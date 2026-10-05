import { resolve } from "node:path";
import type { ContextCharCache } from "@shared/context-composition";
import type { ContextInputCharacters, ContextUsageSnapshot } from "@shared/context-usage";
import { createThrottledProgressReporter, type ProgressSnapshot } from "@shared/progress-phase";
import {
	createStreamingEditOrigin,
	STREAMING_EDIT_ORIGIN_MAX_CODE_UNITS,
	type StreamingEditOrigin,
	validateStreamingEditOrigin,
} from "@shared/streaming-edit-origin";
import { scanToolOutputForKnowledgeDetailed } from "../../services/knowledge-injection";
import { type ProtectedTaskMutation, SPEC_TASKS_PATH } from "../../services/spec-task-service";
import { specVfsService } from "../../services/spec-vfs-service";
import { beginNarratorResponseActivity } from "../../services/update-coordinator";
import {
	type ApiRequestHandle,
	finishApiRequest,
	shouldCollectRequestDump,
	startApiRequest,
} from "../api-request-tracker";
import {
	type BooleanOverride,
	type DangerReflectionLevel,
	normalizeBooleanOverride,
	resolveBooleanOverride,
} from "../boolean-override";
import { matchContextComposition, validInputCharacters } from "../context-usage-snapshot";
import { resolveKimiQuotaWait } from "../kimi-quota-wait";
import { logger } from "../logger";
import { withModelMetadataSnapshotIterator } from "../model-catalog";
import { captureReferencePricingSnapshot } from "../model-pricing";
import { buildPlanFileRelPath, isPlanAuthoringPath, PLAN_DIR_REL } from "../plan-file-path";
import { getPrompt, getToolMessage, getToolMessageWithParams, type Locale } from "../prompt-i18n";
import {
	consumeSearchExecutionTurn,
	getSearchExecutionScope,
	matchesSearchExecutionScope,
	SearchExecutionBudgetExceededError,
} from "../search/execution-scope";
import { shouldUseNativeSearch, usesSideRequestNativeSearch } from "../search/native";
import { hasUsableFunctionSearchChannelFor } from "../search/router";
import { getModelContextWindow, settings, usesStatefulModel } from "../settings";
import { sideCarBodyWithText } from "../sidecar-templates";
import { StreamStaleError } from "../stream-timeout";
import { abortableSleep } from "./abortable-sleep";
import { analyzeShellCommand } from "./bash-analyze";
import { CODEX_REBUILD_HISTORY_RETRY_CODE, isCodexRebuildHistoryRetryError } from "./codex-errors";
import { diagnosticsFromError, normalizeApiRequestDiagnostics } from "./error-diagnostics";
import {
	classifyInvalidState,
	extractErrorMessage,
	getAuxiliaryMaxRetries,
	getPaymentRequiredErrorInfo,
	isContextWindowExceededError,
	isModelUnavailableError,
	isResumableError,
	isRetryableError,
} from "./error-handling";
import { localPathSemantics } from "./execution/path-semantics";
import { countInputCharacters } from "./input-characters";
import {
	buildMalformedCaptureRecord,
	isMalformedRequestBodyError,
	writeMalformedRequestDump,
} from "./malformed-request-dump";
import { type ContentLane, OutputContentAccumulator } from "./output-content";
import { type ParsedStreamEvent, resolveProviderAndModel } from "./provider";
import { ApiRequestDumpCollector } from "./request-dump";
import { detectShell } from "./shell";
import {
	groupToolExecutions,
	isStrictSerialToolExecution,
	selectStreamingToolExecutions,
	settleToolExecutionResult,
} from "./tool-execution-groups";
import {
	executeTool,
	freezeToolExecution,
	getReflectionToolRejection,
	preAdmitToolExecution,
	releaseToolAdmissionState,
	sanitizeBrokenInput,
	type ToolAdmissionState,
	type ToolExecResult,
} from "./tool-executor";
import { ToolInputStream } from "./tool-input-stream";
import { canonicalizeToolName, isBashToolName, isValidToolName } from "./tool-name";
import { toolRegistry } from "./tool-registry";
import {
	applyToolUseIdRemap,
	collectToolUseIdsFromHistory,
	remapToolResultIds,
	reserveUniqueToolUseIds,
} from "./tool-use-id-dedup";
import { SHELL_TOOL_NAME } from "./tools/bash";
import { DANGER_REFLECTION_TOOLS } from "./tools/danger-reflection";
import { replace as applyEditReplacement, findReplaceMatch } from "./tools/edit";
import { readFileText } from "./tools/encoding";
import {
	broadcastPlanReflectionProgress,
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
	broadcastTaskReflectionProgress,
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
	AgentHistoryReplacement,
	AgentToolUse,
	ApiRequestDiagnostics,
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

/** Per-tool mapping: which fields to extract, and which are "large" (streamed incrementally) */
const TOOL_FIELD_CONFIG: Record<string, { short: string[]; large: string[] }> = {
	Write: { short: ["file_path"], large: ["content"] },
	Edit: { short: ["file_path", "device", "replace_all"], large: ["old_string", "new_string"] },
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
	StartPipeline: { short: ["label", "maxPreviewChars", "maxUnusedToolCalls"], large: [] },
	ExtractPipeline: { short: ["aliases", "format", "maxChars"], large: ["rule"] },
	// `async` is extracted while the input streams so the UI can label the card as a
	// deferred question before the call completes; `withdraw` so a maintenance-only
	// call is not rendered as an empty question.
	AskUserQuestion: { short: ["async", "withdraw"], large: [] },
};

interface StreamingToolAccumulator {
	name: string;
	stream: ToolInputStream;
	totalChars: number;
	startedAt: number;
	streamCompletedAt?: number;
	extractedFilePath?: string;
	extractedFields?: Record<string, string>;
	pendingShort: Record<string, string>;
	streamingMetadata?: Record<string, unknown>;
	streamingEditOrigin?: StreamingEditOrigin;
	metadataAttempted?: boolean;
	lastYieldedAt: number;
	outputIndex?: number;
	thoughtSignature?: string;
	thoughtSignatureSource?: string;
}

function normalizeLineEndings(text: string): string {
	return text.replaceAll("\r\n", "\n");
}

export async function resolveStreamingEditMetadata(
	acc: {
		name: string;
		extractedFilePath?: string;
		extractedFields?: Record<string, string>;
		streamingEditOrigin?: StreamingEditOrigin;
	},
	cwd: string,
	toolUseId: string,
	defaultDeviceId = "local",
): Promise<Record<string, unknown> | undefined> {
	if (acc.name !== "Edit") return undefined;
	const filePath = acc.extractedFilePath ?? acc.extractedFields?.file_path;
	const oldString = acc.extractedFields?.old_string;
	const device = acc.extractedFields?.device ?? defaultDeviceId;
	// This matcher reads local files only. Never borrow a local path for a remote tool.
	if (
		device !== "local" ||
		!filePath ||
		!oldString ||
		oldString.length > STREAMING_EDIT_ORIGIN_MAX_CODE_UNITS
	)
		return undefined;

	try {
		const resolvedPath = resolve(cwd, filePath);
		const { text } = await readFileText(resolvedPath);
		const content = normalizeLineEndings(text);
		const normalizedOld = normalizeLineEndings(oldString);
		const replaceAll = acc.extractedFields?.replace_all === "true";
		const match = findReplaceMatch(content, normalizedOld, replaceAll);
		const lineCount = normalizedOld.split("\n").length;
		const metadata = {
			startLine: match.startLine,
			endLine: match.startLine + lineCount - 1,
			matchStatus: "matched",
		};
		acc.streamingEditOrigin = createStreamingEditOrigin(
			toolUseId,
			{
				file_path: filePath,
				old_string: oldString,
				device,
				replace_all: replaceAll,
			},
			metadata,
			device,
		);
		return metadata;
	} catch (err) {
		return {
			matchStatus: "unmatched",
			matchError: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Observable facts about an attempt that produced no persistable output. The
 * empty-response guard used to collapse every such attempt into one generic
 * "check your base URL / model / credentials" sentence, which is actively
 * misleading: an upstream 503, a truncated tool-call stream and a genuinely
 * empty body all need different follow-up. These fields are the signals that
 * are already available at the end of the stream but were previously dropped.
 */
interface EmptyResponseSignals {
	/** Total stream events observed this attempt (0 ⇒ upstream sent nothing at all). */
	streamEvents: number;
	/** Events that carried no content of any kind (usage / queue / quota / stop only). */
	contentlessEvents: number;
	/** Provider-reported completion reason, if any (`stopReason` / `finish_reason`). */
	stopReason?: string;
	/** True when the provider reported token usage, proving the request was served. */
	receivedUsage: boolean;
	/** Tool-call ids seen without a tool name — they can never become a tool call. */
	namelessToolUseIds: string[];
}

/** Machine-readable sub-reason for an empty turn. Surfaced as `diagnostics.reason`. */
type EmptyResponseKind =
	| "empty_response_no_events"
	| "empty_response_usage_only"
	| "empty_response_nameless_tool_call"
	| "empty_response_stop_without_content"
	| "empty_response";

/**
 * Pick the most specific explanation the evidence supports.
 *
 * Note there is deliberately no "truncated tool input" kind here: a tool call
 * whose input stream was cut off leaves a *named* accumulator, which counts as
 * persistable output, so it never reaches the empty-response guard. That case
 * has its own recovery path (the broken-tool-call reminder further below).
 */
function classifyEmptyResponse(signals: EmptyResponseSignals): EmptyResponseKind {
	if (signals.namelessToolUseIds.length > 0) return "empty_response_nameless_tool_call";
	if (signals.streamEvents === 0) return "empty_response_no_events";
	// A stop reason is the single most actionable fact (e.g. `content_filter`),
	// so it outranks the generic "only bookkeeping arrived" observation.
	if (signals.stopReason) return "empty_response_stop_without_content";
	if (signals.streamEvents === signals.contentlessEvents) return "empty_response_usage_only";
	return "empty_response";
}

/**
 * Human-readable explanation for an empty turn.
 *
 * Only the genuinely-empty-body case points at local API configuration; the
 * other kinds are upstream or protocol problems where telling the user to
 * check their base URL and credentials sends them down the wrong path.
 */
function emptyResponseMessageFor(kind: EmptyResponseKind, signals: EmptyResponseSignals): string {
	switch (kind) {
		case "empty_response_no_events":
			return (
				"Provider accepted the request but streamed no events at all. This usually means the " +
				"upstream dropped the response; if it repeats, verify the base URL, model, and credentials."
			);
		case "empty_response_usage_only":
			return (
				"Provider streamed only bookkeeping events (usage/queue/quota) and no content. " +
				"The request reached the model, so this is an upstream problem rather than a local " +
				"configuration error."
			);
		case "empty_response_nameless_tool_call":
			return `Provider announced a tool call without a tool name (${signals.namelessToolUseIds
				.slice(0, 3)
				.join(", ")}), so nothing could be executed. This is an upstream protocol fault.`;
		case "empty_response_stop_without_content":
			return (
				`Provider finished with stop reason "${signals.stopReason}" but produced no content. ` +
				"The request reached the model, so this is an upstream problem rather than a local " +
				"configuration error."
			);
		default:
			return (
				"Provider returned an empty response. This often indicates an API configuration error " +
				"(base URL, model, or credentials)."
			);
	}
}

/**
 * Compact evidence string attached to `diagnostics.responseSnippet` so the
 * failure can be diagnosed from the persisted record without a raw dump.
 */
function emptyResponseEvidence(signals: EmptyResponseSignals): string {
	const parts = [
		`events=${signals.streamEvents}`,
		`contentless=${signals.contentlessEvents}`,
		`usage=${signals.receivedUsage}`,
	];
	if (signals.stopReason) parts.push(`stopReason=${signals.stopReason}`);
	if (signals.namelessToolUseIds.length > 0) {
		parts.push(`namelessToolUseIds=${signals.namelessToolUseIds.slice(0, 5).join("|")}`);
	}
	return parts.join(" ");
}

/** Max retries specifically for empty responses (request succeeded but no content). */
const MAX_EMPTY_RESPONSE_RETRIES = 3;

/**
 * Replay budget for an empty turn the upstream demonstrably SERVED.
 *
 * `usage_only` / `stop_without_content` mean the request reached the model, was
 * accounted for, and came back with a stop signal but no content. Replaying the
 * identical request has a poor success rate in practice — production logs show
 * these failing identically on every attempt — while each replay pays the full
 * prompt again. One retry covers a genuine one-off; beyond that the turn is
 * handed back so the caller can rebuild history and issue a fresh request.
 */
const MAX_EMPTY_RESPONSE_RETRIES_SERVED = 1;

/** Replay budget for one empty-turn kind. */
function maxEmptyResponseRetriesFor(kind: EmptyResponseKind): number {
	return kind === "empty_response_usage_only" || kind === "empty_response_stop_without_content"
		? MAX_EMPTY_RESPONSE_RETRIES_SERVED
		: MAX_EMPTY_RESPONSE_RETRIES;
}

/** Reasoning-only responses above this occupancy trigger one blocking compact attempt. */
const REASONING_ONLY_COMPACT_THRESHOLD = 95;

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

/**
 * Whether a failure means "the upstream stopped sending and nothing arrived
 * before the connection died" — as opposed to an explicit rejection.
 *
 * Covers both detectors that can notice the silence: our own stale-read guard,
 * and the transport-level idle timeout that fires first whenever a hop on the
 * path drops a connection nobody is talking on. `AbortError` is deliberately
 * excluded: a user interrupt is not upstream silence.
 */
function isStreamSilenceError(err: unknown): boolean {
	if (err instanceof StreamStaleError) return true;
	if (!(err instanceof Error)) return false;
	if (err.name === "AbortError") return false;
	if (err.name === "TimeoutError") return true;
	const message = err.message.toLowerCase();
	return (
		message.includes("the operation timed out") ||
		message.includes("socket connection was closed") ||
		message.includes("stream stale")
	);
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

/**
 * Whether an event carries content that can actually land as output.
 *
 * Deliberately stricter than {@link isMeaningfulStreamEvent}, which also counts
 * liveness signals (`queueStatus`, and a `toolUseChunk` carrying only an id).
 * Those prove the upstream is talking to us but never produce committed
 * content, so they must not be treated as "the request succeeded" — otherwise a
 * transient failure's real cause gets discarded and the turn reports a generic
 * empty response instead.
 */
function hasPersistableStreamContent(parsed: ParsedStreamEvent): boolean {
	return !!(
		parsed.text ||
		(parsed.toolUses?.length ?? 0) > 0 ||
		parsed.toolUseChunk?.name ||
		parsed.reasoning ||
		parsed.webSearch ||
		parsed.imageGeneration
	);
}

/**
 * Any parsed provider event proves that the upstream response stream is alive.
 *
 * This is deliberately broader than isMeaningfulStreamEvent(): Anthropic's
 * message_start commonly carries only a message id/usage snapshot while the
 * model is still generating a large tool-input JSON document. Treating that
 * event as "no response" makes the first-token watchdog abort a healthy stream.
 */
function isProviderActivityEvent(parsed: ParsedStreamEvent): boolean {
	return Object.keys(parsed).length > 0;
}

// Cadence (in completed tool calls) for the periodic spec (tasks.json) reminder.
// Named for the legacy todo reminder it replaced; still the spec-reminder interval.
export const TODO_REMINDER_TOOL_INTERVAL = 15;
const DEFAULT_SILENT_TOOL_CALL_THRESHOLD = 50;

const RELAXED_PLAN_READ_ONLY_TOOLS = new Set([
	"Read",
	"Grep",
	"Glob",
	"StructView",
	"WebSearch",
	"WebFetch",
	"Await",
	"ShareFile",
	"ContextAsk",
	"LearningGuide",
	"StartPipeline",
	"ExtractPipeline",
	"AskUserQuestion",
	"EnterPlanMode",
	"ExitPlanMode",
]);

const RELAXED_PLAN_READ_ONLY_SUBAGENTS = new Set(["explore", "plan"]);

/**
 * Is this tool use the model WRITING ITS PLAN, rather than starting implementation?
 *
 * Plan mode asks for exactly one write: the plan file. Reminding the model not to
 * implement immediately after it complied is noise at the worst possible moment — it
 * arrives attached to the one action that was correct, so the only signal the model
 * can take from it is that its plan write was somehow suspect.
 *
 * Judged with the LOCAL path grammar even when the write ran on a remote executor:
 * this is a "should we nag" heuristic, and a mismatch costs one redundant reminder,
 * never a wrong permission decision (the gate in narrator-permission.ts does the
 * target-accurate check).
 */
function isPlanAuthoringToolUse(
	tu: AgentToolUse,
	config: Pick<AgentConfig, "cwd" | "planFilePath">,
): boolean {
	if (tu.name !== "Write" && tu.name !== "Edit") return false;
	const filePath = typeof tu.input.file_path === "string" ? tu.input.file_path : "";
	if (!filePath || specVfsService.isSpecUri(filePath)) return false;
	return isPlanAuthoringPath(localPathSemantics, config.cwd, filePath, config.planFilePath);
}

/**
 * The plan file path to name in the reminder.
 *
 * `planFilePath` is the path the model was actually told to write (it may still be the
 * pre-`plans/` layout for a cycle that started before the move), so it wins. The
 * `planFileId` rebuild covers a config that carries the identity but not the resolved
 * path; the placeholder is the last resort and at least points at the right directory
 * rather than interpolating an empty string into a sentence.
 */
function relaxedPlanReminderPlanFile(
	config: Pick<AgentConfig, "planFilePath" | "planFileId">,
): string {
	const designated = config.planFilePath?.trim();
	if (designated) return designated;
	const planFileId = config.planFileId?.trim();
	return planFileId ? buildPlanFileRelPath(planFileId) : `${PLAN_DIR_REL}/`;
}

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
	config: Pick<AgentConfig, "planMode" | "relaxedPlan" | "cwd" | "chapterId" | "planFilePath">,
): Promise<boolean> {
	if (!config.planMode || !config.relaxedPlan) return false;
	if (RELAXED_PLAN_READ_ONLY_TOOLS.has(tu.name)) return false;
	if (isTaskStateMaintenanceToolUse(tu)) return false;
	if (isPlanAuthoringToolUse(tu, config)) return false;

	if (tu.name === "Agent" || tu.name === "Task") {
		const subagentType =
			typeof tu.input.subagent_type === "string" ? tu.input.subagent_type : undefined;
		return !subagentType || !RELAXED_PLAN_READ_ONLY_SUBAGENTS.has(subagentType);
	}

	if (isBashToolName(tu.name)) {
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

const ABORT_EAGER_TOOL_DRAIN_TIMEOUT_MS = 100;

const EAGER_EXECUTION_DISABLED_TOOLS = new Set([
	"Execute",
	"Agent",
	// Await/Send coordinate with spawned agents. Executing them eagerly mid-stream would
	// let a wait/message run before the group barrier observes the sibling Agent's
	// registered/running state. Defer them to the ordered post-stream tool phase.
	"Await",
	"Send",
	"Browser",
	"Terminal",
	"ShareFile",
	"NarraForkAdmin",
	// ScheduledTask mutations self-gate via ctx.requestPermission and can launch a
	// narrator (run_now). Eager mid-stream execution would open an approval prompt —
	// or dispatch an unattended run — before the assistant message that requested it
	// is even complete.
	"ScheduledTask",
	"PluginInstall",
	"McpAdmin",
	"HookAdmin",
	"ScheduledTaskAdmin",
	"ForkNarrator",
	"EnterPlanMode",
	...DANGER_REFLECTION_TOOLS,
	...EXIT_PLAN_REFLECTION_TOOLS,
	...TASK_REFLECTION_TOOLS,
]);

function shouldEagerExecuteTool(tu: AgentToolUse): boolean {
	if (EAGER_EXECUTION_DISABLED_TOOLS.has(tu.name)) return false;
	// Ordinary Bash is ordered, not necessarily deferred until the response ends.
	// Pipeline/plan transitions still need the complete assistant message.
	if (isStrictSerial(tu) && tu.name !== SHELL_TOOL_NAME) return false;
	// Virtual task writes can enter a reflection loop. Keep that decision after
	// request finalization rather than reflecting against an incomplete response.
	if (
		(tu.name === "Write" || tu.name === "Edit") &&
		typeof tu.input.file_path === "string" &&
		tu.input.file_path.startsWith("spec://")
	)
		return false;
	// A stopped but malformed argument stream is not executable input.
	if ("_raw" in tu.input) return false;
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
	return isStrictSerialToolExecution(tu);
}

type ReasoningBlockEntry = {
	text: string;
	providerMetadata?: ReasoningProviderMetadata;
	outputIndex?: number;
};

function reasoningBlockKey(event: {
	reasoningMetadata?: ReasoningProviderMetadata;
	reasoningOutputIndex?: number;
}): string {
	const openaiItemId = event.reasoningMetadata?.openai?.itemId;
	if (openaiItemId) return `openai:${openaiItemId}`;

	const anthropicBlockIndex = event.reasoningMetadata?.anthropic?.blockIndex;
	if (anthropicBlockIndex != null) return `anthropic:${anthropicBlockIndex}`;

	const geminiStepId = event.reasoningMetadata?.gemini?.stepId;
	if (geminiStepId) return `gemini:${geminiStepId}`;
	const geminiStepIndex = event.reasoningMetadata?.gemini?.stepIndex ?? event.reasoningOutputIndex;
	if (geminiStepIndex != null) return `gemini-index:${geminiStepIndex}`;

	return "__default";
}

/**
 * Stamp the current upstream identity onto reasoning metadata that carries a
 * replay-sensitive Anthropic or Gemini signature. This prevents a signature
 * minted by one server/channel from being echoed to another.
 */
function stampReasoningSource(
	metadata: ReasoningProviderMetadata | undefined,
	source: string | undefined,
): ReasoningProviderMetadata | undefined {
	if (!metadata || !source) return metadata;
	if (!metadata.anthropic?.signature && !metadata.gemini?.thoughtSignature) return metadata;
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
			blocks.push({ ...entry });
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

export function buildDangerReflectionPrompt(
	pause: DangerReflectionPermission,
	toolName: string,
	input: Record<string, unknown>,
	locale: Locale,
): string {
	const reflectionLevel = pause.reflectionLevel ?? "standard";
	const basePrompt = getPrompt("dangerReflection", locale)
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
	const appendPrompt = pause.appendPrompt?.trim();
	if (!appendPrompt) return basePrompt;
	// Appended last, after the level guidance and the mandatory tool-call contract, so caller
	// context can inform the judgement without displacing the decision rules above it.
	const heading =
		locale === "zh-CN"
			? "调用方补充的业务背景（仅供参考，不改变上述决策规则）："
			: "Additional context from the calling integration (advisory; it does not change the decision rules above):";
	return `${basePrompt}\n\n${heading}\n${appendPrompt}`;
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
		.replaceAll("{planText}", planText);
	if (!shouldAllowExitPlanReflectionAutoCompact(config)) return basePrompt;
	return `${basePrompt}\n\n${getPrompt("exitPlanReflectionAutoCompact", locale)}`;
}

/**
 * The reviewer prompt for a protected-task change.
 *
 * ⚠️ It asks about INTENT, not about evidence sufficiency. The wording it replaced led
 * with "is there concrete evidence that the task is complete", which has no upper bound —
 * a reviewer can always name one more unproven thing. One session lost 1.5 hours to five
 * consecutive denials of a task titled "阶段 0-4 全量验收" (full acceptance of phases 0-4);
 * by the last round the entire 3067-test suite passed and it was still denied for lacking
 * a standalone benchmark. Each denial was individually reasonable, and together they were
 * a loop, because the task itself had no decidable completion condition.
 *
 * Hence evidence serves the intent judgement rather than being the bar, and rewriting an
 * unbounded entry into a decidable one is an allowed repair instead of a violation.
 */
export function buildTaskReflectionPrompt(
	requestId: string,
	input: Record<string, unknown>,
	mutations: ProtectedTaskMutation[],
	locale: Locale,
): string {
	const decisionGuidance =
		locale === "zh-CN"
			? "\n\n你最多有两轮决策机会，每轮只调用一个允许的工具：TaskReflectConfirm 或 TaskReflectRevise。首次工具或参数错误可依据 tool result 在第二轮纠正；成功后立即结束，两轮仍未形成有效决策则不执行原修改。不要直接编辑任务文件。反馈及 nextSteps 应说明主助手能执行的工作，不要要求它调用反思专用工具。"
			: "\n\nYou have at most two decision responses; call exactly one allowed tool per response: TaskReflectConfirm or TaskReflectRevise. Correct a mistaken tool or invalid arguments using the tool result in the second response. Stop on success; without a valid decision after two responses, the original change will not execute. Do not edit the task file directly. Feedback and nextSteps must describe work the main assistant can perform, not ask it to call reflection-only tools.";
	if (locale === "zh-CN") {
		return (
			`你正在进行 taskReflection。主叙述者准备修改 spec://tasks.json 中的 protected task。\n\n请求 ID：${requestId}\n\n工具输入：\n${JSON.stringify(input, null, 2)}\n\n受影响的 protected task：\n${JSON.stringify(mutations, null, 2)}\n\n只需回答一个问题：这次修改是否违背了用户真正要求的东西？\n\n- 没有违背 → TaskReflectConfirm。\n- 违背（用户明确要求保证完成的事会被放弃、缩水，或未做完却标记为完成）→ TaskReflectRevise。\n\n证据用来帮你判断意图，不是审核标准本身。任何工作都能被要求更多证据，把"还能想出一件未被证明的事"当作驳回理由会产生无法通过的死循环。已有证据足以说明用户的实际诉求已满足时就确认，即使还能设想更完备的验收。\n\n如果该条目没有可判定的完成条件（"全量验收"、"确保质量"、"不得影响某处"这类无终点表述），它作为调度任务本身有缺陷，继续要证据只是浪费时间。此时把它改写成有明确完成条件的有限任务、或移除 protected 标记，都是合法纠正：只要用户的原始诉求仍以某种形式保留（改写后的任务、behavior_fence 或系统/项目指令）就确认。用户从未要求保证完成时同理。只有当改动实质上是在放弃用户要求的工作时才驳回。\n\ncreatedBy 字段影响保守程度，不替代上面的判断：createdBy=user、system 或 unknown 时要更保守，不能因为任务麻烦就完成、删除或改写；createdBy=assistant 仍不允许绕过真实的有限任务，但纠正它自己误建的条目门槛更低。\n\n驳回时 nextSteps 必须给出具体可完成的下一步。如果写不出"做完这一步就能通过"的指示，说明问题在任务的形式而非证据，应要求把它改写成有限任务。` +
			decisionGuidance
		);
	}
	return (
		`You are running taskReflection. The main narrator is about to change protected task(s) in spec://tasks.json.\n\nRequest ID: ${requestId}\n\nTool input:\n${JSON.stringify(input, null, 2)}\n\nAffected protected task mutations:\n${JSON.stringify(mutations, null, 2)}\n\nAnswer one question: does this change betray what the user actually asked for?\n\n- It does not → TaskReflectConfirm.\n- It does (work the user demanded be guaranteed would be dropped, watered down, or marked finished while incomplete) → TaskReflectRevise.\n\nEvidence helps you judge intent; it is not the standard itself. Any body of work admits a further demand for proof, so treating "one more thing could be proven" as grounds for denial produces a loop no change can pass. When the evidence already shows the user's real requirement is met, confirm — even if a more exhaustive acceptance is imaginable.\n\nIf the entry has no decidable completion condition ("full acceptance", "ensure quality", "must not affect X" — phrasings with no terminal state), it is malformed as a scheduler entry and demanding more evidence only burns time. Rewriting it into a finite task with an explicit completion condition, or removing the protected flag, is then a legitimate repair: confirm as long as the user's original requirement survives somewhere (the rewritten task, behavior_fence, or system/project instructions). The same holds when the user never demanded that guarantee. Deny only when the change amounts to abandoning work the user asked for.\n\nThe \`createdBy\` field weights how conservative to be; it does not replace the judgement above. For createdBy=user, system, or unknown, be more conservative — inconvenience never justifies completion, deletion, or rewriting. For createdBy=assistant, there is still no licence to bypass a real finite task, but repairing an entry it malformed itself carries a lower bar.\n\nWhen denying, nextSteps must name a concrete, completable action. If you cannot write an instruction of the form "do this and it passes", the problem is the task's shape rather than the evidence — require a rewrite into a finite task.` +
		decisionGuidance
	);
}

export interface ReflectionLoopRunOptions {
	parentConfig: AgentConfig;
	history: unknown[];
	prompt: string;
	reflectionLoop: NonNullable<AgentConfig["reflectionLoop"]>;
	abortController?: AbortController;
	/** Decision responses, hard-capped at two; transport retries have a separate budget. */
	maxTurns?: number;
	label?: string;
	/**
	 * Live two-phase progress while the gate deliberates. Called on a throttled
	 * cadence with cumulative counts (see `@shared/progress-phase`).
	 *
	 * Injected rather than broadcast here so this module stays free of any
	 * WebSocket dependency: each gate family owns its own pending map and routing
	 * identity, so only the caller can address the right card.
	 */
	onProgress?: (snapshot: ProgressSnapshot) => void;
	/**
	 * Whether the nested loop should inject the parent's system prompt itself.
	 *
	 * Defaults to `false` whenever a non-empty parent history is inherited: that
	 * history was already produced by the parent loop's own injection, so a second
	 * injection duplicates the prompt and shifts the cacheable prefix. Callers that
	 * pass a raw history with no system prompt of its own can set this to `true`.
	 */
	injectParentSystemPrompt?: boolean;
}

export interface ReflectionLoopObservation {
	assistantMessages: number;
	assistantText: string;
	assistantTextPreview: string;
	toolCalls: string[];
	toolResults: Array<{ toolName: string; isError: boolean; outputPreview: string }>;
	/** True only after a successful tool result from this gate's allowlist. */
	decisionSucceeded?: boolean;
	/** Valid danger fallback parsed from one response, never accumulated display text. */
	dangerTextDecision?: NonNullable<ReturnType<typeof parseDangerReflectionTextFallback>>;
	errors: string[];
	invalidStates: string[];
	/** Transient retries the nested loop performed before settling. */
	retries: number;
	/** Last retry message, kept so an exhausted retry chain can name its cause. */
	lastRetryMessage?: string;
	/**
	 * One user-facing sentence explaining why the loop produced no decision, or
	 * undefined when it decided normally.
	 *
	 * The gates used to discard this entirely: `observed.errors` went to the log and the
	 * card showed a generic "did not call DangerConfirm or DangerCancel", so a provider
	 * 520, an exhausted retry chain, and a model that simply answered in prose were all
	 * indistinguishable to the person deciding whether to retry or take over.
	 */
	failureSummary?: string;
}

/** Longest failure reason surfaced to a card; long provider HTML gets clipped. */
const REFLECTION_FAILURE_SUMMARY_LIMIT = 300;

export function buildReflectionFallbackMessage(
	gateLabel: string,
	failureSummary: string | undefined,
	locale: Locale = "en",
): string {
	const zh = locale === "zh-CN";
	const label =
		gateLabel === "ExitPlanMode reflection"
			? zh
				? "计划检查"
				: "Plan check"
			: gateLabel === "taskReflection"
				? zh
					? "任务状态检查"
					: "Task status check"
				: zh
					? "操作安全检查"
					: "Operation safety check";
	// Tool results contain instructions for the INTERNAL reviewer. Never forward them
	// to the main assistant or a human, who cannot use reflection decision tools.
	let cause: string;
	if (failureSummary?.startsWith("provider error")) {
		cause = zh ? "模型服务请求失败" : "the model service request failed";
	} else if (failureSummary?.includes("crashed")) {
		cause = zh ? "检查流程发生内部错误" : "the check encountered an internal error";
	} else if (failureSummary?.startsWith("invalid provider response")) {
		cause = zh ? "模型服务返回了无法处理的响应" : "the model service returned an unusable response";
	} else if (failureSummary?.includes("rejected")) {
		cause = zh
			? "检查助手调用了不允许的工具或使用了无效参数"
			: "the reviewer used a disallowed tool or invalid arguments";
	} else {
		cause = zh
			? "检查助手未能在最多两轮回复内给出有效决策"
			: "the reviewer did not produce a valid decision within at most two responses";
	}
	const next =
		gateLabel === "ExitPlanMode reflection"
			? zh
				? "计划尚未提交，执行阶段未开始。这不代表计划内容被否决；无需仅因本次检查失败修改计划。确认计划仍有效后，可重新提交 ExitPlanMode；若持续失败，向用户报告检查故障。"
				: "The plan was not submitted and implementation has not started. This is not a rejection of the plan's content; do not revise it solely because this check failed. If the plan is still valid, resubmit ExitPlanMode; report the check failure to the user if it persists."
			: gateLabel === "taskReflection"
				? zh
					? "任务状态修改未执行，原任务状态保留。这不代表完成证据已被否定；确认依据仍有效后可重新提交原修改，持续失败时向用户报告检查故障。"
					: "The task status change did not execute; the original task status is preserved. This does not reject the completion evidence. Resubmit the original change if its evidence remains valid; report the check failure to the user if it persists."
				: zh
					? "待检查的操作未获准执行。这不是风险审查的实质否决；重新确认操作仍符合用户意图后可重试，或选择更安全的替代方案；持续失败时请求人工处理。"
					: "The pending operation was not authorized to execute. This is not a substantive risk rejection. Reconfirm that it still matches the user's intent before retrying, or choose a safer alternative; request human handling if the check keeps failing.";
	return zh
		? `${label}未完成：${cause}。${next}`
		: `${label} could not complete: ${cause}. ${next}`;
}

/**
 * Collapse whitespace and clip, so an HTML error page (Cloudflare 520s arrive as a full
 * document) becomes one readable line instead of flooding the card and the DB row.
 */
function condenseReflectionFailure(text: string): string {
	const flat = text
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return flat.length > REFLECTION_FAILURE_SUMMARY_LIMIT
		? `${flat.slice(0, REFLECTION_FAILURE_SUMMARY_LIMIT)}…`
		: flat;
}

/**
 * Derive the user-facing failure reason from what the nested loop actually observed.
 *
 * Ordered by diagnostic value: a hard error names the cause, an invalid state names the
 * protocol fault, an errored decision tool names the rejected call, and retries alone at
 * least say the attempt was made. A loop that called its decision tool successfully has no
 * failure at all.
 */
export function summarizeReflectionFailure(
	observed: ReflectionLoopObservation,
	options: { threw?: boolean } = {},
): string | undefined {
	if (observed.errors.length > 0) {
		const detail = condenseReflectionFailure(observed.errors[0]);
		return observed.retries > 0
			? `provider error after ${observed.retries} ${observed.retries === 1 ? "retry" : "retries"}: ${detail}`
			: `provider error: ${detail}`;
	}
	if (observed.invalidStates.length > 0) {
		return `invalid provider response: ${condenseReflectionFailure(observed.invalidStates[0])}`;
	}
	if (observed.decisionSucceeded || observed.dangerTextDecision) return undefined;
	const erroredTool = observed.toolResults.find((result) => result.isError);
	if (erroredTool) {
		return `the ${erroredTool.toolName} tool call was rejected: ${condenseReflectionFailure(
			erroredTool.outputPreview,
		)}`;
	}
	if (options.threw) return "the reflection loop crashed before producing a decision";
	if (observed.toolCalls.length > 0) return undefined;
	if (observed.retries > 0) {
		const detail = observed.lastRetryMessage
			? `: ${condenseReflectionFailure(observed.lastRetryMessage)}`
			: "";
		return `no decision after ${observed.retries} ${
			observed.retries === 1 ? "retry" : "retries"
		}${detail}`;
	}
	if (observed.assistantMessages === 0) return "the model returned an empty response";
	return "the model replied without calling a decision tool";
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
			contextSnapshot: event.contextSnapshot,
			meterUsage: event.meterUsage ?? null,
			meterUnit: event.meterUnit ?? null,
			errorMessage: event.errorMessage ?? null,
			rawDump: event.rawDump,
			dumpSpillReuseToken: event.dumpSpillReuseToken,
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
// Wire declarations are independent of execution policy. Capture the actual parent
// request, including its adapter/model, rather than re-resolving dynamic definitions.
const requestToolSnapshots = new WeakMap<
	AgentConfig,
	{
		adapter: ReturnType<typeof resolveProviderAndModel>["adapter"];
		provider: string;
		model: string;
		tools: unknown[];
	}
>();
const inheritedPromptConfigs = new WeakSet<AgentConfig>();

function buildReflectionCorrectionPrompt(config: AgentConfig): string {
	const tools = config.reflectionLoop?.allowedTools.join(", ") ?? "";
	const strict = config.reflectionLoop?.context.purpose === "permissionRuleRequest";
	const budget = strict ? "一轮" : "两轮";
	return config.locale === "zh-CN"
		? `检查尚未形成有效决策。你最多有${budget}决策机会；如仍有下一轮，请根据工具结果纠正工具或参数，且只调用一个当前允许的决策工具：${tools}。不要执行原操作，也不要直接修改文件；通过决策返回具体反馈，由主助手处理。不要要求主助手调用反思专用工具。`
		: `The check has not produced a valid decision. You have at most ${strict ? "one decision response" : "two decision responses"}; if another remains, correct the tool or arguments using its result and call exactly one currently allowed decision tool: ${tools}. Do not execute the original operation or edit files; return concrete feedback through the decision for the main assistant to act on. Do not ask the main assistant to call reflection-only tools.`;
}
export async function runReflectionLoop(
	options: ReflectionLoopRunOptions,
): Promise<ReflectionLoopObservation> {
	const {
		parentConfig,
		history,
		prompt,
		reflectionLoop,
		abortController = new AbortController(),
		maxTurns = 2,
		label = "reflection loop",
		onProgress,
		injectParentSystemPrompt,
	} = options;
	const allowedTools = new Set(reflectionLoop.allowedTools);
	const progress = createThrottledProgressReporter(onProgress);
	// The history handed to us is the parent agentLoop's own post-injection array:
	// agentLoop calls injectSystemPrompt once before its turn loop, so a non-empty
	// inherited history already carries the system prompt as its leading entry.
	//
	// Letting the nested loop inject again produced two copies — a stray
	// `__SYSTEM__:` user block on Anthropic, doubled `instructions` on
	// the duplicate lands at the very front, it shifted every following byte and
	// destroyed the cacheable prefix this loop shares with the parent
	// conversation. Prompt caching is a byte-exact prefix match, so a reflection
	// on a 200k-token conversation re-billed the whole prefix at full price.
	//
	// `injectParentSystemPrompt` lets a caller that builds a raw history (rather
	// than inheriting the parent's) opt back in.
	const inheritsInjectedSystemPrompt =
		injectParentSystemPrompt === undefined ? history.length > 0 : !injectParentSystemPrompt;
	const pendingApiRequests = new Map<string, ApiRequestHandle>();
	const observed: ReflectionLoopObservation = {
		assistantMessages: 0,
		assistantText: "",
		assistantTextPreview: "",
		toolCalls: [],
		toolResults: [],
		errors: [],
		invalidStates: [],
		retries: 0,
	};
	const onParentAbort = () => abortController.abort();
	if (parentConfig.signal.aborted) onParentAbort();
	else parentConfig.signal.addEventListener("abort", onParentAbort, { once: true });
	try {
		const reflectionConfig: AgentConfig = {
			...parentConfig,
			signal: abortController.signal,
			maxTurns: Number.isFinite(maxTurns) ? Math.max(1, Math.min(2, Math.floor(maxTurns))) : 2,
			reflectionLoop,
			// Keep systemPrompt available to dynamic tool definitions; suppress only injection.
			getRuntimeSettingsOverride: undefined,
			getModelOverride: undefined,
			// Auxiliary inputs cannot replace or pin the parent conversation's classification.
			freezeContextComposition: undefined,
			onToolsCharacters: undefined,
			// Auxiliary decision tools are not the original filesystem execution attempt.
			onToolExecutionFinalAuthorization: undefined,
			// Reflection is an auxiliary call: follow the user's retry policy but
			// hard-cap attempts (e.g. don't inherit an infinite/-1 or oversized
			// maxTransientRetries from the parent primary loop).
			maxTransientRetries: getAuxiliaryMaxRetries(parentConfig.maxTransientRetries),
			onEvent: undefined,
			onBeforeTurn: undefined,
			// A reflection is an auxiliary call inside the parent's turn. It must not deliver
			// injections: the reminders belong to the parent conversation, and writing rows
			// from here would put them in the transcript twice (once now, once when the parent
			// reaches its own boundary).
			deliverInjectionRow: undefined,
			getAfterToolsInjections: undefined,
			onCompletedToolCount: undefined,
			silentToolCallThreshold: -1,
			shouldStop: () => observed.decisionSucceeded === true,
			guidanceSignal: undefined,
			urgentGuidanceSignal: undefined,
			onToolExecutionInvoking: undefined,
			// Declaration filtering remains inherited; execution uses the gate's hard ceiling.
			allowedTools: new Set(reflectionLoop.allowedTools),
			disabledTools: undefined,
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
		if (inheritsInjectedSystemPrompt) inheritedPromptConfigs.add(reflectionConfig);
		const snapshot = requestToolSnapshots.get(parentConfig);
		if (snapshot) requestToolSnapshots.set(reflectionConfig, snapshot);
		for await (const event of agentLoop(reflectionConfig, prompt, [...history])) {
			if (event.type === "api_request_start") {
				pendingApiRequests.set(
					event.requestId,
					startApiRequest({
						narratorId: parentConfig.narratorId,
						userId: parentConfig.userId,
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
			if (event.type === "stream_reasoning") {
				progress.addThinking(event.text);
				continue;
			}
			if (event.type === "stream_text") {
				progress.addOutput(event.text);
				continue;
			}
			if (event.type === "assistant_message") {
				observed.assistantMessages++;
				if (event.text) {
					observed.assistantText = `${observed.assistantText}${event.text}`.slice(0, 4000);
					if (
						reflectionLoop.context.kind === "dangerReflection" &&
						reflectionLoop.context.purpose !== "permissionRuleRequest"
					) {
						const textDecision = parseDangerReflectionTextFallback(event.text);
						if (textDecision) observed.dangerTextDecision = textDecision;
					}
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
				if (!event.isError && allowedTools.has(event.toolName)) observed.decisionSucceeded = true;
				observed.toolResults.push({
					toolName: event.toolName,
					isError: event.isError,
					outputPreview: event.output.slice(0, 500),
				});
			} else if (event.type === "invalid_state") {
				observed.invalidStates.push(`${event.reason}: ${event.message}`);
			} else if (event.type === "retrying") {
				// Retries were previously invisible: the nested loop swallowed the event, so a
				// gate that quietly burned its whole auxiliary retry budget looked identical to
				// one that answered on the first try. Counting them lets the failure reason say
				// how hard we tried, and lets a caller report live retry progress.
				observed.retries++;
				observed.lastRetryMessage = event.message;
				logger.warn(`${label} retrying after a transient error`, {
					narratorId: parentConfig.narratorId,
					kind: reflectionLoop.context.kind,
					requestId: reflectionLoop.context.requestId,
					attempt: event.attempt,
					maxRetries: event.maxRetries,
					delayMs: event.delayMs,
					message: event.message,
				});
			} else if (event.type === "error") {
				observed.errors.push(event.message);
				logger.warn(`${label} ended with error`, {
					narratorId: parentConfig.narratorId,
					kind: reflectionLoop.context.kind,
					requestId: reflectionLoop.context.requestId,
					retries: observed.retries,
					message: event.message,
				});
			}
		}
		if (
			reflectionLoop.context.purpose === "permissionRuleRequest" &&
			(abortController.signal.aborted || pendingApiRequests.size > 0)
		)
			observed.errors.push(
				"Permission rule reflection did not finish its provider request normally",
			);
		observed.failureSummary = summarizeReflectionFailure(observed);
		if (!observed.decisionSucceeded && !observed.dangerTextDecision) {
			logger.warn(`${label} completed without a successful reflection tool decision`, {
				narratorId: parentConfig.narratorId,
				kind: reflectionLoop.context.kind,
				requestId: reflectionLoop.context.requestId,
				allowedTools: [...reflectionLoop.allowedTools],
				...observed,
			});
		}
		return observed;
	} finally {
		progress.finish();
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
	const { broadcastDangerReflectionProgress } = await import(
		"@server/services/narrator-permission"
	);
	return runReflectionLoop({
		parentConfig,
		history,
		prompt: buildDangerReflectionPrompt(pause, toolUse.name, pause.input, locale),
		onProgress: (snapshot) => broadcastDangerReflectionProgress(pause.requestId, snapshot),
		reflectionLoop: {
			allowedTools: [...DANGER_REFLECTION_TOOLS],
			context: {
				kind: "dangerReflection",
				purpose: pause.purpose,
				requestId: pause.requestId,
				toolUseId: toolUse.toolUseId,
				data: {
					toolName: toolUse.name,
					fingerprint: pause.fingerprint,
				},
			},
		},
		abortController: reflectionAbort,
		// Permission-rule approvals require a single clean decision; preserve that
		// stricter security contract rather than accepting a corrected approval.
		maxTurns: pause.purpose === "permissionRuleRequest" ? 1 : 2,
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
): Promise<ReflectionLoopObservation> {
	const locale = (parentConfig.locale as Locale) ?? "en";
	return runReflectionLoop({
		parentConfig,
		history,
		prompt: buildExitPlanReflectionPrompt(requestId, input, locale, parentConfig),
		onProgress: (snapshot) => void broadcastPlanReflectionProgress(requestId, snapshot),
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
		maxTurns: 2,
		label: "ExitPlanMode reflection loop",
	});
}

async function runTaskReflectionLoop(
	parentConfig: AgentConfig,
	history: unknown[],
	requestId: string,
	toolUse: AgentToolUse,
	input: Record<string, unknown>,
	mutations: ProtectedTaskMutation[],
	reflectionAbort: AbortController,
): Promise<ReflectionLoopObservation> {
	const locale = (parentConfig.locale as Locale) ?? "en";
	return runReflectionLoop({
		parentConfig,
		history,
		prompt: buildTaskReflectionPrompt(requestId, input, mutations, locale),
		onProgress: (snapshot) => void broadcastTaskReflectionProgress(requestId, snapshot),
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
		maxTurns: 2,
		label: "Task reflection loop",
	});
}

function parseDangerReflectionTextFallback(
	text: string,
): { action: "confirm"; reflection?: string } | { action: "cancel"; reason?: string } | null {
	// Keep fallback JSON parsing bounded, independently of accumulated display text.
	const match = text.slice(0, 4000).match(/<DangerDecision>\s*([\s\S]*?)\s*<\/DangerDecision>/i);
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

/**
 * Drop the in-memory pause entry for a decided gate.
 *
 * A user takeover (`reflectionStoppedByUser`) deliberately keeps the entry alive: the decision
 * moved to the user and `resolvePermissionOrDangerReflection` still needs to find it.
 */
async function discardDangerReflectionRuntimeState(requestId: string): Promise<void> {
	try {
		const { pendingDangerReflections } = await import("@server/services/narrator-session-state");
		const pending = pendingDangerReflections.get(requestId);
		if (!pending || pending.reflectionStoppedByUser) return;
		pending.cleanup();
		pendingDangerReflections.delete(requestId);
	} catch (err) {
		logger.warn("Failed to discard danger reflection runtime state", {
			requestId,
			err: String(err),
		});
	}
}

export async function resolveDangerReflectionDecision(
	config: AgentConfig,
	history: unknown[],
	pause: DangerReflectionPermission,
	toolUse: AgentToolUse,
): Promise<PermissionResult> {
	const reflectionAbort = new AbortController();
	await setDangerReflectionAbortController(pause.requestId, reflectionAbort);
	let reflectionDone = false;
	// The `.catch()` must sit HERE, at the source, not on the race arm below.
	//
	// A bare `reflectionPromise.then(onFulfilled)` propagates a rejection straight into
	// `Promise.race`, so a throwing reflection loop (an unresolvable model id reaching
	// `resolveProviderAndModel`, a failed dynamic import, a SQLite error while recording the
	// auxiliary request) rejected this whole function and SKIPPED the fallback below. Nothing
	// then resolved `pause.decision`, nothing wrote the tool row, and nothing removed the
	// `pendingDangerReflections` entry — the gate stayed `pending`/`running` forever, showing a
	// "still reflecting" card that survived reloads because the backend really was stuck.
	//
	// Converting the rejection to a fulfilment keeps the fallback path reachable, which is what
	// cancels the gate and converges the row. The plan and task gates already do exactly this.
	const reflectionPromise = runDangerReflectionLoop(
		config,
		history,
		pause,
		toolUse,
		reflectionAbort,
	)
		.catch((err) => {
			const crashMessage = extractErrorMessage(err);
			logger.warn("Danger reflection loop ended unexpectedly", {
				narratorId: config.narratorId,
				requestId: pause.requestId,
				err: crashMessage,
			});
			// Preserve the crash as a normal observation so the fallback below can name it.
			// Returning bare `undefined` here is what made every crash surface as the generic
			// "did not call DangerConfirm or DangerCancel".
			const crashed: ReflectionLoopObservation = {
				assistantMessages: 0,
				assistantText: "",
				assistantTextPreview: "",
				toolCalls: [],
				toolResults: [],
				errors: [crashMessage],
				invalidStates: [],
				retries: 0,
			};
			crashed.failureSummary = summarizeReflectionFailure(crashed, { threw: true });
			return crashed;
		})
		.finally(() => {
			reflectionDone = true;
		});
	if (pause.purpose === "permissionRuleRequest") {
		// Confirm is only a candidate in this domain. Await clean provider/loop completion
		// before letting the permission service persist approval and consume the receipt.
		const observed = await reflectionPromise;
		const completedNormally =
			!config.signal.aborted &&
			!reflectionAbort.signal.aborted &&
			observed.errors.length === 0 &&
			observed.invalidStates.length === 0;
		const validToolDecision =
			observed.toolResults.filter(
				(result) => result.toolName === "DangerConfirm" && !result.isError,
			).length === 1 &&
			!observed.toolResults.some((result) => result.isError || result.toolName === "DangerCancel");
		const { completePermissionRuleRequestReflection, cancelDangerReflection } = await import(
			"@server/services/narrator-permission"
		);
		const completed = await completePermissionRuleRequestReflection(pause.requestId, {
			completedNormally,
			validToolDecision,
			usedTextFallback: false,
		});
		if (!completed && !(await isDangerReflectionWaitingForUser(pause.requestId))) {
			await cancelDangerReflection(
				pause.requestId,
				"Permission rule reflection did not complete with a valid tool decision",
				undefined,
				{ failed: true },
			);
		}
		const decision = await pause.decision;
		await discardDangerReflectionRuntimeState(pause.requestId);
		return decision;
	}
	const decision = await Promise.race([
		pause.decision.finally(() => reflectionAbort.abort()),
		reflectionPromise.then(async (observed) => {
			if (await isDangerReflectionWaitingForUser(pause.requestId)) {
				return pause.decision;
			}

			const textFallback = observed.dangerTextDecision;
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

			// Name the actual cause. The gate is being denied either way, but "provider error
			// after 3 retries: 520 Web server is returning an unknown error" tells the user to
			// retry, whereas "the model replied without calling a decision tool" tells them the
			// model misbehaved — the old single generic sentence told them neither.
			const fallbackMessage = buildReflectionFallbackMessage(
				"Danger reflection",
				observed.failureSummary,
				(config.locale as Locale) ?? "en",
			);
			const { cancelDangerReflection } = await import("@server/services/narrator-permission");
			const cancelled = await cancelDangerReflection(pause.requestId, fallbackMessage, undefined, {
				failed: true,
			});
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
	// Whichever arm won, this gate is decided. A surviving runtime entry would keep the
	// narrator tagged "reflecting" and let a later takeover act on a resolved gate, so drop
	// it unconditionally — every resolve path is idempotent about an already-removed entry.
	await discardDangerReflectionRuntimeState(pause.requestId);
	return decision;
}

interface ExitPlanReflectionGateResult {
	checkFailed?: boolean;
	decision: ExitPlanReflectionDecision | { action: "manual"; reason?: string };
	input: Record<string, unknown>;
}

export async function resolveExitPlanModeReflection(
	config: AgentConfig,
	history: unknown[],
	toolUse: AgentToolUse,
): Promise<ExitPlanReflectionGateResult> {
	const locale = (config.locale as Locale) ?? "en";
	const { loadPlanFileReadPolicy, resolveExitPlanModeInputWithBackend } = await import(
		"@server/services/narrator-permission"
	);
	const planReadPolicy = await loadPlanFileReadPolicy(config.narratorId);
	const resolvedInput = await resolveExitPlanModeInputWithBackend(
		config.narratorId,
		config.cwd,
		toolUse.input,
		locale,
		config.relaxedPlan === true,
		config.executionBackend,
		config.executionTarget,
		config.planFilePath,
		planReadPolicy,
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
		parentToolUseId: config.parentToolUseId,
		toolUseId: toolUse.toolUseId,
		toolName: toolUse.name,
		inputJson: resolvedInput.input,
		abortController: reflectionAbort,
	});
	const onPreparationAbort = () => {
		reflectionAbort.abort(config.signal.reason);
		void cancelExitPlanReflection(requestId, "Tool preparation cancelled");
	};
	if (config.signal.aborted) onPreparationAbort();
	else config.signal.addEventListener("abort", onPreparationAbort, { once: true });
	await markExitPlanReflectionStarted(requestId);
	let reflectionDone = false;
	let failedCheckFeedback: string | undefined;
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
				const crashMessage = extractErrorMessage(err);
				logger.warn("ExitPlanMode reflection loop ended unexpectedly", { err: crashMessage });
				return crashMessage;
			})
			.then(async (outcome) => {
				if (isExitPlanReflectionWaitingForUser(requestId)) {
					return { action: "manual" as const };
				}
				// Failure is not a substantive revision decision. Feedback here is addressed
				// to the main assistant/user, never to the internal reflection reviewer.
				const failureSummary =
					typeof outcome === "string"
						? `the reflection loop crashed before producing a decision: ${outcome}`
						: outcome.failureSummary;
				const fallbackMessage = buildReflectionFallbackMessage(
					"ExitPlanMode reflection",
					failureSummary,
					locale,
				);
				failedCheckFeedback = fallbackMessage;
				const cancelled = await cancelExitPlanReflection(requestId, fallbackMessage, {
					failed: true,
				});
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
	config.signal.removeEventListener("abort", onPreparationAbort);
	cleanupExitPlanReflection(requestId);
	return {
		decision,
		input: resolvedInput.input,
		// The decision promise can win the race before cancelExitPlanReflection's
		// await resumes. Derive the outcome from the winning decision, not timing.
		checkFailed: decision.action === "revise" && decision.feedback === failedCheckFeedback,
	};
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

type PlanReflectionOverrideRow = {
	planReflectionAutoApproveOverride?: unknown;
};

type PlanReflectionOverrideLoader = (
	narratorId: string,
) => Promise<PlanReflectionOverrideRow | null>;

/**
 * Test seam for the ExitPlanMode reflection gate's decision-time DB reload.
 * Production always uses narratorService.getById; tests inject a loader to pin
 * the "pass-start snapshot vs live override" split without a real database.
 */
let planReflectionOverrideLoader: PlanReflectionOverrideLoader | null = null;

export function setPlanReflectionOverrideLoaderForTests(
	loader: PlanReflectionOverrideLoader | null,
): void {
	planReflectionOverrideLoader = loader;
}

async function loadLivePlanReflectionAutoApproveOverride(
	narratorId: string,
): Promise<BooleanOverride | undefined> {
	// undefined = reload failed / narrator missing → keep the pass-start snapshot.
	const loader: PlanReflectionOverrideLoader =
		planReflectionOverrideLoader ??
		(async (id) => {
			const { narratorService } = await import("../../services/narrator-service");
			return narratorService.getById(id);
		});
	try {
		const row = await loader(narratorId);
		if (!row) return undefined;
		return normalizeBooleanOverride(row.planReflectionAutoApproveOverride);
	} catch (err) {
		logger.debug("Live plan-reflection override reload failed; using pass snapshot", {
			narratorId,
			err: err instanceof Error ? err.message : String(err),
		});
		return undefined;
	}
}

/**
 * Decision-time gate for ExitPlanMode plan reflection.
 *
 * AgentConfig freezes `planReflectionAutoApproveOverride` when a pass starts, so
 * flipping the permission-menu switch mid-turn used to leave ExitPlanMode running
 * reflection under the old snapshot. This wrapper re-reads the narrator row at the
 * tool-routing decision point (option B): a successful reload always wins over the
 * frozen config; a failed reload falls back to the snapshot so the gate still works
 * when the DB is briefly unavailable.
 */
export async function shouldRunExitPlanModeReflectionLive(
	config: Pick<
		AgentConfig,
		| "narratorId"
		| "reflectionLoop"
		| "permissionMode"
		| "planReflectionAutoApprove"
		| "planReflectionAutoApproveOverride"
	>,
): Promise<boolean> {
	const liveOverride = await loadLivePlanReflectionAutoApproveOverride(config.narratorId);
	return shouldRunExitPlanModeReflection({
		reflectionLoop: config.reflectionLoop,
		permissionMode: config.permissionMode,
		planReflectionAutoApprove: config.planReflectionAutoApprove,
		planReflectionAutoApproveOverride:
			liveOverride !== undefined ? liveOverride : config.planReflectionAutoApproveOverride,
	});
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

export function buildExitPlanReflectionDeniedToolResult(
	decision: ExitPlanReflectionDecision,
	locale: Locale,
	checkFailed = false,
): ToolExecResult {
	if (checkFailed) {
		return {
			output:
				decision.action === "revise"
					? decision.feedback
					: buildReflectionFallbackMessage("ExitPlanMode reflection", undefined, locale),
			isError: true,
			durationMs: 0,
			completedAt: Date.now(),
		};
	}
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

export function buildTaskReflectionDenialFingerprint(mutations: ProtectedTaskMutation[]): string {
	const normalized = mutations
		.map((mutation) => ({
			kind: mutation.kind,
			text: mutation.text,
			createdBy: mutation.createdBy,
		}))
		.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
	return JSON.stringify(normalized);
}

function buildTaskReflectionDeniedToolResult(
	decision: TaskReflectionDecision,
	locale: Locale,
	mutations: ProtectedTaskMutation[],
	checkFailed = false,
): ToolExecResult {
	if (checkFailed) {
		return {
			output:
				decision.action === "revise"
					? decision.feedback
					: buildReflectionFallbackMessage("taskReflection", undefined, locale),
			isError: true,
			durationMs: 0,
			completedAt: Date.now(),
		};
	}
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
	return {
		output,
		isError: true,
		durationMs: 0,
		completedAt: Date.now(),
		metadata: {
			taskReflection: {
				decision: "revise",
				fingerprint: buildTaskReflectionDenialFingerprint(mutations),
			},
		},
	};
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
): Promise<{
	decision: TaskReflectionDecision;
	checkFailed?: boolean;
	input: Record<string, unknown>;
	mutations: ProtectedTaskMutation[];
} | null> {
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
		parentToolUseId: config.parentToolUseId,
		toolUseId: toolUse.toolUseId,
		toolName: toolUse.name,
		inputJson: input,
		mutations: analysis.protectedMutations,
		abortController: reflectionAbort,
	});
	const onPreparationAbort = () => {
		reflectionAbort.abort(config.signal.reason);
		void reviseTaskReflection(requestId, "Tool preparation cancelled", undefined, "user");
	};
	if (config.signal.aborted) onPreparationAbort();
	else config.signal.addEventListener("abort", onPreparationAbort, { once: true });
	await markTaskReflectionStarted(requestId);
	let reflectionDone = false;
	let failedCheckFeedback: string | undefined;
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
			const crashMessage = extractErrorMessage(err);
			logger.warn("Task reflection loop ended unexpectedly", { err: crashMessage });
			return crashMessage;
		})
		.finally(() => {
			reflectionDone = true;
		});
	const decision = await Promise.race([
		decisionPromise.finally(() => reflectionAbort.abort()),
		reflectionPromise.then(async (outcome) => {
			// The user took over: hand the decision to their approve/deny instead of
			// letting the AI reflection fall back (mirrors danger/plan takeover).
			if (isTaskReflectionWaitingForUser(requestId)) return decisionPromise;

			const failureSummary =
				typeof outcome === "string"
					? `the reflection loop crashed before producing a decision: ${outcome}`
					: outcome.failureSummary;
			const fallbackMessage = buildReflectionFallbackMessage(
				"taskReflection",
				failureSummary,
				(config.locale as Locale) ?? "en",
			);
			const fallbackNextSteps =
				config.locale === "zh-CN"
					? "保留原任务状态，确认已有证据仍有效后重新提交原修改；若检查持续失败，向用户报告。"
					: "Keep the original task status; resubmit the original change if its evidence remains valid. Report persistent check failures to the user.";
			// Persist/broadcast check failure, not a substantive task revision decision.
			failedCheckFeedback = fallbackMessage;
			const cancelled = await reviseTaskReflection(
				requestId,
				fallbackMessage,
				fallbackNextSteps,
				undefined,
				{ failed: true },
			);
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
	config.signal.removeEventListener("abort", onPreparationAbort);
	cleanupTaskReflection(requestId);
	return {
		decision,
		input,
		mutations: analysis.protectedMutations,
		checkFailed: decision.action === "revise" && decision.feedback === failedCheckFeedback,
	};
}

interface ExecuteToolAfterReflectionsOptions {
	admissionState?: ToolAdmissionState;
	preAdmissionComplete?: boolean;
}

async function executeToolAfterReflections(
	tu: AgentToolUse,
	config: AgentConfig,
	history: unknown[],
	locale: Locale,
	options: ExecuteToolAfterReflectionsOptions = {},
): Promise<ToolExecResult> {
	const admissionState = options.admissionState ?? {};
	const reflectionRejection = getReflectionToolRejection(tu, config);
	if (reflectionRejection) {
		releaseToolAdmissionState(admissionState);
		return reflectionRejection;
	}
	let preFrozenExecution: Awaited<ReturnType<typeof freezeToolExecution>>;
	let preAdmissionComplete = options.preAdmissionComplete === true;
	if (!preAdmissionComplete || !admissionState.startGrant) {
		await preAdmitToolExecution(tu, config, { state: admissionState });
		preAdmissionComplete = true;
	}
	let admissionHandedToExecutor = false;
	try {
		const freezeExecution = async (): Promise<void> => {
			if (!preFrozenExecution) preFrozenExecution = await freezeToolExecution(tu, config);
		};
		if (tu.name === "ExitPlanMode") {
			try {
				// Plan reflection may inspect the target before executeTool starts. Update admission
				// has already completed, so routing cannot run ahead of the phase-two gate.
				await freezeExecution();
			} catch (err) {
				return {
					output: `Tool routing error: ${err instanceof Error ? err.message : String(err)}`,
					isError: true,
					durationMs: 0,
					completedAt: Date.now(),
				};
			}
		}

		const executeAfterPreAdmission = async (
			executeOptions: Parameters<typeof executeTool>[2] = {},
		): Promise<ToolExecResult> => {
			admissionHandedToExecutor = true;
			const result = await executeTool(tu, config, {
				...executeOptions,
				admissionState,
				preAdmissionComplete,
				...(preFrozenExecution && { preFrozenTarget: preFrozenExecution.target }),
			});
			return config.reflectionLoop && result.isError
				? { ...result, output: `${result.output}\n\n${buildReflectionCorrectionPrompt(config)}` }
				: result;
		};

		// Decision-time reload: the permission-menu "计划反思" switch must apply to a
		// still-running pass, not only to the next AgentConfig snapshot.
		if (tu.name === "ExitPlanMode" && (await shouldRunExitPlanModeReflectionLive(config))) {
			const reflectionConfig = preFrozenExecution
				? {
						...config,
						executionBackend: preFrozenExecution.backend,
						executionTarget: preFrozenExecution.target,
					}
				: config;
			const reflected = await resolveExitPlanModeReflection(reflectionConfig, history, tu);
			if (reflected.decision.action === "manual") {
				tu.input = reflected.input;
				// User manually took over the plan reflection; the loop falls back to the
				// normal ExitPlanMode approval. They are already driving this, so the
				// fallback permission request must not raise a user-facing notification.
				return executeAfterPreAdmission({ suppressAttention: true });
			}
			if (
				reflected.decision.action !== "confirm" &&
				reflected.decision.action !== "confirm_compact"
			) {
				return buildExitPlanReflectionDeniedToolResult(
					reflected.decision,
					locale,
					reflected.checkFailed,
				);
			}

			const shouldCompact = reflected.decision.action === "confirm_compact";
			if (shouldCompact) {
				const { pendingPlanCompact } = await import("@server/services/narrator-session-state");
				pendingPlanCompact.add(config.narratorId);
			}

			// Mark the plan-approval source so the `_planApprovedContinue` persistence
			// branch attributes the injected "plan approved, begin execution" turn to
			// the plan reflection (left bubble, "计划反思") instead of a generic
			// auto-continuation system card or a human user.
			const { pendingPlanApproverSource } = await import("@server/services/narrator-session-state");
			pendingPlanApproverSource.set(config.narratorId, "reflection");

			// Reflection confirmed — skip user approval and execute directly. Keep tu.input as the
			// original model input so executeTool emits updatedInput and the event handler persists
			// the resolved plan before onExitPlanMode reads it for optional plan compact.
			const result = await executeAfterPreAdmission({
				preGrantedPermission: { behavior: "allow", updatedInput: { ...reflected.input } },
			});
			if (result.isError) {
				// The plan was never approved-and-continued, so both markers are stale. Left
				// behind, `pendingPlanApproverSource` would attribute the NEXT approval in
				// this same loop — possibly a real person's — to the reflection.
				const { pendingPlanCompact } = await import("@server/services/narrator-session-state");
				if (shouldCompact) pendingPlanCompact.delete(config.narratorId);
				pendingPlanApproverSource.delete(config.narratorId);
			}
			return result;
		}
		if ((tu.name === "Write" || tu.name === "Edit") && shouldRunTaskReflection(config)) {
			const candidateContent = await buildSpecTasksCandidateContent(config.narratorId, tu);
			if (candidateContent != null) {
				try {
					// taskReflection persists permission-like status on the original row. Admission
					// already passed; now freeze the deterministic spec target before reflection.
					await freezeExecution();
					const reflected = await resolveTaskReflection(config, history, tu, candidateContent);
					if (reflected) {
						tu.input = reflected.input;
						if (reflected.decision.action !== "confirm") {
							return buildTaskReflectionDeniedToolResult(
								reflected.decision,
								locale,
								reflected.mutations,
								reflected.checkFailed,
							);
						}
						grantTaskReflection(config.narratorId, tu.toolUseId);
						try {
							const result = await executeAfterPreAdmission();
							// Surface the reflection's conclusion back to the main model so it knows
							// on what basis the protected task change was allowed to proceed.
							if (!result.isError) {
								return {
									...result,
									output: appendTaskReflectionConfirmation(
										result.output,
										reflected.decision,
										locale,
									),
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
		return executeAfterPreAdmission();
	} finally {
		if (!admissionHandedToExecutor) releaseToolAdmissionState(admissionState);
	}
}

/**
 * Core agent loop. Delegates all provider-specific logic to a ProviderAdapter.
 * Yields AgentEvent objects for the caller to consume.
 */
export function agentLoop(
	...args: Parameters<typeof agentLoopInMetadataSnapshot>
): ReturnType<typeof agentLoopInMetadataSnapshot> {
	return withModelMetadataSnapshotIterator(() => agentLoopInMetadataSnapshot(...args));
}

async function* agentLoopInMetadataSnapshot(
	config: AgentConfig,
	userText: string,
	history: unknown[],
	initialToolResults?: unknown[],
	images?: Array<{ format: string; base64: string }>,
): AsyncGenerator<AgentEvent> {
	const guidanceSignal =
		config.guidanceSignal && config.urgentGuidanceSignal
			? AbortSignal.any([config.guidanceSignal, config.urgentGuidanceSignal])
			: (config.guidanceSignal ?? config.urgentGuidanceSignal);
	// Each loop owns its receipts. Nested reflection loops must not inherit a parent's row.
	const executionBindings = new WeakMap<AgentToolUse, import("./types").ToolCallBinding>();
	config.toolExecutionBindings = executionBindings;
	const bindExecution = (tu: AgentToolUse, binding: import("./types").ToolCallBinding) => {
		const previous = executionBindings.get(tu);
		if (previous) {
			if (previous.toolCallId !== binding.toolCallId || previous.attempt !== binding.attempt) {
				throw new Error("A tool execution cannot be rebound to a different persisted attempt");
			}
			return;
		}
		executionBindings.set(tu, Object.freeze({ ...binding }));
	};
	const inheritedTools = config.reflectionLoop ? requestToolSnapshots.get(config) : undefined;
	const resolvedProvider = inheritedTools ?? resolveProviderAndModel(config.model);
	let provider = resolvedProvider.adapter;
	let effectiveModel = resolvedProvider.model;
	let effectiveProvider = resolvedProvider.provider;
	const searchScope = getSearchExecutionScope();
	const maxTurns = Math.min(
		config.maxTurns ?? settings.agent.maxTurns,
		searchScope?.remainingTurns ?? Number.POSITIVE_INFINITY,
	);
	const locale = (config.locale as Locale) ?? "en";

	// Permission checks must be serialized even when tools themselves are parallel-safe.
	// This prevents concurrent permission prompts / danger reflection loops from racing each other.
	const originalPermissionHandler = config.permissionHandler;
	// A streamed tool may request reflection before the provider's current user
	// turn has been appended to history. Supply that turn on a separate array.
	let getPermissionHistory = (): unknown[] => history;
	let permissionTail: Promise<void> = Promise.resolve();
	config.permissionHandler = async (toolName, input, toolUseId, options) => {
		const run = permissionTail.then(async () => {
			const result = await originalPermissionHandler(toolName, input, toolUseId, options);
			if (result.behavior !== "dangerReflection") return result;

			return resolveDangerReflectionDecision(config, getPermissionHistory(), result, {
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

	let allTools: ResolvedToolDefinition[] = (inheritedTools ? [] : toolRegistry.all())
		.filter((t) => t.name && (!t.isAvailable || t.isAvailable()))
		// Last line of defence before the wire. Providers validate the whole `tools`
		// array and reject the entire request when one name breaks their alphabet
		// (OpenAI: `Invalid 'tools[19].function.name': ... '^[a-zA-Z0-9_-]+$'`), so a
		// single malformed dynamic tool would otherwise make every turn fail. Names are
		// minted sanitized upstream (MCP + plugin bridges); dropping the tool here keeps
		// the session usable if a future source misses that, instead of rewriting the
		// name behind the registry's back — a renamed tool could not be executed or
		// matched against history.
		.filter((t) => {
			if (isValidToolName(t.name)) return true;
			logger.warn("Dropping tool with a provider-invalid name", { toolName: t.name });
			return false;
		})
		.map((t) => ({
			...t,
			description: typeof t.description === "function" ? t.description(config) : t.description,
			rawJsonSchema: t.getRawJsonSchema ? t.getRawJsonSchema(config) : t.rawJsonSchema,
		}));

	// Keep the wire-level tool list identical for primary and reflection requests so
	// provider prompt caches can share the same prefix. Reflection permissions remain
	// narrow: the reflection loop's permissionHandler and executeTool checks enforce
	// `reflectionLoop.allowedTools` when the model actually attempts a call.

	// Apply toolFilter if provided (used by subagents to restrict available tools)
	if (config.toolFilter) {
		allTools = allTools.filter((tool) => tool.reflectionOnly || config.toolFilter?.(tool));
	}

	// Keep SwitchDevice available for a stale remote default so the model can
	// recover by explicitly switching back to local. TransferFile still requires
	// at least one online remote endpoint.
	allTools = filterDeviceTools(allTools, config);

	/**
	 * Whether plan mode should currently blank out the forbidden tools' descriptions.
	 *
	 * Read live, not frozen: plan mode can be toggled MANUALLY while this pass runs, and
	 * `config.planMode`/`relaxedPlan` are getters on the session's live state.
	 */
	function planModeDisablesTools(): boolean {
		return !!config.planMode && !config.relaxedPlan;
	}

	function resolveToolsForProvider(
		providerName: string,
		modelName: string,
	): ResolvedToolDefinition[] {
		let resolved = allTools;
		// Inline native search (Codex): the provider declares its own search tool in
		// the main request, so the function-style WebSearch is hidden entirely.
		if (shouldUseNativeSearch(providerName, modelName)) {
			resolved = resolved.filter((t) => t.name !== "WebSearch");
		} else if (
			// Hide WebSearch when every enabled channel would deterministically fail
			// for THIS session's provider (the global isAvailable check can't see the
			// session, so a native-only channel list would otherwise advertise a tool
			// that always errors on non-opted providers).
			resolved.some((t) => t.name === "WebSearch") &&
			!(searchScope || config.runtimePolicy?.searchOnly
				? (!searchScope || matchesSearchExecutionScope(providerName, modelName)) &&
					usesSideRequestNativeSearch(providerName, modelName)
				: hasUsableFunctionSearchChannelFor(providerName))
		) {
			resolved = resolved.filter((t) => t.name !== "WebSearch");
		}

		// In plan mode, override descriptions for forbidden tools so the model knows not to
		// call them. Applied here rather than baked into `allTools` because a manual toggle
		// can flip plan mode between turns, and `allTools` is built once per pass.
		// Tool NAMES are preserved (required by some APIs for history consistency).
		// When relaxedPlan is enabled, skip this — tools remain fully available.
		if (planModeDisablesTools()) {
			const disabledDesc = getToolMessage("planModeToolDisabled", locale);
			resolved = resolved.map((t) =>
				PLAN_MODE_ALLOWED_TOOLS.has(t.name)
					? t
					: {
							...t,
							description: disabledDesc,
						},
			);
		}
		return resolved;
	}

	async function reportToolsCharacters(formattedTools: unknown): Promise<void> {
		if (!config.onToolsCharacters) return;
		try {
			const counts = await countInputCharacters({ tools: formattedTools }, config.signal);
			if (counts) await config.onToolsCharacters(counts.toolsChars);
		} catch (error) {
			logger.warn("Failed to store context tool characters", {
				narratorId: config.narratorId,
				error: String(error),
			});
		}
	}

	let tools =
		inheritedTools?.tools ??
		provider.formatTools(resolveToolsForProvider(effectiveProvider, effectiveModel));
	await reportToolsCharacters(tools);
	/**
	 * The plan-mode tool-description state `tools` was formatted with.
	 *
	 * Compared at each turn boundary so a manual toggle re-formats the tool array, while an
	 * unchanged state skips the ~30-tool schema conversion `formatTools` performs.
	 */
	let toolsPlanModeDisabled = planModeDisablesTools();
	let pendingToolResults: unknown[] = initialToolResults ?? [];
	let turnIndex = 0;
	let completedToolCount = config.initialCompletedToolCount ?? 0;
	const silentToolCallThreshold = normalizeSilentToolCallThreshold(config.silentToolCallThreshold);
	let silentToolCallCount = 0;
	/**
	 * Tools whose settled result has already been processed for injections.
	 *
	 * One set, not the three it replaces: the old code kept a counted-ids set, a
	 * sidecar-checked set and a result cache, each guarding a different slice of the same
	 * function against the same re-entry (a result drained during streaming and again by
	 * the execution-group loop). They could only ever hold the same ids.
	 */
	const processedToolUseIds = new Set<string>();
	const pipelineExitConfirmationAttachedStateIds = new Set<string>();
	// Knowledge-base entry ids already injected this compact cycle (point B de-dup; shared
	// across tool outputs). Prefer the session-provided shared set so point A (user message)
	// and point B (tool output) de-dup together and the set survives across loop passes until
	// a compact boundary clears it. Falls back to a local set for standalone/test callers.
	const knowledgeInjectedEntryIds = config.knowledgeInjectedEntryIds ?? new Set<string>();

	/**
	 * Reminders the loop itself raised, awaiting delivery at the turn boundary.
	 *
	 * These used to be appended INSIDE the tool result's string. They are now persisted
	 * as their own message rows by the host (`config.deliverInjectionRow`) and folded into
	 * the next turn's text, which is why they are queued rather than returned: a row must
	 * be written once per reminder, not once per tool result that happened to be assembled.
	 */
	type LoopInjection = NonNullable<Parameters<NonNullable<typeof config.deliverInjectionRow>>[0]>;

	const pendingLoopInjections: LoopInjection[] = [];

	function queueLoopInjection(injection: LoopInjection): void {
		if (!injection.content.trim()) return;
		pendingLoopInjections.push(injection);
	}

	/**
	 * Persist the queued reminders and return the text for the current turn.
	 *
	 * A host without the hook gets "" and the reminders are dropped rather than falling
	 * back to a side-car: delivering both ways is how the same words end up in the
	 * conversation twice.
	 */
	async function flushLoopInjections(): Promise<string> {
		if (pendingLoopInjections.length === 0) return "";
		const queued = pendingLoopInjections.splice(0, pendingLoopInjections.length);
		if (!config.deliverInjectionRow) return "";
		const parts: string[] = [];
		for (const injection of queued) {
			try {
				const text = await config.deliverInjectionRow(injection);
				if (text?.trim()) parts.push(text);
			} catch (err) {
				logger.warn("Failed to deliver loop injection row", {
					narratorId: config.narratorId,
					source: injection.source,
					error: String(err),
				});
			}
		}
		return parts.join("\n\n");
	}

	/**
	 * Raise the reminders a settled tool result warrants, and advance the tool counter.
	 *
	 * Formerly `collectToolResultSideCars`, which returned side-cars to be appended inside
	 * the tool result's string. Every one of those reminders is now a message row (queued
	 * here, persisted at the turn boundary by {@link flushLoopInjections}), so nothing is
	 * returned — but the call sites are unchanged in one respect that matters:
	 *
	 * ⚠️ This is called MORE THAN ONCE for the same tool. A result can be drained during
	 * streaming and again by the execution-group loop, so `processedToolUseIds` makes the
	 * whole body idempotent. Without it a single silent-progress threshold crossing would
	 * queue two rows, and the completed-tool count would double-advance — which would in
	 * turn fire the cadence-driven reminders at twice their configured rate.
	 */
	async function processToolResultInjections(
		tu: AgentToolUse,
		result: ToolExecResult,
	): Promise<void> {
		if (processedToolUseIds.has(tu.toolUseId)) return;
		processedToolUseIds.add(tu.toolUseId);

		const pipelineStateId = result.pipelineExitConfirmationStateId;
		if (pipelineStateId && !pipelineExitConfirmationAttachedStateIds.has(pipelineStateId)) {
			pipelineExitConfirmationAttachedStateIds.add(pipelineStateId);
			result.metadata = {
				...result.metadata,
				pipelineExitConfirmationStateId: pipelineStateId,
			};
			queueLoopInjection({
				source: "pipeline_exit_confirmation",
				...sideCarBodyWithText("pipeline_exit_confirmation", { kind: "notice" }, locale),
				toolUseId: tu.toolUseId,
				// The ack must happen only once the row is durable, which the host knows and
				// this loop does not. Carrying the id here replaces the old detour through
				// `result.metadata` and the event handler.
				pipelineExitConfirmationStateId: pipelineStateId,
			});
		}

		if (!result.broken && !result.fatal) {
			silentToolCallCount++;
			if (silentToolCallThreshold >= 0 && silentToolCallCount >= silentToolCallThreshold) {
				queueLoopInjection({
					source: "silent_progress",
					...sideCarBodyWithText(
						"silent_progress",
						{ kind: "notice", params: { count: silentToolCallCount } },
						locale,
					),
					toolUseId: tu.toolUseId,
				});
				silentToolCallCount = 0;
			}
		}

		// A broken or fatal result gets no further reminders: the model needs to see the
		// failure, not advice about planning or the knowledge base. It also must not count
		// toward the completed-tool cadence, which measures productive work.
		if (result.broken || result.fatal) return;

		if (await shouldInjectRelaxedPlanToolReminder(tu, config)) {
			queueLoopInjection({
				source: "relaxed_plan",
				...sideCarBodyWithText(
					"relaxed_plan",
					// The reminder now says WHERE the plan goes. Without it the model is told
					// "keep planning" and left to rediscover the designated path from the
					// EnterPlanMode result many turns back — which is how a plan ends up
					// written somewhere ExitPlanMode will not read.
					{ kind: "notice", params: { planFile: relaxedPlanReminderPlanFile(config) } },
					locale,
				),
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
					queueLoopInjection({
						source: "knowledge_base_hint",
						// `scan.content` is the same text this body renders to (asserted in
						// sidecar-body.test.ts against formatInjectionsBare), so the body is
						// the authority and the text is derived from it — not both kept.
						...sideCarBodyWithText(
							"knowledge_base_hint",
							{
								kind: "knowledge",
								hits: scan.hits.map((hit) => ({
									entryId: hit.entryId,
									title: hit.title,
									summary: hit.summary,
								})),
							},
							locale,
						),
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
		completedToolCount++;
		config.onCompletedToolCount?.(completedToolCount);
	}

	/**
	 * Text to fold into the next turn from producers that persist their OWN message row.
	 *
	 * The successor to the `after_tools` side-car phase, and it differs in the one way
	 * that matters: nothing is yielded for persistence. A producer calling
	 * `deliverInjection` has already written a row, so emitting a side-car here as well
	 * would put the same words into the conversation twice — once as a row and once as an
	 * attachment on somebody else's message.
	 *
	 * The text is still needed because this loop rebuilds its in-memory history only at
	 * pass start: a row written mid-turn is invisible until the next pass, and a
	 * finished background task should not have to wait that long to be mentioned.
	 */
	const pendingInputConsumptions: Array<() => void> = [];
	async function collectAfterToolsInjectionText(): Promise<string> {
		if (!config.getAfterToolsInjections) return "";
		try {
			const injection = await config.getAfterToolsInjections();
			const text = (typeof injection === "string" ? injection : injection.text).trim();
			if (text && typeof injection !== "string" && injection.onConsumed) {
				pendingInputConsumptions.push(injection.onConsumed);
			}
			return text;
		} catch (err) {
			logger.warn("Failed to collect after-tools injections", {
				narratorId: config.narratorId,
				error: String(err),
			});
			return "";
		}
	}

	// Preserve the exact build identity for delivery receipts; the model history itself
	// is copied/mutated by provider projections and must not be used as a global inbox.
	let sourceInputHistory = history;
	// Shallow-copy to avoid mutating the caller's array
	history = [...history];

	// Inherited reflection history already contains this prompt.
	if (config.systemPrompt && !inheritedPromptConfigs.has(config)) {
		provider.injectSystemPrompt(history, config.systemPrompt, effectiveModel, config.locale);
	}

	// Extra content to prepend to the next turn's user message (e.g. broken-tool reminder).
	// Consumed once and reset to empty after use.
	let nextTurnContent = "";

	// Retries for "reasoning-only" dead turns (model produced only reasoning, no text
	// and no tool calls). Declared at function scope so the ceiling is shared across
	// the turn boundary when a dead turn is recovered by injecting a "continue" turn.
	let reasoningOnlyRetries = 0;
	// A high-context dead-turn sequence may compact only once. Reset after a
	// meaningful response so a later, independent sequence can recover normally.
	let reasoningOnlyCompactAttempted = false;

	let resetUpstreamSessionOnNextRequest = !!config.resetUpstreamSessionOnFirstRequest;

	/**
	 * Tool-use identifiers already present in the model-facing history.
	 *
	 * Providers that mint one id for every call (e.g. "call_go_0") produce a valid single
	 * turn but an invalid history: after a few turns the replayed conversation carries the
	 * same id many times and the API answers 400 "duplicate tool_use id". The DB rebuild
	 * path fixes accumulated rows (see uniquifyDbMessageToolUseIds); this set guards the
	 * turns appended in-memory during one run, which never go through a rebuild.
	 *
	 * Rebuilt on every history replacement so it always describes the live history.
	 */
	let historyToolUseIds = collectToolUseIdsFromHistory(history, initialToolResults);

	function applyHistoryReplacement(replacement: AgentHistoryReplacement) {
		resetUpstreamSessionOnNextRequest = true;
		history = replacement.history;
		sourceInputHistory = replacement.history;
		if (replacement.systemPrompt != null) {
			config.systemPrompt = replacement.systemPrompt;
		}
		if (config.systemPrompt) {
			provider.injectSystemPrompt(history, config.systemPrompt, effectiveModel, config.locale);
		}
		pendingToolResults = replacement.pendingToolResults;
		historyToolUseIds = collectToolUseIdsFromHistory(history, pendingToolResults);
	}

	async function hasPendingRuntimeSettingsOverride(): Promise<boolean> {
		// Probe only: a settle/resolve failure here must not escalate a retry path
		// into a whole-turn exception. Treat "cannot tell" as "no pending switch"
		// and keep the current model; real authorization failures still surface
		// from applyPendingRuntimeSettings.
		try {
			const runtimeSettings = await config.getRuntimeSettingsOverride?.();
			return Boolean(
				(runtimeSettings && Object.keys(runtimeSettings).length > 0) || config.getModelOverride?.(),
			);
		} catch (error) {
			logger.warn("Failed to probe pending runtime settings override", {
				narratorId: config.narratorId,
				error: String(error),
			});
			return false;
		}
	}

	async function applyPendingRuntimeSettings(
		cause: "turn" | "retry",
	): Promise<Extract<AgentEvent, { type: "model_switched" }> | null> {
		// Resolve authorization before touching adapters/history. A rejection must
		// propagate rather than silently issuing a request with an obsolete model.
		const settingsOverride = (await config.getRuntimeSettingsOverride?.()) ?? null;
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
					await reportToolsCharacters(tools);
					// This re-format already applied the current plan-mode state; record it so the
					// turn-boundary check does not immediately redo the same work.
					toolsPlanModeDisabled = planModeDisablesTools();
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
		if (guidanceSignal?.aborted) {
			// FIFO guidance may intentionally enter a pass already stopped. Consume the
			// host flag and preserve pending input without activating provider/preflight IO.
			config.shouldStop?.();
			const isFirstTurn = turnIndex === 0;
			provider.pushUserTurn(
				history,
				isFirstTurn ? userText : nextTurnContent,
				effectiveModel,
				isFirstTurn ? (initialToolResults ?? []) : pendingToolResults,
				isFirstTurn ? images : undefined,
			);
			yield { type: "turn_complete", turnIndex };
			return;
		}
		// A reflection sub-loop runs inside the parent's tool admission, so it must not be
		// parked behind the update gate — see beginNarratorResponseActivity for the deadlock.
		const responseActivity = await beginNarratorResponseActivity(config.narratorId, config.signal, {
			isReflection: !!config.reflectionLoop,
		});
		try {
			// Delivery is de-duplicated only within one model turn. If persistence failed,
			// the still-pending state may be attached again on the next turn.
			pipelineExitConfirmationAttachedStateIds.clear();

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

				// A manual plan-mode toggle landed between turns: re-format the tool array so
				// the forbidden tools carry (or drop) the disabled description. Checked after
				// onBeforeTurn because a model switch there already re-formatted the tools.
				const planModeDisabledNow = planModeDisablesTools();
				if (!inheritedTools && planModeDisabledNow !== toolsPlanModeDisabled) {
					toolsPlanModeDisabled = planModeDisabledNow;
					tools = provider.formatTools(resolveToolsForProvider(effectiveProvider, effectiveModel));
					await reportToolsCharacters(tools);
					logger.info("Re-formatted tools after a mid-loop plan-mode change", {
						narratorId: config.narratorId,
						planModeDisablesTools: planModeDisabledNow,
					});
				}
			}

			const content = isFirstTurn ? userText : nextTurnContent;
			nextTurnContent = ""; // consume once
			getPermissionHistory = () => {
				const reflectionHistory = [...history];
				provider.pushUserTurn(
					reflectionHistory,
					content,
					effectiveModel,
					isFirstTurn ? (initialToolResults ?? []) : pendingToolResults,
					isFirstTurn ? images : undefined,
				);
				return reflectionHistory;
			};

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
			// Persistence/replay share block identities; aggregate strings below remain
			// compatibility inputs for providers whose wire protocol has one text field.
			const outputContent = new OutputContentAccumulator();
			const redactedThinkingBlocks: Array<{
				data: string;
				outputIndex?: number;
				signatureSource?: string;
			}> = [];
			const toolUses: AgentToolUse[] = [];
			// Tool cancellation is independent from the caller's user-interrupt signal.
			const toolAbort = new AbortController();
			// Preserve live runtime setting updates on the original config during retries.
			const toolSignal = AbortSignal.any([
				config.signal,
				toolAbort.signal,
				...(config.urgentGuidanceSignal ? [config.urgentGuidanceSignal] : []),
			]);
			const toolConfig = new Proxy(config, {
				get(target, key, receiver) {
					return key === "signal" ? toolSignal : Reflect.get(target, key, receiver);
				},
			});
			const throwIfUserAborted = (): void => {
				if (config.signal.aborted) throw config.signal.reason ?? new Error("Aborted");
			};
			type ToolOrderIdentity = {
				toolUseId: string;
				arrivalOrder: number;
				outputIndex?: number;
				name?: string;
				strictSerial: boolean;
			};
			const toolOrderIdentities = new Map<string, ToolOrderIdentity>();
			let nextToolArrivalOrder = 0;
			const compareToolOrder = (a: ToolOrderIdentity, b: ToolOrderIdentity): number => {
				if (a.outputIndex != null && b.outputIndex != null) {
					const indexOrder = a.outputIndex - b.outputIndex;
					if (indexOrder !== 0) return indexOrder;
				} else if (a.outputIndex != null) {
					return -1;
				} else if (b.outputIndex != null) {
					return 1;
				}
				return a.arrivalOrder - b.arrivalOrder;
			};
			const registerToolOrderIdentity = (
				tool: { toolUseId: string; name?: string; outputIndex?: number },
				strictSerial?: boolean,
			): ToolOrderIdentity => {
				const existing = toolOrderIdentities.get(tool.toolUseId);
				if (existing) {
					if (tool.outputIndex != null) existing.outputIndex = tool.outputIndex;
					if (tool.name) existing.name = tool.name;
					// Completed input is authoritative, including an explicit false for
					// parallel Bash. Partial chunks keep the conservative barrier.
					existing.strictSerial =
						strictSerial ??
						(existing.strictSerial ||
							!!(tool.name && isStrictSerialToolExecution({ name: tool.name, input: {} })));
					return existing;
				}
				const identity: ToolOrderIdentity = {
					toolUseId: tool.toolUseId,
					arrivalOrder: nextToolArrivalOrder++,
					outputIndex: tool.outputIndex,
					name: tool.name,
					strictSerial:
						strictSerial ??
						(tool.name ? isStrictSerialToolExecution({ name: tool.name, input: {} }) : false),
				};
				toolOrderIdentities.set(tool.toolUseId, identity);
				return identity;
			};
			const markCompletedToolUse = (tu: AgentToolUse): ToolOrderIdentity => {
				// These are UI-only annotations, not Edit parameters. Strip model-authored
				// claims before persistence too (including the non-streaming provider path).
				if (tu.name === "Edit" && tu.input && typeof tu.input === "object") {
					delete tu.input._streamingMetadata;
					delete tu.input._streamingEditOrigin;
				}
				const identity = registerToolOrderIdentity(tu, isStrictSerial(tu));
				if (tu.outputIndex == null && identity.outputIndex != null) {
					tu.outputIndex = identity.outputIndex;
				}
				return identity;
			};
			const sortToolUsesByOutputOrder = (): void => {
				for (const toolUse of toolUses) markCompletedToolUse(toolUse);
				toolUses.sort((a, b) => {
					const aIdentity = toolOrderIdentities.get(a.toolUseId);
					const bIdentity = toolOrderIdentities.get(b.toolUseId);
					if (!aIdentity || !bIdentity) return 0;
					return compareToolOrder(aIdentity, bIdentity);
				});
			};
			let messageId: string | undefined;
			let credentialId: string | undefined;
			/**
			 * Whether a graceful soft stop has been granted for THIS turn.
			 *
			 * Turn-scoped rather than declared next to the tool-execution phase because
			 * the request must be observable from the STREAMING phase too: the host's
			 * `shouldStop` is one-shot (see `evaluateSoftStopRequest` in
			 * narrator-session), so whoever consumes it has to record the answer for the
			 * rest of the turn.
			 */
			let gracefulStopRequested = false;
			/**
			 * Consume a pending soft-stop request at most once per turn.
			 *
			 * Every boundary asks through here, so the grant is spent exactly once no
			 * matter which phase observes it first. Asking again after a grant would
			 * return the *next* request's answer (usually false) and silently resurrect
			 * the turn the caller already agreed to end.
			 */
			const observeSoftStopForTurn = (): boolean => {
				if (!gracefulStopRequested && guidanceSignal?.aborted) {
					// Consume the host's one-shot flag too, so the next pass is not stopped again.
					config.shouldStop?.();
					gracefulStopRequested = true;
				}
				if (!gracefulStopRequested && config.shouldStop?.()) gracefulStopRequested = true;
				return gracefulStopRequested;
			};
			// Map of tool executions started during streaming (toolUseId → Promise)
			const earlyExecMap = new Map<string, Promise<ToolExecResult>>();
			// Synchronously queryable map of settled early-exec results (populated via .then())
			const settledResults = new Map<string, ToolExecResult>();
			// Only fully persisted AND announced calls are candidates. A preceding input
			// still streaming remains an ordering barrier even if a later call is ready.
			const streamReadyTools = new Set<string>();
			let streamExecutionOpen = false;
			const startToolExecution = (tu: AgentToolUse): Promise<ToolExecResult> => {
				const existing = earlyExecMap.get(tu.toolUseId);
				if (existing) return existing;
				const preparationAbort = new AbortController();
				const onGuidance = () =>
					preparationAbort.abort(new Error("Stopped for immediate guidance"));
				const removeGuidance = () => guidanceSignal?.removeEventListener("abort", onGuidance);
				if (guidanceSignal?.aborted) onGuidance();
				else guidanceSignal?.addEventListener("abort", onGuidance, { once: true });
				const preparationSignal = AbortSignal.any([toolSignal, preparationAbort.signal]);
				const invocationConfig = new Proxy(toolConfig, {
					get(target, key, receiver) {
						if (key === "signal") return preparationSignal;
						if (key === "permissionHandler") {
							return ((name, input, id, options) =>
								target.permissionHandler(name, input, id, {
									...options,
									signal: preparationSignal,
								})) satisfies AgentConfig["permissionHandler"];
						}
						if (key === "onToolExecutionInvoking") {
							return (tool: AgentToolUse) => {
								// No await between this synchronous boundary and tool.execute.
								preparationSignal.throwIfAborted();
								removeGuidance();
								target.onToolExecutionInvoking?.(tool);
							};
						}
						return Reflect.get(target, key, receiver);
					},
				});
				const execution = settleToolExecutionResult(
					executeToolAfterReflections(tu, invocationConfig, history, locale),
				)
					.then((result) =>
						preparationAbort.signal.aborted
							? {
									...result,
									output: getToolMessage("skippedForSoftStop", locale),
									isError: true,
									metadata: { ...result.metadata, skippedForSoftStop: true },
								}
							: result,
					)
					.finally(removeGuidance);
				earlyExecMap.set(tu.toolUseId, execution);
				void execution.then((result) => {
					settledResults.set(tu.toolUseId, result);
					pumpStreamingTools();
				});
				return execution;
			};
			async function waitForToolOrAbort<T>(
				execution: Promise<T>,
				signal = toolWaitAbortSignal,
			): Promise<T | null> {
				if (signal.aborted) return null;
				let onAbort = () => {};
				try {
					return await Promise.race([
						execution,
						new Promise<null>((resolve) => {
							onAbort = () => resolve(null);
							signal.addEventListener("abort", onAbort, { once: true });
						}),
					]);
				} finally {
					signal.removeEventListener("abort", onAbort);
				}
			}
			const pumpStreamingTools = (): void => {
				if (
					!streamExecutionOpen ||
					config.signal.aborted ||
					config.deferEagerToolsForSafeStop === true ||
					observeSoftStopForTurn()
				)
					return;
				const completed = new Map(toolUses.map((tu) => [tu.toolUseId, tu]));
				const candidates = selectStreamingToolExecutions(
					[...toolOrderIdentities.values()].sort(compareToolOrder).map((identity) => {
						const tool = completed.get(identity.toolUseId);
						const result = settledResults.get(identity.toolUseId);
						return {
							tool,
							ready: streamReadyTools.has(identity.toolUseId),
							started: earlyExecMap.has(identity.toolUseId),
							settled: result !== undefined,
							fatal: result?.fatal,
							allowed: tool !== undefined && shouldEagerExecuteTool(tool),
						};
					}),
				);
				for (const tu of candidates) {
					// Register only actual starts, never promises for queued tools: the
					// cut-in/abort paths must distinguish running work from skippable work.
					if (config.signal.aborted || toolAbort.signal.aborted) break;
					startToolExecution(tu);
				}
			};
			// Track which tool_results have already been yielded during streaming
			const yieldedToolResults = new Set<string>();
			// Track tool calls whose input was broken (output cut off mid-stream)
			const brokenToolUseIds = new Set<string>();
			// Accumulator for streaming tool use events (input arrives in chunks)
			const toolUseAccum = new Map<string, StreamingToolAccumulator>();
			async function* flushToolInput(
				id: string,
				acc: StreamingToolAccumulator,
			): AsyncGenerator<AgentEvent> {
				if (!acc.metadataAttempted && acc.name === "Edit" && acc.extractedFilePath) {
					const oldString = acc.stream.getField("old_string");
					if (oldString != null) {
						acc.metadataAttempted = true;
						const metadataAcc = {
							...acc,
							extractedFields: { ...acc.extractedFields, old_string: oldString },
						};
						acc.streamingMetadata = await resolveStreamingEditMetadata(
							metadataAcc,
							config.cwd,
							id,
							config.defaultDeviceId ?? "local",
						);
						// The matcher mints evidence on its argument; keep it on the real accumulator.
						acc.streamingEditOrigin = metadataAcc.streamingEditOrigin;
					}
				}
				const fields = acc.stream.drainFields();
				const dirty = acc.pendingShort;
				acc.pendingShort = {};
				acc.lastYieldedAt = Date.now();
				const base = {
					type: "tool_use_chunk" as const,
					toolUseId: id,
					toolName: acc.name,
					inputCharsTotal: acc.totalChars,
					...(acc.extractedFilePath && {
						extractedFilePath: acc.extractedFilePath,
						contentCharsReceived: Math.max(
							0,
							acc.totalChars - `"file_path":"${acc.extractedFilePath}",`.length,
						),
					}),
					...(Object.keys(dirty).length > 0 && { extractedFields: dirty }),
					...(acc.streamingMetadata && { metadata: acc.streamingMetadata }),
				};
				// A chunk can close multiple fields. Preserve their order as individual events.
				if (fields.length === 0) yield base;
				else for (const streamingField of fields) yield { ...base, streamingField };
			}
			function resetToolInput(acc: StreamingToolAccumulator, snapshot: string): void {
				acc.stream = new ToolInputStream(
					TOOL_FIELD_CONFIG[acc.name]?.short,
					TOOL_FIELD_CONFIG[acc.name]?.large,
				);
				acc.stream.feed(snapshot);
				acc.totalChars = acc.stream.totalChars;
				acc.extractedFields = undefined;
				acc.extractedFilePath = undefined;
				acc.pendingShort = {};
				acc.metadataAttempted = false;
				acc.streamingMetadata = undefined;
				acc.streamingEditOrigin = undefined;
			}
			function collectShortFields(acc: StreamingToolAccumulator): boolean {
				const dirty = acc.stream.takeShortFields();
				Object.assign(acc.pendingShort, dirty);
				acc.extractedFields = { ...acc.extractedFields, ...dirty };
				if (dirty.file_path != null) acc.extractedFilePath = dirty.file_path;
				return Object.keys(dirty).length > 0;
			}
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
			const orderedAssistantContent = (historyTools: readonly AgentToolUse[]): ContentBlock[] =>
				outputContent.orderedContent([
					...historyTools.map((tool): ContentBlock => ({ type: "tool_use", ...tool })),
					...(collectCompletedWebSearches(webSearchAccum) ?? []).map(
						(block): ContentBlock => ({ type: "web_search", ...block }),
					),
					...(collectCompletedImageGenerations(imageGenAccum) ?? []).map(
						(block): ContentBlock => ({ type: "image_generation", ...block }),
					),
					...redactedThinkingBlocks.map(
						(block): ContentBlock => ({ type: "redacted_thinking", ...block }),
					),
				]);
			// Track whether the provider reported usage data during this turn
			let receivedUsage = false;
			// Per-attempt evidence for the empty-response guard (reset on every retry).
			let streamEventCount = 0;
			let contentlessEventCount = 0;
			let lastStopReason: string | undefined;
			const namelessToolUseIds = new Set<string>();

			function earlyToolResultEvent(
				tu: AgentToolUse,
				settled: ToolExecResult,
			): Extract<AgentEvent, { type: "tool_result" }> {
				const brokenOverride = settled.broken
					? sanitizeBrokenInput(tu.name, settled.updatedInput ?? tu.input, locale)
					: undefined;
				return {
					type: "tool_result",
					toolCallBinding: executionBindings.get(tu),
					toolUseId: tu.toolUseId,
					toolName: tu.name,
					input: settled.updatedInput ?? tu.input,
					output: settled.broken ? getToolMessage("brokenToolCallResult", locale) : settled.output,
					isError: settled.isError ?? false,
					durationMs: settled.durationMs,
					permissionStartedAt: settled.permissionStartedAt,
					executionStartedAt: settled.executionStartedAt,
					completedAt: settled.completedAt,
					brokenInputOverride: brokenOverride,
					updatedInput: brokenOverride ?? settled.updatedInput,
					metadata: settled.metadata,
				};
			}

			async function* drainSettledEarlyToolResults(): AsyncGenerator<AgentEvent> {
				for (const tu of toolUses) {
					const settled = settledResults.get(tu.toolUseId);
					if (!settled || yieldedToolResults.has(tu.toolUseId)) continue;
					yieldedToolResults.add(tu.toolUseId);
					if (settled.broken) brokenToolUseIds.add(tu.toolUseId);
					if (settled.updatedInput) tu.input = settled.updatedInput;
					await processToolResultInjections(tu, settled);
					yield earlyToolResultEvent(tu, settled);
				}
			}

			const detachedToolResults = new Set<string>();
			function detachStartedEarlyToolResults(): void {
				const persist = config.onDetachedToolResult;
				if (!persist) return;
				for (const tu of toolUses) {
					const execution = earlyExecMap.get(tu.toolUseId);
					if (
						!execution ||
						yieldedToolResults.has(tu.toolUseId) ||
						detachedToolResults.has(tu.toolUseId)
					)
						continue;
					detachedToolResults.add(tu.toolUseId);
					// The executor still owns its IO, leases and after snapshot. Keep its
					// final result alive without holding up interruption or emitting into
					// a stream that may already belong to the narrator's next run.
					void execution
						.then((settled) => persist(earlyToolResultEvent(tu, settled)))
						.catch((error) => {
							logger.error("Failed to persist detached tool result", {
								narratorId: config.narratorId,
								toolUseId: tu.toolUseId,
								toolCallId: executionBindings.get(tu)?.toolCallId,
								error: String(error),
							});
						});
				}
			}

			const toolWaitAbortSignal = config.urgentGuidanceSignal
				? AbortSignal.any([config.signal, config.urgentGuidanceSignal])
				: config.signal;
			async function* drainStartedEarlyToolResults(): AsyncGenerator<AgentEvent> {
				for (const tu of toolUses) {
					const earlyPromise = earlyExecMap.get(tu.toolUseId);
					if (earlyPromise && !settledResults.has(tu.toolUseId)) {
						const result = await waitForToolOrAbort(earlyPromise, toolWaitAbortSignal);
						if (!result) {
							// Urgent guidance/hard interruption may not wait for a tool which ignores
							// cancellation. The abort drain owns its late persistence, not a fake result.
							yield* drainEarlyToolResultsAfterAbort();
							return;
						}
						settledResults.set(tu.toolUseId, result);
					}
				}
				yield* drainSettledEarlyToolResults();
			}

			async function* drainEarlyToolResultsAfterAbort(): AsyncGenerator<AgentEvent> {
				const deadline = Date.now() + ABORT_EAGER_TOOL_DRAIN_TIMEOUT_MS;
				for (const tu of toolUses) {
					const earlyPromise = earlyExecMap.get(tu.toolUseId);
					if (!earlyPromise || settledResults.has(tu.toolUseId)) continue;
					const remainingMs = deadline - Date.now();
					if (remainingMs <= 0) break;
					await Promise.race([
						earlyPromise.then(
							() => undefined,
							() => undefined,
						),
						new Promise<void>((resolve) => setTimeout(resolve, remainingMs)),
					]);
				}
				yield* drainSettledEarlyToolResults();
				detachStartedEarlyToolResults();
				// Completed/persisted calls that never started still need a terminal result.
				for (const tu of toolUses) {
					if (earlyExecMap.has(tu.toolUseId) || yieldedToolResults.has(tu.toolUseId)) continue;
					yieldedToolResults.add(tu.toolUseId);
					yield earlyToolResultEvent(tu, {
						output: locale === "zh-CN" ? "工具执行已取消。" : "Tool execution cancelled.",
						isError: true,
						durationMs: 0,
					});
				}
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
			let upstreamContextPercent: number | undefined;
			let requestRawContextWindow: number | undefined;
			let inputCharacters: ContextInputCharacters | null = null;
			let inputComposition: ContextCharCache | null = null;
			let contextSnapshot: ContextUsageSnapshot | undefined;
			function snapshotContext(
				source: ContextUsageSnapshot["source"],
				percentage: number | null,
				window: number | null,
				occupied: number | null,
			): ContextUsageSnapshot {
				contextSnapshot = {
					requestId,
					startedAt: new Date(requestStartTime || Date.now()).toISOString(),
					source,
					percentage,
					contextWindow: window,
					occupiedTokens: occupied,
					inputCharacters,
					composition: matchContextComposition(inputComposition, inputCharacters),
				};
				return contextSnapshot;
			}
			let requestMeterUsage: number | undefined;
			let requestMeterUnit: string | undefined;
			let sawMeaningfulResponse = false;
			/** Tracks the most recent error message from a retried attempt.  When a
			 *  transient error (e.g. 429) triggers a retry and the subsequent attempt
			 *  returns an empty response, we surface this stored message instead of the
			 *  misleading "Provider returned an empty response" text.  Reset to
			 *  undefined only when a retry produces meaningful content. */
			let lastRetryErrorMessage: string | undefined;
			let lastRetryDiagnostics: ApiRequestDiagnostics | undefined;
			/** Set to true when the current attempt already yielded a terminal
			 *  error/invalid_state event.  Prevents the empty-response check from
			 *  running on the same iteration. */
			let sawErrorEvent = false;
			/** Completion-limit stop observed for this attempt. Kept through stream end so
			 * usage/final events are consumed without falling into generic recovery paths. */
			let completionLimitMessage: string | undefined;
			let requestDiagnostics: ApiRequestDiagnostics | undefined;
			let requestDump: ApiRequestDumpCollector | undefined;
			/**
			 * Set when leaked XML tool calls are detected this turn (recovered or unrecovered),
			 * forcing the raw dump to persist regardless of the errors-only setting so the SSE
			 * data is downloadable for debugging.
			 */
			let forceDumpPersist = false;
			/**
			 * Fallback dump used when the upstream rejected the request body as malformed and
			 * no dump collector was active for this attempt (dumping disabled and the provider
			 * does not leak XML tool calls). With a collector present the capture is attached
			 * to the real dump instead — see {@link captureMalformedRequest}.
			 */
			let malformedRequestRecord: unknown;
			/**
			 * Attempts already spent replaying an upstream "malformed request body" rejection.
			 *
			 * Kept separate from `chatRetryCount` because this rejection is not a transient
			 * transport fault and must not draw on (or be masked by) the ordinary retry budget:
			 * observed rate is ~0.02% of upstream requests, and 39 of 40 recorded occurrences
			 * recovered on their own with the request unchanged. Two replays convert that
			 * self-healing window into a recovered turn; beyond that the failure is treated as
			 * real, because a genuinely malformed body would repeat forever and retrying it
			 * would only delay a hard error while re-sending the whole history each time.
			 */
			let malformedRetryCount = 0;
			/**
			 * Path of the dump file written for this turn's first malformed rejection, if any.
			 *
			 * The replays re-send an identical body, so one file is the whole evidence there is;
			 * later attempts reuse this path instead of writing near-duplicates. `null` records
			 * "the write was attempted and failed", which must not be retried either — the
			 * capture record has a distinct note for that case and re-attempting would just
			 * produce the same failure. See {@link captureMalformedRequest}.
			 */
			let malformedDumpPath: string | null | undefined;
			/**
			 * Turn-scoped key letting every attempt of THIS rejection share one spilled dump file.
			 *
			 * `malformedDumpPath` already keeps the malformed-dump directory to one file per turn,
			 * but each attempt also persists its own force-saved `api_requests` row, and those
			 * dumps spill to a SECOND directory (`request-dumps`) that had no such guard: three
			 * attempts produced three near-identical multi-MB files, pruning unrelated
			 * captures out of the newest-N window to store the same request three times. The
			 * token is what tells the tracker these rows describe one request; each row still
			 * gets a pointer, so no attempt looks like a failure without evidence.
			 */
			let malformedSpillReuseToken: string | undefined;
			const requestUserId = config.userId ?? null;
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
					userId: requestUserId,
					provider: effectiveProvider,
					model: effectiveModel,
					credentialId,
					referencePricingSnapshot: captureReferencePricingSnapshot(effectiveModel),
				};
			}

			/**
			 * Special case: the upstream rejected the request body as malformed
			 * (`REQUEST_BODY_INVALID` / "Improperly formed request.") without saying which
			 * field was wrong. Force-save the exact request that produced it to a dedicated
			 * file so the root cause survives every retry path, and ANNOTATE the dump with a
			 * pointer to that file plus a structural summary.
			 *
			 * The annotation must never replace the dump. A user opening a dump is asking what
			 * was sent; handing back only a summary and a server-side path is the one outcome
			 * the dump exists to prevent. Row size is bounded downstream by spilling the whole
			 * dump to a file (see `api-request-dump-store`), not by dropping the request here.
			 */
			const captureMalformedRequest = async (errorMessage?: string): Promise<void> => {
				const snapshot = requestDump?.snapshot();
				// Write the file only for this turn's FIRST rejection. The replays re-send a
				// byte-identical body, so a second file would be a near-duplicate of several MB,
				// and at 3 attempts per turn they would evict unrelated captures through the
				// newest-N pruning — losing other evidence to keep three copies of one.
				//
				// The capture record itself is still rebuilt every attempt: each attempt inserts
				// its own `api_requests` row, and a row without the annotation would look like an
				// ordinary failure with no pointer to the evidence.
				if (malformedDumpPath === undefined) {
					malformedDumpPath = await writeMalformedRequestDump({
						narratorId: config.narratorId,
						requestId,
						provider: effectiveProvider,
						model: effectiveModel,
						errorMessage,
						diagnostics: requestDiagnostics,
						dump: snapshot,
					});
				}
				const filePath = malformedDumpPath;
				const captureRecord = buildMalformedCaptureRecord({
					narratorId: config.narratorId,
					requestId,
					provider: effectiveProvider,
					model: effectiveModel,
					errorMessage,
					diagnostics: requestDiagnostics,
					dump: snapshot,
					filePath,
				});
				if (requestDump) {
					requestDump.setCapture(captureRecord.capture);
				} else {
					// No collector ran for this attempt, so there is no dump to annotate and the
					// capture record is all the evidence there is.
					malformedRequestRecord = captureRecord;
				}
				forceDumpPersist = true;
				// Established on the FIRST rejection of this turn and reused by its replays, so
				// their identical dumps share one spill file. Keyed on the first attempt's
				// requestId: unique per turn without needing another id source, and stable across
				// the replays because it is only assigned once.
				malformedSpillReuseToken ??= `malformed:${requestId}`;
			};

			function getEstimatedUpstreamPromptTokens(): number | undefined {
				const contextWindow =
					requestRawContextWindow ?? getModelContextWindow(effectiveModel, effectiveProvider);
				return upstreamContextPercent !== undefined && contextWindow
					? Math.round((upstreamContextPercent / 100) * contextWindow)
					: undefined;
			}

			function* finishRequest(errorMessage?: string): Generator<AgentEvent> {
				streamExecutionOpen = false;
				if (!requestStarted) return;
				// Retract the live tool cards this request published but never completed.
				//
				// This sits in the request teardown rather than at each retry site because
				// the abandoning paths are not all local: besides the in-loop retries, the
				// loop can hand a failure back to the CALLER (retryable_error /
				// resumable_error / invalid_state), which then rebuilds history and starts a
				// fresh turn. Those exits share only one thing — they all end the request
				// through here. Anchoring on that covers every abandonment with a single
				// rule, including ones added later.
				//
				// Safe on the success path too: a tool whose input closed has left the
				// accumulator, so only genuinely truncated ids are ever named.
				yield* retractStreamingToolCards();
				yield* flushRequestStart();
				const diagnostics = requestDiagnostics
					? normalizeApiRequestDiagnostics({
							...requestDiagnostics,
							provider: requestDiagnostics.provider ?? effectiveProvider,
							model: requestDiagnostics.model ?? effectiveModel,
							message: requestDiagnostics.message ?? errorMessage,
						})
					: undefined;
				requestDump?.setDiagnostics(diagnostics);
				if (!contextSnapshot) {
					const window = getModelContextWindow(effectiveModel, effectiveProvider);
					if (window && inputCharacters) {
						const occupied = Math.ceil(inputCharacters.totalChars * 0.3);
						const percentage = (occupied / window) * 100;
						requestContextPercent = Math.min(percentage, 100);
						const snapshot = snapshotContext("estimate", percentage, window, occupied);
						yield {
							type: "context_usage",
							percentage: requestContextPercent,
							source: "estimate",
							snapshot,
							promptTokens: occupied,
							contextWindow: window,
							isEstimated: true,
						};
					}
				}
				yield {
					type: "api_request_end",
					requestId,
					credentialId,
					// Billing counters are never synthesized from occupancy.
					usage: requestUsage,
					contextSnapshot:
						contextSnapshot ??
						snapshotContext(
							"estimate",
							null,
							getModelContextWindow(effectiveModel, effectiveProvider) ?? null,
							null,
						),
					ttftMs: requestTtftMs,
					durationMs: Date.now() - requestStartTime,
					contextPercent: requestContextPercent,
					meterUsage: requestMeterUsage,
					meterUnit: requestMeterUnit,
					// The dump wins whenever one exists: `malformedRequestRecord` is only set on
					// the no-collector path, where it is the sole record of the rejection.
					rawDump: requestDump?.snapshot() ?? malformedRequestRecord,
					errorMessage,
					diagnostics,
					forceDumpPersist,
					dumpSpillReuseToken: malformedSpillReuseToken,
				};
			}

			// ── Transient-error retry loop ──
			// For stateless providers (anthropic, openai-completions)
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
				lastRetryDiagnostics = undefined;
			};

			/**
			 * Whether this attempt has produced any client-visible, persistable
			 * content so far (text/tool calls/reasoning/web search/image
			 * generation). Used both by the empty-response guard below and by the
			 * resumable-error path: a "resumable" error is only meaningful when
			 * there is actually partial output to continue from — otherwise it
			 * degrades to an ordinary retryable/non-retryable error.
			 */
			/**
			 * Names of tool calls the model had STARTED writing arguments for when the
			 * stream ended, but which never received a stop signal — the accumulator
			 * still holds a half-written input.
			 *
			 * This is the single source of truth for "the model was cut off mid tool
			 * input". It is deliberately distinct from "only reasoning was produced":
			 * a truncated tool input proves the model committed to a tool call whose
			 * arguments did not fit, so the recovery is to tell it to write smaller
			 * calls (the skeleton-first reminder), NOT to replay the identical request
			 * and hit the same ceiling again.
			 *
			 * Entries without a name are ignored: a `toolUseChunk` carrying only an id
			 * never creates a real accumulator entry and represents no output.
			 */
			const orphanedToolInputNames = (): string[] =>
				[...toolUseAccum.values()].map((acc) => acc.name).filter((name): name is string => !!name);

			const hasAnyPersistableOutput = (): boolean => {
				return (
					!!assistantText ||
					toolUses.length > 0 ||
					orphanedToolInputNames().length > 0 ||
					!!collectReasoningBlocks(reasoningBlockMap) ||
					!!collectCompletedWebSearches(webSearchAccum) ||
					!!collectCompletedImageGenerations(imageGenAccum)
				);
			};

			/**
			 * Whether this attempt produced progress that an in-place replay would DESTROY.
			 *
			 * Distinct from {@link hasAnyPersistableOutput}, which answers "is there
			 * anything worth persisting". This answers the question the retry paths
			 * actually need: would re-sending the identical request lose information the
			 * model must see?
			 *
			 * A completed tool call is the decisive case. Every in-place replay resets the
			 * per-attempt accumulators (`toolUses`, `settledResults`, `earlyExecMap`), so a
			 * tool that already ran has its result dropped on the floor while the request
			 * that goes out is byte-identical to the one before it. The model then asks for
			 * the same tool again, lands in the same branch, and the loop burns its whole
			 * budget re-sending the first request — with the transcript growing all the
			 * while, because each abandoned attempt still persisted its blocks.
			 *
			 * When this is true the turn must instead finish (or be handed back to the
			 * caller), so the completed tool results reach history and the NEXT request
			 * carries them.
			 */
			const hasIrreplaceableProgress = (): boolean =>
				toolUses.length > 0 ||
				settledResults.size > 0 ||
				yieldedToolResults.size > 0 ||
				hasStartedEarlyToolExecution();

			/**
			 * Guard for every in-place replay site: replaying is only safe when the
			 * abandoned attempt left nothing behind that the replay would lose.
			 */
			const canReplayInPlace = (): boolean => !hasIrreplaceableProgress();

			/**
			 * Pick the recovery strategy for a resumable interruption (a transient
			 * upstream failure that hit AFTER partial output was already produced,
			 * e.g. the NUG gateway reporting `diagnostics.resumable`).
			 *
			 * The right recovery depends on what the partial output actually is:
			 * - `tool_continuation`: at least one complete tool call landed. Highest
			 *   priority because tool calls may already have side effects; the model
			 *   must see their results. The turn finishes normally (tools execute,
			 *   tool_results are yielded and pushed to history) and the next turn
			 *   carries them — no textual continuation prompt is needed.
			 * - `text_continuation`: visible answer text (or a completed web
			 *   search / image generation) exists. Flush it and let the caller append
			 *   a continuation user turn.
			 * - `truncated_tool_input`: no tool call completed, but the model was cut off
			 *   while writing one's arguments. Replaying the identical request is the
			 *   WRONG recovery here: the most common cause is a tool input that does not
			 *   fit in one response, so an identical replay reproduces the same
			 *   truncation until the retry budget dies. Finish the turn through the
			 *   normal path instead, where the orphaned-tool detector injects the
			 *   skeleton-first reminder and the model can switch to smaller calls.
			 * - `reasoning_only_retry`: only reasoning exists. Nothing client-facing was
			 *   committed and no side effect occurred, so the safest recovery is to DROP
			 *   the partial reasoning and re-send the identical request in place. Keeping
			 *   truncated reasoning would pollute the history and degrade the continuation.
			 * - `none`: nothing to resume from; fall through to ordinary
			 *   retryable/terminal error handling.
			 */
			const classifyResumeStrategy = ():
				| "tool_continuation"
				| "text_continuation"
				| "truncated_tool_input"
				| "reasoning_only_retry"
				| "none" => {
				if (toolUses.length > 0) return "tool_continuation";
				if (
					assistantText.trim().length > 0 ||
					!!collectCompletedWebSearches(webSearchAccum) ||
					!!collectCompletedImageGenerations(imageGenAccum)
				) {
					return "text_continuation";
				}
				// Ranked above reasoning: a model that thinks and THEN gets cut off writing
				// a tool call must be told to write smaller calls, not asked to try again.
				if (orphanedToolInputNames().length > 0) return "truncated_tool_input";
				if (collectReasoningBlocks(reasoningBlockMap)) return "reasoning_only_retry";
				return "none";
			};

			/**
			 * Whether a "resumable" failure can simply be replayed in place because
			 * nothing landed on our side.
			 *
			 * A gateway sets `resumable` once it has forwarded client-visible SSE
			 * payload — that is why it simultaneously refuses a wholesale retry
			 * (`retryable: false`): replaying could duplicate visible output or tool
			 * side effects. But its notion of "client-visible" is broader than ours:
			 * queue notices, a `toolUseChunk` carrying only an id, and other non-content
			 * events count as forwarded upstream while leaving nothing persistable here.
			 *
			 * When that happens the turn is stuck between both recovery paths: there is
			 * nothing to continue from (so no continuation prompt makes sense) and the
			 * error is flagged non-retryable (so the turn dies as a hard failure) even
			 * though the local state is indistinguishable from "the request never
			 * produced anything". Since no visible content and no tool side effect
			 * exists locally, replaying the identical request is safe and is the only
			 * recovery that does not surface a hard failure for a transient transport
			 * fault. The replay reuses the ordinary transient-retry budget and backoff,
			 * so this cannot loop unbounded.
			 */
			const canReplayResumableInPlace = (resumable: boolean): boolean =>
				resumable && !hasAnyPersistableOutput() && !hasStartedEarlyToolExecution();

			/**
			 * Replays granted to an upstream "malformed request body" rejection.
			 *
			 * Two, deliberately: the rejection is overwhelmingly an upstream hiccup that clears
			 * by itself, but it carries no signal distinguishing "transient" from "this body is
			 * actually invalid". A small fixed budget recovers the former without turning the
			 * latter into a long series of full-history re-sends.
			 */
			const MAX_MALFORMED_REPLAYS = 2;

			/**
			 * Whether to replay an identical request after a malformed-body rejection.
			 *
			 * The output guards are the same ones in-place replay always needs: re-sending is
			 * only safe while nothing client-visible has been produced and no tool has begun
			 * executing, otherwise the replay would duplicate output or repeat a side effect.
			 * In practice this rejection arrives before any content, so the guards rarely bite —
			 * but they must be checked rather than assumed, because when they do bite the cost
			 * is duplicated work the user can see.
			 */
			const canReplayMalformedRequest = (): boolean =>
				malformedRetryCount < MAX_MALFORMED_REPLAYS &&
				!config.signal.aborted &&
				// Same rule the ordinary retry budget applies (see `getMaxChatRetries`): a
				// stateful provider has already consumed the request server-side, so re-sending
				// it is not a replay. This guard is not theoretical here — `isMalformedRequestBodyError`
				// matches on response TEXT and is not scoped to a channel, so a codex/responses
				// error that merely contains "Improperly formed request." would otherwise replay
				// a consumed request.
				!usesStatefulModel(effectiveProvider, effectiveModel) &&
				!hasAnyPersistableOutput() &&
				!hasStartedEarlyToolExecution();

			/**
			 * What the caller must do after {@link runMalformedReplay} finishes.
			 *
			 * `"retry"` = fall back into the retry loop; `"aborted"` = the wait was cancelled and
			 * the turn already reported it. Returned rather than left implicit because the two
			 * call sites sit in different loops (`continue chatRetryLoop` vs `continue`), so the
			 * shared generator cannot perform the jump itself.
			 */
			type MalformedReplayOutcome = "retry" | "aborted";

			/**
			 * Perform one malformed-body replay end to end: count it, remember the error so an
			 * empty final attempt reports this instead of "empty response", announce the retry,
			 * tear down the abandoned attempt, and wait out the backoff.
			 *
			 * Both rejection paths (a provider throw and an SSE `invalidState` event) go through
			 * this. They were duplicated line for line, including the abort handling — which is
			 * the kind of pair where a later fix lands on one copy and the other keeps the bug
			 * with no test failing.
			 *
			 * The delay is computed ONCE and used for both the announced `delayMs` and the actual
			 * sleep. Recomputing it after the counter moved is how the two silently disagree, and
			 * a UI that says "retrying in 2s" while sleeping 4s has no error to report.
			 */
			async function* runMalformedReplay(
				message: string,
			): AsyncGenerator<AgentEvent, MalformedReplayOutcome, undefined> {
				malformedRetryCount++;
				lastRetryErrorMessage = message;
				lastRetryDiagnostics = requestDiagnostics;
				const delayMs = Math.min(
					TRANSIENT_RETRY_BASE_MS * 2 ** (malformedRetryCount - 1),
					backoffCeil,
				);
				logger.warn("Upstream rejected the request body as malformed; replaying", {
					narratorId: config.narratorId,
					provider: effectiveProvider,
					model: effectiveModel,
					requestId,
					attempt: malformedRetryCount,
					maxRetries: MAX_MALFORMED_REPLAYS,
					delayMs,
				});
				yield {
					type: "retrying",
					message,
					attempt: malformedRetryCount,
					maxRetries: MAX_MALFORMED_REPLAYS,
					delayMs,
					diagnostics: requestDiagnostics,
				};
				yield* abandonAttemptForReplay(message);
				await abortableSleep(delayMs, config.signal);
				if (config.signal.aborted) {
					yield { type: "error", message: "Aborted" };
					return "aborted";
				}
				return "retry";
			}

			/**
			 * Discard the partial output of an aborted attempt that carried only
			 * reasoning (and/or a tool call with truncated input) so the identical
			 * request can be re-sent without the truncated remnants leaking into
			 * history. Mirrors the reasoning-only dead-turn recovery further below.
			 */
			function* discardReasoningOnlyPartialOutput(): Generator<AgentEvent> {
				// Retract before clearing: the accumulator IS the record of which tool
				// cards are still live, so once it is emptied the ids are unrecoverable
				// and the teardown retraction in finishRequest would find nothing.
				yield* retractStreamingToolCards();
				reasoningBlockMap.clear();
				outputContent.reset();
				redactedThinkingBlocks.length = 0;
				toolUseAccum.clear();
				// Tell the frontend to drop the live streaming reasoning it is showing;
				// nothing will be persisted for this attempt.
				yield { type: "stream_reset" };
			}

			/**
			 * Retract the tool cards of an attempt that is about to be replayed.
			 *
			 * A `tool_use_chunk` publishes a live card as soon as the model starts writing
			 * a tool's arguments, and that card is a purely client-side artifact until the
			 * input completes — nothing is persisted for it. When the stream then breaks
			 * mid-arguments and we retry, the abandoned ids never reach `tool_result`, so
			 * every event that would retire the card (`tool_completed`, the persisted
			 * message carrying the id) never arrives. The card is left running forever:
			 * the ghost tool with a live elapsed timer, still there after the retry
			 * succeeded and the turn finished.
			 *
			 * `stream_reset` is deliberately NOT reused here. It means "drop the live
			 * streaming blocks", which the frontend implements as text/reasoning only —
			 * widening it would also erase legitimately streaming state on paths that
			 * merely discard reasoning. This event names exactly the ids being abandoned,
			 * so a client can retire those cards and nothing else.
			 *
			 * Only ids WITHOUT a completed tool_use are yielded: a tool whose input closed
			 * is either already executing or already persisted, and must not be retracted.
			 */
			function* retractStreamingToolCards(): Generator<AgentEvent> {
				const abandoned = [...toolUseAccum.keys()].filter(
					(id) => !toolUses.some((tu) => tu.toolUseId === id),
				);
				if (abandoned.length === 0) return;
				yield { type: "tool_use_discarded", toolUseIds: abandoned };
			}

			/**
			 * Close out an attempt that is about to be replayed in place.
			 *
			 * Every replay site must go through here rather than calling `finishRequest`
			 * directly. `block_complete` persists as it streams, so an abandoned attempt
			 * has already written its reasoning/text/tool_use rows; `attempt_discarded`
			 * is what tells the host to drop them. Without it each replay leaves another
			 * copy behind and the transcript grows while the outgoing request never
			 * changes.
			 *
			 * Ordering matters: the discard has to reach the consumer BEFORE the request
			 * teardown, mirroring `tool_use_discarded` (which `finishRequest` also emits
			 * ahead of `api_request_end`).
			 *
			 * `requestId` identifies which attempt is being dropped. The consumer needs it
			 * because `api_request_start` is flushed lazily (first stream event, or request
			 * teardown), so an attempt that failed before producing anything emits this
			 * event BEFORE its own `api_request_start`. Keying the truncation baseline on
			 * the requestId keeps the two correlated regardless of arrival order.
			 */
			function* discardAttemptPersistence(): Generator<AgentEvent> {
				yield { type: "attempt_discarded", requestId };
			}

			/** Replay teardown: discard what this attempt persisted, then end its request. */
			function* abandonAttemptForReplay(errorMessage?: string): Generator<AgentEvent> {
				yield* discardAttemptPersistence();
				yield* finishRequest(errorMessage);
			}

			// Settle every completed call through the normal permission/serial execution path
			// before handing the interruption back to the caller's bounded retry budget.
			let pendingResumableError: Extract<AgentEvent, { type: "resumable_error" }> | undefined;
			chatRetryLoop: for (;;) {
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
				outputContent.reset();
				textOutputIndex = undefined;
				reasoningBlockMap.clear();
				toolUses.length = 0;
				toolOrderIdentities.clear();
				nextToolArrivalOrder = 0;
				messageId = undefined;
				credentialId = undefined;
				earlyExecMap.clear();
				settledResults.clear();
				streamReadyTools.clear();
				streamExecutionOpen = false;
				// Leak-detection dump flag is per successful attempt; clear stale state so a
				// retry that no longer leaks does not force-persist the previous attempt's dump.
				forceDumpPersist = false;
				malformedRequestRecord = undefined;
				yieldedToolResults.clear();
				brokenToolUseIds.clear();
				toolUseAccum.clear();
				webSearchAccum.clear();
				imageGenAccum.clear();
				receivedUsage = false;
				streamEventCount = 0;
				contentlessEventCount = 0;
				lastStopReason = undefined;
				namelessToolUseIds.clear();
				sawMeaningfulResponse = false;
				sawErrorEvent = false;
				completionLimitMessage = undefined;
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
				inputCharacters = null;
				inputComposition = null;
				contextSnapshot = undefined;
				upstreamContextPercent = undefined;
				requestRawContextWindow = undefined;
				requestContextPercent = undefined;
				requestMeterUsage = undefined;
				requestMeterUnit = undefined;
				requestDiagnostics = undefined;

				// Collection decision is live (not session-start): saving dump settings must
				// affect the next provider.chat() in this already-running narrator without
				// interrupt/restart. Also force-enabled when the provider may leak XML tool
				// calls so leaked-tool diagnostics always have a bounded raw dump.
				// Providers write bodyText/events through the *WithLimit helpers, so collection
				// stays bounded even when force-enabled here.
				requestDump = shouldCollectRequestDump(provider.mayLeakXmlToolCalls)
					? new ApiRequestDumpCollector({
							provider: effectiveProvider,
							model: effectiveModel,
						})
					: undefined;

				const attemptAbort = new AbortController();
				const guidanceStop = new Error("Stopped for immediate guidance");
				const onGuidanceAbort = () => {
					observeSoftStopForTurn();
					streamExecutionOpen = false;
					attemptAbort.abort(guidanceStop);
				};
				if (guidanceSignal?.aborted) onGuidanceAbort();
				else guidanceSignal?.addEventListener("abort", onGuidanceAbort, { once: true });
				const configuredToolLimit = config.maxToolCallsPerResponse ?? 32;
				const toolCallLimit = Number.isFinite(configuredToolLimit)
					? Math.min(128, Math.max(1, Math.floor(configuredToolLimit)))
					: 32;
				const responseToolIds = new Set<string>();
				const toolLimitState = { exceeded: false };
				const toolLimitStop = new Error("Tool call limit exceeded");
				const registerResponseTool = (id: string): void => {
					throwIfUserAborted();
					if (responseToolIds.has(id)) return;
					if (responseToolIds.size < toolCallLimit) {
						responseToolIds.add(id);
						return;
					}
					toolLimitState.exceeded = true;
					streamExecutionOpen = false;
					toolAbort.abort(toolLimitStop);
					attemptAbort.abort(toolLimitStop);
					try {
						config.onToolCallLimitExceeded?.(toolCallLimit);
					} catch {
						// The owning narrator's notification must not defeat local cancellation.
						logger.warn("Tool call limit interruption callback failed", {
							narratorId: config.narratorId,
						});
					}
					throw toolLimitStop;
				};
				let firstTokenTimeoutTriggered = false;
				let streamIdleTimeoutTriggered = false;
				let providerActivitySeen = false;
				let firstTokenTimer: ReturnType<typeof setTimeout> | undefined;
				let streamIdleTimer: ReturnType<typeof setTimeout> | undefined;
				const firstTokenTimeoutMessage = `${effectiveProvider}: First token timeout after ${Math.round(
					firstTokenTimeoutMs / 1000,
				)}s without upstream activity`;
				const streamIdleTimeoutMs =
					firstTokenTimeoutMs > 0 ? Math.max(firstTokenTimeoutMs * 5, 300_000) : 0;
				const streamIdleTimeoutMessage = `${effectiveProvider}: Stream idle timeout after ${Math.round(
					streamIdleTimeoutMs / 1000,
				)}s without a parsed stream event`;
				const clearFirstTokenTimer = () => {
					if (firstTokenTimer) {
						clearTimeout(firstTokenTimer);
						firstTokenTimer = undefined;
					}
				};
				const clearStreamIdleTimer = () => {
					if (streamIdleTimer) {
						clearTimeout(streamIdleTimer);
						streamIdleTimer = undefined;
					}
				};
				const armStreamIdleTimer = () => {
					if (streamIdleTimeoutMs <= 0) return;
					clearStreamIdleTimer();
					streamIdleTimer = setTimeout(() => {
						if (config.signal.aborted) return;
						streamIdleTimeoutTriggered = true;
						attemptAbort.abort(new Error(streamIdleTimeoutMessage));
					}, streamIdleTimeoutMs);
				};
				const markProviderActivity = () => {
					providerActivitySeen = true;
					clearFirstTokenTimer();
					armStreamIdleTimer();
				};
				startFirstTokenTimerForAttempt = () => {
					if (
						firstTokenTimeoutMs <= 0 ||
						providerActivitySeen ||
						sawMeaningfulResponse ||
						firstTokenTimer
					) {
						return;
					}
					firstTokenTimer = setTimeout(() => {
						if (config.signal.aborted || providerActivitySeen || sawMeaningfulResponse) return;
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
					if (config.runtimeAuthorizationGuard) await config.runtimeAuthorizationGuard();
					// This is adoption by the recipient loop, not persistence, wake admission,
					// or upstream response success. An interrupted/preparation-failed pass never
					// reaches it. Receipt failures cannot retract input or cause redelivery.
					if (!attemptAbort.signal.aborted) {
						const callbacks = pendingInputConsumptions.splice(0);
						callbacks.unshift(() => config.onModelInputConsumed?.(sourceInputHistory, content));
						for (const callback of callbacks) {
							try {
								callback();
							} catch (error) {
								logger.warn("Failed to acknowledge adopted model input", {
									narratorId: config.narratorId,
									error: String(error),
								});
							}
						}
					}
					requestToolSnapshots.set(config, {
						adapter: provider,
						provider: effectiveProvider,
						model: effectiveModel,
						tools,
					});
					const toolSnapshot = requestToolSnapshots.get(config);
					if (toolSnapshot) requestToolSnapshots.set(toolConfig, toolSnapshot);
					if (searchScope) {
						if (!matchesSearchExecutionScope(effectiveProvider, effectiveModel)) {
							yield {
								type: "error",
								message: "Search execution provider/model changed outside its scope",
							};
							return;
						}
						if (searchScope.remainingTurns <= 0) {
							yield { type: "error", message: new SearchExecutionBudgetExceededError().message };
							return;
						}
						consumeSearchExecutionTurn();
					}
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
						onInputCharacters: (counts) => {
							inputCharacters = validInputCharacters(counts);
							try {
								inputComposition =
									config.freezeContextComposition?.(
										inputCharacters,
										requestId,
										new Date(requestStartTime || Date.now()).toISOString(),
									) ?? null;
							} catch {
								inputComposition = null;
							}
						},
						...(isFirstTurn && images?.length ? { images } : {}),
					});

					streamExecutionOpen = true;
					for await (const parsed of stream) {
						if (guidanceSignal?.aborted) throw guidanceStop;
						throwIfUserAborted();
						// Stop dispatch before yielding/awaiting error publication. A finishing
						// tool must not release more queued work while failure handling runs.
						if (parsed.invalidState || parsed.silentDisconnect) streamExecutionOpen = false;
						// Make every identity in this provider event visible before ANY yield.
						// Completed calls and an earlier unfinished chunk may arrive together.
						// Pre-register only a bounded ordering window. Admission below checks
						// completed content in order, before admitting the rest of a huge batch.
						for (const tu of (parsed.toolUses ?? []).slice(0, toolCallLimit)) {
							tu.name = canonicalizeToolName(tu.name);
							markCompletedToolUse(tu);
						}
						if (parsed.toolUseChunk?.toolUseId) {
							registerToolOrderIdentity({
								toolUseId: parsed.toolUseChunk.toolUseId,
								name: parsed.toolUseChunk.name
									? canonicalizeToolName(parsed.toolUseChunk.name)
									: undefined,
								outputIndex: parsed.toolUseChunk.outputIndex,
							});
						}
						yield* flushRequestStart();
						if (isProviderActivityEvent(parsed)) {
							markProviderActivity();
						}
						const hasMeaningfulEvent = isMeaningfulStreamEvent(parsed);
						// Evidence for the empty-response guard: count every event and note
						// which ones carried no content at all, so an attempt that produced
						// nothing can still explain *what* the upstream actually sent.
						streamEventCount++;
						// Counted against persistable content, not mere liveness: a queue
						// notice or an id-only toolUseChunk must register as contentless,
						// otherwise "only bookkeeping arrived" cannot be detected.
						if (!hasPersistableStreamContent(parsed)) contentlessEventCount++;
						// `stopReason` is the provider's own completion reason. It was
						// previously read nowhere in this loop, which is why an empty turn
						// could not distinguish "model stopped" from "nothing arrived".
						if (parsed.stopReason) lastStopReason = parsed.stopReason;
						// A tool-call chunk without a name can never become a tool call
						// (the accumulator below requires `name`), so it leaves no trace
						// unless recorded here.
						if (parsed.toolUseChunk?.toolUseId && !parsed.toolUseChunk.name) {
							namelessToolUseIds.add(parsed.toolUseChunk.toolUseId);
						}
						// Record TTFT (time to first meaningful output) for this request.
						if (requestTtftMs === undefined && hasMeaningfulEvent) {
							requestTtftMs = Date.now() - requestStartTime;
						}

						if (hasMeaningfulEvent) {
							sawMeaningfulResponse = true;
							clearFirstTokenTimer();
						}
						// Only content that actually landed clears a prior retry error.
						// Gating this on `isMeaningfulStreamEvent` used to break the
						// attribution chain: a single usage/queue event after an upstream
						// 503 wiped the real cause, and the turn then reported the generic
						// empty-response text instead of the 503 that caused it.
						if (hasPersistableStreamContent(parsed)) {
							lastRetryErrorMessage = undefined;
							lastRetryDiagnostics = undefined;
						}

						const reasoningKey = reasoningBlockKey(parsed);
						const reasoningLane: ContentLane = {
							blockId:
								parsed.reasoningBlockId ??
								(reasoningKey === "__default" ? undefined : reasoningKey),
							outputIndex: parsed.reasoningOutputIndex,
						};
						const textLane: ContentLane = {
							blockId: parsed.textBlockId,
							outputIndex: parsed.textOutputIndex,
						};
						if (parsed.contentBoundary?.phase === "start") {
							yield* outputContent.boundary(parsed.contentBoundary);
						}
						if (parsed.reasoning) {
							yield* outputContent.begin("reasoning", reasoningLane);
							const itemKey = reasoningKey;
							const existing = reasoningBlockMap.get(itemKey);
							const stampedMetadata = stampReasoningSource(
								parsed.reasoningMetadata,
								provider.getActiveReasoningSource?.(),
							);
							// Metadata can arrive mid-item; it must not inject bytes into signed reasoning.
							if (existing) {
								existing.text += parsed.reasoning;
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
							const identity = outputContent.append(
								"reasoning",
								parsed.reasoning,
								reasoningLane,
								stampedMetadata,
							);
							yield {
								type: "stream_reasoning",
								text: parsed.reasoning,
								providerMetadata: stampedMetadata,
								...identity,
							};
						} else if (parsed.reasoningMetadata) {
							// Metadata-only event (e.g. final encrypted_content from output_item.done
							// or Anthropic thinking block stop with signature).
							// Update the stored metadata without emitting a streaming event.
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
							} else {
								// Metadata arrived before any text — create an empty-text entry
								reasoningBlockMap.set(itemKey, {
									text: "",
									providerMetadata: stampedMetadata,
									outputIndex: parsed.reasoningOutputIndex,
								});
							}
							if (stampedMetadata)
								yield* outputContent.reasoningMetadata(stampedMetadata, reasoningLane);
						}

						// ── Mimo ellipsis reasoning detection ──
						// Some mimo models (via Anthropic protocol) emit "..." as the
						// entire reasoning content, which is a degenerate response.
						// When detected, discard the reasoning block and retry the request.
						if (parsed.reasoningMetadata && effectiveModel.toLowerCase().includes("mimo")) {
							const itemKey = reasoningBlockKey(parsed);
							const entry = reasoningBlockMap.get(itemKey);
							if (entry && entry.text.trim() === "...") {
								logger.warn(
									"Mimo model returned ellipsis-only reasoning, discarding and retrying",
									{
										narratorId: config.narratorId,
										model: effectiveModel,
										provider: effectiveProvider,
									},
								);
								reasoningBlockMap.delete(itemKey);
								mimoEllipsisRetry = true;
								break; // break out of for-await stream loop to trigger retry
							}
						}
						if (parsed.text) {
							yield* outputContent.begin("text", textLane);
							assistantText += parsed.text;
							if (parsed.text.trim()) silentToolCallCount = 0;
							if (parsed.textOutputIndex != null) {
								textOutputIndex = parsed.textOutputIndex;
							}
							// Deltas are forwarded verbatim. Stripping happens once at finalize,
							// and the read side projects historical rows anyway — a second,
							// incremental parser here only created two ways to disagree.
							const identity = outputContent.append("text", parsed.text, textLane);
							yield { type: "stream_text", text: parsed.text, ...identity };
						}
						// Late annotations update their original block; aggregate text and
						// block-local citations are both derived from the same lane spans.
						if (parsed.textCitations) {
							yield* outputContent.addCitations(parsed.textCitations, textLane);
						}
						if (parsed.contentBoundary && parsed.contentBoundary.phase !== "start") {
							yield* outputContent.boundary(parsed.contentBoundary);
						}
						// Content is acknowledged by the awaited event consumer before even
						// the first tool card is shown (not just before eager execution).
						if (parsed.toolUseChunk?.toolUseId) {
							const chunk = parsed.toolUseChunk;
							yield* outputContent.beforeExternal(chunk.toolUseId, chunk.outputIndex);
							chunk.outputIndex ??= outputContent.observeExternal(chunk.toolUseId);
						}
						for (const tool of parsed.toolUses ?? []) {
							yield* outputContent.beforeExternal(tool.toolUseId, tool.outputIndex);
							tool.outputIndex ??= outputContent.observeExternal(tool.toolUseId);
						}
						if (parsed.webSearch) {
							yield* outputContent.beforeExternal(
								parsed.webSearch.id,
								parsed.webSearch.outputIndex,
							);
							parsed.webSearch.outputIndex ??= outputContent.observeExternal(parsed.webSearch.id);
						}
						if (parsed.imageGeneration) {
							yield* outputContent.beforeExternal(
								parsed.imageGeneration.id,
								parsed.imageGeneration.outputIndex,
							);
							parsed.imageGeneration.outputIndex ??= outputContent.observeExternal(
								parsed.imageGeneration.id,
							);
						}
						if (parsed.toolUses) {
							// ── Tool use dedup ──
							// Some providers (notably NUG) may emit the same tool call
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
							for (const tu of parsed.toolUses) {
								throwIfUserAborted();
								tu.name = canonicalizeToolName(tu.name);
								const pendingInput = toolUseAccum.get(tu.toolUseId);
								if (pendingInput) {
									if (tu.input != null && typeof tu.input === "object" && !("_raw" in tu.input)) {
										const snapshot = JSON.stringify(tu.input);
										const prefix = pendingInput.stream.materializeRaw();
										if (snapshot.startsWith(prefix))
											pendingInput.stream.feed(snapshot.slice(prefix.length));
										else if (JSON.stringify(pendingInput.stream.finish()) !== snapshot) {
											yield* flushToolInput(tu.toolUseId, pendingInput);
											resetToolInput(pendingInput, snapshot);
										}
										pendingInput.totalChars = pendingInput.stream.totalChars;
										collectShortFields(pendingInput);
									}
									yield* flushToolInput(tu.toolUseId, pendingInput);
								}
								const identity = markCompletedToolUse(tu);
								// Skip duplicates — the streaming path may have already
								// completed this tool call via toolUseChunk stop. Preserve any
								// order metadata learned by the non-streaming duplicate.
								const existingToolUse = toolUses.find((t) => t.toolUseId === tu.toolUseId);
								if (existingToolUse) {
									if (existingToolUse.outputIndex == null && identity.outputIndex != null) {
										existingToolUse.outputIndex = identity.outputIndex;
									}
									continue;
								}

								if (tu.thoughtSignature && !tu.thoughtSignatureSource) {
									tu.thoughtSignatureSource = provider.getActiveReasoningSource?.();
								}
								registerResponseTool(tu.toolUseId);
								toolUses.push(tu);

								// If this tool was also being streamed via toolUseChunk, remove it
								// from the accumulator so it isn't flagged as orphaned.
								// This happens with some providers (e.g. NUG) that send both a
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
									onToolPersisted: (binding) => bindExecution(tu, binding),
									block: {
										type: "tool_use",
										toolUseId: tu.toolUseId,
										name: tu.name,
										input: tu.input,
										outputIndex: tu.outputIndex,
										...(tu.thoughtSignature && { thoughtSignature: tu.thoughtSignature }),
										...(tu.thoughtSignatureSource && {
											thoughtSignatureSource: tu.thoughtSignatureSource,
										}),
									} satisfies ContentBlock,
								};

								throwIfUserAborted();
								yield {
									type: "tool_call",
									toolUseId: tu.toolUseId,
									toolName: tu.name,
									input: tu.input,
								};
								throwIfUserAborted();
								streamReadyTools.add(tu.toolUseId);
								pumpStreamingTools();
							}
						}

						// Handle streaming tool use chunks
						if (parsed.toolUseChunk) {
							throwIfUserAborted();
							if (parsed.toolUseChunk.toolUseId) {
								registerResponseTool(parsed.toolUseChunk.toolUseId);
							}
							const { toolUseId: id, input, stop } = parsed.toolUseChunk;
							// Same canonicalization as the non-streaming path: the accumulator
							// stores this name and every later lookup (field config, registry,
							// persisted card) reads it from there.
							const name = parsed.toolUseChunk.name
								? canonicalizeToolName(parsed.toolUseChunk.name)
								: parsed.toolUseChunk.name;
							const chunkThoughtSignature = parsed.toolUseChunk.thoughtSignature;
							const chunkThoughtSignatureSource =
								parsed.toolUseChunk.thoughtSignatureSource ??
								(chunkThoughtSignature ? provider.getActiveReasoningSource?.() : undefined);
							if (id) {
								// Register on the first observed chunk even when the provider omits
								// both name and outputIndex; arrival order is the stable fallback.
								registerToolOrderIdentity({
									toolUseId: id,
									name,
									outputIndex: parsed.toolUseChunk.outputIndex,
								});
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
											stream: new ToolInputStream(
												TOOL_FIELD_CONFIG[name]?.short,
												TOOL_FIELD_CONFIG[name]?.large,
											),
											totalChars: 0,
											pendingShort: {},
											startedAt: Date.now(),
											lastYieldedAt: Date.now(),
											outputIndex: parsed.toolUseChunk.outputIndex,
											thoughtSignature: chunkThoughtSignature,
											thoughtSignatureSource: chunkThoughtSignatureSource,
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
									if (stop) acc.streamCompletedAt = Date.now();
									if (parsed.toolUseChunk.outputIndex != null) {
										acc.outputIndex = parsed.toolUseChunk.outputIndex;
									}
									// Gemini 3: the thought signature may arrive on any chunk for
									// this call; keep the latest non-empty value.
									if (chunkThoughtSignature) {
										acc.thoughtSignature = chunkThoughtSignature;
										acc.thoughtSignatureSource = chunkThoughtSignatureSource;
									}
									// finalInput is an authoritative snapshot, never an append delta.
									const finalInput = parsed.toolUseChunk.finalInput;
									if (typeof finalInput === "string") {
										const prefix = acc.stream.materializeRaw();
										if (finalInput.startsWith(prefix)) {
											// The authoritative snapshot can seal an actual append-only prefix.
											acc.stream.feed(finalInput.slice(prefix.length));
										} else {
											yield* flushToolInput(id, acc);
											resetToolInput(acc, finalInput);
										}
									} else if (typeof input === "string") acc.stream.feed(input);
									else if (input != null) {
										// Gemini and other whole-input providers use the same field pipeline.
										acc.stream.feed(JSON.stringify(input));
									}
									acc.totalChars = acc.stream.totalChars;
									const fieldsChanged = collectShortFields(acc);
									if (
										!stop &&
										(fieldsChanged ||
											acc.stream.hasClosedFields ||
											Date.now() - acc.lastYieldedAt >= 50)
									) {
										yield* flushToolInput(id, acc);
									}
									if (stop) {
										yield* flushToolInput(id, acc);
										const parsedInput = acc.stream.finish();
										const streamingEditOrigin =
											(parsedInput?.device ?? config.defaultDeviceId ?? "local") === "local"
												? validateStreamingEditOrigin(acc.streamingEditOrigin, id, parsedInput)
												: undefined;
										const tu: AgentToolUse = {
											toolUseId: id,
											name: acc.name,
											input: parsedInput,
											streamStartedAt: acc.startedAt,
											streamCompletedAt: acc.streamCompletedAt,
											outputIndex: acc.outputIndex,
											...(acc.thoughtSignature && { thoughtSignature: acc.thoughtSignature }),
											...(acc.thoughtSignatureSource && {
												thoughtSignatureSource: acc.thoughtSignatureSource,
											}),
										};
										const identity = markCompletedToolUse(tu);
										// Skip if already added via non-streaming parsed.toolUses.
										const existingToolUse = toolUses.find((t) => t.toolUseId === id);
										const alreadyAdded = !!existingToolUse;
										if (
											existingToolUse &&
											existingToolUse.outputIndex == null &&
											identity.outputIndex != null
										) {
											existingToolUse.outputIndex = identity.outputIndex;
										}
										if (!alreadyAdded) {
											if (tu.thoughtSignature && !tu.thoughtSignatureSource) {
												tu.thoughtSignatureSource = provider.getActiveReasoningSource?.();
											}
											registerResponseTool(tu.toolUseId);
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
											onToolPersisted: (binding) => bindExecution(tu, binding),
											block: {
												type: "tool_use",
												toolUseId: id,
												name: tu.name,
												input: parsedInput,
												streamStartedAt: acc.startedAt,
												streamCompletedAt: acc.streamCompletedAt,
												outputIndex: acc.outputIndex,
												...(acc.thoughtSignature && { thoughtSignature: acc.thoughtSignature }),
												...(acc.thoughtSignatureSource && {
													thoughtSignatureSource: acc.thoughtSignatureSource,
												}),
											} satisfies ContentBlock,
										};

										// Notify frontend the tool has started
										throwIfUserAborted();
										yield {
											type: "tool_call",
											toolUseId: id,
											toolName: tu.name,
											input: parsedInput,
											streamingEditOrigin,
											streamStartedAt: acc.startedAt,
											streamCompletedAt: acc.streamCompletedAt,
										};
										throwIfUserAborted();
										streamReadyTools.add(id);
										pumpStreamingTools();

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
											await processToolResultInjections(prevTu, sr);
											const baseOutput = sr.broken
												? getToolMessage("brokenToolCallResult", locale)
												: sr.output;
											yield {
												type: "tool_result",
												toolCallBinding: executionBindings.get(prevTu),
												toolUseId: prevTu.toolUseId,
												toolName: prevTu.name,
												input: sr.updatedInput ?? prevTu.input,
												output: baseOutput,
												isError: sr.isError ?? false,
												durationMs: sr.durationMs,
												permissionStartedAt: sr.permissionStartedAt,
												executionStartedAt: sr.executionStartedAt,
												completedAt: sr.completedAt,
												brokenInputOverride: brokenOverride,
												updatedInput: brokenOverride ?? sr.updatedInput,
												metadata: sr.metadata,
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
							yield* drainStartedEarlyToolResults();
							yield* finishRequest("Silent disconnect");
							yield { type: "silent_disconnect" };
							return;
						}
						if (parsed.messageId) messageId = parsed.messageId;

						if (parsed.credentialId) credentialId = parsed.credentialId;

						if (parsed.redactedThinking) {
							yield* outputContent.flush();
							parsed.redactedThinking.outputIndex = outputContent.observeExternal(
								`redacted:${redactedThinkingBlocks.length}`,
								parsed.redactedThinking.outputIndex,
							);
							const redactedSource = provider.getActiveReasoningSource?.();
							redactedThinkingBlocks.push({
								data: parsed.redactedThinking.data,
								outputIndex: parsed.redactedThinking.outputIndex,
								...(redactedSource ? { signatureSource: redactedSource } : {}),
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
						if (
							parsed.usage?.contextWindow != null &&
							Number.isFinite(parsed.usage.contextWindow) &&
							parsed.usage.contextWindow > 0
						)
							requestRawContextWindow = parsed.usage.contextWindow;
						if (
							parsed.contextUsagePercentage != null &&
							Number.isFinite(parsed.contextUsagePercentage)
						) {
							receivedUsage = true;
							// Upstream occupancy is independent of measured/billed token counts.
							const ctxWin =
								requestRawContextWindow ?? getModelContextWindow(effectiveModel, effectiveProvider);
							upstreamContextPercent = Math.min(Math.max(parsed.contextUsagePercentage, 0), 100);
							requestContextPercent = upstreamContextPercent;
							const estimatedPromptTokens = getEstimatedUpstreamPromptTokens();
							yield {
								type: "context_usage",
								percentage: upstreamContextPercent,
								source: "upstream",
								snapshot: snapshotContext(
									"upstream",
									upstreamContextPercent,
									ctxWin ?? null,
									estimatedPromptTokens ?? null,
								),
								promptTokens: estimatedPromptTokens,
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
							const previousUsage = requestUsage as ApiRequestEndEvent["usage"];
							// Merge partial counters without letting prompt/input placeholders
							// erase known counts. Output and cache counters update independently.
							requestUsage = {
								promptTokens: parsed.usage.promptTokens || previousUsage?.promptTokens || 0,
								inputTokens:
									parsed.usage.inputTokens === 0 && previousUsage?.inputTokens
										? previousUsage.inputTokens
										: (parsed.usage.inputTokens ?? previousUsage?.inputTokens),
								completionTokens:
									parsed.usage.completionTokens === 0 && previousUsage?.completionTokens
										? previousUsage.completionTokens
										: (parsed.usage.completionTokens ?? previousUsage?.completionTokens),
								reasoningTokens: parsed.usage.reasoningTokens ?? previousUsage?.reasoningTokens,
								cachedInputTokens:
									parsed.usage.cachedInputTokens ?? previousUsage?.cachedInputTokens,
								cacheCreationInputTokens:
									parsed.usage.cacheCreationInputTokens ?? previousUsage?.cacheCreationInputTokens,
								cacheCreation5mTokens:
									parsed.usage.cacheCreation5mTokens ?? previousUsage?.cacheCreation5mTokens,
								cacheCreation1hTokens:
									parsed.usage.cacheCreation1hTokens ?? previousUsage?.cacheCreation1hTokens,
							};
							const contextWindow =
								parsed.usage.contextWindow ??
								getModelContextWindow(effectiveModel, effectiveProvider);
							// Guard: only emit context_usage when promptTokens > 0.
							// Some Anthropic-compatible APIs (e.g. Xiaomi Mimo) send
							// { input_tokens: 0, output_tokens: 0 } in message_start and
							// defer real usage to message_delta. Emitting 0% context usage
							// causes the UI to briefly flash "0%" before showing the real value.
							if (
								contextWindow &&
								parsed.usage.promptTokens > 0 &&
								upstreamContextPercent === undefined
							) {
								const percentage = (parsed.usage.promptTokens / contextWindow) * 100;
								requestContextPercent = Math.min(percentage, 100);
								yield {
									type: "context_usage",
									percentage: requestContextPercent,
									source: "usage",
									snapshot: snapshotContext(
										"usage",
										percentage,
										contextWindow,
										parsed.usage.promptTokens,
									),
									...requestUsage,
									contextWindow,
									isEstimated: false,
								};
							}
						}
						if (
							upstreamContextPercent !== undefined &&
							requestRawContextWindow &&
							(contextSnapshot as ContextUsageSnapshot | undefined)?.contextWindow !==
								requestRawContextWindow
						) {
							const occupied = getEstimatedUpstreamPromptTokens();
							const snapshot = snapshotContext(
								"upstream",
								upstreamContextPercent,
								requestRawContextWindow,
								occupied ?? null,
							);
							yield {
								type: "context_usage",
								percentage: upstreamContextPercent,
								source: "upstream",
								snapshot,
								promptTokens: occupied,
								contextWindow: requestRawContextWindow,
								isEstimated: true,
							};
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
							requestDiagnostics = normalizeApiRequestDiagnostics({
								...parsed.invalidState.diagnostics,
								source: parsed.invalidState.diagnostics?.source ?? "provider",
								phase: parsed.invalidState.diagnostics?.phase ?? "invalid_state",
								reason,
								message,
								provider: parsed.invalidState.diagnostics?.provider ?? effectiveProvider,
								model: parsed.invalidState.diagnostics?.model ?? effectiveModel,
							});
							// Opaque upstream "malformed request body" rejection delivered as a stream
							// error event (NUG relays the upstream ValidationException this way). Capture
							// the exact request before any classification path consumes the error.
							if (
								isMalformedRequestBodyError({ reason, message, diagnostics: requestDiagnostics })
							) {
								await captureMalformedRequest(message);
								// Almost always an upstream hiccup that clears on its own, so replay the
								// identical request a couple of times before surfacing a hard failure.
								if (canReplayMalformedRequest()) {
									if ((yield* runMalformedReplay(message)) === "aborted") return;
									continue chatRetryLoop;
								}
							}
							const classification = classifyInvalidState(reason, message, requestDiagnostics);
							if (classification.category === "context_overflow") {
								yield* outputContent.flush();
								yield* finishRequest(message);
								yield { type: "context_length_exceeded", message };
								return;
							}
							if (classification.category === "completion_limit") {
								if (completionLimitMessage == null) {
									completionLimitMessage = message;
									logger.info("Provider hit completion token limit", {
										narratorId: config.narratorId,
										provider: effectiveProvider,
										model: effectiveModel,
										reason,
										message,
									});
									yield { type: "output_truncated", message };
								}
								continue;
							}
							// Model temporarily unavailable at the NUG gateway (whole credential
							// pool disabled). Suspend and wait for recovery instead of retrying
							// the full request. Only for NUG providers, and only when no tool
							// execution has started (otherwise fall through to the normal terminal
							// path so side-effect recovery is handled by the caller).
							{
								const nugProvider = (settings.nugProviders ?? []).find(
									(p) =>
										!p.disabled && (p.prefix === effectiveProvider || p.id === effectiveProvider),
								);
								if (
									nugProvider &&
									isModelUnavailableError({ message, diagnostics: requestDiagnostics }) &&
									!hasStartedEarlyToolExecution()
								) {
									yield* outputContent.flush();
									yield* finishRequest(message);
									const prefixToken = `${nugProvider.prefix}:`;
									const nugModelId = effectiveModel.startsWith(prefixToken)
										? effectiveModel.slice(prefixToken.length)
										: effectiveModel;
									yield {
										type: "model_unavailable",
										message,
										provider: effectiveProvider,
										model: effectiveModel,
										providerId: nugProvider.id,
										providerPrefix: nugProvider.prefix ?? effectiveProvider,
										nugModelId,
										diagnostics: requestDiagnostics,
									};
									return;
								}
							}
							// Guard first, so a turn that already ran tools does not pay for a
							// usage lookup it could never act on.
							if (!hasStartedEarlyToolExecution()) {
								// Kimi coding-plan allowance used up (403 "usage limit"). Unlike
								// the NUG case above this is NOT unknowable: the window's reset
								// instant is published, so the caller waits on the clock rather
								// than on a poller.
								//
								// A wall whose reset is beyond the wait budget is forwarded too
								// (`quotaResetAt` without `resumeAt`): the caller then reports it
								// WITH the recovery time, because "spent, returns at T" is
								// actionable and an opaque 403 is not.
								const kimiQuota = await resolveKimiQuotaWait(
									effectiveProvider,
									`${message}\n${requestDiagnostics?.responseSnippet ?? ""}`,
								);
								if (kimiQuota.kind !== "none") {
									const { providerId, providerPrefix, resetAt } =
										kimiQuota.kind === "wait" ? kimiQuota.wait : kimiQuota.refusal;
									yield* outputContent.flush();
									yield* finishRequest(message);
									yield {
										type: "model_unavailable",
										message,
										provider: effectiveProvider,
										model: effectiveModel,
										providerId,
										providerPrefix,
										waitKind: "quota",
										resumeAt: kimiQuota.kind === "wait" ? kimiQuota.wait.resumeAt : undefined,
										quotaResetAt: resetAt,
										diagnostics: requestDiagnostics,
									};
									return;
								}
							}
							// Resumable but nothing landed locally: the gateway counted some
							// non-content event as forwarded payload, so it refuses a wholesale
							// retry, yet we have no visible output and no tool side effect to
							// resume from. Replay the identical request instead of dying on a
							// transient transport fault. See canReplayResumableInPlace.
							if (canReplayResumableInPlace(classification.resumable)) {
								if (
									(getMaxChatRetries() === -1 || chatRetryCount < getMaxChatRetries()) &&
									!config.signal.aborted
								) {
									chatRetryCount++;
									lastRetryErrorMessage = message;
									lastRetryDiagnostics = requestDiagnostics;
									const delayMs = Math.min(
										TRANSIENT_RETRY_BASE_MS * 2 ** (chatRetryCount - 1),
										backoffCeil,
									);
									logger.warn("Resumable stream interruption with no local output, replaying", {
										narratorId: config.narratorId,
										provider: effectiveProvider,
										model: effectiveModel,
										requestId,
										reason,
										attempt: chatRetryCount,
										maxRetries: getMaxChatRetries(),
									});
									yield {
										type: "retrying",
										message,
										attempt: chatRetryCount,
										maxRetries: getMaxChatRetries(),
										delayMs,
										diagnostics: requestDiagnostics,
									};
									yield* abandonAttemptForReplay(message);
									await abortableSleep(delayMs, config.signal);
									if (config.signal.aborted) {
										yield { type: "error", message: "Aborted" };
										return;
									}
									continue chatRetryLoop;
								}
								// Replay budget spent (or a stateful provider that cannot replay):
								// fall through to the ordinary terminal handling below.
							}
							// Resumable: a transient failure occurred after client-visible partial
							// output was already produced this attempt (NUG/gateway told us so via
							// diagnostics.resumable). Retrying the whole request wholesale could
							// repeat visible output, so recover according to what the partial output
							// actually is (see classifyResumeStrategy).
							if (classification.resumable && hasAnyPersistableOutput()) {
								const strategy = classifyResumeStrategy();
								if (strategy === "tool_continuation") {
									// A complete tool call landed before the stream broke. Finish the
									// turn through the normal path: tools execute (already-started
									// eager promises are awaited), tool_results are yielded and pushed
									// to history, and the next turn continues from them. No textual
									// continuation prompt and no request replay is needed.
									logger.warn("Resumable stream interruption after a complete tool call", {
										narratorId: config.narratorId,
										provider: effectiveProvider,
										model: effectiveModel,
										requestId,
										reason,
										toolCount: toolUses.length,
										startedToolCount: earlyExecMap.size,
									});
									// Deliberately NOT setting `sawErrorEvent`: that flag stops the
									// turn, but here the turn must continue so the tool runs. The
									// downstream empty-response and reasoning-only guards both
									// check `toolUses.length`, so a complete tool call already
									// keeps them from firing.
									yield {
										type: "resumable_recovered",
										strategy: "tool_continuation",
										message,
										diagnostics: requestDiagnostics,
									};
									break;
								}
								if (strategy === "truncated_tool_input") {
									// The model was cut off while writing a tool's arguments. Finish the
									// turn through the normal path so the orphaned-tool detector injects
									// the skeleton-first reminder; an identical replay would just hit the
									// same output ceiling again.
									logger.warn("Resumable stream interruption mid tool input", {
										narratorId: config.narratorId,
										provider: effectiveProvider,
										model: effectiveModel,
										requestId,
										reason,
										orphanedTools: orphanedToolInputNames(),
									});
									yield {
										type: "resumable_recovered",
										strategy: "truncated_tool_input",
										message,
										diagnostics: requestDiagnostics,
									};
									break;
								}
								if (strategy === "reasoning_only_retry" && canReplayInPlace()) {
									// Only reasoning was produced. Drop it and re-send the identical
									// request instead of continuing from a truncated thought.
									if (
										(getMaxChatRetries() === -1 || chatRetryCount < getMaxChatRetries()) &&
										!config.signal.aborted
									) {
										chatRetryCount++;
										lastRetryErrorMessage = message;
										lastRetryDiagnostics = requestDiagnostics;
										const delayMs = Math.min(
											TRANSIENT_RETRY_BASE_MS * 2 ** (chatRetryCount - 1),
											backoffCeil,
										);
										logger.warn("Resumable stream interruption with reasoning only, retrying", {
											narratorId: config.narratorId,
											provider: effectiveProvider,
											model: effectiveModel,
											requestId,
											reason,
											attempt: chatRetryCount,
											maxRetries: getMaxChatRetries(),
										});
										yield* discardReasoningOnlyPartialOutput();
										yield {
											type: "retrying",
											message,
											attempt: chatRetryCount,
											maxRetries: getMaxChatRetries(),
											delayMs,
											diagnostics: requestDiagnostics,
										};
										yield* abandonAttemptForReplay(message);
										await abortableSleep(delayMs, config.signal);
										if (config.signal.aborted) {
											yield { type: "error", message: "Aborted" };
											return;
										}
										continue chatRetryLoop;
									}
									// Retry budget spent (or a stateful provider that cannot replay the
									// request): fall back to a textual continuation rather than failing.
								}
								yield* outputContent.flush();
								yield* finishRequest(message);
								yield { type: "resumable_error", message, diagnostics: requestDiagnostics };
								return;
							}
							if (classification.retryable) {
								// A completed tool call must never be replayed away: the replay resets
								// `toolUses`/`settledResults`, so the model would ask for the same tool
								// again while the result it already produced is lost.
								//
								// Widened from `hasStartedEarlyToolExecution()`: a tool whose input closed
								// but which was deferred (strict-serial, or an eager-disabled tool such as
								// Bash/Write/Edit) has no entry in `earlyExecMap`, yet replaying it is just
								// as lossy.
								if (hasIrreplaceableProgress()) {
									logger.warn("Retryable provider stream error after tool progress landed", {
										narratorId: config.narratorId,
										provider: effectiveProvider,
										model: effectiveModel,
										reason,
										toolCount: toolUses.length,
										startedToolCount: earlyExecMap.size,
										settledToolCount: settledResults.size,
									});
									// Draining eager calls alone strands completed deferred calls (Browser,
									// strict-serial tools). Execute them normally, but never start another
									// provider turn here: the caller owns the interruption retry budget.
									pendingResumableError = {
										type: "resumable_error",
										message,
										diagnostics: requestDiagnostics,
									};
									break chatRetryLoop;
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
									lastRetryDiagnostics = requestDiagnostics;
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
										diagnostics: requestDiagnostics,
									};
									yield* abandonAttemptForReplay(message);
									await abortableSleep(delayMs, config.signal);
									if (config.signal.aborted) {
										yield { type: "error", message: "Aborted" };
										return;
									}
									continue chatRetryLoop;
								}
								if (await hasPendingRuntimeSettingsOverride()) {
									yield* finishRequest(message);
									const switchEvent = await applyPendingRuntimeSettings("retry");
									if (switchEvent) {
										// Only now is this a replay: discard what the abandoned attempt
										// persisted. Emitted after the switch is confirmed, because
										// without one the turn ends here and its partial content must
										// be kept for the caller.
										yield* discardAttemptPersistence();
										yield switchEvent;
										resetRetryStateAfterModelSwitch();
										continue chatRetryLoop;
									}
								}
								// Exhausted retries — yield block_complete for partial content
								// then signal retryable_error to the caller.
								yield* outputContent.flush();
								yield* finishRequest(message);
								yield { type: "retryable_error", message, diagnostics: requestDiagnostics };
								return;
							}
							// Non-retryable invalidState — treat as a terminal error.
							// Flush any partial content and return immediately so the original
							// error surfaces to the user instead of being masked by the
							// downstream empty-response check (which would retry and eventually
							// report a misleading "Provider returned an empty response" message).
							yield* drainStartedEarlyToolResults();
							sawErrorEvent = true;
							yield* outputContent.flush();
							yield* finishRequest(message);
							yield {
								type: "invalid_state",
								reason,
								message,
								diagnostics: requestDiagnostics,
							};
							return;
						}
					}
					streamExecutionOpen = false;
					throwIfUserAborted();
					yield* flushRequestStart();
				} catch (err) {
					streamExecutionOpen = false;
					if (toolLimitState.exceeded) {
						const message =
							locale === "zh-CN"
								? `单次模型回复的工具调用超过 ${toolCallLimit} 个，已中断。`
								: `Interrupted: this model response exceeded ${toolCallLimit} tool calls.`;
						logger.warn("Tool call limit exceeded", {
							narratorId: config.narratorId,
							limit: toolCallLimit,
						});
						await Promise.resolve();
						yield* drainEarlyToolResultsAfterAbort();
						yield* outputContent.flush();
						yield* finishRequest(message);
						yield { type: "error", message };
						return;
					}
					if (config.signal.aborted) {
						// Let already-fulfilled eager tool promises publish into `settledResults`,
						// then persist their completed results before surfacing the abort.  Without
						// this, a user interrupt during trailing text can leave tool calls that had
						// already finished execution stuck as running/interrupted in history.
						await Promise.resolve();
						yield* drainEarlyToolResultsAfterAbort();
						// Do not await still-running eager tools beyond the bounded abort drain. The
						// executor finishes cleanup; the detached callback preserves the exact result.
						// Even on abort, yield block_complete for accumulated content so it can be persisted
						yield* outputContent.flush();
						yield* finishRequest("Aborted");
						yield { type: "error", message: "Aborted" };
						return;
					}
					if (guidanceSignal?.aborted) {
						observeSoftStopForTurn();
						// Guidance is not a transport fault. Finalize this partial turn below,
						// without replay/retry or cancelling tools whose bodies already began.
						break;
					}
					if (firstTokenTimeoutTriggered) {
						requestDiagnostics = normalizeApiRequestDiagnostics({
							source: "agent",
							phase: "first_token",
							reason: "first_token_timeout",
							message: firstTokenTimeoutMessage,
							provider: effectiveProvider,
							model: effectiveModel,
						});
						if (
							(maxFirstTokenRetries === -1 || chatRetryCount < maxFirstTokenRetries) &&
							!config.signal.aborted
						) {
							chatRetryCount++;
							lastRetryErrorMessage = firstTokenTimeoutMessage;
							lastRetryDiagnostics = requestDiagnostics;
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
								diagnostics: requestDiagnostics,
							};
							yield* abandonAttemptForReplay(firstTokenTimeoutMessage);
							await abortableSleep(delayMs, config.signal);
							if (config.signal.aborted) {
								yield { type: "error", message: "Aborted" };
								return;
							}
							continue; // retry provider.chat()
						}
						if (await hasPendingRuntimeSettingsOverride()) {
							yield* finishRequest(firstTokenTimeoutMessage);
							const switchEvent = await applyPendingRuntimeSettings("retry");
							if (switchEvent) {
								yield* discardAttemptPersistence();
								yield switchEvent;
								resetRetryStateAfterModelSwitch();
								continue;
							}
						}
						yield* finishRequest(firstTokenTimeoutMessage);
						yield {
							type: "retryable_error",
							message: firstTokenTimeoutMessage,
							diagnostics: requestDiagnostics,
						};
						return;
					}
					if (streamIdleTimeoutTriggered) {
						requestDiagnostics = normalizeApiRequestDiagnostics({
							source: "agent",
							phase: "stream_idle",
							reason: "stream_idle_timeout",
							message: streamIdleTimeoutMessage,
							provider: effectiveProvider,
							model: effectiveModel,
						});
						if (
							(maxFirstTokenRetries === -1 || chatRetryCount < maxFirstTokenRetries) &&
							!config.signal.aborted
						) {
							chatRetryCount++;
							lastRetryErrorMessage = streamIdleTimeoutMessage;
							lastRetryDiagnostics = requestDiagnostics;
							const delayMs = Math.min(
								TRANSIENT_RETRY_BASE_MS * 2 ** (chatRetryCount - 1),
								backoffCeil,
							);
							yield {
								type: "retrying",
								message: streamIdleTimeoutMessage,
								attempt: chatRetryCount,
								maxRetries: maxFirstTokenRetries,
								delayMs,
								diagnostics: requestDiagnostics,
							};
							yield* abandonAttemptForReplay(streamIdleTimeoutMessage);
							await abortableSleep(delayMs, config.signal);
							if (config.signal.aborted) {
								yield { type: "error", message: "Aborted" };
								return;
							}
							continue; // retry provider.chat()
						}
						if (await hasPendingRuntimeSettingsOverride()) {
							yield* finishRequest(streamIdleTimeoutMessage);
							const switchEvent = await applyPendingRuntimeSettings("retry");
							if (switchEvent) {
								yield* discardAttemptPersistence();
								yield switchEvent;
								resetRetryStateAfterModelSwitch();
								continue;
							}
						}
						yield* outputContent.flush();
						yield* finishRequest(streamIdleTimeoutMessage);
						yield {
							type: "retryable_error",
							message: streamIdleTimeoutMessage,
							diagnostics: requestDiagnostics,
						};
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
						yield* outputContent.flush();
						yield* drainStartedEarlyToolResults();
						yield* finishRequest(message);
						yield {
							type: "retryable_error",
							message,
							code: CODEX_REBUILD_HISTORY_RETRY_CODE,
							bypassRetryLimit: true,
							diagnostics: requestDiagnostics,
						};
						return;
					}
					const msg = extractErrorMessage(err);
					// An upstream that goes quiet mid-stream used to leave no trace at all:
					// the turn simply stalled until some hop on the path dropped the
					// connection, and the only surviving record was a generic transport
					// error on the api_requests row. Log the shape of the silence itself so
					// a stall can be attributed without reconstructing it from timestamps.
					if (isStreamSilenceError(err)) {
						logger.warn("Upstream stream went silent", {
							narratorId: config.narratorId,
							provider: effectiveProvider,
							model: effectiveModel,
							requestId,
							message: msg,
							// Time since the request was dispatched; with `ttft` below this
							// separates "never spoke" from "spoke, then stopped".
							elapsedMs: requestStartTime ? Date.now() - requestStartTime : undefined,
							ttftMs: requestTtftMs,
							streamEvents: streamEventCount,
							contentlessEvents: contentlessEventCount,
							// Tool calls the model had already asked for when the stream died.
							// `startedToolCount` 0 with a non-zero `toolCount` means nothing had
							// begun executing, so no local work can explain the silence.
							toolCount: toolUses.length,
							startedToolCount: earlyExecMap.size,
							settledToolCount: settledResults.size,
						});
					}
					requestDiagnostics = normalizeApiRequestDiagnostics({
						...diagnosticsFromError(err),
						message: msg,
						provider: effectiveProvider,
						model: effectiveModel,
					});
					// Opaque upstream "malformed request body" rejection: capture the exact
					// request before any retry/classification path can discard it.
					if (isMalformedRequestBodyError(err)) {
						await captureMalformedRequest(msg);
						// Same reasoning as the stream-event path: replay a bounded number of times,
						// since this rejection is overwhelmingly an upstream hiccup. Placed before the
						// payment/availability checks because those cannot apply to this error, and
						// before the generic retry classification, which marks it non-retryable.
						if (canReplayMalformedRequest()) {
							if ((yield* runMalformedReplay(msg)) === "aborted") return;
							continue;
						}
					}
					const nugProvider = (settings.nugProviders ?? []).find(
						(p) => !p.disabled && (p.prefix === effectiveProvider || p.id === effectiveProvider),
					);
					const paymentRequired = nugProvider ? getPaymentRequiredErrorInfo(err) : null;
					if (paymentRequired) {
						yield* outputContent.flush();
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
					// Model temporarily unavailable at the NUG gateway because its whole
					// credential pool is disabled (recoverable exhaustion). Suspend the
					// turn and let the caller wait for recovery via the shared availability
					// poller, instead of retrying the full request (with its whole history)
					// over and over. Only for NUG providers.
					if (nugProvider && isModelUnavailableError(err)) {
						yield* outputContent.flush();
						yield* finishRequest(msg);
						// `effectiveModel` is `${prefix}:${channel:bareModel}`; strip the
						// provider prefix to recover the gateway model id (`channel:bareModel`)
						// used to match this model in `/v1/models`.
						const prefixToken = `${nugProvider.prefix}:`;
						const nugModelId = effectiveModel.startsWith(prefixToken)
							? effectiveModel.slice(prefixToken.length)
							: effectiveModel;
						yield {
							type: "model_unavailable",
							message: msg,
							provider: effectiveProvider,
							model: effectiveModel,
							providerId: nugProvider.id,
							providerPrefix: nugProvider.prefix ?? effectiveProvider,
							nugModelId,
							diagnostics: requestDiagnostics,
						};
						return;
					}
					// Kimi coding-plan allowance used up (403 "usage limit"). Same suspend-
					// and-replay contract as the NUG branch above, but the reset instant is
					// published, so the caller waits on the clock rather than on a poller.
					// Mirrors the invalidState branch earlier in this loop.
					{
						// Kimi coding-plan allowance used up (403 "usage limit"). Same
						// contract as the NUG branch above, but the reset instant is
						// published, so the caller waits on the clock rather than on a
						// poller — or, when the reset is beyond the wait budget, reports the
						// wall with that instant attached (`quotaResetAt` without `resumeAt`).
						// Mirrors the invalidState branch earlier in this loop.
						const kimiQuota = await resolveKimiQuotaWait(
							effectiveProvider,
							`${msg}\n${requestDiagnostics?.responseSnippet ?? ""}`,
						);
						if (kimiQuota.kind !== "none") {
							const { providerId, providerPrefix, resetAt } =
								kimiQuota.kind === "wait" ? kimiQuota.wait : kimiQuota.refusal;
							yield* outputContent.flush();
							yield* finishRequest(msg);
							yield {
								type: "model_unavailable",
								message: msg,
								provider: effectiveProvider,
								model: effectiveModel,
								providerId,
								providerPrefix,
								waitKind: "quota",
								resumeAt: kimiQuota.kind === "wait" ? kimiQuota.wait.resumeAt : undefined,
								quotaResetAt: resetAt,
								diagnostics: requestDiagnostics,
							};
							return;
						}
					}
					// Detect upstream API context length exceeded (HTTP 400)
					if (
						err &&
						typeof err === "object" &&
						"code" in err &&
						(err as { code: string }).code === "CONTEXT_LENGTH_EXCEEDED"
					) {
						// Persist partial content before signalling overflow
						yield* outputContent.flush();
						yield* finishRequest(msg);
						yield { type: "context_length_exceeded", message: msg };
						return;
					}
					// Detect context overflow errors from OpenAI/Codex-compatible providers.
					// Treat as context_length_exceeded so caller can prune/compact+retry.
					if (isContextWindowExceededError(err)) {
						yield* outputContent.flush();
						yield* finishRequest(msg);
						yield { type: "context_length_exceeded", message: msg };
						return;
					}
					// Resumable but nothing landed locally — replay the identical request
					// rather than failing the turn. See canReplayResumableInPlace and the
					// matching invalidState branch above.
					if (canReplayResumableInPlace(isResumableError(err))) {
						if (
							(getMaxChatRetries() === -1 || chatRetryCount < getMaxChatRetries()) &&
							!config.signal.aborted
						) {
							chatRetryCount++;
							lastRetryErrorMessage = msg;
							lastRetryDiagnostics = requestDiagnostics;
							const delayMs = Math.min(
								TRANSIENT_RETRY_BASE_MS * 2 ** (chatRetryCount - 1),
								backoffCeil,
							);
							logger.warn("Resumable stream interruption with no local output, replaying", {
								narratorId: config.narratorId,
								provider: effectiveProvider,
								model: effectiveModel,
								requestId,
								attempt: chatRetryCount,
								maxRetries: getMaxChatRetries(),
							});
							yield {
								type: "retrying",
								message: msg,
								attempt: chatRetryCount,
								maxRetries: getMaxChatRetries(),
								delayMs,
								diagnostics: requestDiagnostics,
							};
							yield* abandonAttemptForReplay(msg);
							await abortableSleep(delayMs, config.signal);
							if (config.signal.aborted) {
								yield { type: "error", message: "Aborted" };
								return;
							}
							continue; // retry provider.chat() with the identical request
						}
						// Replay budget spent (or a stateful provider that cannot replay):
						// fall through to the ordinary handling below.
					}
					// Resumable: a transient failure occurred after client-visible partial
					// output was already produced this attempt. See the matching invalidState
					// branch above for the full rationale and the per-strategy recovery.
					if (isResumableError(err) && hasAnyPersistableOutput()) {
						const strategy = classifyResumeStrategy();
						if (strategy === "tool_continuation") {
							logger.warn("Resumable stream interruption after a complete tool call", {
								narratorId: config.narratorId,
								provider: effectiveProvider,
								model: effectiveModel,
								requestId,
								toolCount: toolUses.length,
								startedToolCount: earlyExecMap.size,
							});
							yield {
								type: "resumable_recovered",
								strategy: "tool_continuation",
								message: msg,
								diagnostics: requestDiagnostics,
							};
							// Leave the retry loop and finish this turn through the normal
							// path so tools execute and their results reach the next turn.
							// `sawErrorEvent` stays unset on purpose (see the invalidState
							// branch above) so the turn is not cut short.
							break;
						}
						if (strategy === "truncated_tool_input") {
							// Cut off mid tool input: leave the retry loop so the orphaned-tool
							// detector can inject the skeleton-first reminder. Replaying the same
							// request would reproduce the same truncation.
							logger.warn("Resumable stream interruption mid tool input", {
								narratorId: config.narratorId,
								provider: effectiveProvider,
								model: effectiveModel,
								requestId,
								orphanedTools: orphanedToolInputNames(),
							});
							yield {
								type: "resumable_recovered",
								strategy: "truncated_tool_input",
								message: msg,
								diagnostics: requestDiagnostics,
							};
							break;
						}
						if (strategy === "reasoning_only_retry" && canReplayInPlace()) {
							if (
								(getMaxChatRetries() === -1 || chatRetryCount < getMaxChatRetries()) &&
								!config.signal.aborted
							) {
								chatRetryCount++;
								lastRetryErrorMessage = msg;
								lastRetryDiagnostics = requestDiagnostics;
								const delayMs = Math.min(
									TRANSIENT_RETRY_BASE_MS * 2 ** (chatRetryCount - 1),
									backoffCeil,
								);
								logger.warn("Resumable stream interruption with reasoning only, retrying", {
									narratorId: config.narratorId,
									provider: effectiveProvider,
									model: effectiveModel,
									requestId,
									attempt: chatRetryCount,
									maxRetries: getMaxChatRetries(),
								});
								yield* discardReasoningOnlyPartialOutput();
								yield {
									type: "retrying",
									message: msg,
									attempt: chatRetryCount,
									maxRetries: getMaxChatRetries(),
									delayMs,
									diagnostics: requestDiagnostics,
								};
								yield* abandonAttemptForReplay(msg);
								await abortableSleep(delayMs, config.signal);
								if (config.signal.aborted) {
									yield { type: "error", message: "Aborted" };
									return;
								}
								continue; // retry provider.chat() with the identical request
							}
							// Retry budget spent (or a stateful provider that cannot replay the
							// request): fall back to a textual continuation rather than failing.
						}
						yield* outputContent.flush();
						yield* finishRequest(msg);
						yield { type: "resumable_error", message: msg, diagnostics: requestDiagnostics };
						return;
					}
					// Detect transient/retryable API errors (e.g. MODEL_TEMPORARILY_UNAVAILABLE,
					// throttling, 429/529 overloaded)
					if (isRetryableError(err)) {
						// A transient fault can land AFTER the model already produced complete
						// tool calls (a 429/529 on the tail of the stream, a mid-turn socket
						// reset). Replaying then destroys those calls and their results while
						// sending a byte-identical request, so the model reproduces them and the
						// loop spins until the budget dies.
						if (hasIrreplaceableProgress()) {
							logger.warn("Retryable provider error after tool progress landed", {
								narratorId: config.narratorId,
								provider: effectiveProvider,
								model: effectiveModel,
								requestId,
								toolCount: toolUses.length,
								startedToolCount: earlyExecMap.size,
								settledToolCount: settledResults.size,
							});
							// Share normal settlement with the invalidState path, including calls
							// whose input completed but which were not eligible for eager execution.
							pendingResumableError = {
								type: "resumable_error",
								message: msg,
								diagnostics: requestDiagnostics,
							};
							break;
						}
						// In-loop retry for stateless providers
						// -1 means infinite retries (consistent with handleTransientError)
						if (
							(getMaxChatRetries() === -1 || chatRetryCount < getMaxChatRetries()) &&
							!config.signal.aborted
						) {
							chatRetryCount++;
							lastRetryErrorMessage = msg;
							lastRetryDiagnostics = requestDiagnostics;
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
								diagnostics: requestDiagnostics,
							};
							yield* abandonAttemptForReplay(msg);
							await abortableSleep(delayMs, config.signal);
							if (config.signal.aborted) {
								yield { type: "error", message: "Aborted" };
								return;
							}
							continue; // retry provider.chat()
						}
						if (await hasPendingRuntimeSettingsOverride()) {
							yield* finishRequest(msg);
							const switchEvent = await applyPendingRuntimeSettings("retry");
							if (switchEvent) {
								yield* discardAttemptPersistence();
								yield switchEvent;
								resetRetryStateAfterModelSwitch();
								continue;
							}
						}
						// Exhausted retries — persist partial content and signal caller
						yield* outputContent.flush();
						yield* finishRequest(msg);
						yield { type: "retryable_error", message: msg, diagnostics: requestDiagnostics };
						return;
					}
					// Non-retryable error — retain already-started side effects, but never
					// dispatch queued calls merely to finish a failed response.
					yield* drainStartedEarlyToolResults();
					yield* outputContent.flush();
					yield* finishRequest(msg);
					yield { type: "error", message: msg, diagnostics: requestDiagnostics };
					return;
				} finally {
					streamExecutionOpen = false;
					clearFirstTokenTimer();
					clearStreamIdleTimer();
					config.signal.removeEventListener("abort", onParentAbort);
					guidanceSignal?.removeEventListener("abort", onGuidanceAbort);
					startFirstTokenTimerForAttempt = undefined;
				}

				if (guidanceSignal?.aborted) {
					observeSoftStopForTurn();
					break;
				}
				if (firstTokenTimeoutTriggered) {
					requestDiagnostics = normalizeApiRequestDiagnostics({
						source: "agent",
						phase: "first_token",
						reason: "first_token_timeout",
						message: firstTokenTimeoutMessage,
						provider: effectiveProvider,
						model: effectiveModel,
					});
					if (
						(maxFirstTokenRetries === -1 || chatRetryCount < maxFirstTokenRetries) &&
						!config.signal.aborted
					) {
						chatRetryCount++;
						lastRetryErrorMessage = firstTokenTimeoutMessage;
						lastRetryDiagnostics = requestDiagnostics;
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
							diagnostics: requestDiagnostics,
						};
						yield* abandonAttemptForReplay(firstTokenTimeoutMessage);
						await abortableSleep(delayMs, config.signal);
						if (config.signal.aborted) {
							yield { type: "error", message: "Aborted" };
							return;
						}
						continue; // retry provider.chat()
					}
					if (await hasPendingRuntimeSettingsOverride()) {
						yield* finishRequest(firstTokenTimeoutMessage);
						const switchEvent = await applyPendingRuntimeSettings("retry");
						if (switchEvent) {
							yield* discardAttemptPersistence();
							yield switchEvent;
							resetRetryStateAfterModelSwitch();
							continue;
						}
					}
					yield* finishRequest(firstTokenTimeoutMessage);
					yield {
						type: "retryable_error",
						message: firstTokenTimeoutMessage,
						diagnostics: requestDiagnostics,
					};
					return;
				}

				if (streamIdleTimeoutTriggered) {
					requestDiagnostics = normalizeApiRequestDiagnostics({
						source: "agent",
						phase: "stream_idle",
						reason: "stream_idle_timeout",
						message: streamIdleTimeoutMessage,
						provider: effectiveProvider,
						model: effectiveModel,
					});
					if (
						(maxFirstTokenRetries === -1 || chatRetryCount < maxFirstTokenRetries) &&
						!config.signal.aborted
					) {
						chatRetryCount++;
						lastRetryErrorMessage = streamIdleTimeoutMessage;
						lastRetryDiagnostics = requestDiagnostics;
						const delayMs = Math.min(
							TRANSIENT_RETRY_BASE_MS * 2 ** (chatRetryCount - 1),
							backoffCeil,
						);
						yield {
							type: "retrying",
							message: streamIdleTimeoutMessage,
							attempt: chatRetryCount,
							maxRetries: maxFirstTokenRetries,
							delayMs,
							diagnostics: requestDiagnostics,
						};
						yield* abandonAttemptForReplay(streamIdleTimeoutMessage);
						await abortableSleep(delayMs, config.signal);
						if (config.signal.aborted) {
							yield { type: "error", message: "Aborted" };
							return;
						}
						continue; // retry provider.chat()
					}
					if (await hasPendingRuntimeSettingsOverride()) {
						yield* finishRequest(streamIdleTimeoutMessage);
						const switchEvent = await applyPendingRuntimeSettings("retry");
						if (switchEvent) {
							yield* discardAttemptPersistence();
							yield switchEvent;
							resetRetryStateAfterModelSwitch();
							continue;
						}
					}
					yield* outputContent.flush();
					yield* finishRequest(streamIdleTimeoutMessage);
					yield {
						type: "retryable_error",
						message: streamIdleTimeoutMessage,
						diagnostics: requestDiagnostics,
					};
					return;
				}

				// ── Mimo ellipsis retry ──
				// If a mimo model returned "..." as reasoning, discard and retry.
				//
				// Skipped once tool progress exists: the ellipsis reasoning is degenerate but a
				// completed tool call is not, and replaying would throw the call (and any result
				// it already produced) away. The turn then finishes normally instead.
				if (
					!config.reflectionLoop &&
					mimoEllipsisRetry &&
					completionLimitMessage == null &&
					canReplayInPlace()
				) {
					chatRetryCount++;
					const delayMs = Math.min(
						TRANSIENT_RETRY_BASE_MS * 2 ** (chatRetryCount - 1),
						backoffCeil,
					);
					yield {
						type: "retrying",
						message: "Mimo model returned ellipsis-only reasoning, retrying",
						attempt: chatRetryCount,
						maxRetries: getMaxChatRetries(),
						delayMs,
						diagnostics: requestDiagnostics,
					};
					yield* abandonAttemptForReplay("mimo ellipsis reasoning");
					await abortableSleep(delayMs, config.signal);
					if (config.signal.aborted) {
						yield { type: "error", message: "Aborted" };
						return;
					}
					continue; // retry provider.chat()
				}

				// Empty/reasoning-only model answers consume reflection decision turns too.
				// Do not inherit the primary loop's extra content-recovery requests or compact it.
				if (
					config.reflectionLoop &&
					requestStarted &&
					!sawErrorEvent &&
					!lastRetryErrorMessage &&
					completionLimitMessage == null &&
					toolUses.length === 0 &&
					!assistantText.trim()
				) {
					yield* finishRequest();
					if (turnIndex + 1 >= maxTurns) {
						yield { type: "done" };
						return;
					}
					provider.pushUserTurn(
						history,
						content,
						effectiveModel,
						isFirstTurn ? (initialToolResults ?? []) : pendingToolResults,
					);
					pendingToolResults = [];
					nextTurnContent = buildReflectionCorrectionPrompt(config);
					yield { type: "turn_complete", turnIndex };
					turnIndex++;
					continue turnLoop;
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
				//
				// `hasIrreplaceableProgress()` is checked as defence in depth, not because a
				// currently-reachable state needs it: within one attempt `toolUses` and
				// `settledResults` are cleared together at the top of the retry loop, so
				// `hasAnyPersistableOutput()` (which tests `toolUses`) already covers every
				// path that exists today. It is stated explicitly because this guard is the
				// one place that decides "replay the identical request", and the cost of the
				// two predicates drifting apart is the whole retry budget spent re-sending a
				// request whose tool results were thrown away. Keeping the strong condition
				// here means a future path that settles a result without leaving a `toolUses`
				// entry cannot silently reintroduce that bug.
				if (
					!sawErrorEvent &&
					completionLimitMessage == null &&
					!hasAnyPersistableOutput() &&
					!hasIrreplaceableProgress()
				) {
					// Evidence collected while consuming this attempt's stream. It turns the
					// single generic "empty response" message into a specific sub-reason, so
					// an upstream fault is no longer reported as a local misconfiguration.
					const emptySignals: EmptyResponseSignals = {
						streamEvents: streamEventCount,
						contentlessEvents: contentlessEventCount,
						stopReason: lastStopReason,
						receivedUsage,
						namelessToolUseIds: [...namelessToolUseIds],
					};
					const emptyKind = classifyEmptyResponse(emptySignals);
					const emptyEvidence = emptyResponseEvidence(emptySignals);
					const emptyResponseText = emptyResponseMessageFor(emptyKind, emptySignals);
					const buildEmptyDiagnostics = (message: string) =>
						normalizeApiRequestDiagnostics({
							source: "agent",
							phase: "response",
							reason: emptyKind,
							message,
							responseSnippet: emptyEvidence,
							provider: effectiveProvider,
							model: effectiveModel,
						});

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
						if (await hasPendingRuntimeSettingsOverride()) {
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
						requestDiagnostics = buildEmptyDiagnostics(
							`${effectiveProvider}: ${emptyResponseText}`,
						);
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
								diagnostics: lastRetryDiagnostics,
							};
							yield* abandonAttemptForReplay(lastRetryErrorMessage);
							await abortableSleep(delayMs, config.signal);
							if (config.signal.aborted) {
								yield { type: "error", message: "Aborted" };
								return;
							}
							continue; // retry provider.chat()
						}
						if (await hasPendingRuntimeSettingsOverride()) {
							yield* finishRequest(lastRetryErrorMessage);
							const switchEvent = await applyPendingRuntimeSettings("retry");
							if (switchEvent) {
								yield* discardAttemptPersistence();
								yield switchEvent;
								resetRetryStateAfterModelSwitch();
								continue;
							}
						}
						// Chat retries exhausted — surface the original error
						yield* finishRequest(lastRetryErrorMessage);
						yield {
							type: "retryable_error",
							message: lastRetryErrorMessage,
							diagnostics: lastRetryDiagnostics,
						};
						return;
					}

					// Genuine empty response (no prior error). Uses a dedicated counter,
					// separate from transient error retries.
					//
					// The budget depends on what the upstream actually did. When it reported
					// usage or a stop reason, the request demonstrably reached the model and
					// came back deliberately empty — replaying the identical bytes rarely
					// changes that (production logs show these failing the same way on every
					// attempt) while each replay pays the full prompt again. Kinds that
					// indicate a transport/protocol fault keep the full budget, because for
					// those a replay genuinely does tend to succeed.
					const maxEmptyRetries = maxEmptyResponseRetriesFor(emptyKind);
					emptyResponseRetries++;
					if (emptyResponseRetries <= maxEmptyRetries && !config.signal.aborted) {
						const delayMs = Math.min(
							TRANSIENT_RETRY_BASE_MS * 2 ** (emptyResponseRetries - 1),
							backoffCeil,
						);
						const message = `${effectiveProvider}: ${emptyResponseText}`;
						requestDiagnostics = buildEmptyDiagnostics(message);
						lastRetryDiagnostics = requestDiagnostics;
						logger.warn("Provider returned empty response, retrying", {
							narratorId: config.narratorId,
							provider: effectiveProvider,
							model: effectiveModel,
							requestId,
							attempt: emptyResponseRetries,
							maxRetries: maxEmptyRetries,
							emptyResponseKind: emptyKind,
							evidence: emptyEvidence,
						});
						yield {
							type: "retrying",
							message,
							attempt: emptyResponseRetries,
							maxRetries: maxEmptyRetries,
							delayMs,
							diagnostics: requestDiagnostics,
						};
						yield* abandonAttemptForReplay(message);
						await abortableSleep(delayMs, config.signal);
						if (config.signal.aborted) {
							yield { type: "error", message: "Aborted" };
							return;
						}
						continue; // retry provider.chat()
					}
					const emptyResponseMessage = `${effectiveProvider}: ${emptyResponseText}`;
					requestDiagnostics = buildEmptyDiagnostics(emptyResponseMessage);
					if (await hasPendingRuntimeSettingsOverride()) {
						yield* finishRequest(emptyResponseMessage);
						const switchEvent = await applyPendingRuntimeSettings("retry");
						if (switchEvent) {
							yield* discardAttemptPersistence();
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
						attempts: emptyResponseRetries,
						maxRetries: maxEmptyRetries,
						emptyResponseKind: emptyKind,
						evidence: emptyEvidence,
					});
					yield* finishRequest(emptyResponseMessage);
					yield {
						type: "invalid_state",
						reason: emptyKind,
						message: emptyResponseMessage,
						diagnostics: requestDiagnostics,
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
				//
				// A half-written tool input is deliberately counted as meaningful output
				// here. It is not a dead turn: the model committed to a tool call whose
				// arguments were cut off, which the orphaned-tool detector below turns
				// into the skeleton-first reminder. Treating it as reasoning-only would
				// discard that evidence and replay the identical request, reproducing the
				// same truncation until the retry budget is exhausted.
				const hasMeaningfulOutput =
					assistantText.trim().length > 0 ||
					toolUses.length > 0 ||
					orphanedToolInputNames().length > 0 ||
					!!collectCompletedWebSearches(webSearchAccum) ||
					!!collectCompletedImageGenerations(imageGenAccum);
				const hasReasoning = !!collectReasoningBlocks(reasoningBlockMap);
				if (
					completionLimitMessage == null &&
					!hasMeaningfulOutput &&
					hasReasoning &&
					// A tool that already ran makes this not a dead turn: discarding the
					// attempt would throw its result away and re-send the same request.
					canReplayInPlace()
				) {
					// This attempt is discarded in both the display and replay lanes.
					reasoningBlockMap.clear();
					outputContent.reset();
					redactedThinkingBlocks.length = 0;
					// Tell the frontend to discard the live streaming reasoning it is showing.
					yield { type: "stream_reset" };
					// The reasoning blocks were already persisted as they streamed, so the
					// in-memory clear above is not enough on its own — without this the
					// discarded thinking stays in the transcript and stacks up on every retry.
					yield* abandonAttemptForReplay(REASONING_ONLY_MESSAGE);
					if (config.signal.aborted) {
						yield { type: "error", message: "Aborted" };
						return;
					}

					// Explicit upstream occupancy wins, including zero. Otherwise prefer
					// positive measured usage, then the caller's last known occupancy.
					const callerContextUsagePercentage = config.getContextUsagePercentage?.();
					const contextUsagePercentage =
						upstreamContextPercent ??
						(requestContextPercent != null && requestContextPercent > 0
							? requestContextPercent
							: (callerContextUsagePercentage ?? requestContextPercent));
					let compactReplacement: AgentHistoryReplacement | null = null;
					if (
						!reasoningOnlyCompactAttempted &&
						contextUsagePercentage != null &&
						contextUsagePercentage > REASONING_ONLY_COMPACT_THRESHOLD &&
						config.onReasoningOnlyHighContext
					) {
						reasoningOnlyCompactAttempted = true;
						logger.warn("Provider returned only reasoning at high context usage", {
							narratorId: config.narratorId,
							provider: effectiveProvider,
							model: effectiveModel,
							requestId,
							contextUsagePercentage,
							threshold: REASONING_ONLY_COMPACT_THRESHOLD,
						});
						try {
							// The callback is intentionally awaited: retrying before compact has
							// finished would send the same oversized context again.
							compactReplacement = await config.onReasoningOnlyHighContext(
								contextUsagePercentage,
								config.signal,
							);
						} catch (err) {
							if (!config.signal.aborted) {
								logger.error("High-context reasoning-only recovery failed", {
									narratorId: config.narratorId,
									provider: effectiveProvider,
									model: effectiveModel,
									contextUsagePercentage,
									error: String(err),
								});
							}
						}
						if (compactReplacement) {
							applyHistoryReplacement(compactReplacement);
							logger.info("High-context reasoning-only recovery completed", {
								narratorId: config.narratorId,
								provider: effectiveProvider,
								model: effectiveModel,
								contextUsagePercentage,
							});
						}
					}

					if (config.signal.aborted) {
						yield { type: "error", message: "Aborted" };
						return;
					}

					// Shared retry ceiling with empty responses to avoid infinite loops.
					if (reasoningOnlyRetries >= MAX_EMPTY_RESPONSE_RETRIES) {
						if (await hasPendingRuntimeSettingsOverride()) {
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
						// Distinct from the empty-response kinds: content *did* arrive, it just
						// never contained an answer or a tool call. Reporting this as
						// `empty_response` sent users to check their API configuration for what
						// is actually a model-behaviour problem.
						yield {
							type: "invalid_state",
							reason: "reasoning_only_exhausted",
							message,
							diagnostics: normalizeApiRequestDiagnostics({
								source: "agent",
								phase: "response",
								reason: "reasoning_only_exhausted",
								message,
								responseSnippet: `retries=${reasoningOnlyRetries}`,
								provider: effectiveProvider,
								model: effectiveModel,
							}),
						};
						return;
					}
					reasoningOnlyRetries++;
					const delayMs = compactReplacement
						? 0
						: Math.min(TRANSIENT_RETRY_BASE_MS * 2 ** (reasoningOnlyRetries - 1), backoffCeil);
					logger.warn("Provider returned only reasoning, recovering", {
						narratorId: config.narratorId,
						provider: effectiveProvider,
						model: effectiveModel,
						requestId,
						attempt: reasoningOnlyRetries,
						maxRetries: MAX_EMPTY_RESPONSE_RETRIES,
						isFirstTurn,
						pendingToolResults: pendingToolResults.length,
						contextUsagePercentage,
						compacted: !!compactReplacement,
					});
					yield {
						type: "retrying",
						message: REASONING_ONLY_MESSAGE,
						attempt: reasoningOnlyRetries,
						maxRetries: MAX_EMPTY_RESPONSE_RETRIES,
						delayMs,
						diagnostics: requestDiagnostics,
					};
					if (delayMs > 0) {
						await abortableSleep(delayMs, config.signal);
					}
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

			// ── Finalize citations for this turn's assistant text ──
			// Runs once, here, so the SAME cleaned text feeds token estimation, the
			// `assistant_message` event, persistence and `pushAssistantTurn`. If the
			// raw text were used for the model history, the next turn would see the
			// internal markers and happily reproduce them.
			const finalizedText = outputContent.finalizeText();
			const turnCitations = finalizedText.citations;
			if (finalizedText.strippedMarkers) {
				logger.debug("Stripped provider-internal citation markers from assistant text", {
					narratorId: config.narratorId,
					provider: effectiveProvider,
					model: effectiveModel,
					requestId,
					citationCount: turnCitations.length,
				});
			}
			assistantText = finalizedText.text;

			// Tool chunks may complete out of order. Reconstruct the provider's native order
			// from identities recorded at tool start before persistence, execution grouping,
			// and model-facing tool results consume the completed calls.
			sortToolUsesByOutputOrder();

			// Reserve this turn's tool_use identifiers against the ones already in history,
			// and coerce them into the character set every channel accepts.
			// Providers that mint a single id for every call (e.g. "call_go_0") would otherwise
			// make the replayed history carry the same id in several assistant messages, which
			// the API rejects with 400 "duplicate tool_use id"; ids like "Bash:0" are accepted
			// by Anthropic but rejected outright by NUG's strict gateway, which would break the
			// session the moment it is switched there. Only the model-facing history is
			// rewritten — the tool_use objects below keep the provider's original id, so
			// persistence, the UI, and permission/approval flows are unaffected.
			const turnToolUseIdRemap = reserveUniqueToolUseIds(toolUses, historyToolUseIds);
			if (turnToolUseIdRemap.size > 0) {
				logger.warn("Rewrote unusable tool_use IDs for model history", {
					narratorId: config.narratorId,
					provider: effectiveProvider,
					model: effectiveModel,
					requestId,
					renamedCount: turnToolUseIdRemap.size,
					originalIds: [...turnToolUseIdRemap.keys()].slice(0, 10),
				});
			}
			/** Tool uses with history-safe ids, for provider.pushAssistantTurn. */
			const toHistoryToolUses = (list: AgentToolUse[]): AgentToolUse[] =>
				applyToolUseIdRemap(list, turnToolUseIdRemap);

			// No fabricated billing counters: occupancy estimates live only in contextSnapshot.

			// Emit API request end event, retaining the failed stream's diagnostics.
			yield* finishRequest(pendingResumableError?.message);

			// Reset retry counters after a successful turn so the next turn's
			// backoff starts from the base delay instead of the ceiling.
			// reasoningOnlyRetries lives at function scope (so the ceiling is shared
			// across the turn boundary while recovering a single dead turn via a
			// "continue" nudge); reset it here so non-consecutive dead turns spread
			// across a long session don't accumulate toward the fatal ceiling.
			chatRetryCount = 0;
			reasoningOnlyRetries = 0;
			reasoningOnlyCompactAttempted = false;

			// The input-only fallback is emitted by finishRequest, before its matching end event.

			// Detect orphaned tool uses — tool calls whose streaming input was cut off
			// before receiving a stop signal (typically due to API max_tokens truncation).
			// These are silently dropped by the accumulator, so we must detect and handle them.
			const orphanedToolNames = orphanedToolInputNames();
			const hasOrphanedToolUses = orphanedToolNames.length > 0;
			if (hasOrphanedToolUses) {
				// The cards published while the arguments were streaming will never reach
				// tool_result (these ids execute nothing), so retire them explicitly —
				// otherwise each truncated call leaves a ghost tool running forever.
				yield* retractStreamingToolCards();
				toolUseAccum.clear();
			}

			// Yield accumulated content before assistant_message so partial-block
			// persistence is finalized for both normal and truncated turns.
			yield* outputContent.flush();

			// Drain settled tool results before assistant_message so the DB
			// has correct tool call statuses when the message is broadcast.
			for (const tu of toolUses) {
				const sr = settledResults.get(tu.toolUseId);
				if (!sr || yieldedToolResults.has(tu.toolUseId)) continue;
				yieldedToolResults.add(tu.toolUseId);
				if (sr.broken) brokenToolUseIds.add(tu.toolUseId);
				if (sr.updatedInput) tu.input = sr.updatedInput;
				const brokenOverride = sr.broken
					? sanitizeBrokenInput(tu.name, tu.input, locale)
					: undefined;
				await processToolResultInjections(tu, sr);
				const baseOutput = sr.broken ? getToolMessage("brokenToolCallResult", locale) : sr.output;
				yield {
					type: "tool_result",
					toolCallBinding: executionBindings.get(tu),
					toolUseId: tu.toolUseId,
					toolName: tu.name,
					input: sr.updatedInput ?? tu.input,
					output: baseOutput,
					isError: sr.isError ?? false,
					durationMs: sr.durationMs,
					permissionStartedAt: sr.permissionStartedAt,
					executionStartedAt: sr.executionStartedAt,
					completedAt: sr.completedAt,
					brokenInputOverride: brokenOverride,
					updatedInput: brokenOverride ?? sr.updatedInput,
					metadata: sr.metadata,
				};
				if (sr.fatal) {
					yield { type: "error", message: sr.output };
					return;
				}
			}

			// A request cancelled before producing content must not persist an empty
			// assistant turn (some providers reject it when history is replayed).
			if (
				guidanceSignal?.aborted &&
				!assistantText &&
				toolUses.length === 0 &&
				!collectReasoningBlocks(reasoningBlockMap) &&
				!collectCompletedWebSearches(webSearchAccum) &&
				!collectCompletedImageGenerations(imageGenAccum)
			) {
				responseActivity.release();
				provider.pushUserTurn(
					history,
					isFirstTurn ? userText : content,
					effectiveModel,
					isFirstTurn ? (initialToolResults ?? []) : pendingToolResults,
					isFirstTurn ? images : undefined,
				);
				yield { type: "turn_complete", turnIndex };
				return;
			}

			// Yield the complete assistant message on every successful turn. Event consumers
			// rely on this to finalize persistence, broadcast the message, run hooks, and update titles.
			yield {
				type: "assistant_message",
				onToolPersisted: (toolUseId, binding) => {
					const tu = toolUses.find((tool) => tool.toolUseId === toolUseId);
					if (tu) bindExecution(tu, binding);
				},
				text: assistantText,
				toolUses,
				messageId,
				credentialId,
				...(turnCitations.length > 0 ? { citations: turnCitations } : {}),
			};
			// The provider response is now complete and every produced tool has a stable row.
			// Tool execution may remain paused behind phase two without holding the response fence.
			responseActivity.release();

			if (guidanceSignal?.aborted) {
				observeSoftStopForTurn();
				yield* drainStartedEarlyToolResults();
				if (config.signal.aborted) {
					yield { type: "error", message: "Aborted" };
					return;
				}
				// Still-running detached calls retain their real pending rows. Do not fabricate
				// skipped results or replay their incomplete pairs into model-facing history.
				const guidanceTools = toolUses.filter((tu) => !detachedToolResults.has(tu.toolUseId));
				const guidanceResults: unknown[] = [];
				for (const tu of guidanceTools) {
					const result = settledResults.get(tu.toolUseId) ?? {
						output: getToolMessage("skippedForSoftStop", locale),
						isError: true,
						durationMs: 0,
						completedAt: Date.now(),
						metadata: { skippedForSoftStop: true },
					};
					if (!yieldedToolResults.has(tu.toolUseId)) {
						yieldedToolResults.add(tu.toolUseId);
						yield earlyToolResultEvent(tu, result);
					}
					guidanceResults.push(
						provider.formatToolResult(
							turnToolUseIdRemap.get(tu.toolUseId) ?? tu.toolUseId,
							result.output,
							result.isError ?? false,
							result.images,
							tu.name,
						),
					);
				}
				provider.pushUserTurn(
					history,
					isFirstTurn ? userText : content,
					effectiveModel,
					isFirstTurn ? (initialToolResults ?? []) : pendingToolResults,
					isFirstTurn ? images : undefined,
				);
				if (
					assistantText ||
					guidanceTools.length > 0 ||
					collectReasoningBlocks(reasoningBlockMap)
				) {
					provider.pushAssistantTurn(
						history,
						assistantText,
						toHistoryToolUses(guidanceTools),
						collectReasoningBlocks(reasoningBlockMap),
						collectCompletedWebSearches(webSearchAccum),
						messageId,
						collectCompletedImageGenerations(imageGenAccum),
						textOutputIndex,
						redactedThinkingBlocks,
						orderedAssistantContent(toHistoryToolUses(guidanceTools)),
					);
				}
				if (guidanceResults.length > 0)
					provider.pushUserTurn(history, "", effectiveModel, guidanceResults);
				yield { type: "turn_complete", turnIndex };
				return;
			}

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
						orderedAssistantContent(toHistoryToolUses(toolUses)),
					);
					yield { type: "turn_complete", turnIndex };
					turnIndex++;
					continue;
				}
			}

			// A prose-only reflection gets one internal correction, never instructions
			// addressed to the main assistant. Keep valid danger fallback tags terminal.
			if (
				toolUses.length === 0 &&
				config.reflectionLoop &&
				turnIndex + 1 < maxTurns &&
				!(
					config.reflectionLoop.context.kind === "dangerReflection" &&
					config.reflectionLoop.context.purpose !== "permissionRuleRequest" &&
					parseDangerReflectionTextFallback(assistantText)
				)
			) {
				provider.pushUserTurn(
					history,
					isFirstTurn ? userText : content,
					effectiveModel,
					isFirstTurn ? (initialToolResults ?? []) : pendingToolResults,
				);
				provider.pushAssistantTurn(history, assistantText, []);
				pendingToolResults = [];
				nextTurnContent = buildReflectionCorrectionPrompt(config);
				yield { type: "turn_complete", turnIndex };
				turnIndex++;
				continue;
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

			// The current input now lives in history; pending permissions must not
			// append it a second time when they resolve after stream completion.
			getPermissionHistory = () => history;

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

			// Preserve provider order while grouping consecutive parallel-safe calls.
			// The same grouping function is used by planned-update recovery.
			const groups = groupToolExecutions(toolUses);

			let toolIndex = 0;
			// Tracks cumulative execution time of preceding serial tools in this turn,
			// used to subtract wait time when computing display duration for fast tools.
			let prevToolsExecMs = 0;
			for (const group of groups) {
				if (config.signal.aborted) {
					await Promise.resolve();
					yield* drainEarlyToolResultsAfterAbort();
					yield { type: "error", message: "Aborted" };
					return;
				}

				if (group.length === 1) {
					// Serial execution (single tool)
					const tu = group[0];
					if (!streamReadyTools.has(tu.toolUseId)) {
						yield {
							type: "tool_call",
							toolUseId: tu.toolUseId,
							toolName: tu.name,
							input: tu.input,
							streamStartedAt: tu.streamStartedAt,
							streamCompletedAt: tu.streamCompletedAt,
						};
						streamReadyTools.add(tu.toolUseId);
					}
					if (config.signal.aborted) {
						yield* drainEarlyToolResultsAfterAbort();
						yield { type: "error", message: "Aborted" };
						return;
					}
					// settleToolExecutionResult converts a genuine rejection into a formal
					// isError ToolExecResult so a throwing serial tool never aborts the loop.
					const result = await waitForToolOrAbort(startToolExecution(tu));
					if (!result) {
						yield* drainEarlyToolResultsAfterAbort();
						if (config.signal.aborted) yield { type: "error", message: "Aborted" };
						else {
							observeSoftStopForTurn();
							yield { type: "turn_complete", turnIndex };
						}
						return;
					}
					if (result.broken) brokenToolUseIds.add(tu.toolUseId);
					// When the permission handler redirected the input (e.g. the plan file),
					// update the in-memory tool_use so pushAssistantTurn writes the correct
					// input into history — otherwise the model sees the original (wrong) path.
					if (result.updatedInput) tu.input = result.updatedInput;
					await processToolResultInjections(tu, result);
					const isLastTool = toolIndex === toolUses.length - 1;
					// The turn nudge is still appended inline: it is about THIS being the last
					// tool of a nearly-exhausted turn, so it has to travel with that result
					// rather than wait for a boundary the loop may not reach.
					const outputForModel =
						isLastTool && shouldNudge ? result.output + nudgeText : result.output;

					pendingToolResults.push(
						provider.formatToolResult(
							tu.toolUseId,
							outputForModel,
							result.isError ?? false,
							result.images,
							tu.name,
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

						yieldedToolResults.add(tu.toolUseId);
						yield {
							type: "tool_result",
							toolCallBinding: executionBindings.get(tu),
							toolUseId: tu.toolUseId,
							toolName: tu.name,
							input: result.updatedInput ?? tu.input,
							output: result.broken
								? getToolMessage("brokenToolCallResult", locale)
								: result.output,
							isError: result.isError ?? false,
							durationMs,
							permissionStartedAt: result.permissionStartedAt,
							executionStartedAt: result.executionStartedAt,
							completedAt: result.completedAt,
							brokenInputOverride,
							updatedInput: brokenInputOverride ?? result.updatedInput,
							metadata:
								durationMs !== result.durationMs
									? { ...result.metadata, execDurationMs: result.durationMs }
									: result.metadata,
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
						if (config.signal.aborted) break;
						if (!streamReadyTools.has(tu.toolUseId) && !yieldedToolResults.has(tu.toolUseId)) {
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
					// individual tool cards immediately. settleToolExecutionResult ensures a
					// genuine rejection from one parallel tool becomes a formal isError result
					// instead of rejecting the Promise.race — the siblings keep yielding and
					// persisting, and the model still gets a tool_result in the original order.
					if (config.signal.aborted) {
						yield* drainEarlyToolResultsAfterAbort();
						yield { type: "error", message: "Aborted" };
						return;
					}
					const execEntries: Array<{ tu: AgentToolUse; promise: Promise<ToolExecResult> }> = [];
					for (const tu of group) {
						if (config.signal.aborted) break;
						execEntries.push({ tu, promise: startToolExecution(tu) });
					}

					// Wrap each promise to carry its index so we know which resolved
					const indexed = execEntries.map((e, i) => e.promise.then((result) => ({ i, result })));

					const settled = new Array<ToolExecResult | undefined>(group.length);
					const formattedResults = new Array<unknown>(group.length);
					const groupStartToolIndex = toolIndex;
					let remaining = new Set(indexed);
					let hasFatal = false;
					let maxParallelMs = 0;

					while (remaining.size > 0) {
						const winner = await waitForToolOrAbort(Promise.race(remaining));
						if (!winner) {
							yield* drainEarlyToolResultsAfterAbort();
							if (config.signal.aborted) yield { type: "error", message: "Aborted" };
							else {
								observeSoftStopForTurn();
								yield { type: "turn_complete", turnIndex };
							}
							return;
						}
						const { i, result } = winner;
						settled[i] = result;

						// Remove the settled promise from the race set
						remaining = new Set([...remaining].filter((p) => p !== indexed[i]));

						const tu = group[i];
						const effectiveResult = result;
						if (effectiveResult.broken) brokenToolUseIds.add(tu.toolUseId);
						if (effectiveResult.updatedInput) tu.input = effectiveResult.updatedInput;
						await processToolResultInjections(tu, effectiveResult);

						// Persist and broadcast every completed result immediately in completion order.
						// Model-facing formatting still happens below in the original call order.
						if (!yieldedToolResults.has(tu.toolUseId)) {
							// Mark before yielding. The consumer may abort while handling this
							// event; an abort drain at the next group boundary must not replay
							// a result that was already delivered to persistence/UI.
							yieldedToolResults.add(tu.toolUseId);
							const brokenInputOverride = effectiveResult.broken
								? sanitizeBrokenInput(tu.name, tu.input, locale)
								: undefined;

							yield {
								type: "tool_result",
								toolCallBinding: executionBindings.get(tu),
								toolUseId: tu.toolUseId,
								toolName: tu.name,
								input: effectiveResult.updatedInput ?? tu.input,
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
							};
						}
						if (effectiveResult.durationMs > maxParallelMs)
							maxParallelMs = effectiveResult.durationMs;

						if (effectiveResult.fatal) hasFatal = true;
					}

					for (let i = 0; i < group.length; i++) {
						const tu = group[i];
						const effectiveResult = settled[i];
						if (!effectiveResult) continue;
						const isLastTool = groupStartToolIndex + i === toolUses.length - 1;
						const outputForModel =
							isLastTool && shouldNudge
								? effectiveResult.output + nudgeText
								: effectiveResult.output;
						formattedResults[i] = provider.formatToolResult(
							tu.toolUseId,
							outputForModel,
							effectiveResult.isError ?? false,
							effectiveResult.images,
							tu.name,
						);
					}

					pendingToolResults.push(...formattedResults);
					toolIndex += group.length;
					prevToolsExecMs += maxParallelMs;

					if (hasFatal) {
						const fatalResult = settled.find((r) => r?.fatal);
						const fatalMsg = fatalResult?.output ?? "Fatal tool error";
						yield { type: "error", message: fatalMsg };
						return;
					}
				}

				// Check after every serial tool and complete parallel-safe group. Once a soft
				// stop is observed, never start another tool: only await promises that were
				// already registered in earlyExecMap and mark every other remaining call skipped.
				if (observeSoftStopForTurn()) {
					const skippedOutput = getToolMessage("skippedForSoftStop", locale);
					let fatalOutput: string | undefined;
					for (const remainingTool of toolUses.slice(toolIndex)) {
						const earlyPromise = earlyExecMap.get(remainingTool.toolUseId);
						if (!earlyPromise) {
							pendingToolResults.push(
								provider.formatToolResult(
									remainingTool.toolUseId,
									skippedOutput,
									true,
									undefined,
									remainingTool.name,
								),
							);
							if (!yieldedToolResults.has(remainingTool.toolUseId)) {
								yieldedToolResults.add(remainingTool.toolUseId);
								yield {
									type: "tool_result",
									toolCallBinding: executionBindings.get(remainingTool),
									toolUseId: remainingTool.toolUseId,
									toolName: remainingTool.name,
									input: remainingTool.input,
									output: skippedOutput,
									isError: true,
									durationMs: 0,
									completedAt: Date.now(),
									metadata: { skippedForSoftStop: true },
								};
							}
							continue;
						}

						const result = await waitForToolOrAbort(earlyPromise);
						if (!result) {
							yield* drainEarlyToolResultsAfterAbort();
							if (config.signal.aborted) yield { type: "error", message: "Aborted" };
							else {
								observeSoftStopForTurn();
								yield { type: "turn_complete", turnIndex };
							}
							return;
						}
						if (result.broken) brokenToolUseIds.add(remainingTool.toolUseId);
						if (result.updatedInput) remainingTool.input = result.updatedInput;
						await processToolResultInjections(remainingTool, result);
						pendingToolResults.push(
							provider.formatToolResult(
								remainingTool.toolUseId,
								result.output,
								result.isError ?? false,
								result.images,
								remainingTool.name,
							),
						);

						if (!yieldedToolResults.has(remainingTool.toolUseId)) {
							yieldedToolResults.add(remainingTool.toolUseId);
							const brokenInputOverride = result.broken
								? sanitizeBrokenInput(remainingTool.name, remainingTool.input, locale)
								: undefined;
							yield {
								type: "tool_result",
								toolCallBinding: executionBindings.get(remainingTool),
								toolUseId: remainingTool.toolUseId,
								toolName: remainingTool.name,
								input: result.updatedInput ?? remainingTool.input,
								output: result.broken
									? getToolMessage("brokenToolCallResult", locale)
									: result.output,
								isError: result.isError ?? false,
								durationMs: result.durationMs,
								permissionStartedAt: result.permissionStartedAt,
								executionStartedAt: result.executionStartedAt,
								completedAt: result.completedAt,
								brokenInputOverride,
								updatedInput: brokenInputOverride ?? result.updatedInput,
								metadata: result.metadata,
							};
						}
						if (result.fatal && !fatalOutput) fatalOutput = result.output;
					}

					if (fatalOutput) {
						yield { type: "error", message: fatalOutput };
						return;
					}
					provider.pushAssistantTurn(
						history,
						assistantText,
						toHistoryToolUses(toolUses),
						collectReasoningBlocks(reasoningBlockMap),
						collectCompletedWebSearches(webSearchAccum),
						messageId,
						collectCompletedImageGenerations(imageGenAccum),
						textOutputIndex,
						redactedThinkingBlocks,
						orderedAssistantContent(toHistoryToolUses(toolUses)),
					);
					yield { type: "turn_complete", turnIndex };
					return;
				}
			}

			// Strip broken tool calls from the history sent to the model.
			// The UI already has the full picture (tool_result events were yielded above),
			// but the model should not see the broken tool_use + tool_result pair —
			// they waste context and cause retry loops.
			if (brokenToolUseIds.size > 0) {
				const cleanToolUses = toolUses.filter((tu) => !brokenToolUseIds.has(tu.toolUseId));
				// Broken calls are filtered by the ORIGINAL ids: pendingToolResults were
				// formatted from tu.toolUseId and are only renamed further below.
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
					toHistoryToolUses(cleanToolUses),
					collectReasoningBlocks(reasoningBlockMap),
					collectCompletedWebSearches(webSearchAccum),
					messageId,
					collectCompletedImageGenerations(imageGenAccum),
					textOutputIndex,
					redactedThinkingBlocks,
					orderedAssistantContent(toHistoryToolUses(cleanToolUses)),
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
					toHistoryToolUses(toolUses),
					collectReasoningBlocks(reasoningBlockMap),
					collectCompletedWebSearches(webSearchAccum),
					messageId,
					collectCompletedImageGenerations(imageGenAccum),
					textOutputIndex,
					redactedThinkingBlocks,
					orderedAssistantContent(toHistoryToolUses(toolUses)),
				);
			}

			// The assistant turn now carries the renamed ids, so the paired tool results
			// sent with the next request must be renamed too — otherwise the API sees a
			// tool_use with no matching result (and an orphaned result for the old id).
			remapToolResultIds(pendingToolResults, turnToolUseIdRemap);

			// Producers that persist their own message row contribute text only — see
			// `collectAfterToolsInjectionText` on why nothing is yielded for them.
			// Loop-raised reminders are flushed first so they read in the order they were
			// raised, before anything the host drained at this same boundary.
			for (const injectionText of [
				await flushLoopInjections(),
				await collectAfterToolsInjectionText(),
			]) {
				if (!injectionText) continue;
				nextTurnContent = nextTurnContent
					? `${nextTurnContent}\n\n${injectionText}`
					: injectionText;
			}

			// Close the small race between the final group boundary and the next provider
			// request: direct user feedback may arrive while after-tools injections are drained.
			if (observeSoftStopForTurn()) {
				yield { type: "turn_complete", turnIndex };
				return;
			}

			if (pendingResumableError) {
				if (config.signal.aborted) {
					yield { type: "error", message: "Aborted" };
				} else {
					yield pendingResumableError;
				}
				return;
			}

			yield { type: "turn_complete", turnIndex };
			turnIndex++;
		} finally {
			responseActivity.release();
		}
	}

	if (searchScope) {
		yield { type: "error", message: new SearchExecutionBudgetExceededError().message };
	}
	yield { type: "max_turns_exceeded", maxTurns };
}
