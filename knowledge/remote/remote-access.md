---
id: remote.remote-access
title: 远程访问
summary: 经 WebRTC 从外部浏览器访问本实例：Go 子进程、请求白名单 bridge、邀请与授权。
anchors:
  - server/routes/remote-access.ts
  - server/services/remote-access-runtime.ts
  - server/services/remote-access-registry.ts
  - server/services/remote-access-bridge.ts
  - server/services/remote-access-ipc.ts
  - server/lib/remote-access-config.ts
  - shared/remote-access/request-policy.ts
  - remote-peer/
  - remote-coordinator/
  - remote-host/
  - frontend/components/settings/RemoteAccessSettingsPanel.tsx
  - frontend/hooks/useRemoteAccess.ts
  - frontend/lib/api/remote-access.ts
  - frontend/routes/settings/remote-access.tsx
  - server/lib/remote-peer-binaries.ts
  - server/lib/remote-request-context.ts
  - shared/remote-access/
  - shared/remote-peer.ts
  - shared/remote-peer-manifest.ts
  - shared/remote-peer-distribution.ts
keywords:
  - 远程访问
  - WebRTC
  - remote-peer
  - /api/remote-access
  - settings.remoteAccess
  - signalUrl
  - stunUrls
  - leaseSeconds
  - allowLocalhost
  - REMOTE_REQUEST_POLICY
  - REMOTE_SOCKET_MESSAGES
  - REMOTE_CAPABILITY_NAMES
  - needs-install
  - REMOTE_NOT_READY
  - 邀请
  - 授权
  - 配对
  - remote-host
  - remote-coordinator
  - build:remote
  - pion
status: draft
verified_at: 878917e97
---
# 远程访问

让用户不暴露端口、经 WebRTC 从外部浏览器访问本实例。

## 关键规则
- 远程访问由 `RemoteAccessRuntime` 管理（`remote-access-runtime.ts`）：读 `settings.remoteAccess`（默认 `enabled: false`），启用且已安装组件时，拉起 Go 子进程 `remote-peer`（pion/webrtc），经管道 IPC 通讯；设置变化触发重新对账。组件未安装时状态为 `needs-install`，`POST /component/install` 下载安装（超时 130s）。
- 状态：`disabled` / `needs-install` / `starting` / `ready` / `backoff` / `failed`（`shared/remote-access/management.ts`）；失败后按 1s 起翻倍、上限 30s 退避重试，满 5 次进 `failed`。`status()` 只读磁盘，不会安装或启动。
- 远程请求不直接进入应用：对端请求经本机回环 bridge 校验后交给服务端分发器；bridge 只放行 `REMOTE_REQUEST_POLICY` 里**逐条枚举**的方法加路径（登录、健康检查、设置读取、项目和叙述者读写若干等），不是整个 `/api` 命名空间（`shared/remote-access/request-policy.ts`，`remote-access-bridge.ts`）。WebSocket 也只转发白名单消息类型（`REMOTE_SOCKET_MESSAGES`）。
- 管理接口 `/api/remote-access/*` 全部 `requireAdmin`，且不在远程请求策略内，即不能被远程对端调用：状态、组件安装、创建/取消邀请（配对）、列出/吊销授权（`routes/remote-access.ts`）。
- 对端会话由 `RemoteAccessRegistry` 持有，带 capability、会话投影与登录期限；密钥用常量时间比较（`equalRemoteSecret`）。后端能力集合在 `shared/remote-access/application.ts:REMOTE_CAPABILITY_NAMES`。
- 仓库里另有 `remote-coordinator/`（TypeScript，导出 `startCoordinator`；仓库内只被 `tests/remote-access/` 里的测试运行时启动）与 `remote-host/`（远程前端静态资源托管，校验前端制品清单；CLI 是 `scripts/remote-host.ts`：`import/bootstrap/disable/catalog/serve`，公网监听要求 TLS 证书和 `--instance-domain`，不提供 API、WebSocket 或业务中继）；二者在线上的部署角色未核实。`remote-prototype/` 是原型，未查看。
- 设置默认 `enabled=false`、`leaseSeconds=300`、`iceNetworkTypes=[udp4,udp6]`（`remote-access-config.ts`）；`signalUrl` 要求 `wss:`（`ws:` 只在 `allowLocalhost` 且主机为本机时允许）。
- IPC：Go 子进程经 stdin/stdout 按行 JSON 通讯，单行上限 64KB、待决命令上限 32、命令超时 15s；畸形输出或 EOF 使整个 epoch 失效（`remote-access-ipc.ts`、`shared/remote-access/ipc.ts`）。
- 对端二进制是可选组件，来源绑定、显式请求才下载，下载逻辑不启动它（`server/lib/remote-peer-binaries.ts`；清单与平台定义在 `shared/remote-peer.ts`、`remote-peer-manifest.ts`，平台为 linux/darwin/windows × amd64/arm64）。
- 远程请求上下文：`remote-request-context.ts` 用 WeakMap 给请求打进程内标记（grantId、clientIp），`http-dispatcher.ts` 据此识别远程请求；没有 header 或公开的 Hono 绑定能写入它。

## 从哪读起
- `server/services/remote-access-runtime.ts`：生命周期。
- `shared/remote-access/`：协议、IPC、请求策略、前端清单的共享定义。
- `remote-peer/peer.go`：Go 侧 WebRTC 对端。
- 前端：`frontend/routes/settings/remote-access.tsx`、`components/settings/RemoteAccessSettingsPanel.tsx`、`hooks/useRemoteAccess.ts`（仅管理员查询；启用时每 5 秒轮询状态，就绪后才查授权列表；邀请密钥不进查询缓存）、`lib/api/remote-access.ts`。

## 改它时
- 给远程端开放一个接口：只在 `shared/remote-access/request-policy.ts:REMOTE_REQUEST_POLICY` 逐条加（方法 + 路径），WebSocket 消息类型加到 `REMOTE_SOCKET_MESSAGES`；管理接口 `/api/remote-access/*` 刻意不进策略，不能为方便远程调用而加。测试 `shared/remote-access/application.test.ts`、`tests/remote-access/*`（含 `browser-isolation.test.ts`）。
- 改 IPC 协议：`shared/remote-access/ipc.ts`（版本 `REMOTE_IPC_VERSION`、单行 64KB、待决命令 32、命令超时 15s）与 Go 侧 `remote-peer/` 一起改；`shared/remote-access/contract.json` / `vectors.json` 是两端共享的契约与向量，`remote-peer/*_test.go` 与 `tests/remote-access/protocol.test.ts` 会校验。
- 加设置项：`server/lib/remote-access-config.ts` 的默认值与 zod schema（`signalUrl` 必须是 `wss:`，仅 `allowLocalhost` 时允许本机 `ws:`；`leaseSeconds` 60..3600）、`shared/remote-access/management.ts:RemoteAccessSettings`、前端 `RemoteAccessSettingsPanel.tsx`。
- 远程前端是另一套构建（`bun run build:remote`，见 [构建与打包](../engineering/build.md)）；`remote-host/` 校验前端制品清单，`frontend-manifest.test.ts`、`tests/scripts/remote-host.test.ts` 守着。
- 不能破：`status()` 只读磁盘，不安装不启动；组件安装只在显式 `POST /component/install`；对端请求只经 `markTrustedRemoteRequest` 标记的本机 bridge 进入，标记是进程内 WeakMap，没有 header 能伪造。

## 相关
- [虚拟网络中转](vnet.md)：经 WebSocket 中继的虚拟网络，与本节点无关。
- [设备与远程执行](devices.md)
