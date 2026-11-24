---
id: engineering.commands-style
title: 开发命令与代码规范
summary: package.json 里的 bun 命令、开发端口、Biome/tsgo 检查、路径别名、CI 静态检查。
anchors:
  - package.json
  - biome.json
  - tsconfig.json
  - server/dev-all.ts
  - server/lib/dev-app-url.ts
  - .github/workflows/ci.yml
keywords:
  - bun run dev
  - dev:all
  - dev:cold
  - dev:frontend
  - bun run start
  - start:dev
  - typecheck
  - bun run check
  - check:tokens
  - i18n:check
  - biome.json
  - tsgo
  - bunx
  - npx
  - 路径别名
  - @server
  - @frontend
  - @shared
  - DEV_ALL_BACKEND_PORT
  - VITE_PORT
  - 7778
  - 41221
  - static-checks
status: draft
verified_at: 2e6441ad0
---
# 开发命令与代码规范

所有脚本都通过 `bun run`/`bunx` 执行（`packageManager` 为 bun 1.4.3，CI 用同一版本）。

## 关键规则
- 开发：`bun run dev:all`（`server/dev-all.ts`）同时起后端和 Vite；后端固定端口 7778（`server/lib/dev-app-url.ts:DEV_ALL_BACKEND_PORT`），Vite 默认 41221（`DEFAULT_DEV_FRONTEND_PORT`，可用 `VITE_PORT` 改），打开的是 Vite 地址。`dev:cold` 不带 `--hot`。
- 单独起：`bun run dev`（迁移 + `PORT=7778 bun run --hot server/index.ts`）、`bun run dev:frontend`（Vite）。`bun run start` = `dev-all.ts --production`（用冻结的本地运行时），`start:dev` 在此基础上加 `--frontend-dev`（后端源码 + Vite 同时存在）。
- 检查：`bunx @biomejs/biome check .`（也可 `bun run check`）、`bunx tsgo --noEmit`（`bun run typecheck`）、`bun run check:tokens`（颜色字面量）、`bun run i18n:check`。CI 的 static-checks 跑 SQLite 迁移资产检查 + biome + check:tokens + i18n:check + `bun scripts/knowledge.ts check`（知识树检查）；类型检查在 build 作业里、前端构建之后（要先生成 `routeTree.gen.ts`）。
- Biome（`biome.json`）：recommended 规则，tab 缩进，行宽 100，开启 organizeImports；忽略 `server/generated`、`routeTree.gen.ts`、`drizzle` 与 `drizzle-postgres` 的 SQL/元数据 JSON。
- 路径别名（`tsconfig.json`）：`@server/*`、`@frontend/*`、`@shared/*`；Vite 里 `@frontend`、`@shared` 同样配置。TS 为 strict + `isolatedModules`，tsconfig 覆盖 server、frontend、shared、tests、update-server。
- 数据库迁移命令：`db:generate`（`scripts/generate-sqlite-migrations.ts`）、`db:migrate`（`server/db/migrate.ts`），PG 侧 `db:generate:pg / db:check:pg / db:baseline:pg / db:resume:pg` 都走 `scripts/postgres-migrations.ts`；CI 里 `scripts/check-sqlite-migration-assets.ts` 校验迁移资产。
- 仓库约定“用 `bunx` 不用 `npx`”：没有守卫测试，也没有脚本或 CI 检查强制，只是约定。

## 从哪读起
- `package.json:scripts`：全部入口命令。
- `server/dev-all.ts`：`--production`、`--frontend-dev`、`--cold`、`--runtime` 的组合与子进程管理。
- `.github/workflows/ci.yml`：CI 实际执行的检查顺序。

## 改它时
- 新增 package.json 脚本：想让 CI 跑它，要改 `.github/workflows/ci.yml`，并同步 `tests/scripts/ci-workflow.test.ts`（它逐步断言 static-checks 含迁移资产检查、biome、i18n:check、`bun scripts/knowledge.ts check` 且这些步骤无 `if` 条件；check:tokens 在测试里未见断言，类型检查在前端构建之后）。
- 新增颜色：前端颜色字面量只能来自 `frontend/styles/tokens.css`（第三方色板另有登记的白名单模块），否则 `bun run check:tokens`（`scripts/check-style-tokens.ts`）失败；新增文案要 `en` 与 `zh-CN` 同时加，`bun run i18n:check`（`server/scripts/check-i18n.ts`）会拦。
- 新增路径别名：`tsconfig.json`、`frontend/vite.config.ts` 都要配。
- 改开发端口：`server/lib/dev-app-url.ts` 的常量与 `package.json` 的 `dev` 脚本（`PORT=7778`）是两处独立的写法，要一起改；`tests/server/lib/dev-app-url.test.ts` 守着前者。
- 不能破：`bun run start` 跑的是冻结的本地运行时（`build-runtime.ts`），不是源码热重载；`start:dev` 才是源码后端 + Vite。

## 相关
- [测试](testing.md)
- [构建与打包](build.md)
