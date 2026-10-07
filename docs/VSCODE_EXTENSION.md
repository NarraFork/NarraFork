# VS Code 插件（纯前端，连接本机后端）

本文档记录设计决策与**外部行为约束的出处**。使用说明见 `vscode-extension/README.md`。

## 定位

插件不含后端，只作为前端外壳，连接本机已运行的 NarraFork。它在 webview 里 iframe 加载**后端自己提供的 SPA**，而不是打包一份副本。

选择 iframe 而非内置 SPA 的理由：UI 与 API 版本天然一致（内置副本会在后端升级后漂移，症状表现为难以归因的 API 报错），vsix 体积小，且 SPA 的 token 存储、Service Worker、资源加载全部发生在后端 origin 下——那里本来就是对的。代价是需要后端可达，没有离线模式，这是刻意接受的。

## 外部行为约束（靠读源码确认，不要凭印象）

这两条决定了整个实现形状，且都不是文档里显眼的地方，所以记在这里。

### code-server 的端口代理会剥离前缀

`asExternalUri` 在 code-server 中返回 **`<root>/proxy/<port>/`**，来源是 code-server 仓库的 `patches/proxy-uri.diff`（上游补丁，不在本仓）：

```
proxyEndpointTemplate: process.env.VSCODE_PROXY_URI ?? rootBase + '/proxy/{{port}}/'
```

`/proxy/<port>/` 是**路径重写**代理——应用收到的 path 不含前缀。官方文档明确要求"应用必须使用相对 URL 且不假设自己的绝对路径"，并且**必须带尾斜杠**。

因此：

- 前端不能出现任何根路径绝对 URL（`/api/...`、`/ws/...`、`/favicon.svg`）。
- 深链接（`/projects/abc`）下相对路径会解析到错误目录，需要服务端注入 `<base href>` 修正。
- iframe URL 必须带尾斜杠，缺了会 404 且症状（空白面板）完全不指向原因。

`/absproxy/<port>/` 原样传递前缀，**不被支持**：服务端的 base href 深度是按"收到的 path"推算的，absproxy 会让它多算层级，而且 `/absproxy/7778/assets/x.js` 在磁盘上没有对应文件，从 base href 这一层根本救不回来。见 `server/lib/spa-base-href.ts` 头部注释。

如果运维设置了 `VSCODE_PROXY_URI`（如 `https://{{port}}.example.com`），返回的是子域名形式——相对路径方案在这种形式下同样正确，这也是选"全相对"而非"读取并拼接前缀"的原因。

### `asExternalUri` 不认 IPv6 字面量（三重静默失效的源头）

端口映射只对**它自己的正则**认得的 authority 生效，出处是 code-server 打包的 VS Code（`out/vs/workbench/api/node/extensionHostProcess.js`）：

```js
const t = /^(localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)$/.exec(e.authority);
if (t) return { address: t[1], port: +t[2] };
```

`[::1]:7778` **不匹配**，于是 `asExternalUri` 原样返回、不建隧道、不给 `/proxy/<port>/`。讽刺的是同一文件的回环主机名列表 `["localhost","127.0.0.1","0:0:0:0:0:0:0:1","::1"]` 是包含 `::1` 的——只有端口映射这条路径没有 IPv6 分支。

**调用方无法从 API 得知失败**：`asExternalUri` 成功返回，只是返回了一个浏览器到不了的地址。「无需映射」（桌面版，正确）与「无法映射」（code-server，致命）是同一个返回值，必须靠环境区分。

这个坑一路静默到底，因为三层各自都不报错：

1. 映射未发生 → URL 仍是 `http://[::1]:7778`；
2. 该地址被塞进 webview → 浏览器在用户机器上，那里没有监听者；
3. **带方括号的 IPv6 host 无法出现在 CSP source list** → 浏览器丢弃该 source，`frame-src` 退化为 `'none'`，iframe 被一条在 HTML 里看起来完全宽松的策略拦下。

唯一证据是 webview devtools 里的一行告警——而那是用户最不会打开的地方。

现在的对策分三处，见 `src/loopback.ts`：调用 `asExternalUri` **之前**把回环地址规范化为 `localhost`（同一台机器，只换一种 VS Code 认得的拼法）；在 web/remote 编辑器里若解析结果**仍是回环**则抛 `UnreachableWebviewUrlError`；CSP 无法表达的 origin 在 `renderShellHtml` 里抛 `UnrepresentableFrameOriginError`。两者都由 `extension.ts` 转成一条指名解决办法的错误提示，而不是白屏。

⚠️ 规范化目标必须是 `localhost` 而**不是** `127.0.0.1`：Bun 以 `host: "localhost"` 启动时在双栈机器上**只监听 IPv6 回环**，此时 `127.0.0.1` 直接 ECONNREFUSED。这也是 discovery 曾经的真实 bug——它硬编码 `127.0.0.1` 作为候选，导致后端明明在跑却报「没有后端响应」。`localhost` 会解析到实际在监听的那个协议族（Node 18+ 的 fetch 会双栈尝试，已实测确认）。

### code-server 的 webview 与主窗口同源

code-server 仓库的 `patches/webview.diff`（上游补丁，不在本仓）标题即 "Serve webviews from the same origin"：`webviewEndpoint` 指向 code-server 自身静态路由，并绕过 `parentOriginHash` 校验。

推论：

- webview 内 iframe 指向 `/proxy/7778/` 会带上 code-server 的认证 cookie，代理不会拒绝。
- webview 的 origin **不是** `vscode-webview://`，而是 code-server 的 origin。

桌面版则相反，webview origin 是 `vscode-webview://<uuid>`，authority 是每个 webview 随机生成的，**无法预先枚举**——这就是 CORS 必须按 scheme 而非完整 origin 放行它的原因。

## 实现结构

```
vscode-extension/src/
  extension.ts     激活、命令、发现与状态生命周期
  discovery.ts     端点发现（settings.json → 默认端口，逐个探活 /api/health）
  external-uri.ts  asExternalUri 换算 + 环境识别 + 不可达则显式报错
  loopback.ts      回环地址拼写规范化（asExternalUri / CSP 各自的可表达性）
  panel.ts         webview 面板生命周期与消息处理
  shell.ts         webview HTML（CSP + nonce + 消息中继）
  token-store.ts   SecretStorage 托管 token
  status-bar.ts    连接状态指示
```

`discovery.ts`、`shell.ts`、`token-store.ts`、`loopback.ts` 刻意不 import `vscode` 运行时（token-store 只 import type），所以它们能在仓库根的 `bun test` 下被测试，无需编辑器环境。测试在 `tests/vscode-extension/`。

`loopback.test.ts` 特意**用 VS Code 的原始正则做断言**而非复述它的判定结果，这样测试不会漂移成「我们以为 VS Code 接受什么」。

## 关键决策

**发现策略只有一条硬规则：配置了 `narrafork.serverUrl` 就只试它。** 用户显式指定地址后静默回落，会把他连到**另一个**后端，而状态栏报告成功——错误的 pin 必须可见地失败。

**设置项的探活必须防抖。** VS Code 的设置界面**每敲一个键就写一次值**，于是 `onDidChangeConfiguration` 按字符触发。早期实现每次触发都启动一轮完整发现（每候选 3s 超时、无防抖、无取消），输入 `http://localhost:7778` 会并发出约 21 条探测链，各自在完成时写同一个状态栏——按完成顺序而非敲键顺序。用户观感是「输入框在吞字、跟自己较劲」：窗口为 `http://l` 这种半截地址转圈，状态栏在过期结论之间闪。

插件**从不写用户设置**（`src/` 里没有任何 `.update()` 调用，由测试固定），所以文本并非真被改写；但上述抖动足以造成同样的体验。现在的做法：防抖 600ms 后才探活，缓存失效仍然立即执行（不延迟才正确），并用 generation 计数丢弃被取代的迟到结果——否则慢的那一条会用过期结论覆盖新结论，把一个可用端点挤掉。见 `tests/vscode-extension/settings-edit-debounce.test.ts`。

**探活用 `/api/health` 而非 TCP 连接。** 它是唯一既公开（无需会话）又能标识软件（返回 `version`/`commit`）的端点。开发机上"某个端口有东西在听"几乎总是成立，所以要检查响应体形状。503 算"找到了"：后端在启动恢复失败时刻意返回 503 + 健康负载并保持 UI 可达，而 UI 正是修复该状态的地方。

**行为不按环境分叉。** 桌面版 / code-server / Remote SSH 全部走 `asExternalUri`，环境识别只用于错误文案与状态栏。分叉会产出只有某种环境才执行的代码路径，那是最容易腐烂的形状，而这个 API 在三种环境下都已经给出正确答案。

**token 必须双向同步。** 后端在 token 接近过期时重新签发，通过 `X-NarraFork-Session-Token` 响应头返回，SPA 的 `absorbRenewedToken` 会写回 localStorage。单向注入会让宿主副本自行过期，而症状出现在**以后、别处**：下一个面板注入过期 token，用户被弹回登录页且没有任何提示。

**`sign-out` 是独立消息，不能复用 `bootstrap { token: null }`。** 这两者语义不同且不可合并：

- `bootstrap { token: null }` = "宿主没有存储副本"（新装、keychain 被清）。收到它**不能**清除会话——否则在一台没存 token 的机器上打开面板会静默销毁用户刚建立的会话。
- `sign-out` = 用户显式要求退出。必须清 token **并 reload**。

第一版实现把退出写成了空 bootstrap，结果命令完全无效：keychain 清了（所以看起来像成功了），但 SPA 仍登录着，下一次滑动续期又把 token 上报回宿主——一个自我撤销的退出。合并成一条消息时，无论选哪种行为都对另一种情况是错的。约束由 `tests/frontend/host-bridge.test.ts` 与 `tests/vscode-extension/protocol.test.ts` 固定。

只清 storage 不 reload 也不够：留下一个完整渲染、持有活 WebSocket 与缓存查询的应用，下一个请求 401，用户读到的是崩溃而不是退出。

**"打开面板"不重载已打开的面板。** 赋值 `webview.html` 会销毁 iframe 并重载 SPA，丢掉正在流式输出的叙述者、活的 WebSocket 订阅、未发送的输入——正是 `retainContextWhenHidden` 要保护的东西。只有 `narrafork.reconnect`（用户明确要求重连）和"端点已变化"才走重载路径。见 `tests/vscode-extension/panel-reload-policy.test.ts`。

**webview 中继脚本是模板字符串里的 JS，`tsc` 看不见它的语法错误。** 注释里一个反引号就会提前终止模板并把后续注释变成活代码（实际发生过）。`tests/vscode-extension/shell.test.ts` 解析渲染后的脚本体来兜住这一类错误。

**token 不做成配置项。** `narrafork.token` 会把活凭据放进经常被同步和提交的 `settings.json`。SecretStorage 走 OS keychain 且是每机器的。token 是用户正常登录的副产物，不需要他手工粘贴任何东西。

## 安全边界

`frontend/lib/host-bridge.ts` 是**全仓唯一允许外部写入会话凭据的入口**，也是唯一向外发送凭据的地方。四层防护，每层都承重：

1. **非嵌套时完全不安装监听器**——普通浏览器标签页不存在这个入口。
2. **要求 URL 上的 `nfEmbed` 标记**。它不是密钥也不是边界（走 URL、无法验证），作用是让"仅仅被 iframe 了"的页面无法唤醒桥接。它回答"我是否被刻意嵌入"，不回答"被谁"。
3. **真正的边界是发送方身份**：只接受 `event.source === window.parent`（`source` 由浏览器设置，无法伪造），出站消息只发给单一显式 targetOrigin，**绝不用 `"*"`**。
4. **首次接触时钉住 parent origin**，之后每条消息必须匹配。parent origin 无法预知（桌面版是随机 UUID），所以不能写成常量；但接受**变化的** origin 等于没有校验。`null` origin 不可钉住——否则之后每个不可归因的发送方都会匹配。

宿主报告"没有 token"时**不清除**本地会话：应用自己的存储才是权威，一个恰好没有副本的宿主（新装、keychain 被清）不能终止用户在面板里建立的会话。

### CORS 为何不是提权

`server/lib/cors-origin.ts` 放行同源、任意回环、`vscode-webview:`/`vscode-file:` scheme，以及 `settings.server.allowedOrigins` 里逐字配置的来源。

这**只**因为一件事而安全：NarraFork 用 `Authorization: Bearer` 认证，全链路没有 cookie 路径（`server/middleware/auth.ts` 只读该 header；全仓唯一的 cookie 处理是 `routes/nug.ts` 解析**上游**响应）。浏览器不会自动附带 bearer header，所以恶意页面即使到达这个 origin 也没有凭据，只能看到本来就公开的端点（health / branding / changelog / licenses）。

> ⚠️ **一旦引入会话 cookie，这个放行当天就变成 ambient authority 漏洞**，因为浏览器会自动附带 cookie。任何添加 cookie 的改动必须同时重新评估这里，而不是只加 cookie。

`null` origin 刻意不放行：它不可归因，放行会让任意沙箱文档可读，且我们没有任何前端需要它。

### 嵌套策略是"由缺省变为决定"

主 SPA 目前不发送 `X-Frame-Options` 或 CSP `frame-ancestors`，所以能被嵌套——但那是**缺省**而非决定。`tests/server/app-embedding-policy.test.ts` 把它固定下来：加一个笼统的 `X-Frame-Options: DENY` 看起来像很自然的加固，而它对插件的影响是**面板全白**，浏览器拒绝该 frame，SPA 从不启动，服务端没有任何请求失败或错误可追。

（`routes/plugin-ui.ts` 与 `routes/shares.ts` 的严格 CSP 必须保留：那里服务的是不可信的插件/分享内容，刻意沙箱化。上述守卫只覆盖 app shell 与 `/api/*`。）

## 相对 base path 支持（Phase 1，可独立成立）

为插件所做的前端改造同时补上了"NarraFork 无法部署在反代子路径下"这个既有缺口。两个必需的半边：

1. **Vite `base: "./"`** → 产出相对资源引用。
2. **服务端为 SPA catch-all 注入 `<base href>`**（`server/lib/spa-base-href.ts`）→ 修正深链接下的相对解析。深度可以从"我们收到的 path"算出，因为前缀给浏览器 URL 添加的层级数，与它在到达我们之前剥掉的层级数相同。

缺任何一半都是空白页 + 入口脚本 404，且**客户端无法补救**（脚本没加载，没有代码有机会发现问题），所以第 2 步必须在服务端。

其余接入点：`frontend/lib/base-path.ts`（`apiUrl`/`assetUrl`/`getRouterBasepath`/`isApiUrl`）、`lib/ws.ts`、`lib/branding.ts`、`lib/shiki-loader.ts`、`lib/i18n.ts` 的路径归一化、TanStack Router 的 `basepath`、`src-sw.ts` 按注册 scope 剥前缀，以及 `index.html` 内联脚本（它在任何模块之前运行，只能用字面量，靠 `tests/frontend/branding-boot.test.ts` 保证两侧一致）。

「哪些路径算 API/WS」这条规则在 `frontend/lib/app-path-classify.ts`，被应用与 Service Worker 共同 import。两侧必须一致，而不一致是**双向静默**的：worker 判错一边会缓存 API 响应（数据变旧、无报错），判错另一边则资源缓存悄悄停摆。worker 无法 import `base-path.ts`（后者在模块作用域读 `document`/`location`），所以共享的只是「接收已剥前缀路径」的那一半，各自保留自己的前缀推算方式。

**precache 的 shell 必须由 Service Worker 重写 base href**：Workbox 缓存的是构建产物，它从未经过服务端注入，因此**不带任何 `<base>`**。直接拿它回答 `/settings/providers` 会让浏览器去请求 `/settings/assets/index-*.js`——入口脚本 404、白屏，且没有任何客户端代码还在运行来报告原因。

这个坑不限于带前缀的部署：在 origin 根下，无 base 的 shell 也只对根级导航正确，而本应用几乎所有路由都是嵌套的。曾有一版实现把导航路由 gate 在 `SW_BASE === "/"`，理由是「根下每个导航都是 `./`」——那个前提对服务端注入后的文档成立，对 precache 的原件不成立。

现在的做法：worker 是唯一**绝对**知道挂载根的一方（自己的 registration scope），所以它注入绝对 `<base href="${SW_BASE}">`，一次重写对所有深度都正确，前缀部署下同样成立，离线能力不必放弃。注入器与服务端共用 `setBaseHref`（`server/lib/spa-base-href.ts`），因为「只替换唯一一个真实 base 元素」和「注释里的 `<base>` 不算」这两条规则不能有两份实现。约束由 `tests/frontend/pwa-offline-shell.test.ts` 按**产物字节**固定——缺陷正是长在源码与产物之间的缝隙里。
