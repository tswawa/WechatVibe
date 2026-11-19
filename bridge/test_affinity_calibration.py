"""Exact checks for the exponential affinity accumulator shared by every Python path."""
import unittest

from backend_contracts import affinity, affinity_from_progress
from profile_state import (AFFINITY_DECAY, add_exp_score, empty_state,
                           relationship_confidence)


class AffinityCalibrationTests(unittest.TestCase):
    def test_append_matches_direct_exponential_sum(self):
        state = empty_state()
        for _ in range(3):
            add_exp_score(state, .5, 1.0)
        weight = 1 + AFFINITY_DECAY + AFFINITY_DECAY ** 2
        self.assertAlmostEqual(state["confidenceExp"], weight)
        self.assertAlmostEqual(state["scoreExp"], .5 * weight)
        self.assertEqual(affinity_from_progress({**state, "scoreCount": 3}), 75)

    def test_out_of_order_insert_matches_full_recompute(self):
        state = empty_state()
        for score, confidence in ((.2, 1.0), (-.4, .5), (.8, 1.0)):
            add_exp_score(state, score, confidence)
        add_exp_score(state, .9, .7, tail_scores=[-.4, .8], tail_confidences=[.5, 1.0])
        rows = [(.2, 1.0), (.9, .7), (-.4, .5), (.8, 1.0)]
        weights = [AFFINITY_DECAY ** (len(rows) - 1 - index) for index in range(len(rows))]
        self.assertAlmostEqual(state["confidenceExp"],
                               sum(confidence * weight for (_score, confidence), weight
                                   in zip(rows, weights)))
        self.assertAlmostEqual(state["scoreExp"],
                               sum(score * confidence * weight for (score, confidence), weight
                                   in zip(rows, weights)))

    def test_legacy_state_falls_back_without_mixing_formulas(self):
        legacy = {"scoreCount": 2, "scoreSum": 0.0, "scoreWeighted": -1.0}
        self.assertEqual(affinity_from_progress(legacy), 33)
        self.assertEqual(affinity([1, -1]), 48)

    def test_confidence_matches_the_typescript_measure(self):
        self.assertEqual(relationship_confidence({"relationship": [
            {"label": "romantic", "probability": 1}],
            "scoreConfidence": 1}), 1)
        self.assertEqual(relationship_confidence({}), 1.0)
        self.assertEqual(relationship_confidence({"relationship": []}), 0.0)
        self.assertAlmostEqual(relationship_confidence({"relationship": [
            {"label": label, "probability": .2}
            for label in ("romantic", "warm", "neutral", "distant", "rejecting")]}), 0.0)


if __name__ == "__main__":
    unittest.main()
