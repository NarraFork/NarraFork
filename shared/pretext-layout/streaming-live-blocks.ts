/**
 * streaming-live-blocks.ts — Which block of the LIVE synthetic message is still
 * being written, as opposed to merely un-persisted.
 *
 * ── The bug this fixes ────────────────────────────────────────────────────────
 *
 * The live row is one synthetic message (`__streaming__`) that accumulates the
 * whole turn: reasoning, then answer text, then tool calls. Every renderer asked
 * "is this the streaming message?" and applied the answer to EVERY block in it. So
 * a reasoning run that finished long ago — the model had already moved on to text,
 * and even to executing tools — kept rendering as live: force-expanded, shimmering,
 * labelled with a scrolling tail, and exempt from the LOD fold. It only settled when
 * the turn persisted, which for a tool-calling turn is many seconds and several tool
 * executions later.
 *
 * ── Why array position is not enough ─────────────────────────────────────────
 *
 * `buildStreamingMsg` emits text/reasoning blocks first (in provider output order)
 * and appends the live tool cards after them, whatever order the provider actually
 * used. So "is this the last block" answers a question about the BUILDER's layout,
 * not about the model: with OpenAI-style parallel calls a response can legitimately
 * run reasoning → tool_call → reasoning, and the second reasoning would land BEFORE
 * the tool block in the row while still being written.
 *
 * The accumulators, on the other hand, see the real arrival order. They therefore
 * stamp the row with the lane that last received a delta (`liveBlockIndex`), cleared
 * whenever a tool event arrives — a tool means the text lane closed, and a later
 * reasoning delta re-opens it. `resolveLiveBlockIndex` prefers that stamp and only
 * falls back to the positional rule for rows built without it (tests, reconnect
 * snapshots, the pixi model's own inputs), where the snapshot already excludes
 * blocks the server has completed.
 *
 * Pure: no DOM, no React, no timers.
 */

/** Id of the synthetic live message (shared with buildStreamingMsg). */
export const STREAMING_MESSAGE_ID = "__streaming__";

/** The subset of a content block this module reads. */
export interface LiveBlockLike {
	type?: unknown;
}

/**
 * The subset of a message this module reads.
 *
 * `liveBlockIndex` is the accumulator's stamp: the index of the block still being
 * written, or -1 for "no text lane is open" (the model has moved on to tool calls).
 * Absent when the row was not built by an accumulator that tracks arrival order.
 */
export interface LiveBlocksMessageLike {
	contentJson?: unknown;
	liveBlockIndex?: number | null;
	/** Frontend-only: a real checkpoint row currently projects a newer live block. */
	liveContentProjection?: boolean;
}

/**
 * Block types whose content streams in character by character, and can therefore be
 * "the one still being written". Tool calls, native searches and generated images
 * carry a status of their own (see `tool-shimmer.ts`) and are never text lanes.
 *
 * ⚠️ `thinking` is here for the POSITIONAL FALLBACK only; it never comes from the
 * accumulator. `applyStreamingDelta` folds exactly two block types — `text` and
 * `reasoning` (Anthropic's `thinking_delta` is routed to the reasoning channel, see
 * anthropic-provider's `thinkingAccum`) — so a stamped `liveBlockIndex` can only ever
 * point at one of those two. Its absence from the fold is not a missing branch.
 *
 * `thinking` is the PERSISTED shape of an extended-thinking block, and the pixi
 * model plus the tests feed persisted-shaped rows through this predicate. Those rows
 * carry no stamp, so they take the positional path — where omitting `thinking` would
 * answer -1 for a row whose last block is one, i.e. report it settled.
 */
function isStreamableTextBlock(block: LiveBlockLike | null | undefined): boolean {
	const type = block?.type;
	return type === "text" || type === "reasoning" || type === "thinking";
}

/**
 * Positional fallback: the LAST text lane in the array, or -1 when the array ends on
 * something else (a tool card, a native search).
 *
 * Only used when no accumulator stamp is available. It is right for the reconnect
 * snapshot — the server drops each block from the snapshot on `block_complete`, so
 * what remains is genuinely unfinished — and it is the closest available answer for
 * any other un-stamped row.
 */
function positionalLiveBlockIndex(blocks: readonly (LiveBlockLike | null | undefined)[]): number {
	const lastIndex = blocks.length - 1;
	// A trailing non-text block (a live tool card) means no text lane is open.
	return isStreamableTextBlock(blocks[lastIndex]) ? lastIndex : -1;
}

/**
 * Index of the block still being written in `msg`, or -1 when none is.
 *
 * `isStreamingMessage` is the caller's own "this is the synthetic live row" test
 * (usually `msg.id === STREAMING_MESSAGE_ID`). A persisted message is never live, so
 * it always answers -1.
 */
export function resolveLiveBlockIndex(
	isStreamingMessage: boolean,
	msg: LiveBlocksMessageLike | null | undefined,
): number {
	if (!msg || (!isStreamingMessage && !msg.liveContentProjection)) return -1;
	// A checkpointed real message can temporarily project a newer live revision.
	// Only that local projection carries a stamp; persisted messages never do.
	const stamped = msg.liveBlockIndex;
	if (typeof stamped === "number") return stamped;
	if (!isStreamingMessage) return -1;
	const blocks = msg.contentJson;
	if (!Array.isArray(blocks) || blocks.length === 0) return -1;
	return positionalLiveBlockIndex(blocks as readonly LiveBlockLike[]);
}

/** Whether the block at `blockIndex` of `msg` is still being written. */
export function isLiveStreamingBlock(
	isStreamingMessage: boolean,
	msg: LiveBlocksMessageLike | null | undefined,
	blockIndex: number | null | undefined,
): boolean {
	if (blockIndex == null) return false;
	return resolveLiveBlockIndex(isStreamingMessage, msg) === blockIndex;
}

/**
 * Same question for a RUN of adjacent blocks — adjacent reasoning blocks render as
 * one card / one folded trace, and the run is live when it contains the live block.
 *
 * `blockIndices` are indices into the message's FULL block array, matching what the
 * stamp and the positional fallback both refer to.
 */
export function isLiveStreamingRun(
	isStreamingMessage: boolean,
	msg: LiveBlocksMessageLike | null | undefined,
	blockIndices: readonly number[] | null | undefined,
): boolean {
	if (!blockIndices || blockIndices.length === 0) return false;
	const live = resolveLiveBlockIndex(isStreamingMessage, msg);
	if (live < 0) return false;
	return blockIndices.includes(live);
}
