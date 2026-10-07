"""Account pin: file handling, the fail-closed state machine, and the locator contract."""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import account_pin_source
import instance_identity
import live_source
from account_pin_source import AccountPinError, AccountPinSource, PIN_FILENAME, UNRESOLVED
from live_source import ActiveSelection


class AccountPinSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.data = self.root / "xwechat_files"
        self.account = self.data / "synthetic-a"
        self.other = self.data / "synthetic-b"
        for account in (self.account, self.other):
            (account / "db_storage").mkdir(parents=True)
            (account / "db_storage" / "session.db").write_bytes(b"synthetic")
        self.pin = AccountPinSource(self.root)
        self.selection = ActiveSelection(self.account.resolve(), ((42, 10.0),))
        self.other_selection = ActiveSelection(self.other.resolve(), ((43, 10.0),))
        # An inherited hint must not leak in from the machine running the suite.
        self.env = patch.dict("os.environ", {}, clear=False)
        self.env.start()
        os.environ.pop(account_pin_source.PIN_ENV, None)
        self.addCleanup(self.env.stop)

    def discover(self, *_args, **_kwargs):
        return [SimpleNamespace(id=f"id-{account.name}", path=str(account / "db_storage"),
                                state="available")
                for account in (self.account, self.other)]

    def live(self, *selections):
        return patch.object(live_source, "live_account_selections", return_value=list(selections))

    def select_account(self, account=None):
        with patch("wr.discovery.discover_account_dirs", side_effect=self.discover), \
                self.live(self.selection, self.other_selection):
            return self.pin.select(str(account or self.account))

    # --- state machine -------------------------------------------------------------

    def test_unpinned_states_follow_the_live_count(self):
        with self.live():
            self.assertEqual(self.pin.status()["state"], "unpinned-none")
        with self.live(self.selection):
            self.assertEqual(self.pin.status()["state"], "unpinned-unique")
        with self.live(self.selection, self.other_selection):
            # This is the reported bug: two accounts, no pin, nothing is selected.
            status = self.pin.status()
            self.assertEqual(status["state"], "unpinned-ambiguous")
            self.assertEqual([item["account"] for item in status["live"]],
                             ["synthetic-a", "synthetic-b"])
            self.assertIsNone(status["pinned"])

    def test_select_then_status_reports_pinned_ready(self):
        status = self.select_account()
        self.assertEqual(status["state"], "pinned-ready")
        self.assertEqual(status["pinned"]["account"], "synthetic-a")
        with self.live(self.selection, self.other_selection):
            self.assertEqual(self.pin.status()["state"], "pinned-ready")

    def test_a_pin_for_a_logged_out_account_fails_closed(self):
        self.select_account()
        with self.live(self.other_selection):
            self.assertEqual(self.pin.status()["state"], "pinned-missing")
        with self.live():
            self.assertEqual(self.pin.status()["state"], "pinned-missing")

    def test_status_can_skip_the_live_list(self):
        """Health only renders the pinned name, so it must not survey every account."""
        self.select_account()
        with patch.object(live_source, "selection_for_account",
                          return_value=self.selection) as asked, \
                patch.object(live_source, "live_account_selections",
                             side_effect=AssertionError("must not enumerate every account")):
            status = self.pin.status(include_live=False)
        self.assertEqual(status["state"], "pinned-ready")
        self.assertEqual(status["live"], [])
        self.assertEqual(status["pinned"]["account"], "synthetic-a")
        self.assertEqual(asked.call_count, 1)

    def test_a_caller_that_already_resolved_the_account_is_not_re_asked(self):
        """Health has the answer already; the pin asks the identical question."""
        self.select_account()
        for value, expected in ((self.account.name, "pinned-ready"), ("wxid_other", "pinned-missing"),
                                (None, "pinned-missing")):
            with patch.object(live_source, "selection_for_account",
                              side_effect=AssertionError("must not query again")):
                self.assertEqual(self.pin.status(include_live=False, resolved=value)["state"],
                                 expected, value)

    def test_an_unresolved_hand_back_is_not_taken_for_an_answer(self):
        """A caller that could not resolve must not report its own failure as a missing pin.

        Health cannot tell "no account is live" from "the pinned account is live but its
        reader is still preparing keys", so it hands the question back and the pin asks.
        """
        self.select_account()
        with patch.object(live_source, "selection_for_account",
                          return_value=self.selection) as asked:
            status = self.pin.status(include_live=False, resolved=UNRESOLVED)
        self.assertEqual(status["state"], "pinned-ready")
        self.assertEqual(asked.call_count, 1)

    def test_status_without_a_pin_still_reports_the_ambiguous_state(self):
        with self.live(self.selection, self.other_selection):
            status = self.pin.status(include_live=False)
        self.assertEqual(status["state"], "unpinned-ambiguous")
        self.assertEqual(status["live"], [])

    def test_clear_returns_to_the_unpinned_states(self):
        self.select_account()
        with self.live(self.selection, self.other_selection):
            self.assertEqual(self.pin.clear()["state"], "unpinned-ambiguous")

    def test_corrupt_or_foreign_config_is_reported_invalid(self):
        self.pin.config.parent.mkdir(parents=True, exist_ok=True)
        for payload in ('{"schema":1}', '{"schema":1,"accountDir":"relative"}',
                        '{"schema":2,"accountDir":"C:\\\\x"}',
                        '{"schema":1,"accountDir":"C:\\\\x","extra":1}', "not json"):
            self.pin.config.write_text(payload, encoding="utf-8")
            self.assertEqual(self.pin.status()["state"], "invalid", payload)
            self.assertIsNone(self.pin.locator()())

    # --- file handling -------------------------------------------------------------

    def test_config_is_written_atomically_with_an_exact_key_set(self):
        self.select_account()
        stored = json.loads(self.pin.config.read_text(encoding="utf-8"))
        self.assertEqual(set(stored), {"schema", "accountDir"})
        self.assertEqual(stored["schema"], 1)
        self.assertEqual(Path(stored["accountDir"]), self.account.resolve())
        self.assertEqual(self.pin.config.name, PIN_FILENAME)
        self.assertEqual([path.name for path in self.pin.config.parent.iterdir()
                          if path.name.endswith(".tmp")], [])

    def test_select_rejects_paths_discovery_does_not_report(self):
        with patch("wr.discovery.discover_account_dirs", side_effect=self.discover):
            for value in (str(self.data / "not-an-account"), "relative-path", "",
                          str(self.root / "xwechat_files")):
                with self.assertRaises(AccountPinError):
                    self.pin.select(value)

    def test_an_explicit_null_overrides_an_inherited_hint(self):
        os.environ[account_pin_source.PIN_ENV] = str(self.account.resolve())
        with self.live(self.selection):
            self.assertEqual(self.pin.status()["state"], "pinned-ready")
        self.pin.clear()
        with self.live(self.selection):
            # The file now says "deliberately unpinned", so the variable must not re-pin it.
            self.assertEqual(self.pin.status()["state"], "unpinned-unique")

    def test_reads_are_cached_until_the_file_changes(self):
        self.select_account()
        with patch.object(Path, "open", side_effect=AssertionError("re-read")) as opened:
            self.pin.pinned_dir()
            self.pin.pinned_dir()
        self.assertFalse(opened.called)

    # --- locator -------------------------------------------------------------------

    def test_unpinned_locator_delegates_to_the_module_snapshot_at_call_time(self):
        """Late binding: patching live_source must still drive the decision."""
        locator = self.pin.locator()
        with patch.object(live_source, "active_account_snapshot", return_value=self.selection):
            self.assertEqual(locator(), self.selection)
        with patch.object(live_source, "active_account_snapshot", return_value=None):
            self.assertIsNone(locator())

    def test_pinned_locator_asks_only_about_the_pinned_account(self):
        """Several accounts means several Restart Manager queries; a pin needs one."""
        self.select_account()
        locator = self.pin.locator()
        asked = []

        def selection_for_account(account_dir):
            asked.append(str(account_dir))
            return self.selection

        with patch.object(live_source, "active_account_snapshot",
                          side_effect=AssertionError("the ambiguous snapshot must not be consulted")), \
                patch.object(live_source, "selection_for_account",
                             side_effect=selection_for_account):
            self.assertEqual(locator(), self.selection)
        self.assertEqual(asked, [str(self.account.resolve())])

    def test_a_pinned_locator_fails_closed_when_the_account_is_not_live(self):
        self.select_account()
        locator = self.pin.locator()
        with patch.object(live_source, "selection_for_account", return_value=None):
            self.assertIsNone(locator())

    def test_locator_never_raises_when_discovery_fails(self):
        self.select_account()
        locator = self.pin.locator()
        with patch.object(live_source, "selection_for_account", side_effect=RuntimeError("boom")):
            self.assertIsNone(locator())


class ConflictingInstanceTests(unittest.TestCase):
    """Two live instances must not read one account: the snapshot directory is shared."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.base = instance_identity.runtime_dir(self.root, None)
        self.alpha = instance_identity.runtime_dir(self.root, "alpha")
        self.account = self.root / "xwechat_files" / "wxid_shared"

    def pin(self, directory, account):
        directory.mkdir(parents=True, exist_ok=True)
        (directory / account_pin_source.PIN_FILENAME).write_text(
            json.dumps({"schema": 1, "accountDir": str(account)}), encoding="utf-8")

    def bridge(self, directory):
        directory.mkdir(parents=True, exist_ok=True)
        import psutil
        created = int((psutil.Process().create_time() + 11_644_473_600) * 10_000_000)
        (directory / "bridge-1.json").write_text(
            json.dumps({"pid": os.getpid(), "created_filetime": created}), encoding="utf-8")

    def test_a_live_instance_on_the_same_account_is_reported(self):
        self.pin(self.alpha, self.account)
        self.bridge(self.alpha)
        self.assertEqual(
            account_pin_source.conflicting_instance(str(self.account), self.root, None),
            self.alpha)

    def test_a_dead_instance_does_not_block_the_pin(self):
        self.pin(self.alpha, self.account)
        self.assertIsNone(
            account_pin_source.conflicting_instance(str(self.account), self.root, None))

    def test_a_different_account_or_the_own_profile_never_conflicts(self):
        other = self.root / "xwechat_files" / "wxid_other"
        self.pin(self.alpha, other)
        self.bridge(self.alpha)
        self.assertIsNone(
            account_pin_source.conflicting_instance(str(self.account), self.root, None))
        # The instance asking already owns it, so it is not a conflict with itself.
        self.assertIsNone(
            account_pin_source.conflicting_instance(str(other), self.root, "alpha"))

    def test_the_default_instance_is_seen_from_a_profile(self):
        self.pin(self.base, self.account)
        self.bridge(self.base)
        self.assertEqual(
            account_pin_source.conflicting_instance(str(self.account), self.root, "alpha"),
            self.base)

    def test_an_unreadable_pin_file_is_ignored(self):
        self.alpha.mkdir(parents=True)
        (self.alpha / account_pin_source.PIN_FILENAME).write_text("not json", encoding="utf-8")
        self.bridge(self.alpha)
        self.assertIsNone(
            account_pin_source.conflicting_instance(str(self.account), self.root, None))

    def test_a_record_without_a_creation_time_never_blocks_the_pin(self):
        """A stale record must not deny the account for good.

        The launcher always writes a FILETIME. A record without a usable one cannot prove the
        PID is the bridge it names, and treating it as live would fail closed forever with a
        message telling the user to release a pin that is not the cause.
        """
        self.pin(self.alpha, self.account)
        for record in ({"pid": os.getpid()}, {"pid": os.getpid(), "created_filetime": "42"},
                       {"pid": os.getpid(), "created_filetime": 0},
                       {"pid": os.getpid(), "created_filetime": None}):
            (self.alpha / "bridge-1.json").write_text(json.dumps(record), encoding="utf-8")
            self.assertIsNone(
                account_pin_source.conflicting_instance(str(self.account), self.root, None),
                record)
        # A record that does carry the filetime still reports the conflict.
        self.bridge(self.alpha)
        self.assertEqual(
            account_pin_source.conflicting_instance(str(self.account), self.root, None),
            self.alpha)


if __name__ == "__main__":
    unittest.main()
