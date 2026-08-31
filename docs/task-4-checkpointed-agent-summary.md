# Task 4：带检查点的 LangGraph 调研工作流阶段总结

> 完成日期：2026-08-28（Asia/Shanghai）

## 1. 阶段目标

Task 4 把 Task 3 中“能够异步执行”的 Agent，升级为具有确定性路由、执行预算、节点级取消和持久化恢复能力的工作流。核心目标不是增加更多 Prompt，而是让模型与工具调用受到服务端代码约束，并让 Worker 重试或进程重启后可以从最近一次安全检查点继续。

## 2. Agent 工作流

```text
START
  -> planner
  -> researcher
  -> evidenceExtractor
  -> writer
  -> citationValidator
       ├─ 引用合法 -> reviewer
       └─ 首次引用错误 -> writer 修订
  -> reviewer
       ├─ 通过 -> publisher
       ├─ 首次质量未通过 -> writer 修订
       └─ 修订后仍未通过 -> publisher + qualityWarning
  -> publisher
  -> END
```

各节点职责：

- `planner`：生成结构化调研目标与问题，quick 最多 3 个问题，deep 最多 6 个问题。
- `researcher`：按问题调用公开网页调研工具，并记录搜索次数和已完成问题。
- `evidenceExtractor`：让模型提出候选证据，再由服务端校验来源 URL 和逐字引用。
- `writer`：只基于已经通过校验的证据生成结构化报告。
- `citationValidator`：确定性检查报告引用是否存在、是否重复以及是否覆盖正文。
- `reviewer`：使用结构化模型评估报告质量并提供修订意见。
- `publisher`：形成最终报告；达到修订上限但仍未通过时附加人工复核警告。

## 3. 确定性控制

### 3.1 路由不交给模型

模型只生成结构化计划、证据候选、报告和评审结果。是否修订、是否发布、是否终止由 TypeScript 条件边决定，避免 Prompt 失控或无限循环。

- 引用修订和质量修订分别计数，互不占用对方额度。
- 引用错误最多修订一次；修订后仍不合法则禁止发布。
- 质量评审最多修订一次；仍未通过时允许发布，但必须写入 `qualityWarning`。

### 3.2 State 与 Reducer

LangGraph State 保存：

- 稳定身份：`runId`、企业、方向、深度、开始时间和截止时间。
- 中间产物：计划、调研结果、证据、报告草稿、引用问题和评审结果。
- 执行游标：已完成问题、已访问节点和内部状态。
- 治理数据：搜索次数、Token、预计成本和两类修订次数。

累计字段通过 Reducer 合并。`completedQuestionIds` 和 `visitedNodes` 使用追加去重语义，Token、成本、搜索次数和修订次数使用增量累计语义，防止节点更新覆盖已经存在的数据。

### 3.3 运行时校验

模型输出、工具输出和数据库 checkpoint 都被视为不可信输入。Zod Schema 在以下边界执行校验：

- 模型结构化输出进入节点时；
- 工具结果进入 Agent State 时；
- Worker 读取 checkpoint 并决定恢复方式时；
- Graph 最终结果写入业务数据库前。

恢复前还会比较 `runId`、企业、方向、深度、开始时间和截止时间，避免错误的 `thread_id` 或损坏状态触发其他任务的模型与搜索调用。

## 4. 预算、超时与取消

默认治理参数：

| 调研深度 | 最大搜索次数 | 最大 Token | 最大预计成本 | 总时长  |
| -------- | ------------ | ---------- | ------------ | ------- |
| quick    | 12           | 80,000     | 5 元         | 5 分钟  |
| deep     | 30           | 200,000    | 15 元        | 15 分钟 |

单次模型调用默认最多 120 秒，单次搜索默认最多 30 秒。实际传给 Adapter 的超时取“单次操作上限”和“整个 Run 剩余时间”中的较小值。

每个节点执行前都会：

1. 查询取消状态；
2. 检查总截止时间；
3. 检查当前操作对应的搜索、Token 或成本预算；
4. 计算本次外部调用能够使用的最大时间。

`researcher` 在每个问题的搜索之前重新执行这些检查，因此用户取消后不会继续启动后续搜索。预算或期限耗尽无法通过 BullMQ 重试恢复，会转换为不可重试错误。

## 5. PostgreSQL Checkpoint 与恢复

### 5.1 两类检查点

系统有两套用途不同的持久化数据：

| 存储位置          | 用途                                      |
| ----------------- | ----------------------------------------- |
| `run_checkpoints` | 业务层的原始请求和最终 `agent-result`     |
| `langgraph.*`     | LangGraph 节点状态、版本和 pending writes |

两者不能混用。业务表用于产品查询和最终结果兜底，LangGraph Schema 用于工作流内部恢复。

### 5.2 Checkpointer 生命周期

- Worker 使用 `PostgresSaver`，每个进程共享一个最大连接数为 2 的独立连接池。
- `research_runs.id` 作为 LangGraph `thread_id`，不同任务的状态相互隔离。
- 调用配置使用 `durability: "sync"`，节点 checkpoint 提交成功后才开始下一节点。
- `checkpoint:setup` 命令负责幂等创建 `langgraph` Schema、表和内部迁移，不在每个 Job 中执行。
- Worker 关闭时同时释放 BullMQ、Redis、Drizzle 和 Checkpointer 资源。

### 5.3 Worker 的三种执行模式

```text
读取 Graph StateSnapshot
  ├─ 没有 checkpoint -> fresh：使用完整初始输入
  ├─ checkpoint.next 非空 -> resume：使用 null 输入继续
  └─ checkpoint.next 为空 -> finalize：不再运行 Graph，直接提交结果
```

`finalize` 处理一种重要故障窗口：Graph 已经完成并写入 checkpoint，但 Worker 在更新 `research_runs` 前退出。重试后系统直接使用完成态 checkpoint 收尾，不再重复调用模型和搜索工具。

## 6. 故障语义

- 临时模型、搜索或数据库错误继续向 BullMQ 抛出，由有限重试策略处理。
- 已完成、已取消或已失败的 Run 不会重新启动 Agent。
- checkpoint 身份冲突、checkpoint 损坏、Graph 未形成完成结果、结果 Run ID 不一致以及预算耗尽都属于不可重试错误。
- Agent 最终结果先保存到业务 checkpoint，再原子完成 Run，最后发布 completed 事件，避免事件先于数据库事实出现。

恢复集成测试验证了：`planner` 完成并提交 checkpoint 后，`researcher` 首次发生临时错误；再次使用相同 `thread_id` 和 `null` 输入运行时，Graph 从 `researcher` 继续，不重复执行 `planner`。

## 7. 自动化验证基线

2026-08-28 的阶段门禁结果：

- `pnpm format:check`：通过。
- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- `pnpm test`：41 个测试文件、355 项测试通过。

覆盖的关键场景包括：

- 正常发布、引用修订、质量修订和修订上限；
- 搜索、Token、成本和总期限耗尽；
- planner 前取消以及多个搜索之间取消；
- checkpoint 创建、连接池复用和优雅关闭；
- fresh、resume 和 finalize 三种 Worker 执行模式；
- checkpoint 身份冲突、损坏状态和错误最终 Run ID；
- 节点失败后恢复且不重复已完成节点。

## 8. 当前边界与后续任务

Task 4 已实现可靠的节点级恢复，但仍有以下边界：

- checkpoint 的提交粒度是 LangGraph 节点。`researcher` 当前会在一个节点内顺序处理多个问题；如果该节点中途失败，本节点内已经产生但尚未作为节点输出提交的外部调用仍可能重复。
- 当前进度事件描述 Worker 的 fresh、resume、finalize 模式以及最终状态，还不是逐节点的实时事件流。
- `checkpoint:setup` 需要在部署迁移阶段显式执行；应用启动不会自动修改数据库结构。
- PostgreSQL checkpoint 保证 Agent 状态恢复，但不能替代外部搜索、模型调用和跨系统事件的幂等设计。
- 真实 PostgreSQL 表初始化已经验证；自动化恢复测试使用 `MemorySaver` 验证 Graph 语义，尚未加入需要真实 PostgreSQL 的进程重启集成测试。

Task 5 将继续完善公开网页 URL 安全、抓取边界、提示注入隔离、标准化证据和来源质量评分。

## 9. 求职作品集表达

这一阶段可以概括为：

> 基于 LangGraph 和 PostgreSQL Checkpointer 实现可恢复的企业调研 Agent，通过服务端确定性路由控制证据引用、报告修订与发布；为模型和搜索调用加入取消、超时、搜索次数、Token、成本及总期限治理，并支持 Worker 重试后从最近已提交节点恢复，避免重复执行已完成的高成本步骤。

面试时可以重点说明：

- 为什么 Agent 的循环终止条件必须由代码控制，而不能只写进 Prompt；
- LangGraph State Reducer 如何累计用量并支持恢复；
- BullMQ 重试与 LangGraph checkpoint 分别解决什么问题；
- 为什么业务 checkpoint 与框架内部 checkpoint 要分开；
- `fresh`、`resume`、`finalize` 如何覆盖不同的 Worker 故障窗口；
- 当前节点级恢复的边界，以及如何进一步拆分 researcher 获得问题级恢复。
