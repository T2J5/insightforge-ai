# 简历项目描述

## 一句话版本

InsightForge：基于 TypeScript、Next.js、BullMQ、LangGraph、PostgreSQL/pgvector 与 Redis 的可恢复企业调研 Agent，输出可追溯到逐字引文的结构化报告。

## 项目职责与亮点

- 设计 Web/Worker 分离的异步架构，以 PostgreSQL 为权威状态、BullMQ 承载任务、SSE 提供可回放进度，支持取消、有限重试和进程重启恢复。
- 编排 Planner、Researcher、Evidence、Writer、Reviewer、Publisher 节点，通过确定性条件边、一次修订上限与 Token/成本/时长预算限制 Agent 循环。
- 实现 PDF/DOCX/Markdown/TXT 摄取、结构化分块、PostgreSQL 全文检索、pgvector、RRF 与重排序，并在 SQL、缓存键和工具上下文中强制 owner 隔离。
- 建立 Evidence UUID 引用链、事实覆盖与支持度校验、不可变报告版本；公开接口拒绝包含私有文档证据的报告。
- 建立 51 条 Golden Dataset 和可手工核算的 Recall@5、MRR、引用支持、成功率、P95 延迟与成本指标，PR CI 使用零外部费用确定性评测，在线评测单独人工触发。
- 为 Web/Worker/MCP 提供非 root 多阶段容器、依赖健康检查与幂等迁移/seed。

## 面试时不要误述

离线夹具对比结果证明评测流水线可复现，不等于真实线上检索提升；没有生成在线评测 Artifact 或公开部署记录前，不在简历中写“线上准确率提升 X%”“P95 为 X ms”或“单次成本为 X 元”。
