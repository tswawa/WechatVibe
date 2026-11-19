"""Cancelling one conversation must stop the job that is already queued or decoding.

The sidebar toggle persists a shorter `requestedSessions` list. That alone only suppresses
future passes, so these checks are about the second half: the running job has to be marked
and dropped, and the worker has to notice at its next scope check.
"""

import http.client
import json
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

from real_backend import Backend, ResultStore
from real_http import make_handler
from test_real_backend import SyntheticAnalyzer, SyntheticSource


class IdentitySource:
    def __init__(self, workdir):
        self.workdir = workdir
        self.account = "wxid_cancel_account"

    def verified_identity(self, *, messages=False):
        return self.account, self.workdir


class StubAnalyzer:
    model = {"state": "ready"}

    def analysis_version(self):
        return "analysis-cancel-test"


class StubStore:
    def __init__(self, path):
        self.path = path

    def cache_suspended(self, *_args, **_kwargs):
        return False


def job_of(status="running", mode="incremental"):
    return {"id": "job-" + status, "status": status, "total": 0, "processed": 0,
            "requested": {"mode": mode, "limit": None},
            "recent": {"status": status}}


class AnalysisCancelTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.source = IdentitySource(root / "snapshot")
        self.store = StubStore(root / "results")
        self.backend = Backend(self.source, StubAnalyzer(),
                               store_factory=lambda _account, _workdir: self.store)
        self.addCleanup(self.backend.shutdown)
        self.account = self.source.account
        self.workdir = str((root / "snapshot").resolve())

    def key_for(self, user, version="analysis-cancel-test"):
        return (self.account, str(self.store.path), user, version)

    def test_running_job_is_marked_dropped_and_blocks_the_next_scope_check(self):
        key = self.key_for("contact-a")
        job = job_of()
        self.backend.jobs[key] = job
        self.backend.recent_windows[key] = {"job": job, "iterator": None,
                                            "limit": 80, "counts": {"total": 0, "processed": 0},
                                            "rerun": False, "background_pending": False}
        self.backend.priority_recent[key] = 80
        self.backend.incremental_recheck.add(key)
        self.backend.history_iterators[key] = iter(())
        self.backend.history_iterator_modes[key] = ("incremental", None)

        result = self.backend.cancel_conversation_analysis(self.account, "contact-a")

        self.assertEqual(result, {"account": self.account, "user": "contact-a", "cancelled": 1})
        self.assertIs(job["_cancelledByRequest"], True)
        self.assertEqual(job["status"], "cancelled")
        self.assertNotIn("error", job)
        # Every queue that could start it again has to be empty for this conversation.
        self.assertEqual([item for item in self.backend.jobs if item[2] == "contact-a"], [])
        self.assertEqual([item for item in self.backend.recent_windows if item[2] == "contact-a"], [])
        self.assertEqual([item for item in self.backend.priority_recent if item[2] == "contact-a"], [])
        self.assertEqual([item for item in self.backend.incremental_recheck if item[2] == "contact-a"], [])
        self.assertEqual([item for item in self.backend.history_iterators if item[2] == "contact-a"], [])
        # This is the check every worker turn and every batch_engine step runs.
        with self.assertRaisesRegex(RuntimeError, "analysis-cancelled"):
            with self.backend._source_scope((self.account, self.workdir), job):
                pass

    def test_queued_task_returns_without_touching_the_model(self):
        key = self.key_for("contact-a")
        job = job_of(status="queued")
        self.backend.jobs[key] = job
        scope = (self.account, self.workdir)
        self.backend._enqueue((key, "incremental", None, self.store, job, scope))
        self.backend.cancel_conversation_analysis(self.account, "contact-a")
        deadline = time.monotonic() + 5
        while self.backend.tasks.unfinished_tasks and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(self.backend.tasks.unfinished_tasks, 0, "the queued turn never finished")
        self.assertEqual(job["status"], "cancelled")
        self.assertNotIn(key, self.backend.jobs)

    def test_queued_job_of_another_model_version_is_cancelled_too(self):
        current, stale = self.key_for("contact-a"), self.key_for("contact-a", "older-version")
        running, queued = job_of(), job_of(status="queued")
        self.backend.jobs[current] = running
        self.backend.jobs[stale] = queued

        result = self.backend.cancel_conversation_analysis(self.account, "contact-a")

        self.assertEqual(result["cancelled"], 2)
        self.assertIs(stale not in self.backend.jobs, True)
        self.assertEqual(queued["status"], "cancelled")

    def test_other_conversations_and_an_idle_conversation_are_untouched(self):
        other_key = self.key_for("contact-b")
        other = job_of()
        self.backend.jobs[other_key] = other

        idle = self.backend.cancel_conversation_analysis(self.account, "contact-c")

        self.assertEqual(idle["cancelled"], 0)
        self.assertEqual(other["status"], "running")
        self.assertNotIn("_cancelledByRequest", other)
        self.assertIn(other_key, self.backend.jobs)

    def test_background_cancel_spares_hand_started_passes(self):
        background_key, hand_key = self.key_for("contact-a"), self.key_for("contact-b")
        background, hand = job_of(), job_of()
        background["_background"] = True
        self.backend.jobs[background_key] = background
        self.backend.jobs[hand_key] = hand

        result = self.backend.cancel_background_analysis(self.account)

        self.assertEqual(result["conversations"], 1)
        self.assertEqual(result["cancelled"], 1)
        self.assertEqual(background["status"], "cancelled")
        # A pass the user started by clicking an avatar is not background work.
        self.assertEqual(hand["status"], "running")
        self.assertIn(hand_key, self.backend.jobs)

    def test_api_job_is_cancelled_without_reading_as_a_source_change(self):
        api_key = (self.account, "contact-a", "source-1")
        job = job_of()
        self.backend.api_jobs[api_key] = job
        self.backend.api_insight_writers[(self.account, "contact-a", "source-1", "m1")] = job["id"]

        result = self.backend.cancel_conversation_analysis(self.account, "contact-a")

        self.assertEqual(result["cancelled"], 1)
        self.assertIs(job["_cancelledByRequest"], True)
        self.assertEqual(job["status"], "cancelled")
        self.assertNotIn(api_key, self.backend.api_jobs)
        self.assertEqual(self.backend.api_insight_writers, {})
        with self.assertRaisesRegex(RuntimeError, "analysis-cancelled"):
            self.backend._assert_api_job(self.backend.api_jobs, api_key, job,
                                         (self.account, self.workdir), self.store)

    def test_scope_check_rejects_a_cancelled_job_even_when_it_was_never_dropped(self):
        job = job_of()
        job["_cancelledByRequest"] = True
        with self.assertRaisesRegex(RuntimeError, "analysis-cancelled"):
            with self.backend._source_scope((self.account, self.workdir), job):
                pass


class LiveCancelTests(unittest.TestCase):
    """A real worker pass, stopped halfway: this is the behaviour the bug report describes."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = SyntheticSource(self.root)
        self.analyzer = SyntheticAnalyzer()
        self.backend = Backend(self.source, self.analyzer,
                               lambda account, _workdir: ResultStore(
                                   self.root / (account + ".sqlite3")))
        self.addCleanup(self.backend.shutdown)

    def test_cancel_stops_a_running_recent_pass_before_the_window_ends(self):
        self.source.add("friend", 60)
        entered, release = threading.Event(), threading.Event()
        self.analyzer.entered, self.analyzer.release = entered, release
        self.backend.start("friend", "recent", 60)
        # Hold the first forward pass so the cancel lands while the worker is inside a turn.
        self.assertTrue(entered.wait(timeout=10), "the worker never reached the model")
        self.analyzer.entered = self.analyzer.release = None
        release.set()
        deadline = time.monotonic() + 10
        while len(self.analyzer.calls) < 8 and time.monotonic() < deadline:
            time.sleep(0.01)

        result = self.backend.cancel_conversation_analysis(self.source.account, "friend")
        self.assertEqual(result["cancelled"], 1)
        self.backend.tasks.join()

        self.assertLess(len(self.analyzer.calls), 60, "the pass kept decoding the whole window")
        self.assertNotIn(("friend", "running"),
                         [(key[2], job["status"]) for key, job in self.backend.jobs.items()])


class AnalysisCancelHTTPTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.source = IdentitySource(root / "snapshot")
        self.store = StubStore(root / "results")
        self.backend = Backend(self.source, StubAnalyzer(),
                               store_factory=lambda _account, _workdir: self.store)
        self.addCleanup(self.backend.shutdown)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.backend))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.thread.join, 2)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def post(self, body):
        payload = json.dumps(body).encode("utf-8")
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.request("POST", "/api/analysis-cancel", body=payload,
                               headers={"Content-Type": "application/json"})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_endpoint_stops_the_running_job(self):
        key = (self.source.account, str(self.store.path), "contact-a", "analysis-cancel-test")
        job = job_of()
        self.backend.jobs[key] = job

        status, body = self.post({"account": self.source.account, "user": "contact-a"})

        self.assertEqual(status, 200)
        self.assertEqual(body, {"account": self.source.account, "user": "contact-a", "cancelled": 1})
        self.assertEqual(job["status"], "cancelled")
        self.assertNotIn(key, self.backend.jobs)

    def test_background_only_cancel_stops_queued_sweep_jobs(self):
        key = (self.source.account, str(self.store.path), "contact-a", "analysis-cancel-test")
        job = job_of(status="queued")
        job["_background"] = True
        self.backend.jobs[key] = job

        status, body = self.post({"account": self.source.account, "allBackground": True})

        self.assertEqual(status, 200)
        self.assertEqual(body, {"account": self.source.account, "cancelled": 1, "conversations": 1})
        self.assertEqual(job["status"], "cancelled")
        self.assertNotIn(key, self.backend.jobs)

    def test_endpoint_rejects_a_malformed_or_foreign_request(self):
        self.assertEqual(self.post({"account": self.source.account})[0], 400)
        status, body = self.post({"account": "wxid_someone_else", "user": "contact-a"})
        self.assertEqual(status, 503)
        self.assertEqual(body["error"], "AccountChangedError")


if __name__ == "__main__":
    unittest.main()
