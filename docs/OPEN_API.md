# NarraFork OAuth 2.0 与 External API v1 接入指南

状态：已实现，计划随后续版本发布

适用范围：第三方桌面应用、移动应用、机器人、自动化服务及其它 NarraFork 外部客户端

NarraFork 可作为 OAuth 2.0 Authorization Server。外部应用通过 Authorization Code + PKCE 获取用户授权，并使用版本化的 External API v1 管理该授权下的远端设备和独立叙述者。

本文描述当前实际实现。旧版 API Token 设计、让 OAuth token 直接访问普通 `/api/*` 路由、以及复用内部 `/ws/narrator` 的方案均未采用。

---

## 1. 安全边界

### 1.1 两种身份完全隔离

| 身份 | 用途 | 可访问范围 |
|---|---|---|
| Session JWT | NarraFork 第一方 Web UI 和管理操作 | 普通 `/api/*`、管理员路由、内部 WebSocket |
| OAuth access token | 第三方应用 | `/api/external/v1/*` |

OAuth token 不能访问普通项目、管理员、设置或内部叙述者 API，也不能用于同意新的 OAuth 授权。Session JWT 不能调用 External API v1。

### 1.2 授权交集

一次外部操作必须同时满足：

1. access token 仍有效且未吊销；
2. OAuth client 仍启用；
3. grant 仍有效；
4. token、grant、client 的实时 scope 交集中包含所需 scope；
5. 若操作关联项目：目标项目位于 grant 的有限项目白名单内（project-less 操作不做此检查，grant 所有权本身即为隔离边界）；
6. 目标资源由同一个 grant 创建；
7. OAuth client policy 允许该操作。

项目白名单为空表示拒绝所有项目级操作，不表示全局访问。资源 ID 不属于当前 grant 时按 404 处理，避免泄露其它授权下的资源是否存在。

---

## 2. 管理员注册 OAuth 应用

管理员在“设置 → OAuth 应用”中注册第三方应用，配置：

- 显示名称；
- 稳定 `client_id`；
- redirect URI 精确白名单；
- 可请求的 scope；
- 叙述者权限模式、系统提示词、全局设备等 policy 上限。

OAuth 应用是 public client，不持有 client secret，必须使用 PKCE S256。

原生应用可注册固定自定义协议，例如：

```text
robot-assistant://oauth/callback
```

也可注册 RFC 8252 loopback 模板：

```text
http://127.0.0.1:0/callback
```

端口 `0` 仅代表允许客户端选择临时 loopback 端口；协议、主机、路径、查询和 fragment 仍必须匹配。

---

## 3. Authorization Server Discovery

客户端应先读取：

```http
GET /api/oauth/.well-known/oauth-authorization-server
```

标准 RFC 8414 字段包括：

- `authorization_endpoint`
- `token_endpoint`
- `revocation_endpoint`
- `scopes_supported`
- `code_challenge_methods_supported: ["S256"]`
- `token_endpoint_auth_methods_supported: ["none"]`

NarraFork 还返回扩展字段 `narrafork_external_api`：

```json
{
  "version": "v1",
  "base_url": "https://narrafork.example.com/api/external/v1",
  "websocket_url": "wss://narrafork.example.com/ws/external/v1/narrators",
  "websocket_ticket_endpoint": "https://narrafork.example.com/api/external/v1/ws-tickets",
  "recommended_scopes": [
    "project.read",
    "device.read",
    "device.provision",
    "device.rotate",
    "narrator.read",
    "event.subscribe",
    "narrator.provision",
    "narrator.send_message",
    "narrator.interrupt"
  ]
}
```

客户端应使用 discovery 返回的地址，不要自行拼接固定端口或假设服务器是否启用 TLS。反向代理部署必须把代理直接地址加入 `auth.trustedProxyCidrs`；只有直连 peer 受信时，服务器才采用最靠近该代理的 `X-Forwarded-Proto` / `X-Forwarded-Host`，并由同一公开 origin 派生全部 HTTP/WSS 地址。非可信来源的 forwarded header 会被忽略。

---

## 4. Authorization Code + PKCE

### 4.1 发起授权

客户端生成：

- 随机 `state`；
- 43–128 字符的 PKCE `code_verifier`；
- `code_challenge = BASE64URL(SHA256(code_verifier))`。

在系统浏览器打开 discovery 返回的 `authorization_endpoint`：

```text
/oauth/authorize
  ?response_type=code
  &client_id=robot-assistant
  &redirect_uri=robot-assistant%3A%2F%2Foauth%2Fcallback
  &scope=project.read%20device.read%20narrator.read
  &state=<random-state>
  &code_challenge=<s256-challenge>
  &code_challenge_method=S256
```

用户登录 NarraFork 后可：

- 查看应用和请求的 scope；
- 选择允许访问的项目；
- 同意或拒绝授权。

回调中的 `state` 必须与客户端发起授权时保存的值做常量时间或等价安全比较。

### 4.2 交换 token

向 discovery 返回的 `token_endpoint` 提交表单：

```http
POST /api/oauth/token
Content-Type: application/x-www-form-urlencoded

 grant_type=authorization_code
 &client_id=robot-assistant
 &code=<authorization-code>
 &redirect_uri=robot-assistant%3A%2F%2Foauth%2Fcallback
 &code_verifier=<original-verifier>
```

成功响应：

```json
{
  "access_token": "<opaque-token>",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "<opaque-refresh-token>",
  "scope": "project.read device.read narrator.read"
}
```

access token 默认有效期 1 小时；refresh family 的绝对有效期为 30 天。refresh token 每次使用都会轮换，旧 refresh token 重放会吊销整个 family。

### 4.3 刷新和吊销

刷新：

```http
POST /api/oauth/token
Content-Type: application/x-www-form-urlencoded

 grant_type=refresh_token
 &client_id=robot-assistant
 &refresh_token=<refresh-token>
```

吊销 access token 或 refresh token：

```http
POST /api/oauth/revoke
Content-Type: application/x-www-form-urlencoded

 token=<token>
 &client_id=robot-assistant
```

客户端应将 access token 和 refresh token 存入操作系统安全存储，不应写入 URL、普通日志、源码或崩溃报告。

---

## 5. Scope

### 5.1 External API v1 canonical scope

| Scope | 能力 |
|---|---|
| `project.read` | 列出 grant 允许的项目 |
| `device.read` | 列出或读取当前 grant 创建的设备 |
| `device.provision` | 幂等创建设备 |
| `device.rotate` | 轮换设备注册凭证 |
| `narrator.read` | 读取当前 grant 创建的叙述者及其文本消息 |
| `event.subscribe` | 获取 WebSocket ticket 并订阅叙述者变化 |
| `narrator.provision` | 幂等创建独立叙述者 |
| `narrator.send_message` | 向叙述者发送纯文本消息 |
| `narrator.interrupt` | 中断叙述者运行 |
| `message.summary.read` | 读取分层消息投影的 `skeleton` / `summary` 层（消息结构、推理步骤标题、工具身份/目标/状态） |
| `message.content.read` | 追加 `full` 层（推理正文、工具 input/output）与单工具下钻端点 |

新建 OAuth 应用时，管理 UI 默认选择这些细粒度 scope。

`message.*` 与 `narrator.read` 是两件不同的事：`narrator.read` 只授权叙述者状态和既有的有界纯文本投影；读取叙述者的**结构**（工具身份、推理步骤），尤其是工具 payload，是明显更大的披露，必须在同意页单独出现。详见 §7.6。

---

## 6. OAuth Client Policy

管理员为每个 OAuth 应用设置 policy ceiling：

### 6.1 通用字段

| 字段 | 含义 | 默认值 |
|---|---|---|
| `defaultPermissionMode` | 未指定模式时的默认叙述者权限模式 | `readOnly` |
| `allowedPermissionModes` | 客户端可请求的权限模式集合（见 §6.3） | `["readOnly"]` |
| `systemPromptMode` | `managed` 忽略客户端提示词；`append` 允许受限追加 | `managed` |
| `maxSystemPromptChars` | 客户端提示词最大字符数 | `0` |
| `allowGlobalDevice` | 是否允许创建全局设备 | `false` |
| `allowKnowledgeWrite` | OAuth 叙述者运行时是否允许知识库写入 | `false` |
| `allowDangerReflectionPrompt` | 客户端是否可提供 danger reflection 附加提示词 | `false` |
| `maxDangerReflectionPromptChars` | danger reflection 附加提示词最大字符数 | `0` |
| `allowRobotDiagnosticPreset` | 是否将服务端定义的机器人诊断只读预设合并到该客户端的 allow-list | `false` |
| `messageDetail` | 分层消息投影的层级上限：`none` / `summary` / `full`（见 §7.6） | `summary` |

**为什么 `messageDetail` 默认不是最严值：** 本表其它上限守护的都是**有副作用的动作**（在设备上执行、放宽提示词、写知识库），默认关闭对管理员零成本。而这一项守护的是一次**读取**，且客户端已经必须取得 `message.summary.read` 的用户同意；若再默认关闭，就等于让同一个已获批准的能力需要两次独立开闸。真正值得第二次决策的是 payload 披露，所以 `full` 是管理员必须显式选择的值。

### 6.2 设备访问模型（`deviceAccess`）

设备访问按**三组**独立配置，每组为一个 `DeviceOperationLevel`：

| 级别 | 语义 |
|---|---|
| `denied` | 禁止 Bash/Write/Edit |
| `readOnly` | 只允许风险引擎归类为非变更的操作（与内部 readOnly Shell 同一套目录/命令 allow-list） |
| `readWrite` | 允许变更操作，仍受已有的目录/命令 deny-list 和灾难性命令检测约束 |

三组设备及其默认值：

| 组 | 含义 | 默认级别 |
|---|---|---|
| `host` | NarraFork 服务器本机 | `denied` |
| `global` | `scope=global` 且非该客户端自行注册的设备 | `readWrite` |
| `selfRegistered` | 该客户端通过 integration_resource_bindings 自行注册的设备 | `readWrite` |

运行时分类逻辑（`classifyDeviceAccessGroup`）：每次工具调用根据 (deviceId, 请求方 grant) 动态判定设备所属组——同一台物理设备可因请求方不同而归入不同组。分类结果决定该次调用的操作天花板。

**`host` 组与本机执行：** `deviceAccess.host` 默认 `denied`，但管理员可按 OAuth 客户端将其放宽为 `readOnly` 或 `readWrite`。放宽后，OAuth 叙述者可在 NarraFork 宿主机上执行，受限于该级别的能力天花板。这不再是硬编码不可变的 `false`。

**`global`/`selfRegistered` 组：** 默认 `readWrite`（设备所有权本身即为信任边界），管理员可按需收紧。

**tool 准入判断：** 运行时会检查 `deviceAccess` 三组中是否有任一组 `!= denied`（决定 Bash 是否出现在可用工具列表）和是否有任一组 `== readWrite`（决定 Write/Edit 是否出现）。这只是粗粒度的候选集门控；具体工具调用时会对目标设备进行分类并查验精确组级别。

**兼容性说明（已废弃字段）：** 旧版 policy 可能包含 `allowRemoteShell`、`remoteShellLevel`、`allowRemoteFileWrite` 三个字段。解析时会通过 `z.preprocess` 透明迁移到 `deviceAccess` 模型：shell 能力和文件写入能力各自映射为一个 `DeviceOperationLevel`，取两者中更严格的值作为 `global` 和 `selfRegistered` 的统一级别，`host` 组不受旧字段影响（始终保持其 schema 默认值 `denied`）。迁移保证有效权限只可能缩小、不可能扩大。新代码不应再使用旧字段。

### 6.3 权限模式（`permissionMode`）

`allowedPermissionModes` 支持三种值：

| 模式 | 语义 |
|---|---|
| `readOnly` | 只允许只读操作 |
| `dontAsk` | 需要交互确认的操作直接拒绝（headless 客户端无法应答） |
| `bypassPermissions` | 需要确认的操作路由到 **danger reflection loop**（而非直接放行或拒绝） |

**`bypassPermissions` 不等于"跳过所有检查"。** 对于 headless 外部客户端，交互式审批不可能完成，因此 `bypassPermissions` 改为将风险操作送入 danger reflection loop：由模型自行评估风险并做出 confirm/cancel 决策。灾难性命令（catastrophic commands）仍被无条件拒绝，`deviceAccess` 天花板仍然独立生效。如果 reflection loop 无法完成决策，默认结果是 cancel（fail-closed）。

客户端可在 provision 时选择 `allowedPermissionModes` 中的任一模式。管理员可通过收紧 `allowedPermissionModes` 限制客户端可用的模式范围。

### 6.4 Policy 交集与冻结

policy 在 authority/grant 与资源创建时冻结一份上限快照。运行时取 client policy、authority policy 与 narrator snapshot 三层的交集（`intersectOAuthClientPolicies`）；之后任一层收紧都会立即生效，但不能放宽已创建资源的冻结上限。旧 policy/snapshot 缺少新字段时按 schema 默认值解析。

### 6.5 执行安全边界

即使设备访问级别允许变更操作，以下始终被拒绝：

- `spec://` 虚拟路径
- `.git` 内部路径
- 灾难性命令（由内置检测逻辑判定）
- 无法安全解析的 Shell 命令

`readOnly` Shell 模式额外拒绝文件写入、管道执行、反向 Shell 与危险环境注入。

---

## 7. External API v1

所有请求使用：

```http
Authorization: Bearer <access-token>
```

Base URL 从 discovery 的 `narrafork_external_api.base_url` 获取。

### 7.1 端点总览

| 方法与路径 | Scope | 说明 |
|---|---|---|
| `GET /projects` | `project.read` | 列出 grant 允许的项目 |
| `GET /devices` | `device.read` | 列出当前 grant 的设备 |
| `PUT /devices/provisions/:provisionKey` | `device.provision` | 幂等创建设备 |
| `GET /devices/:id` | `device.read` | 读取设备 |
| `POST /devices/:id/credentials/rotate` | `device.rotate` | 轮换设备凭证 |
| `PUT /narrators/provisions/:provisionKey` | `narrator.provision` | 幂等创建叙述者 |
| `GET /narrators/:id` | `narrator.read` | 读取叙述者状态 |
| `GET /narrators/:id/messages` | `narrator.read`（+ `message.*` 用于结构化层） | 游标分页读取消息，层级由 `detail` 选择 |
| `POST /narrators/:id/messages` | `narrator.send_message` | 发送纯文本消息 |
| `GET /narrators/:id/tool-calls/:toolUseId` | `message.content.read` | 单工具 payload 下钻（预算大于页内内联） |
| `POST /narrators/:id/interrupt` | `narrator.interrupt` | 中断运行 |
| `POST /ws-tickets` | `narrator.read event.subscribe` | 获取单次 WebSocket ticket |

### 7.2 幂等 provisioning key

`provisionKey` 是调用方稳定保存的资源幂等键：

- 1–80 字符；
- 仅允许字母、数字、`.`、`_`、`~`、`-`；
- 唯一范围是同一个 grant；
- 相同 grant + 相同 key 的重试返回同一资源；
- 不同 grant 或不同 key 不共享资源。

不要使用显示名称代替 `provisionKey`。

### 7.3 创建设备

```http
PUT /api/external/v1/devices/provisions/robot-main
Authorization: Bearer <access-token>
Content-Type: application/json

{
  "projectId": "<authorized-project-id>",
  "scope": "project",
  "name": "Robot Main Computer",
  "description": "Remote executor for Robot Assistant"
}
```

首次成功返回 `201`：

```json
{
  "device": {
    "id": "<device-id>",
    "slug": "robot-main-computer",
    "scope": "project",
    "projectId": "<project-id>",
    "status": "offline"
  },
  "created": true,
  "credential": { "token": "<one-time-device-token>" }
}
```

相同 key 重放返回 `200`、`created: false`、`credential: null`。设备 token 只在首次创建或显式轮换时返回一次。

`scope: "global"` 必须由客户端显式请求。`allowGlobalDevice` 参与 policy 交集计算并写入冻结快照，但**不在 provisioning 路径做运行时拦截**——对 grant 自己 provision 的设备，grant 所有权（资源绑定）本身就是唯一的隔离边界。`projectId` 可选：省略时设备为纯全局设备（无项目锚点）。

### 7.4 创建叙述者

叙述者只能绑定当前 grant 拥有的设备：

```http
PUT /api/external/v1/narrators/provisions/diagnosis-session-42
Authorization: Bearer <access-token>
Content-Type: application/json

{
  "projectId": "<authorized-project-id>",
  "deviceId": "<owned-device-id>",
  "deviceIds": ["<owned-device-id>", "<optional-second-device-id>"],
  "title": "Diagnosis session 42",
  "permissionMode": "readOnly",
  "systemPrompt": "Optional client context",
  "dangerReflectionPrompt": "Optional reflection context (requires policy opt-in)"
}
```

`projectId` 可选：v3 snapshot（project-less）模式下不传入，grant 所有权本身即为隔离边界。`deviceIds` 为叙述者可访问的设备数组（最多 16 个），必须包含 `deviceId`。

`permissionMode` 可为 `readOnly`、`dontAsk` 或 `bypassPermissions`，并受 client policy 的 `allowedPermissionModes` 限制。省略时使用 `defaultPermissionMode`。系统提示词是否采用及长度上限同样由 policy 决定。客户端还可选择提供 `dangerReflectionPrompt`（在 `bypassPermissions` 模式下作为 reflection 上下文），需 policy 的 `allowDangerReflectionPrompt` 为 `true`。

### 7.5 消息分页

```http
GET /api/external/v1/narrators/<id>/messages?limit=50&cursor=<opaque-cursor>
```

默认层级（`detail=text`）只包含用户/助手的有界纯文本投影，不返回原始 tool payload、thinking、文件快照或其它内部消息结构：

```json
{
  "items": [
    {
      "id": "<message-id>",
      "seq": 12,
      "role": "assistant",
      "text": "...",
      "textTruncated": false,
      "createdAt": "2026-07-18T00:00:00.000Z"
    }
  ],
  "nextCursor": null,
  "documentRevision": 41,
  "detail": "text"
}
```

cursor 是不透明值，客户端不得解析或修改。`documentRevision` 对应叙述者的消息版本，可用于跳过无变化的重读（见 §8.4）。

按需读取更多结构见 §7.6。**未传 `detail` 的请求行为与本节完全一致**：既有客户端无需改动、也无需申请新 scope。

### 7.6 分层消息读取（LOD 渐进获取）

#### 为什么是三层而不是照搬 UI 的 LOD

NarraFork 自己的界面用 `RenderLod` 1..6 控制细节。它的内部端点同样是游标分页的，但**每页只有一种详细度**：服务端不区分调用方需要多少，一律发出渲染所需的完整消息结构（含全部 content block 与按字节预算截断的工具 input/output），LOD 纯粹在客户端拿到这份数据之后决定渲染成「整卡 / 一行 / 计数行」。

对外不能照搬这套分级：L5 的「最近两段展开」是位置相关而非级别相关，L1 的收起是 CSS 高度——两者都无法在服务端忠实表达。更重要的是，那份按页结构无条件包含工具 payload，原样对外等于让「只想看工具计数」的客户端也必须接收命令输出全文。

所以这里新增的是一个与分页**正交**的详细度维度：分页决定取哪些消息，`detail` 决定每条消息披露到哪一层。

因此对外契约是三个稳定的**数据层**，按披露程度递增：

| `detail` | 含义 |
|---|---|
| `text`（默认） | 既有的有界纯文本投影，形状不变 |
| `skeleton` | 仅有界标量：文本长度、工具计数、推理 token 数。不读任何大 JSON 列 |
| `summary` | 带身份的结构：正文、推理步骤标题、每个工具的名称/目标/状态/字节数 |
| `full` | 追加推理正文与按字节预算投影的工具 input/output |

客户端若要镜像 NarraFork 的细节滑块，推荐映射为 `1 → skeleton`、`2..4 → summary`、`5..6 → full`。该映射仅供参考，服务端只认上面四个字符串，所以 UI 分级变化不会破坏外部契约。

#### 有效层级与降级语义

有效层级 = `min(请求的 detail, scope 上限, policy.messageDetail)`，三者任一收紧立即生效。

- **超额请求会降级，而不是失败。** 客户端上调细节不该把一个能用的页面变成 403；诚实的答案是「你有权看到的那一页」，并通过 `detailRequested` 告知被压低了。
- **完全没有结构化 scope 则拒绝。** 请求 `skeleton`/`summary`/`full` 但不持有 `message.summary.read` → `403 INSUFFICIENT_SCOPE`。这不是「细节少一点」，而是用户从未授予的能力。
- **policy 为 `none` 则拒绝。** 即使持有 scope，`403 OAUTH_POLICY_FORBIDDEN`——不会静默退回 `text` 形状。

```http
GET /api/external/v1/narrators/<id>/messages?detail=summary&limit=30
GET /api/external/v1/narrators/<id>/messages?detail=skeleton&order=desc&limit=50
```

| 参数 | 语义 |
|---|---|
| `detail` | `text`（默认）/ `skeleton` / `summary` / `full` |
| `order` | `asc`（默认，走向更新的消息）/ `desc`（tail-first，走向更旧的消息） |
| `cursor` | 不透明游标；方向由 `order` 决定 |
| `limit` | 上限按层分档：`text`/`skeleton` 50、`summary` 30、`full` 10 |

只有一个 cursor，方向由 `order` 决定。曾考虑过单独的 `before` 参数但未采用：那会引入四种 cursor/order 组合，其中两种没有合理语义。

结构化层的响应形状：

```json
{
  "items": [
    {
      "id": "<message-id>",
      "seq": 12,
      "role": "assistant",
      "createdAt": "2026-07-18T00:00:00.000Z",
      "kind": "message",
      "textChars": 20,
      "text": "Running diagnostics.",
      "reasoning": {
        "tokens": 128,
        "steps": [{ "title": "Check the logs", "chars": 27 }]
      },
      "tools": {
        "count": 1, "running": 0, "failed": 0, "awaitingPermission": 0,
        "items": [
          {
            "toolUseId": "<tool-use-id>",
            "name": "Bash",
            "target": "systemctl status robot",
            "status": "success",
            "durationMs": 42,
            "inputBytes": 40,
            "outputBytes": 80,
            "hasDetail": true
          }
        ]
      },
      "subagents": { "count": 1, "items": [{ "toolUseId": "...", "type": "explore", "title": null, "status": "running", "recentCallCount": 0 }] }
    }
  ],
  "nextCursor": null,
  "documentRevision": 41,
  "detail": "summary",
  "detailRequested": "full"
}
```

要点：

- **计数永远精确。** `count` 从不被截断；`itemsTruncated` 只表示**枚举**被裁剪，所以客户端即使只看到前 64 项也可以信任 `count`。
- **`subagents` 与 `tools` 分开计数。** `Agent`/`Task`/`Send` 归入 `subagents`，因此客户端的「N 次工具调用」与 NarraFork 界面一致。
- **system 行只作为 compact 标记出现**（`kind: "compact"`），任何层级都不返回其正文；内部 system 文本不属于外部契约。
- **`target`** 由固定 key 白名单在 SQL 内投影，按 `file_path` → `command` → `pattern` → `url` → `query` → … 的具体程度取第一个命中值。
- **`hasDetail: true`** 表示下钻端点能返回比该项更多的内容。
- **`reasoning.unavailable`** 区分「本条没有推理」（`steps: []`）与「有推理但因体积守卫未被读取」。

`full` 层额外给出 `reasoning.steps[].body` 与每个工具的 `input`/`output`。payload 走既有的字节预算投影，超限叶子保持 `{ "_truncated": true, "preview": "...", "fullLength": N }` 形状，并在项上标记 `inputTruncated` / `outputTruncated`。

`full` 层的预算刻意小于内部 vlist：内部的 8KB/leaf 是为了填满卡片已经预留的高度，而外部客户端没有那个盒子，同样预算乘上一页工具密集的消息就是响应体积问题本身。页内内联只覆盖每条消息**前 8 个**工具调用，其余项仍带身份、状态与字节数并报告 `hasDetail`。

#### 单工具下钻

```http
GET /api/external/v1/narrators/<id>/tool-calls/<tool-use-id>
```

需要 `message.content.read` 且 `policy.messageDetail === "full"`。预算显著大于页内内联（32KB/leaf、128KB/工具），所以页面裁掉的内容可以在这里取回：

```json
{
  "toolUseId": "<tool-use-id>",
  "name": "Bash",
  "status": "success",
  "target": "systemctl status robot",
  "durationMs": 42,
  "inputBytes": 40,
  "outputBytes": 80,
  "input": { "command": "systemctl status robot" },
  "output": { "stdout": "..." },
  "inputTruncated": false,
  "outputTruncated": false,
  "createdAt": "2026-07-18T00:00:00.000Z",
  "completedAt": "2026-07-18T00:00:01.000Z"
}
```

可见性沿用叙述者自身的 ref 归属规则，与第一方界面一致：fork 的共享历史仍可读，已离开调用方视图的行则消失。属于其它 grant 的工具 ID 按 404 处理。

本端点**不返回** sidecar 原文、文件快照或图片二进制——这些超出「消息渲染数据」范畴，未纳入本次开放。

---

## 8. External Narrator WebSocket

外部 WebSocket 与内部 `/ws/narrator` 完全分离，默认关闭，需要管理员逐项启用。

### 8.1 获取单次 ticket

```http
POST /api/external/v1/ws-tickets
Authorization: Bearer <access-token>
```

需要 `narrator.read` 和 `event.subscribe`：

```json
{
  "ticket": "<single-use-ticket>",
  "expiresIn": 30
}
```

约束：

- ticket 有效期 30–60 秒；
- 只可消费一次；
- 与 external narrator channel 绑定；
- 服务端只保存 SHA-256 摘要；
- 响应带 `Cache-Control: no-store`；
- ticket 不应写入日志。

### 8.2 建立连接

```text
wss://narrafork.example.com/ws/external/v1/narrators?ticket=<ticket>
```

非浏览器客户端可以不发送 `Origin`。浏览器发送 `Origin` 时必须精确匹配管理员配置的 allowlist；空 allowlist 拒绝所有携带 Origin 的连接。

连接成功后服务端发送：

```json
{ "type": "ready", "version": 1, "maxSubscriptions": 50 }
```

### 8.3 客户端帧

```json
{ "type": "subscribe", "narratorIds": ["n1"], "requestId": "r1" }
{ "type": "unsubscribe", "narratorIds": ["n1"], "requestId": "r2" }
{ "type": "sync_check", "narratorId": "n1", "requestId": "r3" }
{ "type": "send_message", "narratorId": "n1", "message": "hello", "requestId": "r4" }
{ "type": "interrupt", "narratorId": "n1", "requestId": "r5" }
{ "type": "pong" }
```

所有 schema 都是 strict；未知字段、重复 ID、超限数组和超限文本会被拒绝。

### 8.4 服务端帧

```json
{ "type": "subscribed", "narratorIds": ["n1"], "requestId": "r1" }
{ "type": "unsubscribed", "narratorIds": ["n1"], "requestId": "r2" }
{ "type": "narrator_changed", "narratorId": "n1" }
{ "type": "narrator_changed", "narratorId": "n1", "documentRevision": 41, "requestId": "r3" }
{ "type": "message_accepted", "narratorId": "n1", "requestId": "r4" }
{ "type": "interrupted", "narratorId": "n1", "requestId": "r5" }
{ "type": "rate_limited", "retryAfterSeconds": 1, "requestId": "r4" }
{ "type": "auth_lost", "code": "GRANT_REVOKED", "message": "..." }
{ "type": "error", "code": "INSUFFICIENT_SCOPE", "message": "..." }
{ "type": "ping" }
```

`narrator_changed` 只是变化提示。客户端应通过 REST 详情和消息分页接口拉取权威状态，而不是假设 WebSocket 推送完整消息内容。

`documentRevision` **只出现在 `sync_check` 的回复上，不出现在服务端主动推送的帧里**。它与 REST 消息页返回的是同一个值，客户端可以和自己已持有的版本比较，从而完全跳过一次重读——在 `full` 层尤其值得，因为那一页要 join 工具行并投影 payload。推送帧刻意不带它：产生推送的领域事件本身不携带版本号，填这个字段就意味着在扇出路径上为每个订阅者、每个事件多做一次索引读取。推送帧保持纯信号，需要便宜检查的客户端用 `sync_check` 主动问。

每个已解析帧都会重新验证 access token、grant、client 和基础订阅 scope。涉及资源的帧还会重新验证项目白名单和 ownership。

---

## 9. 限流、上限与断线处理

服务端对以下维度设置固定或管理员可调上限：

- OAuth 端点的 pre-auth IP bucket；
- client、grant、user 等 principal bucket；
- ticket 全局容量；
- WebSocket 单帧字节数；
- 单帧和单连接订阅数；
- 全局、token、grant、client、user 连接数；
- WebSocket 发送缓冲；
- 控制帧与写操作速率。

HTTP 429 响应和 WebSocket `rate_limited` 帧都可能包含 `retryAfterSeconds`。客户端应使用带抖动的指数退避，禁止立即无界重试。

以下变化会使现有连接立即断开：

- access token 吊销；
- refresh family 吊销或检测到重放；
- grant 撤销或项目/scope 收紧；
- client 撤销或 policy/scope 收紧；
- 管理员修改 External WebSocket 安全配置。

客户端收到 `auth_lost` 或 4001/4003 类关闭码后，应停止重连，先刷新 token 或重新授权。

---

## 10. 错误处理

OAuth token endpoint 使用 RFC 6749 风格错误：

```json
{
  "error": "invalid_grant",
  "error_description": "..."
}
```

External API 使用 NarraFork 结构化错误，常见 code：

- `OAUTH_REQUIRED`
- `OAUTH_GRANT_FORBIDDEN`
- `OAUTH_CLIENT_FORBIDDEN`
- `INSUFFICIENT_SCOPE`
- `OAUTH_PROJECT_FORBIDDEN`
- `OAUTH_POLICY_FORBIDDEN`
- `INTEGRATION_AUTHORIZATION_DENIED`
- `PAYLOAD_TOO_LARGE`
- `OAUTH_WS_TICKET_CAPACITY`

不要根据错误文案做程序分支；应使用 HTTP 状态和稳定 `code`。

---

## 11. 客户端上线检查清单

- 使用 discovery，不硬编码 OAuth/API/WS 地址；
- 使用系统浏览器和 PKCE S256；
- 校验 `state`；
- token 存入安全存储；
- 请求 canonical 最小 scope，不使用旧冒号式 scope；
- 宿主机执行（`deviceAccess.host`）默认 denied；remote 设备组默认 readWrite，管理员可按需收紧；在客户端 UI 中明确展示执行能力状态；
- 使用稳定、非显示名称的 `provisionKey`；
- 只保存首次返回的设备 credential；
- 消息读取按需申请 `message.summary.read` / `message.content.read`，并把响应里的 `detail` 当作权威层级（可能低于请求值）；
- 按层遵守 `limit` 上限；用 `documentRevision` 跳过无变化的重读；对 `itemsTruncated` / `stepsTruncated` / `*Truncated` / `hasDetail` 做处理，需要完整 payload 时走单工具下钻端点而不是提高 `limit`；
- 处理 refresh rotation 和 refresh reuse 失效；
- 对 429、`rate_limited` 和临时网络错误做有界退避；
- 收到 `auth_lost` 后停止盲目重连；
- 将 REST 视为权威状态，WebSocket 仅用于变化通知和有界控制；
- 不记录 access token、refresh token、device token 或 WebSocket ticket。
