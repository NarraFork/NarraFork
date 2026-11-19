/**
 * narrator-block-protocol.ts — the narrator message stream in protocol v2
 * (docs/BLOCK_STORAGE-DESIGN.md §8.2, P2c-2).
 *
 * Emitters keep broadcasting protocol v1 frames. A connection that negotiated v2 for a
 * narrator receives each frame as mapped here, once per broadcast:
 *   - a message row (`message`, `user_message`, `message_updated`) → `message_upserted`:
 *     the row as an envelope naming its blocks, and the blocks. `cause` names the v1
 *     frame, so a client counts message versions per frame exactly as v1 does;
 *   - a text or reasoning delta (`stream_event` content_block_delta) → `block_delta`
 *     addressed by block id, after `block_opened` when it is the element's first;
 *   - a tool call's first input chunk → `block_opened`, then the chunk as it is;
 *   - `tool_started` / `tool_completed` → the same frame naming its tool block (`blockId`);
 *   - every other frame as it is.
 * Block ids of streaming elements come from `narrator-block-ids.ts`, the same ids the
 * store's sync gives their rows at the next checkpoint. The reconnect snapshot and
 * catch-up carry block ids and envelopes the same way (`toBlockSnapshot`,
 * `toBlockCatchUp`).
 */

import {
	MAX_REASONING_TRANSLATION_OUTPUT_BYTES,
	MAX_REASONING_TRANSLATION_SOURCE_BYTES,
} from "@shared/reasoning-translation";
import { blockIdForElement } from "../services/narrator-block-ids";
import { ledgerBlockId, toEnvelopes } from "../services/narrator-block-page";
import type { NarratorServerMessage } from "./narrator-ws-types";

type Frame = Record<string, unknown> & { type: string };

const MESSAGE_FRAMES = new Set(["message", "user_message", "message_updated"]);
/** Tool lifecycle frames a client patches into the tool block's card. */
const TOOL_FRAMES = new Set(["tool_started", "tool_completed"]);

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const number = (value: unknown) => (typeof value === "number" ? value : undefined);

/** A message row frame as `message_upserted`; undefined when it carries no row. */
function upserted(frame: Frame): NarratorServerMessage | undefined {
	const row = record(frame.message);
	if (!row || typeof row.id !== "string") return undefined;
	const { message: _row, type, ...rest } = frame;
	const { messages, blocks } = toEnvelopes([row as Record<string, unknown> & { id: string }]);
	return {
		...rest,
		type: "message_upserted",
		cause: type as "message" | "user_message" | "message_updated",
		narratorId: frame.narratorId as string,
		messages,
		blocks,
	};
}

/** A streamed text or reasoning delta as `block_delta`, opening its block first if new. */
function delta(frame: Frame): NarratorServerMessage[] | undefined {
	const event = record(frame.event);
	const change = record(event?.delta);
	if (event?.type !== "content_block_delta" || !change) return undefined;
	const elementId = text(change.id);
	const kind =
		change.type === "reasoning_delta"
			? "reasoning"
			: change.type === "text_delta"
				? "output"
				: null;
	if (!elementId || !kind) return undefined;
	const narratorId = frame.narratorId as string;
	const subagentNarratorId = text(event.subagentNarratorId);
	const subagentToolUseId = text(event.subagentToolUseId);
	const outputIndex = number(change.outputIndex) ?? number(event.outputIndex);
	const { blockId, opened } = blockIdForElement(subagentNarratorId ?? narratorId, elementId);
	const scope = {
		...(subagentToolUseId ? { subagentToolUseId } : {}),
		...(subagentNarratorId ? { subagentNarratorId } : {}),
	};
	const frames: NarratorServerMessage[] = [];
	if (opened)
		frames.push({
			type: "block_opened",
			narratorId,
			blockId,
			kind,
			elementId,
			messageId: null,
			...(outputIndex !== undefined ? { outputIndex } : {}),
			...scope,
		});
	frames.push({
		type: "block_delta",
		narratorId,
		blockId,
		kind,
		elementId,
		text: text(change.text) ?? "",
		...(number(change.revision) !== undefined ? { revision: number(change.revision) } : {}),
		...(number(change.textOffset) !== undefined ? { textOffset: number(change.textOffset) } : {}),
		...(outputIndex !== undefined ? { outputIndex } : {}),
		...(event.fileReferenceContext !== undefined
			? { fileReferenceContext: event.fileReferenceContext }
			: {}),
		...scope,
	});
	return frames;
}

/** `block_opened` for a tool call's first input chunk; undefined for any later chunk. */
export function toolOpened(frame: Frame): NarratorServerMessage | undefined {
	if (frame.type !== "tool_use_chunk") return undefined;
	const toolUseId = text(frame.toolUseId);
	if (!toolUseId) return undefined;
	const narratorId = frame.narratorId as string;
	const subagentNarratorId = text(frame.subagentNarratorId);
	const { blockId, opened } = blockIdForElement(subagentNarratorId ?? narratorId, toolUseId);
	if (!opened) return undefined;
	const parentToolUseId = text(frame.parentToolUseId);
	return {
		type: "block_opened",
		narratorId,
		blockId,
		kind: "tool",
		elementId: toolUseId,
		wireId: toolUseId,
		messageId: null,
		...(parentToolUseId ? { subagentToolUseId: parentToolUseId } : {}),
		...(subagentNarratorId ? { subagentNarratorId } : {}),
	};
}

/** A tool lifecycle frame naming the block its ledger attempt belongs to (`blockId`). */
function withToolBlock(frame: Frame): NarratorServerMessage | undefined {
	const toolUseId = text(frame.toolUseId);
	if (!toolUseId) return undefined;
	const narratorIds = [text(frame.narratorId), text(frame.subagentNarratorId)].filter(
		(id): id is string => !!id,
	);
	const blockId = ledgerBlockId(text(frame.toolCallId), toolUseId, narratorIds);
	return blockId ? ({ ...frame, blockId } as unknown as NarratorServerMessage) : undefined;
}

/** A completed part is already addressed by the successful state writer's persistent identity. */
export function reasoningTranslationPatchFrame(
	message: Extract<NarratorServerMessage, { type: "reasoning_translation_patch" }>,
): NarratorServerMessage {
	const { part } = message;
	const identity = [
		message.narratorId,
		message.ownerNarratorId,
		message.messageId,
		message.blockId,
		message.elementId,
		message.translationGeneration,
		part?.id,
	];
	if (
		identity.some((value) => typeof value !== "string" || !value || value.length > 256) ||
		!Number.isSafeInteger(message.blockRevision) ||
		message.blockRevision < 0 ||
		!Number.isSafeInteger(message.stateRevision) ||
		message.stateRevision < 0 ||
		!part ||
		part.generation !== message.translationGeneration ||
		!Number.isSafeInteger(part.start) ||
		part.start < 0 ||
		!Number.isSafeInteger(part.end) ||
		part.end <= part.start ||
		typeof part.sourceText !== "string" ||
		part.sourceText.length !== part.end - part.start ||
		typeof part.translatedText !== "string" ||
		!part.translatedText.trim() ||
		Buffer.byteLength(part.sourceText) > MAX_REASONING_TRANSLATION_SOURCE_BYTES ||
		Buffer.byteLength(part.translatedText) > MAX_REASONING_TRANSLATION_OUTPUT_BYTES
	)
		throw new Error("Invalid reasoning translation patch");
	return {
		type: "reasoning_translation_patch",
		narratorId: message.narratorId,
		ownerNarratorId: message.ownerNarratorId,
		messageId: message.messageId,
		blockId: message.blockId,
		elementId: message.elementId,
		blockRevision: message.blockRevision,
		stateRevision: message.stateRevision,
		translationGeneration: message.translationGeneration,
		part,
		...(message.parentToolUseId ? { parentToolUseId: message.parentToolUseId } : {}),
		...(message.subagentNarratorId ? { subagentNarratorId: message.subagentNarratorId } : {}),
	};
}

/** The frames a v2 connection receives for one v1 broadcast frame. */
export function toBlockFrames(message: NarratorServerMessage): NarratorServerMessage[] {
	if (message.type === "reasoning_translation_patch")
		return [reasoningTranslationPatchFrame(message)];
	const frame = message as unknown as Frame;
	if (MESSAGE_FRAMES.has(frame.type)) return [upserted(frame) ?? message];
	if (TOOL_FRAMES.has(frame.type)) return [withToolBlock(frame) ?? message];
	if (frame.type === "stream_event") return delta(frame) ?? [message];
	if (frame.type === "tool_use_chunk") {
		const opened = toolOpened(frame);
		return opened ? [opened, message] : [message];
	}
	return [message];
}

/** The reconnect snapshot with each live item's block id (`blockId`) alongside. */
export function toBlockSnapshot<T extends Frame>(snapshot: T): T & { protocol: 2 } {
	const narratorId = snapshot.narratorId as string;
	const blocks = Array.isArray(snapshot.streamingBlocks) ? snapshot.streamingBlocks : [];
	const chunks = Array.isArray(snapshot.toolChunks) ? snapshot.toolChunks : [];
	return {
		...snapshot,
		protocol: 2,
		streamingBlocks: blocks.map((block) => {
			const item = record(block);
			const elementId = text(item?.id);
			if (!item || !elementId || (item.type !== "text" && item.type !== "reasoning")) return block;
			return { ...item, blockId: blockIdForElement(narratorId, elementId).blockId };
		}),
		toolChunks: chunks.map((chunk) => {
			const item = record(chunk);
			const toolUseId = text(item?.toolUseId);
			if (!item || !toolUseId) return chunk;
			const author = text(item.subagentNarratorId) ?? narratorId;
			return { ...item, blockId: blockIdForElement(author, toolUseId).blockId };
		}),
	};
}

/**
 * A v1 catch-up frame in protocol v2: its rows, children included, as envelopes + blocks.
 * `orphanMessageIds` names the rows v1 sent as `orphanChildren` (children whose parent row
 * is not in this catch-up); every other row without a parent was in `topLevel`.
 */
export function toBlockCatchUp(frame: Frame): Frame {
	type Row = Record<string, unknown> & { id: string };
	const topLevel = (Array.isArray(frame.topLevel) ? frame.topLevel : []) as Row[];
	const orphans = (Array.isArray(frame.orphanChildren) ? frame.orphanChildren : []) as Row[];
	const { topLevel: _top, orphanChildren: _orphans, ...rest } = frame;
	return {
		...(rest as Omit<Frame, "type">),
		type: "catch_up",
		narratorId: frame.narratorId as string,
		protocol: 2,
		...toEnvelopes([...topLevel, ...orphans]),
		orphanMessageIds: orphans.map((row) => row.id),
		subagentActivities: Array.isArray(frame.subagentActivities) ? frame.subagentActivities : [],
	};
}
