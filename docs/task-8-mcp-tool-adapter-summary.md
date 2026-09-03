# Task 8：MCP 工具适配与统一 ToolRegistry

## 1. 阶段目标

Task 8 将工具执行从 LangGraph 节点中抽离，建立统一 `ToolRegistry`，并通过 MCP
协议复用相同的网页搜索和私有文档检索能力。LangGraph 和 MCP Adapter 都不再直接
依赖 Tavily、PostgreSQL 或 `HybridRetriever` 的实现细节。

```text
LangGraph ─┐
           ├─> ToolRegistry ─> ToolDefinition ─> 业务端口
MCP ───────┘
```

## 2. ToolRegistry 的职责

`packages/agent/src/tools/tool-registry.ts` 提供统一执行入口：

- 只允许调用已经注册的工具；
- 使用 Zod 校验不可信输入和工具输出；
- 从可信上下文读取 ownerId、runId、截止时间、预算和取消信号；
- 组合调用方取消与内部超时；
- 限制 JSON 输出的 UTF-8 字节数；
- 记录不包含原始输入、输出的开始、成功和失败审计事件；
- 将内部异常转换为稳定错误码。

## 3. 工具定义与 Graph 解耦

`research-tool-registry.ts` 注册三类工具：

- `research`：供现有 LangGraph 调研节点使用；
- `search_web`：供直接调用和 MCP 使用；
- `search_uploaded_documents`：供经过 owner 隔离的私有文档检索使用。

Graph 的 researcher 节点现在调用 `ToolRegistry.execute()`，不再直接调用
`researchTool.research()`。原有调研结果、Evidence 和报告流程保持不变。

## 4. MCP Adapter

`apps/mcp` 使用官方 `@modelcontextprotocol/server` v2：

- `auth.ts` 从可信 Session 构造工具上下文，并维护进程级调用预算；
- `tool-result.ts` 统一成功响应、错误白名单和异常脱敏；
- `search-web.ts` 适配公开网页搜索；
- `search-documents.ts` 适配私有文档检索；
- `index.ts` 使用 `serveStdio()` 启动 MCP Server。

Adapter 只负责协议转换，不重复搜索、检索、预算或错误处理逻辑。

## 5. 私有文档安全边界

MCP Server 默认只注册 `search_web`。私有文档工具必须显式设置：

```env
INSIGHTFORGE_MCP_ENABLE_PRIVATE_DOCUMENTS=true
INSIGHTFORGE_MCP_OWNER_ID=<owner-id>
INSIGHTFORGE_MCP_RUN_ID=<run-uuid>
```

`ownerId` 永远不从 MCP 工具 arguments 读取。文档检索继续在 PostgreSQL 查询阶段
按 owner 过滤，避免先读取其他用户内容再做内存过滤。

## 6. 验证结果

- Agent：19 个测试文件、129 个测试通过；
- MCP：4 个测试文件、12 个测试通过；
- 全仓：64 个测试文件、456 个测试通过；
- Prettier、ESLint、TypeScript 和生产构建通过；
- 直接 Registry 调用与 MCP Adapter 调用返回一致业务结果。

## 7. 下一阶段

Task 9 将建立带版本的 Golden Dataset、Recall/MRR/引用指标、离线评测运行器，以及
模型、节点和工具调用的 Trace、Token、成本和耗时观测。
