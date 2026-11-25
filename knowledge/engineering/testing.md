---
id: engineering.testing
title: 测试
summary: bun test 与 --isolate、全局 preload 隔离、CI 四分片、守卫测试、浏览器测试。
anchors:
  - package.json
  - bunfig.toml
  - tests/preload.ts
  - scripts/run-ci-tests.ts
  - .github/workflows/ci.yml
  - tests/scripts/ci-workflow.test.ts
  - scripts/ci-native-diagnostics.ts
  - scripts/ci-stage.ts
  - scripts/summarize-ci-tests.py
  - tests/scripts/ci-summary.test.ts
  - server/services/__tests__/run-registration-identity.test.ts
  - server/db/sqlite-dialect-inventory.guard.test.ts
  - frontend/components/narrator/spec/SpecImportBanner.test.tsx
  - frontend/components/plugins/plugin-overlay.browser.test.ts
keywords:
  - bun test
  - --isolate
  - test:fast
  - bunfig.toml
  - preload.ts
  - NARRAFORK_TEST
  - NF_TEST_CHROMIUM_PATH
  - run-ci-tests
  - test-timings.json
  - shard
  - CI Gate
  - junit
  - NF_CI_STAGE_DIR
  - ci-stage
  - GITHUB_STEP_SUMMARY
  - puppeteer-core
  - *.browser.test.ts
  - *.guard.test.ts
  - sqlite-template
  - narrafork-test-
  - HTMLElement.prototype
status: draft
verified_at: 9bba5f6cdfe1f1a3602e12806eb8129c34d61716
---
# 测试

测试用 `bun:test`，文件与源码并排（`*.test.ts(x)`），跨模块的放 `tests/`（`tests/frontend`、`tests/server`、`tests/shared`、`tests/scripts`、`tests/db`、`tests/remote-access`）。

## 关键规则
- `bun run test` = `bun test --isolate`（`package.json`）；`test:fast` 不隔离。CI 一律带 `--isolate`。`bunfig.toml` 里只有 `[test].preload = ["./tests/preload.ts"]`，隔离只能走命令行。单文件通过、混跑失败时先加 `--isolate` 复跑（`docs/TESTING.md` 称原因是共享模块级原型被测试改写；这一因果未核实，仓库内确有多处测试改 `HTMLElement.prototype`）。
- `tests/preload.ts` 在每个测试进程里：创建临时 HOME/`NARRAFORK_HOME`（`narrafork-test-*`），拒绝指向真实 `~/.narrafork`，设置 `NARRAFORK_TEST=1`，从预迁移的 SQLite 模板播种数据库（`tests/sqlite-template.ts`），并在 `beforeEach/afterEach` 里把 `settings` 单例恢复到预载快照。`tests/preload-isolation.test.ts` 校验这件事，CI 先单独跑它。
- CI（`.github/workflows/ci.yml`）：static-checks（含知识树检查 `bun scripts/knowledge.ts check`）、build（前端构建 + tsgo + 远程前端构建，产物上传）、tests 四分片（`matrix.shard: [1..4]`）、最后 CI Gate。分片入口 `bun scripts/run-ci-tests.ts --isolate --only-failures --shard=N/4 --parallel=2 --timings=… --update-timings --reporter=junit`；`run-ci-tests.ts:buildNativeTestCommand` 只接受这组固定参数；计时文件 `.github/test-timings.json` 仅作调度提示，bun 仍自行发现全部测试文件。
- 测试作业会装 zstd/podman/git/ripgrep，拉 `postgres:17-alpine` 镜像，并安装固定版本 Chrome（146.0.7680.31）到 `NF_TEST_CHROMIUM_PATH`；`tests/scripts/ci-workflow.test.ts` 本身断言工作流的权限、动作 pin、各步骤顺序。
- 浏览器测试：`*.browser.test.ts(x)` 用 `puppeteer-core` + `Bun.build` 打包 `*.browser-fixture.tsx`，在真实 Chrome 中跑（当前约 70 个，例如 `frontend/components/narrator/composer/NarratorComposer.browser.test.ts`）；Chrome 路径取 `NF_TEST_CHROMIUM_PATH`，不存在则 `beforeAll` 抛错。
- 守卫测试：用 `readFileSync` 读源码文本或枚举目录来保证“某个结构不变量”，命名多为 `*.guard.test.ts`（当前约 30 个，如 `vlist-isolation.guard.test.ts`、`zero-dom-measure.guard.test.ts`、`server/lib/compiled-worker.guard.test.ts`）。它们以字符串引用文件路径，移动/重命名被引用的源文件后类型检查与构建都不会报错，必须全仓搜索旧路径。
- 轻量 UI 的夹具要 mock 实际新出口：runtime 读取用 `api.getRuntimeSettings` 或播种 `runtimeSettingsQueryOptions().queryKey`（含当前 token 的 `settings-runtime` key），不是旧 `[settings]`；UI prefs 用 `/user-preferences/ui`/`getUIPreferences` 与 `[user-preferences, ui, userId, token]`。先建立测试 token 与 auth/me 身份再播种，typed RuntimeSettings 包括 revision、outline、requestEvidence 和三态 readiness；不要靠旧完整缓存或匿名身份让开关/授权测试假绿（Spec/outline/插件浮层夹具共用该契约）。
- absolute deadline 测试不能等一个合法地不会出现的 model pass：`run-registration-identity.test.ts` 的 200ms deadline 可能在 Worker 准备阶段已到期，deadline 分支等 terminal 后断言持久 binding 与 timedOut；只有 caller cancellation 分支才等 fake executor 开始。fake executor 等 abort 前先检查 `signal.aborted`，已发生的事件不会向迟注册 listener 重放。保持原 200ms 与测试 5 秒上限，不以延长 deadline/超时掩盖竞态。
- SQLite 方言守卫按具体源登记，而非放宽整个模块：单会话 Spec 的 JSON1 `json_extract/json_set` 已在 `sqlite-dialect-inventory.guard.test.ts` 为 `server/routes/user-preferences.ts` 精确登记 `handle/json1`。PG 的等价 JSON 点读/原位写仍待 port，不能为过测试退回拉取全部历史 layout map。
- 数据库相关测试默认走 SQLite；PG 迁移基线有专门测试（`tests/db/pg-*.test.ts`）。

## 从哪读起
- `tests/preload.ts`、`tests/sqlite-template.ts`：测试环境隔离。
- `scripts/run-ci-tests.ts`：CI 如何调用 bun test、输出/超时上限（30 分钟、64MB）。
- 分片诊断：`run-ci-tests.ts` 经 `scripts/ci-native-diagnostics.ts` 把子进程启动/退出、静默与心跳（静默 60s、心跳 120s）和进程资源采样写进 `artifacts/native-tests*-diagnostics.jsonl`（单文件 256KB 上限）；远程访问浏览器集成测试经 `scripts/ci-stage.ts` 把各阶段（Go peer 构建、Chromium、WebRTC 连接、登录等）的起止写进 `NF_CI_STAGE_DIR` 下的 `ci-stage*.jsonl`（32KB 上限）。分片失败或被取消时，`scripts/summarize-ci-tests.py` 读 JUnit（8MB 上限、拒绝 DTD）和这些 JSONL，把最多 12 条失败（标出超时）写进 GitHub 步骤摘要，不复制测试输出；这些文件随测试报告一起上传（`tests/scripts/ci-summary.test.ts`、`tests/remote-access/ci-stage.test.ts`）。
- `tests/scripts/ci-workflow.test.ts`：CI 契约。
- `docs/TESTING.md`：补充背景（仅线索，以代码为准）。

## 改它时
- 移动或改名被守卫测试用 `readFileSync` / 目录枚举引用的源文件后，必须全仓搜索旧路径字符串：类型检查和构建都不会报错，只有对应 `*.guard.test.ts` 失败。
- 改 CI 工作流（作业、权限、动作 pin、分片、Chrome 版本、步骤顺序）要同步 `tests/scripts/ci-workflow.test.ts`，它按字符串/结构断言这些；CI 的测试命令参数只允许 `run-ci-tests.ts:buildNativeTestCommand` 认的那一组，加 `--timeout`、重试或改 reporter 路径会被 `ci-workflow.test.ts` / `run-ci-tests` 相关测试拒绝。
- 改测试环境隔离（HOME、`NARRAFORK_HOME`、settings 快照恢复）动 `tests/preload.ts`，由 `tests/preload-isolation.test.ts` 校验；改库结构时测试库模板会按 `tests/sqlite-template.ts:sqliteTemplateKey` 自动失效重建。
- 新增浏览器测试：文件名 `*.browser.test.ts(x)` + `*.browser-fixture.tsx`，需要 `NF_TEST_CHROMIUM_PATH` 指向 Chrome，没有则 `beforeAll` 抛错。
- 本地只跑与改动相关的文件并带 `--isolate`，不要本地跑全量（CLAUDE.md）；全量以 CI 为准。

## 相关
- [开发命令与代码规范](commands-style.md)
- [发布与更新](release.md)：发布流程也依赖整条 CI。
