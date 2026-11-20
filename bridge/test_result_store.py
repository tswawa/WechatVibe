"""Read-side legacy API evidence counts, using only synthetic SQLite rows."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from backend_contracts import empty_api_portrait
from portrait_contracts import empty_portrait_evidence
from result_store import ResultStore


class LegacyMbtiEvidenceTests(unittest.TestCase):
    def setUp(self):
        scratch = Path(__file__).resolve().parents[1] / ".local" / "test-temp"
        scratch.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix="result-store-", dir=scratch)
        self.addCleanup(temporary.cleanup)
        self.store = ResultStore(Path(temporary.name) / "synthetic.sqlite3")
        self.identity = ("synthetic-account", "synthetic-session", "synthetic-api", "synthetic-person")
        self.available = {"messageCount": 2200, "textCount": 2200, "targetTextCount": 2126,
                          "totalChars": 8000, "mbtiEvidenceCount": 9999}

    def seed(self, resume):
        self.raw_resume = json.dumps(resume) if resume is not None else None
        self.raw_available = json.dumps(self.available)
        with self.store.connect() as conn:
            conn.execute("INSERT OR REPLACE INTO api_portrait_v1 VALUES "
                         "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                         (*self.identity, None, None, "synthetic-fingerprint", self.raw_available,
                          "[]", 0, 0, 2126, 8000, json.dumps(empty_api_portrait()), self.raw_resume))

    def read(self):
        return self.store.api_portrait_get(*self.identity)

    def test_count_comes_from_valid_observation_ledger_not_progress_or_inventory(self):
        for count in (0, 30, 100, 9007199254740991):
            with self.subTest(count=count):
                self.seed({"portraitEvidence": {**empty_portrait_evidence(), "targetCount": count}})
                result = self.read()
                self.assertEqual(result["available"]["mbtiEvidenceCount"], count)
                self.assertEqual(result["available"]["targetTextCount"], 2126)
                self.assertEqual(result["processed"], 2126)

    def test_missing_or_rejected_observation_ledger_cannot_unlock(self):
        evidence = {**empty_portrait_evidence(), "targetCount": 120}
        invalid = [None, {}, {"portraitEvidence": None}]
        invalid += [{"portraitEvidence": {**evidence, "targetCount": value}}
                    for value in (-1, True, "120", 1.5, 9007199254740992)]
        invalid += [{"portraitEvidence": {**evidence, "version": 2}},
                    {"portraitEvidence": {**evidence, "items": [{"id": "ungrounded"}]}}]
        for resume in invalid:
            with self.subTest(resume=resume):
                self.seed(resume)
                result = self.read()
                self.assertEqual(result["available"]["mbtiEvidenceCount"], 0)
                self.assertNotIn("portraitEvidence", result["resume"] or {})

    def test_read_preserves_valid_axis_basis_without_mutating_the_saved_checkpoint(self):
        basis = {axis: {"status": "supported", "kind": "pattern", "reason": "合成观察依据",
                        "evidenceCount": count}
                 for axis, count in zip(("EI", "SN", "TF", "JP"), (2, 7, 11, 0))}
        self.seed({"portraitEvidence": {**empty_portrait_evidence(), "targetCount": 120},
                   "mbtiBasis": basis})
        self.assertEqual(self.read()["resume"]["mbtiBasis"], basis)
        with self.store.connect() as conn:
            raw = conn.execute("SELECT available_json,resume_json FROM api_portrait_v1").fetchone()
        self.assertEqual(raw, (self.raw_available, self.raw_resume), "GET cannot rewrite old checkpoints")
        invalid_basis = deepcopy(basis)
        invalid_basis["EI"]["evidenceCount"] = True
        self.seed({"portraitEvidence": {**empty_portrait_evidence(), "targetCount": 120},
                   "mbtiBasis": invalid_basis})
        result = self.read()
        self.assertNotIn("mbtiBasis", result["resume"])
        self.assertEqual(result["available"]["mbtiEvidenceCount"], 120)


class ProfileStateIncrementTests(unittest.TestCase):
    """The incremental profile path must stay correct when new rows are inserted."""

    def setUp(self):
        scratch = Path(__file__).resolve().parents[1] / ".local" / "test-temp"
        scratch.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix="result-store-profile-", dir=scratch)
        self.addCleanup(temporary.cleanup)
        self.store = ResultStore(Path(temporary.name) / "profile.sqlite3")
        self.scope = ("synthetic-account", "synthetic-session", "synthetic-version")

    def seed(self, message_id, sort_seq, side="other"):
        with self.store.connect() as conn:
            conn.execute("INSERT OR REPLACE INTO results_v2 VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                         (*self.scope[:2], message_id, sort_seq, "shard", sort_seq, "sender",
                          side, json.dumps({"emotion": [], "intent": []}), 0.5, self.scope[2]))

    def profile(self):
        return self.store.profile_state(*self.scope, None, lambda refs: {})

    def test_incremental_and_out_of_order_rows_are_counted_without_full_rebuild(self):
        self.seed("m1", 1)
        self.seed("m2", 2)
        self.assertEqual(self.profile()["targetCount"], 2)
        self.seed("m3", 3)
        self.assertEqual(self.profile()["targetCount"], 3)
        # A backfilled row older than the stored latest uses the batched tail path.
        self.seed("m0", 0)
        state = self.profile()
        self.assertEqual(state["targetCount"], 4)
        self.assertEqual(state["count"], 4)


if __name__ == "__main__":
    unittest.main()
