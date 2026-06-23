import type { QueryClient } from "@tanstack/react-query";
import type { SideCarRecord, ToolCallRecord } from "../../lib/api";
import { upsertStreamingToolBlock } from "./message-tree-utils";
import type {
	ContentBlock,
	MessagesQueryData,
	NarratorMsg,
	PendingPermission,
} from "./narrator-panel-types";
import { STREAMING_CHUNKS_MSG_ID } from "./narrator-panel-types";
import type { ToolCallData } from "./ToolCallCard";

export type ReflectionKind =
	| "danger_reflection"
	| "plan_reflection"
	| "goal_reflection"
	| "question_reflection";
export type ReflectionStatus = "running" | "awaiting_user" | "confirmed" | "cancelled" | "aborted";

export interface ReflectionSuggestion {
	kind: ReflectionKind;
	status: ReflectionStatus;
	reason?: string;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic suggestion payload
	danger?: any;
	activeGoal?: unknown;
	nextSteps?: string;
	requestId?: string;
}

const REFLECTION_KINDS = new Set<ReflectionKind>([
	"danger_reflection",
	"plan_reflection",
	"goal_reflection",
	"question_reflection",
]);
const ACTIVE_REFLECTION_STATUSES = new Set<ReflectionStatus>(["running", "awaiting_user"]);

export function getReflectionSuggestion(
	suggestions: unknown[] | null | undefined,
): ReflectionSuggestion | null {
	if (!Array.isArray(suggestions)) return null;
	for (const suggestion of suggestions) {
		if (!suggestion || typeof suggestion !== "object") continue;
		const record = suggestion as {
			type?: unknown;
			status?: unknown;
			reason?: unknown;
			danger?: unknown;
			activeGoal?: unknown;
			nextSteps?: unknown;
			requestId?: unknown;
		};
		const kind = String(record.type ?? "");
		if (!REFLECTION_KINDS.has(kind as ReflectionKind)) continue;
		const rawStatus = typeof record.status === "string" ? record.status : "running";
		const status = ACTIVE_REFLECTION_STATUSES.has(rawStatus as ReflectionStatus)
			? (rawStatus as ReflectionStatus)
			: rawStatus === "allow"
				? "confirmed"
				: rawStatus === "deny"
					? "cancelled"
					: rawStatus === "confirmed" || rawStatus === "cancelled" || rawStatus === "aborted"
						? (rawStatus as ReflectionStatus)
						: "running";
		return {
			kind: kind as ReflectionKind,
			status,
			reason: typeof record.reason === "string" ? record.reason : undefined,
			danger: record.danger,
			activeGoal: record.activeGoal,
			nextSteps: typeof record.nextSteps === "string" ? record.nextSteps : undefined,
			requestId: typeof record.requestId === "string" ? record.requestId : undefined,
		};
	}
	return null;
}

export function getPermissionReflectionSuggestion(value: {
	suggestions?: unknown[] | null;
	permissionSuggestions?: unknown[] | null;
}): ReflectionSuggestion | null {
	return getReflectionSuggestion(value.suggestions ?? value.permissionSuggestions);
}

export function isReflectionPermissionLike(value: {
	suggestions?: unknown[] | null;
	permissionSuggestions?: unknown[] | null;
}): boolean {
	return getPermissionReflectionSuggestion(value) !== null;
}

export function isActiveReflectionPermissionLike(value: {
	suggestions?: unknown[] | null;
	permissionSuggestions?: unknown[] | null;
}): boolean {
	const reflection = getPermissionReflectionSuggestion(value);
	return reflection ? ACTIVE_REFLECTION_STATUSES.has(reflection.status) : false;
}

// Re-export functions that moved to message-segments.ts for backward compatibility
export {
	filterChildrenByToolUse,
	hasToolUse,
	isToolOnlyMessage,
	resolveAllToolCallsFromMsg,
} from "./message-segments";

/** Resolve a PendingPermission from a tool call's data or WS state fallback. */
export function resolvePendingPerm(
	tc: ToolCallData,
	wsPerm: PendingPermission | null | undefined,
	wsPermsMap?: Map<string, PendingPermission>,
): PendingPermission | null {
	// Prefer WS-sourced permissions — they carry the full (untruncated) inputJson.
	// The message-list API truncates large inputJson, so building from tc.inputJson
	// would lose data (e.g. ExitPlanMode plan text).
	let perm: PendingPermission | null = null;
	if (wsPermsMap && tc.toolUseId) {
		const fromMap = wsPermsMap.get(tc.toolUseId);
		if (fromMap) perm = fromMap;
	}
	if (!perm && wsPerm && tc.toolUseId && tc.toolUseId === wsPerm.toolUseId) {
		perm = wsPerm;
	}
	// Fallback: build from the tool call record itself (status-driven path,
	// e.g. page refresh before WS reconnects or getPendingPermissions resolves).
	// Reflection gates also store a pending tool-call row while their internal
	// loop decides. They are actionable only while still running or awaiting user;
	// after they resolve, historical notices must not keep approval controls alive.
	if (
		!perm &&
		tc.status === "pending" &&
		tc.toolUseId &&
		(!isReflectionPermissionLike(tc) || isActiveReflectionPermissionLike(tc))
	) {
		perm = {
			id: tc.id ?? tc.toolUseId,
			toolName: tc.toolName,
			toolUseId: tc.toolUseId,
			inputJson: tc.inputJson,
			decisionReason: tc.permissionDecisionReason ?? undefined,
			suggestions: tc.permissionSuggestions ?? undefined,
		};
	}
	return perm;
}

export function revokeContentBlockPreviewUrls(
	blocks: Array<{ previewUrl?: unknown }> | null | undefined,
): void {
	if (!Array.isArray(blocks)) return;
	for (const block of blocks) {
		if (typeof block?.previewUrl === "string") {
			URL.revokeObjectURL(block.previewUrl);
		}
	}
}

const STREAMING_TEXT_PREVIEW_MAX_CHARS = 120_000;

/**
 * Append a streaming text delta to an accumulated preview, capping the total
 * length so a runaway stream cannot grow an unbounded string in memory (keeps
 * the most recent tail). Shared by both the legacy panel WS path and the chunk
 * data layer so they stay byte-for-byte identical.
 */
export function appendStreamingTextPreview(current: string, delta: string): string {
	const next = current + delta;
	if (next.length <= STREAMING_TEXT_PREVIEW_MAX_CHARS) return next;
	return next.slice(-STREAMING_TEXT_PREVIEW_MAX_CHARS);
}

// --- Streaming tool output / field preview bounds ------------------------------
// Shared by the legacy panel WS path and the chunk data layer so the live
// (untruncated) tool output / streaming-field previews stay byte-for-byte
// identical between the two list implementations.

export const STREAMING_TOOL_OUTPUT_PREVIEW_MAX_CHARS = 16_000;
export const STREAMING_TOOL_FIELD_PREVIEW_MAX_CHARS = 16_000;

interface TruncatedToolOutput {
	_truncated: true;
	preview: string;
	fullLength: number;
}

function isTruncatedToolOutput(value: unknown): value is TruncatedToolOutput {
	return (
		!!value &&
		typeof value === "object" &&
		(value as { _truncated?: unknown })._truncated === true &&
		typeof (value as { preview?: unknown }).preview === "string" &&
		typeof (value as { fullLength?: unknown }).fullLength === "number"
	);
}

/**
 * When a tool completes with a truncated output payload but we streamed the
 * complete response live, promote the streamed string into the persisted cache
 * instead of replacing it with the (much shorter) final 2KB preview.
 */
export function preserveCompleteStreamedOutput(
	completedOutput: unknown,
	streamedOutput?: string,
): { output: unknown; preserved: boolean } {
	if (!isTruncatedToolOutput(completedOutput) || typeof streamedOutput !== "string") {
		return { output: completedOutput, preserved: false };
	}
	if (streamedOutput.length < completedOutput.fullLength) {
		return { output: completedOutput, preserved: false };
	}
	return { output: streamedOutput.slice(0, completedOutput.fullLength), preserved: true };
}

/** Keep only the trailing window of a streamed tool output preview. */
export function getToolOutputPreview(output: string): string {
	if (output.length <= STREAMING_TOOL_OUTPUT_PREVIEW_MAX_CHARS) return output;
	return output.slice(-STREAMING_TOOL_OUTPUT_PREVIEW_MAX_CHARS);
}

/** Keep only the trailing window of a streamed tool field preview. */
export function getStreamingFieldPreview(value: string): string {
	if (value.length <= STREAMING_TOOL_FIELD_PREVIEW_MAX_CHARS) return value;
	return value.slice(-STREAMING_TOOL_FIELD_PREVIEW_MAX_CHARS);
}

/**
 * Append user-targeted side-car records to the latest assistant message (depth
 * first, deepest/last first) under the matching parentToolUseId scope. Returns
 * `{ changed: false }` when no assistant message matched (caller keeps refs).
 */
export function appendSideCarsToLatestAssistant(
	messages: NarratorMsg[],
	sideCars: SideCarRecord[],
	parentToolUseId?: string,
): { messages: NarratorMsg[]; changed: boolean } {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.children?.length) {
			const childResult = appendSideCarsToLatestAssistant(msg.children, sideCars, parentToolUseId);
			if (childResult.changed) {
				const updated = [...messages];
				updated[i] = { ...msg, children: childResult.messages };
				return { messages: updated, changed: true };
			}
		}
		const matchesParent = parentToolUseId
			? msg.parentToolUseId === parentToolUseId
			: !msg.parentToolUseId;
		if (msg.role === "assistant" && matchesParent) {
			const updated = [...messages];
			updated[i] = { ...msg, sideCars: mergeSideCarLists(sideCars, msg.sideCars) };
			return { messages: updated, changed: true };
		}
	}
	return { messages, changed: false };
}

/**
 * A top-level streaming-tool chunk accumulator entry. While a tool is streaming
 * its input we render a shimmer indicator; once promoted (`_started`) we render
 * a real tool-call card with the resolved input/status/output.
 */
export interface TopLevelStreamingChunk {
	toolUseId: string;
	toolName: string;
	inputCharsTotal: number;
	extractedFilePath?: string;
	contentCharsReceived?: number;
	extractedFields?: Record<string, string>;
	metadata?: Record<string, unknown>;
	streamingFieldName?: string;
	streamingFieldValue?: string;
	// Sentinel fields set once the tool is promoted to started/completed.
	_started?: boolean;
	_input?: Record<string, unknown>;
	_status?: string;
	_startedAt?: number;
	_output?: unknown;
	_durationMs?: number;
	_metadata?: Record<string, unknown>;
	_sideCars?: SideCarRecord[];
	_longRunning?: boolean;
	_streamedFullOutput?: boolean;
	_streamingOutput?: string;
}

/**
 * Build the synthetic STREAMING_CHUNKS_MSG_ID assistant message that surfaces
 * the currently-streaming top-level tool calls. Pure function shared by the
 * legacy panel WS memo and the chunk data layer so both render identical cards.
 * Returns null when there are no active top-level streaming chunks.
 */
export function buildTopLevelStreamingChunksMsg(
	chunks: TopLevelStreamingChunk[],
	narratorId: string,
	createdAt: string | null,
): NarratorMsg | null {
	if (chunks.length === 0) return null;

	let blocks: ContentBlock[] = [];
	let toolCalls = [] as NonNullable<NarratorMsg["toolCalls"]>;
	for (const chunk of chunks) {
		if (chunk._started) {
			// Tool promoted to started/completed — render as a real card.
			const inputJson = chunk._input ?? {};
			const next = upsertStreamingToolBlock(
				blocks,
				toolCalls,
				chunk.toolUseId,
				chunk.toolName,
				inputJson,
			);
			blocks = next.blocks;
			toolCalls = next.toolCalls;
			const tcIdx = toolCalls.findIndex((tc) => tc.toolUseId === chunk.toolUseId);
			if (tcIdx !== -1) {
				toolCalls[tcIdx] = {
					...toolCalls[tcIdx],
					status: chunk._status ?? "running",
					...(chunk._startedAt && { startedAt: chunk._startedAt }),
					...(chunk._output !== undefined && { outputJson: chunk._output }),
					...(chunk._durationMs != null && { durationMs: chunk._durationMs }),
					...(chunk._sideCars && { sideCars: chunk._sideCars }),
					...(chunk._metadata && { _metadata: chunk._metadata }),
					...(chunk.metadata && { _metadata: chunk.metadata }),
					...(chunk._longRunning && { _longRunning: true }),
					...(chunk._streamedFullOutput && { _streamedFullOutput: true }),
					...(chunk._streamingOutput && { _streamingOutput: chunk._streamingOutput }),
				} as (typeof toolCalls)[number];
			}
		} else {
			const next = upsertStreamingToolBlock(blocks, toolCalls, chunk.toolUseId, chunk.toolName, {
				_streamingChars: chunk.inputCharsTotal,
				...(chunk.extractedFilePath && { _streamingFilePath: chunk.extractedFilePath }),
				...(chunk.contentCharsReceived != null && {
					_streamingContentChars: chunk.contentCharsReceived,
				}),
				...(chunk.extractedFields && { _streamingFields: chunk.extractedFields }),
				...(chunk.metadata && { _streamingMetadata: chunk.metadata }),
				...(chunk.streamingFieldName && { _streamingFieldName: chunk.streamingFieldName }),
				...(chunk.streamingFieldValue && { _streamingFieldValue: chunk.streamingFieldValue }),
			});
			blocks = next.blocks;
			toolCalls = next.toolCalls;
			const tcIdx = toolCalls.findIndex((tc) => tc.toolUseId === chunk.toolUseId);
			if (tcIdx !== -1 && chunk.metadata) {
				toolCalls[tcIdx] = {
					...toolCalls[tcIdx],
					_metadata: chunk.metadata,
				} as (typeof toolCalls)[number];
			}
		}
	}

	return {
		id: STREAMING_CHUNKS_MSG_ID,
		narratorId,
		parentToolUseId: null,
		role: "assistant",
		contentJson: blocks,
		contentText: null,
		toolCalls,
		createdAt: createdAt ?? new Date().toISOString(),
		children: [],
	} as NarratorMsg;
}

/**
 * Insert a top-level message into a seq-ascending array at its correct slot.
 * Falls back to appending when seq is missing or it belongs at the tail.
 */
export function insertTopLevelMessageBySeq(
	messages: NarratorMsg[],
	newMsg: NarratorMsg,
): NarratorMsg[] {
	const seq =
		typeof newMsg.seq === "number" && Number.isFinite(newMsg.seq) ? newMsg.seq : undefined;
	if (seq == null) return [...messages, newMsg];

	const insertIdx = messages.findIndex(
		(msg) => typeof msg.seq === "number" && Number.isFinite(msg.seq) && msg.seq > seq,
	);
	if (insertIdx === -1) return [...messages, newMsg];

	const updated = [...messages];
	updated.splice(insertIdx, 0, newMsg);
	return updated;
}

function sideCarMergeKey(sideCar: SideCarRecord): string {
	return [
		sideCar.target,
		sideCar.source,
		sideCar.toolUseId ?? "",
		sideCar.orderIndex ?? "",
		sideCar.content,
	].join("\u0000");
}

export function mergeSideCarLists(
	incoming?: SideCarRecord[] | null,
	existing?: SideCarRecord[] | null,
): SideCarRecord[] | undefined {
	const merged: SideCarRecord[] = [];
	const seen = new Set<string>();
	for (const list of [incoming, existing]) {
		for (const sideCar of list ?? []) {
			const key = sideCarMergeKey(sideCar);
			if (seen.has(key)) continue;
			seen.add(key);
			merged.push(sideCar);
		}
	}
	return merged.length > 0 ? merged : undefined;
}

function collectToolSideCars(message: NarratorMsg): Map<string, SideCarRecord[]> {
	const result = new Map<string, SideCarRecord[]>();
	const add = (toolUseId: unknown, sideCars: unknown) => {
		if (typeof toolUseId !== "string" || !Array.isArray(sideCars) || sideCars.length === 0) {
			return;
		}
		const previous = result.get(toolUseId);
		result.set(toolUseId, mergeSideCarLists(sideCars as SideCarRecord[], previous) ?? []);
	};
	for (const toolCall of message.toolCalls ?? []) {
		add(toolCall.toolUseId, toolCall.sideCars);
	}
	for (const block of message.contentJson ?? []) {
		if (block.type === "tool_use") {
			add(block.id, block.sideCars);
		}
	}
	return result;
}

/**
 * Merge live side-car records from an existing cached message into an incoming
 * replacement so streamed side-cars survive a server-sent message refresh.
 * Returns `incoming` unchanged when nothing merged (preserves reference).
 */
export function preserveLiveSideCars(
	existing: NarratorMsg | undefined,
	incoming: NarratorMsg,
): NarratorMsg {
	if (!existing) return incoming;

	const sideCars = mergeSideCarLists(incoming.sideCars, existing.sideCars);
	const existingToolSideCars = collectToolSideCars(existing);
	let changed = sideCars !== incoming.sideCars;

	const toolCalls = (incoming.toolCalls ?? []).map((toolCall) => {
		const merged = mergeSideCarLists(
			toolCall.sideCars,
			existingToolSideCars.get(toolCall.toolUseId),
		);
		if (merged === toolCall.sideCars) return toolCall;
		changed = true;
		return { ...toolCall, sideCars: merged } as ToolCallRecord;
	});

	const toolCallSideCars = new Map<string, SideCarRecord[]>();
	for (const toolCall of toolCalls) {
		if (toolCall.toolUseId && toolCall.sideCars?.length) {
			toolCallSideCars.set(toolCall.toolUseId, toolCall.sideCars);
		}
	}

	const contentJson = (incoming.contentJson ?? []).map((block) => {
		if (block.type !== "tool_use" || typeof block.id !== "string") return block;
		const merged = mergeSideCarLists(
			Array.isArray(block.sideCars) ? (block.sideCars as SideCarRecord[]) : undefined,
			toolCallSideCars.get(block.id),
		);
		if (!merged || merged === block.sideCars) return block;
		changed = true;
		return { ...block, sideCars: merged };
	});

	return changed ? { ...incoming, sideCars, toolCalls, contentJson } : incoming;
}

export function removeStreamingChunksMsg(
	qc: QueryClient,
	messagesQueryKey: readonly unknown[],
): void {
	qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
		if (!old?.pages?.length) return old;
		const firstPage = old.pages[0];
		const msgs = Array.isArray(firstPage.messages) ? firstPage.messages : [];
		if (!msgs.some((m: NarratorMsg) => m.id === STREAMING_CHUNKS_MSG_ID)) return old;
		const pages = [...old.pages];
		pages[0] = {
			...firstPage,
			messages: msgs.filter((m: NarratorMsg) => m.id !== STREAMING_CHUNKS_MSG_ID),
		};
		return { ...old, pages };
	});
}
