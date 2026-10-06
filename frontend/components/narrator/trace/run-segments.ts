/**
 * run-segments.ts — Partition a flat message list into assistant "run
 * segments" for LOD recency scoping.
 *
 * An assistant run segment is a maximal stretch of assistant activity. A new
 * segment starts at the first assistant message that follows a non-assistant
 * (user / system / etc.) message; consecutive assistant messages belong to the
 * same segment. The "current + previous request" recency window used by L5 is
 * simply the LAST TWO run segments in the list.
 */

import type { NarratorMsg } from "../narrator-panel-types";

/**
 * Compute the set of message ids belonging to the most recent `count`
 * assistant run segments. Messages not in any of those segments (older
 * assistant output, and non-assistant messages) are absent from the set.
 *
 * The same NarratorMsg object may appear once; ids are used because the
 * renderer addresses messages by id.
 */
export function recentRunSegmentMessageIds(messages: NarratorMsg[], count = 2): Set<string> {
	const result = new Set<string>();
	if (messages.length === 0 || count <= 0) return result;

	// Walk from the end, collecting assistant runs. A run boundary is a
	// non-assistant message; we keep collecting assistant messages into the
	// current run until we hit a boundary, then close that run.
	let runsCollected = 0;
	let inRun = false;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			inRun = true;
			if (runsCollected < count && msg.id) {
				result.add(msg.id);
			}
			continue;
		}
		// Non-assistant message: closes any open run.
		if (inRun) {
			inRun = false;
			runsCollected++;
			if (runsCollected >= count) break;
		}
	}
	return result;
}
