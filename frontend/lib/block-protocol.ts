/**
 * block-protocol.ts — the block-keyed message protocol v2, decoded at the transport
 * boundary (docs/BLOCK_STORAGE-DESIGN.md §8, P2c-3).
 *
 * The server sends messages as envelopes that name their blocks, plus the blocks. This
 * module turns pages and WS frames into the rows the document store renders: each
 * `TreeMessage` holds its blocks (`blocks`, read through `messageBlocks`). Rows stay
 * flat in envelope order; a row the server nests under another one keeps its
 * `parentMessageId` (`message/nested-rows.ts`). v2 is the only message protocol (P3d);
 * frames that are not message-shaped pass through.
 */

import type { MessageRowBlock, TreeMessage } from "./api/types";

/** One block as the server sends it. */
interface BlockDTO {
	id: string;
	messageId: string;
	ordinal: number;
	kind: string;
	subtype: string | null;
	phase: string;
	revision: number;
	wireId: string | null;
	attemptId: string | null;
	elements: unknown[];
	hasOriginal: boolean;
}

/** A message row without its body: its blocks, named in order. */
type EnvelopeDTO = Record<string, unknown> & {
	id: string;
	blockIds: string[];
	/** The row it is nested under; null at the top. */
	parentMessageId: string | null;
};

type Frame = Record<string, unknown>;

const array = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const number = (value: unknown) => (typeof value === "number" ? value : undefined);

/**
 * Envelopes + blocks as rows, in envelope order. A nested row keeps its
 * `parentMessageId`; a row at the top has none.
 */
function rowsOf(envelopes: EnvelopeDTO[], blocks: BlockDTO[]): TreeMessage[] {
	const byBlockId = new Map(blocks.map((block) => [block.id, block]));
	return envelopes.map((envelope) => {
		const { blockIds, parentMessageId, ...fields } = envelope;
		const rowBlocks: MessageRowBlock[] = [];
		for (const blockId of blockIds) {
			const block = byBlockId.get(blockId);
			if (!block) continue;
			rowBlocks.push({
				id: block.id,
				kind: block.kind,
				subtype: block.subtype,
				phase: block.phase,
				revision: block.revision,
				wireId: block.wireId,
				attemptId: block.attemptId,
				hasOriginal: block.hasOriginal,
				named: true,
				elements: block.elements as MessageRowBlock["elements"],
			});
		}
		return {
			...fields,
			...(parentMessageId ? { parentMessageId } : {}),
			blocks: rowBlocks,
		} as unknown as TreeMessage;
	});
}

/** A `pretext-document` page (envelopes + blocks) as rows. */
export function decodeBlockPage<T>(page: T): T {
	const value = page as unknown as Frame;
	if (!value) return page;
	const { protocol: _protocol, messages, blocks, ...rest } = value;
	const rows = rowsOf(array<EnvelopeDTO>(messages), array<BlockDTO>(blocks));
	return { ...rest, messages: rows } as unknown as T;
}

/** One message as envelopes + blocks, as an action's response carries it. */
interface BlockMessageDTO {
	messages: EnvelopeDTO[];
	blocks: BlockDTO[];
}

/** A response whose `message` arrived as envelopes + blocks, with that message as a row. */
export function decodeBlockMessage<T extends { message?: unknown }>(
	response: T,
): Omit<T, "message"> & { message?: TreeMessage } {
	const encoded = response.message as BlockMessageDTO | undefined;
	if (!encoded) return response as Omit<T, "message">;
	const [first] = rowsOf(array<EnvelopeDTO>(encoded.messages), array<BlockDTO>(encoded.blocks));
	return { ...response, message: first };
}

/**
 * A streamed delta in v2 as the v1 `stream_event` it maps from. v1 carries a text item's
 * output index on the event and a reasoning item's on the delta.
 */
function streamEvent(frame: Frame): Frame {
	const kind = frame.kind === "reasoning" ? "reasoning" : "output";
	const outputIndex = number(frame.outputIndex);
	const delta: Frame = {
		type: kind === "reasoning" ? "reasoning_delta" : "text_delta",
		text: text(frame.text) ?? "",
		id: frame.elementId,
		...(number(frame.revision) !== undefined ? { revision: frame.revision } : {}),
		...(number(frame.textOffset) !== undefined ? { textOffset: frame.textOffset } : {}),
		...(kind === "reasoning" && outputIndex !== undefined ? { outputIndex } : {}),
	};
	return {
		type: "stream_event",
		narratorId: frame.narratorId,
		event: {
			type: "content_block_delta",
			delta,
			...(kind === "output" && outputIndex !== undefined ? { outputIndex } : {}),
			...(frame.fileReferenceContext !== undefined
				? { fileReferenceContext: frame.fileReferenceContext }
				: {}),
			...(text(frame.subagentToolUseId) ? { subagentToolUseId: frame.subagentToolUseId } : {}),
			...(text(frame.subagentNarratorId) ? { subagentNarratorId: frame.subagentNarratorId } : {}),
		},
	};
}

/**
 * The v1 frames one received frame stands for: a v2 frame decoded, any other frame as
 * it is. A message frame keeps its v1 type (`cause`), so per-frame message-version
 * counting and every listener see exactly what v1 sent.
 */
export function decodeBlockFrame(frame: Frame): Frame[] {
	switch (frame.type) {
		case "message_upserted": {
			const { type: _type, cause, messages, blocks, ...rest } = frame;
			const rows = rowsOf(array<EnvelopeDTO>(messages), array<BlockDTO>(blocks));
			return rows.map((row) => ({ ...rest, type: cause, message: row }));
		}
		case "block_delta":
			return [streamEvent(frame)];
		// Its id reaches the store with the block's first checkpoint; nothing to render yet.
		case "block_opened":
			return [];
		case "catch_up": {
			const { protocol: _protocol, messages, blocks, orphanMessageIds, ...rest } = frame;
			const orphans = new Set(array<string>(orphanMessageIds));
			const rows = rowsOf(array<EnvelopeDTO>(messages), array<BlockDTO>(blocks));
			return [
				{
					...rest,
					// The frame's rows, each followed by the rows nested under it.
					topLevel: rows.filter((row) => !orphans.has(row.id)),
					orphanChildren: rows.filter((row) => orphans.has(row.id)),
				},
			];
		}
		default:
			return [frame];
	}
}
