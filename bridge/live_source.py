"""Cache-first, read-only preparation for the uniquely active WeChat account.

Only validated raw database keys live in this process memory. The inherited WeChatDB reader
still writes its ordinary decrypted SQLite snapshots under its account-specific workdir.
"""
from __future__ import annotations

import ctypes
import os
import struct
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from cache_source import CacheOnlyWeChatDB
from wechatauto import db as upstream_db
from windows_file_owners import file_owners

NATIVE_READER = str(Path(__file__).resolve().parents[1] / "native-reader")
if NATIVE_READER not in sys.path:
    sys.path.insert(0, NATIVE_READER)
from wr import crypto, discovery

PAGE_SIZE = 4096
MAX_DB_FILES = 128
RETRY_SECONDS = 30
CONFIG_SCAN_CHUNK = 8 * 1024 * 1024
CONFIG_SCAN_PASS_BYTES = 2 * 1024 * 1024 * 1024
CONFIG_SCAN_TOTAL_BYTES = 4 * 1024 * 1024 * 1024
CONFIG_SCAN_REGIONS = 65_536
CONFIG_SCAN_CANDIDATES = 256
CONFIG_SCAN_SECONDS = 90


@dataclass(frozen=True)
class ActiveSelection:
    account_dir: Path
    # A PID alone may be reused. Unknown creation times never authorize a memory scan.
    processes: tuple[tuple[int, float | None], ...]


def _account_database_files(account):
    root = Path(account.path).resolve()
    # Live session/contact databases identify the account without asking Windows to
    # inspect every message/media shard on each identity check. Old accounts have these
    # files too, but are selected only when a current WeChat process owns them.
    anchors = [root / folder / (name + suffix)
               for folder, name in (("session", "session.db"), ("contact", "contact.db"))
               for suffix in ("", "-wal")]
    anchors = [path for path in anchors if path.is_file()]
    if anchors:
        resolved = [path.resolve() for path in anchors]
        if any(not path.is_relative_to(root) for path in resolved):
            raise OSError("database file is outside the account directory")
        return [str(path) for path in resolved]
    files = []
    def unreadable(error):
        raise error
    for base, directories, names in os.walk(root, onerror=unreadable):
        directories[:] = [name for name in directories if not name.lower().startswith("migrate")]
        for name in names:
            if name.lower().endswith((".db", ".db-wal", ".db-shm")):
                path = (Path(base) / name).resolve()
                if not path.is_relative_to(root):
                    raise OSError("database file is outside the account directory")
                files.append(str(path))
                if len(files) > MAX_DB_FILES * 4:
                    raise OSError("too many database resources for account discovery")
    return files


def _account_from_file_owners(accounts, processes):
    """Ask Windows which discovered process owns each account's SQLite files."""
    known = {process.pid for process in processes}
    matches = {}
    for account in accounts:
        owned = set()
        for pid, created in file_owners(_account_database_files(account)):
            if pid not in known or discovery.psutil is None:
                continue
            try:
                process = discovery.psutil.Process(pid)
                # Recheck name and creation time: a reused PID is not a WeChat identity.
                if (process.name().lower() in ("weixin.exe", "wechat.exe") and
                        abs(process.create_time() - created) < .001):
                    owned.add((pid, created))
            except (discovery.psutil.NoSuchProcess, discovery.psutil.AccessDenied):
                continue
        if owned:
            location = Path(account.path).parent.resolve()
            matches.setdefault(location, set()).update(owned)
    if len(matches) != 1:
        return None
    location, owners = next(iter(matches.items()))
    return ActiveSelection(location, tuple(sorted(owners)))


def active_account_snapshot() -> ActiveSelection | None:
    """Use live file ownership only; ambiguous or logged-out accounts are not selected."""
    accounts = discovery.discover_account_dirs()
    processes = discovery.find_weixin_processes()
    if not accounts or not processes:
        return None
    if os.name == "nt":
        # Restart Manager only queries ownership. Unlike open_files(), this does not need
        # PROCESS_DUP_HANDLE, which current WeChat can deny even to the same Windows user.
        return _account_from_file_owners(accounts, processes)
    roots = [(account, os.path.normcase(os.path.realpath(account.path))) for account in accounts]
    matches: dict[str, set[tuple[int, float | None]]] = {}
    for process in processes:
        paths = discovery.process_open_file_paths(process.pid)
        if not paths:
            continue
        created = None
        try:
            if discovery.psutil is not None:
                created = float(discovery.psutil.Process(process.pid).create_time())
        except Exception:
            pass
        for path in paths:
            opened = os.path.normcase(os.path.realpath(path))
            for account, root in roots:
                if opened == root or opened.startswith(root + os.sep):
                    matches.setdefault(account.id, set()).add((process.pid, created))
    if len(matches) != 1:
        return None
    active_id, processes = next(iter(matches.items()))
    match = next((account for account in accounts if account.id == active_id), None)
    return (ActiveSelection(Path(match.path).parent.resolve(), tuple(sorted(processes)))
            if match else None)


def _pages(account_dir: Path) -> dict[str, tuple[Path, bytes, bytes]]:
    """Read exactly page 1 of each database the cache-only reader would require."""
    storage = account_dir / "db_storage"
    pages = {}
    for base, _dirs, names in os.walk(storage):
        relative_base = os.path.relpath(base, storage)
        if os.path.normcase(relative_base).startswith("migrate"):
            continue
        for name in names:
            if not name.endswith(".db"):
                continue
            path = Path(base) / name
            rel = os.path.relpath(path, storage)
            with open(path, "rb") as source:
                page = source.read(PAGE_SIZE)
            if len(page) != PAGE_SIZE or page.startswith(b"SQLite format 3\x00"):
                raise RuntimeError("unsupported active database page layout")
            pages[rel] = (path, page[:16], page)
            if len(pages) > MAX_DB_FILES:
                raise RuntimeError("too many active database files")
    if not pages:
        raise RuntimeError("no active database files")
    return pages


def _token(selection: ActiveSelection, pages: dict[str, tuple[Path, bytes, bytes]]):
    return (os.path.normcase(os.path.realpath(selection.account_dir)), selection.processes,
            tuple(sorted((rel, salt) for rel, (_path, salt, _page) in pages.items())))


class _ConfigScanLimit(RuntimeError):
    pass


class _BoundedConfigCipherProbe:
    """Supply bounded address search to the installed reader's Config.Cipher decoder.

    This object deliberately has no account enumeration, cache, or master-key methods. The
    upstream decoder receives only the already-selected process and database files.
    """

    def __init__(self, pages: dict[str, tuple[Path, bytes, bytes]]):
        self._db_files = [(rel, str(path), len(page))
                          for rel, (path, _salt, page) in pages.items()]
        self._anchors: list[int] = []
        self._pair_hits: dict[bytes, list[int]] | None = None
        self._bytes_read = 0
        self._regions = 0
        self._candidates = 0
        self._deadline = time.monotonic() + CONFIG_SCAN_SECONDS

    def _probable_key(self, candidate: bytes) -> bool:
        self._candidates += 1
        if self._candidates > CONFIG_SCAN_CANDIDATES:
            raise _ConfigScanLimit("candidate_limit")
        return upstream_db.WeChatDB._probable_key(candidate)

    def _scan_needles(self, handle, read, needles: tuple[bytes, ...], hit_limit: int):
        hits = {needle: [] for needle in needles}
        if not needles:
            return hits
        overlap_size = max(map(len, needles)) - 1
        address = 0
        pass_bytes = 0
        queries = 0
        hit_count = 0
        while True:
            if time.monotonic() >= self._deadline or queries >= CONFIG_SCAN_REGIONS:
                raise _ConfigScanLimit("region_or_time_limit")
            info = upstream_db._MBI()
            if not upstream_db._k32.VirtualQueryEx(
                handle, ctypes.c_void_p(address), ctypes.byref(info), ctypes.sizeof(info)
            ):
                return hits
            queries += 1
            self._regions += 1
            if self._regions > CONFIG_SCAN_REGIONS:
                raise _ConfigScanLimit("region_limit")
            base = int(info.BaseAddress or 0)
            size = int(info.RegionSize)
            next_address = base + size
            if size <= 0 or next_address <= address:
                return hits
            readable = (info.State == 0x1000 and (info.Protect & 0xFF) & 0xE6
                        and not (info.Protect & 0x100))
            if readable:
                offset = 0
                overlap = b""
                while offset < size:
                    if time.monotonic() >= self._deadline:
                        raise _ConfigScanLimit("time_limit")
                    budget = min(CONFIG_SCAN_PASS_BYTES - pass_bytes,
                                 CONFIG_SCAN_TOTAL_BYTES - self._bytes_read)
                    if budget <= 0:
                        raise _ConfigScanLimit("byte_limit")
                    take = min(CONFIG_SCAN_CHUNK, size - offset, budget)
                    self._bytes_read += take
                    pass_bytes += take
                    chunk = read(base + offset, take)
                    if chunk:
                        data = overlap + chunk
                        data_base = base + offset - len(overlap)
                        for needle in needles:
                            at = 0
                            while True:
                                at = data.find(needle, at)
                                if at < 0:
                                    break
                                hits[needle].append(data_base + at)
                                hit_count += 1
                                if hit_count >= hit_limit:
                                    return hits
                                at += 1
                        overlap = data[-overlap_size:] if overlap_size else b""
                    else:
                        overlap = b""
                    offset += take
            address = next_address

    def _find_bytes(self, handle, read, needle: bytes) -> list[int]:
        if needle == upstream_db.CONFIG_CIPHER_NAME:
            found = self._scan_needles(handle, read, (needle,), 32)
            self._anchors = found[needle]
            return self._anchors
        if self._pair_hits is None:
            pairs = tuple(struct.pack("<QQ", anchor, len(upstream_db.CONFIG_CIPHER_NAME))
                          for anchor in self._anchors)
            self._pair_hits = self._scan_needles(handle, read, pairs, 128)
        return self._pair_hits.get(needle, [])


def _scan_config_cipher_keys(pid: int, pages: dict[str, tuple[Path, bytes, bytes]]):
    probe = _BoundedConfigCipherProbe(pages)
    return upstream_db.WeChatDB._extract_keys_pid(probe, pid, set())


class VolatileKeyWeChatDB(CacheOnlyWeChatDB):
    """Use validated in-memory per-database keys when existing key caches are absent."""

    def __init__(self, *, volatile_keys: dict[str, bytes], **kwargs):
        self._volatile_keys = dict(volatile_keys)
        super().__init__(**kwargs)

    def _load_or_extract_keys(self, master_key=None):
        try:
            return super()._load_or_extract_keys(master_key=master_key)
        except RuntimeError:
            if master_key is not None:
                raise
        self.master_key = None
        self.cfg_dword = None
        self._keys = {}
        required = {rel for rel, _path, _size in self._db_files}
        for rel in required:
            raw = self._volatile_keys.get(rel)
            if isinstance(raw, bytes) and len(raw) in (32, 48):
                self._keys[rel] = raw
                if not self._key_works(rel):
                    del self._keys[rel]
        if not required or required - self._keys.keys():
            self._keys = {}
            raise RuntimeError("local WeChat key cache unavailable for selected account")

    def _save_keys(self, *args, **kwargs):
        # The upstream new-shard path must never persist volatile key material.
        return None


@dataclass
class _ScanSlot:
    state: str
    keys: dict[str, bytes] | None = None
    retry_at: float = 0.0


class LiveWeChatFactory:
    """One background scan per account/process/page-salt identity, with bounded retry."""

    def __init__(self, cache_factory=CacheOnlyWeChatDB, volatile_factory=VolatileKeyWeChatDB,
                 scanner=None, retry_seconds=RETRY_SECONDS):
        self.cache_factory = cache_factory
        self.volatile_factory = volatile_factory
        self.scanner = scanner
        self.retry_seconds = retry_seconds
        self.lock = threading.Lock()
        self.slots: dict[tuple, _ScanSlot] = {}

    def forget_account(self, account):
        """Discard scoped in-memory keys; a running scan will discard its late result."""
        with self.lock:
            for token in list(self.slots):
                if os.path.basename(token[0]) == account:
                    del self.slots[token]

    def __call__(self, *, db_dir: str, account: str, selection: ActiveSelection | None):
        location = (Path(db_dir) / account).resolve()
        if selection is None or selection.account_dir != location:
            raise RuntimeError("active account changed")
        # An explicit account's existing cache can support layouts the volatile scanner cannot.
        try:
            return self.cache_factory(db_dir=db_dir, account=account)
        except Exception:
            pass
        pages = _pages(location)
        token = _token(selection, pages)
        with self.lock:
            slot = self.slots.get(token)
            if slot and slot.state == "ready":
                keys = dict(slot.keys or {})
            elif slot and (slot.state == "running" or time.monotonic() < slot.retry_at):
                raise RuntimeError("active account preparation pending")
            else:
                keys = None
        if keys is not None:
            try:
                return self.volatile_factory(db_dir=db_dir, account=account, volatile_keys=keys)
            except Exception:
                with self.lock:
                    self.slots[token] = _ScanSlot("failed", retry_at=time.monotonic() + self.retry_seconds)
                raise RuntimeError("active account preparation pending") from None
        with self.lock:
            slot = self.slots.get(token)
            if slot and (slot.state == "running" or time.monotonic() < slot.retry_at):
                raise RuntimeError("active account preparation pending")
            # Keep at most four scoped outcomes without evicting live scan threads.
            if token not in self.slots and len(self.slots) >= 4:
                finished = next((key for key, value in self.slots.items()
                                 if value.state != "running"), None)
                if finished is None:
                    raise RuntimeError("active account preparation pending")
                del self.slots[finished]
            self.slots[token] = _ScanSlot("running")
        threading.Thread(target=self._scan, args=(selection, pages, token), daemon=True).start()
        raise RuntimeError("active account preparation pending")

    def _scan(self, selection: ActiveSelection, pages, token):
        keys: dict[str, bytes] = {}
        reason = "keys_incomplete"
        stage = "scan_setup"
        matched = 0
        try:
            first_pages = {}
            for _rel, (_path, salt, page) in pages.items():
                first_pages.setdefault(salt, page)
            for pid, created in selection.processes:
                stage = "process_identity"
                if created is None:
                    reason = "process_identity_unavailable"
                    break
                if active_account_snapshot() != selection:
                    reason = "account_changed"
                    break
                stage = "process_scan"
                stage = "candidate_validation"
                if self.scanner is None:
                    stage = "config_cipher_scan"
                    found = _scan_config_cipher_keys(pid, pages)
                    stage = "candidate_validation"
                    for rel, raw in found.items():
                        if (rel in pages and isinstance(raw, bytes) and len(raw) in (32, 48)
                                and upstream_db._verify_enc_key(raw, pages[rel][2])):
                            keys[rel] = raw
                else:
                    candidates = self.scanner(pid, set(first_pages), first_pages)
                    for candidate in candidates:
                        for rel, (_path, salt, page) in pages.items():
                            if rel in keys or candidate.salt != salt:
                                continue
                            if crypto.validate_key(candidate.key, salt, page) is not None:
                                keys[rel] = candidate.key
                if len(keys) == len(pages):
                    break
            matched = len(keys)
            stage = "final_identity"
            if active_account_snapshot() != selection:
                reason = "account_changed"
            elif len(keys) == len(pages):
                stage = "final_pages"
                reason = ("ready" if _token(selection, _pages(selection.account_dir)) == token
                          else "database_changed")
            if reason != "ready":
                keys = {}
        except discovery.errors.ProtocolError as exc:
            reason = ("process_read_denied" if exc.code == discovery.errors.PERMISSION_DENIED
                      else "process_scan_error")
            matched = len(keys)
            keys = {}
        except Exception:
            reason = stage + "_error"
            matched = len(keys)
            keys = {}
        with self.lock:
            slot = self.slots.get(token)
            if slot is None or slot.state != "running":
                reason = "scan_discarded"
            elif keys:
                slot.state, slot.keys = "ready", keys
            else:
                slot.state, slot.keys = "failed", None
                slot.retry_at = time.monotonic() + self.retry_seconds
        print(f"live_wechat_preparation result={reason} required={len(pages)} "
              f"matched={matched}", file=sys.stderr, flush=True)
