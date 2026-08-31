# Task 5：公开网页调研与标准化证据阶段总结

> 完成日期：2026-08-31（Asia/Shanghai）
>
> 分支：`codex/add-cited-web-evidence`
>
> 提交：`f94861d feat: collect cited web evidence`
>
> Pull Request：[#8](https://github.com/T2J5/insightforge-ai/pull/8)
>
> 状态：Task 5 已完成，等待 PR 合并

## 1. 阶段目标

Task 5 的目标是把 Task 4 中“Agent 能调用搜索工具并生成报告”的流程，升级为一条可验证、可追溯、可幂等恢复的网页证据流水线：

1. 搜索并规范化公开网页来源；
2. 在安全边界内抓取网页正文；
3. 把网页视为不可信外部数据；
4. 从正文中提取并验证逐字引文；
5. 将候选证据标准化并保存到 PostgreSQL；
6. 在任务完成前保证证据已经持久化。

## 2. 最终数据流

```text
Planner 生成调研问题
  → Tavily 搜索
  → URL 规范化、去重和公网地址校验
  → BoundedWebPageFetcher 抓取并清洗正文
  → Evidence Extractor 生成候选 claim/quote
  → 服务端验证 URL 归属和 quote 原文包含关系
  → Evidence Normalizer 生成规范 URL、来源类别和稳定 contentHash
  → EvidenceRepository 幂等保存
  → 保存 agent-result checkpoint
  → ResearchRun 标记 completed
```

这条顺序保证：如果证据保存失败，Run 不会错误进入完成状态；Worker 重试时，相同 `run_id + content_hash` 会更新原记录，而不是插入重复证据。

## 3. 主要实现

### 3.1 搜索与网页抓取契约

在 Domain 层新增与供应商无关的端口：

- `WebSearchPort`：返回标题、原 URL、规范 URL、摘要、分数和发布时间；
- `WebPagePort`：返回规范 URL、标题、发布者、发布时间、抓取时间、清洗正文、内容哈希和 HTTP 元数据。

Agent 和 Worker 依赖端口，不直接依赖特定搜索或抓取 SDK，后续可以替换供应商而不修改图状态和业务持久化逻辑。

### 3.2 URL 规范化与 SSRF 防护

搜索和抓取入口会执行：

- 只允许 HTTP/HTTPS；
- 删除 fragment、默认端口和常见跟踪参数；
- 规范 hostname、pathname 和 query 参数顺序；
- 拒绝 localhost、链路本地、回环、私有 IPv4/IPv6 地址；
- DNS 解析后检查全部地址；
- 每一次重定向都重新执行 URL 和地址检查；
- 使用规范 URL 对搜索结果确定性去重。

### 3.3 有边界的网页抓取

`BoundedWebPageFetcher` 提供以下保护：

- 默认 10 秒超时；
- 最多两次有限重试和退避；
- 最大 1 MB 响应体；
- 最多五次重定向；
- 只接受 HTML、XHTML 和纯文本；
- 按 hostname 限制并发；
- 在读取响应流时执行字节上限，而不是读取完再检查；
- 去除 script、style、noscript、SVG 和模板内容并归一化空白。

错误被稳定映射为 `SEARCH_RATE_LIMITED`、`PAGE_BLOCKED`、`PAGE_TOO_LARGE`、`PAGE_EMPTY` 或 `PAGE_TIMEOUT`，便于上层决定是否重试。

### 3.4 提示注入防护与引文验证

网页正文始终作为不可信数据处理。Evidence Extractor 的系统指令明确禁止执行网页中的提示、泄露要求或工具调用指令。

模型只负责提出候选证据，服务端代码负责确定性验证：

- `questionId` 必须属于当前调研问题；
- `sourceUrl` 必须来自该问题的真实搜索结果；
- `quote` 在空白归一化后必须是来源正文的连续子串；
- 同一问题最多保留两条证据；
- 重复候选会被删除；
- 没有任何可信引文时以 `GROUNDED_EVIDENCE_REQUIRED` 失败，不能静默生成无依据报告。

### 3.5 标准化证据与来源质量

证据保存前会：

- 规范来源 URL；
- 归一化引文空白；
- 使用 `source type + canonical URL + normalized quote` 生成 SHA-256 `contentHash`；
- 保存 claim、quote、标题、发布者、发布时间、抓取时间和置信度；
- 将来源划分为 `official`、`trusted_news`、`secondary` 或 `unknown`。

来源质量评分只用于来源排序和调研优先级，不能替代引文验证，也不会自动把网页内容认定为事实。

### 3.6 PostgreSQL 持久化

新增 Drizzle 迁移 `0002_dark_karnak.sql`：

- 创建 `evidence_source_category` PostgreSQL Enum；
- 为 `evidence` 表增加非空 `source_category` 列；
- 默认值为 `unknown`，兼容已有证据记录。

迁移由 Drizzle 正式生成，并包含 journal 与 snapshot，避免出现只有 SQL 文件但 `drizzle-kit migrate` 不执行的问题。

## 4. 测试覆盖

新增或扩展的测试覆盖：

- URL 规范化、跟踪参数清理和去重；
- localhost、私网、IPv4/IPv6 和 DNS 解析安全边界；
- 重定向逐跳复检；
- 超时、重试、响应大小、内容类型和错误映射；
- hostname 并发限制；
- 批量网页抓取的部分失败降级；
- 网页提示注入隔离；
- 引文原文包含、跨问题 URL 和伪造引文拒绝；
- Evidence 稳定哈希与规范化；
- 来源类别判断和域名后缀混淆防护；
- Worker 的证据先保存、后完成顺序；
- EvidenceRepository 幂等写入和来源类别持久化；
- Drizzle 迁移在测试数据库中的真实执行。

## 5. 验收结果

- Prettier 格式检查通过；
- ESLint 全仓检查通过；
- TypeScript 全仓类型检查通过；
- 数据库集成测试 27 项通过；
- 全仓 47 个测试文件、402 项测试全部通过；
- `git diff --check` 通过。

## 6. 本阶段获得的 Agent 工程能力

Task 5 不只是增加一个搜索 API，而是完成了 Agent 与外部世界交互时最重要的可信边界：

- **工具能力**：用稳定端口隔离搜索供应商和抓取实现；
- **安全能力**：处理 SSRF、重定向、资源耗尽和提示注入；
- **Grounding 能力**：让模型提出候选、代码验证事实依据；
- **证据链能力**：从报告引用回溯到 claim、quote 和原始 URL；
- **可靠性能力**：用 checkpoint、唯一约束和保存顺序保证重试安全；
- **可测试能力**：用假搜索、假抓取和固定时间验证确定性行为。

## 7. 下一阶段

Task 6 将在当前网页证据链之外增加用户上传文档，重点包括：

- PDF、DOCX、Markdown 和 TXT 解析；
- 结构化分块和 Embedding；
- 所有者隔离；
- 关键词检索与向量检索；
- Reciprocal Rank Fusion（RRF）；
- 网页证据和私有文档证据的混合 RAG。
