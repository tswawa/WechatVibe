"""Official accounts and system rows must not enter the conversation sidebar."""

import unittest
from pathlib import Path

from wechat_source import is_service_account


class ServiceAccountFilterTests(unittest.TestCase):
    def test_official_accounts_and_system_rows_are_excluded(self):
        for user in ("gh_abc123", "brandsessionholder", "brandservicesessionholder",
                     "notifymessage", "weixin", "opencustomerservicemsg", "newsapp",
                     "weixinliteservice", "weixinreminder", "fmessage", "floatbottle",
                     "medianote", "qqmail", "voiceinput", "exmail_tool",
                     "fold@placeholder_foldgroup", "bot@weclaw", "svc@kefu.openim",
                     "brandsessionholder@somewhere"):
            with self.subTest(user=user):
                self.assertTrue(is_service_account(user))

    def test_real_conversations_are_kept(self):
        for user in ("filehelper", "wxid_friend", "someone@chatroom", "user@openim",
                     "opencustomerservicemsg_real", "voiceinput_helper", ""):
            with self.subTest(user=user):
                self.assertFalse(is_service_account(user))

    def test_session_listing_actually_applies_the_filter(self):
        source = Path(__file__).with_name("wechat_source.py").read_text(encoding="utf-8")
        self.assertIn("or is_service_account(user)", source)


if __name__ == "__main__":
    unittest.main()
