import type { MessagesPage, NarratorMsg } from "./narrator-panel-types";

function messageSeq(msg: NarratorMsg): number | undefined {
	return typeof msg.seq === "number" && Number.isFinite(msg.seq) ? msg.seq : undefined;
}

function messageTime(msg: NarratorMsg): number {
	const t = Date.parse(msg.createdAt);
	return Number.isFinite(t) ? t : 0;
}

function compareMessagesByStableOrder(a: NarratorMsg, b: NarratorMsg): number {
	const aSeq = messageSeq(a);
	const bSeq = messageSeq(b);
	if (aSeq != null && bSeq != null && aSeq !== bSeq) return aSeq - bSeq;

	const timeDiff = messageTime(a) - messageTime(b);
	if (timeDiff !== 0) return timeDiff;

	return a.id.localeCompare(b.id);
}

/**
 * Infinite-query pages are stored newest-page first, while the UI renders old → new.
 * A live message can be appended to an around-window page before omitted newer
 * history is fetched, making the reversed page order contain a seq regression.
 */
export function hasRenderableMessageOrderAnomaly(pages: readonly MessagesPage[]): boolean {
	const seenIds = new Set<string>();
	let previousSeq: number | undefined;

	for (let pageIndex = pages.length - 1; pageIndex >= 0; pageIndex--) {
		const page = pages[pageIndex];
		for (const msg of page.messages ?? []) {
			if (seenIds.has(msg.id)) return true;
			seenIds.add(msg.id);

			const seq = messageSeq(msg);
			if (seq == null) continue;
			if (previousSeq != null && seq <= previousSeq) return true;
			previousSeq = seq;
		}
	}

	return false;
}

export function getRenderableMessageOrder(pages: readonly MessagesPage[]): {
	messages: NarratorMsg[];
	normalized: boolean;
} {
	const visualOrder = pages
		.map((page) => page.messages ?? [])
		.reverse()
		.flat();

	if (!hasRenderableMessageOrderAnomaly(pages)) {
		return { messages: visualOrder, normalized: false };
	}

	const byId = new Map<string, NarratorMsg>();
	// Pages are newest-first in the query cache. Prefer the first copy so live WS
	// updates in the newest page win over stale duplicates in older pages.
	for (const page of pages) {
		for (const msg of page.messages ?? []) {
			if (!byId.has(msg.id)) byId.set(msg.id, msg);
		}
	}

	return {
		messages: [...byId.values()].sort(compareMessagesByStableOrder),
		normalized: true,
	};
}
