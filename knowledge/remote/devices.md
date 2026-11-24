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
  - remote-executor/cmd/
  - remote-executor/go.mod
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
  - shared/helper-distribution.ts
  - shared/windows-pe.ts
keywords:
  - 远程设备
  - 设备
  - remote-executor
  - 执行器
  - rdev_
  - remote_devices
  - device_transfer_tasks
  - /api/devices
  - /api/executor
  - /ws/device
  - connectionMode
  - directUrl
  - DeviceScopeError
  - DEVICE_OFFLINE
  - DEVICE_SCOPE_FORBIDDEN
  - DEVICE_PTY_UNAVAILABLE
  - DEVICE_PLATFORM_UNSUPPORTED
  - DEVICE_EXECUTOR_UPGRADE_REQUIRED
  - TransferFile
  - 路径规则
  - 安装脚本
  - executor-bootstrap
  - devices.allowPlaintextEnrollmentOnPrivateNetwork
  - pty.ready-stream.v1
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 设备与远程执行

让叙述者的文件与命令工具在另一台机器上执行：该机器运行 Go 写的 `remote-executor`，与服务端建立 WebSocket，服务端经 RPC 调它。设备记录在 `remote_devices` 表。

## 关键规则
- 两种连接方向（`remote_devices.connectionMode`）：`reverse`（默认，执行器拨入服务端 `/ws/device`）和 `direct`（服务端拨向 `directUrl`，断线按 2s 起翻倍、上限 60s 退避重拨，`device-connection-service.ts`）。两种方向共用同一套 RPC 逻辑（`DeviceTransport`）。
- 令牌：`rdev_` 加随机串，库里只存 SHA-256（`tokenHash`），明文只在创建或轮换时返回一次（`device-service.ts:generateDeviceToken`、`rotateDeviceToken`）。
- 握手：服务端与执行器各出 32 字节 nonce，互相发 HMAC 证明（key 由 tokenHash 派生，transcript 含 role），`device-auth.ts` 与 Go 侧共用格式；握手超时 10s；协议版本 `DEVICE_PROTOCOL_VERSION = 1`。`DeviceScopeError` 的码（`device-service.ts:DeviceScopeErrorCode`）：`DEVICE_SCOPE_FORBIDDEN`（`device-service.ts` 的授权检查：设备是别人私有的，或项目范围不匹配，403）；其余在 `terminal-service.ts` 创建远程终端时抛：`DEVICE_OFFLINE`（设备未连接）、`DEVICE_PTY_UNAVAILABLE`（能力未声明 `pty`）、`DEVICE_PLATFORM_UNSUPPORTED`（Windows 设备暂不支持交互终端）、`DEVICE_EXECUTOR_UPGRADE_REQUIRED`（缺 `pty.ready-stream.v1` 特性）。
- 可用性有两条轴：项目轴（`scope: global|project`，project 设备要求项目精确匹配）和用户轴（`ownerScope: private|shared`，private 只有创建者可用）（`isDeviceAuthorized`）。设备管理（改名、轮换、吊销）仅限管理员或创建者（`canManageDevice`）；列表接口对非管理员只返回自己注册的设备。
- RPC 方法集由 `rpc-types.ts:RpcMethod` 定义：`fs.*`、`glob`、`grep`、`exec.*`、`git.*`、`pty.*`、`editor.*`、`transfer.*`。执行器通过握手上报 features，服务端按 `deviceHasFeature` 判断某能力是否可用；单设备长连 RPC 上限 256。
- 执行器二进制分发是来源绑定的：`server/lib/executor-binaries.ts` 取清单并校验，`helper-binaries.ts` / `helper-distribution-runtime.ts` 负责下载缓存（同一套也分发 ripgrep 等 CLI 辅助程序），`shared/helper-distribution.ts` 定义目录与组件版本，`shared/remote-executor-manifest.ts` 校验清单；Windows 二进制用 `shared/windows-pe.ts` 校验 PE 架构。
- 路径守卫规则：`remote_devices` 里存的是期望规则，真正的执行在执行器本机配置里，目的是服务端被攻破也不能扩大执行器权限（schema 注释；`PUT /:id/path-rules` 只是下发期望值）。
- 安装：`POST /api/devices/:id/install-script` 生成一次性短期 ticket 的安装命令（平台为 `linux/darwin/windows` × `amd64/arm64`，`shared/remote-executor.ts:EXECUTOR_PLATFORMS`；ticket 机制见「改它时」）；公开路由 `/api/executor/{install,download,enroll}/:platform` 凭 ticket 工作；`enroll` 兑换 ticket 时轮换设备密钥（旧密钥立即失效），并先检查传输是否安全再消耗 ticket（`executor-bootstrap.ts`）。传输检查三种结果（`executor-enrollment-policy.ts:evaluateEnrollmentTransport`）：https 或回环地址，放行；私网 http，仅当 `settings.devices.allowPlaintextEnrollmentOnPrivateNetwork` 为真才放行（默认 false）；公网 http，永远拒绝。
- 文件传输：控制面走 `transfer.*` RPC，数据面走二进制块帧，按偏移流式读写、写 `.part` 文件、可暂停/恢复/取消；任务持久化在 `device_transfer_tasks`，服务重启时进行中的任务被标记为暂停（`TRANSFER_RESTART_PAUSE_NOTICE`）。路由 `/:id/transfer-tasks*`。

## 从哪读起
- `server/services/device-connection-service.ts`：连接、握手、`sendRpc`。
- `server/services/device-remote-backend.ts`：把工具调用翻译成 RPC，经 `setRemoteBackendResolver` 接入 `lib/agent/execution/registry.ts`。
- `remote-executor/internal/rpc`、`internal/handlers`：Go 侧分发与各方法实现；`remote-executor/README.md` 是安装说明（线索，未逐条核实）。
- `server/routes/devices.ts`：管理 API。
- `server/lib/agent/tools/transfer-file.ts`：`TransferFile` 工具（可后台运行，重启后可恢复）；`transfer-progress.ts` 是进度与完成摘要的纯格式化；`server/lib/crc32c.ts` 与 Go 侧同一 CRC-32C 做分块校验。
- 前端：`frontend/routes/settings/devices.tsx`；`ExecutorInstallModal.tsx` + `executor-install-command.ts` 生成安装命令（默认基址取浏览器当前 origin，可改，`lib/device-install-url.ts`）；`DevicePathRulesEditor.tsx` 编辑路径规则（`shared/executor-path-rules.ts`：有序 allow/deny 目录前缀，最后一条匹配者生效）；`lib/device-config.ts`、`lib/api/devices.ts`。
- `server/lib/device-url.ts:isSecureDirectDeviceUrl`：direct 模式的 `directUrl` 只接受 `wss:`，或回环 IP 字面量（127.x / ::1）的 `ws:`（`device-service.ts` 创建时检查）；`executor-install-ca.ts` 处理安装脚本带的 CA 证书（只读公钥证书路径）。

## 改它时
- 加一个 RPC 方法：`server/lib/agent/execution/rpc-types.ts:RpcMethod` + Go 侧 `remote-executor/internal/rpc`、`internal/handlers`；新能力要有 `features` 字符串并在服务端用 `deviceHasFeature` 门控，旧执行器才会得到 `DEVICE_EXECUTOR_UPGRADE_REQUIRED` 而不是直接失败（远程终端的 `pty.ready-stream.v1` 是例子，见 `terminal-service.ts`）。
- 改握手或 HMAC 转写格式：`device-auth.ts` 与 Go 侧必须同时改，并升 `DEVICE_PROTOCOL_VERSION`；`server/services/__tests__/device-connection-auth.test.ts`、`device-rpc-lifecycle.test.ts` 会拦。
- 改授权规则：`isDeviceAuthorized` / `canManageDevice`，对应测试 `device-authorization.test.ts`、`device-session-visibility.test.ts`、`routes/__tests__/device-non-admin-authorization.test.ts`。
- 改安装流程：`executor-bootstrap.ts`、`executor-bootstrap-ticket.ts`（ticket 有效 10 分钟、同时最多 200 张、`script`/`binary`/`token` 三种动作分别计次，`token` 只能兑换一次）、`executor-enrollment-policy.ts`；测试 `routes/__tests__/executor-bootstrap.test.ts`、`executor-enroll.test.ts`、`device-install-script-url.test.ts`、`server/lib/__tests__/executor-bootstrap-ticket.test.ts`、`executor-enrollment-policy.test.ts`、`executor-install-script.test.ts`、`tests/executor-bootstrap-e2e.test.ts`。
- 改文件传输：`transfer.*` RPC、`device-transfer-service.ts`、`device-transfer-task-store.ts`、`TransferFile` 工具与 CRC32C 要一起看；测试 `device-transfer-paths.test.ts`、`device-transfer-tasks.test.ts`、`tools/__tests__/transfer-progress.test.ts`。
- 不能破：令牌明文只在创建/轮换时返回一次（库里只有 SHA-256）；路径守卫的真正执行在执行器本机，服务端只下发期望值；安装时 `enroll` 先检查传输安全再消耗 ticket。Go 侧另有 `.github/workflows/remote-executor.yml` 跑执行器测试。

## 相关
- [远程访问](remote-access.md)：浏览器远程访问本服务，与本节点（服务端访问设备）方向相反。
