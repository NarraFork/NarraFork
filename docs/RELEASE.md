# 发布与更新服务器

## Changelog 与发布工作流

项目使用 `changelogs/` 目录持久化每个版本的双语更新日志，构建时嵌入二进制。

1. **生成 Changelog：** 使用 `/release` 技能（或手动创建），输出到 `changelogs/v{version}.json`：
   ```json
   {
     "version": "0.2.0",
     "date": "2026-04-01",
     "en": "## New Features\n\n- ...",
     "zh-CN": "## 新功能\n\n- ..."
   }
   ```
2. **发布新版本：** `bun scripts/release.ts <version>` — 自动从 `changelogs/v{version}.json` 读取 changelog（也可 `--changelog=<file>` 手动指定），执行版本 bump → release commit → 跨平台编译 → git tag → 上传。**发布脚本默认目标仍是旧更新服务器**，GitHub 必须显式使用 `--target=github`，详见下方。
3. **构建嵌入：** `scripts/build-cross-platform.ts` 会扫描 `changelogs/*.json` 生成 `server/generated/embedded-changelog.ts`，编译二进制后无需文件系统即可读取。
4. **运行时读取：** `server/lib/changelog.ts` 双模式 — 开发时读文件系统，编译二进制读嵌入数据。API 端点 `GET /api/changelog`（公开，无需认证）。
5. **前端查看：** 设置页 About 区域有「查看更新日志」链接，跳转到 `/changelog` 页面（Timeline 组件，按版本倒序，根据语言切换内容）。

## GitHub 主程序发布与旧更新服务器桥接

- **客户端默认来源是 GitHub**（仓库 `NarraFork/NarraFork`，须由仓库所有者在上线前公开）；设置页可二选一使用 GitHub Release 或自部署更新服务器，不自动跨源回退。**发布脚本默认仍是 `update-server`**，不因客户端默认来源改变而自动切换。
- **旧配置迁移**：已有显式来源优先；旧自定义服务器地址或非默认 product 保留 `update-server`；未配置、空地址或原内置官方地址且默认 product 迁移为 GitHub。切换来源保留另一种来源的配置，检查使用已保存配置。rg/zstd/executor 仍读取保留的工具服务器地址。
- **检测与下载**：stable 排除 draft/prerelease，beta 同时考虑 stable 与 prerelease，按语义版本排序；精确匹配平台（包括 x64-baseline），校验 sidecar 中的 SHA512 和大小。检测失败、限流、无 Release 和平台缺失不会显示为“已经最新”；元数据单请求 10 秒、检测总预算 30 秒，最多 5 页，每页 100 条。完整二进制流式下载最大 1 GiB、最长 15 分钟，可取消；下载前重新检查可信元数据，源/仓库或版本改变要求重新检测。
- `--target=github|update-server` 选择发布目标；GitHub 仓库可用 `--github-repository=owner/repo` 覆盖，默认 `NarraFork/NarraFork`。GitHub 认证使用已登录的 `gh` / `GH_TOKEN`；GitHub 路径不会读取旧更新服务器令牌或查询其基线。
- **真实发布只能在主仓库工作区原地执行**，不能使用隔离 worktree。GitHub 路径额外检查这一点；本工作区只能开发代码和做模拟测试，不得真实发布。
- GitHub 使用**完整主程序二进制 + 可选 zstd patch 对**；缺少 patch 时仍可发布并全量升级。旧更新服务器继续支持原有增量升级。helper / executor 仍走原有分发，不迁移到主程序 GitHub Release。
- 每个选定平台必须有 `dist/narrafork-<version>-<suffix>`（Windows 带 `.exe`）、同名 `.metadata.json`，以及版本化 `narrafork-<version>-SHA256SUMS`、`narrafork-<version>-checksums.txt`。缺少任何必需文件、size/hash 不一致、版本/平台/target/commit provenance 不符都会失败。sha256 为十六进制，sha512 为 base64，与构建的 binary-metadata schema 一致。
- 上传前读取并验证原 `dist/`；只上传 `--platform` 选定的平台及其 patch 对（未指定则要求全部平台）。过滤后的聚合 checksum 只在独占临时 staging 生成，**不修改原构建产物**；上传使用校验后的 staging 快照。完整二进制最大 1 GiB、patch 最大 512 MiB、文本最大 1 MiB（binary/patch sidecar 各 64 KiB），哈希流式计算；每次发布最多 64 对 patch、200 个资产，目录扫描最多 4096 项。单次 `gh` 调用超时 5 分钟、stdout/stderr 各最多 1 MiB。
- GitHub 的 `v<version>` tag 必须已存在，且解析出的 commit 与本地 tag 一致（支持 annotated tag）；脚本不会自动 push，也不会从 GitHub 默认分支偷偷创建 tag。仍保留 bump → build → tag 的原顺序；初次本地构建/tag 后若缺远端 tag，脚本安全失败，显式 push 后用 `--upload-only` 重试。
- 发布顺序为 **create draft → upload → 验证完整资产集合及 hash → 最后 publish**。失败保留 draft；重试可复用完全一致的已有资产，绝不 `--clobber`。已公开版本只有 tag/commit、通道、双语 changelog 和全部必需资产一致时才视作成功，不能替换或补传公开版本。tag 查询未找到时，通过认证后的 Release 列表寻找 draft，再按 ID 读取；最多扫描 10 页、每页 100 条，无法完整排除既有 draft 时安全失败，不盲目创建。
- 版本严格匹配 `x.y.0` 时为 stable，其他版本为 beta；beta 映射为 GitHub prerelease，不标记 latest。双语 changelog 写入 Release body。
- `--dry-run` 不进行任何 GitHub 调用；仍构建并验证本地产物，不 commit/tag/upload/publish。可加 `--upload-only --dry-run` 只验证已有构建。

公开仓库应**先发布 GitHub，再桥接旧更新服务器**，确保新客户端默认来源有版本可用。示例（版本、平台按实际替换）：

```bash
# 主仓库中准备好版本提交、构建和本地 tag；仅显式推送已经核对的 tag
# 如果先运行完整 --target=github 流程，它在远端 tag 缺失时会安全失败
# 请核对远端仓库及 commit 已可在公开仓库访问，再推送

git push origin v0.6.0
bun scripts/release.ts 0.6.0 --target=github --upload-only

# GitHub 确认已公开后，用同一 dist/ 桥接旧客户端（无需再次 bump/build/tag）
bun scripts/release.ts 0.6.0 --target=update-server --upload-only

# 仅发布/验证一个平台；对同一版本所有重试保持相同平台集合
bun scripts/release.ts 0.6.1 --target=github --platform=windows-x64
bun scripts/release.ts 0.6.1 --target=github --platform=windows-x64 --upload-only --dry-run
```

## GitHub / 未来 CI 的增量资产约定

客户端不依赖发布方式：本地 CLI 或未来 GitHub CI 只需发布相同的资产集合，无需旧更新服务器参与。启用 CI 后可不再运行本地发布脚本；本文约定资产格式与验收，不要求现在新增 workflow。

- 保留每个平台完整二进制、`.metadata.json` 和两份版本化聚合 checksum；仅有 patch 而没有 full 不构成可用 Release。
- 紧邻基线 patch 为 `<binary>.zstd-patch` + `<binary>.zstd-patch.meta.json`；其他基线直达 patch 为 `<binary>.from-<fromVersion>.zstd-patch` + 同名 `.meta.json`。`<binary>` 含目标版本与精确平台后缀（Windows 保留 `.exe`）；同一目标可上传多个源版本，不覆盖已有命名。
- patch metadata 必须包含 `fromVersion`、`toVersion`、`oldFileSize`、`oldFileSha512`、`newFileSize`、`newFileSha512`、`stableEnd`、`newTailSize`、`patchSize`；`mode` 可为 `patch-from` 或 `dictionary`。SHA512 为 base64；源版本必须早于目标，命名源版本提示必须匹配，目标版本与 Release 一致，目标 size/SHA512 与该平台 full sidecar 一致。`stableEnd` 不超过源/目标大小，`newTailSize = newFileSize - stableEnd`。
- 发布器验证 patch 实际大小，流式计算 SHA256，并比对原文件与 staging 快照及上传后的远端身份；不要求 patch metadata 新增独立 hash 字段。客户端用本机源二进制 size/SHA512 核对基线，并在每步重建后校验目标 size/SHA512。
- 缺少所有 patch 是合法的 full-only 发布；选定平台出现孤立 patch/meta、无效 JSON、非法版本/尺寸或身份不匹配则拒绝发布，不静默忽略损坏资产。未选平台 patch 不校验、不上传。`dist/` 中如存在源基线二进制，必须匹配 metadata 的旧 size/SHA512；缺少源文件不阻断，发布器不读取旧服务器配置或联网寻找基线。CLI 的本地构建输入不足时可只产出 full，或由 CI 准备可验证的 patch 对。
- **CI 基线必须取自此前已发布的原始平台二进制**，先与该 Release 的 sidecar 核对 size/SHA512，再生成 patch。不要重编旧 tag 充当基线：编译时间和构建环境可能改变二进制字节，即使版本相同也不保证 SHA512 一致；客户端基础文件 hash 不匹配时会回退 full，无法实际使用这份 patch。
- 大包建议 CI 安装 zstd，生成 `mode: "patch-from"`；GitHub 客户端仅使用本地或已缓存的 zstd CLI，不为此从旧工具服务器下载 CLI。没有可用 CLI 时直接走同 GitHub full fallback。兼容 `dictionary`（包括旧格式缺省 mode）的客户端内存解码仅接受源文件、目标文件和 patch **各不超过 8 MiB**，超过限制回退 full；此兼容模式不适合主程序大二进制。
- CI 也应保持 **draft 上传 → 校验全部资产 → 最后公开**；重试复用匹配的资产、不 clobber，公开版本不覆盖或补传。需要补充资产时发布新版本，而非修改已公开版本。

**客户端选择与回退：** 优先探测当前版本直达目标的 patch，再从可用的直达包和补丁链中选择总 patch 字节数最少、且比 full 更小的路径；字节数相同时优先更少步骤（最多 16 步、最多读取 32 份 patch metadata）。即使存在直达包，链更省流量时仍可选择链。stable 的最终目标仍只选 stable，但链可经过已公开的 beta Release；所有节点必须属于同一 GitHub 仓库和同一精确平台。无可用链、基线不匹配、patch 下载/解码/校验失败时，回退到**同一 GitHub 目标 Release 的 full 二进制**，最终仍校验 SHA512，不回退到旧更新服务器。用户取消立即终止，不触发 full fallback。

## 正式版（stable）直达增量包（旧更新服务器）

以下自动补包逻辑仅属于 `--target=update-server`；GitHub 发布器只上传本地已准备的 patch 对，不向旧服务器寻找基线。GitHub stable 直达包可由构建或未来 CI 按上述 `.from-<version>` 约定生成。

构建只会生成「紧邻上一个版本 → 当前版本」这一条 patch，这对逐版本跟进的 beta 用户是对的，但正式版用户只跟 stable，中间隔着一堆 beta 版本时会被迫连续应用多个 patch。因此**一个版本成为正式版时，额外生成并上传「上一个正式版 → 该版本」的直达 patch**：

- **以 stable 身份发布**（版本号形如 `x.y.0`）：`bun scripts/release.ts <version>` 上传完成后自动补齐。
- **beta 晋升为 stable**：仓库没有 `scripts/promote-release.ts`；不能依赖不存在的命令。旧更新服务器若通过管理界面调整 channel，需另外补齐并验证直达 patch。GitHub 客户端以 Release 的 `prerelease` 状态判定通道，可由发布者显式执行 `gh release edit v<version> --prerelease=false --latest` 晋升，不改变 tag 或二进制；晋升后不能再按原 beta 发布身份幂等重试。
- 实现位于 `scripts/lib/stable-baseline-patch.ts`（基线选择为纯函数，便于测试），patch 生成走 `generateZstdPatchToFile`（文件到文件，不把 ~140MB 二进制读进 JS 堆）。
- 直达包**追加**存储为 `.from-<version>.zstd-patch`，不会覆盖已有的 patch，原有升级路径保持可用。
- 上传前校验本地目标二进制与基线二进制的 size+sha512 必须与服务器已发布的完全一致，避免用被改动过的本地文件生成 patch。
- 补包失败或缺少本地二进制时**只告警不中断**（多步 patch chain 仍然可用）；要跳过这一步用 `--skip-stable-patch`。
- 前提：`dist/` 里需要有上一个正式版和当前版本**两个平台二进制**，且与线上发布版本字节一致。

## 发布目标服务器（生产 vs 个人测试）

- **旧客户端桥接（生产）：** `bun scripts/release.ts <version>` 默认仍读取 `~/.narrafork/update-server.json`，上传到生产更新服务器 `https://narrafork-update.b.domexie.cn`，等价于显式 `--target=update-server`。原默认生产路径保留，**不要改动**；新版客户端默认来源的版本需要先显式发布到 GitHub。
- **个人测试发布：** 用于只给自己测试的版本，走独立的测试更新服务器，不影响生产。发布时通过环境变量覆盖服务器地址和令牌：
  ```bash
  # 令牌明文存于 ~/.narrafork/update-server-test.json（权限 600，不提交仓库）
  NF_UPDATE_SERVER=https://nfupdatetest.domexie.cn \
  NF_UPDATE_TOKEN=$(bun -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.HOME+"/.narrafork/update-server-test.json","utf8")).token)') \
  bun scripts/release.ts <version> --platform=windows-x64
  ```
  说明：`--platform=windows-x64` 按需选择平台；`--dry-run` 只构建不上传；`--upload-only` 复用现有 `dist/` 只上传。
- **客户端测试：** 在设置页把「更新来源」选为「自部署更新服务器」，服务器地址填 `https://nfupdatetest.domexie.cn`，通道选 `beta`（个人测试版本通常发到 beta 通道），保存后再检查。测试完成后恢复原来源与服务器地址；默认来源是 GitHub。

## 个人测试更新服务器（常驻服务）

测试更新服务器由 systemd 常驻托管，避免进程被关导致域名 502（历史上用后台任务跑会因超时被杀）。

- **域名：** `https://nfupdatetest.domexie.cn`（宝塔 nginx/openresty 反代到 `127.0.0.1:17780`，vhost 配置 `/www/server/panel/vhost/nginx/nfupdatetest.domexie.cn.conf`，复用 `*.domexie.cn` 泛域名证书）
- **systemd 服务名：** `narrafork-update-test`（系统单元 `/etc/systemd/system/narrafork-update-test.service`，`User=fulcrum`、`Restart=always`、开机自启）
  ```bash
  systemctl status narrafork-update-test      # 查看状态
  sudo systemctl restart narrafork-update-test # 改了数据/配置后重启（release-cache 是内存缓存，需重启重载 meta.json）
  journalctl -u narrafork-update-test -n 50    # 或看 ~/.narrafork/update-test/service.log
  ```
- **数据目录：** `~/.narrafork/update-test/`（`config.json` + `data/products/narrafork/releases/<version>/...`），持久化，不放 `/tmp`
- **令牌：** 测试服务器专用上传令牌明文存于 `~/.narrafork/update-server-test.json`（权限 600，**不提交仓库**）；`config.json` 内只存 sha256 哈希
- **注意：** 该测试服务器与本机（`127.0.0.1:17780`）绑定；直接修改 `data/` 下的 `meta.json` 后必须 `systemctl restart narrafork-update-test` 才会生效（内存缓存）。
