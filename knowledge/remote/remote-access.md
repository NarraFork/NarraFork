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
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 远程访问

让用户不暴露端口、经 WebRTC 从外部浏览器访问本实例。

## 关键规则
- 远程访问由 `RemoteAccessRuntime` 管理（`remote-access-runtime.ts`）：读 `settings.remoteAccess`（默认 `enabled: false`），启用且已安装组件时，拉起 Go 子进程 `remote-peer`（pion/webrtc），经管道 IPC 通讯；设置变化触发重新对账。组件未安装时状态为 `needs-install`，`POST /component/install` 下载安装（超时 130s）。
- 状态：`disabled` / `needs-install` / `starting` / `ready` / `backoff` / `failed`（`shared/remote-access/management.ts`）；失败后按 1s 起翻倍、上限 30s 退避重试，满 5 次进 `failed`。`status()` 只读磁盘，不会安装或启动。
- 远程请求不直接进入应用：对端请求经本机回环 bridge 校验后交给服务端分发器；bridge 只放行 `REMOTE_REQUEST_POLICY` 里**逐条枚举**的方法加路径（登录、健康检查、设置读取、项目和叙述者读写若干等），不是整个 `/api` 命名空间（`shared/remote-access/request-policy.ts`，`remote-access-bridge.ts`）。WebSocket 也只转发白名单消息类型（`REMOTE_SOCKET_MESSAGES`）。
- 管理接口 `/api/remote-access/*` 全部 `requireAdmin`，且不在远程请求策略内，即不能被远程对端调用：状态、组件安装、创建/取消邀请（配对）、列出/吊销授权（`routes/remote-access.ts`）。
- 对端会话由 `RemoteAccessRegistry` 持有，带 capability、会话投影与登录期限；密钥用常量时间比较（`equalRemoteSecret`）。后端能力集合在 `shared/remote-access/application.ts:REMOTE_CAPABILITY_NAMES`。
- 仓库里另有 `remote-coordinator/`（信令/协调，TypeScript）与 `remote-host/`（远程前端静态资源托管，校验前端制品清单）；它们是否随本产品部署、各自在线上的角色未核实。`remote-prototype/` 是原型，未查看。

## 从哪读起
- `server/services/remote-access-runtime.ts`：生命周期。
- `shared/remote-access/`：协议、IPC、请求策略、前端清单的共享定义。
- `remote-peer/peer.go`：Go 侧 WebRTC 对端。

## 相关
- [虚拟网络中转](vnet.md)：经 WebSocket 中继的虚拟网络，与本节点无关。
- [设备与远程执行](devices.md)
