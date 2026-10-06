/** Per-block ownership evidence. Modern content uses global id + monotonic
 * revision; only unversioned history/snapshots use the conservative legacy match. */
import { getStreamingBlockOutputIndex, type StreamingBlock } from "../message/message-segments";

export interface SupersedeCandidateMessage {
	role?: unknown;
	parentToolUseId?: unknown;
	contentJson?: unknown;
}
interface PersistedBlock {
	type?: unknown;
	text?: unknown;
	outputIndex?: unknown;
	id?: unknown;
	providerMetadata?: unknown;
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

function reasoningIdentity(block: PersistedBlock | StreamingBlock): string | undefined {
	const flat = block.id;
	if (typeof flat === "string" && flat.length > 0) return flat;
	const metadata = (block as PersistedBlock).providerMetadata;
	if (!metadata || typeof metadata !== "object") return undefined;
	const openai = (metadata as { openai?: unknown }).openai;
	if (!openai || typeof openai !== "object") return undefined;
	const itemId = (openai as { itemId?: unknown }).itemId;
	return typeof itemId === "string" && itemId.length > 0 ? itemId : undefined;
}
function indicesMatch(persisted: PersistedBlock, live: StreamingBlock): boolean {
	const liveIndex = getStreamingBlockOutputIndex(live);
	return (
		liveIndex == null ||
		typeof persisted.outputIndex !== "number" ||
		liveIndex === persisted.outputIndex
	);
}
function textSupersedes(persisted: unknown, streaming: string): boolean {
	// A legacy live preview can be the last 120k characters of the stored body.
	return !!streaming && typeof persisted === "string" && persisted.endsWith(streaming);
}

export function blockSupersedes(persisted: PersistedBlock, live: StreamingBlock): boolean {
	if (persisted.type !== live.type) return false;
	const liveIdentity = contentBlockIdentity(live);
	const persistedIdentity = contentBlockIdentity(persisted);
	if (liveIdentity && persistedIdentity) {
		// Text equality is deliberately irrelevant: commits can clean citation markers
		// or advance metadata without changing the visible text.
		return (
			liveIdentity.id === persistedIdentity.id &&
			persistedIdentity.revision >= liveIdentity.revision
		);
	}
	if (live.type === "text") {
		if (
			live.id &&
			typeof persisted.id === "string" &&
			!live.id.startsWith("streaming:") &&
			live.id !== persisted.id
		)
			return false;
		return indicesMatch(persisted, live) && textSupersedes(persisted.text, live.text);
	}
	if (live.type === "reasoning") {
		const liveId = reasoningIdentity(live);
		const persistedId = reasoningIdentity(persisted);
		if (liveId != null && persistedId != null && liveId !== persistedId) return false;
		if ((liveId == null || persistedId == null) && !indicesMatch(persisted, live)) return false;
		return textSupersedes(persisted.text, live.text);
	}
	return typeof persisted.id === "string" && persisted.id.length > 0 && persisted.id === live.id;
}

/** Legacy matching is limited to the current turn and never walks child text. */
function collectCurrentTurnBlocks(
	messages: readonly SupersedeCandidateMessage[],
): PersistedBlock[] {
	const blocks: PersistedBlock[] = [];
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message || message.parentToolUseId) continue;
		if (message.role === "user") break;
		if (message.role !== "assistant" || !Array.isArray(message.contentJson)) continue;
		for (const block of message.contentJson) {
			if (block && typeof block === "object") blocks.push(block as PersistedBlock);
		}
	}
	return blocks;
}

/** Remove only proven display copies. Callers retaining modern raw accumulators
 * should project a copy instead; a checkpoint is NOT a final close of its id. */
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
		if (
			!persisted.some((candidate) => {
				// Unversioned active text can spuriously match an earlier short opener.
				if (live === liveBlock && !(contentBlockIdentity(live) && contentBlockIdentity(candidate)))
					return false;
				return blockSupersedes(candidate, live);
			})
		)
			continue;
		blocks.splice(index, 1);
		changed = true;
	}
	return changed;
}
