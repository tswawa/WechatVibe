"""Synthetic checks for "recompute this one message" (the context-menu action).

The action only forgets the saved row of one id, for one source. Everything else — other
messages, progress, portraits, running jobs — has to stay exactly as it was, because the
client re-submits the single id afterwards through the ordinary analysis path.
"""
import http.client
import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

from backend_contracts import AccountChangedError, LOCAL_SOURCE_ID
from backend_service import Backend
from conversation_selection import ConversationSelectionStore
from message_contracts import api_insight_scope
from real_http import make_handler
from result_store import ResultStore


class Source:
    def __init__(self, root):
        self.account = "wxid_synthetic_a"
        self.workdir = root / "snapshot"

    def verified_identity(self, **_kwargs):
        return self.account, self.workdir


class Analyzer:
    model = {"state": "ready"}

    def analysis_version(self):
        return "synthetic-version"

    def clear_caches(self):
        pass


class MessageRecomputeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = Source(self.root)
        self.store = ResultStore(self.root / "results.sqlite3")
        self.backend = Backend(self.source, Analyzer(),
                               store_factory=lambda *_args: self.store,
                               selection_store=ConversationSelectionStore(self.root / "selection"))
        self.addCleanup(self.backend.shutdown)
        self.api = "a" * 32
        self.other_api = "b" * 32
        self.store.register_api_source(self.source.account, self.api, "chat_completions", "synthetic-model")

    def seed_local(self, message_id, user="friend"):
        with self.store.connect() as conn:
            conn.execute("INSERT INTO fine_results_v1 VALUES (?,?,?,?,?,?,?,?,?)",
                         (self.source.account, user, message_id, "synthetic-version", 1,
                          "message__message_0.db", 1, "friend", json.dumps({"state": "done"})))
            conn.execute("INSERT INTO fine_skips_v1 VALUES (?,?,?,?,?,?,?,?)",
                         (self.source.account, user, message_id, "synthetic-version", 1,
                          "message__message_0.db", 1, "synthetic-skip"))
            conn.execute("INSERT INTO results_v2 VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                         (self.source.account, user, message_id, 1, "message__message_0.db", 1,
                          "friend", "other", json.dumps({"state": "done"}), 0.5, "synthetic-version"))
            conn.execute("INSERT INTO analysis_skips VALUES (?,?,?,?,?,?,?,?)",
                         (self.source.account, user, message_id, "synthetic-version", 1,
                          "message__message_0.db", 1, "synthetic-skip"))
        return message_id

    def count(self, table, message_id, user="friend"):
        with self.store.connect() as conn:
            return conn.execute(f"SELECT COUNT(*) FROM {table} WHERE account=? AND session=? AND id=?",
                                (self.source.account, user, message_id)).fetchone()[0]

    def known(self, message_id, user="friend"):
        return self.store.fine_known(self.source.account, user, "synthetic-version", [message_id])

    def seed_progress(self, user="friend"):
        with self.store.connect() as conn:
            conn.execute("INSERT INTO progress_v1 (account,session,version,cursor_seq,cursor_shard,"
                         "cursor_local,complete,context_json,eligible_count,score_count) "
                         "VALUES (?,?,?,?,?,?,?,?,?,?)",
                         (self.source.account, user, "synthetic-version", 1, "message__message_0.db",
                          1, 0, "[]", 4, 4))

    def test_local_forget_drops_only_the_named_message(self):
        self.seed_local("o1")
        self.seed_local("o2")
        self.seed_local("o1", user="other-friend")
        result = self.backend.forget_message_analysis(self.source.account, "friend", LOCAL_SOURCE_ID, "o1")
        self.assertEqual(result["messageId"], "o1")
        self.assertEqual(result["sourceId"], LOCAL_SOURCE_ID)
        self.assertEqual(result["messageRows"], 4, "the fine row, the skip row and both legacy rows")
        for table in ("fine_results_v1", "fine_skips_v1", "results_v2", "analysis_skips"):
            self.assertEqual(self.count(table, "o1"), 0)
            self.assertEqual(self.count(table, "o2"), 1, "a neighbouring message must not be touched")
            self.assertEqual(self.count(table, "o1", user="other-friend"), 1,
                             "the same id in another conversation belongs to that conversation")
        self.assertFalse(self.known("o1"), "the run paths key their skip on exactly this predicate")
        self.assertTrue(self.known("o2"))
        self.assertFalse(self.backend.analysis_scope_resets, "this is not a scope reset")

    def test_local_forget_leaves_progress_and_portraits_alone(self):
        self.seed_local("o1")
        self.seed_progress()
        with self.store.connect() as conn:
            conn.execute("INSERT INTO portrait_resets_v1 VALUES (?,?,?)",
                         (self.source.account, "friend", "friend"))
        self.backend.forget_message_analysis(self.source.account, "friend", LOCAL_SOURCE_ID, "o1")
        with self.store.connect() as conn:
            progress = conn.execute("SELECT eligible_count,complete FROM progress_v1 WHERE account=? AND session=?",
                                    (self.source.account, "friend")).fetchone()
        self.assertEqual(tuple(progress), (4, 0), "progress rows describe the conversation, not one message")
        self.assertTrue(self.store.portrait_reset(self.source.account, "friend", "friend"))

    def test_api_forget_targets_one_id_and_one_source(self):
        # Insights are stored under the revisioned scope of a source, which is why the
        # delete matches the source prefix instead of one exact string.
        scope = api_insight_scope(self.api)
        self.store.save_api_insights(self.source.account, "friend", scope, [
            ({"id": "o1", "_sort": (1, "message__message_0.db", 1)}, {"status": "ok"}),
            ({"id": "o2", "_sort": (2, "message__message_0.db", 2)}, {"status": "ok"}),
        ])
        self.store.save_api_insights(self.source.account, "friend", api_insight_scope(self.other_api), [
            ({"id": "o1", "_sort": (1, "message__message_0.db", 1)}, {"status": "ok"}),
        ])
        result = self.backend.forget_message_analysis(self.source.account, "friend", self.api, "o1")
        self.assertEqual(result["messageRows"], 1)
        self.assertEqual(self.store.api_insight_known(self.source.account, "friend", scope, ["o1"]), set())
        self.assertEqual(self.store.api_insight_known(self.source.account, "friend", scope, ["o2"]), {"o2"})
        self.assertEqual(self.store.api_insight_known(self.source.account, "friend",
                                                     api_insight_scope(self.other_api), ["o1"]), {"o1"},
                         "another model source keeps its own reading of the same message")

    def test_forget_rejects_bad_input_without_deleting_anything(self):
        self.seed_local("o1")
        with self.assertRaises(AccountChangedError):
            self.backend.forget_message_analysis("other-account", "friend", LOCAL_SOURCE_ID, "o1")
        with self.assertRaises(ValueError):
            self.backend.forget_message_analysis(self.source.account, "friend", "c" * 32, "o1")
        with self.assertRaises(ValueError):
            self.backend.forget_message_analysis(self.source.account, "friend", LOCAL_SOURCE_ID, "")
        with self.assertRaises(ValueError):
            self.backend.forget_message_analysis(self.source.account, "friend", LOCAL_SOURCE_ID, "o1\n")
        with self.assertRaises(ValueError):
            self.backend.forget_message_analysis(self.source.account, "friend", LOCAL_SOURCE_ID, "o" * 201)
        self.assertTrue(self.known("o1"))

    def test_http_forget_validates_shape_and_echoes_the_target(self):
        self.seed_local("o1")
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.backend))
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            def post(body, path="/api/analysis-target/forget"):
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
                try:
                    connection.request("POST", path, json.dumps(body),
                                       {"Content-Type": "application/json"})
                    response = connection.getresponse()
                    return response.status, json.loads(response.read())
                finally:
                    connection.close()
            body = {"account": self.source.account, "user": "friend", "sourceId": LOCAL_SOURCE_ID,
                    "messageId": "o1"}
            self.assertEqual(post({**body, "unknown": True})[0], 400)
            self.assertEqual(post({key: value for key, value in body.items() if key != "messageId"})[0], 400)
            self.assertEqual(post({**body, "messageId": "o1\u0007"})[0], 400)
            self.assertEqual(post({**body, "sourceId": "c" * 32})[0], 400)
            self.assertTrue(self.known("o1"), "a rejected request must not forget anything")
            status, response = post(body)
            self.assertEqual(status, 200)
            self.assertEqual({key: response[key] for key in body}, body)
            self.assertTrue(response["forgotten"])
            self.assertEqual(response["messageRows"], 4)
            self.assertFalse(self.known("o1"))
        finally:
            server.shutdown()
            server.server_close()
            worker.join(3)


if __name__ == "__main__":
    unittest.main()
