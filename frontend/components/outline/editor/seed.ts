/**
 * Read-only first (design §6.10): an HTTP read of a block as the live client takes it, and
 * whether the page it shows can be edited live at all. Pure: no DOM, no requests.
 */
import type { OutlineBlockViewResponse } from "@shared/outline-api";
import { LIVE_TASK_OF_STATUS, OUTLINE_LIVE_LIMITS } from "@shared/outline-live-protocol";
import type { SeedBlock } from "./live-client";

/** The blocks of an HTTP read as the live client takes them. */
export function seedBlocksOf(read: OutlineBlockViewResponse): SeedBlock[] {
	return read.blocks.map((b) => ({
		id: b.id,
		parentId: b.parentId,
		sid: b.sid,
		content: b.content,
		task: b.task ? LIVE_TASK_OF_STATUS[b.task.status] : null,
		childIds: b.childIds,
	}));
}

/**
 * Whether a read shows a page that can be edited live (PR8's limits): only then is typing taken
 * while it connects. Its size in bytes is not in the read: a page over that bound is refused when
 * it joins, and what was typed is then shown to copy (`OutlineEditor`'s unsaved notice).
 */
export function readCanGoLive(read: OutlineBlockViewResponse): boolean {
	return (
		read.current && !read.pageTruncated && read.pageBlocks <= OUTLINE_LIVE_LIMITS.maxPageBlocks
	);
}
