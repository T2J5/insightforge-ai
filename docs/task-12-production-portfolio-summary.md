# Task 12：部署准备与求职作品集总结

## 阶段目标

Task 12 不是再增加一个 Agent 节点，而是把前 11 个阶段变成招聘方可以验证的工程成果：能重复构建、能检查依赖、能展示固定示例、能量化质量，也能明确区分本地结果与真实生产结果。

## 已完成的仓库工作

1. Web `/api/health` 同时探测 PostgreSQL 与 Redis，依赖异常返回 `503 degraded`；Worker 提供同等依赖健康检查。
2. Web、Worker、MCP 使用独立多阶段 Dockerfile。生产 Compose 与 Railway/Vercel 配置记录服务命令、健康路径和发布前初始化步骤。
3. `release:prepare` 按顺序执行 Drizzle migration、LangGraph checkpoint 初始化和幂等演示数据 seed。
4. Golden Dataset 保持 51 条样本，并新增引用支持率、运行成功率、nearest-rank P95 和平均成本聚合。
5. 三份固定 ID 演示报告仅引用企业官方网站的企业使命原文；其余章节明确标注没有进行实时断言，避免以 seed 数据伪装调研结论。
6. 生产冒烟脚本验证健康端点、演示报告、HTTP(S) 引用 URL、受令牌保护的零成本 Run 创建和公开报告读取。
7. README、架构、部署、评测、演示、简历表述和技术复盘形成完整作品集文档。
8. CI 增加 Playwright 用户旅程、确定性评测和构建；独立生产工作流支持手动与定时冒烟。

## 一条发布请求如何工作

部署时，Web 的 pre-deploy 先创建业务表并写入三份演示报告；Worker 的 pre-deploy 初始化 checkpoint 表。Web 接收创建请求后只写 Run 并向 BullMQ 入队，Worker 才执行 Agent Graph。PostgreSQL 保存权威状态、证据、报告和 checkpoint；Redis 保存队列、取消标志与短期 SSE 事件。这样 Web 重启不影响长任务，Worker 重启也能从最后 checkpoint 继续。

## 为什么生产冒烟不调用真实模型

每日冒烟的目标是识别部署接线故障，而不是反复消费模型预算。受保护端点会创建一条真实数据库 Run、Evidence 与 Report，但内容来自固定公开夹具，成本为零。真实模型质量由显式触发的 Online Evaluation 负责，两种检查不能混为同一指标。

## 当前验收边界

仓库内的实现和本地门禁可以完成并复现；公网部署仍需要平台项目、数据库、Redis、对象存储、域名和 Secret。创建这些资源可能产生费用，因此在没有明确生产平台与账户授权前，不标记 12.7 的生产冒烟和 12.8 的发布记录为完成，也不在 README 填写虚假 URL。

## 2026-09-07 本地发布门禁

- Prettier、ESLint 和 TypeScript：通过；
- Vitest：81 个测试文件、497 项测试通过；
- Playwright：桌面和移动端共 10 条用户旅程通过；
- Golden Dataset：51 条样本，三种检索方案基线通过；
- Next.js 生产构建：通过；
- 浏览器实测：首页有内容、无错误覆盖层、无控制台错误，三份演示入口可见；
- 生产冒烟：待真实公网资源部署后执行。

## 发布后必须补录

- 公开站点 URL；
- 发布 Git 提交 SHA / tag；
- Production Smoke 工作流链接与时间；
- 真实模型在线评测 Artifact；
- 实际 P95、单次成本与告警截图；
- 3–5 分钟演示视频链接。
