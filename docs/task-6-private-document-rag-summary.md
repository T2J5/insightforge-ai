# Task 6：上传文档摄取与所有者隔离混合 RAG 阶段总结

> 完成日期：2026-08-31（Asia/Shanghai）
>
> 分支：`codex/add-private-document-rag`
>
> 状态：代码实现完成，等待提交 PR

## 1. 任务目标

Task 6 为企业调研 Agent 增加私有资料能力。用户上传的 PDF、DOCX、Markdown 或 TXT 会经过可信文件校验、文本解析、结构化分块和 Embedding，再由 PostgreSQL 全文检索与 pgvector 语义检索共同召回。

本阶段最重要的约束不是“能搜到文本”，而是：

- 其他用户的 chunk 永远不能进入候选集；
- 格式伪装、超大文件和空文档不能进入解析器；
- 解析或 Embedding 失败不能留下部分可搜索索引；
- 重复文件不能重复支付解析和向量成本；
- 检索结果要保留每一阶段的评分，便于后续评测。

## 2. 完整任务逻辑

```text
multipart 上传
  → 从签名 Cookie 获取 ownerId
  → 验证 Run 属于 owner
  → 校验文件数量、大小、扩展名、MIME 和魔数
  → 规范文本并计算 SHA-256 contentHash
  → 按 ownerId + contentHash 查重
      ├─ 已 ready：复用已有 chunks
      └─ 新文档：写入对象存储并创建 pending 记录
  → 建立 run_documents 关联
  → status = processing
  → PDF/DOCX/MD/TXT 解析为 ParsedDocument
  → 去除满足 60% 页面阈值的重复页眉页脚
  → 结构化分块并批量生成 Embedding
  → 数据库事务：替换 chunks + status = ready
  → 可被 HybridRetriever 搜索
```

任何解析或 Embedding 错误都会把文档标记为 `failed` 并保存公开错误码。Chunk 的删除、插入和文档 ready 状态在同一事务中完成，所以事务失败后旧索引仍然存在，不会留下半套新数据。

## 3. 上传安全

上传服务执行以下规则：

- 单文件最大 20 MB；
- 单次请求最多十个文件；
- 数据库按 `run_documents` 统计每个 Run 的累计文档数量；
- 仅支持 PDF、DOCX、Markdown 和 TXT；
- 扩展名、浏览器 MIME 与文件魔数必须一致；
- 文本文件拒绝包含 NUL 字节的二进制内容；
- 原文件名只作为清洗后的显示元数据；
- 对象存储键由随机 UUID 生成，不使用用户文件名；
- 整批文件先验证再开始写入，避免部分成功；
- 对象写入后数据库创建失败会删除孤儿对象。

## 4. 解析与分块

解析层统一产出：

```ts
type ParsedDocument = {
  title: string;
  pages: Array<{
    pageNumber: number;
    headings: string[];
    text: string;
  }>;
};
```

PDF 使用 PDF.js 按页提取文本，DOCX 使用 Mammoth 转换标题和段落。Markdown/TXT 使用 UTF-8 严格解码。扫描版 PDF 不承诺 OCR；没有有效文本时返回 `DOCUMENT_EMPTY_OR_SCANNED`。

分块目标是 800 Token、最大 1,200 Token、重叠 120 Token。当前使用保守的字符近似估算切块边界，Embedding 供应商的真实用量仍应在后续可观测阶段单独记录。每个 Chunk 保存 `pageStart`、`pageEnd` 和 `headingPath`，为报告引用提供定位信息。

## 5. 幂等摄取与数据关系

`documents` 保存用户拥有的唯一文档实体，唯一键为：

```text
(owner_id, content_hash)
```

同一用户在多个 Run 中上传相同文件时复用文档和向量，通过 `run_documents` 多对多关联表记录当前 Run 可以使用哪些文档。不同用户即使上传相同文件也不会共享私有记录。

文档状态包括：

- `pending`：元数据已建立；
- `processing`：正在解析和生成向量；
- `ready`：全部 Chunk 已事务提交，可以检索；
- `failed`：摄取失败，不参与检索。

## 6. 混合检索逻辑

一次检索执行：

1. PostgreSQL `to_tsvector/plainto_tsquery` 关键词召回 30 条；
2. pgvector 余弦相似度召回 30 条；
3. 两路 SQL 都包含 `owner_id`、ready 状态和可选 `documentIds` 过滤；
4. 使用常数 60 的 Reciprocal Rank Fusion 合并排名；
5. 取融合结果前 20 条进行确定性词项覆盖重排；
6. 默认返回 8 条，最大 20 条。

每条结果保留 `lexicalScore`、`vectorScore`、`fusionScore` 和 `rerankerScore`，后续 Task 9 可以直接比较向量检索、混合检索和重排后的 Recall/MRR。

## 7. Agent 与权限边界

`SearchUploadedDocumentsTool` 的模型输入只有 query、documentIds 和 limit。`ownerId` 不在输入 Schema 中，只能由认证后的服务端上下文注入。即使模型输出 `ownerId: user-b`，严格 Zod Schema 也会拒绝整个调用。

这意味着权限不是 Prompt 约定，而是工具接口和 SQL 查询的双重约束。

## 8. 存储与部署

原文件通过 `ObjectStoragePort` 隔离：

- 本地开发：`LocalObjectStorage`，默认目录 `.data/uploads`；
- 公开部署：`S3ObjectStorage`，兼容 AWS S3 与 Cloudflare R2。

Embedding 使用 OpenAI 兼容 `/embeddings` 接口，默认模型为 `text-embedding-3-small`，固定输出 1,536 维以匹配 pgvector 列。API Key、Base URL 和模型均通过服务端环境变量配置。

## 9. 关键测试

测试覆盖：

- 文件数量、扩展名、MIME、魔数和显示名清洗；
- Markdown/TXT 解析、空文档和空 PDF；
- 重复页眉页脚 60% 阈值；
- 分块大小、重叠、页码和标题路径；
- Embedding 顺序与维度检查；
- 重复文件复用；
- 摄取失败状态与禁止部分提交；
- PostgreSQL 真实事务回滚；
- 关键词与向量检索 owner 隔离；
- 跨 Run 文档复用和关联计数；
- RRF 确定性排序和完整评分结构；
- 上传 API 服务端身份；
- Agent 工具拒绝模型伪造 ownerId。

最终质量门禁结果：Prettier、ESLint、TypeScript 类型检查全部通过；55 个测试文件、429 项测试通过。Task 6 的 Drizzle 迁移已经在测试 PostgreSQL/pgvector 数据库真实执行。

## 10. 下一阶段

Task 7 会把网页 Evidence 与文档检索结果统一提供给 Writer，完成结构化报告版本、确定性引用校验、模型 Reviewer、一次有边界修订和安全公开发布。
