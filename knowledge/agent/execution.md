---
id: agent.execution
title: 执行后端
summary: 工具在哪执行：本地、远程设备；路径语义。
anchors:
  - server/lib/agent/execution/
  - server/lib/agent/tool-executor.ts
  - server/services/device-connection-service.ts
  - server/lib/tool-execution-target-projection.ts
keywords:
  - ExecutionBackend
  - executionBackend
  - 远程设备
  - 设备执行
  - device 参数
  - withDeviceParam
  - ExecutionTargetError
  - REMOTE_DEVICE_UNAVAILABLE
  - REMOTE_DEVICE_UNAUTHORIZED
  - ToolExecutionTarget
  - 路径语义
  - TargetPathSemantics
  - durable service
  - background-services
  - executionTargetsJson
  - SwitchDevice
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 执行后端

文件与命令类工具（Read/Write/Edit/Glob/Grep/Bash/StructView 等）不直接调用 `fs`，而是经 `ExecutionBackend` 接口：一组原子原语（文件字节读写、stat、mkdirp、listDir、glob、grep、`execCommand`、git status/diff）。复杂逻辑（Edit 的替换器链、Read 的分页和上限、Bash 的看门狗）留在 TypeScript 工具层，后端只做 IO 与执行（`backend.ts` 头注释与接口）。

## 关键规则
- 两种后端：`localBackend`（服务器本机，id 为 `"local"`）和远程设备后端（`kind: "remote"`，带 `deviceId`、`defaultCwd`、平台信息）。远程后端由 `device-connection-service.ts` 通过 `setRemoteBackendResolver` 注入。
- 选择顺序：调用显式 `device` > 会话默认设备（SwitchDevice 或全局默认）> local（`registry.ts:resolveBackend`）。**远程目标未知或离线时抛 `ExecutionTargetError`（`REMOTE_DEVICE_UNAVAILABLE`），绝不回退到本机执行**；不在叙述者授权设备列表内抛 `ExecutionTargetAuthorizationError`（`REMOTE_DEVICE_UNAUTHORIZED`）。
- 工具通过 `tool-backend.ts:getToolBackend(ctx, device)` 拿后端。执行器注入的 `ctx.resolveBackend` 优先；否则若上下文有冻结的执行目标，则调用不得改成别的设备，试图改写直接报错。
- 执行目标冻结：权限审批前，`tool-executor.ts` 解析并持久化 `ToolExecutionTarget`（设备、后端类型、cwd、路径风格、词法/规范路径、运行时代次等）；重放时若这些字段与已批准的不一致，会给出漂移说明（`describeExecutionTargetDrift`），`selectionSource` 仅用于审计，不算安全属性。
- 所有文件/命令工具的 schema 经 `withDeviceParam` 增加可选 `device` 字段；可选设备列表与会话默认放在提示词上下文里，不写进 schema（`device-schema.ts`）。
- 路径语义：`TargetPathSemantics` 按目标的路径风格（`posix` / `windows` / `spec`）做纯词法操作（resolve、dirname、relative、contains、identityKey 等），与 NarraFork 宿主 OS 无关；Windows 风格比较不区分大小写。规范文件系统身份另由后端的 `resolvePathIdentity` 解析。工具应用 `backend.paths` 或 `path-resolve.ts` 的包装，不自行写宿主路径逻辑。
- 远程后端的默认工作目录：`toolBaseCwd` 取设备默认目录；`bindSessionWorkspaceCwd` 只在上下文属于同一设备且路径对该设备是绝对路径时，才把会话自己的目录绑到后端上，避免 Windows 上下文的路径变成 POSIX 设备的基准目录。
- 设备认证：服务器与执行器用基于设备令牌 SHA-256 的 HMAC 互证，转写串含版本、deviceRef、双方 nonce 与角色，nonce 为 32 字节 base64url，比较用 `timingSafeEqual`（`device-auth.ts`）。
- 独占创建（`exclusive-create.ts`）：路径 ≤32768 字节、目录深度 ≤128、内容 ≤2,000,000 字节、总期限 30s，校验先于任何文件系统访问。
- 持久后台服务（`durable-service.ts`）：Unix 本机的 `background_kind: "service"` 把输出写到追加日志，包装 shell 记录退出码，清单记录 pid 与进程启动令牌，使计划内重启后新进程可核实并接管同一进程；落在 `<NARRAFORK_HOME>/background-services/<taskId>/`，终态后清理；Windows 不支持，回退普通管道执行。
- Git 工作区的远程调用类型在 `git-workspace-rpc.ts`，设备 RPC 的消息类型在 `rpc-types.ts`。

## 从哪读起
- `server/lib/agent/execution/backend.ts`：接口。
- `registry.ts`、`tool-backend.ts`：选择规则。
- `local-backend.ts`：本机实现。
- 测试：`execution/__tests__/registry.test.ts`、`path-semantics.test.ts`、`device-auth.test.ts`、`durable-service.test.ts`
- `server/lib/tool-execution-target-projection.ts`：工具调用记录的执行目标有两份（结构化的 `executionTargetsJson` 计划，和更早的平铺列 `executionDeviceId`/`executionCwd`…），`toolCallWithExecutionTargets` 是把它们还原成 API 形状（`ApiExecutionTarget`）的唯一入口，按叙述者的消息视图与全局执行日志都走它，`selectionSource` 取 `explicit` / `session_default` / `local_default`。
- 设备侧：`server/services/device-connection-service.ts` 把远程设备注册成后端并注入解析器；设备令牌互证见 `device-auth.ts`。

## 改它时
- 加一个文件/命令类工具：参数 schema 用 `withDeviceParam` 加 `device`，经 `getToolBackend(ctx, device)` 取后端，路径一律走 `backend.paths` 或 `path-resolve.ts`，不要直接 `fs` 或用宿主路径函数；后端新增原语要在 `backend.ts` 接口、`local-backend.ts` 与远程后端（`device-connection-service.ts` 与设备 RPC 类型 `rpc-types.ts`）同时实现。
- 远程目标未知或离线必须抛 `ExecutionTargetError`，不得回退本机（`execution/__tests__/registry.test.ts` 守着选择顺序）；路径语义改动跑 `path-semantics.test.ts`，设备认证改动跑 `device-auth.test.ts`，持久服务改动跑 `durable-service.test.ts`。
- 执行目标冻结发生在权限审批之前（`tool-executor.ts`）：新增会影响执行位置的字段要纳入 `ToolExecutionTarget` 与 `describeExecutionTargetDrift`，否则重放时发现不了漂移。
- `selectionSource` 只用于审计，不能当安全属性使用。

## 相关
- [文件工具](tools/file-tools.md)
- [命令与终端工具](tools/shell.md)
