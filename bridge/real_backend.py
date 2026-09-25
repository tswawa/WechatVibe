"""Read-only WeChat adapter, local inference queue, and account-scoped result cache."""
from __future__ import annotations

import hashlib
import heapq
import itertools
import json
import math
import os
import queue
import re
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from collections import OrderedDict, deque
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit
from xml.etree import ElementTree

from profile_signals import historical_mood, keywords_from_texts, style_traits, summary_from_signals, validate_style_evidence
from profile_signals import keyword_counts, keywords_from_counts, summary_from_aggregate
from profile_state import empty_state as empty_profile_state, add_result as add_profile_result, traits_from_state
from history_browser import browse as browse_history, encode_cursor, saved_results as saved_history_results, search as search_history

ROOT = Path(__file__).resolve().parents[1]
MOODS = {"happy": "(＾▽＾)", "affectionate": "(❤´艸｀❤)", "neutral": "(￣▽￣)",
         "amused": "(≧▽≦)", "sad": "(╥﹏╥)", "anxious": "(；´д｀)", "angry": "(｀皿´)"}
AXES = {"EI": ("E", "I"), "SN": ("S", "N"), "TF": ("T", "F"), "JP": ("J", "P")}
MIN_PERSONALITY_MESSAGES = 100
MIN_AXIS_EVIDENCE = 30
MIN_AXIS_MARGIN = .2
MBTI_SOURCES = [
    "https://www.myersbriggs.org/my-mbti-personality-type/the-mbti-preferences/",
    "https://www.themyersbriggs.com/en-US/Products-and-Services/Myers-Briggs",
]
SYSTEM_NAMES = {"filehelper": "文件传输助手", "newsapp": "腾讯新闻", "brandsessionholder": "公众号消息"}
MAX_ISSUED_IMAGES = 2048
MAX_IMAGE_BYTES = 8 * 1024 * 1024
FORECAST_CACHE_LIMIT = 64
FORECAST_SOURCE_WINDOW = 16
PROFILE_METADATA_CACHE_LIMIT = 64
FINE_LABEL_SCHEMA = "generic-v5"
GROUNDED_INTENT_EVIDENCE = {
    "greet": {"greeting_phrase"}, "thank": {"thanks_phrase"},
    "confirm": {"short_acknowledgement"}, "inspect": {"first_person_inspection"},
    "agree": {"explicit_acceptance"}, "reject": {"explicit_refusal"},
    "invite": {"inclusive_invitation"}, "ask_question": {"answer_seeking_question"},
    "seek_help": {"action_request"},
    "suggest_action": {"advice_marker", "negative_imperative", "imperative_adjustment", "delegated_action"},
    "plan": {"first_person_intention"}, "correct": {"explicit_correction"},
    "explain": {"causal_explanation", "process_explanation"}, "complain": {"negative_evaluation"},
    "status_report": {"progress_statement"}, "share_news": {"sharing_announcement"},
}
QUOTED_REPLY_TYPE = (57 << 32) | 49
SESSION_PREVIEWS = {3: "[图片]", 34: "[语音]", 43: "[视频]", 47: "[表情]",
                    48: "[位置]", 49: "[文件/链接/卡片]", 11000: "[表情]"}


class ForecastRequestError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


class AccountUnavailableError(RuntimeError):
    """The unique live WeChat account or its cache-only database is not ready."""

    def __init__(self):
        super().__init__("当前微信账号未就绪")


class AccountChangedError(RuntimeError):
    """A request or queued analysis outlived the account that supplied its input."""

    def __init__(self):
        super().__init__("当前微信账号已变化")


def active_account_dir():
    """Resolve a unique live account from WeChat's open-file metadata, never DB mtimes."""
    native_reader = str(ROOT / "native-reader")
    if native_reader not in sys.path:
        sys.path.insert(0, native_reader)
    from wr import discovery

    accounts = discovery.discover_account_dirs()
    roots = [(account, os.path.normcase(os.path.realpath(account.path))) for account in accounts]
    matches = set()
    for process in discovery.find_weixin_processes():
        for path in discovery.process_open_file_paths(process.pid):
            opened = os.path.normcase(os.path.realpath(path))
            for account, root in roots:
                if opened == root or opened.startswith(root + os.sep):
                    matches.add(account.id)
    match = next((account for account in accounts if account.id in matches), None)
    return Path(match.path).parent.resolve() if len(matches) == 1 and match else None


def positive_timestamp(value):
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return (number * 1000 if number < 10_000_000_000 else number) if number > 0 else None


def session_preview(summary, message_type, sub_type=None):
    if isinstance(message_type, int):
        kind = message_type & 0xFFFFFFFF if message_type > 0xFFFF else message_type
        if kind == 49 and sub_type in (5, 6):
            return "[链接]" if sub_type == 5 else "[文件]"
        if kind in SESSION_PREVIEWS:
            return SESSION_PREVIEWS[kind]
    content = summary.strip() if isinstance(summary, str) else ""
    return "[消息]" if content.startswith("<") else content


def avatar_candidates(*urls):
    candidates = []
    for url in urls:
        if not isinstance(url, str) or not url or url != url.strip():
            continue
        try:
            parsed = urlsplit(url)
        except ValueError:
            continue
        if (parsed.scheme.lower() in ("http", "https") and parsed.hostname and
                not parsed.username and not parsed.password and url not in candidates):
            candidates.append(url)
    return candidates


def contact_display(contacts, user):
    contact = contacts.get(user)
    if contact:
        return {**contact, "name": SYSTEM_NAMES.get(user, user) if contact["name"] == user else contact["name"]}
    return {"name": SYSTEM_NAMES.get(user, user), "avatar": "", "avatarCandidates": []}


def validate_personality_evidence(evidence):
    if evidence is None:
        return None
    if not isinstance(evidence, dict) or set(evidence) != set(AXES):
        raise RuntimeError("invalid personality evidence axes")
    for axis, (left, right) in AXES.items():
        distribution = evidence[axis]
        if not isinstance(distribution, dict) or set(distribution) != {left, right, "insufficient"}:
            raise RuntimeError("invalid personality evidence distribution")
        probabilities = list(distribution.values())
        if any(isinstance(value, bool) or not isinstance(value, (int, float)) or
               not math.isfinite(value) or not 0 <= value <= 1 for value in probabilities) or sum(probabilities) <= 0:
            raise RuntimeError("invalid personality evidence probability")
    return evidence


def infer_mbti(results, version):
    axes = {}
    supported_messages = 0
    axis_totals = {axis: [0.0, 0.0, 0, 0] for axis in AXES}
    for result in results:
        evidence = result.get("personalityEvidence")
        supported = False
        for axis, (left, right) in AXES.items():
            totals = axis_totals[axis]
            distribution = evidence[axis] if evidence else None
            if distribution is None or distribution["insufficient"] >= max(distribution[left], distribution[right]):
                totals[3] += 1
                continue
            totals[0] += distribution[left]
            totals[1] += distribution[right]
            totals[2] += 1
            supported = True
        if supported:
            supported_messages += 1

    return mbti_from_totals(len(results), supported_messages, axis_totals, version)


def mbti_from_totals(eligible, supported_messages, axis_totals, version):
    axes = {}
    preferences = []
    for axis, (left, right) in AXES.items():
        left_total, right_total, evidence_count, insufficient_count = axis_totals[axis]
        mass = left_total + right_total
        left_share = left_total / mass if evidence_count >= MIN_AXIS_EVIDENCE and mass > 0 else None
        right_share = right_total / mass if left_share is not None else None
        axes[axis] = {"left": left, "right": right, "leftShare": left_share,
                      "rightShare": right_share, "evidenceCount": evidence_count,
                      "insufficientCount": insufficient_count}
        if left_share is None or abs(left_share - right_share) < MIN_AXIS_MARGIN:
            preferences.append(None)
        else:
            preferences.append(left if left_share > right_share else right)

    inferred_type = "".join(preferences) if eligible >= MIN_PERSONALITY_MESSAGES and all(preferences) else None
    return {"basis": "chat-inference", "theory": "MBTI preferences", "version": version,
            "eligibleMessages": eligible, "supportedMessages": supported_messages,
            "minMessages": MIN_PERSONALITY_MESSAGES, "axes": axes, "sources": MBTI_SOURCES,
            "type": inferred_type,
            "status": "estimated" if inferred_type else "insufficient" if eligible < MIN_PERSONALITY_MESSAGES else "partial"}


def affinity(scores):
    """The linear-recency aggregate in electron/native/aggregate.ts, oldest first."""
    count = len(scores)
    if not count:
        return None
    if count == 1:
        weighted = scores[0]
    else:
        weighted = (.5 * sum(scores) + .5 * sum(index * score for index, score in enumerate(scores)) / (count - 1)) / (.75 * count)
    return int(50 + 50 * max(-1, min(1, weighted)) + .5)


def affinity_from_progress(progress):
    count = progress["scoreCount"]
    if not count:
        return None
    weighted = (progress["scoreSum"] if count == 1 else
                (.5 * progress["scoreSum"] + .5 * progress["scoreWeighted"] / (count - 1)) /
                (.75 * count))
    return int(50 + 50 * max(-1, min(1, weighted)) + .5)


def mood_from_progress(progress):
    count = progress["moodCount"]
    if not count:
        return None
    totals = {raw: (values["sum"] if count == 1 else
                    .5 * values["sum"] + .5 * values["weighted"] / (count - 1))
              for raw, values in progress["mood"].items()}
    dominant = max(totals, key=totals.get)
    return {"label": progress["mood"][dominant]["label"], "rawLabel": dominant,
            "kaomoji": MOODS.get(dominant), "sampleCount": count,
            "scope": "analyzed-history"}


def scope_rank(limit):
    return math.inf if limit == "all" else limit


def message_id(account, user, shard, row):
    identity = json.dumps([account, user, shard, row["local_id"], row["sort_seq"],
                           row["server_id"]], ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


class WeChatSource:
    def __init__(self, factory=None, classifier=None, media_factory=None, active_account_locator=None):
        self.factory = factory
        self.classifier = classifier
        self.media_factory = media_factory
        # Injected legacy factories remain fixed for synthetic tests. Production always resolves
        # the unique live account before accessing a cached reader.
        self.live_account = factory is None and active_account_locator is None
        self.dynamic_account = factory is None or active_account_locator is not None
        if self.live_account:
            from live_source import active_account_snapshot
            self.active_account_locator = active_account_snapshot
        else:
            self.active_account_locator = active_account_locator or active_account_dir
        self.lock = threading.RLock()
        self.closed = False
        self.db = None
        self._account_dir = None
        self._active_checked_at = 0.0
        self._self_username = None
        self.issued_images = OrderedDict()
        self.window_images = {}
        self.profile_metadata_cache = OrderedDict()
        self.media_reason = threading.local()

    def _release_db(self):
        self.db = None
        self._account_dir = None
        self._active_checked_at = 0.0
        self._self_username = None
        self.issued_images.clear()
        self.window_images.clear()
        self.profile_metadata_cache.clear()

    def forget_account(self, account):
        """Drop only this account's open reader and volatile key references."""
        with self.lock:
            if self.db is not None and str(self.db.account) == account:
                for name in ("_keys", "_volatile_keys"):
                    value = getattr(self.db, name, None)
                    if isinstance(value, dict):
                        value.clear()
                if hasattr(self.db, "master_key"):
                    self.db.master_key = None
                self._release_db()
            forget = getattr(self.factory, "forget_account", None)
            if callable(forget):
                forget(account)

    def close(self):
        """Stop this bridge instance from reopening any WeChat-derived snapshot."""
        with self.lock:
            self.closed = True
            if self.db is not None:
                self.forget_account(str(self.db.account))
            self._release_db()

    def _db(self, fresh=False):
        with self.lock:
            if self.closed:
                raise AccountUnavailableError()
            if not self.dynamic_account and self.db is not None:
                return self.db
            if self.dynamic_account:
                if self.db is not None and not fresh and time.monotonic() - self._active_checked_at < 0.5:
                    return self.db
                try:
                    selection = self.active_account_locator()
                    location = (selection.account_dir if self.live_account and selection is not None
                                else Path(selection).resolve() if selection is not None else None)
                except Exception as exc:
                    self._release_db()
                    raise AccountUnavailableError() from exc
                if location is None or not (location / "db_storage").is_dir():
                    self._release_db()
                    raise AccountUnavailableError()
                if self.db is not None and self._account_dir != location:
                    self._release_db()
                if self.db is not None:
                    self._active_checked_at = time.monotonic()
                    return self.db
            if self.factory is None:
                if self.live_account:
                    from live_source import LiveWeChatFactory
                    self.factory = LiveWeChatFactory()
                else:
                    from cache_source import CacheOnlyWeChatDB
                    self.factory = CacheOnlyWeChatDB
            try:
                if self.live_account:
                    db = self.factory(db_dir=str(location.parent), account=location.name,
                                      selection=selection)
                elif self.dynamic_account:
                    db = self.factory(db_dir=str(location.parent), account=location.name)
                else:
                    db = self.factory()
                if self.dynamic_account and (str(db.account) != location.name or
                                             Path(db.account_dir).resolve() != location):
                    raise AccountUnavailableError()
                if self.live_account and self.active_account_locator() != selection:
                    raise AccountUnavailableError()
            except Exception as exc:
                self._release_db()
                if self.dynamic_account:
                    raise AccountUnavailableError() from exc
                raise
            self.db = db
            self._account_dir = location if self.dynamic_account else None
            self._active_checked_at = time.monotonic()
            return db

    def identity(self):
        with self.lock:
            db = self._db(fresh=True)
            account = str(db.account)
            if not account or not getattr(db, "workdir", None):
                raise RuntimeError("WeChat account/workdir unavailable")
            workdir = Path(db.workdir).resolve()
            return account, workdir

    def self_user(self, db=None):
        with self.lock:
            standalone = db is None
            db = self._db(fresh=True) if standalone else db
            if self._self_username is None:
                self._self_username = db.get_self_info().get("username") or db.wxid
            if standalone and self._db(fresh=True) is not db:
                raise AccountChangedError()
            return self._self_username

    def _contacts(self, db):
        for rel, path, _ in db._db_files:
            if Path(path).name != "contact.db":
                continue
            conn = db._open(rel)
            try:
                columns = {row[1] for row in conn.execute("PRAGMA table_info(contact)")}
                fields = [field if field in columns else "''" for field in
                          ("username", "nick_name", "remark", "small_head_url", "big_head_url")]
                rows = conn.execute("SELECT " + ",".join(fields) + " FROM contact")
                contacts = {}
                for user, nick, remark, small, big in rows:
                    if user:
                        candidates = avatar_candidates(small, big)
                        name = (remark if remark and remark != user else
                                nick if nick and nick != user else SYSTEM_NAMES.get(user, user))
                        contacts[str(user)] = {"name": name,
                                               "avatar": candidates[0] if candidates else "",
                                               "avatarCandidates": candidates}
                return contacts
            finally:
                conn.close()
        raise RuntimeError("contact.db unavailable")

    def sessions(self):
        with self.lock:
            db = self._db(fresh=True)
            contacts = self._contacts(db)
            self_user = self.self_user(db)
            self_contact = contact_display(contacts, self_user)
            items = []
            for rel, path, _ in db._db_files:
                if Path(path).name != "session.db":
                    continue
                conn = db._open(rel)
                try:
                    columns = {row[1] for row in conn.execute("PRAGMA table_info(SessionTable)")}
                    required = {"username", "unread_count", "summary", "last_timestamp", "last_msg_sender",
                                "last_sender_display_name", "sort_timestamp", "is_hidden"}
                    if not required <= columns:
                        raise RuntimeError("unsupported session table schema")
                    type_column = next((name for name in ("last_msg_type", "last_message_type") if name in columns), None)
                    subtype_column = "last_msg_sub_type" if "last_msg_sub_type" in columns else None
                    fields = ("username,unread_count,summary,last_timestamp,last_msg_sender,"
                              "last_sender_display_name,sort_timestamp," +
                              (type_column if type_column else "NULL") + "," +
                              (subtype_column if subtype_column else "NULL") + "," +
                              ("is_top" if "is_top" in columns else "NULL"))
                    rows = conn.execute("SELECT " + fields + " FROM SessionTable WHERE is_hidden=0 "
                                        "ORDER BY sort_timestamp DESC,rowid DESC")
                    while batch := rows.fetchmany(256):
                        for user, unread, summary, last_time, sender, sender_name, sort_time, message_type, sub_type, is_top in batch:
                            if not isinstance(user, str) or not user:
                                continue
                            contact = contact_display(contacts, user)
                            try:
                                unread_count = max(0, int(unread or 0))
                            except (TypeError, ValueError, OverflowError):
                                unread_count = 0
                            items.append({"username": user, **contact,
                                          "preview": session_preview(summary, message_type, sub_type),
                                          "time": positive_timestamp(last_time),
                                          "sortTimestamp": int(sort_time) if isinstance(sort_time, (int, float)) and sort_time > 0 else None,
                                          "unreadCount": unread_count, "lastMsgType": message_type,
                                          "lastMsgSubType": sub_type,
                                          "pinned": bool(is_top) if is_top in (0, 1) else None,
                                          "lastSender": sender_name or sender or "",
                                          "isGroup": user.endswith("@chatroom")})
                finally:
                    conn.close()
                break
            if self._db(fresh=True) is not db:
                raise AccountChangedError()
            return {"self": {"username": self_user, **self_contact}, "sessions": items, "account": str(db.account)}

    def _shard_rows(self, db, user, limit, offset=0):
        found = db._msg_conns(user)
        rows = []
        try:
            for conn, table in found:
                if not re.fullmatch(r"Msg_[0-9a-fA-F]{32}", table):
                    raise RuntimeError("invalid message table")
                source_path = conn.execute("PRAGMA database_list").fetchone()[2]
                shard = Path(source_path).name
                if not shard.startswith("message__message_") or not shard.endswith(".db"):
                    raise RuntimeError("unidentified message shard")
                sender_index = {int(row[0]): row[1] for row in conn.execute("SELECT rowid,user_name FROM Name2Id")}
                records = conn.execute(
                    f"SELECT local_id,local_type,real_sender_id,create_time,message_content,compress_content,server_id,sort_seq FROM {table} "
                    "ORDER BY sort_seq DESC,local_id DESC LIMIT ?", (limit + offset,))
                for record in records:
                    rows.append((record, shard, sender_index))
        finally:
            for conn in {id(conn): conn for conn, _ in found}.values():
                conn.close()
        rows.sort(key=lambda item: (int(item[0][7]), item[1], int(item[0][0])), reverse=True)
        return rows[offset:offset + limit]

    @staticmethod
    def _quoted_reply_title(content):
        if not isinstance(content, str):
            return None
        start = content.find("<msg")
        if start > 0:
            content = content[start:]
        try:
            root = ElementTree.fromstring(content.strip())
        except ElementTree.ParseError:
            return None
        appmsg = root if root.tag == "appmsg" else root.find("./appmsg")
        if appmsg is None or appmsg.find("./refermsg") is None:
            return None
        subtype = appmsg.find("./type")
        if subtype is not None and (subtype.text or "").strip() != "57":
            return None
        title = appmsg.find("./title")
        text = "".join(title.itertext()).strip() if title is not None else ""
        return text if text and text not in ("[应用消息]", "[消息]", "[图片]", "[表情]") else None

    @staticmethod
    def _decoded_content(db, local_type, content, compressed):
        kind_name = db._msg_type_name(local_type)
        if isinstance(content, bytes):
            content = db._friendly_content(content, kind_name)
        if not content or content == f"[{kind_name}]":
            if isinstance(compressed, bytes) and compressed:
                content = db._friendly_content(compressed, kind_name)
        return kind_name, content

    def _classified_content(self, db, local_type, content, compressed):
        kind_name, content = self._decoded_content(db, local_type, content, compressed)
        quote = self._quoted_reply_title(content) if local_type == QUOTED_REPLY_TYPE else None
        kind, text = ("text", quote) if quote is not None else self.classifier(
            kind_name, content or f"[{kind_name}]")
        return kind_name, kind, text

    def _analyzable_counts(self, db, conn, table, sender_ids=None):
        """Count exactly the rendered text that portrait scanning can consume."""
        where = "local_type IN (?,?)"
        args = [1, QUOTED_REPLY_TYPE]
        if sender_ids is not None:
            if not sender_ids:
                return {}
            where += " AND real_sender_id IN (" + ",".join("?" for _ in sender_ids) + ")"
            args.extend(sender_ids)
        counts = {}
        for sender_id, local_type, content, compressed in conn.execute(
                f"SELECT real_sender_id,local_type,message_content,compress_content FROM {table} WHERE {where}", args):
            _name, kind, text = self._classified_content(db, local_type, content, compressed)
            if kind == "text" and isinstance(text, str) and text.strip():
                counts[sender_id] = counts.get(sender_id, 0) + 1
        return counts

    def _render_row(self, db, user, item, contacts, own_user):
        record, shard, senders = item
        local_id, local_type, sender_id, created, content, compressed, server_id, seq = record
        kind_name, kind, text = self._classified_content(db, local_type, content, compressed)
        if kind == "system":
            return None
        sender = senders.get(int(sender_id or 0), "")
        if not sender and not user.endswith("@chatroom"):
            sender = user
        contact = contact_display(contacts, sender)
        timestamp = int(created or 0)
        return {"id": message_id(str(db.account), user, shard,
                                 {"local_id": local_id, "sort_seq": seq, "server_id": server_id}),
                "historyCursor": encode_cursor(str(db.account), user, (int(seq), shard, int(local_id))),
                "side": "self" if sender and sender == own_user else "other", "text": text,
                "kind": "text" if kind == "text" else "image" if kind == "image" else "other",
                "time": timestamp * 1000 if timestamp < 10_000_000_000 else timestamp,
                "type": kind_name, "senderId": sender, "senderName": contact["name"],
                "senderAvatar": contact["avatar"], "senderAvatarCandidates": contact["avatarCandidates"],
                "_sort": [int(seq), shard, int(local_id)]}

    def messages(self, user, limit, offset=0):
        with self.lock:
            db = self._db()
            contacts = self._contacts(db)
            own_user = self.self_user(db)
            result = []
            for item in reversed(self._shard_rows(db, user, limit, offset)):
                message = self._render_row(db, user, item, contacts, own_user)
                if message:
                    result.append(message)
                    if message["kind"] == "image" and item[0][1] == 3:
                        key = (str(db.account), user, message["id"])
                        self.issued_images[key] = tuple(message["_sort"]) + (item[0][6],)
                        self.issued_images.move_to_end(key)
                        if len(self.issued_images) > MAX_ISSUED_IMAGES:
                            self.issued_images.popitem(last=False)
            if self._db(fresh=True) is not db:
                raise AccountChangedError()
            return result

    def message_windows(self, users, limit=80, expected_account=None):
        """Prepare first screens together, opening each existing snapshot shard once.

        This reads a bounded latest window per conversation, never its full history and
        never invokes inference. Account verification brackets the complete batch.
        """
        with self.lock:
            db = self._db(fresh=expected_account is not None)
            if expected_account is not None and str(db.account) != expected_account:
                raise AccountChangedError()
            contacts = self._contacts(db)
            own_user = self.self_user(db)
            tables = {user: "Msg_" + hashlib.md5(user.encode("utf-8")).hexdigest() for user in users}
            rows = {user: [] for user in users}
            for rel in db._message_dbs():
                conn = db._open(rel)
                try:
                    shard = Path(conn.execute("PRAGMA database_list").fetchone()[2]).name
                    if not re.fullmatch(r"message__message_\d+\.db", shard):
                        raise RuntimeError("unidentified message shard")
                    available = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                    found = [(user, table) for user, table in tables.items() if table in available]
                    if not found:
                        continue
                    senders = {int(row[0]): row[1] for row in conn.execute("SELECT rowid,user_name FROM Name2Id")}
                    for user, table in found:
                        records = conn.execute(
                            f"SELECT local_id,local_type,real_sender_id,create_time,message_content,"
                            f"compress_content,server_id,sort_seq FROM {table} "
                            "ORDER BY sort_seq DESC,local_id DESC LIMIT ?", (limit,))
                        rows[user].extend((record, shard, senders) for record in records)
                finally:
                    conn.close()
            windows, images = {}, {}
            for user, records in rows.items():
                records.sort(key=lambda item: (int(item[0][7]), item[1], int(item[0][0])), reverse=True)
                windows[user], images[user] = [], {}
                for item in reversed(records[:limit]):
                    message = self._render_row(db, user, item, contacts, own_user)
                    if message:
                        windows[user].append(message)
                        if message["kind"] == "image" and item[0][1] == 3:
                            images[user][message["id"]] = tuple(message["_sort"]) + (item[0][6],)
            if self._db(fresh=True) is not db:
                raise AccountChangedError()
            # Each prepared conversation retains only the image capabilities belonging to
            # its current window, so preloading later chats cannot evict earlier images.
            for user in users:
                self.window_images[(str(db.account), user)] = images[user]
            return windows

    def texts_for_refs(self, user, refs, with_ids=False):
        """Read only analyzed message rows by their stored shard and local primary key."""
        if not refs:
            return []
        with self.lock:
            db = self._db(fresh=True)
            by_shard = {}
            for shard, local_id, stable_id in refs:
                by_shard.setdefault(shard, {}).setdefault(int(local_id), set()).add(stable_id)
            table = "Msg_" + hashlib.md5(user.encode("utf-8")).hexdigest()
            texts = []
            for rel, _path, _size in db._db_files:
                shard = rel.replace(os.sep, "__")
                selected = by_shard.get(shard)
                if not selected:
                    continue
                conn = db._open(rel)
                try:
                    exists = conn.execute(
                        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1", (table,)
                    ).fetchone()
                    if not exists:
                        continue
                    ids = list(selected)
                    for start in range(0, len(ids), 400):
                        batch = ids[start:start + 400]
                        placeholders = ",".join("?" for _ in batch)
                        rows = conn.execute(
                            f"SELECT local_id,local_type,message_content,compress_content,server_id,sort_seq "
                            f"FROM {table} WHERE local_id IN ({placeholders})", batch
                        )
                        for local_id, local_type, content, compressed, server_id, sort_seq in rows:
                            stable_id = message_id(str(db.account), user, shard,
                                                   {"local_id": local_id, "sort_seq": sort_seq,
                                                    "server_id": server_id})
                            if stable_id not in selected.get(int(local_id), ()):
                                continue
                            kind_name = db._msg_type_name(local_type)
                            if isinstance(content, bytes):
                                content = db._friendly_content(content, kind_name)
                            placeholder = f"[{kind_name}]"
                            if (not content or content == placeholder) and isinstance(compressed, bytes):
                                content = db._friendly_content(compressed, kind_name)
                            kind, text = self.classifier(kind_name, content or placeholder)
                            if kind == "text" and isinstance(text, str) and text.strip():
                                texts.append((stable_id, text) if with_ids else text)
                finally:
                    conn.close()
            if self._db(fresh=True) is not db:
                raise AccountChangedError()
            return texts

    def media(self, user, stable_id):
        self.media_reason.value = None
        def unavailable(reason):
            self.media_reason.value = reason
            return None
        if not isinstance(stable_id, str) or not re.fullmatch(r"[0-9a-f]{64}", stable_id):
            return unavailable("invalid-id")
        with self.lock:
            db = self._db(fresh=True)
            account = str(db.account)
            issued = (self.issued_images.get((account, user, stable_id)) or
                      self.window_images.get((account, user), {}).get(stable_id))
            if issued is None:
                return unavailable("not-issued")
            seq, shard, local_id, server_id = issued
            if stable_id != message_id(account, user, shard,
                                       {"local_id": local_id, "sort_seq": seq, "server_id": server_id}):
                return unavailable("identity-mismatch")
            found = db._msg_conns(user)
            row = None
            try:
                for conn, table in found:
                    if not re.fullmatch(r"Msg_[0-9a-fA-F]{32}", table):
                        continue
                    path = conn.execute("PRAGMA database_list").fetchone()[2]
                    if Path(path).name != shard:
                        continue
                    matches = conn.execute(
                        f"SELECT local_type,create_time,message_content,packed_info_data FROM {table} "
                        "WHERE local_id=? AND sort_seq=? AND server_id=? LIMIT 2",
                        (local_id, seq, server_id),
                    ).fetchall()
                    if len(matches) == 1 and matches[0][0] == 3:
                        _, created, content, packed = matches[0]
                        row = {"local_type": 3, "create_time": created,
                               "content": content, "packed_info": packed}
                    break
            finally:
                for conn in {id(conn): conn for conn, _ in found}.values():
                    conn.close()
        if row is None:
            return unavailable("row-unavailable")
        try:
            if self.media_factory is None:
                from wechatauto.media import MediaDownloader
                downloader = MediaDownloader(db)
            else:
                downloader = self.media_factory(db)
            md5 = downloader._img_md5(row)
            if not md5 or not re.fullmatch(r"[0-9a-f]{32}", md5):
                return unavailable("metadata-unavailable")
            dat_path = (downloader._find_dat(user, md5, row["create_time"]) or
                        downloader._find_dat(user, md5, row["create_time"], thumbnail=True))
            base = (Path(db.account_dir) / "msg" / "attach" /
                    hashlib.md5(user.encode("utf-8")).hexdigest()).resolve()
            if (not dat_path or Path(dat_path).name not in (md5 + ".dat", md5 + "_t.dat") or
                    not Path(dat_path).resolve().is_relative_to(base)):
                return unavailable("local-file-unavailable")
            if Path(dat_path).stat().st_size > MAX_IMAGE_BYTES:
                return unavailable("image-too-large")
            with open(dat_path, "rb") as file:
                magic = file.read(6)
            aes_key = xor_key = None
            if magic == b"\x07\x08\x56\x32\x08\x07":
                derived = downloader._derive_cfg_key()
                if derived:
                    aes_key, xor_key = derived
                else:
                    aes_key = downloader._load_persisted_key()
                    if not aes_key:
                        return unavailable("local-key-unavailable")
                    xor_key = downloader._derive_xor_key(dat_path)
            data = downloader.decrypt_image(dat_path, aes_key=aes_key, xor_key=xor_key)
        except (OSError, ValueError, RuntimeError):
            return unavailable("decode-failed")
        if not isinstance(data, bytes) or len(data) > MAX_IMAGE_BYTES:
            return unavailable("image-too-large")
        if data.startswith(b"\xff\xd8\xff"):
            mime = "image/jpeg"
        elif data.startswith(b"\x89PNG\r\n\x1a\n"):
            mime = "image/png"
        elif data.startswith((b"GIF87a", b"GIF89a")):
            mime = "image/gif"
        elif data.startswith(b"RIFF") and data[8:12] == b"WEBP":
            mime = "image/webp"
        else:
            return unavailable("unsupported-format")
        with self.lock:
            if self._db(fresh=True) is not db:
                raise AccountChangedError()
        return data, mime

    def history_highwater(self, user):
        with self.lock:
            newest = self._shard_rows(self._db(), user, 1)
            if not newest:
                return None
            record, shard, _ = newest[0]
            return int(record[7]), shard, int(record[0])

    def history_page(self, user, highwater, after=None, page_size=256):
        if highwater is None:
            return [], None
        with self.lock:
            db = self._db()
            contacts = self._contacts(db)
            own_user = self.self_user()
            found = db._msg_conns(user)
            rows = []
            try:
                for conn, table in found:
                    if not re.fullmatch(r"Msg_[0-9a-fA-F]{32}", table):
                        raise RuntimeError("invalid message table")
                    shard = Path(conn.execute("PRAGMA database_list").fetchone()[2]).name
                    if not re.fullmatch(r"message__message_\d+\.db", shard):
                        raise RuntimeError("unidentified message shard")
                    clauses, params = [], []
                    high_seq, high_shard, high_local = highwater
                    if shard == high_shard:
                        clauses.append("(sort_seq < ? OR (sort_seq = ? AND local_id <= ?))")
                        params.extend((high_seq, high_seq, high_local))
                    else:
                        clauses.append("sort_seq <= ?" if shard < high_shard else "sort_seq < ?")
                        params.append(high_seq)
                    if after is not None:
                        after_seq, after_shard, after_local = after
                        if shard == after_shard:
                            clauses.append("(sort_seq > ? OR (sort_seq = ? AND local_id > ?))")
                            params.extend((after_seq, after_seq, after_local))
                        else:
                            clauses.append("sort_seq >= ?" if shard > after_shard else "sort_seq > ?")
                            params.append(after_seq)
                    sql = (f"SELECT local_id,local_type,real_sender_id,create_time,message_content,compress_content,server_id,sort_seq "
                           f"FROM {table} WHERE {' AND '.join(clauses)} ORDER BY sort_seq ASC,local_id ASC LIMIT ?")
                    senders = {int(row[0]): row[1] for row in conn.execute("SELECT rowid,user_name FROM Name2Id")}
                    rows.extend((record, shard, senders) for record in conn.execute(sql, (*params, page_size)))
            finally:
                for conn in {id(conn): conn for conn, _ in found}.values():
                    conn.close()
            rows.sort(key=lambda item: (int(item[0][7]), item[1], int(item[0][0])))
            page = rows[:page_size]
            if not page:
                return [], None
            last_record, last_shard, _ = page[-1]
            next_after = (int(last_record[7]), last_shard, int(last_record[0]))
            messages = [self._render_row(db, user, item, contacts, own_user) for item in page]
            return [message for message in messages if message], next_after

    def quoted_history_page(self, user, ceiling, after=None, page_size=64, member=None):
        """Read only 49/57 candidates inside an already-consumed history prefix."""
        if ceiling is None:
            return [], None
        with self.lock:
            db = self._db()
            contacts = self._contacts(db)
            own_user = self.self_user()
            found = db._msg_conns(user)
            rows = []
            try:
                for conn, table in found:
                    if not re.fullmatch(r"Msg_[0-9a-fA-F]{32}", table):
                        raise RuntimeError("invalid message table")
                    shard = Path(conn.execute("PRAGMA database_list").fetchone()[2]).name
                    if not re.fullmatch(r"message__message_\d+\.db", shard):
                        raise RuntimeError("unidentified message shard")
                    clauses, params = ["local_type=?"], [QUOTED_REPLY_TYPE]
                    if member is not None:
                        selected_ids = [row[0] for row in conn.execute(
                            "SELECT rowid FROM Name2Id WHERE user_name=?", (member,))]
                        if not selected_ids:
                            continue
                        clauses.append("real_sender_id IN (" + ",".join("?" for _ in selected_ids) + ")")
                        params.extend(selected_ids)
                    high_seq, high_shard, high_local = ceiling
                    if shard == high_shard:
                        clauses.append("(sort_seq < ? OR (sort_seq = ? AND local_id <= ?))")
                        params.extend((high_seq, high_seq, high_local))
                    else:
                        clauses.append("sort_seq <= ?" if shard < high_shard else "sort_seq < ?")
                        params.append(high_seq)
                    if after is not None:
                        after_seq, after_shard, after_local = after
                        if shard == after_shard:
                            clauses.append("(sort_seq > ? OR (sort_seq = ? AND local_id > ?))")
                            params.extend((after_seq, after_seq, after_local))
                        else:
                            clauses.append("sort_seq >= ?" if shard > after_shard else "sort_seq > ?")
                            params.append(after_seq)
                    sql = ("SELECT local_id,local_type,real_sender_id,create_time,message_content,"
                           "compress_content,server_id,sort_seq "
                           f"FROM {table} WHERE {' AND '.join(clauses)} "
                           "ORDER BY sort_seq ASC,local_id ASC LIMIT ?")
                    senders = {int(row[0]): row[1] for row in conn.execute(
                        "SELECT rowid,user_name FROM Name2Id")}
                    rows.extend((record, shard, senders) for record in conn.execute(
                        sql, (*params, page_size)))
            finally:
                for conn in {id(conn): conn for conn, _ in found}.values():
                    conn.close()
            rows.sort(key=lambda item: (int(item[0][7]), item[1], int(item[0][0])))
            page = rows[:page_size]
            if not page:
                return [], None
            last, shard, _senders = page[-1]
            next_after = (int(last[7]), shard, int(last[0]))
            rendered = [self._render_row(db, user, item, contacts, own_user) for item in page]
            return [item for item in rendered if item], next_after

    def preceding_text_context(self, user, before, limit=3):
        """Fetch the nearest earlier text context without replaying older history."""
        with self.lock:
            db = self._db()
            contacts = self._contacts(db)
            own_user = self.self_user()
            found = db._msg_conns(user)
            candidates = []
            try:
                for conn, table in found:
                    if not re.fullmatch(r"Msg_[0-9a-fA-F]{32}", table):
                        raise RuntimeError("invalid message table")
                    shard = Path(conn.execute("PRAGMA database_list").fetchone()[2]).name
                    if not re.fullmatch(r"message__message_\d+\.db", shard):
                        raise RuntimeError("unidentified message shard")
                    cursor = None
                    senders = {int(row[0]): row[1] for row in conn.execute(
                        "SELECT rowid,user_name FROM Name2Id")}
                    found_here = 0
                    while found_here < limit:
                        clauses = ["local_type IN (?,?)"]
                        params = [1, QUOTED_REPLY_TYPE]
                        if cursor is None:
                            seq, target_shard, local = before
                            if shard == target_shard:
                                clauses.append("(sort_seq < ? OR (sort_seq = ? AND local_id < ?))")
                                params.extend((seq, seq, local))
                            else:
                                clauses.append("sort_seq <= ?" if shard < target_shard else "sort_seq < ?")
                                params.append(seq)
                        else:
                            seq, local = cursor
                            clauses.append("(sort_seq < ? OR (sort_seq = ? AND local_id < ?))")
                            params.extend((seq, seq, local))
                        sql = ("SELECT local_id,local_type,real_sender_id,create_time,message_content,"
                               "compress_content,server_id,sort_seq "
                               f"FROM {table} WHERE {' AND '.join(clauses)} "
                               "ORDER BY sort_seq DESC,local_id DESC LIMIT ?")
                        rows = conn.execute(sql, (*params, 16)).fetchall()
                        if not rows:
                            break
                        for record in rows:
                            item = self._render_row(db, user, (record, shard, senders),
                                                    contacts, own_user)
                            if item and item["kind"] == "text" and item["text"].strip():
                                candidates.append(item)
                                found_here += 1
                                if found_here >= limit:
                                    break
                        cursor = int(rows[-1][7]), int(rows[-1][0])
                        if len(rows) < 16:
                            break
            finally:
                for conn in {id(conn): conn for conn, _ in found}.values():
                    conn.close()
            newest = sorted(candidates, key=lambda item: tuple(item["_sort"]), reverse=True)[:limit]
            return [{"id": item["id"], "side": item["side"], "text": item["text"]}
                    for item in reversed(newest)]

    def stats(self, user, member=None):
        with self.lock:
            db = self._db()
            contacts = self._contacts(db)
            found = db._msg_conns(user)
            count = text_count = 0
            members = set()
            try:
                for conn, table in found:
                    sender_index = {int(row[0]): row[1] for row in conn.execute("SELECT rowid,user_name FROM Name2Id")}
                    selected_ids = [sender_id for sender_id, username in sender_index.items() if username == member] if member else []
                    if member and not selected_ids:
                        amount = 0
                    elif member:
                        placeholders = ",".join("?" for _ in selected_ids)
                        amount = conn.execute(f"SELECT COUNT(*) FROM {table} WHERE real_sender_id IN ({placeholders})", selected_ids).fetchone()[0]
                    else:
                        amount = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                    count += amount
                    text_count += sum(self._analyzable_counts(
                        db, conn, table, selected_ids if member else None).values())
                    for (sender_id,) in conn.execute(f"SELECT DISTINCT real_sender_id FROM {table}"):
                        sender = sender_index.get(int(sender_id or 0))
                        if sender:
                            members.add(sender)
            finally:
                for conn in {id(conn): conn for conn, _ in found}.values():
                    conn.close()
            return count, text_count, [{"id": member, **contact_display(contacts, member)}
                                       for member in sorted(members)]

    def profile_metadata(self, user, member=None):
        """Read metadata once per snapshot revision; Backend brackets the account scope."""
        with self.lock:
            db = self._db()
            contacts = self._contacts(db)
            found = db._msg_conns(user)
            try:
                signatures = []
                for conn, _table in found:
                    path = Path(conn.execute("PRAGMA database_list").fetchone()[2])
                    stat = path.stat()
                    signatures.append((str(path), stat.st_mtime_ns, stat.st_ctime_ns, stat.st_size))
                signature = tuple(signatures)
                key = (str(db.account), user)
                cached = self.profile_metadata_cache.get(key)
                if cached and cached[0] == signature:
                    counts, count, text_count = cached[1:]
                    self.profile_metadata_cache.move_to_end(key)
                else:
                    counts, count, text_count = {}, 0, 0
                    for conn, table in found:
                        if not re.fullmatch(r"Msg_[0-9a-fA-F]{32}", table):
                            raise RuntimeError("invalid message table")
                        senders = {int(row[0]): row[1] for row in conn.execute("SELECT rowid,user_name FROM Name2Id")}
                        for sender_id, amount in conn.execute(
                                f"SELECT real_sender_id,COUNT(*) FROM {table} GROUP BY real_sender_id"):
                            count += amount
                            sender = senders.get(int(sender_id or 0))
                            if sender:
                                previous = counts.get(sender, (0, 0))
                                counts[sender] = (previous[0] + amount, previous[1])
                        for sender_id, analyzed in self._analyzable_counts(db, conn, table).items():
                            text_count += analyzed
                            sender = senders.get(int(sender_id or 0))
                            if sender:
                                previous = counts.get(sender, (0, 0))
                                counts[sender] = (previous[0], previous[1] + analyzed)
                    self.profile_metadata_cache[key] = (signature, counts, count, text_count)
                    self.profile_metadata_cache.move_to_end(key)
                    if len(self.profile_metadata_cache) > PROFILE_METADATA_CACHE_LIMIT:
                        self.profile_metadata_cache.popitem(last=False)
            finally:
                for conn in {id(conn): conn for conn, _ in found}.values():
                    conn.close()
            group = user.endswith("@chatroom")
            if member and (not group or member not in counts):
                raise ValueError("unknown member")
            subject = member if group else user
            if subject:
                count, text_count = counts.get(subject, (0, 0))
            return {"contact": contact_display(contacts, member or user),
                    "members": [{"id": sender, **contact_display(contacts, sender)} for sender in sorted(counts)] if group else [],
                    "count": count, "textCount": text_count}

    def contact(self, user):
        with self.lock:
            db = self._db(fresh=True)
            contact = contact_display(self._contacts(db), user)
            if self._db(fresh=True) is not db:
                raise AccountChangedError()
            return contact


class NodeAnalysis:
    def __init__(self, settings_path=None):
        self.condition = threading.Condition()
        self.process = None
        self.pending = {}
        self.model = {"state": "idle"}
        self.serial = 0
        self.version = None
        self.running_version = None
        self.settings_path = Path(settings_path) if settings_path is not None else (
            ROOT / ".local" / "real-client-runtime" / "inference-settings.json")
        self.requested_provider = self._read_provider()

    def _read_provider(self):
        try:
            value = json.loads(self.settings_path.read_text(encoding="utf-8")).get("provider")
        except (FileNotFoundError, OSError, ValueError, AttributeError):
            return "gpu"
        return value if value in ("cpu", "gpu") else "gpu"

    def _save_provider(self, provider):
        self.settings_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.settings_path.with_name(self.settings_path.name + "." + uuid.uuid4().hex + ".tmp")
        try:
            temporary.write_text(json.dumps({"provider": provider}) + "\n", encoding="utf-8")
            os.replace(temporary, self.settings_path)
        finally:
            temporary.unlink(missing_ok=True)

    def _runtime_status_locked(self):
        state = self.model.get("state", "idle")
        return {"requestedProvider": self.requested_provider,
                "modelProvider": self.model.get("provider") if state == "ready" and
                self.model.get("provider") in ("cpu", "webgpu") else None,
                "status": state if state in ("ready", "loading", "idle") else "error"}

    def runtime_status(self):
        with self.condition:
            return self._runtime_status_locked()

    def configure_runtime(self, provider):
        if provider not in ("cpu", "gpu"):
            raise ValueError("invalid provider")
        # _request holds this same lock until its target reply arrives; switching cannot
        # interrupt an inference or let two JSONL commands write concurrently.
        with self.condition:
            if (provider == self.requested_provider and self.model.get("state") == "ready" and
                    self.model.get("provider") == ("cpu" if provider == "cpu" else "webgpu")):
                return self._runtime_status_locked()
            self._save_provider(provider)
            self.requested_provider = provider
            if self.process is None or self.process.poll() is not None:
                self.model = {"state": "idle"}
                return self._runtime_status_locked()
            self.model = {"state": "loading"}
            self.serial += 1
            request_id = self.serial
            self.process.stdin.write(json.dumps({"id": request_id, "cmd": "configure-runtime",
                                                 "provider": provider}) + "\n")
            self.process.stdin.flush()
            deadline = time.monotonic() + 180
            while request_id not in self.pending and time.monotonic() < deadline and self.process.poll() is None:
                self.condition.wait(timeout=1)
            response = self.pending.pop(request_id, None)
            if not response or response.get("analysisVersion") != self.version:
                self.model = {"state": "error", "message": "runtime switch timed out or version changed"}
            elif response.get("error"):
                self.model = {"state": "error", "message": str(response["error"])[:200]}
            else:
                self.model = response.get("modelStatus") or {"state": "error", "message": "model status missing"}
            return self._runtime_status_locked()

    def analysis_version(self):
        with self.condition:
            if self.version is None:
                probe = subprocess.run(
                    ["node", "--import", "tsx", str(ROOT / "bridge/analysis_server.ts"), "--analysis-version"],
                    cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=20,
                    check=False, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
                if probe.returncode != 0:
                    raise RuntimeError("analysis version unavailable")
                try:
                    version = json.loads(probe.stdout.strip()).get("analysisVersion")
                except ValueError as exc:
                    raise RuntimeError("invalid analysis version response") from exc
                if not isinstance(version, str) or not version:
                    raise RuntimeError("invalid analysis version")
                self.version = version
            return self.version

    def _read(self, process):
        for line in process.stdout:
            try:
                reply = json.loads(line)
            except ValueError:
                continue
            with self.condition:
                if "ready" in reply:
                    self.model = reply.get("model") or {"state": "error", "message": "model status missing"}
                    self.running_version = reply.get("analysisVersion")
                    if self.running_version != self.version:
                        self.model = {"state": "error", "message": "analysis version changed; restart service"}
                elif reply.get("id") is not None:
                    status = reply.get("modelStatus")
                    if isinstance(status, dict) and status.get("state") in ("ready", "loading", "missing", "error"):
                        self.model = status
                    self.pending[reply["id"]] = reply
                self.condition.notify_all()
        with self.condition:
            if self.process is process:
                self.model = {"state": "error", "message": "analysis process exited"}
                self.condition.notify_all()

    def _request(self, payload):
        version = self.analysis_version()
        with self.condition:
            if self.process is None or self.process.poll() is not None:
                self.model = {"state": "loading"}
                self.process = subprocess.Popen(["node", "--import", "tsx", str(ROOT / "bridge/analysis_server.ts"),
                                                 "--provider", self.requested_provider],
                                                cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                                stderr=subprocess.DEVNULL, text=True, encoding="utf-8", bufsize=1,
                                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                threading.Thread(target=self._read, args=(self.process,), daemon=True).start()
            deadline = time.monotonic() + 120
            while self.model["state"] == "loading" and time.monotonic() < deadline:
                self.condition.wait(timeout=1)
            if self.model["state"] in ("missing", "error") and self.process.poll() is None:
                self.serial += 1
                prepare_id = self.serial
                self.process.stdin.write(json.dumps({"id": prepare_id, "cmd": "prepare"}) + "\n")
                self.process.stdin.flush()
                while prepare_id not in self.pending and time.monotonic() < deadline and self.process.poll() is None:
                    self.condition.wait(timeout=1)
                prepared = self.pending.pop(prepare_id, {})
                self.model = prepared.get("model") or {"state": "error", "message": "model retry failed"}
            if self.model["state"] != "ready":
                raise RuntimeError("model-" + self.model["state"] + ": " + self.model.get("message", ""))
            if self.running_version != version:
                raise RuntimeError("analysis version changed; restart service")
            self.serial += 1
            request_id = self.serial
            self.process.stdin.write(json.dumps({"id": request_id, **payload}, ensure_ascii=False) + "\n")
            self.process.stdin.flush()
            deadline = time.monotonic() + 180
            while request_id not in self.pending and time.monotonic() < deadline and self.process.poll() is None:
                self.condition.wait(timeout=1)
            response = self.pending.pop(request_id, None)
            if not response:
                raise RuntimeError("analysis process timeout or exited")
            if response.get("error"):
                raise RuntimeError(str(response["error"]))
            if response.get("analysisVersion") != version:
                raise RuntimeError("analysis response version mismatch")
            return response, version

    @staticmethod
    def _wire_messages(messages):
        return [{"id": item["id"], "side": item["side"], "text": item["text"],
                 **({"time": item["time"]} if "time" in item else {})} for item in messages]

    def analyze(self, session, messages, target, portraitContext=None, messageLabelsOnly=False):
        if portraitContext is not None and not isinstance(portraitContext, str):
            raise ValueError("invalid portraitContext")
        if type(messageLabelsOnly) is not bool:
            raise ValueError("invalid messageLabelsOnly")
        payload = {"cmd": "targets", "sessionId": session,
                   "messages": self._wire_messages(messages), "targetIds": [target]}
        if portraitContext and portraitContext.strip():
            payload["portraitContext"] = portraitContext
        if messageLabelsOnly:
            payload["messageLabelsOnly"] = True
        response, version = self._request(payload)
        if len(response.get("messages", [])) != 1 or response["messages"][0].get("messageId") != target:
            raise RuntimeError("invalid model response")
        return {**response["messages"][0], "analysisVersion": version,
                "_modelMs": response.get("durationMs")}

    def analyze_batch(self, session, messages, context=None):
        """One model judgment for a contiguous new-text window, never per-message calls."""
        payload = [{"id": item["id"], "text": item["text"], "side": item["side"],
                    "target": bool(item.get("target")), "offset": int(item.get("offset", 0))}
                   for item in messages]
        response, version = self._request({"cmd": "batch", "sessionId": session,
                                           "messages": payload, "context": context or []})
        if response.get("batchVersion") != "message-batch-v1":
            raise RuntimeError("batch response version mismatch")
        consumed = response.get("consumed")
        if not isinstance(consumed, list) or not 1 <= len(consumed) <= len(payload):
            raise RuntimeError("batch made no progress")
        for index, piece in enumerate(consumed):
            item = payload[index]
            start, end = piece.get("start"), piece.get("end")
            if (piece.get("id") != item["id"] or type(start) is not int or type(end) is not int or
                    start != item["offset"] or not start < end <= len(item["text"]) or
                    type(piece.get("complete")) is not bool or
                    piece["complete"] != (end == len(item["text"])) or
                    (index < len(consumed)-1 and not piece["complete"])):
                raise RuntimeError("invalid batch coverage")
        result = response.get("result")
        targeted = any(payload[index]["target"] and
                       payload[index]["text"][piece["start"]:piece["end"]].replace("\ufeff", "").strip()
                       for index, piece in enumerate(consumed))
        if targeted and not isinstance(result, dict):
            raise RuntimeError("missing batch result")
        if result is not None:
            for field in ("emotion", "intent"):
                values = result.get(field)
                if not isinstance(values, list) or not values or any(
                        not isinstance(item, dict) or not isinstance(item.get("label"), str) or
                        not isinstance(item.get("probability"), (float, int)) or
                        not math.isfinite(item["probability"]) or not 0 <= item["probability"] <= 1
                        for item in values):
                    raise RuntimeError("invalid batch " + field)
            validate_style_evidence(result.get("styleEvidence"))
            validate_personality_evidence(result.get("personalityEvidence"))
            if targeted and (not isinstance(result.get("score"), (float, int)) or
                             not math.isfinite(result["score"]) or not -1 <= result["score"] <= 1):
                raise RuntimeError("invalid batch relationship")
        return {**response, "analysisVersion": version}

    def predict_reply(self, session, messages, draft):
        response, version = self._request({"cmd": "forecast", "sessionId": session,
                                           "messages": self._wire_messages(messages), "draft": draft})
        candidates = response.get("candidates")
        expected = {"small_talk", "share_news", "ask_question", "seek_comfort", "give_comfort",
                    "make_plan", "flirt", "complain", "apologize", "joke", "reject", "distance"}
        if not isinstance(candidates, list) or len(candidates) != 3 or len({
                item.get("id") for item in candidates if isinstance(item, dict)}) != 3:
            raise RuntimeError("invalid reply forecast result")
        for item in candidates:
            if (not isinstance(item, dict) or item.get("id") not in expected or
                    not isinstance(item.get("label"), str) or not item["label"] or
                    not isinstance(item.get("description"), str) or not item["description"] or
                    not isinstance(item.get("probability"), (float, int)) or
                    not math.isfinite(item["probability"]) or
                    not 0 <= item["probability"] <= 1):
                raise RuntimeError("invalid reply forecast candidate")
        if any(candidates[index]["probability"] < candidates[index + 1]["probability"] for index in range(2)):
            raise RuntimeError("reply forecast candidates are not ranked")
        return {"analysisVersion": version, "candidates": candidates}

    def close(self):
        """End only this bridge's model child after in-flight requests have returned."""
        with self.condition:
            process = self.process
            self.process = None
            self.model = {"state": "idle"}
            if process is not None and process.poll() is None:
                try:
                    process.stdin.close()
                except (OSError, ValueError):
                    pass
        if process is not None:
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.terminate()
                process.wait(timeout=10)


class ResultStore:
    def __init__(self, path):
        self.path = path
        self.profile_lock = threading.RLock()
        with self.connect() as conn:
            conn.execute("CREATE TABLE IF NOT EXISTS results_v2 (account TEXT NOT NULL, session TEXT NOT NULL, id TEXT NOT NULL, "
                         "sort_seq INTEGER NOT NULL, shard TEXT NOT NULL, local_id INTEGER NOT NULL, sender TEXT NOT NULL, "
                         "side TEXT NOT NULL, result TEXT NOT NULL, score REAL, version TEXT NOT NULL, "
                         "PRIMARY KEY(account,session,id,version))")
            conn.execute("CREATE TABLE IF NOT EXISTS analysis_skips (account TEXT NOT NULL, session TEXT NOT NULL, "
                         "id TEXT NOT NULL, version TEXT NOT NULL, sort_seq INTEGER NOT NULL, shard TEXT NOT NULL, "
                         "local_id INTEGER NOT NULL, reason TEXT NOT NULL, "
                         "PRIMARY KEY(account,session,id,version))")
            conn.execute("CREATE TABLE IF NOT EXISTS fine_results_v1 (account TEXT NOT NULL, session TEXT NOT NULL, "
                         "id TEXT NOT NULL, version TEXT NOT NULL, sort_seq INTEGER NOT NULL, shard TEXT NOT NULL, "
                         "local_id INTEGER NOT NULL, sender TEXT NOT NULL, result TEXT NOT NULL, "
                         "PRIMARY KEY(account,session,id,version))")
            conn.execute("CREATE TABLE IF NOT EXISTS fine_skips_v1 (account TEXT NOT NULL, session TEXT NOT NULL, "
                         "id TEXT NOT NULL, version TEXT NOT NULL, sort_seq INTEGER NOT NULL, shard TEXT NOT NULL, "
                         "local_id INTEGER NOT NULL, reason TEXT NOT NULL, "
                         "PRIMARY KEY(account,session,id,version))")
            conn.execute("CREATE INDEX IF NOT EXISTS fine_results_recent_v1 ON fine_results_v1 "
                         "(account,session,version,sort_seq DESC,shard DESC,local_id DESC)")
            conn.execute("CREATE INDEX IF NOT EXISTS fine_skips_recent_v1 ON fine_skips_v1 "
                         "(account,session,version,sort_seq DESC,shard DESC,local_id DESC)")
            conn.execute("CREATE TABLE IF NOT EXISTS progress_v1 (account TEXT NOT NULL, session TEXT NOT NULL, "
                         "version TEXT NOT NULL, cursor_seq INTEGER, cursor_shard TEXT, cursor_local INTEGER, "
                         "complete INTEGER NOT NULL DEFAULT 0, context_json TEXT NOT NULL DEFAULT '[]', "
                         "eligible_count INTEGER NOT NULL DEFAULT 0, score_count INTEGER NOT NULL DEFAULT 0, "
                         "score_sum REAL NOT NULL DEFAULT 0, score_weighted REAL NOT NULL DEFAULT 0, "
                         "mood_count INTEGER NOT NULL DEFAULT 0, mood_json TEXT NOT NULL DEFAULT '{}', "
                         "PRIMARY KEY(account,session,version))")
            conn.execute("CREATE TABLE IF NOT EXISTS summary_v1 (account TEXT NOT NULL, session TEXT NOT NULL, "
                         "version TEXT NOT NULL, score_count INTEGER NOT NULL, score_sum REAL NOT NULL, "
                         "score_weighted REAL NOT NULL, mood_count INTEGER NOT NULL, mood_json TEXT NOT NULL, "
                         "PRIMARY KEY(account,session,version))")
            conn.execute("CREATE INDEX IF NOT EXISTS results_order_v1 ON results_v2 "
                         "(account,session,version,sort_seq,shard,local_id,id)")
            conn.execute("CREATE INDEX IF NOT EXISTS results_scored_order_v1 ON results_v2 "
                         "(account,session,version,sort_seq,shard,local_id,id) "
                         "WHERE side='other' AND score IS NOT NULL")
            conn.execute("CREATE TABLE IF NOT EXISTS profile_tokens_v1 (account TEXT NOT NULL, session TEXT NOT NULL, "
                         "version TEXT NOT NULL, id TEXT NOT NULL, words TEXT NOT NULL, PRIMARY KEY(account,session,version,id))")
            conn.execute("CREATE TABLE IF NOT EXISTS profile_tokens_ready_v1 (account TEXT NOT NULL, session TEXT NOT NULL, "
                         "version TEXT NOT NULL, PRIMARY KEY(account,session,version))")
            conn.execute("CREATE TABLE IF NOT EXISTS profile_state_v1 (account TEXT NOT NULL, session TEXT NOT NULL, "
                         "version TEXT NOT NULL, subject TEXT NOT NULL, cursor INTEGER NOT NULL, state TEXT NOT NULL, "
                         "PRIMARY KEY(account,session,version,subject))")
            conn.execute("CREATE INDEX IF NOT EXISTS results_profile_delta_v1 ON results_v2 (account,session,version)")
            conn.execute("CREATE INDEX IF NOT EXISTS results_member_delta_v1 ON results_v2 (account,session,version,sender)")

    @contextmanager
    def connect(self):
        conn = sqlite3.connect(self.path, timeout=15)
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def items(self, account, user, version, member=None):
        with self.connect() as conn:
            sql = "SELECT id,result,score,side FROM results_v2 WHERE account=? AND session=? AND version=?"
            args = [account, user, version]
            if member:
                sql += " AND sender=?"
                args.append(member)
            sql += " ORDER BY sort_seq,shard,local_id,id"
            return [(id, json.loads(result), score, side) for id, result, score, side in conn.execute(sql, args)]

    def profile_state(self, account, user, version, subject, read_texts):
        """Bootstrap existing evidence once, then consume only inserted result rows."""
        scope = (account, user, version)
        with self.profile_lock:
            with self.connect() as conn:
                ready = conn.execute("SELECT 1 FROM profile_tokens_ready_v1 WHERE account=? AND session=? AND version=?", scope).fetchone()
                refs = [] if ready else list(conn.execute(
                    "SELECT r.shard,r.local_id,r.id FROM results_v2 r LEFT JOIN profile_tokens_v1 t "
                    "ON t.account=r.account AND t.session=r.session AND t.version=r.version AND t.id=r.id "
                    "WHERE r.account=? AND r.session=? AND r.version=? AND r.side='other' AND t.id IS NULL", scope))
            if not ready:
                # Only legacy results lack stored lexical evidence. New results save it
                # together with the model outcome, including before the first profile.
                texts = read_texts(refs) if refs else {}
                tokens = {stable_id: dict(keyword_counts([texts.get(stable_id, "")]))
                          for _shard, _local, stable_id in refs}
                with self.connect() as conn:
                    conn.executemany("INSERT OR IGNORE INTO profile_tokens_v1 VALUES (?,?,?,?,?)",
                                     [(*scope, stable_id, json.dumps(words, ensure_ascii=False))
                                      for stable_id, words in tokens.items()])
                    conn.execute("INSERT OR IGNORE INTO profile_tokens_ready_v1 VALUES (?,?,?)", scope)
            with self.connect() as conn:
                conn.execute("BEGIN IMMEDIATE")
                saved = conn.execute("SELECT cursor,state FROM profile_state_v1 WHERE account=? AND session=? AND version=? AND subject=?",
                                     (*scope, subject or "")).fetchone()
                cursor, state = (saved[0], json.loads(saved[1])) if saved else (0, empty_profile_state())
                conditions = "r.account=? AND r.session=? AND r.version=? AND r.rowid>?"
                args = (*scope, cursor)
                if subject:
                    conditions += " AND r.sender=?"
                    args += (subject,)
                ordered = "r.rowid" if saved else "r.sort_seq,r.shard,r.local_id,r.id"
                rows = conn.execute(
                    "SELECT r.rowid,r.id,r.result,r.score,r.side,r.sort_seq,r.shard,r.local_id,t.words "
                    "FROM results_v2 r LEFT JOIN profile_tokens_v1 t ON t.account=r.account AND t.session=r.session "
                    "AND t.version=r.version AND t.id=r.id WHERE " + conditions + " ORDER BY " + ordered, args).fetchall()
                for rowid, stable_id, raw, score, side, seq, shard, local_id, words in rows:
                    result, position = json.loads(raw), (seq, shard, local_id, stable_id)
                    tails = []
                    if saved and side == "other" and state["latest"] is not None and position < tuple(state["latest"]):
                        tail_where = "account=? AND session=? AND version=? AND side='other' AND rowid<? AND (sort_seq,shard,local_id,id)>(?,?,?,?)"
                        tail_args = (*scope, rowid, *position)
                        if subject:
                            tail_where += " AND sender=?"
                            tail_args += (subject,)
                        tails = [(json.loads(raw_tail), tail_score) for raw_tail, tail_score in
                                 conn.execute("SELECT result,score FROM results_v2 WHERE " + tail_where, tail_args)]
                    add_profile_result(state, result, score, side, position, json.loads(words or "{}"), tails)
                    cursor = max(cursor, rowid)
                if rows or not saved:
                    conn.execute("INSERT OR REPLACE INTO profile_state_v1 VALUES (?,?,?,?,?,?)",
                                 (*scope, subject or "", cursor, json.dumps(state, ensure_ascii=False)))
                return state

    def ids(self, account, user, version):
        with self.connect() as conn:
            found = {row[0] for row in conn.execute(
                "SELECT id FROM results_v2 WHERE account=? AND session=? AND version=?",
                (account, user, version),
            )}
            found.update(row[0] for row in conn.execute(
                "SELECT id FROM analysis_skips WHERE account=? AND session=? AND version=?",
                (account, user, version),
            ))
            return found

    def has(self, account, user, version, stable_id):
        with self.connect() as conn:
            return (conn.execute("SELECT 1 FROM results_v2 WHERE account=? AND session=? AND id=? AND version=?",
                                 (account, user, stable_id, version)).fetchone() is not None or
                    conn.execute("SELECT 1 FROM analysis_skips WHERE account=? AND session=? AND id=? AND version=?",
                                 (account, user, stable_id, version)).fetchone() is not None)

    def skip(self, account, user, version, message, reason):
        seq, shard, local_id = message["_sort"]
        with self.connect() as conn:
            conn.execute("INSERT OR IGNORE INTO analysis_skips VALUES (?,?,?,?,?,?,?,?)",
                         (account, user, message["id"], version, seq, shard, local_id, reason))

    def progress(self, account, user, version):
        with self.connect() as conn:
            row = conn.execute(
                "SELECT cursor_seq,cursor_shard,cursor_local,complete,context_json,eligible_count FROM progress_v1 "
                "WHERE account=? AND session=? AND version=?", (account, user, version),
            ).fetchone()
        if row is None:
            return {"cursor": None, "complete": False, "context": [], "eligible": 0}
        return {"cursor": tuple(row[:3]) if row[0] is not None else None,
                "complete": bool(row[3]), "context": json.loads(row[4]), "eligible": row[5]}

    def advance(self, account, user, version, cursor, context, item=None, complete=False):
        """Commit only the scan cursor; result summaries are updated on first save."""
        with self.connect() as conn:
            conn.execute("INSERT OR IGNORE INTO progress_v1(account,session,version) VALUES (?,?,?)",
                         (account, user, version))
            row = conn.execute(
                "SELECT cursor_seq,cursor_shard,cursor_local,eligible_count FROM progress_v1 "
                "WHERE account=? AND session=? AND version=?", (account, user, version),
            ).fetchone()
            prior = tuple(row[:3]) if row[0] is not None else None
            if cursor is not None and prior is not None and (cursor < prior or
                    (cursor == prior and not complete)):
                return
            eligible = row[3]
            if item is not None and item["kind"] == "text" and item["text"].strip():
                eligible += 1
            seq, shard, local_id = cursor if cursor is not None else (None, None, None)
            conn.execute("UPDATE progress_v1 SET cursor_seq=?,cursor_shard=?,cursor_local=?,complete=?,"
                         "context_json=?,eligible_count=? WHERE account=? AND session=? AND version=?",
                         (seq, shard, local_id, int(complete),
                          json.dumps(list(context), ensure_ascii=False), eligible, account, user, version))

    def recent(self, account, user, version, limit=80):
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT id,result,score,side FROM results_v2 WHERE account=? AND session=? AND version=? "
                "ORDER BY sort_seq DESC,shard DESC,local_id DESC,id DESC LIMIT ?",
                (account, user, version, limit),
            ).fetchall()
            skipped = conn.execute(
                "SELECT id,reason FROM analysis_skips WHERE account=? AND session=? AND version=? "
                "ORDER BY sort_seq DESC,shard DESC,local_id DESC,id DESC LIMIT ?",
                (account, user, version, limit),
            ).fetchall()
        return ({stable_id: json.loads(result) for stable_id, result, _score, _side in rows} |
                {stable_id: {"state": "skipped", "reason": reason} for stable_id, reason in skipped})

    def fine_known(self, account, user, version, ids):
        if not ids:
            return set()
        if len(ids) > 500:
            raise ValueError("too many fine result ids")
        marks = ",".join("?" for _ in ids)
        with self.connect() as conn:
            scope = (account, user, version, *ids)
            main = {stable_id: json.loads(raw).get("labelSchema") for stable_id, raw in conn.execute(
                f"SELECT id,result FROM results_v2 WHERE account=? AND session=? AND version=? AND id IN ({marks})",
                scope)}
            fine = {stable_id: json.loads(raw).get("labelSchema") for stable_id, raw in conn.execute(
                f"SELECT id,result FROM fine_results_v1 WHERE account=? AND session=? AND version=? AND id IN ({marks})",
                scope)}
            # A legacy fine row overlays a newer main row in fine_view, so it
            # must be refreshed too. Only the caller's visible ids are queried.
            known = {stable_id for stable_id, schema in fine.items() if schema == FINE_LABEL_SCHEMA}
            known.update(stable_id for stable_id, schema in main.items()
                         if schema == FINE_LABEL_SCHEMA and stable_id not in fine)
            # A recorded skip is terminal for this analysis version. In particular,
            # retrying a legacy fine row that already hit the length limit would
            # repeat the same failed model request on every visit.
            for table in ("analysis_skips", "fine_skips_v1"):
                known.update(row[0] for row in conn.execute(
                    f"SELECT id FROM {table} WHERE account=? AND session=? AND version=? AND id IN ({marks})",
                    scope))
            return known

    def fine_view(self, account, user, version, ids=None, limit=80):
        if ids is not None and not ids:
            return {}
        if ids is not None and len(ids) > 500:
            raise ValueError("too many fine result ids")
        where = "account=? AND session=? AND version=?"
        args = [account, user, version]
        if ids is not None:
            where += " AND id IN (" + ",".join("?" for _ in ids) + ")"
            args.extend(ids)
        order = "" if ids is not None else " ORDER BY sort_seq DESC,shard DESC,local_id DESC,id DESC LIMIT ?"
        if ids is None:
            args.append(limit)
        with self.connect() as conn:
            done = conn.execute("SELECT id,result FROM fine_results_v1 WHERE " + where + order, args).fetchall()
            skipped = conn.execute("SELECT id,reason FROM fine_skips_v1 WHERE " + where + order, args).fetchall()
        return ({stable_id: json.loads(raw) for stable_id, raw in done} |
                {stable_id: {"state": "skipped", "reason": reason} for stable_id, reason in skipped})

    def save_fine(self, account, user, version, message, result):
        seq, shard, local_id = message["_sort"]
        with self.connect() as conn:
            conn.execute("INSERT INTO fine_results_v1 VALUES (?,?,?,?,?,?,?,?,?) "
                         "ON CONFLICT(account,session,id,version) DO UPDATE SET result=excluded.result",
                         (account, user, message["id"], version, seq, shard, local_id,
                          message["senderId"], json.dumps(result, ensure_ascii=False)))
            conn.execute("DELETE FROM fine_skips_v1 WHERE account=? AND session=? AND id=? AND version=?",
                         (account, user, message["id"], version))

    def skip_fine(self, account, user, version, message, reason):
        seq, shard, local_id = message["_sort"]
        with self.connect() as conn:
            conn.execute("INSERT OR IGNORE INTO fine_skips_v1 VALUES (?,?,?,?,?,?,?,?)",
                         (account, user, message["id"], version, seq, shard, local_id, reason))

    def text_refs(self, account, user, version, member=None):
        with self.connect() as conn:
            sql = ("SELECT shard,local_id,id FROM results_v2 WHERE account=? AND session=? "
                   "AND version=? AND side='other'")
            args = [account, user, version]
            if member:
                sql += " AND sender=?"
                args.append(member)
            return list(conn.execute(sql, args))

    @staticmethod
    def _add_emotion(summary, emotion, rank, tail=None):
        if not emotion:
            return
        tail = tail or {}
        for entry in emotion:
            raw = entry.get("rawLabel") or entry["label"]
            values = summary["mood"].setdefault(raw, {"label": entry["label"], "sum": 0.0,
                                                       "weighted": 0.0})
            values["sum"] += entry["probability"]
            values["weighted"] += rank * entry["probability"] + tail.get(raw, 0.0)
            values["label"] = entry["label"]
        for raw, probability in tail.items():
            if raw not in {entry.get("rawLabel") or entry["label"] for entry in emotion}:
                summary["mood"][raw]["weighted"] += probability
        summary["moodCount"] += 1

    def _ensure_summary(self, conn, account, user, version):
        row = conn.execute("SELECT score_count,score_sum,score_weighted,mood_count,mood_json "
                           "FROM summary_v1 WHERE account=? AND session=? AND version=?",
                           (account, user, version)).fetchone()
        if row is not None:
            return {"scoreCount": row[0], "scoreSum": row[1], "scoreWeighted": row[2],
                    "moodCount": row[3], "mood": json.loads(row[4])}
        summary = {"scoreCount": 0, "scoreSum": 0.0, "scoreWeighted": 0.0,
                   "moodCount": 0, "mood": {}}
        # Existing installations have results but no summary. This ordered pass happens once
        # for this account/session/version; subsequent reads use only summary_v1.
        for result_json, score, side in conn.execute(
                "SELECT result,score,side FROM results_v2 WHERE account=? AND session=? AND version=? "
                "ORDER BY sort_seq,shard,local_id,id", (account, user, version)):
            if side != "other":
                continue
            if score is not None:
                summary["scoreWeighted"] += summary["scoreCount"] * score
                summary["scoreSum"] += score
                summary["scoreCount"] += 1
            emotion = json.loads(result_json).get("emotion") or []
            self._add_emotion(summary, emotion, summary["moodCount"])
        conn.execute("INSERT INTO summary_v1 VALUES (?,?,?,?,?,?,?,?)",
                     (account, user, version, summary["scoreCount"], summary["scoreSum"],
                      summary["scoreWeighted"], summary["moodCount"],
                      json.dumps(summary["mood"], ensure_ascii=False)))
        return summary

    def summary(self, account, user, version):
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            return self._ensure_summary(conn, account, user, version)

    def save(self, account, user, version, message, result):
        seq, shard, local_id = message["_sort"]
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            summary = self._ensure_summary(conn, account, user, version)
            if conn.execute("SELECT 1 FROM results_v2 WHERE account=? AND session=? AND id=? AND version=?",
                            (account, user, message["id"], version)).fetchone() is not None:
                return
            score = result.get("score") if message["side"] == "other" else None
            mood = (result.get("emotion") or []) if message["side"] == "other" else []
            rank = tail_score = 0
            tail_mood = {}
            if score is not None:
                position = (seq, shard, local_id, message["id"])
                prefix = (account, user, version)
                newest = conn.execute(
                    "SELECT sort_seq,shard,local_id,id FROM results_v2 WHERE account=? AND session=? "
                    "AND version=? AND side='other' AND score IS NOT NULL "
                    "ORDER BY sort_seq DESC,shard DESC,local_id DESC,id DESC LIMIT 1", prefix,
                ).fetchone()
                if newest is None or position > tuple(newest):
                    rank = summary["scoreCount"]
                else:
                    rank = conn.execute(
                        "SELECT COUNT(*) FROM results_v2 WHERE account=? AND session=? AND version=? "
                        "AND side='other' AND score IS NOT NULL AND (sort_seq,shard,local_id,id)<(?,?,?,?)",
                        (*prefix, *position),
                    ).fetchone()[0]
                    tails = conn.execute(
                        "SELECT result,score FROM results_v2 WHERE account=? AND session=? AND version=? "
                        "AND side='other' AND score IS NOT NULL AND (sort_seq,shard,local_id,id)>(?,?,?,?)",
                        (*prefix, *position),
                    )
                    for tail_json, tail_score_value in tails:
                        tail_score += tail_score_value
                        for entry in json.loads(tail_json).get("emotion") or []:
                            raw = entry.get("rawLabel") or entry["label"]
                            tail_mood[raw] = tail_mood.get(raw, 0.0) + entry["probability"]
            inserted = conn.execute("INSERT OR IGNORE INTO results_v2 VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                                    (account, user, message["id"], seq, shard, local_id, message["senderId"],
                                     message["side"], json.dumps(result, ensure_ascii=False), score, version))
            if inserted.rowcount != 1:
                return
            words = keyword_counts([message.get("text", "")]) if message["side"] == "other" else {}
            conn.execute("INSERT OR IGNORE INTO profile_tokens_v1 VALUES (?,?,?,?,?)",
                         (account, user, version, message["id"], json.dumps(words, ensure_ascii=False)))
            if score is not None:
                summary["scoreWeighted"] += rank * score + tail_score
                summary["scoreSum"] += score
                summary["scoreCount"] += 1
            if mood:
                self._add_emotion(summary, mood, rank, tail_mood)
            conn.execute("UPDATE summary_v1 SET score_count=?,score_sum=?,score_weighted=?,mood_count=?,mood_json=? "
                         "WHERE account=? AND session=? AND version=?",
                         (summary["scoreCount"], summary["scoreSum"], summary["scoreWeighted"],
                          summary["moodCount"], json.dumps(summary["mood"], ensure_ascii=False),
                          account, user, version))


class Backend:
    def __init__(self, source, analyzer=None, store_factory=None):
        self.source = source
        self.analyzer = analyzer or NodeAnalysis()
        self.store_factory = store_factory or self._project_store
        self.stores = {}
        self.jobs = {}
        self.jobs_lock = threading.Lock()
        self.request_condition = threading.Condition()
        self.active_requests = 0
        self.closing = False
        self.account_clear_paused = False
        self.performance = {}
        self.priority_recent = {}
        self.recent_windows = {}
        self.incremental_recheck = set()
        self.history_iterators = {}
        self.history_iterator_modes = {}
        self.quoted_backfill_iterators = {}
        self.forecast_cache = OrderedDict()
        self.forecast_lock = threading.Lock()
        self.forecast_flights = {}
        self.tasks = queue.PriorityQueue()
        self.task_serial = itertools.count()
        self.focused_key = None
        self.batch_engine = None
        if callable(getattr(self.analyzer, "analyze_batch", None)):
            from batch_engine import BatchEngine
            self.batch_engine = BatchEngine(self)
        self.worker_thread = threading.Thread(target=self._worker, daemon=True)
        self.worker_thread.start()

    @contextmanager
    def request_lease(self):
        """Drain HTTP readers/writers before clearing this bridge instance's account files."""
        with self.request_condition:
            if self.closing:
                raise RuntimeError("bridge is closing")
            self.active_requests += 1
        try:
            yield
        finally:
            with self.request_condition:
                self.active_requests -= 1
                self.request_condition.notify_all()

    def pause_for_account_clear(self, account):
        """Drain this bridge's work while retaining a way to resume after a failed clear."""
        with self.request_condition:
            if self.closing:
                raise RuntimeError("bridge is closing")
            self.closing = True
        self.tasks.put((99, next(self.task_serial), None))
        with self.request_condition:
            if not self.request_condition.wait_for(lambda: self.active_requests == 0, timeout=200):
                raise RuntimeError("bridge requests did not finish")
        self.worker_thread.join(timeout=200)
        if self.worker_thread.is_alive():
            raise RuntimeError("bridge worker did not stop")
        self.account_clear_paused = True
        try:
            forget = getattr(self.source, "forget_account", None)
            if callable(forget):
                forget(account)
        except Exception:
            self.resume_after_failed_account_clear()
            raise

    def resume_after_failed_account_clear(self):
        """Restore this bridge if scoped file removal failed after it was drained."""
        with self.request_condition:
            if not self.account_clear_paused or self.active_requests or self.worker_thread.is_alive():
                raise RuntimeError("bridge cannot safely resume")
        for iterator in self.history_iterators.values():
            try:
                iterator.close()
            except Exception:
                pass
        self.stores.clear()
        with self.jobs_lock:
            self.jobs.clear()
            self.priority_recent.clear()
            self.recent_windows.clear()
            self.incremental_recheck.clear()
        self.history_iterators.clear()
        self.history_iterator_modes.clear()
        self.quoted_backfill_iterators.clear()
        self.performance.clear()
        self.forecast_cache.clear()
        self.forecast_flights.clear()
        self.focused_key = None
        self.tasks = queue.PriorityQueue()
        self.task_serial = itertools.count()
        if self.batch_engine:
            from batch_engine import BatchEngine
            self.batch_engine = BatchEngine(self)
        self.worker_thread = threading.Thread(target=self._worker, daemon=True)
        self.worker_thread.start()
        with self.request_condition:
            self.account_clear_paused = False
            self.closing = False

    def shutdown(self, account=None):
        """Stop this bridge and model on normal exit or after an active-account clear."""
        with self.request_condition:
            first = not self.closing
            paused = self.account_clear_paused
            self.closing = True
            self.account_clear_paused = False
        if first or paused:
            if account is not None:
                forget = getattr(self.source, "forget_account", None)
                if callable(forget):
                    forget(account)
            close_source = getattr(self.source, "close", None)
            if callable(close_source):
                close_source()
            if first:
                self.tasks.put((99, next(self.task_serial), None))
        with self.request_condition:
            if not self.request_condition.wait_for(lambda: self.active_requests == 0, timeout=200):
                raise RuntimeError("bridge requests did not finish")
        self.worker_thread.join(timeout=200)
        if self.worker_thread.is_alive():
            raise RuntimeError("bridge worker did not stop")
        close_model = getattr(self.analyzer, "close", None)
        if callable(close_model):
            close_model()
        self.stores.clear()
        self.forecast_cache.clear()

    def _task_priority(self, task, interactive=False):
        focused = task[0] == self.focused_key
        recent = interactive or task[1] == "recent-window"
        if task[1] == "batch-subject":
            active = self.batch_engine and self.batch_engine.focused_member == (task[0], task[2])
            return 2 if focused and active else 3
        # A newly requested visible window should run after the current model
        # call, even when a different conversation's baseline is focused.
        return (0 if focused else 1) if recent else (2 if focused else 3)

    def _enqueue(self, task, interactive=False):
        if self.closing:
            return
        self.tasks.put((self._task_priority(task, interactive), next(self.task_serial), task))

    def _focus(self, key):
        """Prioritize the visible conversation's baseline without restarting any iterator."""
        with self.jobs_lock:
            self.focused_key = key
            with self.tasks.mutex:
                for index, (priority, serial, task) in enumerate(self.tasks.queue):
                    priority = self._task_priority(task)
                    self.tasks.queue[index] = (priority, serial, task)
                heapq.heapify(self.tasks.queue)

    def _interactive_waiting(self):
        with self.tasks.mutex:
            return bool(self.tasks.queue and self.tasks.queue[0][0] <= 1)

    @staticmethod
    def _project_store(account, _workdir):
        directory = ROOT / ".local" / "real-client-data"
        directory.mkdir(parents=True, exist_ok=True)
        filename = hashlib.sha256(account.encode("utf-8")).hexdigest() + ".sqlite3"
        return ResultStore(directory / filename)

    def _scoped_identity(self):
        if self.closing:
            raise AccountUnavailableError()
        account, workdir = self.source.identity()
        scope = (str(account), str(Path(workdir).resolve()))
        if scope not in self.stores:
            self.stores[scope] = self.store_factory(account, workdir)
        return scope[0], scope[1], self.stores[scope]

    def _identity(self):
        account, _, store = self._scoped_identity()
        return account, store

    def _assert_scope(self, scope):
        if self.closing:
            raise AccountChangedError()
        account, workdir = self.source.identity()
        if (str(account), str(Path(workdir).resolve())) != scope:
            raise AccountChangedError()

    def _stored_progress(self, account, user, version, store):
        progress = store.progress(account, user, version)
        if self.batch_engine:
            saved = self.batch_engine.snapshot(account, user, version, store)
            if saved:
                progress = {**progress, "cursor": saved["cursor"], "context": saved["context"],
                            "complete": saved["complete"], "eligible": saved["state"]["count"]}
        return progress

    def health(self):
        state = "idle"
        error = None
        account = None
        if isinstance(self.source, WeChatSource) or self.source.db is not None:
            try:
                account, _ = self.source.identity()
                state = "ready"
            except AccountUnavailableError as exc:
                state, error = "account-unavailable", str(exc)
            except Exception as exc:
                state, error = "error", str(exc)
        model = self.analyzer.model
        data = {"state": state}
        if account:
            data["account"] = account
        if error:
            data["error"] = error
        return {"ok": state not in ("error", "account-unavailable") and model["state"] not in ("error", "missing"), "data": data,
                "model": {"state": model["state"],
                          **({"provider": model["provider"]} if model.get("provider") in ("cpu", "webgpu") else {}),
                          **({"error": model["message"]} if model.get("message") and model["state"] != "ready" else {})},
                "version": "real-ui-1"}

    def runtime(self):
        return self.analyzer.runtime_status()

    def configure_runtime(self, provider):
        return self.analyzer.configure_runtime(provider)

    def messages(self, user, limit):
        account, workdir, _ = self._scoped_identity()
        messages = self.source.messages(user, limit)
        self._assert_scope((account, workdir))
        return {"messages": [{key: value for key, value in item.items() if not key.startswith("_")} for item in messages],
                "account": account, "total": None}

    def message_windows(self, requested_account, users):
        windows = self.source.message_windows(users, 80, expected_account=requested_account)
        return {"account": requested_account, "windows": [
            {"user": user, "messages": [
                {key: value for key, value in item.items() if not key.startswith("_")}
                for item in windows[user]]}
            for user in users]}

    def history(self, requested_account, user, *, before=None, around=None, limit=80):
        account, workdir, store = self._scoped_identity()
        if requested_account != account:
            raise AccountChangedError()
        page = browse_history(self.source, account, user, before=before, around=around,
                              limit=limit, max_issued_images=MAX_ISSUED_IMAGES)
        version = self.analyzer.analysis_version()
        results = saved_history_results(store, account, user, version, page["messages"])
        results.update(store.fine_view(account, user, version,
                                      [item["id"] for item in page["messages"]]))
        self._assert_scope((account, workdir))
        return {"account": account, "user": user,
                "messages": [{key: value for key, value in item.items() if not key.startswith("_")}
                             for item in page["messages"]],
                "results": results, "hasMoreBefore": page["hasMoreBefore"],
                "hasMoreAfter": page["hasMoreAfter"], "nextCursor": page["nextCursor"],
                "oldestCursor": page["oldestCursor"], "newestCursor": page["newestCursor"],
                "focusId": page["focusId"]}

    def history_search(self, requested_account, user, *, query=None, day=None,
                       before=None, limit=50):
        account, workdir, _store = self._scoped_identity()
        if requested_account != account:
            raise AccountChangedError()
        page = search_history(self.source, account, user, query=query, day=day,
                              before=before, limit=limit,
                              max_issued_images=MAX_ISSUED_IMAGES)
        self._assert_scope((account, workdir))
        return {"account": account, "user": user,
                "messages": [{key: value for key, value in item.items() if not key.startswith("_")}
                             for item in page["messages"]],
                "hasMore": page["hasMore"], "nextCursor": page["nextCursor"]}

    @staticmethod
    def _forecast_fingerprint(account, workdir, user, version, draft, window):
        basis = {"account": account, "workdir": str(workdir), "user": user, "version": version,
                 "draft": draft, "messages": [{"id": item["id"], "side": item["side"],
                    "kind": item.get("kind"), "text": item.get("text"), "time": item.get("time"),
                    "sort": item.get("_sort")} for item in window]}
        encoded = json.dumps(basis, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    def _verify_forecast_basis(self, account, workdir, user, version, draft, fingerprint):
        current_account, current_workdir = self.source.identity()
        if str(current_account) != account or str(current_workdir) != str(workdir):
            raise ForecastRequestError(409, "account-changed", "当前账号已变化，请刷新会话")
        current_window = self.source.messages(user, FORECAST_SOURCE_WINDOW)
        if self._forecast_fingerprint(account, workdir, user, version, draft, current_window) != fingerprint:
            raise ForecastRequestError(409, "stale-message", "会话消息已变化，请刷新后重试")

    def predict_reply(self, user, account, request_id, draft="", expected_last_message_id=None, member=None):
        if user.endswith("@chatroom"):
            raise ForecastRequestError(422, "group-unsupported", "群聊无法确定由谁回复，请选择单聊")
        if member is not None:
            raise ForecastRequestError(422, "member-not-applicable", "单聊预测不需要选择成员")
        actual_account, workdir = self.source.identity()
        actual_account = str(actual_account)
        if account != actual_account:
            raise ForecastRequestError(409, "account-changed", "当前账号已变化，请刷新会话")
        version = self.analyzer.analysis_version()
        window = self.source.messages(user, FORECAST_SOURCE_WINDOW)
        self._assert_scope((actual_account, str(Path(workdir).resolve())))
        if not window:
            raise ForecastRequestError(422, "no-context", "当前会话没有可用于预测的消息")
        last_message_id = window[-1]["id"]
        if expected_last_message_id is not None and expected_last_message_id != last_message_id:
            raise ForecastRequestError(409, "stale-message", "会话已有新消息，请刷新后重试")
        text_items = [item for item in window if item.get("kind") == "text" and
                      isinstance(item.get("text"), str) and item["text"].strip()]
        context_items = text_items[-8:]
        while len(context_items) > 1 and any(len(item["text"]) > 4000 for item in context_items):
            context_items.pop(0)
        if context_items and len(context_items[-1]["text"]) > 4000:
            raise ForecastRequestError(422, "content-too-long", "这段内容过长，请缩短草稿或稍后重试")
        context = [{"id": item["id"], "side": item["side"], "text": item["text"],
                    "time": item.get("time", 0)} for item in context_items]
        if not context:
            raise ForecastRequestError(422, "no-text-context", "最近对话没有可用于预测的文字消息")
        fingerprint = self._forecast_fingerprint(actual_account, workdir, user, version, draft, window)
        with self.forecast_lock:
            cached = self.forecast_cache.get(fingerprint)
            if cached is not None:
                self.forecast_cache.move_to_end(fingerprint)
            flight = self.forecast_flights.get(fingerprint) if cached is None else None
            leader = cached is None and flight is None
            if leader:
                flight = {"event": threading.Event(), "error": None, "candidates": None}
                self.forecast_flights[fingerprint] = flight
        if cached is not None:
            candidates = cached
            self._verify_forecast_basis(actual_account, workdir, user, version, draft, fingerprint)
        elif not leader:
            flight["event"].wait()
            if flight["error"] is not None:
                raise flight["error"]
            candidates = flight["candidates"]
            self._verify_forecast_basis(actual_account, workdir, user, version, draft, fingerprint)
        else:
            try:
                session = actual_account + ":" + str(workdir) + ":" + user
                try:
                    forecast = self.analyzer.predict_reply(session, context, draft)
                except RuntimeError as exc:
                    if "ForecastInputTooLongError" in str(exc):
                        raise ForecastRequestError(422, "content-too-long", "这段内容过长，请缩短草稿或稍后重试") from exc
                    raise
                if forecast.get("analysisVersion") != version:
                    raise RuntimeError("reply forecast version mismatch")
                candidates = forecast["candidates"]
                # A message may be edited, withdrawn, or received while the model call waits.
                self._verify_forecast_basis(actual_account, workdir, user, version, draft, fingerprint)
                with self.forecast_lock:
                    self.forecast_cache[fingerprint] = candidates
                    self.forecast_cache.move_to_end(fingerprint)
                    while len(self.forecast_cache) > FORECAST_CACHE_LIMIT:
                        self.forecast_cache.popitem(last=False)
                flight["candidates"] = candidates
            except Exception as exc:
                flight["error"] = exc
                raise
            finally:
                with self.forecast_lock:
                    self.forecast_flights.pop(fingerprint, None)
                    flight["event"].set()
        return {"user": user, "account": actual_account, "requestId": request_id,
                "basisFingerprint": fingerprint, "lastMessageId": last_message_id,
                "candidates": candidates}

    def _schedule_recent(self, key, store, job, scope, limit, standalone=False):
        state = self.recent_windows.get(key)
        if state is not None:
            state["limit"] = max(state["limit"], limit)
            if state["iterator"] is not None:
                state["rerun"] = True
            return
        counts = {"total": 0, "processed": 0}
        self.recent_windows[key] = {"iterator": None, "counts": counts, "limit": limit,
                                    "rerun": False, "job": job, "background_pending": standalone}
        job["recent"] = {"id": uuid.uuid4().hex, "status": "queued", "total": 0, "processed": 0}
        self._enqueue((key, "recent-window", limit, store, job, scope), interactive=True)

    def start(self, user, mode, limit):
        account, workdir, store = self._scoped_identity()
        version = self.analyzer.analysis_version()
        key = (account, str(store.path), user, version)
        with self.jobs_lock:
            current = self.jobs.get(key)
            if current and (current["status"] in ("queued", "running") or key in self.recent_windows):
                if mode == "recent":
                    self._schedule_recent(key, store, current, (account, workdir), limit)
                    return dict(current)
                if (mode == "incremental" and key in self.recent_windows and
                        current["status"] == "done"):
                    current["requested"] = {"mode": "incremental", "limit": None}
                    self.recent_windows[key]["background_pending"] = True
                    return dict(current)
                if mode == "incremental" and current["requested"]["mode"] != "incremental":
                    current["requested"] = {"mode": "incremental", "limit": None}
                    if key in self.recent_windows and current["status"] == "done":
                        self.recent_windows[key]["background_pending"] = True
                    elif (not self.batch_engine and key not in self.recent_windows and
                          not self._stored_progress(account, user, version, store)["complete"]):
                        self.priority_recent[key] = max(self.priority_recent.get(key, 0), 80)
                elif mode == "incremental" and current["requested"]["mode"] == "incremental":
                    self.incremental_recheck.add(key)
                elif mode == "history" and current["requested"]["mode"] != "incremental" and scope_rank(limit) > scope_rank(current["requested"]["limit"]):
                    current["requested"] = {"mode": "history", "limit": limit}
                    if key in self.recent_windows and current["status"] == "done":
                        self.recent_windows[key]["background_pending"] = True
                    if limit == "all" and not self.batch_engine:
                        self.priority_recent[key] = max(self.priority_recent.get(key, 0), 80)
                return dict(current)
            job = {"id": uuid.uuid4().hex, "status": "queued", "total": 0, "processed": 0,
                   "requested": {"mode": mode, "limit": limit}}
            self.jobs[key] = job
            if mode == "recent":
                self._schedule_recent(key, store, job, (account, workdir), limit, standalone=True)
                return dict(job)
            if (not self.batch_engine and
                    ((mode == "incremental" and not self._stored_progress(account, user, version, store)["complete"]) or
                     (mode == "history" and limit == "all"))):
                self.priority_recent[key] = 80
            self._enqueue((key, mode, limit, store, job, (account, workdir)))
            return dict(job)

    def _analyze_item(self, account, user, version, store, context, item, scope=None, defer=False,
                      fine=False, portrait_context=None):
        started = time.perf_counter()
        try:
            session = account + ":" + str(store.path) + ":" + user
            response = (self.analyzer.analyze(session, context, item["id"],
                                              portraitContext=portrait_context, messageLabelsOnly=True)
                        if fine else self.analyzer.analyze(session, context, item["id"]))
        except RuntimeError as exc:
            if str(exc) != "ObservedTextTooLongError":
                raise
            if defer:
                return {"skip": "ObservedTextTooLongError"}
            if scope is not None:
                self._assert_scope(scope)
            (store.skip_fine if fine else store.skip)(account, user, version, item,
                                                       "ObservedTextTooLongError")
            return
        inferred = time.perf_counter()
        if response.get("analysisVersion") != version:
            raise RuntimeError("analysis response version mismatch")
        label_schema = response.get("labelSchema")
        if fine and label_schema != FINE_LABEL_SCHEMA:
            raise RuntimeError("fine label schema mismatch")
        if label_schema is not None and not isinstance(label_schema, str):
            raise RuntimeError("invalid label schema")
        if fine:
            if "groundedIntent" not in response:
                raise RuntimeError("missing grounded intent")
            grounded_intent = response["groundedIntent"]
            if grounded_intent is not None and (
                not isinstance(grounded_intent, dict) or
                set(grounded_intent) != {"label", "evidenceKind"} or
                not isinstance(grounded_intent.get("label"), str) or
                not isinstance(grounded_intent.get("evidenceKind"), str) or
                grounded_intent["evidenceKind"] not in
                GROUNDED_INTENT_EVIDENCE.get(grounded_intent["label"], set())
            ):
                raise RuntimeError("invalid grounded intent")
        elif "groundedIntent" in response:
            raise RuntimeError("grounded intent in portrait result")
        for field in ("emotion", "intent"):
            distribution = response.get(field)
            if not isinstance(distribution, list) or not distribution or any(
                not isinstance(entry, dict) or not isinstance(entry.get("label"), str) or
                not isinstance(entry.get("probability"), (int, float)) or
                not math.isfinite(entry["probability"]) or not 0 <= entry["probability"] <= 1
                for entry in distribution
            ):
                raise RuntimeError("invalid model " + field)
        broad = response.get("intentBroad") or []
        if not isinstance(broad, list) or any(
            not isinstance(entry, dict) or not isinstance(entry.get("label"), str) or
            not isinstance(entry.get("probability"), (int, float)) or
            not math.isfinite(entry["probability"]) or not 0 <= entry["probability"] <= 1
            for entry in broad
        ):
            raise RuntimeError("invalid broad intent")
        expression = response.get("expression", [])
        if not isinstance(expression, list) or any(
            not isinstance(entry, dict) or not isinstance(entry.get("label"), str) or
            not isinstance(entry.get("probability"), (int, float)) or
            not math.isfinite(entry["probability"]) or not 0 <= entry["probability"] <= 1
            for entry in expression
        ):
            raise RuntimeError("invalid expression distribution")
        playful_intent = response.get("playfulIntent", [])
        if not isinstance(playful_intent, list) or any(
            not isinstance(entry, dict) or not isinstance(entry.get("label"), str) or
            not entry["label"].startswith("playful:") or
            not isinstance(entry.get("probability"), (int, float)) or isinstance(entry["probability"], bool) or
            not math.isfinite(entry["probability"]) or not 0 <= entry["probability"] <= 1
            for entry in playful_intent
        ):
            raise RuntimeError("invalid playful intent distribution")
        result = {field: response[field] for field in
                  ("emotion", "intent", "emotionLabel", "intentLabel", "emotionP", "intentP", "analysisVersion")}
        result["intentBroad"] = broad
        if label_schema is not None:
            result["labelSchema"] = label_schema
        if fine:
            result["groundedIntent"] = grounded_intent
        result["expression"] = expression
        result["playfulIntent"] = playful_intent
        result["styleEvidence"] = validate_style_evidence(response.get("styleEvidence"))
        result["personalityEvidence"] = validate_personality_evidence(response.get("personalityEvidence"))
        score = response.get("score")
        if item["side"] == "other" and (not isinstance(score, (float, int)) or not -1 <= score <= 1):
            raise RuntimeError("missing relationship score")
        result.update({"state": "done", "score": score if item["side"] == "other" else None})
        if defer:
            # The incremental caller must scope-verify the whole pending batch before saving.
            return {"result": result, "started": started, "inferred": inferred,
                    "modelMs": float(response.get("_modelMs") or (inferred-started)*1000)}
        if scope is not None:
            self._assert_scope(scope)
        verified = time.perf_counter()
        (store.save_fine if fine else store.save)(account, user, version, item, result)
        finished = time.perf_counter()
        with self.jobs_lock:
            metrics = self.performance.setdefault((account, user, version), {})
            defaults = {
                "count": 0, "modelMs": 0.0, "requestMs": 0.0, "verifyMs": 0.0,
                "saveMs": 0.0, "betweenMs": 0.0, "lastFinished": started,
            }
            for name, value in defaults.items():
                metrics.setdefault(name, value)
            metrics["count"] += 1
            metrics["modelMs"] += float(response.get("_modelMs") or (inferred-started)*1000)
            metrics["requestMs"] += (inferred-started)*1000
            metrics["verifyMs"] += (verified-inferred)*1000
            metrics["saveMs"] += (finished-verified)*1000
            metrics["betweenMs"] += max(0.0, (started-metrics["lastFinished"])*1000)
            metrics["lastFinished"] = finished

    def _history_pages(self, user, highwater, scope=None):
        after = None
        while True:
            if scope is not None:
                self._assert_scope(scope)
            page, cursor = self.source.history_page(user, highwater, after)
            if scope is not None:
                self._assert_scope(scope)
            if cursor is None:
                return
            if after is not None and cursor <= after:
                raise RuntimeError("history cursor did not advance")
            yield page
            after = cursor

    def _take_recent_priority(self, key):
        with self.jobs_lock:
            return self.priority_recent.pop(key, 0)

    def _fine_portrait_context(self, account, user, version, store, item):
        if not self.batch_engine:
            return None
        group = user.endswith("@chatroom")
        member = item.get("senderId") if group else None
        if group and not member:
            return None
        saved = self.batch_engine.snapshot(account, user, version, store, member)
        if not saved:
            return None
        state = saved["state"]
        count = int(state.get("targetCount") or 0)
        if count < 3:
            return None
        parts = [f"画像{count}条"]
        traits = sorted(traits_from_state(state), key=lambda item: item["val"], reverse=True)
        parts.extend(f"{item['label'][:4]}{item['val']}" for item in traits[:2])
        broad = state.get("broad") or {}
        if broad:
            parts.append(f"常见意图{str(max(broad, key=broad.get))[:6]}")
        mood = mood_from_progress(state)
        if mood and mood.get("label"):
            parts.append(f"情绪{str(mood['label'])[:4]}")
        return "；".join(parts)[:60]

    def _run_fine_recent(self, account, user, version, store, job, scope, limit):
        self._assert_scope(scope)
        window = self.source.messages(user, limit + 3)
        self._assert_scope(scope)
        selected = [(index, item) for index, item in enumerate(window)
                    if index >= len(window) - limit and item["side"] == "other" and
                    item["kind"] == "text" and item["text"].strip()]
        known = store.fine_known(account, user, version, [item["id"] for _index, item in selected])
        job["total"] = len(selected)
        job["processed"] = sum(item["id"] in known for _index, item in selected)
        contexts = {}
        since_yield = 0
        for index, item in reversed(selected):
            if item["id"] in known:
                continue
            subject = item.get("senderId") if user.endswith("@chatroom") else user
            if subject not in contexts:
                contexts[subject] = self._fine_portrait_context(account, user, version, store, item)
            self._analyze_item(account, user, version, store,
                               window[max(0, index - 3):index + 1], item, scope,
                               fine=True, portrait_context=contexts[subject])
            known.add(item["id"])
            job["processed"] += 1
            since_yield += 1
            if since_yield >= 8 or self._interactive_waiting():
                since_yield = 0
                yield

    def _run_visible_priority(self, account, user, version, store, job, scope,
                               highwater, cached_ids, counted_ids, processed_ids, limit):
        if not limit:
            return
        if self.batch_engine:
            yield from self._run_fine_recent(account, user, version, store, job, scope, limit)
            return
        self._assert_scope(scope)
        window = self.source.messages(user, limit + 3)
        self._assert_scope(scope)
        start = max(0, len(window) - limit)
        since_yield = 0
        order = sorted(range(start, len(window)),
                       key=lambda index: (window[index]["side"] != "other", -index))
        for index in order:
            item = window[index]
            analyzed = False
            if ((highwater is None or tuple(item["_sort"]) <= highwater) and
                    item["kind"] == "text" and item["text"].strip()):
                stable_id = item["id"]
                if stable_id not in counted_ids:
                    counted_ids.add(stable_id)
                    job["total"] += 1
                if stable_id not in cached_ids and not store.has(account, user, version, stable_id):
                    self._analyze_item(account, user, version, store,
                                       window[max(0, index - 3):index + 1], item, scope)
                    analyzed = True
                cached_ids.add(stable_id)
                if stable_id not in processed_ids:
                    processed_ids.add(stable_id)
                    job["processed"] += 1
            if analyzed:
                since_yield += 1
                if since_yield >= 8 or self._interactive_waiting():
                    since_yield = 0
                    yield

    def _infer_quoted_batch(self, account, user, version, store, scope, subject, batches, items):
        """Commit an ordered quote-only target batch, including partial-window resumes."""
        context = self.source.preceding_text_context(user, tuple(items[0]["_sort"]))
        remaining = items
        while remaining:
            known = self.batch_engine.known(account, user, version, store, subject, remaining)
            first = next((index for index, item in enumerate(remaining) if item["id"] not in known), None)
            if first is None:
                batches.advance_quoted_backfill(account, user, version, subject,
                                                tuple(remaining[-1]["_sort"]))
                return
            if first:
                batches.advance_quoted_backfill(account, user, version, subject,
                                                tuple(remaining[first-1]["_sort"]))
                remaining = remaining[first:]
            self._assert_scope(scope)
            cursor, offset, context = self.batch_engine.infer(
                account, user, version, store, scope, subject, remaining, context, advance=False)
            completed = [item for item in remaining if tuple(item["_sort"]) < cursor or
                         tuple(item["_sort"]) == cursor and not offset]
            if completed:
                batches.advance_quoted_backfill(account, user, version, subject,
                                                tuple(completed[-1]["_sort"]))
            remaining = [item for item in remaining if tuple(item["_sort"]) > cursor or
                         offset and tuple(item["_sort"]) == cursor]
            yield

    def _run_quoted_backfill(self, account, user, version, store, scope, member=None):
        """Add only previously skipped quoted text inside the saved portrait cursor."""
        if not self.batch_engine:
            return
        subject = self.batch_engine.subject(user, member)
        saved = self.batch_engine.ensure(account, user, version, store, scope, member)
        if saved["cursor"] is None:
            return
        batches = self.batch_engine.store(store)
        checkpoint = batches.begin_quoted_backfill(account, user, version, subject, saved["cursor"])
        if checkpoint["complete"]:
            return
        after = checkpoint["cursor"]
        while True:
            self._assert_scope(scope)
            page, next_after = self.source.quoted_history_page(
                user, checkpoint["ceiling"], after, member=member)
            self._assert_scope(scope)
            if next_after is None:
                batches.advance_quoted_backfill(account, user, version, subject, complete=True)
                return
            if after is not None and next_after <= after:
                raise RuntimeError("quoted backfill cursor did not advance")
            eligible = [item for item in page if item["kind"] == "text" and item["text"].strip()]
            known = self.batch_engine.known(account, user, version, store, subject, eligible)
            pending, characters = [], 0
            for item in page:
                position = tuple(item["_sort"])
                if item["id"] in known or item["kind"] != "text" or not item["text"].strip():
                    continue
                if member is not None and item["senderId"] != member:
                    continue
                if self.batch_engine.target(item, subject):
                    if pending and (len(pending) >= 12 or characters + len(item["text"]) > 3000):
                        yield from self._infer_quoted_batch(account, user, version, store, scope,
                                                            subject, batches, pending)
                        pending, characters = [], 0
                    pending.append(item)
                    characters += len(item["text"])
                elif user.endswith("@chatroom") and member is None:
                    if pending:
                        yield from self._infer_quoted_batch(account, user, version, store, scope,
                                                            subject, batches, pending)
                        pending, characters = [], 0
                    # Whole-room statistics include the user's own text, without
                    # assigning it a relationship or personality inference.
                    length = len(item["text"])
                    record = {"id": item["id"], "position": list(position),
                              "senderId": item["senderId"], "side": item["side"],
                              "target": False, "startOffset": 0, "endOffset": length,
                              "textLength": length, "complete": True}
                    batch_id = hashlib.sha256(json.dumps(
                        [account, user, version, subject, "quoted-self", item["id"]],
                        ensure_ascii=False).encode()).hexdigest()
                    current = batches.load(account, user, version, subject)
                    self._assert_scope(scope)
                    batches.commit(account, user, version, subject, batch_id=batch_id,
                                   consumed=[record], cursor=current["cursor"],
                                   char_offset=current["charOffset"], context=current["context"],
                                   result=None, is_group=True, advance=False)
                    batches.advance_quoted_backfill(account, user, version, subject, position)
            if pending:
                yield from self._infer_quoted_batch(account, user, version, store, scope,
                                                    subject, batches, pending)
            batches.advance_quoted_backfill(account, user, version, subject, next_after)
            after = next_after
            if self._interactive_waiting():
                yield

    def _run_all_history(self, account, user, version, store, job, scope, key):
        if self.batch_engine:
            yield from self._run_quoted_backfill(account, user, version, store, scope)
            yield from self.batch_engine.incremental(account, user, version, store, job, scope, key)
            return
        self._assert_scope(scope)
        highwater = self.source.history_highwater(user)
        self._assert_scope(scope)
        cached_ids = store.ids(account, user, version)
        counted_ids = set()
        processed_ids = set()
        seen = set()
        first = last = None
        job["total"] = job["processed"] = 0
        job["scope"] = {"mode": "history", "limit": "all", "first": None, "last": None}
        yield from self._run_visible_priority(account, user, version, store, job, scope, highwater,
                                              cached_ids, counted_ids, processed_ids,
                                              self._take_recent_priority(key) or 80)
        context = deque(maxlen=3)
        since_yield = 0
        for page in self._history_pages(user, highwater, scope):
            for item in page:
                priority = self._take_recent_priority(key)
                if priority:
                    yield from self._run_visible_priority(account, user, version, store, job, scope, None,
                                                          cached_ids, counted_ids, processed_ids, priority)
                stable_id = item["id"]
                if stable_id in seen:
                    raise RuntimeError("history snapshot contains duplicate message")
                seen.add(stable_id)
                first = first or stable_id
                last = stable_id
                analyzed = False
                if item["kind"] == "text" and item["text"].strip():
                    if stable_id not in counted_ids:
                        counted_ids.add(stable_id)
                        job["total"] += 1
                    if stable_id not in cached_ids and not store.has(account, user, version, stable_id):
                        self._analyze_item(account, user, version, store, [*context, item], item, scope)
                        analyzed = True
                    cached_ids.add(stable_id)
                    if stable_id not in processed_ids:
                        processed_ids.add(stable_id)
                        job["processed"] += 1
                context.append(item)
                if analyzed:
                    since_yield += 1
                    if since_yield >= 8 or self._interactive_waiting():
                        job["scope"] = {"mode": "history", "limit": "all", "first": first, "last": last}
                        since_yield = 0
                        yield
            job["scope"] = {"mode": "history", "limit": "all", "first": first, "last": last}
            if self._interactive_waiting():
                yield
        priority = self._take_recent_priority(key)
        if priority:
            yield from self._run_visible_priority(account, user, version, store, job, scope, None,
                                                  cached_ids, counted_ids, processed_ids, priority)
        job["scope"] = {"mode": "history", "limit": "all", "first": first, "last": last}

    def _run_incremental(self, account, user, version, store, job, scope, key):
        if self.batch_engine:
            yield from self._run_quoted_backfill(account, user, version, store, scope)
            yield from self.batch_engine.incremental(account, user, version, store, job, scope, key)
            return
        self._assert_scope(scope)
        progress = store.progress(account, user, version)
        cursor = progress["cursor"]
        context = deque(progress["context"], maxlen=3)
        job["phase"] = "incremental" if progress["complete"] else "baseline"
        job["checkpointComplete"] = False
        job["total"] = job["processed"] = progress["eligible"]
        job["scope"] = {"mode": "incremental", "limit": None,
                        "first": None, "last": None}
        highwater = self.source.history_highwater(user)
        self._assert_scope(scope)
        priority = self._take_recent_priority(key)
        if priority:
            priority_job = {"total": 0, "processed": 0}
            yield from self._run_visible_priority(account, user, version, store, priority_job,
                                                  scope, None, set(), set(), set(), priority)
        since_yield = 0
        pending = []
        pending_inferences = 0

        def flush():
            nonlocal cursor, pending_inferences
            if not pending:
                return
            verify_started = time.perf_counter()
            self._assert_scope(scope)
            verified = time.perf_counter()
            saved = []
            for item, position, saved_context, prepared in pending:
                if prepared is not None:
                    if "skip" in prepared:
                        store.skip(account, user, version, item, prepared["skip"])
                    else:
                        save_started = time.perf_counter()
                        store.save(account, user, version, item, prepared["result"])
                        saved.append((prepared, (time.perf_counter() - save_started) * 1000))
                # Results and skips always reach durable storage before their scan cursor.
                store.advance(account, user, version, position, saved_context, item)
                cursor = position
                if item["kind"] == "text" and item["text"].strip():
                    job["total"] += 1
                    job["processed"] += 1
                job["scope"]["last"] = item["id"]
                if job["scope"]["first"] is None:
                    job["scope"]["first"] = item["id"]
            finished = time.perf_counter()
            with self.jobs_lock:
                metrics = self.performance.setdefault((account, user, version), {
                    "count": 0, "modelMs": 0.0, "requestMs": 0.0, "verifyMs": 0.0,
                    "saveMs": 0.0, "betweenMs": 0.0, "lastFinished": verify_started,
                })
                metrics["verifyMs"] += (verified - verify_started) * 1000
                if saved:
                    metrics["betweenMs"] += max(0.0, (saved[0][0]["started"] - metrics["lastFinished"]) * 1000)
                    for index, (prepared, save_ms) in enumerate(saved):
                        metrics["count"] += 1
                        metrics["modelMs"] += prepared["modelMs"]
                        metrics["requestMs"] += (prepared["inferred"] - prepared["started"]) * 1000
                        metrics["saveMs"] += save_ms
                        if index:
                            metrics["betweenMs"] += max(0.0, (prepared["started"] - saved[index - 1][0]["inferred"]) * 1000)
                    metrics["lastFinished"] = finished
            pending.clear()
            pending_inferences = 0

        while highwater is not None and (cursor is None or cursor < highwater):
            self._assert_scope(scope)
            page, next_cursor = self.source.history_page(user, highwater, cursor)
            self._assert_scope(scope)
            if next_cursor is None:
                break
            if cursor is not None and next_cursor <= cursor:
                raise RuntimeError("history cursor did not advance")
            scan_cursor = cursor
            for item in page:
                priority = self._take_recent_priority(key)
                if priority:
                    flush()
                    priority_job = {"total": 0, "processed": 0}
                    yield from self._run_visible_priority(account, user, version, store,
                                                          priority_job, scope, None, set(), set(),
                                                          set(), priority)
                position = tuple(item["_sort"])
                if scan_cursor is not None and position <= scan_cursor:
                    continue
                analyzed = False
                prepared = None
                if item["kind"] == "text" and item["text"].strip():
                    if not store.has(account, user, version, item["id"]):
                        prepared = self._analyze_item(account, user, version, store,
                                                      [*context, item], item, defer=True)
                        analyzed = True
                context.append(item)
                pending.append((item, position, list(context), prepared))
                scan_cursor = position
                if analyzed:
                    pending_inferences += 1
                    since_yield += 1
                interactive = self._interactive_waiting()
                if pending_inferences >= 4 or interactive or since_yield >= 8:
                    flush()
                if since_yield >= 8 or interactive:
                    since_yield = 0
                    yield
            flush()
            if cursor is None or next_cursor > cursor:
                self._assert_scope(scope)
                store.advance(account, user, version, next_cursor, context)
                cursor = next_cursor
            if self._interactive_waiting():
                yield
        self._assert_scope(scope)
        final_cursor = max(cursor, highwater) if cursor is not None and highwater is not None else cursor or highwater
        store.advance(account, user, version, final_cursor, context, complete=True)
        job["checkpointComplete"] = True

    def _run_finite_history(self, account, user, version, store, job, scope, limit):
        if self.batch_engine:
            yield from self.batch_engine.recent(account, user, version, store, job, scope, limit)
            return
        window = self.source.messages(user, limit + 3)
        self._assert_scope(scope)
        selected = window[-limit:]
        cached = store.ids(account, user, version)
        eligible = [item for item in selected if item["kind"] == "text" and item["text"].strip()]
        pending = [item for item in eligible if item["id"] not in cached]
        positions = {message["id"]: index for index, message in enumerate(window)}
        job["total"] = len(eligible)
        job["processed"] = len(eligible) - len(pending)
        job["scope"] = {"mode": "history", "limit": limit,
                        "first": selected[0]["id"] if selected else None,
                        "last": selected[-1]["id"] if selected else None}
        since_yield = 0
        for item in pending:
            analyzed = not store.has(account, user, version, item["id"])
            if analyzed:
                index = positions[item["id"]]
                context = window[max(0, index - 3):index + 4]
                self._analyze_item(account, user, version, store, context, item, scope)
            job["processed"] += 1
            if analyzed:
                since_yield += 1
                if since_yield >= 8 or self._interactive_waiting():
                    since_yield = 0
                    yield
        self._assert_scope(scope)

    def _run_recent_turn(self, key, store, job, scope):
        account, _, user, version = key
        try:
            self._assert_scope(scope)
            with self.jobs_lock:
                state = self.recent_windows.get(key)
                if state is None or state["job"] is not job:
                    return
                if state["iterator"] is None:
                    state["counts"] = {"total": 0, "processed": 0}
                    state["iterator"] = self._run_visible_priority(
                        account, user, version, store, state["counts"], scope,
                        None, set(), set(), set(), state["limit"])
                job["recent"] = {**job["recent"], "status": "running"}
                if job["requested"]["mode"] == "recent":
                    job["status"] = "running"
                    job["total"] = state["counts"]["total"]
                    job["processed"] = state["counts"]["processed"]
                iterator = state["iterator"]
            try:
                next(iterator)
            except StopIteration:
                with self.jobs_lock:
                    state = self.recent_windows.get(key)
                    if state is None or state["job"] is not job:
                        return
                    counts = state["counts"]
                    if job["requested"]["mode"] == "recent":
                        job["total"] = counts["total"]
                        job["processed"] = counts["processed"]
                    if state["rerun"]:
                        state["iterator"] = None
                        state["rerun"] = False
                        job["recent"] = {**job["recent"], "status": "queued",
                                         "total": counts["total"], "processed": counts["processed"]}
                        self._enqueue((key, "recent-window", state["limit"], store, job, scope), interactive=True)
                    else:
                        job["recent"] = {**job["recent"], "status": "done",
                                         "total": counts["total"], "processed": counts["processed"]}
                        del self.recent_windows[key]
                        requested = job["requested"]
                        if state["background_pending"] and requested["mode"] != "recent":
                            job["status"] = "queued"
                            self._enqueue((key, requested["mode"], requested["limit"], store, job, scope))
                        elif requested["mode"] == "recent":
                            job["status"] = "done"
            else:
                with self.jobs_lock:
                    state = self.recent_windows.get(key)
                    if state is None or state["job"] is not job:
                        return
                    counts = state["counts"]
                    if job["requested"]["mode"] == "recent":
                        job["total"] = counts["total"]
                        job["processed"] = counts["processed"]
                    job["recent"] = {**job["recent"], "status": "running",
                                     "total": counts["total"], "processed": counts["processed"]}
                    self._enqueue((key, "recent-window", state["limit"], store, job, scope), interactive=True)
        except Exception as exc:
            with self.jobs_lock:
                state = self.recent_windows.get(key)
                background_pending = state is not None and state["job"] is job and state["background_pending"]
                if state is not None and state["job"] is job:
                    del self.recent_windows[key]
                job["recent"] = {**job.get("recent", {}), "status": "error", "error": str(exc)[:200]}
                if job["requested"]["mode"] == "recent" or background_pending:
                    job["status"] = "error"
                    job["error"] = str(exc)[:200]

    def _worker(self):
        while True:
            _, _, task = self.tasks.get()
            if task is None:
                self.tasks.task_done()
                return
            key, mode, limit, store, job, source_scope = task
            if mode == "batch-subject" and self.batch_engine:
                try:
                    member_key = (*key, limit)
                    iterator = self.quoted_backfill_iterators.get(member_key)
                    if iterator is None:
                        account, _path, user, version = key
                        iterator = self._run_quoted_backfill(account, user, version, store,
                                                              source_scope, limit)
                        self.quoted_backfill_iterators[member_key] = iterator
                    try:
                        next(iterator)
                    except StopIteration:
                        self.quoted_backfill_iterators.pop(member_key, None)
                        self.batch_engine.member_turn(key, limit, store, job, source_scope)
                    else:
                        job["status"] = "queued"
                        self._enqueue(task)
                except Exception as exc:
                    self.quoted_backfill_iterators.pop((*key, limit), None)
                    job["status"] = "error"
                    job["error"] = str(exc)[:200]
                finally:
                    self.tasks.task_done()
                continue
            if mode == "recent-window":
                try:
                    self._run_recent_turn(key, store, job, source_scope)
                finally:
                    self.tasks.task_done()
                continue
            account, _, user, version = key
            terminal = True
            try:
                self._assert_scope(source_scope)
                with self.jobs_lock:
                    requested = job["requested"]
                    if requested["mode"] == "incremental":
                        mode, limit = "incremental", None
                    elif requested["mode"] == "history" and scope_rank(requested["limit"]) > scope_rank(limit):
                        mode, limit = "history", requested["limit"]
                    job["status"] = "running"
                if mode in ("incremental", "history"):
                    iterator = self.history_iterators.get(key)
                    if iterator is not None and self.history_iterator_modes.get(key) != (mode, limit):
                        iterator.close()
                        self.history_iterators.pop(key, None)
                        self.history_iterator_modes.pop(key, None)
                        iterator = None
                    if iterator is None:
                        iterator = (self._run_incremental(account, user, version, store, job,
                                                          source_scope, key) if mode == "incremental" else
                                    self._run_all_history(account, user, version, store, job,
                                                          source_scope, key) if limit == "all" else
                                    self._run_finite_history(account, user, version, store, job,
                                                             source_scope, limit))
                        self.history_iterators[key] = iterator
                        self.history_iterator_modes[key] = (mode, limit)
                    try:
                        next(iterator)
                    except StopIteration:
                        with self.jobs_lock:
                            requested = job["requested"]
                            if mode == "incremental" and key in self.incremental_recheck:
                                self.incremental_recheck.discard(key)
                                self.history_iterators.pop(key, None)
                                self.history_iterator_modes.pop(key, None)
                                job["status"] = "queued"
                                terminal = False
                                self._enqueue((key, "incremental", None, store, job, source_scope))
                            elif requested["mode"] == "incremental" and mode != "incremental":
                                self.history_iterators.pop(key, None)
                                self.history_iterator_modes.pop(key, None)
                                job["status"] = "queued"
                                terminal = False
                                self._enqueue((key, "incremental", None, store, job, source_scope))
                            elif (mode == "history" and requested["mode"] == "history" and
                                  scope_rank(requested["limit"]) > scope_rank(limit)):
                                self.history_iterators.pop(key, None)
                                self.history_iterator_modes.pop(key, None)
                                job["status"] = "queued"
                                terminal = False
                                self._enqueue((key, "history", requested["limit"], store, job, source_scope))
                            else:
                                job["status"] = "done"
                    else:
                        terminal = False
                        self._enqueue((key, mode, limit, store, job, source_scope))
                    continue
                raise RuntimeError("unsupported analysis mode")
            except Exception as exc:
                with self.jobs_lock:
                    job["status"] = "error"
                    job["error"] = str(exc)[:200]
            finally:
                if terminal:
                    self.history_iterators.pop(key, None)
                    self.history_iterator_modes.pop(key, None)
                    with self.jobs_lock:
                        self.priority_recent.pop(key, None)
                        self.incremental_recheck.discard(key)
                self.tasks.task_done()

    def analysis(self, user):
        account, workdir, store = self._scoped_identity()
        version = self.analyzer.analysis_version()
        self._focus((account, str(store.path), user, version))
        progress = self._stored_progress(account, user, version, store)
        saved = self.batch_engine.snapshot(account, user, version, store) if self.batch_engine else None
        summary = saved["state"] if saved else store.summary(account, user, version)
        results = store.recent(account, user, version)
        results.update(store.fine_view(account, user, version))
        group = user.endswith("@chatroom")
        with self.jobs_lock:
            job = dict(self.jobs.get((account, str(store.path), user, version),
                                     {"id": "", "status": "idle", "total": progress["eligible"],
                                      "processed": progress["eligible"],
                                      "phase": "incremental" if progress["complete"] else "baseline",
                                      "checkpointComplete": progress["complete"]}))
            performance = {name: round(value, 2) for name, value in
                           self.performance.get((account, user, version), {}).items()
                            if name != "lastFinished"}
        if self.batch_engine and job.get("requested", {}).get("mode") == "recent":
            job["phase"] = "incremental" if progress["complete"] else "baseline"
            job["checkpointComplete"] = progress["complete"]
        self._assert_scope((account, workdir))
        return {"results": {id: {key: val for key, val in result.items() if key != "score"}
                            for id, result in results.items()},
                "job": job, "affinity": None if group else affinity_from_progress(summary),
                "affinityCount": summary["scoreCount"] if not group else 0,
                "modelState": self.analyzer.model["state"],
                "modelProvider": self.analyzer.model.get("provider"), "analysisVersion": version,
                "mood": mood_from_progress(summary), "performance": performance,
                "analysisUnit": "message",
                "account": account}

    def _legacy_profile_state(self, account, user, version, store, workdir, subject):
        def read_texts(refs):
            self._assert_scope((account, workdir))
            if hasattr(self.source, "texts_for_refs"):
                texts = dict(self.source.texts_for_refs(user, refs, with_ids=True))
            else:
                texts = {}
                selected = {stable_id for _shard, _local, stable_id in refs}
                for page in self._history_pages(user, self.source.history_highwater(user), (account, workdir)):
                    texts.update((item["id"], item["text"]) for item in page
                                 if item["id"] in selected and item["kind"] == "text")
            self._assert_scope((account, workdir))
            return texts
        return store.profile_state(account, user, version, subject, read_texts)

    def profile(self, user, member=None, retry=False):
        account, workdir, store = self._scoped_identity()
        version = self.analyzer.analysis_version()
        group = user.endswith("@chatroom")
        selected = member or user
        subject = member if group else user
        if hasattr(self.source, "profile_metadata"):
            metadata = self.source.profile_metadata(user, member)
            contact, members = metadata["contact"], metadata["members"]
            count, text_count = metadata["count"], metadata["textCount"]
        else:
            group_count, group_text_count, members = self.source.stats(user)
            if member and (not group or member not in {item["id"] for item in members}):
                raise ValueError("unknown member")
            contact = self.source.contact(selected)
            count, text_count = (self.source.stats(user, subject)[:2] if subject else
                                 (group_count, group_text_count))
        def read_legacy_texts(refs):
            self._assert_scope((account, workdir))
            if hasattr(self.source, "texts_for_refs"):
                texts = dict(self.source.texts_for_refs(user, refs, with_ids=True))
            else:
                texts = {}
                analyzed_ids = {stable_id for _shard, _local_id, stable_id in refs}
                for page in self._history_pages(user, self.source.history_highwater(user), (account, workdir)):
                    texts.update((message["id"], message["text"]) for message in page
                                 if message["id"] in analyzed_ids and message["kind"] == "text")
            self._assert_scope((account, workdir))
            return texts
        if self.batch_engine:
            saved = self.batch_engine.ensure(account, user, version, store, (account, workdir), member)
            state = saved["state"]
            backfill_pending = self.batch_engine.store(store).quoted_backfill_pending(
                account, user, version, self.batch_engine.subject(user, member), saved["cursor"])
            if member:
                profile_job = self.batch_engine.request_member(account, user, version, store,
                                                                (account, workdir), member,
                                                                max(text_count, state["count"] + 1)
                                                                if backfill_pending else text_count, retry)
            else:
                self.batch_engine.focused_member = None
                key = (account, str(store.path), user, version)
                self._focus(key)
                highwater = self.source.history_highwater(user)
                needs_work = (backfill_pending or not saved["complete"] or bool(saved["charOffset"]) or
                              highwater is not None and
                              (saved["cursor"] is None or highwater > tuple(saved["cursor"])))
                with self.jobs_lock:
                    current = dict(self.jobs.get(key, {}))
                    fine_active = key in self.recent_windows
                current_mode = current.get("requested", {}).get("mode")
                portrait_active = (current_mode in ("incremental", "history") and
                                   (current.get("status") in ("queued", "running") or
                                    current.get("status") == "error" and not retry) and
                                   (not fine_active or current.get("analysisUnit") == "batch"))
                if portrait_active:
                    profile_job = current
                elif needs_work:
                    if not (fine_active and current_mode == "incremental"):
                        current = self.start(user, "incremental", None)
                    profile_job = ({"status": "queued", "phase": "baseline" if not saved["complete"] else "incremental",
                                    "checkpointComplete": False} if fine_active else current)
                else:
                    profile_job = {"status": "done", "checkpointComplete": True}
                profile_job = {**{name: value for name, value in profile_job.items() if name != "recent"},
                               "analysisUnit": "batch"}
        else:
            state = store.profile_state(account, user, version, subject, read_legacy_texts)
            profile_job = None
        distributions = {field: [{"label": label, "probability": value / state["count"]}
                                 for label, value in state[field].items()] if state["count"] else []
                         for field in ("emotion", "intent")}
        mood = mood_from_progress(state)
        keywords = keywords_from_counts(state["words"])
        inference = None if group and not member else mbti_from_totals(
            state["targetCount"], state["supported"], state["axes"], version)
        traits = traits_from_state(state)
        summary = summary_from_aggregate(state["targetCount"], state["broad"], mood, keywords, group and not member)
        self._assert_scope((account, workdir))
        return {"username": selected, **contact, "isGroup": group, "members": members if group else [],
                "stats": {"messageCount": count, "textCount": text_count, "analyzedCount": state["count"],
                          "participantCount": (1 if count else 0) if subject else len(members)},
                "affinity": None if group else affinity_from_progress(state),
                **distributions, "keywords": keywords,
                "mood": mood, "mbti": inference["type"] if inference else None,
                "mbtiInference": inference, "traits": traits, "traitsBasis": "chat-behaviour",
                "summary": summary, "suggestions": [], "dataStatus": "analyzed" if state["count"] and state["count"] >= text_count else "partial" if state["count"] else "unanalyzed",
                **({"job": profile_job, "analysisUnit": "batch"} if self.batch_engine else {}),
                "account": account}
