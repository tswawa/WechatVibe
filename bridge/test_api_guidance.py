"""Contract tests for the API deep-semantic guidance payload and its storage.

The provider output is normalised in ``electron/api-guidance.ts``; these tests pin the
Python-side half of the same contract, including the rule that the self-style switch
owns the ``forSelf`` branch in both directions.
"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from guidance_contracts import (GUIDANCE_REVISION, MAX_REPLIES, MAX_STRATEGIES,
                                guidance_material, guidance_scope, normalize_guidance,
                                valid_guidance)
from result_store import ResultStore


def others(**overrides):
    advice = {"reading": "对方在确认自己的判断", "strategies": ["先给结论"],
              "replies": [{"tone": "稳妥", "text": "收到，我改好后今天发您"}]}
    advice.update(overrides)
    return advice


def guidance(**overrides):
    value = {"version": GUIDANCE_REVISION, "scenario": "leader", "analyzeSelf": False,
             "subtexts": [{"id": "m2", "status": "ok", "surface": "再看看",
                           "implied": "希望我先自查再交付", "tactic": "留台阶",
                           "sentiment": {"polarity": "negative", "label": "有点挑剔"}}],
             "advice": {"forOthers": others(), "forSelf": None}}
    value.update(overrides)
    return value


class GuidanceContractTests(unittest.TestCase):
    def test_accepts_one_complete_reading_with_its_advice(self):
        self.assertTrue(valid_guidance(guidance()))

    def test_requires_the_current_revision(self):
        self.assertFalse(valid_guidance(guidance(version="api-guidance-v0")))
        self.assertEqual(guidance_scope("abc"), "abc:" + GUIDANCE_REVISION)

    def test_self_branch_follows_the_switch_in_both_directions(self):
        # Requested but missing: the UI must not render "no issues found".
        self.assertFalse(valid_guidance(guidance(analyzeSelf=True)))
        with_self = guidance(analyzeSelf=True)
        with_self["advice"]["forSelf"] = {"summary": "回复偏短", "strengths": ["确认及时"],
                                          "improvements": ["先给结论"]}
        self.assertTrue(valid_guidance(with_self))
        # Not requested but present: a contract violation, not a bonus hint.
        self.assertFalse(valid_guidance(with_self | {"analyzeSelf": False}))

    def test_rejects_an_unusable_reading_or_advice(self):
        cases = [
            guidance(subtexts=[]),
            guidance(subtexts=[{"id": "m2", "status": "ok"}]),
            guidance(subtexts=[{"id": "m2", "status": "done", "implied": "猜的"}]),
            guidance(subtexts=[{"id": "m2", "status": "uncertain", "implied": "其实我知道"}]),
            guidance(subtexts=[{"id": "m2", "status": "ok", "implied": "a", "sentiment": {"polarity": "meh"}}]),
            guidance(subtexts=[{"id": "m1", "status": "ok", "implied": "a"},
                               {"id": "m1", "status": "ok", "implied": "b"}]),
            guidance(advice={"forOthers": others(strategies=[]), "forSelf": None}),
            guidance(advice={"forOthers": others(reading=""), "forSelf": None}),
            guidance(advice={"forOthers": others(replies=[]), "forSelf": None}),
            guidance(advice={"forOthers": others(replies=[{"tone": "稳妥"}]), "forSelf": None}),
            guidance(advice={"forOthers": others(strategies=["一"] * (MAX_STRATEGIES + 1)),
                             "forSelf": None}),
            guidance(advice={"forOthers": others(replies=[{"text": "好"}] * (MAX_REPLIES + 1)),
                             "forSelf": None}),
        ]
        for value in cases:
            with self.subTest(repr(value)[:120]):
                self.assertFalse(valid_guidance(value))
                self.assertIsNone(normalize_guidance(value))

    def test_keeps_every_field_and_drops_only_optional_extras(self):
        value = guidance(usage={"inputTokens": 10}, responseId="resp-1")
        self.assertTrue(valid_guidance(value))
        stored = normalize_guidance(value)
        self.assertEqual(stored["subtexts"][0]["sentiment"],
                         {"polarity": "negative", "label": "有点挑剔"})
        self.assertNotIn("usage", stored)
        self.assertEqual(stored["advice"]["forOthers"]["replies"],
                         [{"tone": "稳妥", "text": "收到，我改好后今天发您"}])

    def test_rejects_control_characters_and_unknown_keys(self):
        self.assertFalse(valid_guidance(guidance(extra=True)))
        self.assertFalse(valid_guidance(
            guidance(subtexts=[{"id": "m2", "status": "ok", "implied": "带\n换行"}])))


class GuidanceStoreTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = ResultStore(os.path.join(self.directory.name, "guidance.sqlite3"))

    def test_saves_reads_and_replaces_one_scope(self):
        scope_a = guidance_scope("api-a")
        scope_b = guidance_scope("api-b")
        self.assertIsNone(self.store.api_guidance_get("acct", "friend", scope_a, "friend"))
        first = normalize_guidance(guidance())
        self.store.api_guidance_save("acct", "friend", scope_a, "friend", first)
        saved = self.store.api_guidance_get("acct", "friend", scope_a, "friend")
        self.assertEqual(saved["guidance"], first)
        self.assertEqual(saved["scenario"], "leader")
        self.assertFalse(saved["analyzeSelf"])
        self.assertGreater(saved["updatedAt"], 0)

        second = normalize_guidance(guidance(scenario="general"))
        self.store.api_guidance_save("acct", "friend", scope_a, "friend", second)
        self.assertEqual(self.store.api_guidance_get("acct", "friend", scope_a, "friend")
                         ["guidance"]["scenario"], "general")
        # Another source keeps its own result; the scope carries the prompt revision.
        self.assertIsNone(self.store.api_guidance_get("acct", "friend", scope_b, "friend"))

    def test_a_damaged_row_is_dropped_instead_of_surfaced(self):
        self.store.api_guidance_save("acct", "friend", guidance_scope("api-a"), "friend",
                                     normalize_guidance(guidance()))
        with self.store.connect() as conn:
            conn.execute("UPDATE api_guidance_v1 SET payload_json='{\"version\":\"x\"}' "
                         "WHERE account='acct'")
        self.assertIsNone(self.store.api_guidance_get("acct", "friend",
                                                      guidance_scope("api-a"), "friend"))
        with self.store.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM api_guidance_v1").fetchone()[0], 0)

    def test_clearing_one_source_leaves_the_other_intact(self):
        self.store.api_guidance_save("acct", "friend", guidance_scope("api-a"), "friend",
                                     normalize_guidance(guidance()))
        self.store.api_guidance_save("acct", "friend", guidance_scope("api-b"), "friend",
                                     normalize_guidance(guidance()))
        self.store.clear_analysis_cache("acct", "api-a")
        self.assertIsNone(self.store.api_guidance_get("acct", "friend",
                                                      guidance_scope("api-a"), "friend"))
        self.assertIsNotNone(self.store.api_guidance_get("acct", "friend",
                                                         guidance_scope("api-b"), "friend"))


class GuidanceLatestTests(unittest.TestCase):
    """The assistant cites one stored result per conversation, whatever source produced it."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = ResultStore(os.path.join(self.directory.name, "latest.sqlite3"))

    def save(self, user, source, subject, value=None):
        self.store.api_guidance_save("acct", user, guidance_scope(source), subject,
                                     normalize_guidance(value or guidance()))

    def test_returns_the_newest_row_across_sources(self):
        self.assertIsNone(self.store.api_guidance_latest("acct", "friend"))
        self.save("friend", "api-a", "friend", guidance(scenario="general"))
        self.save("friend", "api-b", "friend", guidance(scenario="leader"))
        latest = self.store.api_guidance_latest("acct", "friend")
        self.assertEqual(latest["scenario"], "leader")
        self.assertEqual(latest["sourceId"], guidance_scope("api-b"))
        self.assertEqual(latest["subject"], "friend")
        self.assertGreater(latest["updatedAt"], 0)

    def test_prefers_the_conversation_row_over_a_member_row(self):
        # A group chat can hold one reading per member; the conversation-level one is the
        # reading of the conversation the assistant is answering about.
        self.save("room@g", "api-a", "room@g")
        self.save("room@g", "api-a", "member-x", guidance(scenario="general"))
        self.assertEqual(self.store.api_guidance_latest("acct", "room@g")["subject"], "room@g")
        self.save("room@g", "api-a", "room@g", guidance(scenario="general"))
        self.assertEqual(self.store.api_guidance_latest("acct", "room@g")["scenario"], "general")

    def test_a_damaged_row_is_dropped_instead_of_cited(self):
        self.save("friend", "api-a", "friend")
        with self.store.connect() as conn:
            conn.execute("UPDATE api_guidance_v1 SET payload_json='{\"version\":\"x\"}'")
        self.assertIsNone(self.store.api_guidance_latest("acct", "friend"))
        with self.store.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM api_guidance_v1").fetchone()[0], 0)

    def test_another_conversation_is_not_cited(self):
        self.save("friend", "api-a", "friend")
        self.assertIsNone(self.store.api_guidance_latest("acct", "other"))


class GuidanceMaterialTests(unittest.TestCase):
    """What the assistant reads as reference material, derived from the stored payload."""

    def material(self, **overrides):
        value = guidance(**overrides)
        return guidance_material({"scenario": value["scenario"], "subject": "friend",
                                  "guidance": value})

    def test_renders_the_saved_reading_and_advice(self):
        text = self.material()
        self.assertIn("潜台词与沟通建议", text)
        self.assertIn("场景：与领导／上级", text)
        self.assertIn("解读对象：friend", text)
        self.assertIn("表面「再看看」", text)
        self.assertIn("可能「希望我先自查再交付」", text)
        self.assertIn("手法：留台阶", text)
        self.assertIn("倾向：偏负面", text)
        self.assertIn("情绪：有点挑剔", text)
        self.assertIn("局势：对方在确认自己的判断", text)
        self.assertIn("- 先给结论", text)
        self.assertIn("「收到，我改好后今天发您」（语气：稳妥）", text)
        self.assertNotIn("针对自己", text)

    def test_renders_the_self_branch_only_when_the_switch_was_on(self):
        value = guidance(analyzeSelf=True)
        value["advice"]["forSelf"] = {"summary": "回复偏短", "strengths": ["确认及时"],
                                      "improvements": ["先给结论"]}
        text = guidance_material({"scenario": "general", "guidance": value})
        self.assertIn("针对自己：回复偏短", text)
        self.assertIn("做得好的：确认及时", text)
        self.assertIn("可以改进：先给结论", text)

    def test_reports_a_terminal_reading_without_inventing_one(self):
        text = self.material(subtexts=[{"id": "m2", "status": "uncertain"},
                                       {"id": "m3", "status": "insufficient"}])
        self.assertIn("1. 不确定", text)
        self.assertIn("2. 信息不足", text)

    def test_nothing_to_cite_renders_empty(self):
        self.assertEqual(guidance_material(None), "")
        self.assertEqual(guidance_material({}), "")
        self.assertEqual(guidance_material({"guidance": {"version": GUIDANCE_REVISION}}), "")


if __name__ == "__main__":
    unittest.main()
