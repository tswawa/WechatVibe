"""Cases for `wr/fixture.py`, driven by the stable testdata tree next to this crate.

`load_fixture` only reads, so these replay deterministically. Paths are absolute on purpose:
`record` and `diff` may run from different working directories.
"""

from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
DATA = os.path.join(HERE, "testdata")
sys.path.insert(0, os.path.join(ROOT, "native-reader"))

CASES: list[dict] = []


def case(fn, *args):
    CASES.append({"fn": fn, "args": list(args)})


for name in (
    "manifest.json",
    "empty-accounts.json",
    "v2.json",
    "array.json",
    "no-version.json",
    "bool-version.json",
    "missing-shard.json",
    "shard-no-path.json",
    "account-no-id.json",
    "contact-no-username.json",
    "broken.json",
):
    case("load_fixture", os.path.join(DATA, name))

# 不存在的清单
case("load_fixture", os.path.join(DATA, "does-not-exist.json"))
# 目录当成清单
case("load_fixture", DATA)

with open(os.path.join(HERE, "golden-fixture.jsonl"), "w", encoding="utf-8") as f:
    for c in CASES:
        f.write(json.dumps(c, ensure_ascii=False) + "\n")
print(f"wrote {len(CASES)} cases")
