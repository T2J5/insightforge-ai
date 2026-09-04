# Task 10：治理与安全边界阶段总结

## 目标

Task 10 处理的不是 Agent 能否完成任务，而是它在公开部署后能否以可控费用、安全数据边界和可审计方式运行。

```text
创建请求 → 身份/权限 → 原子限流 → 数据库与队列
网页资料 → URL/DNS/重定向检查 → 内容边界 → 模型
私有检索 → owner + 文档集合 + 版本缓存键 → 隔离结果
模型调用 → Token/成本预算 → usage_events → 管理员查询
游客上传 → 24 小时保留策略 → 保留被报告引用的证据
```

## Redis 原子限流

`RedisRateLimiter` 使用 Lua 在 Redis 服务端连续执行 `INCR` 与首次 `EXPIRE`。如果在 Node.js 中分两条命令执行，进程可能在计数后、设置 TTL 前退出，产生永不过期的额度键。

Redis 键只保存 subject 的 SHA-256，不把匿名 Cookie ID 或用户 ID 直接暴露在运维界面。返回值包含 `limit`、`remaining` 和 `resetAt`，HTTP 429 同时提供标准 `Retry-After` 与限额响应头。

## 深度调研权限

`RunService.createRun` 的第三个参数是服务端可信的授权上下文。请求体不能声明 `deepResearch`；默认值为 false。未授权深度请求在创建数据库记录和消费模型费用之前失败。

## 分级缓存

- 公开搜索：规范化查询哈希 + 搜索供应商版本；
- 公开网页：规范 URL 哈希 + 抓取器版本；
- 私有检索：owner 哈希 + 排序后的文档集合 + 查询哈希 + 索引/重排版本；
- 公开报告：报告 ID + 版本，最多缓存 7 天，包含私有文档时禁止缓存。

缓存键包含算法版本是为了避免索引或重排逻辑升级后继续读取旧结果。文档 ID 先排序去重，使同一集合不会因为输入顺序产生多个缓存条目。

## Prompt 注入与 SSRF

`ContentBoundary.wrapUntrusted` 对外部网页和证据添加固定标签，并明确声明内容是证据而非指令。它不能单独保证模型绝不被注入，因此仍需结构化输出、工具白名单、引用校验和执行预算共同防护。

`UrlPolicy` 复用项目现有的公网 URL 校验：拒绝 URL 凭据、非 HTTP(S)、localhost、私有/保留 IP、IPv4-mapped IPv6；域名解析的所有地址都必须是公网地址。网页抓取器对每次手动重定向重新解析与检查，避免公开 URL 302 到云元数据地址。

## 数据保留和用量接口

游客上传默认在 24 小时后进入清理候选。清理顺序为文档块、对象存储文件、文档记录；仍被 Evidence 引用的文档被保留，聚合用量也不在清理范围内。

模型用量通过 `DatabaseUsageSink` 写入 `usage_events`。管理员接口需要 `Authorization: Bearer <ADMIN_API_TOKEN>`，令牌经过定长哈希后做 timing-safe 比较。响应只包含模型、操作、Token、成本、延迟、缓存、重试和节点信息，不返回 Prompt 或私有正文。

## 主要验证命令

```bash
pnpm test -- rate-limit cache content-boundary url-policy retention-job usage
pnpm check
pnpm build
```
