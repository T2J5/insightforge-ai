# Task 2 阶段总结：领域契约与 PostgreSQL 持久化

## 1. 阶段状态

- 状态：已完成
- 完成日期：2026-08-14
- Pull Request：[PR #3 feat: add research persistence model](https://github.com/T2J5/insightforge-ai/pull/3)
- 合并目标：`main`
- 合并提交：`7a5e33cf7ac227e21a859e4344d1cc2a6038042f`
- GitHub Actions：`Quality` 通过
- 最终测试结果：7 个测试文件、42 个测试全部通过

Task 2 已完成企业调研 Agent 的领域契约和持久化基础。后续异步任务、Agent 工作流、RAG、证据引用和报告发布都可以基于本阶段提供的稳定接口继续开发。

## 2. 阶段目标

本阶段解决四个基础问题：

1. 使用 Zod 定义调研任务、工作流检查点、证据和报告版本的运行时契约。
2. 使用 PostgreSQL 16 和 pgvector 建立可迁移、可约束、可索引的数据模型。
3. 使用 Repository 隔离业务代码与 Drizzle ORM/PostgreSQL 的实现细节。
4. 使用真实 PostgreSQL 集成测试验证并发控制、幂等写入和不可变报告版本。

整体数据流为：

```text
调用方输入
   ↓
Zod Domain Schema 运行时校验
   ↓
Repository 业务持久化语义
   ↓
Drizzle ORM 类型化 SQL
   ↓
PostgreSQL / pgvector 约束与索引
```

## 3. 主要交付物

### 3.1 Domain 领域契约

新增文件：

- `packages/domain/src/research.ts`
- `packages/domain/src/evidence.ts`
- `packages/domain/src/report.ts`
- 对应的三个测试文件

已定义的核心契约包括：

- 调研方向：综合、产品、技术、商业和竞争分析。
- 调研深度：快速调研和深度调研。
- 任务状态：`queued`、`running`、`awaiting_review`、`completed`、`failed`、`cancelled`。
- 调研任务创建输入和完整持久化对象。
- 可安全写入 PostgreSQL JSONB 的递归 JSON 类型。
- 工作流检查点输入和完整检查点对象。
- 网页证据和上传文档证据的统一结构。
- 证据来源类型、URL/documentId 一致性和置信度约束。
- 草稿与已发布报告版本的结构和发布时间约束。

Zod 是应用运行时的权威定义。TypeScript 类型由 Zod Schema 推导，减少了“静态类型允许、运行时数据非法”的风险。

### 3.2 PostgreSQL 数据模型

新增 `@insightforge/db` 工作区包，并建立 9 张业务表：

| 数据表            | 职责                                   |
| ----------------- | -------------------------------------- |
| `users`           | 保存用户身份和基础资料                 |
| `research_runs`   | 保存企业调研任务及其生命周期状态       |
| `run_checkpoints` | 保存 Agent 工作流检查点，支持中断恢复  |
| `documents`       | 保存网页或上传文档的元数据             |
| `document_chunks` | 保存文档切片、元数据和向量             |
| `evidence`        | 保存可追溯、可引用和可去重的标准化证据 |
| `reports`         | 保存逻辑报告的稳定身份                 |
| `report_versions` | 保存不可变的报告版本                   |
| `usage_events`    | 保存模型、搜索等操作的用量与成本事件   |

数据库层实现了以下保护：

- UUID 主键和外键约束。
- 用户、任务、文档、证据和报告之间的级联关系。
- `owner_id` 索引，支持后续多租户数据过滤。
- 非负 token、成本、切片编号等 Check 约束。
- 证据置信度范围和页码正数约束。
- 网页证据与文档证据的来源一致性约束。
- 草稿/发布状态与 `published_at` 的一致性约束。
- `(run_id, checkpoint_key)` 检查点唯一约束。
- `(run_id, content_hash)` 证据唯一约束。
- `(report_id, version)` 报告版本唯一约束。

### 3.3 pgvector 与检索准备

初始迁移启用了：

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
```

`document_chunks.embedding` 使用 1536 维向量，并建立 HNSW 余弦索引：

```text
document_chunks_embedding_hnsw_idx
USING hnsw
vector_cosine_ops
```

这为后续 Task 6 的向量检索和混合 RAG 提供了数据库基础。后续选择 Embedding 模型时，输出维度必须与 1536 保持一致；若更换维度，需要通过新迁移修改数据库，而不能直接修改已合并的初始迁移。

### 3.4 数据库连接工厂

`packages/db/src/client.ts` 提供：

```ts
createDatabase(databaseUrl, options);
```

连接工厂负责：

- 校验 PostgreSQL URL。
- 创建 `postgres.js` 客户端。
- 使用完整 Schema 创建 Drizzle Database。
- 导出数据库和客户端类型。
- 提供幂等的异步关闭方法，防止测试进程残留连接。

连接采用显式工厂，而不是模块级全局单例，便于：

- 开发数据库和测试数据库隔离。
- 测试结束后关闭连接。
- 为不同运行环境配置连接池大小。
- 避免模块加载时立即读取环境变量并建立隐式连接。

## 4. Repository 实现

### 4.1 RunRepository

公开接口：

```ts
create(input);
get(runId);
transition(runId, expected, next);
saveCheckpoint(runId, checkpoint);
```

核心设计：

- `create()` 依赖数据库生成 UUID、初始状态、用量和时间。
- `get()` 不存在时返回 `null`。
- `transition()` 使用一条带 `id + expected status` 条件的 Update 实现乐观并发控制。
- 状态已经变化或任务不存在时统一抛出 `RUN_STATUS_CONFLICT`。
- `saveCheckpoint()` 在事务中基于 `(runId, checkpointKey)` 执行 upsert。
- PostgreSQL `numeric` 返回值在 Repository 边界转换为 Domain 所需的 `number`。

状态转换没有采用“先查询、再更新”，避免两个 Worker 同时看到旧状态后都成功更新。

### 4.2 EvidenceRepository

公开接口：

```ts
upsert(evidence);
listForRun(runId);
```

核心设计：

- 基于 `(runId, contentHash)` 幂等保存证据。
- Agent 重试或重复搜索不会产生相同证据的重复记录。
- 冲突更新保留原 Evidence ID，避免已生成的引用失效。
- 不同 Run 允许使用相同内容哈希。
- 查询结果按照 `retrievedAt + id` 稳定排序，保证 Prompt、报告引用和评测可复现。
- 数据库 `numeric confidence` 在 Repository 边界转换为 `number`。

### 4.3 ReportRepository

公开接口：

```ts
createVersion(input);
getPublished(reportId);
```

核心设计：

- `reports` 保存逻辑报告身份，`report_versions` 保存不可变内容。
- 每次修改报告都插入新版本，不覆盖历史版本。
- 在事务中使用 `SELECT ... FOR UPDATE` 锁定报告主记录。
- 锁定后按版本号降序读取最新版本并分配下一个版本号。
- 同一报告的并发创建请求会依次得到不同版本号。
- `reportId`、`runId` 或 `ownerId` 不一致时统一抛出 `REPORT_IDENTITY_CONFLICT`。
- 草稿的 `publishedAt` 必须为 `null`。
- 已发布版本由 Repository 设置发布时间。
- `getPublished()` 只返回最新已发布版本，新草稿不会遮挡旧发布版本。

## 5. 迁移与本地数据库

新增文件：

- `docker-compose.yml`
- `packages/db/drizzle.config.ts`
- `packages/db/src/migrations/0000_initial.sql`
- Drizzle migration journal 和 snapshot

本地数据库使用：

```text
pgvector/pgvector:pg16
```

开发数据库和测试数据库分离：

```text
insightforge
insightforge_test
```

迁移文件编号为 `0000_initial.sql`，而计划示例写的是 `0001_initial.sql`。这是 Drizzle Kit 的正常编号方式，迁移文件名、snapshot 和 journal 保持一致，没有手动重命名。

已经执行并验证：

- 两个 PostgreSQL 扩展存在。
- 9 张业务表存在。
- HNSW 索引存在。
- 唯一索引和 Check 约束存在。
- 重复执行迁移不会重复创建业务表。
- Drizzle 迁移记录正确保存。

## 6. 测试与质量门

本阶段最终共有 42 个测试：

- Domain：研究任务、JSON、证据来源一致性、报告状态等运行时契约测试。
- Testkit：原有确定性模型测试。
- DB：18 个真实 PostgreSQL Repository 集成测试。

数据库测试覆盖：

- Run 创建、查询和数据库默认值。
- 乐观状态转换成功与冲突。
- Checkpoint 幂等 upsert。
- Evidence 插入、更新、跨 Run 唯一范围和稳定排序。
- 报告版本递增与历史版本不可变。
- 并发报告版本分配。
- 草稿隐藏和最新已发布版本查询。
- 报告身份冲突统一处理。

PR 合并前通过的质量门：

```bash
pnpm --filter @insightforge/db test
pnpm --filter @insightforge/db db:check
pnpm peers check
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

GitHub Actions 使用临时的 pgvector PostgreSQL 16 Service，在 CI 中执行迁移后再运行集成测试。因此本地测试通过之外，远程 Linux 环境也验证了完整流程。

## 7. 本阶段发现并解决的问题

开发和评审过程中解决了以下问题：

1. Domain 最初没有定义和导出 `JsonObject` 类型，导致 DB JSONB 类型无法引用。
2. Schema 中存在未使用的 `serial` 导入。
3. `pgTable` 索引回调没有返回数组，触发了难以定位的 TypeScript 重载错误。
4. `research_runs.status` 缺少 `queued` 默认值。
5. `retrieveAt` 与 Domain 的 `retrievedAt` 命名不一致。
6. `document_chunks.owner_id` 缺少索引。
7. Evidence 页码、置信度和来源一致性约束不完整。
8. 文档去重范围从用户级调整为 `(runId, contentHash)`，与当前数据模型保持一致。
9. 初始 CI 没有 PostgreSQL Service、测试连接地址和迁移步骤。
10. ReportRepository 最初按版本号升序读取，第三个版本会错误地再次分配 version 2。
11. 同一 Run 使用不同 reportId 时，底层唯一约束错误被统一转换为 `REPORT_IDENTITY_CONFLICT`。

这些问题说明：类型检查通过不等于数据库行为正确。涉及唯一约束、事务、行锁、upsert 和 pgvector 时，必须使用真实 PostgreSQL 集成测试验证。

## 8. 关键技术理解

### 索引与约束的区别

- 普通索引主要用于加速查询。
- 唯一索引同时负责查询性能和数据唯一性。
- Check 约束在 Insert/Update 时拒绝非法数据。
- 外键保证引用记录存在，但 PostgreSQL 不会自动为引用方外键创建普通查询索引。

索引会提高读性能，但会增加写入和存储成本，因此应围绕真实查询模式建立。

### Domain 与数据库的双层校验

- Zod 在数据进入应用或 Repository 时校验。
- PostgreSQL 在最终写入时保护数据完整性。

两层规则必须一致。例如 Evidence 的来源类型、URL/documentId 关系、报告发布状态和发布时间都同时受到 Domain 与数据库保护。

### 幂等与并发

- Checkpoint 和 Evidence 使用唯一键 + upsert 实现幂等。
- Run 状态使用条件 Update 实现乐观并发控制。
- Report 版本使用事务 + 父记录行锁实现串行版本分配。

三种机制解决的问题不同，不能相互替代。

## 9. 当前边界与后续注意事项

Task 2 只完成领域和持久化基础，尚未实现：

- Web API 和用户鉴权。
- Redis/BullMQ 异步队列。
- SSE 进度事件和取消接口。
- LangGraph Agent 状态图。
- 搜索、网页抓取和证据抽取。
- 文档上传、切片、Embedding 和混合检索。
- Writer、Reviewer 和引用校验。
- 评测、可观测性和公开部署。

后续开发需要继续遵守以下约定：

- `updatedAt.defaultNow()` 只负责插入默认值，更新时 Repository 必须显式设置时间。
- PostgreSQL `numeric` 通常以字符串返回，Repository 必须在 Domain 边界转换。
- 多租户查询必须使用可信会话中的 `ownerId`，不能信任客户端传入的 ownerId。
- 已合并迁移不应直接修改，数据库结构变化应生成新迁移。
- 所有创建报告版本的路径都必须通过 ReportRepository，才能遵守行锁顺序。
- 向量维度变更必须同时考虑 Embedding 模型、Schema、索引和迁移。

## 10. Task 2 完成清单

- [x] 定义 Research Domain Schema
- [x] 定义 Evidence Domain Schema
- [x] 定义 Report Domain Schema
- [x] 添加 Domain 单元测试
- [x] 创建 `@insightforge/db` 工作区包
- [x] 实现数据库连接工厂
- [x] 创建 9 张 PostgreSQL 表
- [x] 启用 pgvector 和 HNSW 余弦索引
- [x] 生成并执行初始迁移
- [x] 实现 RunRepository
- [x] 实现 EvidenceRepository
- [x] 实现 ReportRepository
- [x] 添加真实 PostgreSQL 集成测试
- [x] 配置 CI PostgreSQL Service 和迁移步骤
- [x] PR #3 合并到 `main`

## 11. 下一阶段

下一阶段是 Task 3：创建异步运行、队列处理、进度事件和取消机制。

主要目标包括：

- 使用 Redis 和 BullMQ 接收异步调研任务。
- 在入队前持久化 `queued` Run。
- Worker 使用 RunRepository 执行安全状态转换。
- 提供创建任务、查询状态和取消任务的 API。
- 使用 SSE 发布可重放的任务进度事件。
- 保证重复入队、Worker 重试和取消操作具备幂等性。

Task 3 应直接复用本阶段的 Domain 和 Repository，不让 Web API、Worker 或 Agent 节点直接操作 Drizzle 表。
