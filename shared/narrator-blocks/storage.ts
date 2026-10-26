/**
 * storage.ts — how an envelope's stored content maps onto block rows (P1).
 *
 * P1 writes every envelope as rows of `narrator_blocks` next to the compatible
 * `content_json` that readers still read (docs/BLOCK_STORAGE-DESIGN.md §10.1). A row's
 * payload is the exact stored elements the block came from, with the reader-only fields
 * moved to `state`:
 *
 *   payload = { raw: [element, …] }      state = { raw: [fields | null, …] }
 *
 * so concatenating the rows in ordinal order and merging each state back reproduces the
 * stored array (`assembleContent`): the two representations can never drift apart, and
 * a state-only change (a translation, a card's status) is not a body change. One order
 * rule makes this exact: an element's reader-only fields come after its other fields.
 * The store writes `content_json` from the rows, so it follows the rule; content stored
 * before block storage, or rewritten outside the store, may hold them anywhere, which
 * means the same, so comparisons use `inAssembledOrder`. The columns
 * the database indexes and triggers read — kind, subtype, phase, model_text, wire_id —
 * are what `decodeLegacyContent` makes of the same elements.
 *
 * Canonical payloads (parts, provider_meta) replace `raw` once every reader reads blocks
 * (P2); until then they would only store every body twice.
 *
 * Pure and deterministic, like the decoder: no server imports.
 */

import { type DecodableMessage, decodeLegacyContent } from "./decode";
import type { BlockKind, BlockPhase, CanonicalBlock, CanonicalEnvelope } from "./types";

export interface StoredBlockPayload {
	raw: unknown[];
}

/** Reader-only fields of each element in `payload.raw`, index-aligned; null when none. */
export interface StoredBlockState {
	raw: Array<Record<string, unknown> | null>;
}

/** One block of an envelope, before the store gives it an id and an ordinal. */
export interface BlockDraft {
	/** Identity within the envelope, stable across rewrites of the same content. */
	key: string;
	kind: BlockKind;
	subtype: string | null;
	phase: BlockPhase;
	wireId: string | null;
	modelText: string | null;
	payload: StoredBlockPayload;
	state: StoredBlockState | null;
	/** The canonical block decoded from the same elements; null for leftover elements. */
	canonical: CanonicalBlock | null;
}

export interface SplitOptions {
	/**
	 * The step is still streaming: an output or reasoning element checkpointed as
	 * incomplete is `open`, not `aborted` (§3.5).
	 */
	streaming?: boolean;
}

/** Fields readers patch in place without changing what the block says (§3.4, §5.4). */
const STATE_KEYS: Readonly<Record<string, readonly string[]>> = {
	text: ["translatedText"],
	reasoning: ["translatedText", "translationGeneration", "translationParts"],
	thinking: ["translatedText", "translationGeneration", "translationParts"],
	review_feedback: ["applied"],
	compact: ["status", "attempts", "mode", "error"],
	segment_compact: ["status", "error"],
	// The card's model text is the envelope's content text; these only drive its controls.
	subagent_recovery: ["status", "mode", "resumedCount", "subagents"],
};
const CARD_STATE_KEYS = ["isLatest"];

type RawElement = Record<string, unknown>;

function record(value: unknown): RawElement | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as RawElement)
		: undefined;
}

function stateKeys(element: RawElement): readonly string[] {
	const type = typeof element.type === "string" ? element.type : "";
	return [...(STATE_KEYS[type] ?? []), ...CARD_STATE_KEYS];
}

/** An element without its reader-only fields, and those fields (null when none). */
function separateState(element: unknown): [unknown, Record<string, unknown> | null] {
	const value = record(element);
	if (!value) return [element, null];
	let fields: Record<string, unknown> | null = null;
	let rest: RawElement | null = null;
	for (const key of stateKeys(value)) {
		if (!Object.hasOwn(value, key)) continue;
		rest ??= { ...value };
		fields ??= {};
		fields[key] = value[key];
		delete rest[key];
	}
	return [rest ?? element, fields];
}

/** The decoder's block ids are `${messageId}:${index}` for blocks read from an element. */
function decodedIndex(messageId: string, block: CanonicalBlock): number | undefined {
	const prefix = `${messageId}:`;
	if (!block.id.startsWith(prefix)) return undefined;
	const index = Number(block.id.slice(prefix.length));
	return Number.isSafeInteger(index) && index >= 0 ? index : undefined;
}

function identityOf(element: unknown): string | undefined {
	const value = record(element);
	if (!value) return undefined;
	const id = value.id ?? value.toolUseId;
	return typeof id === "string" && id ? id : undefined;
}

function typeOf(element: unknown): string {
	const value = record(element);
	return value && typeof value.type === "string" ? value.type : typeof element;
}

function draftOf(
	key: string,
	elements: readonly unknown[],
	block: CanonicalBlock | null,
	options: SplitOptions,
): BlockDraft {
	const raw: unknown[] = [];
	const state: Array<Record<string, unknown> | null> = [];
	for (const element of elements) {
		const [rest, fields] = separateState(element);
		raw.push(rest);
		state.push(fields);
	}
	const kind: BlockKind = block?.kind ?? "output";
	let phase: BlockPhase = block?.phase ?? "done";
	if (
		options.streaming &&
		(kind === "output" || kind === "reasoning") &&
		phase === "aborted" &&
		record(elements.find((element) => record(element)))?.completed === false
	)
		phase = "open";
	return {
		key,
		kind,
		subtype: block?.kind === "tool" || block?.kind === "context" ? (block.subtype as string) : null,
		phase,
		wireId: block?.kind === "tool" ? block.wireId : null,
		modelText: block?.kind === "input" || block?.kind === "context" ? block.modelText : null,
		payload: { raw },
		state: state.some(Boolean) ? { raw: state } : null,
		canonical: block,
	};
}

/**
 * The blocks of one stored envelope, in order. Every element belongs to exactly one
 * block: an element the decoder gives no block of its own (a display-only `/bash`
 * result, an unknown type) rides with the block before it, or the first one.
 */
export function splitEnvelope(
	message: DecodableMessage,
	options: SplitOptions = {},
): { blocks: BlockDraft[]; envelope: CanonicalEnvelope } {
	const elements: unknown[] = Array.isArray(message.contentJson) ? message.contentJson : [];
	const envelope = decodeLegacyContent({ ...message, contentJson: elements });
	if (message.role !== "assistant") {
		const block = envelope.blocks[0] ?? null;
		return { blocks: [draftOf("envelope", elements, block, options)], envelope };
	}
	// The decoder skips non-object elements, so its indexes count record elements only.
	const recordPositions: number[] = [];
	elements.forEach((element, position) => {
		if (record(element)) recordPositions.push(position);
	});
	const starts: Array<{ position: number; block: CanonicalBlock }> = [];
	for (const block of envelope.blocks) {
		const index = decodedIndex(message.id, block);
		const position = index === undefined ? undefined : recordPositions[index];
		if (position !== undefined) starts.push({ position, block });
	}
	starts.sort((a, b) => a.position - b.position);
	if (!starts.length)
		return elements.length
			? { blocks: [draftOf("leftover", elements, null, options)], envelope }
			: { blocks: [], envelope };
	const seen = new Map<string, number>();
	const blocks = starts.map(({ position, block }, index) => {
		const from = index === 0 ? 0 : position;
		const to = starts[index + 1]?.position ?? elements.length;
		const element = elements[position];
		const identity = identityOf(element);
		const base = identity
			? `${typeOf(element)}:${identity}`
			: `${typeOf(element)}#${seen.get(typeOf(element)) ?? 0}`;
		if (!identity) seen.set(typeOf(element), (seen.get(typeOf(element)) ?? 0) + 1);
		return draftOf(base, elements.slice(from, to), block, options);
	});
	// Identities are unique per envelope in practice; keep keys unique regardless.
	const used = new Map<string, number>();
	for (const block of blocks) {
		const count = used.get(block.key) ?? 0;
		used.set(block.key, count + 1);
		if (count) block.key = `${block.key}~${count}`;
	}
	return { blocks, envelope };
}

/** A block as row matching sees it: its codec key and its stored payload text. */
export interface MatchableBlock {
	key: string;
	payload: string;
}

/** Past this many alignment cells only the common head and tail align (a bulk rewrite). */
const ALIGN_CELLS = 1 << 22;

const POSITIONAL_SUFFIX = /#\d+(?:~\d+)?$/;

/** The element type of a key made from position (`type#n`); undefined for an identity. */
function positionalType(key: string): string | undefined {
	return !key.includes(":") && POSITIONAL_SUFFIX.test(key)
		? key.replace(POSITIONAL_SUFFIX, "")
		: undefined;
}

/**
 * Which of `before` (an envelope's rows, in ordinal order) each of `after` (the blocks its
 * content splits into now) continues: an index into `before`, or undefined for a new
 * block. A row is continued at most once.
 *
 *   1. A block with an identity of its own (a tool call, an element id, an input's single
 *      block) continues the row with the same key, wherever it moved.
 *   2. All blocks align in order, identities by key and the rest by payload, so a block
 *      removed or added never hands its id to a neighbour that only shares its type and
 *      position: deleting the first of two id-less texts keeps the second text's row.
 *   3. Blocks still unmatched pair up by type, in order, between the same two aligned
 *      blocks: a block edited or streamed in place keeps its row.
 */
export function matchBlocks(
	before: readonly MatchableBlock[],
	after: readonly MatchableBlock[],
): Array<number | undefined> {
	const matched = new Array<number | undefined>(after.length).fill(undefined);
	const taken = new Array<boolean>(before.length).fill(false);
	const take = (from: number, to: number) => {
		matched[to] = from;
		taken[from] = true;
	};

	const identities = new Map<string, number>();
	before.forEach((block, index) => {
		if (positionalType(block.key) === undefined) identities.set(block.key, index);
	});
	after.forEach((block, index) => {
		const from = positionalType(block.key) === undefined ? identities.get(block.key) : undefined;
		if (from !== undefined && !taken[from]) take(from, index);
	});

	const tokens = new Map<string, number>();
	const tokenOf = (block: MatchableBlock) => {
		const text =
			positionalType(block.key) === undefined ? `key\0${block.key}` : `raw\0${block.payload}`;
		const token = tokens.get(text) ?? tokens.size;
		tokens.set(text, token);
		return token;
	};
	const a = before.map(tokenOf);
	const b = after.map(tokenOf);
	const anchors: Array<[number, number]> = [];
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) anchors.push([head, head++]);
	let endA = a.length;
	let endB = b.length;
	const tail: Array<[number, number]> = [];
	while (endA > head && endB > head && a[endA - 1] === b[endB - 1]) tail.push([--endA, --endB]);
	const rows = endA - head;
	const cols = endB - head;
	if (rows > 0 && cols > 0 && (rows + 1) * (cols + 1) <= ALIGN_CELLS) {
		// Longest common subsequence of the middle; lcs[i][j] covers a[head+i..], b[head+j..].
		const width = cols + 1;
		const lcs = new Int32Array((rows + 1) * width);
		for (let i = rows - 1; i >= 0; i--)
			for (let j = cols - 1; j >= 0; j--)
				lcs[i * width + j] =
					a[head + i] === b[head + j]
						? lcs[(i + 1) * width + j + 1] + 1
						: Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
		for (let i = 0, j = 0; i < rows && j < cols; ) {
			if (a[head + i] === b[head + j]) anchors.push([head + i++, head + j++]);
			else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) i++;
			else j++;
		}
	}
	anchors.push(...tail.reverse());
	for (const [from, to] of anchors) if (matched[to] === undefined && !taken[from]) take(from, to);

	let previousA = -1;
	let previousB = -1;
	for (const [endFrom, endTo] of [...anchors, [before.length, after.length] as [number, number]]) {
		const waiting = new Map<string, number[]>();
		for (let from = previousA + 1; from < endFrom; from++) {
			const type = positionalType(before[from].key);
			if (type === undefined || taken[from]) continue;
			const queue = waiting.get(type);
			if (queue) queue.push(from);
			else waiting.set(type, [from]);
		}
		for (let to = previousB + 1; to < endTo; to++) {
			const type = positionalType(after[to].key);
			const from =
				type === undefined || matched[to] !== undefined ? undefined : waiting.get(type)?.shift();
			if (from !== undefined) take(from, to);
		}
		previousA = endFrom;
		previousB = endTo;
	}
	return matched;
}

/**
 * Whether `after` differs from `before` only in reader-only fields: same elements, same
 * fields outside `state`. A state-only write (§5.4) is one of these whose blocks also keep
 * every column the decoder derives (a compact's status sets its phase; see the store).
 */
export function isStateOnlyChange(before: readonly unknown[], after: readonly unknown[]): boolean {
	return (
		before.length === after.length &&
		before.every(
			(element, index) =>
				JSON.stringify(separateState(element)[0]) ===
				JSON.stringify(separateState(after[index])[0]),
		)
	);
}

/**
 * Stored content in the order its rows assemble to: each element's reader-only fields
 * after its other fields (see the module comment). Compare rows against `content_json`
 * as `assembleContent(rows)` against `inAssembledOrder(stored)`.
 */
export function inAssembledOrder(content: readonly unknown[]): unknown[] {
	return content.map((element) => {
		const [rest, fields] = separateState(element);
		return fields ? { ...(rest as RawElement), ...fields } : element;
	});
}

/** The stored array the rows say, in ordinal order: the inverse of `splitEnvelope`. */
export function assembleContent(
	rows: ReadonlyArray<{ payload: unknown; state: unknown }>,
): unknown[] {
	const content: unknown[] = [];
	for (const row of rows) {
		const raw = record(row.payload)?.raw;
		if (!Array.isArray(raw)) continue;
		const state = record(row.state)?.raw;
		raw.forEach((element, index) => {
			const fields = Array.isArray(state) ? record(state[index]) : undefined;
			content.push(fields && record(element) ? { ...record(element), ...fields } : element);
		});
	}
	return content;
}
