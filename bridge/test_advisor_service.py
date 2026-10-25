"""Synthetic service tests: runs, events, stop, restart projection and account clear."""
import tempfile
import threading
import time
import unittest
from pathlib import Path

from advisor_contracts import AdvisorError
from advisor_service import AdvisorService
from backend_contracts import AccountChangedError
from model_source import ModelSourceStore
from test_advisor_support import FakeModelStore, FakeRuntime, FakeSource, wait_until

ACCOUNT = "synthetic-account-1"
USER = "user-a"
AGENT = "builtin:advisor"


class ServiceTestCase(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.source = FakeSource(account=ACCOUNT)
        self.source.seed_pages(USER, 300)
        self.model_store = FakeModelStore(context_tokens=32768)
        self.runtime = FakeRuntime()
        self.service = self.build_service()
        self.addCleanup(self.service.shutdown)

    def build_service(self, runtime=None, runtime_factory="default"):
        if runtime_factory == "default":
            runtime_factory = (lambda: runtime or self.runtime)
        return AdvisorService(self.source, self.model_store, self.root,
                              runtime_factory=runtime_factory)

    # -- helpers -------------------------------------------------------------
    def context(self):
        return self.service.context.snapshot(ACCOUNT, USER)

    def wait_context_ready(self):
        self.service.prepare_context(ACCOUNT, USER)
        ready = wait_until(lambda: self.context() if self.context()["state"] == "ready" else None)
        self.assertIsNotNone(ready, "context did not become ready")
        return ready

    def wait_run(self, run_id, states=("done", "stopped", "error"), service=None):
        service = service or self.service

        def terminal():
            result = service.events(ACCOUNT, USER, run_id, 0)
            return result if result["run"]["state"] in states else None

        result = wait_until(terminal)
        self.assertIsNotNone(result, "run did not reach a terminal state")
        return result

    def messages(self):
        return self.service.thread(ACCOUNT, USER, AGENT)["thread"]["messages"]


class CatalogTests(ServiceTestCase):
    def test_default_catalog_and_mutations_never_call_the_model(self):
        catalog = self.service.catalog()
        self.assertEqual(catalog["permissions"], {"readOnly": True})
        self.assertEqual(catalog["engine"], {"state": "available"})
        self.assertEqual(len(catalog["agents"]), 4)
        self.assertTrue(all(agent["revision"] >= 1 for agent in catalog["agents"]))
        created = self.service.save_template({"action": "save", "agent": {
            "name": "我的参谋", "description": "", "prompt": "帮我分析",
            "skillIds": ["builtin-skill:advisor"]}})
        custom = [agent for agent in created["agents"] if not agent["builtin"]]
        self.assertEqual(len(custom), 1)
        disabled = self.service.save_template({"action": "enable",
                                               "id": custom[0]["id"], "enabled": False})
        self.assertFalse([agent for agent in disabled["agents"]
                          if agent["id"] == custom[0]["id"]][0]["enabled"])
        imported = self.service.import_skill({"name": "倾听", "description": "说明",
                                              "content": "先倾听再回应。"})
        self.assertIn("倾听", [skill["name"] for skill in imported["skills"]])
        deleted = self.service.save_template({"action": "delete", "id": custom[0]["id"]})
        self.assertNotIn(custom[0]["id"], [agent["id"] for agent in deleted["agents"]])
        catalog = self.service.save_template({"action": "delete", "id": AGENT})
        self.assertNotIn(AGENT, [row["id"] for row in catalog["agents"]])
        self.assertEqual(self.runtime.respond_calls, [])
        self.assertEqual(self.runtime.compact_calls, [])

    def test_broken_store_reports_engine_missing(self):
        service = self.build_service(runtime_factory=None)
        service.model_source_store = FakeModelStore(mode="broken")
        self.addCleanup(service.shutdown)
        self.assertEqual(service.catalog()["engine"], {"state": "missing"})


class RunTests(ServiceTestCase):
    def test_run_streams_events_and_persists_projection(self):
        ready = self.wait_context_ready()
        self.runtime.finish_gate = threading.Event()
        result = self.service.start(ACCOUNT, USER, AGENT, None, "我该怎么回复？", "req-1")
        run_id = result["run"]["id"]
        self.assertEqual(result["run"]["state"], "running")
        # The transcript shows the user message while the run is still generating.
        during = self.service.thread(ACCOUNT, USER, AGENT)
        self.assertEqual([message["role"] for message in during["thread"]["messages"]], ["user"])
        self.assertEqual(during["run"]["state"], "running")
        self.runtime.finish_gate.set()
        terminal = self.wait_run(run_id)
        self.assertEqual(terminal["run"]["state"], "done")
        self.assertIn("thread", terminal)
        kinds = [event["type"] for event in terminal["events"]]
        self.assertIn("reasoning", kinds)
        self.assertIn("text", kinds)
        self.assertIn("done", kinds)
        sequences = [event["seq"] for event in terminal["events"]]
        self.assertEqual(sequences, sorted(sequences))
        self.assertEqual(len(sequences), len(set(sequences)))
        messages = terminal["thread"]["messages"]
        self.assertEqual([message["role"] for message in messages], ["user", "assistant"])
        self.assertEqual(messages[1]["text"], self.runtime.text)
        self.assertNotIn("status", messages[1])
        self.assertEqual(terminal["thread"]["runtimeSessionId"], "sess-1")
        self.assertEqual(self.context()["readCount"], 300)
        self.assertEqual(self.context()["revision"], ready["revision"])

        config, request = self.runtime.respond_calls[0]
        self.assertEqual(config["apiKey"], "synthetic-key")
        self.assertTrue(config["stateDir"].endswith("opencode"))
        self.assertIn("狗头军师", request["system"])
        self.assertNotIn("参谋建议框架", request["system"])
        self.assertEqual(request["agentId"], AGENT)
        self.assertIn("参谋建议框架", request["skills"][0]["content"])
        self.assertEqual(request["message"], "我该怎么回复？")
        self.assertEqual(request["selectedSkillIds"], ["builtin-skill:advisor"])
        self.assertEqual(request["contextRevision"], ready["revision"])
        self.assertNotIn("contextMessageCount", request)
        self.assertNotIn("context", request)
        self.assertIn("[最近聊天记录]", request["contextFileText"])
        self.assertIn("消息内容 1", request["contextFileText"])
        self.assertIn("消息内容 300", request["contextFileText"])
        self.assertNotIn("我该怎么回复？", request["contextFileText"])

        second = self.service.start(ACCOUNT, USER, AGENT, result["threadId"], "再想想", "req-2")
        self.wait_run(second["run"]["id"])
        self.assertEqual(self.runtime.respond_calls[1][1]["runtimeSessionId"], "sess-1")
        self.assertEqual([message["role"] for message in self.messages()],
                         ["user", "assistant", "user", "assistant"])

    def test_prepare_context_alone_never_calls_the_model(self):
        self.wait_context_ready()
        self.assertEqual(self.runtime.respond_calls, [])
        self.assertEqual(self.runtime.compact_calls, [])

    def test_early_run_waits_without_adding_a_reading_flow_to_the_timeline(self):
        self.source.page_delay = 0.05
        self.service.prepare_context(ACCOUNT, USER)
        result = self.service.start(ACCOUNT, USER, AGENT, None, "先看一点", "req-early")
        run_id = result["run"]["id"]
        thread = self.service.thread(ACCOUNT, USER, AGENT)["thread"]
        roles = [(message["role"], message.get("status")) for message in thread["messages"]]
        self.assertEqual(roles[0], ("user", None))
        self.assertEqual(roles, [("user", None)])
        self.assertNotIn("state", self.service.thread(ACCOUNT, USER, AGENT)["context"])
        self.source.page_delay = 0
        terminal = self.wait_run(run_id)
        self.assertEqual(terminal["run"]["state"], "done")
        after_all = self.service.events(ACCOUNT, USER, run_id, 10 ** 6)
        self.assertEqual(after_all["events"], [])

    def test_stop_preserves_partial_output_and_blocks_late_save(self):
        self.wait_context_ready()
        self.runtime.pause_after_first_chunk = True
        result = self.service.start(ACCOUNT, USER, AGENT, None, "停一下", "req-stop")
        run_id = result["run"]["id"]
        self.assertTrue(wait_until(self.runtime.paused.is_set))
        stopped = self.service.stop(ACCOUNT, USER, run_id)
        self.assertEqual(stopped["run"]["state"], "stopped")
        assistant = [message for message in self.messages() if message["role"] == "assistant"]
        self.assertEqual(len(assistant), 1)
        self.assertEqual(assistant[0]["text"], "这是合")
        self.assertEqual(assistant[0]["status"], "stopped")
        # Late runtime output after the stop must not create another transcript row.
        time.sleep(0.2)
        self.assertEqual(len([message for message in self.messages()
                              if message["role"] == "assistant"]), 1)
        terminal = self.service.events(ACCOUNT, USER, run_id, 0)
        self.assertEqual(terminal["run"]["state"], "stopped")
        self.assertEqual(terminal["events"][-1]["type"], "done")
        self.assertEqual(terminal["events"][-1]["state"], "stopped")

    def test_new_thread_cancels_visible_run_and_keeps_context(self):
        self.wait_context_ready()
        self.runtime.pause_after_first_chunk = True
        started = self.service.start(ACCOUNT, USER, AGENT, None, "第一线程", "req-new-1")
        self.assertTrue(wait_until(self.runtime.paused.is_set))
        created = self.service.new_thread(ACCOUNT, USER, AGENT)
        self.assertNotEqual(created["thread"]["id"], started["threadId"])
        self.assertEqual(created["thread"]["messages"], [])
        self.assertEqual(set(created["context"]), {"revision"})
        old = self.service.events(ACCOUNT, USER, started["run"]["id"], 0)
        self.assertEqual(old["run"]["state"], "stopped")
        self.runtime.pause_after_first_chunk = False
        second = self.service.start(ACCOUNT, USER, AGENT, created["thread"]["id"], "新的开始",
                                    "req-new-2")
        self.wait_run(second["run"]["id"])
        self.assertEqual(len(self.messages()), 2)

    def test_request_id_is_idempotent_and_one_run_per_thread(self):
        self.wait_context_ready()
        self.runtime.pause_after_first_chunk = True
        first = self.service.start(ACCOUNT, USER, AGENT, None, "重复请求", "req-same")
        again = self.service.start(ACCOUNT, USER, AGENT, first["threadId"], "重复请求", "req-same")
        self.assertEqual(first["run"]["id"], again["run"]["id"])
        with self.assertRaises(AdvisorError) as caught:
            self.service.start(ACCOUNT, USER, AGENT, first["threadId"], "另一个", "req-other")
        self.assertEqual(caught.exception.code, "run-active")
        self.service.stop(ACCOUNT, USER, first["run"]["id"])
        self.assertEqual(len([message for message in self.messages()
                              if message["role"] == "user"]), 1)

    def test_disabled_agent_cannot_run(self):
        self.wait_context_ready()
        self.service.save_template({"action": "enable", "id": AGENT, "enabled": False})
        with self.assertRaises(AdvisorError) as caught:
            self.service.start(ACCOUNT, USER, AGENT, None, "你好", "req-disabled")
        self.assertEqual(caught.exception.code, "agent-disabled")

    def test_scope_validation_rejects_other_accounts_and_users(self):
        with self.assertRaises(AccountChangedError):
            self.service.start("someone-else", USER, AGENT, None, "你好", "req-scope")
        with self.assertRaises(AdvisorError) as caught:
            self.service.events(ACCOUNT, "other-user", "run:missing", 0)
        self.assertEqual(caught.exception.code, "run-unknown")
        with self.assertRaises(AdvisorError) as caught:
            self.service.stop(ACCOUNT, USER, "run:missing")
        self.assertEqual(caught.exception.code, "run-unknown")

    def test_message_size_limit_uses_the_contract_boundary(self):
        self.wait_context_ready()
        previous = self.service.stores.account(ACCOUNT).latest_thread(USER, AGENT)
        with self.assertRaises(AdvisorError):
            self.service.start(ACCOUNT, USER, AGENT, None, "x" * 16001, "req-big")
        self.assertEqual(self.service.stores.account(ACCOUNT).latest_thread(USER, AGENT), previous)
        self.assertFalse(self.runtime.respond_calls)


class ConfigurationTests(ServiceTestCase):
    def profiles_at_same_endpoint(self):
        store = ModelSourceStore(self.root / "synthetic-model-source.json", root=self.root,
                                 protect=lambda value: value.encode(), unprotect=lambda value: value.decode())
        a = store.save_profile(None, "A", "chat_completions", "http://127.0.0.1:9",
                               "synthetic-model", "synthetic-key-A", 32768)
        b = store.save_profile(None, "B", "chat_completions", "http://127.0.0.1:9",
                               "synthetic-model", "synthetic-key-B", 32768)
        store.select_profile(b)
        self.service.model_source_store = store
        return store, a, b

    def test_selected_profile_without_key_never_borrows_same_endpoint_peer_key(self):
        store, _a, b = self.profiles_at_same_endpoint()
        store.clear_key(b)
        with self.assertRaises(AdvisorError) as caught:
            self.service._resolve_config(ACCOUNT)
        self.assertEqual(caught.exception.code, "api-not-configured")
        started = self.service.start(ACCOUNT, USER, AGENT, None, "合成问题", "profile-b-no-key")
        finished = self.wait_run(started["run"]["id"])
        self.assertEqual(finished["run"]["state"], "error")
        self.assertFalse(self.runtime.respond_calls)

    def test_selected_profile_supplies_only_its_own_key_to_assistant(self):
        self.profiles_at_same_endpoint()
        started = self.service.start(ACCOUNT, USER, AGENT, None, "合成问题", "profile-b-key")
        finished = self.wait_run(started["run"]["id"])
        self.assertEqual(finished["run"]["state"], "done")
        self.assertEqual(self.runtime.respond_calls[0][0]["apiKey"], "synthetic-key-B")

    def test_missing_api_configuration_returns_a_clear_error(self):
        self.model_store.mode = "local"
        self.assertEqual(self.service.catalog()["engine"], {"state": "missing"})
        with self.assertRaises(AdvisorError) as caught:
            self.service.start(ACCOUNT, USER, AGENT, None, "你好", "req-local")
        self.assertEqual(caught.exception.code, "api-not-configured")
        self.assertIsNone(self.service.stores.account(ACCOUNT).latest_thread(USER, AGENT))
        self.model_store.mode = "api"
        self.model_store.key = None
        started = self.service.start(ACCOUNT, USER, AGENT, None, "你好", "req-nokey")
        finished = self.wait_run(started["run"]["id"])
        self.assertEqual(finished["run"]["state"], "error")
        self.assertIn("密钥不可用", finished["run"]["error"])
        self.assertFalse(self.runtime.respond_calls)

    def test_missing_runtime_engine_is_a_synchronous_error(self):
        service = self.build_service(runtime_factory=None)
        self.addCleanup(service.shutdown)
        with self.assertRaises(AdvisorError) as caught:
            service.start(ACCOUNT, USER, AGENT, None, "你好", "req-engine")
        self.assertEqual(caught.exception.code, "engine-unavailable")

    def test_restart_restores_the_thread_projection(self):
        self.wait_context_ready()
        result = self.service.start(ACCOUNT, USER, AGENT, None, "持久化问题", "req-persist")
        self.wait_run(result["run"]["id"])
        self.service.shutdown()
        restarted_runtime = FakeRuntime(text="重启后的回复。")
        restarted = self.build_service(runtime=restarted_runtime)
        self.addCleanup(restarted.shutdown)
        payload = restarted.thread(ACCOUNT, USER, AGENT)
        self.assertEqual(payload["run"]["state"], "done")
        messages = payload["thread"]["messages"]
        self.assertEqual([message["role"] for message in messages], ["user", "assistant"])
        self.assertEqual(messages[0]["text"], "持久化问题")
        second = restarted.start(ACCOUNT, USER, AGENT, payload["thread"]["id"], "重启后继续",
                                 "req-restart")
        self.wait_run(second["run"]["id"], service=restarted)
        self.assertEqual(restarted_runtime.respond_calls[0][1]["runtimeSessionId"], "sess-1")


class AccountLifecycleTests(ServiceTestCase):
    def test_pause_and_resume_keep_the_projection(self):
        self.wait_context_ready()
        self.service.pause_for_account_clear(ACCOUNT)
        with self.assertRaises(AdvisorError) as caught:
            self.service.thread(ACCOUNT, USER, AGENT)
        self.assertEqual(caught.exception.code, "account-paused")
        self.service.resume_after_failed_account_clear()
        payload = self.service.thread(ACCOUNT, USER, AGENT)
        self.assertNotIn("readCount", payload["context"])
        self.assertEqual(self.context()["readCount"], 300)

    def test_clear_account_drains_the_run_then_removes_owned_data(self):
        self.wait_context_ready()
        self.runtime.pause_after_first_chunk = True
        started = self.service.start(ACCOUNT, USER, AGENT, None, "清理中", "req-clear")
        run = self.service._runs[started["run"]["id"]]
        self.assertTrue(wait_until(self.runtime.paused.is_set))
        result = self.service.clear_account(ACCOUNT)
        self.assertTrue(result["deleted"])
        self.assertFalse(run.worker.is_alive())
        self.assertEqual(run.state, "stopped")
        digest = __import__("hashlib").sha256(ACCOUNT.encode()).hexdigest()
        self.assertFalse((self.root / ".local" / "advisor-data" / digest).exists())
        self.assertEqual(self.runtime.account_shutdowns, [ACCOUNT])
        # A cleared service cannot recreate data through polling or late callbacks.
        self.service.resume_after_failed_account_clear()
        with self.assertRaises(AdvisorError):
            self.service.prepare_context(ACCOUNT, USER)
        with self.assertRaises(AdvisorError):
            self.service.events(ACCOUNT, USER, started["run"]["id"], 0)
        self.assertFalse((self.root / ".local" / "advisor-data" / digest).exists())

    def test_resume_after_shutdown_is_rejected(self):
        self.service.shutdown()
        with self.assertRaises(RuntimeError):
            self.service.resume_after_failed_account_clear()


class SendPerformanceTests(ServiceTestCase):
    def test_deleting_active_builtin_stops_only_its_run_and_terminal_projection_remains_readable(self):
        self.wait_context_ready()
        self.runtime.pause_after_first_chunk = True
        started = self.service.start(ACCOUNT, USER, AGENT, None, "待删除的助手", "req-delete-active")
        self.assertTrue(self.runtime.paused.wait(2))
        run = self.service._runs[started["run"]["id"]]
        catalog = self.service.save_template({"action": "delete", "id": AGENT})
        self.assertNotIn(AGENT, [item["id"] for item in catalog["agents"]])
        self.assertEqual(run.state, "stopped")
        payload = self.service.events(ACCOUNT, USER, run.id, 0)
        self.assertEqual(payload["run"]["state"], "stopped")
        self.assertEqual(payload["thread"]["welcome"], "")
        run.worker.join(2)
        self.assertFalse(run.worker.is_alive())
        self.assertEqual(self.service.stores.account(ACCOUNT).run(run.id)["state"], "stopped")
        self.assertEqual(len(self.service.stores.config.agents()), 3)

    def running_fixture(self):
        self.wait_context_ready()
        self.runtime.pause_after_first_chunk = True
        result = self.service.start(ACCOUNT, USER, AGENT, None, "合成性能问题", "req-poll-performance")
        self.assertTrue(wait_until(self.runtime.paused.is_set))
        run = self.service._runs[result["run"]["id"]]
        return run

    def test_active_event_polls_reuse_the_recent_fresh_scope_check(self):
        run = self.running_fixture()
        calls = []

        def slow_verified(*, messages=False):
            calls.append(messages)
            time.sleep(0.06)
            return self.source.identity()

        self.source.verified_identity = slow_verified
        for _ in range(10):
            self.assertEqual(self.service.events(ACCOUNT, USER, run.id)["run"]["id"], run.id)
        self.assertEqual(calls, [])
        run.last_scope_check = 0
        self.service.events(ACCOUNT, USER, run.id)
        self.assertEqual(calls, [True])
        for _ in range(10):
            self.service.events(ACCOUNT, USER, run.id)
        self.assertEqual(calls, [True])

    def test_due_poll_detects_account_switch_and_refuses_cross_scope_requests(self):
        run = self.running_fixture()
        with self.assertRaises(AdvisorError):
            self.service.events("other-account", USER, run.id)
        with self.assertRaises(AdvisorError):
            self.service.events(ACCOUNT, "other-user", run.id)
        self.source.account = "other-account"
        run.last_scope_check = 0
        with self.assertRaises((AdvisorError, AccountChangedError)):
            self.service.events(ACCOUNT, USER, run.id)
        self.assertEqual(run.state, "stopped")
        self.assertTrue(run.cancel.is_set())
        self.assertEqual([row["role"] for row in run.database.thread_messages(run.thread_id)], ["user"])

    def test_slow_due_poll_does_not_hold_the_service_condition(self):
        run = self.running_fixture()
        entered, release = threading.Event(), threading.Event()
        errors = []

        def blocked_verified(*, messages=False):
            entered.set()
            release.wait(3)
            return self.source.identity()

        self.source.verified_identity = blocked_verified
        run.last_scope_check = 0

        def poll():
            try:
                self.service.events(ACCOUNT, USER, run.id)
            except Exception as error:
                errors.append(error)

        worker = threading.Thread(target=poll)
        worker.start()
        try:
            self.assertTrue(entered.wait(2))
            acquired = self.service.condition.acquire(timeout=0.1)
            self.assertTrue(acquired, "fresh account discovery held the service condition")
            if acquired:
                self.service.condition.release()
        finally:
            release.set()
            worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])

    def test_terminal_event_recovery_keeps_a_fresh_identity_check(self):
        self.wait_context_ready()
        result = self.service.start(ACCOUNT, USER, AGENT, None, "结束后读取", "req-terminal-scope")
        self.wait_run(result["run"]["id"])
        before = self.source.identity_calls
        self.service.events(ACCOUNT, USER, result["run"]["id"])
        self.assertGreater(self.source.identity_calls, before)
        self.source.account = "other-account"
        with self.assertRaises(AccountChangedError):
            self.service.events(ACCOUNT, USER, result["run"]["id"])

    def test_run_finishing_during_a_due_check_returns_the_terminal_projection(self):
        run = self.running_fixture()
        run.last_scope_check = 0
        original = self.service._check_run

        def complete_during_check(target, thorough=True):
            if target is run and thorough:
                with self.service.condition:
                    target.state = "done"
                raise AdvisorError("stopping", "已停止")
            return original(target, thorough)

        self.service._check_run = complete_during_check
        result = self.service.events(ACCOUNT, USER, run.id)
        self.assertEqual(result["run"]["state"], "done")
        self.assertIn("thread", result)
        run.cancel.set()

    def block_highwater(self):
        entered, release = threading.Event(), threading.Event()
        original = self.source.history_highwater
        self.source.lock = threading.RLock()

        def highwater(user):
            with self.source.lock:
                entered.set()
                release.wait(4)
                return original(user)

        self.source.history_highwater = highwater
        self.addCleanup(release.set)
        return entered, release

    def test_send_ack_and_cancel_do_not_wait_for_locked_history_discovery(self):
        entered, release = self.block_highwater()
        started_at = time.monotonic()
        started = self.service.start(ACCOUNT, USER, AGENT, None, "立即显示的问题", "req-fast")
        self.assertLess(time.monotonic() - started_at, 0.5)
        self.assertTrue(entered.wait(2))
        self.assertEqual(started["run"]["phase"], "preparing")
        self.assertEqual(started["run"]["requestId"], "req-fast")
        saved = self.service.stores.account(ACCOUNT).thread_messages(started["threadId"])
        self.assertEqual(saved[0]["id"], started["run"]["messageId"])
        stopped_at = time.monotonic()
        stopped = self.service.stop(ACCOUNT, USER, started["run"]["id"])
        self.assertLess(time.monotonic() - stopped_at, 0.5)
        self.assertEqual(stopped["run"]["state"], "stopped")
        release.set()
        self.service._runs[started["run"]["id"]].worker.join(2)
        self.assertFalse(self.runtime.respond_calls)

    def test_source_change_during_preparation_never_reaches_model(self):
        entered, release = self.block_highwater()
        started = self.service.start(ACCOUNT, USER, AGENT, None, "旧账号的问题", "req-source-switch")
        self.assertTrue(entered.wait(2))
        self.source.account = "different-account"
        release.set()
        run = self.service._runs[started["run"]["id"]]
        run.worker.join(2)
        self.assertFalse(run.worker.is_alive())
        self.assertEqual(run.state, "stopped")
        self.assertFalse(self.runtime.respond_calls)
        self.assertFalse(self.runtime.compact_calls)

    def test_idempotent_ack_returns_same_saved_message_identity(self):
        started = self.service.start(ACCOUNT, USER, AGENT, None, "幂等问题", "req-same")
        self.wait_run(started["run"]["id"])
        repeated = self.service.start(ACCOUNT, USER, AGENT, started["threadId"], "幂等问题", "req-same")
        self.assertEqual(repeated["run"]["id"], started["run"]["id"])
        self.assertEqual(repeated["run"]["messageId"], started["run"]["messageId"])
        self.assertEqual(repeated["run"]["requestId"], "req-same")
        self.assertEqual(len([item for item in self.messages() if item["role"] == "user"]), 1)

    def test_token_burst_does_not_verify_wechat_source_for_every_delta(self):
        self.wait_context_ready()
        self.runtime.pause_after_first_chunk = True
        started = self.service.start(ACCOUNT, USER, AGENT, None, "流式问题", "req-burst")
        self.assertTrue(self.runtime.paused.wait(2))
        run = self.service._runs[started["run"]["id"]]
        before = self.source.identity_calls
        for _ in range(200):
            self.service._on_event(run, {"type": "text", "text": "x"})
        self.assertLessEqual(self.source.identity_calls - before, 4)
        self.assertEqual(run.phase, "answering")
        self.service.stop(ACCOUNT, USER, run.id)


if __name__ == "__main__":
    unittest.main()
