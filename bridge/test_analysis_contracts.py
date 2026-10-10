"""Synthetic tests for the pure per-message and portrait contract modules."""
from __future__ import annotations

import ast
import sys
import unittest
from pathlib import Path

import backend_contracts
import message_contracts
import portrait_contracts
from node_analysis import NodeAnalysis

ROOT = Path(__file__).resolve().parents[1]
BRIDGE = ROOT / "bridge"
CONTRACT_MODULES = ("message_contracts", "portrait_contracts")


def parsed(name):
    return ast.parse((BRIDGE / (name + ".py")).read_text(encoding="utf-8"))


def imports(tree):
    found = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found.update(item.name.split(".")[0] for item in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            found.add(node.module.split(".")[0])
    return found


class ConstantIdentityTests(unittest.TestCase):
    def test_backend_contracts_reexports_the_same_constant_objects(self):
        self.assertIs(backend_contracts.FINE_LABEL_SCHEMA, message_contracts.FINE_LABEL_SCHEMA)
        self.assertIs(backend_contracts.API_INSIGHT_REVISION, message_contracts.API_INSIGHT_REVISION)
        self.assertIs(backend_contracts.API_PORTRAIT_REVISION, portrait_contracts.API_PORTRAIT_REVISION)
        self.assertIs(backend_contracts.api_insight_scope, message_contracts.api_insight_scope)
        self.assertIs(backend_contracts.api_portrait_scope, portrait_contracts.api_portrait_scope)

    def test_constant_values_and_cache_keys_are_unchanged(self):
        self.assertEqual(message_contracts.FINE_LABEL_SCHEMA, "generic-v9")
        self.assertEqual(message_contracts.API_INSIGHT_REVISION, "free-label-v6-compact")
        self.assertEqual(portrait_contracts.API_PORTRAIT_REVISION, "portrait-v2")
        self.assertEqual(message_contracts.api_insight_scope("api:one"), "api:one:free-label-v6-compact")
        self.assertEqual(portrait_contracts.api_portrait_scope("api:one"), "api:one:portrait-v2")
        self.assertEqual(backend_contracts.api_insight_scope("api:one"), "api:one:free-label-v6-compact")
        self.assertEqual(backend_contracts.api_portrait_scope("api:one"), "api:one:portrait-v2")

    def test_fine_revision_change_does_not_move_the_portrait_scope(self):
        original = message_contracts.API_INSIGHT_REVISION
        try:
            message_contracts.API_INSIGHT_REVISION = "free-label-v6-compact"
            self.assertEqual(message_contracts.api_insight_scope("api:one"), "api:one:free-label-v6-compact")
            # The portrait scope reads its own module constant and is unaffected.
            self.assertEqual(portrait_contracts.api_portrait_scope("api:one"), "api:one:portrait-v2")
            self.assertEqual(backend_contracts.api_portrait_scope("api:one"), "api:one:portrait-v2")
        finally:
            message_contracts.API_INSIGHT_REVISION = original

    def test_portrait_evidence_contract_requires_v3_and_grounded_sources(self):
        valid = portrait_contracts.empty_portrait_evidence()
        self.assertEqual(valid["version"], 3)
        self.assertTrue(portrait_contracts.valid_portrait_evidence(valid))
        item = {"id": "obs-1", "dimension": "topics", "text": "喜欢提前安排",
                "sources": [{"messageId": "m1", "quote": "提前安排", "time": 1, "speaker": "speaker-1"}]}
        self.assertTrue(portrait_contracts.valid_portrait_evidence(
            {**valid, "items": [item]}))
        for invalid in ({"version": 1, "items": [], "legacyPortrait": None},
                        {**valid, "version": 2},
                        {**valid, "unknown": True}, {**valid, "targetCount": True},
                        {**valid, "targetCount": 9007199254740992},
                        {**valid, "items": [{**item, "sources": []}]},
                        {**valid, "items": [{**item, "id": "bad\nvalue"}]},
                        {**valid, "items": [{**item, "dimension": "unknown"}]},
                        {**valid, "items": [{**item, "text": ""}]},
                        {**valid, "items": [item, item]}):
            self.assertFalse(portrait_contracts.valid_portrait_evidence(invalid))

    def test_axis_specific_observations_preserve_the_existing_source_contract(self):
        valid = portrait_contracts.empty_portrait_evidence()
        for dimension in ("mbti_EI", "mbti_SN", "mbti_TF", "mbti_JP"):
            item = {"id": dimension, "dimension": dimension, "text": "合成个人偏好观察",
                    "sources": [{"messageId": "m1", "quote": "合成明确自述",
                                 "time": 1, "speaker": "speaker-1"}]}
            with self.subTest(dimension=dimension):
                self.assertTrue(portrait_contracts.valid_portrait_evidence({**valid, "items": [item]}))
                self.assertFalse(portrait_contracts.valid_portrait_evidence(
                    {**valid, "items": [{**item, "sources": []}]}))
        self.assertEqual(portrait_contracts.PORTRAIT_EVIDENCE_DIMENSIONS,
                         {"summary", "communication", "emotionExpression", "interactionPreferences",
                          "topics", "patterns", "boundaries", "uncertain",
                          "mbti_EI", "mbti_SN", "mbti_TF", "mbti_JP"})

    def test_quote_preserves_source_whitespace_without_permitting_control_characters_elsewhere(self):
        source = {"messageId": "m1", "quote": "合成\n原文\r\t换行", "time": 1, "speaker": "speaker-1"}
        item = {"id": "obs-1", "dimension": "communication", "text": "合成观察", "sources": [source]}
        valid = {**portrait_contracts.empty_portrait_evidence(), "items": [item]}
        self.assertTrue(portrait_contracts.valid_portrait_evidence(valid))
        for field, replacement in (("quote", "坏\x00引文"), ("quote", "坏\x7f引文"),
                                   ("messageId", "m\n1"), ("speaker", "speaker\t1")):
            self.assertFalse(portrait_contracts.valid_portrait_evidence(
                {**valid, "items": [{**item, "sources": [{**source, field: replacement}]}]}))

    def test_synthesis_fingerprint_ignores_progress_but_tracks_evidence_and_eligibility(self):
        item = {"id": "a", "dimension": "topics", "text": "合成观察", "sources": [
            {"messageId": "m1", "quote": "合成原文", "time": 1, "speaker": "speaker-1"}]}
        second = {**item, "id": "b"}
        evidence = {**portrait_contracts.empty_portrait_evidence(), "items": [item, second], "targetCount": 2}
        fingerprint = portrait_contracts.portrait_synthesis_fingerprint
        initial = fingerprint(evidence)
        self.assertEqual(initial, fingerprint({**evidence, "items": [second, item], "batchCount": 6, "targetCount": 99}))
        for change in ({"targetCount": 100}, {"subjectKind": "group"}, {"items": [item]},
                       {"items": [{**item, "text": "另一观察"}, second]}):
            self.assertNotEqual(initial, fingerprint({**evidence, **change}))
        self.assertEqual(fingerprint({**evidence, "targetCount": 100}), fingerprint({**evidence, "targetCount": 101}))
        self.assertIsNone(fingerprint({"invalid": True}))

    def test_optional_mbti_basis_contract_is_bounded_and_independent_of_portrait(self):
        item = {"status": "supported", "kind": "pattern", "reason": "合成行为依据", "evidenceCount": 2}
        basis = {axis: dict(item) for axis in ("EI", "SN", "TF", "JP")}
        self.assertTrue(portrait_contracts.valid_mbti_basis(basis))
        for status in ("supported", "insufficient", "unverified"):
            for kind in ("pattern", "self-report", "unspecified"):
                self.assertTrue(portrait_contracts.valid_mbti_basis(
                    {**basis, "EI": {**item, "status": status, "kind": kind,
                                     "reason": "", "evidenceCount": 0}}))
        for invalid in (None, {}, {**basis, "extra": item},
                        {axis: item for axis in ("EI", "SN", "TF")}):
            self.assertFalse(portrait_contracts.valid_mbti_basis(invalid))
        for replacement in ({"status": "unknown"}, {"kind": "unbounded"}, {"extra": True},
                            {"reason": None}, {"reason": "字" * 161}, {"reason": "不应\n换行"},
                            {"reason": "删除\x7f字符"}, {"evidenceCount": -1},
                            {"evidenceCount": 100001}, {"evidenceCount": True}):
            self.assertFalse(portrait_contracts.valid_mbti_basis(
                {**basis, "EI": {**item, **replacement}}))


class PurityTests(unittest.TestCase):
    def test_contract_modules_depend_only_on_the_standard_library(self):
        for name in CONTRACT_MODULES:
            with self.subTest(module=name):
                self.assertFalse(imports(parsed(name)) - sys.stdlib_module_names - {"__future__"})

    def test_contract_modules_do_not_import_each_other_or_any_service(self):
        for name in CONTRACT_MODULES:
            with self.subTest(module=name):
                found = imports(parsed(name))
                self.assertFalse(found & {
                    "backend_contracts", "backend_service", "real_backend", "real_http",
                    "result_store", "node_analysis", "wechat_source", "model_source", "batch_engine",
                })
        self.assertNotIn("portrait_contracts", imports(parsed("message_contracts")))
        self.assertNotIn("message_contracts", imports(parsed("portrait_contracts")))


class PortraitNodeProtocolTests(unittest.TestCase):
    def test_optional_mbti_basis_survives_node_protocol_and_invalid_metadata_is_ignored(self):
        adapter = NodeAnalysis.__new__(NodeAnalysis)
        portrait = backend_contracts.empty_api_portrait()
        basis = {axis: {"status": "supported", "kind": "pattern", "reason": "合成依据", "evidenceCount": 2}
                 for axis in ("EI", "SN", "TF", "JP")}
        for metadata in (basis, None, {"EI": "invalid"}):
            reply = {"portrait": portrait, "axes": {key: portrait[key]
                     for key in ("affinity", "traits", "mbtiAxes")}}
            if metadata is not None:
                reply["mbtiBasis"] = metadata
                reply["axes"]["mbtiBasis"] = metadata
            adapter._request = lambda *_args, **_kwargs: (reply, None)
            result = adapter.synthesize_portrait("responses", "https://example.test/v1", "synthetic-key",
                                                "test-model", portrait_contracts.empty_portrait_evidence(), 8192)
            axes = adapter.refresh_portrait_axes("responses", "https://example.test/v1", "synthetic-key",
                                                 "test-model", portrait)
            if metadata == basis:
                self.assertEqual(result["mbtiBasis"], basis)
                self.assertEqual(axes["mbtiBasis"], basis)
            else:
                self.assertNotIn("mbtiBasis", result)
                self.assertNotIn("mbtiBasis", axes)
            self.assertEqual(result["portrait"], portrait)
            self.assertNotIn("mbtiBasis", result["portrait"])

    def test_observation_and_synthesis_have_separate_wire_phases(self):
        adapter = NodeAnalysis.__new__(NodeAnalysis)
        calls = []
        evidence = portrait_contracts.empty_portrait_evidence()
        portrait = backend_contracts.empty_api_portrait()
        def request(payload, **kwargs):
            calls.append((payload, kwargs))
            return {"evidence": evidence, "portrait": portrait}, None
        adapter._request = request
        messages = [{"id": "m:0", "messageId": "m", "sender": "OTHER", "target": True,
                     "text": "合成文本", "speaker": "anonymous", "time": 1, "complete": True}]
        self.assertEqual(adapter.extract_portrait_observations(
            "responses", "https://example.test/v1", "synthetic-key", "test-model", messages,
            evidence, "person")["evidence"], evidence)
        self.assertEqual(calls[-1][0]["cmd"], "model:portrait")
        self.assertEqual(calls[-1][0]["phase"], "observe")
        self.assertNotIn("previous", calls[-1][0])
        self.assertNotIn("portrait", calls[-1][0])
        self.assertFalse(calls[-1][1]["require_model"])
        self.assertEqual(adapter.synthesize_portrait(
            "responses", "https://example.test/v1", "synthetic-key", "test-model", evidence,
            8192)["portrait"], portrait)
        self.assertEqual(calls[-1][0]["phase"], "synthesize")
        self.assertEqual(calls[-1][0]["contextTokens"], 8192)
        self.assertNotIn("messages", calls[-1][0])
        self.assertNotIn("previous", calls[-1][0])

    def test_observation_wire_rejects_legacy_evidence_response(self):
        adapter = NodeAnalysis.__new__(NodeAnalysis)
        adapter._request = lambda *_args, **_kwargs: ({"evidence": {"version": 1, "items": []}}, None)
        with self.assertRaisesRegex(RuntimeError, "invalid-portrait"):
            adapter.extract_portrait_observations(
                "responses", "https://example.test/v1", "synthetic-key", "test-model", [])


if __name__ == "__main__":
    unittest.main()
