"""Unified message-input record and legacy wire projection.

This module is a pure contract boundary for the future OCR extension. It does not
read WeChat, decode media, or call any model. It normalizes an already-read source
row into a typed input record and projects it back to the legacy node wire
(``id``/``side``/``text``/``time``) plus an optional ``inputMeta`` envelope that is
carried only over the local IPC. Meta never reaches the model prompt.

It also owns the single rule for what a model may see: the ``text`` projected by
``prepare_item`` / ``to_wire`` has links (and bare WeChat placeholders) removed, and
``has_analysis_content`` decides whether a message is worth analysing at all. The caller's
item, the stored results and everything shown to the user keep the original text.

Facts it relies on:
- The WeChat source layer already emits ``time`` as integer milliseconds and already
  multiplies sub-1e10 values by 1000. ``0`` means unknown. This module never multiplies
  ``time`` again.
- Only the current reply body is available from ``appmsg``/``title``; no quoted author,
  body or time is recovered here. A missing quote stays unknown, never guessed.

Legacy wire compatibility:
- ``id`` keeps the old "non-empty string" rule (no new length/control limits).
- ``time`` keeps a finite non-negative number (ints and floats alike); ``0`` is the
  unknown sentinel and is preserved as-is.
- New metadata fields are bounded by Unicode codepoint and type-checked. Names and
  quote text are display text, so newlines/tabs/emoji are allowed verbatim; only IDs
  reject control characters.
"""
from __future__ import annotations

import math
import re
import unicodedata

SOURCE_KINDS = frozenset({"wechat", "ocr", "unknown"})

# ── Links never reach a model ───────────────────────────────────────────────
# A shared link is not what the analysis is about: the reading is of the message, and the
# URL is noise. In API mode it is also something we would rather not send. The rule is
# deliberately narrow — only a scheme or `www.` starts a link, so ordinary text is never
# eaten — and it applies wherever text is handed to a model. The chat display, the stored
# results and the message identity keep the original text untouched.
LINK_PATTERN = re.compile(r"(?:https?://|www\.)[^\s<>\"'“”‘’（）()\[\]【】{}《》]+", re.IGNORECASE)
# Punctuation that a trailing URL swallows from the sentence around it.
LINK_TAIL = "。，、；：！？…·.,;:!?)]}>”’\"'"

#: Message-type names WeChat renders as a bare placeholder. Such a message arrives as
#: ``kind == "other"`` in practice (``chat_server.classify`` labels it), so this list is a
#: narrow fallback for the odd case where a placeholder is seen as text.
PLACEHOLDER_NAMES = frozenset({
    "图片", "表情", "动画表情", "语音", "视频", "文件", "链接", "位置", "名片", "转账",
    "红包", "微信红包", "小程序", "音乐", "聊天记录", "合并转发", "视频号", "消息",
    "应用消息", "系统消息", "群公告", "拍一拍", "接龙", "卡券", "商品", "直播", "频道",
    "语音通话", "视频通话",
})
PLACEHOLDER_PATTERN = re.compile(r"^\[([^\[\]\s]{1,16})\]$")


def strip_links(text):
    """Return ``text`` without URLs; anything else, including punctuation, is kept."""
    if not isinstance(text, str) or not text:
        return text

    def drop(match):
        url = match.group(0)
        # A trailing "。" or "，" belongs to the sentence, not to the link.
        return url[len(url.rstrip(LINK_TAIL)):]

    return LINK_PATTERN.sub(drop, text)


def _punctuation_only(text):
    return all(unicodedata.category(char).startswith("P") or char.isspace() for char in text)


def analysis_text(text):
    """The text a model may see: links and bare placeholders removed, everything else kept.

    Returns ``""`` for a placeholder-only message, which is how both the caller and
    :func:`has_analysis_content` recognise "nothing to analyse here".
    """
    if not isinstance(text, str):
        return text
    if not text:
        return ""
    stripped = strip_links(text)
    match = PLACEHOLDER_PATTERN.match(stripped.strip())
    if match and match.group(1) in PLACEHOLDER_NAMES:
        return ""
    return stripped


def has_analysis_content(text):
    """True when a message carries something to analyse.

    Punctuation still counts on its own — it carries tone — so this is not a "letters
    required" test. The one case it excludes is a message that carried nothing but a link
    (or a link plus the punctuation around it): once the link is gone, there is no reading
    to make, and in API mode there is nothing worth paying for.
    """
    if not isinstance(text, str) or not text.strip():
        return False
    remaining = analysis_text(text)
    if not remaining.strip():
        return False
    if remaining != text and _punctuation_only(remaining):
        return False
    return True

MAX_ACCOUNT = 200
MAX_CONVERSATION = 256
MAX_SENDER_ID = 200
MAX_SENDER_NAME = 200
MAX_QUOTE_ID = 200
MAX_QUOTE_SENDER_ID = 200
MAX_QUOTE_SENDER_NAME = 200
MAX_QUOTE_TEXT = 4000


def _identifier(value, maximum, field):
    """ID-like new metadata: non-empty, bounded, control-free."""
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise ValueError("invalid " + field)
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError("invalid " + field)
    return value


def _display_text(value, maximum, field):
    """Display text: bounded by codepoint but newlines/tabs/emoji stay verbatim."""
    if not isinstance(value, str) or len(value) > maximum:
        raise ValueError("invalid " + field)
    return value


def _optional_identifier(value, maximum, field):
    if value is None or value == "":
        return None
    return _identifier(value, maximum, field)


def _optional_display(value, maximum, field):
    if value is None or value == "":
        return None
    return _display_text(value, maximum, field)


def _sent_at_ms(value, field="sentAtMs"):
    """Already-millisecond number; 0 means unknown. Never multiplied again."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("invalid " + field)
    try:
        finite = math.isfinite(value)
    except OverflowError:
        finite = False
    if not finite or value < 0:
        raise ValueError("invalid " + field)
    return value


def normalize_quote(quote):
    """Validate an optional quote envelope without recovering missing content.

    Accepts the canonical ``{id,senderId,senderName,text,sentAtMs}`` shape and the
    draft aliases ``author`` -> ``senderName`` and ``time`` -> ``sentAtMs``. It never
    derives ``senderId`` from a display name.
    """
    if quote is None:
        return None
    if not isinstance(quote, dict):
        raise ValueError("invalid quote")
    sender_name = quote.get("senderName")
    if sender_name is None:
        sender_name = quote.get("author")
    sent_at = quote.get("sentAtMs")
    if sent_at is None:
        sent_at = quote.get("time")
    result = {
        "id": _optional_identifier(quote.get("id"), MAX_QUOTE_ID, "quote.id"),
        "senderId": _optional_identifier(quote.get("senderId"), MAX_QUOTE_SENDER_ID,
                                         "quote.senderId"),
        "senderName": _optional_display(sender_name, MAX_QUOTE_SENDER_NAME, "quote.senderName"),
        "text": _optional_display(quote.get("text"), MAX_QUOTE_TEXT, "quote.text"),
        "sentAtMs": _sent_at_ms(sent_at, "quote.sentAtMs"),
    }
    if all(value is None for value in result.values()):
        return None
    return result


def normalize_input_meta(value):
    """Validate an existing metadata envelope into the canonical shape."""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("invalid inputMeta")
    kind = "unknown"
    source = value.get("source")
    if source is not None:
        if not isinstance(source, dict):
            raise ValueError("invalid inputMeta.source")
        kind = source.get("kind")
        if kind is None:
            kind = "unknown"
        if not isinstance(kind, str) or kind not in SOURCE_KINDS:
            raise ValueError("invalid inputMeta.source.kind")
    return {
        "accountId": _optional_identifier(value.get("accountId"), MAX_ACCOUNT,
                                          "inputMeta.accountId"),
        "conversationId": _optional_identifier(value.get("conversationId"), MAX_CONVERSATION,
                                               "inputMeta.conversationId"),
        "senderId": _optional_identifier(value.get("senderId"), MAX_SENDER_ID,
                                         "inputMeta.senderId"),
        "senderName": _optional_display(value.get("senderName"), MAX_SENDER_NAME,
                                        "inputMeta.senderName"),
        "sentAtMs": _sent_at_ms(value.get("sentAtMs"), "inputMeta.sentAtMs"),
        "source": {"kind": kind},
        "quote": normalize_quote(value.get("quote")),
    }


def _merge_scope(trusted, foreign, maximum, field):
    """Trusted scope wins; a conflicting foreign metadata scope is rejected."""
    if trusted is None:
        return foreign
    validated = _identifier(trusted, maximum, field)
    if foreign is not None and foreign != validated:
        raise ValueError("cross-" + field + " envelope")
    return validated


def _merge_known(left, right, field):
    if left is None:
        return right
    if right is not None and left != right:
        raise ValueError("conflicting " + field)
    return left


def _merge_time(left, right):
    if left in (None, 0):
        return right if right is not None else left
    if right in (None, 0):
        return left
    return _merge_known(left, right, "sentAtMs")


def _merge_quote(left, right):
    if left is None:
        return right
    if right is None:
        return left
    return {key: (_merge_time(left[key], right[key]) if key == "sentAtMs" else
                  _merge_known(left[key], right[key], "quote." + key)) for key in left}


def build_input_record(item, *, account_id=None, conversation_id=None, source_kind=None):
    """Normalize one source row into the unified input record.

    ``account_id``/``conversation_id`` are the caller's own trusted truth. An existing
    ``item['inputMeta']`` is validated and merged, never silently overwritten; a foreign
    scope is rejected instead of guessed. ``senderId``/``senderName`` come from the item
    (or its metadata) and stay null when missing, including SELF messages.
    """
    if not isinstance(item, dict):
        raise ValueError("invalid message item")
    stable_id = item.get("id")
    if not isinstance(stable_id, str) or not stable_id:
        raise ValueError("invalid id")
    side = item.get("side")
    if side not in ("self", "other"):
        raise ValueError("invalid side")
    text = item.get("text")
    if not isinstance(text, str):
        raise ValueError("invalid text")
    existing = normalize_input_meta(item.get("inputMeta"))
    account = _merge_scope(account_id, existing["accountId"] if existing else None,
                           MAX_ACCOUNT, "accountId")
    conversation = _merge_scope(conversation_id, existing["conversationId"] if existing else None,
                                MAX_CONVERSATION, "conversationId")
    sender_id = _merge_known(existing["senderId"] if existing else None,
                            _optional_identifier(item.get("senderId"), MAX_SENDER_ID, "senderId"), "senderId")
    sender_name = _merge_known(existing["senderName"] if existing else None,
                              _optional_display(item.get("senderName"), MAX_SENDER_NAME, "senderName"), "senderName")
    sent_at = _merge_time(existing["sentAtMs"] if existing else None,
                          _sent_at_ms(item.get("time"), "sentAtMs"))
    if source_kind is not None:
        if not isinstance(source_kind, str) or source_kind not in SOURCE_KINDS:
            raise ValueError("invalid source.kind")
        existing_kind = existing["source"]["kind"] if existing else "unknown"
        if existing_kind != "unknown" and source_kind != "unknown" and existing_kind != source_kind:
            raise ValueError("conflicting source.kind")
        kind = existing_kind if source_kind == "unknown" else source_kind
    elif existing:
        kind = existing["source"]["kind"]
    else:
        kind = "unknown"
    quote = _merge_quote(existing["quote"] if existing else None, normalize_quote(item.get("quote")))
    return {
        "id": stable_id,
        "side": side,
        "text": text,
        "accountId": account,
        "conversationId": conversation,
        "senderId": sender_id,
        "senderName": sender_name,
        "sentAtMs": sent_at,
        "source": {"kind": kind},
        "quote": quote,
    }


def record_to_meta(record):
    """Project a record to the local ``inputMeta`` envelope (no legacy fields)."""
    return {
        "accountId": record["accountId"],
        "conversationId": record["conversationId"],
        "senderId": record["senderId"],
        "senderName": record["senderName"],
        "sentAtMs": record["sentAtMs"],
        "source": {"kind": record["source"]["kind"]},
        "quote": record["quote"],
    }


def prepare_item(item, *, account_id=None, conversation_id=None, source_kind=None):
    """Return a shallow copy of ``item`` with a validated ``inputMeta`` attached.

    Legacy keys (``id``/``side``/``text``/``time``/...) keep their values, except ``text``:
    the copy carries the model-facing text — links and bare placeholders removed, see
    :func:`analysis_text`. The caller's item, the stored results and everything shown to the
    user keep the original text.
    """
    record = build_input_record(item, account_id=account_id, conversation_id=conversation_id,
                               source_kind=source_kind)
    prepared = dict(item)
    prepared["inputMeta"] = record_to_meta(record)
    if isinstance(prepared.get("text"), str):
        prepared["text"] = analysis_text(prepared["text"])
    return prepared


def prepare_messages(messages, *, account_id=None, conversation_id=None, source_kind=None):
    return [prepare_item(item, account_id=account_id, conversation_id=conversation_id,
                         source_kind=source_kind) for item in messages]


def to_wire(item, record, *, target_cap=None, context_cap=None, is_target=False):
    """Project one record back to the legacy node wire plus optional ``inputMeta``.

    The legacy fields keep their values and truncation, except ``text``: it is the
    model-facing text (``analysis_text``), so a link never reaches a prompt. Truncation is
    applied after that, to what the model would actually receive.
    """
    text = analysis_text(record["text"])
    cap = target_cap if is_target else context_cap
    if cap is not None:
        text = text[:cap]
    wire = {"id": record["id"], "side": record["side"], "text": text}
    if "time" in item:
        wire["time"] = item["time"]
    wire["inputMeta"] = record_to_meta(record)
    return wire
