"""Shared managed WeChat context for Advisor.

One projection per real account + WeChat user holds every readable message the
source exposes. Imports freeze the source highwater and walk forward with the
source cursor, checking identity before and after every page; a page is saved
in one SQLite transaction together with the checkpoint, and a cancelled or
account-switched reader never commits its late page.

Model input is compacted only when a run asks for it and the assembled input
cannot fit. Compaction is hierarchical: the oldest leaf segments are replaced
by neutral summaries which are cached per source range + compression version +
model fingerprint and produced single-flight, so concurrent agents share them.
The full original history always stays in the projection; only the model input
is ever compacted.
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from contextlib import contextmanager, nullcontext

from advisor_contracts import (
    COMPACT_CHUNK_CHARS, COMPRESSION_VERSION, MAX_SUMMARY_CHARS,
    RECENT_CONTEXT_PERCENT, MAX_COMPRESSION_LEVELS, AdvisorError, compress_key, public_context,
)
import message_input
from backend_contracts import AccountChangedError, AccountUnavailableError, MessagesUnavailableError
from history_browser import decode_cursor

IMPORT_PAGE_SIZE = 256
MAX_CONTEXT_MESSAGE_CHARS = 16000
MAX_CONTEXT_ERROR_CHARS = 300
MAX_RAW_FIELD_CHARS = 2048
# Retained windows are a highwater hint for a later `prepare`, so only the recent ones matter: the
# UI preloads every added conversation in batches of 64, and without a bound the bridge kept one
# decoded window (up to 80 messages) per conversation it had ever seen, for the whole process.
MAX_PENDING_WINDOWS = 64
VALID_SIDES = ("self", "other")


def _encode_position(value):
    if value is None:
        return None
    return json.dumps(list(value), ensure_ascii=False, separators=(",", ":"))


def _decode_position(value):
    if not value:
        return None
    try:
        parts = json.loads(value)
    except (TypeError, ValueError):
        return None
    if (not isinstance(parts, list) or len(parts) != 3 or type(parts[0]) is not int or
            not isinstance(parts[1], str) or type(parts[2]) is not int):
        return None
    return (parts[0], parts[1], parts[2])


def _friendly_error(exc):
    return "读取聊天记录失败，请重试"


class _Import:
    def __init__(self, cancel, thread, binding):
        self.cancel = cancel
        self.thread = thread
        self.binding = binding


class ContextProjection:
    """Owns import workers, the context projection and neutral summaries."""

    def __init__(self, stores, source):
        self.stores = stores
        self.source = source
        self.lock = threading.RLock()
        self.condition = threading.Condition(self.lock)
        self._imports = {}
        self._summary_locks = {}
        self._closed = False
        self._paused = set()
        self._observed = {}
        self._pending_windows = {}

    # -- identity ------------------------------------------------------------
    def _identity(self, fresh=False):
        advisor_identity = getattr(self.source, "advisor_identity", None)
        verified = getattr(self.source, "verified_identity", None)
        if not fresh and callable(advisor_identity):
            identity = advisor_identity(messages=True)
        else:
            identity = verified(messages=True) if callable(verified) else self.source.identity()
        if isinstance(identity, (tuple, list)) and len(identity) >= 2:
            return str(identity[0]), os.path.normcase(os.path.realpath(str(identity[1])))
        raise AdvisorError("account-changed", "无法确认当前微信账号")

    @staticmethod
    def scope_fingerprint(account, workdir):
        identity = (str(account), os.path.normcase(os.path.realpath(str(workdir))))
        return hashlib.sha256(json.dumps(identity, ensure_ascii=False).encode("utf-8")).hexdigest()

    def source_scope(self, account, fresh=False):
        binding = self.capture_binding(account)
        return self.source.binding_fingerprint(binding)

    def capture_binding(self, account):
        binding = self.source.capture_binding(messages=True)
        if str(binding.account) != account:
            raise AccountChangedError()
        return binding

    def _binding_key(self, fingerprint, binding):
        return fingerprint, binding

    def _check_identity(self, account, expected=None, binding=None, fresh=False):
        if binding is None:
            binding = self.capture_binding(account)
        self.source.assert_binding(binding, messages=True, fresh=fresh)
        if str(binding.account) != account:
            raise AccountChangedError()
        current = self.source.binding_fingerprint(binding)
        if expected is not None and current != expected:
            raise AccountChangedError()
        return current

    def _check_open(self, account, cancel=None, expected=None, binding=None, fresh=False):
        if self._closed or account in self._paused or (cancel is not None and cancel.is_set()):
            raise AdvisorError("stopping", "已停止")
        return self._check_identity(account, expected, binding, fresh=fresh)

    def highwater(self, account, user, binding=None):
        """Read a fixed source highwater with identity checks on both sides."""
        binding = binding or self.capture_binding(account)
        self._check_identity(account, binding=binding)
        try:
            highwater = self.source.history_highwater(user)
        finally:
            self._check_identity(account, binding=binding)
        return highwater

    # -- public API ----------------------------------------------------------
    def observe_window(self, account, workdir, user, messages, has_more_before, binding):
        """Accept only the backend's already-verified decoded latest message window."""
        if type(has_more_before) is not bool or not isinstance(messages, (list, tuple)):
            raise AdvisorError("invalid-request", "会话窗口结构无效")
        scope = (account, os.path.normcase(os.path.realpath(str(workdir))))
        if scope[1] != os.path.normcase(os.path.realpath(str(binding.workdir))):
            raise AccountChangedError()
        fingerprint = self._check_identity(account, binding=binding)
        rows = self._page_rows(user, messages, 0, trusted_identity=scope)
        positions = [_decode_position(row["sort_key"]) for row in rows]
        if (len({row["msg_id"] for row in rows}) != len(rows) or
                any(previous >= current for previous, current in zip(positions, positions[1:]))):
            raise AdvisorError("context-error", "会话窗口顺序无效")
        observation = {"fingerprint": fingerprint, "binding": binding, "rows": rows, "hasMoreBefore": has_more_before,
                       "latest": positions[-1] if positions else None}
        key = (account, user)
        with self.lock, self.source.lock:
            self._check_identity(account, fingerprint, binding, fresh=True)
            if self._closed or account in self._paused:
                return False
            database = self.stores.account(account)
            entry = self._imports.get(key)
            if entry is not None and entry.thread.is_alive():
                self._pending_windows[key] = observation
                self._observed.pop(key, None)
                self._trim_pending_locked()
                if entry.binding != binding:
                    entry.cancel.set()
                return True
            return self._apply_window_locked(account, user, observation)

    def _apply_window_locked(self, account, user, observation, after_import=False):
        binding = observation["binding"]
        self._check_identity(account, observation["fingerprint"], binding)
        key = (account, user)
        database = self.stores.account(account)
        row = database.context(user)
        fingerprint, rows, newest = observation["fingerprint"], observation["rows"], observation["latest"]
        scope_changed = row is not None and row["source_id"] != fingerprint
        previous = _decode_position(row["last_sort"]) if row is not None else None
        try:
            known = database.context_window_matches(user, rows) if row is not None and not scope_changed else set()
            changed_facts = False
        except AdvisorError:
            known, changed_facts = set(), True
        complete = not observation["hasMoreBefore"]
        missing_facts = complete and row is not None and not scope_changed and len(known) != row["read_count"]
        anchored = previous is not None and any(_decode_position(item["sort_key"]) == previous and
                                                item["msg_id"] in known for item in rows)
        prefix_unknown = row is not None and previous is not None and any(
            _decode_position(item["sort_key"]) <= previous and item["msg_id"] not in known for item in rows)
        older_pending = (after_import and not complete and row is not None and row["state"] == "ready" and
                         not scope_changed and not changed_facts and len(known) == len(rows) and
                         (newest is None or _decode_position(row["highwater"]) is not None and
                          newest <= _decode_position(row["highwater"])))
        if older_pending:
            self._observed[key] = self._binding_key(fingerprint, binding)
            self._pending_windows.pop(key, None)
            return True
        rollback = row is not None and previous is not None and (newest is None or newest < previous)
        if complete and (row is None or scope_changed or changed_facts or missing_facts or rollback or prefix_unknown):
            database.context_begin(user, _encode_position(newest), fingerprint, reset=row is not None)
            database.context_append_page(user, rows, _encode_position(newest), _encode_position(newest))
            current = database.context(user)
            database.context_finish(user, current["read_count"])
            self._observed[key] = self._binding_key(fingerprint, binding)
            self._pending_windows.pop(key, None)
            self.condition.notify_all()
            return True
        if (row is not None and row["state"] == "ready" and not scope_changed and not changed_facts and
                not rollback and not prefix_unknown and (anchored or complete)):
            delta = [item for item in rows if item["msg_id"] not in known]
            highwater = newest or _decode_position(row["highwater"])
            if delta:
                database.context_begin(user, _encode_position(highwater), fingerprint)
                database.context_append_page(user, delta, _encode_position(highwater), _encode_position(highwater))
                current = database.context(user)
                database.context_finish(user, current["read_count"])
            self._observed[key] = self._binding_key(fingerprint, binding)
            self._pending_windows.pop(key, None)
            self.condition.notify_all()
            return True
        self._observed.pop(key, None)
        self._pending_windows[key] = observation
        self._trim_pending_locked()
        if row is not None:
            # Only an already-managed conversation is repaired proactively; first windows are seeds.
            reset = scope_changed or changed_facts or rollback or prefix_unknown
            ceiling = newest or _decode_position(row["highwater"])
            database.context_begin(user, _encode_position(ceiling), fingerprint, reset=reset)
            self._start_worker(account, user, binding)
        return True

    def _trim_pending_locked(self):
        """Keep the retained windows bounded, oldest first, without dropping a running import.

        A window is kept so a later `prepare` can take its newest position as the highwater hint
        (it falls back to `highwater()` when the entry is gone), and an import that is still running
        keeps its own entry because its worker continues from the window it was started with.
        """
        while len(self._pending_windows) > MAX_PENDING_WINDOWS:
            for key in self._pending_windows:
                entry = self._imports.get(key)
                if entry is not None and entry.thread.is_alive():
                    continue
                del self._pending_windows[key]
                break
            else:
                break

    def invalidate_window(self, account, user):
        with self.lock:
            self._observed.pop((account, user), None)
            self._pending_windows.pop((account, user), None)

    def prepare(self, account, user, cancel=None, expected_scope=None, binding=None):
        """Start or continue the shared import; never calls a generative model."""
        binding = binding or self.capture_binding(account)
        fingerprint = self._check_open(account, cancel, expected_scope, binding)
        with self.lock:
            if self._closed or account in self._paused or (cancel is not None and cancel.is_set()):
                raise AdvisorError("stopping", "已停止")
            key = (account, user)
            database = self.stores.account(account)
            row = database.context(user)
            worker = self._imports.get(key)
            running = worker is not None and worker.thread.is_alive()
            if running:
                if worker.binding != binding:
                    worker.cancel.set()
                    raise AccountChangedError()
                return public_context(row)
            if (row is not None and row["state"] == "ready" and
                    self._observed.get(key) == self._binding_key(row["source_id"], binding) and
                    (expected_scope is None or expected_scope == row["source_id"])):
                return public_context(row)
        # Source discovery may block; never hold the projection lock while it runs.
        with self.lock:
            pending = self._pending_windows.get(key)
        current = (pending["latest"] if pending is not None and pending["binding"] == binding and
                   pending["latest"] is not None else self.highwater(account, user, binding))
        with self.lock, self.source.lock:
            self._check_open(account, cancel, fingerprint, binding, fresh=True)
            if self._closed or account in self._paused or (cancel is not None and cancel.is_set()):
                raise AdvisorError("stopping", "已停止")
            row = database.context(user)
            worker = self._imports.get(key)
            if worker is not None and worker.thread.is_alive():
                if worker.binding != binding:
                    worker.cancel.set()
                    raise AccountChangedError()
                return public_context(row)
            previous = _decode_position(row["highwater"]) if row else None
            reset = bool(row and (row["source_id"] != fingerprint or
                                 (previous is not None and (current is None or current < previous))))
            if reset:
                row = database.context_begin(user, _encode_position(current), fingerprint, reset=True)
            if row is None:
                row = database.context_begin(user, _encode_position(current), fingerprint)
                if current is None:
                    row = database.context_finish(user, 0)
                    return public_context(row)
                self._start_worker(account, user, binding)
                return public_context(database.context(user))
            if row["state"] == "error":
                row = database.context_begin(user, _encode_position(current), fingerprint)
                self._start_worker(account, user, binding)
                return public_context(database.context(user))
            if row["state"] == "ready":
                if _encode_position(current) != row["highwater"]:
                    row = database.context_begin(user, _encode_position(current), fingerprint)
                    self._start_worker(account, user, binding)
                return public_context(database.context(user))
            # reading: resume a worker that did not survive a restart
            if not running:
                self._start_worker(account, user, binding)
            return public_context(database.context(user))

    def wait_ready(self, account, user, cancel, check, expected_scope=None, expected_epoch=None):
        while True:
            check()
            with self.lock:
                if self._closed or account in self._paused or cancel.is_set():
                    raise AdvisorError("stopping", "已停止")
                database = self.stores.account(account)
                row = database.context(user)
                if row is not None and ((expected_scope is not None and row["source_id"] != expected_scope) or
                                        (expected_epoch is not None and row["epoch"] != expected_epoch)):
                    raise AdvisorError("stopping", "聊天数据来源已经变化")
                if row is not None and row["state"] == "ready":
                    result = public_context(row)
                    result["sourceFingerprint"] = row["source_id"]
                    result["epoch"] = row["epoch"]
                    return result
                if row is not None and row["state"] == "error":
                    raise AdvisorError("context-error", "聊天记录读取失败，请重试")
                self.condition.wait(timeout=0.1)

    def snapshot(self, account, user):
        database = self.stores.account(account)
        return public_context(database.context(user))

    def messages(self, account, user, upto_seq=None):
        database = self.stores.account(account)
        return database.context_messages(user, upto_seq)

    def cancel_account(self, account):
        """Signal and join every import writer for one account; True when drained."""
        with self.lock:
            self._paused.add(account)
            for key in [key for key in self._observed if key[0] == account]:
                self._observed.pop(key, None)
            for key in [key for key in self._pending_windows if key[0] == account]:
                self._pending_windows.pop(key, None)
            entries = [entry for (owner, _user), entry in self._imports.items() if owner == account]
        for entry in entries:
            entry.cancel.set()
        with self.condition:
            self.condition.notify_all()
        deadline = time.monotonic() + 200
        drained = True
        for entry in entries:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                drained = False
                break
            entry.thread.join(remaining)
            if entry.thread.is_alive():
                drained = False
        return drained

    def resume_account(self, account):
        with self.lock:
            if not self._closed:
                self._paused.discard(account)

    def close(self):
        with self.lock:
            self._closed = True
            entries = list(self._imports.values())
        for entry in entries:
            entry.cancel.set()
        with self.condition:
            self.condition.notify_all()
        deadline = time.monotonic() + 200
        for entry in entries:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            entry.thread.join(remaining)
        if any(entry.thread.is_alive() for entry in entries):
            raise RuntimeError("advisor context import did not finish")
        with self.lock:
            self._imports.clear()
            self._summary_locks.clear()
            self._observed.clear()
            self._pending_windows.clear()

    # -- import worker -------------------------------------------------------
    def _start_worker(self, account, user, binding):
        key = (account, user)
        worker = self._imports.get(key)
        if worker is not None and worker.thread.is_alive():
            return worker
        cancel = threading.Event()
        thread = threading.Thread(target=self._import_worker, args=(account, user, cancel, binding),
                                  name="advisor-context-import", daemon=True)
        entry = _Import(cancel, thread, binding)
        self._imports[key] = entry
        thread.start()
        return entry

    def _import_worker(self, account, user, cancel, binding):
        key = (account, user)
        database = self.stores.account(account)
        try:
            while not cancel.is_set():
                row = database.context(user)
                if row is None or row["state"] != "reading":
                    return
                highwater = _decode_position(row["highwater"])
                expected = row["source_id"]
                if highwater is None:
                    with self.lock, self.source.lock:
                        self._check_open(account, cancel, expected, binding, fresh=True)
                        database.context_finish(user, row["read_count"])
                    return
                after = _decode_position(row["cursor"]) or _decode_position(row["last_sort"])
                self._check_open(account, cancel, expected, binding)
                try:
                    with self.source.binding_scope(binding):
                        page, next_after = self.source.history_page(
                            user, highwater, after, page_size=IMPORT_PAGE_SIZE)
                finally:
                    self._check_identity(account, expected, binding)
                if cancel.is_set():
                    return
                if page:
                    rows = self._page_rows(user, page, row["read_count"])
                    last_sort = rows[-1]["sort_key"] if rows else row["last_sort"]
                else:
                    rows, last_sort = [], row["last_sort"]
                if next_after is not None and after is not None and tuple(next_after) <= tuple(after):
                    raise AdvisorError("context-error", "历史读取游标未推进")
                with self.lock:
                    source_lock = getattr(self.source, "lock", None)
                    with source_lock if source_lock is not None else nullcontext():
                        self._check_open(account, cancel, expected, binding, fresh=True)
                        database.context_append_page(user, rows, _encode_position(next_after),
                                                     last_sort)
                        if next_after is None:
                            current = database.context(user)
                            database.context_finish(user, current["read_count"])
                            return
                        self.condition.notify_all()
        except AccountChangedError:
            if not cancel.is_set():
                database.context_error(user, "当前微信账号或数据来源已变化，读取已停止")
        except (AccountUnavailableError, MessagesUnavailableError):
            if not cancel.is_set():
                database.context_error(user, "当前微信记录暂不可用")
        except Exception as exc:  # noqa: BLE001 - the state must become visible, never silent
            if not cancel.is_set():
                database.context_error(user, _friendly_error(exc))
        finally:
            with self.lock:
                entry = self._imports.get(key)
                if entry is not None and entry.thread is threading.current_thread():
                    del self._imports[key]
                pending = self._pending_windows.get(key)
                current = database.context(user)
                if (pending is not None and not cancel.is_set() and not self._closed and account not in self._paused and
                        current is not None and current["state"] == "ready" and
                        current["source_id"] == pending["fingerprint"]):
                    try:
                        with self.source.lock:
                            self._apply_window_locked(account, user, pending, after_import=True)
                    except (AccountChangedError, AccountUnavailableError, MessagesUnavailableError):
                        self._pending_windows.pop(key, None)
                self.condition.notify_all()

    def _page_rows(self, user, page, read_count, trusted_identity=None):
        group_chat = user.endswith("@chatroom")
        rows = []
        scope = trusted_identity or self._identity()
        for index, message in enumerate(page):
            if not isinstance(message, dict):
                raise AdvisorError("context-error", "历史消息结构无效")
            sort = message.get("_sort")
            cursor = message.get("historyCursor")
            try:
                cursor_sort = decode_cursor(cursor, scope[0], user) if cursor is not None else None
            except ValueError as exc:
                raise AdvisorError("context-error", "历史消息游标不属于当前会话") from exc
            if sort is None and cursor_sort is not None:
                sort = list(cursor_sort)
            if (not isinstance(sort, (list, tuple)) or len(sort) != 3 or
                    type(sort[0]) is not int or not 0 <= sort[0] <= 2**63 - 1 or
                    not isinstance(sort[1], str) or type(sort[2]) is not int or not 0 <= sort[2] <= 2**63 - 1 or
                    not isinstance(message.get("id"), str) or not message.get("id") or
                    (cursor_sort is not None and tuple(sort) != cursor_sort)):
                raise AdvisorError("context-error", "历史消息身份无效")
            sort = list(sort)
            text = message.get("text")
            if not isinstance(text, str):
                raise AdvisorError("context-error", "历史文本结构无效")
            unified = message_input.prepare_item(message, account_id=scope[0], conversation_id=user,
                                                 source_kind="wechat")
            side = message["side"]
            sender_id = unified["inputMeta"].get("senderId") or ""
            sender_name = unified["inputMeta"].get("senderName") or ""
            kind = _bounded(message.get("kind"), 16)
            time_ms = unified["inputMeta"].get("sentAtMs")
            raw = {
                "_sort": sort,
                "historyCursor": _bounded(message.get("historyCursor"), MAX_RAW_FIELD_CHARS),
                "type": _bounded(message.get("type"), 64),
                "inputMeta": unified["inputMeta"],
            }
            rows.append({
                "seq": read_count + index + 1,
                "msg_id": message["id"],
                "sort_key": json.dumps(sort, ensure_ascii=False, separators=(",", ":")),
                "group_chat": 1 if group_chat else 0,
                "side": side,
                "sender_id": sender_id,
                "sender_name": sender_name,
                "kind": kind,
                "text": text,
                "time_ms": time_ms,
                "raw": json.dumps(raw, ensure_ascii=False, separators=(",", ":")),
            })
        return rows

    # -- model input assembly ------------------------------------------------
    def build_model_context(self, account, user, upto_seq, budget_chars, compactor, model_fp,
                            check=None, compact_budget=None, cancel=None, commit_guard=None, binding=None):
        """Assemble the model's WeChat context, compacting only when it cannot fit."""
        binding = binding or self.capture_binding(account)
        original_check, original_guard = check, commit_guard

        def check():
            self._check_open(account, cancel, binding=binding)
            if original_check:
                original_check()

        @contextmanager
        def commit_guard():
            with original_guard() if original_guard is not None else nullcontext():
                with self.lock, self.source.lock:
                    self.source.assert_binding(binding)
                    check()
                    yield

        database = self.stores.account(account)
        segments = []
        if check:
            check()
        context = database.context(user)
        if context is not None and context["source_id"] != self.source.binding_fingerprint(binding):
            raise AccountChangedError()
        if budget_chars <= 64:
            if database.context_messages(user, upto_seq):
                raise AdvisorError("context-too-long", "模型窗口没有足够空间容纳聊天资料")
            return ""
        limit = max(64, min(COMPACT_CHUNK_CHARS, compact_budget or budget_chars)) - 1
        for row in database.context_messages(user, upto_seq):
            text = _format_line(row)
            for offset in range(0, len(text), limit):
                piece = text[offset:offset + limit]
                digest = hashlib.sha256(piece.encode("utf-8")).hexdigest()
                key = "r%d:%d:%d:%s" % (row["seq"], offset, offset + len(piece), digest)
                segments.append({"key": key, "text": piece, "chars": len(piece) + 1,
                                 "level": 0, "coverage": [key]})
        if not segments:
            return ""
        return self._fit(segments, budget_chars, database, user, compactor, model_fp,
                         check=check, compact_budget=limit, cancel=cancel, commit_guard=commit_guard)

    def _fit(self, segments, budget_chars, database, user, compactor, model_fp,
             check=None, compact_budget=None, cancel=None, commit_guard=None):
        def total(items):
            return sum(item["chars"] for item in items)

        if len(_render([], segments)) <= budget_chars:
            return _render([], segments)
        share = max(1, budget_chars * RECENT_CONTEXT_PERCENT // 100)
        recent = []
        older = list(segments)
        consumed = 0
        while older:
            candidate = older[-1]
            if consumed + candidate["chars"] > share:
                break
            older.pop()
            recent.insert(0, candidate)
            consumed += candidate["chars"]
        expected = [part for item in segments for part in item["coverage"]]
        target = max(32, min(MAX_SUMMARY_CHARS, budget_chars // 4))
        for _round in range(MAX_COMPRESSION_LEVELS):
            if check:
                check()
            actual = [part for item in older + recent for part in item["coverage"]]
            if actual != expected:
                raise AdvisorError("compression-failed", "聊天摘要覆盖范围不完整")
            if len(_render(older, recent)) <= budget_chars:
                return _render(older, recent)
            if not older:
                break
            chunks = _chunk(older, compact_budget or COMPACT_CHUNK_CHARS)
            level = max(item["level"] for item in older) + 1
            summarized = []
            for chunk in chunks:
                text = "\n".join(item["text"] for item in chunk)
                coverage = [part for item in chunk for part in item["coverage"]]
                digest = hashlib.sha256(json.dumps([coverage, text, target], ensure_ascii=False).encode("utf-8")).hexdigest()
                key = compress_key(user, level, digest, digest)
                summary = self._summarize(database, user, key, level, text, compactor,
                                          model_fp, coverage, target, check, cancel, commit_guard)
                summarized.append({"key": "s:" + key, "text": "[摘要] " + summary,
                                   "chars": len(summary) + 6, "level": level, "coverage": coverage})
            if total(summarized) >= total(older):
                raise AdvisorError("compression-failed", "模型摘要未缩短聊天资料，请重试或增加模型上下文")
            older = summarized
        if len(_render(older, recent)) > budget_chars:
            raise AdvisorError("context-too-long", "聊天记录过长，无法压缩到模型窗口内")
        return _render(older, recent)

    def _summarize(self, database, user, key, level, text, compactor, model_fp,
                   coverage, target, check=None, cancel=None, commit_guard=None):
        cached = database.summary(user, key, COMPRESSION_VERSION, model_fp, level)
        if cached:
            return cached
        lock = self._summary_lock(database.account, user, key, level, model_fp)
        while not lock.acquire(timeout=0.05):
            if check:
                check()
        try:
            if check:
                check()
            cached = database.summary(user, key, COMPRESSION_VERSION, model_fp, level)
            if cached:
                return cached
            summary = compactor(text, key, level)
            if not isinstance(summary, str) or not summary.strip():
                raise AdvisorError("compression-failed", "模型未返回摘要内容")
            summary = summary.strip()
            if len(summary) > target:
                raise AdvisorError("compression-failed", "模型摘要过长，请重试或增加模型上下文")
            if check:
                check()
            if commit_guard is not None:
                with commit_guard():
                    with self.lock:
                        if self._closed or database.account in self._paused or (cancel is not None and cancel.is_set()):
                            raise AdvisorError("stopping", "已停止")
                        database.save_summary(user, key, COMPRESSION_VERSION, model_fp, level, summary, coverage)
            else:
                with self.lock:
                    source_lock = getattr(self.source, "lock", None)
                    with source_lock if source_lock is not None else nullcontext():
                        self._check_open(database.account, cancel, database.context(user)["source_id"])
                        database.save_summary(user, key, COMPRESSION_VERSION, model_fp, level, summary, coverage)
            return summary
        finally:
            lock.release()

    def _summary_lock(self, account, user, key, level, model_fp):
        with self.lock:
            identity = (account, user, key, level, model_fp)
            lock = self._summary_locks.get(identity)
            if lock is None:
                lock = threading.Lock()
                self._summary_locks[identity] = lock
            return lock


def _bounded(value, maximum):
    if not isinstance(value, str):
        return ""
    return value[:maximum]


def _format_line(row):
    when = ""
    if isinstance(row.get("time_ms"), (int, float)) and row["time_ms"]:
        try:
            when = time.strftime("%Y-%m-%d %H:%M", time.localtime(row["time_ms"] / 1000))
        except (OverflowError, OSError, ValueError):
            pass
    if row.get("side") == "self":
        speaker = "我"
    else:
        speaker = row.get("sender_name") or row.get("sender_id") or "对方"
        if row.get("group_chat") and row.get("sender_id"):
            speaker = speaker + " <" + row["sender_id"] + ">"
    text = (row.get("text") or "").replace("\r\n", "\n")
    quote = json.loads(row.get("raw") or "{}").get("inputMeta", {}).get("quote")
    if quote is not None:
        text += "\n[引用] " + json.dumps(quote, ensure_ascii=False, separators=(",", ":"))
    return "[%s] %s: %s" % (when or "时间未知", speaker, text)


def _chunk(segments, limit):
    chunks = []
    current = []
    size = 0
    for segment in segments:
        if current and size + segment["chars"] > limit:
            chunks.append(current)
            current, size = [], 0
        current.append(segment)
        size += segment["chars"]
    if current:
        chunks.append(current)
    return chunks


def _render(older, recent):
    parts = []
    if older:
        parts.append("[较早聊天记录摘要]")
        parts.extend(item["text"] for item in older)
    if recent:
        parts.append("[最近聊天记录]")
        parts.extend(item["text"] for item in recent)
    return "\n".join(parts)
