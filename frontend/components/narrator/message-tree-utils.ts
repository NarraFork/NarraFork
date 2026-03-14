/**
 * Pure utility functions for operating on the message tree cache.
 * Used by NarratorPanel's WebSocket handlers to immutably update
 * React Query's cached message pages.
 */

import type {
	BaseContentBlock,
	ContentBlock,
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
		return { ...block, ...fields } as ContentBlock;
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
		// This is the target message — append child
		if (msg.children?.some((c) => c.id === childMsg.id)) {
			return { messages, changed: false };
		}
		const updated = [...messages];
		updated[idx] = { ...msg, children: [...(msg.children || []), childMsg] };
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

function insertChildIntoMessages(
	messages: TreeMessage[],
	childMsg: TreeMessage,
): { messages: TreeMessage[]; changed: boolean } {
	if (!Array.isArray(messages)) return { messages: messages ?? [], changed: false };
	let anyChanged = false;
	const updated = messages.map((msg) => {
		// Check if this message contains the parent tool call
		const hasParentTool = (msg.toolCalls as ToolCall[])?.some(
			(tc) => tc.toolUseId === childMsg.parentToolUseId,
		);
		if (hasParentTool) {
			if (msg.children?.some((c) => c.id === childMsg.id)) return msg;
			anyChanged = true;
			return { ...msg, children: [...(msg.children || []), childMsg] };
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

/** Recursively merge extra fields into a tool call's record in the message tree */
export function mergeToolCallFieldsInTree(
	messages: TreeMessage[],
	toolUseId: string,
	fields: Record<string, unknown>,
): { messages: TreeMessage[]; changed: boolean } {
	if (!Array.isArray(messages)) return { messages: messages ?? [], changed: false };
	let anyChanged = false;
	const updated = messages.map((msg) => {
		let result = msg;
		if ((msg.toolCalls as ToolCall[])?.length) {
			let tcChanged = false;
			const updatedCalls = (msg.toolCalls as ToolCall[]).map((tc) => {
				if (tc.toolUseId !== toolUseId) return tc;
				tcChanged = true;
				return { ...tc, ...fields };
			});
			if (tcChanged) {
				anyChanged = true;
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

/** Find a message in the tree that contains a tool call with the given toolUseId */
export function findMsgByToolUseIdInTree(
	messages: TreeMessage[],
	toolUseId: string,
): TreeMessage | null {
	if (!Array.isArray(messages)) return null;
	for (const msg of messages) {
		if ((msg.toolCalls as ToolCall[])?.some((tc) => tc.toolUseId === toolUseId)) return msg;
		if (msg.children?.length) {
			const found = findMsgByToolUseIdInTree(msg.children, toolUseId);
			if (found) return found;
		}
	}
	return null;
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
		// This is the target message — update its toolCalls
		if (!(msg.toolCalls as ToolCall[])?.length) return messages;
		let tcChanged = false;
		const updatedCalls = (msg.toolCalls as ToolCall[]).map((tc) => {
			if (tc.toolUseId !== toolUseId) return tc;
			tcChanged = true;
			// For outputJson, keep existing value if the new one is undefined
			const merged = { ...tc, ...fields };
			if (fields.outputJson === undefined) merged.outputJson = tc.outputJson;
			return merged;
		});
		if (!tcChanged) return messages;
		// Also update the enriched tool_use block in contentJson so that
		// resolveAllToolCallsFromMsg (which reads from contentJson first)
		// picks up the new status/output/etc.
		let enrichedContent = msg.contentJson;
		if (Array.isArray(enrichedContent)) {
			let contentChanged = false;
			enrichedContent = enrichedContent.map((block) => {
				if (block.type !== "tool_use" || block.id !== toolUseId) return block;
				contentChanged = true;
				const merged: BaseContentBlock = { ...block, ...fields };
				if (fields.outputJson === undefined) merged.outputJson = block.outputJson;
				return merged;
			});
			if (!contentChanged) enrichedContent = msg.contentJson;
		}
		updated[idx] = {
			...msg,
			toolCalls: updatedCalls as ToolCallRecord[],
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
): TreeMessage[] {
	const msg = messages[msgIdx];
	const children = [...(msg.children || [])];
	const existingIdx = children.findIndex((c) => c.id === syntheticId);
	const existing = existingIdx !== -1 ? children[existingIdx] : null;

	const streamingInput: Record<string, unknown> = { _streamingChars: inputCharsTotal };
	if (extractedFilePath) streamingInput._streamingFilePath = extractedFilePath;
	if (contentCharsReceived != null) streamingInput._streamingContentChars = contentCharsReceived;

	const { blocks, toolCalls } = upsertStreamingToolBlock(
		existing ? [...existing.contentJson] : [],
		existing ? [...existing.toolCalls] : [],
		toolUseId,
		toolName,
		streamingInput,
	);

	const syntheticChild: TreeMessage = {
		id: syntheticId,
		narratorId,
		parentToolUseId,
		role: "assistant",
		contentJson: blocks,
		contentText: null,
		toolCalls: toolCalls,
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

function upsertStreamingChildInMessages(
	messages: TreeMessage[],
	parentToolUseId: string,
	syntheticId: string,
	narratorId: string,
	toolUseId: string,
	toolName: string,
	inputCharsTotal: number,
	extractedFilePath?: string,
	contentCharsReceived?: number,
): { messages: TreeMessage[]; changed: boolean } {
	if (!Array.isArray(messages)) return { messages: messages ?? [], changed: false };
	let anyChanged = false;
	const updated = messages.map((msg) => {
		// Check if this message contains the parent tool call
		const hasParentTool = (msg.toolCalls as ToolCall[])?.some(
			(tc) => tc.toolUseId === parentToolUseId,
		);
		if (hasParentTool) {
			anyChanged = true;
			const children = [...(msg.children || [])];
			const existingIdx = children.findIndex((c) => c.id === syntheticId);
			const existing = existingIdx !== -1 ? children[existingIdx] : null;

			const streamingInput: Record<string, unknown> = { _streamingChars: inputCharsTotal };
			if (extractedFilePath) streamingInput._streamingFilePath = extractedFilePath;
			if (contentCharsReceived != null)
				streamingInput._streamingContentChars = contentCharsReceived;

			const { blocks, toolCalls } = upsertStreamingToolBlock(
				existing ? [...existing.contentJson] : [],
				existing ? [...existing.toolCalls] : [],
				toolUseId,
				toolName,
				streamingInput,
			);

			const syntheticChild: TreeMessage = {
				id: syntheticId,
				narratorId,
				parentToolUseId,
				role: "assistant",
				contentJson: blocks,
				contentText: null,
				toolCalls: toolCalls,
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

function removeStreamingChildInMessages(
	messages: TreeMessage[],
	parentToolUseId: string,
	syntheticId: string,
): { messages: TreeMessage[]; changed: boolean } {
	if (!Array.isArray(messages)) return { messages: messages ?? [], changed: false };
	let anyChanged = false;
	const updated = messages.map((msg) => {
		const hasParentTool = (msg.toolCalls as ToolCall[])?.some(
			(tc) => tc.toolUseId === parentToolUseId,
		);
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
	// Mark the last kept page as having more older messages
	const lastPage = { ...pages[keepCount - 1] };
	lastPage.hasMore = true;
	// Derive nextCursor from the oldest message in the last kept page
	const oldestMsg = lastPage.messages?.[0];
	if (oldestMsg) {
		lastPage.nextCursor = oldestMsg.id;
	}
	pages[keepCount - 1] = lastPage;

	return {
		...old,
		pages,
		pageParams: (old.pageParams ?? []).slice(0, keepCount),
	};
}
