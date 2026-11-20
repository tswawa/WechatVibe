# Laya 好感度训练：交接文档

> 写给下一个接手训练/评分的 AI。
> 先读本文，再读 `docs/laya-scoring-calibration.md`。本文只描述现状、操作方法和下一步，不重复完整原理。

## 0. 先做这五件事

1. `git status --short`。工作区有大量**其他会话的未提交改动**，不要整体 `stash`、`reset` 或回滚。
2. 读 `docs/laya-scoring-calibration.md`，确认当前评分链路和已知边界。
3. 运行 `npm run typecheck`，确认基线干净。
4. 用下文命令跑一次 WebGPU 训练，确认本机能复现当前结果。
5. 明确本次任务边界：**不要声称重新训练了 Laya 的 ONNX 权重**。仓库没有训练侧工程。

## 1. 目标与非目标

### 当前目标

优化“对方消息的关系信号 → 0~100 好感度”的准确性和稳定性：

- 关系分类提示词；
- 单条关系分到会话总分的聚合；
- 时间衰减、置信度权重；
- TypeScript 与 Python 两套持久化路径的一致性。

### 非目标，或需要用户明确授权

- 微调 `model.onnx`：没有训练图、优化器、权重导出工程。
- 抓取用户真实聊天做训练：必须先取得用户明确同意。
- 用未标注真实会话直接调提示词：会造成无法量化的过拟合。

## 2. 当前快照

| 项 | 值 |
| --- | --- |
| 日期 | 2026-11-01 建档，2026-11-07 v2 迭代，2026-11-19 v3，2026-11-20 全量复现 |
| 分支 | `perf/optimize-tokenizer` |
| Node | v22.22.2（`package.json` 声明 24.11.1） |
| Python | `.venv/Scripts/python.exe`，3.13.0 |
| 模型 | `.local/models/laya`，`laya-multilingual-onnx@d9d003d` |
| 生产关系分类 | 训练模型 `relationship-linear-v3-17bc5623`（边界字符 1–4 gram 逻辑回归 + 拒绝侧结构特征） |
| 本地 MBTI 证据 | 训练模型 `mbti-linear-v3-d5e77a1f`（4 轴 3 分类线性头 + 轴特定 cue），test 93/96 = 96.88% |
| Laya 关系提示词 | `relationship-v2`，现仅作回退/对照，不再决定本地关系分 |
| 评分头 | `affinity-v2`，半衰期 8 条，无权重下限 |
| GPU 后端 | WebGPU 可用；DirectML 不可用；CUDA 不可用 |
| 测试集结果 | **317/350，90.57%**；r9 最终盲测 46/50 = 92%；validation 132/136 = 97.06% |
| 旧 Laya 提示词结果 | 分类 55%、MAE 11.60（仅为历史对照，不再是当前准确率） |

当前工作区的历史合并冲突已随上游 1.3.6 合并清空（见 §9 的复现结果）。接手时先 `git status --short`
自查一次，仍有其他会话的在途改动时，**不要整体 `stash`、`reset` 或回滚**。

v2 迭代涉及的文件：

```text
A  electron/laya/relationship-linear.ts
A  electron/laya/relationship-linear-model.json
A  scripts/train-relationship-linear.py
A  tests/relationship-linear.test.ts tests/mbti-linear.test.ts tests/laya-mbti-corpus.test.ts
A  docs/laya-relationship-linear.md
A  docs/laya-relationship-linear-report.json
M  electron/analysis.ts、scripts/stage-real-client.py、package.json
M  tests/fixtures/laya-affinity-corpus.jsonl（931 条）
M  tests/laya-affinity-corpus.test.ts、scripts/laya-score-train.ts
D  electron/laya/relationship-nb.* 等 6 个 v1 文件（已退役）
```

## 3. 文件地图

| 文件 | 作用 |
| --- | --- |
| `tests/fixtures/laya-affinity-corpus.jsonl` | 931 条手写关系语料，唯一数据源 |
| `tests/fixtures/laya-mbti-corpus.jsonl` | 600 行 MBTI 证据语料（4 轴 × 3 类，450 唯一文本） |
| `scripts/train-mbti-linear.py` | MBTI 四头线性模型训练/校准/90% 闸门 |
| `electron/laya/mbti-linear.ts` | MBTI 生产推理（本地分析链） |
| `electron/laya/mbti-linear-model.json` | 训练产物 |
| `electron/laya/thread-tuning.ts` | CPU 线程数启发式、真实形状校准与结果缓存 |
| `scripts/benchmark-laya-threads.ts` | 一次性线程校准入口（`npm run benchmark:laya-threads`） |
| `docs/laya-mbti-linear.md` / `docs/laya-mbti-linear-report.json` | 模型卡与分层指标 |
| `scripts/train-relationship-linear.py` | **当前主模型**：关系分类训练/校准/90% 闸门 |
| `electron/laya/relationship-linear.ts` | 生产推理 |
| `electron/laya/relationship-linear-model.json` | 训练产物（447 KB） |
| `docs/laya-relationship-linear.md` | 模型卡与结果 |
| `docs/laya-relationship-linear-report.json` | 分层指标与模型溯源 |
| `scripts/laya-score-train.ts` | Laya 提示词/半衰期历史评测脚本 |
| `scripts/laya-score-eval.ts` | 手工分布场景和半衰期搜索，离线回归 |
| `electron/laya/options.ts` | 关系题面、版本号、权重 |
| `electron/laya/scoring.ts` | 单条分、置信度、指数聚合 |
| `electron/analysis.ts` | 缓存键、分析版本、结果组装 |
| `electron/api-portrait-classifier.ts` | API 画像分类、`scoreConfidence` |
| `bridge/backend_contracts.py` | `AFFINITY_HALF_LIFE`、Python 聚合入口 |
| `bridge/profile_state.py` | 逐条累计与乱序 tail 闭式更新 |
| `bridge/batch_state.py` | 批量累计、coverage 置信度 |
| `bridge/result_store.py` | `summary_v1` 和旧数据迁移 |
| `bridge/api_portrait_statistics.py` | API 画像统计，版本 2 |
| `bridge/message_results.py` | 保留关系分布，供 Python 算置信度 |
| `tests/laya-affinity-corpus.test.ts` | 语料均衡、唯一性、split 泄漏检查 |
| `tests/laya-scoring-calibration.test.ts` | 评分聚合回归 |
| `bridge/test_affinity_calibration.py` | Python 闭式累计/乱序/旧状态测试 |
| `docs/laya-scoring-calibration.md` | 完整诊断、结果、公式、迁移说明 |

## 4. 语料契约

JSONL，每行：

```json
{"id":"train-rom-01","text":"我喜欢你，想和你在一起。","label":"romantic","target":95,"split":"train"}
```

| 字段 | 约束 |
| --- | --- |
| `id` | 全局唯一 |
| `text` | 3~80 字符，全局不重复 |
| `label` | `rejecting / distant / neutral / warm / romantic` |
| `target` | 0~100 的整数，代表该类期望分数 |
| `split` | `train / validation / test` |

当前切分：总计 495/136/300，共 931 条。

- rejecting：84/24/60
- distant：88/24/60
- neutral：86/24/60
- warm：120/32/60
- romantic：117/32/60

test 严格 60/类，由五批组成：原始 4、r4 +16、r6 +20、r7 +10（开发测试）、
r8 +10（最终盲测）。r8 从未参与选型，与其余语料最高相似度 0.700、平均 0.541。
当前训练、验证和 test 指标均已按 931 条重跑。

评分区间：

```text
rejecting 0..30
distant   20..50
neutral   40..60
warm      58..85
romantic  80..100
```

**铁律**：test 只用于最终报告。不要看 test 错误后再改提示词、加规则或选参数。新增语料时优先加入
train/validation，保留原 test 不动；如果必须换 test，先记录旧版本结果并说明原因。
本轮曾按 r7 盲测暴露的缺口补语料，r7 因此降级为开发测试，最终闸门另起全新 r8 批次。

## 5. 训练流程

```text
当前主训练（scripts/train-relationship-linear.py）：
  train 495 + validation 136
    → 5 折 CV 选 L2
    → 边界字符 1-4 gram + 多项逻辑回归 + 幅度剪枝
    → validation 只拟合温度（不改 argmax）
    → test 300 一次性 90% 闸门，分层报告 r8 盲测

历史 Laya 评测（不再是生产关系来源）：
  train/validation 选提示词与半衰期
  test 300 仅最终对照
```

提示词候选在 `scripts/laya-score-train.ts` 的 `VARIANTS`：

- `baseline`：旧英文提示词；
- `production`：当前中文提示词（`relationship-v2`）；
- `implicit-romance` / `hard-reject` / `space-request` / `pure-logistics` / `no-warm-affection`：
  逐条边界规则；
- `compact-v3`：同等 token 预算下的紧凑重写；
- `order-reversed`：选项倒序，用来测位置偏置；
- `boundary-all`：**故意保留的截断样本**，运行时会打警告，不可用于比较。

提示词选择只使用 train；不要用 validation 去重新选 prompt，否则 validation 也不再独立。

10 个对话场景由语料输出拼接：友好后拒绝、冷淡后热恋、忽冷忽热、长期友好后新拒绝等。半衰期候选：
`4 / 6 / 8 / 10 / 12 / 16 / 24`。

**注意**：原 280 条语料下这 10 个场景已无法区分半衰期（6 条候选同为 80%，分辨率就是 10%），
脚本会打印同分提示并给出 16；生产值 8 的依据是离线噪声场景（`scripts/laya-score-eval.ts`）。
扩到 931 条后不要沿用这一结论；当前生产关系分类已改为 v2 线性模型，Laya 半衰期只影响聚合。
场景列不能跨语料版本比较，详见 `docs/laya-scoring-calibration.md` §6.4。

## 6. 当前结果

> 下面训练/验证数字是 **280 条语料池**的历史结果，用于说明上一轮为什么回退 v3；
> 以下 Laya 提示词数字是 280 条语料池的历史记录，保留用于解释为什么停止调提示词。
> 当前生产关系分类是 v2 线性模型：test 300 条 90.67%，r8 盲测 90%，
> 见 `docs/laya-relationship-linear.md`。本节表格全部是历史对照。

280 条池上，v3 在 train/validation 全胜、但 test 被否决：

| 候选 | train 区间 | train 准确率 | train MAE | val 区间 | val 准确率 |
| --- | ---: | ---: | ---: | ---: | ---: |
| hard-reject | 0.720 | 0.640 | 11.270 | 0.617 | 0.533 |
| implicit-romance（v3） | 0.705 | **0.660** | **11.785** | **0.700** | **0.600** |
| production-v2 | 0.695 | 0.630 | 12.030 | 0.650 | 0.583 |

最终 test：

| 配置 | 区间 | 分类 | MAE | 场景 |
| --- | ---: | ---: | ---: | ---: |
| v1 baseline + 线性权重 | 60~65% | 45% | 13.10~13.15 | 60% |
| v2 production + 8 条半衰期 | **70%** | **55%** | **11.60** | **70%** |

半衰期 6 和 8 在 validation 都是 80%；6 在离线低置信噪声场景掉到 52 分，8 保持 54 分且场景
12/12，因此选 8。

### 仍未解决

最终 test 的 9 个分类错误：

- 4 条明确暧昧判成 `warm`，分数 74~77；
- 2 条隐含拒绝判成 `distant`，分数 27/28；
- 2 条疏离判成 `neutral`，分数 48/55；
- 1 条事务消息判成 `distant`，分数 30。

继续手调 `RELATIONSHIP_WEIGHT` 会同时抬高 `warm`，不是正确方向。优先改分类器训练数据。

**P1 提示词边界：第一轮饱和，第二轮被 test 否决。**

1. 100 条语料上试了 10 个候选，没有一个超过 v2，最好的一条只多命中 1/60（§6.1）。
2. 语料扩到 280 条（test 仍冻结 20 条）后重跑：`implicit-romance` 在 200 train / 60 validation 上
   **五个指标全部领先**（train 0.705/0.660/11.79 vs v2 0.695/0.630/12.03，val 0.700/0.600 vs 0.650/0.583），
   于是写成 `relationship-v3` 并跑 test——结果分类准确率 **55%→45%**、MAE **11.60→12.00**，
   4 条 neutral 全错（`你到了给我发个位置。`→romantic 81）。**已回退到 v2**。

v1 NB 上线前，生产提示词是 `relationship-v2`，旧 test 指标为 70% / 55% / 11.60 / 70%。
细节见 `docs/laya-scoring-calibration.md` §6.1~§6.3。

顺带发现 `head_max_len=256` 是指令和选项的**共享**预算，超长会被静默截断（§6.2），改提示词前先跑
`--budget`。

## 7. 核心公式与一致性

```text
r = 0.5 ** (1 / 8)
weighted = Σ score·confidence·r^age / Σ confidence·r^age
affinity = round(50 + 50·clamp(weighted, -1, 1))
```

`confidence` 是关系分布到均匀分布的总变差距离，one-hot=1，均匀=0。

增量/乱序闭式更新：

```text
state' = r^m · state + (1 - r^m) · tail + new_block
```

- `scoreExp = Σ score·confidence·r^age`
- `confidenceExp = Σ confidence·r^age`
- 旧状态没有这两个字段时，`affinity_from_progress` 回退 v1，禁止混算。
- `summary_v1` 新增 `score_exp`、`confidence_exp`；旧汇总会从 `results_v2` 重建一次。
- `AFFINITY_HALF_LIFE=8` 同时定义在 `backend_contracts.py` 和 `scoring.ts`，改一处必须同步另一处，
  并升 `AFFINITY_CALIBRATION.version` 和 `ANALYSIS_VERSION`。
- API 画像统计版本已从 1 升到 2。

## 8. 可复现命令

```bash
cd /d/project/weixinAnalyzer

# 环境前提：`npm run train:*` 里的 python 是系统解释器，本机没有 numpy，必须用仓库 venv；
# Laya 提示词评测还要指定模型目录（默认 .models/laya，仓库实际放在 .local/models/laya）。
PY=.venv/Scripts/python.exe
export LAYA_MODEL_DIR=/d/project/weixinAnalyzer/.local/models/laya

# 当前主模型：重训 / 只验闸门 / 契约测试
$PY scripts/train-relationship-linear.py
$PY scripts/train-relationship-linear.py --check
node --import tsx --test tests/relationship-linear.test.ts tests/laya-affinity-corpus.test.ts

# Laya CPU 线程一次性校准（首次约 1 分钟，之后启动命中缓存）
npm run benchmark:laya-threads

# MBTI 证据分类器
$PY scripts/train-mbti-linear.py
$PY scripts/train-mbti-linear.py --check
node --import tsx --test tests/mbti-linear.test.ts tests/laya-mbti-corpus.test.ts

# Laya 评分头训练：默认 auto（Windows WebGPU 优先），test 只在 winner/baseline 上解码
# 当前语料 981 条下全量约 11.5 分钟（7010 次前向）；改提示词迭代一律加 --train-only，
# 只做语料校验加 --dry-run。冒烟用 LAYA_TRAIN_LIMIT=5。
npm run train:laya-score
node --import tsx scripts/laya-score-train.ts --train-only       # 完全不解码 test
node --import tsx scripts/laya-score-train.ts --provider=cpu     # 显式 CPU，约慢 3~4 倍
LAYA_TRAIN_LIMIT=3 node --import tsx scripts/laya-score-train.ts --train-only  # 冒烟

# 语料校验，不需要模型
node --import tsx scripts/laya-score-train.ts --dry-run

# 提示词 token 预算与截断检查（不需要模型推理，改提示词前先跑）
node --import tsx scripts/laya-score-train.ts --budget

# 只跑 train/validation，绝不读 test（调提示词时用这个）
LAYA_MODEL_DIR=/d/project/weixinAnalyzer/.local/models/laya \
  node --import tsx scripts/laya-score-train.ts --provider=webgpu --train-only

# CPU 训练
LAYA_MODEL_DIR=/d/project/weixinAnalyzer/.local/models/laya \
  node --import tsx scripts/laya-score-train.ts --provider=cpu

# Windows GPU（推荐）
LAYA_MODEL_DIR=/d/project/weixinAnalyzer/.local/models/laya \
  node --import tsx scripts/laya-score-train.ts --provider=webgpu

# npm 形式
npm run train:laya-score -- --provider=webgpu

# 离线场景
node --import tsx scripts/laya-score-eval.ts
node --import tsx scripts/laya-score-eval.ts --grid

# 真实模型冒烟
LAYA_MODEL_DIR=/d/project/weixinAnalyzer/.local/models/laya npm run test:model
```

PowerShell 使用：

```powershell
$env:LAYA_MODEL_DIR = "D:\project\weixinAnalyzer\.local\models\laya"
npm run train:laya-score -- --provider=webgpu
```

## 9. 验证清单

提交或交付前至少运行：

```bash
npm run typecheck
node --import tsx --test tests/laya-affinity-corpus.test.ts tests/laya-scoring-calibration.test.ts \
  tests/relationship-linear.test.ts
.venv/Scripts/python.exe bridge/test_affinity_calibration.py
.venv/Scripts/python.exe bridge/test_incremental_reconciliation.py
.venv/Scripts/python.exe bridge/test_api_portrait_statistics.py
.venv/Scripts/python.exe bridge/test_message_results.py
npm run test:node
npm run test:python
```

最近一次结果：

- `npm run typecheck`：通过；
- 关系模型 v3：validation 97.06%，test 317/350 = 90.57%，r9 盲测 46/50 = 92%；
- MBTI 模型 v3：validation 93.75%，test 93/96 = 96.88%，`--check` 闸门通过；
- 模型 + 语料契约测试全通过（TS 与 Python 推理数值一致）；
- 真实模型冒烟：通过；
- 完整 Node / Python 套件：全通过。

2026-11-20 全量复现（WebGPU，`scripts/laya-score-train.ts` 7010 次前向 / 689.8s）：

- 关系模型 v3：validation 132/136 = 97.06%，test 317/350 = 90.571%，r9 盲测 46/50 = 92%，
  `passed: true`；模型与报告 **零字节变化**，训练完全确定。
- MBTI 模型 v3：test 93/96 = 96.875%，`passed: true`；同样零字节变化。
- 契约与回归：`relationship-linear` / `mbti-linear` / 语料 / `laya-scoring-calibration` 16/16；
  `bridge/test_affinity_calibration` / `test_incremental_reconciliation` / `test_api_portrait_statistics` /
  `test_message_results` 四个 Python 测试全 OK；`npm run typecheck` 通过。
- Laya 提示词路径（历史对照，不再是生产关系）：10 候选中 `implicit-romance` 训练最优
  （区间 0.668 / 召回 0.605 / MAE 12.511），test 58% / MAE 14.297 / 场景 90%；
  v1 baseline 为 56% / 16.971 / 70%。合成语料上提示词方法的天花板仍在六成上下，
  再次说明生产关系必须走线性分类器。
- 离线场景 `laya-score-eval.ts`：v2（现行聚合）12/12，v1 10/12；被否决的对比度拉伸方案结论不变。
- 半衰期候选表在 981 条语料上给出 4（验证场景 90% / 档位距离 4）> 8（80% / 10）。
  生产仍用 8：依据是上面这份离线噪声场景与「改聚合要升 `AFFINITY_CALIBRATION.version` /
  `ANALYSIS_VERSION` 并重跑 Bridge 校准」的成本。**这是产品决策，不要只按候选表改。**

## 10. 下一阶段建议

按优先级：

### P0：扩充真实标注集

从**获得用户明确授权**的会话中抽取 200~500 条对方消息，人工标 5 类关系。必须与现有 test 隔离。
新集按 60/20/20 切分，新增字段建议：

```json
{"source":"human","annotator":"...","confidence":"high"}
```

### P1：针对剩余边界改提示词

**两轮都失败，不要再从提示词入手。** 100 条语料上 10 个候选全不达标（§6.1）；扩到 280 条后
`implicit-romance` 在 train/validation 上五个指标全胜，但 test 分类 55%→45%、MAE 11.60→12.00，
已回退（§6.3）。

可复用的教训：`--train-only` 迭代 + `--budget` 查截断 + test 只跑一次做闸门。这套流程本身没问题，
是提示词这条路到头了。

### P1.5：先把评估集做大，再谈提示词

**已完成（2026-11-01 ~ 11-07）**：共六轮，语料 100 → 931 条，test 20 → 300 条。

- 前三轮到 460：扩 train/validation，正面增补，test 4/类冻结。
- 第四轮到 551：test 扩到 100 条（20/类），另补 11 条 train。
- 第五轮到 731：新增 r6 独立 test 100 条，线性模型在 200 条 test 上 91%。
- 第六轮到 931：r7 盲测暴露含蓄表达缺口（80%）→ 补 100 条弱关键词 train/val →
  新增 r8 最终盲测 50 条，整体 300 条 test 90.67%。

**提示词这条路基本到头**；评估集扩大后已训练出真正的轻量分类器，且经历了
"盲测失败 → 按训练/验证补语料 → 新盲测通过"的完整闭环。

### P2：小型关系分类器（已完成 v1 → v2 → v3）

`relationship-linear` 已落地，v1 NB 相关 6 个文件已删除：

1. 边界字符 1–4 gram + 多项逻辑回归 + 幅度剪枝；
2. train 5 折 CV 选 L2，validation 拟合温度，test 闸门；
3. 导出 JSON 模型，TypeScript 直接推理，已接入本地分析链；
4. v2（2026-11-07）：test 272/300 = 90.67%，r8 盲测 90%；
   v3（2026-11-19）：加拒绝侧结构特征，test 317/350 = 90.57%，r9 盲测 92%，
   validation 97.06%。详见 `docs/laya-relationship-linear.md`。

v3 选型教训：表白侧 + 人称/问号 cue 虽把 validation 拉到 95.59%，但 test 掉到 89%
（neutral/warm 被误拉），已回滚；只用拒绝侧 cue、且 `@short` 必须保留才有效。
test 一旦看过就不能再用于选型，第二轮只用 validation A/B，另起 r9 盲测做最终闸门。

下一步若有人工标注千级真实数据，可升级为多语言编码器（bge-m3 / MiniLM / XLM-R）：
冻结 embedding 跑 logistic regression 验证信号，再解冻微调、导出 ONNX。仍不是微调现有 Laya。

### P2.5：MBTI 证据分类器（已完成 v1 → v2 → v3）

`mbti-linear` 已落地，本地分析链改用训练模型：

1. 4 轴 × 3 类线性头，共享边界字符 1–4 gram 词表；
2. 600 行手写语料（450 唯一文本），train/val/test 隔离，最高 SequenceMatcher 0.720、Jaccard 0.400；
3. CV 按**轴内文本**分折选 L2，validation 拟合温度，test 一次性闸门；
4. v1 test 45/48 = 93.75%；v2（2026-11-19）加 8 个轴特定 cue 后 69/72 = 95.83%；
   v3（同日）特征不变、只扩 train 72 行并新增 r3 盲测 24 行后 93/96 = 96.88%。

迭代教训：首版 16 条/类只有 85.4%；27 组超参搜索全部停在 85.4%，瓶颈是语料不是模型；
扩到 32 条/类后 95.8%，但查出 4 对 ≥0.75 近重复，剔除后 93.75%。
**加语料后必须重跑近重复检查**，否则指标虚高。
v2 的 cue 是轴隔离的（每轴 2 个），选型只用 CV + validation，特征冻结后才写 r2 test 24 行。
TS 推理要按轴分别加 cue（共享 n-gram + 本轴 cue），与 Python 的 `row_features` 对齐。

API 画像链仍走 4 个固定题面（与关系模型架构一致）；本地链已不再问这 4 题（2026-11-17 移除，
同轮也摘掉了 `relationship` 题），本地画像题集从 13 题降到 8 题：emotion + intent + 6 个 style。
`ANALYSIS_VERSION` 追加 `local-questions-v2`，旧画像进度按新题集重建。

### P3：CUDA

当前 Windows Node 绑定没有 CUDA：

- 官方支持 CPU / DirectML / WebGPU，CUDA 仅 Linux x64；
- 本机 DirectML 在该图 `Reshape` 失败；
- WebGPU 实测训练 122.6s → 32.2s，约 3.8×。

要 CUDA，需要 Linux 或 Python `onnxruntime-gpu`。不要在 Windows Node 上继续尝试 CUDA provider，
脚本会明确拒绝 `--provider=cuda`。

## 11. 容易踩的坑

1. **不要把 test 当验证集反复调参。** 当前 90.67% 是 300 条 test 的一次性闸门；r7 曾因参与迭代而降级为开发测试，最终盲测必须另起新批次。
2. **不要整体回滚工作区。** 这里有其他会话的修改，先看 `git diff` 再改。
3. **不要同时改 TS 和 Python 的其中一边。** 界面读取 Python 持久化结果。
4. **不要忘了升缓存版本。** 提示词改了就升 `RELATIONSHIP_QUESTION_VERSION`；聚合改了升
   `AFFINITY_CALIBRATION.version`。
5. **旧 API 统计不能增量接新公式。** 版本 2 会隔离旧统计；不要强行复用。
6. **DirectML 不是可用路径。** probe 会在 `Reshape` 节点失败；不要把它写成生产 GPU 方案。
7. **语料是合成数据。** 指标只证明模型在这套边界样本上更好，不代表真实聊天准确率；含蓄拒绝/表白仍是主要误差（rejecting 召回 80%）。
8. **不要靠加大 batch 提速。** `LAYA_TRAIN_BATCH_SIZE` 默认 1 是刻意的：2026-11-07 实测
   16 行/批在 WebGPU 只快 1.3~1.9× 却改了 3/120 分类答案（最大概率差 0.103），CPU 上反而慢
   0.76×。差异来自 padding 到 batch 内最长序列，不是切片 bug（`rows=1` 的 `predictBatch`
   与逐条完全一致）。正式报告一律用默认逐行口径，见 `docs/laya-scoring-calibration.md` §7.1。
8. **不要在未授权时读取或保存用户聊天原文。**
9. 仓库使用 CRLF；`git diff --check` 请加 `-c core.whitespace=cr-at-eol`，否则会把所有新增行误报为尾随空白。
10. **提示词超长会被静默截断。** `head_max_len=256` 是"指令 + 选项"的共享预算，`buildPrefix` 从尾部
    截断且不报错。`relationship-v2` 用 176+10，`emotion` 只剩 9 token 余量。加规则前先跑 `--budget`；
    加选项释义会按选项数×长度吃掉指令预算（五个释义占 106 token，指令被砍掉三分之一）。
11. **调提示词必须用 `--train-only`。** 默认模式跑完会打印 test 结果，看一眼就等于污染了 holdout。
12. **`scripts/laya-score-train.ts` 的 `EXPECTED` 表必须跟着 `tests/laya-affinity-corpus.test.ts` 走。**
    11-19 把 test 扩到 70/类（r9 v3 盲测）时漏改这张表，`npm run train:laya-score` 直接崩在
    `unbalanced corpus: test/rejecting`，11-20 已修。扩语料后先跑
    `node --import tsx scripts/laya-score-train.ts --dry-run` 确认全链路通了再跑推理。
13. **`npm run train:relationship-linear` / `train:mbti-linear` 里的 `python` 是系统解释器**，
    本机没有 numpy，必须用 `.venv/Scripts/python.exe`（文档命令已改用 `$PY`）。

## 12. 接手完成标准

下一任 AI 至少应做到：

- 能复现当前 test 结果（允许不同 GPU 后端造成 ±1 分）；
- 能解释为什么没有微调 ONNX；
- 能指出 test 不得参与选择；
- 新增语料不破坏每类 train/validation 均衡，且 test 始终冻结 4 条/类；
- TS 与 Python 在相同输入上给出相同 `affinity`；
- 修改后完整 Node/Python 测试通过；
- 汇报时区分“合成语料指标”和“真实会话准确率”。

## 附：Laya CPU 线程自适应（2026-11-07）

- `electron/laya/runner.ts` 的 `intraOpNumThreads` 不再恒为 4。`adaptiveThreads: true`
  时 CPU 路径先读 `.local/real-client-runtime/laya-threads.json` 缓存，未命中则按
  `min(8, cores-1)` 启发式取值，**启动零开销**；WebGPU 忽略该参数，不参与调优。
- 显式校准：`npm run benchmark:laya-threads`，用 8×256 的真实形状测 4 与启发式线程数，
  结果写缓存供后续所有启动使用。也可设 `LAYA_BENCHMARK_THREADS=1` 在下次建 session 时同步测。
- **实测教训**：单次微基准噪声大于真实差异。三次同机校准给出 8 快 14% / 4 快 42% /
  8 快 9.5%；缩小形状省时间但会把结论反过来。故 `pickFastest` 把 <20% 差距判为平手并
  选较少线程，三次一致收敛到 4。改校准形状或判定规则必须升 `TUNING_VERSION` 让旧缓存失效。
- 验证：完整 Node **887/887**、发布清单 10/10、脚本入口 3/3、真实模型冒烟 `affinity: 69`；
  校准后启动命中缓存约 3 s。
