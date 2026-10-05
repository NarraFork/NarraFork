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
	"tool.browserSessionLostAfterUpdate": {
		en: "Your browser session(s) {ids} were lost while switching to the new version and could not be restored ({reason}). Please launch a new browser session if you still need one.",
		"zh-CN":
			"浏览器会话 {ids} 在切换到新版本时丢失、无法恢复（{reason}）。如仍需要，请重新用 Browser launch 打开。",
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
		en: "EMERGENCY NOTICE: the context window overflowed and had to be force-compacted. Do not use the Read tool's read-all mode (limit=-1) for routine inspection. Prefer Grep plus small offset/limit pages; use read-all only when the user explicitly requires the complete file and its size is manageable.",
		"zh-CN":
			"紧急提示：上下文窗口已溢出并被强制压缩。请勿用 read_all（Read 工具 limit=-1 全量读取模式）做常规检查。优先使用 Grep 定位，再用较小的 offset/limit 分页；只有用户明确要求完整文件且文件大小可控时才使用全量模式。",
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
	"tool.enterPlanModeOutputWithPath": {
		en: `Entered plan mode. Designated plan file:

\`{planFilePath}\`

Write the complete plan there, then call ExitPlanMode for approval. The plan file must stay under \`.narrafork/plans/\` (including in relaxed mode). Other files may be edited while planning only in relaxed mode.`,
		"zh-CN": `已进入计划模式。指定计划文件：

\`{planFilePath}\`

将完整计划写入该文件，然后调用 ExitPlanMode 提交审批。计划文件必须位于 \`.narrafork/plans/\`（宽松模式同样适用）。仅宽松模式下可在规划期间修改其他文件。`,
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
		en: '[PLAN MODE] The user rejected your file-based plan. You are STILL in plan mode. Revise the designated plan file, then call ExitPlanMode again with mode="file" so the system rereads it. If the feedback only requires a small change, prefer using Edit to patch the existing plan file and submit it directly; only rewrite the whole plan file when a full restructure is necessary. Do NOT attempt to write code or make changes — you must exit plan mode first.',
		"zh-CN":
			'[计划模式] 用户拒绝了你通过计划文件提交的计划。你仍然处于计划模式中。请修改指定的计划文件，然后以 mode="file" 再次调用 ExitPlanMode，让系统重新读取该文件。若反馈只需要小幅调整，优先用 Edit 修补原计划文件并直接重新提交；只有在结构必须大改时才整体重写计划文件。不要尝试写代码或做任何修改——你必须先退出计划模式。',
	},
	"tool.exitPlanModeDeniedFileWithMessage": {
		en: '[PLAN MODE] The user rejected your file-based plan with the following feedback: {message}\n\nYou are STILL in plan mode. Revise the designated plan file based on this feedback, then call ExitPlanMode again with mode="file" so the system rereads it. If the requested change is small, prefer using Edit to patch the existing plan file and submit it directly; only rewrite the whole plan file when a full restructure is necessary. Do NOT attempt to write code or make changes — you must exit plan mode first.',
		"zh-CN":
			'[计划模式] 用户拒绝了你通过计划文件提交的计划，并附带以下反馈：{message}\n\n你仍然处于计划模式中。请根据此反馈修改指定的计划文件，然后以 mode="file" 再次调用 ExitPlanMode，让系统重新读取该文件。若请求的改动较小，优先用 Edit 修补原计划文件并直接重新提交；只有在结构必须大改时才整体重写计划文件。不要尝试写代码或做任何修改——你必须先退出计划模式。',
	},
	// Reached only when NO plan content was obtained from either source. Both routes
	// are offered without preference: naming one as "the" fix would be wrong for the
	// case the model actually hit (a declared `file` plan whose file is empty must not
	// be told to retry inline, since inline fallback is refused under that declaration).
	"tool.exitPlanModeEmptyPlan": {
		en: 'Error: The plan content is empty — neither an inline plan body nor the designated plan file ({planFile}) produced any plan. Pick one and make it real: put the COMPLETE plan text in \'inline_plan\' and call ExitPlanMode with mode="inline", or write the plan into {planFile} and call ExitPlanMode with mode="file". A declared mode is verified, so it must match the source you actually filled in.',
		"zh-CN":
			'错误：计划内容为空 — 内联计划正文和指定的计划文件（{planFile}）都没有提供任何计划。请选定其中一条并落实：把完整的计划正文放入 \'inline_plan\' 并以 mode="inline" 调用 ExitPlanMode，或把计划写入 {planFile} 并以 mode="file" 调用 ExitPlanMode。声明的 mode 会被校验，因此必须与你实际填写的来源一致。',
	},
	"tool.exitPlanModeEmptyPlanFallback": {
		en: 'Error: The plan content is empty. Provide the complete plan in \'inline_plan\' with mode="inline", or write it to the designated plan file and submit with mode="file".',
		"zh-CN":
			'错误：计划内容为空。请在 \'inline_plan\' 中提供完整计划并以 mode="inline" 提交，或将其写入指定的计划文件后以 mode="file" 提交。',
	},
	"tool.exitPlanModeCustomFileNotFound": {
		en: "Error: The specified plan file \"{planFile}\" does not exist or is empty. Please write your plan to this file first, or omit the 'plan_file_path' parameter to use the default designated plan file.",
		"zh-CN":
			"错误：指定的计划文件 \"{planFile}\" 不存在或为空。请先将计划写入此文件，或省略 'plan_file_path' 参数以使用默认的指定计划文件。",
	},
	"tool.exitPlanModePlanFileInvalid": {
		en: 'Error: The plan file "{planFile}" must be a regular Markdown file (.md or .markdown).',
		"zh-CN": '错误：计划文件 "{planFile}" 必须是普通 Markdown 文件（.md 或 .markdown）。',
	},
	"tool.exitPlanModePlanFileOutsidePlansDir": {
		en: 'Error: The plan file "{planFile}" is outside "{plansDir}/". Plan files must live in that directory of the working directory, even when this session permits writing other files. Move the plan into "{plansDir}/" (or use the designated plan file "{defaultPlanFile}") and submit again.',
		"zh-CN":
			'错误：计划文件 "{planFile}" 不在 "{plansDir}/" 目录内。即使当前会话允许修改其他文件，计划文件也必须位于工作目录下的该目录中。请把计划移入 "{plansDir}/"（或直接使用指定计划文件 "{defaultPlanFile}"）后重新提交。',
	},
	"tool.exitPlanModePlanFileTooLarge": {
		en: 'Error: The plan file "{planFile}" exceeds the maximum supported size of {maxBytes} bytes. Please split the plan into a smaller file.',
		"zh-CN":
			'错误：计划文件 "{planFile}" 超过最大支持大小 {maxBytes} 字节。请将计划拆分到更小的文件中。',
	},
	"tool.exitPlanModeInlineWithExistingPlanFile": {
		en: 'Error: You already wrote {bytes} bytes of plan content to the designated plan file ({planFile}), so an inline submission is refused: the user would review the inline text while the file that recorded your actual planning work is ignored. Call ExitPlanMode with mode="file" to submit what you wrote. If the plan file is stale or wrong, use Read to check it and Write to replace its content, then submit it with mode="file".',
		"zh-CN":
			'错误：你已经向指定的计划文件（{planFile}）写入了 {bytes} 字节的计划内容，因此内联提交被拒绝：那会让用户审阅内联文本，而记录了你实际规划工作的文件被忽略。请以 mode="file" 调用 ExitPlanMode 来提交你写好的内容。如果计划文件已过时或有误，请用 Read 检查、用 Write 替换其内容，然后以 mode="file" 提交。',
	},
	"tool.exitPlanModeInlineModeDisabled": {
		en: 'Error: mode="inline" is disabled in this instance. Write your complete plan to the designated plan file ({planFile}), then call ExitPlanMode with mode="file".',
		"zh-CN":
			'错误：本实例已禁用 mode="inline"。请将完整计划写入指定的计划文件（{planFile}），然后以 mode="file" 调用 ExitPlanMode。',
	},
	"tool.exitPlanModeInlineWithoutBody": {
		en: "Error: You declared mode=\"inline\" but did not provide a plan body in 'inline_plan'. This is not treated as a request to read the plan file — a declared inline plan must carry its own content. Either put the COMPLETE plan text in 'inline_plan', or declare mode=\"file\" to submit the plan you wrote to {planFile}.",
		"zh-CN":
			"错误：你声明了 mode=\"inline\"，但没有在 'inline_plan' 中提供计划正文。这不会被当作读取计划文件的请求 — 声明为内联的计划必须自带内容。请把完整的计划正文放入 'inline_plan'，或改为声明 mode=\"file\" 来提交你写入 {planFile} 的计划。",
	},
	"tool.exitPlanModePathReference": {
		en: "Error: The 'inline_plan' parameter looks like a file path or location reference, not the actual plan. The 'inline_plan' parameter must contain the COMPLETE plan text itself (all steps, file changes, reasoning) — this is what the user reviews. Do NOT pass a path like 'plan_path: ...' or a file reference. Either paste the full plan body into 'inline_plan' and submit with mode=\"inline\", or write your plan to the designated plan file ({planFile}) and call ExitPlanMode with mode=\"file\" so the system reads it.",
		"zh-CN":
			"错误：'inline_plan' 参数看起来是一个文件路径或位置引用，而不是真正的计划内容。'inline_plan' 参数必须包含完整的计划正文本身（所有步骤、文件改动、推理）— 这是用户要审阅的内容。不要传入类似 'plan_path: ...' 的路径或文件引用。请将完整的计划正文粘贴到 'inline_plan' 并以 mode=\"inline\" 提交，或将计划写入指定的计划文件（{planFile}）后以 mode=\"file\" 调用 ExitPlanMode，让系统读取。",
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
	"tool.pipelineExitConfirmation": {
		en: "[SYSTEM: Pipeline has already been used to extract captured output and is still active. Before making more tool calls, confirm whether you still need Pipeline. If not, stop using Pipeline so its captures can be cleaned up by the inactivity limit instead of continuing to accumulate.]",
		"zh-CN":
			"[系统提示：Pipeline 已经执行过一次提取，目前仍处于活动状态。继续调用工具前，请确认是否仍需要 Pipeline；如果不再需要，请停止使用 Pipeline，让系统按闲置阈值清理捕获内容，避免继续累积。]",
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
	"tool.skippedForSoftStop": {
		en: "Tool not executed because queued user feedback requested a safe stop after the previous tool.",
		"zh-CN": "因排队中的用户反馈要求在上一个工具后安全停止，此工具未执行。",
	},
	"tool.interruptionContinue": {
		en: "Your previous response was cut off by the completion token limit. Please continue from where you left off.",
		"zh-CN": "你上一条回复因 completion token 限制被截断，请从中断处继续。",
	},
	"tool.resumeAfterTransientError": {
		en: "Your previous response was interrupted by a temporary connection issue. Please continue from where you left off.",
		"zh-CN": "你上一条回复因临时网络问题被中断，请从中断处继续。",
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
	"tool.forkNarratorDepthExceeded": {
		en: "Refused: this narrator is already {depth} forks deep, and the limit is {limit}. Each fork creates a chapter, a git worktree and a narrator that can fork again, so the chain is capped. Do the work here, or ask the user to start a new branch.",
		"zh-CN":
			"已拒绝：当前叙述者已处于第 {depth} 层分叉，上限是 {limit} 层。每次分叉都会创建章节、git worktree 和一个还能继续分叉的叙述者，因此链条有上限。请在当前叙述者内完成工作，或请用户另起一个分支。",
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

	// --- sidecar.* (model-facing templates for structured side-car bodies) ---
	//
	// `renderSideCarBodyToText` (@shared/sidecar-body) assembles a side-car's
	// model-facing text from these. They live here, with the rest of the prompt copy,
	// because they ARE prompt copy — the shared module owns only the assembly order.
	//
	// ⚠️ Every string below reproduces what its predecessor formatter emitted, byte
	// for byte: this text goes into the model's context, and the migration to
	// structured bodies must not change a single character of it.
	// `shared/__tests__/sidecar-body.test.ts` pins that against the originals.

	// notice — fixed reminders, one per source (was: getToolMessage in loop.ts).
	// These intentionally duplicate `tool.*` keys rather than aliasing them: the
	// `tool.*` entries have other callers, and a shared prompt string that two
	// features edit for different reasons is how one feature's tweak silently
	// changes another's behaviour.
	"sidecar.noticeSilentProgress": {
		en: `<progress_update_request>
You have completed {count} tool call(s) since your last visible text reply. Before calling any more tools, briefly tell the user in one sentence what you are working on right now, then continue.
</progress_update_request>`,
		"zh-CN": `<progress_update_request>
你已经连续 {count} 次工具调用没有向用户输出可见文本。继续调用更多工具前，请先用一句话简短告诉用户你当前正在做什么，然后继续。
</progress_update_request>`,
	},
	"sidecar.noticeRelaxedPlan": {
		en: `<relaxed_plan_reminder>
You are still in relaxed plan mode, and this tool call modified something outside your plan file. Non-read-only tools are available only so planning can continue with full context — they are not permission to start implementing. Do not write or change implementation code yet.
Your plan belongs in: {planFile}
Continue investigating or refining the plan there, then call ExitPlanMode to submit the complete plan for approval.
</relaxed_plan_reminder>`,
		"zh-CN": `<relaxed_plan_reminder>
你仍处于宽松计划模式，而这次工具调用改动了计划文件以外的内容。非只读工具只是为了让规划能带着完整上下文继续进行，并不表示可以开始实现。现在不要编写或修改实现代码。
你的计划应写入：{planFile}
请继续在该文件中调查或完善计划，然后调用 ExitPlanMode 提交完整计划供用户批准。
</relaxed_plan_reminder>`,
	},
	"sidecar.noticePipelineExit": {
		en: "[SYSTEM: Pipeline has already been used to extract captured output and is still active. Before making more tool calls, confirm whether you still need Pipeline. If not, stop using Pipeline so its captures can be cleaned up by the inactivity limit instead of continuing to accumulate.]",
		"zh-CN":
			"[系统提示：Pipeline 已经执行过一次提取，目前仍处于活动状态。继续调用工具前，请确认是否仍需要 Pipeline；如果不再需要，请停止使用 Pipeline，让系统按闲置阈值清理捕获内容，避免继续累积。]",
	},

	// prose — `{source}Heading` prefixes the text; absent ⇒ emitted bare.
	// Only behavior_fence has one (was: buildBehaviorFenceReminder). A buffered user
	// message is the user's own words and gets no prefix.
	"sidecar.behavior_fenceHeading": {
		en: "Behavior fence (durable behavior constraints set by the user — you must obey them):",
		"zh-CN": "行为护栏（用户设定的行为约束，务必遵守）：",
	},

	// tasks — the Dynamic Spec digest (was: spec-reminder.ts).
	//
	// ⚠️ These strings are injected MID-TURN on a tool-call cadence, so every word is
	// paid again and again inside ONE piece of work. Keep them to the live task state
	// plus one action line. The rules about `tasks.json`'s shape, what makes a task
	// finite, when `protected` is allowed and how to handle a blocked entry all live in
	// the system prompt (`getDynamicSpecSystemReminder`, which embeds the blocked-task
	// rule verbatim) — the model read them at position zero and will read them again on
	// the next request, so restating them here is pure repetition. The turn-end
	// continuation prompts are a separate, rarer surface and may be as long as needed.
	// ⚠️ The heading must say "excerpt". This digest lists at most 4 tasks selected by
	// `buildSpecTaskDigestBody`; a longer list is silently cut. Read as the full file, a
	// model concludes its own entries went missing and "restores" them by overwriting
	// tasks.json with just these lines — which really does destroy the rest.
	"sidecar.tasksCurrentHeading": {
		en: "Dynamic Spec — excerpt of open tasks (not the full list; read spec://tasks.json for all of it):",
		"zh-CN": "Dynamic Spec 当前任务节选（非完整列表，完整内容见 spec://tasks.json）：",
	},
	"sidecar.tasksCurrentUpdateNote": {
		en: "Update spec://tasks.json if any state changed. Edit it in place; do not rewrite the file from this excerpt.",
		"zh-CN": "状态有变化就更新 spec://tasks.json。请就地修改，不要按本节选重写整个文件。",
	},
	"sidecar.tasksEmptyHeading": {
		en: "Dynamic Spec — no open tasks.",
		"zh-CN": "Dynamic Spec 当前没有开放任务。",
	},
	"sidecar.tasksEmptyNeverCreate": {
		en: "- Multi-step work? Write a task list to spec://tasks.json (one doing plus a few todo).",
		"zh-CN": "- 如果是多步骤工作，请在 spec://tasks.json 建立任务清单（一条 doing + 若干 todo）。",
	},
	"sidecar.tasksEmptyNeverSkip": {
		en: "- Simple work needs no list; ignore this if so.",
		"zh-CN": "- 工作简单则无需拆分，可忽略本提醒。",
	},
	"sidecar.tasksEmptyDoneReorganize": {
		en: "- Previous phase is done. Reorganize spec://tasks.json for the next one: drop completed ordinary tasks, keep a concise doing/todo/blocked set, preserve protected-task intent.",
		"zh-CN":
			"- 上一阶段已完成。请为下一阶段整理 spec://tasks.json：清理已完成的普通任务，只保留精简的 doing/todo/blocked，并保留 protected task 的用户意图。",
	},
	"sidecar.tasksEmptyDoneContinue": {
		en: "- Refresh the list before continuing.",
		"zh-CN": "- 整理完再继续。",
	},
	"sidecar.tasksTooManyHeading": {
		en: "Dynamic Spec — {count} tasks in spec://tasks.json, over the {threshold} threshold.",
		"zh-CN": `Dynamic Spec 当前有 {count} 条任务（spec://tasks.json），超过 {threshold} 条。`,
	},
	"sidecar.tasksTooManyReorganize": {
		en: "- Reorganize before continuing: merge duplicates, drop obsolete ordinary tasks, split oversized ones, keep only this phase's doing/todo/blocked. Preserve protected-task intent.",
		"zh-CN":
			"- 请先整理再继续：合并重复项，删除过期的普通任务，拆分过大的任务，只保留当前阶段的 doing/todo/blocked。protected task 的用户意图必须保留。",
	},

	// knowledge — was: formatInjectionsBare (knowledge-injection.ts). The heading is
	// English-only upstream (it is passed as a literal argument), so it stays so here.
	"sidecar.knowledgeHeading": {
		en: "Relevant knowledge-base entries were found based on the latest tool output:",
	},
	"sidecar.knowledgeReadHint": {
		en: "(Use KnowledgeRead with an id for full content.)",
	},

	// tasksDone — was: formatBackgroundCompletionNotifications + the inline bash
	// formatter in narrator-session.ts. Both are English-only upstream.
	"sidecar.bgAgentEntry": {
		en: `[System] Background agent "{title}" (ID: {id}) {status}.
Result preview: {preview}
Use Await({ type: "agent", id: "{id}" }) to see the full result, or Send({ id: "{id}", message }) to continue.`,
	},
	"sidecar.bgBashEntry": {
		en: `[System] Background bash "{title}" (ID: {id}) {status}.
Result preview: {preview}`,
	},
	"sidecar.emptyResult": {
		en: "(empty)",
	},

	// messages — was: formatParentInboundMessage (parent-inbound-queue.ts) and the
	// inline team formatter in subagent-executor.ts.
	"sidecar.subagentMessageEntry": {
		en: `[Progress report from subagent "{name}" ({type})]:
{text}`,
		"zh-CN": `[来自子代理"{name}"（{type}）的进展汇报]：
{text}`,
	},
	"sidecar.teamMessageEntry": {
		en: "[Team {channel} from {name} ({type})]: {text}",
	},
	"sidecar.teamBroadcast": { en: "broadcast" },
	"sidecar.teamDirect": { en: "message" },

	// specUpdates — was: formatSpecUpdateSideCars (spec-update-queue.ts).
	"sidecar.specUpdateHeading": {
		en: "[System] The user updated the following spec files via the Spec panel — align your plan accordingly:",
		"zh-CN": "[系统] 用户通过 Spec 面板更新了以下文件，请注意同步你的工作计划：",
	},
	"sidecar.specUpdateEntry": {
		en: "User updated {uri} via UI ({timestamp}).",
		"zh-CN": "用户通过 UI 更新了 {uri}（{timestamp}）。",
	},
	"sidecar.specUpdatePreview": {
		en: "Content preview:",
		"zh-CN": "内容预览：",
	},

	// asyncQuestionAnswers — answers to an AskUserQuestion asked with `async: true`.
	// The heading has to say WHICH question this answers, because the tool call it
	// belongs to may be hundreds of messages back by the time the user replies.
	"sidecar.asyncQuestionAnsweredHeading": {
		en: "[System] The user answered your asynchronous question(s). Adjust your work accordingly — do not ask again:",
		"zh-CN": "[系统] 用户回答了你此前异步提交的问题。请据此调整工作，不要重复提问：",
	},
	"sidecar.asyncQuestionReceiptHeading": {
		en: "The user answered a historical question. The original situation and the new user answer are recorded below:",
		"zh-CN": "用户回答了一个历史问题。以下分别记录提问时的情况与用户的新回答：",
	},
	"sidecar.asyncQuestionSupplementHeading": {
		en: "The user supplied a new supplement or correction. The frozen first answers below are historical background, not a re-submission. Read earlier supplement events via Question action=get (paginated) before confirming the current decision.",
		"zh-CN":
			"用户提供了新的补充或纠正。下列首次答案是历史背景，并未重新提交；请通过 Question action=get 分页读取此前补充，再确认当前处理结果。",
	},
	"sidecar.asyncQuestionReceiptHint": {
		en: "Historical context describes the situation at question time. Preview artifacts are omitted: Question.get returns complete previews. Treat answers and supplements as normal user requests. Judge applicability against the current task; confirm handling with Question action=resolve and the latest answerMessageId. If unclear, explain what needs clarification.",
		"zh-CN":
			"背景描述的是提问时的情况。回执省略预览原文，使用 Question action=get 读取完整预览。答案和补充是正常用户请求，请结合当前任务判断适用性，通过 Question action=resolve 与最新 answerMessageId 确认处理结果；需要澄清时说明缺少的信息。",
	},
	"sidecar.asyncQuestionDismissedReceiptHint": {
		en: "The user skipped this item. Use your own judgement and continue; no Question action=resolve is needed. Question action=get can retrieve omitted previews when necessary.",
		"zh-CN":
			"用户已跳过此事项，请自行判断并继续；无需调用 Question action=resolve。需要完整预览时可通过 Question action=get 读取。",
	},
	"sidecar.asyncQuestionUnknownContext": {
		en: "Question-time context is unknown.",
		"zh-CN": "提问时背景未知。",
	},
	"sidecar.asyncQuestionEntry": {
		en: "Q: {header}\nA: {answer}",
		"zh-CN": "问：{header}\n答：{answer}",
	},
	"sidecar.asyncQuestionNotes": {
		en: "Note: {notes}",
		"zh-CN": "备注：{notes}",
	},
	"sidecar.asyncQuestionDismissedHeading": {
		en: "[System] The user chose not to answer your asynchronous question(s) — use your own best judgement and continue. Do not ask again:",
		"zh-CN":
			"[系统] 用户选择不回答你此前异步提交的问题 —— 请按你自己的最佳判断继续，不要重复提问：",
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
	| "browserSessionLostAfterUpdate"
	| "systemPromptAck"
	| "titleAck"
	| "titleReminder"
	| "compactTodoSkip"
	| "compactContextOverflowHint"
	| "compactCurrentTodos"
	| "enterPlanModeOutput"
	| "enterPlanModeOutputWithPath"
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
	| "exitPlanModeCustomFileNotFound"
	| "exitPlanModePlanFileInvalid"
	| "exitPlanModePlanFileOutsidePlansDir"
	| "exitPlanModePlanFileTooLarge"
	| "exitPlanModeInlineWithExistingPlanFile"
	| "exitPlanModeInlineModeDisabled"
	| "exitPlanModeInlineWithoutBody"
	| "exitPlanModePathReference"
	| "planModeSoftDenyAskReason"
	| "planModeToolDisabled"
	| "planModeFileRedirected"
	| "planModeCancelled"
	| "suggestAnswerSystem"
	| "questionReflectionSystem"
	| "turnNudge"
	| "silentToolCallProgressReminder"
	| "pipelineExitConfirmation"
	| "brokenToolCallReminder"
	| "brokenToolCallInputPlaceholder"
	| "brokenToolCallResult"
	| "skippedForSoftStop"
	| "interruptionContinue"
	| "resumeAfterTransientError"
	| "userContinue"
	| "toolLoaded"
	| "toolUnloaded"
	| "forkNarratorSuccess"
	| "forkNarratorChapterInfo"
	| "forkNarratorError"
	| "forkNarratorDepthExceeded";

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
