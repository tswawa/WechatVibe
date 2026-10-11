import sqlite3
import tempfile
import threading
import unittest
from contextlib import closing
from pathlib import Path

from account_store import account_id
from conversation_selection import ConversationSelectionStore, SelectionCorrupt


class ConversationSelectionStoreTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.data_dir = Path(temporary.name) / "real-client-data"
        self.store = ConversationSelectionStore(self.data_dir)
        self.account_a = "wxid_real_a_abcd"
        self.account_b = "wxid_real_b_efgh"

    def path(self, account):
        return self.data_dir / (account_id(account) + ".sqlite3")

    def test_first_adoption_is_empty_without_creating_a_database(self):
        expected = {"account": self.account_a, "initialized": False, "selectedSessions": [],
                    "requestedSessions": []}
        self.assertEqual(self.store.get(self.account_a), expected)
        self.assertFalse(self.path(self.account_a).exists())

        # Existing analysis data does not imply an opt-in to the new sidebar.
        self.data_dir.mkdir()
        with closing(sqlite3.connect(self.path(self.account_a))) as conn, conn:
            conn.execute("CREATE TABLE preserved_analysis (message TEXT)")
            conn.execute("INSERT INTO preserved_analysis VALUES ('synthetic-only')")
        self.assertEqual(self.store.get(self.account_a), expected)

    def test_selection_survives_restart_and_removal_preserves_analysis(self):
        self.data_dir.mkdir()
        with closing(sqlite3.connect(self.path(self.account_a))) as conn, conn:
            conn.execute("CREATE TABLE preserved_analysis (message TEXT)")
            conn.execute("INSERT INTO preserved_analysis VALUES ('synthetic-only')")

        selected = self.store.set_selected(self.account_a, "contact-a", True)
        self.assertEqual(selected, {"account": self.account_a, "initialized": True,
                                    "selectedSessions": ["contact-a"],
                                    "requestedSessions": []})
        self.assertEqual(ConversationSelectionStore(self.data_dir).get(self.account_a), selected)
        self.assertEqual(self.store.get(self.account_b)["selectedSessions"], [])

        removed = self.store.set_selected(self.account_a, "contact-a", False)
        self.assertEqual(removed["selectedSessions"], [])
        self.assertTrue(removed["initialized"])
        self.assertEqual(ConversationSelectionStore(self.data_dir).get(self.account_a), removed)
        with closing(sqlite3.connect(self.path(self.account_a))) as conn:
            self.assertEqual(conn.execute("SELECT message FROM preserved_analysis").fetchall(),
                             [("synthetic-only",)])

    def test_accounts_remain_isolated_even_with_same_session_id(self):
        self.store.set_selected(self.account_a, "same-contact", True)
        self.store.set_selected(self.account_b, "same-contact", True)
        self.store.set_selected(self.account_a, "same-contact", False)
        self.assertEqual(self.store.get(self.account_a)["selectedSessions"], [])
        self.assertEqual(self.store.get(self.account_b)["selectedSessions"], ["same-contact"])
        self.assertNotEqual(self.path(self.account_a), self.path(self.account_b))

    def test_parallel_adds_do_not_lose_selections(self):
        errors = []

        def add(index):
            try:
                ConversationSelectionStore(self.data_dir).set_selected(
                    self.account_a, f"contact-{index}", True)
            except Exception as exc:
                errors.append(exc)

        threads = [threading.Thread(target=add, args=(index,)) for index in range(12)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(errors, [])
        self.assertEqual(len(self.store.get(self.account_a)["selectedSessions"]), 12)

    def test_invalid_scope_and_incomplete_schema_are_rejected(self):
        for account, session, selected in (("../other", "contact", True),
                                           (self.account_a, "", True),
                                           (self.account_a, "contact\x00bad", True),
                                           (self.account_a, "contact", 1)):
            with self.subTest(account=account, session=session, selected=selected):
                with self.assertRaises(ValueError):
                    self.store.set_selected(account, session, selected)

        self.data_dir.mkdir()
        with closing(sqlite3.connect(self.path(self.account_a))) as conn, conn:
            conn.execute("CREATE TABLE conversation_selection_meta_v1 (account TEXT, version INTEGER)")
        with self.assertRaises(SelectionCorrupt):
            self.store.get(self.account_a)
        with self.assertRaises(SelectionCorrupt):
            self.store.set_selected(self.account_a, "contact", True)


if __name__ == "__main__":
    unittest.main()

class AnalysisRequestTests(unittest.TestCase):
    """The per-card button's request is persisted next to the selection, and survives a restart."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.data_dir = Path(temporary.name) / "real-client-data"
        self.store = ConversationSelectionStore(self.data_dir)
        self.account_a = "wxid_real_a_abcd"
        self.account_b = "wxid_real_b_efgh"

    def path(self, account):
        return self.data_dir / (account_id(account) + ".sqlite3")

    def test_request_is_kept_separate_from_the_selection(self):
        self.data_dir.mkdir()
        self.store.set_selected(self.account_a, "contact-a", True)
        self.store.set_selected(self.account_a, "contact-b", True)
        state = self.store.set_requested(self.account_a, "contact-b", True)
        self.assertEqual(state["requestedSessions"], ["contact-b"])
        # Adding a conversation is not a request to analyse it.
        self.assertEqual(state["selectedSessions"], ["contact-a", "contact-b"])

    def test_request_survives_a_new_store_instance(self):
        self.data_dir.mkdir()
        self.store.set_requested(self.account_a, "contact-a", True)
        self.assertEqual(ConversationSelectionStore(self.data_dir).get(self.account_a)["requestedSessions"],
                         ["contact-a"])

    def test_taking_the_request_off_leaves_the_selection_alone(self):
        self.data_dir.mkdir()
        self.store.set_selected(self.account_a, "contact-a", True)
        self.store.set_requested(self.account_a, "contact-a", True)
        state = self.store.set_requested(self.account_a, "contact-a", False)
        self.assertEqual(state["requestedSessions"], [])
        self.assertEqual(state["selectedSessions"], ["contact-a"])

    def test_removing_the_conversation_drops_the_request_with_it(self):
        # The flag lives on the selection row, so requested stays a subset of selected.
        self.data_dir.mkdir()
        self.store.set_requested(self.account_a, "contact-a", True)
        state = self.store.set_selected(self.account_a, "contact-a", False)
        self.assertEqual(state["selectedSessions"], [])
        self.assertEqual(state["requestedSessions"], [])

    def test_add_all_never_requests_analysis(self):
        self.data_dir.mkdir()
        self.store.set_requested(self.account_a, "contact-a", True)
        self.store.set_selected(self.account_a, "contact-a", False)
        state = self.store.set_all_selected(self.account_a, ["contact-a", "contact-b"])
        self.assertEqual(state["selectedSessions"], ["contact-a", "contact-b"])
        self.assertEqual(state["requestedSessions"], [])

    def test_request_is_scoped_to_its_account(self):
        self.data_dir.mkdir()
        self.store.set_requested(self.account_a, "same-contact", True)
        self.assertEqual(self.store.get(self.account_b)["requestedSessions"], [])

    def test_rejects_a_non_session_or_non_boolean_request(self):
        self.data_dir.mkdir()
        with self.assertRaises(ValueError):
            self.store.set_requested(self.account_a, "", True)
        with self.assertRaises(ValueError):
            self.store.set_requested(self.account_a, "contact-a", "yes")

    def test_a_database_written_before_requests_reads_as_no_requests(self):
        # An older database has no `requested` column. Reading must not migrate on a read-only
        # connection and must not look corrupt.
        self.data_dir.mkdir()
        with closing(sqlite3.connect(self.path(self.account_a))) as conn, conn:
            conn.execute("CREATE TABLE conversation_selection_meta_v1 ("
                         "account TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version=1))")
            conn.execute("CREATE TABLE conversation_selection_v1 ("
                         "account TEXT NOT NULL, session TEXT NOT NULL, PRIMARY KEY(account,session))")
            conn.execute("INSERT INTO conversation_selection_meta_v1 VALUES (?,1)", (self.account_a,))
            conn.execute("INSERT INTO conversation_selection_v1 VALUES (?,?)", (self.account_a, "old"))
        state = self.store.get(self.account_a)
        self.assertEqual(state["selectedSessions"], ["old"])
        self.assertEqual(state["requestedSessions"], [])
        # Writing migrates the column in place.
        self.store.set_requested(self.account_a, "old", True)
        self.assertEqual(self.store.get(self.account_a)["requestedSessions"], ["old"])