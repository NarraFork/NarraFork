# WebRTC 远程访问设计（M2 核心业务集成）

状态：M2 已接入真实 NF 的 opaque 会话、管理员密码/MFA、项目、叙述者聊天/审批、SSE 和小附件；采用同一业务源码的普通/远程双构建、精确后端版本选择与默认关闭的安装/配对管理。当前验证使用隔离 HOME/SQLite、自有 loopback 进程和 Chromium，不等于生产部署。M1 曾通过 domepc/laptop 公网 IPv6 UDP 直连实测；强制 IPv4 尚未打通，不能据此承诺任意 NAT 可达。历史记录保留在 [原型说明](WEBRTC_PROTOTYPE.md)。
工作分支：`explore/webrtc-hole-punching`。

## 1. 目标与非目标

目标：用户无需暴露自己的 NarraFork HTTP 端口，也无需在访问端安装客户端；在异地浏览器打开官方入口或已安装的 PWA，经官方协调后直连自己的实例。聊天、项目、终端和文件等浏览器—实例业务流量最终由 WebRTC 承载。

“业务数据不经过官方服务”是直连模式的路径约束，不是所有 NAT 环境必定可用的承诺。前端分发、实例注册、信令和 STUN 仍使用官方网络；B 调用模型提供商、Git 等外部服务仍由 B 自行联网。

第一版明确不做：官方 SSO、公共实例目录、匿名分享访问、任意内网 HTTP 代理、多实例同页会话、后台永驻 RTC、端口预测、自动 TURN/HTTP 中继回退。远程访问先限实例管理员；现有本地访问不变。完整业务迁移是后续阶段目标，PoC 不宣称覆盖全部功能。

## 2. 核心决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 默认联网策略 | `direct-only`，不配置 TURN，不接受 relay 候选 | 明确执行“不经官方中继”；打洞失败可观察、可解释 |
| 官方协调 | 独立 Bun/Hono 服务，业务后端与其隔离 | A 不装载 B 的业务路由、数据库或 Agent Loop |
| 实例端 RTC | 独立 Go/Pion v4 辅助进程 | 将 ICE/DTLS/SCTP 处理移出 Bun 主线程，避免原生 addon 与 Bun ABI 耦合 |
| 业务适配 | HTTP 语义隧道 + 逻辑 WebSocket | 保留业务路由、校验、会话认证与消息协议 |
| 浏览器隔离 | 每实例独立官方 origin | 隔离已有 token、草稿、缓存和 PWA，避免 PoC 重写所有存储键 |
| 配对与授权 | 本地管理员配对 + B 自己的业务登录 | 官方发现权限不成为 B 管理员权限 |
| 全功能资源 | 小资源先显式 blob；流式资源后设计 SW 桥 | 不把替换 fetch 误认为覆盖 img、video、iframe 和下载 |

继续采用已做浏览器互操作验证的 Go/Pion v4；依赖锁定于 `remote-peer/go.mod/go.sum`，不使用浮动版本。Go 辅助进程不复用 remote-executor 的命令执行协议和权限。

### 2.1 Go 组件独立分发

- `remote-peer` 默认不嵌入 NF 主包，也不在普通 NF 启动时下载或运行。主包只记录可选组件的精确版本、协议版本和 tag；缺少声明的历史 NF 不以 APP_VERSION 猜测组件版本。
- 普通前端的“设置 → 远程访问”提供显式安装、启停、邀请及撤权；`ensureRemotePeerBinary` 只在管理员安装操作时获取已验证组件。默认关闭，普通启动与状态查询均不下载、不启动 peer。远程专用前端不开放此管理入口。
- 使用独立 `remote-peer-v<version>` 产物，包含六种 GOOS/GOARCH 二进制、manifest 和许可附件；程序不塞进 NF 主包。下载选 GitHub 时二者从固定仓库获取；选镜像时二者均从该服务器获取，客户端冷缓存也不访问 GitHub，失败不回落 GitHub/上游。用户选择镜像即信任其发布清单，仍严格验证 size/SHA-256/架构/版本，不接受 unsigned tools 或任意 PATH 程序。
- peer 随正常 NF 发布自动处理，不要求单独手动发组件：主 Release 冻结生产输入指纹及 pin，未变复用；新 pin 自动六平台构建、原生 smoke，在同次受保护 publisher 中先发布 peer 再发 NF。源码变了但仍使用已公开旧 pin 时要求正常更新组件版本，不覆写旧资产。独立 [remote-peer workflow](../.github/workflows/remote-peer-release.yml) 仅保留诊断/历史恢复入口；既有 executor workflow/toolchain/recipe 不变。
- Linux 原生 smoke 已覆盖同一身份状态重开；Windows 私有 DACL/状态锁实现与跨平台构建不等于 Windows 原生验收，后者仍由六平台 CI 验证。当前实现不触发实际发布。

## 3. 拓扑与部署

```text
A：官方连接服务
  HTTPS：门户、静态 PWA、客户端版本描述
  WSS：B 在线注册、C 连接申请、SDP/ICE 交换
  STUN：单独部署的 coturn stun-only 服务

B：用户自托管实例
  NarraFork Bun 后端 / SQLite 或 PostgreSQL / 原有 HTTP + WS
  可选 remote-peer（Go/Pion）
    ├─ 主动连接 A
    ├─ 与 C 建立 WebRTC
    └─ 经受保护的本机桥接访问本实例

C：浏览器 / PWA
  静态前端来自 A
  业务请求、流式响应和实时事件来自 B 的 DataChannel
```

关闭远程访问时不启动辅助进程、不注册 A，也不增加本机桥接监听。辅助进程失败不得停止 NarraFork、Agent Loop 或既有 HTTP/WS。

### 3.1 每实例独立 origin

使用 `https://<instanceId>.connect.example`；公钥固定使用 P-256 SEC1 未压缩 65-byte 编码（04 + 32-byte X + 32-byte Y），校验曲线和点有效性；`instanceId` 为这些字节的 SHA-256、无 padding 小写 base32（52 字符）。不能对 JWK JSON/PEM/压缩点各自求指纹。A 配置通配 DNS 与 TLS，所有实例域共用同一个静态 bundle。实例公钥必须匹配 URL 中的身份，不接受 A 把同一实例 ID 映射到另一公钥。

根域只显示连接/配对入口及本浏览器保存的实例别名；不运行需要 B 的仪表盘查询，也不向服务器列出公共实例。切换实例完整导航，不在同页替换正在使用的 transport。localStorage、IndexedDB、BroadcastChannel、Service Worker 与页面 QueryClient 因 origin/生命周期隔离。不能把私有凭证改放父域 Cookie 或门户的全局存储。

MVP 不需要官方账号体系。跨浏览器恢复通过 B 再生成邀请；官方账号同步如后续加入，只同步发现能力和非敏感别名，不自动获得 B 的业务权限。每实例 origin 会增加重复静态缓存，作为明确的安全/实现简化取舍。

完整业务 PWA 从实例子域安装，每个实例独立 scope。根域如提供 PWA，只是实例发现器，不能假设一个 Service Worker/PWA scope 跨子域覆盖业务页面。

## 4. 实例身份、注册与配对

### 4.1 持久状态

B 本地保存实例身份私钥，限制为服务用户可读（Unix 0600 / Windows 对应 ACL），原子异步写入，不放通用 settings API、日志、命令行参数或信令。身份丢失/轮换意味着新 instanceId、新 origin，必须重新配对，禁止静默替换已固定的公钥。

B 的配对记录保存邀请 secret 的哈希、已配对浏览器公钥、grant ID、过期/撤销状态。业务 JWT 仍使用原实例认证机制；不与实例签名密钥或 A 的信令凭证混用。正式集成增加 schema 时只修改现有数据库 schema，再用生成命令产生 SQLite/PG 迁移，不手写迁移资产。

A 的 PoC 仅维护有界内存注册和在线租约：公钥/实例 ID、当前 B 信令连接、租约代次和发现 capability 哈希。重启后 B 可重新注册；A 无需保存 B 业务数据库或 JWT。生产持久化与多副本租约路由另作为运营阶段，不阻塞直连验证。

### 4.2 注册

1. 管理员在本地访问中启用远程功能、确认协调域名。
2. B 主动建立 WSS，签名 A 的短期随机挑战证明实例私钥持有权。
3. A 验证 instanceId、公钥及挑战，授予在线租约；同实例连接替换必须有新有效签名和租约代次，旧连接不能继续投递。
4. B 定期续租，断线后使用带 jitter 的退避重新注册。

注册证明实例身份，不发布 HTTP 服务，也不授予浏览器业务权限。

### 4.3 邀请与浏览器配对

本地已登录管理员生成 10 分钟有效、单次使用的邀请二维码/链接。邀请含：instanceId、公钥 pin、协调地址、仅用于 A 接受连接申请的 discovery capability、仅由 B 验证的独立 256-bit pairing secret。两种 secret 不能复用。

链接秘密放 URL fragment，前端读入内存后立即 replaceState 移除；不写查询参数、访问日志或 analytics。A 的服务器只接收 discovery capability，不接收 pairing secret。恶意官方 JS 仍能读取 fragment，必须保留这一信任边界声明。

C 在 WebCrypto 中生成 P-256 浏览器密钥；RTC 建立后，B 在受保护通道内验证 pairing secret 和密钥持有证明，原子消费邀请并发放绑定浏览器公钥的 connect-only grant。邀请重放被拒绝。grant 默认 30 天、可提前撤销；浏览器私钥尽量使用不可导出的 CryptoKey 存入该实例 origin 的 IndexedDB。

成功配对同时发放独立的 30 天 discovery capability：B 通过直连交给 C，只把其哈希、grant ID 和期限注册给 A；撤销邀请的旧 capability。B 在本地保存哈希用于 A 重启后的重新注册，不需要保留 discovery 明文。grant 续期时经已授权直连旋转 capability；过期后需要重新配对，不能依赖已过期的一次性邀请恢复连接。

connect-only grant 只允许建立配对连接和业务登录，不是用户 session。B 的账号密码、MFA、session JWT 仅在 C↔B 通道传递。MVP 在接受 JWT 后校验本地用户存在、tokenVersion、过期时间和当前管理员角色；非管理员明确拒绝，不转为管理员。登录、MFA 路径采用显式允许表，不开放注册、账号恢复、OIDC 重定向或 passkey 等尚未适配的旁路。

### 4.4 信令与会话绑定

A 为本次连接生成一次性、短寿命 ticket，绑定 instanceId、lease epoch、sessionId、双方角色、C 公钥摘要、offer SDP 摘要及截止时间。B 验证 ticket 并只接受当前租约与未消费的 sessionId。A 的 ticket 只许可协商，不足以绕过 B 的配对和业务登录。

已配对客户端在 offer 中携带 grant ID 与浏览器签名，B 先查本地有效 grant、验证 key 与 offer 摘要，再分配 RTC 资源；首次配对申请只允许映射到 B 本地仍有效的 invitation，每邀请最多一个未完成 peer。收到有效连接申请不延长 grant/invitation 的期限。这样 A 不能仅靠自己签发 ticket 任意消耗 B 的未认证 peer 预算。

B 对 answer 身份声明签名，C 使用邀请/已配对记录的公钥 pin 验证。双方 `peer.hello` 再绑定 sessionId、客户端 key、offer/answer 摘要及 DTLS certificate fingerprint，防止不同协商、实例或浏览器混接。签名输入使用固定字段、UTF-8 长度前缀和域分离标签；ECDSA 签名格式统一为 64-byte r||s，不临时创造模糊 JSON 拼接协议。

A 的发现租约与 B 的配对/业务授权使用独立生命周期。A 断线、在线租约 TTL 到期、注册续租失败或目录记录被撤销，只阻止发现、新连接及依赖信令的 ICE 协商；不能关闭仍获 B 本地授权的既有 RTC。lease epoch 只校验新协商，不在既有业务请求中要求当前 A 租约仍有效。

B 主动撤销浏览器 grant、业务 session 失效/用户退出或降权/tokenVersion 改变、禁用远程访问或主动撤销实例身份时，才关闭相应既有 peer/逻辑 socket，取消请求。不能把 A 租约失效回调复用为 B 权限撤销回调；A 离线也不能使已经过期的 B 授权继续有效。

## 5. 信令协议与控制面

A 只接受注册、租约、连接申请、offer、answer、candidate、end-of-candidates、cancel 和有限错误事件。没有通用 `data`/HTTP body/文件 payload 转发方法。

使用带 version、sessionId、leaseEpoch、type 和受校验 payload 的 JSON envelope。C 固定为 offerer，B answerer，减少双 offer 冲突；ICE restart 使用新 negotiation generation，旧候选不能注入新一代协商。

PoC 接口族：
- `GET /client/manifest`：官方壳版本、支持的 wire 版本、feature flags；无业务数据。
- `WSS /signal/instance`：B 注册与续租。
- `WSS /signal/browser`：C 提交 discovery capability、请求连接并交换信令；秘密放首条认证消息，不放 URL。
- 静态 shell：实例域与根域分别使用明确 bootstrap mode。

业务 `/api/*`、`/ws/*` 在 A 不存在；不得 SPA fallback 成 200 HTML，更不能连到 A 自身 NarraFork 数据。浏览器 remote transport 不允许业务请求落到这些公网 URL。

初始上限（可配置，只允许管理员提高）：单信令消息 96 KiB；SDP 64 KiB；单 candidate 2 KiB、每侧每代最多 128；未认证 WS 5 秒；协商 20 秒；ticket 60 秒；租约心跳 25 秒、75 秒失效。连接申请每 capability 每分钟最多 5 次，同时每实例最多 4 个 peer。A 按 IP、instanceId 和 capability 分层限流，并限制注册总量与每连接发送队列；不能用内存注册模式宣称无限规模或防滥用完备。

## 6. 业务 DataChannel 协议

### 6.1 通道

| 名称 | 用途 | 第一版可靠性 |
|---|---|---|
| `nf.control.v2` | hello/auth、请求头、状态、取消、信用更新 | 有序可靠 |
| `nf.realtime.v2` | 逻辑 socket 生命周期与 narrator 核心订阅 | 有序可靠 |
| `nf.bulk.v2` | 请求/响应 body、文件分块 | 有序可靠 |

不能对 permission、审批、终端字符、消息增量随意使用不可靠通道。以后只有可完整覆盖旧值的状态快照才能考虑丢弃。多个 DataChannel 仍共享 SCTP/网络拥塞；分通道不等于带宽独立，发送调度必须优先 control/realtime，并限制 bulk 在途数据。

### 6.2 请求响应与 socket

HTTP 语义：`request.open`（streamId/method/相对路径/允许头/hasBody）、等待 `request.accept` 后发送 body DATA、END；hasBody=false 隐式请求 EOF，不发送 bulk END；`response.open`（status/允许头）、DATA、END；`stream.cancel`、`stream.error`、`window.update`。客户端尽早返回 `Response` 和 `ReadableStream`，不是收齐 body 后再返回。AbortSignal 同时取消本地流和 B 的上游请求。保留业务错误码、session renewal、Content-Type、Content-Disposition 等端到端头；剔除 Host、Connection、Upgrade、Transfer-Encoding、任意代理头及内部桥接头。

逻辑 socket：`socket.open` 指定允许的业务 WS 路径和 B 凭证；`socket.ready`/message/close/error 复用既有消息协议和恢复逻辑。DataChannel 连接成功不自动表示每个 socket 已授权。仅在 B 实际 WS upgrade 成功后报告 ready。v2 的 text/binary 逻辑消息最多 2 MiB，使用独立 32-byte socket header 分成不超过 16 KiB 的帧；按 socket 有界重组、校验顺序并保留真实关闭码。每片进入已预留重组预算后归还 credit，避免大消息等待完整窗口而死锁。协议支持 binary 不代表本轮开放 outline/terminal。

二进制 DATA 使用固定 24-byte 大端 header：magic(4)、version(1)、kind(1)、flags(2)、streamId(4)、sequence(4)、payloadBytes(4)、reserved(4)。session 由当前 peer 上下文绑定，断线重建不复用旧 streamId。每帧总长度不超过 16 KiB 且不超过协商的 SCTP maxMessageSize；协议版本、长度、序号或 credit 不合法即拒绝。字段类型、frame kind、控制消息 schema 与边界测试集中在 shared/remote-access/。

### 6.3 预算与背压

默认每 peer 最多 32 个在途 HTTP stream、8 个逻辑 socket；每流初始 receive credit 64 KiB；控制 JSON 16 KiB、请求头总量 8 KiB；常规 JSON body 上限 1 MiB；MVP 文件上限 8 MiB，必须流式分块，不转 Base64 整体 JSON。更大文件需要单独能力和断点协议，不靠无限增大队列。

每 peer 应用发送/接收队列各最多 4 MiB，B 全局应用队列最多 32 MiB。DataChannel bufferedAmount 高水位 1 MiB、低水位 256 KiB；仅在低水位/credit 允许时继续读取上游。Pion 侧显式设置接收消息/缓冲上限，并验证浏览器协商效果，不能把应用计数当作整个 RTC 库的内存硬上限。

常规请求 30 秒截止；配对后人机登录窗口最多 10 分钟，单次认证另有限时。只对服务端允许的 SSE 路由提供流策略：响应头/credit 停滞各 30 秒、无业务或心跳活动 60 秒、最大持续 2 小时、累计最多 64 MiB，可贯穿取消且不缓存完整流。stderr/status 有界并脱敏；不记录正文、凭证或完整 SDP。

## 7. B 的本机桥接与生命周期

采用仅 127.0.0.1、随机端口的专用 Bun HTTP/WS listener。B 启动辅助进程时经受控 pipe 交付短期桥接 capability、监听地址和配置，不用 argv/env 暴露 secret；stdout 是有界版本化控制事件，stderr 为有界脱敏日志。

此 listener 的每次请求、socket upgrade 均先校验进程 capability、peer context capability、epoch、grant/session 与阶段/路径允许表。Go 只访问固定 listener，不接受 C 指定的 scheme、host、端口或 redirect 目标。生产模式拒绝业务重定向；仅显式 prototype 模式保留原型的手动 Location 测试语义。

共用分派器位于 `server/http-dispatcher.ts`，公开 listener 与私有 listener 保留 readiness、shutdown admission、request tracking、真实 opaque session 鉴权、WS handlers 和 BunFile Range/HEAD 处理。原生 WS upgrade 使用 Bun 原始 Request，不能传重建的 Request。`/_nf/remote/session/introspect` 仅私有桥接可用，读取真实会话但不滑动续期；公开 `/api/auth/me` 不增加内部字段。存储故障关闭传输（1013），grant 终止为 1008，仅真实 session 失效使用 4001，避免误清有效凭证。

私有入口设置由服务端验证的 `transport=webrtc`、peer/session/grant 上下文；不接受 C 自报 trustedProxy 或 clientIp。由于真实 TCP peer 是 loopback，远程登录/配对必须按 grant/browserKey/user 等身份维度额外限流，不能把所有异地用户当可信本机或仅计入 127.0.0.1。未来支持普通用户/终端前，专项确认 HTTP 与 WS 的逐资源授权一致。

辅助进程受 B 管理：退出、禁用或 B grant 撤销立即清理 peer/stream/socket；重启采用 1–30 秒指数退避+jitter，5 分钟连续失败进入显式故障态。绝不为其重启停止整个 NarraFork。

A 失联、在线租约 TTL 到期或续租失败时，既有 RTC 及其业务流继续运行，只由 B 本地 grant/session/角色的有效性决定；新的会话和需要信令的 ICE restart 等待 A 恢复。发现注册撤销也不自动取消既有 B 业务授权。若要立即关闭现有业务，必须由 B 执行明确的 grant/session/实例身份撤销或禁用远程访问；不能因 A 失联无限延长 B 权限。

## 8. C 的 transport 与启动顺序

前端抽象：

```ts
interface BusinessTransport {
  request(path: string, init?: RequestInit): Promise<Response>;
  upload(path: string, body: BodyInit, options?: BusinessUploadOptions): Promise<Response>;
  openSocket(path: string, credential: string): BusinessSocket;
}
```

完整接口与 mount ABI 以 `shared/remote-access/business-transport.ts` 为准；构建常量与 alias 在编译期选择 transport 和未支持功能替代模块，不维护第二套聊天业务源码。

请求 body 使用浏览器 Request 序列化 FormData/multipart，保留 Content-Type boundary；按协议预算传输，不转 Base64 大 JSON。HEAD、204/304 等无 body 响应保留语义。SSE 分片不是事件边界，UTF-8 解码器跨 chunk 保持状态。reader.cancel 与 AbortSignal 都通知 B 取消。生产 transport 不自动导航或请求重定向目标。

`HttpTransport` 保留原 HTTP/WS；`WebRtcTransport` 实现上述协议。business request 与 static asset fetch 分开命名和职责，不全局 monkey-patch fetch/WebSocket。MVP 远程模式先连接、配对、版本协商、B 管理员登录，再挂载业务路由和 query hooks；本地模式保持原启动顺序。

request/authorizedFetch、上传 XHR、直接 fetch 和 socket 构造点按清单迁移。upload progress 在远程路径表示已被 transport/对端接受的字节，不能误称已落盘；取消、中断与错误沿用用户可理解的语义。未迁移功能通过 capability 隐藏/禁用并返回明确 UnsupportedTransport 错误，而不是偷跑同源网络。

capability gate 同时覆盖入口、后台 hooks、启动同步和服务端路径允许表，不只隐藏菜单。MVP 禁用插件脚本/CSS/theme 注入、Webview/容器端口 iframe、匿名分享、未经桥接的媒体/下载、服务器重启更新流程、TLS/访问地址向导、提供商浏览器 OAuth、VS Code host token handoff。remote shell 在业务 App/全局插件初始化之前分支启动；[frontend/index.html](frontend/index.html#L70-L79) 的品牌图标和登录背景使用 A 固定静态资源，不在 bundle 加载前触发 B API URL。PoC 中 A 的 `/api/*` 拒绝策略不能代替浏览器端避免发送含业务资源 ID 的漏请求。

新增 transport 状态：idle → signaling → connecting → paired → authenticating → ready；以及 disconnected/recovering/failed/closed。配对/auth 状态与网络 ready 分开。Peer 状态和每个 socket ready 也分开。

## 9. PWA、资源与版本

M2 远程专用构建不注册 Service Worker/PWA；检测到已有控制页面的 SW 时拒绝启动。普通前端的 PWA 保持原样。连接由活动页面持有，不能宣称后台永驻或离线重建 RTC；远程 PWA/SW 资源桥留待专项设计。

轻量 bootstrap 先通过已验证 RTC hello 获取 **NF 应用** repository/release、bootstrap ABI、API epoch、wire version，再读取同 origin 的有界 catalog，选择显式兼容键映射的 immutable buildId。校验 manifest/hash 后在同一 document 加载业务 `mount`，保留既有 RTC。无匹配或禁用版本明确拒绝；不用 peer 版本代替 NF 版本，不取 latest、不猜 semver、不支持未经改造的历史 NF。普通/远程分别输出 `dist/frontend/` 与 `dist/frontend-remote/`；业务静态资源位于 `/remote/frontends/<buildId>/`。

资源迁移：
1. MVP：小图片、附件通过 transport 获取有界 Blob，组件使用 blob URL、卸载时 revoke；不是缓存私有内容到 A。
2. 本轮已验证小媒体的真实 206/416；大文件、持续流媒体、断点续传及同源虚拟资源 URL/SW 桥仍未开放，不能用小附件 Range 测试宣称完整媒体支持。
3. 任意 iframe 内相对资源、插件 UI、Webview、匿名分享及外部服务不是上述桥接的自动收益，需独立 origin/sandbox/路由授权设计。在完整验证前禁用。

passkey/SSO 原有 B origin/RP ID 不会自动迁移到官方 origin。MVP 仅允许密码与已适配的 TOTP/备份码认证，明确不提供远程 passkey、OIDC 和新用户注册。账户只有未支持的认证/MFA 方式时明确拒绝远程登录，不得跳过或降级 MFA。品牌 API、favicon、登录背景等启动资源同样要分类，不能连接前请求 A 的业务 URL。

## 10. 重连与写操作语义

M2 对短暂 disconnected 有界等待，持续失败后以已持久化 grant 重建 peer，并在新连接上重新认证；不是原连接 ICE restart。移动端挂起后仍须重新核验连接状态，不承诺后台一直在线。

重建 peer 使用新 session/epoch；先重新验证 grant 和 B session，再重建逻辑 socket 并按原 cursor/seq 补齐事件。快照类数据重新查询；终端 scrollback 恢复不能重复发送键盘输入。

只自动重试明确无副作用且可重试的读请求。写请求在“已发送但未获响应”时报告结果未知，先查询业务结果；不自动重放，也不宣称 exactly-once。未来对发送消息/执行命令等逐路由设计幂等键与持久去重后才开放重试。

## 11. 隐私、信任与运营

A 可以观察实例在线状态、公网地址、连接时刻和协商元数据；B/C 的 DataChannel 使用 DTLS，但官方提供前端 JS，不能称官方在安全模型上完全不可信。实例身份 pin/会话签名防御错配与信令替换，不防御恶意客户端代码。

日志与 telemetry 默认只含非敏感 error code、建连阶段耗时、直连候选类型和聚合字节计数；不上传业务正文、JWT、pairing secret、完整 SDP/candidates、内部文件路径。生产日志保留和告知策略属于上线门禁。

STUN 使用 coturn 的 stun-only 配置；默认不开放 TURN allocation，也不把“只隐藏 TURN 按钮”当禁用。独立 UDP 暴露需做流量限额、监控和滥用控制。将来可加入用户明确配置的 TURN，UI 必须显示 relay 路径和流量承担方，不能叫它直连。

验证直连同时检查 selected candidate pair 的双方类型；任一为 relay 即违反 direct-only。以 C/B 业务字节与 A 控制面字节差异验证业务不经 A，而不只看连接成功。计数使用 data-channel/transport 统计，不用 RTP 媒体统计代替。

## 12. 分阶段实施与完成条件

### M1：独立技术原型（已完成的历史验证）

新增 isolated coordinator、Go peer、浏览器调试客户端及共享协议测试；使用专用 fixture 后端、独立 HOME/端口、测试邀请和 JWT，不改真实用户数据库，不接管运行中的实例。注册/配对、身份绑定、direct-only、预算、取消和基本背压在此阶段就验证，不先做无认证公网隧道。

完成条件：浏览器到 Go DataChannel、真实 Request/Response 往返与流式响应、一个现有 narrator 类实时协议的逻辑 WS 转发、小文件双向传输；对端身份错误、邀请重放、未登录/非管理员、非法目标、relay 候选、协议超限、取消、断线结果未知均有负例测试。未完成真实不同 NAT 网络测试时只能标为“本机互操作通过”，不能宣布打洞验证成功。

### M2：NarraFork 核心应用集成

已加入设置/配对管理、受保护 loopback listener、辅助进程生命周期、真实管理员 password/MFA、项目/叙述者聊天审批、SSE 和小附件。普通/远程编译目标共享业务组件，远程精确匹配 NF release 后加载独立模块；未适配能力在模块图、hooks 与服务端允许表同时阻断。验收分别覆盖真实 Go→NF app/SQLite 业务和 production UI 的零业务网络旁路；测试 provider 可替身，auth/routes 不替身。多版本静态包与正常发布集成属于本轮交付，实际公网部署仍不在授权范围。

### M3：核心业务完整性

在权限专项验收后加入 terminal、git-workspace 等实时链路、大文件/下载/Range。完成实际使用中的 fetch/XHR/WebSocket/resource URL 清单迁移；M3 完成前不宣传“所有后端数据都已走 WebRTC”。插件、Webview、匿名分享、passkey/SSO 仍需独立验收。

### M4：生产部署与分发

跨 Linux/macOS/Windows、x64/arm64 与 baseline 编译、运行和浏览器 smoke；辅助进程采用已校验/可信发布源的配套组件，不静默下载执行未知二进制。首次启用与更新需明确安装状态、摘要/真实性校验和 wire 版本匹配。补齐 Pion及全部随产物分发的 Go 依赖许可证/NOTICE，按 [docs/LICENSES.md](docs/LICENSES.md) 登记。

A 的注册限额、日志政策、STUN 滥用治理、多副本租约路由、容量/故障恢复、TLS/域名运营和用户文档通过后，才部署正式官方服务。当前设计不授权发布、提交、推送、重启或修改生产服务。

## 13. 拟修改范围

M1 新增（建议路径）：`shared/remote-access/`、`remote-coordinator/`、`remote-peer/`、`scripts/webrtc-prototype.ts` 及隔离测试客户端。PoC 入口不注册为现有生产功能。

M2 已有接点：
- [server/main.ts](server/main.ts)：共用请求/WS 分派边界与专用 listener 生命周期。
- [server/middleware/auth.ts](server/middleware/auth.ts)、[server/routes/auth.ts](server/routes/auth.ts)：保留现有认证，增加已验证 remote grant/阶段约束。
- settings/validators 目录与现有数据库 schema：可选设置、配对记录及生成迁移。
- [frontend/main.tsx](frontend/main.tsx)、[frontend/lib/api/client.ts](frontend/lib/api/client.ts)、[frontend/lib/api/narrators.ts](frontend/lib/api/narrators.ts)：启动、请求与上传 transport。
- [frontend/lib/narrator-ws-manager.ts](frontend/lib/narrator-ws-manager.ts)、[frontend/hooks/useTerminalWS.ts](frontend/hooks/useTerminalWS.ts)：逻辑 socket（terminal 按阶段开通）。
- [frontend/src-sw.ts](frontend/src-sw.ts)、[frontend/lib/pwa.ts](frontend/lib/pwa.ts)、[frontend/lib/version-refresh.ts](frontend/lib/version-refresh.ts)、[frontend/vite.config.ts](frontend/vite.config.ts)：壳版本与 PWA 模式。
- 实际资源组件和中英 locale 目录：按迁移清单逐项修改，中英同时添加字符串。

不是把远程执行器的 device key 或 vnet UDP 节点当成浏览器 RTC；两者原功能保持独立。目录/文件可在实现中遵循现有约定细化，不移动大文件来顺带重构。

## 14. 验证矩阵

| 层级 | 必须证明 |
|---|---|
| 协议单测 | 帧长度/序号/credit、版本、取消、重复/乱序、超限，无无限积累 |
| 认证负例 | ticket/grant/身份错配、邀请重放、过期、撤销、非管理员、伪造桥接头、非法目标 |
| 本机互操作 | 浏览器↔Pion↔隔离 Bun HTTP/WS，真实流与响应头，不只 mock transport |
| 浏览器 | 首次配对、重载、实例切换、断线恢复、PWA 壳、未支持功能无业务网络旁路 |
| NAT 实测 | 同 LAN / 不同真实网络 / 双层 NAT / 移动 CGNAT；记录成功或失败及选中候选，不预设通过 |
| UDP 阻断 | 明确失败、无中继/普通 HTTP 偷跑、队列和资源及时释放 |
| 租约与授权隔离 | A信令断开并让在线lease过期，已获B授权的业务流/请求继续成功，新连接受阻；随后B撤销grant，既有peer/stream/socket立即关闭，业务不能继续 |
| 数据路径 | 大数据传输时 A 不出现相应 payload/流量增长；双方候选非 relay |
| 性能 | 慢消费者、丢包、大流与聊天并发、辅助进程故障，不阻塞业务主线程；记录内存/队列/事件循环延迟 |
| 回归 | 本地 HTTP/WS、权限、续期、SSE、上传、分享等既有测试继续通过 |

Bun 子集测试使用 `bun test --isolate`；静态检查 `bunx tsgo --noEmit`、对修改文件执行 Biome 并确认实际检查文件数；Go 使用 go test 和 race 检查，浏览器需真实启动。真实 NAT 结果不由本机 loopback 或 fixture 替代。所有测试使用隔离数据目录，不重启承载当前会话的 NarraFork。

## 15. 规范与代码依据

规范：RFC 8445（ICE，§2/§2.1/§2.2）、RFC 8827（信令信任与 DataChannel DTLS，§4.3/§6.5）、RFC 8831（DataChannel、消息与调度，§6.6）、W3C WebRTC / WebRTC Stats（接口、缓冲和候选统计）、Pion WebRTC v4 官方 API 文档（纯 Go RTC、DataChannel、SCTP 缓冲设置）。这些依据支持协议能力，不替代本项目兼容性实测。

现状证据：[API client](frontend/lib/api/client.ts)、[WS URL](frontend/lib/ws.ts)、[Service Worker](frontend/src-sw.ts)、[服务入口](server/main.ts)、[终端 WS](server/websocket/terminal-ws.ts)、[现有 Go 模块](remote-executor/go.mod)、[构建说明](docs/BUILD.md)、[许可证要求](docs/LICENSES.md)、[测试说明](docs/TESTING.md)。开发机 Bun 1.4.2 无 RTCPeerConnection；Go 1.26.1 可用。这些版本是本次环境事实，不是全部用户环境的保证。

## 16. 设计审视报告

### 原定目标
形成可评审架构、明确安全/传输边界与下一阶段可观察的验收条件，不改生产业务代码。

### 完成情况
- [x] 已完成：源码与规范调查、前端子系统设计复核、身份/origin/协议/预算/分阶段设计。
- [x] 后续已完成：M1 隔离原型、本机真实 Chromium/Pion/Bun 验收、Go race/vet、Windows/amd64 与 Darwin/arm64 交叉编译（不是原生运行）。
- [x] 后续实测：独立 nug2 公网 WSS/STUN，domepc/laptop 互换浏览器角色均可经公网 IPv6 直连；双向业务、并行吞吐已验证，未走 EasyTier/TURN。强制 IPv4 失败并完成映射/过滤诊断，结果不推广到所有网络。
- [x] 后续 M2：真实 NF app/隔离数据库的核心业务、会话撤权/存储故障、条件编译与 production UI 资源边界验收；Linux peer 同状态重开 smoke。没有使用 fixture auth/routes 替代真实后端。
- [ ] 未完成：IPv4 穿透增强、UDP 阻断专项、远程 PWA、非核心业务、进程 RSS 压测、完整多平台原生运行和正式公网部署；不得用本机核心业务或交叉编译结果替代。

### 发现的问题与修正

| 严重程度 | 具体问题 | 根本原因 | 修正 |
|---|---|---|---|
| 必须改正（已修正） | §4 初稿未区分邀请过期和已配对浏览器重连发现凭证 | 未完整走查第二次连接生命周期 | 独立长期 discovery capability、旋转、撤销与重注册 |
| 必须改正（已修正） | §8 只描述 capability gate，未覆盖 bundle 前品牌请求/插件启动同步 | 过度聚焦 API 主入口，漏查浏览器原生资源 | 前置 remote shell 启动分支，禁用旁路与后台 hooks，要求零业务漏流 |
| 应当改正（已修正） | §9 用同 API major 推断可兼容，缺乏跨版本验证 | 把版本命名当兼容证据 | M1/M2 使用明确匹配版本，兼容矩阵由测试证明 |
| 必须改正（已修正） | §4/§7 与 M1 初稿混称 grant/lease 撤销，可能使 A 离线关闭既有业务 | 未严格区分控制面租约和 B 本地业务授权生命周期 | A租约仅控制发现/新协商，B授权决定既有RTC；增加“租约过期继续、B撤销立即关闭”验收 |

### 做得好的地方
- 将“业务不经 A”与“任何网络必可用”分开，没有静默中继和未经验证的成功率承诺。
- 用独立 origin、保留既有业务协议和可选辅助进程控制范围，未为探索改写主业务。

### 下次重点关注
真实不同 NAT 网络、浏览器/Pion 互操作、私有桥接授权、资源旁路、慢消费者与辅助进程内存。新会话继续时可附本设计文档作为上下文；上述修正已保存在本工作区。
