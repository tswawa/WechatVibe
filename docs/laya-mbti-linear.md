# MBTI 证据分类器：mbti-linear（v1）

> 2026-11-07 起，本地分析链的 MBTI 证据由这个训练模型提供。
> 它是**单条消息的证据模型**，不是人格定论；最终四字母仍由
> `backend_contracts.mbti_from_totals` 在 100 条消息 / 每轴 30 证据 / 0.2 差值门槛后给出。

## 1. 模型

| 项 | 值 |
| --- | --- |
| 算法 | 4 个独立 3 分类多项逻辑回归头，共享词表 |
| 每轴标签 | `[insufficient, 左极, 右极]`：`EI`=E/I、`SN`=S/N、`TF`=T/F、`JP`=J/P |
| 特征 | 带边界符 `^…$` 的 Unicode 字符 1–4 gram，二值出现 |
| 训练/验证/测试 | 384 / 48 / 48 行（每轴每类 32 / 4 / 4） |
| L2 / epochs / 剪枝 | CV 选中 0.001 / 1200 / `\|w\| < 0.02` |
| 每轴温度 | EI 0.25、SN 0.35、TF 0.5、JP 0.5（validation 拟合，不改 argmax） |
| 模型版本 | `mbti-linear-v1-6d442382` |
| 产物 | `electron/laya/mbti-linear-model.json` |
| 推理 | `electron/laya/mbti-linear.ts` |
| 训练 | `scripts/train-mbti-linear.py` |
| 报告 | `docs/laya-mbti-linear-report.json` |
| 语料 | `tests/fixtures/laya-mbti-corpus.jsonl` |

输出保持 `PersonalityEvidence { EI:{E,I,insufficient}, … }` 契约不变，因此
`shared/contracts.ts`、`bridge/profile_state.py`、`bridge/batch_state.py`、
`backend_contracts.py` 的累积与聚合逻辑**零改动**。

## 2. 语料

480 行、360 条唯一文本，全部手写合成，不含用户聊天。

- 4 轴 × 3 类 × (train 32 / validation 4 / test 4)
- 24→40 条共享事务句作为所有轴的 `insufficient` 样本，因此唯一性按 `(axis, text)` 断言
- 最高 `SequenceMatcher` 相似度 **0.667**，平均最近邻 **0.370**，无 ≥0.75 近似对
- 全库字符二元组 Jaccard 最高 **0.556**，闸门 < 0.65
- val/test 文本与 train 严格隔离；三轮扩充只加 train，val/test 文本从未改动

`tests/laya-mbti-corpus.test.ts` 固定每类计数、`(axis,text)` 唯一、无 split 泄漏与近重复闸门。

## 3. 训练方法

1. `split=train` 上 5 折 CV 选共享 L2，**按轴内文本分折**（早期按全局文本分折会把
   24 条共享 `insufficient` 句摊到每一折，CV 掉到 0.46，无参考意义）。
2. 4 个头分别拟合；validation 只用于选每轴温度，不参与拟合。
3. 导出保留 6 位小数的权重；所有指标用导出后的 float64 权重重算，保证
   Python 报告 / `--check` / TypeScript 推理一致。
4. `split=test` 一次性评估，默认闸门 ≥90%，未达标脚本返回非零退出码。

## 4. 结果

| 集合 | 正确 | 准确率 |
| --- | ---: | ---: |
| validation | 41/48 | 85.42% |
| **test** | **45/48** | **93.75%** |

test 分类别轴：

| 轴 | 正确 | 准确率 |
| --- | ---: | ---: |
| EI | 11/12 | 91.7% |
| SN | 12/12 | 100% |
| TF | 11/12 | 91.7% |
| JP | 11/12 | 91.7% |

CV（按轴内文本分折）：最佳 L2=0.001 时约 0.64，低于 holdout；每折只有约
4/5 训练样本，且每类样本很少，CV 只用于相对排序，不作为发布指标。

### 迭代过程

| 步骤 | 动作 | test |
| --- | --- | --- |
| 1 | 首版 16 条/类，固定 4 题提示词基线 | 85.4%（闸门失败） |
| 2 | 修 CV 分折、扩 L2 网格 | 85.4%，超参不是瓶颈 |
| 3 | train 扩到 24 条/类 | 87.5% |
| 4 | validation 超参搜索（gram/epochs/L2，27 组） | 全部停在 85.4%，确认瓶颈是语料 |
| 5 | train 扩到 32 条/类 | 95.8%，但查出 4 对 ≥0.75 近重复 |
| 6 | 替换 4 条近重复句后重训 | **93.75%**，最高相似度降到 0.667 |

第 6 步是最终版本。剔除近重复后 95.8% → 93.75%，说明 2 个点来自词面泄漏。

## 5. 生产接入

```
classifyMessage(targetText)
  → mbtiEvidenceForText(text)
  → PersonalityEvidence
  → profile_state.add_result → mbti_from_totals
```

- `electron/analysis.ts` 的 `ANALYSIS_VERSION` 纳入 `MBTI_LINEAR_VERSION`，
  模型更新后旧本地画像缓存自动失效。
- `mbtiEvidenceForText` 复刻 `personalityEvidenceFromAnswers` 的弃权闸：
  四轴都没有任何一极超过 `insufficient` 时返回 `null`，不制造证据。
- **API 画像链保持原样**：`api-portrait-classifier.ts` 仍用 4 个固定题面 +
  `personalityEvidenceFromAnswers`。这与关系模型的架构一致（本地用训练模型、
  API 用 LLM 题），且 `API_PORTRAIT_CLASSIFIER_VERSION` 不含模型版本。
- 发布白名单 `scripts/stage-real-client.py` 已加入 `mbti-linear.ts` 与模型 JSON。

`mbtiEvidenceForTexts` 提供整批 target 文本的平均证据，供未来 API 链切换使用；
当前生产未启用。

## 6. 复现

```bash
npm run train:mbti-linear
python scripts/train-mbti-linear.py --check
node --import tsx --test tests/mbti-linear.test.ts tests/laya-mbti-corpus.test.ts
```

## 7. 验证（2026-11-07）

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| 模型闸门 `--check` | 45/48 = 93.75%，通过 |
| MBTI 契约 + 语料 + 旧证据测试 | 7/7 |
| 完整 Node 套件 | **882/882** |
| 发布清单 / 脚本入口 | 10/10、3/3 |

## 8. 边界与下一步

1. 93.75% 是**合成语料 test** 的成绩，不等于真实微信聊天准确率。
2. 单条消息只提供证据；短事务消息会正确弃权。人格结论仍受 100/30/0.2 门槛约束。
3. 本地链已不再把 4 个 `PERSONALITY_QUESTIONS` 送进 Laya（2026-11-17）：这些答案本来就由本模型
   覆盖。同一轮把 `relationship` 题一起摘掉（改由 `relationship-linear` 负责），本地画像题集从
   13 题降到 8 题（emotion + intent + 6 个 style），`ANALYSIS_VERSION` 追加 `local-questions-v2`
   让旧缓存重算。API 画像链的 58 题契约不变。
4. 下一步应建立用户明确授权的真实聊天标注集，保持 train/validation/test 隔离，
   再跑同一脚本与 90% 闸门。含蓄偏好（尤其 EI/JP 边界）仍是主要误差来源。
