/**
 * Unified backend i18n module.
 *
 * Provides a single source of truth for all server-side localised strings.
 * Messages are organised by namespace (e.g. "tool.*", "merge.*", "gateway.*").
 */

import { eq } from "drizzle-orm";
import { db } from "../db";
import { userPreferences } from "../db/schema";

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type Locale = "en" | "zh-CN";

type Messages = Record<string, Record<Locale, string>>;

// ---------------------------------------------------------------------------
// Message registry
// ---------------------------------------------------------------------------

const messages: Messages = {
	// --- tool.* (migrated from prompt-i18n.ts toolMessages) ---
	"tool.interruptedByUser": {
		en: "The user interrupted this tool call before it could execute.",
		"zh-CN": "用户在此工具调用执行前中断了会话。",
	},
	"tool.interruptedByServerRestart": {
		en: "Tool execution was interrupted by a server restart.",
		"zh-CN": "工具执行因服务器重启而中断。",
	},
	"tool.systemPromptAck": {
		en: "I will follow these instructions.",
		"zh-CN": "我会遵循这些指示。",
	},
	"tool.titleAck": {
		en: "Understood. I will generate only a short title. Send me the content.",
		"zh-CN": "明白。我只会生成一个简短的标题。请发送内容。",
	},
	"tool.titleReminder": {
		en: "Reply with ONLY a short title (max 50 chars), nothing else.",
		"zh-CN": "只回复一个简短的标题（最多50个字符），不要回复其他任何内容。",
	},
	"tool.compactTodoSkip": {
		en: "Note: TODOs are tracked separately. Do NOT include any TODO or task list information in the summary.",
		"zh-CN": "注意：待办事项已通过独立机制管理，摘要中不要包含任何 TODO 或待办事项信息。",
	},
	"tool.enterPlanModeOutput": {
		en: "Entered plan mode. Analyze and plan before making changes.",
		"zh-CN": "已进入计划模式。请先分析和规划，再进行修改。",
	},
	"tool.exitPlanModeOutput": {
		en: "Plan approved.",
		"zh-CN": "计划已批准。",
	},
	"tool.exitPlanModeApproved": {
		en: "The user approved your plan. You may now begin execution.",
		"zh-CN": "用户批准了你的计划，可以开始执行。",
	},
	"tool.exitPlanModeApprovedWithDiff": {
		en: "The user edited your plan before approving it. The following changes were made:\n\n{diff}\n\nPlease follow the edited plan.",
		"zh-CN": "用户在批准前编辑了你的计划。以下是修改内容：\n\n{diff}\n\n请按照编辑后的计划执行。",
	},
	"tool.planCompactContinue": {
		en: "The user approved your plan and the context has been reset. Your plan is now in the system prompt under Conversation Context. Please begin executing the plan.",
		"zh-CN":
			"用户批准了你的计划，上下文已重置。你的计划现在位于系统提示的 Conversation Context 部分。请开始执行计划。",
	},
	"tool.permissionDeniedByUser": {
		en: "The user rejected this tool call.",
		"zh-CN": "用户拒绝了此工具调用。",
	},
	"tool.permissionDeniedWithMessage": {
		en: "The user rejected this tool call with the following message: {message}",
		"zh-CN": "用户拒绝了此工具调用，并附带以下消息：{message}",
	},
	"tool.permissionDeniedNonInteractive": {
		en: "Non-interactive session: all risky operations are denied",
		"zh-CN": "非交互式会话：所有高风险操作已被拒绝",
	},
	"tool.permissionDeniedReadOnly": {
		en: "Read-only mode: only read operations are allowed. Write, edit, and other mutating tools are denied.",
		"zh-CN": "只读模式：仅允许读取操作。写入、编辑及其他修改类工具已被拒绝。",
	},
	"tool.permissionDeniedPathOutsideScope": {
		en: "DENIED: The target path is outside the allowed working directory. Read and shell operations are restricted to the project worktree.",
		"zh-CN": "已拒绝：目标路径超出允许的工作目录范围。读取和 Shell 操作仅限于项目工作树内。",
	},
	"tool.permissionDeniedPlanMode": {
		en: "[PLAN MODE] This operation is denied in plan mode. You are in plan mode — writing and editing files (except the plan file) is not allowed. Focus on reading and analyzing code to form your plan, then call ExitPlanMode to submit it.",
		"zh-CN":
			"[计划模式] 此操作在计划模式下被拒绝。你当前处于计划模式——不允许写入或编辑文件（计划文件除外）。请专注于阅读和分析代码以形成你的计划，然后调用 ExitPlanMode 提交计划。",
	},
	"tool.exitPlanModeDenied": {
		en: "[PLAN MODE] The user rejected your plan. You are STILL in plan mode. Review the user's feedback (if any), revise your plan accordingly, and call ExitPlanMode again with the updated plan. Do NOT attempt to write code or make changes — you must exit plan mode first.",
		"zh-CN":
			"[计划模式] 用户拒绝了你的计划。你仍然处于计划模式中。请查看用户的反馈（如有），相应地修改你的计划，然后再次调用 ExitPlanMode 提交更新后的计划。不要尝试写代码或做任何修改——你必须先退出计划模式。",
	},
	"tool.exitPlanModeDeniedWithMessage": {
		en: "[PLAN MODE] The user rejected your plan with the following feedback: {message}\n\nYou are STILL in plan mode. Revise your plan based on this feedback and call ExitPlanMode again. Do NOT attempt to write code or make changes — you must exit plan mode first.",
		"zh-CN":
			"[计划模式] 用户拒绝了你的计划，并附带以下反馈：{message}\n\n你仍然处于计划模式中。请根据此反馈修改你的计划，然后再次调用 ExitPlanMode 提交。不要尝试写代码或做任何修改——你必须先退出计划模式。",
	},
	"tool.exitPlanModeEmptyPlan": {
		en: "Error: The plan content is empty. Either provide a non-empty plan in the 'plan' parameter, or write your plan to the designated plan file ({planFile}) first — the system will read it automatically when you call ExitPlanMode without the 'plan' parameter.",
		"zh-CN":
			"错误：计划内容为空。请在 'plan' 参数中提供非空的计划内容，或先将计划写入指定的计划文件（{planFile}）— 当你不传 'plan' 参数调用 ExitPlanMode 时，系统会自动读取该文件。",
	},
	"tool.exitPlanModeEmptyPlanFallback": {
		en: "Error: The plan content is empty. Provide a non-empty plan in the 'plan' parameter or write it to the designated plan file first.",
		"zh-CN":
			"错误：计划内容为空。请在 'plan' 参数中提供非空的计划内容，或先将计划写入指定的计划文件。",
	},
	"tool.planModeSoftDenyAskReason": {
		en: "[Plan Mode] This operation is blocked by plan mode restrictions. Allow to enable relaxed plan mode (tools remain available during planning).",
		"zh-CN":
			"[计划模式] 此操作被计划模式限制阻止。允许将开启宽松规划模式（规划期间工具保持可用）。",
	},
	"tool.planModeToolDisabled": {
		en: "[PLAN MODE] This tool is disabled during plan mode. Focus on reading and analyzing code, then call ExitPlanMode with your plan.",
		"zh-CN":
			"[计划模式] 此工具在计划模式下已禁用。请专注于阅读和分析代码，然后调用 ExitPlanMode 提交你的计划。",
	},
	"tool.planModeFileRedirected": {
		en: '[Plan Mode] Note: Your write target was redirected from "{originalPath}" to the designated plan file "{planFile}". In plan mode, please use the exact plan file path directly.',
		"zh-CN":
			'[计划模式] 注意：你的写入目标已从 "{originalPath}" 重定向到指定的计划文件 "{planFile}"。在计划模式下，请直接使用正确的计划文件路径。',
	},
	"tool.todoWriteOutput": {
		en: "Updated todos: {total} total ({completed} completed, {inProgress} in progress, {pending} pending)",
		"zh-CN":
			"已更新待办事项：共 {total} 项（{completed} 已完成，{inProgress} 进行中，{pending} 待处理）",
	},
	"tool.suggestAnswerSystem": {
		en: "You are a senior software engineering advisor. The user is being asked one or more questions by an AI coding assistant during a conversation. You will receive the full conversation context in <conversation> tags and the questions in <questions> tags. For each question, suggest the best-practice answer considering the specific project context and conversation history. If options are provided, pick from them; otherwise give a concise free-text answer. Reply with ONLY a valid JSON object mapping each question key to your recommended answer string. No explanation, no markdown fences.",
		"zh-CN":
			"你是一位资深软件工程顾问。用户正在一次对话中被 AI 编程助手提问。你会收到 <conversation> 标签中的完整对话上下文和 <questions> 标签中的问题。对于每个问题，请结合具体的项目上下文和对话历史，建议最佳实践答案。如果提供了选项，从中选择；否则给出简洁的自由文本答案。只回复一个有效的 JSON 对象，将每个问题的 key 映射到你推荐的答案字符串。不要解释，不要 markdown 代码块。",
	},
	"tool.turnNudge": {
		en: "\n\n[SYSTEM: You have used {turnIndex} of {maxTurns} turns. Please wrap up your work soon — summarize remaining steps if you cannot finish in time.]",
		"zh-CN":
			"\n\n[系统提示：你已使用 {turnIndex}/{maxTurns} 轮。请尽快收尾——如果无法及时完成，请总结剩余步骤。]",
	},
	"tool.brokenToolCallReminder": {
		en: `[SYSTEM: Your previous {toolNames} call(s) were broken — the output was cut off by the token limit before the tool input was complete, so they were not executed. The broken call has been removed from history to save context.

STRICT RULES — you MUST follow these exactly to avoid repeated truncation:
1. Each tool call's TOTAL input must be under 10,000 characters (including file_path, old_string, new_string, content — everything).
2. SKELETON-FIRST approach for new files: Use Write to create the file with a SKELETON — include the real opening code, then place numbered splice markers where large sections will go, then the real closing code. The skeleton itself must be under 10,000 chars. Use the file type's comment syntax for markers (e.g. // SPLICE_1 for JS/TS, {# SPLICE_1 #} for Jinja, <!-- SPLICE_1 --> for HTML). Number markers sequentially: SPLICE_1, SPLICE_2, SPLICE_3, etc.
3. FILL via Edit: For each marker, call Edit with old_string="// SPLICE_1" (just the marker, nothing more) and new_string=<the real content for that section>. If a section is still too large, replace the marker with partial content + a new sub-marker (e.g. SPLICE_1a, SPLICE_1b).
4. NEVER write/edit more than 10,000 characters in a single tool call. NEVER use Write to overwrite a file that already exists with content.
5. For large replacements in existing files: split into multiple small Edit calls with different unique short anchors as old_string.]`,
		"zh-CN": `[系统提示：你上一次的 {toolNames} 调用已损坏——输出在工具输入完成前被 token 限制截断，因此未被执行。损坏的调用已从历史中移除以节省上下文。

严格规则——你必须严格遵守以下规则，避免重复截断：
1. 每次工具调用的总输入必须小于 10,000 字符（包括 file_path、old_string、new_string、content 等所有字段）。
2. 骨架优先策略（新文件）：用 Write 创建文件骨架——包含真实的开头代码，然后在需要大段内容的位置放置编号的拼接标记，最后是真实的结尾代码。骨架本身必须小于 10,000 字符。根据文件类型使用对应注释语法（如 JS/TS 用 // SPLICE_1，Jinja 用 {# SPLICE_1 #}，HTML 用 <!-- SPLICE_1 -->）。标记按顺序编号：SPLICE_1、SPLICE_2、SPLICE_3 等。
3. 用 Edit 填充：对每个标记，调用 Edit，old_string="// SPLICE_1"（只写标记本身，不要多写），new_string=<该段的真实内容>。如果某段仍然过大，将标记替换为部分内容 + 新的子标记（如 SPLICE_1a、SPLICE_1b）。
4. 绝对不要在单次调用中写入/编辑超过 10,000 字符。绝对不要用 Write 覆盖已有内容的文件。
5. 大范围替换已有文件：拆分为多个小 Edit，用不同的唯一短锚点作为 old_string。]`,
	},
	"tool.brokenToolCallInputPlaceholder": {
		en: "[Content too large for single output — output was truncated]",
		"zh-CN": "[过长的单次输出，输出被截断]",
	},
	"tool.brokenToolCallResult": {
		en: "Tool input was truncated by token limit — not executed. Each call must be under 10,000 chars. Use skeleton-first approach: Write a skeleton with SPLICE markers, then Edit to fill each marker.",
		"zh-CN":
			"工具输入被 token 限制截断，未执行。每次调用总输入须小于 10,000 字符，请使用骨架优先策略：先 Write 骨架（含 SPLICE 标记），再用 Edit 逐个填充。",
	},
	"tool.interruptionContinue": {
		en: "Your previous response appears to have been cut off. Please continue from where you left off.",
		"zh-CN": "你上一条回复似乎被截断了，请从中断处继续。",
	},
	"tool.userContinue": {
		en: "Continue.",
		"zh-CN": "继续。",
	},
	"tool.toolLoaded": {
		en: '[The optional tool "{toolName}" has just been loaded into this session. {toolDescription}. You can now use this tool when appropriate.]',
		"zh-CN":
			'[可选工具 "{toolName}" 刚刚被加载到本次会话中。{toolDescription}。你现在可以在合适的时候使用这个工具。]',
	},
	"tool.overseerPermissionRequestText": {
		en: "A Narrator under your jurisdiction needs a permission decision.\n\nRequest ID: {requestId}\nNarrator: {narratorTitle} (id: {narratorId})\nTool: {toolName}\nTool Use ID: {toolUseId}\nInput:\n```json\n{inputSummary}\n```\n\nPlease review this request and use ApprovePermission or DenyPermission to make your decision.",
		"zh-CN":
			"你管辖范围内的一个叙述者需要权限决策。\n\nRequest ID: {requestId}\n叙述者: {narratorTitle} (id: {narratorId})\n工具: {toolName}\nTool Use ID: {toolUseId}\n输入:\n```json\n{inputSummary}\n```\n\n请审查此请求，并使用 ApprovePermission 或 DenyPermission 做出决定。",
	},
	"tool.overseerNotAnOverseer": {
		en: "Error: This narrator is not an overseer.",
		"zh-CN": "错误：此叙述者不是监察者。",
	},
	"tool.overseerPermissionApproved": {
		en: "Permission request {requestId} approved.{feedback}",
		"zh-CN": "权限请求 {requestId} 已批准。{feedback}",
	},
	"tool.overseerPermissionDenied": {
		en: "Permission request {requestId} denied.{reason}",
		"zh-CN": "权限请求 {requestId} 已拒绝。{reason}",
	},
	"tool.overseerPermissionAlreadyResolved": {
		en: "Permission request {requestId} was already resolved (likely by the user).",
		"zh-CN": "权限请求 {requestId} 已被解决（可能由用户处理）。",
	},
	"tool.overseerDefaultDenyMessage": {
		en: "Denied by Overseer",
		"zh-CN": "被监察者拒绝",
	},
	"tool.overseerNoManagedNarrators": {
		en: "No narrators currently under your jurisdiction.",
		"zh-CN": "当前你的管辖范围内没有叙述者。",
	},
	"tool.overseerManagedNarratorsHeader": {
		en: "Managed narrators ({count}):",
		"zh-CN": "被管理的叙述者（{count}）：",
	},
	"tool.overseerNoMessages": {
		en: "No messages found for this narrator.",
		"zh-CN": "未找到该叙述者的消息。",
	},
	"tool.overseerRecentMessagesHeader": {
		en: "Recent messages from narrator {narratorId} ({count}):",
		"zh-CN": "叙述者 {narratorId} 的近期消息（{count}）：",
	},
	"tool.forkNarratorSuccess": {
		en: "New narrator forked successfully.\n\nNarrator ID: {narratorId}\nTitle: {title}\n{chapterInfo}\nThe new narrator is now running independently with your message.",
		"zh-CN":
			"叙述者分叉成功。\n\n叙述者 ID：{narratorId}\n标题：{title}\n{chapterInfo}\n新叙述者正在独立运行你的消息。",
	},
	"tool.forkNarratorChapterInfo": {
		en: "Chapter ID: {chapterId}\nChapter: {chapterTitle}\n",
		"zh-CN": "章节 ID：{chapterId}\n章节：{chapterTitle}\n",
	},
	"tool.forkNarratorError": {
		en: "Failed to fork narrator: {error}",
		"zh-CN": "分叉叙述者失败：{error}",
	},
	// --- merge.* (migrated from prompt-i18n.ts mergeSummaryLabels) ---
	"merge.branch": { en: "Branch", "zh-CN": "分支" },
	"merge.mergedInto": { en: "Merged into", "zh-CN": "合并到" },
	"merge.strategy": { en: "Strategy", "zh-CN": "策略" },
	"merge.mergeCommit": { en: "Merge commit", "zh-CN": "合并提交" },
	"merge.mergedBy": { en: "Merged by", "zh-CN": "合并者" },
	"merge.chapterTitle": { en: "Chapter title", "zh-CN": "章节标题" },
	"merge.description": { en: "Description", "zh-CN": "描述" },
	"merge.commits": { en: "Commits", "zh-CN": "提交记录" },
	"merge.diffSummary": { en: "Diff summary", "zh-CN": "变更统计" },
	"merge.headerMerged": { en: "Branch Merged", "zh-CN": "分支已合并" },
	// --- gateway.* (IM gateway command responses) ---
	"gateway.rateLimited": {
		en: "⏳ Rate limited. Please wait a moment.",
		"zh-CN": "⏳ 请求过于频繁，请稍候。",
	},
	"gateway.sessionReset": {
		en: "🔄 Session reset. Send a message to start a new conversation.",
		"zh-CN": "🔄 会话已重置。发送消息开始新对话。",
	},
	"gateway.sessionExpired": {
		en: "🔄 Session expired due to inactivity. Starting fresh.",
		"zh-CN": "🔄 会话因长时间无活动已过期，将开始新对话。",
	},
	"gateway.noActiveSession": {
		en: "No active session. Send a message to start one.",
		"zh-CN": "没有活跃的会话。发送消息以开始。",
	},
	"gateway.noActiveSessionShort": {
		en: "No active session.",
		"zh-CN": "没有活跃的会话。",
	},
	"gateway.currentModel": {
		en: "🤖 Current model: {model}",
		"zh-CN": "🤖 当前模型：{model}",
	},
	"gateway.modelSwitched": {
		en: "🤖 Model switched to: {model}",
		"zh-CN": "🤖 模型已切换为：{model}",
	},
	"gateway.sessionStatusHeader": {
		en: "📊 Session Status",
		"zh-CN": "📊 会话状态",
	},
	"gateway.statusNarrator": {
		en: "Narrator: {id}",
		"zh-CN": "叙述者：{id}",
	},
	"gateway.statusStatus": {
		en: "Status: {status}",
		"zh-CN": "状态：{status}",
	},
	"gateway.statusModel": {
		en: "Model: {model}",
		"zh-CN": "模型：{model}",
	},
	"gateway.statusMessages": {
		en: "Messages: {count}",
		"zh-CN": "消息数：{count}",
	},
	"gateway.statusCost": {
		en: "Cost: {costDisplay}",
		"zh-CN": "费用：{costDisplay}",
	},
	"gateway.agentStopped": {
		en: "⏹ Agent stopped.",
		"zh-CN": "⏹ 代理已停止。",
	},
	"gateway.error": {
		en: "❌ Error: {error}",
		"zh-CN": "❌ 错误：{error}",
	},
	"gateway.noUserLinked": {
		en: "No NarraFork user linked. Cannot list tabs.",
		"zh-CN": "未关联 NarraFork 用户，无法列出标签页。",
	},
	"gateway.recentTabs": {
		en: "📋 Recent tabs:",
		"zh-CN": "📋 最近的标签页：",
	},
	"gateway.noRecentTabs": {
		en: "No recent tabs found.",
		"zh-CN": "没有找到最近的标签页。",
	},
	"gateway.useSwitchHint": {
		en: "Use /switch <id> to switch.",
		"zh-CN": "使用 /switch <id> 切换。",
	},
	"gateway.searchResults": {
		en: '🔍 Search results for "{query}":',
		"zh-CN": '🔍 "{query}" 的搜索结果：',
	},
	"gateway.searchNoResults": {
		en: 'No narrators found for "{query}".',
		"zh-CN": '未找到与 "{query}" 匹配的叙述者。',
	},
	"gateway.searchUsage": {
		en: "Usage: /search <query>",
		"zh-CN": "用法：/search <关键词>",
	},
	"gateway.switchUsage": {
		en: "Usage: /switch <narrator-id>\nUse /list or /search to find IDs.",
		"zh-CN": "用法：/switch <叙述者ID>\n使用 /list 或 /search 查找 ID。",
	},
	"gateway.switchedTo": {
		en: "🔗 Switched to: {title}\nID: {id} | Status: {status} | Model: {model}",
		"zh-CN": "🔗 已切换到：{title}\nID：{id} | 状态：{status} | 模型：{model}",
	},
	"gateway.narratorNotFound": {
		en: "❌ Narrator not found: {id}\nUse /list or /search to find valid IDs.",
		"zh-CN": "❌ 未找到叙述者：{id}\n使用 /list 或 /search 查找有效 ID。",
	},
	"gateway.narratorWrongProject": {
		en: "❌ Narrator belongs to a different project.\nUse /list or /search to find narrators in the current project.",
		"zh-CN": "❌ 该叙述者属于其他项目。\n使用 /list 或 /search 查找当前项目的叙述者。",
	},
	"gateway.helpHeader": {
		en: "📖 Available commands:",
		"zh-CN": "📖 可用命令：",
	},
	"gateway.helpNew": {
		en: "/new — Start a fresh conversation",
		"zh-CN": "/new — 开始新对话",
	},
	"gateway.helpStop": {
		en: "/stop — Interrupt the running agent",
		"zh-CN": "/stop — 中断正在运行的代理",
	},
	"gateway.helpModel": {
		en: "/model — Show current model",
		"zh-CN": "/model — 查看当前模型",
	},
	"gateway.helpModelSwitch": {
		en: "/model <name> — Switch to a different model",
		"zh-CN": "/model <名称> — 切换模型",
	},
	"gateway.helpList": {
		en: "/list — List recent narrators",
		"zh-CN": "/list — 列出最近的叙述者",
	},
	"gateway.helpSearch": {
		en: "/search <query> — Search narrators by title",
		"zh-CN": "/search <关键词> — 按标题搜索叙述者",
	},
	"gateway.helpSwitch": {
		en: "/switch <id> — Switch to an existing narrator",
		"zh-CN": "/switch <id> — 切换到已有叙述者",
	},
	"gateway.helpStatus": {
		en: "/status — Show session info",
		"zh-CN": "/status — 查看会话信息",
	},
	"gateway.helpHelp": {
		en: "/help — Show this message",
		"zh-CN": "/help — 显示此帮助",
	},
	"gateway.currentSuffix": {
		en: " ← current",
		"zh-CN": " ← 当前",
	},
	// --- gateway tool call & permission ---
	"gateway.toolStarted": {
		en: "🔧 {toolName}: {summary}",
		"zh-CN": "🔧 {toolName}：{summary}",
	},
	"gateway.toolCompleted": {
		en: "✅ {toolName} ({duration})",
		"zh-CN": "✅ {toolName}（{duration}）",
	},
	"gateway.toolFailed": {
		en: "❌ {toolName} failed: {error}",
		"zh-CN": "❌ {toolName} 失败：{error}",
	},
	"gateway.permissionRequest": {
		en: "⚠️ Permission required\nTool: {toolName}\n{summary}\n\nReply /approve or /deny [reason]",
		"zh-CN": "⚠️ 需要权限批准\n工具：{toolName}\n{summary}\n\n回复 /approve 或 /deny [理由]",
	},
	"gateway.permissionApproved": {
		en: "✅ Permission approved.",
		"zh-CN": "✅ 权限已批准。",
	},
	"gateway.permissionDenied": {
		en: "🚫 Permission denied.",
		"zh-CN": "🚫 权限已拒绝。",
	},
	"gateway.noPermissionPending": {
		en: "No pending permission request.",
		"zh-CN": "没有待处理的权限请求。",
	},
	"gateway.helpApprove": {
		en: "/approve — Approve pending permission request",
		"zh-CN": "/approve — 批准待处理的权限请求",
	},
	"gateway.helpDeny": {
		en: "/deny [reason] — Deny pending permission request",
		"zh-CN": "/deny [理由] — 拒绝待处理的权限请求",
	},
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Translate a message key with optional parameter interpolation.
 * Falls back to English when the requested locale is missing.
 */
export function t(
	key: string,
	locale: Locale = "en",
	params?: Record<string, string | number>,
): string {
	const entry = messages[key];
	if (!entry) return key; // unknown key → return as-is
	let msg = entry[locale] ?? entry.en;
	if (params) {
		for (const [k, v] of Object.entries(params)) {
			msg = msg.replaceAll(`{${k}}`, String(v));
		}
	}
	return msg;
}

// ---------------------------------------------------------------------------
// User language helpers (migrated from prompt-i18n.ts)
// ---------------------------------------------------------------------------

/**
 * Get the language preference for a user from the database.
 * Returns "en" as default if no preference is set.
 */
export async function getUserLanguage(userId: string): Promise<Locale> {
	const pref = await db.query.userPreferences.findFirst({
		where: eq(userPreferences.userId, userId),
		columns: { language: true },
	});
	return (pref?.language as Locale) ?? "en";
}

/**
 * Get the replyInUserLanguage preference for a user.
 */
export async function getUserReplyInLanguage(userId: string): Promise<boolean> {
	const pref = await db.query.userPreferences.findFirst({
		where: eq(userPreferences.userId, userId),
		columns: { replyInUserLanguage: true },
	});
	return pref?.replyInUserLanguage ?? true;
}

// ---------------------------------------------------------------------------
// Backward-compatible typed accessors (for existing callers)
// ---------------------------------------------------------------------------

/** All known tool message keys (matches the old ToolMessageKey type). */
export type ToolMessageKey =
	| "interruptedByUser"
	| "interruptedByServerRestart"
	| "systemPromptAck"
	| "titleAck"
	| "titleReminder"
	| "compactTodoSkip"
	| "enterPlanModeOutput"
	| "exitPlanModeOutput"
	| "exitPlanModeApproved"
	| "exitPlanModeApprovedWithDiff"
	| "planCompactContinue"
	| "permissionDeniedByUser"
	| "permissionDeniedWithMessage"
	| "permissionDeniedNonInteractive"
	| "permissionDeniedReadOnly"
	| "permissionDeniedPathOutsideScope"
	| "permissionDeniedPlanMode"
	| "exitPlanModeDenied"
	| "exitPlanModeDeniedWithMessage"
	| "exitPlanModeEmptyPlan"
	| "exitPlanModeEmptyPlanFallback"
	| "planModeSoftDenyAskReason"
	| "planModeToolDisabled"
	| "planModeFileRedirected"
	| "todoWriteOutput"
	| "suggestAnswerSystem"
	| "turnNudge"
	| "brokenToolCallReminder"
	| "brokenToolCallInputPlaceholder"
	| "brokenToolCallResult"
	| "interruptionContinue"
	| "userContinue"
	| "toolLoaded"
	| "overseerPermissionRequestText"
	| "overseerNotAnOverseer"
	| "overseerPermissionApproved"
	| "overseerPermissionDenied"
	| "overseerPermissionAlreadyResolved"
	| "overseerDefaultDenyMessage"
	| "overseerNoManagedNarrators"
	| "overseerManagedNarratorsHeader"
	| "overseerNoMessages"
	| "overseerRecentMessagesHeader"
	| "forkNarratorSuccess"
	| "forkNarratorChapterInfo"
	| "forkNarratorError";

export function getToolMessage(key: ToolMessageKey, locale: Locale = "en"): string {
	return t(`tool.${key}`, locale);
}

export function getToolMessageWithParams(
	key: ToolMessageKey,
	locale: Locale = "en",
	params: Record<string, string | number> = {},
): string {
	return t(`tool.${key}`, locale, params);
}

export type MergeSummaryLabelKey =
	| "branch"
	| "mergedInto"
	| "strategy"
	| "mergeCommit"
	| "mergedBy"
	| "chapterTitle"
	| "description"
	| "commits"
	| "diffSummary"
	| "headerMerged";

export function getMergeSummaryLabel(key: MergeSummaryLabelKey, locale: Locale = "en"): string {
	return t(`merge.${key}`, locale);
}
