# macOS `.app` 打包（实验性）

状态：**实验** — 探索「下载 → 拖进 Applications → 双击即用」的 macOS 常规安装体验，替代目前「下载裸二进制 → `chmod +x` → 终端里跑 → 手动去隔离属性」的流程。

分支：`devin/*-macos-app-experiment`。不影响现有发布链路（`build:cross`/release.ts 产出的裸二进制、GitHub Release、更新镜像都不变）。

## 用法

```bash
# 1. 照常构建 macOS 二进制（含前端构建）
bun run build:macos-arm64

# 2. 打包成 NarraFork.app（+ 可选 DMG）
bun scripts/build-macos-app.ts --dmg
```

产物：

- `dist/macos-app-arm64/NarraFork.app` — 可双击的应用
- `dist/narrafork-<version>-macos-arm64.dmg` — 内含 `NarraFork.app` 和 `/Applications` 拖拽快捷方式

也可直接指向已有二进制：`bun scripts/build-macos-app.ts --binary=<path> --arch=x64 --dmg`。

## 包结构

```
NarraFork.app/
  Contents/
    Info.plist                 — bundle id / 版本 / 图标 / 最低系统 11.0 / 类别 developer-tools
    MacOS/
      NarraFork                — CFBundleExecutable：编译型 Mach-O 启动器（scripts/macos-app/launcher.c）
      narrafork-server         — bun build --compile 产出的真实二进制
    Resources/
      AppIcon.icns             — 由 frontend/public/pwa-512x512.png 经 iconset/iconutil 生成
```

启动器行为（launcher.c，~150 行 C，打包时用 `clang -arch <arch>` 编译）：

- **已运行 → 聚焦**：探测 `~/.narrafork/settings.json` 的 `server.port`（或 `--port=`），扫描该端口起 11 个端口的 `GET /api/health`；命中则 `open http://127.0.0.1:<port>/` 并退出。双击一个已在运行的 .app 不再静默撞实例锁，而是把页面带到前台——符合 macOS 应用直觉。
- **未运行 → 启动**：stdout/stderr 追加到 `~/.narrafork/narrafork-app.log`，注入 `NARRAFORK_APP_BUNDLE=1`，`exec` 同目录的 `narrafork-server`。`exec` 保持同一进程，Dock 上「退出」= 直接 SIGTERM 服务端。
- 服务端原有的「启动后自动开浏览器」逻辑（`server.openBrowser`）不变；设置里选 `app` 模式会以 Chrome/Edge 的 `--app=` 无边窗口打开，接近桌面应用观感。

## 当前做到 / 没做到的

| 体验环节 | 现状 | 缺口 |
|----------|------|------|
| 下载载体 | DMG，含 Applications 拖拽链接 | DMG 窗口排版/背景图（需 AppleScript/dmgbuild 类定制） |
| 安装 | 拖进 /Applications 即可 | — |
| 首次启动 | 双击即起服务 + 自动开浏览器 | **未签名/未公证**：下载来的 app 带 quarantine，首次需「右键 → 打开」或 `xattr -dr com.apple.quarantine NarraFork.app`。ad-hoc `codesign -` 只把「已损坏」降级为「无法验证开发者」，不消除拦截 |
| 再次启动 | 探测到服务 → 只打开页面 | 若服务端在启动中途（几秒内），探测未命中仍会尝试 exec 并撞实例锁（错误进 app.log，无 GUI 提示） |
| 更新 | 沿用既有自更新机制（二进制级） | 更新替换的是 `Contents/MacOS/narrafork-server`；如自更新改写的是整个 dist 路径而非就地更新，需要确认落点在 app 包内（未验证） |
| 图标 | pwa-512x512 生成，1024 槽位为放大 | 正式版应提供 1024px 源图（渲染 favicon.svg） |
| 退出 | Dock ⌘Q / 菜单退出 → SIGTERM | 无状态栏菜单、无「开机自启」开关（可做 LaunchAgent/`SMAppService`） |
| 卸载 | 删 .app + `~/.narrafork/` | — |

## 走向正式分发还缺什么

1. **Developer ID 签名 + 公证**：`codesign --options runtime` + `xcrun notarytool submit --wait` + `stapler staple`。需要 Apple Developer Program 证书；CI 上把证书放 keychain。hardened runtime 下 bun 编译产物大概率要 entitlement：`com.apple.security.cs.allow-unsigned-executable-memory`（JIT）。
2. **启动器须保持 Mach-O**：公证要求 bundle 内可执行体可签名，shell 脚本当 CFBundleExecutable 无法正确签署——所以选编译型启动器而非包装脚本。
3. **自更新落点**：确认现有 update 流程对「app 包内二进制」的工作方式；或者仿 Windows manager，让一个外部小工具完成「停服务 → 换包 → 重启」。
4. **安装器选择**：DMG 保持现状即可；pkg/`.pkg` + `productbuild` 可做「安装到 /Applications + 可选 LaunchAgent」的向导式安装，但 macOS 惯例是 DMG 拖拽。
5. **Gatekeeper 之外的登录项**：`SMAppService.mainApp`/`launchd` plist 生成放在 `~/Library/LaunchAgents`，由设置页「开机自启」开关写入，不走安装包。
6. **x64/arm64 双架构**：两个单架构包已可分别产出；universal 需 `lipo` 合并启动器 + 两份二进制或 universal2 的 bun 产物（bun --compile 目前出单架构，合并会加倍体积）。

## 验证记录（本机 arm64, macOS 26）

- `bun run build:macos-arm64` → `dist/narrafork-0.9.15-macos-arm64`
- `bun scripts/build-macos-app.ts --dmg` → `dist/macos-app-arm64/NarraFork.app`（173 MB，ad-hoc 签名）+ `dist/narrafork-0.9.15-macos-arm64.dmg`（63 MB）
- `open dist/macos-app-arm64/NarraFork.app`：服务起来、`GET /api/health` 200、浏览器自动打开页面
- 服务运行中再次 `open`：launcher 探测到 `::1` 上的健康端点，exec `open` 后退出——不再 exec 服务端、不撞实例锁（进程数保持 1）
- `SIGTERM`（等价 Dock 退出）：服务端走完整 graceful shutdown、释放实例锁（见 `~/.narrafork/narrafork-app.log`）
- 实测坑：服务端 `host=localhost` 在 macOS 绑的是 `[::1]`（IPv6），探测必须双栈；`open` 目标用 `localhost` 而非 `127.0.0.1`
