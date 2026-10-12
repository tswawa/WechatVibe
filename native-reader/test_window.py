"""Synthetic window-telemetry checks: no real desktop, window or capture worker is touched.

`GetForegroundWindow()` returns NULL (None through `wintypes.HWND`) whenever nothing holds the
foreground: a locked session, a switched desktop, or a focused window that was destroyed. The
helper used to call `int()` on it straight away, so `enumerate_windows` raised TypeError before
inspecting any window and every geometry/UIA call failed instead of reporting "nothing is
foreground".
"""

import ctypes
import unittest
from unittest.mock import patch

from wr import window


class FakeUser32:
    """One enumerable window owned by PROCESS_ID, with a controllable foreground handle."""

    PROCESS_ID = 4242
    HANDLE = 0x1234

    def __init__(self, foreground=HANDLE):
        self.foreground = foreground

    def GetForegroundWindow(self):
        return self.foreground

    def EnumWindows(self, callback, _lparam):
        callback(ctypes.c_void_p(self.HANDLE), 0)
        return True

    def IsWindowVisible(self, _hwnd):
        return True

    def IsIconic(self, _hwnd):
        return False

    def GetWindowThreadProcessId(self, _hwnd, pid):
        pid._obj.value = self.PROCESS_ID
        return 1

    def GetWindowRect(self, _hwnd, rect):
        rect._obj.left, rect._obj.top = 10, 20
        rect._obj.right, rect._obj.bottom = 310, 420
        return True

    def GetClientRect(self, _hwnd, rect):
        rect._obj.left, rect._obj.top = 0, 0
        rect._obj.right, rect._obj.bottom = 300, 400
        return True

    def ClientToScreen(self, _hwnd, _point):
        return True


class WindowEnumerationTests(unittest.TestCase):
    def _enumerate(self, foreground):
        user32 = FakeUser32(foreground)
        with patch.object(window, "user32", user32), \
                patch.object(window, "_is_tool_window", return_value=False), \
                patch.object(window, "_dpi_for_window", return_value=96):
            return window.enumerate_windows({FakeUser32.PROCESS_ID})

    def test_a_null_foreground_handle_does_not_abort_enumeration(self):
        windows = self._enumerate(None)
        self.assertEqual(len(windows), 1)
        self.assertFalse(windows[0].foreground)
        self.assertTrue(windows[0].visible)

    def test_a_matching_foreground_handle_is_still_reported(self):
        windows = self._enumerate(FakeUser32.HANDLE)
        self.assertEqual(len(windows), 1)
        self.assertTrue(windows[0].foreground)

    def test_a_foreign_foreground_handle_reports_no_foreground_window(self):
        windows = self._enumerate(FakeUser32.HANDLE + 8)
        self.assertEqual(len(windows), 1)
        self.assertFalse(windows[0].foreground)

    def test_current_geometry_degrades_instead_of_raising(self):
        user32 = FakeUser32(None)
        with patch.object(window, "user32", user32), \
                patch.object(window, "_is_tool_window", return_value=False), \
                patch.object(window, "_dpi_for_window", return_value=96), \
                patch.object(window, "ensure_dpi_awareness", return_value=None):
            payload = window.current_geometry({FakeUser32.PROCESS_ID})
        self.assertIs(payload["foreground"], False)
        self.assertIs(payload["visible"], True)
        self.assertEqual((payload["width"], payload["height"]), (300, 400))


if __name__ == "__main__":
    unittest.main()
