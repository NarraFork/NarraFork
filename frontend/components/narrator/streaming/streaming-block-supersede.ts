/**
 * streaming-block-supersede.ts — Drops live streaming blocks whose PERSISTED
 * counterpart is already in the loaded document.
 *
 * The gap this closes
 * -------------------
 * The server persists a turn's output progressively: `block_complete` writes each
 * finished text/reasoning block into a partial assistant message and removes it from
 * the reconnect snapshot, so the snapshot only ever holds what is still streaming.
 * The CLIENT had no matching contraction: `applyStreamingDelta` only ever grows the
 * live row and nothing retires an individual block, because the browser never sees
 * `block_complete` at all.
 *
 * Mid-turn that asymmetry is harmless — the partial row is invisible to clients
 * (`appendBlockToMessage` neither bumps `messageVersion` nor broadcasts), so the live
 * row is the only view of that content. It stops being harmless when a catch-up
 * delivers the partial row for the first time (a tab returning to the foreground):
 * the row arrives carrying blocks the live row is still holding, and the same
 * paragraph renders TWICE until a tool call's exact id match retires the whole row.
 *
 * Why the judgement is structural
 * -------------------------------
 * Same philosophy as `streaming-handoff.ts`: a block is dropped because the document
 * DEMONSTRABLY already contains it, never because an event announced it. An
 * event-driven variant (server says "archived", client deletes) was rejected — the
 * partial row is invisible mid-turn, so it would delete content that has nowhere else
 * to render, turning a visible duplicate into silent mid-stream loss.
 *
 * Three conditions must ALL hold, and each closes a different window:
 *
 *   1. A persisted block matches by coordinate — the replacement is really on screen.
 *   2. The text discriminator passes — `outputIndex` restarts at 0 on every API
 *      request while all blocks append to ONE partial row, so a coordinate alone
 *      cannot tell this step's block from the previous step's.
 *   3. It is not the block currently being written — a lane's first delta is a few
 *      characters long and can spuriously satisfy (2) against an earlier step.
 *
 * Failure mode is therefore one-directional: anything unproven keeps the duplicate
 * (today's behaviour) rather than losing output.
 *
 * Pure: mutates the passed `blocks` array and returns whether anything changed. No
 * React, no DOM, no WS.
 */

import { getStreamingBlockOutputIndex, type StreamingBlock } from "../message-segments";

/** The subset of a committed message this module reads. */
export interface SupersedeCandidateMessage {
	role?: unknown;
	parentToolUseId?: unknown;
	contentJson?: unknown;
}

/** A persisted content block, in the shape `appendBlockToMessage` stores. */
interface PersistedBlock {
	type?: unknown;
	text?: unknown;
	outputIndex?: unknown;
	id?: unknown;
	providerMetadata?: unknown;
}

/**
 * Identity of a reasoning block, normalized across the two shapes it takes.
 *
 * The live side carries a flat `id` (the accumulator lifts it out of
 * `providerMetadata.openai.itemId` and ships it as `delta.id`), while the persisted
 * side keeps the nested metadata. Resolving both here — rather than at each
 * comparison site — is what stops the two spellings from drifting apart, a skew that
 * would produce no error, just a silent failure to ever match.
 */
function reasoningIdentity(block: PersistedBlock | StreamingBlock): string | undefined {
	const flat = (block as { id?: unknown }).id;
	if (typeof flat === "string" && flat.length > 0) return flat;
	const metadata = (block as { providerMetadata?: unknown }).providerMetadata;
	if (!metadata || typeof metadata !== "object") return undefined;
	const openai = (metadata as { openai?: unknown }).openai;
	if (!openai || typeof openai !== "object") return undefined;
	const itemId = (openai as { itemId?: unknown }).itemId;
	return typeof itemId === "string" && itemId.length > 0 ? itemId : undefined;
}

function outputIndexOf(block: PersistedBlock): number | undefined {
	return typeof block.outputIndex === "number" ? block.outputIndex : undefined;
}

function textOf(block: PersistedBlock): string | undefined {
	return typeof block.text === "string" ? block.text : undefined;
}

/**
 * Whether a persisted block's text proves it is the same content as the live block's.
 *
 * `persisted.endsWith(streaming)` rather than equality, because the live text is
 * capped to a trailing window (`appendStreamingTextPreview` keeps the LAST 120k
 * chars), so on a very long answer the live side legitimately holds only a suffix of
 * what was stored. Requiring a prefix match instead would never fire there — which
 * loses no content, but also never fixes the duplicate.
 *
 * Always compares `text`, never `translatedText`: reasoning translation ADDS that
 * field and leaves `text` byte-for-byte intact (the same property
 * `isSameReasoningBlock` relies on server-side), so translation cannot break this.
 *
 * Empty text is never a match — a lane that has just been created must not be
 * swallowed by an arbitrary persisted block.
 */
function textSupersedes(persisted: string | undefined, streaming: string): boolean {
	if (!streaming) return false;
	if (persisted == null) return false;
	return persisted.endsWith(streaming);
}

/**
 * Whether one persisted block supersedes `live`.
 *
 * The coordinate only NOMINATES a candidate; for text and reasoning the text
 * discriminator decides. This mirrors the server's own caution: `findReasoningBlockIndex`
 * locates by `providerMetadata`/`outputIndex` and then re-checks the text via
 * `isSameReasoningBlock`, precisely because "`outputIndex` is reproduced by the replay".
 *
 * `web_search` / `image_generation` need no discriminator: their `id` is a
 * provider-issued item id (unique per call), not a per-request ordinal, so it cannot
 * collide across the requests of one turn.
 */
function blockSupersedes(persisted: PersistedBlock, live: StreamingBlock): boolean {
	if (persisted.type !== live.type) return false;

	if (live.type === "text") {
		const liveIndex = getStreamingBlockOutputIndex(live);
		const persistedIndex = outputIndexOf(persisted);
		// A coordinate present on both sides must agree. When either side lacks one,
		// fall through to the text discriminator alone — it is the stronger signal.
		if (liveIndex != null && persistedIndex != null && liveIndex !== persistedIndex) return false;
		return textSupersedes(textOf(persisted), live.text);
	}

	if (live.type === "reasoning") {
		const liveId = reasoningIdentity(live);
		const persistedId = reasoningIdentity(persisted);
		if (liveId != null && persistedId != null && liveId !== persistedId) return false;
		if (liveId == null || persistedId == null) {
			const liveIndex = getStreamingBlockOutputIndex(live);
			const persistedIndex = outputIndexOf(persisted);
			if (liveIndex != null && persistedIndex != null && liveIndex !== persistedIndex) return false;
		}
		// Even an id match must clear the text check: `id` only exists on OpenAI-family
		// providers, so relying on it would give two different safety levels depending
		// on which provider produced the turn.
		return textSupersedes(textOf(persisted), live.text);
	}

	// web_search / image_generation — provider item id is enough.
	return typeof persisted.id === "string" && persisted.id.length > 0 && persisted.id === live.id;
}

/**
 * Collect the persisted blocks that could stand in for a live block.
 *
 * Scoped to the CURRENT TURN: walks back from the tail over top-level assistant
 * messages and stops at the first top-level user message. Two independent reasons,
 * and either alone would justify it:
 *
 * - **Correctness.** The live row only ever holds output of the turn in flight, so
 *   nothing older can legitimately supersede it — but it could ACCIDENTALLY match.
 *   The text discriminator is a suffix test, and an assistant message from an earlier
 *   turn that happens to end with "好的。" would satisfy it. Restricting the scan to
 *   the turn that produced the live blocks removes that whole class of false hit.
 * - **Cost.** This runs on every `committedMessages` identity change, which is several
 *   times per turn (each live lifecycle patch rebuilds the array), and the loaded
 *   window is allowed to reach `TRIM_TRIGGER_MESSAGES` (1200) rows. Scanning all of
 *   them per patch would be a per-frame O(window) walk on the streaming path.
 *
 * TOP-LEVEL messages only, and children are deliberately NOT walked — unlike
 * `collectPersistedToolUseIds`, which does. Both are right because they match
 * different things: a child message can own a live TOOL id (a subagent page renders
 * its own tools as top-level cards), but a parent's live row never receives a child's
 * text/reasoning at all — `applyStreamingDelta` discards deltas carrying a
 * `subagentToolUseId`. Walking children here could therefore only add false matches,
 * never true ones. A subagent's OWN page is still fully covered: there its messages
 * are the top-level ones.
 */
function collectCurrentTurnBlocks(
	messages: readonly SupersedeCandidateMessage[],
): PersistedBlock[] {
	const blocks: PersistedBlock[] = [];
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message) continue;
		// Children belong to a subagent's own document; they never bound the turn.
		if (message.parentToolUseId) continue;
		// The turn boundary: everything above this belongs to earlier turns.
		if (message.role === "user") break;
		if (message.role !== "assistant") continue;
		if (!Array.isArray(message.contentJson)) continue;
		for (const block of message.contentJson) {
			if (block && typeof block === "object") blocks.push(block as PersistedBlock);
		}
	}
	return blocks;
}

/**
 * Remove live streaming blocks the committed document already contains.
 *
 * `liveBlock` is the block currently being written, passed BY REFERENCE and skipped
 * unconditionally. It must not be identified by array index: `StreamDeltaResult.blockIndex`
 * is only valid for the array as it stood after that fold, and `upsertStreaming*Block`
 * splices native blocks in by `outputIndex` without updating any index the caller
 * holds. A stale index would protect a neighbour and leave the lane that is actually
 * growing unguarded — exactly the case condition (3) exists for. References survive
 * the splices because text/reasoning blocks are mutated in place.
 *
 * Returns true when at least one block was removed, so the caller can re-render.
 */
export function dropSupersededStreamingBlocks(
	blocks: StreamingBlock[],
	committedMessages: readonly SupersedeCandidateMessage[],
	liveBlock: StreamingBlock | null,
): boolean {
	if (blocks.length === 0) return false;
	const persisted = collectCurrentTurnBlocks(committedMessages);
	if (persisted.length === 0) return false;

	let changed = false;
	for (let index = blocks.length - 1; index >= 0; index--) {
		const live = blocks[index];
		if (live === liveBlock) continue;
		if (!persisted.some((candidate) => blockSupersedes(candidate, live))) continue;
		blocks.splice(index, 1);
		changed = true;
	}
	return changed;
}
