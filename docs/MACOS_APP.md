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
    Info.plist                 — bundle id / 版本 / 图标 / 最低系统 11.0 / 类别 developer-tools / LSUIElement（无 Dock 图标，纯状态栏 agent）
    MacOS/
      NarraFork                — CFBundleExecutable：编译型 Mach-O 启动器（scripts/macos-app/launcher.m）
      narrafork-server         — bun build --compile 产出的真实二进制
    Resources/
      AppIcon.icns             — 由 frontend/public/pwa-512x512.png 经 iconset/iconutil 生成
```

启动器行为（launcher.m，~470 行 Objective-C，打包时用 `clang -fobjc-arc -framework Cocoa -arch <arch>` 编译）：

- **状态栏常驻**：`NSApplicationActivationPolicyAccessory`（LSUIElement=true）——无 Dock 图标、无 Cmd-Tab 项，只在菜单栏放一个 18pt template 图标（按 favicon 的 fork 形状用 NSBezierPath 手绘，自动适配深浅菜单栏）。图标 tooltip 为「NarraFork」。
- **状态栏菜单**（中英文随系统语言）：
  - 状态行（只读）：`● NarraFork · localhost:7778` / `◐ …starting…` / `○ …stopped`；**无轮询**——刷新由三个事件源驱动：① 自家 NSTask 的 terminationHandler、② `~/.narrafork/` 目录的 VNODE dispatch source（实例锁 `narrafork.lock` 增删即事件）、③ 每次展开菜单时 `menuWillOpen:` 按需探测一次
  - `Open NarraFork` ⌘O — `open http://localhost:<port>/`
  - `Open in app window` ⇧⌘O — 用 `open -a <浏览器> url --args --app=<url>` 开 Chrome/Edge/Chromium 无边窗口（找到第一个装了的浏览器）
  - `View log` ⌘L — `open ~/.narrafork/narrafork-app.log`（系统默认关联，一般为控制台.app）
  - `Launch at login` — 开关写 `~/Library/LaunchAgents/<bundle-id>.plist`（RunAtLoad，ProgramArguments 指向包内可执行体）
  - `Stop server`/`Start server` ⌘S — NSTask 终止/重启；只有本 app 拉起的进程才允许 Stop（防止杀掉外部部署的服务）
  - `Quit NarraFork` ⌘Q — 退出时对本 app 拉起的 NSTask 发 SIGTERM（服务端走完整 graceful shutdown、释放实例锁）
- **已运行 → 聚焦**：启动时探测 `~/.narrafork/settings.json` 的 `server.port`（或 `--port=`），扫描该端口起 11 个端口的 `GET /api/health`；命中则不再起服务，菜单操作直接开页面。同 bundle-id 已有运行实例时，新实例只打开页面后立即退出（单实例语义）。
- **未运行 → 启动**：NSTask 拉起同目录的 `narrafork-server`，stdout/stderr 追加到 `~/.narrafork/narrafork-app.log`，注入 `NARRAFORK_APP_BUNDLE=1`；terminationHandler 里刷新菜单状态。
- 服务端原有的「启动后自动开浏览器」逻辑（`server.openBrowser`）不变；设置里选 `app` 模式会以 Chrome/Edge 的 `--app=` 无边窗口打开，接近桌面应用观感。

## 当前做到 / 没做到的

| 体验环节 | 现状 | 缺口 |
|----------|------|------|
| 下载载体 | DMG，含 Applications 拖拽链接 | DMG 窗口排版/背景图（需 AppleScript/dmgbuild 类定制） |
| 安装 | 拖进 /Applications 即可 | — |
| 首次启动 | 双击即起服务 + 自动开浏览器 | **未签名/未公证**：下载来的 app 带 quarantine，首次需「右键 → 打开」或 `xattr -dr com.apple.quarantine NarraFork.app`。ad-hoc `codesign -` 只把「已损坏」降级为「无法验证开发者」，不消除拦截 |
| 再次启动 | 探测到服务 → 只打开页面；同 bundle-id 已运行则直接退出 | 服务端在启动中途（几秒内）探测未命中仍会尝试拉起并撞实例锁（错误进 app.log，无 GUI 提示） |
| 状态栏 | template 图标 + 菜单：状态/打开/应用窗口/日志/开机自启/停启服务/退出 | 菜单内无会话列表/通知等更深层 UI |
| 更新 | 沿用既有自更新机制（二进制级） | 更新替换的是 `Contents/MacOS/narrafork-server`；如自更新改写的是整个 dist 路径而非就地更新，需要确认落点在 app 包内（未验证） |
| 图标 | pwa-512x512 生成，1024 槽位为放大 | 正式版应提供 1024px 源图（渲染 favicon.svg）；状态栏图标目前是路径手绘、较小的笔画可再调 |
| 退出 | 状态栏菜单 ⌘Q → SIGTERM 本 app 拉起的进程 | 若服务由外部方式启动，退出 app 不影响服务（设计如此） |
| 开机自启 | LaunchAgent plist 开关（菜单项勾选） | 未走 `SMAppService` 的 ServiceManagement 注册流程，正式版可用 SMAppService.mainApp 统一 |
| 卸载 | 删 .app + `~/.narrafork/` | — |

## 走向正式分发还缺什么

1. **Developer ID 签名 + 公证**：`codesign --options runtime` + `xcrun notarytool submit --wait` + `stapler staple`。需要 Apple Developer Program 证书；CI 上把证书放 keychain。hardened runtime 下 bun 编译产物大概率要 entitlement：`com.apple.security.cs.allow-unsigned-executable-memory`（JIT）。
2. **启动器须保持 Mach-O**：公证要求 bundle 内可执行体可签名，shell 脚本当 CFBundleExecutable 无法正确签署——所以选编译型启动器而非包装脚本。
3. **自更新落点**：确认现有 update 流程对「app 包内二进制」的工作方式；或者仿 Windows manager，让一个外部小工具完成「停服务 → 换包 → 重启」。
4. **安装器选择**：DMG 保持现状即可；pkg/`.pkg` + `productbuild` 可做「安装到 /Applications + 可选 LaunchAgent」的向导式安装，但 macOS 惯例是 DMG 拖拽。
5. **登录项方案升级**：实验版已用 `~/Library/LaunchAgents/<bundle-id>.plist` 开关；正式版可换 `SMAppService.mainApp`（系统设置里有统一管理入口，且能在主设置页里挂开关）。
6. **x64/arm64 双架构**：两个单架构包已可分别产出；universal 需 `lipo` 合并启动器 + 两份二进制或 universal2 的 bun 产物（bun --compile 目前出单架构，合并会加倍体积）。

## 验证记录（本机 arm64, macOS 26）

- `bun run build:macos-arm64` → `dist/narrafork-0.9.15-macos-arm64`
- `bun scripts/build-macos-app.ts --dmg` → `dist/macos-app-arm64/NarraFork.app`（173 MB，ad-hoc 签名）+ `dist/narrafork-0.9.15-macos-arm64.dmg`（63 MB）
- `open dist/macos-app-arm64/NarraFork.app`：服务起来、`GET /api/health` 200、浏览器自动打开页面；状态栏出现 fork 形 template 图标（tooltip「NarraFork」），Dock 中无图标
- 状态栏菜单实测：7 项全部渲染——状态行「● NarraFork · localhost:7778」、Open NarraFork ⌘O、Open in app window ⇧⌘O、View log ⌘L、Launch at login、Stop server ⌘S、Quit NarraFork ⌘Q；AX 树可列出全部 selector
- 事件驱动状态迁移实测（无定时器）：外部 SIGTERM 杀服务 → lock 删除 → 状态变 ○ stopped；菜单 Start server → lock 出现 → 有界探测链到 ● running；菜单 Stop server → terminationHandler → ○ stopped
- `Quit NarraFork`：NSTask 收到 SIGTERM，服务端走完整 graceful shutdown、释放实例锁（`narrafork-app.log` 记录 `clean`）；launcher 与 server 进程均退出（Apple Event quit 同路径验证）
- 服务运行中再次 `open`：同 bundle-id 实例探测后只打开页面即退出，进程数保持 1
- 实测坑：服务端 `host=localhost` 在 macOS 绑的是 `[::1]`（IPv6），探测必须双栈；`open` 目标用 `localhost` 而非 `127.0.0.1`
