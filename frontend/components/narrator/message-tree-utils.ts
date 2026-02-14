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
