# UI、iframe Bridge 与 Dockview 插件设计

> 本文只设计前端 UI 插件宿主、iframe bridge 与 Dockview 接入。后端插件进程、公共事件/查询权限、Manifest 完整格式与安装安全分别由其他设计文档定义；本文给出的字段名应在总设计整合时统一。

## 1. 标记与范围

本文使用以下标记区分信息性质：

- **[事实]**：当前仓库代码已经存在的行为。
- **[建议]**：本文推荐的目标设计。
- **[假设]**：为完成设计暂时采用、需由其他文档确认的前提。
- **[待决策]**：实现前必须明确的产品或协议选择。

本文覆盖：

- sandbox iframe 与静态 UI 资源加载；
- `MessageChannel`、版本协商、RPC、取消与错误处理；
- context、事件、commands、notifications、storage、认证代理等 UI API；
- `PluginDockPanel`、panel params、`addPanel` 与布局持久化；
- 插件缺失、禁用、升级和异常时的恢复；
- 单 narrator focus dock、workspace、多 narrator 和 director 模式；
- UI contribution points、静态路由约束以及禁止任意 React/DOM 注入。

## 2. 当前前端事实与约束

### 2.1 Dockview surface

- **[事实]** `DockviewSurface` 是复用层，统一注册 Dockview components、tab components、主题、拖放语义和 `DockviewApi`。
- **[事实]** `DockviewSurface` 支持 `defaultRenderer="always"`。该模式让 Dockview 中不可见或跨 group 移动的 panel 保持 DOM 和 React 实例，避免 WebSocket、终端、滚动位置等状态因拖动而重建。
- **[事实]** 单 narrator 的 `NarratorDock` 和多 narrator 的 `DockviewWorkspace` 均显式使用 `defaultRenderer="always"`。
- **[事实]** Dockview component 是静态 registry 中的 React adapter；panel 的业务类型和身份放在 `params` 中，panel 通过 `api.close()`、`api.setTitle()`、`api.updateParameters()` 等方法操作自身。

### 2.2 Focus dock 与 workspace

- **[事实]** focus dock 的布局按 `narratorId + device` 保存到 `localStorage`，带版本 envelope 和最后打开时间；超过 30 天的旧布局会在应用启动时清理。
- **[事实]** focus dock 持久化前会移除 panel params 中的 `narratorId` 和 `chapterId`，恢复后以当前页面的 `NarratorDockContext` 为身份真值，避免把 narrator A 的身份恢复到 narrator B 页面。
- **[事实]** workspace 布局保存到服务端 `workspaces.tree`，envelope 中包含 Dockview `SerializedDockview` 和 director 状态；写入由布局变化触发并防抖。
- **[事实]** workspace 的一个 Dockview surface 可以同时承载多个 narrator。共享协调状态按 `narratorId` 分片，narrator tool panel 的 params 必须携带所属 `narratorId`，panel ID 也按 narrator 命名空间隔离。
- **[事实]** workspace 关闭 narrator 主 panel 后，会清理其孤立 tool/subagent panel。
- **[事实]** `addPanel` 的 component 名来自静态 registry，params 必须可被 Dockview 序列化和恢复。

### 2.3 Director 模式

- **[事实]** director 是 workspace route 上方的独立 overlay；底层 Dockview 保持挂载但被隐藏。
- **[事实]** 当前 director 只直接渲染 narrator、terminal、webview；narrator tool 和 subagent 不进入顶层 director leaf 列表。
- **[事实]** 当前 built-in panel 在 director overlay 中会由 `DirectorLayout` 重新渲染，底层对应 adapter 在 director 激活时停止渲染内容，以避免同一 narrator/terminal 被挂载两次。
- **[建议]** 插件 iframe 不应简单复制这一做法，否则每次进入/退出 director 都会重建 browsing context、断开 `MessagePort` 并丢失插件内存状态。第 12 节给出稳定 iframe runtime 的方案。

### 2.4 路由、认证与全局 Provider

- **[事实]** TanStack Router 的 route tree 由 Vite 插件从 `frontend/routes` 在构建期生成；运行期安装的插件不能增加新的文件路由。
- **[事实]** `main.tsx` 在单一 React root 中挂载 Mantine、确认对话框、图片查看器、Notifications、React Query 和 Router，并启用 React StrictMode。
- **[事实]** 当前前端 JWT 位于宿主页面 `localStorage` 的 `narrafork_token`，宿主 API client 把它放入 `Authorization: Bearer ...`。
- **[事实]** 生产服务器只对“不含点号”的未知前端路径执行 SPA `index.html` fallback；真实静态文件按精确路径提供。Vite dev server 当前只代理 `/api` 和 `/ws`。
- **[事实]** PWA 构建只预缓存既定 frontend assets；运行期安装的插件资源不在当前构建期 glob 中。
- **[事实]** 现有普通 `WebviewPanel` 使用允许 `allow-same-origin` 的 iframe sandbox。它面向用户指定网页，不应直接作为第三方插件 iframe 的安全模板。

## 3. 目标与非目标

### 3.1 目标

- **[建议]** 第三方 UI 永远运行在独立 sandbox iframe，不进入宿主 React tree。
- **[建议]** 插件只通过版本化 UI bridge 访问宿主能力，不能得到 JWT、`DockviewApi`、Router、QueryClient、内部 context、原始 event bus 或服务对象。
- **[建议]** 同一个通用 `PluginDockPanel` adapter 承载所有插件 panel，插件安装、禁用或缺失时仍能恢复 Dockview 布局。
- **[建议]** focus、workspace、多 narrator 和 director 使用同一套 panel/runtime 协议，只由 context scope 不同。
- **[建议]** UI contribution 是静态、声明式、可校验的；宿主决定最终 chrome、位置、权限和可见性。
- **[建议]** panel 拖动、tab 切换和普通隐藏不销毁 iframe；不可避免的重载必须有明确 lifecycle reason，并能从 params/storage 恢复。

### 3.2 非目标

- **[建议]** 不支持插件向宿主注册任意 React component、hook、Provider、route module、CSS 或 JavaScript 回调。
- **[建议]** 不支持 Module Federation、运行期 `import()` 第三方包到主窗口、`eval` 插件代码、向 `#root` 注入 DOM、替换 Dockview tab renderer 或修改 Mantine theme。
- **[建议]** 不把任意 `/api/*` HTTP 代理包装成插件 API；插件只能使用经过权限检查的公共 query/command/event API，或调用自己的后端插件 endpoint。
- **[建议]** 不保证插件 iframe 能访问宿主 DOM、宿主 localStorage、同源 Cookie、Service Worker、剪贴板、文件系统或外部网络。

## 4. 总体架构

```text
Plugin manifest/contributions
          │
          ▼
PluginContributionRegistry（只读、已校验）
          │
          ├── host menus / command palette / settings navigation
          └── addPluginPanel(...)
                    │
                    ▼
DockviewApi.addPanel({
  component: "plugin",
  params: PluginDockPanelParams
})
                    │
                    ▼
PluginDockPanel（宿主 React adapter/chrome/恢复占位）
                    │ 注册可见 slot
                    ▼
PluginUiRuntimeProvider / PluginUiLayer
                    │ 每 panelInstanceId 一个稳定 iframe + MessagePort
                    ▼
sandbox iframe ── MessageChannel RPC ── HostUiBridge
                                           │
                                           ├── context/events/commands
                                           ├── notifications/storage
                                           └── authenticated host/backend proxy
```

- **[建议]** `PluginContributionRegistry` 只保存安装并启用的、已通过 Manifest 校验的 contribution。插件 iframe 不能在运行时扩大 contribution 集合。
- **[建议]** `PluginUiRuntimeProvider` 放在 Router 外、Notifications 与 QueryClient 可用的宿主 Provider 层中；它管理所有 iframe session，但不把内部对象暴露给插件。
- **[建议]** 每个 panel instance 有独立 runtime、独立 `MessageChannel`、独立权限快照和独立取消域。一个插件的多个 panel 不能隐式共享 port。
- **[建议]** 插件跨 panel 通信应经 namespaced storage、插件后端或显式 `plugin.<pluginId>.*` 消息能力，不共享宿主对象引用。

## 5. sandbox iframe

### 5.1 sandbox 基线

推荐默认 iframe：

```tsx
<iframe
  sandbox="allow-scripts"
  referrerPolicy="no-referrer"
  allow=""
  title={hostResolvedTitle}
/>
```

- **[建议]** 默认只启用 `allow-scripts`。
- **[建议]** 禁止 `allow-same-origin`。同源脚本与 `allow-same-origin` 同时存在时，隔离边界显著变弱，插件还可能读到宿主 origin 下的资源。
- **[建议]** 默认禁止 forms、popups、downloads、modals、top navigation、pointer lock、camera、microphone、geolocation 和 clipboard。
- **[建议]** 打开外部链接通过 `env.openExternal` host command，宿主校验协议、权限和用户确认，不给 iframe `allow-popups`。
- **[建议]** 需要下载时使用宿主生成的受控下载 action，不让插件直接获得文件系统或认证 URL。
- **[建议]** iframe 使用 host-controlled HTML shell。插件包只声明经过校验的 JS/CSS entry，不直接控制外层 HTML、CSP、`<base>`、meta refresh 或 sandbox 属性。

### 5.2 CSP 与网络

**[建议]** host-controlled shell 设置至少如下策略，实际 origin/hash 由资源服务生成：

```text
sandbox allow-scripts;
default-src 'none';
script-src <plugin-asset-origin>;
style-src <plugin-asset-origin> 'unsafe-inline';
img-src <plugin-asset-origin> data: blob:;
font-src <plugin-asset-origin>;
connect-src 'none';
frame-src 'none';
object-src 'none';
base-uri 'none';
form-action 'none';
```

- **[建议]** 插件默认不能直接 `fetch` NarraFork API 或公网；网络能力统一走 bridge/backend proxy。
- **[建议]** 不允许远程 script、远程 stylesheet 或运行期 CDN 依赖。安装包应自包含。
- **[建议]** 插件 asset response 使用准确 MIME、`X-Content-Type-Options: nosniff`、不可变版本路径和内容 hash。
- **[建议]** 若使用 ESM entry，sandbox opaque origin 下的 module fetch 需要资源路由提供适当 CORS；更简单的 MVP 是要求 UI entry 构建成单个 classic/IIFE bundle。
- **[待决策]** 首版是否只允许 IIFE bundle，还是同时支持 ESM + 动态 chunk。若支持动态 chunk，Manifest、CSP、CORS 和离线升级必须一起设计。

### 5.3 iframe 不持有身份凭据

- **[建议]** iframe 内永不注入 JWT、API token、Cookie、用户密码、provider secret 或后端插件 secret。
- **[建议]** bridge context 中的 `user` 仅包含展示所需的最小字段；用户 ID 也应受权限和用途约束。
- **[建议]** iframe 不能把 context 当作后端认证证明。所有后端调用仍由宿主和服务端重新绑定当前用户、pluginId、panel session 与权限。

## 6. MessageChannel 与 RPC

### 6.1 建连

1. **[建议]** 宿主为 panel instance 创建 128 bit 随机 `connectNonce`、`MessageChannel` 和 session record。
2. **[建议]** iframe 加载完成后，宿主只在 bootstrap 阶段调用一次 `contentWindow.postMessage`，转移 `port2`。
3. **[建议]** 因 sandbox iframe 的 `event.origin` 可能是 `"null"`，不能只依赖 origin。插件 SDK 必须同时校验 `event.source === window.parent`、消息类型和 `connectNonce`。
4. **[建议]** 建连后关闭 window-level message listener，所有通信只走转移的 `MessagePort`。
5. **[建议]** 宿主把 session 绑定到 `{ userId, pluginId, contributionId, panelInstanceId, surfaceScope }`；插件不能在 RPC params 中改写这些绑定。
6. **[建议]** iframe reload、panel remove、route unmount、插件禁用或用户退出时关闭 port，并取消该 session 的所有未完成请求和订阅。

Bootstrap 示例：

```ts
interface UiBootstrapMessage {
  type: "narrafork:ui-connect";
  nonce: string;
  protocol: "narrafork.ui";
  hostProtocolRange: { min: 1; max: 1 };
}

// 由宿主执行；插件不主动向未知 window 广播连接请求。
iframe.contentWindow?.postMessage(message, "*", [channel.port2]);
```

### 6.2 协议 envelope

**[建议]** 虽然 `MessagePort` 支持 structured clone，公共协议只允许 JSON value，便于审计、持久化、录制和跨 SDK 实现：

```ts
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type RpcRequest = {
  protocol: "narrafork.ui/1";
  kind: "request";
  id: string;
  method: string;
  params?: JsonValue;
};

type RpcResponse =
  | {
      protocol: "narrafork.ui/1";
      kind: "response";
      id: string;
      result: JsonValue;
    }
  | {
      protocol: "narrafork.ui/1";
      kind: "response";
      id: string;
      error: UiRpcError;
    };

type RpcNotification = {
  protocol: "narrafork.ui/1";
  kind: "notification";
  method: string;
  params?: JsonValue;
};

interface UiRpcError {
  code:
    | "METHOD_NOT_FOUND"
    | "INVALID_PARAMS"
    | "PERMISSION_DENIED"
    | "CONTEXT_UNAVAILABLE"
    | "NOT_FOUND"
    | "CONFLICT"
    | "RATE_LIMITED"
    | "PAYLOAD_TOO_LARGE"
    | "TIMEOUT"
    | "CANCELLED"
    | "PLUGIN_DISABLED"
    | "HOST_UNAVAILABLE"
    | "INTERNAL_ERROR";
  message: string;
  retryable?: boolean;
  details?: JsonValue;
}
```

### 6.3 版本、取消、上限与背压

- **[建议]** 建连先执行 `handshake`，协商整数 protocol version；无共同版本时显示“不兼容插件 UI”恢复页，而不是执行部分 API。
- **[建议]** 每个 request 支持 `rpc.cancel({ requestId })`；host 为异步调用建立 `AbortController`。
- **[建议]** 常规 UI RPC 默认 10 秒超时，插件后端 command 默认 30 秒；长任务返回 task handle，通过事件报告进度，而不是无限悬挂一个 request。
- **[建议]** 单条 request/notification 上限暂定 256 KiB，单条 response 上限暂定 1 MiB；大数据必须分页、游标或流式分块。
- **[建议]** 每个 session 的事件队列有界。状态类事件合并到最新值，业务事件超限时丢弃最旧项并发出一次 `events.overflow`。
- **[建议]** narrator token stream、terminal output、完整 diff 等高频/大字段不进入通用 event API；需要专门的分页/流式能力。
- **[建议]** host 记录方法名、pluginId、耗时、结果码和大小，但不默认记录敏感 params/result 正文。
- **[待决策]** 上述大小、超时和队列数字需与事件/权限文档统一。

## 7. UI API

所有 API 都是 host 实现的 RPC method，不是向 iframe 注入可变对象。SDK 可以把它们包装成 Promise/subscribe 接口。

### 7.1 生命周期与 panel API

```ts
interface PanelApi {
  getState(): Promise<PluginPanelState>;
  setTitle(input: { title: string }): Promise<void>;
  setBadge(input: { text?: string; tone?: "neutral" | "info" | "success" | "warning" | "danger" }): Promise<void>;
  setDirty(input: { dirty: boolean }): Promise<void>;
  updateParams(input: { patch: JsonValue }): Promise<void>;
  focus(): Promise<void>;
  close(): Promise<void>;
  open(input: OpenPluginPanelInput): Promise<{ panelInstanceId: string }>;
}
```

- **[建议]** `panel.updateParams` 只能修改该 contribution 声明的 `viewState`，不能修改 `pluginId`、`contributionId`、scope binding、权限或 component key。
- **[建议]** title、badge、dirty 状态由宿主 chrome 渲染；插件不能提供 React node、HTML、CSS class 或事件 callback。
- **[建议]** `panel.close()` 可被宿主策略拒绝，例如不可关闭的核心/固定 panel。
- **[建议]** host 向插件发送：`panel.activeChanged`、`panel.visibilityChanged`、`panel.sizeChanged`、`panel.paramsChanged`、`panel.beforeClose`、`panel.disposing`。
- **[建议]** `beforeClose` 只允许短时间请求宿主确认，不允许插件永久阻止关闭；超时按可关闭处理。

### 7.2 Context API

```ts
interface UiContextSnapshot {
  contextVersion: number;
  host: {
    appVersion: string;
    locale: string;
    colorScheme: "light" | "dark";
    platform: "windows" | "macos" | "linux" | "unknown";
  };
  plugin: {
    id: string;
    version: string;
    contributionId: string;
    panelInstanceId: string;
  };
  surface: {
    kind: "narrator-focus" | "workspace" | "director" | "settings";
    active: boolean;
    visible: boolean;
  };
  narrator?: {
    id: string;
    chapterId?: string | null;
    projectId?: string | null;
  };
  workspace?: {
    id: string;
    ownerNarratorId?: string;
    narratorIds?: string[];
    presentation: "grid" | "director";
  };
  route: {
    routeId: string;
  };
}
```

- **[建议]** `context.get()` 返回权限过滤后的不可变 snapshot；`context.subscribe()` 在 snapshot 版本变化时通知。
- **[建议]** focus panel 的 narrator/chapter 身份来自 live route/context，不从持久化 params 恢复。
- **[建议]** workspace 中 narrator-scoped plugin panel 必须绑定明确的 `ownerNarratorId`；不得用“当前最后激活 narrator”隐式推断，否则多 narrator 切换会造成越界或串号。
- **[建议]** global/workspace-scoped panel 默认不获得任意 narrator 详情；如需 narrator 列表或数据，必须通过有权限的 query API。
- **[建议]** route 只暴露稳定 `routeId` 和必要资源 ID，不暴露 Router 实例、完整 URL query、history state 或任意 loader data。
- **[建议]** theme/locale/context 变化发送增量通知，但 SDK 应允许插件重新获取完整 snapshot。

### 7.3 Events API

```ts
interface EventsApi {
  subscribe(input: {
    topics: string[];
    filter?: JsonValue;
  }): Promise<{ subscriptionId: string }>;
  unsubscribe(input: { subscriptionId: string }): Promise<void>;
}
```

- **[建议]** topic、filter schema 和字段脱敏由公共事件文档定义；UI bridge 只负责 session、队列、取消和交付。
- **[建议]** 不暴露内部 `eventBus` 名称、任意监听器或原始 payload。
- **[建议]** host 在订阅时和每次交付时都检查权限，以支持权限被撤销、插件禁用或用户身份变化。
- **[建议]** event notification 包含单调 `seq`、时间、topic、data；发生丢弃时发送 `events.overflow`，插件随后应主动 query 当前状态。
- **[建议]** panel 不可见时，默认暂停非关键事件并合并状态事件；插件可声明少量 background topic，但需单独权限和资源预算。
- **[建议]** 插件只能发布 `plugin.<自身 pluginId>.*` 的插件私有事件，不能伪造 `narrafork.*` 核心事件。

### 7.4 Commands API

- **[建议]** command 是带 schema、权限和审计的动作边界，适合菜单项、通知 action、快捷键和插件到宿主调用。
- **[建议]** command ID 全局命名：核心命令 `narrafork.*`，插件命令 `plugin.<pluginId>.*`。
- **[建议]** 插件 Manifest 静态声明 command title、参数 schema、执行位置和 enablement 条件；不能从 iframe 动态注册任意 callback。
- **[建议]** command handler 可以位于插件后端，或由某个已连接 UI panel 处理。UI handler 不在线时，宿主返回 `HOST_UNAVAILABLE`，而不是自动打开隐藏 iframe，除非 contribution 显式声明可激活。
- **[建议]** `commands.execute` 只能调用当前授权范围内的核心命令和自身插件命令。
- **[建议]** enablement 使用宿主支持的有限 context-key 表达式，不执行插件 JavaScript。

示例：

```ts
await narrafork.commands.execute("narrafork.narrator.open", {
  narratorId: "..."
});
```

### 7.5 Notifications API

```ts
interface ShowNotificationInput {
  title: string;
  message: string;
  severity?: "info" | "success" | "warning" | "error";
  dedupeKey?: string;
  autoCloseMs?: number | false;
  actions?: Array<{
    title: string;
    command: string;
    args?: JsonValue;
  }>;
}
```

- **[建议]** 使用现有 Mantine Notifications 作为宿主渲染器，通知上显示插件名称/来源。
- **[建议]** title/message 是纯文本；禁止 HTML、Markdown HTML、React node、任意 icon component 和 `onClick` callback。
- **[建议]** action 只能引用已声明且当前可执行的 command。
- **[建议]** 每插件限速、限制同时可见数、限制文本长度，并允许用户关闭该插件通知。
- **[建议]** notification ID 是 session 级 opaque ID，插件只能 update/dismiss 自己创建的通知。
- **[假设]** 需要持久通知时应委托服务端通知系统，而不是让 iframe 常驻维持；具体权限由事件/API 文档定义。

### 7.5b 主题 token 与 i18n API（已实现）

面板运行在独立 document 里，拿不到宿主的样式表和 i18n 实例。若不提供这两样，
每个面板都会自己长出一套硬编码配色和一套语言检测——这已经发生过：
`cline-external` 硬编码了 8 个十六进制色值且只有英文，

#### 主题：CSS 变量，插件零代码

宿主向 iframe 注入 `<style id="nf-tokens">`，内容是当前生效的 14 个语义 token：

| 用途 | 变量 |
|---|---|
| 页面背景 / 正文 / 次要文字 | `--nf-color-body`、`--nf-color-text`、`--nf-color-dimmed` |
| 面板底色 / 边框 | `--nf-color-surface`、`--nf-color-border` |
| 主色 / 悬停 | `--nf-color-primary`、`--nf-color-primary-hover` |
| 语义色 | `--nf-color-error`、`--nf-color-success`、`--nf-color-warning` |
| 字体 | `--nf-font`、`--nf-font-mono` |
| 圆角 / 间距 | `--nf-radius`、`--nf-spacing` |

**用法：** `color: var(--nf-color-text, #e6e6e6)`。
带 fallback 是必要的——老宿主不注入任何 token，此时 fallback 就是面板原本的样子。

**值来自 `getComputedStyle(document.documentElement)`，不是一张映射表。**
这是本能力的关键实现决定：OLED（`frontend/styles/oled.css`）和插件贡献主题
（`theme-compiler.ts`）都是**覆写同一批 `--mantine-*` 变量**生效的，
所以读取实际计算值能让两者自动流到面板；而硬编码「dark 就是 #1a1b1e」的表两者都拿不到，
且症状只是颜色差一档，没人会报告。`host-tokens.test.ts` 专门钉住这一点。

**主题切换无需插件参与**：宿主重写那个 `<style>` 的内容，浏览器自行重算。
触发源有四个——Mantine colorScheme、OLED、插件主题（三者是 `<html>` 属性，
由一个 `MutationObserver` 覆盖）以及插件主题**规则内容**变化
（属性没动，由 `PluginThemeInjector` 显式调用 `notifyPluginThemeChanged()` 上报）。

**token 集合刻意只有 14 个。** 每个名字都是插件可以永久引用的公开契约，
导出整套 Mantine 变量会让任何内部重构变成第三方插件的破坏性变更。
这与 `theme-compiler.ts` 只接受白名单 token（而非裸 CSS）是同一个取舍，方向相反。

#### i18n：宿主给规则，插件给词表

```ts
interface PluginI18nApi {
  /** 宿主当前语言（已归一化，如 `en`、`zh-CN`）。getter，随宿主切换变化。 */
  readonly locale: string;
  /** 查表 + 回退 + 插值。每次调用按当前 locale 现算。 */
  t(
    tables: { en: Record<string, string>; [locale: string]: Record<string, string> | undefined },
    key: string,
    params?: Record<string, string | number>,
  ): string;
  /** 语言变化时重渲染。返回退订函数。 */
  onChange(listener: (locale: string) => void): () => void;
}
```

**词表留在插件侧**，因为只有插件知道自己的文案；宿主提供的是对所有插件都一样的部分：
当前语言是什么、缺翻译时怎么回退。

**回退顺序**用宿主自己的 `getLocaleFallbackChain`：精确匹配 → 别名归一
（`zh-Hans`/`zh-SG` → `zh-CN`）→ `en` → **返回 key 本身**。
返回 key 而不是空串：按钮上显示 `signIn` 一眼看出是缺翻译，
空按钮则与渲染故障无法区分，会被当成后者排查。
`en` 表是必需的，因为它终结每条回退链。

**插值** `{name}`，缺参数时保留原样占位符（同理，可见的 `{amount}` 比空白好排查）。
单次替换，不递归——否则译文可以插值到调用方未打算暴露的参数。

**⚠️ 语言跟随需要插件配合，主题不需要。** 这是两条通道的真实差异：
CSS 变量一改浏览器自己重算，而**已经写进 DOM 的字符串只能由插件重写**。
不订阅 `onChange` 的面板会在切语言后保持旧文案直到重挂载——
这是插件的选择，不是平台缺陷。

**不暴露宿主自己的翻译资源。** 宿主 `settings` 命名空间的键名随普通重构而变，
目的是与内置面板无法区分），但那是一次性人工核对，不是运行时依赖。

#### 首帧值与 `context.host` 的关系

`locale`、`localeChain` 和 token CSS 都随 shell bootstrap 传入，因为
`context.get` 是异步 RPC，无法在插件首帧前完成——否则面板会先无样式、错语言地画一遍再自我纠正。

`context.host.locale` 与 `context.host.colorScheme` 仍然存在，但它们是**建立时的快照**
（`context.subscribe` 尚未实现）。跟随语言用 `narrafork.i18n`，跟随主题用 CSS 变量；
`context.host` 的这两个字段只适合做一次性判断。

> 实现：`frontend/components/plugins/host-tokens.ts`（token 定义与读取）、
> `host-presentation.ts`（变化侦测）、`asset-shell.ts`（注入与 SDK）、
> `plugin-i18n.ts`（宿主侧查表）。
> shell 内联了第二份查表实现（它是模板字符串，无法 import），
> `asset-shell-presentation.test.ts` 用同一批输入比对两者，防止漂移。

### 7.6 Storage API

```ts
type StorageScope = "session" | "device" | "user" | "workspace" | "narrator";

interface StorageApi {
  get(input: { scope: StorageScope; key: string }): Promise<{ value: JsonValue | null }>;
  set(input: { scope: StorageScope; key: string; value: JsonValue }): Promise<void>;
  delete(input: { scope: StorageScope; key: string }): Promise<void>;
  list(input: { scope: StorageScope; prefix?: string; cursor?: string; limit?: number }): Promise<{
    items: Array<{ key: string; value: JsonValue }>;
    nextCursor?: string;
  }>;
}
```

- **[建议]** namespace 由宿主强制绑定为 `{pluginId, userId, scopeResourceId}`，iframe 不能传入另一个 pluginId/userId。
- **[建议]** `session` 仅存内存；`device` 由宿主 local storage/IndexedDB adapter 管理；`user/workspace/narrator` 由服务端 namespaced storage 管理。
- **[建议]** opaque sandbox origin 下不依赖 iframe 自己的 localStorage。即使浏览器允许，也不把它视为可靠或可迁移存储。
- **[建议]** storage 只接收 JSON，不保存 token、密码、provider secret 或大文件。
- **[建议]** 暂定单值 64 KiB、每插件每用户 1 MiB、list 最大 100 项；超限返回 `PAYLOAD_TOO_LARGE` 或 quota error。
- **[建议]** panel 的小型可布局状态放 `panel params.viewState`，跨 panel/跨设备状态放 storage；不要把大状态塞入 Dockview layout。
- **[待决策]** `device` storage 在浏览器清理、PWA、多设备间的语义，以及卸载插件时是否默认保留 user storage。

### 7.7 认证代理与后端调用

**[建议]** 提供两类明确 API，而不是通用任意 fetch：

1. `queries.execute(queryId, input)` / `commands.execute(commandId, input)`：访问 NarraFork 公共能力。
2. `backend.call(method, input)`：只调用当前 pluginId 自己注册的后端插件 RPC。

调用链：

```text
iframe
  -> MessagePort backend.call("analyze", input)
  -> HostUiBridge（绑定 pluginId、user、panel scope、权限）
  -> 宿主 API client（此处才读取 JWT）
  -> /api/plugins/{boundPluginId}/ui-rpc
  -> 服务端再次校验用户、插件启用状态、权限、schema
  -> 后端插件
```

- **[建议]** iframe 永远看不到 Authorization header、JWT、refresh token、response cookie 或服务端内部地址。
- **[建议]** pluginId 由 session 绑定并由宿主拼接，不能由 iframe params 选择。
- **[建议]** 服务端不能因为请求来自宿主前端就跳过插件权限检查。
- **[建议]** response 只返回 schema 允许的 body，不透传敏感 headers。
- **[建议]** 支持 AbortSignal、超时、输出字节上限和审计 ID。
- **[建议]** 禁止 `backend.call` 访问其他插件、任意 `/api` path、localhost、文件 URL 或云 metadata 地址。
- **[待决策]** UI-only 插件是否允许使用所有公共 query/command，还是必须安装一个后端插件 companion 才能访问核心数据。推荐允许最小只读公共 API，写操作按权限单独授权。

## 8. UI contribution points

### 8.1 声明式 contribution

**[建议]** Manifest 的 UI 部分只声明数据。以下仅为本文所需字段示例，最终命名需与 Manifest 文档统一：

```json
{
  "contributes": {
    "ui": {
      "panels": [
        {
          "id": "review-dashboard",
          "title": "Review Dashboard",
          "entry": "ui/review-dashboard.js",
          "style": "ui/review-dashboard.css",
          "surfaces": ["narrator-focus", "workspace", "director"],
          "scope": "narrator",
          "instance": "singleton-per-scope",
          "defaultPlacement": "secondary",
          "commands": ["plugin.example.openReviewDashboard"]
        }
      ],
      "commands": [
        {
          "id": "plugin.example.openReviewDashboard",
          "title": "Open Review Dashboard"
        }
      ],
      "menus": {
        "narrator.toolbar": [
          {
            "command": "plugin.example.openReviewDashboard",
            "when": "narrator.hasChapter"
          }
        ]
      }
    }
  }
}
```

- **[建议]** `entry` 必须是安装包内相对路径，不能是 URL、`data:`、`file:` 或 `javascript:`。
- **[建议]** contribution ID 在 plugin namespace 内唯一；完整身份为 `<pluginId>/<contributionId>`。
- **[建议]** host 根据权限、surface、scope、enablement 和插件状态决定是否展示 contribution。

### 8.2 推荐 contribution points

| Contribution point | 内容 | 渲染方式 | 首版建议 |
| --- | --- | --- | --- |
| `dock.panel` | 完整工具/业务面板 | sandbox iframe | 必须支持 |
| `commandPalette` | 命令入口 | 宿主文本/icon/command | 必须支持 |
| `settings.section` | 插件设置页 | 固定宿主 route + iframe | 必须支持 |
| `narrator.toolbar` | narrator 工具按钮 | 宿主按钮 + command | 可支持 |
| `workspace.toolbar` | workspace 工具按钮 | 宿主按钮 + command | 可支持 |
| `narrator.message.contextMenu` | 消息操作 | 宿主菜单项 + command | 后续支持 |
| `chapter.contextMenu` | 章节操作 | 宿主菜单项 + command | 后续支持 |
| `panel.contextMenu` | panel 操作 | 宿主菜单项 + command | 后续支持 |
| `status.badge` | 状态提示 | 宿主限定 badge schema | 后续支持 |

- **[建议]** toolbar/menu contribution 只能声明 label、built-in icon token、group、order、when、command；不能声明 JSX、HTML 或 CSS。
- **[建议]** `settings.section` 使用预声明的宿主静态 route（例如一个通用 `/settings/plugins/$pluginId/$contributionId` route）加载 iframe，不为每个插件生成 route 文件。
- **[建议]** built-in icon token 来自宿主白名单。自定义 SVG 不进入宿主 DOM；如需品牌图形，只在 iframe 内显示，或经过独立 sanitize/image pipeline。
- **[建议]** 首版不要开放 app shell、导航树任意节点、消息正文 renderer、代码块 renderer、登录页、全局 CSS、全局 keyboard handler 等高耦合 contribution point。

## 9. PluginDockPanel 与 panel params

### 9.1 单一静态 adapter

- **[建议]** focus registry 与 workspace registry 都只新增一个稳定 component key，例如 `"plugin"`，对应宿主内置 `PluginDockPanel`。
- **[建议]** 不为每个插件注册 `component: "plugin.example.panel"`。否则插件缺失时 `fromJSON()` 会因 component registry 不完整而使整个布局恢复失败。
- **[建议]** `PluginDockPanel` 负责：校验 params、查 contribution、渲染宿主 chrome、注册 iframe slot、连接 runtime、显示 loading/error/missing/disabled/incompatible 占位和提供重试/移除操作。
- **[建议]** plugin iframe 只渲染内容区；tab、关闭按钮、标题、badge、dirty、错误边框和缺失恢复 UI 由宿主控制。

### 9.2 Panel params

```ts
type PluginPanelBinding =
  | { kind: "focus-current-narrator" }
  | { kind: "workspace"; workspaceId: string }
  | {
      kind: "workspace-narrator";
      workspaceId: string;
      ownerNarratorId: string;
    }
  | { kind: "global" };

interface PluginDockPanelParams {
  panelType: "plugin";
  schemaVersion: 1;

  pluginId: string;
  contributionId: string;
  panelInstanceId: string;
  binding: PluginPanelBinding;

  /** 插件定义的小型、JSON-only、可迁移 panel 状态。 */
  viewState?: JsonValue;
  viewStateVersion?: number;

  /** 插件缺失时仍可展示，不作为权限或加载依据。 */
  fallback?: {
    title?: string;
    pluginName?: string;
    pluginVersion?: string;
  };
}
```

- **[建议]** `pluginId`、`contributionId`、`panelInstanceId`、`binding` 为 host-owned immutable fields。
- **[建议]** `viewState` 暂定最大 16 KiB；只保存恢复视图所需的小状态，不保存数据缓存、凭据或函数。
- **[建议]** focus layout 的 `binding` 固定为 `focus-current-narrator`，不得持久化 narratorId/chapterId，遵循现有“live context 是身份真值”的规则。
- **[建议]** workspace narrator-scoped panel 必须持久化 `ownerNarratorId`，因为一个 surface 中存在多个 narrator，无法只靠 route 推断。
- **[建议]** `workspaceId` 在服务端 workspace layout 内属于冗余值。可保留用于防串布局校验，也可由当前 workspace context 注入；见待决策项。
- **[建议]** 恢复时只信任 registry 中的 contribution 与当前授权；`fallback` 仅作文字展示，不能决定 asset entry、权限或 command。

### 9.3 Panel ID

- **[建议]** singleton panel 使用可重复计算的稳定 ID，多实例 panel 使用生成 ID：

```text
focus singleton:
  pui_<pluginIdHash>_<contributionIdHash>

workspace narrator singleton:
  pui_<pluginIdHash>_<contributionIdHash>_<ownerNarratorIdHash>

multi instance:
  pui_<pluginIdHash>_<contributionIdHash>_<randomOrMonotonicId>
```

- **[建议]** 不把未经编码的任意 pluginId 直接拼入 DOM ID、CSS selector 或日志路径。
- **[建议]** `panelInstanceId` 与 Dockview panel ID 可以相同，但协议上应视为 opaque stable ID，避免未来布局迁移被 Dockview 命名约束锁死。

## 10. addPanel 与打开策略

### 10.1 对插件暴露高层 API

插件调用：

```ts
await narrafork.panels.open({
  contributionId: "review-dashboard",
  target: { kind: "current-narrator" },
  placement: "secondary",
  initialState: { tab: "summary" }
});
```

宿主内部执行：

1. **[建议]** 从 session 绑定取得 pluginId，不接受调用方指定其他 pluginId。
2. **[建议]** 查 contribution，校验 surface、scope、instance 策略和权限。
3. **[建议]** 解析 target 为 focus current narrator、workspace、workspace owner narrator 或 global。
4. **[建议]** 若 singleton 已存在，执行 `setActive()`，可选合并合法 `viewState`，不重复创建。
5. **[建议]** 构造 host-owned `PluginDockPanelParams`。
6. **[建议]** 调用当前 surface 的受控 `addPluginPanel`，最终使用：

```ts
api.addPanel<PluginDockPanelParams>({
  id: panelId,
  component: "plugin",
  title: resolvedTitle,
  params,
  position: resolvedHostPosition
});
```

7. **[建议]** 让现有 layout-change listener 负责持久化；插件不得直接调用 `api.toJSON()` 或写 workspace tree/localStorage layout key。

### 10.2 Placement

- **[建议]** 对外只暴露有限 placement：`active-group`、`secondary`、`split-right`、`split-below`、`new-group`。宿主可因屏幕、surface 和布局策略改写。
- **[建议]** narrator-scoped panel 默认遵循现有 tool placement：第一个 secondary panel 在 narrator/chat 右侧分栏，后续 panel 进入该 narrator 的 secondary group。
- **[建议]** workspace/global panel 可作为顶层 panel；narrator-scoped panel 与所属 narrator cluster 一起管理。
- **[建议]** 插件不能传任意 `referencePanel`/`referenceGroup` ID 操作不属于自己的 panel，也不能执行 swap/close 他人 panel。
- **[建议]** 用户拖动仍由 `DockviewSurface` 处理，插件只接收位置/可见性变化，不参与原生 DnD 决策。

### 10.3 Orphan 处理

- **[建议]** workspace narrator 主 panel 被移除后，自动关闭或转为恢复占位的 narrator-scoped plugin panel，行为与现有 narrator tool/subagent 清理一致。
- **[建议]** 默认自动关闭，同时先保存 `viewState`；若插件声明可脱离 narrator 转为 workspace scope，必须由用户显式执行 command，不做静默转换。
- **[待决策]** narrator-scoped plugin panel 是否允许被用户拖到其他 narrator cluster。推荐禁止隐式改绑；提供“移动到 narrator…”宿主命令并重新校验权限/context。

## 11. 布局持久化与缺失插件恢复

### 11.1 Focus layout

- **[建议]** 继续使用现有 per-narrator/per-device localStorage envelope 和清理策略。
- **[建议]** plugin panel params 通过 `api.toJSON()` 自然进入 layout；focus 保存时继续移除任何错误出现的 narratorId/chapterId，并校验 binding 必须是 `focus-current-narrator`。
- **[建议]** 恢复前对所有 `panelType: "plugin"` params 做 schema 校验和大小限制。非法 params 不应让整个 `fromJSON()` 失败，应改写为可恢复的 invalid placeholder params。
- **[建议]** chat 主 panel 仍是 focus layout 的必须项；插件不能替代或关闭 protagonist panel。

### 11.2 Workspace layout

- **[建议]** plugin params 进入现有 `SerializedDockview`，director state 仍由 outer envelope 保存。
- **[建议]** 扩展 `WorkspacePanelParams` 与 component mapping 时，plugin component 永远映射到静态 `"plugin"`。
- **[建议]** 是否提升 workspace envelope version 取决于最终是否改变 outer schema。仅新增 panel union 理论上可向后兼容，但若增加恢复索引、缺失 snapshot 或 migration journal，应显式升版。
- **[建议]** 服务端持久化前后都限制 tree 总大小，避免插件把大 `viewState` 注入 layout。

### 11.3 缺失、禁用、权限撤销和不兼容

因为 component key 始终存在，布局恢复后由 `PluginDockPanel` 显示状态：

| 状态 | panel 内容 | 布局处理 |
| --- | --- | --- |
| 插件未安装 | Missing placeholder，显示 fallback、安装/移除入口 | 保留 |
| 插件已禁用 | Disabled placeholder，显示启用/移除入口 | 保留 |
| contribution 删除/改名 | Contribution missing，提示升级不兼容 | 保留 |
| 权限被撤销 | Permission placeholder，可申请权限或移除 | 保留 |
| protocol 不兼容 | Incompatible placeholder，提示升级宿主/插件 | 保留 |
| iframe 加载失败/崩溃 | Error placeholder，提供 reload 与诊断 ID | 保留 |
| params/state 迁移失败 | Recovery placeholder，可重置该 panel state | 保留原始恢复副本 |

- **[建议]** 不因插件暂时缺失而静默删除 panel；这会永久改变用户布局并阻止重新安装后的恢复。
- **[建议]** 插件重新安装/启用且 contribution 匹配时，placeholder 原位热切换为 iframe，不调用 `addPanel` 创建副本。
- **[建议]** 用户可“移除此 panel”；只有显式操作才从 Dockview layout 删除。
- **[建议]** 卸载插件时，默认询问是否同时移除所有布局占位和 namespaced storage；禁用插件不删除二者。
- **[建议]** contribution rename 通过 Manifest migration/alias 表识别，host 更新 params 后再持久化。

### 11.4 View state migration

- **[建议]** params 携带 `viewStateVersion`，插件升级后通过受限 migration handler 转换 JSON state。
- **[建议]** migration 在启动 iframe 前完成，有时间、输出大小和异常边界；不能在主线程执行任意第三方 JS。
- **[假设]** migration 最安全地由隔离的后端插件进程执行，或由声明式 JSON migration 完成。
- **[建议]** migration 失败时保留原 state 的有界 recovery copy，并允许用户重置，不让整个 workspace 无法打开。

## 12. defaultRenderer、稳定 iframe 与 Director

### 12.1 Dockview grid

- **[事实]** 两个现有 Dockview surface 都使用 `defaultRenderer="always"`。
- **[建议]** 插件 panel 不允许覆盖 renderer mode；必须继承 surface 的 `always`。
- **[建议]** tab 隐藏、group 移动、split/swap/merge 时只发送 panel visibility/size/context 事件，不重建 iframe 或 port。
- **[建议]** iframe 不可见时保持 browsing context，但 host 应把 wrapper 设为不可交互，并暂停非关键 event delivery，避免后台 panel 持续占用 CPU。

### 12.2 稳定 iframe runtime

单纯让 `PluginDockPanel` 直接返回 `<iframe>` 可以满足 Dockview grid，但不能同时解决 director overlay。推荐使用 slot + top-level layer：

- **[建议]** `PluginUiRuntimeProvider` 按 `panelInstanceId` 创建且只创建一次真实 iframe。
- **[建议]** `PluginDockPanel` 返回宿主 chrome 与 `<PluginPanelSlot panelInstanceId=... />`，slot 只上报可见性、矩形和优先级。
- **[建议]** `PluginUiLayer` 位于稳定的 app root 层，使用宿主控制的 wrapper 把 iframe定位到当前有效 slot 的矩形；切换 grid/director 时不移动或重建 iframe DOM，只更新坐标、裁剪、z-index、visibility 与 pointer-events。
- **[建议]** runtime 用 `ResizeObserver`、surface visibility 和 layout event 更新矩形，按 animation frame 合并，避免每个像素变化触发 React 重渲染。
- **[建议]** panel drag 期间 iframe 临时 `pointer-events: none`，避免吞掉 Dockview pointer events。
- **[建议]** Notifications、Modal 和宿主菜单的 z-index 高于 PluginUiLayer；iframe 内容不能逃出 panel clip rect。
- **[建议]** StrictMode 下 runtime controller 的创建与 dispose 必须幂等，不能因 effect 双调用创建两个 iframe/session。

### 12.3 Director 支持

- **[建议]** `PluginDockPanelParams` 作为 workspace top-level leaf 时可以进入 director；narrator-scoped resource plugin 默认像 `narrator-tool` 一样不进入顶层 director leaf。
- **[建议]** `DirectorLayout` 对 plugin leaf 渲染另一个 `PluginPanelSlot`，而不是第二个 iframe。runtime 在 director 激活时优先绑定 director slot，底层 Dockview slot仍存在但不可见。
- **[建议]** director secondary preview 上覆盖宿主点击层，和现有 panel 一样：预览只用于选择，插件不接收交互；成为 primary 后再启用 iframe pointer events。
- **[建议]** 若浏览器/定位实现无法可靠保持单 iframe，首版应明确降级为“plugin panel 不进入 director；点击插件 panel 时退出 director并聚焦 grid”，而不是悄悄双挂载。
- **[待决策]** 首版是否实现 top-level PluginUiLayer。推荐实现；它是同时满足 `defaultRenderer=always` 与 director 连续性的最稳妥边界。

### 12.4 多 narrator context

- **[建议]** 每个 workspace narrator-scoped plugin panel 的 session 永久绑定一个 `ownerNarratorId`，并从 workspace dock store/查询层获得该 narrator 的 context。
- **[建议]** 多个 narrator 各自打开同一 singleton-per-narrator contribution 时，生成不同 panel instance、port、storage narrator scope 和事件 filter。
- **[建议]** 插件不能通过在 viewState 中写另一个 narratorId 改变绑定；必须调用宿主“重新绑定/新开 panel”命令。
- **[建议]** workspace-level plugin 若需要聚合多个 narrator，使用权限化 query/event filter，不复用任意一个 narrator 的私有 dock context。

## 13. 静态资源与路由约束

### 13.1 不允许运行期路由注入

- **[事实]** TanStack route tree 是构建期生成的静态模块。
- **[建议]** 插件不能新增 `frontend/routes` 文件、调用 router 内部 mutation、注册 loader 或把插件 bundle import 到 route tree。
- **[建议]** 所有插件入口通过少量宿主预置 route：Dockview panel、通用插件设置 route、插件管理/诊断 route。route 只解析 plugin/contribution ID，再渲染宿主 `PluginDockPanel`/`PluginSettingsFrame`。
- **[建议]** plugin navigation 使用 `commands.execute("narrafork.navigate", ...)` 或有限 `navigation.open(...)`，目标必须匹配宿主允许的 route ID 与参数 schema，不接受任意 URL 作为内部路由。

### 13.2 插件 asset route

- **[建议]** 为兼容开发环境现有 `/api` proxy，首版资源可放在专用精确路由，例如：

```text
GET /api/plugin-assets/{pluginId}/{version}/{contentHash}/shell.html
GET /api/plugin-assets/{pluginId}/{version}/{contentHash}/entry.js
GET /api/plugin-assets/{pluginId}/{version}/{contentHash}/style.css
GET /api/plugin-assets/{pluginId}/{version}/{contentHash}/assets/...
```

- **[建议]** 该路由必须在通用 `/api/*` auth gate/插件 API RPC 设计中明确区分“可公开读取的已安装代码资源”和“需认证的用户数据”。静态代码响应绝不包含用户数据、配置值或 secret。
- **[建议]** 资源路径必须精确匹配文件并防目录穿越；不依赖 SPA fallback。
- **[建议]** `shell.html` 由宿主生成且 `no-cache`；带 hash 的 JS/CSS/assets 可 `immutable`。升级用新 version/hash URL，旧 layout session 关闭后再回收旧资源。
- **[建议]** Service Worker 不预缓存所有插件；由插件管理器维护可选、版本化的 runtime cache，并在卸载/回滚时清理对应 namespace。
- **[建议]** 若未来改用 `/plugin-assets/*`，必须同步添加 Vite dev proxy 和生产静态 middleware，不能只依赖前端 Router。
- **[待决策]** 静态插件代码是否允许未登录访问。推荐允许读取无用户数据的 hash asset，从而避免把 JWT 放入 iframe URL；若产品要求隐藏插件清单，应使用短期、仅限 asset 的 capability URL，仍不得使用主 JWT。

## 14. 错误边界、生命周期与资源释放

### 14.1 Session 状态机

```text
registered
  -> loading-assets
  -> connecting
  -> ready
  -> suspended/hidden
  -> reconnecting
  -> disposing
  -> disposed

任意阶段可进入：missing / disabled / denied / incompatible / crashed
```

- **[建议]** asset load 与 handshake 分别超时并显示不同错误，便于诊断。
- **[建议]** iframe `error`、port `messageerror`、heartbeat 失败和连续 RPC protocol violation 都使 session 进入 crashed；自动重试必须限次并指数退避。
- **[建议]** panel UI 提供“重新加载插件 UI”“复制诊断 ID”“移除 panel”，不展示内部堆栈或 secret。
- **[建议]** iframe reload 后创建新 nonce/port/session generation；旧 response 不得落入新 session。
- **[建议]** panel remove 立即取消请求、退订事件、dismiss session notifications、释放 ResizeObserver 和 iframe。
- **[建议]** route unmount 时 flush 小型 viewState 后 dispose。布局保存仍由现有 Dockview persistence 完成。
- **[建议]** 插件禁用/卸载事件作用于所有 live sessions，但不得阻塞主 UI。

### 14.2 可见性与资源预算

- **[建议]** `visible=false` 时发送一次 lifecycle event，暂停 animation/轮询是插件 SDK 的默认行为；host 同时暂停可暂停的 event subscription。
- **[建议]** host 可统计每插件 iframe 数、消息速率、未完成 RPC、事件队列和最近错误。
- **[建议]** 为每插件限制同时活动 iframe 数；超过时拒绝新建多实例 panel，singleton 只聚焦已有实例。
- **[建议]** 插件长时间无响应不能阻塞 Dockview layout、路由切换或应用退出。

## 15. 明确禁止的注入方式

以下均应在实现、Manifest 校验和代码评审中作为硬边界：

1. **[建议]** 禁止插件提供 React component、JSX、hook、Context Provider、ErrorBoundary、Dockview tab component 或 Mantine component。
2. **[建议]** 禁止运行期把插件 JS import 到主窗口，禁止 Module Federation、`eval`、`new Function` 和远程 script。
3. **[建议]** 禁止插件获得 `document`、`window`、宿主 DOM node、shadow root、React root、portal target 或 DOM mutation callback。
4. **[建议]** 禁止向宿主注入全局 CSS、CSS variable、font、keyframes 或修改 Dockview/Mantine theme。
   - **[例外]** 唯一受控例外是 `themes` contribution（见 03 号文档 3.5 节）：插件**不提交任何 CSS**，只声明受白名单约束的设计 token；宿主校验并编译成一段作用于 `[data-plugin-theme]` 的 Mantine CSS 变量覆盖，需要高风险 `ui.theme` 权限（默认拒绝）。这不违反本条——插件从始至终没有 CSS/选择器/keyframes 能力，也无法注入 font 外链；宿主是唯一的 CSS 产出方。任意 CSS、CSS 文件、`@import`、`url()` 外链和自定义选择器仍然严格禁止。
5. **[建议]** 禁止插件直接访问 `DockviewApi`、Router、QueryClient、i18n instance、Notifications instance、raw WebSocket 或 event bus。
6. **[建议]** 禁止 bridge 传递函数、DOM node、Error object、AbortSignal、MessagePort 之外的任意 capability object；公共 payload 只用 JSON。
7. **[建议]** 禁止插件自行读写 NarraFork layout localStorage key、workspace tree、recent tabs 或认证 token。
8. **[建议]** 禁止 menu/notification/panel title 使用任意 HTML；宿主必须按纯文本渲染。
9. **[建议]** 禁止 iframe 使用 `allow-same-origin` 作为修复资源加载问题的快捷方案。
10. **[建议]** 禁止缺失插件导致整个 Dockview `fromJSON()` 失败或静默丢弃用户 panel。

## 16. 建议实现顺序

1. **[建议]** 定义 `UiContributionRegistry`、`PluginDockPanelParams` schema 和静态 component key `plugin`。
2. **[建议]** 在 focus/workspace registry 中注册 `PluginDockPanel`，先完成 missing/disabled placeholder 与布局恢复测试。
3. **[建议]** 实现 host-controlled asset shell、严格 sandbox/CSP 和最小 `MessageChannel` handshake。
4. **[建议]** 实现 context、panel lifecycle、notifications、storage session/device 的最小 API。
5. **[建议]** 接入后端 `queries/commands/backend.call` 认证代理和服务端权限复核。
6. **[建议]** 接入 events、有界队列、不可见暂停、取消和诊断。
7. **[建议]** 实现受控 `panels.open`/`addPluginPanel`，覆盖 singleton、多实例、focus 和 workspace narrator binding。
8. **[建议]** 实现 `PluginUiLayer` 稳定 iframe 与 director slot；若延期，启用显式 grid-only 降级。
9. **[建议]** 开放声明式 command palette/settings/toolbar contribution，最后再评估 context menu/status badge。

最低验收测试应包括：

- focus panel 拖动、tab 隐藏、split/swap/merge 后 iframe 和 port 未重建；
- narrator A/B 的 focus layout 不串 identity；
- workspace 中同一插件分别绑定两个 narrator，context、storage、事件过滤互不串号；
- 进入/退出 director 不双挂载 iframe；若使用降级策略，能原位返回 grid 并保持 session；
- 插件禁用、卸载、重新安装、contribution rename、协议不兼容均能保留布局并恢复；
- 恶意 iframe 无法读 `narrafork_token`、直接调用受保护 API、访问 parent DOM 或注册 React/route；
- RPC 超时、取消、超大 payload、event overflow、iframe crash 不阻塞主应用；
- workspace tree 和 focus localStorage 中不出现 JWT、函数、DOM 数据或超限 viewState。

## 17. 待决策汇总

1. **[待决策]** UI bundle 首版只支持 IIFE，还是支持 ESM/dynamic chunks。
2. **[待决策]** 是否首版实现 top-level `PluginUiLayer`；推荐实现，否则 director 必须采用明确的 grid-only 降级。
3. **[待决策]** workspace params 是否持久化冗余 `workspaceId`，还是只由 live workspace context 注入。
4. **[待决策]** narrator-scoped plugin panel 是否允许显式改绑到另一个 narrator；推荐只通过宿主命令完成。
5. **[待决策]** 静态插件 asset 是否公开读取；推荐公开 hash asset、严格保证不包含用户数据，避免 iframe URL 泄露 JWT。
6. **[待决策]** UI-only 插件可直接获得哪些只读 query；写 command 是否必须有后端 companion。
7. **[待决策]** storage quota、卸载后的保留策略和 `device` scope 多浏览器语义。
8. **[待决策]** panel params/viewState、RPC payload、事件队列和超时的最终上限。
9. **[待决策]** mobile narrator 页面当前不使用 Dockview。首版是隐藏 desktop-only panel contribution，还是增加通用全屏 plugin route/drawer。推荐首版按 contribution `surfaces` 明确标为 desktop Dockview only，避免在移动端生成不可达入口。

## 18. 设计结论

- **[建议]** 安全边界是“宿主声明式 chrome + sandbox iframe + 每实例 MessageChannel”，不是“可信 React 插件”。
- **[建议]** Dockview 永远只认识一个内置 `PluginDockPanel` component；真实插件身份全部在可校验 params 和 registry 中，从而保证缺失插件时仍可恢复布局。
- **[建议]** focus 身份来自 live context，workspace narrator panel 使用显式 owner binding，这是避免多 narrator 串号的关键规则。
- **[建议]** 两个 Dockview surface 继续固定 `defaultRenderer="always"`；director 通过稳定 `PluginUiLayer`/slot 复用同一个 iframe，不能双挂载。
- **[建议]** 认证、events、commands、notifications 和 storage 都是受权限、限额、审计和取消控制的 host API；JWT、原始 event bus、内部服务及任意 `/api` fetch 不进入 iframe。
- **[建议]** TanStack route tree 保持构建期静态；插件通过预置 route 和 contribution points 出现，不运行期注入 route、React 或 DOM。
