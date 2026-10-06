# 构建指南

本文档说明如何为不同平台构建 NarraFork 可执行文件。

## 快速开始

### 构建所有平台

```bash
bun run build:cross
```

这会生成以下可执行文件：
- `dist/narrafork-macos-arm64` - macOS Apple Silicon (M1/M2/M3)
- `dist/narrafork-macos-x64` - macOS Intel
- `dist/narrafork-linux-x64` - Linux x86_64
- `dist/narrafork-linux-arm64` - Linux ARM64

### 按平台构建

```bash
# 构建所有 macOS 版本
bun run build:macos

# 构建所有 Linux 版本
bun run build:linux

# 单独构建特定平台
bun run build:macos-arm64    # macOS ARM64
bun run build:macos-x64      # macOS x64
bun run build:linux-x64      # Linux x64
bun run build:linux-arm64    # Linux ARM64
```

## 构建流程

构建脚本 `scripts/build-cross-platform.ts` 执行以下步骤：

1. **构建前端** - 使用 Vite 将 React 应用构建到 `dist/frontend/`
2. **生成嵌入清单** - 扫描前端资源并生成 `server/generated/embedded-frontend.ts`
3. **编译可执行文件** - 使用 `bun build --compile` 为每个目标平台生成独立二进制文件

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

# 仅构建 ARM64 版本
bun scripts/build-cross-platform.ts --platform=arm64
```

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
3. 运行：`./narrafork-macos-arm64`

首次运行会自动：
- 创建 `~/.narrafork/` 目录
- 初始化数据库
- 生成默认配置

## 故障排查

### macOS Gatekeeper 警告

macOS 可能会阻止未签名的应用。用户需要：

```bash
# 移除隔离属性
xattr -d com.apple.quarantine narrafork-macos-arm64

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

- `bun run build` - 仅构建前端
- `bun run build:cross` - 构建所有平台
- `bun run build:cross --platform=linux-x64` - 构建指定平台
- `bun run start` - 开发模式运行（不编译）
