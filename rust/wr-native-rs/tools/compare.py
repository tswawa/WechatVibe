"""Differential check for NativeService in fixture mode.

Fixture mode drives the same query / pagination / snapshot code as live mode without touching a
running WeChat process, so it is the only service-layer path with a reproducible input/output.

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

from wr import service  # noqa: E402

DATA = os.path.join(CRATE, "testdata")
SOURCE_DB = os.path.join(ROOT_REPO, "rust", "wr-query-rs", "testdata", "msg-1.db")
DB = os.path.join(DATA, "fixture.db")
MANIFEST = os.path.join(DATA, "manifest.json")
CACHE = os.path.join(DATA, "cache")
BINARY = os.path.join(CRATE, "target", "release", "wr-native.exe")

OPS = [
    {"op": "hello"},
    {"op": "status"},
    {"op": "accounts"},
    {"op": "contacts"},  # 未连接 -> not_connected
    {"op": "connect", "params": {"accountId": "acct-1"}},
    {"op": "status"},
    {"op": "contacts", "params": {}},
    {"op": "latest", "params": {"contactId": "c_a", "limit": 3}},
    {"op": "latest", "params": {"contactId": "c_missing"}},
    {"op": "latest", "params": {"contactId": "c_a", "limit": 0}},
    {"op": "latest", "params": {"accountId": "other", "contactId": "c_a"}},
    {"op": "connect", "params": {"accountId": "nope"}},
    {"op": "open_history", "params": {"accountId": "acct-1", "contactId": "c_a"}},
    {"op": "open_history", "params": {"accountId": "acct-1", "contactId": "nope"}},
    {"op": "read_history", "params": {"snapshotId": "__snap0", "limit": 3}},
    {"op": "read_history", "params": {"snapshotId": "__snap0", "limit": 3, "contextLimit": 2}},
    {"op": "read_history", "params": {"snapshotId": "missing"}},
    {"op": "close"},
]


def prepare():
    os.makedirs(DATA, exist_ok=True)
    shutil.copyfile(SOURCE_DB, DB)
    with open(MANIFEST, "w", encoding="utf-8") as handle:
        json.dump({
            "version": 1,
            "accounts": [{
                "id": "acct-1",
                "name": "测试账号",
                "username": "wxid_me",
                "contacts": [
                    {"id": "c_a", "username": "wxid_a", "name": "阿甲", "kind": "friend"},
                    {"id": "c_b", "username": "wxid_b", "name": "乙", "kind": "chatroom"},
                ],
                "shards": [{"id": "shard-1", "path": DB}],
            }],
        }, handle, ensure_ascii=False)
    if os.path.exists(CACHE):
        shutil.rmtree(CACHE)
    os.makedirs(CACHE, exist_ok=True)
    with open(os.path.join(DATA, "ops.json"), "w", encoding="utf-8") as handle:
        for op in OPS:
            handle.write(json.dumps(op, ensure_ascii=False) + "\n")


def run_python():
    svc = service.NativeService(CACHE, MANIFEST)
    out = []
    responses = []
    for op in OPS:
        try:
            name = op["op"]
            params = op.get("params", {})
            first_snapshot = next(
                (r["ok"]["snapshotId"] for r in responses
                 if "ok" in r and isinstance(r["ok"], dict) and "snapshotId" in r["ok"]),
                None,
            )
            for key, value in list(params.items()):
                if isinstance(value, str) and value.startswith("__snap") and first_snapshot:
                    params[key] = first_snapshot
            if name == "hello":
                value = svc.hello()
            elif name == "status":
                value = svc.status()
            elif name == "accounts":
                value = svc.accounts_method()
            elif name == "connect":
                value = svc.connect(params)
            elif name == "contacts":
                value = svc.contacts(params)
            elif name == "latest":
                value = svc.latest(params)
            elif name == "open_history":
                value = svc.open_history(params)
            elif name == "read_history":
                value = svc.read_history(params)
            elif name == "close":
                value = svc.close()
            else:
                raise SystemExit(f"unknown op {name}")
            responses.append({"ok": value})
        except service.errors.ProtocolError as exc:
            responses.append({"error": f"ProtocolError: {exc}"})
    out = responses
    svc.close()
    return out


def run_rust():
    if not os.path.exists(BINARY):
        print(f"missing {BINARY}; run: cargo build --release", file=sys.stderr)
        raise SystemExit(2)
    proc = subprocess.run(
        [BINARY, "--manifest", MANIFEST, "--cache", CACHE,
         "--ops", os.path.join(DATA, "ops.json")],
        check=True,
        capture_output=True,
    )
    responses = json.loads(proc.stdout)
    # 第一次运行：read_history 里的 __snap 占位符会失败，但 open_history 已给出本机生成的 id。
    # 用这个 id 重写 ops 再跑一次。
    first_snapshot = next(
        (r["ok"]["snapshotId"] for r in responses
         if "ok" in r and isinstance(r["ok"], dict) and "snapshotId" in r["ok"]),
        None,
    )
    if first_snapshot is None:
        return responses
    rewritten = []
    for op in OPS:
        item = json.loads(json.dumps(op))
        params = item.get("params", {})
        for key, value in list(params.items()):
            if isinstance(value, str) and value.startswith("__snap"):
                params[key] = first_snapshot
        rewritten.append(item)
    ops_file = os.path.join(DATA, "ops.json")
    with open(ops_file, "w", encoding="utf-8") as handle:
        for op in rewritten:
            handle.write(json.dumps(op, ensure_ascii=False) + "\n")
    proc = subprocess.run(
        [BINARY, "--manifest", MANIFEST, "--cache", CACHE, "--ops", ops_file],
        check=True, capture_output=True,
    )
    return json.loads(proc.stdout)


def normalise(value):
    if isinstance(value, dict):
        out = {}
        import re
        for key, item in value.items():
            if key == "error" and isinstance(item, str):
                item = re.sub(r"^ProtocolError\([^)]*\): ", "ProtocolError: ", item)
            out[key] = normalise(item)
        return out
    if isinstance(value, list):
        return [normalise(v) for v in value]
    if isinstance(value, str):
        import re
        return "<SNAP>" if re.fullmatch(r"[0-9a-f]{32}", value) else value
    return value


def main():
    prepare()
    py, rs = normalise(run_python()), normalise(run_rust())
    failures = []
    for index, (want, have) in enumerate(zip(py, rs)):
        if want != have:
            failures.append(
                f"op #{index} {OPS[index]['op']}:\n"
                f"  python {json.dumps(want, ensure_ascii=False)[:300]}\n"
                f"  rust   {json.dumps(have, ensure_ascii=False)[:300]}"
            )
    if len(py) != len(rs):
        failures.append(f"response count {len(py)} != {len(rs)}")
    for failure in failures:
        print(failure)
    print(f"{len(OPS) - len(failures)}/{len(OPS)} ops identical")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
