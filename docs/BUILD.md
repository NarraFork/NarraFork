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

新构建在生成的 build-info 和 sidecar 中声明 `helperDistribution`：固定 helpers catalog/tag，加应用版本对应的 executor tag/protocol。严格构建和八平台 bundle 核对同一声明；旧无声明产物保持兼容。构建与 dry-run 不要求远端已经有辅助 Release，真正主程序发布前才做只读就绪检查。

辅助工具通过独立 `.github/workflows/helpers-release.yml` 构建并原生 smoke，不加入主程序资产。rg/zstd 各覆盖六平台；Linux zstd 使用固定 Alpine 镜像摘要及源码摘要的 musl 静态 recipe，Windows ARM64 复用固定 llvm-mingw recipe，macOS 原生构建。不要恢复 `Alpine latest`、未经摘要校验的 musl.cc 工具链或 `-march=native`。发布细节、许可附件和显式触发步骤见 [RELEASE.md](RELEASE.md)。

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
