/**
 * React Query cache maintenance for the paged narrator-messages query.
 *
 * Extracted from MessageBubble.tsx so every message-list surface (and action
 * handlers that live outside any component) prunes deleted messages through one
 * implementation.
 */

import type { QueryClient } from "@tanstack/react-query";

type MessagesCacheMessage = { id?: string };
type MessagesCachePage = { messages?: MessagesCacheMessage[] } & Record<string, unknown>;
type MessagesCacheData = { pages?: MessagesCachePage[] } & Record<string, unknown>;

/**
 * Prune deleted messages from the paged messages query cache.
 *
 * Shared because the exact vlist's error-notice dismissal needs the same cache
 * pruning (its rows are zero-DOM copies and cannot own this logic themselves) —
 * one implementation keeps both list renderers consistent.
 */
export function removeMessagesFromCache(
	qc: QueryClient,
	narratorId: string,
	deletedMessageIds: string[],
) {
	if (deletedMessageIds.length === 0) return;
	const deletedSet = new Set(deletedMessageIds);
	qc.setQueriesData({ queryKey: ["narrators", narratorId, "messages"] }, (old: unknown) => {
		if (!old || typeof old !== "object") return old;
		const data = old as MessagesCacheData;
		if (!Array.isArray(data.pages)) return old;
		let changed = false;
		const pages = data.pages.map((page) => {
			if (!Array.isArray(page.messages)) return page;
			const messages = page.messages.filter((msg) => !msg.id || !deletedSet.has(msg.id));
			if (messages.length === page.messages.length) return page;
			changed = true;
			return { ...page, messages };
		});
		return changed ? { ...data, pages } : old;
	});
}
