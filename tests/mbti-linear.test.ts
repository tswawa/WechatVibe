// Contract checks for the trained four-head MBTI evidence classifier.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { it } from "node:test";

import {
  MBTI_LINEAR_VERSION, mbtiAxisProbabilities, mbtiEvidenceForText, mbtiEvidenceForTexts,
} from "../electron/laya/mbti-linear";

const model = JSON.parse(readFileSync(
  path.resolve("electron/laya/mbti-linear-model.json"), "utf8")) as {
  version: string; corpusSha256: string; axes: string[];
  axisLabels: Record<string, string[]>; testAccuracy: number;
  weights: Record<string, number[]>;
};
const report = JSON.parse(readFileSync(
  path.resolve("docs/laya-mbti-linear-report.json"), "utf8")) as {
  version: string; passed: boolean; test: { overall: number };
};

it("ships a model trained from the current corpus", () => {
  const digest = createHash("sha256")
    .update(readFileSync(path.resolve("tests/fixtures/laya-mbti-corpus.jsonl")))
    .digest("hex");
  assert.equal(model.corpusSha256, digest, "corpus changed; rerun scripts/train-mbti-linear.py");
  assert.equal(MBTI_LINEAR_VERSION, model.version);
  assert.equal(report.version, model.version);
  assert.equal(report.passed, true);
  assert.deepEqual(model.axes, ["EI", "SN", "TF", "JP"]);
  assert.ok(Object.keys(model.weights).length > 1000);
});

it("holds the held-out accuracy gate through the shipped TypeScript path", () => {
  const rows = readFileSync(path.resolve("tests/fixtures/laya-mbti-corpus.jsonl"), "utf8")
    .trim().split(/\r?\n/u).map((line) => JSON.parse(line) as {
      text: string; axis: string; label: string; split: string;
    }).filter((row) => row.split === "test");
  assert.equal(rows.length, 96);
  let correct = 0;
  for (const row of rows) {
    const values = mbtiAxisProbabilities(row.text)[row.axis]!;
    const best = values.indexOf(Math.max(...values));
    correct += Number(model.axisLabels[row.axis]![best] === row.label);
  }
  const accuracy = correct / rows.length;
  assert.ok(accuracy >= 0.9, `TS MBTI accuracy ${accuracy} below 90%`);
  assert.ok(Math.abs(accuracy - model.testAccuracy) < 1e-9,
    `Python/TypeScript predictions diverged: ${accuracy} vs ${model.testAccuracy}`);
  assert.ok(Math.abs(accuracy - report.test.overall) < 1e-9);
});

it("returns normalized per-axis distributions and obeys the abstain gate", () => {
  const distribution = mbtiAxisProbabilities("周末约了三拨人，一个人待着反而没劲");
  assert.deepEqual(Object.keys(distribution).sort(), [...model.axes].sort());
  for (const axis of model.axes) {
    const values = distribution[axis]!;
    assert.equal(values.length, 3);
    assert.ok(Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) < 1e-9);
  }
  assert.ok(distribution.EI![1]! > distribution.EI![0]!, "clear E signal should beat insufficient");
  const logistics = mbtiAxisProbabilities("快递放前台了，记得拿");
  assert.ok(logistics.EI![0]! > logistics.EI![1]! && logistics.EI![0]! > logistics.EI![2]!);
  assert.equal(mbtiEvidenceForText("快递放前台了，记得拿"), null);
  const evidence = mbtiEvidenceForText("周末约了三拨人，一个人待着反而没劲");
  assert.ok(evidence && evidence.EI.E > evidence.EI.I);

  const averaged = mbtiEvidenceForTexts(["周末约了三拨人，一个人待着反而没劲",
    "一有空就想找人唠两句"]);
  assert.ok(averaged && averaged.EI.E > averaged.EI.I);
  assert.equal(mbtiEvidenceForTexts([]), null);
});
