"""Pin this instance to one WeChat account, so several instances can share one machine.

Without a pin nothing changes: an instance still needs exactly one live account, and two
logged-in accounts stay "not ready". A pin removes only that ambiguity — it names the
account this instance reads, and it never falls back to a different one when the named
account is logged out, because silently switching accounts would mix two people's data.

Read-only like the rest of discovery: it opens no chat database and reads no message.
"""
from __future__ import annotations

import json
import os
import sys
import threading
import uuid
from pathlib import Path

from instance_identity import runtime_dir


PIN_ENV = "WECHATVIBE_ACCOUNT_PIN"
PIN_FILENAME = "wechat-account-pin.json"
_MISSING = object()
# Distinguishes "the caller already resolved the account" from "it resolved to nothing".
# Public, because a caller whose own probe failed has to hand the question back rather than
# answer it: `Backend.health` cannot tell "no account is live" apart from "the pinned account
# is live but its reader is still preparing keys", and only the first is an answer.
UNRESOLVED = object()
_CONFIG_LIMIT = 8192


class AccountPinError(ValueError):
    pass


def _read_pin_file(path):
    """The directory a pin file names, or None when there is no usable pin."""
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    if (not isinstance(data, dict) or set(data) != {"schema", "accountDir"} or
            data.get("schema") != 1):
        return None
    value = data.get("accountDir")
    return value if isinstance(value, str) and value else None


def _live_bridge(directory):
    """True when this instance still has a running bridge, matched by PID creation time."""
    try:
        import psutil
    except Exception:
        return False
    for record in directory.glob("bridge-*.json"):
        try:
            data = json.loads(record.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        pid = data.get("pid")
        if not isinstance(pid, int) or pid <= 0:
            continue
        try:
            process = psutil.Process(pid)
            expected = data.get("created_filetime")
            # Stored as a Windows FILETIME; a reused PID has a different creation time. A record
            # without one cannot prove this PID is the bridge it names, and treating it as live
            # would deny the account to every instance for good, with a message telling the user
            # to release a pin that is not the cause. The launcher always writes the FILETIME.
            if not isinstance(expected, int) or expected <= 0:
                continue
            if abs(process.create_time() - (expected / 10_000_000 - 11_644_473_600)) > 1:
                continue
            return True
        except Exception:
            continue
    return False


def conflicting_instance(account_dir, root, profile):
    """The runtime directory of another live instance already pinned to this account.

    Every reader decrypts an account into one machine-wide directory named after the account,
    whichever instance opened it, and the vendored reader takes no cross-process lock. Two
    instances on one account would overwrite each other's snapshot files, so the only safe
    answer is to refuse the second pin rather than corrupt both.
    """
    if not isinstance(account_dir, str) or not account_dir:
        return None
    base = runtime_dir(Path(root), None)
    try:
        others = [(None, base)] + [(child.name, child) for child in base.iterdir()
                                   if child.is_dir()]
    except OSError:
        return None
    target = os.path.normcase(os.path.realpath(account_dir))
    for name, directory in others:
        if name == profile:
            continue
        pinned = _read_pin_file(directory / PIN_FILENAME)
        if pinned is None or os.path.normcase(os.path.realpath(pinned)) != target:
            continue
        if _live_bridge(directory):
            return directory
    return None


class AccountPinSource:
    def __init__(self, root, profile=None):
        self.root = Path(root).resolve()
        self.config = runtime_dir(self.root, profile) / PIN_FILENAME
        self.lock = threading.RLock()
        # Keyed on (mtime_ns, size) so a pinned instance does not re-read on every request.
        self._cache = None

    def _check_config(self):
        if not self.config.resolve().is_relative_to(self.root):
            raise AccountPinError("账号锁定配置不可用")
        cursor = self.config
        while cursor != self.root:
            try:
                attributes = cursor.lstat()
            except FileNotFoundError:
                pass
            else:
                if cursor.is_symlink() or getattr(attributes, "st_file_attributes", 0) & 0x400:
                    raise AccountPinError("账号锁定配置不可用")
            cursor = cursor.parent

    @staticmethod
    def _directory(value):
        if (not isinstance(value, str) or not 1 <= len(value) <= 4096 or
                any(ord(char) < 32 or ord(char) == 127 for char in value)):
            raise AccountPinError("账号锁定配置不可用")
        path = Path(value)
        if not path.is_absolute():
            raise AccountPinError("账号锁定配置不可用")
        return path

    def _stored_dir(self):
        """The stored account directory, or _MISSING when no file has been written yet."""
        self._check_config()
        try:
            stat = self.config.stat()
        except FileNotFoundError:
            self._cache = None
            return _MISSING
        key = (stat.st_mtime_ns, stat.st_size)
        if self._cache is not None and self._cache[0] == key:
            return self._cache[1]
        with self.config.open("rb") as stream:
            raw = stream.read(_CONFIG_LIMIT + 1)
        if len(raw) > _CONFIG_LIMIT:
            raise AccountPinError("账号锁定配置不可用")
        data = json.loads(raw.decode("utf-8"))
        if (not isinstance(data, dict) or set(data) != {"schema", "accountDir"} or
                type(data["schema"]) is not int or data["schema"] != 1):
            raise AccountPinError("账号锁定配置不可用")
        value = data["accountDir"]
        value = None if value is None else str(self._directory(value))
        self._cache = (key, value)
        return value

    def _write(self, value):
        self._check_config()
        self.config.parent.mkdir(parents=True, exist_ok=True)
        self._check_config()
        temporary = self.config.with_name(self.config.name + "." + uuid.uuid4().hex + ".tmp")
        try:
            with temporary.open("x", encoding="utf-8") as stream:
                json.dump({"schema": 1, "accountDir": value}, stream, ensure_ascii=False)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.config)
        finally:
            temporary.unlink(missing_ok=True)
        self._cache = None

    def pinned_dir(self):
        """The effective pin: an explicit file wins, else an inherited hint, else nothing.

        A file that stores null means "deliberately unpinned" and overrides the environment,
        so clearing in the app cannot be undone by a variable the user forgot about.
        """
        value = self._stored_dir()
        if value is _MISSING:
            value = os.environ.get(PIN_ENV) or None
        return value

    def _known_account_dir(self, value):
        """Accept only a directory discovery reports, so a pin cannot name an arbitrary path."""
        path = self._directory(value)
        if not path.is_dir():
            raise AccountPinError("账号目录不存在")
        target = path.resolve()
        native_reader = str(self.root / "native-reader")
        if native_reader not in sys.path:
            sys.path.insert(0, native_reader)
        from wr import discovery
        for account in discovery.discover_account_dirs():
            if Path(account.path).parent.resolve() == target:
                return target
        raise AccountPinError("未发现该微信账号目录")

    @staticmethod
    def _describe(directory):
        return {"accountDir": str(Path(directory).resolve()), "account": Path(directory).name}

    def _live(self):
        # Imported here rather than at module scope: the name must resolve at call time so
        # tests that patch live_source keep driving the real decision.
        import live_source
        return live_source.live_account_selections()

    def status(self, include_live=True, resolved=UNRESOLVED):
        """The pin state, and optionally the picker's list of live accounts.

        `include_live=False` lets a caller that only needs the state (the health endpoint)
        skip surveying accounts it will not report: with a pin, whether that one account is
        live is the whole question, and asking about the others costs a Restart Manager
        query each. `resolved` is the account the caller has already resolved in this same
        request; the locator answers the identical question, so a status report that already
        has the answer must not pay for it twice. `UNRESOLVED` is the caller saying it could
        not answer — the pin then asks its own narrower question instead of reporting the
        account as missing.
        """
        with self.lock:
            try:
                pinned = self.pinned_dir()
            except (OSError, ValueError):
                return {"state": "invalid", "pinned": None, "live": []}
            if pinned is not None and not include_live:
                if resolved is UNRESOLVED:
                    try:
                        import live_source
                        resolved = live_source.selection_for_account(pinned)
                    except Exception:
                        resolved = None
                    matched = resolved is not None
                else:
                    resolved = resolved if isinstance(resolved, str) else (
                        Path(resolved.account_dir).name if resolved is not None else None)
                    matched = resolved is not None and resolved == Path(pinned).name
                return {"state": "pinned-ready" if matched else "pinned-missing",
                        "pinned": self._describe(pinned), "live": []}
            try:
                live = self._live()
            except Exception:
                live = []
            live_items = [self._describe(selection.account_dir) for selection in live]
            if pinned is None:
                state = ("unpinned-none" if not live_items else
                         "unpinned-unique" if len(live_items) == 1 else
                         "unpinned-ambiguous")
                return {"state": state, "pinned": None,
                        "live": live_items if include_live else []}
            target = os.path.normcase(os.path.realpath(pinned))
            matched = any(os.path.normcase(os.path.realpath(selection.account_dir)) == target
                          for selection in live)
            return {"state": "pinned-ready" if matched else "pinned-missing",
                    "pinned": self._describe(pinned),
                    "live": live_items if include_live else []}

    def select(self, account_dir):
        with self.lock:
            self._write(str(self._known_account_dir(account_dir)))
            return self.status()

    def clear(self):
        with self.lock:
            self._write(None)
            return self.status()

    def locator(self):
        """A selection callable for this instance, for injection into the live source.

        Resolution stays path-based, matching how `_token` normalizes the account, so the
        same wxid under two data roots cannot be confused for the pinned one.
        """
        def locate():
            try:
                pinned = self.pinned_dir()
            except (OSError, ValueError):
                return None
            if pinned is None:
                import live_source
                return live_source.active_account_snapshot()
            try:
                import live_source
                # Only this account is asked about, which halves the Restart Manager work on
                # a machine with several accounts logged in.
                return live_source.selection_for_account(pinned)
            except Exception:
                # Pinned but not signed in: fail closed rather than read someone else's account.
                return None
        return locate
