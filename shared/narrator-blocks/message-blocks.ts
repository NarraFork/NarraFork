/**
 * message-blocks.ts — a message's blocks as the frontend holds and renders them
 * (docs/BLOCK_STORAGE-DESIGN.md, P3d).
 *
 * A row holds its body as blocks (`blocks`): each block is its identity (id, kind,
 * subtype, phase, revision, wire id) and the elements it holds. The protocol decoder
 * gives every row the blocks the server named. A row built on the client — the streaming
 * row, chat and share rows — is split into blocks exactly as the server splits a legacy
 * envelope (`splitRowBlocks`), so both kinds group their elements the same way.
 *
 * Readers take the body through `messageBody` (the elements) or `messageBlocks` (the
 * blocks); code that rewrites a row's body goes through `mapRowElements`,
 * `filterRowElements` or `rowWithElements`, which keep each block's identity. A row
 * without blocks has an empty body.
 */

import { splitEnvelope } from "./storage";
import type { EnvelopeRole } from "./types";

/** One block a row holds: its identity and its elements. */
export interface RowBlock<E = unknown> {
	id: string;
	kind: string;
	subtype: string | null;
	phase: string;
	revision: number;
	wireId: string | null;
	attemptId: string | null;
	/** An edited output block keeps its body from before the first edit. */
	hasOriginal: boolean;
	/**
	 * The server named this block, so its id addresses it in the block routes. A
	 * client-built row's blocks are split here and their ids are derived.
	 */
	named: boolean;
	elements: readonly E[];
}

/** One block of a message, with where its elements start in the message's body. */
export interface MessageBlock<E = unknown> extends RowBlock<E> {
	from: number;
}

/** The least a row needs for `messageBody`: the blocks that hold its elements. */
export interface MessageBodySource {
	blocks?: readonly RowBlock<unknown>[] | null;
}

/** A row whose body holds elements of type `E` — what structural row types extend. */
export interface MessageWithBody<E> extends MessageBodySource {
	blocks?: readonly RowBlock<E>[] | null;
}

/** What a client-built row is split by, besides its elements (`splitRowBlocks`). */
export interface SplitSource {
	id?: string;
	narratorId?: string | null;
	/** Only an assistant row splits into a block per element group; any other is one block. */
	role?: string;
	contentText?: string | null;
	parentToolUseId?: string | null;
	messageUuid?: string | null;
	provider?: string | null;
	/** Who wrote the row; server rows carry it, and it decides input versus context. */
	origin?: unknown;
}

/** A row with its blocks and what identifies it. */
export interface BlockSourceMessage<E> extends MessageWithBody<E>, SplitSource {
	role: string;
}

/** A row's elements, typed after its blocks. */
export type MessageBody<M> = M extends { blocks?: infer R }
	? NonNullable<R> extends readonly RowBlock<infer E>[]
		? readonly E[]
		: readonly unknown[]
	: readonly unknown[];

const EMPTY: readonly never[] = [];

/** Each block list's elements, one after another. */
const bodies = new WeakMap<readonly RowBlock<unknown>[], readonly unknown[]>();

/**
 * The message's elements in order: its blocks' elements, one after another. The same
 * array while the row's blocks are the same.
 */
export function messageBody<M extends MessageBodySource>(
	message: M | null | undefined,
): MessageBody<M> {
	const blocks = message?.blocks;
	return (Array.isArray(blocks) ? flatten(blocks) : EMPTY) as unknown as MessageBody<M>;
}

function flatten(blocks: readonly RowBlock<unknown>[]): readonly unknown[] {
	if (blocks.length === 0) return EMPTY;
	if (blocks.length === 1) return blocks[0].elements;
	let body = bodies.get(blocks);
	if (!body) {
		body = blocks.flatMap((block) => block.elements);
		bodies.set(blocks, body);
	}
	return body;
}

/** Each block list with its starting positions. */
const placed = new WeakMap<readonly RowBlock<unknown>[], readonly MessageBlock[]>();

/** The message's blocks in order; the same array while its blocks are the same. */
export function messageBlocks<E>(message: MessageWithBody<E>): readonly MessageBlock<E>[] {
	const held = message.blocks;
	if (!Array.isArray(held) || held.length === 0) return EMPTY;
	let blocks = placed.get(held);
	if (!blocks) {
		let from = 0;
		blocks = held.map((block) => {
			const at = from;
			from += block.elements.length;
			return { ...block, from: at };
		});
		placed.set(held, blocks);
	}
	return blocks as readonly MessageBlock<E>[];
}

/** The message's block holding element `index`. */
export function blockAtIndex<E>(
	message: MessageWithBody<E>,
	index: number,
): MessageBlock<E> | undefined {
	return messageBlocks(message).find(
		(block) => index >= block.from && index < block.from + block.elements.length,
	);
}

/**
 * A client-built row's elements as blocks, split as the server splits a legacy envelope:
 * a block's id is its element's identity where it has one, else `<messageId>:<position>`.
 */
export function splitRowBlocks<E>(message: SplitSource, elements: readonly E[]): RowBlock<E>[] {
	if (!elements.length) return [];
	const messageId = message.id ?? "msg";
	const { blocks } = splitEnvelope({
		id: messageId,
		narratorId: message.narratorId ?? undefined,
		role: message.role as EnvelopeRole,
		contentJson: elements as unknown[],
		contentText: message.contentText ?? null,
		parentToolUseId: message.parentToolUseId ?? null,
		messageUuid: message.messageUuid ?? null,
		origin: typeof message.origin === "string" ? message.origin : null,
		provider: message.provider ?? null,
	});
	let from = 0;
	return blocks.map((draft) => {
		const count = draft.payload.raw.length;
		const block: RowBlock<E> = {
			id: draft.canonical?.id ?? `${messageId}:${from}`,
			kind: draft.kind,
			subtype: draft.subtype,
			phase: draft.phase,
			revision: 0,
			wireId: draft.wireId,
			attemptId: null,
			hasOriginal: false,
			named: false,
			elements: elements.slice(from, from + count),
		};
		from += count;
		return block;
	});
}

/** The row's fields other than its body, to merge another row's body into. */
export function withoutBody<M extends MessageBodySource>(row: M): Omit<M, keyof MessageBodySource> {
	const { blocks: _blocks, ...rest } = row;
	return rest;
}

/**
 * A client-built row with `elements` as its body, split into blocks. For a row built on
 * the client only: a server row's blocks keep their ids through `mapRowElements` /
 * `filterRowElements`.
 */
export function rowWithElements<M extends object, E>(
	row: M,
	elements: readonly E[],
): Omit<M, "blocks"> & { blocks: RowBlock<E>[] } {
	return { ...row, blocks: splitRowBlocks(row as SplitSource, elements) };
}

type ElementOf<M> = MessageBody<M>[number];

/**
 * Each element of the row through `map` (`index` is its position in the body). A block
 * keeps its identity; the row and every unchanged block stay the same objects.
 */
export function mapRowElements<M extends MessageBodySource>(
	row: M,
	map: (element: ElementOf<M>, index: number) => ElementOf<M>,
): M {
	const held = row.blocks;
	if (!held?.length) return row;
	let changed = false;
	let from = 0;
	const blocks = held.map((block) => {
		const at = from;
		from += block.elements.length;
		let blockChanged = false;
		const elements = block.elements.map((element, offset) => {
			const next = map(element as ElementOf<M>, at + offset);
			if (next !== element) blockChanged = true;
			return next;
		});
		if (!blockChanged) return block;
		changed = true;
		return { ...block, elements };
	});
	return changed ? { ...row, blocks } : row;
}

/**
 * The row with only the elements `keep` accepts (`index` is the position in the body). A
 * block left with no elements is dropped; the others keep their identity. The same row
 * when every element is kept.
 */
export function filterRowElements<M extends MessageBodySource>(
	row: M,
	keep: (element: ElementOf<M>, index: number) => boolean,
): M {
	const held = row.blocks;
	if (!held?.length) return row;
	let changed = false;
	let from = 0;
	const blocks: RowBlock<unknown>[] = [];
	for (const block of held) {
		const at = from;
		from += block.elements.length;
		const elements = block.elements.filter((element, offset) =>
			keep(element as ElementOf<M>, at + offset),
		);
		if (elements.length === block.elements.length) {
			blocks.push(block);
			continue;
		}
		changed = true;
		if (elements.length) blocks.push({ ...block, elements });
	}
	return changed ? { ...row, blocks } : row;
}
