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

- **客户端默认来源是 GitHub**：官方包默认 `NarraFork/NarraFork`；fork 自行构建的包默认采用构建时注入的仓库。新安装无需填写仓库，已有显式保存的来源（包括官方仓库）不被覆盖。上游已发布二进制不会在运行时识别用户的 fork、cwd 或项目 origin。仓库须公开才能匿名分发；设置页仍可选择自部署更新服务器，不自动跨源回退。**发布脚本默认仍是 `update-server`**。
- **旧配置迁移**：已有显式来源优先；旧自定义服务器地址或非默认 product 保留 `update-server`；未配置、空地址或原内置官方地址且默认 product 迁移为 GitHub。切换来源保留另一种来源的配置，检查使用已保存配置。rg/zstd/executor 也按生效来源选择分发；GitHub 模式不会把保留的工具服务器地址当成生效来源。
- **检测与下载**：stable 排除 draft/prerelease，beta 同时考虑 stable 与 prerelease，按语义版本排序；精确匹配平台（包括 x64-baseline），校验 sidecar 中的 SHA512 和大小。检测失败、限流、无 Release 和平台缺失不会显示为“已经最新”；元数据单请求 10 秒、检测总预算 30 秒，最多 5 页，每页 100 条。完整二进制流式下载最大 1 GiB、最长 15 分钟，可取消；下载前重新检查可信元数据，源/仓库或版本改变要求重新检测。
- **配置与准备包身份**：检测开始时冻结生效的来源、仓库或服务器/product、channel、platform；下载前及写入准备记录前再次核对。变化要求重新检测，不能把旧通道/产品的结果下载成新配置的包。保存来源设置不删除旧准备包或取消已有调度；界面按来源、版本、SHA512 和大小匹配推荐，旧元数据缺来源时明确显示“未知来源”，不从当前设置反推。
- **应用 API**：`GET /api/update/status` 的 `preparedIdentity.id` 绑定已验证文件及其来源；`POST /api/update/apply` 必须提交该 `preparedId`（可同时提交 `version`）。缺失或过期选择器返回 409，不再仅凭版本号选择文件。旧包仍可通过查询所得的选择器显式应用；已进入调度的准备包不能被另一次下载替换。选择器不是授权令牌，接口仍要求管理员权限。
- `--target=github|update-server` 选择发布目标；GitHub 仓库可用 `--github-repository=owner/repo` 指定，否则优先采用可信 Actions 仓库或 GitHub origin，无法推导时才回退官方仓库。Actions 中显式仓库必须与当前仓库一致；同一身份注入前后端、sidecar 和 smoke。GitHub 认证使用已登录的 `gh` / `GH_TOKEN`；GitHub 路径不会读取旧更新服务器令牌或查询其基线。
- **真实发布只能在主仓库工作区原地执行**，不能使用隔离 worktree。GitHub 路径额外检查这一点；本工作区只能开发代码和做模拟测试，不得真实发布。
- GitHub 使用**完整主程序二进制 + 可选 zstd patch 对**；缺少 patch 时仍可发布并全量升级。旧更新服务器继续支持原有增量升级。helper / executor 使用同仓库独立辅助 Release，不混入主程序资产；显式自部署来源仍兼容旧 tools 接口。
- 每个选定平台必须有 `dist/narrafork-<version>-<suffix>`（Windows 带 `.exe`）、同名 `.metadata.json`，以及版本化 `narrafork-<version>-SHA256SUMS`、`narrafork-<version>-checksums.txt`。缺少任何必需文件、size/hash 不一致、版本/平台/target/commit provenance 不符都会失败。sha256 为十六进制，sha512 为 base64，与构建的 binary-metadata schema 一致。
- 上传前读取并验证原 `dist/`；只上传 `--platform` 选定的平台及其 patch 对（未指定则要求全部平台）。过滤后的聚合 checksum 只在独占临时 staging 生成，**不修改原构建产物**；上传使用校验后的 staging 快照。完整二进制最大 1 GiB、patch 最大 512 MiB、文本最大 1 MiB（binary/patch sidecar 各 64 KiB），哈希流式计算；每次发布最多 64 对 patch、200 个资产，目录扫描最多 4096 项。单次 `gh` 调用超时 5 分钟、stdout/stderr 各最多 1 MiB。
- GitHub 的 `v<version>` tag 必须已存在，且解析出的 commit 与本地 tag 一致（支持 annotated tag）；脚本不会自动 push，也不会从 GitHub 默认分支偷偷创建 tag。仍保留 bump → build → tag 的原顺序；初次本地构建/tag 后若缺远端 tag，脚本安全失败，显式 push 后用 `--upload-only` 重试。
- 发布顺序为 **create draft → upload → 验证完整资产集合及 hash → 最后 publish**。失败保留 draft；重试可复用完全一致的已有资产，绝不 `--clobber`。已公开版本只有 tag/commit、通道、双语 changelog 和全部必需资产一致时才视作成功，不能替换或补传公开版本。tag 查询未找到时，通过认证后的 Release 列表寻找 draft，再按 ID 读取；最多扫描 10 页、每页 100 条，无法完整排除既有 draft 时安全失败，不盲目创建。
- 版本严格匹配 `x.y.0` 时为 stable，其他版本为 beta；beta 映射为 GitHub prerelease，不标记 latest。双语 changelog 写入 Release body。
- 普通发布的 `--dry-run` 不进行任何 GitHub 调用；仍构建并验证本地产物和有界索引记录，不 commit/tag/upload/publish。可加 `--upload-only --dry-run` 只验证已有构建。`--index-only` 是独立的只读在线修复预览：读取已公开 Release，不依赖本地 dist，不 build/upload/publish；只有额外指定 `--publish-index` 才更新元数据分支，不能与 `--dry-run` 同用。

### 更新与辅助工具的网络代理

网络代理页集中管理“软件更新与辅助工具”，覆盖 GitHub 索引/REST、sidecar、说明、完整包、patch，以及 rg/zstd/executor manifest 和二进制。对应设置只有 `update.proxy`：缺省或 `mode:"default"` 继承全局，也可单独选择 `direct`、`system`、`custom`。全局默认直连；system 使用进程启动时记录的环境代理，自定义支持 HTTP(S) 代理，非法配置不会静默改成直连。更新设置页链接同一管理入口，不存在两份覆盖值。

一次检查/下载冻结传输策略，重定向每跳重新应用 NO_PROXY/loopback 豁免。代理变更后可以立即重试，不复用旧失败或 in-flight；不改来源身份或 preparedId，不删除已准备包，也不取消已调度更新。TLS 验证不能关闭，代理凭据不写入产物、票据、来源身份或诊断日志。旧更新服务器的响应体也受请求 deadline/父取消约束；检查 JSON 限 1 MiB、patch metadata 限 64 KiB，只允许同 origin 的有界重定向。

公开仓库应**先发布 GitHub，再桥接旧更新服务器**，确保新客户端默认来源有版本可用。新构建先发布下节的辅助依赖，再发布主程序。示例（版本、平台按实际替换）：

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

## GitHub Release CI

`.github/workflows/release.yml` 是主程序专用入口，仅支持从当前仓库的真实默认分支手动触发（不再硬编码上游仓库或 main）。先把版本号和双语 `changelogs/v<version>.json` 提交到默认分支，再由维护者显式创建和推送 tag。CI 不修改源码分支、版本或 tag；仅受保护 publisher 可为生成的索引创建元数据分支提交。不改变本地发布脚本默认的旧更新服务器目标。

输入为 `tag`、默认 `false` 的 `publish`、可选 `source_run_id`、默认 `false` 的 `index_only` 与 `mirror_only`，以及镜像恢复用的 `bridge_run_id` / `bridge_run_attempt`。默认流程只构建验收并保存索引预览，不创建 draft，也不公开 Release：

```text
preflight（固定 tag SHA、版本、changelog、基线）
  → 可复用 CI（静态、build/typecheck、前后端全仓四片、CI Gate）
  → 八平台严格构建 → 八平台原生 smoke
  → 基线 patch、统一 checksum、离线 publisher 校验 → 不可变 bundle
  → publish=true 时等待 release Environment 审批
  → 再验 tag 与 bundle → draft → 上传 → 远端完整校验 → publish
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

旧更新服务器桥接由下节显式 Environment 配置启用；executor/helper 分发仍使用独立辅助 workflow。自动版本准备、自动推送与签名证书管理不在此 workflow 范围。上线报告必须区分本地测试、在线 `publish=false` 验收和真实发布，不能把模拟测试称为在线发布成功。

### 自动同步既有更新服务器

仅在 `release` Environment 配置 `vars.NF_UPDATE_SERVER`（HTTPS 根地址）和 `secrets.NF_UPDATE_TOKEN`（上传令牌）；两个值都未配置时保持 GitHub-only。只配置一个、非法 URL 或空令牌均在首次 GitHub 写入前失败，不读 HOME 配置、不使用个人测试/生产地址兜底。秘密仅进入经审批的 publisher 环境，不进入命令行、控制 bundle、Actions 输出、缓存、artifact 或日志。`publish=false`、离线预览和 `index_only` 不访问旧服务器。

配置启用后的顺序是：完整原 bundle 验证 → 旧端八平台冲突/预算/基线预检 → 独立生成并重建验证 bridge patch → 封存 seal 和 bridge bytes → 不可变 Actions artifact 上传成功并核验 ID/SHA256 → GitHub 公开 → 主程序索引读回 → 串行镜像与回验 → 门禁。主程序状态依次为 `BUILD_COMPLETE` / `PUBLISHED` / `INDEXED` / `MIRRORED`；辅助发布没有索引阶段。旧 metadata 不转换成 GitHub sidecar，不修改原 bundle 或原 GitHub patch。缺失匹配旧二进制基线、256MiB multipart 超限或任一平台冲突都阻止 GitHub 首次写入。

两 workflow 的 protected publisher 共用静态 `update-server-publish` concurrency 锁，区别于各自顶层锁，不主动取消发布。发布 job 总预算 30 分钟，第一步固定一次 25 分钟绝对截止，为取消与 receipt 上传保留余量；prepare、artifact restore、GitHub 写入、mirror、HTTP 和 patch 子进程共用截止与 SIGTERM 信号，不因分阶段重新获得时限。GitHub 子进程 stdout/stderr 各限 1MiB，父截止/取消终止本次子进程，下载/ZIP/磁盘仍使用独立硬限。helper 原始 rg/zstd bytes 按旧 tools 别名投影；executor 先上传并回验版本化 binary，最后切换固定 manifest。共享锁及写前/写后核验只约束这些 workflow：旧 tools API 无 CAS，不能保证其他私有 CLI 与其完全互斥或跨平台事务。

旧端是立即公开、非八平台事务。镜像失败报告 `PUBLISHED_NOT_MIRRORED`，Actions 和门禁失败，保留公开 GitHub Release/索引、原始 bundle、不可变 bridge artifact 与已写成的部分 receipt（receipt 无法写入时摘要明确说明 unavailable），不删除已成功平台、不自动跨端回滚。正常发布在同一 CLI 中复用发布前已严格恢复的 Prepared 对象，GitHub/索引成功后直接镜像；不再次下载 bridge 或重新选择基线。只有独立 mirror-only 恢复重新下载原封存 artifact。

`BASELINE_ADVANCED` 表示旧服务器当前基线已前进、该封存 bridge 过时：同 artifact 重试无法修复，不能偷偷改选新基线或重生成旧 bridge。应由维护者显式处置，或通过新版本/full 迁移恢复兼容；全部目标/patch 已匹配时仍允许纯只读成功，不强迫覆盖。其余可恢复部分失败给出原 source/bridge run 的重试命令。索引失败先报告 `PUBLISHED_NOT_INDEXED`，不会继续镜像；索引修复和镜像恢复是两个独立操作，均不能伪装整体成功。

只补镜像时，新建 dispatch：`publish=true mirror_only=true source_run_id=<原build run> bridge_run_id=<原publisher run>`；两者可能不同（build-only X 后在 Y 发布）。不能与 `index_only` 同用，必须提供正整数原 run ID。若原 publisher run 被 rerun，额外提供原 `bridge_run_attempt`。此模式每次仍等待同一 Environment 审批，只读核验 GitHub 已公开资产，不修改 Release/索引、不重编、不查询最新旧基线、不重封存新 patch。

bridge artifact 为 `update-server-bridge-<main|helpers|executor>-<publisherRunId>-<attempt>`，保留 30 天；可信 envelope 绑定仓库、workflow/control SHA、tag/build commit、原 bundle manifest SHA、source run/attempt、目标 canonical server、seal SHA。恢复严格核验原准备及 artifact 上传步骤成功、artifact ID/digest/大小/未过期、仓库及默认分支身份；原 publisher 整体失败不阻止恢复。ZIP 流式下载并校验 digest，有界安全解压，不接受用户指定本地 seal 替代可信 artifact。artifact 过期或证据缺失时明确停止，不重新选择基线。partial receipt 在独立 `update-server-*-receipts-<run>-<attempt>` artifact 保存；它不是可改写的封存桥接输入。

```bash
# 以下仅供维护者显式执行；main 和 run ID 按实际替换
# build run X=123456789，失败的 publisher run Y=234567890
# 若索引已成功，只补旧服务器：
gh workflow run release.yml --ref main -f tag=v0.9.0 -F publish=true -F mirror_only=true -f source_run_id=123456789 -f bridge_run_id=234567890
# helper / executor 同样用原两种 run 身份：
gh workflow run helpers-release.yml --ref main -f kind=helpers -f tag=helpers-v1.0.0 -F publish=true -F mirror_only=true -f source_run_id=123456789 -f bridge_run_id=234567890
```

## GitHub 辅助工具与 executor

- rg 15.1.0 与 zstd 1.5.7 的六平台原始可执行文件、`helper-manifest-v1.json` 和许可附件放在同仓库不可变 `helpers-v1.0.0` Release。rg 由固定官方归档及归档/二进制双摘要制备；zstd 使用受控源码与工具链构建。新增 macOS zstd，Windows ARM64 使用原有确定性 recipe。Linux zstd 为 musl 静态包；rg Linux ARM64 是 glibc 包，不代表支持 Alpine/Termux。
- executor 使用独立 `executor-v<应用版本>` Release 和 `narrafork-executor-manifest.json`，校验外层仓库/tag/commit、应用版本、RPC 协议及六种 Go 平台；不通过 GitHub latest 选择工具。两类辅助 Release 都不标记 latest、不写主 update-index、不占主程序资产预算。
- GitHub 模式只访问生效仓库，不访问保留的个人更新服务器、不默默转用上游仓库；显式 update-server 模式保持旧 tools 接口。fork 自动取得仓库名，但必须自行发布对应辅助 Release，仓库需公开供匿名客户端下载。
- 系统 PATH 优先；托管缓存按来源/tag/版本/平台/摘要隔离，使用前核对 size/SHA256/架构。旧缓存仅可信摘要吻合才复制迁移，不删除旧文件。manifest 流式硬限 64 KiB/10 秒；helper 二进制 32 MiB/60 秒，executor 32 MiB/120 秒，父取消与独占 temp 清理贯穿下载。
- executor 安装票据绑定选中的来源/tag/版本/平台/size/digest，下载不重新用最新 manifest 选包。目标机器从 NarraFork 获取验证后的产物，不接收服务端代理凭据。不安装系统包、不修改 PATH、不 sudo、不启动守护进程。
- 新 build-info/sidecar/bundle 带 `helperDistribution` 依赖声明，八平台必须一致；正常主程序 publisher 在远端写入前只读核验对应 helpers 和 executor 公开资产的完整集合、hash/size、许可及版本/协议。build-only/dry-run 不因此联网或发布，旧 bundle 无声明时不凭当前代码编造新依赖。

`.github/workflows/helpers-release.yml` 独立、手动运行。维护者先创建并推送精确源码 tag：helpers 使用 `helpers-v1.0.0`，executor 使用 `executor-v<version>`；tag 须在当前仓库真实默认分支祖先链。默认 `publish=false` 完成六平台 native build/smoke 后只上传不可变 Actions bundle；`publish=true` 仍需 `release` Environment 审批，只有 publisher 有写权限。不会因为 push main/tag 自动发布。

示例（`main` 替换为实际默认分支；这些命令会触发远端任务，需维护者显式执行）：

```bash
# 辅助工具：先原生验收，再用原 run bundle 发布，不重建
gh workflow run helpers-release.yml --ref main -f kind=helpers -f tag=helpers-v1.0.0 -F publish=false
gh workflow run helpers-release.yml --ref main -f kind=helpers -f tag=helpers-v1.0.0 -F publish=true -f source_run_id=123456789
# executor：使用与客户端相同的应用版本
gh workflow run helpers-release.yml --ref main -f kind=executor -f tag=executor-v0.9.0 -F publish=false
gh workflow run helpers-release.yml --ref main -f kind=executor -f tag=executor-v0.9.0 -F publish=true -f source_run_id=234567890
```

本地 `scripts/release-helpers.ts preview --plan=<plan> --output=<bundle>` 校验原产物、不写 Release；`scripts/release-executor.ts` 提供显式 `--target=github`，默认旧服务器目标不变。公开辅助资产不能 clobber、补传或覆盖，变更需新 tag；失败 draft 可恢复，但恢复必须核对原 run/attempt/artifact 和全部 native smoke，不用新的重编结果替代。checksum 只证明同源传输/缓存完整性，不宣称独立发布者签名。mock 不能代替托管 runner native smoke 或真实资产上线。

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

客户端不依赖发布方式：本地 CLI 和 GitHub CI 发布相同的资产集合，无需旧更新服务器参与。启用 CI 后可不再运行本地发布脚本。

- 保留每个平台完整二进制、`.metadata.json` 和两份版本化聚合 checksum；仅有 patch 而没有 full 不构成可用 Release。
- 紧邻基线 patch 为 `<binary>.zstd-patch` + `<binary>.zstd-patch.meta.json`；其他基线直达 patch 为 `<binary>.from-<fromVersion>.zstd-patch` + 同名 `.meta.json`。`<binary>` 含目标版本与精确平台后缀（Windows 保留 `.exe`）；同一目标可上传多个源版本，不覆盖已有命名。
- patch metadata 必须包含 `fromVersion`、`toVersion`、`oldFileSize`、`oldFileSha512`、`newFileSize`、`newFileSha512`、`stableEnd`、`newTailSize`、`patchSize`；`mode` 可为 `patch-from` 或 `dictionary`。SHA512 为 base64；源版本必须早于目标，命名源版本提示必须匹配，目标版本与 Release 一致，目标 size/SHA512 与该平台 full sidecar 一致。`stableEnd` 不超过源/目标大小，`newTailSize = newFileSize - stableEnd`。
- 发布器验证 patch 实际大小，流式计算 SHA256，并比对原文件与 staging 快照及上传后的远端身份；不要求 patch metadata 新增独立 hash 字段。客户端用本机源二进制 size/SHA512 核对基线，并在每步重建后校验目标 size/SHA512。
- 缺少所有 patch 是合法的 full-only 发布；选定平台出现孤立 patch/meta、无效 JSON、非法版本/尺寸或身份不匹配则拒绝发布，不静默忽略损坏资产。未选平台 patch 不校验、不上传。`dist/` 中如存在源基线二进制，必须匹配 metadata 的旧 size/SHA512；缺少源文件不阻断，发布器不读取旧服务器配置或联网寻找基线。CLI 的本地构建输入不足时可只产出 full，或由 CI 准备可验证的 patch 对。
- **CI 基线必须取自此前已发布的原始平台二进制**，先与该 Release 的 sidecar 核对 size/SHA512，再生成 patch。不要重编旧 tag 充当基线：编译时间和构建环境可能改变二进制字节，即使版本相同也不保证 SHA512 一致；客户端基础文件 hash 不匹配时会回退 full，无法实际使用这份 patch。
- 大包建议 CI 安装 zstd，生成 `mode: "patch-from"`；GitHub 客户端先用系统 zstd，再按需准备同仓库固定辅助 Release 的已验证 CLI，不访问保留的旧工具服务器。辅助包不可用时走同目标 GitHub full fallback；父操作取消则停止，不触发 full。兼容 `dictionary`（包括旧格式缺省 mode）的客户端内存解码仅接受源文件、目标文件和 patch **各不超过 8 MiB**，超过限制回退 full；此兼容模式不适合主程序大二进制。
- CI 也应保持 **draft 上传 → 校验全部资产 → 最后公开**；重试复用匹配的资产、不 clobber，公开版本不覆盖或补传。需要补充资产时发布新版本，而非修改已公开版本。

**客户端选择与回退：** 优先探测当前版本直达目标的 patch，再从可用的直达包和补丁链中选择总 patch 字节数最少、且比 full 更小的路径；字节数相同时优先更少步骤（最多 16 步、最多读取 32 份 patch metadata）。即使存在直达包，链更省流量时仍可选择链。stable 的最终目标仍只选 stable，但链可经过已公开的 beta Release；所有节点必须属于同一 GitHub 仓库和同一精确平台。无可用链、基线不匹配、patch 下载/解码/校验失败时，回退到**同一 GitHub 目标 Release 的 full 二进制**，最终仍校验 SHA512，不回退到旧更新服务器。用户取消立即终止，不触发 full fallback。

## 正式版（stable）直达增量包（旧更新服务器）

以下自动补包逻辑仅属于 `--target=update-server`；GitHub 发布器只上传本地已准备的 patch 对，不向旧服务器寻找基线。GitHub Release CI 按上述 `.from-<version>` 约定生成 stable 直达包，不访问旧更新服务器。

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
