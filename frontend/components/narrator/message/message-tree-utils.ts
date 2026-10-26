/**
 * Pure utility functions for immutably updating loaded message rows from WebSocket
 * events. Rows are flat: a nested row is a row like any other (`nested-rows.ts`).
 */

import type {
	BaseContentBlock,
	ContentBlock,
	SubagentActivitySummary,
	SubagentToolCallHeader,
	ToolCallRecord,
	TreeMessage,
} from "@frontend/lib/api";
import { mapRowElements, messageBody } from "@shared/narrator-blocks/message-blocks";
import { copyStreamingEditInput, handoffStreamingEditOrigin } from "@shared/streaming-edit-origin";
import { mergeToolLifecycleRecord, type ToolLifecycleRecord } from "@shared/tool-row-status";

interface ToolCall {
	toolUseId: string;
	status?: string;
	outputJson?: unknown;
	toolName?: string;
	inputJson?: unknown;
	[key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only validated dedicated server evidence may survive a full-input handoff. */
export function preserveStreamingEditLocation(
	previous: unknown,
	incoming: unknown,
	toolUseId: string,
): unknown {
	return handoffStreamingEditOrigin(toolUseId, incoming, undefined, previous);
}

export function normalizeSubagentModel(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed || null;
}

export function normalizeSubagentReasoningEffort(value: unknown): string | null {
	return normalizeSubagentModel(value);
}

const TERMINAL_TOOL_STATUSES = new Set([
	"success",
	"completed",
	"denied",
	"error",
	"fail",
	"failed",
	"cancelled",
	"canceled",
	"aborted",
	"timeout",
]);

function isTerminalToolStatus(status: string | undefined): boolean {
	return !!status && TERMINAL_TOOL_STATUSES.has(status.toLowerCase());
}

function sameSubagentToolCall(
	existing: SubagentToolCallHeader,
	incoming: SubagentToolCallHeader,
): boolean {
	if (existing.toolCallId && incoming.toolCallId)
		return existing.toolCallId === incoming.toolCallId;
	return existing.toolUseId === incoming.toolUseId;
}

function mergeSubagentToolCallHeader(
	existing: SubagentToolCallHeader,
	incoming: SubagentToolCallHeader,
): SubagentToolCallHeader {
	const preventTerminalRegression =
		isTerminalToolStatus(existing.status) && !isTerminalToolStatus(incoming.status);
	return {
		...existing,
		...incoming,
		toolCallId: incoming.toolCallId ?? existing.toolCallId,
		status: preventTerminalRegression ? existing.status : incoming.status,
		timing: {
			...(existing.timing ?? {}),
			...(incoming.timing ?? {}),
			...(preventTerminalRegression && existing.timing?.completedAt != null
				? { completedAt: existing.timing.completedAt }
				: {}),
		},
	};
}

/** Upsert one lightweight child tool header and retain only the newest three. */
export function upsertSubagentToolCallHeader(
	activity: SubagentActivitySummary | null | undefined,
	header: SubagentToolCallHeader,
): SubagentActivitySummary {
	const latest = [...(activity?.latestToolCalls ?? [])];
	const existingIndex = latest.findIndex((item) => sameSubagentToolCall(item, header));
	const merged =
		existingIndex >= 0 ? mergeSubagentToolCallHeader(latest[existingIndex], header) : header;
	if (existingIndex >= 0) latest.splice(existingIndex, 1);
	latest.push(merged);
	const reasoningEffort = normalizeSubagentReasoningEffort(activity?.reasoningEffort);
	return {
		subagentNarratorId: activity?.subagentNarratorId ?? null,
		model: normalizeSubagentModel(activity?.model),
		...(reasoningEffort ? { reasoningEffort } : {}),
		...(activity?.modelInheritance ? { modelInheritance: activity.modelInheritance } : {}),
		// This rebuilds the summary from scratch, so anything not restated here is
		// ERASED. A child tool event knows nothing about takeover, and dropping the
		// flag on every such event would make the badge flicker off the moment the
		// taken-over child ran anything.
		...(activity?.takenOver ? { takenOver: true } : {}),
		// Tool headers carry no file evidence; keep the last aggregate until a
		// snapshot actually supplies a replacement (including an explicit empty one).
		...(activity && Object.hasOwn(activity, "fileChanges")
			? { fileChanges: activity.fileChanges }
			: {}),
		latestToolCalls: latest.slice(-3),
	};
}

/** A newly assigned child must never inherit the previous child's file evidence. */
export function activityForSubagent(
	activity: SubagentActivitySummary | null | undefined,
	subagentNarratorId: string | null | undefined,
): SubagentActivitySummary | undefined {
	if (
		activity?.subagentNarratorId &&
		subagentNarratorId &&
		activity.subagentNarratorId !== subagentNarratorId
	) {
		return undefined;
	}
	return activity ?? undefined;
}

/** Replace authoritative activity details without letting an empty model erase a known value. */
export function replaceSubagentActivitySnapshot(
	activity: SubagentActivitySummary,
	previous?: SubagentActivitySummary,
): SubagentActivitySummary {
	const sameChild = activityForSubagent(previous, activity.subagentNarratorId);
	const reasoningEffort =
		normalizeSubagentReasoningEffort(activity.reasoningEffort) ??
		normalizeSubagentReasoningEffort(sameChild?.reasoningEffort);
	const hasFileChanges = Object.hasOwn(activity, "fileChanges");
	let normalized: SubagentActivitySummary = {
		subagentNarratorId: activity.subagentNarratorId ?? sameChild?.subagentNarratorId ?? null,
		model: normalizeSubagentModel(activity.model) ?? normalizeSubagentModel(sameChild?.model),
		// Incremental activity snapshots may omit fileChanges while the child is
		// still running. Preserve the last known list in that case; an explicit
		// empty array remains authoritative and clears it.
		...(hasFileChanges
			? { fileChanges: activity.fileChanges }
			: sameChild?.fileChanges
				? { fileChanges: sameChild.fileChanges }
				: {}),
		...(reasoningEffort ? { reasoningEffort } : {}),
		// Like `model`, an empty snapshot must not erase a known decision.
		...((activity.modelInheritance ?? sameChild?.modelInheritance)
			? { modelInheritance: activity.modelInheritance ?? sameChild?.modelInheritance }
			: {}),
		// The snapshot is AUTHORITATIVE for takeover (the server reads the live
		// in-memory Set when building it), so unlike `model` it must NOT fall back to
		// the previous value: a snapshot arriving after the user stopped the takeover
		// is precisely the correction this channel exists to deliver.
		...(activity.takenOver ? { takenOver: true } : {}),
		latestToolCalls: [],
	};
	for (const header of activity.latestToolCalls ?? []) {
		normalized = upsertSubagentToolCallHeader(normalized, header);
	}
	return normalized;
}

/** Merge sparse projections without losing a same-attempt child activity aggregate. */
export function mergeToolRecordWithSubagentActivity<
	P extends ToolLifecycleRecord,
	I extends ToolLifecycleRecord,
>(previous: P | undefined, incoming: I | undefined): P & I {
	const merged = mergeToolLifecycleRecord(previous, incoming);
	if (!previous || !incoming) return merged;
	const result: ToolLifecycleRecord = { ...merged };
	// Keep the owner of retained activity evidence across sparse projections too.
	// Otherwise attempt 1 → unknown → attempt 2 loses the boundary and leaks files.
	if (incoming.executionAttempt == null && Number.isSafeInteger(previous.executionAttempt)) {
		result.executionAttempt = previous.executionAttempt;
	}
	const differentAttempt =
		Number.isSafeInteger(previous.executionAttempt) &&
		Number.isSafeInteger(incoming.executionAttempt) &&
		previous.executionAttempt !== incoming.executionAttempt;
	if (differentAttempt) {
		// The lifecycle merger inherits descriptive fields on retry. Activity is
		// execution evidence, not description, and must not survive that inheritance.
		if (!Object.hasOwn(incoming, "_subagentActivity")) delete result._subagentActivity;
		return result as P & I;
	}
	if (!Object.hasOwn(incoming, "_subagentActivity")) {
		if (Object.hasOwn(previous, "_subagentActivity")) {
			result._subagentActivity = previous._subagentActivity;
		}
	} else if (isRecord(incoming._subagentActivity)) {
		result._subagentActivity = replaceSubagentActivitySnapshot(
			incoming._subagentActivity as unknown as SubagentActivitySummary,
			isRecord(previous._subagentActivity)
				? (previous._subagentActivity as unknown as SubagentActivitySummary)
				: undefined,
		);
	}
	// Explicit null/undefined activities and missing tool blocks remain authoritative.
	return result as P & I;
}

/** Update the Agent/Task/Send tool block identified by parentToolUseId in the rows. */
export function updateSubagentActivityInMessages(
	messages: TreeMessage[],
	parentToolUseId: string,
	updater: (activity: SubagentActivitySummary | undefined) => SubagentActivitySummary | undefined,
): { messages: TreeMessage[]; changed: boolean } {
	if (!Array.isArray(messages)) return { messages: messages ?? [], changed: false };
	let changed = false;
	const updated = messages.map((message) => {
		let nextMessage = message;
		const withContent = mapRowElements(message, (block) => {
			if (block.type !== "tool_use" || block.id !== parentToolUseId) return block;
			const nextActivity = updater(block._subagentActivity);
			if (nextActivity === block._subagentActivity) return block;
			return { ...block, _subagentActivity: nextActivity };
		});
		let localChanged = withContent !== message;
		const nextCalls = (message.toolCalls ?? []).map((call) => {
			if (call.toolUseId !== parentToolUseId) return call;
			const current = (call as ToolCallRecord & { _subagentActivity?: SubagentActivitySummary })
				._subagentActivity;
			const nextActivity = updater(current);
			if (nextActivity === current) return call;
			localChanged = true;
			return { ...call, _subagentActivity: nextActivity };
		});
		if (localChanged) {
			changed = true;
			nextMessage = { ...withContent, toolCalls: nextCalls };
		}
		return nextMessage;
	});
	return { messages: changed ? updated : messages, changed };
}

/**
 * Merge fields while preserving a persisted tool input when the incoming input
 * only contains streaming progress markers. Started/permission updates still
 * replace the full input object as before.
 *
 * Status is phase-ranked: a late snapshot must not move a tool BACKWARDS
 * (`running` over a live-patched `success`). That regression is exactly how a
 * finished call keeps its spinner until the next structural reload.
 */
function mergeToolFields<T extends { inputJson?: unknown; outputJson?: unknown; status?: unknown }>(
	existing: T,
	fields: Record<string, unknown>,
): T & Record<string, unknown> {
	const lifecycle = mergeToolLifecycleRecord(existing, fields);
	const merged = { ...existing, ...fields, ...lifecycle } as T & Record<string, unknown>;
	const incomingInput = fields.inputJson;
	if (
		isRecord(incomingInput) &&
		Object.keys(incomingInput).some((key) => key.startsWith("_streaming")) &&
		!("old_string" in incomingInput || "new_string" in incomingInput) &&
		isRecord(existing.inputJson)
	) {
		merged.inputJson = copyStreamingEditInput(existing.inputJson, incomingInput);
	} else if (incomingInput !== undefined) {
		const identity = existing as T & { toolUseId?: string; id?: string };
		merged.inputJson = preserveStreamingEditLocation(
			existing.inputJson,
			incomingInput,
			identity.toolUseId ?? identity.id ?? "",
		);
	}
	if (fields.outputJson === undefined && existing.outputJson !== undefined) {
		merged.outputJson = existing.outputJson;
	}
	return merged;
}

/**
 * Sync fields into the message's enriched tool_use element that matches the given
 * toolUseId. This keeps the body in sync with toolCalls so that
 * resolveAllToolCallsFromMsg (which reads enriched elements first) sees updates
 * from WS events like tool_completed / tool_started / permission changes.
 */
function syncToolElementFields(
	message: TreeMessage,
	toolUseId: string,
	fields: Record<string, unknown>,
): TreeMessage {
	return mapRowElements(message, (block) =>
		block.type !== "tool_use" || block.id !== toolUseId
			? block
			: (mergeToolFields(block, fields) as ContentBlock),
	);
}

/** Merge extra fields into every occurrence of a tool call's record in the rows. */
export function mergeToolCallFieldsInRows(
	messages: TreeMessage[],
	toolUseId: string,
	fields: Record<string, unknown>,
): { messages: TreeMessage[]; changed: boolean } {
	if (!Array.isArray(messages)) return { messages: messages ?? [], changed: false };
	let anyChanged = false;
	const updated = messages.map((msg) => {
		let result = msg;
		let tcChanged = false;
		const updatedCalls = (Array.isArray(msg.toolCalls) ? msg.toolCalls : []).map((tc) => {
			if (tc.toolUseId !== toolUseId) return tc;
			tcChanged = true;
			return mergeToolFields(tc, fields);
		});

		const contentChanged = messageBody(msg).some(
			(block) => block.type === "tool_use" && block.id === toolUseId,
		);
		if (tcChanged || contentChanged) {
			anyChanged = true;
			if (contentChanged) result = syncToolElementFields(result, toolUseId, fields);
			if (tcChanged) result = { ...result, toolCalls: updatedCalls as ToolCallRecord[] };
		}
		return result;
	});
	return { messages: updated, changed: anyChanged };
}

export interface ReflectionToolOccurrence {
	found: boolean;
	requestId?: string;
}

/**
 * Locate the newest tool occurrence first, then inspect only that occurrence's
 * reflection suggestions. A reused provider toolUseId on an older card must not
 * become the fallback identity when the newest card has no suggestion yet.
 */
export function getNewestReflectionToolOccurrence(
	messages: TreeMessage[],
	toolUseId: string,
	reflectionType: string,
): ReflectionToolOccurrence {
	if (!Array.isArray(messages)) return { found: false };

	// Walk newest-to-oldest. A nested row follows its parent, so it is checked before
	// the parent row: a nested reflection can be newer than the parent's tool-call data.
	for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
		const msg = messages[messageIndex];

		const toolCalls = Array.isArray(msg.toolCalls) ? (msg.toolCalls as ToolCall[]) : [];
		let matchingToolCall: ToolCall | undefined;
		for (let toolCallIndex = toolCalls.length - 1; toolCallIndex >= 0; toolCallIndex--) {
			if (toolCalls[toolCallIndex].toolUseId === toolUseId) {
				matchingToolCall = toolCalls[toolCallIndex];
				break;
			}
		}

		const contentBlocks = messageBody(msg);
		let matchingContentBlock:
			| (BaseContentBlock & { permissionSuggestions?: unknown[]; suggestions?: unknown[] })
			| undefined;
		for (let blockIndex = contentBlocks.length - 1; blockIndex >= 0; blockIndex--) {
			const block = contentBlocks[blockIndex];
			if (block.type === "tool_use" && block.id === toolUseId) {
				matchingContentBlock = block as typeof matchingContentBlock;
				break;
			}
		}

		if (!matchingToolCall && !matchingContentBlock) continue;
		const requestId = getLatestReflectionSuggestionId(
			[
				matchingToolCall?.permissionSuggestions,
				(matchingToolCall as { suggestions?: unknown[] } | undefined)?.suggestions,
				matchingContentBlock?.permissionSuggestions,
				matchingContentBlock?.suggestions,
			],
			reflectionType,
		);
		return requestId ? { found: true, requestId } : { found: true };
	}
	return { found: false };
}

/** Merge fields into only the newest occurrence of a reused toolUseId. */
export function mergeFieldsIntoNewestToolOccurrence(
	messages: TreeMessage[],
	toolUseId: string,
	fields: Record<string, unknown>,
): { messages: TreeMessage[]; changed: boolean } {
	if (!Array.isArray(messages)) return { messages: messages ?? [], changed: false };
	for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
		const msg = messages[messageIndex];
		const toolCalls = Array.isArray(msg.toolCalls) ? [...msg.toolCalls] : [];
		let toolCallIndex = -1;
		for (let index = toolCalls.length - 1; index >= 0; index--) {
			if (toolCalls[index].toolUseId === toolUseId) {
				toolCallIndex = index;
				break;
			}
		}
		const body = messageBody(msg);
		let contentBlockIndex = -1;
		for (let index = body.length - 1; index >= 0; index--) {
			const block = body[index];
			if (block.type === "tool_use" && block.id === toolUseId) {
				contentBlockIndex = index;
				break;
			}
		}
		if (toolCallIndex < 0 && contentBlockIndex < 0) continue;

		if (toolCallIndex >= 0) {
			toolCalls[toolCallIndex] = mergeToolFields(toolCalls[toolCallIndex], fields);
		}
		const next =
			contentBlockIndex >= 0
				? mapRowElements(msg, (block, index) =>
						index === contentBlockIndex ? (mergeToolFields(block, fields) as ContentBlock) : block,
					)
				: msg;
		const updated = [...messages];
		updated[messageIndex] = {
			...next,
			...(toolCallIndex >= 0 ? { toolCalls: toolCalls as ToolCallRecord[] } : {}),
		};
		return { messages: updated, changed: true };
	}
	return { messages, changed: false };
}

function getLatestReflectionSuggestionId(
	candidates: unknown[],
	reflectionType: string,
): string | undefined {
	for (const suggestions of candidates) {
		if (!Array.isArray(suggestions)) continue;
		for (let index = suggestions.length - 1; index >= 0; index--) {
			const suggestion = suggestions[index];
			if (!suggestion || typeof suggestion !== "object") continue;
			const record = suggestion as { type?: unknown; requestId?: unknown };
			if (record.type === reflectionType && typeof record.requestId === "string") {
				return record.requestId;
			}
		}
	}
	return undefined;
}

/**
 * Upsert a streaming tool_use block into existing content blocks and tool call arrays.
 * Shared by both top-level streaming chunks and subagent streaming chunks.
 * Returns new arrays (does not mutate inputs).
 */
export function upsertStreamingToolBlock(
	prevBlocks: ContentBlock[],
	prevToolCalls: ToolCallRecord[],
	toolUseId: string,
	toolName: string,
	streamingInput: Record<string, unknown>,
): { blocks: ContentBlock[]; toolCalls: ToolCallRecord[] } {
	const blocks = [...prevBlocks];
	const toolCalls = [...prevToolCalls];

	const blockIdx = blocks.findIndex(
		(b: ContentBlock) => b.type === "tool_use" && b.id === toolUseId,
	);
	if (blockIdx === -1) {
		blocks.push({ type: "tool_use", id: toolUseId, name: toolName, input: {} });
		toolCalls.push({
			toolUseId,
			toolName,
			inputJson: {},
			status: "initializing",
			createdAt: new Date().toISOString(),
		} as ToolCallRecord);
	}
	const tcIdx = toolCalls.findIndex((tc: ToolCallRecord) => tc.toolUseId === toolUseId);
	if (tcIdx !== -1) {
		toolCalls[tcIdx] = { ...toolCalls[tcIdx], inputJson: streamingInput };
	}
	return { blocks, toolCalls };
}
