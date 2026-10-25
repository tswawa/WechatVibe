"""Boundary checks using only temporary stores and injected synthetic engines."""
import hashlib
import json
import sqlite3
import tempfile
import threading
import time
import unittest
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from advisor_contracts import AdvisorError, char_budget, normalize_event
from advisor_context import ContextProjection
from advisor_service import AdvisorService
from advisor_store import AdvisorPathError, AdvisorStoreRoot
from history_browser import encode_cursor
from wechat_source import WeChatSource
from test_advisor_support import FakeModelStore, FakeRuntime, FakeSource, make_message, wait_until

ACCOUNT = "synthetic-account-1"
USER = "user-a"
AGENT = "builtin:advisor"


class RetainedModelStore(FakeModelStore):
    def __init__(self, protocol="chat_completions", mode="local", key="synthetic-key"):
        super().__init__(mode=mode, key=key, context_tokens=32768)
        self.protocol = protocol
        self.model = "synthetic-model"

    def saved_selection(self):
        return {"selectedMode": self.mode, "sourceId": self.source_id,
                "api": {"protocol": self.protocol, "baseUrl": "http://127.0.0.1:9",
                        "model": self.model, "contextTokens": self.context_tokens,
                        "encryptedKey": "synthetic-cipher" if self.key else None}}


class DelayedRuntime(FakeRuntime):
    def __init__(self):
        super().__init__()
        self.entered = threading.Event()
        self.release = threading.Event()

    def respond(self, config, request, on_event, cancel_event):
        self.respond_calls.append((config, request))
        self.entered.set()
        self.release.wait(5)
        on_event({"type": "text", "text": "late synthetic output"})
        return {"text": "late synthetic output", "runtimeSessionId": "native-synthetic"}

    def shutdown_account(self, account):
        super().shutdown_account(account)
        self.release.set()

    def close(self):
        super().close()
        self.release.set()


class ContextBoundaryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = FakeSource()
        self.stores = AdvisorStoreRoot(self.root)
        self.projection = ContextProjection(self.stores, self.source)
        self.addCleanup(self.stores.close)
        self.addCleanup(self.projection.close)

    def import_ready(self, user=USER):
        self.projection.prepare(ACCOUNT, user)
        row = wait_until(lambda: self.projection.snapshot(ACCOUNT, user)
                         if self.projection.snapshot(ACCOUNT, user)["state"] in ("ready", "error") else None)
        self.assertIsNotNone(row)
        return row

    def test_empty_filtered_page_advances_to_later_text(self):
        self.source.add_messages(USER, [make_message(257)])
        original = self.source.history_page
        def page(user, highwater, after=None, page_size=256):
            if after is None:
                return [], (256, "message__message_1.db", 256)
            return original(user, highwater, after, page_size)
        self.source.history_page = page
        ready = self.import_ready()
        self.assertEqual((ready["state"], ready["readCount"]), ("ready", 1))
        self.assertIn("257", self.projection.messages(ACCOUNT, USER)[0]["text"])

    def test_full_original_long_message_and_quote_identity_survive(self):
        sender = "member-" + "x" * 160
        text = "原文" * 12000 + "不可遗漏的末尾"
        quote = {"id": "quote1", "senderId": sender, "senderName": "成员",
                 "text": "被引用的原文", "sentAtMs": 1700000000000}
        item = make_message(1, text=text, sender=sender)
        item["quote"] = quote
        self.source.add_messages("room@chatroom", [item])
        self.import_ready("room@chatroom")
        row = self.projection.messages(ACCOUNT, "room@chatroom")[0]
        self.assertEqual(row["text"], text)
        self.assertEqual(row["sender_id"], sender)
        self.assertEqual(json.loads(row["raw"])["inputMeta"]["quote"], quote)

    def test_invalid_row_is_error_not_silent_gap(self):
        invalid = make_message(1)
        invalid["_sort"] = None
        self.source.history_highwater = lambda _user: (3, "message__message_1.db", 3)
        self.source.history_page = lambda *_args, **_kwargs: ([invalid, make_message(3)], None)
        result = self.import_ready()
        self.assertEqual((result["state"], result["readCount"]), ("error", 0))
        self.assertEqual(self.projection.messages(ACCOUNT, USER), [])

    def test_repeated_page_is_deduped_by_message_identity_and_seq_is_dense(self):
        self.source.add_messages(USER, [make_message(1), make_message(2)])
        def page(user, highwater, after=None, page_size=256):
            if after is None:
                return [make_message(1)], (1, "message__message_1.db", 1)
            if after[0] == 1:
                return [make_message(1), make_message(2)], (2, "message__message_1.db", 1)
            return [], None
        self.source.history_page = page
        result = self.import_ready()
        self.assertEqual(result["readCount"], 2)
        self.assertEqual([row["seq"] for row in self.projection.messages(ACCOUNT, USER)], [1, 2])

    def test_workdir_change_rebuilds_source_and_clears_summaries(self):
        self.source.seed_pages(USER, 2)
        self.import_ready()
        old = self.stores.account(ACCOUNT).context(USER)
        self.stores.account(ACCOUNT).save_summary(USER, "old", "v", "fp", 1, "old summary")
        self.source.workdir = "C:/synthetic-new-workdir"
        self.source.users[USER] = [make_message(1, text="new root content")]
        self.import_ready()
        database = self.stores.account(ACCOUNT)
        self.assertNotEqual(database.context(USER)["epoch"], old["epoch"])
        self.assertEqual([row["text"] for row in self.projection.messages(ACCOUNT, USER)], ["new root content"])
        self.assertIsNone(database.summary(USER, "old", "v", "fp", 1))

    def test_highwater_regression_rebuilds_old_tail(self):
        self.source.seed_pages(USER, 5)
        self.import_ready()
        old = self.stores.account(ACCOUNT).context(USER)["epoch"]
        self.source.users[USER] = [make_message(1, text="restored source")]
        ready = self.import_ready()
        self.assertEqual(ready["readCount"], 1)
        self.assertNotEqual(self.stores.account(ACCOUNT).context(USER)["epoch"], old)

    def test_single_giant_message_compacts_all_pieces_inside_exact_budget(self):
        text = "0123456789" * 3000
        self.source.add_messages(USER, [make_message(1, text=text)])
        self.import_ready()
        seen = []
        def compact(piece, key, level):
            seen.append(piece)
            self.assertLessEqual(len(piece), 1000)
            return "neutral compressed fact"
        import advisor_context
        render_calls = []
        original_render = advisor_context._render
        def track_render(older, recent):
            render_calls.append([key for item in older + recent for key in item["coverage"]])
            return original_render(older, recent)
        with patch("advisor_context._render", side_effect=track_render):
            rendered = self.projection.build_model_context(ACCOUNT, USER, 1, 700, compact, "fp", compact_budget=1000)
        self.assertLessEqual(len(rendered), 700)
        # The final view preserves every original range through summaries or raw recent pieces.
        coverage = render_calls[-1]
        boundaries = [(int(key.split(":")[1]), int(key.split(":")[2])) for key in coverage]
        self.assertEqual(boundaries[0][0], 0)
        for previous, current in zip(boundaries, boundaries[1:]):
            self.assertEqual(previous[1], current[0])
        self.assertEqual(boundaries[-1][1], len(original_render([], [{"text": advisor_context._format_line(
            self.projection.messages(ACCOUNT, USER)[0])}]).split("\n", 1)[1]))
        rows = self.stores.account(ACCOUNT)._rows("SELECT coverage_json FROM summaries")
        coverage = [part for row in rows for part in json.loads(row["coverage_json"])]
        self.assertTrue(any(":0:" in key for key in coverage))
        self.assertEqual(self.projection.messages(ACCOUNT, USER)[0]["text"], text)

    def test_nonshrinking_or_oversized_summary_never_discards_history(self):
        self.source.seed_pages(USER, 100, text_size=80)
        self.import_ready()
        original = self.projection.messages(ACCOUNT, USER)
        with self.assertRaises(AdvisorError) as caught:
            self.projection.build_model_context(ACCOUNT, USER, None, 700,
                                                lambda text, _key, _level: text, "fp")
        self.assertEqual(caught.exception.code, "compression-failed")
        self.assertEqual(self.projection.messages(ACCOUNT, USER), original)
        self.assertEqual(self.stores.account(ACCOUNT)._rows("SELECT * FROM summaries"), [])

    def test_database_file_reparse_is_rejected_before_sqlite_writes(self):
        database = self.stores.account(ACCOUNT)
        import advisor_store
        original = advisor_store._reparse
        with patch("advisor_store._reparse", side_effect=lambda path: Path(path) == database.path or original(path)):
            with self.assertRaises(AdvisorPathError):
                database.context(USER)
        self.assertFalse(database.path.exists())

    def test_unrenderable_timestamp_keeps_original_and_text(self):
        self.source.add_messages(USER, [make_message(1, time_ms=9 * 10 ** 18, text="valid text")])
        self.import_ready()
        rendered = self.projection.build_model_context(ACCOUNT, USER, 1, 10000,
                                                       lambda *_args: "should not compact", "fp")
        self.assertIn("时间未知", rendered)
        self.assertIn("valid text", rendered)
        self.assertEqual(self.projection.messages(ACCOUNT, USER)[0]["time_ms"], 9 * 10 ** 18)

    def test_real_wechat_history_page_contract_with_only_synthetic_sqlite_files(self):
        user = "synthetic-room@chatroom"
        table = "Msg_" + "a" * 32
        files, raw_items = [], []
        for shard_number in (1, 2):
            path = self.root / ("message__message_%d.db" % shard_number)
            with closing(sqlite3.connect(path)) as connection, connection:
                connection.execute("CREATE TABLE Name2Id(user_name TEXT)")
                connection.executemany("INSERT INTO Name2Id(user_name) VALUES(?)", [("self-user",), ("member-b",)])
                connection.execute("CREATE TABLE " + table + "(local_id INTEGER,local_type INTEGER,real_sender_id INTEGER,"
                                   "create_time INTEGER,message_content TEXT,compress_content BLOB,server_id INTEGER,sort_seq INTEGER)")
                seq = shard_number
                record = (1, 1, shard_number, 1700000000 + seq, "native synthetic message %d" % seq,
                          None, 1000 + seq, seq)
                connection.execute("INSERT INTO " + table + " VALUES(?,?,?,?,?,?,?,?)", record)
                raw_items.append((record, path.name, {1: "self-user", 2: "member-b"}))
            files.append(path)
        db = SimpleNamespace(account=ACCOUNT, workdir="C:/synthetic-workdir",
                             _msg_conns=lambda _user: [(sqlite3.connect(path), table) for path in files])
        source = WeChatSource(factory=lambda: db)
        source.db = db
        source._db = lambda fresh=False: db
        source.identity = lambda: (ACCOUNT, "C:/synthetic-workdir")
        source._contacts = lambda _db: {"member-b": {"name": "群成员", "avatar": "", "avatarCandidates": []}}
        source.self_user = lambda _db=None: "self-user"
        source._classified_content = lambda _db, _type, content, _compressed: ("文本", "text", content)
        source._shard_rows = lambda _db, _user, limit: sorted(raw_items, key=lambda item: item[0][7], reverse=True)[:limit]
        self.projection.source = source
        ready = self.import_ready(user)
        self.assertEqual(ready["readCount"], 2)
        rows = self.projection.messages(ACCOUNT, user)
        self.assertEqual([row["side"] for row in rows], ["self", "other"])
        self.assertEqual([row["sender_id"] for row in rows], ["self-user", "member-b"])
        self.assertEqual([row["text"] for row in rows], ["native synthetic message 1", "native synthetic message 2"])
        self.assertEqual(rows[0]["time_ms"], 1700000001000)
        self.assertEqual(json.loads(rows[1]["raw"])["inputMeta"]["conversationId"], user)

    def test_cursor_only_messages_restore_scope_validated_sort(self):
        message = make_message(1, text="cursor-only original")
        message.pop("_sort")
        message["historyCursor"] = encode_cursor(ACCOUNT, USER, (1, "message__message_1.db", 1))
        self.source.history_highwater = lambda _user: (1, "message__message_1.db", 1)
        self.source.history_page = lambda _user, _highwater, after=None, page_size=256: ([message], None) if after is None else ([], None)
        ready = self.import_ready()
        self.assertEqual((ready["state"], ready["readCount"]), ("ready", 1))
        row = self.projection.messages(ACCOUNT, USER)[0]
        self.assertEqual(json.loads(row["sort_key"]), [1, "message__message_1.db", 1])
        self.assertEqual(row["text"], "cursor-only original")

    def test_foreign_cursor_or_disagreeing_sort_fails_without_committing(self):
        for cursor in (encode_cursor("different-account", USER, (1, "message__message_1.db", 1)),
                       encode_cursor(ACCOUNT, "different-room", (1, "message__message_1.db", 1)),
                       encode_cursor(ACCOUNT, USER, (2, "message__message_1.db", 1))):
            message = make_message(1)
            message["historyCursor"] = cursor
            with self.assertRaises(AdvisorError):
                self.projection._page_rows(USER, [message], 0)
        self.assertEqual(self.projection.messages(ACCOUNT, USER), [])


class ServiceBoundaryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = FakeSource()
        self.source.seed_pages(USER, 3)
        self.model_store = RetainedModelStore()
        self.runtime = FakeRuntime()
        self.service = AdvisorService(self.source, self.model_store, self.root,
                                      runtime_factory=lambda: self.runtime)
        self.addCleanup(self.service.shutdown)

    def completed(self, result):
        identifier = result["run"]["id"]
        terminal = wait_until(lambda: self.service._runs[identifier]
                              if self.service._runs[identifier].state != "running" else None)
        self.assertIsNotNone(terminal)
        return terminal

    def test_first_send_waits_for_all_pages_before_any_paid_call(self):
        self.source.users[USER] = []
        self.source.seed_pages(USER, 600)
        self.model_store.context_tokens = 1000000
        entered, release = threading.Event(), threading.Event()
        def block(_source):
            if not entered.is_set():
                entered.set()
                release.wait(5)
        self.source.page_hook = block
        result = self.service.start(ACCOUNT, USER, AGENT, None, "first send", "first")
        self.assertTrue(entered.wait(2))
        time.sleep(0.05)
        self.assertEqual(self.runtime.respond_calls, [])
        self.assertEqual(self.runtime.compact_calls, [])
        release.set()
        run = self.completed(result)
        self.assertEqual(run.state, "done")
        request = self.runtime.respond_calls[0][1]
        self.assertEqual(run.database.context(USER)["read_count"], 600)
        self.assertNotIn("contextMessageCount", request)
        self.assertEqual(run.database.run(run.id)["context_revision"], request["contextRevision"])
        self.assertIn("消息内容 1 ", request["contextFileText"])
        self.assertIn("消息内容 600 ", request["contextFileText"])

    def test_progress_steps_are_published_without_echoing_the_message(self):
        question = "请根据这段聊天给我一条建议"
        result = self.service.start(ACCOUNT, USER, AGENT, None, question, "steps")
        run = self.completed(result)
        self.assertEqual(run.state, "done")
        payload = self.service.events(ACCOUNT, USER, run.id)
        steps = [(event.get("state"), event.get("text") or "") for event in payload["events"]
                 if event.get("type") == "status" and
                 event.get("state") in ("reading", "preparing", "thinking")]
        states = [state for state, _text in steps]
        # The three coarse phases have to show up in this order, before the answer streams.
        for expected in ("reading", "preparing", "thinking"):
            self.assertIn(expected, states)
        self.assertLess(states.index("reading"), states.index("preparing"))
        self.assertLess(states.index("preparing"), states.index("thinking"))
        for _state, text in steps:
            self.assertNotIn(question, text, "a progress label must not echo the user message")
            self.assertNotIn("消息内容", text, "a progress label must not echo chat text")

    def test_cancel_while_first_import_blocks_prevents_generation(self):
        entered, release = threading.Event(), threading.Event()
        def block(_source):
            entered.set()
            release.wait(5)
        self.source.page_hook = block
        result = self.service.start(ACCOUNT, USER, AGENT, None, "stop first send", "stop-first")
        self.assertTrue(entered.wait(2))
        self.service.stop(ACCOUNT, USER, result["run"]["id"])
        release.set()
        self.completed(result).worker.join(2)
        self.assertEqual(self.runtime.respond_calls, [])
        self.assertEqual(self.runtime.compact_calls, [])

    def test_retained_api_runs_while_analysis_is_local_without_switching(self):
        run = self.completed(self.service.start(ACCOUNT, USER, AGENT, None, "advice", "local-analysis"))
        self.assertEqual(run.state, "done")
        self.assertEqual(self.model_store.mode, "local")
        self.assertEqual(self.runtime.respond_calls[0][0]["sourceId"], self.model_store.source_id)

    def test_keyless_ollama_runs(self):
        self.model_store.protocol = "ollama"
        self.model_store.key = None
        self.assertEqual(self.service.catalog()["engine"]["state"], "available")
        run = self.completed(self.service.start(ACCOUNT, USER, AGENT, None, "local generation", "ollama"))
        self.assertEqual(run.state, "done")
        self.assertIsNone(self.runtime.respond_calls[0][0]["apiKey"])

    def test_initial_retry_is_idempotent_even_without_thread_id(self):
        first = self.service.start(ACCOUNT, USER, AGENT, None, "same message", "idempotent")
        self.completed(first)
        duplicate = self.service.start(ACCOUNT, USER, AGENT, None, "same message", "idempotent")
        self.assertEqual(duplicate["threadId"], first["threadId"])
        self.assertEqual(duplicate["run"]["id"], first["run"]["id"])
        self.assertEqual(len(self.runtime.respond_calls), 1)
        with self.assertRaises(AdvisorError) as caught:
            self.service.start(ACCOUNT, USER, AGENT, None, "different message", "idempotent")
        self.assertEqual(caught.exception.code, "request-conflict")

    def test_native_history_is_not_duplicated_into_managed_context(self):
        first = self.service.start(ACCOUNT, USER, AGENT, None, "unique earlier user request", "history-1")
        self.completed(first)
        self.completed(self.service.start(ACCOUNT, USER, AGENT, first["threadId"], "new request", "history-2"))
        second = self.runtime.respond_calls[1][1]
        self.assertEqual(second["runtimeSessionId"], "sess-1")
        self.assertNotIn("unique earlier user request", second["contextFileText"])
        self.assertNotIn(self.runtime.text, second["contextFileText"])

    def test_new_model_has_new_native_session_and_visible_boundary(self):
        first = self.service.start(ACCOUNT, USER, AGENT, None, "first model", "model-1")
        self.completed(first)
        self.model_store.model = "synthetic-second-model"
        self.model_store.source_id = "second-source"
        self.completed(self.service.start(ACCOUNT, USER, AGENT, first["threadId"], "second model", "model-2"))
        self.assertIsNone(self.runtime.respond_calls[1][1]["runtimeSessionId"])
        payload = self.service.thread(ACCOUNT, USER, AGENT)["thread"]
        self.assertTrue(any(message["role"] == "status" and "模型已变更" in message["text"] for message in payload["messages"]))
        self.assertEqual(payload["sourceId"], "second-source")

    def test_rename_keeps_native_history(self):
        first = self.service.start(ACCOUNT, USER, AGENT, None, "first", "rename-1")
        self.completed(first)
        agent = self.service.stores.config.agent(AGENT)
        self.service.save_template({"action": "save", "agent": {key: agent[key] for key in
                                                               ("id", "name", "description", "prompt", "skillIds")}
                                    | {"name": "改名的军师"}})
        self.completed(self.service.start(ACCOUNT, USER, AGENT, first["threadId"], "second", "rename-2"))
        self.assertEqual(self.runtime.respond_calls[1][1]["runtimeSessionId"], "sess-1")

    def test_account_switch_ignores_late_output_without_old_account_commit(self):
        self.runtime = DelayedRuntime()
        result = self.service.start(ACCOUNT, USER, AGENT, None, "before switch", "switch")
        self.assertTrue(self.runtime.entered.wait(2))
        run = self.service._runs[result["run"]["id"]]
        before = run.database.thread_messages(run.thread_id)
        self.source.account = "synthetic-other-account"
        self.runtime.release.set()
        run.worker.join(2)
        self.assertEqual(run.state, "stopped")
        self.assertEqual(run.database.thread_messages(run.thread_id), before)

    def test_stop_and_clear_cannot_be_undone_by_late_callback(self):
        self.runtime = DelayedRuntime()
        result = self.service.start(ACCOUNT, USER, AGENT, None, "clear", "late-clear")
        self.assertTrue(self.runtime.entered.wait(2))
        run = self.service._runs[result["run"]["id"]]
        owned_directory = run.database.directory
        self.service.clear_account(ACCOUNT)
        self.service._on_event(run, {"type": "text", "text": "late callback"})
        self.service._finish_locked(run, "late answer", "late-session")
        self.service._fail_locked(run, "late failure", "error")
        self.service.resume_after_failed_account_clear()
        with self.assertRaises(AdvisorError):
            self.service.prepare_context(ACCOUNT, USER)
        self.assertFalse(owned_directory.exists())

    def test_failed_native_drain_does_not_delete_or_resume_account(self):
        self.completed(self.service.start(ACCOUNT, USER, AGENT, None, "retained", "drain-fail"))
        path = self.service.stores.account(ACCOUNT).directory
        def fail(_account):
            raise RuntimeError("synthetic drain failure")
        self.runtime.shutdown_account = fail
        with self.assertRaises(RuntimeError):
            self.service.clear_account(ACCOUNT)
        self.assertTrue(path.exists())
        with self.assertRaises(AdvisorError):
            self.service.thread(ACCOUNT, USER, AGENT)
        self.service.resume_after_failed_account_clear()
        with self.assertRaises(AdvisorError):
            self.service.thread(ACCOUNT, USER, AGENT)

    def test_raw_provider_secret_exception_is_not_rendered_or_stored(self):
        secret = "synthetic-secret-key-and-private-path"
        def fail(*_args):
            raise RuntimeError(secret)
        self.runtime.respond = fail
        result = self.service.start(ACCOUNT, USER, AGENT, None, "safe", "redact")
        run = self.completed(result)
        self.assertEqual(run.state, "error")
        self.assertNotIn(secret, json.dumps(self.service.events(ACCOUNT, USER, run.id), ensure_ascii=False))

    def test_native_retry_timing_is_preserved_without_invented_countdown(self):
        event = normalize_event({"type": "status", "state": "retry", "attempt": 2,
                                 "next": 1800000000000, "nativeType": "session.retry"}, 1)
        self.assertEqual((event["attempt"], event["next"], event["nativeType"]),
                         (2, 1800000000000, "session.retry"))
        invalid = normalize_event({"type": "status", "attempt": -1, "next": True}, 2)
        self.assertNotIn("attempt", invalid)
        self.assertNotIn("next", invalid)

    def test_changed_model_during_generation_blocks_old_commit(self):
        self.runtime = DelayedRuntime()
        result = self.service.start(ACCOUNT, USER, AGENT, None, "old config", "config-change")
        self.assertTrue(self.runtime.entered.wait(2))
        run = self.service._runs[result["run"]["id"]]
        self.model_store.model = "changed synthetic model"
        before = run.database.thread_messages(run.thread_id)
        self.runtime.release.set()
        run.worker.join(2)
        self.assertEqual(run.state, "stopped")
        self.assertEqual(run.database.thread_messages(run.thread_id), before)
        self.completed(self.service.start(ACCOUNT, USER, AGENT, result["threadId"], "new config", "config-new"))
        self.assertIsNone(self.runtime.respond_calls[1][1]["runtimeSessionId"])

    def test_source_epoch_reset_during_generation_blocks_old_commit(self):
        self.runtime = DelayedRuntime()
        result = self.service.start(ACCOUNT, USER, AGENT, None, "old snapshot", "epoch-change")
        self.assertTrue(self.runtime.entered.wait(2))
        run = self.service._runs[result["run"]["id"]]
        self.source.users[USER] = [make_message(1, text="restored synthetic history")]
        self.service.prepare_context(ACCOUNT, USER)
        before = run.database.thread_messages(run.thread_id)
        self.runtime.release.set()
        run.worker.join(2)
        self.assertEqual(run.state, "stopped")
        self.assertEqual(run.database.thread_messages(run.thread_id), before)

    def test_changed_context_source_resets_native_session_visibly(self):
        first = self.service.start(ACCOUNT, USER, AGENT, None, "old source", "root-1")
        self.completed(first)
        self.source.workdir = "C:/synthetic-next-root"
        self.source.users[USER] = [make_message(1, text="new source conversation")]
        self.completed(self.service.start(ACCOUNT, USER, AGENT, first["threadId"], "new source", "root-2"))
        self.assertIsNone(self.runtime.respond_calls[1][1]["runtimeSessionId"])
        payload = self.service.thread(ACCOUNT, USER, AGENT)["thread"]
        self.assertTrue(any(message["role"] == "status" and "数据来源已变更" in message["text"]
                            for message in payload["messages"]))

    def test_oversized_prompt_and_skill_fail_before_paid_requests(self):
        self.model_store.context_tokens = 4096
        created = self.service.save_template({"action": "save", "agent": {
            "name": "too long", "description": "", "prompt": "p" * 5000,
            "skillIds": []}})
        custom = [agent for agent in created["agents"] if not agent["builtin"]][0]
        run = self.completed(self.service.start(ACCOUNT, USER, custom["id"], None, "question", "too-long"))
        self.assertEqual(run.state, "error")
        self.assertEqual(self.runtime.respond_calls, [])
        self.assertEqual(self.runtime.compact_calls, [])

    def test_cancel_during_compact_leaves_no_late_summary(self):
        self.source.users[USER] = []
        self.source.seed_pages(USER, 100, text_size=100)
        self.model_store.context_tokens = 8192
        entered, release = threading.Event(), threading.Event()
        def compact(config, request, on_event, cancel):
            entered.set()
            release.wait(5)
            return {"text": "neutral synthetic summary"}
        self.runtime.compact = compact
        result = self.service.start(ACCOUNT, USER, AGENT, None, "compact then stop", "stop-compact")
        self.assertTrue(entered.wait(2))
        run = self.service._runs[result["run"]["id"]]
        self.service.stop(ACCOUNT, USER, run.id)
        release.set()
        run.worker.join(2)
        self.assertEqual(run.database._rows("SELECT * FROM summaries"), [])
        self.assertEqual(self.runtime.respond_calls, [])

    def test_shutdown_drain_timeout_preserves_open_store_until_worker_finishes(self):
        self.runtime = DelayedRuntime()
        self.runtime.close = lambda: None
        result = self.service.start(ACCOUNT, USER, AGENT, None, "blocked synthetic engine", "shutdown")
        self.assertTrue(self.runtime.entered.wait(2))
        run = self.service._runs[result["run"]["id"]]
        with patch("advisor_service.WORKER_DRAIN_SECONDS", 0.01):
            with self.assertRaises(RuntimeError):
                self.service.shutdown()
        self.assertFalse(run.database._closed)
        self.assertFalse(self.service.stores._closed)
        self.runtime.release.set()
        run.worker.join(2)
        self.service.shutdown()
        self.assertTrue(run.database._closed)

    def test_unavailable_factory_never_claims_engine_ready(self):
        factory = lambda: self.runtime
        factory.available = lambda: False
        self.service.runtime_factory = factory
        self.assertEqual(self.service.catalog()["engine"]["state"], "missing")
        with self.assertRaises(AdvisorError) as caught:
            self.service.start(ACCOUNT, USER, AGENT, None, "not installed", "missing-engine")
        self.assertEqual(caught.exception.code, "engine-unavailable")

    def test_failed_persistence_is_terminal_and_does_not_leak_exception(self):
        self.runtime = DelayedRuntime()
        result = self.service.start(ACCOUNT, USER, AGENT, None, "save failure", "persistence")
        self.assertTrue(self.runtime.entered.wait(2))
        run = self.service._runs[result["run"]["id"]]
        with patch.object(run.database, "finish_run", side_effect=OSError("synthetic-private-path")):
            self.runtime.release.set()
            run.worker.join(2)
        self.assertEqual(run.state, "error")
        self.assertNotIn("synthetic-private-path", run.error)
        self.assertIn("保存失败", run.error)

    def test_agent_payload_has_welcome_and_no_reading_flow_or_counts(self):
        entered, release = threading.Event(), threading.Event()
        def block(_source):
            entered.set()
            release.wait(5)
        self.source.page_hook = block
        payload = self.service.thread(ACCOUNT, USER, AGENT)
        self.assertEqual(payload["thread"]["welcome"], "嗨，我是你的狗头军师")
        result = self.service.start(ACCOUNT, USER, AGENT, payload["thread"]["id"], "first question", "silent-read")
        self.assertTrue(entered.wait(2))
        pending = self.service.events(ACCOUNT, USER, result["run"]["id"])
        # The only thing allowed out before any history is read is the coarse "reading" step:
        # no counts, no message text, nothing that mirrors the payload.
        self.assertEqual([event.get("state") for event in pending["events"]], ["reading"])
        self.assertNotRegex(pending["events"][0].get("text", ""), r"\d")
        self.assertEqual(set(self.service.thread(ACCOUNT, USER, AGENT)["context"]), {"revision"})
        self.assertEqual([row["role"] for row in self.service.stores.account(ACCOUNT).thread_messages(result["threadId"])], ["user"])
        release.set()
        self.completed(result)
        request = self.runtime.respond_calls[0][1]
        self.assertNotIn("context", request)
        self.assertNotIn("contextMessageCount", request)
        self.assertIn("每轮回答前", request["system"])
        self.assertIn("只读资料文件", request["system"])
        self.assertNotIn("消息内容", request["system"])
        self.assertIn("消息内容 1", request["contextFileText"])


if __name__ == "__main__":
    unittest.main()
