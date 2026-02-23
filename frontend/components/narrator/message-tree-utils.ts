/**
 * Pure utility functions for operating on the message tree cache.
 * Used by NarratorPanel's WebSocket handlers to immutably update
 * React Query's cached message pages.
 */

import type { ContentBlock, ToolCallRecord, TreeMessage } from "@frontend/lib/api";

interface ToolCall {
	toolUseId: string;
	status?: string;
	outputJson?: unknown;
	[key: string]: unknown;
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
export function insertChildIntoCache(old: InfiniteCache, childMsg: TreeMessage): InfiniteCache {
	let anyChanged = false;
	const pages = old.pages.map((page) => {
		const { messages, changed } = insertChildIntoMessages(page.messages, childMsg);
		if (changed) anyChanged = true;
		return changed ? { ...page, messages } : page;
	});
	return anyChanged ? { ...old, pages } : old;
}

function insertChildIntoMessages(
	messages: TreeMessage[],
	childMsg: TreeMessage,
): { messages: TreeMessage[]; changed: boolean } {
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
				result = { ...result, toolCalls: updatedCalls };
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
				result = { ...result, toolCalls: updatedCalls };
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

/** Navigate to a message by path and update its tool call immutably */
function updateAtPath(
	messages: TreeMessage[],
	path: number[],
	toolUseId: string,
	status: string,
	output: unknown | undefined,
	durationMs?: number,
): TreeMessage[] {
	if (path.length === 0) return messages;
	const [idx, ...rest] = path;
	const updated = [...messages];
	const msg = updated[idx];
	if (!msg) return messages;

	if (rest.length === 0) {
		// This is the target message — update its toolCalls
		if (!(msg.toolCalls as ToolCall[])?.length) return messages;
		const updatedCalls = (msg.toolCalls as ToolCall[]).map((tc) => {
			if (tc.toolUseId !== toolUseId) return tc;
			return {
				...tc,
				status,
				outputJson: output ?? tc.outputJson,
				...(durationMs != null ? { durationMs } : {}),
			};
		});
		updated[idx] = { ...msg, toolCalls: updatedCalls };
	} else {
		// Navigate deeper into children
		if (!msg.children?.length) return messages;
		updated[idx] = {
			...msg,
			children: updateAtPath(msg.children, rest, toolUseId, status, output, durationMs),
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
	const entry = index.get(toolUseId);
	if (!entry) {
		// Fallback: tool was added after last index build (e.g. new message via WS)
		if (!old?.pages?.length) return old;
		let anyChanged = false;
		const pages = old.pages.map((page) => {
			const { messages, changed } = updateToolCallInTree(
				page.messages,
				toolUseId,
				status,
				output,
				durationMs,
			);
			if (changed) anyChanged = true;
			return changed ? { ...page, messages } : page;
		});
		return anyChanged ? { ...old, pages } : old;
	}

	const pages = [...old.pages];
	const page = { ...pages[entry.pageIdx] };
	page.messages = updateAtPath(page.messages, entry.path, toolUseId, status, output, durationMs);
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
): InfiniteCache {
	const syntheticId = subagentStreamingId(parentToolUseId);

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
		);
		if (changed) anyChanged = true;
		return changed ? { ...page, messages } : page;
	});
	return anyChanged ? { ...old, pages } : old;
}

function upsertStreamingChildInMessages(
	messages: TreeMessage[],
	parentToolUseId: string,
	syntheticId: string,
	narratorId: string,
	toolUseId: string,
	toolName: string,
	inputCharsTotal: number,
): { messages: TreeMessage[]; changed: boolean } {
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

			// Build updated content blocks and tool calls
			const prevBlocks: ContentBlock[] = existing
				? [...(existing.contentJson as ContentBlock[])]
				: [];
			const prevToolCalls: ToolCallRecord[] = existing
				? [...(existing.toolCalls as ToolCallRecord[])]
				: [];

			const blockIdx = prevBlocks.findIndex(
				(b: ContentBlock) => b.type === "tool_use" && b.id === toolUseId,
			);
			if (blockIdx === -1) {
				prevBlocks.push({ type: "tool_use", id: toolUseId, name: toolName, input: {} });
				prevToolCalls.push({
					toolUseId,
					toolName,
					inputJson: {},
					status: "initializing",
					createdAt: new Date().toISOString(),
				} as ToolCallRecord);
			}
			const tcIdx = prevToolCalls.findIndex((tc: ToolCallRecord) => tc.toolUseId === toolUseId);
			if (tcIdx !== -1) {
				prevToolCalls[tcIdx] = {
					...prevToolCalls[tcIdx],
					inputJson: { _streamingChars: inputCharsTotal },
				};
			}

			const syntheticChild: TreeMessage = {
				id: syntheticId,
				narratorId,
				parentToolUseId,
				role: "assistant",
				contentJson: prevBlocks,
				contentText: null,
				toolCalls: prevToolCalls,
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
): InfiniteCache {
	const syntheticId = subagentStreamingId(parentToolUseId);
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

function removeStreamingChildInMessages(
	messages: TreeMessage[],
	parentToolUseId: string,
	syntheticId: string,
): { messages: TreeMessage[]; changed: boolean } {
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
