"""Reproducible micro-benchmarks for the hot paths named in docs/performance-analysis.md.

Development only: this file is not part of the packaged runtime (scripts/stage-real-client.py
copies an explicit SCRIPTS tuple). It never reads WeChat data; every fixture is synthetic.

    python scripts/run-project-python.py scripts/perf-baseline.py

Three measurements, each isolating one claim from the report:

1. `ResultStore` write cost per call versus one transaction per window.
2. Full `contact` table read (the shape `WeChatSource._contacts` builds) at 1k/5k/20k rows.
3. Portrait state size and decode cost after N results (what `analysis_progress_rows` loads).
"""
from __future__ import annotations

import json
import os
import statistics
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "bridge"))
os.chdir(ROOT)

from backend_contracts import SYSTEM_NAMES  # noqa: E402
from profile_signals import STYLE_LABELS  # noqa: E402
from profile_state import add_result, empty_state  # noqa: E402
from result_store import ResultStore  # noqa: E402
from wechat_source import avatar_candidates  # noqa: E402

import sqlite3  # noqa: E402


def timed(fn, repeat=1):
    samples = []
    for _ in range(repeat):
        started = time.perf_counter()
        fn()
        samples.append((time.perf_counter() - started) * 1000)
    return statistics.median(samples)


def result_payload(index):
    return {"emotion": [{"label": "happy", "probability": 0.6},
                        {"label": "neutral", "probability": 0.3}],
            "intent": [{"label": "chat", "probability": 0.5}],
            "intentBroad": [{"label": "social", "probability": 0.5}],
            "relationship": [{"label": "warm", "probability": 0.7}],
            "styleEvidence": {key: 0.5 for key in STYLE_LABELS},
            "personalityEvidence": None}


def message(index):
    return {"id": "m%05d" % index, "_sort": [index, "message__message_0.db", index],
            "senderId": "wxid_target", "side": "other"}


def bench_store():
    path = Path(tempfile.mkdtemp()) / "bench.sqlite3"
    store = ResultStore(path)
    with store.connect() as conn:
        journal = conn.execute("PRAGMA journal_mode").fetchone()[0]
        sync = conn.execute("PRAGMA synchronous").fetchone()[0]

    # `save` returns early when the id already exists, so every round must use fresh ids.
    counter = {"n": 0}

    def fresh():
        counter["n"] += 1
        return counter["n"]

    def single_round():
        for _ in range(100):
            index = fresh()
            store.save("a", "u", "v", message(index), result_payload(index))

    single = timed(single_round, repeat=3)

    def one_transaction():
        with store.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            for _ in range(100):
                index = fresh()
                item = message(index)
                conn.execute(
                    "INSERT OR REPLACE INTO results_v2 VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    ("a", "u", item["id"], item["_sort"][0], item["_sort"][1], item["_sort"][2],
                     "wxid_target", "other", json.dumps(result_payload(index)), 0.5, "v"))

    batched = timed(one_transaction, repeat=3)

    def fine_round():
        for _ in range(100):
            index = fresh()
            store.save_fine("a", "u", "v", message(index), result_payload(index))

    fine = timed(fine_round, repeat=3)

    def fine_batch():
        store.save_fine_many("a", "u", "v",
                             [(message(fresh()), result_payload(0)) for _ in range(100)])

    fine_many = timed(fine_batch, repeat=3)
    lookup = timed(lambda: [store.has("a", "u", "v", "m%05d" % i) for i in range(100)], repeat=3)
    return {"journal_mode": journal, "synchronous": sync,
            "save_per_call_ms": round(single / 100, 2),
            "save_fine_per_call_ms": round(fine / 100, 2),
            "save_fine_many_total_ms_100": round(fine_many, 1),
            "save_batched_total_ms_100": round(batched, 1),
            "save_batched_per_row_ms": round(batched / 100, 3),
            "has_per_call_ms": round(lookup / 100, 2)}


def bench_contacts(rows):
    path = Path(tempfile.mkdtemp()) / "contact.db"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE contact(username TEXT, nick_name TEXT, remark TEXT,"
                 " small_head_url TEXT, big_head_url TEXT)")
    conn.executemany("INSERT INTO contact VALUES(?,?,?,?,?)", [
        ("wxid_%06d" % i, "昵称%d" % i, "",
         "https://wx.qlogo.cn/mmhead/ver_1/%032d/132" % i,
         "https://wx.qlogo.cn/mmhead/ver_1/%032d/0" % i) for i in range(rows)])
    conn.commit()
    conn.close()

    def read_all():
        connection = sqlite3.connect(path)
        contacts = {}
        for user, nick, remark, small, big in connection.execute(
                "SELECT username,nick_name,remark,small_head_url,big_head_url FROM contact"):
            if user:
                candidates = avatar_candidates(small, big)
                name = (remark if remark and remark != user else
                        nick if nick and nick != user else SYSTEM_NAMES.get(user, user))
                contacts[str(user)] = {"name": name, "avatar": candidates[0] if candidates else "",
                                       "avatarCandidates": candidates}
        connection.close()

    return round(timed(read_all, repeat=3), 1)


def bench_state(count):
    state = empty_state()
    for i in range(count):
        add_result(state, result_payload(i), 0.5, "other",
                   [i, "message__message_0.db", i],
                   {"词%d" % ((i * 7 + j) % max(1, count // 2)): 1 for j in range(5)})
    blob = json.dumps(state, ensure_ascii=False)
    decode = timed(lambda: json.loads(blob), repeat=5)
    return {"state_kb": round(len(blob.encode()) / 1024, 1),
            "words": len(state["words"]), "json_loads_ms": round(decode, 2)}


def main():
    report = {
        "store": bench_store(),
        "contacts_full_read_ms": {str(n): bench_contacts(n) for n in (1000, 5000, 20000)},
        "profile_state": {str(n): bench_state(n) for n in (1000, 5000)},
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
