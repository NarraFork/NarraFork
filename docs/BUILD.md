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
- `bun run start` — 生产模式运行（跑迁移 + 后端 + 静态前端，不编译独立二进制）
