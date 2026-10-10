"""Pure Advisor domain contract: limits, preset templates, validation, budgets.

This module must stay dependency-free (standard library only). It defines the
shared vocabulary that ``advisor_store``, ``advisor_context`` and
``advisor_service`` rely on, mirroring the existing ``message_contracts`` style.

The Advisor is a read-only product agent: it only reads one selected
conversation plus approved Skill text and returns advice. There is no command
execution, file editing, browsing, plugin, MCP or WeChat sending in this
contract, and no renderer request may ever carry the API key.
"""
from __future__ import annotations

import copy
import hashlib
import json
import re

ADVISOR_CONFIG_VERSION = 1

# --- Catalog limits (stable HTTP contract) ---------------------------------
MAX_AGENTS = 100
MAX_SKILLS = 200
MAX_AGENT_NAME = 60
MAX_AGENT_DESCRIPTION = 240
MAX_AGENT_PROMPT = 16000
MAX_AGENT_WELCOME = 120
MAX_SKILL_NAME = 60
MAX_SKILL_DESCRIPTION = 240
MAX_SKILL_CONTENT = 24000
MAX_SKILL_IDS = 16
#: Referenced by `advisor_service`: a run that selected this skill is told whether a saved
#: 「潜台词与沟通建议」exists, so it can analyse the conversation itself when none does.
GUIDANCE_SKILL_ID = "builtin-skill:guidance"
MAX_USER_MESSAGE = 16000
MAX_REQUEST_ID = 128
MAX_SCOPE_VALUE = 256
MAX_IDENTIFIER = 80

# --- Model input budget ----------------------------------------------------
# Characters are only ever a conservative proxy for provider tokens, never an
# exact count. The ratio keeps Chinese text (roughly one token per character)
# inside the window while English is over-reserved, not under-reserved.
DEFAULT_CONTEXT_TOKENS = 8192
OUTPUT_RESERVED_TOKENS = 4096
CHAR_PER_TOKEN_NUM = 55
CHAR_PER_TOKEN_DEN = 100
MIN_INPUT_CHARS = 2048
SAFETY_MARGIN_PERCENT = 10
HISTORY_BUDGET_PERCENT = 40
RECENT_CONTEXT_PERCENT = 70
COMPACT_CHUNK_CHARS = 6000
MAX_SUMMARY_CHARS = 2000
MAX_COMPRESSION_LEVELS = 8
COMPRESSION_VERSION = "advisor-compress-v2"

# --- Runtime event/state vocabulary ----------------------------------------
EVENT_TYPES = ("status", "text", "reasoning", "skill", "done", "error")
RUN_STATES = ("running", "done", "stopped", "error")
TERMINAL_RUN_STATES = ("done", "stopped", "error")
CONTEXT_STATES = ("idle", "reading", "ready", "error")
MESSAGE_ROLES = ("user", "assistant", "status")
MESSAGE_STATUSES = ("stopped", "error", "reading")

# --- Stable error codes -----------------------------------------------------
ERROR_CODES = frozenset({
    "invalid-request", "agent-unknown", "agent-disabled", "builtin-agent",
    "skill-unknown", "skill-name-taken", "config-invalid", "config-full",
    "api-not-configured", "engine-unavailable", "account-changed",
    "account-paused", "account-closed", "context-error", "context-too-long",
    "compression-failed", "thread-unknown", "thread-agent-mismatch",
    "run-active", "run-unknown", "request-conflict", "stopping",
})


class AdvisorError(RuntimeError):
    """A scoped Advisor failure with a stable machine code."""

    def __init__(self, code, message=None):
        if code not in ERROR_CODES:
            raise ValueError("unknown advisor error code: " + str(code))
        super().__init__(message or code)
        self.code = code
        self.message = message or code


# --- Preset templates -------------------------------------------------------

_ADVISOR_PROMPT = (
    "你是“狗头军师”，擅长从聊天记录里揣摩真实意图，给出机灵、务实又带点幽默的参谋建议。\n"
    "- 先读懂对话：双方关系、情绪、话题走向和潜在诉求。\n"
    "- 建议要具体可执行，给出 1-3 个选项，并说明各自的风险和对方可能的反应。\n"
    "- 语气可以调侃，但不要挖苦任何一方，不要臆测隐私。\n"
    "- 只依据提供的聊天记录，不编造事实；信息不足时直接说明。"
)

_EMPATHY_PROMPT = (
    "你是共情沟通教练，帮助用户更好地回应对方。\n"
    "- 先指出对方可能的感受和需要，再给出回应建议。\n"
    "- 建议使用观察、感受、需要、请求的框架，避免评判和指责。\n"
    "- 提供 1-2 段可直接参考或改写的话术，保留用户自己的语气。\n"
    "- 只依据提供的聊天记录，不夸大、不编造。"
)

_REFLECTION_PROMPT = (
    "你是理性复盘助手，帮助用户从一段对话中看清事实和选择。\n"
    "- 区分事实与推测，梳理事情的起因、经过和结果。\n"
    "- 指出有效的做法与可以改进的地方，避免人身评价。\n"
    "- 给出下一步可验证的小行动，并提示可能的风险。\n"
    "- 只依据提供的聊天记录，不确定时明确说明。"
)

_GUIDANCE_PROMPT = (
    "你是沟通参谋，擅长把聊天里的潜台词讲清楚，并把建议落到马上能发出去的话上。\n"
    "- 先给潜台词解读：逐条指出关键消息的表面说法、可能的真实意图和依据。\n"
    "- 再给局势判断：对方的态度、情绪与顾虑，区分事实和推测。\n"
    "- 最后给沟通建议：2 到 4 条策略加 1 到 3 条可直接用的回复草稿。\n"
    "- 只依据提供的聊天记录，不确定时直接说明，不编造。"
)

_BUILTIN_AGENTS = (
    {
        "id": "builtin:advisor",
        "name": "狗头军师",
        "description": "机灵务实的参谋，帮你分析聊天局势并给出可执行的对策。",
        "prompt": _ADVISOR_PROMPT,
        "skillIds": ["builtin-skill:advisor"],
        "enabled": True,
        "builtin": True,
        "revision": 1,
    },
    {
        "id": "builtin:empathy",
        "name": "共情沟通",
        "description": "以共情为先的沟通教练，帮你把回应说得让人愿意听。",
        "prompt": _EMPATHY_PROMPT,
        "skillIds": ["builtin-skill:empathy"],
        "enabled": True,
        "builtin": True,
        "revision": 1,
    },
    {
        "id": "builtin:reflection",
        "name": "理性复盘",
        "description": "把一段对话拆成事实、判断和下一步行动的复盘助手。",
        "prompt": _REFLECTION_PROMPT,
        "skillIds": ["builtin-skill:reflection"],
        "enabled": True,
        "builtin": True,
        "revision": 1,
    },
    {
        "id": "builtin:guidance",
        "name": "沟通参谋",
        "description": "逐条解读潜台词，并给出场景化的沟通建议与可复制回复。",
        "prompt": _GUIDANCE_PROMPT,
        "skillIds": [GUIDANCE_SKILL_ID],
        "enabled": True,
        "builtin": True,
        "revision": 1,
    },
)

_ADVISOR_SKILL = (
    "参谋建议框架\n"
    "1. 目标：这段对话里用户真正想达成什么。\n"
    "2. 局势：对方的态度、情绪和可能的顾虑。\n"
    "3. 选项：给出 1-3 个可执行做法，注明直接收益与风险。\n"
    "4. 下一步：挑一个最小动作，并给出可观察的结果。"
)

_EMPATHY_SKILL = (
    "共情回应四步\n"
    "1. 观察：只描述发生了什么，不加评判。\n"
    "2. 感受：说出对方可能的感受。\n"
    "3. 需要：猜测感受背后的需要或在意点。\n"
    "4. 请求：提出清晰、可回应的小请求或回应方式。"
)

_REFLECTION_SKILL = (
    "复盘四问\n"
    "1. 事实是什么：只写聊天记录里能证实的内容。\n"
    "2. 我做了什么判断：哪些是推测，依据是什么。\n"
    "3. 哪里有效、哪里可以调整：针对做法，不针对人。\n"
    "4. 下次怎么做：给出一个可验证的小行动。"
)

# Moved here from the persona page's `#guidanceCard`: subtext reading plus scenario advice,
# now produced by the assistant with its own model instead of the separate API pipeline.
_GUIDANCE_SKILL = (
    "潜台词与沟通建议\n"
    "1. 潜台词：挑 3 到 6 条最值得解读的消息，逐条写「表面说法 → 可能的真实意图 → 用的手法或语气」。\n"
    "2. 局势：用一句话说明对方当下的态度、情绪与顾虑；证据不足就直说不确定。\n"
    "3. 建议：给 2 到 4 条可执行策略并注明收益与风险，再给 1 到 3 条可以直接发出的回复草稿，标注语气。\n"
    "4. 场景：默认按普通联系人给建议；用户说明是与领导或上级时，改用更稳妥、留余地的说法。\n"
    "5. 边界：只依据本会话资料，不臆测没有证据的内容；用户要求时再额外给针对自己的一面。"
)

_BUILTIN_SKILLS = (
    {
        "id": "builtin-skill:advisor",
        "name": "参谋建议框架",
        "description": "把局势分析变成目标、选项和下一步行动。",
        "content": _ADVISOR_SKILL,
        "builtin": True,
    },
    {
        "id": "builtin-skill:empathy",
        "name": "共情回应四步",
        "description": "观察、感受、需要、请求，四步组织一段回应。",
        "content": _EMPATHY_SKILL,
        "builtin": True,
    },
    {
        "id": "builtin-skill:reflection",
        "name": "复盘四问",
        "description": "区分事实与推测，找到下一步可验证的行动。",
        "content": _REFLECTION_SKILL,
        "builtin": True,
    },
    {
        "id": GUIDANCE_SKILL_ID,
        "name": "潜台词与沟通建议",
        "description": "逐条解读潜台词，并给出场景化的沟通建议与可复制回复。",
        "content": _GUIDANCE_SKILL,
        "builtin": True,
    },
)

_IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}\Z")


def builtin_agents():
    agents = copy.deepcopy(list(_BUILTIN_AGENTS))
    for agent in agents:
        agent["welcome"] = default_welcome(agent["name"])
    return agents


def default_welcome(name):
    return "嗨，我是你的" + name


def builtin_skills():
    return copy.deepcopy(list(_BUILTIN_SKILLS))


def builtin_agent_ids():
    return tuple(agent["id"] for agent in _BUILTIN_AGENTS)


def builtin_skill_ids():
    return tuple(skill["id"] for skill in _BUILTIN_SKILLS)


def new_identifier(prefix, random_hex):
    """Stable public id built from an injected random hex string (testable)."""
    return prefix + ":" + random_hex


def valid_identifier(value):
    return isinstance(value, str) and bool(_IDENTIFIER.fullmatch(value))


def valid_sha256(value):
    return (isinstance(value, str) and len(value) == 64 and
            all(char in "0123456789abcdef" for char in value))


# --- Field validation -------------------------------------------------------

def _control_free(value):
    return all(ord(char) >= 32 and ord(char) != 127 for char in value)


def single_line(value, field, maximum, allow_empty=False):
    if (not isinstance(value, str) or not _control_free(value) or len(value) > maximum or
            (not allow_empty and not value.strip())):
        raise AdvisorError("invalid-request", "invalid " + field)
    return value


def text_block(value, field, maximum, allow_empty=True):
    """Multiline text: newline/tab are allowed, other control characters are not."""
    if not isinstance(value, str) or len(value) > maximum:
        raise AdvisorError("invalid-request", "invalid " + field)
    if any(ord(char) < 32 and char not in "\n\r\t" for char in value):
        raise AdvisorError("invalid-request", "invalid " + field)
    if ord("\x7f") in (ord(char) for char in value):
        raise AdvisorError("invalid-request", "invalid " + field)
    if not allow_empty and not value.strip():
        raise AdvisorError("invalid-request", "invalid " + field)
    return value


def valid_scope_value(value, field):
    if (not isinstance(value, str) or not value or len(value) > MAX_SCOPE_VALUE or
            any(ord(char) < 32 or ord(char) == 127 for char in value)):
        raise AdvisorError("invalid-request", "invalid " + field)
    return value


def valid_request_id(value):
    if value is None:
        return None
    if (not isinstance(value, str) or not 1 <= len(value) <= MAX_REQUEST_ID or
            not _IDENTIFIER.fullmatch(value)):
        raise AdvisorError("invalid-request", "invalid requestId")
    return value


def valid_user_message(value):
    if (not isinstance(value, str) or not 1 <= len(value) <= MAX_USER_MESSAGE or
            not value.strip() or ord("\x00") in (ord(char) for char in value)):
        raise AdvisorError("invalid-request", "invalid message")
    return value


def valid_enabled(value):
    if type(value) is not bool:
        raise AdvisorError("invalid-request", "invalid enabled")
    return value


def valid_skill_ids(value):
    if not isinstance(value, list) or len(value) > MAX_SKILL_IDS:
        raise AdvisorError("invalid-request", "invalid skillIds")
    result = []
    for identifier in value:
        if not valid_identifier(identifier) or identifier in result:
            raise AdvisorError("invalid-request", "invalid skillIds")
        result.append(identifier)
    return result


# --- Skill import hygiene ---------------------------------------------------
# Imports are plain SKILL.md text only: no URLs, arbitrary local paths or
# scripts. Patterns stay deliberately conservative and documented.
_FORBIDDEN_SKILL_PATTERNS = (
    (re.compile(r"https?://|ftp://|file://|www\.", re.IGNORECASE), "url"),
    (re.compile(r"[A-Za-z]:[\\/]|\\\\[^\s\\]"), "path"),
    (re.compile(r"#!"), "script"),
    (re.compile(r"<script|javascript:", re.IGNORECASE), "script"),
    (re.compile(r"\b(?:eval|exec|os\.system|subprocess\.[A-Za-z_]+)\s*\("), "script"),
)


def validate_skill_content(content):
    text = text_block(content, "content", MAX_SKILL_CONTENT)
    for pattern, reason in _FORBIDDEN_SKILL_PATTERNS:
        if pattern.search(text):
            raise AdvisorError("invalid-request", "SKILL.md 包含不允许的内容（" + reason + "）")
    return text


def normalize_skill(name, description, content):
    return {
        "name": single_line(name, "name", MAX_SKILL_NAME),
        "description": single_line(description, "description", MAX_SKILL_DESCRIPTION, allow_empty=True),
        "content": validate_skill_content(content),
    }


def normalize_agent_payload(payload):
    """Validate a save payload without touching the catalog (membership checked by store)."""
    if not isinstance(payload, dict):
        raise AdvisorError("invalid-request", "invalid agent")
    identifier = payload.get("id")
    if identifier is not None and not valid_identifier(identifier):
        raise AdvisorError("invalid-request", "invalid agent id")
    return {
        "id": identifier,
        "name": single_line(payload.get("name"), "name", MAX_AGENT_NAME),
        "description": single_line(payload.get("description"), "description",
                                   MAX_AGENT_DESCRIPTION, allow_empty=True),
        "prompt": text_block(payload.get("prompt"), "prompt", MAX_AGENT_PROMPT),
        "welcome": (single_line(payload["welcome"], "welcome", MAX_AGENT_WELCOME, allow_empty=True)
                    if "welcome" in payload else None),
        "skillIds": valid_skill_ids(payload.get("skillIds")),
    }


# --- Model input budget -----------------------------------------------------

def char_budget(context_tokens):
    """Conservative character ceiling for one Advisor model input.

    Never presented as an exact token count; it leaves room for the model
    output and refuses nonsense saved budgets instead of trusting them.
    """
    if type(context_tokens) is not int or not 4096 <= context_tokens <= 1000000:
        context_tokens = DEFAULT_CONTEXT_TOKENS
    reserved = min(4096, max(512, context_tokens // 4))
    wire = (context_tokens - reserved) * CHAR_PER_TOKEN_NUM // CHAR_PER_TOKEN_DEN
    return max(0, wire)


def safety_margin(chars):
    return max(512, chars * SAFETY_MARGIN_PERCENT // 100)


# --- Runtime event normalization -------------------------------------------

def normalize_event(event, seq):
    """Copy one trusted runtime event into the stable wire shape.

    Unknown event types and non-string payload fields are dropped rather than
    failing a run; the parent runtime owns richer engine events.
    """
    if not isinstance(event, dict):
        return None
    kind = event.get("type")
    if kind not in EVENT_TYPES or kind in ("done", "error"):
        return None
    result = {"seq": seq, "type": kind}
    for key in ("text", "state", "messageId", "skillId"):
        value = event.get(key)
        if isinstance(value, str) and value:
            result[key] = value
    native_type = event.get("nativeType")
    if isinstance(native_type, str) and len(native_type) <= 128:
        result["nativeType"] = native_type
    for key, maximum in (("attempt", 10000), ("next", 10 ** 15)):
        value = event.get(key)
        if type(value) in (int, float) and 0 <= value <= maximum:
            result[key] = value
    return result


def terminal_event(seq, kind, state=None, text=None, message_id=None):
    event = {"seq": seq, "type": kind}
    if state is not None:
        event["state"] = state
    if text:
        event["text"] = text
    if message_id:
        event["messageId"] = message_id
    return event


def public_run(row):
    run = {"id": row["id"], "threadId": row["thread_id"], "state": row["state"]}
    if row.get("error"):
        run["error"] = row["error"]
    return run


def public_context(row):
    if row is None:
        return {"state": "idle", "revision": 0, "readCount": 0}
    snapshot = {"state": row["state"], "revision": row["revision"], "readCount": row["read_count"]}
    if row.get("total_count") is not None:
        snapshot["totalCount"] = row["total_count"]
    if row.get("error"):
        snapshot["error"] = row["error"]
    return snapshot


def compress_key(user, level, first_key, last_key):
    identity = json.dumps([COMPRESSION_VERSION, user, int(level), first_key, last_key],
                          ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def model_fingerprint(protocol, base_url, model, context_tokens):
    identity = json.dumps([protocol, base_url, model, context_tokens],
                          ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()
