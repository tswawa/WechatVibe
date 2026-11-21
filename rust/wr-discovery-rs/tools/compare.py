"""Differential check for the deterministic half of `wr/discovery.py`.

Builds a synthetic WeChat-like directory tree, runs the same ops through the original Python
module and the Rust binary, and compares every answer. `discover_shards` order is filesystem
dependent, so both sides sort by path before comparison.

    python tools/compare.py
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CRATE = os.path.dirname(HERE)
ROOT_REPO = os.path.dirname(os.path.dirname(CRATE))
sys.path.insert(0, os.path.join(ROOT_REPO, "native-reader"))

from wr import discovery as d  # noqa: E402

DATA = os.path.join(CRATE, "testdata")
TREE = os.path.join(DATA, "tree")
BINARY = os.path.join(CRATE, "target", "release", "wr-discovery.exe")


def make_tree() -> None:
    if os.path.exists(TREE):
        shutil.rmtree(TREE)
    os.makedirs(TREE)
    root = os.path.join(TREE, "xwechat_files")
    for account in ("acctA", "acctB"):
        storage = os.path.join(root, account, "db_storage")
        os.makedirs(storage, exist_ok=True)
        with open(os.path.join(storage, "msg.db"), "wb") as handle:
            handle.write(b"fake db")
    nested = os.path.join(root, "acctA", "db_storage", "nested")
    os.makedirs(nested, exist_ok=True)
    with open(os.path.join(nested, "other.db"), "wb") as handle:
        handle.write(b"nested db")
    with open(os.path.join(nested, "other.db-wal"), "wb") as handle:
        handle.write(b"wal")
    with open(os.path.join(nested, "ignore.txt"), "wb") as handle:
        handle.write(b"not a db")
    os.makedirs(os.path.join(root, "db_storage"), exist_ok=True)

    config = os.path.join(TREE, "config")
    os.makedirs(config, exist_ok=True)
    with open(os.path.join(config, "settings.json"), "w", encoding="utf-8") as handle:
        json.dump({"dataDir": root, "other": 1}, handle, ensure_ascii=False)
    with open(os.path.join(config, "legacy.ini"), "wb") as handle:
        handle.write(f"data_dir={root}\n".encode("gbk"))
    with open(os.path.join(config, "utf16.txt"), "wb") as handle:
        handle.write(b"\xff\xfe" + f"path={root}\n".encode("utf-16-le"))


def normalise(value):
    if isinstance(value, list):
        return [normalise(v) for v in value]
    if isinstance(value, dict):
        return {k: normalise(v) for k, v in value.items()}
    if isinstance(value, str):
        return value.replace("/", "\\")
    return value


def build_ops() -> list[dict]:
    root = os.path.join(TREE, "xwechat_files")
    first = os.path.join(root, "acctA", "db_storage")
    nested = os.path.join(first, "nested")
    config = os.path.join(TREE, "config")
    with open(os.path.join(config, "legacy.ini"), "rb") as handle:
        gbk_hex = handle.read().hex()
    with open(os.path.join(config, "utf16.txt"), "rb") as handle:
        utf16_hex = handle.read().hex()

    ops: list[dict] = [
        {"op": "opaque_account_id", "path": first},
        {"op": "opaque_account_id", "path": "."},
        {"op": "is_under", "path": nested, "root": first},
        {"op": "is_under", "path": first, "root": nested},
        {"op": "is_under", "path": first, "root": first},
        {"op": "decode_config_bytes", "hex": gbk_hex},
        {"op": "decode_config_bytes", "hex": utf16_hex},
        {"op": "decode_config_bytes", "hex": b"\xef\xbb\xbfhello".hex()},
        {"op": "decode_config_bytes", "hex": "fffe00"},
        {"op": "existing_absolute_directory", "value": first},
        {"op": "existing_absolute_directory", "value": f'"{first}"'},
        {"op": "existing_absolute_directory", "value": "relative\\path"},
        {"op": "existing_absolute_directory", "value": os.path.join(TREE, "missing")},
        {"op": "config_line_directory", "line": f"data_dir={first}"},
        {"op": "config_line_directory", "line": first},
        {"op": "config_line_directory", "line": f"prefix: {root}"},
        {"op": "config_line_directory", "line": "   "},
        {"op": "config_content_directories", "content": json.dumps({"dataDir": root})},
        {"op": "config_content_directories", "content": json.dumps([root, "bad"])},
        {"op": "config_content_directories", "content": json.dumps(root)},
        {"op": "config_content_directories", "content": f"\ufeffdataDir={first}\nother=1"},
        {"op": "config_content_directories", "content": f"[General]\npath={root}"},
        {"op": "discover_account_dirs", "roots": [root, os.path.join(TREE, "missing")]},
        {"op": "discover_account_dirs", "roots": [first]},
        {"op": "discover_shards", "path": root},
        {"op": "discover_shards", "path": os.path.join(TREE, "missing")},
    ]
    return ops


def run_python(ops: list[dict]) -> list[dict]:
    out = []
    for op in ops:
        name = op["op"]
        if name == "opaque_account_id":
            value = d.opaque_account_id(op["path"])
        elif name == "is_under":
            value = d._is_under(op["path"], op["root"])
        elif name == "decode_config_bytes":
            value = d._decode_config_bytes(bytes.fromhex(op["hex"]))
        elif name == "existing_absolute_directory":
            value = d._existing_absolute_directory(op["value"])
        elif name == "config_line_directory":
            value = d._config_line_directory(op["line"])
        elif name == "config_content_directories":
            value = d._config_content_directories(op["content"])
        elif name == "discover_account_dirs":
            value = sorted(d.discover_account_dirs(op["roots"]), key=lambda x: x.path)
            value = [{"$object": "AccountDir", "attrs": {k: getattr(v, k) for k in ("id", "path", "state", "message")}} for v in value]
        elif name == "discover_shards":
            value = sorted(d.discover_shards(
                type("AccountDir", (), {"path": op["path"]})()
            ), key=lambda x: x.path)
            value = [{"$object": "ShardFile", "attrs": {k: getattr(v, k) for k in ("id", "path", "wal_path")}} for v in value]
        else:
            raise SystemExit(f"unknown op {name}")
        out.append({"ok": value})
    return out


def run_rust(ops: list[dict]) -> list[dict]:
    if not os.path.exists(BINARY):
        print(f"missing {BINARY}; run: cargo build --release", file=sys.stderr)
        raise SystemExit(2)
    ops_file = os.path.join(DATA, "ops.json")
    with open(ops_file, "w", encoding="utf-8") as handle:
        for op in ops:
            handle.write(json.dumps(op, ensure_ascii=False) + "\n")
    proc = subprocess.run([BINARY, "--ops", ops_file], check=True, capture_output=True)
    return json.loads(proc.stdout)


def main() -> int:
    make_tree()
    ops = build_ops()
    py = normalise(run_python(ops))
    rs = normalise(run_rust(ops))
    failures = []
    for index, (want, have) in enumerate(zip(py, rs)):
        if want != have:
            failures.append(
                f"op #{index} {ops[index]['op']}:\n"
                f"  python {json.dumps(want, ensure_ascii=False)[:260]}\n"
                f"  rust   {json.dumps(have, ensure_ascii=False)[:260]}"
            )
    if len(py) != len(rs):
        failures.append(f"response count {len(py)} != {len(rs)}")
    for failure in failures:
        print(failure)
    print(f"{len(ops) - len(failures)}/{len(ops)} ops identical")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
