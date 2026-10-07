"""Tail evidence must never fail a run whose saved state has lost it (issue #24).

The three accumulators below all merge "tail" rows - evidence newer than the row being
inserted - into a state that was loaded from storage. When the saved state and the
stored details disagree (the analysis details are kept while the progress record is
cleared, or a summary is rebuilt from a partial pass) the tail carries a label the state
no longer has, and the direct subscript raised KeyError forever after. These tests pin
the recover-instead-of-crash behaviour and the unchanged numbers for healthy states.
They touch no database, model, account or network.
"""
from __future__ import annotations

import unittest

import batch_state
import profile_state
from result_store import ResultStore


def _emotion(raw, label, probability):
    return {"label": label, "rawLabel": raw, "probability": probability}


class BatchStateTailTest(unittest.TestCase):
    def test_tail_label_missing_from_the_progress_state_is_recovered(self):
        state = batch_state.empty_state()
        state["moodCount"] = 2
        batch_state._merge(state, {"emotion": [_emotion("happy", "开心", 0.8)]}, 1,
                           (3, "message__message_0.db", 7), {}, False, "friend",
                           tail_emotions=[[_emotion("sad", "难过", 0.6)]])
        self.assertEqual(state["mood"]["sad"],
                         {"label": "难过", "sum": 0.0, "weighted": 0.6})

    def test_tail_label_the_progress_state_still_has_keeps_its_sum(self):
        state = batch_state.empty_state()
        state["moodCount"] = 2
        state["mood"]["sad"] = {"label": "难过", "sum": 0.9, "weighted": 0.4}
        batch_state._merge(state, {"emotion": [_emotion("happy", "开心", 0.8)]}, 1,
                           (3, "message__message_0.db", 7), {}, False, "friend",
                           tail_emotions=[[_emotion("sad", "难过", 0.6)]])
        self.assertEqual(state["mood"]["sad"],
                         {"label": "难过", "sum": 0.9, "weighted": 1.0})


class ProfileStateTailTest(unittest.TestCase):
    def test_backfill_tail_label_missing_from_the_state_is_recovered(self):
        state = profile_state.empty_state()
        tails = [({"emotion": [_emotion("sad", "难过", 0.6)]}, None)]
        profile_state.add_result(state, {"emotion": [_emotion("happy", "开心", 0.8)]}, 0.5,
                                 "other", (3, "message__message_0.db", 7), {}, tails)
        self.assertEqual(state["mood"]["sad"],
                         {"label": "难过", "sum": 0.0, "weighted": 0.6})


class SummaryTailTest(unittest.TestCase):
    def test_tail_label_missing_from_the_summary_keeps_its_display_label(self):
        summary = {"moodCount": 0, "mood": {}}
        ResultStore._add_emotion(summary, [_emotion("happy", "开心", 0.8)], 0,
                                 {"sad": ("难过", 0.6)})
        self.assertEqual(summary["mood"]["sad"],
                         {"label": "难过", "sum": 0.0, "weighted": 0.6})
        self.assertEqual(summary["mood"]["happy"]["sum"], 0.8)

    def test_tail_label_the_summary_still_has_keeps_its_sum(self):
        summary = {"moodCount": 1,
                   "mood": {"sad": {"label": "难过", "sum": 0.5, "weighted": 0.2}}}
        ResultStore._add_emotion(summary, [_emotion("happy", "开心", 0.8)], 0,
                                 {"sad": ("难过", 0.6)})
        self.assertEqual(summary["mood"]["sad"],
                         {"label": "难过", "sum": 0.5, "weighted": 0.8})


if __name__ == "__main__":
    unittest.main()
