---
id: engineering.release
title: 发布与更新
summary: scripts/release.ts 的两种目标、changelog 文件、GitHub Release 工作流、更新索引与补丁、更新服务器镜像、客户端更新源。
anchors:
  - shared/github-repository.ts
  - scripts/release.ts
  - scripts/lib/stable-baseline-patch.ts
  - scripts/mirror-update-server.ts
  - .github/workflows/release.yml
  - update-server/
  - server/services/update-service.ts
  - server/services/github-release-update.ts
  - shared/update-index.ts
  - frontend/components/UpdateBadge.tsx
  - frontend/components/UpdateModal.tsx
  - frontend/components/VersionUpdateBanner.tsx
  - frontend/hooks/use-changelogs.ts
  - frontend/hooks/useUpdateCheck.ts
  - frontend/hooks/useUpdateSchedule.ts
  - frontend/hooks/useUpdateSourcePrompt.ts
  - frontend/lib/update-source.ts
  - frontend/lib/update-state.ts
  - frontend/lib/version-match.ts
  - frontend/lib/version-refresh.ts
  - frontend/routes/changelog.tsx
  - frontend/routes/settings/about.tsx
  - server/lib/changelog.ts
  - server/lib/net/update-fetch.ts
  - server/lib/release-baseline.ts
  - server/lib/update-server-url.ts
  - server/lib/version.ts
  - server/lib/zstd-patch.ts
  - server/routes/changelog.ts
  - server/routes/update.ts
  - server/services/github-release-patch-apply.ts
  - server/services/github-release-patch-planner.ts
  - server/services/update-mirror-client.ts
  - shared/independent-update-mirror.ts
  - shared/mirror-relay.ts
  - shared/mirror-transfer-pool.ts
  - shared/release-patch.ts
  - shared/release-version.ts
  - shared/update-identity.ts
  - shared/update-index-types.ts
  - shared/update-server-child-env.ts
  - shared/update-settings.ts
  - shared/webdav-transport.ts
keywords:
  - release.ts
  - scripts/release.ts
  - 发布
  - 更新
  - 检查更新
  - 更新源
  - update-server
  - --target=github
  - --include-full
  - --preview
  - --dry-run
  - --overwrite-release
  - changelogs/
  - release.yml
  - workflow_dispatch
  - Release Gate
  - stable
  - update-index-v1.json
  - narrafork-updates
  - zstd
  - 补丁
  - /api/update
  - /api/v2/products
  - /api/v3/products
  - UPDATE_SOURCE_CHANGED
  - settings.update.source
  - settings.update.channel
  - UpdateBadge
  - UpdateModal
  - /changelog
  - embedded-changelog.ts
status: draft
verified_at: cbee4b47b5594056cb1d92a41d222b876789c0a6
---
# 发布与更新

GitHub Release 是发布的权威来源；更新服务器（`update-server/`）只镜像已经公开的 GitHub Release；客户端（`server/services/update-service.ts`）从 GitHub 或更新服务器取更新。

## 关键规则
- 发布入口是 `bun scripts/release.ts <version> [--target=github|update-server]`，版本须通过 `shared/release-version.ts:isValidReleaseVersion`（`x.y.z` 或带预发布段）。默认目标是 `update-server`：只调用 `mirror-update-server.ts:mirrorPublishedGitHubRelease` 镜像已公开的 Release（默认只传补丁与元数据，`--include-full` 才含完整二进制；`--preview` 只读核对；`--dry-run` 完全离线）。镜像模式不构建、不打 tag、不需要 `dist/`，镜像时不会自己生成补丁。
- `--target=github` 才发布：先读 `changelogs/v<version>.json`（字段 `version`、`date`、`en`、`zh-CN`），升 `package.json` 版本，提交 `release: v<version>`（提交只允许含 `package.json` 和该 changelog，工作区有别的改动直接拒绝），再 tag `v<version>`。已声明 remote-peer 的版本（`releaseSourceDeclaresRemotePeer`）不在本机构建：要求 HEAD 干净、打 tag 后用 `scripts/lib/main-release-dispatch.ts:dispatchMainRelease` 触发并等待 `.github/workflows/release.yml`；其它情形走本机 `build-cross-platform.ts` 构建后上传。已发布的 Release 身份不可变，`--overwrite-release` 已被拒绝，只能发新版本。
- `release.yml` 只能 `workflow_dispatch`（输入 `tag`、`publish`、`index_only` 等），`publish` 默认 false；作业链为 preflight → 各平台 peer 构建/冒烟/组装 → verify（调用 ci.yml 全量检查）→ 各目标 Build 与原生 Smoke → assemble → publish verified release → Release Gate；并发组 `main-program-release` 串行，不取消进行中的发布。另有一组 `restore-*` 作业用于不重建地恢复原始产物。
- changelog 在构建时被嵌入（`scripts/lib/build-materials.ts:renderChangelogs` 生成 `server/generated/embedded-changelog.ts`，缺 `version`/`date`/`en` 或解析失败的文件被静默跳过，按版本倒序）；`/changelog` 页展示它。
- 补丁：更新用 zstd 差分补丁（`server/lib/zstd-patch.ts`，`vendor/zstd`）。`scripts/lib/stable-baseline-patch.ts` 为某版本成为稳定版时，额外生成以“上一个稳定版”为基线的补丁，免得稳定通道用户重放整条 beta 链。`release.ts` 明确声明补丁只由 GitHub Release CI 生成，镜像不生成。
- 客户端更新源：`settings.update.source` 为 `github`（默认）或 `update-server`，`channel` 默认 `stable`；`update-service.ts:getCurrentUpdateSourceIdentity` 把当前来源固化成身份，下载/应用前用 `isUpdateSourceCurrent` 核对，来源中途变了就报 `UPDATE_SOURCE_CHANGED`。
- 客户端 API `/api/update/*`（`server/routes/update.ts`）：`check`、`download`、`apply` 需管理员或本机 manager 令牌（`localPeerUpdateRoutes`）；`notes`、`version`、`cleanup`、`directory`、`status`、`cancel`、`shutdown` 需登录并管理员（`version` 仅需登录）。`apply` 会先排空运行中的 Bash/子代理再重启；`shutdown` 是不等排空的对应入口。
- GitHub 源的数据面：客户端读仓库 `narrafork-updates` 分支上的 `update-index-v1.json`（上限 256KB、最多 32 个 Release，`shared/update-index-types.ts`），`github-release-patch-planner.ts` 规划补丁链（最多 16 步，`MAX_RELEASE_PATCH_STEPS`），`github-release-patch-apply.ts` 应用（总时限 15 分钟）；镜像源走 `update-mirror-client.ts`、`shared/independent-update-mirror.ts`、`mirror-relay.ts`、`webdav-transport.ts`。
- 前端：`UpdateBadge` / `UpdateModal` / `VersionUpdateBanner` 展示更新；`useUpdateSchedule` 轮询已准备更新的状态；`lib/version-match.ts` 比较前后端构建版本（前端用短哈希、发布服务端二进制用完整 40 位提交，所以基础版本相同且提交哈希互为前缀就算匹配，一方缺提交哈希时只与同样缺的匹配）；`lib/version-refresh.ts` 对同一对版本每个标签页只自动刷新一次，避免陈旧代理造成刷新循环；设置页 `routes/settings/about.tsx` 与 `useUpdateSourcePrompt` 处理更新源。
- 更新服务器（`update-server/index.ts`，Hono + Bun.serve，默认端口参数 `--port=7780`）：公开路由 `GET /api/v2/products/:product/releases/latest?channel=&platform=&version=`（`routes/check.ts`）、下载与补丁下载、`/api/v3/products` 镜像写入（`routes/mirror.ts`，需 `requireAuth` 令牌）、`/api/v2/tokens`、`/health`；存储是本地文件系统（`storage/local.ts`）。契约测试在 `tests/update-server-*.test.ts`。

- WebDAV 服务端拉取（`update-server/services/mirror-relay-pull.ts`）：作业保持单并发，作业内资产通过 `shared/mirror-transfer-pool.ts:MirrorTransferPool` 有界并发，`mirrorRelay.downloadConcurrency` 默认 8、严格接受数字整数 1–8；未启用 relay 时不解析。相同 SHA256/size 的对象只传一次，冲突大小在资产派发前拒绝；失败取消同批传输并等待清理，全部成功才提交 main/tools。runner 上传仍独立使用 `NF_MIRROR_UPLOAD_CONCURRENCY`（direct 默认 2、WebDAV 默认 3，可显式设为 8），`scripts/lib/mirror-upload-pool.ts` 保留共享池的兼容导出。

## 从哪读起
- `scripts/release.ts`：按 “Step 1…5” 注释读；CLI 参数校验在文件前 150 行。
- `.github/workflows/release.yml` 与 `tests/scripts/release-ci-*.test.ts`、`release.test.ts`：发布契约。
- `update-server/app.ts`：路由装配；`server/services/update-service.ts`：客户端。
- 前端 `frontend/components/UpdateModal.tsx`、`hooks/useUpdateCheck.ts`、`lib/update-state.ts`（协调阶段 `idle/draining/draining_background_bash/quiescing_tools/restarting`）。

## 改它时
- 改发布物格式（更新索引、补丁命名、更新身份）：`shared/update-index.ts`、`update-index-types.ts`、`release-patch.ts`、`update-identity.ts` 同时约束 `scripts/`、`server/services/github-release-*.ts`、`update-mirror-client.ts` 与 `update-server/`，要一起改；测试 `shared/update-index.test.ts`、`release-patch.test.ts`、`update-identity.test.ts`、`tests/scripts/update-index.test.ts`、`tests/update-server-*.test.ts`（生产者/消费者契约）。
- 新增目标平台或改资产命名：`github-release-update.ts:PLATFORM_SUFFIXES`、`update-service.ts:getPlatform()`、`build-cross-platform.ts:PLATFORMS` 三处 id 必须一致。
- 改发布脚本或 `release.yml` 的作业：`tests/scripts/release.test.ts`、`release-ci-*.test.ts`、`release-ci-workflow.test.ts`、`main-release-dispatch.test.ts` 会拦；补丁生成只在 GitHub Release CI，不要让镜像脚本生成补丁。
- 改客户端更新流程（下载/应用/来源切换）：`server/routes/update.ts`、`update-service.ts`、前端 `useUpdateCheck.ts` / `useUpdateSchedule.ts` / `lib/update-state.ts`；测试 `server/services/__tests__/update-*.test.ts`、`github-release-*.test.ts`、`frontend/hooks/useUpdateCheck.test.ts`、`useUpdateSchedule.test.ts`、`lib/update-state.test.ts`。
- 新增 changelog：`changelogs/v<version>.json` 必须有 `version`、`date`、`en`，缺字段的文件在构建时被静默跳过；不要靠提交说明补，发布提交只允许含 `package.json` 与该 changelog。
- 不能破：已发布 Release 身份不可变（不覆盖，只发新版）；下载/应用前核对更新来源身份，来源变了报 `UPDATE_SOURCE_CHANGED`。

## 相关
- [构建与打包](build.md)
- [测试](testing.md)
- [第三方许可](licenses.md)
