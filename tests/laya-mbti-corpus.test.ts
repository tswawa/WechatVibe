// The MBTI evidence corpus is hand-authored and axis-scoped. Neutral logistics lines are
// deliberately reused as `insufficient` examples for all four axes, so uniqueness is asserted
// on (axis, text) pairs rather than on text alone. The r2/r3 test batches (24 rows each) were
// authored after the v2 features and then the v3 training corpus were frozen, and never used
// for feature or hyperparameter selection.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { it } from "node:test";

const AXES = ["EI", "SN", "TF", "JP"] as const;
const LABELS: Record<(typeof AXES)[number], [string, string, string]> = {
  EI: ["insufficient", "E", "I"],
  SN: ["insufficient", "S", "N"],
  TF: ["insufficient", "T", "F"],
  JP: ["insufficient", "J", "P"],
};
const PER_CLASS = { train: 38, validation: 4, test: 8 } as const;

it("keeps the MBTI evidence corpus balanced, leak-free and free of near-duplicates", () => {
  const file = path.resolve("tests/fixtures/laya-mbti-corpus.jsonl");
  const rows = readFileSync(file, "utf8").trim().split(/\r?\n/u).map((line) => JSON.parse(line) as {
    id: string; text: string; axis: string; label: string; split: string;
  });
  assert.equal(rows.length, 600);
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
  assert.equal(new Set(rows.map((row) => `${row.axis}\u0000${row.text}`)).size, rows.length);
  assert.equal(new Set(rows.map((row) => row.text)).size, 450); // 50 shared insufficient lines

  for (const axis of AXES) {
    for (const [split, expected] of Object.entries(PER_CLASS)) {
      const slice = rows.filter((row) => row.axis === axis && row.split === split);
      assert.equal(slice.length, expected * 3, `${axis}/${split}`);
      for (const label of LABELS[axis]) {
        assert.equal(slice.filter((row) => row.label === label).length, expected,
          `${axis}/${split}/${label}`);
      }
    }
    const testTexts = new Set(rows.filter((row) => row.axis === axis && row.split === "test")
      .map((row) => row.text));
    for (const row of rows.filter((item) => item.axis === axis && item.split !== "test"))
      assert.equal(testTexts.has(row.text), false, `test leak ${axis}: ${row.text}`);
  }

  const texts = [...new Set(rows.map((row) => row.text))].sort();
  const shingles = texts.map((text) =>
    new Set(Array.from({ length: Math.max(0, text.length - 1) }, (_, index) => text.slice(index, index + 2))));
  for (let i = 0; i < texts.length; i++) {
    for (let j = 0; j < i; j++) {
      const left = shingles[i]!;
      const right = shingles[j]!;
      let intersection = 0;
      for (const gram of left) if (right.has(gram)) intersection++;
      const union = left.size + right.size - intersection;
      assert.ok(!union || intersection / union < 0.65,
        `near-duplicate MBTI rows: ${texts[i]} / ${texts[j]}`);
    }
  }
});
