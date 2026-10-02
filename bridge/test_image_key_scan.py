"""The image AES key is derived once, off the request path."""

import threading
import unittest
from pathlib import Path

from wechat_source import WeChatSource


class ImageKeyScanWiringTests(unittest.TestCase):
    def test_source_exposes_a_lazy_background_scan(self):
        self.assertTrue(hasattr(WeChatSource, "_start_image_key_scan"))
        source = WeChatSource.__new__(WeChatSource)
        source.image_key_lock = threading.Lock()
        source.image_key_scan = {"running": False, "retry_at": 0.0}
        self.assertFalse(source.image_key_scan["running"])

    def test_media_asks_for_the_scan_instead_of_failing_immediately(self):
        text = Path(__file__).with_name("wechat_source.py").read_text(encoding="utf-8")
        self.assertIn("self._start_image_key_scan(db)", text)
        self.assertIn('return unavailable("local-key-pending")', text)
        # The scan is bounded, so it cannot freeze WeChat's window while it runs.
        self.assertIn("monitor_timeout=20", text)


if __name__ == "__main__":
    unittest.main()
