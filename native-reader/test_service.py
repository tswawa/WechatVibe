"""Synthetic dataset-identity checks: a snapshot must cover the bytes it actually serves.

`_capture_dataset` freezes the main shard *and* its WAL, but the dataset id was derived from the
main shard alone. A committed WAL changes the rows the frozen data contains while the main file
stays byte-identical, so the same id was reused for stale content - `read_history` then missed
rows that the account totals had already counted. `_source_fingerprint`, which decides whether the
live store is rebuilt, has always covered the WAL.
"""

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from wr import service


class RecordingStore:
    """Stands in for SnapshotStore: remembers which datasets were created."""

    def __init__(self):
        self.datasets: dict[str, tuple] = {}
        self.created = 0
        self.pruned: list[int] = []

    def has_dataset(self, dataset_id):
        return dataset_id in self.datasets

    def create_dataset(self, dataset_id, meta, blobs):
        self.created += 1
        self.datasets[dataset_id] = (meta, blobs)

    def prune_datasets(self, keep):
        self.pruned.append(keep)


class DatasetIdentityTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="dataset identity ")
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        self.db = root / "message_0.db"
        self.wal = root / "message_0.db-wal"
        self.db.write_bytes(b"D" * 4096)
        self.wal.write_bytes(b"W" * 32)

        self.service = service.NativeService.__new__(service.NativeService)
        self.service.mode = "live"
        self.service.account_id = "synthetic-account"
        self.service.store = RecordingStore()
        self.service.accounts = {"synthetic-account": SimpleNamespace(shards=[
            SimpleNamespace(id="message__message_0.db", path=str(self.db), wal_path=str(self.wal))])}

    def capture(self):
        return self.service._capture_dataset(0)

    def test_a_wal_only_change_moves_the_dataset_identity(self):
        first = self.capture()
        self.wal.write_bytes(b"W" * 32 + b"committed")
        second = self.capture()
        self.assertNotEqual(first, second)
        self.assertEqual(self.service.store.created, 2)

    def test_a_main_shard_change_still_moves_the_identity(self):
        first = self.capture()
        self.db.write_bytes(b"D" * 4096 + b"page")
        self.assertNotEqual(first, self.capture())

    def test_an_unchanged_source_reuses_one_dataset(self):
        first = self.capture()
        self.assertEqual(first, self.capture())
        self.assertEqual(self.service.store.created, 1)

    def test_the_frozen_dataset_carries_the_wal_blob(self):
        dataset_id = self.capture()
        meta, blobs = self.service.store.datasets[dataset_id]
        self.assertEqual(meta["shards"], [{"shardId": "message__message_0.db", "hasWal": True}])
        self.assertEqual([name for name, _blob in blobs],
                         ["message__message_0.db#db", "message__message_0.db#wal"])

    def test_a_shard_without_a_wal_keeps_working(self):
        self.service.accounts["synthetic-account"] = SimpleNamespace(shards=[
            SimpleNamespace(id="message__message_0.db", path=str(self.db), wal_path=None)])
        dataset_id = self.capture()
        meta, blobs = self.service.store.datasets[dataset_id]
        self.assertEqual(meta["shards"], [{"shardId": "message__message_0.db", "hasWal": False}])
        self.assertEqual([name for name, _blob in blobs], ["message__message_0.db#db"])


if __name__ == "__main__":
    unittest.main()
