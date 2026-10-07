# Electrobun 桌面外壳

本文档说明 NarraFork 桌面版（Electrobun 打包）的架构、资产解析规则和构建方式。

桌面版与既有的两条发布路径**并存互不影响**：`bun run start`（源码运行）和 `bun run build:cross`（单文件二进制）都未改动。

## 现状

| 项目 | 状态 |
| --- | --- |
| 外壳配置与启动器 | 已完成 |
| 工具链版本 | electrobun 2.0.2-beta.27 / hutch 0.27.0-canary.8 / cottontail 0.7.0-canary.10 / Bun 1.4.0 |
| Linux 包构建 | 已验证 |
| 窗口渲染 | **已验证**（容器 + Xvfb 截图取证，见「窗口层验证」） |
| 前端加载与表单交互 | **已验证**（真实 webview 渲染并响应合成键盘输入） |
| WebSocket 升级 | **已验证**（打包环境握手返回 101） |
| 登录全流程 / 终端 | **部分验证**：API 层通过，UI 端到端未走完 |
| `mainProcess: "cottontail"` | **不可用**，见「为什么仍用 Bun 主进程」 |
| Windows 包 | **未构建**，Electrobun 不支持交叉编译 |

## 后台运行与托盘

- 托盘可用时，关闭主窗口仅关闭窗口，服务端和正在执行的任务继续运行；托盘菜单「打开主窗口」恢复窗口，「退出 NarraFork」执行服务端完整优雅关闭后退出。
- 窗口重开不会重新启动服务端。启动中关窗也会缓存就绪地址或错误页面，重开时恢复。
- 菜单根据进程的 `LC_ALL` / `LC_MESSAGES` / `LANG` 选择中英文；目前不跟随网页内语言切换。
- Linux 需要 StatusNotifier 托盘宿主（例如 XFCE 状态托盘、KDE，GNOME 需相应扩展）和 `gdbus`（Debian 系为 `libglib2.0-bin`）。探测超时、命令缺失或托盘创建失败时，窗口标题提示「关闭窗口将退出」，不留下无入口的后台进程。
- 后台运行不等于开机自启；本次不注册系统服务或登录自启。
- 2026-09-23 验证：10 项隔离单元测试通过；XFCE + Xvfb 容器中图标可见，真实 WM_DELETE_WINDOW 后健康接口仍为 ready，托盘菜单重开窗口，退出后进程和 HTTP 均停止，日志 `reason: desktop_quit` / `cleanMarked: true`。无托盘宿主时，标题警告和关窗退出也已验证。最终包已显示初始化账户页面。
- 同时修正桌面探针/导航地址：保留 `localhost` 的 IPv6 解析，通配监听地址转换为对应 loopback，IPv6 字面量加方括号，避免服务已启动但窗口一直停在加载页。

### Linux 分发形式

当前提供 `linux-x64-NarraFork-Setup.tar.gz`，解压后运行 `installer`，并非唯一的打包方向。此版本 SDK 可通过 `build.linux.flatpak` 生成 Flatpak 配方和载荷，但仍需额外执行 `flatpak-builder`。也可以另行封装目录压缩包、deb/rpm；这些形式需要自行维护桌面集成与系统依赖，不是现有安装器的开关。当前未产出这些额外格式。

## 架构：启动器 + 内嵌服务端（单进程）

`desktop/main.ts` 是一个薄启动器，不重复实现任何服务端逻辑：

1. 把 `NARRAFORK_HOME` 指向平台 userData 目录
2. **先开窗口**并显示内置加载页
3. 后台 `import("../server/index")` 启动服务端（顶层副作用模块，import 即启动，与 `bun run start` 一致）
4. 轮询 `/api/health`，就绪后把窗口导航到 `http://127.0.0.1:<port>`
5. 失败时在窗口内显示错误和日志路径

**先开窗口再等服务端是有意的**：冷启动要初始化数据库、跑迁移、构建整个服务图，耗时可达数十秒。显示加载态是「正在启动」和「应用坏了」的区别。

**端口不能硬编码**。服务端在端口冲突时会重试（`server/main.ts` 的 `MAX_PORT_RETRIES`），实际端口只有 `getRuntimeAddress()`（`server/lib/server-restart.ts`）知道。启动器每次轮询都重新读取，而不是读一次配置值。

**数据目录必须隔离**。数据库实例锁是排他的，若桌面版用 `~/.narrafork`，会和同机的开发实例互相抢锁，后启动的直接失败。`Utils.paths.userData` 已包含 app identifier。

### 为什么仍用 Bun 主进程（Cottontail 实测不可用）

Cottontail 表面上很有吸引力：包体 140MB vs 160MB，且 `bun:sqlite`（含 WAL 与 FTS5 trigram CJK 检索）、`Bun.serve`、`Bun.spawn`、`Bun.Terminal`、`bun:ffi`、`worker_threads`、`crypto.subtle`、`node:zlib` 全部与真实 Bun 行为一致；完整服务端能在其下启动，窗口层也能渲染登录页。

但有三个实测阻塞项，其中第一个是硬阻塞：

**1. 子进程无法加载异步 bundle（硬阻塞）。** 服务端通过重新拉起自身入口来跑辅助进程（完整性探针、文件监视器）。Cottontail 下这些子进程直接失败：

```
TypeError: require() async module ".../app/bun/index.js" is unsupported. use "await import()" instead.
    at //.cottontail-embedded-runtime/bun/ffi.js:3851:20
```

Cottontail 内嵌运行时的 FFI 兼容层用 `require()` 加载 bundle，而带顶层 `await` 的 bundle 是异步模块。**这个失败点在我们代码之外**，无法通过应用侧改动绕开。同一份代码打成 Bun 包时探针 6ms 正常返回，Cottontail 包挂起 2 分钟不返回（进程睡在 `do_sys_poll`）。

**2. glibc 基线高出很多。** Cottontail 二进制要求 `GLIBC_2.38` / `GLIBCXX_3.4.32`，Bun 只要 `GLIBC_2.17`。实际后果：Cottontail 包在 Debian 12（glibc 2.36）上**根本起不来**，需要 Debian 13 / Ubuntu 24.04 及更新；Bun 包可以覆盖到 Debian 11 / CentOS 7 级别的老系统。

**3. 构建期偶发 SIGSEGV。** `hutch electrobun build` 用 Cottontail 0.5.0 时约一半概率崩溃（本次会话 3 次），重跑即过。构建期可以重试，但同一运行时用在生产环境里不让人放心。

因此保持 `mainProcess: "bun"`：真实 Bun 运行时与 `bun run start` 的生产行为完全一致，不依赖兼容层。官方迁移文档也把保留 `mainProcess: "bun"` 列为 v1 Bun 应用的最低风险路径。

那些 Cottontail 兼容改动仍然保留（`server/lib/webcrypto-globals.ts` 的 WebCrypto 全局注入、WASM 动态导入、`scripts/patch-cottontail-modules.ts` 的换行补丁）：在真实 Bun 下是 no-op 或等价行为。附带发现——它们针对的两个 Cottontail 0.2.3 缺陷（`CryptoKey` 全局缺失、无尾换行模块加载失败）在 0.5.0 上就已修复，0.7.0-canary.10 亦然。

## 资产解析规则（最容易踩坑的部分）

打包后的实测路径：

```
import.meta.dir  = <app>/Resources/app/bun      ← 主进程 bundle 所在
cwd              = <app>/Resources/app          ← 由 desktop/main.ts 设定
copy 落地位置     = <app>/Resources/app/<目标>    ← 比 import.meta.dir 高一层
```

| 资产 | 进包方式 | 运行时定位 |
| --- | --- | --- |
| `dist/frontend` | `copy` | 服务端解析 `<模块目录>/../dist/frontend`，故 copy 到 `dist/frontend` |
| `drizzle/` 迁移 | `copy` | 服务端按 cwd 相对路径 `./drizzle` 查找，故 cwd 设为 app root |
| tree-sitter `.wasm` | bundler 自动嵌入 | 按 `import.meta.dir` resolve |
| `@parcel/watcher` `.node` | bundler 自动嵌入 | 按 `import.meta.dir` resolve |
| `librust_pty`（bun-pty） | `copy` | 通过 `BUN_PTY_LIB` 环境变量显式指定 |

选择 `copy` 还是 bundler 自动嵌入，取决于依赖边是否可被静态分析：`import ... with { type: "file" }` 声明的资产 bundler 能跟随并嵌入；FFI / `dlopen` 加载的共享库无法被任何 bundler 跟随，只能 `copy` + 显式路径。

### 为打包修掉的四个真实缺陷

这些不是迁就打包的 workaround，是打包场景暴露的真实 bug：

**1. 资产路径可能是相对的**（`server/lib/agent/bash-analyze.ts`、`scripts/download-parcel-watcher.ts`）

`with { type: "file" }` 返回的说明符在 `bun run` 下是真实绝对路径，在 `bun build --compile` 下是 `$bunfs` 绝对路径，但 Electrobun 的 bundler 返回**相对于 bundle 的路径**（如 `./tree-sitter-<hash>.wasm`）。直接 `Bun.file(raw)` / `readFileSync(raw)` 在 cwd 不等于 bundle 目录时必然 ENOENT。

修复：`isAbsolute(v) ? v : resolve(import.meta.dir, v)`。对前两种绝对形式是 no-op，三种运行时都得到可读的绝对路径。

`parcel-native-loader.ts` 是生成文件，所以改的是生成器 `scripts/download-parcel-watcher.ts`，然后 `bun scripts/download-parcel-watcher.ts` 重新生成。

**2. bun-pty 在 import 时就解析 Rust 库**（`server/terminal/runtime-pty.ts`）

`bun-pty` 在模块加载阶段通过 Bun FFI 解析 `librust_pty`，解析失败直接抛异常。静态 import 会把一个**只有 Windows 才使用**的终端后端变成全平台硬启动依赖：Linux/macOS 走 `Bun.Terminal`，`spawnPortablePty` 根本不会被调用，但服务端照样起不来。

修复：改为 lazy `require`，失败点回到真正请求 portable PTY 的调用帧。

**3. 运行时地址无法从外部读取**（`server/lib/server-restart.ts`）

新增导出 `getRuntimeAddress()`。此前只有注册接口没有读取接口，嵌入方无法得知服务端实际绑定的端口。

**4. 辅助子进程会重新打开窗口**（`desktop/main.ts`、`server/db/integrity-check.ts`）

服务端的完整性探针和文件监视器都靠「用标志重新拉起自身入口」实现。打包后那个入口就是 `desktop/main.ts`，于是两处同时出错：

- `integrity-check.ts` 从模块 URL 推导出 `<app>/Resources/app/index.ts`，该文件不存在（`isCompiledRuntime()` 只识别 `$bunfs`/`%7EBUN`，而 bundle 报告的是真实磁盘路径），每次探针都变成 `unavailable`；
- 即使路径正确，`desktop/main.ts` 静态 `import { BrowserWindow } from "electrobun/main"` 会在**模块求值阶段**通过 FFI 调用 `setExitOnLastWindowClosed`，于是每个 worker 子进程都试图初始化窗口层——缺原生库时直接抛异常，父进程则一直等在 stdout 上。

完整性探针和 native watcher 的父进程都会识别 bundle 形态并复用 bundle 自身作为入口；源码模式从模块 URL 定位绝对 `server/index.ts` 路径，不依赖 cwd。`desktop/main.ts` 先检查 worker 标志，命中就只 `await import("../server/index")`，把 `electrobun/main` 降级为动态 import（仅应用分支才加载）。

桌面退出与管理员关闭共用同一个清理 Promise：即使管理员关闭还在等待响应宽限期，托盘退出也必须等完整清理完成，不能因关闭已排程而跳过等待。清理拒绝或返回失败时保留退出失败状态，允许重试。

桌面应用版本直接读取 `package.json`，不再维护独立版本常量。复制过来的 `artifacts/` 是旧基线产物，不代表当前源码的发布包；发布前须重新构建。

实测：修复前探针挂起或报 `Module not found`；修复后 Bun 包报 `integrity check passed`，耗时 6ms。

## 构建

### Linux / macOS

```bash
bun run build                                  # 前端 → dist/frontend
export PATH="$HOME/.hutch/bin:$PATH"
hutch electrobun build --env=dev                # 开发包
hutch electrobun build --env=stable             # 正式包
```

构建环境只有 `dev`、`canary`、`stable`。早期 2.x 预览版用的 `production` 已退休，**且不是别名**，传入会报错。

首次需要安装 hutch 工具链：

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://hutch.blackboard.sh/hutch/install.sh -o /tmp/install-hutch.sh
sh /tmp/install-hutch.sh --channel production --no-modify-path
```

### Windows

**Electrobun 不支持交叉编译**，Windows 包必须在 Windows 上构建。构建目标在 CLI 内硬编码为宿主平台（`{ os: OS, arch: ARCH }`，取自 `os.platform()`/`os.arch()`），`hutch electrobun build` 只接受 `--env`，没有目标平台参数。官方文档与 CI 示例均确认这一点。

```powershell
$script = irm https://hutch.blackboard.sh/hutch/install.ps1
& ([scriptblock]::Create($script)) -Channel production

bun install
bun run build
hutch electrobun build --env=stable
```

### 工具链版本与配对关系

三个组件的版本不是各自独立选的，而是一条配对链，`hutch.config.ts` 把整条链钉死：

```ts
// @hutch cli=0.27.0-canary.8 cottontail=0.7.0-canary.10
export default { electrobun: { version: "2.0.2-beta.27" } };
```

配对来源是 electrobun 该版本 GitHub release 里的 `hutch-artifacts.json`（声明 `hutch.version`）；build-time Cottontail 与该 hutch 的发布通道配对（2.0.2-beta.27 与上游 `kitchen/hutch.config.ts` 一致，钉 `0.7.0-canary.10`）。不要凭猜测组合版本：beta.19 起 electrobun 要求 hutch ≥ 0.16，beta.24 起要求 hutch ≥ 0.24，2.0.2-beta.17+ 的稳定对曾是 hutch 0.26.0 + cottontail 0.6.0，beta.27 已推进到 canary 对。

pragma 只影响本项目，hutch 把各版本并存存放，所以升级全局 selection 不会破坏其他 pin 了旧版的项目：

```bash
hutch self update 0.27.0-canary.8  # 全局 selection
hutch cottontail update 0.7.0-canary.10
hutch status                       # 核对 pragma → 实际生效版本
```

beta.19 起 electrobun **不再分发 Bun**，改由 devkit 钉住 Bun 版本（2.0.2-beta.27 仍是 Bun 1.4.0），`hutch electrobun sync` 会自动拉取该工具链。`mainProcess: "bun"` 仍是受支持的选项，无需改成 cottontail。

### GitHub 不可达时

Electrobun 的 core/CEF 资产托管在 GitHub releases，`electrobun-artifacts.json` 内的下载地址是硬编码的 github.com 且受 hutch 可信 host 校验，**`ELECTROBUN_RELEASES_BASE_URL` 指向镜像会直接报 `UntrustedElectrobunArtifactUrl`**。可行路径只有从镜像下载后通过官方支持的环境变量指定本地 devkit：

```bash
# 期望 sha256 取自该版本的 electrobun-artifacts.json（platforms.linux-x64.core.sha256），
# 该索引文件本身也可经镜像拉取
mkdir -p ~/.cache/electrobun-devkit && cd ~/.cache/electrobun-devkit
curl -fL -o core.tar.gz \
  "https://ghfast.top/https://github.com/blackboardsh/electrobun/releases/download/v2.0.2-beta.27/electrobun-core-linux-x64.tar.gz"
echo "d346de866690b823ca152562f8cb8903cb26993243c336003871ae5fc599d1ae  core.tar.gz" | sha256sum -c -

mkdir -p beta27 && tar -xzf core.tar.gz -C beta27
export HUTCH_ELECTROBUN_DEVKIT_ROOT="$HOME/.cache/electrobun-devkit/beta27"
```

hutch 自身和 Bun 工具链走 `hutch.blackboard.sh` 与 `oven-sh` 直连，实测可达，不需要镜像。

不要手工往 hutch 全局存储里放文件——路径命名规则未公开，猜测写入会留下无效孤儿文件。

## 验证

### 无窗口层（无图形环境亦可）

服务端本身不需要 GTK/WebKit，但**打包后的主进程 bundle 不能在无 WebKitGTK 的机器上直跑**：`electrobun/main` 的 `BrowserWindow` 模块在 import 阶段就调用 `setExitOnLastWindowClosed`，FFI 加载 `libNativeWrapper.so` 失败会直接抛出 `Electrobun FFI is unavailable`。这与 electrobun 版本无关（beta.12 和 beta.27 的 `libNativeWrapper.so` 缺失依赖完全相同）。

要在无图形环境验证服务端侧，用打包的 Bun 直接加载服务端入口，绕开窗口 SDK：

```bash
P=$(pwd)/build/dev-linux-x64/NarraFork-dev
cd "$P/Resources/app"
NARRAFORK_HOME="$HOME/.narrafork-eb-verify" PORT=7855 \
  "$P/bin/bun" -e 'await import("<仓库绝对路径>/server/index.ts")'
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:7855/api/health
```

注意服务端绑的是 `localhost`，在本机解析到 IPv6 loopback，用 `127.0.0.1` 探测会连不上。验证完记得删掉隔离数据目录。

已验证通过的项目（基于升到 2.0.2-beta.27 **之前** 的 2.0.1-beta.31 包；升版后需按同一流程复验）：打包产物元信息正确（`build.json` 记录 electrobun 2.0.1-beta.31 + Bun 1.4.0）、copy 映射全部落位（`dist/`、`drizzle/`、`native/bun-pty`）、tree-sitter WASM 与 `@parcel/watcher` `.node` 正确嵌入、服务端在 Bun 1.4.0 下完整启动、`/api/health` 返回 200、数据库建库/迁移/完整性检查正常、调度器与插件管理器就绪、数据落在隔离目录、运行中的开发实例不受影响。

### 窗口层（容器 + Xvfb，不需要改动宿主机）

窗口层需要 GTK/WebKit。**不要为此在宿主机装图形栈**——用一次性容器提供系统库和虚拟显示，跑完即弃，也不会干扰正在运行的开发实例。

`.reference/desktop-verify/` 下有现成的镜像定义和驱动脚本（`.reference/` 不进版本库）：

```bash
cd .reference/desktop-verify && podman build -t narrafork-desktop-verify:local .
cd -

podman run -d --name nf-desktop-verify \
  -v "$(pwd)/build/dev-linux-x64:/app:rw" \
  -v "$(pwd)/.reference/desktop-verify/run-window-test.sh:/run-test.sh:ro" \
  -v /tmp/nf-verify-out:/out:rw --shm-size=512m \
  localhost/narrafork-desktop-verify:local bash /run-test.sh

# 截图与日志落在 /tmp/nf-verify-out/
```

几个必须注意的点：

- **基础镜像用 trixie 而非 bookworm。** 只跑 Bun 主进程时 bookworm 够用，但 Cottontail 需要 glibc 2.38（bookworm 只有 2.36）。统一用 trixie 省得两套镜像。
- trixie 上 GTK3 包名是 `libgtk-3-0t64`（64 位 `time_t` 迁移改的名），照抄 bookworm 的 `libgtk-3-0` 会找不到包。
- 需要 `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1`：WebKit 沙箱要的权限 rootless 容器给不了。仅加载应用自己的 localhost 前端时可以接受。
- Xvfb 的窗口管理器不实现 `_NET_ACTIVE_WINDOW`，`xdotool windowactivate` 会失败，用 `windowfocus` 即可。
- 容器内 `dbus-launch` 能消掉 AT-SPI 无障碍总线的告警噪音。

已取证通过的项目：窗口以正确标题和尺寸创建（NarraFork，1440x900）、WebKitWebProcess/NetworkProcess 正常拉起、**真实 webview 渲染出前端**（i18next 初始化日志与截图可证）、**React 应用接收合成键盘输入并执行表单校验**（截图中出现用户名格式校验错误提示）、WebSocket 升级返回 101、完整性探针正常返回。

尚未走完：UI 端到端登录进入主界面（当前受合成输入的 Tab 焦点顺序所限，非应用缺陷）、终端交互、叙述者流式输出。

`[console.error] Failed to initialize encryption` 可以忽略：它来自 Electrobun preload 的安全 RPC 通道（`.hutch/devkit/api/preload/encryption.ts`），而本应用的 webview 只加载自己的 localhost 前端，不使用 Electrobun RPC。

## 已知限制与风险

- **Electrobun 2.0.2-beta.27 仍是 beta**，`hutch electrobun init` 需要 `--beta` 才能拿到当前模板目录。工具链也是 canary 对（hutch 0.27.0-canary.8 / cottontail 0.7.0-canary.10），升级前留意上游是否打出 2.0.2 正式版 + stable 工具链。
- **2.0.2-beta.27 相对 2.0.1-beta.31 的相关修复**（我们用 `mainProcess: "bun"`，多数 Cottontail 运行时改动不直接生效）：Windows WebView2 profile 关闭时持久化、Windows 启动器保留完整退出码、macOS 系统证书信任、native RPC 多进程隔离、worker dispatch 修复。Wayland 屏幕捕获与 per-webview `appdata` 协议是新增能力，本外壳尚未使用。
- **包体约 160MB**，其中内嵌 Bun 运行时约 101MB。Cottontail 能降到 140MB，但实测不可用，见「为什么仍用 Bun 主进程」。
- **冷启动数十秒**，已通过先开窗口显示加载态缓解，但首次启动体感仍偏慢。
- **`bun-pty` 的 Windows 终端功能未验证**，它是 Rust 原生模块，只能在 Windows 上实测。
- **UI 端到端登录与终端交互未验证**，窗口渲染和输入响应已取证，见上节。
- `bundleCEF: false`，使用系统 WebView（Linux WebKitGTK / Windows WebView2）。前端是标准 React，不需要 CEF，跳过它显著减小包体。

## 相关文件

| 文件 | 作用 |
| --- | --- |
| `electrobun.config.ts` | 应用元数据、主进程运行时、copy 映射 |
| `hutch.config.ts` | 锁定工具链版本（hutch / cottontail / electrobun） |
| `desktop/main.ts` | 外壳启动器 |
| `docs/BUILD.md` | 单文件二进制构建（另一条独立路径） |
