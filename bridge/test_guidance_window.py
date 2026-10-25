"""Reply generation only uploads the chosen recent window of chat."""

import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from backend_service import Backend
from guidance_contracts import (GUIDANCE_WINDOW_CHOICES, GUIDANCE_WINDOW_DEFAULT,
                                GUIDANCE_WINDOW_MAX, GUIDANCE_WINDOW_MIN, guidance_window_minutes)


class GuidanceWindowChoiceTests(unittest.TestCase):
    def test_default_is_one_day(self):
        self.assertEqual(GUIDANCE_WINDOW_DEFAULT, 1440)
        self.assertEqual(guidance_window_minutes(None), 1440)
        self.assertEqual(guidance_window_minutes(1440), 1440)

    def test_any_amount_inside_the_range_is_kept(self):
        # The field accepts arbitrary hours/days, not only the presets.
        for minutes in (60, 61, 90, 120, 1440, 4321, 10080, 43200):
            self.assertEqual(guidance_window_minutes(minutes), minutes)
        for minutes in GUIDANCE_WINDOW_CHOICES:
            self.assertEqual(guidance_window_minutes(minutes), minutes)

    def test_out_of_range_values_are_clamped(self):
        self.assertEqual(GUIDANCE_WINDOW_MIN, 60)
        self.assertEqual(GUIDANCE_WINDOW_MAX, 43200)
        self.assertEqual(guidance_window_minutes(0), 60)
        self.assertEqual(guidance_window_minutes(-60), 60)
        self.assertEqual(guidance_window_minutes(1), 60)
        self.assertEqual(guidance_window_minutes(99_999), 43200)

    def test_unusable_values_fall_back_to_one_day(self):
        for value in ("1440", None, True, False, [1440], {1: 2}):
            self.assertEqual(guidance_window_minutes(value), 1440)

    def test_float_values_are_truncated(self):
        self.assertEqual(guidance_window_minutes(60.0), 60)
        self.assertEqual(guidance_window_minutes(1440.9), 1440)


class GuidanceWindowSelectionTests(unittest.TestCase):
    def backend(self, messages):
        backend = object.__new__(Backend)
        backend.source = type("Source", (), {"messages": lambda _self, _user, _limit: messages})()
        return backend

    def test_keeps_only_messages_inside_the_window(self):
        now = int(time.time() * 1000)
        messages = [
            {"id": "old", "time": now - 3 * 24 * 60 * 60 * 1000},
            {"id": "yesterday", "time": now - 20 * 60 * 60 * 1000},
            {"id": "recent", "time": now - 5 * 60 * 1000},
        ]
        kept = self.backend(messages)._guidance_window("friend", 1440)
        self.assertEqual([item["id"] for item in kept], ["yesterday", "recent"])

        hour = self.backend(messages)._guidance_window("friend", 60)
        self.assertEqual([item["id"] for item in hour], ["recent"])

        week = self.backend(messages)._guidance_window("friend", 10080)
        self.assertEqual([item["id"] for item in week], ["old", "yesterday", "recent"])

        # An arbitrary window still works (two days keeps yesterday but not the 3-day-old row).
        two_days = self.backend(messages)._guidance_window("friend", 2880)
        self.assertEqual([item["id"] for item in two_days], ["yesterday", "recent"])

    def test_sources_without_timestamps_keep_every_message(self):
        messages = [{"id": "a"}, {"id": "b"}]
        self.assertEqual([item["id"] for item in self.backend(messages)._guidance_window("friend", 60)],
                         ["a", "b"])

    def test_missing_timestamps_are_dropped_when_others_carry_one(self):
        now = int(time.time() * 1000)
        messages = [{"id": "no-time"}, {"id": "recent", "time": now}]
        self.assertEqual([item["id"] for item in self.backend(messages)._guidance_window("friend", 60)],
                         ["recent"])


if __name__ == "__main__":
    unittest.main()
