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
2. **发布新版本：** `bun scripts/release.ts <version> --target=github` — 从 `changelogs/v{version}.json` 读取 changelog（也可 `--changelog=<file>`），执行版本 bump → release commit → 跨平台编译 → git tag → GitHub 公开及 index 核验。为兼容保留的默认 `update-server` 目标已改为**镜像已公开的 GitHub 版本**，不再构建、bump、tag 或生成补丁；主程序发布须显式选择 GitHub。
3. **构建嵌入：** `scripts/build-cross-platform.ts` 会扫描 `changelogs/*.json` 生成 `server/generated/embedded-changelog.ts`，编译二进制后无需文件系统即可读取。
4. **运行时读取：** `server/lib/changelog.ts` 双模式 — 开发时读文件系统，编译二进制读嵌入数据。API 端点 `GET /api/changelog`（公开，无需认证）。
5. **前端查看：** 设置页 About 区域有「查看更新日志」链接，跳转到 `/changelog` 页面（Timeline 组件，按版本倒序，根据语言切换内容）。

## GitHub 权威发布与独立更新服务器

- **发布与客户端下载选源分开**：官方包默认发布仓库为 `NarraFork/NarraFork`；fork 采用构建时注入或明确配置的仓库，不依据运行时 cwd 偷换。选择独立更新服务器后，主程序索引、binary sidecar、说明、补丁及全量包均从该服务器获取；辅助组件（rg/zstd/executor/remote-peer）的 manifest 和程序仍从该服务器的精确 tag 端点获取。**客户端无需访问 GitHub，也不会在镜像失败时回落 GitHub**，跨 origin 重定向同样拒绝。发布/制作镜像的机器仍可使用 GitHub；不要把它变成下载主机的在线校验依赖。脚本默认 `update-server` 仍指镜像已公开产物。
- **配置与信任**：已有服务器地址保留；选择镜像表示信任管理员配置的镜像提供发布清单。repository 只作为冻结的组件命名空间做离线等值校验，不向 GitHub查询。镜像程序仍必须符合清单的精确版本、协议、文件名、大小、SHA-256和架构；哈希只证明与清单一致，不防御被选镜像本身恶意替换清单。缓存、下载中任务与票据按 mode/serverUrl/product/repository 隔离，来源变更需重新选择，不复活 unsigned 旧 tools 接口。
- **检测与下载**：stable 排除 draft/prerelease，beta 同时考虑 stable 与 prerelease，按语义版本排序；精确匹配平台（包括 x64-baseline），校验 sidecar 中的 SHA512 和大小。检测失败、限流、无 Release 和平台缺失不会显示为“已经最新”；元数据单请求 10 秒、检测总预算 30 秒，最多 5 页，每页 100 条。完整二进制流式下载最大 1 GiB、最长 15 分钟，可取消；下载前重新检查可信元数据，源/仓库或版本改变要求重新检测。
- **配置与准备包身份**：检测开始冻结 GitHub repository、metadata delivery 方式、镜像 server/product、channel/platform；下载前及写入准备记录前再次核对。变化要求重新检查，不能把旧通道/产品/仓库的结果下载成新配置的包。保存设置不删除已准备包或取消调度；历史元数据缺 repository/来源时明确未知，不用当前配置补造身份。
- **应用 API**：`GET /api/update/status` 的 `preparedIdentity.id` 绑定已验证文件及其来源；`POST /api/update/apply` 必须提交该 `preparedId`（可同时提交 `version`）。缺失或过期选择器返回 409，不再仅凭版本号选择文件。旧包仍可通过查询所得的选择器显式应用；已进入调度的准备包不能被另一次下载替换。选择器不是授权令牌，接口仍要求管理员权限。
- `--target=github|update-server` 选择发布目标；GitHub 仓库可用 `--github-repository=owner/repo` 指定，否则优先采用可信 Actions 仓库或 GitHub origin，无法推导时才回退官方仓库。Actions 中显式仓库必须与当前仓库一致；同一身份注入前后端、sidecar 和 smoke。GitHub 认证使用已登录的 `gh` / `GH_TOKEN`；GitHub 路径不会读取独立更新服务器令牌或查询其基线。
- **真实发布只能在主仓库工作区原地执行**，不能使用隔离 worktree。GitHub 路径额外检查这一点；本工作区只能开发代码和做模拟测试，不得真实发布。
- GitHub 使用**完整主程序二进制 + 可选 zstd patch 对**；没有 patch 仍可公开并全量升级。独立服务器复制当前 canonical binary/metadata/patch；镜像历史不完整时允许同镜像全量升级，不要求发布端生成额外补丁。helper/executor 使用同仓库独立辅助 Release，不混入主程序资产；历史 tools 数据保留读兼容，新客户端只通过新的 canonical 精确 tag 路由下载辅助二进制。
- 每个选定平台必须有 `dist/narrafork-<version>-<suffix>`（Windows 带 `.exe`）、同名 `.metadata.json`，以及版本化 `narrafork-<version>-SHA256SUMS`、`narrafork-<version>-checksums.txt`。缺少任何必需文件、size/hash 不一致、版本/平台/target/commit provenance 不符都会失败。sha256 为十六进制，sha512 为 base64，与构建的 binary-metadata schema 一致。
- 上传前读取并验证原 `dist/`；只上传 `--platform` 选定的平台及其 patch 对（未指定则要求全部平台）。过滤后的聚合 checksum 只在独占临时 staging 生成，**不修改原构建产物**；上传使用校验后的 staging 快照。完整二进制最大 1 GiB、patch 最大 512 MiB、文本最大 1 MiB（binary/patch sidecar 各 64 KiB），哈希流式计算；每次发布最多 64 对 patch、200 个资产，目录扫描最多 4096 项。单次 `gh` 调用超时 5 分钟、stdout/stderr 各最多 1 MiB。
- GitHub 的主程序 `v<version>` tag 必须已推送且与本地 source commit 一致（支持 annotated tag），脚本不自动 push 主 tag。声明 remote-peer 的真实本地发布会自动委托同一主 Release CI，编译/原生 smoke 和 peer 发布由 CI 完成；不把本机 dist 当成多平台原生证据。缺远端主 tag 时明确失败，操作者按原流程推送主 tag 后重试即可，**不需要单独推送或发布 peer tag**。未声明 peer 的旧版和本地预览保留既有构建路径。
- 发布顺序为 **create draft → upload → 验证完整资产集合及 hash → 最后 publish**。失败保留 draft；重试可复用完全一致的已有资产，绝不 `--clobber`。已公开版本只有 tag/commit、通道、双语 changelog 和全部必需资产一致时才视作成功，不能替换或补传公开版本。tag 查询未找到时，通过认证后的 Release 列表寻找 draft，再按 ID 读取；最多扫描 10 页、每页 100 条，无法完整排除既有 draft 时安全失败，不盲目创建。
- 版本严格匹配 `x.y.0` 时为 stable，其他版本为 beta；beta 映射为 GitHub prerelease，不标记 latest。双语 changelog 写入 Release body。
- 普通发布的 `--dry-run` 不进行任何 GitHub 调用；仍构建并验证本地产物和有界索引记录，不 commit/tag/upload/publish。可加 `--upload-only --dry-run` 只验证已有构建。`--index-only` 是独立的只读在线修复预览：读取已公开 Release，不依赖本地 dist，不 build/upload/publish；只有额外指定 `--publish-index` 才更新元数据分支，不能与 `--dry-run` 同用。

### Windows 管理器更新交接

Windows 替换程序由旧服务通过 `CreateProcessW` 直接启动，显式设置 `CREATE_BREAKAWAY_FROM_JOB`，使用独立 Unicode 环境块，不继承句柄或控制台，不再经过 `cmd /c start`。单独使用 Bun `detached: true` / `unref()` 不足以脱离服务的嵌套 Job。这让新管理器及其服务在旧管理器退出后继续运行；原生创建失败时会明确报告，不回落到会被连带结束的启动方式。本修复针对 NarraFork 自身的嵌套 Job；第三方宿主的外层 Job 仍可能保留生命周期约束，不保证脱离任意外部限制。非 Windows 继续使用 Bun detached；普通托管后端的生命周期和原有认证关闭、实例锁及恢复清单协议不变。

**首次升级限制：** 0.9.13 / 0.9.14 等仍采用旧启动逻辑的已安装版本，更新到包含本修复的版本时，发起端仍是旧代码，新管理器和服务仍可能被旧管理器连带结束。下载完成后需手动启动新版本 exe；只有运行修复版之后发起的后续更新才使用新的 breakaway 交接路径。不要把“更新包下载成功”当成新版已启动，也不要在旧服务尚未退出时强制终止它。手动启动与自动更新的会话恢复资格仍遵循各自既有协议，不保证手动启动自动消费计划更新恢复清单。

### 更新与辅助工具的网络代理

网络代理页集中管理“软件更新与辅助工具”，覆盖 GitHub 索引/REST、sidecar、说明、完整包、patch，以及 rg/zstd/executor manifest 和二进制。对应设置只有 `update.proxy`：缺省或 `mode:"default"` 继承全局，也可单独选择 `direct`、`system`、`custom`。全局默认直连；system 使用进程启动时记录的环境代理，自定义支持 HTTP(S) 代理，非法配置不会静默改成直连。更新设置页链接同一管理入口，不存在两份覆盖值。

一次检查/下载冻结传输策略，重定向每跳重新应用 NO_PROXY/loopback 豁免。代理变更后可以立即重试，不复用旧失败或 in-flight；不改来源身份或 preparedId，不删除已准备包，也不取消已调度更新。TLS 验证不能关闭，代理凭据不写入产物、票据、来源身份或诊断日志。独立更新服务器的响应体也受请求 deadline/父取消约束；检查 JSON 限 1 MiB、patch metadata 限 64 KiB，只允许同 origin 的有界重定向。

公开仓库先发布 GitHub 产物，再由独立 workflow 镜像 binary/metadata/patch/组件；镜像不参与主发布成功条件。remote-peer 随正常 NF 发布自动处理：输入未变复用，新的组件 pin 尚未公开则由同次主发布构建并发布，不另行手动发 peer。helpers/executor 保持既有版本声明与发布约束。示例（版本、平台按实际替换）：

```bash
# 主仓库中准备好版本提交、构建和本地 tag；仅显式推送已经核对的 tag
# 如果先运行完整 --target=github 流程，它在远端 tag 缺失时会安全失败
# 请核对远端仓库及 commit 已可在公开仓库访问，再推送

git push origin v0.6.0
bun scripts/release.ts 0.6.0 --target=github --upload-only

# GitHub及index确认已公开后，镜像该公开版本binary/metadata/patch
# 不需要dist、不再次bump/build/tag，也不生成兼容补丁
bun scripts/release.ts 0.6.0 --target=update-server

# 单平台仅作本地构建/只读验证，不绕过正式发布的完整原生 CI
bun scripts/release.ts 0.6.1 --target=github --platform=windows-x64 --dry-run
bun scripts/release.ts 0.6.1 --target=github --platform=windows-x64 --upload-only --dry-run
# 正常发布由主 CI 自动处理更新的 peer，无需独立 peer 命令
bun scripts/release.ts 0.6.1 --target=github --upload-only
```

## 可选 WebRTC 组件的独立分发

`remote-peer` 继续使用 Go/Pion，但不嵌入 NF 主程序、不在普通启动时下载或运行。`shared/component-versions.json` 的可选 `remotePeer` 与 NF/executor 版本独立；主构建仅生成独立 `buildRemotePeerDistribution` 元数据，未声明 pin 的历史包不能猜测 APP_VERSION 来下载组件。该可选组件不进入主程序发布的 helpers/executor 必需公开依赖集合。

- 独立 tag 为 `remote-peer-v<version>`，资产名为 `narrafork-remote-peer-<version>-<os>-<arch>[.exe]`，manifest 为 `narrafork-remote-peer-manifest.json`；发布需要完整六平台及 `remote-peer-LICENSES.txt`。Go 本地构建只写 `remote-peer/dist/`，不进入 NF 主 release 文件集合。
- 正常入口是 `.github/workflows/release.yml`：从 NF 目标提交冻结 peer pin 和生产输入指纹，输入未变则复用；新 pin 尚未公开时自动运行 Peer Build/Native smoke/Assemble。沿用主发布的一次 release Environment 审批，受保护 publisher 先创建缺失且 SHA 固定的 peer tag、发布并读回组件，再公开 NF。peer 失败不公开新的 NF；peer 已成功而 NF 失败时，重试校验复用，不覆盖资产。
- 组件版本仍正常受评审：若 Go 源码/依赖/协议/构建输入变了但沿用已公开的旧 pin，编译前要求同步更新组件版本，不能覆写旧 tag。独立 `.github/workflows/remote-peer-release.yml` 保留诊断和旧 bundle 恢复用途，不是正常发布时需要人工多跑的步骤。alpha 等组件仍是 prerelease、不标 latest。
- 本地 `release.ts --target=github` 在目标源码声明 peer 时自动 dispatch 同一主 CI 并等待明确成功，严格绑定默认分支、控制 SHA、tag、操作者和 dispatch 响应中的精确 runId（不搜索并发运行列表）；不伪造 GITHUB_*。`--platform`/自定义 `--changelog`/`--skip-build` 仅可用于本地预览或旧版路径，不将单平台请求悄悄变成完整正式发布；`--upload-only` 在此路径只保留跳过本地准备的含义，不绕过 CI 上传本机 dist。index-only、镜像和 dry-run 不补发 peer。
- 主发布恢复携带原 NF/peer 封存计划及原生证据，不用今天的 pin 重选；旧独立 peer bundle 仍通过原固定 workflow/job/receipt 验证，executor workflow/工具链/输入指纹不变。未声明 peer 的历史目标不增加该阶段。
- 后续启用通过 `ensureRemotePeerBinary` 显式获取组件。GitHub直连从其 manifest/asset 下载；镜像模式从所选 serverUrl/product 获取二者，冷缓存也不请求 GitHub。按精确命名空间/tag/version/protocol/platform 及 size/SHA-256/架构验证；镜像失败只用同来源已验证缓存或明确失败，不回落 GitHub/官方仓库。
- 同次主发布为新 peer 和 NF 保存各自 receipt；自动镜像先校验完整 receipt 集合，再分别同步，避免只镜像 NF 或互相覆盖。制作镜像的发布端可访问 GitHub，不要求下载主机具备此能力。镜像入库保留 metadata-only→binary 单调补齐与所有大小/数量限制。

代码实现本身不触发发布；操作者照常发布 NF 时会自动处理所需 peer。真实发布仍只能在主仓库工作区或其受保护 CI 进行。M2 已接入真实核心业务与普通设置页的显式安装、启停、邀请/撤权；默认关闭，普通启动/状态查询零下载、零 peer 进程。实现及隔离验收不代表已部署官方远程服务，也不代表所有 NF 功能已支持远程。

## 随正常 NF 发布的远程前端包（M2）

远程前端不是另一个人工发布流程。主 Release plan 从精确 `target.commit` 读取 `shared/remote-access/frontend-capability.json` 并冻结；仅真实缺失声明的历史目标跳过，坏 JSON、未知契约或读取错误不得当成旧版本。声明目标经同一 reusable CI 构建普通与 remote 两个目标；普通 binary 仍只嵌入普通前端。

同次 NF Release 额外发布：

- `narrafork-<version>-remote-frontend.tar.gz`
- `narrafork-<version>-remote-frontend.manifest.json`

manifest 记录真实 NF release、仓库、source SHA、内容 buildId、bootstrap/API/wire 契约、入口/CSS 和完整文件大小/摘要。manifest 位于 archive 外，不做自哈希循环。预算为 manifest 1 MiB、archive 128 MiB、解包 512 MiB、单文件 64 MiB、文件数 4096；拒绝绝对/穿越路径、重复/大小写冲突、链接、特殊文件、未声明内容和坏摘要。

CI 的 remote 产物按 run/attempt 封存；production UI 另供隔离浏览器网络边界测试。bundle 上限为 52 个文件，publisher 对 remote 两资产使用独立大小预算、私有快照与完整归档验证，缺一即失败。验证器封入可信 `control.js`，publisher 不安装依赖、不执行产物程序，也不依赖遗失的 worker 源文件。

`source_run_id` 恢复原完整 bundle；`build_run_id` 重验路径冻结并下载原 remote artifact 的 ID/digest/size/run/attempt，不以当前源码重编补包。历史无 remote 的 plan 仍合法；已经公开的 Release 不补传、不覆盖资产。

主程序 `SHA256SUMS`/`checksums.txt`、八平台 update-index v1 和主镜像 binary/metadata/patch DTO 不加入 remote 两资产；新增 extra assets 不改变主镜像投影。本轮没有增加远程前端更新服务器镜像或自动公网部署。运营者使用 [构建指南](BUILD.md) 的独立 host CLI 导入多个 immutable 版本，并显式选择引导包/禁用记录；业务模块始终按 NF hello 精确选择，不按 peer pin 或 latest。

## GitHub Release CI

`.github/workflows/release.yml` 是主程序专用入口，仅支持从当前仓库的真实默认分支手动触发（不再硬编码上游仓库或 main）。先把版本号和双语 `changelogs/v<version>.json` 提交到默认分支，再由维护者显式创建和推送 tag。CI 不修改源码分支、版本或主程序 tag；受保护 publisher 可为自动准备的 peer 创建缺失且指向冻结 source SHA 的独立组件 tag，并为生成的索引创建元数据分支提交。不改变本地发布脚本默认的独立更新服务器目标。

主入口保留 `tag`、默认 `false` 的 `publish`、可选 `source_run_id` 和 `index_only`，以及原始构建重验参数。镜像转到独立 workflow，不再接受主发布前 `prepare-bridge` / `mirror_only` / `bridge_run_id`。默认 `publish=false` 只验收、保存索引预览，不创建或公开 Release；必须明确 `publish=true` 才进入受保护发布：

```text
preflight（固定 NF tag SHA、版本、changelog、基线与 peer action/pin/输入指纹）
  → 可复用 CI（静态、build/typecheck、前后端全仓四片、CI Gate）
  → NF 八平台构建/原生 smoke；需要新 peer 时六平台 Peer Build/Native smoke/Assemble
  → 基线 patch、统一 checksum、离线 publisher 校验 → NF/peer 不可变 bundle
  → publish=true 时等待同一次 release Environment 审批
  → 再验 tag 与 bundle → 按需先发布并核验 peer → NF draft/上传/完整核验/publish
  → 原子提交 narrafork-updates 索引与 notes → 读回确认 commit/generation
```

### 平台与严格构建

Linux/Windows 三种 target（x64、x64-baseline、arm64）在 Ubuntu 24.04 交叉编译；macOS x64/arm64 在对应 macOS runner 编译并使用系统 codesign。每个平台独立 checkout。使用 `--release-ci` 构建时，Bun/commit、原生库完整性、macOS 签名、sidecar/checksum 都必须有效，并禁止隐式从旧 `dist/` 寻找 patch 基线。

原生 smoke 运行下载的原始二进制，不重编、不补签；临时 HOME/数据库、loopback 端口、`--no-auto-resume`，关闭隔离实例的 VNet/UDP，验证启动、内嵌前端、数据库、watcher 和 PTY。smoke runner 的 PATH 不应包含 dtach，否则为避免派生守护进程越出本次进程树而预检失败；本地复现可用临时 PATH 排除它，不要卸载全局工具或停止既有服务。baseline target 在现代 x64 runner 上运行成功不等于已在无 AVX2 的旧 CPU 上验证。macOS 仅 ad-hoc 签名，不包含 Developer ID/公证；Windows 不包含 Authenticode。

### 启用与发布

维护者（包括 fork 所有者）必须启用 Actions，并先创建 `release` Environment，配置 required reviewers 和仅允许真实默认分支的规则。预检不能确认保护规则时失败；workflow 不自动创建无保护环境。允许维护者自审以适配单维护者仓库。仅 publish job 获得 `contents: write`；其余 job 不持有发布写权限，publisher 不安装依赖、不执行 bundle 内程序。组织策略须允许该 job 写当前仓库；fork 的“零配置”指无需填写仓库身份，不绕过这些平台审批。元数据分支不能同时是仓库默认分支。

示例（以下命令会触发远端任务，应由维护者按实际版本明确执行）：

```bash
# 首先只构建验收
gh workflow run release.yml --ref main -f tag=v0.9.0 -F publish=false

# 使用上一步成功封存的原始 bundle 发布，run ID 替换为实际值
gh workflow run release.yml --ref main -f tag=v0.9.0 -F publish=true -f source_run_id=123456789
```

版本规则不变：`x.y.0` 为 stable，其余为 beta/prerelease；新 stable 不得把 latest 回退到更旧版本。发布作业跨版本串行，不主动取消运行中的发布；这不承诺 FIFO 队列。

### 资产与恢复

每个平台只上传 binary + sidecar，统一汇总时重验八个平台，再生成版本化 `SHA256SUMS` 和 `checksums.txt`，不会用矩阵局部 checksum 相互覆盖。首发没有基线时允许 full-only；已有基线时按精确 Release/asset ID 下载原始 binary，核对 sidecar/hash 后生成 patch 并实际重建验 hash。网络错误、限流、分页截断或损坏基线不能当作“没有基线”；patch 不小于 full 时明确省略。

bundle artifact 命名为 `release-bundle-<runId>-<runAttempt>`，保留 30 天，包含 `manifest.json` 和 `dist/`。CI manifest 记录控制 workflow SHA、目标 SHA、工具链、基线、每文件 hash/size 与八平台 smoke 结果；它不是公开 Release 的额外资产。

失败恢复请**新建一次 dispatch，传原始构建的 `source_run_id`**，不要依赖 Re-run failed jobs 混合不同 attempt 的 artifact。恢复会验证原 run 的仓库、默认分支 workflow、逐项 job 结果、精确 artifact ID/digest 和完整文件内容；源 run 的发布步骤失败不妨碍恢复已验收的 bundle。恢复不重新编译、签名、选基线或生成 checksum。artifact 过期、证据不完整或内容不一致即失败，不自动重编替代。失败 draft 保留；公开版本不可覆盖、补传或删除。

独立更新服务器的纯镜像由下节独立 workflow 启用，不再属于 GitHub 主发布或辅助发布链；executor/helper 保持独立版本。自动版本准备、自动推送与签名证书管理不在此 workflow 范围。上线报告必须区分本地测试、在线 `publish=false` 验收和真实发布，不能把模拟测试称为在线发布成功。

### 独立更新服务器：Release 完成后的纯镜像

GitHub 是二进制、补丁、通道、摘要及说明的唯一权威。主程序 GitHub Release 已公开且 update-index 已读回、Core Release Gate 成功后，独立的 `update-server-mirror.yml` 才开始镜像。辅助 Release 公开后镜像 manifest/许可等 metadata 及 manifest 声明的原始 helper/executor 二进制。镜像 workflow 有自己的受保护 `release` Environment 审批、锁、截止与结果，绝不反向依赖主发布。

- 主 publisher 不注入 `NF_UPDATE_SERVER` / `NF_UPDATE_TOKEN`，不访问服务器、不准备兼容补丁，也不等待镜像配置或成功。镜像离线、失败、取消和超时只影响 Mirror Gate，不影响已经公开的 GitHub Release、index 或 Core Gate。
- 自动镜像需要仓库变量 `NF_MIRROR_ENABLED=true`，仅接受可信 primary 发布完成 receipt；`publish=false` 的成功构建不是发布，不触发镜像。也可手动指定已公开的 `kind` 与精确 `tag`。
- 镜像配置仍在既有受保护 `release` Environment 中。`vars.NF_MIRROR_TRANSPORT` 缺省为 `direct`，沿用 `vars.NF_UPDATE_SERVER`（HTTPS 根地址）、`secrets.NF_UPDATE_TOKEN`（上传令牌）；direct 两者均空为 `SKIPPED_UNCONFIGURED`，半配置失败。只有显式 `webdav` 才使用下节中转配置，不要求或注入服务器地址/token。未知模式或非法配置明确失败，不探测、不自动切换。秘密不写命令行、artifact、receipt 或日志，不创建无保护环境、不自动批准。
- main 镜像复制当前 GitHub public Release 的原始全量二进制、metadata/patch、当前说明和已确认的 canonical index 快照，不重新编译、生成或还原补丁。全量包与 patch 均有界下载落盘、校验大小/SHA256 后流式上传，不通过 `gh api` 文本输出传输二进制。helpers/executor 镜像按原始 manifest 校验资产 ID、size/SHA256 后流式下载并上传二进制；GitHub tag/commit 与资产集合在上传前和提交前重验。
- 不读取服务器版本列表、latest、fromVersion 元数据或旧二进制；历史不存在、版本号高低、旧补丁身份不是上传门槛。无 patch 的 GitHub Release 同样镜像全量包。旧数据不扫描或删除，旧 metadata-only 提交仍可读；新主程序 snapshot v2 要求完整 binary 投影，并仅在原始资产校验完成后发布。
- GitHub snapshot 中的历史条目不等于本地镜像了历史 patch；可用资产表只声明实际写入并校验的内容。服务器保留仍与当前 canonical index 指纹一致的历史目标，供客户端查询中间版本补丁；旧提交不会因服务升级自动获得未经验证的全量包公开资格。服务器 latest 采用 canonical snapshot channel 指针，不通过历史记录的语义最大值选举。
- 新镜像 API 按运营者配置的预期 GitHub 仓库验证 snapshot、tag、平台和文件身份。主程序全量包（各 ≤1 GiB）、patch（各 ≤512 MiB）及辅助二进制真正流式计数/hash 后原子落盘，metadata 小请求分开提交，必要资产完成后才发布 snapshot/tag。生产端单批最多200个资产、8 GiB双向传输（源下载＋上传），relay 单任务原始资产最多4 GiB，服务端仍受8 GiB存储硬配额及空闲空间/并发限制；超限明确失败，不省略全量包。辅助 projection 的可选 `binaries` 只含完整 manifest 对应的描述，不内嵌字节，最多16个、各32 MiB。旧 metadata-only 提交可重新校验后单调补入二进制；旧生产者重试不删除已有可用性。坏 hash、孤立 sidecar、截断、超限均拒绝；不能将错误伪装为无 patch。
- 辅助客户端下载按配置选源：GitHub 模式访问固定仓库/tag；镜像模式的 manifest 与 binary 均走 `/api/v3/products/<product>/mirror/tools/<kind>/<tag>/assets/<name>`，仅提交后的精确 tag 可见，冷缓存也不请求 GitHub。坏 hash、404 或网络错误只允许使用同来源已验证缓存或明确失败，不回落 GitHub/上游。用户选择镜像即信任其清单，仍严格验证身份、大小、摘要及架构；拒绝跨 origin 重定向。helper/executor 现有 32 MiB、协议与 60/120 秒预算继续生效；操作冻结 server/product/repository/代理，安装票据保留镜像身份。主程序与辅助组件都遵守同一镜像选源边界。
- 镜像模式的客户端逐版本查询 availability，仅用已镜像且身份验证通过的边规划 direct 或多步补丁链，总下载量必须小于 full。无适用链、base 不匹配、404/坏 hash、zstd 缺失或重建失败，只转同一冻结镜像中的目标 full，仍验 size/SHA256/SHA512；镜像 full 也缺失时明确失败，绝不访问 GitHub。用户取消和整体 deadline 不触发 fallback。
- **升级与重新镜像**：客户端和镜像服务器都需升级才能获得完整离线选源能力；旧客户端不会被服务器升级自动改变请求策略。旧 v1 snapshot/catalog 继续可读，已有 patch 可用则仍可增量；但旧 metadata-only 镜像缺少 full 时，新客户端只会报错。升级镜像服务器后，用新镜像生产端重新镜像所需已公开 tag，才能补齐 full；需要多步增量时也须确保中间目标已镜像并仍在当前 index 窗口内。跨源302不能替代升级或资产补齐。
- **两种模式都不回传资产给 runner 做 hash 校验**：服务器负责流式大小/SHA256 校验及提交；direct 仅返回 `server-sha256` 小回执，旧服务器缺少该回执须升级，不恢复大文件 GET 兼容。必要的服务器本地提交复核仍保留。
- receipt 区分 direct 的 `MIRRORED` / `METADATA_ONLY`、WebDAV 的 `STAGED_FOR_PULL`，以及 `SKIPPED_UNCONFIGURED` / `FAILED` 与部分完成。`verified` 表示服务器已校验，不再表示 runner 读回；WebDAV 暂存时该数组为空、`snapshotCommitted=false`。缺失 receipt 不等于成功。Core Gate 不看镜像结果。

```bash
# 仅在目标已公开到 GitHub 后手动镜像；main 替换为真实默认分支
# 不需要旧 bridge run、不重编、不查询服务器历史基线
gh workflow run update-server-mirror.yml --ref main -f kind=main -f tag=v0.9.2
gh workflow run update-server-mirror.yml --ref main -f kind=executor -f tag=executor-v0.9.1
```

历史 `prepare-bridge`、`mirror_only` / `bridge_run_id` 封存恢复不再属于正常发布链。旧 artifact 只保留诊断，不能作为 GitHub 当前资产权威；需要重新镜像时只读核验已经公开的 GitHub 版本，并上传其当前内容。

#### 可选 WebDAV 中转：runner 无须连接更新服务器

不配置 WebDAV 时保持默认 direct，不启动服务器后台拉取。只有 GitHub runner 到更新服务器网络不通时，显式选择：

```text
GitHub → runner → WebDAV
                    ↓ 更新服务器主动拉取、校验 SHA256、原子提交
```

在独立镜像 workflow 使用的既有 `release` Environment 配置：

| 类型 | 配置 | 说明 |
|------|------|------|
| variable | `NF_MIRROR_TRANSPORT=webdav` | 必须显式选择；缺省 direct |
| variable | `NF_MIRROR_WEBDAV_URL` | HTTPS 专属根目录，例如 `https://dav.example.invalid/updates/`，不内嵌凭证、query 或 fragment |
| variable | `NF_MIRROR_WEBDAV_FEED` | 消费通道，缺省 `default`；不同独立服务器用不同 feed |
| secret | `NF_MIRROR_WEBDAV_USERNAME`、`NF_MIRROR_WEBDAV_PASSWORD` | Basic 上传账号；与下项二选一 |
| secret | `NF_MIRROR_WEBDAV_TOKEN` | Bearer 上传凭证；不能同时配置 Basic |
| secret | `NF_MIRROR_RELAY_SIGNING_KEY` | 32 随机字节的规范 base64，与服务器验证密钥一致 |

runner 需要专属前缀的 MKCOL/PUT/PROPFIND/DELETE 权限；它只删除满足保留期规则的自有日期桶，不修改用户其他目录或旧 123 分发目录。服务器可使用另一只读账号，仅需 GET/PROPFIND。密钥不能与 WebDAV 密码混用；HMAC 认证交接清单，不把 WebDAV 当独立发布权威。默认拒绝所有重定向。若厂商 GET 下载经 CDN，可在服务器 `mirrorRelay.downloadRedirectHosts` 显式配置精确主机名或受限后缀，例如 `["*.pd1.cjjd19.com"]`；只允许 HTTPS/443、最多 3 跳，后续请求不转发 Authorization、Cookie 或 Referer，且共用原超时与大小/hash 校验。PSL 校验拒绝公共及托管后缀本身，不能把 `*.com` 或 `*.s3.amazonaws.com` 当信任范围；域名白名单不等于 DNS 重绑定钉住。上传、发现、删除仍不跟随重定向，其他部署不配置此字段即可维持原策略。没有新增 rclone 或其他外部二进制依赖。

独立更新服务器的 `config.json` 增加以下字段（合并进原有配置，替换示例仓库和 URL）：

```json
{
  "mirrorRepositories": { "narrafork": "NarraFork/NarraFork" },
  "mirrorRelay": {
    "enabled": true,
    "url": "https://dav.example.invalid/updates/",
    "feed": "production",
    "usernameEnv": "MIRROR_DAV_USER",
    "passwordEnv": "MIRROR_DAV_PASSWORD",
    "signingKeyEnv": "MIRROR_RELAY_KEY",
    "pollIntervalSeconds": 60
  }
}
```

服务器进程环境中配置对应只读账号和同一签名密钥；也可将 username/password 引用替换为 `bearerTokenEnv`。这些字段是**环境变量名称**，不把密码或解析后的密钥写入 config。`enabled` 缺省 false；启用却缺配置则明确失败，不能静默降级。轮询间隔允许 10–3600 秒，最多 16 个显式配置的产品。独立更新服务器需加载新配置；这不要求重启承载会话的 NarraFork 主服务。

交接与结果：

1. runner 在 `narrafork-mirror-v1/<feed>/batches/<product>/<kind>/<UTC日期>/<jobId>/objects/` 上传原始文件及独立 commit payload；不读取 WebDAV 资产做回传验证。
2. 最后上传 `ready/.../<manifestHash>.json`，其 HMAC 覆盖 feed、仓库、目标、jobId、时间和 payload 的大小/SHA256；ready ≤8 KiB，不内嵌最高 1 MiB 的 payload。没有完整合法 ready，服务器不会导入。
3. 服务器自启动可取消的单并发拉取任务，验签、验证运营者配置仓库、拉取对象并校验大小/SHA256，复用 direct 的同一入库/提交锁。成功状态本地原子记录，重启重试幂等；同 catalog 不同 target 的 availability 不互相抹除，辅助 metadata 按精确 tag 不可变保存。
4. workflow 成功只代表 `STAGED_FOR_PULL`（已暂存、待拉取），不等待服务器在线，不冒称 `MIRRORED`。服务器实际导入结果看本地 `Mirror relay pull` 日志及 `mirror-relay-state/<feed>/<product>.json`，不新增向 runner 回调或回传文件。

容量与保留：ready 自创建起精确有效 7×24 小时，容许 5 分钟时钟偏差；离线超过期限需重新暂存。每产品/类型/日期最多 32 项，过大目录明确失败，不静默截断。轮询扫描通常 8 个、午夜偏差时最多 9 个 UTC 桶，每轮最多导入 4 项；失败退避不阻塞其他任务。默认单任务 main 25 分钟、helpers/executor 120 分钟；单 DAV 对象上传/下载及 relay 流式入库默认15分钟，direct 上传仍限120秒。可用受保护 Environment/repository 变量 `NF_MIRROR_TOTAL_TIMEOUT_MINUTES`（整数1–300）和 `NF_MIRROR_TRANSFER_TIMEOUT_MINUTES`（整数1–60，仅DAV）显式覆盖；本地 CLI 使用同名环境变量。空值保留默认，NaN、负数、小数和越界值失败，不自动降级。总预算贯穿 CLI→main/tools→签名 ready，工作流硬限330分钟，较最大300分钟预留30分钟安装依赖、保存失败receipt与artifact；仍可能硬取消，缺失/partial receipt不代表成功。

服务器独立配置 `mirrorRelay.totalTimeoutMinutes`（1–300）和 `mirrorRelay.transferTimeoutMinutes`（1–60），默认同上；不能从远端payload改变本地预算。显式单对象预算不得大于总任务预算（服务器不设置总预算时以兼容的main25分钟核对），只提高runner预算不能自动放宽服务器。显式 `mirrorLimits.uploadTimeoutMs` 始终是额外运营者上限（旧120000仍生效），调大relay配置不绕过它；旧主程序默认和direct120秒上限不变。GitHub原始资产下载仍各有15分钟预算。各层父取消贯穿流式读写；runner不原地重试取消/超时，客户端取消/整体deadline不fallback；relay保留既有失败退避/幂等重放，stop取消不继续轮询。不回传资产校验，也不因更大预算放宽大小/总量/签名/保留期约束。总导入字节数最多 4 GiB，仍受服务器磁盘配额/空闲量限制。

runner 清理只在**该日期桶次日 UTC 零点 +7 天 +24 小时宽限 +10 分钟时钟余量**之后进行；每次最多 12 个日期桶、30 秒，任务对象独占避免误删新引用。权限不足、预算耗尽或部分失败记为 `RETENTION_INCOMPLETE`，并不表示清理成功或 WebDAV 配额必然有界；运营者仍需监测容量。WebDAV 实际厂商网络/权限兼容性与本地 fixture 验收分开报告。

并行上传：独立 workflow 的受保护 Environment/repository 变量及本地 CLI 环境变量 `NF_MIRROR_UPLOAD_CONCURRENCY` 未显式配置时 **direct默认2、WebDAV默认3**，只接受整数 **1–8**（空值使用默认；0、负数、小数、NaN、越界或含空白的字符串拒绝）。同一个有界池覆盖 main 的 binary/metadata/patch 与 helpers/executor 的完整“源下载→hash→上传”任务，不先把所有大文件下载落盘。临时文件逐任务独占；按最大N个去重物理文件之和 +64 MiB预留本地磁盘（N为并发数），单文件/总字节预算不变。相同SHA/size只传一次物理对象，逻辑资产仍完整校验；回执按canonical资产顺序输出，不依赖完成先后。

任何任务失败即停止派发、取消在途传输并等待所有任务及临时文件清理settle；随后只报告真实已确认的部分成功，不提交snapshot、不发布ready。全部资产成功后才重新核验GitHub权威并提交；WebDAV共享初始化目录，对相同hash在途上传去重，存在失败或在途对象时拒绝生成payload/ready。新服务器认证上传和LocalStorage同时入库的全局硬上限为8，提交锁仍为2，磁盘配额/保留空间与timeout不放宽；relay后台仍单作业拉取，不因runner并发而无界扩张。**旧服务器只有2个上传槽**，direct缺省2保持兼容，不探测、不自动429重试；显式提高到3–8前需先部署新服务器，不能靠提高runner并发绕过服务器上限。服务器配额 admission 与最终rename共用短锁；临时物理磁盘预留与对象净配额增长分别记账，仅排除本进程精确登记的活动temp，崩溃遗留temp仍计费，满额同SHA对象重传不被重复预留拒绝。

慢链路示例（仅说明配置，不自动执行生产操作）：设置受保护 Environment 的 `NF_MIRROR_TOTAL_TIMEOUT_MINUTES=120`、`NF_MIRROR_TRANSFER_TIMEOUT_MINUTES=45`，服务器同时配置 `mirrorRelay.totalTimeoutMinutes:120`、`mirrorRelay.transferTimeoutMinutes:45`；如旧 `mirrorLimits.uploadTimeoutMs:120000` 仍存在，需运营者明确决定是否调整，不能被新预算静默覆盖。main 未显式配置时仍是25分钟。

生效需先将实现合并到仓库真实默认分支，独立 workflow 才会 checkout 新控制SHA；部署新的 `update-server/` 代码并由运营者加载配置后才支持二进制入库/精确tag下载与服务器预算。客户端需升级含新 `shared/helper-distribution.ts`、`server/lib/helper-distribution-runtime.ts` 的 NarraFork 构建；旧客户端保持原GitHub下载行为。仅改变量不能更新旧服务器/客户端代码。本功能不要求也不允许工具自行重启承载当前会话的 NarraFork。

`NF_MIRROR_TRANSPORT` 选择目前用于独立 workflow 和 `scripts/mirror-update-server.ts`；原 `release.ts` / `release-executor.ts` 的兼容服务器目标仍按既有 direct 配置工作，不会因设置中转变量而自动切换。

## GitHub 辅助工具与 executor

- rg 15.1.0 与 zstd 1.5.7 的六平台原始可执行文件、`helper-manifest-v1.json` 和许可附件放在同仓库不可变 `helpers-v1.0.0` Release。rg 由固定官方归档及归档/二进制双摘要制备；zstd 使用受控源码与工具链构建。新增 macOS zstd，Windows ARM64 使用原有确定性 recipe。Linux zstd 为 musl 静态包；rg Linux ARM64 是 glibc 包，不代表支持 Alpine/Termux。
- executor 使用独立 `executor-v<组件版本>` Release 和 `narrafork-executor-manifest.json`。组件版本与协议由 `shared/component-versions.json` 显式锁定，不跟随主程序版本增长；例如主程序 0.9.2 或后续版本可以继续依赖 executor 0.9.1。仍校验外层仓库/tag/commit、组件版本、RPC 协议及六种 Go 平台，不通过 GitHub latest 选择工具，也不接受任意“同协议最新版”。两类辅助 Release 都不标记 latest、不写主 update-index、不占主程序资产预算。
- GitHub 模式从配置的 canonical 仓库固定 tag 获取 helper/executor；独立镜像模式则从选定服务器的精确 tag 获取 manifest、许可和二进制，不回退 GitHub/上游，也不使用 unsigned 旧 tools 接口。镜像运营者必须先升级支持该协议的服务器，并导入所需 `helpers-v1.0.0`、`executor-v<组件版本>` 资产；旧服务器或 metadata-only 镜像缺少资产时会明确失败，不能把 404 当作自动切源。fork 的发布端仍须自行公开对应辅助 Release，客户端选源与发布权威校验分开。
- 系统 PATH 优先；托管缓存按来源/tag/版本/平台/摘要隔离，使用前核对 size/SHA256/架构。旧缓存仅可信摘要吻合才复制迁移，不删除旧文件。manifest 流式硬限 64 KiB/10 秒；helper 二进制 32 MiB/60 秒，executor 32 MiB/120 秒，父取消与独占 temp 清理贯穿下载。
- executor 安装票据绑定选中的来源/tag/版本/平台/size/digest，下载不重新用最新 manifest 选包。目标机器从 NarraFork 获取验证后的产物，不接收服务端代理凭据。不安装系统包、不修改 PATH、不 sudo、不启动守护进程。
- 新 build-info/sidecar/bundle 带 `helperDistribution` 依赖声明，构建开始时冻结，八平台必须一致；正常主程序 publisher 在远端写入前只读核验对应 helpers 和 executor 公开资产的完整集合、hash/size、许可及组件版本/协议。含独立组件配置的新目标还要比较实际 executor 构建输入，源码、依赖、生产嵌入资源、构建参数或固定 Go 工具链发生变化但未升级组件 pin 时拒绝复用；仅主程序、文档或纯测试变化不触发组件发布。build-only/dry-run 不因此联网或发布，旧 bundle 无声明时不凭当前代码编造新依赖；恢复原始 bundle 不采用控制脚本的当前 pin 改写旧产物。

`.github/workflows/helpers-release.yml` 独立、手动运行。维护者在组件实际变化时先显式升级组件配置，再创建并推送精确源码 tag：helpers 使用 `helpers-v1.0.0`，executor 使用与该提交组件配置一致的 `executor-v<组件版本>`，不要求与该提交的应用版本相等；tag 须在当前仓库真实默认分支祖先链。无新配置的历史 tag/封存包保留原身份校验与恢复规则。默认 `publish=false` 完成六平台 native build/smoke 后只上传不可变 Actions bundle；`publish=true` 仍需 `release` Environment 审批，只有 publisher 有写权限。不会因为 push main/tag 或应用版本增长自动发布。

示例（`main` 替换为实际默认分支；这些命令会触发远端任务，需维护者显式执行）：

```bash
# 辅助工具：先原生验收，再用原 run bundle 发布，不重建
gh workflow run helpers-release.yml --ref main -f kind=helpers -f tag=helpers-v1.0.0 -F publish=false
gh workflow run helpers-release.yml --ref main -f kind=helpers -f tag=helpers-v1.0.0 -F publish=true -f source_run_id=123456789
# executor：仅组件变化、升级独立 pin 且尚未公开时执行（tag 按组件配置替换）
# 普通主程序 0.9.2 可以复用已公开 executor-v0.9.1，无须执行这些命令
gh workflow run helpers-release.yml --ref main -f kind=executor -f tag=executor-v0.9.2 -F publish=false
gh workflow run helpers-release.yml --ref main -f kind=executor -f tag=executor-v0.9.2 -F publish=true -f source_run_id=234567890
```

本地 `scripts/release-helpers.ts preview --plan=<plan> --output=<bundle>` 校验原产物、不写 Release；`scripts/release-executor.ts --target=github` 消费原生验收封存包。默认 `server` 参数及配置地址为兼容保留，只镜像已公开组件的 metadata 和原始二进制，不 Go build、不重新发布 GitHub；使用 `--preview` 做在线只读预览、`--dry-run` 做明确离线意图检查。公开辅助资产不能 clobber、补传或覆盖，变更需新 tag；失败 draft 可恢复，但恢复必须核对原 run/attempt/artifact 和全部 native smoke，不用新的重编结果替代。checksum 只证明同源传输/缓存完整性，不宣称独立发布者签名。mock 不能代替托管 runner native smoke 或真实资产上线。

## 有界更新索引与修复

- 固定入口是同仓库 `narrafork-updates` 分支的 `update-index-v1.json`，无需 Pages、token 或额外服务。首次 publisher 自动创建只含元数据的 orphan branch；不要预先创建没有有效索引的同名分支，否则视为损坏并拒写。
- v1 最多 32 个版本、每版 8 个平台和 64 对 patch；索引限 256 KiB、单版本记录 96 KiB、sidecar 64 KiB、外置 notes 1 MiB。stable/beta 当前目标必须保留；旧非目标超预算时裁剪，目标自身不合法或超预算则失败。
- 首次部署通过 GraphQL 概要定位已有 stable/beta 目标并验证必要旧资产，不能用本次较旧发布遮蔽已有高版本。CI 概要查询不读取 Release body/assets 大字段，保持 10×100 条、每次 30 秒及 1 MiB 输出预算。旧匿名 REST 兼容路径的分页边界不变。
- 发布器使用 Git Data API 写 blobs/tree/单个 commit，再非 force 更新固定 ref。CAS 冲突最多重读合并三次；保留其他文件，拒绝覆盖损坏索引，不执行分支代码。已公告的二进制、sidecar 和 patch 身份不能改写；首次 full-only 历史记录可单调补入后来核验的既有 patch。
- 客户端先读索引，只有 **404** 回退旧 Release API；损坏、错仓库、未知 schema、超限、超时或鉴权失败均明确报错。ETag 缓存有界且按仓库隔离。目标 sidecar 与索引的大小、SHA256/SHA512、版本、平台和 commit 必须匹配；窗口外无法形成安全 patch 路径时仍用同来源 full。
- 说明按内容寻址路径单独保存，Modal 打开且推荐匹配所选包时才读取。管理员 notes API 只接受来源身份、版本和目标 hash，不接受任意 URL；切源/换包后的迟到结果丢弃，说明失败不阻止已验证二进制。
- Release 与索引不是跨系统事务。公开后索引失败会报告 `PUBLISHED_NOT_INDEXED` 并让门禁失败，不撤销 Release、不重建、不覆盖公开资产。修复成功必须取得并读回核验 index commit/generation。

CI 修复用 `index_only=true`，默认 `publish=false` 仅生成预览，不跑构建；可指定原始 `source_run_id` 校验 bundle，也可直接核验已公开资产。确认后用 `publish=true` 经相同 Environment 审批提交索引。示例中的 `main` 替换为实际默认分支：

```bash
# 只读在线预览；不是公开发布成功
gh workflow run release.yml --ref main -f tag=v0.9.0 -F index_only=true -F publish=false
# 经审批修复，不修改公开 Release 资产
gh workflow run release.yml --ref main -f tag=v0.9.0 -F index_only=true -F publish=true
# 本地 CLI 同样先只读验证公开资产，不需要 dist
bun scripts/release.ts 0.9.0 --target=github --index-only
# 确认后在主仓库执行，显式授权索引写入
bun scripts/release.ts 0.9.0 --target=github --index-only --publish-index
```

显式把 GitHub beta 晋升 stable 后，须运行索引修复才更新客户端通道指针；修复采用远端已批准状态，不重新编译。仅修改 GitHub `latest` 不等于索引已更新。内容寻址 notes 不自动垃圾回收，旧索引引用不会被新发布覆盖。

## GitHub / CI 的增量资产约定

客户端不依赖发布方式：本地 CLI 和 GitHub CI 发布相同的资产集合，无需独立更新服务器参与。启用 CI 后可不再运行本地发布脚本。

- 保留每个平台完整二进制、`.metadata.json` 和两份版本化聚合 checksum；仅有 patch 而没有 full 不构成可用 Release。
- 紧邻基线 patch 为 `<binary>.zstd-patch` + `<binary>.zstd-patch.meta.json`；其他基线直达 patch 为 `<binary>.from-<fromVersion>.zstd-patch` + 同名 `.meta.json`。`<binary>` 含目标版本与精确平台后缀（Windows 保留 `.exe`）；同一目标可上传多个源版本，不覆盖已有命名。
- patch metadata 必须包含 `fromVersion`、`toVersion`、`oldFileSize`、`oldFileSha512`、`newFileSize`、`newFileSha512`、`stableEnd`、`newTailSize`、`patchSize`；`mode` 可为 `patch-from` 或 `dictionary`。SHA512 为 base64；源版本必须早于目标，命名源版本提示必须匹配，目标版本与 Release 一致，目标 size/SHA512 与该平台 full sidecar 一致。`stableEnd` 不超过源/目标大小，`newTailSize = newFileSize - stableEnd`。
- 发布器验证 patch 实际大小，流式计算 SHA256，并比对原文件与 staging 快照及上传后的远端身份；不要求 patch metadata 新增独立 hash 字段。客户端用本机源二进制 size/SHA512 核对基线，并在每步重建后校验目标 size/SHA512。
- 缺少所有 patch 是合法的 full-only 发布；选定平台出现孤立 patch/meta、无效 JSON、非法版本/尺寸或身份不匹配则拒绝发布，不静默忽略损坏资产。未选平台 patch 不校验、不上传。`dist/` 中如存在源基线二进制，必须匹配 metadata 的旧 size/SHA512；缺少源文件不阻断，发布器不读取独立更新服务器配置或联网寻找基线。CLI 的本地构建输入不足时可只产出 full，或由 CI 准备可验证的 patch 对。
- **CI 基线必须取自此前已发布的原始平台二进制**，先与该 Release 的 sidecar 核对 size/SHA512，再生成 patch。不要重编旧 tag 充当基线：编译时间和构建环境可能改变二进制字节，即使版本相同也不保证 SHA512 一致；客户端基础文件 hash 不匹配时会回退 full，无法实际使用这份 patch。
- 大包建议 CI 安装 zstd，生成 `mode: "patch-from"`；GitHub 客户端先用系统 zstd，再按需准备同仓库固定辅助 Release 的已验证 CLI，不访问保留的旧工具服务器。辅助包不可用时走同目标 GitHub full fallback；父操作取消则停止，不触发 full。兼容 `dictionary`（包括旧格式缺省 mode）的客户端内存解码仅接受源文件、目标文件和 patch **各不超过 8 MiB**，超过限制回退 full；此兼容模式不适合主程序大二进制。
- CI 也应保持 **draft 上传 → 校验全部资产 → 最后公开**；重试复用匹配的资产、不 clobber，公开版本不覆盖或补传。需要补充资产时发布新版本，而非修改已公开版本。

**客户端选择与回退：** 优先探测当前版本直达目标的 patch，再从可用的直达包和补丁链中选择总 patch 字节数最少、且比 full 更小的路径；字节数相同时优先更少步骤（最多 16 步、最多读取 32 份 patch metadata）。即使存在直达包，链更省流量时仍可选择链。stable 的最终目标仍只选 stable，但链可经过已公开的 beta Release；所有节点必须属于同一 GitHub 仓库和同一精确平台。无可用链、基线不匹配、patch 下载/解码/校验失败时，回退到**同一 GitHub 目标 Release 的 full 二进制**，最终仍校验 SHA512，不回退到独立更新服务器。用户取消立即终止，不触发 full fallback。

## Stable 直达补丁与独立镜像

生产补丁基线只能是此前 GitHub 已公开的原始二进制，必须核对该 Release sidecar 的 size/hash；不能按独立服务器的 stable/beta 历史另生成兼容补丁，也不能枚举未经核验的本地 dist 当基线。Release CI 生成并完整重建验证当前 patch；普通本地开发构建可 full-only。

独立服务器只复制当前 GitHub 已公开的 patch pairs。服务器没有 fromVersion、旧版本号高低、原补丁hash不同，不要求补历史包、不阻止当前投影；客户端自行验证本机base，不能用时下载同一GitHub目标full。GitHub beta→stable晋升后仍需索引修复，镜像采用新的canonical channel指针，不自行修改通道或生成stable补包。

原 `--patch-from`、`--skip-stable-patch` 等独立服务器生成参数已经废弃；不会通过“补包失败只告警”继续保留第二套权威。若未来需新增某条生产升级路径，应在GitHub canonical发布体系内提供并验证，不在镜像端再生成。

## 发布目标服务器（生产 vs 个人测试）

- **生产独立镜像：** `bun scripts/release.ts <version>` 为兼容仍默认 `--target=update-server`，读取同一 `~/.narrafork/update-server.json` 与原生产地址 `https://narrafork-update.b.domexie.cn`；默认参数/地址不变，行为为镜像已经公开的 GitHub binary/metadata/patch，不再构建或生成补丁；完整原始全量包必须上传并随 v2 snapshot 提交。GitHub版本尚未公开时明确拒绝并提示primary入口，不自动切换目标或发布。
- **个人测试镜像：** 对已经公开到 GitHub 的版本，在独立测试更新服务器镜像 binary/metadata/patch，不影响生产。新服务器需升级 v3 镜像 API，并在配置 `mirrorRepositories` 中绑定产品预期仓库，例如 `{"narrafork":"NarraFork/NarraFork"}`；默认空配置不会信任上传内容自报的仓库。通过环境变量覆盖地址和令牌：
  ```bash
  # 令牌明文存于 ~/.narrafork/update-server-test.json（权限 600，不提交仓库）
  NF_UPDATE_SERVER=https://nfupdatetest.domexie.cn \
  NF_UPDATE_TOKEN=$(bun -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.HOME+"/.narrafork/update-server-test.json","utf8")).token)') \
  bun scripts/release.ts <已公开的GitHub版本> --target=update-server
  ```
  说明：镜像当前完整 canonical target 投影，不发布一个伪造的局部 snapshot。`--dry-run` 离线打印意图，不读取 token、不构建/联网；`--preview` 在线只读核验已公开 GitHub 资产，不访问服务器；`--upload-only` 为兼容别名，镜像无需本地 dist。
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
