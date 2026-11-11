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

import { messageBody } from "@shared/narrator-blocks/message-blocks";
import { auxiliaryContentViews } from "@shared/pretext-layout/auxiliary-content";
import { isNestedRow } from "../message/nested-rows";
import type { NarratorMsg } from "../narrator-panel-types";

/**
 * Compute the set of message ids belonging to the most recent `count`
 * assistant run segments. Messages not in any of those segments (older
 * assistant output, and non-assistant messages) are absent from the set.
 *
 * The same NarratorMsg object may appear once; ids are used because the
 * renderer addresses messages by id.
 */
export function recentRunSegmentMessageIds(
	messages: NarratorMsg[],
	count = 2,
	opts?: { compactAuxiliaryContent?: boolean },
): Set<string> {
	const result = new Set<string>();
	if (messages.length === 0 || count <= 0) return result;

	// Walk from the end, collecting assistant runs. A run boundary is a
	// non-assistant message; we keep collecting assistant messages into the
	// current run until we hit a boundary, then close that run.
	let runsCollected = 0;
	let inRun = false;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		// A nested row is not part of the conversation's runs.
		if (isNestedRow(msg)) continue;
		const auxiliary = opts?.compactAuxiliaryContent ? auxiliaryContentViews(msg) : [];
		const owned = new Set(auxiliary.flatMap((view) => view.sourceIndices));
		const auxiliaryOnly =
			auxiliary.length > 0 &&
			messageBody(msg).every(
				(block, index) => owned.has(index) || (block.type === "text" && !block.text?.trim()),
			);
		if (msg.role === "assistant" || auxiliaryOnly) {
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
