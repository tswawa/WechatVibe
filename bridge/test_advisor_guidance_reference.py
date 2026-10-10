"""The guidance skill, its builtin assistant, and the reference material a run receives.

``tests/api-guidance.test.ts`` and ``test_api_guidance.py`` own the guidance payload and its
storage; this file pins what the assistant adds on top: the builtin skill/assistant pair that
replaced the persona page's card, and the decision about which reference material one run is
told about the saved analysis.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from advisor_contracts import (GUIDANCE_SKILL_ID, builtin_agent_ids, builtin_agents,
                               builtin_skill_ids, builtin_skills)
from advisor_service import AdvisorService
from guidance_contracts import GUIDANCE_MISSING_NOTE
from test_api_guidance import guidance


class BuiltinGuidanceTests(unittest.TestCase):
    def test_ships_one_skill_and_one_assistant_for_subtext_and_advice(self):
        self.assertIn(GUIDANCE_SKILL_ID, builtin_skill_ids())
        skills = {skill["id"]: skill for skill in builtin_skills()}
        skill = skills[GUIDANCE_SKILL_ID]
        self.assertEqual(skill["name"], "潜台词与沟通建议")
        self.assertTrue(skill["builtin"])
        for keyword in ("潜台词", "建议", "场景", "不确定"):
            self.assertIn(keyword, skill["content"])

        agents = {agent["id"]: agent for agent in builtin_agents()}
        self.assertIn("builtin:guidance", agents)
        assistant = agents["builtin:guidance"]
        self.assertEqual(assistant["skillIds"], [GUIDANCE_SKILL_ID])
        self.assertEqual(assistant["name"], "沟通参谋")
        self.assertTrue(assistant["builtin"])
        # The same ids the store validates `deletedBuiltin*Ids` against.
        self.assertEqual(set(agents), set(builtin_agent_ids()))


class GuidanceReferenceTests(unittest.TestCase):
    """`_guidance_material` decides what one run is told about the saved analysis."""

    def service(self, provider):
        # No engine, store or source is needed to exercise this decision: the method only
        # turns a provider answer into material, so the instance is built without a run.
        service = AdvisorService.__new__(AdvisorService)
        service.guidance_provider = provider
        return service

    def test_passes_a_saved_reading_through_as_reference_material(self):
        saved = {"scenario": "leader", "subject": "friend", "guidance": guidance()}
        service = self.service(lambda account, user: saved)
        text = service._guidance_material("acct", "friend", [])
        self.assertIn("潜台词与沟通建议", text)
        self.assertIn("局势：对方在确认自己的判断", text)

    def test_tells_a_guidance_run_to_analyse_when_nothing_is_saved(self):
        service = self.service(lambda account, user: None)
        self.assertEqual(service._guidance_material("acct", "friend", [{"id": GUIDANCE_SKILL_ID}]),
                         GUIDANCE_MISSING_NOTE)
        # A run that did not pick the skill is not nudged: this is not its job.
        self.assertEqual(
            service._guidance_material("acct", "friend", [{"id": "builtin-skill:advisor"}]), "")

    def test_ignores_a_saved_row_that_no_longer_satisfies_the_contract(self):
        saved = {"scenario": "general", "guidance": {"version": "api-guidance-v0"}}
        service = self.service(lambda account, user: saved)
        self.assertEqual(service._guidance_material("acct", "friend", [{"id": GUIDANCE_SKILL_ID}]),
                         GUIDANCE_MISSING_NOTE)

    def test_a_broken_provider_never_fails_the_run(self):
        def broken(account, user):
            raise RuntimeError("result store is gone")

        self.assertEqual(
            self.service(broken)._guidance_material("acct", "friend", [{"id": GUIDANCE_SKILL_ID}]),
            GUIDANCE_MISSING_NOTE)
        self.assertEqual(self.service(None)._guidance_material("acct", "friend", []), "")


if __name__ == "__main__":
    unittest.main()
