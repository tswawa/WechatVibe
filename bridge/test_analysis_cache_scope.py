"""A scope change must not put every data request behind a model restart.

`_scoped_identity` takes `analysis_cache_scope_lock`, and every data endpoint (messages, history,
profile, insights) calls it first. Clearing the model text caches starts the analysis process and
can wait up to two minutes for it, so doing that while holding the lock left the whole UI looking
hung after an account or data-root switch.
"""
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from conversation_selection import ConversationSelectionStore
from real_backend import Backend
from test_analysis_workers import StubSource


class BlockingAnalyzer:
    model = {"state": "ready"}

    def __init__(self):
        self.cleared = 0
        self.entered = threading.Event()
        self.release = threading.Event()

    def clear_caches(self):
        self.cleared += 1
        self.entered.set()
        self.release.wait(10)


class SwitchingSource(StubSource):
    def __init__(self, workdir):
        super().__init__(workdir)
        self.scope = Path(workdir)

    def verified_identity(self, *, messages=False):
        return self.account, self.scope


class CacheScopeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = SwitchingSource(self.root / "snapshot-a")
        self.analyzer = BlockingAnalyzer()
        with mock.patch("backend_service.save_worker_settings"):
            self.backend = Backend(self.source, self.analyzer,
                                   selection_store=ConversationSelectionStore(self.root / "results"))
        self.addCleanup(self.backend.shutdown)
        self.addCleanup(self.analyzer.release.set)
        # Prime the scope: the first identity has nothing to clear.
        self.backend._scoped_identity()
        self.assertEqual(self.analyzer.cleared, 0)

    def test_a_scope_change_does_not_block_other_requests(self):
        self.source.scope = self.root / "snapshot-b"
        finished = threading.Event()

        def call():
            self.backend._scoped_identity()
            finished.set()

        changed = threading.Thread(target=call, daemon=True)
        changed.start()
        self.assertTrue(self.analyzer.entered.wait(5), "the clear never started")

        other = threading.Thread(target=call, daemon=True)
        other.start()
        self.assertTrue(finished.wait(3), "a data request waited behind the cache clear")
        self.assertEqual(self.analyzer.cleared, 1)
        self.assertEqual(self.backend.analysis_cache_scope[1], str((self.root / "snapshot-b").resolve()))
        self.analyzer.release.set()
        changed.join(5)

    def test_the_previous_scope_still_gets_cleared_once(self):
        self.source.scope = self.root / "snapshot-b"
        self.analyzer.release.set()
        self.backend._scoped_identity()
        self.assertEqual(self.analyzer.cleared, 1)
        self.backend._scoped_identity()
        self.assertEqual(self.analyzer.cleared, 1, "an unchanged scope must not clear again")


if __name__ == "__main__":
    unittest.main()
