# Task 12：质量验证与求职作品集总结

## 阶段目标

Task 12 不是再增加一个 Agent 节点，而是把前 11 个阶段整理为可在本地验证的工程成果：能重复构建、能检查依赖、能展示固定示例并量化质量。

## 已完成的仓库工作

1. Web `/api/health` 同时探测 PostgreSQL 与 Redis，依赖异常返回 `503 degraded`；Worker 提供同等依赖健康检查。
2. Web、Worker、MCP 使用独立多阶段 Dockerfile；本地 Compose 配置可启动依赖服务。
3. `release:prepare` 按顺序执行 Drizzle migration、LangGraph checkpoint 初始化和幂等演示数据 seed。
4. Golden Dataset 保持 51 条样本，并新增引用支持率、运行成功率、nearest-rank P95 和平均成本聚合。
5. 三份固定 ID 演示报告仅引用企业官方网站的企业使命原文；其余章节明确标注没有进行实时断言，避免以 seed 数据伪装调研结论。
6. README、架构、评测、讲解脚本、简历表述和技术复盘形成完整作品集文档。
7. CI 增加 Playwright 用户旅程、确定性评测和构建。

## 一条本地请求如何工作

初始化时，`release:prepare` 依次创建业务表、初始化 checkpoint 表并写入三份演示报告。Web 接收创建请求后只写 Run 并向 BullMQ 入队，Worker 才执行 Agent Graph。PostgreSQL 保存权威状态、证据、报告和 checkpoint；Redis 保存队列、取消标志与短期 SSE 事件。这样 Web 重启不影响长任务，Worker 重启也能从最后 checkpoint 继续。

## 当前验收边界

Task 12 按“本地求职作品集”范围收尾：本地质量门禁、容器配置、截图、评测和讲解材料均已交付。公网部署、生产冒烟、云资源、线上成本验收与演示视频不属于本次交付范围。

容器实际构建此前被镜像仓库 `insufficient_scope` 错误阻断，不能视为已通过容器运行验收。已有本地 Node 生产构建结果仍有效。

## 2026-09-07 本地发布门禁

- Prettier、ESLint 和 TypeScript：通过；
- Vitest：81 个测试文件、497 项测试通过；
- Playwright：桌面和移动端共 10 条用户旅程通过；
- Golden Dataset：51 条样本，三种检索方案基线通过；
- Next.js 生产构建：通过；
- 浏览器实测：首页有内容、无错误覆盖层、无控制台错误，三份演示入口可见；
