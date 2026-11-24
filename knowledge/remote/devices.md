---
id: remote.devices
title: 设备与远程执行
summary: 设备注册与连接、remote-executor、文件传输。
anchors:
  - server/services/device-service.ts
  - server/services/device-connection-service.ts
  - server/services/device-remote-backend.ts
  - server/services/device-transfer-service.ts
  - server/services/device-transfer-task-store.ts
  - server/routes/devices.ts
  - server/routes/executor-bootstrap.ts
  - server/lib/agent/execution/device-auth.ts
  - server/lib/agent/execution/rpc-types.ts
  - remote-executor/
  - frontend/components/settings/DevicePathRulesEditor.tsx
  - frontend/components/settings/ExecutorInstallModal.tsx
  - frontend/components/settings/executor-install-command.ts
  - frontend/lib/api/devices.ts
  - frontend/lib/device-config.ts
  - frontend/lib/device-install-url.ts
  - frontend/routes/settings/devices.tsx
  - server/lib/agent/tools/transfer-file.ts
  - server/lib/agent/tools/transfer-progress.ts
  - server/lib/crc32c.ts
  - server/lib/device-url.ts
  - server/lib/executor-binaries.ts
  - server/lib/executor-bootstrap-ticket.ts
  - server/lib/executor-enrollment-policy.ts
  - server/lib/executor-install-ca.ts
  - server/lib/executor-install-script.ts
  - server/lib/helper-binaries.ts
  - server/lib/helper-binary-platform.ts
  - server/lib/helper-distribution-runtime.ts
  - server/lib/validators/devices.ts
  - shared/executor-path-rules.ts
  - shared/remote-executor-manifest.ts
  - shared/remote-executor.ts
  - shared/remote-peer-distribution.ts
  - shared/remote-peer-manifest.ts
  - shared/remote-peer.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 设备与远程执行

让叙述者的文件与命令工具在另一台机器上执行：该机器运行 Go 写的 `remote-executor`，与服务端建立 WebSocket，服务端经 RPC 调它。设备记录在 `remote_devices` 表。

## 关键规则
- 两种连接方向（`remote_devices.connectionMode`）：`reverse`（默认，执行器拨入服务端 `/ws/device`）和 `direct`（服务端拨向 `directUrl`，断线按 2s 起翻倍、上限 60s 退避重拨，`device-connection-service.ts`）。两种方向共用同一套 RPC 逻辑（`DeviceTransport`）。
- 令牌：`rdev_` 加随机串，库里只存 SHA-256（`tokenHash`），明文只在创建或轮换时返回一次（`device-service.ts:generateDeviceToken`、`rotateDeviceToken`）。
- 握手：服务端与执行器各出 32 字节 nonce，互相发 HMAC 证明（key 由 tokenHash 派生，transcript 含 role），`device-auth.ts` 与 Go 侧共用格式；握手超时 10s；协议版本 `DEVICE_PROTOCOL_VERSION = 1`。设备能力不足时服务按场景抛 `DeviceScopeError` 的 `DEVICE_EXECUTOR_UPGRADE_REQUIRED`、`DEVICE_PTY_UNAVAILABLE` 等码（未逐处核实触发条件）。
- 可用性有两条轴：项目轴（`scope: global|project`，project 设备要求项目精确匹配）和用户轴（`ownerScope: private|shared`，private 只有创建者可用）（`isDeviceAuthorized`）。设备管理（改名、轮换、吊销）仅限管理员或创建者（`canManageDevice`）；列表接口对非管理员只返回自己注册的设备。
- RPC 方法集由 `rpc-types.ts:RpcMethod` 定义：`fs.*`、`glob`、`grep`、`exec.*`、`git.*`、`pty.*`、`editor.*`、`transfer.*`。执行器通过握手上报 features，服务端按 `deviceHasFeature` 判断某能力是否可用；单设备长连 RPC 上限 256。
- 路径守卫规则：`remote_devices` 里存的是期望规则，真正的执行在执行器本机配置里，目的是服务端被攻破也不能扩大执行器权限（schema 注释；`PUT /:id/path-rules` 只是下发期望值）。
- 安装：`POST /api/devices/:id/install-script` 生成一次性短期 ticket 的安装命令；公开路由 `/api/executor/{install,download,enroll}/:platform` 凭 ticket 工作；`enroll` 兑换 ticket 时轮换设备密钥（旧密钥立即失效），并先检查传输是否安全再消耗 ticket（`executor-bootstrap.ts`）。
- 文件传输：控制面走 `transfer.*` RPC，数据面走二进制块帧，按偏移流式读写、写 `.part` 文件、可暂停/恢复/取消；任务持久化在 `device_transfer_tasks`，服务重启时进行中的任务被标记为暂停（`TRANSFER_RESTART_PAUSE_NOTICE`）。路由 `/:id/transfer-tasks*`。

## 从哪读起
- `server/services/device-connection-service.ts`：连接、握手、`sendRpc`。
- `server/services/device-remote-backend.ts`：把工具调用翻译成 RPC，经 `setRemoteBackendResolver` 接入 `lib/agent/execution/registry.ts`。
- `remote-executor/internal/rpc`、`internal/handlers`：Go 侧分发与各方法实现；`remote-executor/README.md` 是安装说明（线索，未逐条核实）。
- `server/routes/devices.ts`：管理 API。

## 相关
- [远程访问](remote-access.md)：浏览器远程访问本服务，与本节点（服务端访问设备）方向相反。
