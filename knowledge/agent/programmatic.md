---
id: agent.programmatic
title: 程序化执行与沙箱
summary: 程序化工具调用、沙箱与 VM 运行时。
anchors:
  - server/lib/agent/programmatic/
  - server/lib/agent/tools/eval.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 程序化执行与沙箱

让模型写一小段同步 TypeScript，在隔离的 Podman 容器里运行，并通过受控网关回调少数“接收者”（receiver）方法。目前唯一的使用者是 `Eval` 工具，它只暴露 `tools.Read`。服务本身不是 agent 工具，调用方必须提供真实的授权与审计回调（`service.ts:createProgrammaticService` 注释）。

## 关键规则
- Eval 默认关闭：只有运营者设置环境变量 `NF_READONLY_EVAL_IMAGE`（64 位十六进制镜像 ID，可带 `sha256:`）和 `NF_READONLY_EVAL_NARRATORS`（1–16 个叙述者 ID）才可用；模型输入或 `/load` 都不能授予（`eval.ts:readEvalConfiguration`）。它在 `OPTIONAL_TOOLS` 里，`isAvailable` 在未配置时为假。执行还要求上下文带授权/审计桥（`executeRead`、`recheckAuthorization`、tool call 绑定）并允许本地执行。
- Eval 中的 `tools.Read` 只读纯文本，`limit` ≤200（缺省 100），二进制扩展名（pdf、ipynb、常见图片）被拒；走叙述者现有权限与审计。代码 ≤64KiB；返回值或 `deliver(value, summary)` 结束该次 Eval，不结束叙述者回合。
- 源码守卫（`source-guard.ts:guardSource`）：在隔离 Worker 内用 Babel 解析，必须整体留在同步函数体内；出现 async、await、import、`Promise` 即拒绝；遍历用迭代而非递归，防止深嵌套攻击。不在服务器主线程解析不可信源码。
- 隔离驱动必须是 Podman（`driver.policy.kind !== "podman"` 直接拒绝）。容器策略：`--pull=never`（镜像必须已存在，禁止拉取）、`--read-only`、`--network=none`、`--cap-drop=ALL`、`no-new-privileges`、用户 65532、内存 256MiB（swap 同值）、最多 32 个进程、1 核、CPU 5 秒（`podman-driver.ts` 的 `POLICY` 与启动参数）。启动后、发送用户源码前先 `verifyIsolation` 核对实际隔离。
- 资源上限（`protocol.ts:PROGRAMMATIC_LIMITS`）：源码 64KiB、单次请求 64KiB、响应 256KiB、累计传输 8MiB、单帧 1MiB、最多 100 次调用、墙钟默认 120s 上限 600s、启动 15s、结果 64KiB、日志最多 20 条每条 8KiB、摘要 2000 字符。
- 并发：全局默认 2、每用户 1、每团队 1，配置值必须在 1–16；队列 `maxQueued: 0`，超出直接报 `CAPACITY`（`service.ts`）。服务关闭时（`closeProgrammaticServices`，由 `main.ts` 在关停时调用）拒绝新运行。
- 网关（`gateway.ts`）：沙箱里的调用必须带递增序号，每次调用先 `authorize` 再执行，并产生 request/authorized/completed/failed 审计事件，只记录字节数与哈希，不记录参数内容；超预算或违规为致命错误。`mailbox.ts` 是 Worker 与代理之间基于 SharedArrayBuffer 的请求/响应邮箱；`vm-runtime.ts` 是序列化进 VM 的运行时，依赖预先捕获的内建引用（与工具定义同源序列化，不得引入外部依赖）；`wire.ts` 处理 NDJSON 帧与有界 stderr。

## 从哪读起
- `server/lib/agent/programmatic/service.ts:execute`：一次运行的完整流程。
- `protocol.ts`：帧格式与限额。
- `server/lib/agent/tools/eval.ts`
- 测试：`programmatic/__tests__/`（`service*.test.ts`、`gateway.test.ts`、`source-guard.test.ts`、`podman-driver.lifecycle.test.ts`）

## 相关
- [工具体系](tools/index.md)
- [执行后端](execution.md)
