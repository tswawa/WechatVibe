"""Manual discovery settings: synthetic directories, no real account or model IO."""
import json
import os
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from data_root_source import CUSTOM_ROOT_ENV, DataRootError, DataRootSource


class DataRootSourceTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.store = DataRootSource(self.root)
        env = patch.dict(os.environ, {name: str(self.root / name.lower())
                                     for name in ("USERPROFILE", "APPDATA", "LOCALAPPDATA")})
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop(CUSTOM_ROOT_ENV, None)
        self.data = self.root / "outside-defaults" / "xwechat_files"
        self.account = self.data / "synthetic-a"
        (self.account / "db_storage").mkdir(parents=True)

    def test_default_auto_does_not_create_config(self):
        self.store.apply()
        self.assertEqual(self.store.status()["state"], "unset")
        self.assertFalse(self.store.config.exists())

    def test_parent_root_account_and_storage_are_valid_metadata_hints(self):
        for path in (self.data.parent, self.data, self.account, self.account / "db_storage"):
            with self.subTest(path=path.name):
                state = self.store.select(str(path))
                self.assertEqual((state["state"], state["accounts"]), ("ready", 1))
                expected = self.account if path.name == "db_storage" else path
                self.assertEqual(state["path"], str(expected.resolve()))
                self.assertEqual(os.environ[CUSTOM_ROOT_ENV], state["path"])

    def test_invalid_input_cannot_replace_saved_hint(self):
        self.store.select(str(self.data))
        before = self.store.config.read_bytes()
        file = self.root / "ordinary-file"
        file.write_bytes(b"synthetic")
        empty = self.root / "empty"
        empty.mkdir()
        for value in (None, 4, "", "relative/path", "x\x00", str(file), str(empty), str(self.root / "missing")):
            with self.subTest(value=repr(value)):
                with self.assertRaises(DataRootError):
                    self.store.select(value)
                self.assertEqual(self.store.config.read_bytes(), before)
                self.assertEqual(os.environ[CUSTOM_ROOT_ENV], str(self.data.resolve()))

    def test_reload_and_explicit_auto_restore(self):
        self.store.select(str(self.data))
        os.environ.pop(CUSTOM_ROOT_ENV)
        reloaded = DataRootSource(self.root)
        reloaded.apply()
        self.assertEqual(os.environ[CUSTOM_ROOT_ENV], str(self.data.resolve()))
        reloaded.clear()
        self.assertNotIn(CUSTOM_ROOT_ENV, os.environ)
        os.environ[CUSTOM_ROOT_ENV] = str(self.data)
        DataRootSource(self.root).apply()
        self.assertNotIn(CUSTOM_ROOT_ENV, os.environ)

    def test_absent_config_preserves_explicit_environment_hint(self):
        os.environ[CUSTOM_ROOT_ENV] = str(self.data)
        self.store.apply()
        self.assertEqual(self.store.status()["accounts"], 1)
        self.assertEqual(os.environ[CUSTOM_ROOT_ENV], str(self.data))

    def test_corrupt_config_is_visible_and_recoverable_without_startup_failure(self):
        self.store.config.parent.mkdir(parents=True)
        self.store.config.write_text("not json", encoding="utf-8")
        self.store.apply()
        self.assertEqual(self.store.status()["state"], "invalid")
        self.assertEqual(self.store.clear()["state"], "unset")

    def test_missing_saved_directory_is_not_an_account(self):
        self.store.select(str(self.data))
        moved = self.data.with_name("moved")
        self.data.rename(moved)
        self.assertEqual(self.store.status()["state"], "missing")
        self.assertEqual(self.store.status()["accounts"], 0)

    def test_write_failure_keeps_previous_config_and_environment(self):
        self.store.select(str(self.data))
        before = self.store.config.read_bytes()
        with patch("data_root_source.os.replace", side_effect=OSError("synthetic disk failure")):
            with self.assertRaises(OSError):
                self.store.clear()
        self.assertEqual(self.store.config.read_bytes(), before)
        self.assertEqual(os.environ[CUSTOM_ROOT_ENV], str(self.data.resolve()))
        self.assertEqual(list(self.store.config.parent.glob("*.tmp")), [])

    def test_save_and_clear_cannot_split_disk_and_environment_state(self):
        wrote = threading.Event()
        release = threading.Event()
        attempted_clear = threading.Event()
        original = self.store._write

        def paused_write(value):
            original(value)
            if value is not None:
                wrote.set()
                if not release.wait(3):
                    raise RuntimeError("synthetic release timeout")

        def clear():
            attempted_clear.set()
            return self.store.clear()

        with patch.object(self.store, "_write", side_effect=paused_write):
            with ThreadPoolExecutor(max_workers=2) as pool:
                saved = pool.submit(self.store.select, str(self.data))
                self.assertTrue(wrote.wait(3))
                cleared = pool.submit(clear)
                self.assertTrue(attempted_clear.wait(3))
                try:
                    with self.assertRaises(TimeoutError):
                        cleared.result(timeout=.05)
                finally:
                    release.set()
                self.assertEqual(saved.result(timeout=3)["state"], "ready")
                self.assertEqual(cleared.result(timeout=3)["state"], "unset")
        self.assertIsNone(json.loads(self.store.config.read_text(encoding="utf-8"))["path"])
        self.assertNotIn(CUSTOM_ROOT_ENV, os.environ)

    def test_selection_does_not_read_or_change_database_contents(self):
        database = self.account / "db_storage" / "session.db"
        database.write_bytes(b"synthetic account database sentinel")
        self.store.select(str(self.data))
        self.store.clear()
        self.assertEqual(database.read_bytes(), b"synthetic account database sentinel")

    def test_live_owner_selection_still_rejects_other_and_ambiguous_accounts(self):
        import live_source
        from wr import discovery
        other = self.data / "synthetic-b"
        (other / "db_storage").mkdir(parents=True)
        for account in (self.account, other):
            (account / "db_storage" / "session.db").write_bytes(b"synthetic")
        self.store.select(str(self.data))
        accounts = discovery.discover_account_dirs(roots=[str(self.data)])
        owners = set()
        fake_psutil = SimpleNamespace(
            Process=lambda _pid: SimpleNamespace(name=lambda: "Weixin.exe", create_time=lambda: 10.0),
            NoSuchProcess=RuntimeError, AccessDenied=PermissionError)

        def file_owners(paths):
            return [(42, 10.0)] if any(Path(path).parent.parent.name in owners for path in paths) else []

        # The ownership policy itself is tested separately; this test is about the mapping
        # from raw ownership to a selection, so it must see every call. Since 1.3.0 the
        # ownership query is fresh by default, so no cache window has to be disabled here.
        with patch.object(live_source, "file_owners", side_effect=file_owners), \
                patch.object(discovery, "psutil", fake_psutil):
            processes = [discovery.WeixinProcess(pid=42)]
            self.assertIsNone(live_source._account_from_file_owners(accounts, processes))
            owners.add("synthetic-a")
            self.assertEqual(live_source._account_from_file_owners(accounts, processes).account_dir,
                             self.account.resolve())
            owners.clear()
            owners.add("synthetic-b")
            self.assertEqual(live_source._account_from_file_owners(accounts, processes).account_dir,
                             other.resolve())
            owners.add("synthetic-a")
            self.assertIsNone(live_source._account_from_file_owners(accounts, processes))

    def test_live_account_selections_enumerates_the_ambiguous_set(self):
        """The picker needs every live account, which the fail-closed selector drops.

        Both functions must read the same attribution, so the assertion pairs the newly
        enumerated set against the unchanged None from `_account_from_file_owners`.
        """
        import live_source
        from wr import discovery
        other = self.data / "synthetic-b"
        (other / "db_storage").mkdir(parents=True)
        for account in (self.account, other):
            (account / "db_storage" / "session.db").write_bytes(b"synthetic")
        self.store.select(str(self.data))
        accounts = discovery.discover_account_dirs(roots=[str(self.data)])
        processes = [discovery.WeixinProcess(pid=42)]
        owners = set()
        fake_psutil = SimpleNamespace(
            Process=lambda _pid: SimpleNamespace(name=lambda: "Weixin.exe", create_time=lambda: 10.0),
            NoSuchProcess=RuntimeError, AccessDenied=PermissionError)

        def file_owners(paths):
            return [(42, 10.0)] if any(Path(path).parent.parent.name in owners for path in paths) else []

        with patch.object(live_source, "file_owners", side_effect=file_owners), \
                patch.object(live_source, "OWNERSHIP_TTL_SECONDS", 0), \
                patch.object(discovery, "psutil", fake_psutil), \
                patch.object(discovery, "discover_account_dirs", return_value=accounts), \
                patch.object(discovery, "find_weixin_processes", return_value=processes):
            self.assertEqual(live_source.live_account_selections(), [])
            owners.add("synthetic-a")
            self.assertEqual([item.account_dir for item in live_source.live_account_selections()],
                             [self.account.resolve()])
            owners.add("synthetic-b")
            self.assertEqual([item.account_dir for item in live_source.live_account_selections()],
                             [self.account.resolve(), other.resolve()])
            self.assertIsNone(live_source._account_from_file_owners(accounts, processes))


if __name__ == "__main__":
    unittest.main()
