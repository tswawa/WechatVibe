"""End-to-end check: build the golden set, replay it with the Rust binary, diff the JSON.

    python tools/compare.py

Exits non-zero on the first difference. `cargo test` runs the same comparison without the CLI.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CRATE = os.path.dirname(HERE)
BINARY = os.path.join(CRATE, "target", "release", "wr-query.exe")
TESTDATA = os.path.join(CRATE, "testdata")


def main() -> int:
    subprocess.run([sys.executable, os.path.join(HERE, "build-golden.py")], check=True)

    if not os.path.exists(BINARY):
        print(f"missing {BINARY}; run: cargo build --release", file=sys.stderr)
        return 2

    actual = subprocess.run(
        [
            BINARY,
            "--image", os.path.join(TESTDATA, "msg.db"),
            "--account", "wxid_self_account",
            "--self", "wxid_me",
            "--shard-id", "shard-1",
            "--ops", os.path.join(TESTDATA, "ops.json"),
        ],
        check=True,
        capture_output=True,
    )
    with open(os.path.join(TESTDATA, "actual.json"), "wb") as handle:
        handle.write(actual.stdout)

    expected = json.load(open(os.path.join(TESTDATA, "expected.json"), encoding="utf-8"))
    got = json.loads(actual.stdout)
    ops = [json.loads(line) for line in open(os.path.join(TESTDATA, "ops.json"), encoding="utf-8")]

    if len(expected) != len(got):
        print(f"op count differs: expected {len(expected)}, got {len(got)}", file=sys.stderr)
        return 1

    failures = 0
    for index, (want, have) in enumerate(zip(expected, got)):
        if want != have:
            failures += 1
            name = ops[index].get("op")
            print(f"op #{index} {name} (args {json.dumps(ops[index], ensure_ascii=False)})")
            print(f"  expected {json.dumps(want, ensure_ascii=False)[:300]}")
            print(f"  actual   {json.dumps(have, ensure_ascii=False)[:300]}")

    print(f"{len(expected) - failures}/{len(expected)} ops identical")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
