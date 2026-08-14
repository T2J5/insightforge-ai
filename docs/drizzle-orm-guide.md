# Drizzle ORM 零基础入门指南

> 适用项目：InsightForge（TypeScript + PostgreSQL 16 + `postgres.js`）
> 本项目版本：`drizzle-orm ^0.45.2`、`drizzle-kit ^0.31.10`
> 阅读目标：理解 Drizzle 的角色，并能够定义表、连接数据库、完成 CRUD 和管理迁移。

## 1. Drizzle 是什么

Drizzle ORM 是面向 TypeScript 的 SQL ORM。它让你用 TypeScript 定义数据库结构、编写类型安全的查询，同时保留 SQL 的表达方式。

可以把相关组件分成三层：

| 组件                  | 作用                              | 运行时机    |
| --------------------- | --------------------------------- | ----------- |
| `drizzle-orm`         | 建立数据库客户端、执行查询        | 应用运行时  |
| 数据库驱动 `postgres` | 与 PostgreSQL 建立真实连接        | 应用运行时  |
| `drizzle-kit`         | 生成、检查、执行迁移，启动 Studio | 开发/部署时 |

最重要的心智模型：

```text
TypeScript Schema ──生成迁移──> SQL 文件 ──执行迁移──> PostgreSQL
        │                                              ▲
        └──────给查询提供类型──── drizzle-orm + driver ─┘
```

Drizzle 不隐藏 SQL。`select`、`where`、`join`、事务和索引等数据库概念依然存在，只是改用类型安全的 TypeScript API 表达。

## 2. 本项目中的位置

数据库包位于 `packages/db`：

```text
packages/db/
├── drizzle.config.ts       # Drizzle Kit 配置
├── package.json
└── src/
    ├── client.ts           # 数据库连接（建议）
    ├── schema.ts           # 表、列、约束和索引（建议）
    ├── migrations/         # SQL 迁移文件
    └── repositories/       # 业务数据访问层
```

项目已经安装：

```json
{
  "dependencies": {
    "drizzle-orm": "^0.45.2",
    "postgres": "^3.4.9"
  },
  "devDependencies": {
    "drizzle-kit": "^0.31.10"
  }
}
```

这里选择 `postgres.js` 作为驱动，因此导入路径是 `drizzle-orm/postgres-js`。不要误用 `drizzle-orm/node-postgres`，后者对应的是另一个驱动包 `pg`。

## 3. 准备本地数据库

仓库的 `docker-compose.yml` 已经定义 PostgreSQL 16（包含 pgvector）：

```bash
docker compose up -d postgres
docker compose ps
```

开发环境连接串：

```dotenv
DATABASE_URL=postgresql://insightforge:insightforge@localhost:5432/insightforge
```

不要把真实密码提交到 Git。通常提交 `.env.example`，把 `.env` 加入 `.gitignore`。

## 4. 定义 Schema

Schema 是数据库结构的 TypeScript 描述，也是 Drizzle 类型推断的来源。下面是一个适合入门的用户—文章模型。

```ts
// packages/db/src/schema.ts
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [uniqueIndex("users_email_uidx").on(table.email)],
);

export const posts = pgTable(
  "posts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    content: text("content"),
    viewCount: integer("view_count").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("posts_author_id_idx").on(table.authorId)],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
```

### 4.1 常用列修饰符

| 写法                              | 含义                        |
| --------------------------------- | --------------------------- |
| `.primaryKey()`                   | 主键                        |
| `.notNull()`                      | 禁止 `NULL`                 |
| `.default(value)`                 | 数据库默认值                |
| `.defaultNow()`                   | 默认当前时间                |
| `.defaultRandom()`                | PostgreSQL 随机 UUID 默认值 |
| `.references(() => table.column)` | 外键                        |
| `.unique()` / `uniqueIndex`       | 唯一约束/唯一索引           |

注意三个容易混淆的概念：

- TypeScript 属性名可以用 `createdAt`，数据库列名可以是 `created_at`。
- 未写 `.notNull()` 的列，其查询类型会包含 `null`。
- `$inferSelect` 表示“查出来的完整行”，`$inferInsert` 表示“插入时允许提供的数据”；有默认值的字段在插入类型中通常是可选的。

## 5. 创建数据库客户端

```ts
// packages/db/src/client.ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.js";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const queryClient = postgres(databaseUrl, {
  max: 10,
});

export const db = drizzle({ client: queryClient, schema });

export async function closeDatabase(): Promise<void> {
  await queryClient.end();
}
```

说明：

- `postgres(...)` 创建连接池；`drizzle(...)` 在其上提供类型安全查询。
- 传入 `schema` 后可以使用关系查询 API，并让 Drizzle 了解全部表。
- 长期运行的 Web/Worker 进程通常复用一个客户端，不要为每次请求重新创建连接池。
- 测试或一次性脚本结束时调用 `closeDatabase()`，否则进程可能因连接未关闭而不退出。
- 本项目是 ESM，仓库现有 TypeScript 约定可能要求相对导入写 `.js` 后缀。

## 6. CRUD：增删改查

### 6.1 Insert

```ts
const [user] = await db
  .insert(users)
  .values({
    email: "alice@example.com",
    name: "Alice",
  })
  .returning();
```

PostgreSQL 支持 `returning()`，可以直接取得插入后的行。批量插入时给 `values` 传数组。

```ts
await db.insert(users).values([
  { email: "a@example.com", name: "A" },
  { email: "b@example.com", name: "B" },
]);
```

### 6.2 Select

```ts
import { desc, eq } from "drizzle-orm";

const result = await db
  .select({
    id: users.id,
    name: users.name,
  })
  .from(users)
  .where(eq(users.email, "alice@example.com"))
  .orderBy(desc(users.createdAt))
  .limit(10);
```

不要写 JavaScript 比较表达式 `users.email === email`。查询条件要使用 `eq`、`and`、`or`、`gt`、`inArray`、`like` 等操作符。

多个条件示例：

```ts
import { and, eq, gt } from "drizzle-orm";

const result = await db
  .select()
  .from(posts)
  .where(and(eq(posts.authorId, userId), gt(posts.viewCount, 100)));
```

### 6.3 Update

```ts
const [updated] = await db
  .update(users)
  .set({ name: "Alice Chen" })
  .where(eq(users.id, userId))
  .returning();
```

`update` 如果遗漏 `where` 会更新整张表。项目代码中应格外审查没有 `where` 的更新和删除。

### 6.4 Delete

```ts
const [deleted] = await db
  .delete(posts)
  .where(eq(posts.id, postId))
  .returning({ id: posts.id });
```

### 6.5 Upsert

PostgreSQL 的 upsert 对应 `INSERT ... ON CONFLICT`：

```ts
await db
  .insert(users)
  .values({ email: "alice@example.com", name: "Alice" })
  .onConflictDoUpdate({
    target: users.email,
    set: { name: "Alice" },
  });
```

冲突目标必须有唯一约束或唯一索引，否则 PostgreSQL 无法判断冲突。

## 7. Join 与关系查询

SQL 风格的 join 最直观：

```ts
const rows = await db
  .select({
    postId: posts.id,
    title: posts.title,
    authorName: users.name,
  })
  .from(posts)
  .innerJoin(users, eq(posts.authorId, users.id));
```

外键和“应用层关系”不是同一件事：

- `.references(...)` 创建数据库外键，用于数据完整性。
- Drizzle 的关系定义用于关系查询和结果嵌套，不会自动创建外键。

刚入门时建议先熟悉 `select + join`；需要嵌套读取对象时，再学习 Drizzle Relations / Relational Queries。这样更容易看懂最终执行的 SQL。

## 8. 事务

多条操作必须“全部成功或全部失败”时使用事务：

```ts
await db.transaction(async (tx) => {
  const [post] = await tx
    .insert(posts)
    .values({ authorId: userId, title: "Drizzle 入门" })
    .returning();

  await tx
    .update(users)
    .set({ name: "活跃作者" })
    .where(eq(users.id, post.authorId));
});
```

回调抛出异常时事务回滚。事务内必须使用 `tx`，不要误用外部的 `db`，否则那条查询不属于当前事务。

本项目计划中的“保存检查点”适合在一个事务中完成；“状态转换”则适合用一条带当前状态条件的原子更新：

```ts
const [run] = await db
  .update(researchRuns)
  .set({ status: nextStatus })
  .where(
    and(eq(researchRuns.id, runId), eq(researchRuns.status, expectedStatus)),
  )
  .returning();

if (!run) {
  throw new Error("RUN_STATUS_CONFLICT");
}
```

这能避免“先查询、再更新”之间被其他进程修改的竞态条件。

## 9. Drizzle Kit 配置

本项目的 `packages/db/drizzle.config.ts` 可以配置为：

```ts
import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./src/migrations",
  dbCredentials: {
    url: databaseUrl,
  },
  strict: true,
  verbose: true,
});
```

配置路径以执行命令时 Drizzle 配置文件所在的包为背景理解。本仓库脚本位于 `packages/db/package.json`，推荐从仓库根目录这样执行：

```bash
DATABASE_URL=postgresql://insightforge:insightforge@localhost:5432/insightforge \
  pnpm --filter @insightforge/db db:generate
```

实际项目可使用 dotenv 加载环境变量；是否需要 `dotenv/config` 取决于命令运行环境是否已经注入 `DATABASE_URL`。

## 10. 迁移工作流

推荐团队项目采用可审查的 Code First 工作流：

```text
修改 schema.ts
      ↓
drizzle-kit generate
      ↓
审查生成的 SQL
      ↓
drizzle-kit migrate
      ↓
应用启动/测试
```

### 10.1 生成迁移

```bash
pnpm --filter @insightforge/db db:generate -- --name=initial
```

`generate` 比较当前 TypeScript Schema 与上一次快照，生成 SQL 和快照；它不会把 SQL 自动应用到数据库。

### 10.2 审查迁移

生成后必须打开 SQL 文件检查，重点关注：

- 是否意外删除表或列；
- 列重命名是否被误判为“删除旧列 + 新增列”；
- 新增 `NOT NULL` 列时，存量数据是否有合法默认值；
- 唯一约束和索引是否会被已有重复数据阻塞；
- 大表上的索引或列变更是否会长时间锁表。

### 10.3 执行迁移

```bash
pnpm --filter @insightforge/db db:migrate
```

`migrate` 只执行尚未执行的迁移，并在数据库中记录迁移历史。

### 10.4 检查迁移一致性

```bash
pnpm --filter @insightforge/db db:check
```

### 10.5 `push` 什么时候用

`drizzle-kit push` 会比较 Schema 与数据库，并直接应用变化，不生成可提交、可审查的 SQL 迁移文件。它适合本地原型和快速实验；多人协作及生产环境更推荐 `generate + migrate`。

## 11. 查看生成的 SQL

学习阶段建议经常查看 ORM 实际生成什么 SQL：

```ts
const query = db
  .select()
  .from(users)
  .where(eq(users.email, "alice@example.com"));

console.log(query.toSQL());
const rows = await query;
```

这有助于发现缺少索引、错误 join、一次读取过多数据等问题。Drizzle 会参数化普通值，避免手工拼接 SQL 带来的注入风险。

需要数据库原生能力时可以使用 `sql` 模板：

```ts
import { sql } from "drizzle-orm";

const result = await db
  .select({
    count: sql<number>`count(*)::int`,
  })
  .from(posts);
```

优先把动态值作为 `${value}` 插值交给 Drizzle 参数化，不要自己拼接用户输入。

## 12. 常见问题与排查

### `DATABASE_URL is required`

运行命令的进程没有读取到环境变量。先确认：

```bash
echo "$DATABASE_URL"
```

只检查是否存在即可，不要在日志或 CI 输出真实生产连接串。

### `ECONNREFUSED 127.0.0.1:5432`

PostgreSQL 没启动、端口不同或容器尚未健康：

```bash
docker compose up -d postgres
docker compose ps
docker compose logs postgres
```

### TypeScript 提示列可能为 `null`

这是 Schema 没有 `.notNull()` 的真实结果。若业务上不能为空，应同时修改 Schema 和数据库迁移，而不是只用类型断言掩盖。

### 修改 Schema 后数据库没有变化

修改 TypeScript 文件不会自动修改数据库。需要执行 `generate`，审查 SQL，再执行 `migrate`；或者仅在原型阶段使用 `push`。

### 查询返回数组而不是单个对象

Drizzle 的普通查询即使最多命中一行，结果仍通常是数组。可使用：

```ts
const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);

if (!user) {
  throw new Error("USER_NOT_FOUND");
}
```

### 迁移中重命名列导致数据丢失风险

生成迁移时明确选择重命名，并始终审查 SQL。生产迁移不要盲目接受 drop/create 操作。

### Serverless 环境出现 prepared statement 问题

`postgres.js` 默认使用 prepared statements，部分代理或特定 Serverless 环境可能不支持。此时根据部署平台要求配置 `prepare: false`：

```ts
const queryClient = postgres(databaseUrl, { prepare: false });
```

本地 Docker PostgreSQL 通常不需要这个选项。

## 13. 测试建议

数据库层至少覆盖：

1. 正常插入和读取；
2. 唯一约束与外键约束；
3. 事务失败后的回滚；
4. upsert 的新增和更新两个分支；
5. 带预期状态条件的并发更新；
6. 每个测试的数据隔离和连接关闭。

纯 mock 无法验证 SQL、约束和事务。Repository 的关键行为应在真实 PostgreSQL 测试库上跑集成测试；业务服务层可以使用 Fake Repository 获得更快的单元测试。

## 14. 推荐学习顺序

按下面顺序练习，成本最低：

1. 启动 PostgreSQL，执行 `select 1`；
2. 定义一张 `users` 表并生成首次迁移；
3. 完成 insert、select、update、delete；
4. 增加 `posts` 表、外键、索引并练习 join；
5. 练习事务和 upsert；
6. 阅读生成 SQL，并用 PostgreSQL 的 `EXPLAIN` 分析查询；
7. 最后再学习 Relations、动态查询、CTE、视图和 pgvector。

## 15. 一页速查

```ts
import { and, desc, eq, gt, sql } from "drizzle-orm";

// 新增
await db.insert(users).values(data).returning();

// 查询
await db.select().from(users).where(eq(users.id, id)).limit(1);

// 条件组合
await db
  .select()
  .from(posts)
  .where(and(eq(posts.authorId, userId), gt(posts.viewCount, 10)))
  .orderBy(desc(posts.createdAt));

// 更新
await db.update(users).set(data).where(eq(users.id, id)).returning();

// 删除
await db.delete(users).where(eq(users.id, id)).returning();

// 事务
await db.transaction(async (tx) => {
  await tx.insert(users).values(data);
});

// 原生 SQL 表达式
await db.select({ count: sql<number>`count(*)::int` }).from(users);
```

```bash
# 启动数据库
docker compose up -d postgres

# 生成、检查、执行迁移
pnpm --filter @insightforge/db db:generate
pnpm --filter @insightforge/db db:check
pnpm --filter @insightforge/db db:migrate
```

## 16. 官方资料

- [PostgreSQL 入门与驱动连接](https://orm.drizzle.team/docs/get-started-postgresql)
- [Schema 定义](https://orm.drizzle.team/docs/sql-schema-declaration)
- [查询数据](https://orm.drizzle.team/docs/select)
- [Insert](https://orm.drizzle.team/docs/insert)、[Update](https://orm.drizzle.team/docs/update)、[Delete](https://orm.drizzle.team/docs/delete)
- [事务](https://orm.drizzle.team/docs/transactions)
- [迁移基础](https://orm.drizzle.team/docs/migrations)
- [Drizzle Kit 命令概览](https://orm.drizzle.team/docs/kit-overview)
- [`generate`](https://orm.drizzle.team/docs/drizzle-kit-generate) 与 [`migrate`](https://orm.drizzle.team/docs/drizzle-kit-migrate)

---

学习 Drizzle 时，先问自己两件事：**这段 TypeScript 会生成什么 SQL？数据库靠什么约束保证数据正确？** 能回答这两个问题，就不只是“会调用 ORM”，而是真正掌握了它。
