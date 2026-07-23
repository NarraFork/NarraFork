/**
 * Pure utility functions for operating on the message tree cache.
 * Used by NarratorPanel's WebSocket handlers to immutably update
 * React Query's cached message pages.
 */

import type {
	BaseContentBlock,
	ContentBlock,
	SubagentActivitySummary,
	SubagentToolCallHeader,
	ToolCallRecord,
	TreeMessage,
} from "@frontend/lib/api";

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
		latestToolCalls: latest.slice(-3),
	};
}

/** Replace authoritative activity details without letting an empty model erase a known value. */
export function replaceSubagentActivitySnapshot(
	activity: SubagentActivitySummary,
	previous?: SubagentActivitySummary,
): SubagentActivitySummary {
	const reasoningEffort =
		normalizeSubagentReasoningEffort(activity.reasoningEffort) ??
		normalizeSubagentReasoningEffort(previous?.reasoningEffort);
	let normalized: SubagentActivitySummary = {
		subagentNarratorId: activity.subagentNarratorId ?? null,
		model: normalizeSubagentModel(activity.model) ?? normalizeSubagentModel(previous?.model),
		...(reasoningEffort ? { reasoningEffort } : {}),
		latestToolCalls: [],
	};
	for (const header of activity.latestToolCalls ?? []) {
		normalized = upsertSubagentToolCallHeader(normalized, header);
	}
	return normalized;
}

/** Update the Agent/Task/Send tool block identified by parentToolUseId in a message tree. */
export function updateSubagentActivityInMessages(
	messages: TreeMessage[],
	parentToolUseId: string,
	updater: (activity: SubagentActivitySummary | undefined) => SubagentActivitySummary | undefined,
): { messages: TreeMessage[]; changed: boolean } {
	if (!Array.isArray(messages)) return { messages: messages ?? [], changed: false };
	let changed = false;
	const updated = messages.map((message) => {
		let nextMessage = message;
		let localChanged = false;
		const nextContent = (message.contentJson ?? []).map((block) => {
			if (block.type !== "tool_use" || block.id !== parentToolUseId) return block;
			const nextActivity = updater(block._subagentActivity);
			if (nextActivity === block._subagentActivity) return block;
			localChanged = true;
			return { ...block, _subagentActivity: nextActivity };
		});
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
			nextMessage = { ...message, contentJson: nextContent, toolCalls: nextCalls };
		}
		if (nextMessage.children?.length) {
			const childResult = updateSubagentActivityInMessages(
				nextMessage.children,
				parentToolUseId,
				updater,
			);
			if (childResult.changed) {
				changed = true;
				nextMessage = { ...nextMessage, children: childResult.messages };
			}
		}
		return nextMessage;
	});
	return { messages: changed ? updated : messages, changed };
}

/** Update subagent activity in React Query's paginated message cache. */
export function updateSubagentActivityInCache(
	old: InfiniteCache,
	parentToolUseId: string,
	updater: (activity: SubagentActivitySummary | undefined) => SubagentActivitySummary | undefined,
): InfiniteCache {
	let changed = false;
	const pages = old.pages.map((page) => {
		const result = updateSubagentActivityInMessages(page.messages, parentToolUseId, updater);
		if (!result.changed) return page;
		changed = true;
		return { ...page, messages: result.messages };
	});
	return changed ? { ...old, pages } : old;
}

function hasToolUseInMessage(msg: TreeMessage, toolUseId: string | null | undefined): boolean {
	if (!toolUseId) return false;
	if ((msg.toolCalls as ToolCall[] | undefined)?.some((tc) => tc.toolUseId === toolUseId)) {
		return true;
	}
	return (
		Array.isArray(msg.contentJson) &&
		msg.contentJson.some((block) => block.type === "tool_use" && block.id === toolUseId)
	);
}

/**
 * Merge fields while preserving a persisted tool input when the incoming input
 * only contains streaming progress markers. Started/permission updates still
 * replace the full input object as before.
 */
function mergeToolFields<T extends { inputJson?: unknown; outputJson?: unknown }>(
	existing: T,
	fields: Record<string, unknown>,
): T & Record<string, unknown> {
	const merged = { ...existing, ...fields } as T & Record<string, unknown>;
	const incomingInput = fields.inputJson;
	if (
		isRecord(incomingInput) &&
		Object.keys(incomingInput).some((key) => key.startsWith("_streaming")) &&
		isRecord(existing.inputJson)
	) {
		merged.inputJson = { ...existing.inputJson, ...incomingInput };
	}
	if (fields.outputJson === undefined && existing.outputJson !== undefined) {
		merged.outputJson = existing.outputJson;
	}
	return merged;
}

/**
 * Sync fields into the enriched tool_use block in contentJson that matches
 * the given toolUseId. This keeps contentJson in sync with toolCalls so that
 * resolveAllToolCallsFromMsg (which reads enriched blocks first) sees updates
 * from WS events like tool_completed / tool_started / permission changes.
 */
function syncContentJsonFields(
	contentJson: ContentBlock[],
	toolUseId: string,
	fields: Record<string, unknown>,
): ContentBlock[] {
	let changed = false;
	const result = contentJson.map((block) => {
		if (block.type !== "tool_use" || block.id !== toolUseId) return block;
		changed = true;
		return mergeToolFields(block, fields) as ContentBlock;
	});
	return changed ? result : contentJson;
}

interface CachePage {
	messages: TreeMessage[];
	hasMore?: boolean;
	nextCursor?: string | null;
}

interface InfiniteCache {
	pages: CachePage[];
	pageParams?: unknown[];
}

/** Insert a child message into the correct parent's children array in the cache */
export function insertChildIntoCache(
	old: InfiniteCache,
	childMsg: TreeMessage,
	index?: MessageIndex,
): InfiniteCache {
	// Fast path: use index to locate the parent message by parentToolUseId
	if (index && childMsg.parentToolUseId) {
		const entry = index.get(childMsg.parentToolUseId);
		if (entry && entry.pageIdx < old.pages.length && old.pages[entry.pageIdx]) {
			const pages = [...old.pages];
			const page = { ...pages[entry.pageIdx] };
			const { messages, changed } = insertChildAtPath(page.messages, entry.path, childMsg);
			if (changed) {
				page.messages = messages;
				pages[entry.pageIdx] = page;
				return { ...old, pages };
			}
			return old;
		}
	}
	// Fallback: full tree traversal
	let anyChanged = false;
	const pages = old.pages.map((page) => {
		const { messages, changed } = insertChildIntoMessages(page.messages, childMsg);
		if (changed) anyChanged = true;
		return changed ? { ...page, messages } : page;
	});
	return anyChanged ? { ...old, pages } : old;
}

/** Navigate to a message by path and append a child to it */
function insertChildAtPath(
	messages: TreeMessage[],
	path: number[],
	childMsg: TreeMessage,
): { messages: TreeMessage[]; changed: boolean } {
	if (!Array.isArray(messages)) return { messages: messages ?? [], changed: false };
	if (path.length === 0) return { messages, changed: false };
	const [idx, ...rest] = path;
	const msg = messages[idx];
	if (!msg) return { messages, changed: false };

	if (rest.length === 0) {
		// This is the target message — append or refresh child
		const children = msg.children || [];
		const existingIdx = children.findIndex((c) => c.id === childMsg.id);
		const updated = [...messages];
		if (existingIdx !== -1) {
			const nextChildren = [...children];
			const existing = nextChildren[existingIdx];
			nextChildren[existingIdx] = {
				...existing,
				...childMsg,
				children: childMsg.children?.length ? childMsg.children : (existing.children ?? []),
			};
			updated[idx] = { ...msg, children: nextChildren };
			return { messages: updated, changed: true };
		}
		updated[idx] = { ...msg, children: [...children, childMsg] };
		return { messages: updated, changed: true };
	}
	// Navigate deeper into children
	if (!msg.children?.length) return { messages, changed: false };
	const childResult = insertChildAtPath(msg.children, rest, childMsg);
	if (!childResult.changed) return { messages, changed: false };
	const updated = [...messages];
	updated[idx] = { ...msg, children: childResult.messages };
	return { messages: updated, changed: true };
}

export function insertChildIntoMessages(
	messages: TreeMessage[],
	childMsg: TreeMessage,
): { messages: TreeMessage[]; changed: boolean } {
	if (!Array.isArray(messages)) return { messages: messages ?? [], changed: false };
	let anyChanged = false;
	const updated = messages.map((msg) => {
		// Check both persisted tool-call rows and partial contentJson blocks.
		const hasParentTool = hasToolUseInMessage(msg, childMsg.parentToolUseId);
		if (hasParentTool) {
			const children = msg.children || [];
			const existingIdx = children.findIndex((c) => c.id === childMsg.id);
			anyChanged = true;
			if (existingIdx !== -1) {
				const nextChildren = [...children];
				const existing = nextChildren[existingIdx];
				nextChildren[existingIdx] = {
					...existing,
					...childMsg,
					children: childMsg.children?.length ? childMsg.children : (existing.children ?? []),
				};
				return { ...msg, children: nextChildren };
			}
			return { ...msg, children: [...children, childMsg] };
		}
		// Recurse into children
		if (msg.children?.length) {
			const childResult = insertChildIntoMessages(msg.children, childMsg);
			if (childResult.changed) {
				anyChanged = true;
				return { ...msg, children: childResult.messages };
			}
		}
		return msg;
	});
	return { messages: updated, changed: anyChanged };
}

/** Recursively merge extra fields into a tool call's record in the message tree. */
export function mergeToolCallFieldsInTree(
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

		let contentChanged = false;
		if (Array.isArray(msg.contentJson)) {
			contentChanged = msg.contentJson.some(
				(block) => block.type === "tool_use" && block.id === toolUseId,
			);
		}
		if (tcChanged || contentChanged) {
			anyChanged = true;
			result = {
				...result,
				...(tcChanged ? { toolCalls: updatedCalls as ToolCallRecord[] } : {}),
				...(contentChanged
					? { contentJson: syncContentJsonFields(msg.contentJson, toolUseId, fields) }
					: {}),
			};
		}
		if (msg.children?.length) {
			const childResult = mergeToolCallFieldsInTree(msg.children, toolUseId, fields);
			if (childResult.changed) {
				anyChanged = true;
				result = { ...result, children: childResult.messages };
			}
		}
		return result;
	});
	return { messages: updated, changed: anyChanged };
}

/** Recursively update a tool call's status/output in the message tree */
export function updateToolCallInTree(
	messages: TreeMessage[],
	toolUseId: string,
	status: string,
	output?: unknown,
	durationMs?: number,
): { messages: TreeMessage[]; changed: boolean } {
	if (!Array.isArray(messages)) return { messages: messages ?? [], changed: false };
	let anyChanged = false;
	const updated = messages.map((msg) => {
		let msgChanged = false;
		let result = msg;

		// Update toolCalls on this message
		if ((msg.toolCalls as ToolCall[])?.length) {
			const updatedCalls = (msg.toolCalls as ToolCall[]).map((tc) => {
				if (tc.toolUseId !== toolUseId) return tc;
				msgChanged = true;
				return {
					...tc,
					status,
					outputJson: output ?? tc.outputJson,
					...(durationMs != null ? { durationMs } : {}),
				};
			});
			if (msgChanged) {
				anyChanged = true;
				const fields: Record<string, unknown> = { status };
				if (output !== undefined) fields.outputJson = output;
				if (durationMs != null) fields.durationMs = durationMs;
				result = { ...result, toolCalls: updatedCalls as ToolCallRecord[] };
				// Sync enriched contentJson blocks
				if (Array.isArray(result.contentJson)) {
					result = {
						...result,
						contentJson: syncContentJsonFields(result.contentJson, toolUseId, fields),
					};
				}
			}
		}

		// Recurse into children
		if (msg.children?.length) {
			const childResult = updateToolCallInTree(msg.children, toolUseId, status, output, durationMs);
			if (childResult.changed) {
				anyChanged = true;
				result = { ...result, children: childResult.messages };
			}
		}

		return result;
	});
	return { messages: updated, changed: anyChanged };
}

/** Find a message in the tree that contains a tool call with the given toolUseId. */
export function findMsgByToolUseIdInTree(
	messages: TreeMessage[],
	toolUseId: string,
): TreeMessage | null {
	if (!Array.isArray(messages)) return null;
	for (const msg of messages) {
		if ((msg.toolCalls as ToolCall[])?.some((tc) => tc.toolUseId === toolUseId)) return msg;
		// Partial assistant messages can briefly expose the tool_use block before the
		// narrator_tool_calls row is visible to the history query. Match contentJson
		// as well so reconnect reconciliation does not create a second synthetic card.
		if (
			Array.isArray(msg.contentJson) &&
			msg.contentJson.some((block) => block.type === "tool_use" && block.id === toolUseId)
		) {
			return msg;
		}
		if (msg.children?.length) {
			const found = findMsgByToolUseIdInTree(msg.children, toolUseId);
			if (found) return found;
		}
	}
	return null;
}

/**
 * Return the currently persisted danger-reflection request ID for a tool call.
 * `undefined` means the newest tool occurrence has no visible reflection request.
 */
export function getDangerReflectionRequestIdInTree(
	messages: TreeMessage[],
	toolUseId: string,
): string | undefined {
	return getReflectionRequestIdInTree(messages, toolUseId, "danger_reflection");
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
export function getNewestReflectionToolOccurrenceInTree(
	messages: TreeMessage[],
	toolUseId: string,
	reflectionType: string,
): ReflectionToolOccurrence {
	if (!Array.isArray(messages)) return { found: false };

	// Walk newest-to-oldest at every level. Children are checked before their parent
	// row because a nested reflection can be newer than the parent's tool-call data.
	for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
		const msg = messages[messageIndex];
		if (msg.children?.length) {
			const childOccurrence = getNewestReflectionToolOccurrenceInTree(
				msg.children,
				toolUseId,
				reflectionType,
			);
			if (childOccurrence.found) return childOccurrence;
		}

		const toolCalls = Array.isArray(msg.toolCalls) ? (msg.toolCalls as ToolCall[]) : [];
		let matchingToolCall: ToolCall | undefined;
		for (let toolCallIndex = toolCalls.length - 1; toolCallIndex >= 0; toolCallIndex--) {
			if (toolCalls[toolCallIndex].toolUseId === toolUseId) {
				matchingToolCall = toolCalls[toolCallIndex];
				break;
			}
		}

		const contentBlocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
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

/** Return the request ID from the newest matching tool occurrence only. */
export function getReflectionRequestIdInTree(
	messages: TreeMessage[],
	toolUseId: string,
	reflectionType: string,
): string | undefined {
	return getNewestReflectionToolOccurrenceInTree(messages, toolUseId, reflectionType).requestId;
}

/** Merge fields into only the newest occurrence of a reused toolUseId. */
export function mergeFieldsIntoNewestToolOccurrenceInTree(
	messages: TreeMessage[],
	toolUseId: string,
	fields: Record<string, unknown>,
): { messages: TreeMessage[]; changed: boolean } {
	if (!Array.isArray(messages)) return { messages: messages ?? [], changed: false };
	for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
		const msg = messages[messageIndex];
		if (msg.children?.length) {
			const childResult = mergeFieldsIntoNewestToolOccurrenceInTree(
				msg.children,
				toolUseId,
				fields,
			);
			if (childResult.changed) {
				const updated = [...messages];
				updated[messageIndex] = { ...msg, children: childResult.messages };
				return { messages: updated, changed: true };
			}
		}

		const toolCalls = Array.isArray(msg.toolCalls) ? [...msg.toolCalls] : [];
		let toolCallIndex = -1;
		for (let index = toolCalls.length - 1; index >= 0; index--) {
			if (toolCalls[index].toolUseId === toolUseId) {
				toolCallIndex = index;
				break;
			}
		}
		const contentJson = Array.isArray(msg.contentJson) ? [...msg.contentJson] : [];
		let contentBlockIndex = -1;
		for (let index = contentJson.length - 1; index >= 0; index--) {
			const block = contentJson[index];
			if (block.type === "tool_use" && block.id === toolUseId) {
				contentBlockIndex = index;
				break;
			}
		}
		if (toolCallIndex < 0 && contentBlockIndex < 0) continue;

		if (toolCallIndex >= 0) {
			toolCalls[toolCallIndex] = mergeToolFields(toolCalls[toolCallIndex], fields);
		}
		if (contentBlockIndex >= 0) {
			contentJson[contentBlockIndex] = mergeToolFields(
				contentJson[contentBlockIndex],
				fields,
			) as ContentBlock;
		}
		const updated = [...messages];
		updated[messageIndex] = {
			...msg,
			...(toolCallIndex >= 0 ? { toolCalls: toolCalls as ToolCallRecord[] } : {}),
			...(contentBlockIndex >= 0 ? { contentJson } : {}),
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

// --- Indexed tree updates for O(1) lookup instead of full traversal ---

/** Maps toolUseId → { pageIdx, path } where path is the index chain to reach the message */
export type MessageIndex = Map<string, { pageIdx: number; path: number[] }>;

/** Build an index of toolUseId → location for all messages across all pages */
export function buildToolUseIndex(pages: CachePage[]): MessageIndex {
	const index: MessageIndex = new Map();
	for (let p = 0; p < pages.length; p++) {
		indexMessages(pages[p].messages, p, [], index);
	}
	return index;
}

/**
 * Incrementally update the toolUseId index when only some pages changed.
 * Compares page references — unchanged pages keep their existing index entries.
 * Falls back to full rebuild when page count changes (load-more).
 */
export function updateToolUseIndex(
	prevIndex: MessageIndex,
	prevPages: CachePage[],
	newPages: CachePage[],
): MessageIndex {
	if (newPages.length !== prevPages.length) {
		return buildToolUseIndex(newPages);
	}
	// Find which pages changed by reference
	let allSame = true;
	for (let i = 0; i < newPages.length; i++) {
		if (newPages[i] !== prevPages[i]) {
			allSame = false;
			break;
		}
	}
	if (allSame) return prevIndex;

	// Rebuild only changed pages
	const updated = new Map(prevIndex);
	for (let p = 0; p < newPages.length; p++) {
		if (newPages[p] !== prevPages[p]) {
			// Remove old entries for this page
			for (const [key, val] of updated) {
				if (val.pageIdx === p) updated.delete(key);
			}
			// Add new entries
			indexMessages(newPages[p].messages, p, [], updated);
		}
	}
	return updated;
}

function indexMessages(
	messages: TreeMessage[],
	pageIdx: number,
	path: number[],
	index: MessageIndex,
) {
	if (!Array.isArray(messages)) return;
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.toolCalls) {
			for (const tc of msg.toolCalls as ToolCall[]) {
				if (tc.toolUseId) {
					index.set(tc.toolUseId, { pageIdx, path: [...path, i] });
				}
			}
		}
		// Partial assistant messages can expose tool_use before the tool-call row is
		// materialized. Index the content block as a fallback identity source too.
		if (Array.isArray(msg.contentJson)) {
			for (const block of msg.contentJson) {
				if (block.type === "tool_use" && block.id) {
					index.set(block.id, { pageIdx, path: [...path, i] });
				}
			}
		}
		if (msg.children?.length) {
			indexMessages(msg.children, pageIdx, [...path, i], index);
		}
	}
}

/** Navigate to a message by path and merge arbitrary fields into its tool call */
function mergeAtPath(
	messages: TreeMessage[],
	path: number[],
	toolUseId: string,
	fields: Record<string, unknown>,
): TreeMessage[] {
	if (!Array.isArray(messages)) return [];
	if (path.length === 0) return messages;
	const [idx, ...rest] = path;
	const updated = [...messages];
	const msg = updated[idx];
	if (!msg) return messages;

	if (rest.length === 0) {
		// This is the target message. Update both the persisted tool-call row and
		// the enriched content block; either one may be the only available identity
		// source while a partial assistant message is being written.
		let tcChanged = false;
		const updatedCalls = (Array.isArray(msg.toolCalls) ? msg.toolCalls : []).map((tc) => {
			if (tc.toolUseId !== toolUseId) return tc;
			tcChanged = true;
			return mergeToolFields(tc, fields);
		});

		let contentChanged = false;
		let enrichedContent = msg.contentJson;
		if (Array.isArray(enrichedContent)) {
			enrichedContent = enrichedContent.map((block) => {
				if (block.type !== "tool_use" || block.id !== toolUseId) return block;
				contentChanged = true;
				return mergeToolFields(block, fields) as BaseContentBlock;
			});
			if (!contentChanged) enrichedContent = msg.contentJson;
		}
		if (!tcChanged && !contentChanged) return messages;
		updated[idx] = {
			...msg,
			toolCalls: tcChanged ? (updatedCalls as ToolCallRecord[]) : msg.toolCalls,
			contentJson: enrichedContent,
		};
	} else {
		// Navigate deeper into children
		if (!msg.children?.length) return messages;
		updated[idx] = {
			...msg,
			children: mergeAtPath(msg.children, rest, toolUseId, fields),
		};
	}
	return updated;
}

/** Update a tool call using the pre-built index for O(1) lookup. Falls back to full traversal. */
export function updateToolCallByIndex(
	old: InfiniteCache,
	toolUseId: string,
	status: string,
	output: unknown | undefined,
	index: MessageIndex,
	durationMs?: number,
): InfiniteCache {
	return mergeFieldsByIndex(
		old,
		toolUseId,
		{
			status,
			outputJson: output,
			...(durationMs != null ? { durationMs } : {}),
		},
		index,
	);
}

/**
 * Merge arbitrary fields into a tool call using the pre-built index for O(1) lookup.
 * Falls back to full tree traversal when the toolUseId is not in the index.
 */
export function mergeFieldsByIndex(
	old: InfiniteCache,
	toolUseId: string,
	fields: Record<string, unknown>,
	index: MessageIndex,
): InfiniteCache {
	const entry = index.get(toolUseId);
	if (!entry) {
		// Fallback: tool was added after last index build (e.g. new message via WS)
		if (!old?.pages?.length) return old;
		let anyChanged = false;
		const pages = old.pages.map((page) => {
			const { messages, changed } = mergeToolCallFieldsInTree(page.messages, toolUseId, fields);
			if (changed) anyChanged = true;
			return changed ? { ...page, messages } : page;
		});
		return anyChanged ? { ...old, pages } : old;
	}

	if (entry.pageIdx >= old.pages.length || !old.pages[entry.pageIdx]) {
		// Index is stale (page was trimmed or removed) — fall back to full traversal
		let anyChanged = false;
		const pages = old.pages.map((page) => {
			const { messages, changed } = mergeToolCallFieldsInTree(page.messages, toolUseId, fields);
			if (changed) anyChanged = true;
			return changed ? { ...page, messages } : page;
		});
		return anyChanged ? { ...old, pages } : old;
	}
	const pages = [...old.pages];
	const page = { ...pages[entry.pageIdx] };
	page.messages = mergeAtPath(page.messages, entry.path, toolUseId, fields);
	pages[entry.pageIdx] = page;
	return { ...old, pages };
}

/**
 * Sentinel ID for synthetic streaming-tool-chunks child messages inside subagent cards.
 * Each parentToolUseId gets its own sentinel so multiple concurrent subagents don't collide.
 */
export function subagentStreamingId(parentToolUseId: string): string {
	return `__streaming_subagent_${parentToolUseId}__`;
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

/**
 * Upsert a synthetic streaming child message under a parent tool_use in the message tree.
 * Used for subagent tool_use_chunk events — the streaming tool calls appear as children
 * of the Task tool call that spawned the subagent.
 */
export function upsertSubagentStreamingChunk(
	old: InfiniteCache,
	parentToolUseId: string,
	narratorId: string,
	toolUseId: string,
	toolName: string,
	inputCharsTotal: number,
	index?: MessageIndex,
	extractedFilePath?: string,
	contentCharsReceived?: number,
	extractedFields?: Record<string, string>,
	metadata?: Record<string, unknown>,
	streamingField?: { name: string; value: string },
): InfiniteCache {
	const syntheticId = subagentStreamingId(parentToolUseId);

	// Fast path: use index to locate the parent message
	if (index) {
		const entry = index.get(parentToolUseId);
		if (entry && entry.pageIdx < old.pages.length && old.pages[entry.pageIdx]) {
			const pages = [...old.pages];
			const page = { ...pages[entry.pageIdx] };
			const { messages, changed } = upsertStreamingChildAtPath(
				page.messages,
				entry.path,
				parentToolUseId,
				syntheticId,
				narratorId,
				toolUseId,
				toolName,
				inputCharsTotal,
				extractedFilePath,
				contentCharsReceived,
				extractedFields,
				metadata,
				streamingField,
			);
			if (changed) {
				page.messages = messages;
				pages[entry.pageIdx] = page;
				return { ...old, pages };
			}
			return old;
		}
	}

	// Fallback: full tree traversal
	let anyChanged = false;
	const pages = old.pages.map((page) => {
		const { messages, changed } = upsertStreamingChildInMessages(
			page.messages,
			parentToolUseId,
			syntheticId,
			narratorId,
			toolUseId,
			toolName,
			inputCharsTotal,
			extractedFilePath,
			contentCharsReceived,
			extractedFields,
			metadata,
			streamingField,
		);
		if (changed) anyChanged = true;
		return changed ? { ...page, messages } : page;
	});
	return anyChanged ? { ...old, pages } : old;
}

/** Navigate to a message by path and upsert a streaming child on it */
function upsertStreamingChildAtPath(
	messages: TreeMessage[],
	path: number[],
	parentToolUseId: string,
	syntheticId: string,
	narratorId: string,
	toolUseId: string,
	toolName: string,
	inputCharsTotal: number,
	extractedFilePath?: string,
	contentCharsReceived?: number,
	extractedFields?: Record<string, string>,
	metadata?: Record<string, unknown>,
	streamingField?: { name: string; value: string },
): { messages: TreeMessage[]; changed: boolean } {
	if (path.length === 0) return { messages, changed: false };
	const [idx, ...rest] = path;
	const msg = messages[idx];
	if (!msg) return { messages, changed: false };

	if (rest.length === 0) {
		// This is the target message — upsert the streaming child
		return {
			messages: upsertStreamingChildOnMsg(
				messages,
				idx,
				parentToolUseId,
				syntheticId,
				narratorId,
				toolUseId,
				toolName,
				inputCharsTotal,
				extractedFilePath,
				contentCharsReceived,
				extractedFields,
				metadata,
				streamingField,
			),
			changed: true,
		};
	}
	// Navigate deeper
	if (!msg.children?.length) return { messages, changed: false };
	const childResult = upsertStreamingChildAtPath(
		msg.children,
		rest,
		parentToolUseId,
		syntheticId,
		narratorId,
		toolUseId,
		toolName,
		inputCharsTotal,
		extractedFilePath,
		contentCharsReceived,
		extractedFields,
		metadata,
		streamingField,
	);
	if (!childResult.changed) return { messages, changed: false };
	const updated = [...messages];
	updated[idx] = { ...msg, children: childResult.messages };
	return { messages: updated, changed: true };
}

/** Upsert a streaming child on a specific message (by index in its array) */
function upsertStreamingChildOnMsg(
	messages: TreeMessage[],
	msgIdx: number,
	parentToolUseId: string,
	syntheticId: string,
	narratorId: string,
	toolUseId: string,
	toolName: string,
	inputCharsTotal: number,
	extractedFilePath?: string,
	contentCharsReceived?: number,
	extractedFields?: Record<string, string>,
	metadata?: Record<string, unknown>,
	streamingField?: { name: string; value: string },
): TreeMessage[] {
	const msg = messages[msgIdx];
	const children = [...(msg.children || [])];
	const existingIdx = children.findIndex((c) => c.id === syntheticId);
	const existing = existingIdx !== -1 ? children[existingIdx] : null;

	const streamingInput: Record<string, unknown> = { _streamingChars: inputCharsTotal };
	if (extractedFilePath) streamingInput._streamingFilePath = extractedFilePath;
	if (contentCharsReceived != null) streamingInput._streamingContentChars = contentCharsReceived;
	if (extractedFields) streamingInput._streamingFields = extractedFields;
	if (metadata) streamingInput._streamingMetadata = metadata;
	if (streamingField) {
		streamingInput._streamingFieldName = streamingField.name;
		streamingInput._streamingFieldValue = streamingField.value;
	}

	const { blocks, toolCalls } = upsertStreamingToolBlock(
		existing ? [...existing.contentJson] : [],
		existing ? [...existing.toolCalls] : [],
		toolUseId,
		toolName,
		streamingInput,
	);
	const patchedToolCalls = metadata
		? toolCalls.map((tc) => (tc.toolUseId === toolUseId ? { ...tc, _metadata: metadata } : tc))
		: toolCalls;

	const syntheticChild: TreeMessage = {
		id: syntheticId,
		narratorId,
		parentToolUseId,
		role: "assistant",
		contentJson: blocks,
		contentText: null,
		toolCalls: patchedToolCalls,
		createdAt: existing?.createdAt ?? new Date().toISOString(),
		children: [],
	};

	if (existingIdx !== -1) {
		children[existingIdx] = syntheticChild;
	} else {
		children.push(syntheticChild);
	}
	const updated = [...messages];
	updated[msgIdx] = { ...msg, children };
	return updated;
}

export function upsertStreamingChildInMessages(
	messages: TreeMessage[],
	parentToolUseId: string,
	syntheticId: string,
	narratorId: string,
	toolUseId: string,
	toolName: string,
	inputCharsTotal: number,
	extractedFilePath?: string,
	contentCharsReceived?: number,
	extractedFields?: Record<string, string>,
	metadata?: Record<string, unknown>,
	streamingField?: { name: string; value: string },
): { messages: TreeMessage[]; changed: boolean } {
	if (!Array.isArray(messages)) return { messages: messages ?? [], changed: false };
	let anyChanged = false;
	const updated = messages.map((msg) => {
		// Check both persisted tool-call rows and partial contentJson blocks.
		const hasParentTool = hasToolUseInMessage(msg, parentToolUseId);
		if (hasParentTool) {
			anyChanged = true;
			const children = [...(msg.children || [])];
			const existingIdx = children.findIndex((c) => c.id === syntheticId);
			const existing = existingIdx !== -1 ? children[existingIdx] : null;

			const streamingInput: Record<string, unknown> = { _streamingChars: inputCharsTotal };
			if (extractedFilePath) streamingInput._streamingFilePath = extractedFilePath;
			if (contentCharsReceived != null)
				streamingInput._streamingContentChars = contentCharsReceived;
			if (extractedFields) streamingInput._streamingFields = extractedFields;
			if (metadata) streamingInput._streamingMetadata = metadata;
			if (streamingField) {
				streamingInput._streamingFieldName = streamingField.name;
				streamingInput._streamingFieldValue = streamingField.value;
			}

			const { blocks, toolCalls } = upsertStreamingToolBlock(
				existing ? [...existing.contentJson] : [],
				existing ? [...existing.toolCalls] : [],
				toolUseId,
				toolName,
				streamingInput,
			);
			const patchedToolCalls = metadata
				? toolCalls.map((tc) => (tc.toolUseId === toolUseId ? { ...tc, _metadata: metadata } : tc))
				: toolCalls;

			const syntheticChild: TreeMessage = {
				id: syntheticId,
				narratorId,
				parentToolUseId,
				role: "assistant",
				contentJson: blocks,
				contentText: null,
				toolCalls: patchedToolCalls,
				createdAt: existing?.createdAt ?? new Date().toISOString(),
				children: [],
			};

			if (existingIdx !== -1) {
				children[existingIdx] = syntheticChild;
			} else {
				children.push(syntheticChild);
			}
			return { ...msg, children };
		}

		// Recurse into children
		if (msg.children?.length) {
			const childResult = upsertStreamingChildInMessages(
				msg.children,
				parentToolUseId,
				syntheticId,
				narratorId,
				toolUseId,
				toolName,
				inputCharsTotal,
				extractedFilePath,
				contentCharsReceived,
				extractedFields,
				metadata,
				streamingField,
			);
			if (childResult.changed) {
				anyChanged = true;
				return { ...msg, children: childResult.messages };
			}
		}
		return msg;
	});
	return { messages: updated, changed: anyChanged };
}

/**
 * Remove synthetic streaming child messages for a given parentToolUseId from the tree.
 */
export function removeSubagentStreamingChunk(
	old: InfiniteCache,
	parentToolUseId: string,
	index?: MessageIndex,
): InfiniteCache {
	const syntheticId = subagentStreamingId(parentToolUseId);

	// Fast path: use index
	if (index) {
		const entry = index.get(parentToolUseId);
		if (entry && entry.pageIdx < old.pages.length && old.pages[entry.pageIdx]) {
			const pages = [...old.pages];
			const page = { ...pages[entry.pageIdx] };
			const { messages, changed } = removeStreamingChildAtPath(
				page.messages,
				entry.path,
				syntheticId,
			);
			if (changed) {
				page.messages = messages;
				pages[entry.pageIdx] = page;
				return { ...old, pages };
			}
			return old;
		}
	}

	// Fallback: full tree traversal
	let anyChanged = false;
	const pages = old.pages.map((page) => {
		const { messages, changed } = removeStreamingChildInMessages(
			page.messages,
			parentToolUseId,
			syntheticId,
		);
		if (changed) anyChanged = true;
		return changed ? { ...page, messages } : page;
	});
	return anyChanged ? { ...old, pages } : old;
}

/** Navigate to a message by path and remove a streaming child from it */
function removeStreamingChildAtPath(
	messages: TreeMessage[],
	path: number[],
	syntheticId: string,
): { messages: TreeMessage[]; changed: boolean } {
	if (path.length === 0) return { messages, changed: false };
	const [idx, ...rest] = path;
	const msg = messages[idx];
	if (!msg) return { messages, changed: false };

	if (rest.length === 0) {
		if (!msg.children?.some((c) => c.id === syntheticId)) {
			return { messages, changed: false };
		}
		const updated = [...messages];
		updated[idx] = { ...msg, children: msg.children.filter((c) => c.id !== syntheticId) };
		return { messages: updated, changed: true };
	}
	if (!msg.children?.length) return { messages, changed: false };
	const childResult = removeStreamingChildAtPath(msg.children, rest, syntheticId);
	if (!childResult.changed) return { messages, changed: false };
	const updated = [...messages];
	updated[idx] = { ...msg, children: childResult.messages };
	return { messages: updated, changed: true };
}

export function removeStreamingChildInMessages(
	messages: TreeMessage[],
	parentToolUseId: string,
	syntheticId: string,
): { messages: TreeMessage[]; changed: boolean } {
	if (!Array.isArray(messages)) return { messages: messages ?? [], changed: false };
	let anyChanged = false;
	const updated = messages.map((msg) => {
		const hasParentTool = hasToolUseInMessage(msg, parentToolUseId);
		if (hasParentTool && msg.children?.some((c) => c.id === syntheticId)) {
			anyChanged = true;
			return { ...msg, children: msg.children.filter((c) => c.id !== syntheticId) };
		}
		if (msg.children?.length) {
			const childResult = removeStreamingChildInMessages(
				msg.children,
				parentToolUseId,
				syntheticId,
			);
			if (childResult.changed) {
				anyChanged = true;
				return { ...msg, children: childResult.messages };
			}
		}
		return msg;
	});
	return { messages: updated, changed: anyChanged };
}

/**
 * Evict oldest pages from the cache until total message count <= maxMessages.
 * Returns the original cache if no eviction is needed.
 * Sets hasMore=true on the new last page so older messages can be re-fetched.
 */
export function evictOldestPages(old: InfiniteCache, maxMessages: number): InfiniteCache {
	if (!old?.pages?.length || old.pages.length <= 1) return old;

	let total = 0;
	let keepCount = 0;
	for (const page of old.pages) {
		total += page.messages?.length ?? 0;
		keepCount++;
		if (total >= maxMessages) break;
	}

	if (keepCount >= old.pages.length) return old;

	const pages = old.pages.slice(0, keepCount);
	// Mark the last kept page as having more older messages and restore the
	// cursor that originally fetched the first dropped page. The backend expects
	// a seq cursor here, not a message ID.
	const lastPage = { ...pages[keepCount - 1] };
	lastPage.hasMore = true;
	const firstDroppedPage = old.pages[keepCount];
	const droppedPageParam = old.pageParams?.[keepCount] as
		| string
		| { cursor?: string; direction?: "older" | "newer" }
		| undefined;
	const restoredOlderCursor =
		typeof droppedPageParam === "string"
			? droppedPageParam
			: droppedPageParam?.direction === "older"
				? droppedPageParam.cursor
				: undefined;
	if (typeof restoredOlderCursor === "string" && restoredOlderCursor.length > 0) {
		lastPage.nextCursor = restoredOlderCursor;
	} else if (
		typeof firstDroppedPage?.nextCursor === "string" &&
		firstDroppedPage.nextCursor.length > 0
	) {
		lastPage.nextCursor = firstDroppedPage.nextCursor;
	}
	pages[keepCount - 1] = lastPage;

	return {
		...old,
		pages,
		pageParams: (old.pageParams ?? []).slice(0, keepCount),
	};
}
