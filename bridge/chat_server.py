#!/usr/bin/env python3
"""Read-only local chat UI entry point; no WeChat database is opened on import."""
from __future__ import annotations

import re


def _tagged_text(text, tags):
    """Body of the leftmost ``<tag>``/``</tag>`` pair, or None when the text has no such pair.

    This replaces a lazy ``(.*?)`` regex, which is quadratic when many opening tags appear
    without a closing one: a message starting with ``<sysmsg`` and carrying 20000 unterminated
    ``<text>`` tokens took 35 s for 117 KB against 0.0014 s for the same size of plain text.
    Classification runs while the shared source lock is held, so one such message stalls every
    request. The answer here is the same leftmost/shortest pair in a single pass.
    """
    opened = [(text.find("<" + tag + ">"), tag) for tag in tags]
    opened = [(at, tag) for at, tag in opened if at >= 0]
    if not opened:
        return None
    start_at, tag = min(opened)
    # A closing tag anywhere after the leftmost opening tag is enough for the pair to exist.
    if max(text.rfind("</" + name + ">") for name in tags) < start_at:
        return None
    start = start_at + len(tag) + 2
    closes = [text.find("</" + name + ">", start) for name in tags]
    closes = [at for at in closes if at >= 0]
    return text[start:min(closes)] if closes else None


def classify(message_type, content):
    type_name = (message_type if isinstance(message_type, str) else
                 str(message_type) if isinstance(message_type, int) else "消息")
    text = content if isinstance(content, str) else ""
    text = re.sub(r"^(?:wxid_[\w-]+|[\w-]+@chatroom)\s*:\s*", "", text.strip())
    if text.startswith(("<msg", "<?xml", "<sysmsg", "<revokemsg")):
        if "<revokemsg" in text:
            return "system", ""
        if "<sysmsg" in text:
            body = _tagged_text(text, ("text", "content"))
            return "system", re.sub(r"<[^>]+>", "", body)[:80] if body is not None else ""
        for tag, kind, label in (("<img", "image", "[图片]"), ("<emoji", "other", "[表情]"),
                                 ("<voicemsg", "other", "[语音]"), ("<videomsg", "other", "[视频]")):
            if tag in text:
                return kind, label
        if "<appmsg" in text:
            body = _tagged_text(text, ("title",))
            return "other", re.sub(r"<[^>]+>", "", body)[:80] if body is not None else "[应用消息]"
        return "other", "[消息]"
    if type_name != "文本":
        if "图片" in type_name:
            return "image", "[图片]"
        return "other", "[" + type_name + "]"
    return "text", text


def main():
    # Embedded Python's isolated path omits the script directory. Import only
    # the bridge modules shipped beside this trusted entry point.
    import sys
    from pathlib import Path
    bridge_dir = str(Path(__file__).resolve().parent)
    if bridge_dir not in sys.path:
        sys.path.insert(0, bridge_dir)
    from real_http import main as serve
    return serve(classify)


if __name__ == "__main__":
    raise SystemExit(main())
