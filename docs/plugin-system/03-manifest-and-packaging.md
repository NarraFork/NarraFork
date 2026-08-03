# NarraFork 插件系统：Manifest、打包与安装生命周期

> 本文定义插件包的静态描述、版本兼容、安装目录、依赖、启停、升级、回滚和卸载流程。本文不定义完整 JSON-RPC 方法；服务端 RPC 约束见 `04-server-rpc-and-provider.md`，宿主总体生命周期见 `02-host-architecture.md`，权限和沙箱细节见 `07-security-and-sandbox.md`。

## 0. 标记约定

- **[当前事实]**：可由当前仓库代码或现有设计直接确认。
- **[设计建议]**：本设计建议采用的目标行为。
- **[假设]**：为形成可执行方案而暂时采用，尚未实现或确认。
- **[待决策]**：需要后续 ADR、产品策略或实现阶段确认。

## 1. 范围与设计约束

### 1.1 当前实现事实

- **[当前事实]** `McpManager` 从 `settings.mcpServers` 读取启用项，负责连接、工具发现、断线重连、工具列表变化通知和统一 shutdown；它支持 `stdio`、`streamable-http`、`sse` 三种 MCP transport。
- **[当前事实]** MCP 的 stdio transport 当前会把进程环境合并到子进程环境；插件运行时不应直接复用这种“继承全部环境”的策略，因为其中可能包含密钥、代理和宿主内部配置。
- **[当前事实]** `server/lib/spawn.ts` 的 `safeSpawn` 已提供参数数组启动、超时、AbortSignal、输出上限、watchdog、进程树清理和 Windows `taskkill /T` 兜底；它可作为插件 Runtime Supervisor 的实现参考，但不能替代插件专用协议监管。
- **[当前事实]** NarraFork 的配置根目录由 `getNarraforkHome()` 解析，默认是 `~/.narrafork`，也可通过 `NARRAFORK_HOME` 覆盖；settings 使用原子替换写入并以 `0600` 创建文件，JWT secret 在首次加载时自动生成。
- **[当前事实]** 现有章节容器由 `container-service.ts` 通过 rootless Podman/compose 管理，端口默认从 `10000–20000` 分配；该服务围绕章节 worktree 和 compose 文件设计，不应直接当作插件运行器。
- **[当前事实]** 当前前端 `WebviewPanel` 是用户指定 URL 的通用 webview，iframe sandbox 包含 `allow-same-origin`、`allow-forms` 和 `allow-popups`；这不是第三方插件 UI 的安全模板。
- **[当前事实]** 现有前端 Dockview/Director 使用构建期静态 component registry；插件 UI 应通过单一宿主 adapter 和声明式参数接入，而不是在运行时注入 React component 或 route。

### 1.2 目标

- **[设计建议]** 安装包必须能够在不修改 NarraFork 源码、不动态导入 `server/*` 内部模块的情况下扩展 provider、tool、command、event、view 和配置页面。
- **[设计建议]** 安装、启用和激活是三个不同动作：安装只读取和校验静态内容，不执行插件代码；启用只改变期望状态；激活才创建运行时。
- **[设计建议]** Manifest、Host API 和 RPC protocol 使用三个独立版本层。插件发布版本不能替代兼容协议版本。
- **[设计建议]** Manifest 是静态权限和贡献的上限，不是授权本身；管理员 Grant、宿主安全策略、当前用户权限和当前调用范围还要进一步收敛实际能力。
- **[设计建议]** 一个插件包的 server、UI、provider 和 tool 可以独立启用或禁用，但默认共享一个插件身份和版本目录；不同插件不共享运行时进程。
- **[设计建议]** 默认包不可变、版本目录不可覆盖；升级通过 staging 和原子 `current` 指针切换完成。

## 2. 版本与身份模型

### 2.1 三层版本

**[设计建议]** 使用以下三个互不替代的版本字段：

| 版本层 | 示例 | 作用 | 不兼容时处理 |
|---|---|---|---|
| Manifest schema | `1` | 宿主是否能安全读取 `manifest.json` | 安装检查失败，不执行代码 |
| Host API | `1.0` | 插件可调用的 Query/Command/Event/Storage/Secret API | 选择共同版本；无交集则 incompatible |
| RPC protocol | `narrafork.rpc/1` | framing、握手、流、取消、错误和背压 | major 不同拒绝握手 |

- **[设计建议]** `schemaVersion` 是整数主版本，表示 Manifest 结构版本；同一主版本只能增加可选字段，不得改变必填字段语义。
- **[设计建议]** `version` 遵循 SemVer，表示插件发布版本；预发布版本可以安装但默认不参与稳定通道自动升级。
- **[设计建议]** `engine.hostApi` 和 `engine.rpc` 使用宿主支持的范围表达式；静态检查不通过时保留包以供诊断，但不激活。
- **[待决策]** NarraFork `0.x` 是否允许 Host API minor 之间破坏性变化；建议至少保留一个旧 major 的兼容窗口。

### 2.2 pluginId 规则

**[设计建议]** `pluginId` 是安装、权限、日志、存储和贡献命名的根身份，建议采用反向域名形式：

```text
com.example.review
org.example.narrative-tools
cn.example.team.provider
```

约束：

- ASCII 小写；允许字母、数字、`.`、`-`；长度 3–128 字节；首尾必须是字母或数字。
- 不允许 `/`、`:`、空格、控制字符、路径片段、Unicode 同形异义字符和大小写变体。
- 全局唯一；包内不允许通过第二个字段覆盖已有 `pluginId`。
- contribution 使用包内局部 ID，完整 ID 为 `<pluginId>/<localId>`；provider prefix 也应使用插件命名空间，不能占用内置 provider prefix。
- **[设计建议]** `pluginId` 不由包文件名推断；文件名只作导入提示，最终身份以 Manifest 为准并在安装时绑定。

### 2.3 engine

**[设计建议]** `engine` 描述运行时、宿主兼容性和平台要求，不表示插件获得的权限：

```json
{
  "engine": {
    "runtime": "bun",
    "runtimeVersion": ">=1.2 <2",
    "hostApi": ">=1.0 <2",
    "rpc": "narrafork.rpc/1",
    "os": ["linux", "darwin", "win32"],
    "arch": ["x64", "arm64"],
    "runner": "local-process"
  }
}
```

- `runtime` 建议支持 `bun`、`node`、`python` 和 `binary`；第一阶段本地运行器可只实现 `bun`/`node`，Podman runner 再扩展其他运行时。
- `runtimeVersion` 只描述可执行文件兼容范围；宿主必须在安装或启动前检查，不在激活时偷偷联网下载运行时。
- `runner` 可为 `local-process` 或 `podman`，但 Manifest 只能声明偏好或最低要求，最终 runner 由宿主安全策略决定。
- `os`、`arch` 为空表示不声明限制；声明的值必须是受控枚举，不能通过 Manifest 注入任意启动参数。

## 3. Manifest schema

### 3.1 最小完整示例

**[设计建议]** `manifest.json` 必须位于包根目录，使用 JSON，不允许执行式配置、JSON5、`eval` 表达式或远程 URL 入口：

```json
{
  "schemaVersion": 1,
  "pluginId": "com.example.review",
  "version": "1.2.3",
  "displayName": "Review Assistant",
  "description": "Review and summarize chapter changes.",
  "publisher": {
    "id": "com.example",
    "name": "Example Team"
  },
  "license": "Apache-2.0",
  "engine": {
    "runtime": "bun",
    "runtimeVersion": ">=1.2 <2",
    "hostApi": ">=1.0 <2",
    "rpc": "narrafork.rpc/1",
    "os": ["linux", "darwin", "win32"],
    "arch": ["x64", "arm64"],
    "runner": "local-process"
  },
  "server": {
    "entry": "server/index.js",
    "transport": "stdio",
    "protocol": "narrafork.rpc/1",
    "args": [],
    "workingDirectory": "package",
    "startupTimeoutMs": 15000,
    "activationTimeoutMs": 30000
  },
  "ui": {
    "entry": "ui/review-dashboard.iife.js",
    "format": "iife",
    "style": "ui/review-dashboard.css",
    "shell": "host-controlled"
  },
  "activationEvents": [
    "onCommand:openReviewDashboard",
    "onView:review-dashboard",
    "onTool:review-chapter"
  ],
  "contributes": {
    "providers": [],
    "tools": [
      {
        "id": "review-chapter",
        "title": "Review chapter",
        "inputSchema": {
          "type": "object",
          "properties": {
            "chapterId": { "type": "string", "maxLength": 100 }
          },
          "required": ["chapterId"],
          "additionalProperties": false
        },
        "execution": "server"
      }
    ],
    "commands": [
      {
        "id": "openReviewDashboard",
        "title": "Open Review Dashboard",
        "handler": "server",
        "when": "chapter.exists"
      }
    ],
    "events": [
      {
        "id": "chapterChanged",
        "topic": "chapter.changed",
        "filter": { "fields": ["chapterId", "projectId"] }
      }
    ],
    "views": [
      {
        "id": "review-dashboard",
        "title": "Review Dashboard",
        "entry": "ui/review-dashboard.iife.js",
        "style": "ui/review-dashboard.css",
        "surfaces": ["workspace", "director"],
        "scope": "workspace",
        "instance": "singleton-per-workspace"
      }
    ],
    "configuration": {
      "properties": {
        "defaultReviewDepth": {
          "type": "string",
          "enum": ["quick", "normal", "deep"],
          "default": "normal",
          "description": "Default review depth"
        }
      }
    }
  },
  "permissions": {
    "host": [
      "query.chapters.read",
      "query.projects.read",
      "command.reviews.create",
      "storage.workspace.read",
      "storage.workspace.write",
      "ui.panel"
    ],
    "network": {
      "mode": "none",
      "allow": []
    },
    "filesystem": {
      "package": "readOnly",
      "pluginData": "readWrite",
      "workspace": "none"
    },
    "process": {
      "spawn": "none"
    }
  },
  "secrets": [],
  "dependencies": {
    "plugins": {},
    "runtime": {}
  }
}
```

### 3.2 根字段

| 字段 | 必填 | 规则 |
|---|---:|---|
| `schemaVersion` | 是 | 当前为 `1`；未知主版本拒绝安装 |
| `pluginId` | 是 | 按 2.2 校验，全局唯一 |
| `version` | 是 | SemVer；不能与已安装版本相同且内容摘要不同 |
| `displayName` | 是 | 纯文本，建议不超过 120 字符 |
| `description` | 否 | 纯文本，建议不超过 4000 字符 |
| `publisher` | 建议 | 发布者 ID、显示名、联系信息；不得作为授权替代 |
| `license` | 建议 | SPDX 字符串或组织内部许可证标识 |
| `engine` | 是 | 运行时、Host API、RPC 和平台约束 |
| `server` | 条件必填 | 存在后端 contribution 时必填 |
| `ui` | 条件必填 | 存在 UI view 时必填 |
| `activationEvents` | 否 | 只能使用白名单事件和静态过滤 |
| `contributes` | 是 | 默认为空对象；静态贡献 ID 必须唯一 |
| `permissions` | 是 | 显式声明权限上限；缺省不代表全开 |
| `configuration` | 否 | 也可放在 `contributes.configuration`，二者只能选一个规范位置；建议统一使用后者 |
| `secrets` | 否 | 只声明 secret 元数据，不携带 secret 值 |
| `dependencies` | 否 | 插件/运行时依赖；不得在激活时隐式安装 |
| `integrity`/`signature` | 包级 | 通常由打包工具生成，不由插件源码手工修改 |

**[设计建议]** 为避免多个工具链产生两个配置入口，规范字段只保留 `contributes.configuration`；顶层 `configuration` 仅作为安装器读取时的兼容别名，保存时归一化到贡献索引。

### 3.3 server 与 ui entry

- **[设计建议]** `server.entry` 和 `ui.entry` 必须是包内相对路径，使用 `/` 分隔；拒绝绝对路径、`..`、符号链接目标、`file:`、`data:`、`javascript:` 和远程 URL。
- `server.entry` 由宿主通过参数数组启动，不经过 shell；`server.args` 只能包含静态字符串和受控占位符，例如 `${PLUGIN_DATA_DIR}`，不支持任意命令模板。
- server stdout 专用于 RPC framing；普通日志走 stderr 或结构化 log notification。stdout 混入日志达到阈值时终止运行时。
- `workingDirectory` 只能是 `package`、`pluginData` 或受宿主批准的临时目录，默认 `package`，且包目录只读。
- `ui.entry` 首版建议要求单文件 classic/IIFE bundle；动态 chunk、ESM、Web Worker 和 WebAssembly 需要额外的 CSP、CORS、资源回收和审计设计。
- UI 外层 HTML、sandbox 属性、CSP、`<base>`、meta refresh 和加载顺序由宿主生成；插件只能提供已校验的 JS/CSS asset。
- **[待决策]** 首版是否允许 ESM/dynamic chunks；推荐先只允许 IIFE，降低 opaque-origin iframe 的资源和 CSP 复杂度。

### 3.4 activationEvents

**[设计建议]** 只允许以下事件族：

| 事件 | 示例 | 触发语义 |
|---|---|---|
| `onStartup` | `onStartup` | 宿主启动后异步激活；第三方默认不允许或需额外授权 |
| `onCommand:<id>` | `onCommand:openReviewDashboard` | 调用已声明 command 前激活 |
| `onView:<id>` | `onView:review-dashboard` | 打开 view 前激活后端 |
| `onProvider:<id>` | `onProvider:com.example.review/provider` | provider 首次使用或模型发现时激活 |
| `onTool:<id>` | `onTool:review-chapter` | tool 第一次执行前激活 |
| `onEvent:<topic>` | `onEvent:chapter.changed` | 白名单公共事件到达时激活 |
| `onSchedule:<id>` | `onSchedule:daily-summary` | 宿主调度器触发，不允许插件自行持有 timer |

约束：

- 事件名必须引用本 Manifest 中存在的 contribution；未知引用安装失败。
- 不允许 JavaScript 谓词、正则执行式过滤或访问内部 eventBus 名称。
- event filter 必须是宿主定义的 JSON schema；高频事件必须支持去抖、合并和队列上限。
- 同一插件并发激活使用 single-flight；激活期间进入有界 cold-start queue，超过上限快速返回 `PLUGIN_BUSY`。
- 插件启用但没有匹配激活事件时保持 stopped，不应因“启用”而常驻运行。

### 3.5 contributes

**[设计建议]** v1 的贡献类型和最小字段如下：

- `providers[]`：provider type ID、显示名、模型发现能力、session mode、并发建议、配置 schema；provider 通过 `RemoteProviderAdapter` 接入，不直接拿到 Agent Loop。
- `searchProviders[]`（**已实现**）：局部 ID、标题、**必填 `providerId`**、`requiresConfig[]`、`capabilities`、`limits`。声明一个 web 搜索源，宿主把它注册为 `lib/search` 的一个搜索通道（`kind: "plugin"`，channel id 为 `plugin:<pluginId>:<contributionId>`），执行走 `provider.search`（详见 `04-server-rpc-and-provider.md`）。详细约束见下方 3.5.7。
- `tools[]`：局部 ID、纯文本标题/描述、JSON Schema、执行位置 `server` 或 `ui`、是否允许后台执行。工具参数仍经过核心 schema、权限和审计。
- `commands[]`：局部 ID、纯文本标题、参数 schema、handler 位置、有限 `when` context-key；不允许运行期注册 callback。
- `events[]`：公共 topic、静态 filter schema、是否允许后台接收、最大事件频率；不透传原始事件 payload。
- `views[]`：UI entry、surface、scope、instance 策略、默认位置、关联 command；只允许宿主声明式 panel。
- `themes[]`：局部 ID、纯文本标题、`colorScheme`（light/dark/both）和受白名单约束的设计 `tokens`（primaryColor 单色、body/text 颜色、自定义 colors、spacing/fontSize/radius，以及可选的 `backgrounds` 区域背景和 `frames` 九宫格贴图边框）。**插件只声明 token，不提交任何 CSS**；宿主校验每个值（颜色只允许 `#hex`/`rgb()` 安全子集，盒模型值做范围钳制并拒绝 `calc()`/`var()`/表达式），在 catalog refresh 时把单色扩展成 10 级色阶并编译成一段作用于 `[data-plugin-theme]` 的 Mantine CSS 变量覆盖。主题贡献是零 JS、零代码执行的声明式 token，风险与内置 OLED 模式同级，因此 `ui.theme` **不是**高风险能力（详见下方 3.5.1 插件分级）。切换主题只改 `<html data-plugin-theme>` 属性，不重建 React 树。
- `menus`/`status`：后续阶段可加入，但只能声明文本、宿主 icon token、排序和 command，不能注入 HTML/CSS/React。

### 3.5.1 插件分级（tier）与安装/启用门槛

**[设计建议]** 参照 VSCode 的扩展模型，插件按 manifest 形态分为三个风险层级，由纯函数 `pluginTier(manifest)` 判定（`server/lib/plugins/manifest.ts`）：

| tier | 判据 | 风险 | 安装/启用门槛 |
|---|---|---|---|
| `backend` | 存在 `manifest.server` | 运行后端进程，可访问文件/网络/子进程 | 仅管理员 |
| `frontend` | 无 server 但有 `views` | 前端 sandbox iframe 里执行第三方 IIFE JS | 仅管理员 |
| `theme-only` | 无 server、无 view，仅 `themes` | 零 JS、零代码执行的受控 CSS 变量 | **任何登录用户** |

- **[设计建议]** tier 判定只依据 `manifest.server` 与 `contributes.views`，**绝不使用 permissions 字段**：纯前端插件仍可声明后端能力（虽无处执行），用 permissions 判级会被绕过。
- **[设计建议]** install 路由对所有登录用户开放；因为 tier 只有静态解析后才可知，宿主先完成安装（install 从不执行插件代码），若解析结果非 theme-only 且操作者非管理员，则**回滚安装并返回 403**。
- **[设计建议]** enable/activate/disable/uninstall 在执行前查询插件 tier，非 theme-only 操作要求管理员。
- **[安全]** tier 判定 fail-safe：当 manifest 不可读/缺失时保守判为 `backend`（要求管理员），不乐观归类为低风险。
- **[设计建议]** theme-only 插件的**包**全局安装（共享一份），但**启用是 per-user**：`user_plugin_themes` 表记录每个用户启用了哪些主题；`GET /api/plugins/ui/themes` 只返回当前用户已启用主题的编译 CSS。用户 A 启用主题不影响用户 B（包括管理员），因此"人人可装 theme-only"不构成提权。
- **[设计建议]** 插件系统默认启用（`settings.plugins.enabled` 默认 `true`）；环境变量 `NF_PLUGINS_ENABLED`/`NARRAFORK_PLUGINS_ENABLED` 若设置则优先，作为运维应急 kill switch（设为 `0`/`false` 强制关闭）。

### 3.5.2 主题背景图（包内图片）

**[设计建议]** 主题 `tokens` 可选 `backgrounds`，给**受控宿主区域**设置**包内图片**背景。这是唯一允许主题引用图片资源的通道，安全边界如下：

- 区域为固定白名单枚举，映射到稳定宿主类，**不开放任意选择器**。页面级：`body`（页面底）、`app`（`.nf-app-shell`）、`main`（`.nf-app-shell-main`）、`navbar`（`.mantine-AppShell-navbar`）、`header`（`.mantine-AppShell-header`）；容器级：`paper`（`.mantine-Paper-root`）、`card`（`.mantine-Card-root`）、`modal`（`.mantine-Modal-content`）、`input`（`.mantine-Input-input`）。
- 每区域字段：`image`（**包内相对路径**，经 `manifestPathSchema` 校验，拒绝 URL scheme/绝对路径/`..` 穿越）、`size`/`position`/`repeat`/`overlay` 枚举、`opacity`（0–1，作为遮罩强度）。全部枚举/钳制，**不接受任意 CSS 值**。
- **插件绝不写 `url()`**：宿主在编译期把 `image` 路径拼成**同源受控端点** URL 后再 emit `background-image`。硬禁外链（外链会泄露用户 IP/在线状态、可追踪）。
- **资源端点** `GET /api/plugins/ui/:pluginId/:version/:hash/theme-asset/:assetPath`：不绑 UI session（theme-only 无 session），能力=**精确包 hash（内容绑定 sha256）+ 插件已启用且为 current 包**；只服务主题**显式声明**的图片路径（`readAsset` 的 declaredAssets 白名单）；复用路径穿越/symlink/大小（10MB）防护。因为宿主主文档 CSS `url()` 请求不带 `Authorization`，端点不能用 Bearer/cookie 认证，故采用 URL 内嵌 hash 能力模型。
- **仅允许位图，SVG 硬禁**（`.png`/`.jpg`/`.jpeg`/`.webp`/`.gif`/`.avif`）。该端点无认证且同源，响应 `Content-Type` 由扩展名决定，因此任何活动类型（`.html`/`.js`/`.svg`/`.json`）都等于同源脚本投递。SVG 可携带脚本且背景不需要矢量，故直接排除；manifest schema 与端点各校验一次（defense in depth），并附 `nosniff` + `Content-Security-Policy: default-src 'none'; img-src 'self'; sandbox` + `Content-Disposition: inline`，即使直接导航到 URL 也不执行脚本。
- `overlay`（`none`/`scrim-light`/`scrim-dark`）在背景图上叠加一层基于 `--mantine-color-body` 的半透明遮罩以保证文字可读性，`opacity` 控制遮罩强度。深浅变体（`light`/`dark`）可各自声明不同背景。

### 3.5.3 九宫格贴图边框（`frames`）

**[设计建议]** 主题 `tokens` 可选 `frames`，用**包内位图**给受控控件贴九宫格（nine-slice）边框。资源通道与 3.5.2 完全共用（同一端点、同一位图白名单、同一 declaredAssets 机制），差异只在编译出的 CSS 属性和目标选择器。

- 目标为固定白名单枚举 → 稳定 Mantine 静态类映射：`button`（`.mantine-Button-root`）、`buttonHover`（同上 + `:hover:not(:disabled):not([data-disabled])`）、`actionIcon`、`card`、`paper`、`modal`、`navbar`、`header`、`input`。**不开放任意选择器**。
- 每目标字段：`image`（包内位图相对路径）、`slice`（1–64 整数 px，源图四边切割inset）、`width`（可选，1–64 整数 px，渲染厚度，默认等于 `slice`）、`repeat`（`stretch`/`repeat`/`round`/`space`）、`fill`（布尔，是否用源图中心区填充元素背景）。全部枚举/钳制整数/布尔，**无任意字符串进入 CSS**。
- **`slice` 用整数 px 而非百分比**：百分比 slice 相对源图内在尺寸，宿主要解码图片才能知道，而图片解码不应出现在 catalog refresh 路径上。
- **[安全] 结构性禁止 reflow**：编译器只 emit `border-style: solid` + **`border-width: 0`** + 四个 `border-image-*`，视觉厚度全部由 `border-image-width` 承载。零边框不占布局空间，内容盒不变，因此主题**无法**触发 reflow。非零 `border-width` 与 `border-image-outset` 在 token schema 中**不可表达**：outset 绘制在 border box 之外，会被任何 `overflow: hidden` 祖先整块裁掉（Mantine `Button` 自身即设置该属性），属于不可靠而非有用。
- **`slice` 描述源图，`width` 描述渲染结果，二者解耦是刻意的**：frame 从元素边缘向**内**绘制且不占布局空间，因此小控件上厚边框会压住文字。作者应对紧凑控件（按钮/输入框）调小 `width`，只在卡片/模态框等宽裕表面用接近 `slice` 的厚度。
- 编译顺序固定在 `FRAME_TARGET_ORDER` 而非跟随 manifest 键序：`.mantine-Paper-root` 与 `.mantine-Card-root` 在同一元素上特异度相同（Card 内部渲染 Paper），`buttonHover` 也必须排在 `button` 之后，靠源码顺序决胜。
- 每主题编译产物有 48 KiB 硬上限（`MAX_COMPILED_THEME_CSS_LENGTH`），超限则整个主题产出空字符串，不输出截断样式表。
- 参考实现：`examples/plugins/theme-framed/`。

### 3.5.4 渐变、字体、阴影与分表面文字色

**[设计建议]** 社区主题（如 linux.do 上流行的复古 QQ 皮肤、粉色系主题）的观感几乎全部建立在渐变之上，纯色 token 无法表达。以下四组 token 补齐这一缺口，全部沿用「插件只声明结构化 token，宿主合成 CSS」的边界。

**`gradients`（结构化渐变）**

- 表面白名单 `THEME_GRADIENT_SURFACES` = 九个背景区域 + `button`/`buttonHover`/`actionIcon`（两个交互控件只有渐变才有意义）。
- 字段：`from`/`to`（必填，复用 `safeColorSchema`）、`via` + `viaAt`（可选中间停靠点，0–100 整数）、`angle`（0–360 整数，默认 180）。**插件永不书写 `linear-gradient(...)` 语法**，只给颜色与角度，宿主自行拼装，因此没有插入第二条声明或多余括号的入口。
- 只提供一个中间停靠点是刻意的：既足够表达 QQ 时代「顶部高光 + 快速衰减 + 底部饱和」的玻璃质感，又让产物体积保持有界。
- **[实测] 只 emit `background-image`，绝不 emit `background` 简写或 `background-color`**：Mantine 的 `Button`/`ActionIcon` 自身规则用 `background` 简写（隐含 `background-image: none`），而 `AppShell.Header`/`Input` 用 `background-color`。由于主题作用域选择器特异度更高，单发 `background-image` 既能覆盖简写隐含的 `none`，又不破坏组件自己的 `background-color`。headless Chrome 实测四类目标 `gradientPainted` 全部为 true，因此**一条统一代码路径**即可，无需按目标分类。
- **[架构] 渐变与 `backgrounds` 必须同一趟编译**：二者共用 `background-image` 一个属性，分两趟发规则会让后写的规则静默擦掉前一条。宿主把 scrim / 图片 / 渐变合成为一个图层栈（scrim 在上保证可读性，渐变在最下作为底色），并让 `background-size`/`position`/`repeat` 的每个槽位与图层顺序对齐。

**`fontFamily` / `fontFamilyHeadings` / `fontFamilyMonospace`**

- 只接受泛型 CSS 关键字枚举 `THEME_FONT_FAMILIES` = `system-ui`/`sans-serif`/`serif`/`monospace`/`cursive`。
- **[安全] 拒绝具体字体名，也拒绝包内字体文件**：字体是由平台文字引擎解析的复杂二进制，攻击面远大于位图；而任意字体名字符串可用于探测用户已安装字体，属指纹识别向量。关键字已足够承载意图（`serif` 即宋体/Times 那类观感）。

**`shadow`**

- 只接受 0–48 的整数（模糊半径强度），宿主按既有 `SIZE_LADDER` 推出 xs..xl 全套 `--mantine-shadow-*`，偏移按比例派生，**alpha 由宿主固定为 0.18**。
- **[安全] 插件不能书写原始 `box-shadow`**：该属性接受无界长度值，可用于把阴影画到元素外很远处，或伪造宿主 chrome。

**`textColors`（分表面文字色）**

- 表面白名单 `THEME_TEXT_SURFACES` = `navbar`/`header`/`card`/`paper`/`modal`/`input`/`button`/`actionIcon`。
- 全局 `text` 无法表达「深色标题栏上必须白字、浅色按钮面上必须深字」这类同一主题内相反的对比需求，任何 chrome 风格主题都需要它。
- 同时改写该表面的 `--mantine-color-text`，因为许多 Mantine 后代元素读该变量而非继承 `color`。

### 3.5.5 `borders`（边框与圆角，允许影响布局）

**[设计建议]** 复刻真实应用 chrome 离不开货真价实的 1px 分隔线与分角圆角：标签条、分组列表表头、下沉式代码面板。这些用 repaint-only token 无法表达，因此 `borders` 是**唯一允许影响布局**的一组，这是刻意的取舍——优先换取表达自由度。

- 字段：`width`（0–8 整数 px）、`style`（`solid`/`dashed`/`dotted`/`double`/`none` 枚举）、`color`（`safeColorSchema`）、`radius` 或四个分角 `radiusTopLeft` 等（0–48 整数 px）、`edges`（`top`/`right`/`bottom`/`left` 数组，用于只画某几条边）。
- **`inset: true` 提供零布局影响的逃生通道**：此时描边编译为 inset `box-shadow` 环，画在元素内部、尊重圆角、不占布局。实测（headless Chrome）：`content-box` 元素加 1px 真实边框外框从 200 变 230，而 inset 方案内容盒与无边框完全一致。需要真 chrome 的主题接受重排，需要安全的用 `inset`。
- 分角优先于统一 `radius`；四角齐备时发 `border-radius` 简写以压过宿主 longhand，否则发对应 longhand。
- `style: "none"` 或 `width: 0` 是显式移除宿主边框的手段（扁平无 chrome 风格）。
- 无论走哪条路径，爆炸半径仍有界：宽度 ≤ 8px、圆角 ≤ 48px、style 是枚举、颜色过 `isSafeColor`。

### 3.5.6 统一表面词表与派生 schema

**[设计建议]** 表面白名单已扩展到约 29 个，覆盖 `body`/`app`/`main`/`navbar`/`header`/`footer`、容器（`card`/`paper`/`modal`）、内容 chrome（`code`/`table`/`tableHeader`/`badge`/`menu`/`menuItem`/`tooltip`/`divider`/`scrollbar`/`scrollbarThumb`）、导航（`navLink` 及 hover/active）、以及交互控件与其状态（`button`/`buttonHover`/`buttonActive`/`actionIcon`/`actionIconHover`/`input`/`inputFocus`/`menuItemHover`/`navLinkHover`）。

- `backgrounds`/`gradients`/`frames`/`textColors`/`borders` 五组**共用同一张 `SURFACE_TARGET` 映射表与同一个 `SURFACE_ORDER` 发射顺序**，各组只收窄到自己接受的子集。同一个名字在不同 token 组里绝不指向不同元素。
- **[反模式修正] schema 由表面数组派生（`surfaceMapSchema`），不再手写五份平行键列表**。手写列表已经出过事故：`input` 曾漏在 text-color 列表外，直到渲染出白底浅字才暴露。现在数组是唯一真源，新增表面无法"半落地"，并有回归测试锁定「每个声明的表面都必须在编译器里有选择器」。
- 顺序固定解决三类覆盖决胜：`.mantine-Paper-root` 与 `.mantine-Card-root`（Card 内部即 Paper，特异度相同）、`button` 与 `buttonHover`/`buttonActive`、以及 `navLink` 与其 hover/active 态。交互元素的状态规则紧随其基础规则之后发射。
- **编译上限提到 192 KiB**：上限按实测最坏情况定，而非猜测——29 个表面全部带渐变 + 背景图 + 九宫格 + 文字色 + 边框，再乘以 base/light/dark 三份，实测约 124 KB。上限仍然重要（它界定单个插件能向宿主样式表注入多少），但刻意留足余量，因为超限会丢弃**整个**主题，半套样式比大样式更糟。

**[安全] repaint-only 保证（有回归测试锁定）**

`gradients`、`backgrounds`、`frames`、`textColors`、`shadow` 五组**只重绘、不参与布局**：编译产物不含 `width`/`height`/`padding`/`margin`/`position`/`font-size`/`transform` 等任何布局属性（`border-image-width` 例外，它在既有 border box 内绘制，见 3.5.3）。已用 headless Chrome 对真实 Mantine 类名做 before/after 内容盒测量，`reflowed` 为空。

明确排除在该保证外的：`borders`（非 inset 路径，见 3.5.5）以及 `fontFamily`/`fontSize`/`spacing`/`radius`——改变文字度量与间距正是后者的用途，与既有 `fontSize` token 语义一致。主题作者应知道换字体和加边框会引起重排。

**主题作者须知：表面要成套styling**

壁纸 + 主题化文字色是做出不可读界面最快的方式。两条经验都来自本次实测踩坑：一是**任何承载文字的表面配了背景图就必须配 scrim**；二是**给一个表面设了背景就要连它的文字色一起设**——示例主题曾只给 `card` 设渐变而漏掉 `input`/`code`/`badge`，结果深色模式下这些控件是浅底浅字。

参考实现：`examples/plugins/theme-qq-classic/`（玻璃质感 chrome，26 个渐变表面 + 分边框线 + 下沉式输入框）、`examples/plugins/theme-strawberry/`（壁纸 + 完整双配色，全部 token 组）。两个示例的位图均由程序生成，不搬运任何真实产品素材或人物肖像。

### 3.5.7 `searchProviders`（web 搜索源，已实现）


```json
"searchProviders": [
  {
    "id": "web-search",
    "requiresConfig": ["credentialsBundle"],
    "capabilities": { "maxResults": true },
    "limits": { "timeoutMs": 60000 }
  }
]
```

**`providerId` 必填，搜索贡献没有自己的 config/secret 命名空间。**

这是本贡献点最重要的一条约束，理由是它避免撕开一处已经收紧的安全校验：

- vault 只认 `provider.<contributionId>.<field>` 形状的键（`plugin-secret-vault.ts`）；
- 插件命令可写的 secret 前缀是**从 provider registry 派生**的，不取自请求（`plugin-command-secret-writes.ts` 的 `ownedContributionIds`）。

如果给搜索一个独立的 `search.<id>.<field>` 命名空间，上述派生逻辑就得同时遍历搜索注册表，等于把命名空间校验再放宽一次。绑定则完全复用既有路径：`providerId` 指向的 provider 贡献负责承载配置，宿主在每次 `provider.search` 前解析该 provider 的 config + vault secret 并随请求下发，与 `provider.chat` 完全一致。

对用户的效果是凭据只录一次，对话和搜索共用。`contributes.views` 的 `providerId` 已有同样的先例与同样的理由。

代价如实记录：**只想贡献搜索的插件仍需声明一个 provider 贡献作为配置载体**。这有点别扭，但比放宽 secret 校验划算；将来若有真实需求，补独立命名空间是向后兼容的增量。

manifest 校验会拒绝指向未声明 provider 的 `providerId`（悬空绑定会装出一条永远解析不到凭据的通道），且搜索贡献与 provider/tool/command 一样要求 `server`（它经 `provider.search` 服务）。

**`requiresConfig` 是同步可用性判断的唯一依据。**

`getNormalizedSearchChannels()` 在每次工具执行和每次 provider 请求体构建时都会跑（该函数为此专门避开了 `structuredClone` 整个 settings），所以可用性必须是同步内存读取：不能问插件"你现在可用吗"，也不能等待 vault I/O。插件因此在 manifest 里声明它需要绑定 provider 的哪几个字段齐备，宿主同步检查明文 config 与 vault 已加载的键名（`PluginSecretVault.peekKeys`）。

它只能判断字段**是否已设置**，不能判断凭据是否有效。无效凭据会得到一条"看起来可用、执行时失败"的通道，随后 router 落到下一条 —— 与内置 `custom-api` 的行为一致（`isCustomSearchProviderUsable` 同样只查配置齐备）。

**能力与权限**

`capabilities` 纯描述性，宿主代码不读取它：宿主总是把它有的字段都发过去，插件自行忽略不支持的。声明 `domainFilter: false` **不会**让宿主代替插件做域名过滤 —— 忽略某个参数只会让结果集更宽，不会失败，所以无需宿主兜底；确实不支持过滤的源应写在 `description` 里，让管理员据此安排通道顺序。

`limits` 两个字段都是插件给自己设的上限，宿主在 `PluginProviderRpcClient.search` 里与自身限制取小：`timeoutMs` 对传输层 unary 超时，`maxOutputBytes` 对 `maxUnaryResponseBytes`（1 MB）。声明比宿主上限更大的值无效；声明更小的值会被强制执行。

`search.provide` 需要在 `permissions.host` 里声明，但它是声明性 capability，**不设运行时 gate** —— 与 provider 执行路径一致，详见 `11-capability-policy.md`。

- `mcp`：**[建议]** v1 不允许 Manifest 直接修改 `settings.mcpServers`；如未来支持 MCP contribution，必须由宿主创建受控配置、独立授权和审计，并复用现有 MCP Manager 的连接/重连语义。

完整 contribution ID 必须带命名空间，例如：

```text
com.example.review/review-chapter
com.example.review/provider/main
com.example.review/openReviewDashboard
```

## 4. 配置、secret 与依赖声明

### 4.1 配置

- **[设计建议]** 插件配置存储在插件命名空间，不直接写入 NarraFork 核心 `settings.json`。宿主提供 `Config API`，支持默认值、schema 校验、迁移和按用户/工作区/叙述者范围覆盖。
- 配置 schema 只允许 JSON Schema 的受控子集：object、array、string、number、integer、boolean、enum、description、default、min/max、pattern 的安全子集；禁止 `$ref` 指向远程 URL、脚本化 `format` 和任意表达式。
- 普通配置可以在管理 UI 展示和导出；导出前必须过滤 secret 引用、运行时令牌和宿主内部路径。
- 配置变更先写宿主存储，再发送 `config.changed`；插件不能把“建议配置”直接覆盖用户配置。

### 4.2 secret 声明

**[设计建议]** Manifest 只声明 secret 元数据：

```json
{
  "secrets": [
    {
      "id": "providerApiKey",
      "label": "Provider API key",
      "required": true,
      "scope": ["user", "workspace"],
      "usage": "outbound-network",
      "inject": "ephemeral-reference"
    }
  ]
}
```

- secret ID 在插件内唯一；完整引用为 `<pluginId>/<secretId>`。
- secret 值不进入 Manifest、命令行、普通配置 JSON、UI iframe、日志、审计 payload 或 core settings 导出。
- 默认注入方式为短期 opaque reference，由 Secret Broker 在单次 RPC/operation 中解析；插件只能在获准的 `secret.use.<id>` scope 内使用。
- 本地进程的环境变量注入不是默认方案，因为子进程、诊断和崩溃 dump 可能暴露环境；若必须使用，宿主应使用短生命周期临时环境/文件，并在退出时清理。
- provider secret 必须绑定 provider instance、用户/工作区 scope 和调用目的，不能因为插件具有后台 grant 就继承最近一次用户的 secret。
- **[待决策]** 首版 Secret Broker 是按 RPC 临时注入，还是优先使用容器 `/run/secrets`；建议先实现 RPC opaque reference，Podman 阶段再增加只读 secret mount。

### 4.3 依赖

**[设计建议]** 依赖分三类：

```json
{
  "dependencies": {
    "plugins": {
      "org.example.shared": ">=1.2 <2"
    },
    "runtime": {
      "bun": ">=1.2 <2"
    }
  }
}
```

- 插件依赖必须按 ID 和 SemVer 解析，禁止循环依赖；依赖缺失时包可以安装但不能启用/激活。
- 依赖的 contribution 和权限不会自动传递给依赖方；调用依赖插件必须经过宿主 proxy 和独立 Grant。
- npm/Bun/Python 等运行时依赖建议在构建时 vendored 或生成锁定清单，安装时离线校验；不在 NarraFork 主进程中执行不受控 `npm install`、`bun install` 或安装脚本。
- 原生模块、动态链接库、安装后脚本和需要系统工具的依赖默认标记为高风险，推荐只允许 Podman runner 或受信任管理员显式批准。
- 依赖包使用自己的不可变版本目录；不得通过相对路径越过包根目录读取另一个插件的文件。

## 5. 包格式与静态校验

### 5.1 包格式

**[设计建议]** v1 使用 `.nfplugin` 后缀的 ZIP 归档，内容自包含：

```text
manifest.json                 # 必须
integrity.json                # 建议，文件摘要和包格式版本
signature.json                # 可选，签名与 keyId
server/index.js               # 可选
ui/review-dashboard.iife.js   # 可选
ui/review-dashboard.css       # 可选
vendor/...                    # 可选，锁定依赖
assets/...                    # 可选，UI 静态资源
migrations/...                # 可选，声明式/受限数据迁移
LICENSE
NOTICE
```

- 不接受包内符号链接、Windows junction、设备文件、FIFO、绝对路径和 `..` 路径。
- 归档解压必须逐项进行路径规范化和真实路径检查，拒绝 zip bomb、重复文件、大小写碰撞和超出总解压大小的包。
- `manifest.json` 解析和静态检查在 staging 目录完成；在校验结束前不执行 server、UI、安装脚本或依赖脚本。
- **[假设]** 未来可支持 `.tar.gz` 导入，但要复用现有 pack 的类型/大小/路径穿越检查；v1 建议只承诺 ZIP，减少跨平台归档差异。

### 5.2 完整性与签名

- **[设计建议]** 无论是否签名，都计算 SHA-256 包摘要和每个文件摘要；运行时启动前校验 `manifest.json`、entry 和 vendor 文件未被替换。
- **[设计建议]** 签名采用可选 Ed25519：签名对象为规范化 Manifest、文件摘要清单、包摘要、`pluginId`、`version` 和签名算法版本。
- `signature.json` 至少含 `algorithm`、`keyId`、`signature`、`signedAt` 和可选 `publisherId`；公钥不随包自动成为信任根。
- 签名可信只证明发布者/完整性，不代表自动启用、自动授予权限或跳过沙箱。
- 未签名或未知 key 的包进入“待批准/受限”状态；未知包不能在未经过管理员确认时执行。
- **[待决策]** 官方信任根、组织私有信任根、吊销列表、离线 key rotation 和签名有效期由发布策略另行确定。

### 5.3 静态校验清单

安装器必须在不执行插件代码的情况下检查：

1. 归档类型、文件数量、单文件大小、总压缩/解压大小。
2. 路径穿越、符号链接、大小写碰撞和重复 entry。
3. `manifest.json` JSON 语法、schemaVersion、字段类型和未知必填语义。
4. pluginId、版本、贡献 ID、provider prefix 和 activation event 引用冲突。
5. server/ui entry 存在且位于包根目录内；entry 扩展名和 format 与 engine/runner 相容。
6. Host API、RPC、平台、CPU、runtime 版本和 runner 可用性。
7. 权限声明是否属于宿主白名单，是否超过当前安装策略允许的最大权限。
8. 配置/secret schema 是否受控、默认值是否泄露敏感信息。
9. 插件/运行时依赖是否满足、是否有循环或不允许的安装脚本。
10. 文件摘要和签名（如存在）是否与包内容一致。

## 6. 安装目录与持久化布局

### 6.1 推荐目录

**[设计建议]** 使用 `getNarraforkHome()` 作为根目录，建议布局如下：

```text
~/.narrafork/
  plugins/
    packages/
      com.example.review/
        1.2.3/
          manifest.json
          server/
          ui/
          vendor/
        1.1.8/
      org.example.shared/
        1.4.0/
    current/
      com.example.review -> ../packages/com.example.review/1.2.3
    staging/
      <operationId>/
    quarantine/
      <pluginId>/<version>/
    cache/
      assets/<pluginId>/<version>/<contentHash>/
    data/
      com.example.review/
        config.json
        storage/
        migrations/
        tmp/
        logs/
    journals/
      install/
      upgrade/
      uninstall/
    trust/
      roots.json
      revocations.json
```

- **[当前事实]** 根目录默认 `~/.narrafork`，测试可使用 `NARRAFORK_HOME` 隔离；上述 `plugins/` 是新增设计目录，不代表当前已实现。
- `packages/<pluginId>/<version>` 不可变；不得原地覆盖已运行版本。
- `current` 可以是符号链接，也可以是平台兼容的文本指针；Windows 不依赖必须可创建 symlink 的权限，宿主应提供原子 pointer 文件实现。
- `data/<pluginId>` 与包目录分离，升级/回滚不覆盖用户配置和私有 storage；包删除不默认删除 data。
- staging、quarantine、journal 只由核心宿主写入；插件只能通过 Storage API 访问自己的 data 子目录映射。
- UI 静态资源使用版本和 content hash 路径；升级生成新 URL，旧资源在无 live session 后再回收。

### 6.2 权限与文件模式

- **[设计建议]** 包目录对运行时只读；data/config/logs 按宿主用户权限创建，Unix 下建议目录 `0700`、secret 文件 `0600`。
- 不把插件目录放入项目 worktree、git 仓库或 `dist/frontend`；插件 UI 通过专用资源路由服务。
- 包、data、日志和缓存不应通过普通静态文件 fallback 暴露；资源路由必须精确匹配并防目录穿越。
- 不把 plugin data、settings、数据库路径和 provider credential path 放入插件环境变量；需要的目录用启动握手下发 opaque logical path 或容器内固定路径。

## 7. 安装、启用与激活

### 7.1 安装状态机

**[设计建议]** 持久化期望状态和运行状态分离：

```text
未安装
  └─ install ─> installed-disabled
                    └─ enable ─> installed-enabled
                    └─ uninstall ─> uninstalling ─> 未安装

installed-enabled
  ├─ activation event ─> starting -> handshaking -> activating -> active
  ├─ disable ─> installed-disabled
  └─ upgrade ─> upgrading -> installed-enabled | rollback | incompatible

active
  ├─ idle stop -> stopped
  ├─ crash -> backoff -> starting | quarantine
  └─ disable/upgrade/shutdown -> draining -> deactivating -> stopped
```

- 期望状态至少包括 `disabled`、`enabled`、`uninstalling`；`incompatible`、`quarantine` 是宿主结果，不应伪装成用户主动禁用。
- 每次运行时 spawn 产生单调递增 `runtimeGeneration`；旧进程迟到消息必须丢弃。
- 同一插件的生命周期操作使用 per-plugin 异步互斥；不同插件可以并行安装/激活，但全局资源配额仍由宿主控制。

### 7.2 install

1. 管理员上传本地 `.nfplugin` 或从受信的离线目录导入。
2. 宿主把字节写入 `staging/<operationId>`，限制上传大小并计算摘要。
3. 解压到临时 staging，执行 5.3 的静态校验；此阶段不 spawn，不加载 UI，不运行依赖安装脚本。
4. 解析 Manifest、贡献索引、依赖图、签名和权限请求，生成待批准摘要。
5. 校验通过后将 staging 目录原子移动到 `packages/<pluginId>/<version>`，写安装 journal 和索引。
6. 初始状态为 `installed-disabled`；只注册静态贡献和“未启用/待授权”诊断。
7. 只有管理员明确执行 enable 并确认高风险权限，插件才进入 `installed-enabled`。

安装失败应清理 staging，但保留有界诊断和失败摘要；不要删除已有版本或当前运行版本。

### 7.3 enable 与首次 activation

- `enable` 只更新期望状态、Grant 和 Activation Index，不启动代码。
- 宿主在激活事件到达时再次校验包摘要、当前版本、权限快照和依赖状态。
- Runtime Supervisor 用参数数组启动 server，建立 stdio framing，执行 `hello`/`initialize`/`initialized` 握手，再发送 `activate` 及触发原因。
- 握手中的 `pluginId`、版本、包摘要、RPC protocol 必须和宿主记录一致；不一致立即 fail closed 并 quarantine。
- 激活成功才把 contribution proxy 标记为 active；激活失败保留静态条目，但返回结构化不可用原因。
- `onStartup` 不应成为第三方默认激活事件；优先使用 provider/tool/command/view 的懒激活。

## 8. 插件进程生命周期

### 8.1 LocalProcessRunner

**[设计建议]** v1 可使用本地独立进程，但必须明确这是故障隔离而非安全沙箱：

- 使用 `Bun.spawn`/等价 API 的参数数组，不经过 shell；只传 allowlist 环境变量。
- cwd 只能是版本包只读目录、插件 data 目录或宿主创建的 tmp 目录。
- stdout 只承载 RPC，stderr 使用有界 ring buffer；stderr 不得无限累积。
- 进程启动、握手、激活、普通调用、drain 和 shutdown 都有独立超时；参考 `02-host-architecture.md` 的 15s/30s/15s/60s/5s 基线。
- 支持 AbortSignal 和显式 cancel；取消不响应时先关闭请求，再在宽限期后终止进程。
- 递归清理子进程树；Unix 使用进程组/子进程遍历，Windows 使用 `/T` 终止，避免类似现有终端、MCP 和 Bash 子进程的孤儿问题。
- 可参考 `safeSpawn` 的输出上限、watchdog 和 long-running 诊断，但插件 RPC 需要流式 reader、credit window 和 request generation，不能完整收集 stdout 后再处理。

### 8.2 idle、重启与 quarantine

- **[设计建议]** 普通 command/tool 完成且无 lease 后允许 idle stop；provider 活跃会话、UI backend session 或后台任务可持有有期限 lease。
- 进程异常退出时立即失败在途请求，保留 contribution 的 unavailable 状态，不删除用户配置或布局引用。
- 自动重启使用抖动指数退避和滑动窗口预算；建议初始为 1 分钟最多 3 次、15 分钟最多 10 次，超过后进入 quarantine。
- 连续协议错误、身份不一致、无视 cancel、超过帧/队列/资源限制或检测到越权路径时，不应无限重启。
- quarantine 需要管理员显式重试或冷却策略；重试必须重新走静态完整性、授权和健康检查。

### 8.3 核心退出与宿主重启

**[当前事实]** `server/main.ts` 会先写 clean-shutdown marker，再以每步硬超时清理 terminal、Bash、MCP、浏览器和其他子系统，并在 Windows 退出时清理自己的子进程树。

**[设计建议]** Plugin Manager 接入相同模式：

```text
停止接收新激活/新调用
→ 广播 drain
→ 取消可取消请求
→ deactivate
→ shutdown
→ 超时 kill
→ 写 runtime lease/journal
```

插件清理超时不能阻塞 HTTP server、数据库 clean marker、实例锁释放或整体退出。下次启动把未完成 lease 视为丢失，重新建立 runtime generation，不假定旧插件已经执行 deactivate。

## 9. 升级、回滚与卸载

### 9.1 upgrade

```text
导入新包到 staging
→ 静态校验/摘要/签名/兼容/依赖
→ 读取存储迁移声明
→ 标记 upgrading，拒绝新调用
→ drain/cancel 旧 runtime
→ 停止旧 runtime
→ 原子切换 current 指针
→ 启动受限 health activation
→ 成功提交 journal，保留旧包
```

- 新旧版本不同时写同一 plugin storage；升级期间只有一个可写版本。
- 不覆盖旧目录；旧版本按数量/空间策略保留，以便快速回滚。
- 配置 schema 和 viewState migration 必须有版本号、输出上限、超时和 journal；不能在核心主线程执行任意第三方 migration JS。
- 不可逆迁移前必须生成宿主侧 namespaced storage snapshot，或在 UI 中明确告知“升级成功后只能手动恢复”。
- 新版本健康检查失败时恢复旧 `current` 指针、旧 Grant 和旧 runtime；新包转入 quarantine，记录失败原因。
- 旧版本也必须重新做完整性检查，不能因为曾经运行过就跳过校验。

### 9.2 rollback

- 回滚只选择已安装且摘要完整的历史版本；不得从不可信缓存直接启动。
- 回滚前停止新版本、撤销新版本动态贡献和 secret handle，再恢复旧版本。
- 若新版本已完成不可逆存储迁移，只有在存在 snapshot 或迁移声明保证向后兼容时自动回滚；否则进入人工恢复状态，不伪装为成功。
- UI layout 中保留 contribution ID 和 `viewStateVersion`；旧版本无法理解时显示恢复占位，而不是删除整个 Dockview layout。

### 9.3 uninstall

```text
标记 uninstalling
→ 从 Activation Index 移除
→ 拒绝新调用
→ drain/cancel/deactivate/shutdown
→ 撤销 Grant、secret handle、事件订阅和 UI session
→ 删除版本包、缓存和运行时临时目录
→ 默认保留 namespaced config/storage 与缺失引用
→ 用户显式选择后 purge data
→ 完成 uninstall journal
```

- 卸载默认不删除 `data/<pluginId>`，便于重新安装后恢复配置和 panel state。
- secret grant 和可继续使用的句柄立即撤销，即使用户保留插件数据。
- 例程、模型配置、菜单和 Dockview layout 中的引用保留 `<pluginId>/<contributionId>` 缺失占位，重新安装且兼容时可恢复。
- 强制卸载可以跳过插件自己的 deactivate，但不能跳过宿主撤销权限、终止进程、清理注册表和审计。
- **[待决策]** 数据默认保留期限、旧包保留数量、purge 是否需要二次确认和管理员审计由产品策略确认。

## 10. 安装与运行时限制基线

**[假设]** 初始实现可以采用以下安全基线，最终数值需与 RPC/UI 文档统一：

| 对象 | 建议上限 | 超限处理 |
|---|---:|---|
| `.nfplugin` 压缩包 | 100 MiB | 拒绝导入 |
| 解压后总大小 | 500 MiB | 拒绝解压 |
| Manifest | 256 KiB | 拒绝安装 |
| 单文件 | 50 MiB | 拒绝安装或改用受控附件 |
| RPC 单帧 | 1 MiB | 协议错误并终止运行时 |
| 运行时排队 | 8 MiB | 施加背压，达到硬限失败请求 |
| 最大在途 RPC | 16 | 返回 busy |
| stderr ring buffer | 1 MiB/进程 | 丢弃最旧内容 |
| 安装/升级并发 | 1 个/插件 | 其余排队或冲突 |

- **[设计建议]** 所有限制按 UTF-8 bytes 计算，不以 JavaScript 字符数代替。
- **[设计建议]** 归档校验、哈希、解压、签名验证和大文件读写不能在 HTTP 请求路径无界同步执行；应使用受限后台 job/subprocess，并提供取消、超时和进度。

## 11. 阶段取舍与待决策

### 11.1 分阶段落地

1. **阶段一：静态目录与 LocalProcessRunner**
   - Manifest schema、包校验、版本目录、安装/禁用/启用、静态 contribution index、stdio handshake、诊断。
   - 不开放 workspace 文件写入、任意网络、secret 读取和进程派生。
2. **阶段二：公共 API 与生命周期完善**
   - Query/Command/Event、配置、namespaced storage、secret broker、取消/背压、重启预算和审计。
3. **阶段三：provider 与升级恢复**
   - Provider Registry、RemoteProviderAdapter、模型目录缓存、升级 journal、migration snapshot、回滚。
4. **阶段四：UI iframe 与 Podman**
   - host-controlled shell、MessageChannel、Dockview adapter、PodmanRunner、网络/文件/资源硬隔离。
5. **阶段五：签名和组织分发**
   - Ed25519 签名、信任根、撤销、离线分发、私有仓库和自动升级策略。

### 11.2 主要待决策

- **[待决策]** v1 是否只支持 ZIP `.nfplugin`；建议是，tar.gz 作为后续导入格式。
- **[待决策]** 第三方插件默认 LocalProcessRunner 还是 PodmanRunner；建议默认“受限插件用本地进程，沙箱级插件必须 Podman”，并在 UI 明确本地模式不是安全沙箱。
- **[待决策]** 官方插件是否允许 `onStartup`；建议仍需显式策略，不因官方身份绕过懒激活。
- **[待决策]** 是否允许插件贡献 MCP server；建议 v1 不直接改 `settings.mcpServers`，未来通过受控 adapter 接入 `McpManager`。
- **[待决策]** Host API 兼容窗口、旧包保留数量、数据保留期限和不可逆 migration 的发布门槛。
- **[待决策]** 首版 UI 只支持 IIFE 还是同时支持 ESM；建议 IIFE。

## 12. 验收标准

- **[设计建议]** 仅导入包不会执行 server、UI、安装脚本或依赖脚本。
- **[设计建议]** Manifest 缺字段、schemaVersion 不兼容、路径穿越、entry 缺失、贡献冲突、依赖循环和权限未知时均能在不执行插件代码的情况下给出诊断。
- **[设计建议]** 同一 `pluginId` 的不同版本可并存，升级不会覆盖旧目录，失败可恢复旧 `current`。
- **[设计建议]** disable、uninstall、核心重启和 Windows 退出不会留下插件子进程或可继续使用的 secret handle。
- **[设计建议]** 插件崩溃、超时、协议错误或 quarantine 不影响 NarraFork 核心 HTTP/WS、数据库和其他插件。
- **[设计建议]** UI layout、例程和模型配置在插件禁用、缺失、升级失败时保留可诊断占位，不静默删除用户数据。
- **[设计建议]** 每个安装、授权、激活、升级、回滚、卸载和高风险调用都能在审计中按 `pluginId`、版本、摘要和 operation ID 追踪。
