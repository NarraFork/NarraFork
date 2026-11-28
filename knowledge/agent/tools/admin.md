---
id: agent.tools.admin
title: 管理工具
summary: 让会话管理 NarraFork 自身的工具：各类 *Admin、插件安装，管理员门槛与写入审批，以及引导设置叙述者。
anchors:
  - server/lib/agent/tools/narrafork-admin.ts
  - server/lib/agent/tools/mcp-admin.ts
  - server/lib/agent/tools/hook-admin.ts
  - server/lib/agent/tools/knowledge-admin.ts
  - server/lib/agent/tools/knowledge-actions.ts
  - server/lib/agent/tools/index.ts
  - server/lib/agent/tools/plugin-install.ts
  - server/lib/agent/tools/admin-common.ts
  - server/lib/agent/tools/setup-kind.ts
  - server/services/tool-load-markers.ts
keywords:
  - NarraForkAdmin
  - McpAdmin
  - HookAdmin
  - ScheduledTaskAdmin
  - KnowledgeAdmin
  - PluginInstall
  - ADMIN_ONLY_LOAD_TOOLS
  - isAdminToolExecutionAllowed
  - ***MASKED***
  - permissionRuleAutoApprove
  - setup 叙述者
  - 引导设置
  - restricted to administrators
status: draft
verified_at: 1f5b09796829c69a6a4f145446bbfc07f6cc5f5d
---
# 管理工具

五个可选工具让会话直接改 NarraFork 自己的配置：`NarraForkAdmin`（设置）、`McpAdmin`、`HookAdmin`、`KnowledgeAdmin`（知识库结构与 ACL）、`PluginInstall`。它们改的是特权状态，所以有三道闸。

## 关键规则
- 加载闸：这五个名字在 `tool-load-markers.ts:ADMIN_ONLY_LOAD_TOOLS`，非管理员不能加载（`tool-loading-service.ts`）。
- 执行闸：每次执行前 `tool-executor.ts` 调 `isAdminToolExecutionAllowed` 重查调用用户的当前角色，非管理员（含他人加载后继续用）得「restricted to administrators」。`NarraForkAdmin` 自身不再查角色，靠这道闸；`McpAdmin`、`HookAdmin`、`PluginInstall` 在写动作前还会自查 `admin-common.ts:isAdminUser`（`PluginInstall` 用同样实现的 `plugin-install.ts:defaultIsAdminUser`；都在读 Worker 上查 `users.role`，`worker-required`、30s 超时，读失败即抛错，不回主线程），`KnowledgeAdmin` 查 `knowledgeAcl` 的 `isAdmin`。
- 写入审批：写动作先 `ctx.requestPermission`（`admin-common.ts:requestWritePermission`），被拒或危险反思未决即返回错误；读动作（list/get 等）直接执行。`KnowledgeAdmin` 的写动作还在 `narrator-permission.ts` 被归为危险，bypass 模式下也触发危险反思；读写动作划分的唯一来源是 `knowledge-actions.ts`。
- `NarraForkAdmin`：get_settings / get_setting / update_settings / reset_setting。读到的凭据键（`*secret`、`*apiKey`、`*token`、`*password`、敏感请求头等）与 URL 内嵌凭据一律替换为 `***MASKED***`；写回掩码值表示保留已存值，掩码对应的已存值不存在则报错。更新是深度合并，写 `mcpServers` 数组时按 id 做补丁式合并。
- `NarraForkAdmin` 永远不能改 `agent.permissionRuleAutoApprove`（含整体重置 `agent`）：这个开关只允许管理员在设置页由人改（`isPermissionRuleAutoApproveMutation`）。
- `McpAdmin`：list/add/remove/connect/disconnect/refresh/test；传输为 stdio、streamable-http、sse。env 与 headers 的值从不回显，只列键名；`test` 也要审批；加载模式与 `enabled` 冲突时拒绝。
- `HookAdmin`：list/get/create/update/delete；事件 PreToolUse、PostToolUse、Stop、Attention、AttentionResolved，类型 command（任意 shell）或 http；超时 1 到 600 秒；创建经 `createHookSchema` 校验。输出里 headers 不带值。
- `ScheduledTaskAdmin` 已退役，不再注册、加载或作为执行别名；统一入口为普通会话可用的 `ScheduledTask`（见[流程与协作工具](workflow.md)），按当前用户的任务 ACL 与动作审批。`normalizePersistedToolSelections` 只把旧持久加载意图归一为 `ScheduledTask`，不转换拒绝清单或授权，不让历史工具名绕过当前权限检查。
- `PluginInstall`：list_sources / list_installed / install / install_and_enable。插件系统关闭时直接报错。`path` 必须落在 `~/.narrafork/plugin-imports` 下，拒绝 `.`/`..` 段、NUL 与网络路径，扩展名只能是 `.zip` 或 `.nfplugin`；`url` 只收公开 http(s)：不带内嵌凭据，每一跳都校验主机并解析 DNS 拒绝私有地址，最多跟 3 次重定向，30 秒超时，包体上限 64 MiB。`path` 与 `url` 二选一，安装前要审批。
- 引导设置：创建 `kind: "setup"` 的叙述者时加上 `setup` trait 并预装 `Terminal`（`narrator-service.ts`，常量在 `setup-kind.ts`），因为包管理器常需要 PTY；其系统提示由调用方生成。

## 从哪读起
- `server/lib/agent/tools/admin-common.ts`：管理员判断与写入审批的公共辅助。
- `server/services/tool-load-markers.ts`：管理员工具清单。
- 测试：`lib/agent/tools/__tests__/` 下的 `mcp-admin`、`hook-admin`、`plugin-install`、`narrafork-admin-secrets`
- `server/lib/agent/tools/knowledge-admin.ts`：`KnowledgeAdmin`（分类等级、标签与标签类型、授权、按用户与按条目的 ACL）；读写动作划分只认 `knowledge-actions.ts`，权限层与工具共用。

## 改它时
- 加一个管理工具：名字加进 `services/tool-load-markers.ts:ADMIN_ONLY_LOAD_TOOLS`（加载闸，非管理员不能 `/load`），工具文件里写动作前调用 `admin-common.ts:requestWritePermission`，读写动作划分放叶子模块（如 `knowledge-actions.ts`），再进 `tools/index.ts` 的 `OPTIONAL_TOOLS`；执行闸 `isAdminToolExecutionAllowed` 在 `tool-executor.ts`，按名字清单判断，漏登记就没有这道闸。
- 返回值不得带密钥：读设置要走掩码（`***MASKED***`），MCP/Hook 的 env 与 headers 只列键名；改掩码规则跑 `tools/__tests__/narrafork-admin-secrets.test.ts`。
- `agent.permissionRuleAutoApprove` 不能被 `NarraForkAdmin` 改（含整体重置 `agent`），这条要保持。
- `PluginInstall` 的路径与 URL 限制（`~/.narrafork/plugin-imports`、拒私有地址、64 MiB、3 次重定向）是安全边界，改动要补 `plugin-install.test.ts`。
- 测试：`tools/__tests__/` 下的 `mcp-admin`、`hook-admin`、`plugin-install`、`narrafork-admin-secrets`。

## 相关
- [工具体系](index.md)
- [MCP 集成](../mcp.md)
- [工具调用审批](../../security/tool-permissions/index.md)
