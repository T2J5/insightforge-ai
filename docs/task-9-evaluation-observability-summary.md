# Task 9：Agent 评测与可观测性阶段总结

## 1. 本阶段解决的问题

Task 9 把“感觉 Agent 变好了”变成可重复验证的工程结论。它建立了两个互补系统：

1. **Evaluation** 回答“输出质量是否达标、改动有没有退步”；
2. **Observability** 回答“一次真实运行在哪里耗时、用了多少 Token、在哪个节点失败”。

评测面向一批运行后的统计结果；可观测性面向单次运行的执行过程。二者不能互相替代。

## 2. 指标为什么这样定义

- `Recall@K`：前 K 条候选覆盖相关证据的比例。它衡量“需要的资料有没有被召回”。
- `MRR`：第一条相关证据排名的倒数。它衡量“正确资料是否足够靠前”。
- `citationCoverage`：有合法引用的事实块占全部事实块的比例。推断和摘要不进入分母。
- `toolAccuracy`：合法工具调用占全部工具调用的比例，禁止工具即使碰巧成功也会扣分。
- `runSuccessRate`：在步骤预算内得到与样本 `answerable` 一致结果的运行比例。

指标都是无网络、无数据库副作用的纯函数，因此边界值可以手工验算，CI 结果也稳定。

## 3. Golden Dataset

`evals/datasets/company-research.v1.jsonl` 使用 JSONL：第一行是数据集版本元数据，后续每行一个样本。当前 v1.0.0 有 51 条样本，覆盖 17 家公司，每家公司包含业务模式、战略增长、竞争风险三个问题。

每条样本声明：

- 预期证据键与事实；
- 允许和禁止使用的工具；
- 最大步骤数；
- 问题是否可以回答。

Schema 在加载时检查字段、版本、ID 格式和重复 ID。修改判定标准时必须提升版本，避免新旧分数不可比较。

## 4. 离线评测流程

```text
Golden Dataset
      ↓
同一 EvaluationSystem 分别运行三种 RetrievalVariant
      ↓
vector / hybrid / hybrid-reranked
      ↓
计算 Recall@5、MRR、工具准确率和成功率
      ↓
输出 JSON（机器读取）和 Markdown（人工阅读）
      ↓
低于稳定阈值时让 CI 失败
```

`fixtureEvaluationSystem` 是测试评测管线的固定系统，不是假装成真实质量分数。它的价值是保证数据加载、三组对比、指标聚合、报告生成和回归门禁本身不会悄悄失效。

## 5. Trace 与 Usage

`Telemetry.withSpan` 使用 `AsyncLocalStorage` 维护父子 Span。Agent 每个节点创建 `agent.node.*` Span，节点中的模型调用形成 `model.*` 子 Span；Task 8 的 `ToolAuditRecorder` 接入工具 started/succeeded/failed 事件。

模型 Usage 记录：模型名、操作、输入/输出 Token、预计人民币成本、延迟、缓存状态和重试次数。Trace 失败只对外保留稳定错误码，未知异常统一为 `INTERNAL_ERROR`。

日志刻意不包含 Prompt、搜索正文、私有文档片段和 Secret。这是可观测性中的重要边界：**可调试不等于把所有数据都记下来**。

## 6. 两类 CI

- `.github/workflows/ci.yml`：PR 和 main push 都运行确定性离线评测，不需要 Secret，不产生模型费用。
- `.github/workflows/online-evals.yml`：只支持手工触发，从 `online-evaluation` Environment 读取 `ONLINE_EVAL_ENDPOINT` 和 `ONLINE_EVAL_TOKEN`，调用部署环境的真实 Agent，上传结果但不在 PR 自动运行。

## 7. 常用命令

```bash
pnpm --filter @insightforge/evals test
pnpm --filter @insightforge/observability test
pnpm eval:fixtures
pnpm check
```

离线报告生成在 `evals/results/fixtures.json` 和 `fixtures.md`，该目录的生成结果不会提交到 Git，只由本地或 CI Artifact 保存。

## 8. 后续如何使用

以后修改检索权重、重排器、Prompt、工具选择或工作流路由时，先运行同一数据集并与基线比较。Task 12 发布作品集前，应人工复核样本证据键和预期事实，并把真实在线评测结果固化为作品集中的质量证据。
