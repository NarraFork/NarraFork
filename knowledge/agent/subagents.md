---
id: agent.subagents
title: 子代理
summary: Task 工具、模板、嵌套两层、委派深度、子代理资源。
anchors:
  - server/lib/agent/tools/team-status.ts
  - server/lib/agent/tools/task.ts
  - server/services/subagent-runner.ts
  - server/services/subagent-resources.ts
  - server/services/subagent-lifecycle.ts
  - server/services/custom-subagent-service.ts
  - server/services/delegation-depth.ts
  - server/services/agent-runtime/policy.ts
  - server/lib/agent/fork-narrator-depth.ts
  - frontend/hooks/useCustomSubagents.ts
  - frontend/hooks/useSubagentOutputCounts.ts
  - server/lib/validators/subagent-models.ts
  - server/routes/custom-subagents.ts
  - server/services/agent-resource-caps.ts
  - server/services/legacy-delegation-materializer.ts
  - server/services/narrator-runtime-registration.ts
  - server/services/nested-subagent-routing.ts
  - server/services/subagent-activity.ts
  - server/services/subagent-alias.ts
  - server/services/subagent-communication-policy.ts
  - server/services/narrator-communication.ts
  - server/routes/narrator-communication.ts
  - server/services/narrator-communication/store.ts
  - server/services/narrator-communication/access.ts
  - server/services/narrator-communication/predicates.ts
  - server/services/narrator-communication/service.ts
  - server/services/narrator-communication/reader.ts
  - server/services/narrator-communication/postgres.ts
  - server/services/narrator-communication/initialize.ts
  - server/services/narrator-communication/index.ts
  - shared/narrator-communication.ts
  - server/services/subagent-execution-boundary.ts
  - server/services/subagent-executor.ts
  - server/services/subagent-extract.ts
  - server/services/subagent-file-changes.ts
  - server/services/subagent-knowledge-injection.ts
  - server/services/subagent-label.ts
  - server/services/subagent-model-switch.ts
  - server/services/subagent-model.ts
  - server/services/subagent-nested.ts
  - server/services/subagent-takeover-broadcast.ts
  - server/services/subagent-team.ts
  - server/services/subagent-terminals.ts
  - server/services/subagent-tools.ts
  - shared/subagent-model-policy.ts
  - shared/subagent-nested.ts
  - shared/subagent-output-counts.ts
  - shared/subagent-result-text.ts
  - shared/subagent-tool-summary.ts
  - server/lib/runtime-source.ts
  - shared/model-inheritance.ts
keywords:
  - Agent 工具
  - 子代理
  - subagent_type
  - general
  - worker
  - explore
  - plan
  - review
  - search
  - compileDelegationPolicy
  - DELEGATED_DENY
  - MAX_DELEGATION_DEPTH
  - SUBAGENT.md
  - custom subagent
  - /api/custom-subagents
  - policy_source_narrator_id
  - runtime registration
  - __parent__
  - subagent_status_changed
  - subagent_nested_changed
  - FORK_NARRATOR_MAX_DEPTH
status: draft
verified_at: cbf0722e0
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
- `workdir` 是团队里一个 queued 工作项的 worktree 时，子代理成为它的工作者；这一项还有未合并的依赖就在创建子代理前拒绝（`Agent error (TEAM_WORK_ITEM_BLOCKED)`，什么都不建），见[工作项](../collaboration/teams/work-items.md)。
- 普通 Send 的可达性单独由通讯森林和精确 peer 决定：同一通讯根下的主代理、子代理和二级助手可互发；不同组只有两个精确端点的 peer 可达，不沿 peer 传递。每次重连分配新关系 ID，断连按此身份且以任一实际可管理端点发起，不另维护固定代际。名单和投影有展示上限，精确 ID 的授权不依赖截断名单；名称、别名和 ID 前缀在同一授权通讯查询中先匹配再限量，不从截断展示目录或旧任务别名旁路解析。ContextAsk、Watch、Stop、TeamStatus 的原控制/读取范围不因此扩大。
- “移出通讯组”仅清所选节点的通讯父边，后代仍随该节点组成一组；恢复只接回持久保存的原通讯父边。controller、policy source、ACL root、工作项和自动结果回传保持不变。普通 Send(parent)、TeamStatus.send/broadcast 与 work.sync 都受普通消息最终准入 gate 约束，注册的任务结果通知不借此重建 peer。
- 子代理出生同事务写通讯节点；普通 fork 创建独立通讯根。旧数据初始化只补缺失节点，显式 NULL 不再推导为继承；坏链/环/超深拒绝域授权。发送时重新读取源会话持久执行身份和当前权限，不能借消息作者覆盖接收会话身份。
- `isolation: "worktree"` 建的工作项分支名取标题的 ASCII 单词；标题里没有（中文标题）时改用 `description` 的英文单词作 `branchHint`（`task.ts`），规则见[工作项](../collaboration/teams/work-items.md)。

## 从哪读起
- `server/lib/agent/tools/task.ts`：工具入口与参数。
- `server/services/subagent-runner.ts`：从模板创建叙述者、登记与调用方的关系，并交给统一的 run 服务启动（执行本身在 `agent-runtime/run.ts`）。
- `server/services/agent-runtime/policy.ts`：模板与能力上限。
- 测试：`server/services/__tests__/subagent-*.test.ts`、`tools/__tests__/agent-team-worktree.test.ts`
- 模型来源与池：`subagent-model.ts` 与 `server/lib/runtime-source.ts` 决定子代理的模型和能力来自谁（显式存储的 `policy_source_narrator_id` 列与运行时登记，不靠父子关系推断），「跟随父级模型」用 `__parent__` 标记（`shared/model-inheritance.ts`），模型池与固定推理档位的形状在 `shared/subagent-model-policy.ts`、校验在 `lib/validators/subagent-models.ts`，运行中改模型走 `subagent-model-switch.ts`。登记的读写在 `narrator-runtime-registration.ts`（内部服务，没有路由，模型输入碰不到），旧委派在启动后补登记（`legacy-delegation-materializer.ts`）。
- 资源上限（`agent-resource-caps.ts`）：每个子代理最多 3 个运行中终端、2 个浏览器会话，一棵团队树最多 6 个，进程内由代理启动的浏览器会话最多 20 个。
- 嵌套层的展示与路由：第一层子代理卡片最多列 5 个下级（`shared/subagent-nested.ts`，`subagent-nested.ts`），嵌套子代理的事件还要送到 ACL 根的页面（`nested-subagent-routing.ts`）。
- 结果与活动的投影：卡片结论文本（上限 120000 字符）取自 `shared/subagent-result-text.ts`，最近调用行的输入摘要取自 `shared/subagent-tool-summary.ts`，活动汇总在 `subagent-activity.ts`，别名与对人/模型的标签在 `subagent-alias.ts`、`subagent-label.ts`。别名占用及原团队控制/观察选择使用这个父会话里仍可寻址的成员（`idle` / `working` / `waiting`，`addressableTeamMembersWhere`）；普通 Send 仍按上述通讯域和执行权限解析，已授权的归档精确 ID 只产生逐收件人失败，不形成投递。已归档且不在该集合里的别名不再被选中，也不占名，没有时间截止。候选名（基名、`基名-2`…）用 `narrators.title_slug`、`alias_selector` 和进行中的任务行做索引等值查询，按不同的值去重，重复标题填不满条数上限，不扫描历史，也不再因兄弟行数抛错。归档和取消归档只在调用者自己的子代理里解析：归档点可寻址成员，不跟旧的后台任务别名；取消归档只点已归档候选。精确 id 优先，同名多于一个就报错。选择器查询先按归档或可寻址状态过滤，再取有限行，所以活着的同名成员不会把已归档的挤出窗口。取消归档后 `reconcileRestoredSubagentAlias` 只给真正的团队成员重新登记（主会话分叉虽有 parent，也不写子代理别名）：活着的占用者留原名，恢复的那个拿空闲后缀，同一笔写入改掉它拥有的 agent 任务别名。TeamStatus `get_task` 的精确任务 id 仍指向那一行。别名在这个占用者有任务时丢掉其他已归档的 agent 任务，再按创建时间取最新一行，所以较新的 Bash 或传输盖过恢复的 agent，较新的归档 agent 不能盖过它。投递里恰有一个成员的持久别名或完整 id 等于选择器时，它压过别人的标题 slug。显式 `@handle` 可明确选择 handle；裸 handle 与标题、标题 slug 和 ID 前缀同级；若它与另一会话的活动或持久别名相撞，也须拒绝，不能让排名把该冲突挤出限量结果。无 handle 冲突时保留别名对标题的优先级，同一 ID 同时匹配多个属性不算跨会话歧义。跨会话歧义必须要求精确 ID，不能任意选首行。导入子代理和提取主会话同事务保存实际标题的 `title_slug`，无需启动回填即可按 slug 解析。Send 的自动放行用同一次解析，审批对象和送达对象是同一个。ContextAsk 和 TeamStatus 的 file_changes 用历史查找：精确 id 能点到已归档成员，名字被复用时不猜；file_changes 只在汇报团队里查。团队外的精确 id 与不存在的会话同一句回复，不带标题。孙代理的别名留在它自己的父上。`registerTaskAlias` 把标题当别名来源并 slug 化；`restoreTaskAlias` 按原样恢复已持久化的别名，只在本进程内别的 id 已占用时才加后缀，Watch 重启挂接用它。`title_slug` 由写入和 `alias-selector-backfill.ts` 保持与 JS 的 `slugifyTaskAlias` 一致；实时输出字数在 `shared/subagent-output-counts.ts` 与前端 `useSubagentOutputCounts.ts`；`shared/agent-reference.ts` 是消息里 `#nf-agent=` 链接的封闭 URL 形状与排版常量。
- 执行段与文件改动：子代理一次逻辑运行的执行段回执在 `subagent-execution-boundary.ts`，文件改动的有界元数据投影在 `subagent-file-changes.ts`（只有当前执行段内已落定的 v2 结果算精确行，旧 `file_attributions` 只是累计搅动量），团队级改动追踪在 `subagent-team.ts`，终端在 `subagent-terminals.ts`（列表上限 100）。
- 其他：`subagent-extract.ts` 把子代理会话提取为独立的主叙述者（不是已移除的克隆，也不是普通 fork）；`subagent-knowledge-injection.ts` 对子代理收到的文本做被动知识注入；`subagent-takeover-broadcast.ts` 向父消息层广播接管/释放；`subagent-tools.ts` 按运行时策略过滤工具与 MCP 工具；`subagent-executor.ts` 只剩重试恢复的展示广播；自定义子代理的 REST 在 `routes/custom-subagents.ts`（`/api/custom-subagents`，列表/读取/创建/更新/删除），前端 `useCustomSubagents.ts`。

## 改它时
- 加一种模板：在 `agent-runtime/policy.ts:compileDelegationPolicy` 里定义能力上限，默认被拒的能力集合是 `DELEGATED_DENY`；改深度要同时看 `MAX_DELEGATION_DEPTH`、创建时的深度戳与 `delegation-depth.ts` 的兜底校验，三者必须一致，且不能信任戳。
- 加一个新的子代理资源（终端、浏览器之外）：回收放进 `subagent-resources.ts`（归档/删除与一次运行结束两个时点），上限放 `agent-resource-caps.ts`；回收函数必须尽力而为不抛错。
- 子代理的文件改动与回退有守卫测试：`subagent-file-changes-outlets.guard.test.ts`、`subagent-revert-coverage.guard.test.ts`，新增写文件出口要登记，否则会失败。
- 改 Agent 工具参数要同步 `tools/task.ts`、自定义子代理校验与前端；嵌套相关看 `subagent-nesting.integration.test.ts`；模型跟随看 `subagent-model-follow-parent.test.ts`、`subagent-pool-reasoning-effort.test.ts`。

## 相关
- [工具体系](tools/index.md)
- [Agent Loop](loop.md)
