/** Shared, bounded raw text/reasoning accumulation. Content ids identify lanes;
 * outputIndex only orders them. Legacy frames retain their coordinate fallback. */
import { normalizeFileReferenceContext } from "@shared/file-reference-context";
import {
	findStreamingInsertIndex,
	getStreamingBlockOutputIndex,
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
	const outputIndex = nonNegativeInteger(
		type === "text"
			? (event.outputIndex ?? delta.outputIndex)
			: (delta.outputIndex ?? event.outputIndex),
	);
	const index = blocks.findIndex((block) => {
		if (block.type !== type) return false;
		if (id) return block.id === id;
		if (block.id) return false;
		return getStreamingBlockOutputIndex(block) === outputIndex;
	});
	if (index !== -1) {
		const block = blocks[index];
		if (block.type !== "text" && block.type !== "reasoning") return NOT_APPLIED;
		if (revision != null && block.revision != null && revision <= block.revision)
			return NOT_APPLIED;
		if (textOffset != null && block.textOffset != null) {
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
		} else {
			block.text = appendStreamingTextPreview(block.text, delta.text);
			if (textOffset != null)
				block.textOffset = Math.max(0, textOffset + delta.text.length - block.text.length);
		}
		if (revision != null) block.revision = revision;
		return { applied: true, blockIndex: index };
	}
	const insertAt = findStreamingInsertIndex(blocks, outputIndex);
	const text = appendStreamingTextPreview("", delta.text);
	blocks.splice(insertAt, 0, {
		type,
		text,
		...(id ? { id } : {}),
		...(revision != null ? { revision } : {}),
		...(textOffset != null ? { textOffset: textOffset + delta.text.length - text.length } : {}),
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
