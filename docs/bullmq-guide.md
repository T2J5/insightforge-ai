# BullMQ 实战技术指南

> 适用项目：InsightForge（Node.js + TypeScript + BullMQ + Redis）  
> 本项目版本：`bullmq 5.81.2`、`ioredis 5.11.1`、Redis 7.4  
> 阅读目标：理解 BullMQ 的运行机制，并能安全地完成任务入队、消费、重试、取消、监控和生产部署。

## 1. BullMQ 是什么

BullMQ 是基于 Redis 的 Node.js 分布式任务队列。它适合把耗时、易失败或不应阻塞 HTTP 请求的工作放到后台执行，例如：

- AI 报告生成；
- 网页抓取与文档解析；
- 邮件、通知和 Webhook；
- 图片、音视频处理；
- 定时同步和数据清理；
- 需要重试的第三方 API 调用。

BullMQ 解决的是“任务如何排队和调度”，而不是业务数据存储。对本项目而言：

- PostgreSQL 是研究运行、证据和报告的权威数据源；
- Redis 保存队列状态、延迟任务、锁和短期事件；
- BullMQ 负责把任务从 Web 进程可靠地交给 Worker；
- Worker 执行业务逻辑，并把最终状态写回 PostgreSQL。

不要只把重要结果存在 `job.returnvalue` 或 Redis 中。Redis 队列数据可能因保留策略、运维操作或故障被清理。

## 2. 核心组件

| 组件           | 职责                         | 本项目中的角色         |
| -------------- | ---------------------------- | ---------------------- |
| `Queue`        | 添加和管理任务               | Web API 生产者         |
| `Worker`       | 从队列领取并执行任务         | 独立 Worker 进程       |
| `Job`          | 单个任务及其数据、选项、进度 | 一次研究运行           |
| `QueueEvents`  | 监听整个队列的全局事件       | 监控、日志或状态桥接   |
| `FlowProducer` | 创建有父子依赖的任务流       | 多阶段 DAG（按需使用） |
| Job Scheduler  | 创建周期性任务               | 定时清理、同步         |

最基本的数据流：

```text
HTTP 请求
   │
   ▼
Web / Queue.add()
   │
   ▼
Redis 队列 ───等待/延迟/重试───┐
   │                          │
   ▼                          │
Worker processor             │
   │                          │
   ├──成功──> completed       │
   └──异常──> failed ─────────┘
```

生产者和消费者可以部署在不同进程、容器或机器上，只要它们连接同一个 Redis、使用相同队列名和兼容的数据协议。

## 3. 本项目结构建议

```text
apps/
├── web/
│   └── lib/server/
│       ├── redis.ts              # Web 使用的 Redis 连接
│       └── research-queue.ts     # Queue：任务入队
└── worker/
    └── src/
        ├── redis.ts              # Worker 使用的 Redis 连接
        ├── queues.ts             # 队列名、任务名和数据类型
        ├── processors/
        │   └── research-run.ts   # 业务处理器
        └── index.ts              # Worker 启动和优雅关闭
```

队列名称、任务名称和 Job Data 类型最好放在 Web、Worker 都能依赖的共享包中，避免双方使用不同字符串或数据结构。

## 4. 启动 Redis

本项目的 `docker-compose.yml` 已包含 Redis 7.4：

```bash
docker compose up -d redis
docker compose ps
docker compose exec redis redis-cli ping
```

成功时最后一条命令返回：

```text
PONG
```

开发环境变量：

```dotenv
REDIS_URL=redis://localhost:6379
```

当前 Docker 配置包含两项适合 BullMQ 的设置：

```text
appendonly yes                # 使用 AOF 提高重启后的数据恢复能力
maxmemory-policy noeviction   # 内存不足时报错，不自动淘汰队列键
```

`noeviction` 很重要。若 Redis 自动删除 BullMQ 的内部键，队列状态、锁和任务数据可能不一致。不过它不等于“不会内存不足”；仍需监控内存并合理清理完成/失败任务。

## 5. 定义任务协议

任务数据会序列化到 Redis。应当使用小而明确的数据，不要把大文档、Buffer、数据库连接或函数放进去。

```ts
// 可放入共享包
export const RESEARCH_QUEUE = "research-runs";
export const PROCESS_RESEARCH_RUN = "process-research-run";

export interface ResearchJobData {
  runId: string;
  ownerId: string;
}

export interface ResearchJobResult {
  reportId: string;
  version: number;
}
```

推荐只传 `runId` 等标识符，由 Worker 从 PostgreSQL 读取最新数据。这样可以：

- 避免 Redis 保存重复的大对象；
- 防止排队期间业务数据已经更新，而 Job Data 仍是旧快照；
- 明确 PostgreSQL 才是权威来源；
- 降低包含敏感信息的风险。

Job Data 属于跨进程协议。修改字段时应考虑滚动部署期间旧 Worker 是否还能处理新任务。

## 6. Redis 连接

BullMQ 底层使用 ioredis。Web 生产者与 Worker 对连接失败的容忍方式不同，建议分别创建连接。

### 6.1 Web 生产者：快速失败

HTTP 请求不能在 Redis 宕机时无限等待：

```ts
// apps/web/lib/server/redis.ts
import IORedis from "ioredis";

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  throw new Error("REDIS_URL is required");
}

export const producerRedis = new IORedis(redisUrl, {
  maxRetriesPerRequest: 1,
  enableReadyCheck: true,
});
```

### 6.2 Worker：持续重连

后台 Worker 应在 Redis 短暂中断后继续工作。手工向 `Worker` 传入 ioredis 实例时，`maxRetriesPerRequest` 必须设为 `null`：

```ts
// apps/worker/src/redis.ts
import IORedis from "ioredis";

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  throw new Error("REDIS_URL is required");
}

export const workerRedis = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});
```

不要使用 ioredis 的 `keyPrefix` 选项，它与 BullMQ 自己的键前缀机制不兼容。需要环境隔离时使用 BullMQ 的 `prefix` 选项，并确保生产者、Worker 和 `QueueEvents` 一致。

`Worker` 为阻塞读取还会创建额外连接，因此“传入一个 Redis 实例”不代表整个 Worker 只占一个连接。部署到有连接数上限的托管 Redis 时必须计算连接预算。

## 7. 创建 Queue 并添加任务

```ts
// apps/web/lib/server/research-queue.ts
import { Queue } from "bullmq";

import { producerRedis } from "./redis.js";

export const researchQueue = new Queue<ResearchJobData, ResearchJobResult>(
  RESEARCH_QUEUE,
  {
    connection: producerRedis,
    defaultJobOptions: {
      attempts: 4,
      backoff: {
        type: "exponential",
        delay: 2_000,
        jitter: 0.2,
      },
      removeOnComplete: { age: 24 * 60 * 60, count: 1_000 },
      removeOnFail: { age: 7 * 24 * 60 * 60, count: 5_000 },
    },
  },
);
```

添加任务：

```ts
const job = await researchQueue.add(
  PROCESS_RESEARCH_RUN,
  { runId, ownerId },
  {
    jobId: runId,
  },
);
```

建议把数据库记录与入队动作组织为清晰的服务方法：

```ts
const run = await runRepository.create(input);

try {
  await researchQueue.add(
    PROCESS_RESEARCH_RUN,
    { runId: run.id, ownerId },
    { jobId: run.id },
  );
} catch (error) {
  await runRepository.markEnqueueFailed(run.id);
  throw error;
}
```

PostgreSQL 事务无法与 Redis 操作形成普通 ACID 事务。若业务要求极高可靠性，应使用 Transactional Outbox：数据库事务中同时写业务记录和 outbox 事件，再由独立发布器将事件投递到 BullMQ。

## 8. 实现 Worker

```ts
// apps/worker/src/index.ts
import { Job, Worker } from "bullmq";

import { workerRedis } from "./redis.js";

const worker = new Worker<ResearchJobData, ResearchJobResult>(
  RESEARCH_QUEUE,
  async (job: Job<ResearchJobData, ResearchJobResult>) => {
    if (job.name !== PROCESS_RESEARCH_RUN) {
      throw new Error(`Unsupported job name: ${job.name}`);
    }

    const { runId, ownerId } = job.data;

    await job.updateProgress({ stage: "loading", percent: 5 });
    const run = await runRepository.getOwned(runId, ownerId);

    await assertNotCancelled(runId);
    await job.updateProgress({ stage: "researching", percent: 30 });
    const evidence = await collectEvidence(run);

    await assertNotCancelled(runId);
    await job.updateProgress({ stage: "writing", percent: 75 });
    const report = await createReport(run, evidence);

    await runRepository.complete(runId, report.id);
    await job.updateProgress({ stage: "completed", percent: 100 });

    return { reportId: report.id, version: report.version };
  },
  {
    connection: workerRedis,
    concurrency: 4,
  },
);
```

Processor 正常返回时，Job 进入 `completed`；抛出 `Error` 时进入重试或 `failed`。始终抛出 `Error` 对象，不要 `throw "message"`。

建议监听 Worker 自身错误：

```ts
worker.on("completed", (job, result) => {
  logger.info({ jobId: job.id, result }, "job completed");
});

worker.on("failed", (job, error) => {
  logger.error(
    { jobId: job?.id, attemptsMade: job?.attemptsMade, error },
    "job failed",
  );
});

worker.on("error", (error) => {
  logger.error({ error }, "worker error");
});
```

`failed` 是任务执行失败；`error` 是 Worker 本身的错误。两者都应监控。

## 9. Job 生命周期

常见状态：

| 状态               | 含义                   |
| ------------------ | ---------------------- |
| `waiting`          | 等待 Worker 领取       |
| `prioritized`      | 带优先级等待           |
| `delayed`          | 等待延迟时间到达       |
| `active`           | 正在执行               |
| `completed`        | 成功完成               |
| `failed`           | 最终失败或等待手动重试 |
| `waiting-children` | 等待子任务完成         |

“stalled”不是持久状态，而是事件。当 active Job 的锁没有正常续期时，BullMQ 会把它重新放回等待队列；超过 `maxStalledCount` 后才永久失败。

因此 Worker 崩溃、进程被强杀或事件循环长时间阻塞时，同一个 Job 可能再次执行。这是幂等性要求的根源。

## 10. 重试与退避

自动重试由 `attempts` 开启：

```ts
await researchQueue.add(name, data, {
  attempts: 4,
  backoff: {
    type: "exponential",
    delay: 2_000,
    jitter: 0.2,
  },
});
```

`attempts: 4` 表示最多执行四次，不是“首次执行后再重试四次”。

重试分类建议：

| 错误               | 是否重试     | 例子                         |
| ------------------ | ------------ | ---------------------------- |
| 临时基础设施故障   | 是           | 超时、HTTP 429/503、连接中断 |
| 永久输入错误       | 否           | 数据校验失败、资源不存在     |
| 权限或业务规则错误 | 通常否       | 用户无权访问、运行已取消     |
| 未知异常           | 有上限地重试 | 程序异常，保留日志后调查     |

不要对所有错误无脑重试。永久错误会浪费资源，并掩盖真正的问题。可使用 `UnrecoverableError` 让不可恢复错误直接失败：

```ts
import { UnrecoverableError } from "bullmq";

if (!run) {
  throw new UnrecoverableError(`Run ${runId} does not exist`);
}
```

指数退避加 jitter 可以避免大量任务同时重试形成“惊群”。对于第三方 API，还应结合限流和供应商返回的 `Retry-After`。

## 11. 幂等性与投递语义

BullMQ 应按“至少一次”处理来设计：同一任务在故障场景下可能执行多次。生产级 Processor 必须允许安全重放。

### 11.1 `jobId` 去重

```ts
await researchQueue.add(name, data, { jobId: runId });
```

同一队列中已有相同 `jobId` 时，再次添加会被忽略。但要注意：

- 唯一性只在当前队列内有效；
- 自定义 ID 不能包含 `:`；
- Job 被 `removeOnComplete`、`removeOnFail` 或手工删除后，同一个 ID 可以再次添加；
- 它避免的是重复入队，不能阻止 active Job 因 stalled 或故障被再次执行。

### 11.2 业务幂等

可靠做法是让数据库约束和状态机兜底：

```ts
const transitioned = await runRepository.transition(runId, "queued", "running");

if (!transitioned) {
  // 已完成、已取消，或者另一个 Worker 已领取
  return existingResult;
}
```

对于外部副作用：

- 使用供应商支持的 idempotency key；
- 给数据库写入设置唯一约束；
- 先检查持久化检查点，再执行下一阶段；
- 保存每一步的确定性业务键；
- 不要只依赖进程内布尔变量或 Redis 临时锁。

## 12. 并发与吞吐量

本地并发：

```ts
const worker = new Worker(queueName, processor, {
  connection,
  concurrency: 10,
});
```

`concurrency: 10` 表示这个 Worker 实例最多同时处理 10 个 Job。适合大量等待网络或数据库的 I/O 型任务。

CPU 密集任务不会因为提高并发而变快，反而可能阻塞事件循环、导致锁无法续期和 stalled。此类任务应使用 sandboxed processor、Worker Threads，或拆到专用计算服务。

多实例部署还能提高可用性。总并发大致是各 Worker 本地并发之和，但仍会受到队列全局并发和限流约束。

```ts
await researchQueue.setGlobalConcurrency(20);
```

设置并发时要同时考虑：

- PostgreSQL 连接池容量；
- Redis 连接数限制；
- 第三方 API QPS/Token 限额；
- 单任务内存和 CPU；
- Worker 副本数量；
- 下游服务可承受的峰值。

先从较小并发开始，通过等待时长、处理时长、错误率和资源利用率逐步调优。

## 13. 延迟、优先级和限流

### 延迟任务

```ts
await researchQueue.add(name, data, {
  delay: 60_000,
});
```

表示至少 60 秒后可以被处理，不保证恰好在该毫秒执行；队列积压、Worker 不足和 Redis 负载都会影响实际时间。

### 优先级

```ts
await researchQueue.add(name, data, {
  priority: 1,
});
```

数值越小优先级越高。不要滥用优先级，否则低优先级任务可能长期饥饿。普通 FIFO 任务不设置 priority 的性能也更好。

### 限流

```ts
const worker = new Worker(queueName, processor, {
  connection,
  concurrency: 10,
  limiter: {
    max: 20,
    duration: 1_000,
  },
});
```

限流用于保护下游 API；并发控制的是“同时执行多少个”，限流控制的是“一段时间最多开始多少个”，两者不是一回事。

## 14. 进度与事件

Processor 可以更新进度：

```ts
await job.updateProgress({
  stage: "collecting-evidence",
  completed: 12,
  total: 30,
});
```

进度应结构化且单调推进，避免客户端依赖自由文本解析。

跨进程监听全局事件使用 `QueueEvents`：

```ts
import { QueueEvents } from "bullmq";
import IORedis from "ioredis";

const eventsRedis = new IORedis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
});

const queueEvents = new QueueEvents(RESEARCH_QUEUE, {
  connection: eventsRedis,
});

await queueEvents.waitUntilReady();

queueEvents.on("progress", ({ jobId, data }) => {
  logger.info({ jobId, progress: data }, "job progress");
});

queueEvents.on("completed", ({ jobId, returnvalue }) => {
  logger.info({ jobId, returnvalue }, "job completed");
});

queueEvents.on("failed", ({ jobId, failedReason }) => {
  logger.error({ jobId, failedReason }, "job failed");
});
```

`worker.on(...)` 主要看到当前 Worker 实例的事件；`QueueEvents` 用 Redis Streams 聚合整个队列的事件，并需要自己的阻塞连接。

事件适合实时 UI、日志和指标，但不应成为业务事实的唯一来源。先把状态和结果提交到 PostgreSQL，再发出“完成”进度，避免 UI 声称完成而数据尚未落库。

## 15. 取消任务

BullMQ 无法安全地强行中断任意正在执行的 JavaScript 或外部 HTTP 请求。取消应设计为协作式取消。

本项目可采用：

1. PostgreSQL 将运行状态改为 `cancelled`；
2. Redis 写入带 TTL 的取消标志；
3. Worker 在每个耗时阶段之间检查标志；
4. 新的外部调用不再开始；
5. 可中断的请求配合 `AbortController`；
6. 已发生的副作用通过幂等或补偿逻辑处理。

```ts
const cancellationKey = `run:${runId}:cancelled`;

await producerRedis.set(cancellationKey, "1", "EX", 24 * 60 * 60);
```

Worker 检查：

```ts
import { UnrecoverableError } from "bullmq";

async function assertNotCancelled(runId: string): Promise<void> {
  const cancelled = await workerRedis.get(`run:${runId}:cancelled`);

  if (cancelled === "1") {
    throw new UnrecoverableError(`Run ${runId} was cancelled`);
  }
}
```

仅从 waiting 队列删除 Job 不等于取消 active Job。反过来，仅设置数据库状态也不会自动阻止 Processor 继续运行，因此必须由业务代码定期检查。

## 16. 周期任务

BullMQ 5.16 起推荐 Job Scheduler API，旧的 repeatable job API 已被替代。

```ts
await maintenanceQueue.upsertJobScheduler(
  "cleanup-expired-artifacts",
  { pattern: "0 0 3 * * *" },
  {
    name: "cleanup-expired-artifacts",
    data: {},
    opts: {
      attempts: 3,
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  },
);
```

`upsertJobScheduler` 适合部署时重复执行：相同 scheduler ID 会更新配置，而不是不断创建重复调度器。

周期任务不会保证每次严格按墙上时钟启动。若上一任务尚未开始、队列繁忙或没有 Worker，实际频率可能低于配置频率。对财务结算等强时间语义任务，应另行设计补偿和漏跑扫描。

BullMQ 2.0 以后，普通延迟、重试和 stalled 检测不需要单独创建 `QueueScheduler`。不要照搬旧教程。

## 17. 父子任务与 Flow

复杂任务可以用 `FlowProducer` 建立依赖：父任务等待所有子任务完成。

```ts
import { FlowProducer } from "bullmq";

const flow = new FlowProducer({ connection: producerRedis });

await flow.add({
  name: "assemble-report",
  queueName: "reports",
  data: { runId },
  children: sources.map((source) => ({
    name: "collect-source",
    queueName: "sources",
    data: { runId, source },
  })),
});
```

Flow 适合真正存在任务依赖的 DAG，但会增加调试、取消和错误传播复杂度。本项目已经计划使用持久化状态图与检查点时，不要再用 Flow 重复实现同一层编排；应明确哪一层是工作流权威。

## 18. 优雅关闭

容器停止时通常先收到 `SIGTERM`。正确关闭可让 Worker 停止领取新任务，并等待当前任务完成：

```ts
let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, "worker shutting down");

  try {
    await worker.close();
    await queueEvents.close();
    await eventsRedis.quit();
    await workerRedis.quit();
    await closeDatabase();
    process.exitCode = 0;
  } catch (error) {
    logger.error({ error }, "graceful shutdown failed");
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
```

不要收到信号后立即 `process.exit()`，否则 active Job 的锁停止续期，任务会变成 stalled 并可能被重复执行。

部署平台的 termination grace period 必须大于正常任务收尾时间。若单任务可能运行几十分钟，应增加阶段检查点，让任务在重启后从已提交阶段恢复，而不是依赖无限长的关闭等待。

Web 进程关闭时也应调用 `queue.close()`，再关闭它拥有的 Redis 连接。不要关闭仍被其他组件共享的连接。

## 19. 任务保留与 Redis 内存

如果不设置清理策略，完成和失败 Job 会持续占用 Redis 内存：

```ts
defaultJobOptions: {
  removeOnComplete: { age: 86_400, count: 1_000 },
  removeOnFail: { age: 604_800, count: 5_000 },
}
```

解释：

- 成功任务最多保留 24 小时且不超过 1,000 个；
- 失败任务最多保留 7 天且不超过 5,000 个；
- 具体清理由后续任务完成时触发，并非精确到期立即删除。

失败任务通常比成功任务保留更久，便于排障。但长期审计信息应进入日志、指标或 PostgreSQL，而不是无限保存在 BullMQ。

清理任务后，自定义 `jobId` 的去重占位也会消失。这是保留策略与重复入队之间的重要权衡。

## 20. 监控指标

生产环境至少观察：

| 指标                     | 意义                     |
| ------------------------ | ------------------------ |
| waiting 数量             | 队列积压                 |
| 最老 waiting Job 的年龄  | 用户实际等待时间         |
| active 数量              | 当前并发使用情况         |
| completed/failed 速率    | 吞吐与错误趋势           |
| p50/p95/p99 处理时长     | 性能和超时依据           |
| retries/stalled 数量     | 依赖不稳定或事件循环阻塞 |
| Redis 内存、连接数、延迟 | 队列基础设施健康度       |
| Worker 心跳和副本数      | 是否有消费者在线         |

队列长度为零不一定代表健康：可能生产者入队失败。Worker 在线也不代表任务正常：可能所有任务都在快速失败。应把 Web 入队成功率、数据库业务状态和 BullMQ 指标联合观察。

日志至少带上：

```text
queueName, jobName, jobId, runId, attemptsMade, workerId, durationMs, error
```

禁止记录完整敏感 Job Data、Redis 密码、用户文档内容或模型密钥。

## 21. 测试策略

### 单元测试

把 Processor 的核心业务逻辑抽成普通函数，使用 Fake Repository、Fake Model 等测试：

- 正常路径；
- 可重试和不可重试错误；
- 取消检查；
- 检查点恢复；
- 重复执行的幂等性。

### Redis 集成测试

使用真实 Redis 测试：

- Web 入队后 Worker 能消费；
- 重试次数和 backoff；
- 自定义 `jobId` 去重；
- 进度和完成事件；
- Worker 重启后的重新处理；
- 优雅关闭；
- 完成/失败任务清理。

不要把所有测试指向开发者共用 Redis。每个测试运行使用唯一队列前缀或队列名，并在测试后关闭 Worker、Queue、QueueEvents 和连接。

```ts
const queueName = `research-test-${crypto.randomUUID()}`;
```

集成测试结束时可对测试专属 Queue 调用清理 API；不要对不确定归属的 Redis 使用 `FLUSHALL`。

## 22. 常见问题排查

### 任务一直 waiting

检查：

1. 是否有 Worker 进程运行；
2. Queue 和 Worker 的队列名是否完全一致；
3. 两者是否连接到同一个 Redis/数据库编号；
4. Worker 是否 paused；
5. 全局并发是否被设置为 0；
6. Worker 日志是否有连接或解析错误。

### Worker 报 `maxRetriesPerRequest` 警告

传给 Worker 的手工 ioredis 实例没有设置：

```ts
new IORedis(redisUrl, { maxRetriesPerRequest: null });
```

Web 生产者不应照搬 `null`，否则 Redis 宕机时 HTTP 请求可能长时间挂起。

### 同一个任务执行了两次

这在 Worker 崩溃、锁续期失败或网络分区时可能发生。检查 stalled 事件和事件循环阻塞，并让业务写入幂等。不要试图只靠加大 lock duration 掩盖 CPU 阻塞。

### 任务频繁 stalled

常见原因：

- 同步 CPU 计算长时间占用事件循环；
- 进程暂停、机器过载或容器 CPU 限制过严；
- Redis 网络延迟严重；
- Worker 被不优雅地终止。

优先拆分 CPU 工作或使用 sandboxed processor，并检查资源和 Redis 延迟。

### Redis 内存持续增长

检查 `removeOnComplete`、`removeOnFail`、Job Data 大小、事件流长度及失败任务数量。`noeviction` 会保护队列键不被静默删除，但内存耗尽后写命令会失败。

### 设置 `jobId` 后仍能重复入队

确认旧 Job 是否已被自动删除。Job 一旦被删除，原 ID 可以重新使用。需要长期业务唯一性时依赖 PostgreSQL 唯一约束或幂等记录。

### 取消后任务仍继续

设置取消状态不会自动打断已执行的代码。Processor 必须在阶段之间检查，并为支持取消的 I/O 使用 `AbortSignal`。

### 定时任务没有严格准点执行

Job Scheduler 根据队列和 Worker 可用性生产/执行任务，不是硬实时调度器。检查积压、并发和 Worker 在线状态。

## 23. 生产上线检查表

- Redis 设置 `maxmemory-policy=noeviction`；
- Redis 启用认证、TLS、持久化和备份策略；
- Web 与 Worker 使用不同的连接重试配置；
- Queue、Worker、QueueEvents 都监听连接/运行错误；
- 设置有限的 `attempts`、指数退避和 jitter；
- Processor 对重复执行保持幂等；
- Job Data 小、可版本化且不含密钥；
- 设置 `removeOnComplete` 和 `removeOnFail`；
- 配置 SIGTERM/SIGINT 优雅关闭；
- Worker 健康检查同时验证进程、Redis 和 PostgreSQL；
- 监控积压、等待时间、失败率、重试、stalled 和 Redis 资源；
- 关键业务状态和结果持久化到 PostgreSQL；
- 用检查点支持长任务故障恢复；
- 部署前做 Worker 重启、Redis 短暂中断和重复投递测试。

## 24. 一页速查

```ts
import { Queue, QueueEvents, Worker } from "bullmq";
import IORedis from "ioredis";

const producerConnection = new IORedis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: 1,
});

const workerConnection = new IORedis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
});

const eventsConnection = new IORedis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
});

const queue = new Queue("research-runs", {
  connection: producerConnection,
  defaultJobOptions: {
    attempts: 4,
    backoff: { type: "exponential", delay: 2_000, jitter: 0.2 },
    removeOnComplete: 1_000,
    removeOnFail: 5_000,
  },
});

await queue.add("process-research-run", { runId, ownerId }, { jobId: runId });

const worker = new Worker(
  "research-runs",
  async (job) => {
    await job.updateProgress(50);
    return processResearchRun(job.data);
  },
  { connection: workerConnection, concurrency: 4 },
);

const events = new QueueEvents("research-runs", {
  connection: eventsConnection,
});

events.on("failed", ({ jobId, failedReason }) => {
  console.error({ jobId, failedReason });
});

async function shutdown(): Promise<void> {
  await worker.close();
  await events.close();
  await queue.close();
  await eventsConnection.quit();
  await workerConnection.quit();
  await producerConnection.quit();
}
```

```bash
# 启动 Redis 和 Worker
docker compose up -d redis
pnpm --filter @insightforge/worker dev

# 查看 Redis 是否健康
docker compose exec redis redis-cli ping

# 查看 Redis 内存策略
docker compose exec redis redis-cli CONFIG GET maxmemory-policy
```

## 25. 官方资料

- [BullMQ 官方指南](https://docs.bullmq.io/)
- [Queue](https://docs.bullmq.io/guide/queues)
- [Worker](https://docs.bullmq.io/guide/workers)
- [Redis 连接与 `maxRetriesPerRequest`](https://docs.bullmq.io/guide/connections)
- [失败重试与 backoff](https://docs.bullmq.io/guide/retrying-failing-jobs)
- [并发](https://docs.bullmq.io/guide/workers/concurrency)
- [Job ID](https://docs.bullmq.io/guide/jobs/job-ids)
- [Deduplication](https://docs.bullmq.io/guide/jobs/deduplication)
- [Stalled Job](https://docs.bullmq.io/guide/jobs/stalled)
- [Job Scheduler](https://docs.bullmq.io/guide/job-schedulers)
- [生产环境建议](https://docs.bullmq.io/guide/going-to-production)

---

使用 BullMQ 时最重要的三个问题是：**任务能否安全地执行两次？Redis 暂时不可用时系统如何表现？Worker 在任意阶段退出后如何恢复？** 如果设计能明确回答这三个问题，队列才真正具备生产可靠性。
