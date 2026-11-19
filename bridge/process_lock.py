"""Small OS-backed file locks. Ownership ends when the handle/process exits."""
from __future__ import annotations

import os
import stat
import threading
import time
from pathlib import Path


class LockBusy(RuntimeError):
    pass


_OPEN_LOCKS: dict[str, threading.Lock] = {}
_OPEN_LOCKS_GUARD = threading.Lock()


def sqlite_open_lock(path):
    """One lock per database file, held only while a connection is opened.

    `sqlite3.connect` creates a missing database itself. Two threads opening the same new
    file at the same instant leave one of them holding a handle SQLite then reports as
    readonly ("attempt to write a readonly database") or refuses outright, and that happens
    before any transaction of ours could serialize them. Serializing only the open closes
    that window without serializing the queries that follow it.
    """
    key = os.path.normcase(os.path.abspath(str(path)))
    with _OPEN_LOCKS_GUARD:
        lock = _OPEN_LOCKS.get(key)
        if lock is None:
            lock = _OPEN_LOCKS[key] = threading.Lock()
        return lock


def checked_path(path):
    path = Path(os.path.abspath(path))
    for item in (path, *path.parents):
        try:
            info = item.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise OSError("unsafe resource lock path")
    return path


class ProcessLock:
    def __init__(self, path):
        self.path = checked_path(path)
        self.stream = None

    def acquire(self, timeout=0):
        if self.stream is not None:
            return self
        self.path.parent.mkdir(parents=True, exist_ok=True)
        checked_path(self.path)
        stream = self.path.open("a+b")
        # Both Windows byte-range locks and flock support an empty file. Writing
        # an initial byte races a peer that has already locked the same region.
        deadline = time.monotonic() + timeout
        while True:
            try:
                stream.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.stream = stream
                return self
            except OSError as exc:
                if time.monotonic() >= deadline:
                    stream.close()
                    raise LockBusy("resource is in use by another instance") from exc
                time.sleep(min(0.02, max(0, deadline - time.monotonic())))

    def release(self):
        stream, self.stream = self.stream, None
        if stream is not None:
            # Closing also releases the OS lock, including on a crashed process.
            stream.close()

    def __enter__(self):
        return self.acquire()

    def __exit__(self, *_exc):
        self.release()
