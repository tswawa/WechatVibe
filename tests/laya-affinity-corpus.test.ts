// The affinity corpus is hand-authored, not derived from user chats. This test keeps it
// balanced and prevents a text from appearing in more than one split.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { it } from "node:test";

const LABELS = ["rejecting", "distant", "neutral", "warm", "romantic"] as const;
const SPLITS = ["train", "validation", "test"] as const;
/**
 * Per-label row count in each split. Warm/romantic are deliberately enriched on
 * train/validation (positive-only supplement); metrics in the trainer therefore use
 * macro averages instead of raw accuracy. Test is strictly 70/class across six
 * batches: the original 4, r4 (+16), r6 (+20), r7 (+10 dev), r8 (+10 v2 blind)
 * and r9 (+10 v3 blind, authored after v3 features were frozen).
 */
const EXPECTED: Record<(typeof SPLITS)[number], Record<(typeof LABELS)[number], number>> = {
  train: { rejecting: 84, distant: 88, neutral: 86, warm: 120, romantic: 117 },
  validation: { rejecting: 24, distant: 24, neutral: 24, warm: 32, romantic: 32 },
  test: { rejecting: 70, distant: 70, neutral: 70, warm: 70, romantic: 70 },
};

it("keeps the hand-authored affinity corpus balanced and leak-free", () => {
  const file = path.resolve("tests/fixtures/laya-affinity-corpus.jsonl");
  const rows = readFileSync(file, "utf8").trim().split(/\r?\n/u).map((line) => JSON.parse(line) as {
    id: string; text: string; label: string; target: number; split: string;
  });
  assert.equal(rows.length, 981);
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
  assert.equal(new Set(rows.map((row) => row.text)).size, rows.length);
  for (const split of SPLITS) {
    const slice = rows.filter((row) => row.split === split);
    assert.equal(slice.length, LABELS.reduce((sum, label) => sum + EXPECTED[split][label], 0));
    for (const label of LABELS) {
      assert.equal(slice.filter((row) => row.label === label).length, EXPECTED[split][label],
        `${split}/${label}`);
    }
  }
  for (const row of rows) {
    assert.ok(LABELS.includes(row.label as (typeof LABELS)[number]));
    assert.ok(Number.isInteger(row.target) && row.target >= 0 && row.target <= 100);
    assert.ok(row.text.length >= 3 && row.text.length <= 80);
  }

  // Character-bigram Jaccard catches near-duplicates that the exact-text set cannot. The current
  // maximum is about 0.54, so 0.65 leaves room for short, naturally similar Chinese sentences
  // while rejecting copy edits such as one-noun substitutions.
  const shingles = rows.map((row) =>
    new Set(Array.from({ length: Math.max(0, row.text.length - 1) }, (_, index) => row.text.slice(index, index + 2))));
  for (let i = 0; i < rows.length; i++) {
    for (let j = 0; j < i; j++) {
      const left = shingles[i]!;
      const right = shingles[j]!;
      let intersection = 0;
      for (const gram of left) if (right.has(gram)) intersection++;
      const union = left.size + right.size - intersection;
      const similarity = union ? intersection / union : 0;
      assert.ok(similarity < 0.65,
        `near-duplicate corpus rows ${rows[i]!.id} / ${rows[j]!.id}: ${similarity.toFixed(3)}`);
    }
  }
});
