# 第三方开源协议页面（`/licenses`）

## 项目自身的许可证与 CLA

NarraFork 的项目原创源代码和配套材料（除另有明确许可声明外）采用 **Mozilla Public License 2.0（`MPL-2.0`）**，标准正文见 [LICENSE](../LICENSE)。根目录包和 VS Code 扩展的包元数据均声明 `MPL-2.0`。

贡献者许可协议见 [CLA.md](../CLA.md)。接收贡献前需核验贡献者的明确签署及实际权利人授权；CLA 允许将其覆盖的贡献在未来改用 MIT、Apache-2.0、BSD-3-Clause 等宽松开源许可证，但不转让版权，也不授予任意专有再许可权。签署步骤、法人授权及历史贡献补签规则均在 CLA 中说明，不能用普通 PR 提交或 `Signed-off-by` 替代。

第三方依赖、运行时、二进制、复制或 vendored 的代码仍按各自许可证分发，本项目的许可证和 CLA 不覆盖或变更其权利。本页以下内容及 `/licenses` 页面仍用于第三方许可披露。未来如整体变更许可证，必须逐项核验贡献和第三方材料的授权，不能仅修改包元数据或 `LICENSE` 文件。

## GitHub 辅助 Release 披露

`helpers-v<catalog>` 和 `executor-v<version>` 是独立分发产物，也必须携带真实许可正文。辅助 manifest 记录许可文件名称、size 和 SHA256，publisher 核对必需附件及远端资产完整集合；只上传裸可执行文件不能算完整发布。rg/PCRE2、zstd、musl、LLVM compiler-rt/MinGW，以及 executor 的 Go 标准库/模块沿用 `licenses/extra/` 已有正文及选定许可分支。`entries.json` 的分发方式同步标记 GitHub 辅助 Release与旧 tools 兼容路径，不另写或改写第三方许可正文。

Linux GCC 构建另保守披露运行库与启动代码；`gcc-runtime.txt` 由固定 GCC 14.2.0 上游 commit 的 COPYING3 与 COPYING.RUNTIME 逐字材料组成，附在 helpers Release 并以 size/SHA256 校验，不改 zstd 原有 BSD 分支。许可原文不凭记忆重写。

新 helper 平台或构建 recipe 引入额外静态链接组件时，仍须补登记和真实许可材料，不能认为共享主程序 `/licenses` 页面已经覆盖独立下载资产。

## 第三方披露范围与实现

页面覆盖**所有随发布产物分发的第三方组件**（当前约 1280 条），而非仅 `package.json` 里的直接依赖。分组依据是"是否随产物分发"，不是 `dependencies` / `devDependencies` 的位置：

- **`bundled`** — 不在 `node_modules` 里、但被编译进发布产物的组件。**由人工在 `licenses/extra/entries.json` 声明**，协议全文放同目录 `.txt`。完整清单以该文件为准；主要包括：Bun 运行时（含其静态链接的 JavaScriptCore，**LGPL-2**，附带 relink 说明）、`vendor/zstd` 静态二进制（**BSD-3-Clause OR GPL-2.0，已选定 BSD-3**）、静态链接的 musl libc、Go 标准库 + `remote-executor/go.mod` 的模块、`@parcel/watcher` 的 8 个平台原生 `.node`（由 `scripts/download-parcel-watcher.ts` 直接从 npm 下载，**绕过 node_modules，扫描器看不到**），以及 ripgrep、PCRE2、LLVM compiler-rt、MinGW-w64 runtime、purego 等。
- **`runtime`** — 从 `dependencies` 递归可达的包（含 `optionalDependencies`），全部随二进制分发。
- **`development`** — 仅 `devDependencies` 可达，不分发，列出以求完整。

**⚠️ 新增非 npm 二进制依赖时必须在 `licenses/extra/entries.json` 登记**，否则页面不会提及它，构成 attribution 缺口。

实现要点：

1. **扫描器** `server/lib/licenses/scan.ts` — 递归依赖树 + `readdir` 正则匹配协议文件（`/^(licen[cs]e|copying)([._-].*)?$/i`，比固定候选名多命中 23 个包）+ NOTICE 单独采集（Apache-2.0 §4(d)）+ 按 sha256 去重全文（去重后约一半）。
2. **双许可选定** `server/lib/licenses/dual-license.ts` — `"A OR B"` 必须人工声明采用哪个分支并写明理由；**未声明的 disjunction 会报 error 阻断构建**，不会静默显示原始 `"A OR B"`（那看起来像答案，却隐藏了没人做过选择的事实，MPL 分支还带源码披露义务）。同文件还有 `khroma` 这类"无 license 字段"的人工 override。
3. **缺协议原文回落** `server/lib/licenses/spdx-templates.ts` — 约 40 个包声明了 SPDX 但没随包提供协议文件（monorepo 只在仓库根放一份）。回落到标准协议全文，条目标 `textSource: "spdx-template"`，**UI 明确提示"这是标准文本，不是该包自行提供的措辞"并给出上游链接**。所有模板均从 `node_modules` 中已安装的规范副本逐字复制（模板注释里标注了来源包），有测试逐字对比；**禁止凭记忆手写或改写协议文本**。
4. **构建嵌入** `scripts/build-cross-platform.ts` Step 5c → `server/generated/embedded-licenses.ts`。**`problems` 中有 `error` 级会 `exit(1)` 阻断构建**（取代旧实现的静默 `catch {}`，正是它让 785 个包无声消失）。嵌入内容以 JSON 字符串 + `JSON.parse` 形式生成，与 `embedded-migrations-data.ts` 同理：上千条对象字面量会让 TS 推断出过复杂 union 而报 TS2590。
5. **运行时读取** `server/lib/licenses/manifest.ts` 双模式 — 开发扫 `node_modules`（约 130ms，进程内缓存），二进制读嵌入数据。API：`GET /api/licenses`（摘要，**不含全文**）+ `GET /api/licenses/text/:id`（按内容哈希取单份全文）。两者均公开无需认证，因为 attribution 必须对软件接收者可得，且 `/licenses` 从登录页可直达。
6. **前端** `frontend/routes/licenses.tsx` — 运行时加载，展开行才拉取对应全文。改造前是构建期把 1.7MB 全文内联进 bundle（`__LICENSE_DATA__`），现在 licenses chunk 仅 7.6KB。
