# 关系分类训练：relationship-linear（v3）

> 2026-11-07 起，本地分析的 relationship 信号由这个训练模型提供。
> v1 多项式朴素贝叶斯（`relationship-nb`）已退役，相关文件已删除。
> 这是独立的小模型，**没有微调 Laya ONNX 权重**。
> v3（2026-11-19）在字符 n-gram 之外加入**拒绝侧结构特征**，解决 v2 残余的含蓄拒绝误判。

## 1. 模型

| 项 | 值 |
| --- | --- |
| 算法 | 多项逻辑回归（full-batch GD + L2 + 幅度剪枝） |
| 特征 | 带边界符 `^…$` 的 Unicode 字符 1–4 gram + 拒绝侧结构特征，二值出现 |
| 训练集 | `split=train`，495 条 |
| 验证集 | `split=validation`，136 条 |
| 测试集 | `split=test`，350 条（70/类） |
| L2 / epochs / 剪枝 | 0.001 / 1200 / \|w\| < 0.02 置零 |
| 概率温度 | 0.35（仅验证集拟合，不改变 argmax） |
| 词表 / 导出权重 | 12,504 特征 / 10,488 个非零条目 |
| 模型版本 | `relationship-linear-v3-17bc5623` |
| 产物 | `electron/laya/relationship-linear-model.json`（442 KB） |
| 推理 | `electron/laya/relationship-linear.ts` |
| 训练 | `scripts/train-relationship-linear.py` |
| 报告 | `docs/laya-relationship-linear-report.json` |

## 2. 为什么换掉 v1 NB

| 对比 | v1 NB（旧） | v2 线性 |
| --- | --- | --- |
| 特征 | 字符 1–3 gram，无边界 | 字符 1–4 gram + 句首句尾边界 |
| train 5 折 CV（同一 415 条语料） | 87.0% | 89.4% |
| validation（当时 96 条） | 94.8% | 97.4% |
| 扩到 200 条独立 test | 旧 NB 口径 91% 以下 | 91.0% |

NB 的 `-n·log(den)` 长度项和偏向 warm/romantic 的类别先验，在句式变长、类别均衡的
评估集上会系统性偏向多数类。判别式 LR 直接学决策边界，且边界符能捕捉句首/句尾语气。

v1 的 95%（100 条 test）是较小评估集上的历史数字，**不能与 v2 的 300 条 test 直接比较**。

## 3. 训练方法

1. 在 train 上做 5 折交叉验证选 L2：`1e-4 / 3e-4 / 1e-3`。本轮三档 CV 同为 88.48%，
   平手时选更强正则。epochs 与剪枝阈值由上一轮网格搜索固定，不在本轮重选。
2. 用选中的配置在 train 上拟合；**validation 只用于温度缩放**，不参与特征或超参选择。
3. 训练后按 `|w| < 0.02` 剪枝并导出保留 6 位小数的权重。所有指标都用导出后的
   float64 权重重算，因此 Python 报告、`--check` 与 TypeScript 推理完全一致。
4. test 一次性评估，默认闸门 ≥90%，未达标脚本返回非零退出码。

分类别平衡训练（`class_weight`）在 train CV 上无收益、validation 下降 1–2 个百分点，
因此未启用。详见 `scripts/train-relationship-linear.py` 的方法说明。

### v3 结构特征的选型过程

v2 的 28 条 test 错例集中在两类：含蓄回绝（"把东西放门口就行，不要进门"被判 warm）
和含蓄表白（"这颗心早就不听劝了"被判 warm）。先做了一版同时加拒绝侧 + 表白侧
+ 人称/问号特征的实验，**validation 从 94.12% 升到 95.59%，但 test 闸门失败
（89%，267/300）**：rejecting/romantic 各涨 3/1 条，neutral 掉 5 条、warm 掉 3 条——
表白侧 cue 把中性与温暖误拉了过去。该版本已回滚，模型与报告未发布。

按铁律 test 已不可再用于选型，于是只用 validation 做第二轮 A/B：
- 仅拒绝侧 cue（`@neg` / `@neg_late` / `@dismiss` / `@imperative_start` / `@distance` / `@short`）：
  **97.06%**，三档 L2 一致；
- 拒绝侧 + 人称/问号 cue：95.59%；
- 去掉 `@short`：94.12%（短句恰是含蓄回绝的主要形态）。

选拒绝侧版本并冻结特征后，新写 r9 盲测 50 条（10/类），与全库最高
`SequenceMatcher` 0.70、字符二元组 Jaccard 0.308，从未参与任何选型。
最终 test 350 条 90.57%，r9 盲测 92%，闸门通过。

## 4. 结果

| 集合 | 正确 | 准确率 | 宏召回 |
| --- | ---: | ---: | ---: |
| validation | 132/136 | 97.06% | 97.06% |
| **test（全部 350 条）** | **317/350** | **90.57%** | **90.57%** |

test 分层（`docs/laya-relationship-linear-report.json` 的 `test.byBatch`）：

| 批次 | 条数 | 正确 | 准确率 | 用途 |
| --- | ---: | ---: | ---: | --- |
| 早期批次（原始 + r4 + r6） | 200 | 181 | 90.50% | 历史对照 |
| r7 | 50 | 46 | 92.00% | 开发测试，曾用于发现含蓄表达缺口 |
| r8 | 50 | 44 | 88.00% | v2 最终盲测 |
| **r9** | **50** | **46** | **92.00%** | **v3 最终盲测，特征冻结后新写、从未参与选型** |

分类别（test 350 条）：

| 类别 | 正确 | 召回 |
| --- | ---: | ---: |
| rejecting | 65/70 | 92.9% |
| distant | 61/70 | 87.1% |
| neutral | 63/70 | 90.0% |
| warm | 65/70 | 92.9% |
| romantic | 63/70 | 90.0% |

v2 的 rejecting 召回是 80%（48/60），v3 提升到 92.9%：拒绝侧结构特征
（句尾否定、删/退/撤/拉黑、祈使开头、距离词、短句）抓住了"把东西放门口就行"
这类读起来像事务安排的含蓄回绝。代价是 distant 从 91.7% 降到 87.1%——
部分冷淡表达被结构特征推向了拒绝侧。

概率校准：validation NLL 0.122，Brier 0.056。

## 5. 语料与迭代过程

`tests/fixtures/laya-affinity-corpus.jsonl`，981 条，全部手写合成，不含用户聊天：
train 495 / validation 136 / test 350，test 每类严格 70 条。
详见 `docs/laya-scoring-calibration.md` §2。

迭代过程：

| 步骤 | 日期 | 动作 | 结果 |
| --- | --- | --- | --- |
| 1 | 11-07 | 换 LR + 边界 1–4 gram，语料 551 → 731 | test 200 条 91.0% |
| 2 | 11-07 | 新增 r7 盲测 50 条 | r7 只有 80%，闸门失败；定位含蓄表达缺口 |
| 3 | 11-07 | 补弱关键词 train/val + r8 盲测 50 条 | test 300 条 90.67%，r8 盲测 90%，v2 通过 |
| 4 | 11-19 | 加拒绝侧结构特征（仅 train/val 选型）+ r9 盲测 50 条 | test 350 条 90.57%，r9 盲测 92%，v3 通过 |

独立性校验：

- r9 与全库最高 `SequenceMatcher` 相似度 **0.700**、字符二元组 Jaccard **0.308**，无 ≥0.75 近似对。
- r8 与其余 881 条最高 0.700、平均最近邻 0.541；r7 最高 0.696。
- 全库字符二元组 Jaccard 闸门 < 0.65。
- 文本全局唯一；`tests/laya-affinity-corpus.test.ts` 固定每类计数、唯一性、无 split 泄漏和近重复闸门。

## 6. 生产接入

```
classifyMessage(targetText)
  → relationshipTextProbabilities(text)   # electron/laya/relationship-linear.ts
  → relationship distribution
  → messageScore → affinity-v2
```

- 普通 OTHER 消息、`messageLabelsOnly` 细标签、批量分析统一使用该分布。
- `electron/analysis.ts` 的 `ANALYSIS_VERSION` 纳入 `RELATIONSHIP_LINEAR_VERSION`，
  模型版本变化后旧缓存自动失效。
- `scripts/stage-real-client.py` 的 `LAYA` 白名单已换成
  `relationship-linear.ts` 与 `relationship-linear-model.json`，发布包不会漏文件。
- 概率经温度 0.35 缩放，直接进入 `relationshipConfidence` 与好感度聚合。

## 7. 复现

```bash
# 重训（需要 numpy；系统 Python 与 .venv 均已安装）
npm run train:relationship-linear

# 只验证已发布模型与 90% 闸门
python scripts/train-relationship-linear.py --check

# 模型契约、语料均衡与近重复
node --import tsx --test tests/relationship-linear.test.ts tests/laya-affinity-corpus.test.ts
```

## 8. 验证记录（2026-11-19，v3）

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| 定向 Node 测试（模型 + 语料） | 4/4 |
| 模型 90% 闸门 `--check` | 317/350 = 90.57%，通过 |
| 完整 Node 套件 | 全通过 |
| 完整 Python 套件 | 全通过 |

## 9. 局限与下一步

1. 90.57% 是**合成语料 test** 的成绩，不等于真实微信聊天准确率。
2. 字符 n-gram + 结构特征仍靠词面；含蓄表白（romantic 90%）比拒绝侧改善小，
   distant 从 91.7% 降到 87.1%，部分冷淡被结构特征推向拒绝侧。
3. 继续调权重收益有限。下一步应建立**用户明确授权的真实聊天标注集**，
   保持 train/validation/test 隔离，再跑同一脚本和 90% 闸门。
4. 若真实语料仍卡在含蓄表达，可考虑一个小型语义编码器（bge-m3 / MiniLM）
   冻结 embedding + 线性头，或用它给本模型做特征增强；这仍不是微调 Laya ONNX。
