---
id: engineering.build
title: 构建与打包
summary: Vite 前端构建、生成嵌入模块、bun --compile 跨平台可执行文件与目标平台列表、内置插件与远程前端构建。
anchors:
  - scripts/build-cross-platform.ts
  - scripts/lib/build-materials.ts
  - scripts/lib/build-profile.ts
  - scripts/build-runtime.ts
  - scripts/generate-builtin-plugins.ts
  - scripts/build-remote-frontend.ts
  - frontend/vite.config.ts
  - frontend/vite.remote.config.ts
  - frontend/build/
  - shared/build-repository.ts
keywords:
  - bun run build
  - bun run build:remote
  - build:cross
  - build:runtime
  - bun build --compile
  - vite build
  - embedded-frontend.ts
  - embedded-migrations-data
  - build-info.ts
  - embedded-changelog.ts
  - embedded-licenses.ts
  - embedded-builtin-plugins
  - generate-builtin-plugins
  - PLATFORMS
  - --platform
  - --skip-frontend
  - resolveBuildProfile
  - diagnostic
  - vite.remote.config.ts
  - remote-boundaries.ts
  - COMPILED_WORKER_ENTRIES
  - __NARRAFORK_BUILD_REPOSITORY__
  - BUILD_GITHUB_REPOSITORY
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 构建与打包

发布物是 `bun build --compile` 产出的单文件可执行程序，里面内嵌前端、迁移、更新日志、许可证清单和内置插件；所以这些东西都要先被“生成成 TS 模块”再编译。

## 关键规则
- `bun run build`：删除旧的 `server/generated/embedded-frontend.ts`，用 `frontend/vite.config.ts` 构建前端到 `dist/frontend/`，再跑 `scripts/generate-builtin-plugins.ts`（把内置插件包文本嵌入生成模块；编译后的二进制没有源码目录，只能靠内联）。Vite 同时生成路由树（`routeTree.gen.ts`）并通过 `vite-plugin-pwa` 的 injectManifest 构建 `src-sw.ts`。
- `scripts/lib/build-materials.ts:collectBuildModules` 在 `server/generated/` 下生成：`embedded-frontend.ts`、`embedded-migrations-data.ts`、`embedded-postgres-migrations-data.ts`、`build-info.ts`、`embedded-changelog.ts`、`embedded-licenses.ts`、`embedded-builtin-plugins.ts`。有上限：前端资产 ≤20000 个文件、单文件 ≤64MB、总计 ≤512MB。许可证清单有 error 级问题时直接抛错中断构建（见[第三方许可](licenses.md)）。
- `scripts/build-cross-platform.ts`：先构建前端（`--skip-frontend` 跳过）、下载 `@parcel/watcher` 各平台原生件、生成上述模块，再对每个目标**串行**执行 `bun build ./server/index.ts --target <bun-target> --outfile dist/narrafork-<版本>-<平台>`（因为共享的 `build-info.ts` 要逐平台写入 `platform`）；编译后每个平台在独立 worker 线程里做后处理（`post-process-worker.ts`：签名、SHA-512、zstd 补丁、`latest.yml` 元数据）。worker 入口随 `compiledWorkerBuildEntrypoints()` 一起传给编译器。
- 目标平台表（`PLATFORMS`）：darwin-arm64、darwin-x64、linux-x64、linux-x64-baseline、linux-arm64、win-x64、win-x64-baseline、win-arm64；`--platform=` 可选其一。`platformId` 须与 `update-service.ts:getPlatform()` 的返回值一致。macOS 目标在 `--release-ci` 下要求原生 macOS 运行器；Windows 目标加 `--windows-hide-console`。
- 构建档位（`scripts/lib/build-profile.ts:resolveBuildProfile`）：默认 `release`（`--minify`）；只有版本号是 `x.y.z-alpha…` 预发布版本，且 `CI`、`GITHUB_ACTIONS`、`NF_BUILD_RELEASE_CONTEXT` 都未启用时才用 `diagnostic`（`--keep-names --sourcemap --minify-syntax --minify-whitespace`）。
- `shared/build-repository.ts:BUILD_GITHUB_REPOSITORY` 是编译期注入的仓库标识（`--define=__NARRAFORK_BUILD_REPOSITORY__`），更新源默认值和 helper 分发都读它；来源优先级由 `scripts/lib/build-repository.ts` 决定（测试称：显式 > 受信 CI > 源码 origin > 官方归档兼容）。
- `bun run build:runtime`（`scripts/build-runtime.ts`）只构建本地冻结运行时给 `bun run start` 用，不启动应用、不迁移数据库、不复用旧产物；`--frontend` 要求 `dist/frontend/index.html` 已存在。
- 远程访问前端是另一套构建：`frontend/vite.remote.config.ts`（输出 `dist/frontend-remote`，不含原生配置、路由插件、PWA 和插件宿主），`bun run build:remote` 用 `scripts/build-remote-frontend.ts` 产出带清单的 artifact；`frontend/build/remote-boundaries.ts` 规定哪些模块在远程构建中被替换。

## 从哪读起
- `package.json:scripts` 里 `build*` 条目。
- `scripts/build-cross-platform.ts`：主流程，按 Step 注释读。
- `scripts/lib/build-materials.ts`：嵌入模块清单。
- `frontend/vite.config.ts`：前端构建、PWA、自定义插件。

## 改它时
- 新增一个会被 `new Worker(...)` / 子进程启动的文件：必须登记到 `server/lib/compiled-worker.ts:COMPILED_WORKER_ENTRIES`（`build-cross-platform.ts` 与 `scripts/lib/runtime-compiler.ts` 都展开 `compiledWorkerBuildEntrypoints()`，不要在构建脚本里手写路径）；`server/lib/compiled-worker.guard.test.ts` 断言入口唯一、文件存在、数量是 22，改数量要同步改测试。
- 新增需要内嵌进二进制的资源：在 `scripts/lib/build-materials.ts:collectBuildModules` 加一个生成模块，注意上面的文件数/体积上限；`server/generated/` 是生成物（Biome 忽略）。
- 新增发布目标平台：`PLATFORMS` 的 `platformId` 必须与 `update-service.ts:getPlatform()` 一致，平台 id 还出现在 `scripts/lib/ci-release-types.ts`、`scripts/lib/github-release.ts`、`scripts/lib/stable-baseline-patch.ts` 和 `tests/scripts/ci-build-native.test.ts`、`github-release.test.ts`、`release-ci-smoke.test.ts` 等，要一起核对。
- 改构建档位判定要动 `scripts/lib/build-profile.ts`，测试 `tests/scripts/build-profile.test.ts`、`build-alpha.test.ts`；`shared/build-repository.ts` 是编译期常量（`--define=__NARRAFORK_BUILD_REPOSITORY__`），只来自构建脚本，运行时代码不得读环境或用户仓库推断（`tests/scripts/build-repository.test.ts`）。
- 远程访问前端：新增被远程构建替换的模块，登记到 `frontend/build/remote-boundaries.ts:REMOTE_MODULE_REPLACEMENTS`（按解析后的源文件身份替换）；没有专门守卫测试，改完要实际跑 `bun run build:remote`（制品校验见 `tests/scripts/remote-frontend-artifact.test.ts`）。

## 相关
- [发布与更新](release.md)
- [第三方许可](licenses.md)
- [前端](../frontend/index.md)
