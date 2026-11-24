---
id: agent.subagents
title: 子代理
summary: Task 工具、模板、嵌套两层、委派深度、子代理资源。
anchors:
  - server/lib/agent/tools/task.ts
  - server/services/subagent-runner.ts
  - server/services/subagent-resources.ts
  - server/services/subagent-lifecycle.ts
  - server/services/custom-subagent-service.ts
  - server/services/delegation-depth.ts
  - server/services/agent-runtime/policy.ts
  - server/lib/agent/fork-narrator-depth.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 子代理

主叙述者通过工具把工作委派给子代理：子代理是独立的叙述者记录（`type="subagent"`），经 `parentNarratorId` 挂在父叙述者之下，按模板获得一份能力上限（runtime policy）。启动工具线上名为 `Agent`（导出名 `agentTool`，文件 `tools/task.ts`）。

## 关键规则
- 模板名只在 `agent-runtime/policy.ts:compileDelegationPolicy` 里有含义，结果是写进新叙述者 traits 的能力上限。内置模板：`general`（完整写权限）、`worker`（general 加 Terminal、Browser，并可自己启动并等待下一层 helper）、`explore` 与 `plan`（只读）、`review`（只读 + 同步查看 Git + Browser，不能控制运行中的任务）、`search`（仅 WebSearch/WebFetch 等，无 MCP，只读）；其他名字视为自定义定义，缺失或无效的定义按只读处理（失败即收紧）。
- 被委派者默认不能：再启动代理、等待代理、向用户提问、批准计划、切换工作目录（`DELEGATED_DENY`）。worker 的拒绝列表去掉了启动与等待代理，所以只有 worker 能向下嵌套。
- 嵌套深度：`MAX_DELEGATION_DEPTH = 2`——主叙述者为 0 层，其子代理 1 层，再下一层 helper 为 2 层，2 层的子代理不能启动或控制其他代理。创建时给能力上限打深度戳（`withDelegationDepth`，深度达上限时同时去掉 spawn/await 能力和对应工具）；兜底校验不信任戳，`delegation-depth.ts:delegationDepthOf` 沿 `parent_narrator_id` 向上数 `subagent` 类型的层数，环或过深的链直接报错。
- ForkNarrator 是另一条递归通道：fork 链最多 8 层祖先（`FORK_NARRATOR_MAX_DEPTH`），沿父链遍历有步数上限（`fork-narrator-depth.ts`）。
- 自定义子代理：`~/.narrafork/subagents/<name>/SUBAGENT.md`，frontmatter 加 markdown 正文；字段含描述、`toolAccess`（`readOnly` / `general` / `custom`）、自定义工具列表、默认模型（空串表示继承父级）、提示词（`custom-subagent-service.ts`）。
- Agent 工具参数：`subagent_type`（缺省为 `general`；创建团队工作项时缺省 `worker`）、`model`、`reasoning_effort`、`workdir`、`alias`（会话内唯一，缺省由描述生成）、`run_in_background`、`isolation: "worktree"`（仅团队协调者，为工作项建分支与 worktree）。
- 资源回收（`subagent-resources.ts`）：子代理被归档或删除时，关闭它创建的所有运行中终端和启动的浏览器会话；一次运行结束且没有待处理工作（helper 仍在工作、或已排队的输入）时，关闭此刻打开的浏览器会话，终端保留（dev server、REPL 可跨轮使用）。主叙述者不受影响，所有函数尽力而为、不抛错；单次最多关闭 50 个终端。
- `subagent-lifecycle.ts:interruptAndArchiveSubagent`：先取消运行再标记归档，不抛错，保证删除历史不会因副作用失败。
- 与子代理通信：Send（异步）与 Watch（观察）；运行时策略不含 `watchAgent` 能力时 Watch agent 被拒（`subagent-communication-policy.ts`）。

## 从哪读起
- `server/lib/agent/tools/task.ts`：工具入口与参数。
- `server/services/subagent-runner.ts`：从模板创建叙述者、登记与调用方的关系，并交给统一的 run 服务启动（执行本身在 `agent-runtime/run.ts`）。
- `server/services/agent-runtime/policy.ts`：模板与能力上限。
- 测试：`server/services/__tests__/subagent-*.test.ts`、`tools/__tests__/agent-team-worktree.test.ts`

## 相关
- [工具体系](tools/index.md)
- [Agent Loop](loop.md)
