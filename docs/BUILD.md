# 构建指南

本文档说明如何为不同平台构建 NarraFork 可执行文件。

## 快速开始

### 构建所有平台

```bash
bun run build:cross
```

产物文件名带版本号（`narrafork-${VERSION}-...`），覆盖 8 个平台：

- `dist/narrafork-${VERSION}-macos-arm64` — macOS Apple Silicon
- `dist/narrafork-${VERSION}-macos-x64` — macOS Intel
- `dist/narrafork-${VERSION}-linux-x64` / `-linux-x64-baseline` / `-linux-arm64`
- `dist/narrafork-${VERSION}-windows-x64.exe` / `-windows-x64-baseline.exe` / `-windows-arm64.exe`

### 按平台构建

```bash
# 构建所有 macOS / Linux / Windows 版本
bun run build:macos
bun run build:linux
bun run build:windows

# 单独构建特定平台
bun run build:macos-arm64
bun run build:macos-x64
bun run build:linux-x64
bun run build:linux-x64-baseline
bun run build:linux-arm64
```

`--platform=` 支持完整后缀（`darwin-arm64`、`linux-x64`、`windows-x64`）或短别名前缀（`windows`/`linux`/`darwin` 匹配对应 `*-*`）；裸 `arm64` 不会命中。

## 本机稳定运行

`bun run start` 先构建本机单文件运行产物，再从该产物启动后端。
主程序、Worker、迁移及原生依赖固定在同一次构建中；启动后对源码执行 rebase，不会改变后续新建 Worker 使用的代码。它要求先构建整站前端，并将 `dist/frontend` 嵌入产物。
`bun run start:dev` 默认不构建冻结后端，而是在 production 模式运行源码后端，同时启动源码 Vite。后端默认 7778 直接读取磁盘上的 `dist/frontend`，因此执行 `bun run build` 后无需重启后端即可看到新前端；Vite 热重载入口为 41221。
显式 `dev` / `dev:all` / `dev:cold` 仍是源码开发模式，不提供 `start` 的运行隔离。

`start` 的构建不会发布版本，也不会重启或接管已有服务。迁移由新后端取得实例锁后使用内嵌材料执行，不再在启动前单独运行源码迁移；`start:dev` 则在启动源码后端前执行源码迁移。
`start` 构建失败即停止，不回退源码或某个旧版本。构建期间应避免修改源码；运行版本固定不等于构建输入自动取得了 Git 快照。

### 构建一次，多次启动

每次构建输出独占路径以及耗时、产物大小。**日常重启建议复用该路径，代码变更后再构建**：

```sh
# 构建静态前端，并将它嵌入冻结后端
bun run build
bun run build:runtime --frontend

# 通过冻结产物提供静态前端及后端
bun run start --runtime="<构建输出的可执行文件绝对路径>"
```

`start:dev` 默认不使用上述冻结产物，以便 7778 能直接看到后续前端构建。显式为 `start:dev` 传入 `--runtime` 可以改用指定冻结产物，但此时前端也会冻结在该产物中。

`--runtime` 明确选择已有产物，跳过编译；找不到该文件会报错，不自动换一个版本。
后端参数可继续传递，例如 `--no-auto-resume`。不要为了测试上述命令而停止承载会话的服务器；验证请使用独立 HOME、端口和数据库。

产物位于 `NARRAFORK_HOME/runtime/<buildId>/`（默认 `~/.narrafork/runtime/`），成功构建后不自动覆盖或删除。
保留正在使用的版本及需要回退的版本；确认某版本已不被服务、维护子进程或启动配置引用后，才手动删除其整个独占目录。
不要删除正在运行的版本，即使后端已经启动，后续 Worker 和维护子进程仍可能需要它。
本机产物不走正式发行版的自动替换更新；源码更新后重新构建并由操作员选择切换时机。

## 构建流程

构建脚本 `scripts/build-cross-platform.ts` 执行以下步骤：

1. **构建前端** — Vite 构建到 `dist/frontend/`
2. **下载 `@parcel/watcher` 原生二进制** — 8 个平台的 `.node`，绕过 node_modules
3. **生成嵌入清单/数据** — embedded-frontend、embedded-migrations、embedded-postgres-migrations、build-info、embedded-changelog、embedded-licenses
4. **编译可执行文件** — `bun build --compile` 为每个目标平台生成独立二进制
5. **生成校验和与更新元数据** — SHA256SUMS / checksums，以及更新服务器用的 `latest.yml`

## 高级用法

### 跳过前端构建

如果前端已经构建过，可以跳过这一步：

```bash
bun run build:cross --skip-frontend
```

### 指定特定平台

```bash
# 仅构建 Linux 版本
bun scripts/build-cross-platform.ts --platform=linux

# 仅构建某一平台（完整后缀如 linux-arm64 / darwin-arm64，或短别名 windows/linux/darwin）
bun scripts/build-cross-platform.ts --platform=linux-arm64
```

### 本地 alpha 服务端诊断构建

在 Linux x64 上安装项目依赖后，运行：

```bash
make build-alpha
# 可选：指定版本、私有归档目录和 Bun 路径
make build-alpha VERSION=0.9.16-alpha.2 ARCHIVE_DIR="$HOME/private-builds" BUN=bun
```

默认自动选择下一个 alpha 版本，并将 Linux x64 baseline 可执行文件、metadata sidecar、SHA256SUMS 与校验报告验证后归档到仓库内的私有 `.build-alpha-archive/`。自动模式跳过已占用的版本；显式重建会备份同名文件。前端资源在构建锁目录内生成并嵌入诊断版，不会覆盖正常启动使用的 `dist/frontend/`。构建会暂时改写并恢复 `package.json`，不要在同一工作区并行构建或发布。此命令不发布任何产物。

正式入口 [scripts/build-cross-platform.ts](../scripts/build-cross-platform.ts) 在启动时冻结一次后端编译配置，并打印配置名称、严格校验状态、编译参数和实际命令参数数组：

- 合法 SemVer 的 `alpha` 预发布版本（例如 `0.9.10-alpha.9`），在本地默认使用 `diagnostic`：`--keep-names --sourcemap --minify-syntax --minify-whitespace`。
- 非 alpha 版本，或启用了 `CI`、`GITHUB_ACTIONS`、内部 `NF_BUILD_RELEASE_CONTEXT` 的构建，使用 `release`，保持 `--minify`。这三个环境值统一忽略首尾空白和大小写；未设置、空值、`false`、`0` 视为关闭，其余非空值视为开启。
- [scripts/release.ts](../scripts/release.ts) 为构建子进程强制设置 `NF_BUILD_RELEASE_CONTEXT=1`，覆盖继承值。该标记用于内部发布上下文，不是公开 CLI 开关。
- `--release-ci` 只开启严格校验（固定 Bun 版本、完整 commit、平台依赖和 sidecar 等），不选择编译配置。本地 alpha 加上该参数仍使用诊断配置；CI 和发布上下文仍使用发布配置。

主入口和所有显式编译的 worker 共享同一配置。前端仍按原 Vite 配置构建，不因后端诊断配置新增公开 sourcemap，也不改变二进制 metadata schema。

构建和验证使用根目录 `packageManager` 固定的 Bun **1.4.3**，先运行所选 Bun 的 `--version`，并保证子进程沿用同一可执行文件。`--compile` 隐含 production 默认行为，因此诊断能力不能仅凭移除 `--minify` 推断。[tests/scripts/build-profile.test.ts](../tests/scripts/build-profile.test.ts) 用真实 compile fixture 验证函数/类名称、主入口与 worker 原始文件行号，以及 CPU profile 中命名热函数的有效采样；运行前设置独立 `HOME`、`NARRAFORK_HOME`、`TMPDIR/TMP/TEMP` 和 `NARRAFORK_ALLOW_MULTIPLE=1`，使用固定 Bun 执行 `test --isolate ./tests/scripts/build-profile.test.ts`。

普通 compile 的 sourcemap 嵌入二进制，可用于异常堆栈的源码定位；测试删除相邻源文件和 `.map` 后仍验证映射。编译器另行生成的后端 `.map` 副产物只保留在私有构建目录，不放入 `dist/frontend/` 或公开分发。嵌入 map 的诊断二进制本身也可能包含源码，应按敏感构建产物保管。

需要 CPU 采样时，仅在隔离数据目录、独立 loopback 端口的有界调试进程上，通过 `BUN_OPTIONS` 临时设置 `--cpu-prof --cpu-prof-dir=<私有目录> --cpu-prof-name=<名称>.cpuprofile`，正常退出后解析结果；不把采样参数嵌入交付二进制，不增加调试端口或常驻 profiler。保留名称不保证所有匿名函数都有业务名称，嵌入 map 也不保证 Linux perf 自动解析全部 JIT 原生地址。

对正在运行的服务，管理员可用自己的会话 Bearer 令牌调用 `POST /api/diagnostics/cpu-profile`。发送空正文或 JSON `{"durationMs":5000}`（正文最多 1 KiB，默认 15 秒，范围 1–30000 毫秒）。请求等待采样完成并下载 `.cpuprofile`，只采样 HTTP 服务的 JS 线程，不包含独立 Worker 或子进程。每个服务进程同时只接受一次采样（忙时返回 409）；断开请求或正常关闭服务会停止本次采样。

接口不开放调试端口。Bun 1.4.3 不支持与启动时的 `--cpu-prof` / `--cpu-prof-md` 或已启用的 Inspector 调试监听器并用（返回 503）；请勿同时运行其他进程内采样器。采样有开销，建议先用短窗口并在窗口内复现目标负载；空闲线程可能没有样本。文件可能包含函数名和本机源码路径，请存入私有目录，不要公开分享。

### fork 的默认更新仓库

构建时按显式 `NF_BUILD_GITHUB_REPOSITORY=owner/repo`、可信 Actions 仓库、源码 GitHub origin 的顺序确定仓库，无法推导时才使用官方默认值。Actions 中显式值必须等于当前仓库；本地 `release.ts --target=github --github-repository=owner/repo` 会自动传递该构建身份。

该身份同时嵌入前后端和 binary sidecar。运行时不会依据 cwd、用户项目 origin 或运行环境自动切源；新安装采用构建默认值，已有显式保存的来源保持不变。fork 必须自行构建，不能让上游二进制自动变成 fork 包。严格 Release CI 还会交叉核对 bundle、sidecar、smoke 及新安装 settings 的仓库身份。

### 辅助分发依赖

新构建在生成的 build-info 和 sidecar 中声明 `helperDistribution`：固定 helpers catalog/tag，加 `shared/component-versions.json` 锁定的独立 executor version/tag/protocol，不按应用版本重新选择。构建开始冻结同一声明并传入所有后处理 worker，严格构建和八平台 bundle 核对它；旧无声明产物保持兼容。构建与 dry-run 不要求远端已经有辅助 Release，真正主程序发布前才做只读资产就绪与组件构建输入一致性检查。主程序 0.9.2 可以直接复用未变化的 executor 0.9.1；组件实际变化时才显式升组件版本并独立发布。

普通本地 build 只产出 full 和 metadata，不枚举 dist 猜旧基线生成 patch。生产 patch 由 GitHub Release CI 使用此前已公开的原始 GitHub binary/sidecar 单次生成并重建验证；本地上传现存 patch 也须证明公开基线身份，离线无证据时明确拒绝该 patch 而不偷偷联网。独立更新服务器只在 GitHub Release/index 完成后镜像 metadata/当前 patch，不参与构建、补包或主发布门禁。默认 direct，可显式配置 WebDAV 暂存后由服务器主动拉取；两种方式都由服务器校验大小/SHA256，不回传资产给 runner。WebDAV 的 `STAGED_FOR_PULL` 仅表示已暂存，不等于服务器已导入，配置与保留期见 [RELEASE.md](RELEASE.md)。

辅助工具通过独立 `.github/workflows/helpers-release.yml` 构建并原生 smoke，不加入主程序资产；helper/executor/remote-peer 下载选 GitHub 时使用固定仓库/tag，选独立镜像时 manifest 与 binary 都从该镜像获取，冷缓存也不访问 GitHub，镜像失败不回落 GitHub。rg/zstd 各覆盖六平台；Linux zstd 使用固定 Alpine 镜像摘要及源码摘要的 musl 静态 recipe，Windows ARM64 复用固定 llvm-mingw recipe，macOS 原生构建。不要恢复 `Alpine latest`、未经摘要校验的 musl.cc 工具链或 `-march=native`。发布细节、许可附件和显式触发步骤见 [RELEASE.md](RELEASE.md)。

## 远程专用前端与本地静态托管（M2）

同一业务源码有两个编译目标：`bun run build` 保持普通 HTTP/WS 前端和 `dist/frontend/`；`bun run build:remote:assets` 生成 `dist/frontend-remote/`，不含普通启动、PWA/插件 host 或未适配的终端/outline 等模块。远程业务不回退普通 HTTP。

```bash
# 构建远程资源并打包；不会发布、推送或启动 NF
bun run build:remote --output=dist/remote-package
# 已有最新远程资源时可只打包
bun scripts/build-remote-frontend.ts --skip-build --output=dist/remote-package
```

产物为 `narrafork-<version>-remote-frontend.tar.gz` 与同名前缀 `.manifest.json`。版本取当前 package，仓库身份沿用构建来源规则，commit 默认取完整 HEAD；CI 显式冻结目标 SHA。开发工作区的未提交构建不能当成该 SHA 的已发布源码证明。重复相同产物可复用；同版本不同内容请换输出目录，不覆盖已有资产。归档不包含 Vite 的私有源码模块图和开发 metadata。

导入使用独立 CLI 校验摘要、文件清单、预算与安全 tar 路径后原子安装；不在 NF 请求线程解压。下面只启动本机静态 host，不包含信令服务或公网部署：

```bash
VERSION="$(bun --eval 'console.log((await Bun.file("package.json").json()).version)')"
bun scripts/remote-host.ts import --store=.narrafork/remote-host --manifest="dist/remote-package/narrafork-${VERSION}-remote-frontend.manifest.json"
# build-id 替换为导入结果中的实际 64 位摘要；引导包必须显式指定，不自动取 latest
bun scripts/remote-host.ts bootstrap --store=.narrafork/remote-host --build-id="<build-id>"
bun scripts/remote-host.ts serve --store=.narrafork/remote-host --hostname=127.0.0.1 --port=8787
```

不同兼容身份的包可重复导入同一 store；`catalog` 查看清单，`disable --build-id="<build-id>"` 停用，`--disabled=false` 显式恢复。禁止覆盖既有 buildId。运行中的库实例对新导入内容须显式调用 `host.reload()` 完成验证后才服务；改变引导包配置须重新创建独立 host，不能借此重启正在运行的 NF。遗留 `.remote-host.lock` 不自动抢占，需操作者先确认原进程已经停止。

`remote-host/index.ts` 的 `createRemoteHost().assetHandler` 可接入协调服务的 `assetHandler`。业务 `/api/*`、`/ws/*` 和未知静态 chunk 均拒绝，不代理 NF；普通深链只返回轻量引导页。浏览器从可信 RTC hello 取得 **NF 应用版本** 后选择精确匹配模块，未知/禁用版本不回退 latest。实际浏览器使用需要每实例独立 HTTPS origin 与 WSS 信令；localhost 仅用于显式隔离测试。公网监听额外要求 `--allow-public-tls`、`--tls-cert`、`--tls-key` 和 `--instance-domain`，本轮未实际部署。

真实 NF 管理入口在普通前端“设置 → 远程访问”：先显式安装匹配 peer，配置协调服务/STUN，再启用并创建邀请；默认关闭，状态查询不会下载或启动进程。配对后仍须管理员密码及既有 MFA。支持项目、叙述者聊天/审批、SSE 和有界小附件；未适配功能明确禁用。

## 交叉编译说明

### 从 Linux x86 构建 macOS 版本

Bun 支持交叉编译，你可以在 Linux x86 机器上直接构建 macOS 版本：

```bash
bun run build:macos
```

生成的二进制文件可以直接在 macOS 上运行，无需在 macOS 机器上重新编译。

### 注意事项

1. **内置依赖** - SQLite 通过 `bun:sqlite` 内置模块使用，已包含在编译后的二进制文件中
2. **外部依赖** - 目标系统需要安装：
   - Git（必需）
   - Podman（可选，用于容器功能）
3. **数据库位置** - 默认在 `~/.narrafork/narrafork.db`
4. **配置文件** - 默认在 `~/.narrafork/settings.json`

## 分发

编译后的可执行文件是完全独立的，包含：
- Bun 运行时
- 所有 Node.js 依赖
- 前端静态资源
- SQLite 数据库引擎

用户只需：
1. 下载对应平台的可执行文件
2. 添加执行权限（macOS/Linux）：`chmod +x narrafork-*`
3. 运行：`./narrafork-${VERSION}-macos-arm64`（文件名含版本号）

首次运行会自动：
- 创建 `~/.narrafork/` 目录
- 初始化数据库
- 生成默认配置

## 故障排查

### macOS Gatekeeper 警告

macOS 可能会阻止未签名的应用。用户需要：

```bash
# 移除隔离属性
xattr -d com.apple.quarantine narrafork-${VERSION}-macos-arm64

# 或在系统设置中允许运行
```

### 权限问题

确保可执行文件有执行权限：

```bash
chmod +x dist/narrafork-*
```

### 构建失败

1. 确保 Bun 版本 ≥ 1.2：`bun --version`
2. 清理并重试：
   ```bash
   rm -rf dist/ server/generated/
   bun run build:cross
   ```

## CI/CD 集成

可以在 GitHub Actions 中使用：

```yaml
- uses: oven-sh/setup-bun@v1
- run: bun install
- run: bun run build:cross
- uses: actions/upload-artifact@v4
  with:
    name: binaries
    path: dist/narrafork-*
```

## 相关命令

- `bun run build` — 仅构建前端
- `bun run build:cross` — 构建所有平台
- `bun run build:cross --platform=linux-x64` — 构建指定平台
- `bun run build:update-server` — 构建更新服务器
- `bun run build:android-rootfs` — 构建 Android rootfs
- `bun run build:runtime` — 构建本机冻结后端；加 `--frontend` 嵌入已有静态前端
- `bun run start` — 构建并运行本机产物及静态前端；`--runtime=<path>` 复用已构建版本
- `bun run start:dev` — 源码后端直接提供磁盘静态前端，额外提供源码 Vite 热重载入口；显式 `--runtime=<path>` 可改用冻结产物
