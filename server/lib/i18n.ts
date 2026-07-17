/**
 * Unified backend i18n module.
 *
 * Provides a single source of truth for all server-side localised strings.
 * Messages are organised by namespace (e.g. "tool.*", "merge.*", "gateway.*").
 */

import {
	DEFAULT_LOCALE,
	type Locale,
	type LocalizedValue,
	normalizeLocale,
	pickLocalizedValue,
} from "@shared/i18n-locales";

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type { Locale } from "@shared/i18n-locales";

type Messages = Record<string, LocalizedValue<string>>;

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
		en: "Note: TODO reminder blocks in tool results are transient. Ignore any <todo_reminder> blocks in the message history; use only the latest TODO list below when TODO state is relevant.",
		"zh-CN":
			"注意：工具结果里的 TODO 提醒块是临时信息。请忽略消息历史中的 <todo_reminder> 块；只有在待办状态相关时，才使用下面的最新 TODO 列表。",
	},
	"tool.compactContextOverflowHint": {
		en: "EMERGENCY NOTICE: the context window overflowed and had to be force-compacted. Avoid using the Read tool's read-all mode (limit=-1) or reading very large files/outputs unless strictly necessary — otherwise the context window may fill up again quickly.",
		"zh-CN":
			"紧急提示：上下文窗口已溢出并被强制压缩。请勿在非必要的时候使用 read_all（Read 工具 limit=-1 全量读取模式）或读取超大文件/输出，否则上下文窗口可能会再次快速占满。",
	},
	"tool.compactCurrentTodos": {
		en: `<current_todos>
Latest TODO list from narrator state:
{todos}
</current_todos>`,
		"zh-CN": `<current_todos>
来自叙述者状态的最新 TODO 列表：
{todos}
</current_todos>`,
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
		en: "Start executing the plan now.",
		"zh-CN": "立即开始执行计划。",
	},
	"tool.exitPlanModeApprovedWithDiff": {
		en: "The user edited your plan before approving it. The following changes were made:\n\n{diff}\n\nStart executing the edited plan now.",
		"zh-CN":
			"用户在批准前编辑了你的计划。以下是修改内容：\n\n{diff}\n\n立即按照编辑后的计划开始执行。",
	},
	"tool.planCompactContinue": {
		en: "The user approved your plan and the context has been reset. Your plan is now in the system prompt under Conversation Context. Start executing it now.",
		"zh-CN":
			"用户批准了你的计划，上下文已重置。你的计划现在位于系统提示的 Conversation Context 部分。立即开始执行。",
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
	"tool.exitPlanModeDeniedFile": {
		en: "[PLAN MODE] The user rejected your file-based plan. You are STILL in plan mode. Revise the designated plan file, then call ExitPlanMode again without the 'inline_plan' parameter so the system rereads it. If the feedback only requires a small change, prefer using Edit to patch the existing plan file and submit it directly; only rewrite the whole plan file when a full restructure is necessary. Do NOT attempt to write code or make changes — you must exit plan mode first.",
		"zh-CN":
			"[计划模式] 用户拒绝了你通过计划文件提交的计划。你仍然处于计划模式中。请修改指定的计划文件，然后再次调用 ExitPlanMode（不传 'inline_plan' 参数），让系统重新读取该文件。若反馈只需要小幅调整，优先用 Edit 修补原计划文件并直接重新提交；只有在结构必须大改时才整体重写计划文件。不要尝试写代码或做任何修改——你必须先退出计划模式。",
	},
	"tool.exitPlanModeDeniedFileWithMessage": {
		en: "[PLAN MODE] The user rejected your file-based plan with the following feedback: {message}\n\nYou are STILL in plan mode. Revise the designated plan file based on this feedback, then call ExitPlanMode again without the 'inline_plan' parameter so the system rereads it. If the requested change is small, prefer using Edit to patch the existing plan file and submit it directly; only rewrite the whole plan file when a full restructure is necessary. Do NOT attempt to write code or make changes — you must exit plan mode first.",
		"zh-CN":
			"[计划模式] 用户拒绝了你通过计划文件提交的计划，并附带以下反馈：{message}\n\n你仍然处于计划模式中。请根据此反馈修改指定的计划文件，然后再次调用 ExitPlanMode（不传 'inline_plan' 参数），让系统重新读取该文件。若请求的改动较小，优先用 Edit 修补原计划文件并直接重新提交；只有在结构必须大改时才整体重写计划文件。不要尝试写代码或做任何修改——你必须先退出计划模式。",
	},
	"tool.exitPlanModeEmptyPlan": {
		en: "Error: The plan content is empty. Either provide a non-empty plan in the 'inline_plan' parameter, or write your plan to the designated plan file ({planFile}) first — the system will read it automatically when you call ExitPlanMode without the 'inline_plan' parameter.",
		"zh-CN":
			"错误：计划内容为空。请在 'inline_plan' 参数中提供非空的计划内容，或先将计划写入指定的计划文件（{planFile}）— 当你不传 'inline_plan' 参数调用 ExitPlanMode 时，系统会自动读取该文件。",
	},
	"tool.exitPlanModeEmptyPlanFallback": {
		en: "Error: The plan content is empty. Provide a non-empty plan in the 'inline_plan' parameter or write it to the designated plan file first.",
		"zh-CN":
			"错误：计划内容为空。请在 'inline_plan' 参数中提供非空的计划内容，或先将计划写入指定的计划文件。",
	},
	"tool.exitPlanModePathReference": {
		en: "Error: The 'inline_plan' parameter looks like a file path or location reference, not the actual plan. The 'inline_plan' parameter must contain the COMPLETE plan text itself (all steps, file changes, reasoning) — this is what the user reviews. Do NOT pass a path like 'plan_path: ...' or a file reference. Either paste the full plan body into 'inline_plan', or write your plan to the designated plan file ({planFile}) and call ExitPlanMode WITHOUT the 'inline_plan' parameter so the system reads it automatically.",
		"zh-CN":
			"错误：'inline_plan' 参数看起来是一个文件路径或位置引用，而不是真正的计划内容。'inline_plan' 参数必须包含完整的计划正文本身（所有步骤、文件改动、推理）— 这是用户要审阅的内容。不要传入类似 'plan_path: ...' 的路径或文件引用。请将完整的计划正文粘贴到 'inline_plan' 中，或将计划写入指定的计划文件（{planFile}）后不带 'inline_plan' 参数调用 ExitPlanMode，让系统自动读取。",
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
	"tool.subagentConclusionRedirected": {
		en: `⚠️ File path redirected: "{originalPath}" → "{conclusionFile}".

You are an explore/plan subagent in READ-ONLY mode. All Write/Edit operations are restricted to the designated conclusion file.

**Do NOT attempt to modify source code, configuration, or any project files.** Your role is to investigate and report findings, not to implement changes. If the task requires code modifications, describe what needs to change in your conclusion — the caller will implement it.

Always target the conclusion file directly: \`{conclusionFile}\``,
		"zh-CN": `⚠️ 文件路径已重定向："{originalPath}" → "{conclusionFile}"。

你是 explore/plan 子代理，处于只读模式。所有 Write/Edit 操作被限制为只能写入指定的结论文件。

**不要尝试修改源代码、配置或任何项目文件。** 你的职责是调查并报告发现，而不是实施变更。如果任务需要修改代码，在结论中描述需要改什么——调用者会去实施。

始终直接写入结论文件：\`{conclusionFile}\``,
	},
	"tool.subagentConclusionRedirectedFileNotFound": {
		en: `⚠️ File path redirected: "{originalPath}" → "{conclusionFile}".

The conclusion file "{conclusionFile}" does not exist yet, so Edit failed.

**You are an explore/plan subagent in READ-ONLY mode.** Do NOT attempt to modify source code, configuration, or any project files.

**Action required:** Use **Write** (not Edit) to create the conclusion file first with your complete findings. After the file exists, you can use Edit to append or modify it.

Target file: \`{conclusionFile}\``,
		"zh-CN": `⚠️ 文件路径已重定向："{originalPath}" → "{conclusionFile}"。

结论文件 "{conclusionFile}" 尚不存在，因此 Edit 操作失败。

**你是 explore/plan 子代理，处于只读模式。** 不要尝试修改源代码、配置或任何项目文件。

**需要执行的操作：** 首先使用 **Write**（而不是 Edit）创建结论文件，写入你的完整发现。文件创建后，你可以使用 Edit 追加或修改。

目标文件：\`{conclusionFile}\``,
	},
	"tool.relaxedPlanToolReminder": {
		en: `<relaxed_plan_reminder>
You are still in relaxed plan mode. This non-read-only tool call was allowed only so planning can continue with full context. Do not start implementation work yet. Continue investigating or refining the plan, then call ExitPlanMode to submit the complete plan for approval.
</relaxed_plan_reminder>`,
		"zh-CN": `<relaxed_plan_reminder>
你仍处于宽松计划模式。此次非只读工具调用只是为了让规划能带着完整上下文继续进行，并不表示可以开始实现。不要现在开始写实现代码；请继续调查或完善计划，然后调用 ExitPlanMode 提交完整计划供用户批准。
</relaxed_plan_reminder>`,
	},
	"tool.planModeCancelled": {
		en: "Plan mode was cancelled by the user. Do not submit or execute this plan unless the user asks you to plan again.",
		"zh-CN": "计划模式已被用户取消。除非用户再次要求规划，否则不要提交或执行此计划。",
	},
	"tool.suggestAnswerSystem": {
		en: "You are a senior software engineering advisor. The user is being asked one or more questions by an AI coding assistant during a conversation. You will receive the full conversation context in <conversation> tags and the questions in <questions> tags. For each question, suggest the best-practice answer considering the specific project context and conversation history. If options are provided, pick from them; otherwise give a concise free-text answer. Reply with ONLY a valid JSON object mapping each question key to your recommended answer string. No explanation, no markdown fences.",
		"zh-CN":
			"你是一位资深软件工程顾问。用户正在一次对话中被 AI 编程助手提问。你会收到 <conversation> 标签中的完整对话上下文和 <questions> 标签中的问题。对于每个问题，请结合具体的项目上下文和对话历史，建议最佳实践答案。如果提供了选项，从中选择；否则给出简洁的自由文本答案。只回复一个有效的 JSON 对象，将每个问题的 key 映射到你推荐的答案字符串。不要解释，不要 markdown 代码块。",
	},
	"tool.questionReflectionSystem": {
		en: "You are NarraFork's question reflection gate. An AI coding assistant asked the user one or more questions, but the session is allowed to proceed automatically. Use the conversation context and project intent to answer as a careful user would: choose the safest practical default, prefer the assistant's recommended option when it is reasonable, and avoid adding new requirements. If options are provided, pick option labels exactly; for multi-select questions, return comma-separated option labels. For free-text questions, give a concise answer. Reply with ONLY a valid JSON object mapping each question key to your answer string. No explanation, no markdown fences.",
		"zh-CN":
			"你是 NarraFork 的问题反思关卡。AI 编程助手向用户提出了一个或多个问题，但当前会话允许自动继续。请根据对话上下文和项目意图，像谨慎的用户一样回答：选择安全、实用的默认值；当助手推荐项合理时优先采用；不要添加新的需求。如果提供了选项，请精确返回选项 label；多选问题返回用逗号分隔的选项 label。自由文本问题请给出简洁回答。只回复一个有效的 JSON 对象，将每个问题 key 映射到答案字符串。不要解释，不要 markdown 代码块。",
	},
	"tool.turnNudge": {
		en: "\n\n[SYSTEM: You have used {turnIndex} of {maxTurns} turns. Please wrap up your work soon — summarize remaining steps if you cannot finish in time.]",
		"zh-CN":
			"\n\n[系统提示：你已使用 {turnIndex}/{maxTurns} 轮。请尽快收尾——如果无法及时完成，请总结剩余步骤。]",
	},
	"tool.silentToolCallProgressReminder": {
		en: `<progress_update_request>
You have completed {count} tool call(s) since your last visible text reply. Before calling any more tools, briefly tell the user in one sentence what you are working on right now, then continue.
</progress_update_request>`,
		"zh-CN": `<progress_update_request>
你已经连续 {count} 次工具调用没有向用户输出可见文本。继续调用更多工具前，请先用一句话简短告诉用户你当前正在做什么，然后继续。
</progress_update_request>`,
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
		en: "Your previous response was cut off by the completion token limit. Please continue from where you left off.",
		"zh-CN": "你上一条回复因 completion token 限制被截断，请从中断处继续。",
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
	"tool.toolUnloaded": {
		en: '[The optional tool "{toolName}" has just been unloaded from this session. Do not use this tool unless it is loaded again.]',
		"zh-CN":
			'[可选工具 "{toolName}" 刚刚从本次会话中卸载。除非它再次被加载，否则不要使用这个工具。]',
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
		en: "Use /switch <number> or /switch <id> to switch.",
		"zh-CN": "使用 /switch <序号> 或 /switch <id> 切换。",
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
		en: "Usage: /switch <number> or /switch <id>\nUse /list or /search to find narrators.",
		"zh-CN": "用法：/switch <序号> 或 /switch <id>\n使用 /list 或 /search 查找叙述者。",
	},
	"gateway.switchedTo": {
		en: "🔗 Switched to: {title}\nID: {id} | Status: {status} | Model: {model}",
		"zh-CN": "🔗 已切换到：{title}\nID：{id} | 状态：{status} | 模型：{model}",
	},
	"gateway.narratorNotFound": {
		en: "❌ Narrator not found: {id}\nUse /list or /search to find valid IDs.",
		"zh-CN": "❌ 未找到叙述者：{id}\n使用 /list 或 /search 查找有效 ID。",
	},
	"gateway.switchIndexOutOfRange": {
		en: "❌ Invalid number. Valid range: 1–{max}.\nUse /list or /search to refresh.",
		"zh-CN": "❌ 序号无效，有效范围：1–{max}。\n使用 /list 或 /search 刷新列表。",
	},
	"gateway.switchNoListCache": {
		en: "❌ No recent list. Use /list or /search first, then /switch <number>.",
		"zh-CN": "❌ 没有最近的列表。请先使用 /list 或 /search，再用 /switch <序号>。",
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
		en: "/switch <number|id> — Switch to an existing narrator",
		"zh-CN": "/switch <序号|id> — 切换到已有叙述者",
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
	locale: Locale = DEFAULT_LOCALE,
	params?: Record<string, string | number>,
): string {
	const entry = messages[key];
	if (!entry) return key; // unknown key → return as-is
	let msg = pickLocalizedValue(entry, locale);
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

/** Load database dependencies only when a user preference is actually queried. */
async function createUserPreferenceQueryDependencies() {
	const [{ eq }, { db }, { userPreferences }] = await Promise.all([
		import("drizzle-orm"),
		import("../db"),
		import("../db/schema"),
	]);
	return { db, eq, userPreferences };
}

let userPreferenceQueryDependencies:
	| ReturnType<typeof createUserPreferenceQueryDependencies>
	| undefined;

function loadUserPreferenceQueryDependencies() {
	userPreferenceQueryDependencies ??= createUserPreferenceQueryDependencies();
	return userPreferenceQueryDependencies;
}

/**
 * Get the language preference for a user from the database.
 * Returns the default locale if no valid preference is set.
 */
export async function getUserLanguage(userId: string): Promise<Locale> {
	const { db, eq, userPreferences } = await loadUserPreferenceQueryDependencies();
	const pref = await db.query.userPreferences.findFirst({
		where: eq(userPreferences.userId, userId),
		columns: { language: true },
	});
	return normalizeLocale(pref?.language);
}

/**
 * Get the replyInUserLanguage preference for a user.
 */
export async function getUserReplyInLanguage(userId: string): Promise<boolean> {
	const { db, eq, userPreferences } = await loadUserPreferenceQueryDependencies();
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
	| "compactContextOverflowHint"
	| "compactCurrentTodos"
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
	| "exitPlanModeDeniedFile"
	| "exitPlanModeDeniedFileWithMessage"
	| "exitPlanModeEmptyPlan"
	| "exitPlanModeEmptyPlanFallback"
	| "exitPlanModePathReference"
	| "planModeSoftDenyAskReason"
	| "planModeToolDisabled"
	| "planModeFileRedirected"
	| "subagentConclusionRedirected"
	| "subagentConclusionRedirectedFileNotFound"
	| "relaxedPlanToolReminder"
	| "planModeCancelled"
	| "suggestAnswerSystem"
	| "questionReflectionSystem"
	| "turnNudge"
	| "silentToolCallProgressReminder"
	| "brokenToolCallReminder"
	| "brokenToolCallInputPlaceholder"
	| "brokenToolCallResult"
	| "interruptionContinue"
	| "userContinue"
	| "toolLoaded"
	| "toolUnloaded"
	| "forkNarratorSuccess"
	| "forkNarratorChapterInfo"
	| "forkNarratorError";

export function getToolMessage(key: ToolMessageKey, locale: Locale = DEFAULT_LOCALE): string {
	return t(`tool.${key}`, locale);
}

export function getToolMessageWithParams(
	key: ToolMessageKey,
	locale: Locale = DEFAULT_LOCALE,
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

export function getMergeSummaryLabel(
	key: MergeSummaryLabelKey,
	locale: Locale = DEFAULT_LOCALE,
): string {
	return t(`merge.${key}`, locale);
}
