/** Per-block ownership evidence: a text/reasoning element by its global id and monotonic
 * revision, a provider tool block by its id. */
import { type MessageBodySource, messageBody } from "@shared/narrator-blocks/message-blocks";
import type { StreamingBlock } from "../message/message-segments";

export interface SupersedeCandidateMessage extends MessageBodySource {
	role?: unknown;
	parentToolUseId?: unknown;
}
interface PersistedBlock {
	type?: unknown;
	id?: unknown;
	revision?: unknown;
}

export function contentBlockIdentity(block: {
	type?: unknown;
	id?: unknown;
	revision?: unknown;
}): { id: string; revision: number } | null {
	if (
		(block.type !== "text" && block.type !== "reasoning") ||
		typeof block.id !== "string" ||
		!block.id ||
		typeof block.revision !== "number" ||
		!Number.isSafeInteger(block.revision) ||
		block.revision < 0
	)
		return null;
	return { id: block.id, revision: block.revision };
}

/**
 * The persisted block covers the live one: a text/reasoning element at the same id and at
 * least the live revision (its text may differ — commits clean citation markers and
 * advance metadata without changing what is shown); a provider tool block (web_search,
 * image_generation) at the same id.
 */
export function blockSupersedes(persisted: PersistedBlock, live: StreamingBlock): boolean {
	if (persisted.type !== live.type) return false;
	if (live.type === "text" || live.type === "reasoning") {
		const liveIdentity = contentBlockIdentity(live);
		const persistedIdentity = contentBlockIdentity(persisted);
		return (
			!!liveIdentity &&
			!!persistedIdentity &&
			liveIdentity.id === persistedIdentity.id &&
			persistedIdentity.revision >= liveIdentity.revision
		);
	}
	return typeof persisted.id === "string" && persisted.id.length > 0 && persisted.id === live.id;
}

/** The current turn's persisted blocks (never a child's). */
function collectCurrentTurnBlocks(
	messages: readonly SupersedeCandidateMessage[],
): PersistedBlock[] {
	const blocks: PersistedBlock[] = [];
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message || message.parentToolUseId) continue;
		if (message.role === "user") break;
		if (message.role !== "assistant") continue;
		for (const block of messageBody(message)) {
			if (block && typeof block === "object") blocks.push(block as PersistedBlock);
		}
	}
	return blocks;
}

/**
 * Remove the live provider tool blocks (web_search, image_generation) the current turn
 * has persisted. Text and reasoning lanes are not removed here: their raw accumulators
 * outlive a checkpoint, which is not a final close of the id (callers project a copy).
 */
export function dropSupersededStreamingBlocks(
	blocks: StreamingBlock[],
	committedMessages: readonly SupersedeCandidateMessage[],
): boolean {
	if (blocks.length === 0) return false;
	const persisted = collectCurrentTurnBlocks(committedMessages);
	if (persisted.length === 0) return false;
	let changed = false;
	for (let index = blocks.length - 1; index >= 0; index--) {
		const live = blocks[index];
		if (live.type === "text" || live.type === "reasoning") continue;
		if (!persisted.some((candidate) => blockSupersedes(candidate, live))) continue;
		blocks.splice(index, 1);
		changed = true;
	}
	return changed;
}
