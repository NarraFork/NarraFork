---
id: engineering.licenses
title: 第三方许可
summary: 许可证清单如何由 node_modules 与 licenses/extra 手工声明合成、构建时的阻断规则、/licenses 页。
anchors:
  - licenses/extra/entries.json
  - server/lib/licenses/
  - server/routes/licenses.ts
  - server/lib/licenses/__tests__/manifest-extra.test.ts
  - scripts/lib/build-materials.ts
  - frontend/routes/licenses.tsx
  - frontend/hooks/use-licenses.ts
keywords:
  - 第三方许可
  - 开源许可
  - 许可证
  - /licenses
  - /api/licenses
  - licenses/extra
  - entries.json
  - embedded-licenses.ts
  - buildLicenseManifestFromDisk
  - renderLicenses
  - bundled
  - distributedVia
  - textFile
  - noticeFile
  - remote-peer-LICENSES.txt
  - bun.txt
  - useLicenses
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 第三方许可

发布的二进制里编译进了所有传递依赖和若干非 npm 组件，每个组件的版权/许可文本都要随发行物提供。仓库用一份“许可证清单”统一描述，并在 `/licenses` 页公开展示。

## 关键规则
- 清单由两部分合成（`server/lib/licenses/scan.ts`、`manifest.ts`）：`node_modules` 依赖图的递归扫描（按可达性区分 `runtime` 与 `development`），加 `licenses/extra/entries.json` 里手工声明的组件，类型为 `bundled`（Bun 运行时、zstd、ripgrep、pcre2、musl、Go 可执行器及其模块、`@parcel/watcher` 原生件、remote-peer 等）。每条 extra 声明指向 `licenses/extra/` 下的许可文本文件（`textFile`，可选 `noticeFile`），并写明 `distributedVia`。
- 新增一个会被打进发行物但不在 `node_modules` 里的组件（原生二进制、Go 模块、向量化数据等）：在 `licenses/extra/` 放逐字许可文本，并在 `entries.json` 加条目。没有自动机制发现漏声明的非 npm 组件（未核实），靠人工在引入时补。
- 构建时 `scripts/lib/build-materials.ts:renderLicenses` 调 `buildLicenseManifestFromDisk`，有 `severity: "error"` 的问题（如运行时依赖缺许可信息；`development` 依赖同类问题只算 warn）就抛错，构建失败；warn 只打印。编译产物里清单被嵌入 `server/generated/embedded-licenses.ts`（没有 `node_modules` 时从嵌入数据读），开发态则首次使用时扫描并在进程内缓存。
- 版本一致性有测试守着（`server/lib/licenses/__tests__/manifest-extra.test.ts`）：extra 条目都被加载并标记 bundled、都说明分发方式、都带可取回的许可文本；Bun 条目的 `version` 必须等于正在运行的 Bun（`versionSource: "bun-runtime"`），`bun.txt` 须与该版本许可一致；同一次版本内补丁号漂移只 warn；“当前树无阻断问题”也是一条测试。升级 Bun 时要同步更新 `entries.json` 与 `bun.txt`。
- remote-peer 的 Go 依赖升级必须同时更新 `licenses/extra/remote-peer-LICENSES.txt` 和 `entries.json` 的对应版本，否则 `remote-peer.yml` 失败（见 `.github/workflows/remote-peer-dependabot-licenses.yml` 的说明）。
- `GET /api/licenses`（`server/routes/licenses.ts`）公开（登录页链接到 `/licenses`），只返回摘要列表，许可文本按 id 单独取（`/text/:id`，id 为内容哈希），避免一次返回上 MB 的响应。

## 从哪读起
- `server/lib/licenses/types.ts`：`LicenseEntryKind`、问题严重度。
- `licenses/extra/entries.json`：手工声明的样例。
- `frontend/routes/licenses.tsx`：展示页。
- `frontend/hooks/use-licenses.ts`：`useLicenses`（摘要列表）与 `useLicenseText`（按 id 取许可文本）。

## 改它时
- 新增打进发行物但不在 `node_modules` 里的组件：`licenses/extra/` 放逐字许可文本 + `entries.json` 加条目（`textFile`、`distributedVia`，Bun 条目要 `versionSource: "bun-runtime"`）；`server/lib/licenses/__tests__/manifest-extra.test.ts` 会校验加载、分发方式、可取回文本、版本一致、「当前树无阻断问题」。
- 升级 Bun：同步 `entries.json` 的版本与 `licenses/extra/bun.txt`；升级 remote-peer 的 Go 依赖：同步 `remote-peer-LICENSES.txt` 与 `entries.json`（`.github/workflows/remote-peer.yml` 会失败）。
- 清单形状（`server/lib/licenses/types.ts`）变化要同时改前端 `frontend/hooks/use-licenses.ts` 与 `frontend/routes/licenses.tsx`；`GET /api/licenses` 保持公开且只返回摘要，许可文本留在 `/text/:id`。
- 不能破：运行时依赖缺许可信息会让构建失败（`renderLicenses`）；编译产物不依赖 `node_modules`，清单走 `embedded-licenses.ts`。

## 相关
- [构建与打包](build.md)：清单随二进制嵌入。
