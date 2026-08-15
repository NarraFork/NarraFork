# Electrobun 桌面外壳

本文档说明 NarraFork 桌面版（Electrobun 打包）的架构、资产解析规则和构建方式。

桌面版与既有的两条发布路径**并存互不影响**：`bun run start`（源码运行）和 `bun run build:cross`（单文件二进制）都未改动。

## 现状

| 项目 | 状态 |
| --- | --- |
| 外壳配置与启动器 | 已完成 |
| Linux 包构建 | 已验证（无窗口层） |
| 窗口渲染 / 登录 / WebSocket | **未验证**，需要 GTK/WebKit 系统库 |
| Windows 包 | **未构建**，Electrobun 不支持交叉编译 |

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

### 为什么用 `mainProcess: "bun"` 而不是 Cottontail

两者都实测可行——Cottontail 能跑通 `bun:sqlite`、`Bun.serve`、`Bun.spawnSync`、`Bun.file`、`worker_threads`、`crypto.subtle`、`.node` 原生插件，且 `server/app.ts` 完整模块图能在其下成功加载。

选 Bun 是因为它打包真实 Bun 运行时，与 `bun run start` 的生产行为完全一致，不依赖兼容层。NarraFork 重度依赖 Bun 专有 API，Cottontail 文档也建议这种情况用 Bun 选项。

electrobun 分支上的 Cottontail 兼容改动（`server/lib/webcrypto-globals.ts` 的 WebCrypto 全局注入、WASM 动态导入、`scripts/patch-cottontail-modules.ts` 的 node_modules 换行补丁）全部保留：它们在真实 Bun 下是 no-op 或等价行为，将来要切回 Cottontail 无需回退。

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

### 为打包修掉的三个真实缺陷

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

## 构建

### Linux / macOS

```bash
bun run build                                  # 前端 → dist/frontend
export PATH="$HOME/.hutch/bin:$PATH"
hutch electrobun build --env=dev                # 开发包
hutch electrobun build --env=production         # 正式包
```

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
hutch electrobun build --env=production
```

### GitHub 不可达时

Electrobun 的 core/CEF 资产托管在 GitHub releases。若直连超时，可从镜像下载后通过官方支持的环境变量指定本地 devkit：

```bash
# 校验 sha256 必须与 ~/.hutch/cache/electrobun/releases/<版本>/electrobun-artifacts.json 中一致
curl -L -o /tmp/eb-core.tar.gz \
  "https://ghfast.top/https://github.com/blackboardsh/electrobun/releases/download/v2.0.1-beta.12/electrobun-core-linux-x64.tar.gz"
sha256sum /tmp/eb-core.tar.gz

mkdir -p /tmp/eb-devkit && tar -xzf /tmp/eb-core.tar.gz -C /tmp/eb-devkit
export HUTCH_ELECTROBUN_DEVKIT_ROOT=/tmp/eb-devkit
```

不要手工往 hutch 全局缓存里放文件——缓存路径命名规则未公开，猜测写入会留下无效孤儿文件。

## 验证

### 无窗口层（无图形环境亦可）

窗口需要 GTK/WebKit，服务端不需要。直接运行打包后的主进程即可验证服务端侧：

```bash
P=build/dev-linux-x64/NarraFork-dev
cd "$P/Resources/app" && "$P/bin/bun" run bun/index.js
```

已验证通过的项目：服务端启动、`/api/health` 返回 200、前端 `index.html` 正常返回并渲染、tree-sitter WASM 解析成功、数据库建库/迁移/FTS 索引正常、数据落在隔离目录、运行中的开发实例不受影响。

### 窗口层（需要系统库）

```bash
# Ubuntu/Debian
sudo apt install libgtk-3-0 libwebkit2gtk-4.1-0 libayatana-appindicator3-1 librsvg2-2
```

装好后启动 `build/dev-linux-x64/NarraFork-dev/bin/launcher`，需要验证：窗口渲染、**登录流程**（直接检验 WebCrypto/JWT 兼容改动是否生效）、WebSocket 实时输出、终端功能。

## 已知限制与风险

- **Electrobun 2.0.1-beta.12 是 beta**，稳定版模板尚未发布（`hutch electrobun init` 不加 `--beta` 会报 `TemplateCatalogUnavailable`）。
- **包体约 175MB**，其中内嵌 Bun 运行时约 101MB。
- **冷启动数十秒**，已通过先开窗口显示加载态缓解，但首次启动体感仍偏慢。
- **`bun-pty` 的 Windows 终端功能未验证**，它是 Rust 原生模块，只能在 Windows 上实测。
- **窗口层完全未验证**，见上节。
- `bundleCEF: false`，使用系统 WebView（Linux WebKitGTK / Windows WebView2）。前端是标准 React，不需要 CEF，跳过它显著减小包体。

## 相关文件

| 文件 | 作用 |
| --- | --- |
| `electrobun.config.ts` | 应用元数据、主进程运行时、copy 映射 |
| `hutch.config.ts` | 锁定工具链版本（hutch / cottontail / electrobun） |
| `desktop/main.ts` | 外壳启动器 |
| `docs/BUILD.md` | 单文件二进制构建（另一条独立路径） |
