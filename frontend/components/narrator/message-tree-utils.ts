/**
 * Pure utility functions for operating on the message tree cache.
 * Used by NarratorPanel's WebSocket handlers to immutably update
 * React Query's cached message pages.
 */

/** Insert a child message into the correct parent's children array in the cache */
export function insertChildIntoCache(old: any, childMsg: any): any {
	const pages = old.pages.map((page: any) => {
		const { messages, changed } = insertChildIntoMessages(page.messages, childMsg);
		return changed ? { ...page, messages } : page;
	});
	return { ...old, pages };
}

function insertChildIntoMessages(
	messages: any[],
	childMsg: any,
): { messages: any[]; changed: boolean } {
	let anyChanged = false;
	const updated = messages.map((msg: any) => {
		// Check if this message contains the parent tool call
		const hasParentTool = msg.toolCalls?.some(
			(tc: any) => tc.toolUseId === childMsg.parentToolUseId,
		);
		if (hasParentTool) {
			if (msg.children?.some((c: any) => c.id === childMsg.id)) return msg;
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
	messages: any[],
	toolUseId: string,
	fields: Record<string, unknown>,
): { messages: any[]; changed: boolean } {
	let anyChanged = false;
	const updated = messages.map((msg: any) => {
		let result = msg;
		if (msg.toolCalls?.length) {
			let tcChanged = false;
			const updatedCalls = msg.toolCalls.map((tc: any) => {
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
	messages: any[],
	toolUseId: string,
	status: string,
	output?: unknown,
): { messages: any[]; changed: boolean } {
	let anyChanged = false;
	const updated = messages.map((msg: any) => {
		let msgChanged = false;
		let result = msg;

		// Update toolCalls on this message
		if (msg.toolCalls?.length) {
			const updatedCalls = msg.toolCalls.map((tc: any) => {
				if (tc.toolUseId !== toolUseId) return tc;
				msgChanged = true;
				return { ...tc, status, outputJson: output ?? tc.outputJson };
			});
			if (msgChanged) {
				anyChanged = true;
				result = { ...result, toolCalls: updatedCalls };
			}
		}

		// Recurse into children
		if (msg.children?.length) {
			const childResult = updateToolCallInTree(msg.children, toolUseId, status, output);
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
export function findMsgByToolUseIdInTree(messages: any[], toolUseId: string): any | null {
	for (const msg of messages) {
		if (msg.toolCalls?.some((tc: any) => tc.toolUseId === toolUseId)) return msg;
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
export function buildToolUseIndex(pages: any[]): MessageIndex {
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
	prevPages: any[],
	newPages: any[],
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

function indexMessages(messages: any[], pageIdx: number, path: number[], index: MessageIndex) {
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.toolCalls) {
			for (const tc of msg.toolCalls) {
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
	messages: any[],
	path: number[],
	toolUseId: string,
	status: string,
	output: unknown | undefined,
): any[] {
	if (path.length === 0) return messages;
	const [idx, ...rest] = path;
	const updated = [...messages];
	const msg = updated[idx];
	if (!msg) return messages;

	if (rest.length === 0) {
		// This is the target message — update its toolCalls
		if (!msg.toolCalls?.length) return messages;
		const updatedCalls = msg.toolCalls.map((tc: any) => {
			if (tc.toolUseId !== toolUseId) return tc;
			return { ...tc, status, outputJson: output ?? tc.outputJson };
		});
		updated[idx] = { ...msg, toolCalls: updatedCalls };
	} else {
		// Navigate deeper into children
		if (!msg.children?.length) return messages;
		updated[idx] = {
			...msg,
			children: updateAtPath(msg.children, rest, toolUseId, status, output),
		};
	}
	return updated;
}

/** Update a tool call using the pre-built index for O(1) lookup. Falls back to full traversal. */
export function updateToolCallByIndex(
	old: any,
	toolUseId: string,
	status: string,
	output: unknown | undefined,
	index: MessageIndex,
): any {
	const entry = index.get(toolUseId);
	if (!entry) {
		// Fallback: tool was added after last index build (e.g. new message via WS)
		if (!old?.pages?.length) return old;
		let anyChanged = false;
		const pages = old.pages.map((page: any) => {
			const { messages, changed } = updateToolCallInTree(page.messages, toolUseId, status, output);
			if (changed) anyChanged = true;
			return changed ? { ...page, messages } : page;
		});
		return anyChanged ? { ...old, pages } : old;
	}

	const pages = [...old.pages];
	const page = { ...pages[entry.pageIdx] };
	page.messages = updateAtPath(page.messages, entry.path, toolUseId, status, output);
	pages[entry.pageIdx] = page;
	return { ...old, pages };
}

/** Merge a permission request into a tool call's permissionRequests array in the cache */
export function mergePermissionIntoToolCall(
	old: any,
	toolUseId: string,
	permissionRequest: { id: string; toolName: string; inputJson: unknown },
	index: MessageIndex,
): any {
	const fields = {
		permissionRequests: [{ ...permissionRequest, decision: "pending" }],
	};
	const entry = index.get(toolUseId);
	if (!entry) {
		// Fallback: full traversal
		if (!old?.pages?.length) return old;
		let anyChanged = false;
		const pages = old.pages.map((page: any) => {
			const { messages, changed } = mergeToolCallFieldsInTree(
				page.messages,
				toolUseId,
				fields,
			);
			if (changed) anyChanged = true;
			return changed ? { ...page, messages } : page;
		});
		return anyChanged ? { ...old, pages } : old;
	}
	// Use indexed path for O(1) lookup
	const pages = [...old.pages];
	const page = { ...pages[entry.pageIdx] };
	page.messages = mergeFieldsAtPath(page.messages, entry.path, toolUseId, fields);
	pages[entry.pageIdx] = page;
	return { ...old, pages };
}

/** Navigate to a message by path and merge fields into its tool call immutably */
function mergeFieldsAtPath(
	messages: any[],
	path: number[],
	toolUseId: string,
	fields: Record<string, unknown>,
): any[] {
	if (path.length === 0) return messages;
	const [idx, ...rest] = path;
	const updated = [...messages];
	const msg = updated[idx];
	if (!msg) return messages;

	if (rest.length === 0) {
		if (!msg.toolCalls?.length) return messages;
		const updatedCalls = msg.toolCalls.map((tc: any) => {
			if (tc.toolUseId !== toolUseId) return tc;
			return { ...tc, ...fields };
		});
		updated[idx] = { ...msg, toolCalls: updatedCalls };
	} else {
		if (!msg.children?.length) return messages;
		updated[idx] = {
			...msg,
			children: mergeFieldsAtPath(msg.children, rest, toolUseId, fields),
		};
	}
	return updated;
}
