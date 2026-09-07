# 生产部署手册

## 推荐拓扑

使用 Railway 承载两个来自同一仓库的常驻服务：`web` 与 `worker`；添加托管 PostgreSQL、Redis，并使用 Cloudflare R2 或其他 S3 兼容对象存储。Web 生成公网域名，Worker、数据库和 Redis 不开放公网入口。

Railway 当前已把旧 `railway.json` Config as Code 标记为弃用，并计划于 2026-12-01 停止新服务使用。本仓库中的 JSON 仍用于记录可审核配置；创建新 Railway 服务时，在 Dashboard 中按本文复制设置，或迁移到 Railway Infrastructure as Code。

## 发布顺序

1. 创建 PostgreSQL 16 + pgvector 和 Redis 服务；生产 Redis 使用平台提供的 `rediss://` TLS URL。
2. 创建 Web 服务，Dockerfile Path 设为 `/apps/web/Dockerfile`，配置文件设为 `/deploy/railway.web.json`。
3. Web pre-deploy 先执行 Drizzle migration，再幂等 seed 三份演示报告。
4. 创建 Worker 服务，Dockerfile Path 设为 `/apps/worker/Dockerfile`，配置文件设为 `/deploy/railway.worker.json`。
5. Worker pre-deploy 执行 LangGraph `checkpoint:setup`，初始只运行 1 个副本。
6. 为 Web 生成公网域名，把该地址保存到 GitHub `production-smoke` Environment 的 `INSIGHTFORGE_PUBLIC_URL`。
7. 运行生产冒烟，确认后再开放作品集链接。

若在单机用 `compose.production.yml` 验证镜像，先复制 `.env.example` 为 `.env.production.local`，填入生产形态的非空配置，并在 shell 中提供独立的 `POSTGRES_PASSWORD`。该文件已被 Git 忽略，不能提交。

## 环境变量分组

Web：`DATABASE_URL`、`REDIS_URL`、`AUTH_SECRET`、`SMOKE_TEST_TOKEN`、`ADMIN_API_TOKEN`、对象存储和 Embedding 配置。

Worker：`DATABASE_URL`、`REDIS_URL`、`MODEL_API_KEY`、`MODEL_NAME`、`SEARCH_API_KEY`、模型/搜索超时与 quick/deep 预算、OTLP/Langfuse 配置。

共享 Secret 必须由平台注入，不能写入镜像或 Git。Preview 与 Production 使用不同的数据库、Redis、bucket、AUTH_SECRET、管理员令牌和冒烟令牌。`APP_VERSION` 设置为部署提交 SHA。

## R2 CORS

Bucket 默认保持私有。只有确实改为浏览器直传时才允许生产站点 origin，并限制为所需方法、`Content-Type` 头和短期缓存；当前上传由 Web 服务端代理，不需要开放通配符 CORS。

## 预算与告警

- quick：12 次搜索、80,000 Token、¥5、5 分钟；
- deep：30 次搜索、200,000 Token、¥15、15 分钟，并需要显式权限；
- Redis 使用 `noeviction`，避免 BullMQ 键被静默淘汰；
- 对 HTTP 5xx、Worker failed、队列积压、预算拒绝和每日成本设置告警；
- 管理员用量接口只允许受控运维调用，不连接到公开页面。

## Vercel 可选方案

`deploy/vercel.json` 只描述可选 Web 部署。BullMQ Worker 仍必须部署在常驻计算平台。SSE 会占用 Function 持续时间，因此作品集默认采用 Railway 全栈拓扑，避免 Serverless 时长和跨平台私网配置增加不必要复杂度。
