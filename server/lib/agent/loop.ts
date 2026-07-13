import { resolve } from "node:path";
import { scanToolOutputForKnowledgeDetailed } from "../../services/knowledge-injection";
import { SPEC_TASKS_PATH } from "../../services/spec-task-service";
import { specVfsService } from "../../services/spec-vfs-service";
import { type ApiRequestHandle, finishApiRequest, startApiRequest } from "../api-request-tracker";
import { type DangerReflectionLevel, resolveBooleanOverride } from "../boolean-override";
import { logger } from "../logger";
import { getPrompt, getToolMessage, getToolMessageWithParams, type Locale } from "../prompt-i18n";
import { shouldUseNativeSearch } from "../search/native";
import { getModelContextWindow, settings, usesStatefulModel } from "../settings";
import { analyzeShellCommand } from "./bash-analyze";
import { CODEX_REBUILD_HISTORY_RETRY_CODE, isCodexRebuildHistoryRetryError } from "./codex-errors";
import {
	extractErrorMessage,
	getPaymentRequiredErrorInfo,
	isCompletionLimitReason,
	isContextOverflowMessage,
	isContextOverflowReason,
	isContextWindowExceededError,
	isRetryableError,
	isRetryableInvalidStateReason,
} from "./error-handling";
import { estimateTokens } from "./estimate-tokens";
import { type ParsedStreamEvent, resolveProviderAndModel } from "./provider";
import { ApiRequestDumpCollector } from "./request-dump";
import { detectShell } from "./shell";
import { appendSideCarsForApi } from "./sidecar";
import {
	executeTool,
	freezeToolExecutionTarget,
	sanitizeBrokenInput,
	type ToolExecResult,
} from "./tool-executor";
import { toolRegistry } from "./tool-registry";
import { SHELL_TOOL_NAME } from "./tools/bash";
import { DANGER_REFLECTION_TOOLS } from "./tools/danger-reflection";
import { replace as applyEditReplacement, findReplaceMatch } from "./tools/edit";
import { readFileText } from "./tools/encoding";
import {
	cancelExitPlanReflection,
	cleanupExitPlanReflection,
	createExitPlanReflectionDecision,
	EXIT_PLAN_CONFIRM_COMPACT_TOOL_NAME,
	EXIT_PLAN_REFLECTION_TOOLS,
	type ExitPlanReflectionDecision,
	isExitPlanReflectionWaitingForUser,
	markExitPlanReflectionStarted,
} from "./tools/exit-plan-reflection";
import {
	cleanupTaskReflection,
	consumeTaskReflectionGrant,
	createTaskReflectionDecision,
	grantTaskReflection,
	isTaskReflectionWaitingForUser,
	markTaskReflectionStarted,
	reviseTaskReflection,
	TASK_REFLECTION_TOOLS,
	type TaskReflectionDecision,
} from "./tools/task-reflection";
import type {
	AgentConfig,
	AgentEvent,
	AgentSideCar,
	AgentToolUse,
	ContentBlock,
	PermissionResult,
	ResolvedToolDefinition,
} from "./types";
import {
	PLAN_MODE_ALLOWED_TOOLS,
	type ReasoningProviderMetadata,
	TRANSIENT_RETRY_BASE_MS,
} from "./types";

export { isRetryableError } from "./error-handling";

/**
 * Hide remote-only tools without removing the recovery path from a stale remote
 * default. TransferFile requires an online remote endpoint; SwitchDevice also
 * remains available when the current default is remote so the session can
 * explicitly return to local execution.
 */
export function filterDeviceTools(
	tools: ResolvedToolDefinition[],
	config: Pick<AgentConfig, "availableDevices" | "defaultDeviceId">,
): ResolvedToolDefinition[] {
	const hasOnlineRemote = (config.availableDevices ?? []).some((device) => device.online);
	const hasRemoteDefault = config.defaultDeviceId != null && config.defaultDeviceId !== "local";

	return tools.filter((tool) => {
		if (tool.name === "TransferFile") return hasOnlineRemote;
		if (tool.name === "SwitchDevice") return hasOnlineRemote || hasRemoteDefault;
		return true;
	});
}

// ── Incomplete JSON field extractor ─────────────────────────────
// Parses streaming JSON fragments to extract field values without
// requiring a complete JSON object. Used to provide structured
// field data to the frontend instead of raw JSON.

/** Find the unescaped closing quote in a JSON string value. Returns -1 if not found. */
function findClosingQuote(s: string, start: number): number {
	for (let i = start; i < s.length; i++) {
		if (s.charCodeAt(i) === 0x5c /* \ */) {
			i++; // skip escaped char
			continue;
		}
		if (s.charCodeAt(i) === 0x22 /* " */) return i;
	}
	return -1;
}

/** Decode JSON string escapes, withholding an incomplete trailing escape until a later chunk. */
function decodeJsonStringFragment(s: string): { text: string; consumedChars: number } {
	let text = "";
	let i = 0;
	while (i < s.length) {
		const ch = s[i];
		if (ch !== "\\") {
			text += ch;
			i++;
			continue;
		}

		if (i + 1 >= s.length) break;
		const escaped = s[i + 1];
		switch (escaped) {
			case '"':
				text += '"';
				i += 2;
				break;
			case "\\":
				text += "\\";
				i += 2;
				break;
			case "/":
				text += "/";
				i += 2;
				break;
			case "b":
				text += "\b";
				i += 2;
				break;
			case "f":
				text += "\f";
				i += 2;
				break;
			case "n":
				text += "\n";
				i += 2;
				break;
			case "r":
				text += "\r";
				i += 2;
				break;
			case "t":
				text += "\t";
				i += 2;
				break;
			case "u": {
				const hex = s.slice(i + 2, i + 6);
				if (hex.length < 4) return { text, consumedChars: i };
				if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
					text += `\\${escaped}`;
					i += 2;
					break;
				}
				text += String.fromCharCode(Number.parseInt(hex, 16));
				i += 6;
				break;
			}
			default:
				// Preserve malformed escapes rather than dropping user-visible text.
				text += `\\${escaped}`;
				i += 2;
		}
	}
	return { text, consumedChars: i };
}

/** Unescape JSON string content. Incomplete trailing escapes are preserved for completed fields. */
function unescapeJsonString(s: string): string {
	const decoded = decodeJsonStringFragment(s);
	return decoded.consumedChars === s.length
		? decoded.text
		: decoded.text + s.slice(decoded.consumedChars);
}

interface ExtractedFieldsResult {
	/** Completed short fields (key → unescaped value) */
	fields: Record<string, string>;
	/** The field currently being written (no closing quote yet), or null */
	activeField: { name: string; rawStart: number } | null;
}

/**
 * Extract selected fields from an incomplete JSON object.
 * Scans for `"key": "value"` patterns, handling escaped quotes correctly, and also
 * captures completed primitive values such as booleans for short fields.
 * Returns completed fields and identifies the currently-streaming string field.
 */
function extractJsonFields(raw: string, wantedKeys: ReadonlySet<string>): ExtractedFieldsResult {
	const fields: Record<string, string> = {};
	let activeField: ExtractedFieldsResult["activeField"] = null;

	// Match `"key" :` patterns
	const keyRe = /"(\w+)"\s*:\s*/g;
	for (;;) {
		const m = keyRe.exec(raw);
		if (m === null) break;
		const key = m[1];
		if (!wantedKeys.has(key)) continue;
		const afterColon = m.index + m[0].length;
		if (afterColon >= raw.length) continue;
		if (raw.charCodeAt(afterColon) !== 0x22 /* " */) {
			const primitiveMatch = raw
				.slice(afterColon)
				.match(/^(true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
			if (primitiveMatch) {
				fields[key] = primitiveMatch[1];
				keyRe.lastIndex = afterColon + primitiveMatch[0].length;
			}
			continue;
		}
		const valueStart = afterColon + 1;
		const closeQuote = findClosingQuote(raw, valueStart);
		if (closeQuote !== -1) {
			// Complete field
			fields[key] = unescapeJsonString(raw.slice(valueStart, closeQuote));
			// Advance past this field so we don't re-match inside the value
			keyRe.lastIndex = closeQuote + 1;
		} else {
			// No closing quote — this field is still being written
			activeField = { name: key, rawStart: valueStart };
			break; // Nothing meaningful after an incomplete string value
		}
	}
	return { fields, activeField };
}

/** Per-tool mapping: which fields to extract, and which are "large" (streamed incrementally) */
const TOOL_FIELD_CONFIG: Record<string, { short: string[]; large: string[] }> = {
	Write: { short: ["file_path"], large: ["content"] },
	Edit: { short: ["file_path", "replace_all"], large: ["old_string", "new_string"] },
	Bash: { short: ["description"], large: ["command"] },
	Grep: { short: ["pattern", "path", "glob", "output_mode", "type"], large: [] },
	Glob: { short: ["pattern", "path"], large: [] },
	Read: { short: ["file_path", "offset", "limit"], large: [] },
	Agent: {
		short: ["description", "subagent_type", "model", "reasoning_effort"],
		large: ["prompt"],
	},
	Task: { short: ["description", "subagent_type", "model", "reasoning_effort"], large: ["prompt"] },
	Await: { short: ["type", "id", "timeout", "wait_for_text"], large: [] },
	Send: {
		short: ["id", "ids", "name", "names", "doInterrupt", "await", "timeout"],
		large: ["message"],
	},
	WebSearch: { short: ["query"], large: [] },
	WebFetch: { short: ["url", "mode"], large: [] },
	Skill: { short: ["skill"], large: [] },
	ExitPlanMode: { short: [], large: ["plan"] },
	StartPipeline: { short: ["label", "maxPreviewChars"], large: [] },
	EndPipeline: { short: ["aliases", "format", "maxChars"], large: ["rule"] },
	AskUserQuestion: { short: [], large: [] },
};

function getToolWantedKeys(toolName: string): Set<string> {
	const config = TOOL_FIELD_CONFIG[toolName];
	if (!config) return new Set();
	return new Set([...config.short, ...config.large]);
}

/** Tools whose input is short enough that streaming JSON parsing adds no value.
 *  We still emit tool_use_chunk events (so the frontend shows the shimmer),
 *  but skip extractJsonFields / streaming field extraction entirely.
 *  Tools with short fields (e.g. Grep.pattern, Read.file_path) still need extraction. */
function isShortInputTool(name: string): boolean {
	const config = TOOL_FIELD_CONFIG[name];
	if (!config) return true; // not in config → short by default
	return config.large.length === 0 && config.short.length === 0;
}

function normalizeLineEndings(text: string): string {
	return text.replaceAll("\r\n", "\n");
}

async function resolveStreamingEditMetadata(
	acc: { name: string; extractedFilePath?: string; extractedFields?: Record<string, string> },
	cwd: string,
): Promise<Record<string, unknown> | undefined> {
	if (acc.name !== "Edit") return undefined;
	const filePath = acc.extractedFilePath ?? acc.extractedFields?.file_path;
	const oldString = acc.extractedFields?.old_string;
	if (!filePath || oldString == null || oldString === "") return undefined;

	try {
		const resolvedPath = resolve(cwd, filePath);
		const { text } = await readFileText(resolvedPath);
		const content = normalizeLineEndings(text);
		const normalizedOld = normalizeLineEndings(oldString);
		const replaceAll = acc.extractedFields?.replace_all === "true";
		const match = findReplaceMatch(content, normalizedOld, replaceAll);
		const lineCount = normalizedOld.split("\n").length;
		return {
			startLine: match.startLine,
			endLine: match.startLine + lineCount - 1,
			matchStatus: "matched",
		};
	} catch (err) {
		return {
			matchStatus: "unmatched",
			matchError: err instanceof Error ? err.message : String(err),
		};
	}
}

const EMPTY_RESPONSE_MESSAGE =
	"Provider returned an empty response. This often indicates an API configuration error " +
	"(base URL, model, or credentials).";

/** Max retries specifically for empty responses (request succeeded but no content). */
const MAX_EMPTY_RESPONSE_RETRIES = 3;

const REASONING_ONLY_MESSAGE =
	"Provider returned only reasoning with no answer or tool call. Retrying.";

/** Terminal message when reasoning-only retries are exhausted. Conveys how many
 *  retries were already attempted so the failure is not mistaken for a pending retry. */
function reasoningOnlyExhaustedMessage(retries: number): string {
	const retryLabel = retries === 1 ? "retry" : "retries";
	return (
		"Provider returned only reasoning with no answer or tool call " +
		`after ${retries} ${retryLabel}. Giving up.`
	);
}

function dedupeToolUsesInPlace(
	toolUses: AgentToolUse[],
	provider: string,
	model: string,
): AgentToolUse[] {
	if (toolUses.length < 2) return toolUses;
	const seen = new Set<string>();
	const deduped: AgentToolUse[] = [];
	const duplicateIds: string[] = [];
	for (const tu of toolUses) {
		if (seen.has(tu.toolUseId)) {
			duplicateIds.push(tu.toolUseId);
			continue;
		}
		seen.add(tu.toolUseId);
		deduped.push(tu);
	}
	if (duplicateIds.length > 0) {
		logger.error("Deduplicated repeated tool calls in a single turn", {
			provider,
			model,
			duplicateCount: duplicateIds.length,
			toolUseIds: [...new Set(duplicateIds)].slice(0, 20),
		});
		toolUses.length = 0;
		toolUses.push(...deduped);
	}
	return toolUses;
}

/** Abort-aware sleep that resolves early when the signal fires. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

function isMeaningfulStreamEvent(parsed: ParsedStreamEvent): boolean {
	return !!(
		parsed.text ||
		(parsed.toolUses?.length ?? 0) > 0 ||
		parsed.toolUseChunk ||
		parsed.reasoning ||
		parsed.webSearch ||
		parsed.imageGeneration ||
		parsed.queueStatus
	);
}

/** Yield block_complete events for accumulated reasoning blocks and assistant text.
 *  Used in every early-return / error path to persist partial progress. */
function* flushPartialContent(
	reasoningBlockMap: Map<string, ReasoningBlockEntry>,
	assistantText: string,
	textOutputIndex?: number,
): Generator<AgentEvent> {
	for (const entry of reasoningBlockMap.values()) {
		if (entry.text || entry.providerMetadata) {
			yield {
				type: "block_complete",
				block: {
					type: "reasoning",
					text: entry.text,
					providerMetadata: entry.providerMetadata,
					outputIndex: entry.outputIndex,
				},
			};
		}
	}
	if (assistantText) {
		yield {
			type: "block_complete",
			block: { type: "text", text: assistantText, outputIndex: textOutputIndex },
		};
	}
}

/** Tools that can safely run in parallel when multiple appear in the same turn. */
const PARALLEL_TOOLS = new Set([
	"Agent",
	"Read",
	"Glob",
	"Grep",
	"WebSearch",
	"WebFetch",
	"Await",
	"Send",
	SHELL_TOOL_NAME,
]);

// Cadence (in completed tool calls) for the periodic spec (tasks.json) reminder.
// Named for the legacy todo reminder it replaced; still the spec-reminder interval.
export const TODO_REMINDER_TOOL_INTERVAL = 15;
const DEFAULT_SILENT_TOOL_CALL_THRESHOLD = 20;

const RELAXED_PLAN_READ_ONLY_TOOLS = new Set([
	"Read",
	"Grep",
	"Glob",
	"WebSearch",
	"WebFetch",
	"Await",
	"ShareFile",
	"LearningGuide",
	"StartPipeline",
	"EndPipeline",
	"AskUserQuestion",
	"EnterPlanMode",
	"ExitPlanMode",
]);

const RELAXED_PLAN_READ_ONLY_SUBAGENTS = new Set(["explore", "plan"]);

function isTaskStateMaintenanceToolUse(tu: AgentToolUse): boolean {
	if (tu.name !== "Write" && tu.name !== "Edit") return false;
	const filePath = typeof tu.input.file_path === "string" ? tu.input.file_path : null;
	if (!filePath || !specVfsService.isSpecUri(filePath)) return false;
	try {
		return specVfsService.normalizeSpecPath(filePath) === SPEC_TASKS_PATH;
	} catch {
		return false;
	}
}

export async function shouldInjectRelaxedPlanToolReminder(
	tu: AgentToolUse,
	config: Pick<AgentConfig, "planMode" | "relaxedPlan" | "cwd" | "chapterId">,
): Promise<boolean> {
	if (!config.planMode || !config.relaxedPlan) return false;
	if (RELAXED_PLAN_READ_ONLY_TOOLS.has(tu.name)) return false;
	if (isTaskStateMaintenanceToolUse(tu)) return false;

	if (tu.name === "Agent" || tu.name === "Task") {
		const subagentType =
			typeof tu.input.subagent_type === "string" ? tu.input.subagent_type : undefined;
		return !subagentType || !RELAXED_PLAN_READ_ONLY_SUBAGENTS.has(subagentType);
	}

	if (tu.name === SHELL_TOOL_NAME || tu.name === "Shell") {
		const command = typeof tu.input.command === "string" ? tu.input.command : "";
		if (!command) return false;
		try {
			const workdir = typeof tu.input.workdir === "string" ? tu.input.workdir : undefined;
			const shellCwd = workdir ? resolve(config.cwd, workdir) : config.cwd;
			const analysis = await analyzeShellCommand(
				command,
				shellCwd,
				detectShell().type,
				!!config.chapterId,
			);
			return analysis.hasWriteOperation;
		} catch (err) {
			logger.debug("Failed to classify relaxed-plan shell tool use", {
				toolUseId: tu.toolUseId,
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	return true;
}

function normalizeSilentToolCallThreshold(value: number | undefined): number {
	if (value == null) return DEFAULT_SILENT_TOOL_CALL_THRESHOLD;
	if (!Number.isFinite(value)) return DEFAULT_SILENT_TOOL_CALL_THRESHOLD;
	const threshold = Math.trunc(value);
	return threshold < -1 ? -1 : threshold;
}

const EAGER_EXECUTION_DISABLED_TOOLS = new Set([
	SHELL_TOOL_NAME,
	"Shell",
	"Execute",
	"Agent",
	"Write",
	"Edit",
	"Browser",
	"Terminal",
	"ShareFile",
	"NarraForkAdmin",
	"ForkNarrator",
]);

function shouldEagerExecuteTool(tu: AgentToolUse): boolean {
	if (EAGER_EXECUTION_DISABLED_TOOLS.has(tu.name)) return false;
	// Reflection decision tools (TaskReflectConfirm/Revise, ExitPlanConfirm/Revise,
	// DangerConfirm/Cancel, …) settle a pending decision whose resolution aborts the
	// reflection loop's own AbortController. Executing them eagerly mid-stream aborts the
	// reflection provider.chat() while it is still in flight, which records a spurious
	// "Aborted" API request in usage history. Defer them to the post-stream tool phase so
	// the reflection request records a clean success (via finishRequest) before the tool
	// settles the decision and triggers the expected abort.
	if (toolRegistry.get(tu.name)?.reflectionOnly === true) return false;
	return true;
}

/** Whether a tool use should skip parallel grouping and early execution. */
function isStrictSerial(tu: AgentToolUse): boolean {
	return (
		(tu.name === SHELL_TOOL_NAME && tu.input.strict_serial === true) ||
		tu.name === "StartPipeline" ||
		tu.name === "EndPipeline" ||
		tu.name === "ExitPlanMode"
	);
}

type ReasoningBlockEntry = {
	text: string;
	providerMetadata?: ReasoningProviderMetadata;
	outputIndex?: number;
	/** When true, the next reasoning delta should be preceded by a separator. */
	_needsSeparator?: boolean;
};

function reasoningBlockKey(event: {
	reasoningMetadata?: ReasoningProviderMetadata;
	reasoningOutputIndex?: number;
}): string {
	const openaiItemId = event.reasoningMetadata?.openai?.itemId;
	if (openaiItemId) return `openai:${openaiItemId}`;

	const anthropicBlockIndex = event.reasoningMetadata?.anthropic?.blockIndex;
	if (anthropicBlockIndex != null) return `anthropic:${anthropicBlockIndex}`;

	return "__default";
}

/**
 * Stamp the current upstream identity onto reasoning metadata that carries an
 * Anthropic thinking signature, so on replay we can tell which server minted it
 * and avoid echoing a signature to a different server (which fails
 * verification). Only anthropic-family channels produce signatures; for others
 * `source` is undefined and we leave the metadata untouched.
 */
function stampReasoningSource(
	metadata: ReasoningProviderMetadata | undefined,
	source: string | undefined,
): ReasoningProviderMetadata | undefined {
	if (!metadata || !source) return metadata;
	if (!metadata.anthropic?.signature) return metadata;
	if (metadata.signatureSource === source) return metadata;
	return { ...metadata, signatureSource: source };
}

/** Convert the per-itemId reasoning map to the blocks array expected by pushAssistantTurn. */
function collectReasoningBlocks(
	map: Map<string, ReasoningBlockEntry>,
): ReasoningBlockEntry[] | undefined {
	if (map.size === 0) return undefined;
	const blocks: ReasoningBlockEntry[] = [];
	for (const entry of map.values()) {
		if (entry.text || entry.providerMetadata) {
			// Strip internal-only _needsSeparator before passing to pushAssistantTurn
			const { _needsSeparator: _, ...block } = entry;
			blocks.push(block);
		}
	}
	return blocks.length > 0 ? blocks : undefined;
}

function collectCompletedWebSearches(
	map: Map<
		string,
		{
			query?: string;
			queries?: string[];
			emitted: boolean;
			outputIndex?: number;
			action?: import("./provider").WebSearchAction;
		}
	>,
):
	| Array<{
			id: string;
			query?: string;
			queries?: string[];
			outputIndex?: number;
			action?: import("./provider").WebSearchAction;
	  }>
	| undefined {
	const blocks: Array<{
		id: string;
		query?: string;
		queries?: string[];
		outputIndex?: number;
		action?: import("./provider").WebSearchAction;
	}> = [];
	for (const [id, entry] of map.entries()) {
		if (!entry.query && !entry.queries?.length && !entry.action) continue;
		blocks.push({
			id,
			query: entry.query,
			queries: entry.queries,
			outputIndex: entry.outputIndex,
			action: entry.action,
		});
	}
	return blocks.length > 0 ? blocks : undefined;
}

function collectCompletedImageGenerations(
	map: Map<
		string,
		{
			revisedPrompt?: string;
			result?: string;
			emitted: boolean;
			outputIndex?: number;
		}
	>,
):
	| Array<{
			id: string;
			revisedPrompt?: string;
			result?: string;
			outputIndex?: number;
	  }>
	| undefined {
	const blocks: Array<{
		id: string;
		revisedPrompt?: string;
		result?: string;
		outputIndex?: number;
	}> = [];
	for (const [id, entry] of map.entries()) {
		// Skip entries with no meaningful data (e.g. generation started but never completed)
		if (!entry.revisedPrompt && !entry.result) continue;
		blocks.push({
			id,
			revisedPrompt: entry.revisedPrompt,
			result: entry.result,
			outputIndex: entry.outputIndex,
		});
	}
	return blocks.length > 0 ? blocks : undefined;
}

function bulletList(items: string[]): string {
	return items.map((item) => `- ${item}`).join("\n");
}

function formatDangerDetails(details: string[] | undefined, locale: Locale): string {
	if (!details?.length) return "";
	return locale === "zh-CN"
		? `\n详情：\n${bulletList(details)}`
		: `\nDetails:\n${bulletList(details)}`;
}

function formatDangerReflectionLevelForPrompt(
	level: Exclude<DangerReflectionLevel, "off">,
	locale: Locale,
): string {
	if (locale === "zh-CN") {
		switch (level) {
			case "light":
				return "宽松";
			case "standard":
				return "中等";
			case "strict":
				return "严格";
		}
	}
	switch (level) {
		case "light":
			return "Light";
		case "standard":
			return "Medium";
		case "strict":
			return "Strict";
	}
}

function buildDangerReflectionLevelGuidance(
	level: Exclude<DangerReflectionLevel, "off">,
	locale: Locale,
): string {
	if (locale === "zh-CN") {
		switch (level) {
			case "light":
				return [
					"当前为宽松档：通常只会拦截高风险或关键风险。",
					"本轮反思应重点寻找真实的破坏性、状态变更、网络/供应链、权限提升、历史改写或外部路径风险。",
					"如果操作与用户意图明确一致、范围清楚、收益必要且没有明显误操作迹象，可以确认；不要因为只是存在抽象风险就取消。",
				].join("\n");
			case "standard":
				return [
					"当前为中等档：对中风险及以上操作做平衡审查。",
					"确认前必须同时满足：符合当前任务、仍有必要、目标范围明确、风险收益成立。",
					"如果存在实质更安全且不会丢失任务目标的替代方案，或者必要性不清楚，应取消。",
				].join("\n");
			case "strict":
				return [
					"当前为严格档：低风险也可能触发反思，审查应更保守，但不要机械拒绝。",
					"低影响、只读、边界明确且紧扣任务的操作可以确认；任何写入、删除、网络、供应链、外部路径或难以检查的副作用都需要更强的必要性证明。",
					"若上下文不足、命令可能过期/误复制、或替代方案能显著降低风险，应取消。",
				].join("\n");
		}
	}
	switch (level) {
		case "light":
			return [
				"Current level: Light. This level usually pauses only high or critical risks.",
				"Focus on real destructive, state-changing, network/supply-chain, privilege, history-rewrite, or external-path risk.",
				"If the operation clearly matches user intent, has a bounded scope, is necessary, and does not look accidental, you may confirm; do not cancel merely for abstract risk.",
			].join("\n");
		case "standard":
			return [
				"Current level: Medium. This level performs balanced review for medium and higher risks.",
				"Confirm only when the operation matches the current task, remains necessary, has a clear target scope, and has a justified risk/reward tradeoff.",
				"Cancel if a materially safer alternative preserves the task goal, or if necessity is unclear.",
			].join("\n");
		case "strict":
			return [
				"Current level: Strict. Even low-risk operations may pause, so be conservative but not mechanical.",
				"Low-impact, read-only, bounded, task-aligned operations can be confirmed; writes, deletions, network/supply-chain actions, external paths, or hard-to-inspect side effects require stronger necessity.",
				"Cancel when context is insufficient, the command may be stale/accidental, or a safer alternative materially reduces risk.",
			].join("\n");
	}
}

type DangerReflectionPermission = Extract<PermissionResult, { behavior: "dangerReflection" }>;

function buildDangerReflectionPrompt(
	pause: DangerReflectionPermission,
	toolName: string,
	input: Record<string, unknown>,
	locale: Locale,
): string {
	const reflectionLevel = pause.reflectionLevel ?? "standard";
	return getPrompt("dangerReflection", locale)
		.replaceAll("{requestId}", pause.requestId)
		.replaceAll("{toolName}", toolName)
		.replaceAll("{inputJson}", JSON.stringify(input, null, 2))
		.replaceAll("{severity}", pause.danger.severity)
		.replaceAll("{reflectionLevel}", formatDangerReflectionLevelForPrompt(reflectionLevel, locale))
		.replaceAll("{levelGuidance}", buildDangerReflectionLevelGuidance(reflectionLevel, locale))
		.replaceAll("{summary}", pause.danger.summary)
		.replaceAll("{detailsSection}", formatDangerDetails(pause.danger.details, locale))
		.replaceAll("{consequencesList}", bulletList(pause.danger.consequences))
		.replaceAll("{alternativesList}", bulletList(pause.danger.saferAlternatives));
}

function formatAllowedPrompts(value: unknown): string {
	if (!Array.isArray(value) || value.length === 0) return "- (none)";
	const items = value.flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const tool = (entry as { tool?: unknown }).tool;
		const prompt = (entry as { prompt?: unknown }).prompt;
		if (typeof prompt !== "string" || !prompt.trim()) return [];
		return [`- ${typeof tool === "string" && tool ? `${tool}: ` : ""}${prompt.trim()}`];
	});
	return items.length > 0 ? items.join("\n") : "- (none)";
}

type ExitPlanReflectionAutoCompactConfig = Pick<AgentConfig, "planReflectionAllowAutoCompact">;

export function shouldAllowExitPlanReflectionAutoCompact(
	config: Partial<ExitPlanReflectionAutoCompactConfig> = {},
): boolean {
	return config.planReflectionAllowAutoCompact ?? settings.agent.planReflectionAllowAutoCompact;
}

export function getExitPlanReflectionAllowedTools(
	config: Partial<ExitPlanReflectionAutoCompactConfig> = {},
): string[] {
	const allowedTools = [...EXIT_PLAN_REFLECTION_TOOLS];
	if (shouldAllowExitPlanReflectionAutoCompact(config)) {
		allowedTools.push(EXIT_PLAN_CONFIRM_COMPACT_TOOL_NAME);
	}
	return allowedTools;
}

export function buildExitPlanReflectionPrompt(
	requestId: string,
	input: Record<string, unknown>,
	locale: Locale,
	config: Partial<ExitPlanReflectionAutoCompactConfig> = {},
): string {
	const planText = typeof input.plan === "string" ? input.plan : "";
	const basePrompt = getPrompt("exitPlanReflection", locale)
		.replaceAll("{requestId}", requestId)
		.replaceAll("{inputJson}", JSON.stringify(input, null, 2))
		.replaceAll("{planText}", planText)
		.replaceAll("{allowedPromptsList}", formatAllowedPrompts(input.allowedPrompts));
	if (!shouldAllowExitPlanReflectionAutoCompact(config)) return basePrompt;
	return `${basePrompt}\n\n${getPrompt("exitPlanReflectionAutoCompact", locale)}`;
}

function buildTaskReflectionPrompt(
	requestId: string,
	input: Record<string, unknown>,
	mutations: unknown[],
	locale: Locale,
): string {
	if (locale === "zh-CN") {
		return `你正在进行 taskReflection。主叙述者准备修改 spec://tasks.json 中的 protected task。\n\n请求 ID：${requestId}\n\n工具输入：\n${JSON.stringify(input, null, 2)}\n\n受影响的 protected task：\n${JSON.stringify(mutations, null, 2)}\n\n请只调用一个工具：\n- 如果有具体证据证明这些 protected task 已完成，或删除/替换不会削弱用户意图，调用 TaskReflectConfirm。\n- 如果证据不足、任务未完成，或变更会削弱用户意图，调用 TaskReflectRevise。\n\n必须保守处理用户意愿：不能因为任务看起来麻烦就完成、删除或改写 protected task。`;
	}
	return `You are running taskReflection. The main narrator is about to change protected task(s) in spec://tasks.json.\n\nRequest ID: ${requestId}\n\nTool input:\n${JSON.stringify(input, null, 2)}\n\nAffected protected task mutations:\n${JSON.stringify(mutations, null, 2)}\n\nCall exactly one tool:\n- TaskReflectConfirm only if there is concrete evidence that the protected task is complete, or that the delete/replacement is necessary and does not weaken user intent.\n- TaskReflectRevise if evidence is missing, the task is not complete, or the change weakens user intent.\n\nBe conservative about user intent: protected tasks must not be completed, deleted, or rewritten merely because they are inconvenient.`;
}

export interface ReflectionLoopRunOptions {
	parentConfig: AgentConfig;
	history: unknown[];
	prompt: string;
	reflectionLoop: NonNullable<AgentConfig["reflectionLoop"]>;
	abortController?: AbortController;
	maxTurns?: number;
	label?: string;
}

export interface ReflectionLoopObservation {
	assistantMessages: number;
	assistantText: string;
	assistantTextPreview: string;
	toolCalls: string[];
	toolResults: Array<{ toolName: string; isError: boolean; outputPreview: string }>;
	errors: string[];
	invalidStates: string[];
}

type ApiRequestEndEvent = Extract<AgentEvent, { type: "api_request_end" }>;

function normalizeApiRequestUsage(usage: ApiRequestEndEvent["usage"]) {
	if (!usage) return null;
	return {
		inputTokens: usage.inputTokens ?? usage.promptTokens ?? 0,
		outputTokens: usage.completionTokens ?? 0,
		cachedInputTokens: usage.cachedInputTokens ?? 0,
		cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
		cacheCreation5mInputTokens: usage.cacheCreation5mTokens ?? 0,
		cacheCreation1hInputTokens: usage.cacheCreation1hTokens ?? 0,
		reasoningTokens: usage.reasoningTokens ?? 0,
	};
}

async function recordReflectionApiRequestEnd(
	pendingApiRequests: Map<string, ApiRequestHandle>,
	event: ApiRequestEndEvent,
	parentConfig: AgentConfig,
	label: string,
): Promise<void> {
	const requestInfo = pendingApiRequests.get(event.requestId);
	if (!requestInfo) {
		logger.warn("Reflection API request end without start", {
			narratorId: parentConfig.narratorId,
			requestId: event.requestId,
			label,
		});
		return;
	}

	try {
		await finishApiRequest(requestInfo, {
			usage: normalizeApiRequestUsage(event.usage),
			credentialId: event.credentialId,
			ttftMs: event.ttftMs ?? null,
			durationMs: event.durationMs ?? null,
			contextPercent: event.contextPercent ?? null,
			meterUsage: event.meterUsage ?? null,
			meterUnit: event.meterUnit ?? null,
			errorMessage: event.errorMessage ?? null,
			rawDump: event.rawDump,
		});
	} catch (error) {
		logger.warn("Failed to record reflection API request", {
			narratorId: parentConfig.narratorId,
			requestId: event.requestId,
			apiRequestId: requestInfo.id,
			label,
			error: String(error),
		});
	} finally {
		pendingApiRequests.delete(event.requestId);
	}
}

async function recordUnfinishedReflectionApiRequests(
	pendingApiRequests: Map<string, ApiRequestHandle>,
	parentConfig: AgentConfig,
	label: string,
): Promise<void> {
	for (const [requestId, requestInfo] of pendingApiRequests) {
		try {
			await finishApiRequest(requestInfo, {
				errorMessage: `${label} ended before the API request completed`,
			});
		} catch (error) {
			logger.warn("Failed to record unfinished reflection API request", {
				narratorId: parentConfig.narratorId,
				requestId,
				apiRequestId: requestInfo.id,
				label,
				error: String(error),
			});
		}
	}
	pendingApiRequests.clear();
}

/**
 * Run a bounded nested agent loop for model self-checks or small decision gates.
 * The nested loop gets an isolated tool allowlist and no parent event/prompt hooks,
 * so callers can reuse the pattern without hand-rolling another agentLoop wrapper.
 */
export async function runReflectionLoop(
	options: ReflectionLoopRunOptions,
): Promise<ReflectionLoopObservation> {
	const {
		parentConfig,
		history,
		prompt,
		reflectionLoop,
		abortController = new AbortController(),
		maxTurns = 1,
		label = "reflection loop",
	} = options;
	const allowedTools = new Set(reflectionLoop.allowedTools);
	const pendingApiRequests = new Map<string, ApiRequestHandle>();
	const observed: ReflectionLoopObservation = {
		assistantMessages: 0,
		assistantText: "",
		assistantTextPreview: "",
		toolCalls: [],
		toolResults: [],
		errors: [],
		invalidStates: [],
	};
	const onParentAbort = () => abortController.abort();
	parentConfig.signal.addEventListener("abort", onParentAbort, { once: true });
	try {
		const reflectionConfig: AgentConfig = {
			...parentConfig,
			signal: abortController.signal,
			maxTurns,
			reflectionLoop,
			onEvent: undefined,
			onBeforeTurn: undefined,
			getSideCars: undefined,
			silentToolCallThreshold: -1,
			shouldStop: undefined,
			toolFilter: undefined,
			permissionHandler: async (toolName) => {
				if (allowedTools.has(toolName)) return { behavior: "allow" };
				return {
					behavior: "deny",
					rawMessage: true,
					message:
						`Reflection loop can only call allowed tools (${reflectionLoop.allowedTools.join(", ")}). ` +
						`Tool "${toolName}" is not allowed in this reflection loop.`,
				};
			},
		};
		for await (const event of agentLoop(reflectionConfig, prompt, [...history])) {
			if (event.type === "api_request_start") {
				pendingApiRequests.set(
					event.requestId,
					startApiRequest({
						narratorId: parentConfig.narratorId,
						provider: event.provider,
						model: event.model,
						credentialId: event.credentialId,
						kind: "reflection",
					}),
				);
				continue;
			}
			if (event.type === "api_request_end") {
				await recordReflectionApiRequestEnd(pendingApiRequests, event, parentConfig, label);
				continue;
			}
			if (event.type === "assistant_message") {
				observed.assistantMessages++;
				if (event.text) {
					observed.assistantText = `${observed.assistantText}${event.text}`.slice(0, 4000);
				}
				if (!observed.assistantTextPreview && event.text) {
					observed.assistantTextPreview = event.text.slice(0, 500);
				}
				for (const toolUse of event.toolUses) {
					observed.toolCalls.push(toolUse.name);
				}
			} else if (event.type === "tool_call") {
				observed.toolCalls.push(event.toolName);
			} else if (event.type === "tool_result") {
				observed.toolResults.push({
					toolName: event.toolName,
					isError: event.isError,
					outputPreview: event.output.slice(0, 500),
				});
			} else if (event.type === "invalid_state") {
				observed.invalidStates.push(`${event.reason}: ${event.message}`);
			} else if (event.type === "error") {
				observed.errors.push(event.message);
				logger.warn(`${label} ended with error`, {
					narratorId: parentConfig.narratorId,
					kind: reflectionLoop.context.kind,
					requestId: reflectionLoop.context.requestId,
					message: event.message,
				});
			}
		}
		if (observed.toolCalls.length === 0 || observed.toolResults.some((result) => result.isError)) {
			logger.warn(`${label} completed without a successful reflection tool decision`, {
				narratorId: parentConfig.narratorId,
				kind: reflectionLoop.context.kind,
				requestId: reflectionLoop.context.requestId,
				allowedTools: reflectionLoop.allowedTools,
				...observed,
			});
		}
		return observed;
	} finally {
		await recordUnfinishedReflectionApiRequests(pendingApiRequests, parentConfig, label);
		parentConfig.signal.removeEventListener("abort", onParentAbort);
	}
}

async function runDangerReflectionLoop(
	parentConfig: AgentConfig,
	history: unknown[],
	pause: DangerReflectionPermission,
	toolUse: AgentToolUse,
	reflectionAbort: AbortController,
): Promise<ReflectionLoopObservation> {
	const locale = (parentConfig.locale as Locale) ?? "en";
	return runReflectionLoop({
		parentConfig,
		history,
		prompt: buildDangerReflectionPrompt(pause, toolUse.name, pause.input, locale),
		reflectionLoop: {
			allowedTools: [...DANGER_REFLECTION_TOOLS],
			context: {
				kind: "dangerReflection",
				requestId: pause.requestId,
				toolUseId: toolUse.toolUseId,
				data: {
					toolName: toolUse.name,
					fingerprint: pause.fingerprint,
				},
			},
		},
		abortController: reflectionAbort,
		maxTurns: 1,
		label: "Danger reflection loop",
	});
}

async function runExitPlanModeReflectionLoop(
	parentConfig: AgentConfig,
	history: unknown[],
	requestId: string,
	toolUse: AgentToolUse,
	input: Record<string, unknown>,
	reflectionAbort: AbortController,
): Promise<void> {
	const locale = (parentConfig.locale as Locale) ?? "en";
	await runReflectionLoop({
		parentConfig,
		history,
		prompt: buildExitPlanReflectionPrompt(requestId, input, locale, parentConfig),
		reflectionLoop: {
			allowedTools: getExitPlanReflectionAllowedTools(parentConfig),
			context: {
				kind: "exitPlanMode",
				requestId,
				toolUseId: toolUse.toolUseId,
				data: {
					toolName: toolUse.name,
				},
			},
		},
		abortController: reflectionAbort,
		maxTurns: 1,
		label: "ExitPlanMode reflection loop",
	});
}

async function runTaskReflectionLoop(
	parentConfig: AgentConfig,
	history: unknown[],
	requestId: string,
	toolUse: AgentToolUse,
	input: Record<string, unknown>,
	mutations: unknown[],
	reflectionAbort: AbortController,
): Promise<void> {
	const locale = (parentConfig.locale as Locale) ?? "en";
	await runReflectionLoop({
		parentConfig,
		history,
		prompt: buildTaskReflectionPrompt(requestId, input, mutations, locale),
		reflectionLoop: {
			allowedTools: [...TASK_REFLECTION_TOOLS],
			context: {
				kind: "taskReflection",
				requestId,
				toolUseId: toolUse.toolUseId,
				data: {
					toolName: toolUse.name,
				},
			},
		},
		abortController: reflectionAbort,
		maxTurns: 1,
		label: "Task reflection loop",
	});
}

function parseDangerReflectionTextFallback(
	text: string,
): { action: "confirm"; reflection?: string } | { action: "cancel"; reason?: string } | null {
	const match = text.match(/<DangerDecision>\s*([\s\S]*?)\s*<\/DangerDecision>/i);
	if (!match) return null;
	try {
		const parsed = JSON.parse(match[1]) as {
			action?: unknown;
			reflection?: unknown;
			reason?: unknown;
		};
		if (parsed.action === "confirm") {
			return {
				action: "confirm",
				reflection: typeof parsed.reflection === "string" ? parsed.reflection : undefined,
			};
		}
		if (parsed.action === "cancel") {
			return {
				action: "cancel",
				reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
			};
		}
	} catch {
		return null;
	}
	return null;
}

async function setDangerReflectionAbortController(
	requestId: string,
	reflectionAbortController: AbortController,
): Promise<void> {
	const { pendingDangerReflections } = await import("@server/services/narrator-session-state");
	const pending = pendingDangerReflections.get(requestId);
	if (pending) pending.reflectionAbortController = reflectionAbortController;
}

async function isDangerReflectionWaitingForUser(requestId: string): Promise<boolean> {
	const { pendingDangerReflections } = await import("@server/services/narrator-session-state");
	return pendingDangerReflections.get(requestId)?.reflectionStoppedByUser === true;
}

async function resolveDangerReflectionDecision(
	config: AgentConfig,
	history: unknown[],
	pause: DangerReflectionPermission,
	toolUse: AgentToolUse,
): Promise<PermissionResult> {
	const reflectionAbort = new AbortController();
	await setDangerReflectionAbortController(pause.requestId, reflectionAbort);
	let reflectionDone = false;
	const reflectionPromise = runDangerReflectionLoop(
		config,
		history,
		pause,
		toolUse,
		reflectionAbort,
	).finally(() => {
		reflectionDone = true;
	});
	const decision = await Promise.race([
		pause.decision.finally(() => reflectionAbort.abort()),
		reflectionPromise.then(async (observed) => {
			if (await isDangerReflectionWaitingForUser(pause.requestId)) {
				return pause.decision;
			}

			const textFallback = parseDangerReflectionTextFallback(observed.assistantText);
			if (textFallback) {
				const { cancelDangerReflection, confirmDangerReflection } = await import(
					"@server/services/narrator-permission"
				);
				const resolved =
					textFallback.action === "confirm"
						? await confirmDangerReflection(pause.requestId, textFallback.reflection)
						: await cancelDangerReflection(pause.requestId, textFallback.reason);
				if (resolved) return pause.decision;
			}

			const fallbackMessage =
				"Danger reflection loop did not call DangerConfirm or DangerCancel in its single allowed response";
			const { cancelDangerReflection } = await import("@server/services/narrator-permission");
			const cancelled = await cancelDangerReflection(pause.requestId, fallbackMessage);
			if (cancelled) return pause.decision;

			// If the cancellation path could not find the pending request, do not leave the
			// parent narrator waiting on an unresolved decision. Prefer an already-settled
			// decision (e.g. the user resolved it at the same time); otherwise fail closed.
			const alreadySettled = await Promise.race<PermissionResult | null>([
				pause.decision,
				Promise.resolve(null),
			]);
			const fallbackDecision: PermissionResult = { behavior: "deny", message: fallbackMessage };
			return alreadySettled ?? fallbackDecision;
		}),
	]);
	if (!reflectionDone) {
		reflectionPromise.catch((err) => {
			logger.warn("Danger reflection loop cleanup failed", { err: String(err) });
		});
	}
	return decision;
}

interface ExitPlanReflectionGateResult {
	decision: ExitPlanReflectionDecision | { action: "manual"; reason?: string };
	input: Record<string, unknown>;
}

async function resolveExitPlanModeReflection(
	config: AgentConfig,
	history: unknown[],
	toolUse: AgentToolUse,
): Promise<ExitPlanReflectionGateResult> {
	const locale = (config.locale as Locale) ?? "en";
	const { resolveExitPlanModeInput } = await import("@server/services/narrator-permission");
	const resolvedInput = resolveExitPlanModeInput(
		config.narratorId,
		config.cwd,
		toolUse.input,
		locale,
	);
	if (!resolvedInput.ok) {
		return {
			decision: { action: "revise", feedback: resolvedInput.message },
			input: resolvedInput.input,
		};
	}

	const requestId = `exit_plan_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
	const reflectionAbort = new AbortController();
	const decisionPromise = createExitPlanReflectionDecision(requestId, {
		narratorId: config.narratorId,
		broadcastTargetId: config.parentNarratorId ?? config.narratorId,
		toolUseId: toolUse.toolUseId,
		toolName: toolUse.name,
		inputJson: resolvedInput.input,
		abortController: reflectionAbort,
	});
	await markExitPlanReflectionStarted(requestId);
	let reflectionDone = false;
	const reflectionPromise = runExitPlanModeReflectionLoop(
		config,
		history,
		requestId,
		toolUse,
		resolvedInput.input,
		reflectionAbort,
	).finally(() => {
		reflectionDone = true;
	});
	const decision = await Promise.race([
		decisionPromise.finally(() => reflectionAbort.abort()),
		reflectionPromise
			.catch((err) => {
				logger.warn("ExitPlanMode reflection loop ended unexpectedly", { err: String(err) });
			})
			.then(async () => {
				if (isExitPlanReflectionWaitingForUser(requestId)) {
					return { action: "manual" as const };
				}
				const fallbackMessage =
					"ExitPlanMode reflection loop did not call ExitPlanConfirm or ExitPlanRevise in its single allowed response";
				const cancelled = await cancelExitPlanReflection(requestId, fallbackMessage);
				if (cancelled) return decisionPromise;

				// Prefer an already-settled decision if the tool resolved concurrently;
				// otherwise fail closed and ask the model to revise before user approval.
				const alreadySettled = await Promise.race<ExitPlanReflectionDecision | null>([
					decisionPromise,
					Promise.resolve(null),
				]);
				const fallbackDecision: ExitPlanReflectionDecision = {
					action: "revise",
					feedback: fallbackMessage,
				};
				return alreadySettled ?? fallbackDecision;
			}),
	]);
	if (!reflectionDone) {
		reflectionPromise.catch((err) => {
			logger.warn("ExitPlanMode reflection loop cleanup failed", { err: String(err) });
		});
	}
	cleanupExitPlanReflection(requestId);
	return { decision, input: resolvedInput.input };
}

function resolvePlanReflectionAutoApprove(
	config: Pick<AgentConfig, "planReflectionAutoApprove" | "planReflectionAutoApproveOverride">,
): boolean {
	if (config.planReflectionAutoApproveOverride !== undefined) {
		return resolveBooleanOverride(
			config.planReflectionAutoApproveOverride,
			settings.agent.planReflectionAutoApprove,
		);
	}
	return config.planReflectionAutoApprove ?? settings.agent.planReflectionAutoApprove;
}

export function shouldRunExitPlanModeReflection(
	config: Pick<
		AgentConfig,
		| "reflectionLoop"
		| "permissionMode"
		| "planReflectionAutoApprove"
		| "planReflectionAutoApproveOverride"
	>,
): boolean {
	return (
		resolvePlanReflectionAutoApprove(config) &&
		!config.reflectionLoop &&
		(config.permissionMode === "acceptEdits" || config.permissionMode === "bypassPermissions")
	);
}

export function shouldRunTaskReflection(config: Pick<AgentConfig, "reflectionLoop">): boolean {
	return !config.reflectionLoop;
}

function normalizeEditText(text: string): string {
	return text.replaceAll("\r\n", "\n");
}

async function buildSpecTasksCandidateContent(
	narratorId: string,
	toolUse: AgentToolUse,
): Promise<string | null> {
	const input = toolUse.input as Record<string, unknown>;
	const filePath = typeof input.file_path === "string" ? input.file_path : null;
	if (!filePath || !specVfsService.isSpecUri(filePath)) return null;
	let specPath: string;
	try {
		specPath = specVfsService.normalizeSpecPath(filePath);
	} catch {
		return null;
	}
	if (specPath !== "tasks.json") return null;
	if (toolUse.name === "Write") {
		return typeof input.content === "string" ? input.content : null;
	}
	if (toolUse.name !== "Edit") return null;
	const oldString = typeof input.old_string === "string" ? input.old_string : null;
	const newString = typeof input.new_string === "string" ? input.new_string : null;
	const replaceAll = input.replace_all === true;
	if (oldString == null || newString == null) return null;
	if (oldString === "") return normalizeEditText(newString);
	try {
		const current = await specVfsService.readSpecFile(narratorId, filePath);
		return applyEditReplacement(
			normalizeEditText(current.content),
			normalizeEditText(oldString),
			normalizeEditText(newString),
			replaceAll,
		).content;
	} catch (err) {
		logger.debug("Skipping taskReflection preflight because candidate edit could not be built", {
			toolUseId: toolUse.toolUseId,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

function buildExitPlanReflectionDeniedToolResult(
	decision: ExitPlanReflectionDecision,
	locale: Locale,
): ToolExecResult {
	const feedback =
		decision.action === "revise" && decision.feedback.trim()
			? decision.feedback.trim()
			: "ExitPlanMode reflection requested plan revision before user approval.";
	const output =
		locale === "zh-CN"
			? `ExitPlanMode 反思认为计划还不应提交给用户审批。请先修改计划。\n\n反馈：${feedback}`
			: `ExitPlanMode reflection decided the plan should not be submitted for user approval yet. Revise the plan first.\n\nFeedback: ${feedback}`;
	return {
		output,
		isError: true,
		durationMs: 0,
		completedAt: Date.now(),
	};
}

function buildTaskReflectionDeniedToolResult(
	decision: TaskReflectionDecision,
	locale: Locale,
): ToolExecResult {
	const feedback =
		decision.action === "revise" && decision.feedback.trim()
			? decision.feedback.trim()
			: "Task reflection found that the protected task change is not justified.";
	const nextSteps =
		decision.action === "revise" && decision.nextSteps?.trim()
			? decision.nextSteps.trim()
			: "Continue working and only modify protected tasks after concrete evidence supports the change.";
	const output =
		locale === "zh-CN"
			? `任务反思认为 protected task 不能这样修改。\n\n反馈：${feedback}\n\n下一步：${nextSteps}`
			: `Task reflection decided the protected task change should not proceed.\n\nFeedback: ${feedback}\n\nNext steps: ${nextSteps}`;
	return { output, isError: true, durationMs: 0, completedAt: Date.now() };
}

/**
 * Append the task-reflection confirmation (evidence + optional reflection) to a
 * successful tool output so the main model sees why the protected change was allowed.
 */
function appendTaskReflectionConfirmation(
	output: string,
	decision: TaskReflectionDecision,
	locale: Locale,
): string {
	if (decision.action !== "confirm") return output;
	const evidence = decision.evidence.trim();
	const reflection = decision.reflection?.trim();
	const lines =
		locale === "zh-CN"
			? [`[taskReflection] 已确认此 protected task 变更。`, `证据：${evidence}`]
			: [`[taskReflection] Confirmed this protected task change.`, `Evidence: ${evidence}`];
	if (reflection) {
		lines.push(locale === "zh-CN" ? `说明：${reflection}` : `Reflection: ${reflection}`);
	}
	return `${output}\n\n${lines.join("\n")}`;
}

async function resolveTaskReflection(
	config: AgentConfig,
	history: unknown[],
	toolUse: AgentToolUse,
	candidateContent: string,
): Promise<{ decision: TaskReflectionDecision; input: Record<string, unknown> } | null> {
	const input = toolUse.input as Record<string, unknown>;
	const filePath = typeof input.file_path === "string" ? input.file_path : "spec://tasks.json";
	const analysis = await specVfsService.analyzeSpecWriteCandidate(
		config.narratorId,
		filePath,
		candidateContent,
	);
	if (analysis.protectedMutations.length === 0) return null;

	const requestId = `task_reflect_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
	const reflectionAbort = new AbortController();
	const decisionPromise = createTaskReflectionDecision(requestId, {
		narratorId: config.narratorId,
		broadcastTargetId: config.parentNarratorId ?? config.narratorId,
		toolUseId: toolUse.toolUseId,
		toolName: toolUse.name,
		inputJson: input,
		mutations: analysis.protectedMutations,
		abortController: reflectionAbort,
	});
	await markTaskReflectionStarted(requestId);
	let reflectionDone = false;
	const reflectionPromise = runTaskReflectionLoop(
		config,
		history,
		requestId,
		toolUse,
		input,
		analysis.protectedMutations,
		reflectionAbort,
	)
		.catch((err) => {
			logger.warn("Task reflection loop ended unexpectedly", { err: String(err) });
		})
		.finally(() => {
			reflectionDone = true;
		});
	const decision = await Promise.race([
		decisionPromise.finally(() => reflectionAbort.abort()),
		reflectionPromise.then(async () => {
			// The user took over: hand the decision to their approve/deny instead of
			// letting the AI reflection fall back (mirrors danger/plan takeover).
			if (isTaskReflectionWaitingForUser(requestId)) return decisionPromise;

			const fallbackMessage =
				"taskReflection loop did not call TaskReflectConfirm or TaskReflectRevise in its single allowed response.";
			const fallbackNextSteps =
				"Review the protected task, gather concrete evidence, and try the tasks.json change again only if it remains justified.";
			// Broadcast a resolved (cancelled) state so live clients converge instead of
			// showing a perpetually-running reflection notice.
			const cancelled = await reviseTaskReflection(requestId, fallbackMessage, fallbackNextSteps);
			if (cancelled) return decisionPromise;

			const alreadySettled = await Promise.race<TaskReflectionDecision | null>([
				decisionPromise,
				Promise.resolve(null),
			]);
			const fallbackDecision: TaskReflectionDecision = {
				action: "revise",
				feedback: fallbackMessage,
				nextSteps: fallbackNextSteps,
			};
			return alreadySettled ?? fallbackDecision;
		}),
	]);
	if (!reflectionDone) {
		reflectionPromise.catch((err) => {
			logger.warn("Task reflection loop cleanup failed", { err: String(err) });
		});
	}
	cleanupTaskReflection(requestId);
	return { decision, input };
}

async function executeToolAfterReflections(
	tu: AgentToolUse,
	config: AgentConfig,
	history: unknown[],
	locale: Locale,
): Promise<ToolExecResult> {
	if (tu.name === "ExitPlanMode" && shouldRunExitPlanModeReflection(config)) {
		const reflected = await resolveExitPlanModeReflection(config, history, tu);
		if (reflected.decision.action === "manual") {
			tu.input = reflected.input;
			// User manually took over the plan reflection; the loop falls back to the
			// normal ExitPlanMode approval. They are already driving this, so the
			// fallback permission request must not raise a user-facing notification.
			return executeTool(tu, config, { suppressAttention: true });
		}
		if (
			reflected.decision.action !== "confirm" &&
			reflected.decision.action !== "confirm_compact"
		) {
			return buildExitPlanReflectionDeniedToolResult(reflected.decision, locale);
		}

		const shouldCompact = reflected.decision.action === "confirm_compact";
		if (shouldCompact) {
			const { pendingPlanCompact } = await import("@server/services/narrator-session-state");
			pendingPlanCompact.add(config.narratorId);
		}

		// Reflection confirmed — skip user approval and execute directly.  Keep tu.input as the
		// original model input so executeTool emits updatedInput and the event handler persists
		// the resolved plan before onExitPlanMode reads it for optional plan compact.
		const result = await executeTool(tu, config, {
			preGrantedPermission: { behavior: "allow", updatedInput: { ...reflected.input } },
		});
		if (shouldCompact && result.isError) {
			const { pendingPlanCompact } = await import("@server/services/narrator-session-state");
			pendingPlanCompact.delete(config.narratorId);
		}
		return result;
	}
	if ((tu.name === "Write" || tu.name === "Edit") && shouldRunTaskReflection(config)) {
		const candidateContent = await buildSpecTasksCandidateContent(config.narratorId, tu);
		if (candidateContent != null) {
			try {
				// taskReflection persists permission-like status on the original tool-call row.
				// Freeze the deterministic spec:// execution identity first so the later
				// executeTool pass can only confirm the same target, never assign it late.
				await freezeToolExecutionTarget(tu, config);
			} catch (err) {
				return {
					output: `Tool routing error: ${err instanceof Error ? err.message : String(err)}`,
					isError: true,
					durationMs: 0,
					completedAt: Date.now(),
				};
			}
			try {
				const reflected = await resolveTaskReflection(config, history, tu, candidateContent);
				if (reflected) {
					tu.input = reflected.input;
					if (reflected.decision.action !== "confirm") {
						return buildTaskReflectionDeniedToolResult(reflected.decision, locale);
					}
					grantTaskReflection(config.narratorId, tu.toolUseId);
					try {
						const result = await executeTool(tu, config);
						// Surface the reflection's conclusion back to the main model so it knows
						// on what basis the protected task change was allowed to proceed.
						if (!result.isError) {
							return {
								...result,
								output: appendTaskReflectionConfirmation(result.output, reflected.decision, locale),
							};
						}
						return result;
					} finally {
						consumeTaskReflectionGrant(config.narratorId, tu.toolUseId);
					}
				}
			} catch (err) {
				logger.debug("Skipping taskReflection preflight", {
					toolUseId: tu.toolUseId,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}
	return executeTool(tu, config);
}

/**
 * Core agent loop. Delegates all provider-specific logic to a ProviderAdapter.
 * Yields AgentEvent objects for the caller to consume.
 */
export async function* agentLoop(
	config: AgentConfig,
	userText: string,
	history: unknown[],
	initialToolResults?: unknown[],
	images?: Array<{ format: string; base64: string }>,
): AsyncGenerator<AgentEvent> {
	const resolvedProvider = resolveProviderAndModel(config.model);
	let provider = resolvedProvider.adapter;
	let effectiveModel = resolvedProvider.model;
	let effectiveProvider = resolvedProvider.provider;
	const maxTurns = config.maxTurns ?? settings.agent.maxTurns;
	const locale = (config.locale as Locale) ?? "en";

	// Permission checks must be serialized even when tools themselves are parallel-safe.
	// This prevents concurrent permission prompts / danger reflection loops from racing each other.
	const originalPermissionHandler = config.permissionHandler;
	let permissionTail: Promise<void> = Promise.resolve();
	config.permissionHandler = async (toolName, input, toolUseId, options) => {
		const run = permissionTail.then(async () => {
			const result = await originalPermissionHandler(toolName, input, toolUseId, options);
			if (result.behavior !== "dangerReflection") return result;

			return resolveDangerReflectionDecision(config, history, result, {
				toolUseId,
				name: toolName,
				input: result.input,
			});
		});
		permissionTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};

	let allTools: ResolvedToolDefinition[] = toolRegistry
		.all()
		.filter((t) => t.name && (!t.isAvailable || t.isAvailable()))
		.map((t) => ({
			...t,
			description: typeof t.description === "function" ? t.description(config) : t.description,
			rawJsonSchema: t.getRawJsonSchema ? t.getRawJsonSchema(config) : t.rawJsonSchema,
		}));

	if (config.reflectionLoop) {
		const allowedTools = new Set(config.reflectionLoop.allowedTools);
		allTools = allTools.filter((tool) => allowedTools.has(tool.name));
	} else {
		allTools = allTools.filter((tool) => !tool.reflectionOnly);
	}

	// Apply toolFilter if provided (used by subagents to restrict available tools)
	if (config.toolFilter) {
		allTools = allTools.filter(config.toolFilter);
	}

	// Keep SwitchDevice available for a stale remote default so the model can
	// recover by explicitly switching back to local. TransferFile still requires
	// at least one online remote endpoint.
	allTools = filterDeviceTools(allTools, config);

	// In plan mode, override descriptions for forbidden tools so the model knows not to call them.
	// When relaxedPlan is enabled, skip this — tools remain fully available.
	if (config.planMode && !config.relaxedPlan) {
		const disabledDesc = getToolMessage("planModeToolDisabled", locale);
		allTools = allTools.map((t) =>
			PLAN_MODE_ALLOWED_TOOLS.has(t.name)
				? t
				: {
						...t,
						description: disabledDesc,
					},
		);
	}

	function resolveToolsForProvider(
		providerName: string,
		modelName: string,
	): ResolvedToolDefinition[] {
		// Providers only hide the function-style WebSearch when the unified native-search
		// channel is currently enabled as the first search channel for this model.
		if (shouldUseNativeSearch(providerName, modelName)) {
			return allTools.filter((t) => t.name !== "WebSearch");
		}
		return allTools;
	}

	let tools = provider.formatTools(resolveToolsForProvider(effectiveProvider, effectiveModel));
	let pendingToolResults: unknown[] = initialToolResults ?? [];
	let turnIndex = 0;
	let completedToolCount = config.sideCarInitialCompletedToolCount ?? 0;
	const silentToolCallThreshold = normalizeSilentToolCallThreshold(config.silentToolCallThreshold);
	let silentToolCallCount = 0;
	const countedToolUseIds = new Set<string>();
	const sideCarCheckedToolUseIds = new Set<string>();
	const toolResultSideCarCache = new Map<string, AgentSideCar[]>();
	// Knowledge-base entry ids already injected this compact cycle (point B de-dup; shared
	// across tool outputs). Prefer the session-provided shared set so point A (user message)
	// and point B (tool output) de-dup together and the set survives across loop passes until
	// a compact boundary clears it. Falls back to a local set for standalone/test callers.
	const knowledgeInjectedEntryIds = config.knowledgeInjectedEntryIds ?? new Set<string>();

	function cacheToolResultSideCars(toolUseId: string, sideCars: AgentSideCar[]): AgentSideCar[] {
		toolResultSideCarCache.set(toolUseId, sideCars);
		return sideCars;
	}

	async function collectToolResultSideCars(
		tu: AgentToolUse,
		result: ToolExecResult,
	): Promise<AgentSideCar[]> {
		if (toolResultSideCarCache.has(tu.toolUseId)) {
			return toolResultSideCarCache.get(tu.toolUseId) ?? [];
		}

		const sideCars: AgentSideCar[] = [];

		if (!result.broken && !result.fatal) {
			silentToolCallCount++;
			if (silentToolCallThreshold >= 0 && silentToolCallCount >= silentToolCallThreshold) {
				sideCars.push({
					target: "tool_result",
					source: "silent_progress",
					content: getToolMessageWithParams("silentToolCallProgressReminder", locale, {
						count: silentToolCallCount,
					}),
					orderIndex: 10,
					toolUseId: tu.toolUseId,
				});
				silentToolCallCount = 0;
			}
		}

		if (result.broken || result.fatal) {
			return cacheToolResultSideCars(tu.toolUseId, sideCars);
		}
		if (await shouldInjectRelaxedPlanToolReminder(tu, config)) {
			sideCars.push({
				target: "tool_result",
				source: "relaxed_plan",
				content: getToolMessage("relaxedPlanToolReminder", locale),
				orderIndex: 20,
				toolUseId: tu.toolUseId,
			});
		}
		// Point B: scan this tool's output for relevant knowledge and inject a reminder.
		// Skip the knowledge tools themselves to avoid self-amplification.
		if (
			!tu.name.startsWith("Knowledge") &&
			typeof result.output === "string" &&
			result.output.length > 0
		) {
			try {
				const scan = await scanToolOutputForKnowledgeDetailed(
					config.userId,
					result.output,
					knowledgeInjectedEntryIds,
					{
						projectId: config.projectId ?? undefined,
					},
				);
				if (scan) {
					sideCars.push({
						target: "tool_result",
						source: "knowledge_base_hint",
						content: scan.content,
						orderIndex: 30,
						toolUseId: tu.toolUseId,
						knowledgeInjection: {
							narratorId: config.narratorId,
							compactSeq: config.knowledgeInjectionCompactSeq ?? -1,
							triggerToolCallId: tu.toolUseId,
							hits: scan.hits,
						},
					});
				}
			} catch (err) {
				logger.warn("Knowledge injection (tool output) failed", {
					narratorId: config.narratorId,
					toolUseId: tu.toolUseId,
					error: String(err),
				});
			}
		}
		if (!countedToolUseIds.has(tu.toolUseId)) {
			countedToolUseIds.add(tu.toolUseId);
			completedToolCount++;
			config.onSideCarCompletedToolCount?.(completedToolCount);
		}
		if (!config.getSideCars || sideCarCheckedToolUseIds.has(tu.toolUseId)) {
			return cacheToolResultSideCars(tu.toolUseId, sideCars);
		}
		sideCarCheckedToolUseIds.add(tu.toolUseId);
		try {
			const collected = await config.getSideCars({
				phase: "tool_result",
				toolName: tu.name,
				toolUseId: tu.toolUseId,
				completedToolCount,
			});
			sideCars.push(...collected.filter((sc) => sc.target === "tool_result"));
		} catch (err) {
			logger.warn("Failed to collect tool result sidecars", {
				narratorId: config.narratorId,
				toolUseId: tu.toolUseId,
				error: String(err),
			});
		}
		return cacheToolResultSideCars(tu.toolUseId, sideCars);
	}

	async function collectAfterToolsSideCars(): Promise<AgentSideCar[]> {
		if (!config.getSideCars) return [];
		try {
			const sideCars = await config.getSideCars({ phase: "after_tools" });
			return sideCars.filter((sc) => sc.target === "user_message");
		} catch (err) {
			logger.warn("Failed to collect after-tools sidecars", {
				narratorId: config.narratorId,
				error: String(err),
			});
		}
		return [];
	}

	// Shallow-copy to avoid mutating the caller's array
	history = [...history];

	// Inject system prompt via provider-specific mechanism
	if (config.systemPrompt) {
		provider.injectSystemPrompt(history, config.systemPrompt, effectiveModel, config.locale);
	}

	// Extra content to prepend to the next turn's user message (e.g. broken-tool reminder).
	// Consumed once and reset to empty after use.
	let nextTurnContent = "";

	// Retries for "reasoning-only" dead turns (model produced only reasoning, no text
	// and no tool calls). Declared at function scope so the ceiling is shared across
	// the turn boundary when a dead turn is recovered by injecting a "continue" turn.
	let reasoningOnlyRetries = 0;

	let resetUpstreamSessionOnNextRequest = !!config.resetUpstreamSessionOnFirstRequest;

	function applyHistoryReplacement(replacement: {
		history: unknown[];
		pendingToolResults: unknown[];
		systemPrompt?: string;
	}) {
		resetUpstreamSessionOnNextRequest = true;
		history = replacement.history;
		if (replacement.systemPrompt != null) {
			config.systemPrompt = replacement.systemPrompt;
		}
		if (config.systemPrompt) {
			provider.injectSystemPrompt(history, config.systemPrompt, effectiveModel, config.locale);
		}
		pendingToolResults = replacement.pendingToolResults;
	}

	function hasPendingRuntimeSettingsOverride(): boolean {
		const runtimeSettings = config.getRuntimeSettingsOverride?.();
		return Boolean(
			(runtimeSettings && Object.keys(runtimeSettings).length > 0) || config.getModelOverride?.(),
		);
	}

	async function applyPendingRuntimeSettings(
		cause: "turn" | "retry",
	): Promise<Extract<AgentEvent, { type: "model_switched" }> | null> {
		const settingsOverride = config.getRuntimeSettingsOverride?.() ?? null;
		const legacyModelOverride = config.getModelOverride?.() ?? null;
		const newModel = settingsOverride?.model || legacyModelOverride;
		const hasReasoningOverride =
			!!settingsOverride && Object.hasOwn(settingsOverride, "reasoningEffort");
		const nextReasoningEffort = hasReasoningOverride
			? (settingsOverride.reasoningEffort ?? undefined)
			: config.reasoningEffort;
		const reasoningChanged = hasReasoningOverride && nextReasoningEffort !== config.reasoningEffort;

		if (!newModel && !reasoningChanged) return null;

		try {
			let providerChanged = false;
			let modelChanged = false;
			if (newModel) {
				const newResolved = resolveProviderAndModel(newModel);
				providerChanged = newResolved.provider !== effectiveProvider;
				modelChanged = newResolved.model !== effectiveModel;
				provider = newResolved.adapter;
				effectiveModel = newResolved.model;
				effectiveProvider = newResolved.provider;
				config.model = newResolved.model;
				config.provider = newResolved.provider;
				if (providerChanged || modelChanged) {
					tools = provider.formatTools(resolveToolsForProvider(effectiveProvider, effectiveModel));
				}
			}

			if (hasReasoningOverride) {
				config.reasoningEffort = nextReasoningEffort;
			}

			if (providerChanged || modelChanged) {
				// Force history/tool-result rebuild so the next API call uses the new
				// provider protocol even when this switch happens inside a retry loop.
				const replacement = await config.onBeforeTurn?.(turnIndex, {
					force: true,
					cause: "model_switch",
				});
				if (replacement) {
					applyHistoryReplacement(replacement);
				} else if (config.systemPrompt && providerChanged) {
					provider.injectSystemPrompt(history, config.systemPrompt, effectiveModel, config.locale);
				}
			}

			logger.info("Agent loop switched runtime settings before API call", {
				narratorId: config.narratorId,
				cause,
				model: effectiveModel,
				provider: effectiveProvider,
				reasoningEffort: config.reasoningEffort,
				modelChanged,
				providerChanged,
				reasoningChanged,
			});
			return {
				type: "model_switched",
				model: effectiveModel,
				provider: effectiveProvider,
				reasoningEffort: config.reasoningEffort ?? null,
				cause,
			};
		} catch (err) {
			logger.warn("Failed to switch runtime settings during agent loop", {
				narratorId: config.narratorId,
				cause,
				model: newModel,
				reasoningEffort: settingsOverride?.reasoningEffort,
				error: String(err),
			});
			return null;
		}
	}

	turnLoop: while (turnIndex < maxTurns) {
		if (config.signal.aborted) {
			yield { type: "error", message: "Aborted" };
			return;
		}

		const isFirstTurn = turnIndex === 0;

		if (!isFirstTurn) {
			const switchEvent = await applyPendingRuntimeSettings("turn");
			if (switchEvent) {
				yield switchEvent;
			} else if (config.onBeforeTurn) {
				// Allow caller to rebuild history mid-loop (e.g. after prune boundary changes or compact)
				const replacement = await config.onBeforeTurn(turnIndex);
				if (replacement) {
					applyHistoryReplacement(replacement);
				}
			}
		}

		const content = isFirstTurn ? userText : nextTurnContent;
		nextTurnContent = ""; // consume once

		// Call provider and collect the response
		let assistantText = "";
		/** Provider-native content block index for the text block (for interleaved ordering). */
		let textOutputIndex: number | undefined;
		/**
		 * Reasoning blocks accumulated during streaming, keyed by itemId.
		 * Supports multiple reasoning items per turn (e.g. interleaved with tool calls).
		 * Falls back to a synthetic key "__default" for providers that don't supply itemId.
		 */
		const reasoningBlockMap = new Map<string, ReasoningBlockEntry>();
		const redactedThinkingBlocks: Array<{ data: string; outputIndex?: number }> = [];
		const toolUses: AgentToolUse[] = [];
		let messageId: string | undefined;
		let credentialId: string | undefined;
		// Map of tool executions started during streaming (toolUseId → Promise)
		const earlyExecMap = new Map<string, Promise<ToolExecResult>>();
		// Synchronously queryable map of settled early-exec results (populated via .then())
		const settledResults = new Map<string, ToolExecResult>();
		// Once a strict-serial tool appears, no later tool may start eager execution.
		// This mirrors the final group execution order and preserves serial side effects.
		let eagerExecutionBlocked = false;
		// Track which tool_results have already been yielded during streaming
		const yieldedToolResults = new Set<string>();
		// Track tool calls whose input was broken (output cut off mid-stream)
		const brokenToolUseIds = new Set<string>();
		// Accumulator for streaming tool use events (input arrives in chunks)
		const toolUseAccum = new Map<
			string,
			{
				name: string;
				inputChunks: string[];
				totalChars: number;
				startedAt: number;
				extractedFilePath?: string;
				extractedFields?: Record<string, string>;
				/** Metadata derived while tool input is still streaming (e.g. Edit match line). */
				streamingMetadata?: Record<string, unknown>;
				/** Name of the large field currently being streamed */
				activeStreamingField?: string;
				/** How many raw chars of the active field have been decoded and emitted so far */
				streamingFieldYielded: number;
				lastYieldedAt: number;
				/** Provider-native content block index for interleaved ordering. */
				outputIndex?: number;
			}
		>();
		// Accumulator for native web search calls (Codex web_search tool)
		const webSearchAccum = new Map<
			string,
			{
				query?: string;
				queries?: string[];
				emitted: boolean;
				outputIndex?: number;
				action?: import("./provider").WebSearchAction;
			}
		>();
		// Accumulator for native image generation calls (Codex image_generation tool)
		const imageGenAccum = new Map<
			string,
			{
				revisedPrompt?: string;
				result?: string;
				emitted: boolean;
				outputIndex?: number;
			}
		>();
		// Track whether the provider reported usage data during this turn
		let receivedUsage = false;

		async function* drainSettledEarlyToolResults(): AsyncGenerator<AgentEvent> {
			for (const tu of toolUses) {
				const settled = settledResults.get(tu.toolUseId);
				if (!settled || yieldedToolResults.has(tu.toolUseId)) continue;
				yieldedToolResults.add(tu.toolUseId);
				if (settled.broken) brokenToolUseIds.add(tu.toolUseId);
				if (settled.updatedInput) tu.input = settled.updatedInput;
				const brokenOverride = settled.broken
					? sanitizeBrokenInput(tu.name, tu.input, locale)
					: undefined;
				const toolSideCars = await collectToolResultSideCars(tu, settled);
				const baseOutput = settled.broken
					? getToolMessage("brokenToolCallResult", locale)
					: settled.output;
				yield {
					type: "tool_result",
					toolUseId: tu.toolUseId,
					toolName: tu.name,
					output: baseOutput,
					isError: settled.isError ?? false,
					durationMs: settled.durationMs,
					permissionStartedAt: settled.permissionStartedAt,
					executionStartedAt: settled.executionStartedAt,
					completedAt: settled.completedAt,
					brokenInputOverride: brokenOverride,
					updatedInput: brokenOverride ?? settled.updatedInput,
					metadata: settled.metadata,
					sideCars: toolSideCars.length > 0 ? toolSideCars : undefined,
				};
			}
		}

		async function* drainStartedEarlyToolResults(): AsyncGenerator<AgentEvent> {
			for (const tu of toolUses) {
				const earlyPromise = earlyExecMap.get(tu.toolUseId);
				if (earlyPromise && !settledResults.has(tu.toolUseId)) {
					settledResults.set(tu.toolUseId, await earlyPromise);
				}
			}
			yield* drainSettledEarlyToolResults();
		}

		function hasStartedEarlyToolExecution(): boolean {
			return earlyExecMap.size > 0 || yieldedToolResults.size > 0;
		}

		// API request tracking variables (moved outside retry loop)
		let requestId = "";
		let requestStartTime = 0;
		let requestTtftMs: number | undefined;
		let requestUsage:
			| {
					promptTokens?: number;
					inputTokens?: number;
					completionTokens?: number;
					reasoningTokens?: number;
					cachedInputTokens?: number;
					cacheCreationInputTokens?: number;
					cacheCreation5mTokens?: number;
					cacheCreation1hTokens?: number;
			  }
			| undefined;
		let requestContextPercent: number | undefined;
		let requestMeterUsage: number | undefined;
		let requestMeterUnit: string | undefined;
		let sawMeaningfulResponse = false;
		/** Tracks the most recent error message from a retried attempt.  When a
		 *  transient error (e.g. 429) triggers a retry and the subsequent attempt
		 *  returns an empty response, we surface this stored message instead of the
		 *  misleading "Provider returned an empty response" text.  Reset to
		 *  undefined only when a retry produces meaningful content. */
		let lastRetryErrorMessage: string | undefined;
		/** Set to true when the current attempt already yielded a terminal
		 *  error/invalid_state event.  Prevents the empty-response check from
		 *  running on the same iteration. */
		let sawErrorEvent = false;
		let requestDump: ApiRequestDumpCollector | undefined;
		/**
		 * Set when leaked XML tool calls are detected this turn (recovered or unrecovered),
		 * forcing the raw dump to persist regardless of the errors-only setting so the SSE
		 * data is downloadable for debugging.
		 */
		let forceDumpPersist = false;
		let requestStarted = false;
		let requestStartPending = false;
		let startFirstTokenTimerForAttempt: (() => void) | undefined;

		const markRequestStarted = (info?: { credentialId?: string }) => {
			if (info?.credentialId) {
				credentialId = info.credentialId;
			}
			if (requestStarted) return;
			requestStarted = true;
			requestStartPending = true;
			requestStartTime = Date.now();
			startFirstTokenTimerForAttempt?.();
		};

		function* flushRequestStart(): Generator<AgentEvent> {
			if (!requestStartPending) return;
			requestStartPending = false;
			yield {
				type: "api_request_start",
				requestId,
				provider: effectiveProvider,
				model: effectiveModel,
				credentialId,
			};
		}

		function* finishRequest(errorMessage?: string): Generator<AgentEvent> {
			if (!requestStarted) return;
			yield* flushRequestStart();
			yield {
				type: "api_request_end",
				requestId,
				credentialId,
				usage: requestUsage,
				ttftMs: requestTtftMs,
				durationMs: Date.now() - requestStartTime,
				contextPercent: requestContextPercent,
				meterUsage: requestMeterUsage,
				meterUnit: requestMeterUnit,
				rawDump: requestDump?.snapshot(),
				errorMessage,
				forceDumpPersist,
			};
		}

		// ── Transient-error retry loop ──
		// we can safely retry the exact same provider.chat() call with identical
		// history, content, and toolResults — no server-side state was mutated.
		// Stateful providers (responses/codex) cannot retry here because the
		// server already consumed the request.
		const maxConfiguredRetries = config.maxTransientRetries ?? 0;
		const getMaxChatRetries = () =>
			usesStatefulModel(effectiveProvider, effectiveModel) ? 0 : maxConfiguredRetries;
		const maxFirstTokenRetries = maxConfiguredRetries;
		const backoffCeil = config.retryBackoffCeilMs ?? 20_000;
		const firstTokenTimeoutMs = Math.max(0, config.firstTokenTimeoutMs ?? 300_000);
		let chatRetryCount = 0;
		let emptyResponseRetries = 0;
		/** Set when a mimo model returns "..." as reasoning — triggers a retry. */
		let mimoEllipsisRetry = false;
		const resetRetryStateAfterModelSwitch = () => {
			chatRetryCount = 0;
			emptyResponseRetries = 0;
			reasoningOnlyRetries = 0;
			lastRetryErrorMessage = undefined;
		};

		for (;;) {
			// Reset per-attempt accumulators so a retry starts with a clean slate.
			// (On the first attempt these are already empty; on retries they may
			// contain partial data from the failed stream.)
			//
			// NOTE: earlyExecMap.clear() drops references to in-flight tool Promises
			// from a failed attempt.  Those Promises are .catch()-wrapped so they
			// won't cause unhandled rejections, but any side-effects (e.g. Bash
			// commands) may still complete in the background.  In practice, retries
			// only trigger on transient API errors that occur before tool execution
			// begins (the stream fails during the model's response, not after tool
			// dispatch), so this is safe.
			assistantText = "";
			textOutputIndex = undefined;
			reasoningBlockMap.clear();
			toolUses.length = 0;
			messageId = undefined;
			credentialId = undefined;
			earlyExecMap.clear();
			settledResults.clear();
			// Leak-detection dump flag is per successful attempt; clear stale state so a
			// retry that no longer leaks does not force-persist the previous attempt's dump.
			forceDumpPersist = false;
			yieldedToolResults.clear();
			brokenToolUseIds.clear();
			toolUseAccum.clear();
			webSearchAccum.clear();
			imageGenAccum.clear();
			receivedUsage = false;
			sawMeaningfulResponse = false;
			sawErrorEvent = false;
			mimoEllipsisRetry = false;
			// NOTE: lastRetryErrorMessage is intentionally NOT reset here.
			// It persists across retries so that if a retry produces an empty
			// response, we can surface the original error instead of the
			// misleading "empty response" message.  It is cleared below when
			// the attempt produces meaningful content.

			const retrySwitchEvent = await applyPendingRuntimeSettings("retry");
			if (retrySwitchEvent) {
				yield retrySwitchEvent;
				resetRetryStateAfterModelSwitch();
			}

			// Generate unique request ID for this provider attempt (reset on each retry).
			// The actual request start time is set by markRequestStarted() after the
			// provider has assembled a concrete request and is about to send it.
			requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
			requestStartTime = 0;
			requestStarted = false;
			requestStartPending = false;
			requestTtftMs = undefined;
			requestUsage = undefined;
			requestContextPercent = undefined;
			requestMeterUsage = undefined;
			requestMeterUnit = undefined;

			// Initialize request dump collector when explicitly enabled, OR when the provider
			// bounded raw dump to persist on detection. Providers write bodyText/events through
			// the *WithLimit helpers, so collection stays bounded even when force-enabled here.
			requestDump =
				settings.agent.requestDumpEnabled || provider.mayLeakXmlToolCalls
					? new ApiRequestDumpCollector({
							provider: effectiveProvider,
							model: effectiveModel,
						})
					: undefined;

			const attemptAbort = new AbortController();
			let firstTokenTimeoutTriggered = false;
			let firstTokenTimer: ReturnType<typeof setTimeout> | undefined;
			const firstTokenTimeoutMessage = `${effectiveProvider}: First token timeout after ${Math.round(
				firstTokenTimeoutMs / 1000,
			)}s without a meaningful AI API event`;
			const clearFirstTokenTimer = () => {
				if (firstTokenTimer) {
					clearTimeout(firstTokenTimer);
					firstTokenTimer = undefined;
				}
			};
			startFirstTokenTimerForAttempt = () => {
				if (firstTokenTimeoutMs <= 0 || sawMeaningfulResponse || firstTokenTimer) return;
				firstTokenTimer = setTimeout(() => {
					if (config.signal.aborted || sawMeaningfulResponse) return;
					firstTokenTimeoutTriggered = true;
					attemptAbort.abort(new Error(firstTokenTimeoutMessage));
				}, firstTokenTimeoutMs);
			};
			const onParentAbort = () => {
				attemptAbort.abort(config.signal.reason ?? new Error("Aborted"));
			};
			if (config.signal.aborted) {
				onParentAbort();
			} else {
				config.signal.addEventListener("abort", onParentAbort, { once: true });
			}

			try {
				const resetUpstreamSession = resetUpstreamSessionOnNextRequest;
				resetUpstreamSessionOnNextRequest = false;
				const stream = provider.chat({
					conversationId: config.conversationId,
					content,
					model: effectiveModel,
					cwd: config.cwd,
					history,
					tools,
					toolResults: pendingToolResults,
					signal: attemptAbort.signal,
					stickySessionKey: config.narratorId,
					reasoningEffort: config.reasoningEffort,
					serviceTier: config.serviceTier,
					metadata: config.metadata,
					requestDump,
					resetUpstreamSession,
					onRequestStart: markRequestStarted,
					...(isFirstTurn && images?.length ? { images } : {}),
				});

				for await (const parsed of stream) {
					yield* flushRequestStart();
					const hasMeaningfulEvent = isMeaningfulStreamEvent(parsed);
					// Record TTFT (time to first token) for this request
					if (requestTtftMs === undefined && hasMeaningfulEvent) {
						requestTtftMs = Date.now() - requestStartTime;
					}

					if (hasMeaningfulEvent) {
						sawMeaningfulResponse = true;
						clearFirstTokenTimer();
						// A successful response clears any prior retry error so the
						// empty-response guard won't resurface a stale message.
						lastRetryErrorMessage = undefined;
					}

					if (parsed.text) {
						assistantText += parsed.text;
						if (parsed.text.trim()) silentToolCallCount = 0;
						if (parsed.textOutputIndex != null) {
							textOutputIndex = parsed.textOutputIndex;
						}
						yield { type: "stream_text", text: parsed.text, outputIndex: parsed.textOutputIndex };
					}
					if (parsed.toolUses) {
						// ── Tool use dedup ──
						// via BOTH the non-streaming `parsed.toolUses` array AND the streaming
						// `parsed.toolUseChunk` path. This commonly happens for tools with
						// empty or very small parameters (e.g. EnterPlanMode). Without dedup,
						// the tool would be executed twice and yield duplicate events.
						//
						// Strategy:
						// 1. Skip any toolUse whose ID is already in `toolUses` (streaming
						//    path completed it first).
						// 2. Remove matching entries from `toolUseAccum` (streaming accumulator)
						//    so the streaming stop handler doesn't re-process them.
						// 3. Yield block_complete + tool_call + start eager execution here,
						//    mirroring what the streaming stop path would have done.
						// single aggregated leaked_tool_call(stream_captured) diagnostic can be
						// emitted after the loop.
						const streamCapturedLeaked: AgentToolUse[] = [];
						for (const tu of parsed.toolUses) {
							// Skip duplicates — the streaming path may have already
							// completed this tool call via toolUseChunk stop.
							if (toolUses.some((t) => t.toolUseId === tu.toolUseId)) continue;


							toolUses.push(tu);

							// If this tool was also being streamed via toolUseChunk, remove it
							// from the accumulator so it isn't flagged as orphaned.
							// the same call — especially for tools with empty parameters.
							const wasStreaming = toolUseAccum.has(tu.toolUseId);
							if (wasStreaming) {
								toolUseAccum.delete(tu.toolUseId);
							}

							// Yield block_complete so the tool call is persisted
							// (the streaming path would have done this on stop, but
							// non-streaming toolUses skip that path entirely).
							yield {
								type: "block_complete",
								block: {
									type: "tool_use",
									toolUseId: tu.toolUseId,
									name: tu.name,
									input: tu.input,
								} satisfies ContentBlock,
							};

							// Start eager execution (same as the streaming stop path).
							// Skip after a strict-serial barrier — those tools must execute
							// in final group order after preceding tools complete.
							if (
								!earlyExecMap.has(tu.toolUseId) &&
								!isStrictSerial(tu) &&
								!eagerExecutionBlocked &&
								shouldEagerExecuteTool(tu)
							) {
								const execPromise = executeTool(tu, config).catch(
									(err): ToolExecResult => ({
										output: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
										isError: true,
										durationMs: 0,
									}),
								);
								execPromise.then((r) => settledResults.set(tu.toolUseId, r));
								earlyExecMap.set(tu.toolUseId, execPromise);
							}
							if (isStrictSerial(tu)) eagerExecutionBlocked = true;

							yield {
								type: "tool_call",
								toolUseId: tu.toolUseId,
								toolName: tu.name,
								input: tu.input,
							};
						}

						// Diagnostic: surface XML-captured tool calls so the UI can mark them
						// as recovered-from-stream (non-persisted notice). Emitted after the
						// loop so a single event covers all leaked tools in this stream event.
						if (streamCapturedLeaked.length > 0) {
							yield {
								type: "leaked_tool_call",
								phase: "stream_captured",
								requestId,
								toolUseIds: streamCapturedLeaked.map((t) => t.toolUseId),
								toolNames: streamCapturedLeaked.map((t) => t.name),
							};
						}
					}

					// Handle streaming tool use chunks
					if (parsed.toolUseChunk) {
						const { toolUseId: id, name, input, stop } = parsed.toolUseChunk;
						if (id) {
							if (!toolUseAccum.has(id) && name) {
								// Don't create accumulator if this tool was already
								// completed via non-streaming parsed.toolUses
								if (toolUses.some((t) => t.toolUseId === id)) {
									// Still yield the chunk so the frontend sees it
									yield {
										type: "tool_use_chunk",
										toolUseId: id,
										toolName: name,
										inputCharsTotal: 0,
									};
								} else {
									toolUseAccum.set(id, {
										name,
										inputChunks: [],
										totalChars: 0,
										streamingFieldYielded: 0,
										startedAt: Date.now(),
										lastYieldedAt: Date.now(),
										outputIndex: parsed.toolUseChunk.outputIndex,
									});
									// Yield immediately so the frontend knows the tool name early
									yield {
										type: "tool_use_chunk",
										toolUseId: id,
										toolName: name,
										inputCharsTotal: 0,
									};
								}
							}
							const acc = toolUseAccum.get(id);
							if (acc) {
								const shortInput = isShortInputTool(acc.name);
								if (typeof input === "string") {
									acc.inputChunks.push(input);
									acc.totalChars += input.length;

									// Short-input tools: skip field extraction, just throttle the chunk event
									if (shortInput) {
										const now = Date.now();
										if (now - acc.lastYieldedAt >= 50) {
											acc.lastYieldedAt = now;
											yield {
												type: "tool_use_chunk",
												toolUseId: id,
												toolName: acc.name,
												inputCharsTotal: acc.totalChars,
											};
										}
									} else {
										// Extract structured fields from the incomplete JSON
										const raw = acc.inputChunks.join("");
										const wantedKeys = getToolWantedKeys(acc.name);
										let fieldsChanged = false;

										if (wantedKeys.size > 0) {
											const result = extractJsonFields(raw, wantedKeys);

											// Update completed short fields
											for (const [key, value] of Object.entries(result.fields)) {
												if (!acc.extractedFields) acc.extractedFields = {};
												if (acc.extractedFields[key] !== value) {
													acc.extractedFields[key] = value;
													fieldsChanged = true;
												}
											}

											// Update file_path shortcut (used by header summary)
											if (result.fields.file_path && !acc.extractedFilePath) {
												acc.extractedFilePath = result.fields.file_path;
												fieldsChanged = true;
											}

											// Track the active streaming field
											if (result.activeField) {
												if (acc.activeStreamingField !== result.activeField.name) {
													acc.streamingFieldYielded = 0;
												}
												acc.activeStreamingField = result.activeField.name;
											}
										}

										if (
											!acc.streamingMetadata &&
											acc.name === "Edit" &&
											acc.extractedFields?.old_string != null &&
											(acc.extractedFilePath || acc.extractedFields.file_path)
										) {
											acc.streamingMetadata = await resolveStreamingEditMetadata(acc, config.cwd);
											fieldsChanged = true;
										}

										// Throttle: yield at most once per 50ms per tool.

										// Bypass throttle when fields change so the frontend
										// can display them immediately.
										const now = Date.now();
										if (fieldsChanged || now - acc.lastYieldedAt >= 50) {
											acc.lastYieldedAt = now;

											// Calculate content chars (total minus file_path JSON overhead)
											let contentChars = acc.totalChars;
											if (acc.extractedFilePath) {
												const filePathFieldSize = `"file_path":"${acc.extractedFilePath}",`.length;
												contentChars = Math.max(0, acc.totalChars - filePathFieldSize);
											}

											// Compute streaming field delta
											let streamingField: { name: string; delta: string } | undefined;
											if (acc.activeStreamingField && wantedKeys.size > 0) {
												const sfResult = extractJsonFields(raw, wantedKeys);
												if (
													sfResult.activeField &&
													sfResult.activeField.name === acc.activeStreamingField
												) {
													const fullRaw = raw.slice(sfResult.activeField.rawStart);
													if (fullRaw.length > acc.streamingFieldYielded) {
														const decoded = decodeJsonStringFragment(
															fullRaw.slice(acc.streamingFieldYielded),
														);
														if (decoded.text) {
															streamingField = {
																name: acc.activeStreamingField,
																delta: decoded.text,
															};
														}
														acc.streamingFieldYielded += decoded.consumedChars;
													}
												}
											}

											yield {
												type: "tool_use_chunk",
												toolUseId: id,
												toolName: acc.name,
												inputCharsTotal: acc.totalChars,
												...(acc.extractedFilePath && {
													extractedFilePath: acc.extractedFilePath,
												}),
												...(acc.extractedFilePath && {
													contentCharsReceived: contentChars,
												}),
												...(acc.extractedFields && {
													extractedFields: acc.extractedFields,
												}),
												...(acc.streamingMetadata && { metadata: acc.streamingMetadata }),
												...(streamingField && { streamingField }),
											};
										}
									}
								}
								if (stop) {
									const stopRaw = acc.inputChunks.join("");

									// Short-input tools: skip field extraction on stop too
									if (shortInput) {
										yield {
											type: "tool_use_chunk",
											toolUseId: id,
											toolName: acc.name,
											inputCharsTotal: acc.totalChars,
										};
									} else {
										// Final yield: flush any remaining streaming field delta
										const stopWantedKeys = getToolWantedKeys(acc.name);
										if (
											!acc.streamingMetadata &&
											acc.name === "Edit" &&
											acc.extractedFields?.old_string != null &&
											(acc.extractedFilePath || acc.extractedFields.file_path)
										) {
											acc.streamingMetadata = await resolveStreamingEditMetadata(acc, config.cwd);
										}
										let streamingField: { name: string; delta: string } | undefined;

										if (acc.activeStreamingField && stopWantedKeys.size > 0) {
											const sfResult = extractJsonFields(stopRaw, stopWantedKeys);
											if (
												sfResult.activeField &&
												sfResult.activeField.name === acc.activeStreamingField
											) {
												const fullRaw = stopRaw.slice(sfResult.activeField.rawStart);
												if (fullRaw.length > acc.streamingFieldYielded) {
													const decoded = decodeJsonStringFragment(
														fullRaw.slice(acc.streamingFieldYielded),
													);
													if (decoded.text) {
														streamingField = {
															name: acc.activeStreamingField,
															delta: decoded.text,
														};
													}
													acc.streamingFieldYielded += decoded.consumedChars;
												}
											}
										}

										let contentChars = acc.totalChars;
										if (acc.extractedFilePath) {
											const filePathFieldSize = `"file_path":"${acc.extractedFilePath}",`.length;
											contentChars = Math.max(0, acc.totalChars - filePathFieldSize);
										}
										yield {
											type: "tool_use_chunk",
											toolUseId: id,
											toolName: acc.name,
											inputCharsTotal: acc.totalChars,
											...(acc.extractedFilePath && {
												extractedFilePath: acc.extractedFilePath,
											}),
											...(acc.extractedFilePath && {
												contentCharsReceived: contentChars,
											}),
											...(acc.extractedFields && {
												extractedFields: acc.extractedFields,
											}),
											...(acc.streamingMetadata && { metadata: acc.streamingMetadata }),
											...(streamingField && { streamingField }),
										};
									}

									let parsedInput: Record<string, unknown> = {};
									if (stopRaw) {
										try {
											parsedInput = JSON.parse(stopRaw);
										} catch {
											parsedInput = { _raw: stopRaw };
										}
									}
									const tu: AgentToolUse = {
										toolUseId: id,
										name: acc.name,
										input: parsedInput,
										streamStartedAt: acc.startedAt,
										outputIndex: acc.outputIndex,
									};
									// Skip if already added via non-streaming parsed.toolUses
									const alreadyAdded = toolUses.some((t) => t.toolUseId === id);
									if (!alreadyAdded) {
										toolUses.push(tu);
									}
									toolUseAccum.delete(id);

									// If already handled via non-streaming parsed.toolUses,
									// skip block_complete / execution / tool_call — they were
									// already yielded in the parsed.toolUses handler above.
									if (alreadyAdded) continue;

									// Block is complete — yield for immediate persistence
									yield {
										type: "block_complete",
										block: {
											type: "tool_use",
											toolUseId: id,
											name: tu.name,
											input: parsedInput,
											streamStartedAt: acc.startedAt,
											outputIndex: acc.outputIndex,
										} satisfies ContentBlock,
									};

									// Start tool execution eagerly (don't await — collect later).
									// Wrap with .catch() so a rejected permissionHandler doesn't
									// create an unhandled rejection; the error surfaces as isError.
									// The .then() populates settledResults synchronously so the
									// streaming loop can drain completed results without awaiting.
									// Skip after a strict-serial barrier — those tools must execute
									// in final group order after preceding tools complete.
									if (!isStrictSerial(tu) && !eagerExecutionBlocked && shouldEagerExecuteTool(tu)) {
										const execPromise = executeTool(tu, config).catch(
											(err): ToolExecResult => ({
												output: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
												isError: true,
												durationMs: 0,
											}),
										);
										execPromise.then((r) => settledResults.set(id, r));
										earlyExecMap.set(id, execPromise);
									}
									if (isStrictSerial(tu)) eagerExecutionBlocked = true;

									// Notify frontend the tool has started
									yield {
										type: "tool_call",
										toolUseId: id,
										toolName: tu.name,
										input: parsedInput,
										streamStartedAt: acc.startedAt,
									};

									// Drain any tool results that settled during streaming.
									// This lets fast tools (Read, Glob, etc.) report completion
									// before the model finishes outputting subsequent tool calls.
									for (const prevTu of toolUses) {
										const sr = settledResults.get(prevTu.toolUseId);
										if (!sr || yieldedToolResults.has(prevTu.toolUseId)) continue;
										yieldedToolResults.add(prevTu.toolUseId);
										if (sr.broken) brokenToolUseIds.add(prevTu.toolUseId);
										if (sr.updatedInput) prevTu.input = sr.updatedInput;
										const brokenOverride = sr.broken
											? sanitizeBrokenInput(prevTu.name, prevTu.input, locale)
											: undefined;
										const toolSideCars = await collectToolResultSideCars(prevTu, sr);
										const baseOutput = sr.broken
											? getToolMessage("brokenToolCallResult", locale)
											: sr.output;
										yield {
											type: "tool_result",
											toolUseId: prevTu.toolUseId,
											toolName: prevTu.name,
											output: baseOutput,
											isError: sr.isError ?? false,
											durationMs: sr.durationMs,
											permissionStartedAt: sr.permissionStartedAt,
											executionStartedAt: sr.executionStartedAt,
											completedAt: sr.completedAt,
											brokenInputOverride: brokenOverride,
											updatedInput: brokenOverride ?? sr.updatedInput,
											metadata: sr.metadata,
											sideCars: toolSideCars.length > 0 ? toolSideCars : undefined,
										};
										if (sr.fatal) {
											yield* finishRequest(sr.output);
											yield { type: "error", message: sr.output };
											return;
										}
									}
								}
							}
						}
					}

					if (parsed.silentDisconnect) {
						yield* finishRequest("Silent disconnect");
						yield { type: "silent_disconnect" };
						return;
					}
					if (parsed.messageId) messageId = parsed.messageId;

					if (parsed.credentialId) credentialId = parsed.credentialId;

					if (parsed.reasoning) {
						const itemKey = reasoningBlockKey(parsed);
						const existing = reasoningBlockMap.get(itemKey);
						const stampedMetadata = stampReasoningSource(
							parsed.reasoningMetadata,
							provider.getActiveReasoningSource?.(),
						);
						// Separator prefix for multiple delimited reasoning segments that share a provider item.
						let prefix = "";
						if (existing) {
							if (existing._needsSeparator && existing.text) {
								prefix = "\n\n";
								existing._needsSeparator = false;
							}
							existing.text += prefix + parsed.reasoning;
							if (stampedMetadata) {
								existing.providerMetadata = stampedMetadata;
							}
							if (parsed.reasoningOutputIndex != null) {
								existing.outputIndex = parsed.reasoningOutputIndex;
							}
						} else {
							reasoningBlockMap.set(itemKey, {
								text: parsed.reasoning,
								providerMetadata: stampedMetadata,
								outputIndex: parsed.reasoningOutputIndex,
							});
						}
						yield {
							type: "stream_reasoning",
							text: prefix + parsed.reasoning,
							providerMetadata: stampedMetadata,
							outputIndex: parsed.reasoningOutputIndex,
						};
					} else if (parsed.reasoningMetadata) {
						// Metadata-only event (e.g. final encrypted_content from output_item.done
						// or Anthropic thinking block stop with signature).
						// Update the stored metadata without emitting a streaming event.
						// Mark the entry so the next reasoning delta inserts a separator.
						const itemKey = reasoningBlockKey(parsed);
						const existing = reasoningBlockMap.get(itemKey);
						const stampedMetadata = stampReasoningSource(
							parsed.reasoningMetadata,
							provider.getActiveReasoningSource?.(),
						);
						if (existing) {
							existing.providerMetadata = stampedMetadata;
							if (parsed.reasoningOutputIndex != null) {
								existing.outputIndex = parsed.reasoningOutputIndex;
							}
							// Mark for separator so the next reasoning delta from a
							// new thinking block gets a visual break from the previous one.
							if (existing.text) {
								existing._needsSeparator = true;
							}
						} else {
							// Metadata arrived before any text — create an empty-text entry
							reasoningBlockMap.set(itemKey, {
								text: "",
								providerMetadata: stampedMetadata,
								outputIndex: parsed.reasoningOutputIndex,
							});
						}
					}

					// ── Mimo ellipsis reasoning detection ──
					// Some mimo models (via Anthropic protocol) emit "..." as the
					// entire reasoning content, which is a degenerate response.
					// When detected, discard the reasoning block and retry the request.
					if (parsed.reasoningMetadata && effectiveModel.toLowerCase().includes("mimo")) {
						const itemKey = reasoningBlockKey(parsed);
						const entry = reasoningBlockMap.get(itemKey);
						if (entry && entry.text.trim() === "...") {
							logger.warn("Mimo model returned ellipsis-only reasoning, discarding and retrying", {
								narratorId: config.narratorId,
								model: effectiveModel,
								provider: effectiveProvider,
							});
							reasoningBlockMap.delete(itemKey);
							mimoEllipsisRetry = true;
							break; // break out of for-await stream loop to trigger retry
						}
					}

					if (parsed.redactedThinking) {
						const redactedSource = provider.getActiveReasoningSource?.();
						redactedThinkingBlocks.push({
							data: parsed.redactedThinking.data,
							outputIndex: parsed.redactedThinking.outputIndex,
						});
						yield {
							type: "block_complete",
							block: {
								type: "redacted_thinking",
								data: parsed.redactedThinking.data,
								outputIndex: parsed.redactedThinking.outputIndex,
								...(redactedSource ? { signatureSource: redactedSource } : {}),
							},
						};
					}
					if (parsed.contextUsagePercentage != null) {
						receivedUsage = true;
						// raw token counts. Derive the estimated prompt token count from
						// percentage × context window (consistent with the percentage the
						// UI shows), and estimate output tokens from the assistant text.
						const ctxWin = getModelContextWindow(effectiveModel, effectiveProvider);
						const clampedPct = Math.min(Math.max(parsed.contextUsagePercentage, 0), 100);
						requestContextPercent = clampedPct;
						const estimatedPromptTokens = ctxWin
							? Math.round((clampedPct / 100) * ctxWin)
							: undefined;
						const estimatedCompletionTokens = estimateTokens(assistantText);
						// Store percent-derived usage so api_request_end reports the same
						// estimate rather than the char-heuristic fallback below.
						requestUsage = {
							inputTokens: estimatedPromptTokens,
							promptTokens: estimatedPromptTokens,
							completionTokens: estimatedCompletionTokens,
						};
						yield {
							type: "context_usage",
							percentage: parsed.contextUsagePercentage,
							promptTokens: estimatedPromptTokens,
							inputTokens: estimatedPromptTokens,
							completionTokens: estimatedCompletionTokens,
							contextWindow: ctxWin ?? undefined,
							isEstimated: true,
						};
					}
					if (parsed.metering) {
						requestMeterUsage = parsed.metering.usage;
						requestMeterUnit = parsed.metering.unit;
						yield {
							type: "metering",
							unit: parsed.metering.unit,
							unitPlural: parsed.metering.unitPlural,
							usage: parsed.metering.usage,
							credentialId,
						};
					}
					// Generic gateway-injected queue/quota events (via unified gateway)
					if (parsed.queueStatus) {
						yield {
							type: "queue_status",
							position: parsed.queueStatus.position,
							queueDepth: parsed.queueStatus.queueDepth,
							queueMessage: parsed.queueStatus.queueMessage,
						};
					}
					if (parsed.quotaBalance !== undefined) {
						yield {
							type: "quota_balance",
							quotaBalance: parsed.quotaBalance,
							detailedQuotaBalance: parsed.detailedQuotaBalance,
						};
					}
					// Convert OpenAI/Anthropic usage to context_usage percentage
					if (parsed.usage && parsed.usage.promptTokens != null) {
						receivedUsage = true;
						// Store usage for API request tracking
						requestUsage = {
							promptTokens: parsed.usage.promptTokens,
							inputTokens: parsed.usage.inputTokens,
							completionTokens: parsed.usage.completionTokens,
							reasoningTokens: parsed.usage.reasoningTokens,
							cachedInputTokens: parsed.usage.cachedInputTokens,
							cacheCreationInputTokens: parsed.usage.cacheCreationInputTokens,
							cacheCreation5mTokens: parsed.usage.cacheCreation5mTokens,
							cacheCreation1hTokens: parsed.usage.cacheCreation1hTokens,
						};
						const contextWindow =
							parsed.usage.contextWindow ??
							getModelContextWindow(effectiveModel, effectiveProvider);
						// Guard: only emit context_usage when promptTokens > 0.
						// Some Anthropic-compatible APIs (e.g. Xiaomi Mimo) send
						// { input_tokens: 0, output_tokens: 0 } in message_start and
						// defer real usage to message_delta. Emitting 0% context usage
						// causes the UI to briefly flash "0%" before showing the real value.
						if (contextWindow && parsed.usage.promptTokens > 0) {
							const percentage = (parsed.usage.promptTokens / contextWindow) * 100;
							requestContextPercent = Math.min(percentage, 100);
							yield {
								type: "context_usage",
								percentage: requestContextPercent,
								promptTokens: parsed.usage.promptTokens,
								inputTokens: parsed.usage.inputTokens,
								completionTokens: parsed.usage.completionTokens,
								reasoningTokens: parsed.usage.reasoningTokens,
								cachedInputTokens: parsed.usage.cachedInputTokens,
								cacheCreationInputTokens: parsed.usage.cacheCreationInputTokens,
								cacheCreation5mTokens: parsed.usage.cacheCreation5mTokens,
								cacheCreation1hTokens: parsed.usage.cacheCreation1hTokens,
								contextWindow,
							};
						}
					}
					if (parsed.webSearch) {
						const ws = parsed.webSearch;
						if (!webSearchAccum.has(ws.id)) {
							webSearchAccum.set(ws.id, { emitted: false, outputIndex: ws.outputIndex });
						}
						// biome-ignore lint/style/noNonNullAssertion: just set above
						const acc = webSearchAccum.get(ws.id)!;
						// Update query info when available (from output_item.done)
						if (ws.query) acc.query = ws.query;
						if (ws.queries) acc.queries = ws.queries;
						if (ws.outputIndex != null) acc.outputIndex = ws.outputIndex;
						if (ws.action) acc.action = ws.action;
						// Emit block_complete only from the final output_item.done payload so
						// the persisted block keeps the search query and stable output order.
						if (ws.final && (acc.query || acc.queries || acc.action) && !acc.emitted) {
							acc.emitted = true;
							yield {
								type: "block_complete",
								block: {
									type: "web_search",
									id: ws.id,
									query: acc.query,
									queries: acc.queries,
									outputIndex: acc.outputIndex,
									action: acc.action,
								},
							};
						}
						yield {
							type: "web_search",
							id: ws.id,
							status: ws.status,
							query: ws.query,
							queries: ws.queries,
							outputIndex: acc.outputIndex,
						};
					}
					if (parsed.imageGeneration) {
						const ig = parsed.imageGeneration;
						if (!imageGenAccum.has(ig.id)) {
							imageGenAccum.set(ig.id, { emitted: false, outputIndex: ig.outputIndex });
						}
						// biome-ignore lint/style/noNonNullAssertion: just set above
						const acc = imageGenAccum.get(ig.id)!;
						if (ig.revisedPrompt) acc.revisedPrompt = ig.revisedPrompt;
						if (ig.result) acc.result = ig.result;
						if (ig.outputIndex != null) acc.outputIndex = ig.outputIndex;
						if (ig.final && !acc.emitted) {
							acc.emitted = true;
							yield {
								type: "block_complete",
								block: {
									type: "image_generation",
									id: ig.id,
									revisedPrompt: acc.revisedPrompt,
									result: acc.result,
									outputIndex: acc.outputIndex,
								},
							};
						}
						yield {
							type: "image_generation",
							id: ig.id,
							status: ig.status,
							revisedPrompt: ig.revisedPrompt,
							result: ig.result,
							partialImageIndex: ig.partialImageIndex,
							partialImageB64: ig.partialImageB64,
							outputIndex: acc.outputIndex,
						};
					}
					if (parsed.invalidState) {
						const reason = String(parsed.invalidState.reason ?? "api_error");
						const message = String(parsed.invalidState.message ?? "Unknown provider error");
						if (isContextOverflowReason(reason) || isContextOverflowMessage(message)) {
							yield* flushPartialContent(reasoningBlockMap, assistantText, textOutputIndex);
							yield* finishRequest(message);
							yield { type: "context_length_exceeded", message };
							return;
						}
						if (isCompletionLimitReason(reason)) {
							logger.info("Provider hit completion token limit", {
								narratorId: config.narratorId,
								provider: effectiveProvider,
								model: effectiveModel,
								reason,
								message,
							});
							yield { type: "output_truncated", message };
							continue;
						}
						if (isRetryableInvalidStateReason(reason, message)) {
							if (hasStartedEarlyToolExecution()) {
								logger.warn("Retryable provider stream error after tool execution started", {
									narratorId: config.narratorId,
									provider: effectiveProvider,
									model: effectiveModel,
									reason,
									toolCount: toolUses.length,
									startedToolCount: earlyExecMap.size,
								});
								yield* flushPartialContent(reasoningBlockMap, assistantText, textOutputIndex);
								yield* drainStartedEarlyToolResults();
								yield* finishRequest(message);
								yield {
									type: "invalid_state",
									reason,
									message,
								};
								return;
							}
							// In-loop retry: skip block_complete persistence and retry
							// the same chat() call with identical parameters.
							// -1 means infinite retries (consistent with handleTransientError)
							if (
								(getMaxChatRetries() === -1 || chatRetryCount < getMaxChatRetries()) &&
								!config.signal.aborted
							) {
								chatRetryCount++;
								lastRetryErrorMessage = message;
								const delayMs = Math.min(
									TRANSIENT_RETRY_BASE_MS * 2 ** (chatRetryCount - 1),
									backoffCeil,
								);
								yield {
									type: "retrying",
									message,
									attempt: chatRetryCount,
									maxRetries: getMaxChatRetries(),
									delayMs,
								};
								yield* finishRequest(message);
								await abortableSleep(delayMs, config.signal);
								if (config.signal.aborted) {
									yield { type: "error", message: "Aborted" };
									return;
								}
								continue; // retry provider.chat()
							}
							if (hasPendingRuntimeSettingsOverride()) {
								yield* finishRequest(message);
								const switchEvent = await applyPendingRuntimeSettings("retry");
								if (switchEvent) {
									yield switchEvent;
									resetRetryStateAfterModelSwitch();
									continue;
								}
							}
							// Exhausted retries — yield block_complete for partial content
							// then signal retryable_error to the caller.
							yield* flushPartialContent(reasoningBlockMap, assistantText, textOutputIndex);
							yield* finishRequest(message);
							yield { type: "retryable_error", message };
							return;
						}
						// Non-retryable invalidState — treat as a terminal error.
						// Flush any partial content and return immediately so the original
						// error surfaces to the user instead of being masked by the
						// downstream empty-response check (which would retry and eventually
						// report a misleading "Provider returned an empty response" message).
						sawErrorEvent = true;
						yield* flushPartialContent(reasoningBlockMap, assistantText, textOutputIndex);
						yield* finishRequest(message);
						yield {
							type: "invalid_state",
							reason,
							message,
						};
						return;
					}
				}
				yield* flushRequestStart();
			} catch (err) {
				if (config.signal.aborted) {
					// Let already-fulfilled eager tool promises publish into `settledResults`,
					// then persist their completed results before surfacing the abort.  Without
					// this, a user interrupt during trailing text can leave tool calls that had
					// already finished execution stuck as running/interrupted in history.
					await Promise.resolve();
					yield* drainSettledEarlyToolResults();
					// Even on abort, yield block_complete for accumulated content so it can be persisted
					yield* flushPartialContent(reasoningBlockMap, assistantText, textOutputIndex);
					yield* finishRequest("Aborted");
					yield { type: "error", message: "Aborted" };
					return;
				}
				if (firstTokenTimeoutTriggered) {
					if (
						(maxFirstTokenRetries === -1 || chatRetryCount < maxFirstTokenRetries) &&
						!config.signal.aborted
					) {
						chatRetryCount++;
						lastRetryErrorMessage = firstTokenTimeoutMessage;
						const delayMs = Math.min(
							TRANSIENT_RETRY_BASE_MS * 2 ** (chatRetryCount - 1),
							backoffCeil,
						);
						logger.warn("Provider first token timeout, retrying", {
							narratorId: config.narratorId,
							provider: effectiveProvider,
							model: effectiveModel,
							requestId,
							attempt: chatRetryCount,
							maxRetries: maxFirstTokenRetries,
							firstTokenTimeoutMs,
						});
						yield {
							type: "retrying",
							message: firstTokenTimeoutMessage,
							attempt: chatRetryCount,
							maxRetries: maxFirstTokenRetries,
							delayMs,
						};
						yield* finishRequest(firstTokenTimeoutMessage);
						await abortableSleep(delayMs, config.signal);
						if (config.signal.aborted) {
							yield { type: "error", message: "Aborted" };
							return;
						}
						continue; // retry provider.chat()
					}
					if (hasPendingRuntimeSettingsOverride()) {
						yield* finishRequest(firstTokenTimeoutMessage);
						const switchEvent = await applyPendingRuntimeSettings("retry");
						if (switchEvent) {
							yield switchEvent;
							resetRetryStateAfterModelSwitch();
							continue;
						}
					}
					yield* finishRequest(firstTokenTimeoutMessage);
					yield { type: "retryable_error", message: firstTokenTimeoutMessage };
					return;
				}
				if (isCodexRebuildHistoryRetryError(err)) {
					const message = extractErrorMessage(err);
					logger.warn("Codex quota failover requires rebuilt history retry", {
						narratorId: config.narratorId,
						provider: effectiveProvider,
						model: effectiveModel,
						requestId,
						toolCount: toolUses.length,
						startedToolCount: earlyExecMap.size,
					});
					yield* flushPartialContent(reasoningBlockMap, assistantText, textOutputIndex);
					yield* drainStartedEarlyToolResults();
					yield* finishRequest(message);
					yield {
						type: "retryable_error",
						message,
						code: CODEX_REBUILD_HISTORY_RETRY_CODE,
						bypassRetryLimit: true,
					};
					return;
				}
				const msg = extractErrorMessage(err);
				const nugProvider = (settings.nugProviders ?? []).find(
					(p) => !p.disabled && (p.prefix === effectiveProvider || p.id === effectiveProvider),
				);
				const paymentRequired = nugProvider ? getPaymentRequiredErrorInfo(err) : null;
				if (paymentRequired) {
					yield* flushPartialContent(reasoningBlockMap, assistantText, textOutputIndex);
					yield* finishRequest(msg);
					yield {
						type: "payment_required",
						message: paymentRequired.message,
						providerId: nugProvider?.id,
						providerPrefix: nugProvider?.prefix ?? effectiveProvider,
						balance: paymentRequired.balance,
						required: paymentRequired.required,
						resumeAction:
							hasStartedEarlyToolExecution() || (initialToolResults?.length ?? 0) > 0
								? "continue"
								: "retry",
					};
					return;
				}
				if (
					err &&
					typeof err === "object" &&
					"code" in err &&
					(err as { code: string }).code === "CONTEXT_LENGTH_EXCEEDED"
				) {
					// Persist partial content before signalling overflow
					yield* flushPartialContent(reasoningBlockMap, assistantText, textOutputIndex);
					yield* finishRequest(msg);
					yield { type: "context_length_exceeded", message: msg };
					return;
				}
				// Detect context overflow errors from OpenAI/Codex-compatible providers.
				// Treat as context_length_exceeded so caller can prune/compact+retry.
				if (isContextWindowExceededError(err)) {
					yield* flushPartialContent(reasoningBlockMap, assistantText, textOutputIndex);
					yield* finishRequest(msg);
					yield { type: "context_length_exceeded", message: msg };
					return;
				}
				// Detect transient/retryable API errors (e.g. MODEL_TEMPORARILY_UNAVAILABLE,
				// throttling, 429/529 overloaded)
				if (isRetryableError(err)) {
					// In-loop retry for stateless providers
					// -1 means infinite retries (consistent with handleTransientError)
					if (
						(getMaxChatRetries() === -1 || chatRetryCount < getMaxChatRetries()) &&
						!config.signal.aborted
					) {
						chatRetryCount++;
						lastRetryErrorMessage = msg;
						const delayMs = Math.min(
							TRANSIENT_RETRY_BASE_MS * 2 ** (chatRetryCount - 1),
							backoffCeil,
						);
						yield {
							type: "retrying",
							message: msg,
							attempt: chatRetryCount,
							maxRetries: getMaxChatRetries(),
							delayMs,
						};
						yield* finishRequest(msg);
						await abortableSleep(delayMs, config.signal);
						if (config.signal.aborted) {
							yield { type: "error", message: "Aborted" };
							return;
						}
						continue; // retry provider.chat()
					}
					if (hasPendingRuntimeSettingsOverride()) {
						yield* finishRequest(msg);
						const switchEvent = await applyPendingRuntimeSettings("retry");
						if (switchEvent) {
							yield switchEvent;
							resetRetryStateAfterModelSwitch();
							continue;
						}
					}
					// Exhausted retries — persist partial content and signal caller
					yield* flushPartialContent(reasoningBlockMap, assistantText, textOutputIndex);
					yield* finishRequest(msg);
					yield { type: "retryable_error", message: msg };
					return;
				}
				// Non-retryable error — persist partial content and signal caller
				yield* flushPartialContent(reasoningBlockMap, assistantText, textOutputIndex);
				yield* finishRequest(msg);
				yield { type: "error", message: msg };
				return;
			} finally {
				clearFirstTokenTimer();
				config.signal.removeEventListener("abort", onParentAbort);
				startFirstTokenTimerForAttempt = undefined;
			}

			if (firstTokenTimeoutTriggered) {
				if (
					(maxFirstTokenRetries === -1 || chatRetryCount < maxFirstTokenRetries) &&
					!config.signal.aborted
				) {
					chatRetryCount++;
					lastRetryErrorMessage = firstTokenTimeoutMessage;
					const delayMs = Math.min(
						TRANSIENT_RETRY_BASE_MS * 2 ** (chatRetryCount - 1),
						backoffCeil,
					);
					yield {
						type: "retrying",
						message: firstTokenTimeoutMessage,
						attempt: chatRetryCount,
						maxRetries: maxFirstTokenRetries,
						delayMs,
					};
					yield* finishRequest(firstTokenTimeoutMessage);
					await abortableSleep(delayMs, config.signal);
					if (config.signal.aborted) {
						yield { type: "error", message: "Aborted" };
						return;
					}
					continue; // retry provider.chat()
				}
				if (hasPendingRuntimeSettingsOverride()) {
					yield* finishRequest(firstTokenTimeoutMessage);
					const switchEvent = await applyPendingRuntimeSettings("retry");
					if (switchEvent) {
						yield switchEvent;
						resetRetryStateAfterModelSwitch();
						continue;
					}
				}
				yield* finishRequest(firstTokenTimeoutMessage);
				yield { type: "retryable_error", message: firstTokenTimeoutMessage };
				return;
			}

			// ── Mimo ellipsis retry ──
			// If a mimo model returned "..." as reasoning, discard and retry.
			if (mimoEllipsisRetry) {
				chatRetryCount++;
				const delayMs = Math.min(TRANSIENT_RETRY_BASE_MS * 2 ** (chatRetryCount - 1), backoffCeil);
				yield {
					type: "retrying",
					message: "Mimo model returned ellipsis-only reasoning, retrying",
					attempt: chatRetryCount,
					maxRetries: getMaxChatRetries(),
					delayMs,
				};
				yield* finishRequest("mimo ellipsis reasoning");
				await abortableSleep(delayMs, config.signal);
				if (config.signal.aborted) {
					yield { type: "error", message: "Aborted" };
					return;
				}
				continue; // retry provider.chat()
			}

			// Empty response check — request succeeded but returned no content.
			// IMPORTANT: Skip this check if we already yielded an error/invalid_state event
			// during this attempt — otherwise the empty-response message masks the real error.
			//
			// We base this on what actually landed as persistable output, NOT on the
			// optimistic `sawMeaningfulResponse` flag. `sawMeaningfulResponse` is set by
			// `isMeaningfulStreamEvent` the moment any "interesting" stream event arrives
			// (text/toolUseChunk/reasoning/webSearch/imageGeneration/queueStatus),
			// but some of those events never produce committed content:
			//   - a `toolUseChunk` carrying a toolUseId but no `name` never creates an
			//     accumulator (loop ~L2285) and is never pushed to `toolUses`, so it leaves
			//     no orphaned entry either;
			//   - pure `queueStatus` status events carry no content at all.
			// In those cases the optimistic flag would suppress the empty-response guard and
			// the turn would silently persist an empty assistant message and go idle. Compute
			// the real picture from the accumulators instead so the guard still fires.
			const hasOrphanedToolAccum = [...toolUseAccum.values()].some((acc) => !!acc.name);
			const hasAnyPersistableOutput =
				!!assistantText ||
				toolUses.length > 0 ||
				hasOrphanedToolAccum ||
				!!collectReasoningBlocks(reasoningBlockMap) ||
				!!collectCompletedWebSearches(webSearchAccum) ||
				!!collectCompletedImageGenerations(imageGenAccum);
			if (!sawErrorEvent && !hasAnyPersistableOutput) {
				if (!requestStarted) {
					const message =
						`${effectiveProvider}: Provider finished without starting an API request. ` +
						"This indicates the request was not assembled or dispatched; check provider setup and local request-building errors.";
					logger.warn("Provider produced no events before starting a request", {
						narratorId: config.narratorId,
						provider: effectiveProvider,
						model: effectiveModel,
						requestId,
					});
					if (hasPendingRuntimeSettingsOverride()) {
						const switchEvent = await applyPendingRuntimeSettings("retry");
						if (switchEvent) {
							yield switchEvent;
							resetRetryStateAfterModelSwitch();
							continue;
						}
					}
					yield { type: "error", message };
					return;
				}

				// When a previous retry recorded a real error (e.g. 429) treat
				// the empty response as a continuation of that transient failure
				// and feed it back into the *chat* retry counter (not the
				// separate empty-response counter).  This keeps infinite-retry
				// mode working and avoids surfacing the misleading "empty
				// response" message.
				if (lastRetryErrorMessage) {
					if (
						(getMaxChatRetries() === -1 || chatRetryCount < getMaxChatRetries()) &&
						!config.signal.aborted
					) {
						chatRetryCount++;
						const delayMs = Math.min(
							TRANSIENT_RETRY_BASE_MS * 2 ** (chatRetryCount - 1),
							backoffCeil,
						);
						logger.warn(
							"Provider returned empty response after prior error, retrying with original error",
							{
								narratorId: config.narratorId,
								provider: effectiveProvider,
								model: effectiveModel,
								requestId,
								originalError: lastRetryErrorMessage,
								attempt: chatRetryCount,
								maxRetries: getMaxChatRetries(),
							},
						);
						yield {
							type: "retrying",
							message: lastRetryErrorMessage,
							attempt: chatRetryCount,
							maxRetries: getMaxChatRetries(),
							delayMs,
						};
						yield* finishRequest(lastRetryErrorMessage);
						await abortableSleep(delayMs, config.signal);
						if (config.signal.aborted) {
							yield { type: "error", message: "Aborted" };
							return;
						}
						continue; // retry provider.chat()
					}
					if (hasPendingRuntimeSettingsOverride()) {
						yield* finishRequest(lastRetryErrorMessage);
						const switchEvent = await applyPendingRuntimeSettings("retry");
						if (switchEvent) {
							yield switchEvent;
							resetRetryStateAfterModelSwitch();
							continue;
						}
					}
					// Chat retries exhausted — surface the original error
					yield* finishRequest(lastRetryErrorMessage);
					yield { type: "retryable_error", message: lastRetryErrorMessage };
					return;
				}

				// Genuine empty response (no prior error).  Use a dedicated
				// counter (max 3 retries) separate from transient error retries.
				emptyResponseRetries++;
				if (emptyResponseRetries <= MAX_EMPTY_RESPONSE_RETRIES && !config.signal.aborted) {
					const delayMs = Math.min(
						TRANSIENT_RETRY_BASE_MS * 2 ** (emptyResponseRetries - 1),
						backoffCeil,
					);
					const message = `${effectiveProvider}: ${EMPTY_RESPONSE_MESSAGE}`;
					logger.warn("Provider returned empty response, retrying", {
						narratorId: config.narratorId,
						provider: effectiveProvider,
						model: effectiveModel,
						requestId,
						attempt: emptyResponseRetries,
						maxRetries: MAX_EMPTY_RESPONSE_RETRIES,
					});
					yield {
						type: "retrying",
						message,
						attempt: emptyResponseRetries,
						maxRetries: MAX_EMPTY_RESPONSE_RETRIES,
						delayMs,
					};
					yield* finishRequest(message);
					await abortableSleep(delayMs, config.signal);
					if (config.signal.aborted) {
						yield { type: "error", message: "Aborted" };
						return;
					}
					continue; // retry provider.chat()
				}
				const emptyResponseMessage = `${effectiveProvider}: ${EMPTY_RESPONSE_MESSAGE}`;
				if (hasPendingRuntimeSettingsOverride()) {
					yield* finishRequest(emptyResponseMessage);
					const switchEvent = await applyPendingRuntimeSettings("retry");
					if (switchEvent) {
						yield switchEvent;
						resetRetryStateAfterModelSwitch();
						continue;
					}
				}
				// Exhausted empty-response retries — surface as invalid_state
				logger.warn("Provider returned empty response, retries exhausted", {
					narratorId: config.narratorId,
					provider: effectiveProvider,
					model: effectiveModel,
					requestId,
				});
				yield* finishRequest(emptyResponseMessage);
				yield {
					type: "invalid_state",
					reason: "empty_response",
					message: emptyResponseMessage,
				};
				return;
			}

			// Safety net: if an error was already yielded during this attempt but
			// execution somehow continued (e.g. future code changes removed a return),
			// stop here instead of proceeding with normal post-chat logic.
			if (sawErrorEvent) {
				return;
			}

			// ── Reasoning-only dead turn ──
			// The model produced reasoning but no answer text, no tool calls, and no
			// other meaningful output (web search / image generation). Such a turn must
			// not be persisted — the trailing reasoning would become a dangling
			// assistant message (content:null) that breaks history replay.
			// We drop the reasoning (do NOT flush it to the DB), reset the frontend's
			// streaming snapshot, and recover based on what the previous block was.
			const hasMeaningfulOutput =
				assistantText.trim().length > 0 ||
				toolUses.length > 0 ||
				!!collectCompletedWebSearches(webSearchAccum) ||
				!!collectCompletedImageGenerations(imageGenAccum);
			const hasReasoning = !!collectReasoningBlocks(reasoningBlockMap);
			if (!hasMeaningfulOutput && hasReasoning) {
				// Drop accumulated reasoning so flushPartialContent won't persist it.
				reasoningBlockMap.clear();
				redactedThinkingBlocks.length = 0;
				// Tell the frontend to discard the live streaming reasoning it is showing.
				yield { type: "stream_reset" };
				yield* finishRequest(REASONING_ONLY_MESSAGE);

				// Shared retry ceiling with empty responses to avoid infinite loops.
				if (reasoningOnlyRetries >= MAX_EMPTY_RESPONSE_RETRIES || config.signal.aborted) {
					if (hasPendingRuntimeSettingsOverride()) {
						const switchEvent = await applyPendingRuntimeSettings("retry");
						if (switchEvent) {
							yield switchEvent;
							resetRetryStateAfterModelSwitch();
							continue;
						}
					}
					logger.warn("Provider returned only reasoning, retries exhausted", {
						narratorId: config.narratorId,
						provider: effectiveProvider,
						model: effectiveModel,
						requestId,
						retries: reasoningOnlyRetries,
					});
					const message = `${effectiveProvider}: ${reasoningOnlyExhaustedMessage(reasoningOnlyRetries)}`;
					yield { type: "invalid_state", reason: "empty_response", message };
					return;
				}
				reasoningOnlyRetries++;
				const delayMs = Math.min(
					TRANSIENT_RETRY_BASE_MS * 2 ** (reasoningOnlyRetries - 1),
					backoffCeil,
				);
				logger.warn("Provider returned only reasoning, recovering", {
					narratorId: config.narratorId,
					provider: effectiveProvider,
					model: effectiveModel,
					requestId,
					attempt: reasoningOnlyRetries,
					maxRetries: MAX_EMPTY_RESPONSE_RETRIES,
					isFirstTurn,
					pendingToolResults: pendingToolResults.length,
				});
				yield {
					type: "retrying",
					message: REASONING_ONLY_MESSAGE,
					attempt: reasoningOnlyRetries,
					maxRetries: MAX_EMPTY_RESPONSE_RETRIES,
					delayMs,
				};
				await abortableSleep(delayMs, config.signal);
				if (config.signal.aborted) {
					yield { type: "error", message: "Aborted" };
					return;
				}

				// Recover based on what the previous (already-committed) block is.
				// The dead turn itself is discarded entirely — nothing is pushed to
				// history, so no content:null assistant message can be created.
				//
				// If the request that produced the dead turn still has pending input
				// that has NOT been committed to history yet — i.e. the first-turn user
				// message, a mid-loop user nudge (non-empty `content`), or tool results
				// (`pendingToolResults`) — then the previous block is a user/tool block.
				// Re-send the exact same request by retrying the chat() call in place
				// (same turn: history, content and toolResults are all unchanged).
				if (isFirstTurn || content.length > 0 || pendingToolResults.length > 0) {
					continue;
				}

				// Otherwise the previous committed block is an assistant message and
				// there is no pending input to re-send. Open a fresh turn that nudges
				// the model to continue, so the loop can make progress.
				yield { type: "turn_complete", turnIndex };
				turnIndex++;
				nextTurnContent = getToolMessage("userContinue", locale);
				continue turnLoop;
			}

			// Chat call succeeded — break out of the retry loop
			break;
		} // end for (;;) retry loop

		// Final safety net: if a provider/parser accidentally surfaced the same toolUseId
		// multiple times in one turn, collapse them before any drain/execution logic below.
		dedupeToolUsesInPlace(toolUses, effectiveProvider, effectiveModel);

		// lifts `<invoke>...</invoke>` blocks out of the text deltas as they stream, but if
		// anything prevented that (mid-block retry, an event-shape edge case, or a buffer
		// boundary the streaming parser couldn't reconcile), a complete block can still be
		// sitting in the finished `assistantText`. Re-run the stateless parser on the full
		// text so a closed block always becomes an executable tool call instead of leaking
		// to the UI. This is idempotent: the streaming layer already stripped any block it
		// successfully parsed, so only un-lifted blocks remain here.
		if (assistantText.includes("<invoke")) {
			if (recovered.toolUses.length > 0) {
				logger.warn("Recovered leaked XML tool calls from assistant text", {
					narratorId: config.narratorId,
					provider: effectiveProvider,
					model: effectiveModel,
					requestId,
					recoveredCount: recovered.toolUses.length,
					toolNames: recovered.toolUses.map((tu) => tu.name).slice(0, 10),
				});
				assistantText = recovered.text;
				const recoveredIds: string[] = [];
				for (const tu of recovered.toolUses) {
					if (!toolUses.some((existing) => existing.toolUseId === tu.toolUseId)) {
						toolUses.push(tu);
						recoveredIds.push(tu.toolUseId);
					}
				}
				// The raw block was already streamed to the UI as text; tell the frontend to
				// discard the live streaming snapshot so the clean `block_complete` below
				// (emitted by flushPartialContent) becomes the authoritative rendering.
				yield { type: "stream_reset" };
				// Force the raw SSE dump to persist so the recovery is downloadable, then emit
				// a diagnostic so the UI can prompt the user to download the raw data.
				forceDumpPersist = true;
				yield {
					type: "leaked_tool_call",
					phase: "recovered",
					requestId,
					toolUseIds: recoveredIds,
					toolNames: recovered.toolUses.map((tu) => tu.name),
				};
			} else {
				// Leaked `<invoke` text remained but no complete block could be parsed — a
				// closing tag may be missing or the block was malformed. The tool was NOT
				// executed. Force-persist the dump and surface a diagnostic with a snippet.
				const idx = assistantText.indexOf("<invoke");
				const snippet = assistantText.slice(Math.max(0, idx - 40), idx + 200);
				logger.warn("Unrecovered leaked XML in assistant text (no parseable tool call)", {
					narratorId: config.narratorId,
					provider: effectiveProvider,
					model: effectiveModel,
					requestId,
					snippetLength: snippet.length,
				});
				forceDumpPersist = true;
				yield {
					type: "leaked_tool_call",
					phase: "unrecovered",
					requestId,
					snippet,
				};
			}
		}

		// ── Estimate token usage when provider doesn't report it ──
		// For these cases, we estimate based on text length to provide usage statistics.
		if (!requestUsage) {
			const historyText = JSON.stringify(history);
			const systemText = config.systemPrompt ?? "";
			const estimatedInputTokens =
				estimateTokens(historyText) + estimateTokens(systemText) + estimateTokens(content);
			const estimatedOutputTokens = estimateTokens(assistantText);

			requestUsage = {
				inputTokens: estimatedInputTokens,
				promptTokens: estimatedInputTokens,
				completionTokens: estimatedOutputTokens,
			};
		}

		// Emit API request end event
		yield* finishRequest();

		// Reset retry counters after a successful turn so the next turn's
		// backoff starts from the base delay instead of the ceiling.
		// reasoningOnlyRetries lives at function scope (so the ceiling is shared
		// across the turn boundary while recovering a single dead turn via a
		// "continue" nudge); reset it here so non-consecutive dead turns spread
		// across a long session don't accumulate toward the fatal ceiling.
		chatRetryCount = 0;
		reasoningOnlyRetries = 0;

		// ── Fallback: estimate context usage when the provider reported nothing ──
		if (!receivedUsage) {
			const contextWindow = getModelContextWindow(effectiveModel, effectiveProvider);
			if (contextWindow) {
				// Estimate prompt tokens from history + system prompt + current turn content
				const historyText = JSON.stringify(history);
				const systemText = config.systemPrompt ?? "";
				const estimatedPromptTokens =
					estimateTokens(historyText) +
					estimateTokens(systemText) +
					estimateTokens(content) +
					estimateTokens(assistantText);
				const percentage = Math.min((estimatedPromptTokens / contextWindow) * 100, 100);
				yield {
					type: "context_usage",
					percentage,
					promptTokens: estimatedPromptTokens,
					contextWindow,
					isEstimated: true,
				};
			}
		}

		// Detect orphaned tool uses — tool calls whose streaming input was cut off
		// before receiving a stop signal (typically due to API max_tokens truncation).
		// These are silently dropped by the accumulator, so we must detect and handle them.
		const orphanedToolNames = [...toolUseAccum.values()].map((acc) => acc.name).filter(Boolean);
		const hasOrphanedToolUses = orphanedToolNames.length > 0;
		if (hasOrphanedToolUses) toolUseAccum.clear();

		// Yield accumulated content before assistant_message so partial-block
		// persistence is finalized for both normal and truncated turns.
		yield* flushPartialContent(reasoningBlockMap, assistantText, textOutputIndex);

		// Drain settled tool results before assistant_message so the DB
		// has correct tool call statuses when the message is broadcast.
		for (const tu of toolUses) {
			const sr = settledResults.get(tu.toolUseId);
			if (!sr || yieldedToolResults.has(tu.toolUseId)) continue;
			yieldedToolResults.add(tu.toolUseId);
			if (sr.broken) brokenToolUseIds.add(tu.toolUseId);
			if (sr.updatedInput) tu.input = sr.updatedInput;
			const brokenOverride = sr.broken ? sanitizeBrokenInput(tu.name, tu.input, locale) : undefined;
			const toolSideCars = await collectToolResultSideCars(tu, sr);
			const baseOutput = sr.broken ? getToolMessage("brokenToolCallResult", locale) : sr.output;
			yield {
				type: "tool_result",
				toolUseId: tu.toolUseId,
				toolName: tu.name,
				output: baseOutput,
				isError: sr.isError ?? false,
				durationMs: sr.durationMs,
				permissionStartedAt: sr.permissionStartedAt,
				executionStartedAt: sr.executionStartedAt,
				completedAt: sr.completedAt,
				brokenInputOverride: brokenOverride,
				updatedInput: brokenOverride ?? sr.updatedInput,
				metadata: sr.metadata,
				sideCars: toolSideCars.length > 0 ? toolSideCars : undefined,
			};
			if (sr.fatal) {
				yield { type: "error", message: sr.output };
				return;
			}
		}

		// Yield the complete assistant message on every successful turn. Event consumers
		// rely on this to finalize persistence, broadcast the message, run hooks, and update titles.
		yield {
			type: "assistant_message",
			text: assistantText,
			toolUses,
			messageId,
			credentialId,
		};

		if (hasOrphanedToolUses) {
			nextTurnContent = getToolMessageWithParams("brokenToolCallReminder", locale, {
				toolNames: orphanedToolNames.join(", "),
			});
			if (toolUses.length === 0) {
				if (isFirstTurn) {
					provider.pushUserTurn(
						history,
						userText,
						effectiveModel,
						initialToolResults ?? [],
						images,
					);
				} else if (pendingToolResults.length > 0) {
					provider.pushUserTurn(history, "", effectiveModel, pendingToolResults);
				}
				provider.pushAssistantTurn(
					history,
					assistantText,
					[],
					collectReasoningBlocks(reasoningBlockMap),
					collectCompletedWebSearches(webSearchAccum),
					messageId,
					collectCompletedImageGenerations(imageGenAccum),
					textOutputIndex,
					redactedThinkingBlocks,
				);
				yield { type: "turn_complete", turnIndex };
				turnIndex++;
				continue;
			}
		}

		// No tool calls → we're done
		if (toolUses.length === 0) {
			yield { type: "done" };
			return;
		}

		// Push the current user turn into history for the next turn.
		// This must happen AFTER the API call (not before), because
		// chat() references the history array directly.
		if (isFirstTurn) {
			provider.pushUserTurn(history, userText, effectiveModel, initialToolResults ?? [], images);
		} else if (pendingToolResults.length > 0) {
			provider.pushUserTurn(history, "", effectiveModel, pendingToolResults);
		}

		// Execute each tool call
		pendingToolResults = [];
		// Nudge threshold: append a wrap-up reminder when ≥80% of maxTurns used
		const nudgeThreshold = Math.floor(maxTurns * 0.8);
		const shouldNudge = turnIndex >= nudgeThreshold;
		const nudgeText = shouldNudge
			? getToolMessageWithParams("turnNudge", locale, {
					turnIndex: turnIndex + 1,
					maxTurns,
				})
			: "";

		// Group tool calls into runs: consecutive parallel-safe tools form a batch,
		// everything else executes serially (one tool per group).
		// strict-serial tools always form their own group.
		const groups: AgentToolUse[][] = [];
		for (const tu of toolUses) {
			const isParallel = PARALLEL_TOOLS.has(tu.name) && !isStrictSerial(tu);
			const lastGroup = groups[groups.length - 1];
			if (
				isParallel &&
				lastGroup &&
				PARALLEL_TOOLS.has(lastGroup[0].name) &&
				!isStrictSerial(lastGroup[0])
			) {
				lastGroup.push(tu);
			} else {
				groups.push([tu]);
			}
		}

		let toolIndex = 0;
		// Tracks cumulative execution time of preceding serial tools in this turn,
		// used to subtract wait time when computing display duration for fast tools.
		let prevToolsExecMs = 0;
		for (const group of groups) {
			if (config.signal.aborted) {
				await Promise.resolve();
				yield* drainSettledEarlyToolResults();
				yield { type: "error", message: "Aborted" };
				return;
			}

			if (group.length === 1) {
				// Serial execution (single tool)
				const tu = group[0];
				const earlyPromise = earlyExecMap.get(tu.toolUseId);
				const result = earlyPromise
					? await earlyPromise
					: await executeToolAfterReflections(tu, config, history, locale);
				if (result.broken) brokenToolUseIds.add(tu.toolUseId);
				// When the permission handler redirected the input (e.g. conclusion file),
				// update the in-memory tool_use so pushAssistantTurn writes the correct
				// input into history — otherwise the model sees the original (wrong) path.
				if (result.updatedInput) tu.input = result.updatedInput;
				const toolSideCars = await collectToolResultSideCars(tu, result);
				const outputWithReminder =
					toolSideCars.length > 0
						? appendSideCarsForApi(result.output, toolSideCars)
						: result.output;
				const isLastTool = toolIndex === toolUses.length - 1;
				const outputForModel =
					isLastTool && shouldNudge ? outputWithReminder + nudgeText : outputWithReminder;

				pendingToolResults.push(
					provider.formatToolResult(
						tu.toolUseId,
						outputForModel,
						result.isError ?? false,
						result.images,
					),
				);

				if (yieldedToolResults.has(tu.toolUseId)) {
					// Already yielded during streaming — just accumulate timing
					prevToolsExecMs += result.durationMs;
					toolIndex++;
					if (result.fatal) {
						// Fatal was already yielded in the drain loop
						return;
					}
				} else {
					// Only yield tool_call if not already yielded during streaming
					if (!earlyPromise) {
						yield {
							type: "tool_call",
							toolUseId: tu.toolUseId,
							toolName: tu.name,
							input: tu.input,
							streamStartedAt: tu.streamStartedAt,
						};
					}

					// For tools with streamStartedAt, compute display duration as
					// total elapsed minus time spent executing preceding tools.
					let durationMs = result.durationMs;
					if (tu.streamStartedAt != null) {
						const totalElapsed = Date.now() - tu.streamStartedAt;
						const adjusted = totalElapsed - prevToolsExecMs;
						durationMs = Math.max(adjusted, result.durationMs);
					}
					prevToolsExecMs += result.durationMs;

					// For broken tool calls, sanitize the persisted input and output
					// so the DB shows a clean message instead of truncated garbage.
					const brokenInputOverride = result.broken
						? sanitizeBrokenInput(tu.name, tu.input, locale)
						: undefined;

					yield {
						type: "tool_result",
						toolUseId: tu.toolUseId,
						toolName: tu.name,
						output: result.broken ? getToolMessage("brokenToolCallResult", locale) : result.output,
						isError: result.isError ?? false,
						durationMs,
						brokenInputOverride,
						updatedInput: brokenInputOverride ?? result.updatedInput,
						metadata:
							durationMs !== result.durationMs
								? { ...result.metadata, execDurationMs: result.durationMs }
								: result.metadata,
						sideCars: toolSideCars.length > 0 ? toolSideCars : undefined,
					};
					toolIndex++;

					if (result.fatal) {
						yield { type: "error", message: result.output };
						return;
					}
				}
			} else {
				// Parallel execution (multiple Task calls)
				// Yield tool_call events for tools not already started during streaming
				for (const tu of group) {
					if (!earlyExecMap.has(tu.toolUseId) && !yieldedToolResults.has(tu.toolUseId)) {
						yield {
							type: "tool_call",
							toolUseId: tu.toolUseId,
							toolName: tu.name,
							input: tu.input,
							streamStartedAt: tu.streamStartedAt,
						};
					}
				}

				// Start all executions concurrently, but yield results as each completes
				// (instead of waiting for all via Promise.all) so the frontend can update
				// individual tool cards immediately.
				const execEntries = group.map((tu) => ({
					tu,
					promise:
						earlyExecMap.get(tu.toolUseId) ??
						executeToolAfterReflections(tu, config, history, locale),
				}));

				// Wrap each promise to carry its index so we know which resolved
				const indexed = execEntries.map((e, i) => e.promise.then((result) => ({ i, result })));

				const settled = new Array<ToolExecResult | undefined>(group.length);
				let remaining = new Set(indexed);
				let hasFatal = false;
				let maxParallelMs = 0;

				while (remaining.size > 0) {
					const winner = await Promise.race(remaining);
					const { i, result } = winner;
					settled[i] = result;

					// Remove the settled promise from the race set
					remaining = new Set([...remaining].filter((p) => p !== indexed[i]));

					const tu = group[i];
					const effectiveResult = result;
					if (effectiveResult.broken) brokenToolUseIds.add(tu.toolUseId);
					if (effectiveResult.updatedInput) tu.input = effectiveResult.updatedInput;
					const parallelSideCars = await collectToolResultSideCars(tu, effectiveResult);
					const outputWithReminder =
						parallelSideCars.length > 0
							? appendSideCarsForApi(effectiveResult.output, parallelSideCars)
							: effectiveResult.output;
					const isLastTool = toolIndex === toolUses.length - 1 && remaining.size === 0;
					const outputForModel =
						isLastTool && shouldNudge ? outputWithReminder + nudgeText : outputWithReminder;

					pendingToolResults.push(
						provider.formatToolResult(
							tu.toolUseId,
							outputForModel,
							effectiveResult.isError ?? false,
							effectiveResult.images,
						),
					);

					if (!yieldedToolResults.has(tu.toolUseId)) {
						const brokenInputOverride = effectiveResult.broken
							? sanitizeBrokenInput(tu.name, tu.input, locale)
							: undefined;

						yield {
							type: "tool_result",
							toolUseId: tu.toolUseId,
							toolName: tu.name,
							output: effectiveResult.broken
								? getToolMessage("brokenToolCallResult", locale)
								: effectiveResult.output,
							isError: effectiveResult.isError ?? false,
							durationMs: effectiveResult.durationMs,
							permissionStartedAt: effectiveResult.permissionStartedAt,
							executionStartedAt: effectiveResult.executionStartedAt,
							completedAt: effectiveResult.completedAt,
							brokenInputOverride,
							updatedInput: brokenInputOverride ?? effectiveResult.updatedInput,
							metadata: effectiveResult.metadata,
							sideCars: parallelSideCars.length > 0 ? parallelSideCars : undefined,
						};
					}
					toolIndex++;
					if (effectiveResult.durationMs > maxParallelMs)
						maxParallelMs = effectiveResult.durationMs;

					if (effectiveResult.fatal) hasFatal = true;
				}
				prevToolsExecMs += maxParallelMs;

				if (hasFatal) {
					const fatalResult = settled.find((r) => r?.fatal);
					const fatalMsg = fatalResult?.output ?? "Fatal tool error";
					yield { type: "error", message: fatalMsg };
					return;
				}
			}
		}

		// Graceful stop requested (e.g. feedback injection) — exit without aborting processes.
		// Unlike abort, this lets the current tool finish normally and preserves its result.
		if (config.shouldStop?.()) {
			provider.pushAssistantTurn(
				history,
				assistantText,
				toolUses,
				collectReasoningBlocks(reasoningBlockMap),
				collectCompletedWebSearches(webSearchAccum),
				messageId,
				collectCompletedImageGenerations(imageGenAccum),
				textOutputIndex,
				redactedThinkingBlocks,
			);
			yield { type: "turn_complete", turnIndex };
			return;
		}

		// Strip broken tool calls from the history sent to the model.
		// The UI already has the full picture (tool_result events were yielded above),
		// but the model should not see the broken tool_use + tool_result pair —
		// they waste context and cause retry loops.
		if (brokenToolUseIds.size > 0) {
			const cleanToolUses = toolUses.filter((tu) => !brokenToolUseIds.has(tu.toolUseId));
			pendingToolResults = pendingToolResults.filter((tr) => {
				const toolUseId =
					(tr as { toolUseId?: string; call_id?: string; tool_call_id?: string }).toolUseId ??
					(tr as { toolUseId?: string; call_id?: string; tool_call_id?: string }).call_id ??
					(tr as { toolUseId?: string; call_id?: string; tool_call_id?: string }).tool_call_id;
				return !toolUseId || !brokenToolUseIds.has(toolUseId);
			});
			provider.pushAssistantTurn(
				history,
				assistantText,
				cleanToolUses,
				collectReasoningBlocks(reasoningBlockMap),
				collectCompletedWebSearches(webSearchAccum),
				messageId,
				collectCompletedImageGenerations(imageGenAccum),
				textOutputIndex,
				redactedThinkingBlocks,
			);

			// Inject a user-side reminder so the model knows what happened and
			// switches strategy instead of blindly retrying the same large write.
			const brokenNames = toolUses
				.filter((tu) => brokenToolUseIds.has(tu.toolUseId))
				.map((tu) => tu.name);
			nextTurnContent = getToolMessageWithParams("brokenToolCallReminder", locale, {
				toolNames: brokenNames.join(", "),
			});
		} else {
			// Append assistant message to history for next turn
			provider.pushAssistantTurn(
				history,
				assistantText,
				toolUses,
				collectReasoningBlocks(reasoningBlockMap),
				collectCompletedWebSearches(webSearchAccum),
				messageId,
				collectCompletedImageGenerations(imageGenAccum),
				textOutputIndex,
				redactedThinkingBlocks,
			);
		}

		// Collect after-tools sidecars (replaces getInjectedUserText).
		// These are assembled into the next user turn's text portion.
		const afterToolsSideCars = await collectAfterToolsSideCars();
		if (afterToolsSideCars.length > 0) {
			const injected = appendSideCarsForApi("", afterToolsSideCars);
			if (injected) {
				nextTurnContent = nextTurnContent ? `${nextTurnContent}\n\n${injected}` : injected;
			}
			yield { type: "sidecars", sideCars: afterToolsSideCars };
		}

		yield { type: "turn_complete", turnIndex };
		turnIndex++;
	}

	yield { type: "max_turns_exceeded", maxTurns };
}
