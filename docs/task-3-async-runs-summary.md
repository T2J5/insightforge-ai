# Task 3：异步调研运行阶段总结

> 完成日期：2026-08-25（Asia/Shanghai）

## 1. 阶段目标

Task 3 把同步函数调用升级为可公开部署的异步任务链路。用户创建调研后无需保持 HTTP 请求，Web 负责持久化与投递，Worker 独立消费任务，Redis 传递队列和进度，PostgreSQL 保存权威业务状态，浏览器通过 SSE 接收并恢复进度。

## 2. 已完成链路

```text
POST /api/runs
  -> 校验请求与匿名所有者
  -> PostgreSQL 创建 queued Run
  -> BullMQ 以 runId 作为 jobId 入队
  -> Worker 将 queued 原子转换为 running
  -> Agent 执行规划、调研、证据提取、写作、评审和发布
  -> PostgreSQL 保存 agent-result 检查点
  -> PostgreSQL 原子保存 completed、Token 和成本
  -> Redis 发布 completed 事件
  -> SSE 回放或实时推送终态并关闭连接
```

取消链路以 PostgreSQL 状态为权威事实，同时写入带 TTL 的 Redis 取消键作为 Worker 快速检查信号。Worker 在启动工作流前后执行取消检查；更细粒度的节点级取消属于 Task 4。

## 3. 核心能力

### 3.1 PostgreSQL：业务事实

- 保存 Run 生命周期、所有者、输入、Token 和成本。
- 使用 `WHERE status = expected` 实现乐观并发控制。
- 使用单条 `UPDATE` 原子写入 `completed + tokenUsage + estimatedCostCny`。
- 保存 `request` 和 `agent-result` 检查点，避免最终报告只存在于 Worker 内存。

### 3.2 BullMQ：任务调度

- Run ID 与 BullMQ Job ID 一致，减少重复投递。
- Worker 负责合法 Job 校验、有限重试和不可重试错误处理。
- 仅在最终失败或不可重试失败时把数据库状态写为 `failed`。
- Worker 启停过程管理 Redis、PostgreSQL 和信号监听，支持优雅关闭。

### 3.3 Redis：临时协调与进度

- 取消键：`run:<runId>:cancelled`。
- 单调事件序号：`run:<runId>:event-seq`。
- 最近 200 条事件日志：`run:<runId>:event-log`。
- 实时频道：`run:<runId>:events`。
- Redis 不是最终业务状态来源；任务状态仍以 PostgreSQL 为准。

### 3.4 SSE：可恢复进度

- 验证 Run 所有者，不允许读取其他用户的进度。
- 支持 `Last-Event-ID`，只回放断线后遗漏的事件。
- 定期发送心跳，避免代理或浏览器把空闲连接关闭。
- 收到 completed、failed 或 cancelled 后关闭流并清理订阅资源。
- 客户端即使晚于任务完成才连接，也能从事件日志回放终态。

## 4. 真实端到端验证

真实任务已经跑通以下组件：

```text
Next.js API
  -> PostgreSQL
  -> Redis / BullMQ
  -> Worker
  -> LangGraph Agent
  -> 真实结构化模型
  -> Tavily 搜索与内容提取
  -> agent-result 检查点
  -> SSE completed
```

验证中发现并修复了两个仅靠 Mock 难以发现的问题：

1. 当前 OpenAI 兼容提供商不接受 JSON Schema 的 `format: uri`。模型输出层改用有边界的字符串，服务端 grounding 后仍使用严格 URL Schema。
2. SSE 完成事件包含实际 Token，但 Run 表原先仍保留默认值 0。现在 Repository 使用原子 `complete()` 同时保存终态和用量。

## 5. 自动化验证基线

2026-08-25 的阶段门禁结果：

- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- `pnpm test`：38 个测试文件、318 项测试通过。
- Domain 测试：59 项通过。
- DB 集成测试：27 项通过。
- Worker 测试：91 项通过。
- Agent 测试：53 项通过。
- Web 测试：88 项通过。

## 6. 当前边界与后续任务

Task 3 已保证“任务可以异步执行、取消、观察进度并形成终态”，但不代表具备完整的 Agent 恢复能力。

Task 4 继续解决：

- 在每个模型或工具节点之前检查取消，而不是只在整张图前后检查。
- 为 quick/deep 调研配置搜索、Token、成本和时间预算。
- 为单次模型与工具调用设置超时。
- 节点完成后持久化状态和下一个恢复位置。
- Worker 重试或进程重启后从最新安全检查点继续，避免重复模型成本。

生产强化阶段仍需处理 Transactional Outbox、跨 PostgreSQL/Redis 的最终一致性、幂等请求、限流和可观测性。这些风险不阻止 Task 3 验收，但必须在公开部署前完成或明确记录。

## 7. 求职作品集表达

这一阶段可以概括为：

> 设计并实现基于 Next.js、PostgreSQL、Redis 与 BullMQ 的异步 Agent 运行平台，支持乐观并发状态机、任务重试与失败收敛、取消信号、可回放 SSE 进度以及 Token/成本原子持久化，并通过真实模型与公开搜索完成跨进程端到端验证。
