/**
 * exact-streaming-accumulator.ts — pure text/reasoning streaming-block folding
 * for the exact-layout shell's live tail.
 *
 * This is a deliberately narrow copy of the useNarratorChunksWS text/reasoning
 * accumulation (it does NOT handle live tool-call chunks): the band renderer it
 * replaces only surfaces a plain text tail, so text + reasoning parity is enough
 * to retire the band path for the active state. Keeping the fold here (pure,
 * mutation-on-a-passed-array) makes it unit-testable with no WS or React.
 *
 * All functions mutate the passed `blocks` array in place and return whether the
 * caller should bump its render version (mirrors the ref + rAF pattern).
 */

import {
	findStreamingInsertIndex,
	mergeStreamingSnapshotBlocks,
	type StreamingBlock,
} from "../message-segments";
import { appendStreamingTextPreview } from "../narrator-message-helpers";

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
 * Fold a single content_block_delta into `blocks`. Returns true when a text or
 * reasoning delta was applied (caller should bump its render version).
 *
 * `isSubagent` mirrors the legacy guard: on a top-level page, deltas that still
 * carry a subagentToolUseId belong to a child stream and are ignored.
 */
export function applyExactStreamDelta(
	blocks: StreamingBlock[],
	event: StreamDeltaEvent | undefined,
	isSubagent: boolean,
): boolean {
	if (!event || event.type !== "content_block_delta") return false;
	if (!isSubagent && event.subagentToolUseId) return false;
	const delta = event.delta;
	const deltaText = typeof delta?.text === "string" ? delta.text : "";
	if (!delta || !deltaText) return false;

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
		} else {
			const lastBlock = blocks[blocks.length - 1];
			if (lastBlock?.type === "text" && outputIndex == null) {
				lastBlock.text = appendStreamingTextPreview(lastBlock.text, deltaText);
			} else {
				blocks.splice(findStreamingInsertIndex(blocks, outputIndex), 0, {
					type: "text",
					text: appendStreamingTextPreview("", deltaText),
					...(outputIndex != null ? { outputIndex } : {}),
				});
			}
		}
		return true;
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
		} else {
			blocks.splice(findStreamingInsertIndex(blocks, outputIndex), 0, {
				type: "reasoning",
				text: appendStreamingTextPreview("", deltaText),
				...(reasoningId ? { id: reasoningId } : {}),
				...(outputIndex != null ? { outputIndex } : {}),
			});
		}
		return true;
	}

	return false;
}

/** Merge a reconnect snapshot into `blocks`; returns true when anything changed. */
export function applyExactStreamingSnapshot(
	blocks: StreamingBlock[],
	snapshotBlocks: StreamingBlock[],
): boolean {
	if (snapshotBlocks.length === 0) return false;
	return mergeStreamingSnapshotBlocks(blocks, snapshotBlocks);
}
