"""Pure contract tests: limits, presets, skill hygiene, budget and event shapes."""
import unittest

from advisor_contracts import (
    AdvisorError, builtin_agents, builtin_skills, char_budget, compress_key,
    model_fingerprint, normalize_agent_payload, normalize_event, normalize_skill,
    public_context, public_run, terminal_event, valid_identifier, valid_request_id,
    valid_user_message,
)


class ValidationTests(unittest.TestCase):
    def test_agent_payload_limits(self):
        base = {"name": "自定义", "description": "说明", "prompt": "提示", "skillIds": []}
        self.assertEqual(normalize_agent_payload(base)["name"], "自定义")
        for field, value in (("name", "x" * 61), ("description", "x" * 241),
                             ("prompt", "x" * 16001)):
            with self.subTest(field=field):
                with self.assertRaises(AdvisorError) as caught:
                    normalize_agent_payload({**base, field: value})
                self.assertEqual(caught.exception.code, "invalid-request")
        with self.assertRaises(AdvisorError):
            normalize_agent_payload({**base, "skillIds": ["ok", "ok"]})
        with self.assertRaises(AdvisorError):
            normalize_agent_payload({**base, "name": "\x01bad"})

    def test_user_message_and_request_id_bounds(self):
        self.assertEqual(valid_user_message("你好"), "你好")
        with self.assertRaises(AdvisorError):
            valid_user_message("")
        with self.assertRaises(AdvisorError):
            valid_user_message(" ")
        with self.assertRaises(AdvisorError):
            valid_user_message("x" * 16001)
        self.assertEqual(valid_request_id("req-1"), "req-1")
        with self.assertRaises(AdvisorError):
            valid_request_id("../etc")
        self.assertIsNone(valid_request_id(None))

    def test_identifier_accepts_preset_and_generated_shapes(self):
        for value in ("builtin:advisor", "agent:abc123", "thread:3f", "run:99"):
            self.assertTrue(valid_identifier(value))
        for value in ("", "has space", "a" * 81, ":leading"):
            self.assertFalse(valid_identifier(value))

    def test_skill_import_rejects_urls_paths_and_scripts(self):
        for content in ("见 https://example.com", "读取 C:\\Users\\x", "\\\\server\\share",
                        "#!/bin/sh", "<script>alert(1)</script>", "javascript:alert(1)",
                        "run eval(text)"):
            with self.subTest(content=content):
                with self.assertRaises(AdvisorError) as caught:
                    normalize_skill("技能", "说明", content)
                self.assertEqual(caught.exception.code, "invalid-request")
        self.assertIn("观察", normalize_skill("技能", "说明", "观察、感受、需要、请求")["content"])

    def test_presets_exist_and_at_least_one_is_enabled(self):
        agents = builtin_agents()
        ids = [agent["id"] for agent in agents]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertTrue(all(agent["builtin"] for agent in agents))
        self.assertTrue(any(agent["enabled"] for agent in agents))
        # `沟通参谋` ships with this fork's 潜台词与沟通建议 skill.
        self.assertEqual({agent["name"] for agent in agents},
                         {"狗头军师", "共情沟通", "理性复盘", "沟通参谋"})
        skill_ids = {skill["id"] for skill in builtin_skills()}
        for agent in agents:
            self.assertTrue(set(agent["skillIds"]) <= skill_ids)


class BudgetAndEventTests(unittest.TestCase):
    def test_char_budget_is_conservative_and_bounded(self):
        self.assertEqual(char_budget(4096), (4096 - 1024) * 55 // 100)
        self.assertGreater(char_budget(32768), char_budget(8192))
        self.assertEqual(char_budget(None), char_budget(8192))
        self.assertEqual(char_budget("nonsense"), char_budget(8192))

    def test_compression_keys_and_model_fingerprints_are_stable(self):
        first = compress_key("u1", 1, "r1", "r9")
        self.assertEqual(first, compress_key("u1", 1, "r1", "r9"))
        self.assertNotEqual(first, compress_key("u1", 1, "r1", "r8"))
        self.assertEqual(model_fingerprint("a", "b", "c", 1), model_fingerprint("a", "b", "c", 1))
        self.assertNotEqual(model_fingerprint("a", "b", "c", 1), model_fingerprint("a", "b", "d", 1))

    def test_event_normalization_drops_unknown_and_terminal_types(self):
        self.assertEqual(normalize_event({"type": "text", "text": "hi"}, 4),
                         {"seq": 4, "type": "text", "text": "hi"})
        self.assertIsNone(normalize_event({"type": "mystery"}, 1))
        self.assertIsNone(normalize_event({"type": "done"}, 1))
        self.assertIsNone(normalize_event("not a dict", 1))
        terminal = terminal_event(7, "done", state="done", message_id="msg:1")
        self.assertEqual(terminal, {"seq": 7, "type": "done", "state": "done", "messageId": "msg:1"})

    def test_public_shapes_omit_empty_optional_fields(self):
        self.assertEqual(public_context(None), {"state": "idle", "revision": 0, "readCount": 0})
        self.assertEqual(public_context({"state": "ready", "revision": 3, "read_count": 9,
                                         "total_count": None, "error": None}),
                         {"state": "ready", "revision": 3, "readCount": 9})
        self.assertEqual(public_run({"id": "run:1", "thread_id": "t:1", "state": "done"}),
                         {"id": "run:1", "threadId": "t:1", "state": "done"})


if __name__ == "__main__":
    unittest.main()
