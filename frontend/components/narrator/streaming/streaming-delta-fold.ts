/** Shared, bounded raw text/reasoning accumulation. Every delta names its element (the
 * lane), the element's revision and the raw characters before it; outputIndex only
 * orders lanes. */
import { normalizeFileReferenceContext } from "@shared/file-reference-context";
import {
	findStreamingInsertIndex,
	mergeStreamingSnapshotBlocks,
	type StreamingBlock,
} from "../message/message-segments";
import { appendStreamingTextPreview } from "../narrator-message-helpers";

export interface StreamDeltaEvent {
	type?: unknown;
	subagentToolUseId?: unknown;
	fileReferenceContext?: unknown;
	outputIndex?: unknown;
	delta?: {
		type?: unknown;
		text?: unknown;
		id?: unknown;
		revision?: unknown;
		/** Raw character offset before this delta (not citation-cleaned text). */
		textOffset?: unknown;
		outputIndex?: unknown;
	};
}
export interface StreamDeltaResult {
	applied: boolean;
	/** Valid immediately after this fold; later native-block insertion can shift it. */
	blockIndex: number;
}
const NOT_APPLIED: StreamDeltaResult = { applied: false, blockIndex: -1 };
function nonNegativeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function applyStreamingDelta(
	blocks: StreamingBlock[],
	event: StreamDeltaEvent | undefined,
	isSubagent: boolean,
): StreamDeltaResult {
	if (!event || event.type !== "content_block_delta" || (!isSubagent && event.subagentToolUseId))
		return NOT_APPLIED;
	const delta = event.delta;
	if (
		!delta ||
		(delta.type !== "text_delta" && delta.type !== "reasoning_delta") ||
		typeof delta.text !== "string" ||
		!delta.text
	)
		return NOT_APPLIED;
	const type = delta.type === "text_delta" ? "text" : "reasoning";
	const id = typeof delta.id === "string" && delta.id ? delta.id : undefined;
	const revision = nonNegativeInteger(delta.revision);
	const textOffset = nonNegativeInteger(delta.textOffset);
	// The server names every delta's element, revision and raw offset.
	if (!id || revision == null || textOffset == null) return NOT_APPLIED;
	const outputIndex = nonNegativeInteger(
		type === "text"
			? (event.outputIndex ?? delta.outputIndex)
			: (delta.outputIndex ?? event.outputIndex),
	);
	const index = blocks.findIndex((block) => block.type === type && block.id === id);
	if (index !== -1) {
		const block = blocks[index];
		if (block.type !== "text" && block.type !== "reasoning") return NOT_APPLIED;
		if (revision <= block.revision) return NOT_APPLIED;
		const end = block.textOffset + block.text.length;
		if (textOffset >= block.textOffset && textOffset <= end) {
			const added = delta.text.slice(Math.max(0, end - textOffset));
			block.text = appendStreamingTextPreview(block.text, added);
			block.textOffset = Math.max(end, textOffset + delta.text.length) - block.text.length;
		} else {
			// Missing raw baseline on reconnect. The snapshot joins these raw windows;
			// never manufacture a prefix from a cleaned committed display body.
			block.text = appendStreamingTextPreview("", delta.text);
			block.textOffset = textOffset + delta.text.length - block.text.length;
		}
		block.revision = revision;
		return { applied: true, blockIndex: index };
	}
	const insertAt = findStreamingInsertIndex(blocks, outputIndex);
	const text = appendStreamingTextPreview("", delta.text);
	blocks.splice(insertAt, 0, {
		type,
		text,
		id,
		revision,
		textOffset: textOffset + delta.text.length - text.length,
		...(outputIndex != null ? { outputIndex } : {}),
		...(type === "text" && event.fileReferenceContext !== undefined
			? { fileReferenceContext: normalizeFileReferenceContext(event.fileReferenceContext) }
			: {}),
	});
	return { applied: true, blockIndex: insertAt };
}

export function applyStreamingSnapshotBlocks(
	blocks: StreamingBlock[],
	snapshotBlocks: StreamingBlock[],
): boolean {
	return snapshotBlocks.length > 0 && mergeStreamingSnapshotBlocks(blocks, snapshotBlocks);
}
