"""Cached-key initialization and reusable snapshots with upstream database/WAL decoding."""
from __future__ import annotations

import os

from wechatauto.db import WeChatDB
from snapshot_cache import SnapshotCacheMixin


class CacheOnlyWeChatDB(SnapshotCacheMixin, WeChatDB):
    def get_self_info(self):
        for rel, path, _ in self._db_files:
            if os.path.basename(path) != "contact.db":
                continue
            conn = self._open(rel)
            try:
                row = conn.execute(
                    "SELECT username, nick_name, remark FROM contact WHERE username=? LIMIT 1",
                    (self.wxid,),
                ).fetchone()
            finally:
                conn.close()
            if row:
                return {"username": row[0], "nick_name": row[1], "remark": row[2]}
        return {"username": self.wxid, "nick_name": "", "remark": ""}

    def _load_or_extract_keys(self, master_key=None):
        if master_key is not None:
            raise RuntimeError("cache-only mode does not accept a master key")
        self.master_key = None
        self.cfg_dword = None
        self._keys = {}
        stable = self._stable_key_file()
        cache_paths = [stable, self.keys_file, self.keys_file + ".bak"]
        required = {rel for rel, _, _ in self._db_files}
        for path in cache_paths:
            if not path or not os.path.isfile(path):
                continue
            try:
                candidates = self._load_key_cache(path)
            except (AttributeError, TypeError, ValueError):
                continue
            for rel in required - self._keys.keys():
                key = candidates.get(rel)
                if not isinstance(key, bytes) or len(key) not in (32, 48):
                    continue
                self._keys[rel] = key
                try:
                    valid = self._key_works(rel)
                except Exception:
                    valid = False
                if not valid:
                    del self._keys[rel]
        if not required or required - self._keys.keys():
            self._keys = {}
            raise RuntimeError("local WeChat key cache unavailable for selected account")

    def _auto_diagnose_key_failure(self, _rel):
        raise RuntimeError("local WeChat key cache unavailable for selected account")

    def extract_keys(self):
        raise RuntimeError("process key extraction disabled in cache-only mode")

    def extract_master_key(self):
        raise RuntimeError("process key extraction disabled in cache-only mode")

    def _all_key_candidates(self):
        raise RuntimeError("process key extraction disabled in cache-only mode")
