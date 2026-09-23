/**
 * exact-streaming-accumulator.ts — the exact shell's view of the shared text /
 * reasoning delta fold.
 *
 * The fold itself moved to `../streaming/streaming-delta-fold.ts` so the ALWAYS-ON chunked path
 * can share it: that path may not statically import `vlist/` (see
 * `vlist-isolation.guard.test.ts` — with the flag off, vlist code must never even be
 * fetched), while vlist importing outward is fine. Two copies of the fold is how the
 * two lists drift, and the live-lane stamp is precisely the kind of state that must
 * not: it decides when a reasoning run settles.
 *
 * This module is kept as the vlist-facing name so the shell and its tests keep one
 * stable import site.
 */

export type {
	StreamDeltaEvent,
	StreamDeltaResult,
} from "../streaming/streaming-delta-fold";

import type { StreamingBlock } from "../message/message-segments";
import {
	applyStreamingDelta,
	applyStreamingSnapshotBlocks,
	type StreamDeltaEvent,
	type StreamDeltaResult,
} from "../streaming/streaming-delta-fold";

/** Fold one `content_block_delta` into `blocks` (see applyStreamingDelta). */
export function applyExactStreamDelta(
	blocks: StreamingBlock[],
	event: StreamDeltaEvent | undefined,
	isSubagent: boolean,
): StreamDeltaResult {
	return applyStreamingDelta(blocks, event, isSubagent);
}

/** Merge a reconnect snapshot into `blocks`; returns true when anything changed. */
export function applyExactStreamingSnapshot(
	blocks: StreamingBlock[],
	snapshotBlocks: StreamingBlock[],
): boolean {
	return applyStreamingSnapshotBlocks(blocks, snapshotBlocks);
}

/**
 * Snapshot provenance/revision changes still need publishing, but only accepted
 * text changes reset the animation baseline. Keep references to the old strings
 * (not blocks, which the fold can mutate); no extra body copy or parsing.
 */
export function applyExactStreamingSnapshotUpdate(
	blocks: StreamingBlock[],
	snapshotBlocks: StreamingBlock[],
): { changed: boolean; textChanged: boolean } {
	const before = snapshotAnimationText(blocks);
	const changed = applyExactStreamingSnapshot(blocks, snapshotBlocks);
	if (!changed) return { changed: false, textChanged: false };
	const after = snapshotAnimationText(blocks);
	return {
		changed,
		textChanged:
			before.length !== after.length ||
			after.some((block, index) => {
				const previous = before[index];
				return (
					previous?.type !== block.type ||
					previous?.id !== block.id ||
					previous?.text !== block.text
				);
			}),
	};
}

function snapshotAnimationText(blocks: readonly StreamingBlock[]) {
	return blocks.flatMap((block) =>
		block.type === "text" || block.type === "reasoning"
			? [{ type: block.type, id: block.id, text: block.text }]
			: [],
	);
}
