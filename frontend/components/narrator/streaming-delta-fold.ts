/**
 * streaming-delta-fold.ts — The ONE text/reasoning delta fold, shared by both
 * message lists.
 *
 * Why it lives here rather than in vlist/
 * --------------------------------------
 * This started as a deliberately narrow copy inside `vlist/`, next to the exact
 * shell that needed it, while `useNarratorChunksWS` kept its own inline copy. Two
 * copies of the same fold is exactly how the two lists drift: the live-lane stamp
 * (`blockIndex`, see @shared/pretext-layout/streaming-live-blocks) has to be derived
 * identically on both paths or the same turn settles its reasoning at different
 * moments depending on which list the reader has enabled.
 *
 * It cannot live in `vlist/` for the shared version: the always-on chunked path may
 * not statically import vlist (`vlist-isolation.guard.test.ts` — the OFF path must
 * never even fetch vlist code). vlist importing OUTWARD is fine, so the fold sits
 * here and `vlist/exact-streaming-accumulator.ts` re-exports it.
 *
 * Pure: mutates the passed `blocks` array and returns what changed. No WS, no React,
 * no DOM.
 */

import {
	findStreamingInsertIndex,
	getStreamingBlockOutputIndex,
	mergeStreamingSnapshotBlocks,
	type StreamingBlock,
} from "./message-segments";
import { appendStreamingTextPreview } from "./narrator-message-helpers";

/** A decoded `content_block_delta` stream event (the shape onStreamEvent passes). */
export interface StreamDeltaEvent {
	type?: unknown;
	subagentToolUseId?: unknown;
	outputIndex?: unknown;
	delta?: {
		type?: unknown;
		text?: unknown;
		id?: unknown;
		outputIndex?: unknown;
	};
}

/**
 * What a delta did, including WHERE it landed.
 *
 * The index is what lets the caller stamp the row with the lane still being written.
 * Array position cannot be derived later: `buildStreamingMsg` appends the live tool
 * cards after the text lanes whatever order the provider used, so a reasoning block
 * the model reopened after a tool call sits in the middle of the published row.
 */
export interface StreamDeltaResult {
	/** True when a text or reasoning delta was applied (bump the render version). */
	applied: boolean;
	/**
	 * Index in `blocks` the delta landed in, or -1 when nothing was applied.
	 *
	 * ⚠️ VALID ONLY FOR THE ARRAY AS IT STANDS AFTER THIS FOLD. A later delta with a
	 * lower `outputIndex` splices a block in ahead of this one, and every index from
	 * the insertion point onwards then names a different block. So this must be
	 * consumed (or re-stamped) immediately; it is not a durable handle.
	 *
	 * Both callers satisfy that by overwriting their `liveBlockIndexRef` after every
	 * applied delta, which is a property of their call order rather than of this
	 * type — hence the warning.
	 */
	blockIndex: number;
}

const NOT_APPLIED: StreamDeltaResult = { applied: false, blockIndex: -1 };

/**
 * Fold a single content_block_delta into `blocks`.
 *
 * `isSubagent` mirrors the legacy guard: on a top-level page, deltas that still
 * carry a subagentToolUseId belong to a child stream and are ignored.
 */
export function applyStreamingDelta(
	blocks: StreamingBlock[],
	event: StreamDeltaEvent | undefined,
	isSubagent: boolean,
): StreamDeltaResult {
	if (!event || event.type !== "content_block_delta") return NOT_APPLIED;
	if (!isSubagent && event.subagentToolUseId) return NOT_APPLIED;
	const delta = event.delta;
	const deltaText = typeof delta?.text === "string" ? delta.text : "";
	if (!delta || !deltaText) return NOT_APPLIED;

	if (delta.type === "text_delta") {
		const outputIndex = typeof event.outputIndex === "number" ? event.outputIndex : undefined;
		const existingIdx =
			outputIndex != null
				? blocks.findIndex((b) => b.type === "text" && b.outputIndex === outputIndex)
				: -1;
		if (existingIdx !== -1) {
			const existing = blocks[existingIdx];
			if (existing.type === "text") {
				existing.text = appendStreamingTextPreview(existing.text, deltaText);
			}
			return { applied: true, blockIndex: existingIdx };
		}
		if (outputIndex == null) {
			// An UN-INDEXED delta belongs to the un-indexed text lane, so match on that
			// rather than on "the array happens to end with a text block".
			//
			// The positional version merged across lanes: `findStreamingInsertIndex` keeps
			// indexed blocks in index order and appends un-indexed ones at the end, so in a
			// mixed stream — provider emits `text(0)`, then a compatibility relay emits a
			// bare `text_delta.text` (see anthropic-provider's note on relays that stream a
			// block with no index) — the array's last block IS the indexed one, and two
			// different outputs were concatenated into a single block.
			//
			// Symmetric with the reasoning branch's `!b.id && b.outputIndex == null`.
			const bareIdx = blocks.findIndex(
				(b) => b.type === "text" && getStreamingBlockOutputIndex(b) == null,
			);
			if (bareIdx !== -1) {
				const bare = blocks[bareIdx];
				if (bare.type === "text") {
					bare.text = appendStreamingTextPreview(bare.text, deltaText);
				}
				return { applied: true, blockIndex: bareIdx };
			}
		}
		const insertAt = findStreamingInsertIndex(blocks, outputIndex);
		blocks.splice(insertAt, 0, {
			type: "text",
			text: appendStreamingTextPreview("", deltaText),
			...(outputIndex != null ? { outputIndex } : {}),
		});
		return { applied: true, blockIndex: insertAt };
	}

	if (delta.type === "reasoning_delta") {
		const reasoningId = typeof delta.id === "string" && delta.id.length > 0 ? delta.id : undefined;
		const outputIndex = typeof delta.outputIndex === "number" ? delta.outputIndex : undefined;
		const existingIdx = blocks.findIndex((b) => {
			if (b.type !== "reasoning") return false;
			if (reasoningId) return b.id === reasoningId;
			if (outputIndex != null) return b.outputIndex === outputIndex;
			return !b.id && b.outputIndex == null;
		});
		if (existingIdx !== -1) {
			const existing = blocks[existingIdx];
			if (existing.type === "reasoning") {
				existing.text = appendStreamingTextPreview(existing.text, deltaText);
				if (reasoningId) existing.id = reasoningId;
				if (outputIndex != null) existing.outputIndex = outputIndex;
			}
			return { applied: true, blockIndex: existingIdx };
		}
		const insertAt = findStreamingInsertIndex(blocks, outputIndex);
		blocks.splice(insertAt, 0, {
			type: "reasoning",
			text: appendStreamingTextPreview("", deltaText),
			...(reasoningId ? { id: reasoningId } : {}),
			...(outputIndex != null ? { outputIndex } : {}),
		});
		return { applied: true, blockIndex: insertAt };
	}

	return NOT_APPLIED;
}

/** Merge a reconnect snapshot into `blocks`; returns true when anything changed. */
export function applyStreamingSnapshotBlocks(
	blocks: StreamingBlock[],
	snapshotBlocks: StreamingBlock[],
): boolean {
	if (snapshotBlocks.length === 0) return false;
	return mergeStreamingSnapshotBlocks(blocks, snapshotBlocks);
}
