"""Owned Advisor persistence: agent catalog config and per-account projection.

Two independent stores live here:

* :class:`AgentConfigStore` owns one small ``.local`` JSON document holding the
  agent cards and imported Skills. Writes are atomic (temp file + fsync +
  replace) and every mutation bumps the affected agent revision.
* :class:`AccountDatabase` owns a private SQLite projection per real account at
  ``.local/advisor-data/<sha256(account)>/advisor.sqlite3``. The saved thread
  transcript is an immutable UI projection of runtime output: messages are
  append-only, only run state rows are updated.

The native OpenCode state directory lives under the same account directory so
the parent's account clear removes it with the rest of the projection.

Every column that carries chat text — the transcript, the scoped request, the
imported WeChat records and their summaries — is sealed with
:class:`payload_crypto.PayloadCipher` before it reaches SQLite. Reading accepts
both a sealed value and a legacy plaintext one, so an existing projection keeps
working and turns into ciphertext on its next write.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
import shutil
import sqlite3
import stat
import threading
import time
import uuid
from pathlib import Path

from advisor_contracts import (
    MAX_AGENTS, MAX_AGENT_DESCRIPTION, MAX_AGENT_NAME, MAX_AGENT_WELCOME,
    MAX_AGENT_PROMPT, MAX_SKILLS, MAX_SKILL_CONTENT, MAX_SKILL_DESCRIPTION,
    MAX_SKILL_IDS, MAX_SKILL_NAME, MAX_HISTORY_THREADS, AdvisorError, builtin_agents, builtin_skill_ids, builtin_skills,
    default_welcome, new_identifier, normalize_agent_payload, normalize_skill, single_line,
    text_block, valid_enabled, valid_identifier, valid_request_id, valid_sha256,
)
from payload_crypto import ENVELOPE, PayloadCipher, PayloadUnreadable

SUPPORTED_CONFIG_VERSION = 2
MAX_IMPORT_REQUESTS = 200


class AdvisorPathError(RuntimeError):
    """An owned Advisor path is not a plain directory under its root."""


def _reparse(path):
    try:
        details = path.lstat()
    except FileNotFoundError:
        return False
    except OSError:
        return True
    if stat.S_ISLNK(details.st_mode):
        return True
    if getattr(details, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0):
        return True
    isjunction = getattr(os.path, "isjunction", None)
    return bool(isjunction and isjunction(path))


def _checked_root(root):
    root = Path(os.path.abspath(root))
    if _reparse(root):
        raise AdvisorPathError("advisor root is not a plain directory")
    return root


def _ensure_directory(root, target, *, leaf_file=False):
    """Create ``target`` under ``root`` after rejecting reparse components."""
    root = _checked_root(root)
    target = Path(os.path.abspath(target))
    if target != root and not target.is_relative_to(root):
        raise AdvisorPathError("advisor path escapes its root")
    for part in (target, *target.parents):
        if _reparse(part):
            raise AdvisorPathError("advisor path contains a reparse point")
        if part == root:
            break
    directory = target.parent if leaf_file else target
    directory.mkdir(parents=True, exist_ok=True)
    if _reparse(directory) or not directory.is_dir():
        raise AdvisorPathError("advisor path is not a plain directory")
    return target


def _write_json_atomic(path, document, commit_check=None):
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temporary.open("x", encoding="utf-8") as stream:
            json.dump(document, stream, ensure_ascii=False, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        if commit_check is not None:
            commit_check()
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _write_bytes_atomic(path, content):
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temporary.open("xb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _check_import_cancel(cancel_event):
    if cancel_event is not None and cancel_event.is_set():
        raise AdvisorError("stopping", "导入已取消")


class AgentConfigStore:
    """The owned ``.local/advisor/config.json`` agent/skill document."""

    def __init__(self, root):
        self.root = _checked_root(root)
        self.directory = self.root / ".local" / "advisor"
        self.path = self.directory / "config.json"
        self.backup_path = self.directory / "config.v1.backup.json"
        self.lock = threading.RLock()
        self._document = None
        self._legacy_bytes = None

    # -- loading / defaults -------------------------------------------------
    def _default_document(self):
        return {"version": SUPPORTED_CONFIG_VERSION,
                "agents": builtin_agents(), "skills": builtin_skills(),
                "deletedBuiltinSkillIds": [], "deletedBuiltinAgentIds": [], "importRequests": []}

    def _validate_agent(self, item):
        if not isinstance(item, dict) or not valid_identifier(item.get("id")):
            raise AdvisorError("config-invalid", "顾问配置已损坏")
        if type(item.get("builtin")) is not bool or type(item.get("enabled")) is not bool:
            raise AdvisorError("config-invalid", "顾问配置已损坏")
        result = {
            "id": item["id"],
            "name": single_line(item.get("name"), "name", MAX_AGENT_NAME),
            "description": single_line(item.get("description"), "description",
                                       MAX_AGENT_DESCRIPTION, allow_empty=True),
            "prompt": text_block(item.get("prompt"), "prompt", MAX_AGENT_PROMPT),
            "welcome": single_line(item.get("welcome", default_welcome(item["name"])), "welcome",
                                   MAX_AGENT_WELCOME, allow_empty=True),
            "skillIds": list(item.get("skillIds") or []),
            "enabled": item["enabled"],
            "builtin": item["builtin"],
            "revision": int(item.get("revision", 1)),
        }
        if "importedSkillId" in item:
            if not valid_identifier(item["importedSkillId"]):
                raise AdvisorError("config-invalid", "导入助手的技能关联已损坏")
            result["importedSkillId"] = item["importedSkillId"]
        return result

    def _validate_skill(self, item):
        if not isinstance(item, dict) or not valid_identifier(item.get("id")):
            raise AdvisorError("config-invalid", "顾问配置已损坏")
        if type(item.get("builtin")) is not bool:
            raise AdvisorError("config-invalid", "顾问配置已损坏")
        result = {
            "id": item["id"],
            "name": single_line(item.get("name"), "name", MAX_SKILL_NAME),
            "description": single_line(item.get("description"), "description",
                                       MAX_SKILL_DESCRIPTION, allow_empty=True),
            "content": text_block(item.get("content"), "content", MAX_SKILL_CONTENT),
            "builtin": item["builtin"],
        }
        if "package" in item:
            from advisor_packages import validate_package
            try:
                package = validate_package(item["package"])
                if item["builtin"] or package["entry"]["content"] != result["content"]:
                    raise AdvisorError("config-invalid", "导入技能包的正文已变化")
            except (AdvisorError, KeyError, TypeError, ValueError) as exc:
                raise AdvisorError("config-invalid", "导入技能包已损坏") from exc
            result["package"] = copy.deepcopy(package)
        return result

    def _validate_import_requests(self, value):
        if not isinstance(value, list) or len(value) > MAX_IMPORT_REQUESTS:
            raise AdvisorError("config-invalid", "导入请求记录已损坏")
        result, seen = [], set()
        for item in value:
            if not isinstance(item, dict):
                raise AdvisorError("config-invalid", "导入请求记录已损坏")
            try:
                request_id = valid_request_id(item.get("requestId"))
            except AdvisorError as exc:
                raise AdvisorError("config-invalid", "导入请求记录已损坏") from exc
            if (request_id is None or request_id in seen or not valid_sha256(item.get("fingerprint")) or
                    not valid_identifier(item.get("agentId")) or not valid_identifier(item.get("skillId"))):
                raise AdvisorError("config-invalid", "导入请求记录已损坏")
            seen.add(request_id)
            result.append({key: item[key] for key in ("requestId", "fingerprint", "agentId", "skillId")})
        return result

    def _load(self):
        if self._document is not None:
            return self._document
        if not os.path.lexists(self.path):
            self._document = self._default_document()
            return self._document
        if _reparse(self.path) or not self.path.is_file():
            raise AdvisorError("config-invalid", "顾问配置已损坏")
        try:
            saved_bytes = self.path.read_bytes()
            raw = json.loads(saved_bytes.decode("utf-8"))
        except (OSError, UnicodeError, ValueError) as exc:
            raise AdvisorError("config-invalid", "顾问配置已损坏") from exc
        if (not isinstance(raw, dict) or type(raw.get("version")) is not int or
                raw.get("version") not in (1, SUPPORTED_CONFIG_VERSION) or
                not isinstance(raw.get("agents"), list) or not isinstance(raw.get("skills"), list)):
            raise AdvisorError("config-invalid", "顾问配置已损坏")
        agents = [self._validate_agent(item) for item in raw["agents"]]
        skills = [self._validate_skill(item) for item in raw["skills"]]
        deleted_skills = raw.get("deletedBuiltinSkillIds", [])
        if (not isinstance(deleted_skills, list) or any(not isinstance(value, str) for value in deleted_skills) or
                len(set(deleted_skills)) != len(deleted_skills) or not set(deleted_skills) <= set(builtin_skill_ids())):
            raise AdvisorError("config-invalid", "顾问配置已损坏")
        deleted_agents = raw.get("deletedBuiltinAgentIds", [])
        builtin_ids = {agent["id"] for agent in builtin_agents()}
        if (not isinstance(deleted_agents, list) or any(not isinstance(value, str) for value in deleted_agents) or
                len(set(deleted_agents)) != len(deleted_agents) or not set(deleted_agents) <= builtin_ids):
            raise AdvisorError("config-invalid", "顾问配置已损坏")
        known_skills = {skill["id"] for skill in skills}
        packaged_skills = {skill["id"] for skill in skills if "package" in skill}
        for agent in agents:
            if len(agent["skillIds"]) > MAX_SKILL_IDS or len(set(agent["skillIds"])) != len(agent["skillIds"]):
                raise AdvisorError("config-invalid", "顾问配置已损坏")
            if not set(agent["skillIds"]) <= known_skills:
                raise AdvisorError("config-invalid", "顾问配置已损坏")
            if "importedSkillId" in agent and agent["importedSkillId"] not in packaged_skills:
                raise AdvisorError("config-invalid", "导入助手的技能关联已损坏")
        # Upgrade defaults without recreating a preset the user explicitly deleted.
        present = {agent["id"] for agent in agents}
        for index, preset in enumerate(builtin_agents()):
            if preset["id"] not in present and preset["id"] not in deleted_agents:
                preset["skillIds"] = [identifier for identifier in preset["skillIds"] if identifier not in deleted_skills]
                agents.insert(min(index, len(agents)), preset)
        present_skills = {skill["id"] for skill in skills}
        for index, preset in enumerate(builtin_skills()):
            if preset["id"] not in present_skills and preset["id"] not in deleted_skills:
                skills.insert(min(index, len(skills)), preset)
        self._document = {"version": SUPPORTED_CONFIG_VERSION, "agents": agents, "skills": skills,
                          "deletedBuiltinSkillIds": list(deleted_skills),
                          "deletedBuiltinAgentIds": list(deleted_agents),
                          "importRequests": self._validate_import_requests(raw.get("importRequests", []))}
        if raw["version"] == 1:
            self._legacy_bytes = saved_bytes
        return self._document

    def _commit(self, document, cancel_event=None):
        _check_import_cancel(cancel_event)
        _ensure_directory(self.root, self.directory)
        if self._legacy_bytes is not None:
            if _reparse(self.path) or not self.path.is_file() or self.path.read_bytes() != self._legacy_bytes:
                raise AdvisorError("config-invalid", "旧版配置已在迁移前变化，请重新载入")
            _ensure_directory(self.root, self.backup_path, leaf_file=True)
            if os.path.lexists(self.backup_path):
                if not self.backup_path.is_file() or self.backup_path.read_bytes() != self._legacy_bytes:
                    raise AdvisorError("config-invalid", "旧版配置备份与待迁移配置不一致")
            else:
                _write_bytes_atomic(self.backup_path, self._legacy_bytes)
        _write_json_atomic(self.path, document,
                           (lambda: _check_import_cancel(cancel_event)) if cancel_event is not None else None)
        self._document = document
        self._legacy_bytes = None

    # -- reads ---------------------------------------------------------------
    def agents(self):
        with self.lock:
            return copy.deepcopy(self._load()["agents"])

    def skills(self):
        with self.lock:
            return copy.deepcopy(self._load()["skills"])

    def agent(self, identifier):
        if not valid_identifier(identifier):
            raise AdvisorError("invalid-request", "invalid agent id")
        with self.lock:
            for item in self._load()["agents"]:
                if item["id"] == identifier:
                    return copy.deepcopy(item)
        return None

    # -- mutations -----------------------------------------------------------
    def save_agent(self, payload):
        agent = normalize_agent_payload(payload)
        with self.lock:
            document = copy.deepcopy(self._load())
            known_skills = {item["id"] for item in document["skills"]}
            if not set(agent["skillIds"]) <= known_skills:
                raise AdvisorError("skill-unknown", "选择的技能不在技能库中")
            identifier = agent["id"]
            found = next((item for item in document["agents"] if item["id"] == identifier), None)
            if found is None:
                if identifier is not None:
                    raise AdvisorError("agent-unknown", "agent 不存在")
                if len(document["agents"]) >= MAX_AGENTS:
                    raise AdvisorError("config-full", "agent 数量已达上限")
                found = {
                    "id": new_identifier("agent", uuid.uuid4().hex),
                    "name": agent["name"], "description": agent["description"],
                    "prompt": agent["prompt"], "skillIds": agent["skillIds"],
                    "welcome": agent["welcome"] if agent["welcome"] is not None else default_welcome(agent["name"]),
                    "enabled": True, "builtin": False, "revision": 1,
                }
                document["agents"].append(found)
            else:
                welcome = agent["welcome"]
                if welcome is None:
                    previous = found.get("welcome", default_welcome(found["name"]))
                    welcome = default_welcome(agent["name"]) if previous == default_welcome(found["name"]) else previous
                found.update({"name": agent["name"], "description": agent["description"],
                              "prompt": agent["prompt"], "skillIds": agent["skillIds"], "welcome": welcome})
                if found.get("importedSkillId") not in found["skillIds"]:
                    found.pop("importedSkillId", None)
                found["revision"] = int(found.get("revision", 1)) + 1
            self._commit(document)
            return copy.deepcopy(found)

    def set_enabled(self, identifier, enabled):
        if not valid_identifier(identifier):
            raise AdvisorError("invalid-request", "invalid agent id")
        enabled = valid_enabled(enabled)
        with self.lock:
            document = copy.deepcopy(self._load())
            found = next((item for item in document["agents"] if item["id"] == identifier), None)
            if found is None:
                raise AdvisorError("agent-unknown", "agent 不存在")
            found["enabled"] = enabled
            found["revision"] = int(found.get("revision", 1)) + 1
            self._commit(document)
            return copy.deepcopy(found)

    def delete_agent(self, identifier):
        if not valid_identifier(identifier):
            raise AdvisorError("invalid-request", "invalid agent id")
        with self.lock:
            document = copy.deepcopy(self._load())
            found = next((item for item in document["agents"] if item["id"] == identifier), None)
            if found is None:
                raise AdvisorError("agent-unknown", "agent 不存在")
            if found["builtin"] and identifier not in document["deletedBuiltinAgentIds"]:
                document["deletedBuiltinAgentIds"].append(identifier)
            document["agents"] = [item for item in document["agents"] if item["id"] != identifier]
            self._commit(document)
            return {"deleted": identifier}

    def import_skill(self, name, description, content):
        skill = normalize_skill(name, description, content)
        with self.lock:
            document = copy.deepcopy(self._load())
            if any(item["name"].strip().lower() == skill["name"].strip().lower()
                   for item in document["skills"]):
                raise AdvisorError("skill-name-taken", "技能名称已存在")
            if len(document["skills"]) >= MAX_SKILLS:
                raise AdvisorError("config-full", "技能数量已达上限")
            created = {"id": new_identifier("skill", uuid.uuid4().hex),
                       "name": skill["name"], "description": skill["description"],
                       "content": skill["content"], "builtin": False}
            document["skills"].append(created)
            self._commit(document)
            return copy.deepcopy(created)

    @staticmethod
    def _unique_import_name(name, items, maximum):
        existing = {item["name"].strip().casefold() for item in items}
        if name.strip().casefold() not in existing:
            return name
        for number in range(2, len(items) + 2):
            candidate = name + " (" + str(number) + ")"
            if len(candidate) > maximum:
                raise AdvisorError("skill-name-taken", "名称已存在，请缩短名称或另选名称后导入")
            if candidate.strip().casefold() not in existing:
                return candidate
        raise AdvisorError("skill-name-taken", "导入名称已存在")

    def import_assistant(self, package, agent_overrides=None, request_id=None, *, cancel_event=None):
        """Commit one immutable package and its assistant together, without touching threads."""
        from advisor_packages import validate_package
        _check_import_cancel(cancel_event)
        package = copy.deepcopy(validate_package(package))
        request_id = valid_request_id(request_id)
        overrides = {} if agent_overrides is None else agent_overrides
        if (not isinstance(overrides, dict) or
                not set(overrides) <= {"name", "description", "prompt", "welcome"}):
            raise AdvisorError("invalid-request", "导入助手字段不正确")
        entry = package["entry"]
        agent = normalize_agent_payload({
            "name": overrides.get("name", entry["name"]),
            "description": overrides.get("description", entry["description"]),
            "prompt": overrides.get("prompt", entry["defaultPrompt"]),
            "skillIds": [],
            **({"welcome": overrides["welcome"]} if "welcome" in overrides else {}),
        })
        skill_fields = {
            "name": single_line(entry["name"], "name", MAX_SKILL_NAME),
            "description": single_line(entry["description"], "description", MAX_SKILL_DESCRIPTION, allow_empty=True),
            "content": text_block(entry["content"], "content", MAX_SKILL_CONTENT),
        }
        identity = [package["source"], package["digest"]]
        fingerprint = hashlib.sha256(json.dumps([identity, agent], ensure_ascii=False, sort_keys=True,
                                               separators=(",", ":")).encode("utf-8")).hexdigest()
        with self.lock:
            _check_import_cancel(cancel_event)
            document = copy.deepcopy(self._load())
            previous = next((item for item in document["importRequests"] if item["requestId"] == request_id), None)
            if previous is not None:
                if previous["fingerprint"] != fingerprint:
                    raise AdvisorError("request-conflict", "导入请求编号已用于另一份内容")
                old_agent = next((item for item in document["agents"] if item["id"] == previous["agentId"]), None)
                old_skill = next((item for item in document["skills"] if item["id"] == previous["skillId"]), None)
                if old_agent is None:
                    raise AdvisorError("agent-unknown", "此前导入的助手已删除")
                if old_skill is None:
                    raise AdvisorError("skill-unknown", "此前导入的技能已删除")
                return {"agent": copy.deepcopy(old_agent), "skill": copy.deepcopy(old_skill),
                        "created": False, "duplicate": True}
            skill = next((item for item in document["skills"] if item.get("package") is not None and
                          [item["package"]["source"], item["package"]["digest"]] == identity), None)
            imported_agent = next((item for item in document["agents"] if skill is not None and
                                   item.get("importedSkillId") == skill["id"] and skill["id"] in item["skillIds"]), None)
            created = imported_agent is None
            if created:
                if len(document["agents"]) >= MAX_AGENTS:
                    raise AdvisorError("config-full", "助手数量已达上限")
                agent_name = self._unique_import_name(agent["name"], document["agents"], MAX_AGENT_NAME)
                if skill is None:
                    if len(document["skills"]) >= MAX_SKILLS:
                        raise AdvisorError("config-full", "技能数量已达上限")
                    skill = {"id": new_identifier("skill", uuid.uuid4().hex), **skill_fields,
                             "builtin": False, "package": package}
                    skill["name"] = self._unique_import_name(skill["name"], document["skills"], MAX_SKILL_NAME)
                    document["skills"].append(skill)
                imported_agent = {
                    "id": new_identifier("agent", uuid.uuid4().hex), "name": agent_name,
                    "description": agent["description"], "prompt": agent["prompt"],
                    "welcome": agent["welcome"] if agent["welcome"] is not None else default_welcome(agent_name),
                    "skillIds": [skill["id"]], "importedSkillId": skill["id"],
                    "enabled": True, "builtin": False, "revision": 1,
                }
                document["agents"].append(imported_agent)
            if request_id is not None:
                document["importRequests"].append({"requestId": request_id, "fingerprint": fingerprint,
                                                   "agentId": imported_agent["id"], "skillId": skill["id"]})
                document["importRequests"] = document["importRequests"][-MAX_IMPORT_REQUESTS:]
            if created or request_id is not None:
                self._commit(document, cancel_event)
            return {"agent": copy.deepcopy(imported_agent), "skill": copy.deepcopy(skill),
                    "created": created, "duplicate": not created}

    def delete_skill(self, identifier):
        if not valid_identifier(identifier):
            raise AdvisorError("invalid-request", "技能编号不正确")
        with self.lock:
            document = copy.deepcopy(self._load())
            found = next((skill for skill in document["skills"] if skill["id"] == identifier), None)
            if found is None:
                raise AdvisorError("skill-unknown", "技能不存在")
            document["skills"] = [skill for skill in document["skills"] if skill["id"] != identifier]
            if identifier in builtin_skill_ids() and identifier not in document["deletedBuiltinSkillIds"]:
                document["deletedBuiltinSkillIds"].append(identifier)
            affected = []
            for agent in document["agents"]:
                if identifier in agent["skillIds"]:
                    agent["skillIds"] = [value for value in agent["skillIds"] if value != identifier]
                    agent["revision"] += 1
                    affected.append(agent["id"])
                if agent.get("importedSkillId") == identifier:
                    agent.pop("importedSkillId")
            self._commit(document)
            return {"deleted": identifier, "affectedAgentIds": affected}


_SCHEMA = """
CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    user TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    model_fp TEXT,
    template_revision INTEGER,
    context_epoch TEXT,
    source_id TEXT NOT NULL,
    runtime_session_id TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS threads_scope ON threads(user, agent_id, updated_at_ms DESC);
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    status TEXT,
    created_at_ms INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_thread_seq ON messages(thread_id, seq);
CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    request_id TEXT,
    user_message_id TEXT,
    state TEXT NOT NULL,
    error TEXT,
    template_revision INTEGER NOT NULL,
    context_revision INTEGER NOT NULL,
    source_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS runs_thread_request ON runs(thread_id, request_id);
CREATE TABLE IF NOT EXISTS requests (
    user TEXT NOT NULL, agent_id TEXT NOT NULL, request_id TEXT NOT NULL,
    message TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    PRIMARY KEY(user,agent_id,request_id)
);
CREATE INDEX IF NOT EXISTS runs_thread ON runs(thread_id, created_at_ms DESC);
CREATE TABLE IF NOT EXISTS context (
    user TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    revision INTEGER NOT NULL,
    read_count INTEGER NOT NULL,
    total_count INTEGER,
    error TEXT,
    source_id TEXT,
    epoch TEXT,
    highwater TEXT,
    cursor TEXT,
    last_sort TEXT,
    started_at_ms INTEGER,
    updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS context_messages (
    user TEXT NOT NULL,
    seq INTEGER NOT NULL,
    msg_id TEXT NOT NULL,
    sort_key TEXT NOT NULL,
    group_chat INTEGER NOT NULL DEFAULT 0,
    side TEXT,
    sender_id TEXT,
    sender_name TEXT,
    kind TEXT,
    text TEXT,
    time_ms INTEGER,
    raw TEXT,
    PRIMARY KEY(user, seq)
);
CREATE TABLE IF NOT EXISTS summaries (
    user TEXT NOT NULL,
    range_key TEXT NOT NULL,
    version TEXT NOT NULL,
    model_fp TEXT NOT NULL,
    level INTEGER NOT NULL,
    text TEXT NOT NULL,
    coverage_json TEXT,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY(user, range_key, version, model_fp, level)
);
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def _now_ms():
    return int(time.time() * 1000)


class AccountDatabase:
    """Private append-only projection for one real account."""

    def __init__(self, data_root, account, *, cipher=None):
        self.data_root = _checked_root(data_root)
        self.account = account
        self.digest = hashlib.sha256(account.encode("utf-8")).hexdigest()
        self.directory = self.data_root / self.digest
        self.path = self.directory / "advisor.sqlite3"
        self.state_dir = self.directory / "opencode"
        self.cipher = cipher if isinstance(cipher, PayloadCipher) else None
        self.lock = threading.RLock()
        self._connection = None
        self._closed = False

    # -- chat text sealing ----------------------------------------------------
    def _seal(self, value):
        """Seal one text column; a blank value and an already sealed one pass through."""
        if self.cipher is None or not isinstance(value, str) or not value:
            return value
        if value.startswith(ENVELOPE):
            return value
        return self.cipher.protect(value)

    def _open(self, value):
        """Read one text column; a legacy plaintext value stays readable as-is."""
        if self.cipher is None or not isinstance(value, str) or not value.startswith(ENVELOPE):
            return value
        return self.cipher.unprotect(value)

    def _open_row(self, row, fields):
        if row is None or self.cipher is None:
            return row
        sealed = {field: self._open(row[field]) for field in fields if field in row.keys()}
        return {**dict(row), **sealed} if sealed else dict(row)

    # -- one-time sealing of legacy plaintext rows ---------------------------
    _SEALED_COLUMNS = (
        ("messages", ("id",), ("text",)),
        ("requests", ("user", "agent_id", "request_id"), ("message",)),
        ("context_messages", ("user", "seq"), ("text", "raw")),
        ("summaries", ("user", "range_key", "version", "model_fp", "level"), ("text",)),
    )

    def _seal_existing_text(self, connection):
        """Rewrite plaintext rows once so an old projection stops leaking chat text.

        Recorded in ``meta`` so reopening an already sealed database is a cheap no-op scan.
        """
        if connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").fetchone() is None:
            return
        done = connection.execute("SELECT value FROM meta WHERE key='text-sealed'").fetchone()
        if done is not None and done[0] == "1":
            return
        for table, keys, columns in self._SEALED_COLUMNS:
            selection = ", ".join(keys + columns)
            for row in connection.execute(f"SELECT {selection} FROM {table}").fetchall():
                sealed = {column: self._seal(row[column]) for column in columns}
                if all(sealed[column] == row[column] for column in columns):
                    continue
                assignments = ", ".join(f"{column}=?" for column in columns)
                where = " AND ".join(f"{key}=?" for key in keys)
                connection.execute(f"UPDATE {table} SET {assignments} WHERE {where}",
                                   (*sealed.values(), *(row[key] for key in keys)))
        connection.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('text-sealed','1')")

    # -- connection ----------------------------------------------------------
    def _connect(self):
        with self.lock:
            if self._connection is not None:
                return self._connection
            if self._closed:
                raise AdvisorError("account-closed", "账号数据已关闭")
            _ensure_directory(self.data_root, self.directory)
            for filename in (self.path, Path(str(self.path) + "-wal"), Path(str(self.path) + "-shm")):
                if _reparse(filename):
                    raise AdvisorPathError("advisor database is not a plain file")
            connection = sqlite3.connect(str(self.path), timeout=30.0, check_same_thread=False)
            connection.row_factory = sqlite3.Row
            if self.cipher is not None:
                # Key setup (DPAPI + fsync) must not land inside the first write of a run.
                self.cipher.warm()
            try:
                connection.execute("PRAGMA journal_mode=WAL")
                connection.execute("PRAGMA synchronous=FULL")
                connection.execute("PRAGMA foreign_keys=ON")
                connection.execute("PRAGMA busy_timeout=30000")
                connection.executescript(_SCHEMA)
                for table, field, sql_type in (("threads", "model_fp", "TEXT"),
                                                ("threads", "template_revision", "INTEGER"),
                                                ("threads", "context_epoch", "TEXT"),
                                                ("runs", "user_message_id", "TEXT"),
                                                ("context", "epoch", "TEXT"),
                                                ("summaries", "coverage_json", "TEXT")):
                    columns = {row[1] for row in connection.execute("PRAGMA table_info(" + table + ")")}
                    if field not in columns:
                        connection.execute("ALTER TABLE " + table + " ADD COLUMN " + field + " " + sql_type)
                connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS context_message_identity ON context_messages(user,msg_id)")
                connection.execute("PRAGMA user_version=3")
                if self.cipher is not None:
                    self._seal_existing_text(connection)
                connection.commit()
                self._connection = connection
                self._mark_interrupted()
            except Exception:
                self._connection = None
                connection.close()
                raise
            return connection

    def close(self):
        with self.lock:
            self._closed = True
            if self._connection is not None:
                try:
                    self._connection.close()
                finally:
                    self._connection = None

    def _mark_interrupted(self):
        """Runs cannot survive a service restart; their transcript stays intact."""
        now = _now_ms()
        rows = self._connection.execute(
            "SELECT id, thread_id FROM runs WHERE state='running'").fetchall()
        for row in rows:
            self._connection.execute(
                "UPDATE runs SET state='error', error=?, updated_at_ms=? WHERE id=?",
                ("服务重启，运行已中断", now, row["id"]))
            self._append_message(row["thread_id"], "status", "上次生成已中断",
                                 status="error", created_at_ms=now)
        if rows:
            self._connection.commit()

    # -- low-level helpers ---------------------------------------------------
    def _rows(self, sql, params=()):
        connection = self._connect()
        with self.lock:
            return [dict(row) for row in connection.execute(sql, params)]

    def _row(self, sql, params=()):
        rows = self._rows(sql, params)
        return rows[0] if rows else None

    # -- threads -------------------------------------------------------------
    def create_thread(self, user, agent_id, source_id):
        thread_id = new_identifier("thread", uuid.uuid4().hex)
        now = _now_ms()
        with self.lock:
            connection = self._connect()
            with connection:
                connection.execute(
                    "INSERT INTO threads(id,user,agent_id,source_id,created_at_ms,updated_at_ms)"
                    " VALUES(?,?,?,?,?,?)",
                    (thread_id, user, agent_id, source_id, now, now))
        return self.thread(thread_id)

    def delete_thread(self, thread_id):
        """Remove one conversation and everything hanging off it. Reports whether it existed."""
        with self._connect() as connection:
            row = connection.execute("SELECT id FROM threads WHERE id=?", (thread_id,)).fetchone()
            if row is None:
                return False
            connection.execute(
                "DELETE FROM requests WHERE run_id IN (SELECT id FROM runs WHERE thread_id=?)",
                (thread_id,))
            connection.execute("DELETE FROM runs WHERE thread_id=?", (thread_id,))
            connection.execute("DELETE FROM messages WHERE thread_id=?", (thread_id,))
            connection.execute("DELETE FROM threads WHERE id=?", (thread_id,))
            return True

    def thread(self, thread_id):
        return self._row("SELECT * FROM threads WHERE id=?", (thread_id,))

    def latest_thread(self, user, agent_id):
        return self._row(
            "SELECT * FROM threads WHERE user=? AND agent_id=?"
            " ORDER BY created_at_ms DESC, rowid DESC LIMIT 1", (user, agent_id))

    def list_threads(self, user, agent_id, limit=MAX_HISTORY_THREADS):
        """This contact's saved conversations, newest first, with a title and a preview.

        The title is the first thing the user asked in that conversation, the preview is its last
        message: enough to recognise a conversation without opening it.
        """
        rows = self._rows(
            "SELECT threads.id AS id, threads.created_at_ms AS created_at_ms,"
            " threads.updated_at_ms AS updated_at_ms,"
            " (SELECT COUNT(*) FROM messages WHERE messages.thread_id=threads.id) AS message_count,"
            " (SELECT text FROM messages WHERE messages.thread_id=threads.id AND role='user'"
            "   ORDER BY seq ASC LIMIT 1) AS title,"
            " (SELECT text FROM messages WHERE messages.thread_id=threads.id"
            "   ORDER BY seq DESC LIMIT 1) AS preview,"
            " (SELECT role FROM messages WHERE messages.thread_id=threads.id"
            "   ORDER BY seq DESC LIMIT 1) AS preview_role"
            " FROM threads WHERE user=? AND agent_id=?"
            " ORDER BY updated_at_ms DESC, rowid DESC LIMIT ?",
            (user, agent_id, int(limit)))
        return [self._open_row(row, ("title", "preview")) for row in rows]

    def thread_messages(self, thread_id):
        return [self._open_row(row, ("text",)) for row in
                self._rows("SELECT * FROM messages WHERE thread_id=? ORDER BY seq ASC", (thread_id,))]

    def set_runtime_session(self, thread_id, runtime_session_id):
        with self.lock:
            connection = self._connect()
            with connection:
                connection.execute("UPDATE threads SET runtime_session_id=? WHERE id=?",
                                   (runtime_session_id, thread_id))

    def recent_user_texts(self, thread_id):
        return [self._open(row["text"]) for row in reversed(self._rows(
            "SELECT text FROM messages WHERE thread_id=? AND role='user' ORDER BY seq DESC LIMIT 2", (thread_id,)))]


    def bind_runtime(self, thread_id, source_id, model_fp, template_revision, context_epoch=None):
        with self.lock:
            connection = self._connect()
            row = connection.execute("SELECT * FROM threads WHERE id=?", (thread_id,)).fetchone()
            if row is None:
                raise AdvisorError("thread-unknown", "会话不存在")
            if (row["source_id"], row["model_fp"], row["context_epoch"]) != (source_id, model_fp, context_epoch):
                with connection:
                    connection.execute("UPDATE threads SET source_id=?,model_fp=?,template_revision=?,"
                                       "context_epoch=?,runtime_session_id=NULL WHERE id=?",
                                       (source_id, model_fp, template_revision, context_epoch, thread_id))
            else:
                with connection:
                    connection.execute("UPDATE threads SET template_revision=? WHERE id=?", (template_revision, thread_id))
            return self.thread(thread_id)

    def _touch_thread(self, connection, thread_id, now):
        connection.execute("UPDATE threads SET updated_at_ms=? WHERE id=?", (now, thread_id))

    def _append_message(self, thread_id, role, text, status=None, created_at_ms=None):
        connection = self._connect()
        seq = connection.execute(
            "SELECT COALESCE(MAX(seq),0)+1 FROM messages WHERE thread_id=?", (thread_id,)).fetchone()[0]
        message = {"id": new_identifier("msg", uuid.uuid4().hex), "thread_id": thread_id,
                   "seq": seq, "role": role, "text": text, "status": status,
                   "created_at_ms": created_at_ms if created_at_ms is not None else _now_ms()}
        connection.execute(
            "INSERT INTO messages(id,thread_id,seq,role,text,status,created_at_ms)"
            " VALUES(?,?,?,?,?,?,?)",
            (message["id"], thread_id, seq, role, self._seal(text), status, message["created_at_ms"]))
        return message

    def append_message(self, thread_id, role, text, status=None):
        with self.lock:
            connection = self._connect()
            with connection:
                message = self._append_message(thread_id, role, text, status=status)
                self._touch_thread(connection, thread_id, message["created_at_ms"])
        return message

    # -- runs ----------------------------------------------------------------
    def find_run_by_request(self, thread_id, request_id):
        if request_id is None:
            return None
        return self._row("SELECT * FROM runs WHERE thread_id=? AND request_id=?",
                         (thread_id, request_id))

    def scoped_request(self, user, agent_id, request_id, message):
        if request_id is None:
            return None
        row = self._row("SELECT requests.message AS request_message,runs.* FROM requests "
                        "JOIN runs ON runs.id=requests.run_id WHERE requests.user=? AND "
                        "requests.agent_id=? AND requests.request_id=?", (user, agent_id, request_id))
        if row is not None:
            row = self._open_row(row, ("request_message",))
            if row["request_message"] != message:
                raise AdvisorError("request-conflict", "该请求编号已经用于另一条消息")
        return row

    def run(self, run_id):
        return self._row("SELECT * FROM runs WHERE id=?", (run_id,))

    def run_with_user(self, run_id):
        return self._row(
            "SELECT runs.*, threads.user AS scope_user FROM runs"
            " JOIN threads ON threads.id = runs.thread_id WHERE runs.id=?", (run_id,))

    def latest_run(self, thread_id):
        return self._row("SELECT * FROM runs WHERE thread_id=? ORDER BY created_at_ms DESC, id DESC LIMIT 1",
                         (thread_id,))

    def active_run(self, thread_id):
        return self._row("SELECT * FROM runs WHERE thread_id=? AND state='running' ORDER BY created_at_ms DESC LIMIT 1",
                         (thread_id,))

    def active_runs_for_user(self, user):
        return self._rows(
            "SELECT runs.* FROM runs JOIN threads ON threads.id = runs.thread_id"
            " WHERE threads.user=? AND runs.state='running'", (user,))

    def create_run(self, thread, user_message, request_id, template_revision,
                   context_revision, source_id):
        """Atomically create the run row and its user message projection."""
        run_id = new_identifier("run", uuid.uuid4().hex)
        now = _now_ms()
        with self.lock:
            connection = self._connect()
            with connection:
                existing = None
                if request_id is not None:
                    existing = connection.execute(
                        "SELECT * FROM runs WHERE thread_id=? AND request_id=?",
                        (thread["id"], request_id)).fetchone()
                if existing is not None:
                    return dict(existing), None
                connection.execute(
                    "INSERT INTO runs(id,thread_id,request_id,state,error,template_revision,"
                    "context_revision,source_id,created_at_ms,updated_at_ms)"
                    " VALUES(?,?,?,'running',NULL,?,?,?,?,?)",
                    (run_id, thread["id"], request_id, template_revision, context_revision,
                     source_id, now, now))
                message = self._append_message(thread["id"], "user", user_message)
                connection.execute("UPDATE runs SET user_message_id=? WHERE id=?", (message["id"], run_id))
                if request_id is not None:
                    connection.execute("INSERT INTO requests(user,agent_id,request_id,message,run_id) VALUES(?,?,?,?,?)",
                                       (thread["user"], thread["agent_id"], request_id,
                                        self._seal(user_message), run_id))
                self._touch_thread(connection, thread["id"], now)
        return self.run(run_id), message

    def finish_run(self, run_id, thread_id, state, error=None, assistant_text=None,
                   assistant_status=None, status_text=None, runtime_session_id=None):
        """One transaction: optional transcript rows + run state + session + touch."""
        now = _now_ms()
        appended = []
        with self.lock:
            connection = self._connect()
            with connection:
                current = connection.execute("SELECT state,thread_id FROM runs WHERE id=?", (run_id,)).fetchone()
                if current is None or current["thread_id"] != thread_id or current["state"] != "running":
                    return []
                if status_text is not None:
                    appended.append(self._append_message(thread_id, "status", status_text,
                                                         status=state))
                if assistant_text is not None:
                    appended.append(self._append_message(thread_id, "assistant", assistant_text,
                                                         status=assistant_status))
                connection.execute(
                    "UPDATE runs SET state=?, error=?, updated_at_ms=? WHERE id=?",
                    (state, error, now, run_id))
                if runtime_session_id is not None:
                    connection.execute("UPDATE threads SET runtime_session_id=? WHERE id=?",
                                       (runtime_session_id, thread_id))
                self._touch_thread(connection, thread_id, now)
        return appended

    def freeze_run_context(self, run_id, revision):
        with self.lock:
            connection = self._connect()
            with connection:
                connection.execute("UPDATE runs SET context_revision=? WHERE id=? AND state='running'",
                                   (revision, run_id))

    # -- context -------------------------------------------------------------
    def context(self, user):
        return self._row("SELECT * FROM context WHERE user=?", (user,))

    def context_begin(self, user, highwater_json, source_id=None, reset=False):
        now = _now_ms()
        with self.lock:
            connection = self._connect()
            with connection:
                if reset:
                    connection.execute("DELETE FROM context_messages WHERE user=?", (user,))
                    connection.execute("DELETE FROM summaries WHERE user=?", (user,))
                    connection.execute("DELETE FROM context WHERE user=?", (user,))
                connection.execute(
                    "INSERT INTO context(user,state,revision,read_count,total_count,error,source_id,epoch,"
                    "highwater,cursor,last_sort,started_at_ms,updated_at_ms)"
                    " VALUES(?,?,?,?,?,NULL,?,?,?,NULL,NULL,?,?)"
                    " ON CONFLICT(user) DO UPDATE SET state='reading', error=NULL,"
                    " highwater=excluded.highwater, source_id=excluded.source_id,total_count=NULL,"
                    " started_at_ms=COALESCE(context.started_at_ms, excluded.started_at_ms),"
                    " updated_at_ms=excluded.updated_at_ms",
                    (user, "reading", 0, 0, None, source_id, uuid.uuid4().hex, highwater_json, now, now))
        return self.context(user)

    def context_append_page(self, user, rows_to_add, cursor_json, last_sort_json):
        """Append one imported page; a page that inserts nothing does not bump revision."""
        now = _now_ms()
        with self.lock:
            connection = self._connect()
            with connection:
                inserted = 0
                next_seq = connection.execute("SELECT COALESCE(MAX(seq),0) FROM context_messages WHERE user=?", (user,)).fetchone()[0]
                for row in rows_to_add:
                    prior = connection.execute("SELECT sort_key,text,raw,sender_id FROM context_messages WHERE user=? AND msg_id=?",
                                               (user, row["msg_id"])).fetchone()
                    if prior is not None:
                        if (prior["sort_key"], self._open(prior["text"]), self._open(prior["raw"]),
                                prior["sender_id"]) != (
                                row["sort_key"], row["text"], row["raw"], row["sender_id"]):
                            raise AdvisorError("context-error", "历史消息内容发生变化，请重新读取")
                        continue
                    next_seq += 1
                    cursor = connection.execute(
                        "INSERT INTO context_messages(user,seq,msg_id,sort_key,group_chat,"
                        "side,sender_id,sender_name,kind,text,time_ms,raw)"
                        " VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                        (user, next_seq, row["msg_id"], row["sort_key"], row["group_chat"],
                         row["side"], row["sender_id"], row["sender_name"], row["kind"],
                         self._seal(row["text"]), row["time_ms"], self._seal(row["raw"])))
                    inserted += cursor.rowcount
                # The forward cursor always advances; only fresh rows bump the
                # revision and the read count.
                if inserted:
                    connection.execute(
                        "UPDATE context SET state='reading', revision=revision+1,"
                        " read_count=read_count+?, cursor=?, last_sort=?, updated_at_ms=?"
                        " WHERE user=?",
                        (inserted, cursor_json, last_sort_json, now, user))
                else:
                    if cursor_json or last_sort_json:
                        connection.execute(
                            "UPDATE context SET cursor=?, last_sort=?, updated_at_ms=? WHERE user=?",
                            (cursor_json, last_sort_json, now, user))
        return inserted

    def context_finish(self, user, total_count):
        now = _now_ms()
        with self.lock:
            connection = self._connect()
            with connection:
                connection.execute(
                    "UPDATE context SET state='ready', error=NULL, total_count=?, updated_at_ms=?"
                    " WHERE user=?", (total_count, now, user))
        return self.context(user)

    def context_error(self, user, message):
        now = _now_ms()
        with self.lock:
            connection = self._connect()
            with connection:
                connection.execute(
                    "UPDATE context SET state='error', error=?, updated_at_ms=? WHERE user=?",
                    (message, now, user))
        return self.context(user)

    def context_messages(self, user, upto_seq):
        if upto_seq is None:
            rows = self._rows("SELECT * FROM context_messages WHERE user=? ORDER BY seq ASC", (user,))
        else:
            rows = self._rows(
                "SELECT * FROM context_messages WHERE user=? AND seq<=? ORDER BY seq ASC",
                (user, upto_seq))
        return [self._open_row(row, ("text", "raw")) for row in rows]

    def context_window_matches(self, user, rows):
        """Validate overlap against immutable message facts, ignoring renamed contacts."""
        known = set()
        with self.lock:
            connection = self._connect()
            for row in rows:
                previous = connection.execute("SELECT * FROM context_messages WHERE user=? AND msg_id=?",
                                              (user, row["msg_id"])).fetchone()
                if previous is None:
                    continue
                facts = ("sort_key", "side", "sender_id", "kind", "text", "time_ms")
                previous = self._open_row(previous, ("text", "raw"))
                old_quote = json.loads(previous["raw"] or "{}").get("inputMeta", {}).get("quote")
                new_quote = json.loads(row["raw"] or "{}").get("inputMeta", {}).get("quote")
                if any(previous[field] != row[field] for field in facts) or old_quote != new_quote:
                    raise AdvisorError("context-error", "已读取消息发生变化，需要重新整理会话资料")
                known.add(row["msg_id"])
        return known

    # -- shared neutral summaries -------------------------------------------
    def summary(self, user, range_key, version, model_fp, level):
        row = self._row(
            "SELECT text FROM summaries WHERE user=? AND range_key=? AND version=?"
            " AND model_fp=? AND level=?", (user, range_key, version, model_fp, level))
        return self._open(row["text"]) if row else None

    def save_summary(self, user, range_key, version, model_fp, level, text, coverage=None):
        with self.lock:
            connection = self._connect()
            with connection:
                connection.execute(
                    "INSERT OR REPLACE INTO summaries(user,range_key,version,model_fp,level,text,"
                    "created_at_ms,coverage_json) VALUES(?,?,?,?,?,?,?,?)",
                    (user, range_key, version, model_fp, level, self._seal(text), _now_ms(),
                     json.dumps(coverage, separators=(",", ":")) if coverage is not None else None))

    # -- removal -------------------------------------------------------------
    def _assert_owned_tree(self):
        if not os.path.lexists(self.directory):
            return False
        if _reparse(self.directory) or not self.directory.is_dir():
            raise AdvisorPathError("advisor account directory is not a plain directory")
        for base, directories, files in os.walk(self.directory):
            for name in list(directories) + list(files):
                path = Path(base) / name
                if _reparse(path):
                    raise AdvisorPathError("advisor account directory contains a reparse point")
        return True

    def remove(self):
        """Close and delete this account's owned projection directory."""
        with self.lock:
            self.close()
            if not self._assert_owned_tree():
                return {"deleted": False}
            shutil.rmtree(self.directory)
        return {"deleted": True}


class AdvisorStoreRoot:
    """Factory and lifecycle owner for config + per-account databases."""

    def __init__(self, root, *, cipher=None):
        self.root = _checked_root(root)
        self.data_root = self.root / ".local" / "advisor-data"
        self.config = AgentConfigStore(self.root)
        self.cipher = cipher if isinstance(cipher, PayloadCipher) else None
        self.lock = threading.RLock()
        self._accounts = {}
        self._blocked = set()
        self._closed = False

    def account(self, account):
        if not isinstance(account, str) or not account:
            raise AdvisorError("invalid-request", "invalid account")
        with self.lock:
            if self._closed or account in self._blocked:
                raise AdvisorError("account-closed", "账号数据已关闭")
            database = self._accounts.get(account)
            if database is None or database._closed:
                database = AccountDatabase(self.data_root, account, cipher=self.cipher)
                self._accounts[account] = database
            return database

    def block_account(self, account):
        with self.lock:
            self._blocked.add(account)

    def unblock_account(self, account):
        with self.lock:
            if not self._closed:
                self._blocked.discard(account)

    def release_account(self, account):
        """Close one account's database so the parent may remove its files."""
        with self.lock:
            database = self._accounts.pop(account, None)
        if database is not None:
            database.close()

    def remove_account(self, account):
        with self.lock:
            database = self._accounts.pop(account, None)
        if database is not None:
            return database.remove()
        return AccountDatabase(self.data_root, account).remove()

    def close(self):
        with self.lock:
            self._closed = True
            databases = list(self._accounts.values())
            self._accounts.clear()
        for database in databases:
            database.close()
