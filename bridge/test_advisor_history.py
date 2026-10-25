"""History picker: stored conversations, their titles and previews, and the HTTP surface."""

import tempfile
import unittest
from pathlib import Path

from advisor_contracts import MAX_HISTORY_THREADS
from advisor_service import AdvisorService
from test_advisor_support import FakeModelStore, FakeRuntime, FakeSource

ACCOUNT = "synthetic-account-1"  # FakeSource owns this identity
USER = "friend-a"
AGENT = "advisor"
OTHER_AGENT = "companion"


class HistoryStoreTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(temporary.cleanup)
        self.source = FakeSource()
        self.source.seed_pages("synthetic-chat", 10)
        self.service = AdvisorService(self.source, FakeModelStore(), Path(temporary.name),
                                      runtime_factory=lambda: FakeRuntime())
        self.addCleanup(self.service.shutdown)
        self.database = self.service.stores.account(ACCOUNT)

    def seed(self, user=USER, agent=None, messages=()):
        thread = self.database.create_thread(user, agent or "builtin:advisor", "source-1")
        for role, text in messages:
            self.database.append_message(thread["id"], role, text)
        return thread["id"]

    def test_lists_conversations_newest_first_with_title_and_preview(self):
        first = self.seed(messages=[("user", "先问这个"), ("assistant", "好的"), ("user", "再问一句")])
        second = self.seed(messages=[("user", "后来的对话"), ("assistant", "收到")])

        rows = self.database.list_threads(USER, "builtin:advisor")
        self.assertEqual([row["id"] for row in rows], [second, first])
        newest = rows[0]
        self.assertEqual(newest["title"], "后来的对话")
        self.assertEqual(newest["preview"], "收到")
        self.assertEqual(newest["preview_role"], "assistant")
        self.assertEqual(newest["message_count"], 2)
        # The title is the first user message, not the first message overall.
        self.assertEqual(rows[1]["title"], "先问这个")
        self.assertEqual(rows[1]["preview"], "再问一句")

    def test_titles_and_previews_are_decrypted_for_display(self):
        self.seed(messages=[("user", "机密标题"), ("assistant", "机密预览")])
        row = self.database.list_threads(USER, "builtin:advisor")[0]
        self.assertEqual((row["title"], row["preview"]), ("机密标题", "机密预览"))
        self.assertFalse(str(row["title"]).startswith("wv1:"))

    def test_other_contact_or_assistant_sees_nothing(self):
        self.seed(messages=[("user", "别人看不到")])
        self.assertEqual(self.database.list_threads("friend-b", "builtin:advisor"), [])
        self.assertEqual(self.database.list_threads(USER, "no-such-agent"), [])

    def test_limit_is_honoured_and_empty_state_is_a_list(self):
        for index in range(3):
            self.seed(messages=[("user", "第 %d 段" % index)])
        self.assertEqual(len(self.database.list_threads(USER, "builtin:advisor", limit=2)), 2)
        self.assertIsInstance(self.database.list_threads(USER, "builtin:advisor", limit=0), list)
        self.assertLessEqual(MAX_HISTORY_THREADS, 200)


    def test_deleting_a_conversation_removes_its_messages_and_is_idempotent(self):
        keep = self.seed(messages=[("user", "留下")])
        gone = self.seed(messages=[("user", "删掉"), ("assistant", "好的")])
        self.assertTrue(self.database.delete_thread(gone))
        self.assertEqual([row["id"] for row in self.database.list_threads(USER, "builtin:advisor")], [keep])
        self.assertIsNone(self.database.thread(gone))
        self.assertEqual(self.database.thread_messages(gone), [])
        self.assertFalse(self.database.delete_thread(gone))

class PickerLineTests(unittest.TestCase):
    def test_long_messages_are_truncated_instead_of_failing_the_list(self):
        from advisor_service import picker_line
        line = picker_line("长" * 200, 60)
        self.assertEqual(len(line), 60)  # the ellipsis counts toward the 60-character wire limit
        self.assertTrue(line.endswith("…"))

    def test_newlines_and_control_characters_collapse_to_one_line(self):
        from advisor_service import picker_line
        self.assertEqual(picker_line("  第一行\n第二行\t第三行  ", 60), "第一行 第二行 第三行")
        self.assertEqual(picker_line(None, 60), "")


    def test_emoji_count_as_two_units_so_the_wire_limit_holds(self):
        from advisor_service import picker_line
        line = picker_line("😂" * 100, 60)
        self.assertLessEqual(len(line.encode("utf-16-le")) // 2, 60)
        self.assertTrue(line.endswith("…"))


if __name__ == "__main__":
    unittest.main()
