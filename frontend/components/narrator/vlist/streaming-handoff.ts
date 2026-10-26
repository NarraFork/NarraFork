import type { BaseContentBlock, TreeMessage } from "@frontend/lib/api/types";
import {
	filterRowElements,
	type MessageBodySource,
	mapRowElements,
	messageBody,
} from "@shared/narrator-blocks/message-blocks";
import { isReasoningBlock } from "@shared/pretext-layout/reasoning-segments";
import { resolveLiveBlockIndex } from "@shared/pretext-layout/streaming-live-blocks";
import type { StreamingBlock } from "../message/message-segments";
import { isNestedRow } from "../message/nested-rows";
import { blockSupersedes, contentBlockIdentity } from "../streaming/streaming-block-supersede";
import { collectPersistedToolUseIds } from "./streaming-tool-chunks";
import { preserveReasoningTranslationElement } from "./vlist-live-patch";

/** Live deltas lack state fields; append may reuse the committed translation lineage. */
function withCommittedReasoningTranslation(
	incoming: BaseContentBlock,
	previous: BaseContentBlock,
): BaseContentBlock {
	const text = incoming.thinking ?? incoming.text ?? "";
	const previousText = previous.thinking ?? previous.text ?? "";
	const candidate =
		!incoming.translationGeneration &&
		previous.translationGeneration &&
		text.startsWith(previousText)
			? { ...incoming, translationGeneration: previous.translationGeneration }
			: incoming;
	return preserveReasoningTranslationElement(candidate, previous);
}

export { STREAMING_MESSAGE_ID } from "@shared/pretext-layout/streaming-live-blocks";

export interface HandoffMessage extends MessageBodySource {
	id?: unknown;
	role?: unknown;
	parentToolUseId?: unknown;
	parentMessageId?: unknown;
	toolCalls?: unknown;
}

/**
 * A row that is not part of this page's conversation: a nested row, or on a parent
 * page a row a subagent wrote.
 */
function offPage(message: HandoffMessage, isSubagent: boolean): boolean {
	return (!isSubagent && !!message.parentToolUseId) || isNestedRow(message);
}

function currentTurn(messages: readonly HandoffMessage[], isSubagent: boolean): HandoffMessage[] {
	const turn: HandoffMessage[] = [];
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message || message.id === "__streaming__" || offPage(message, isSubagent)) continue;
		if (message.role === "user") break;
		if (message.role === "assistant") turn.push(message);
	}
	return turn;
}

/** Read-only publication: a checkpoint retires a DISPLAY copy, not its raw accumulator. */
export function projectStreamingMessage(
	streaming: TreeMessage | null,
	committed: readonly HandoffMessage[],
	isSubagent = false,
): TreeMessage | null {
	if (!streaming) return null;
	const persisted = currentTurn(committed, isSubagent).flatMap(
		(message) => messageBody(message) as readonly BaseContentBlock[],
	);
	// Modern ids are global, not turn coordinates. A user can interject while an
	// earlier assistant block is still active, so index the whole loaded document.
	const versions = new Map<string, BaseContentBlock>();
	for (const message of committed) {
		if (
			message.id === "__streaming__" ||
			message.role !== "assistant" ||
			offPage(message, isSubagent)
		)
			continue;
		for (const block of messageBody(message) as readonly BaseContentBlock[]) {
			const identity = contentBlockIdentity(block);
			if (identity && identity.revision >= (versions.get(identity.id)?.revision ?? -1))
				versions.set(identity.id, block);
		}
	}
	const tools = collectPersistedToolUseIds(committed);
	const liveIndex = resolveLiveBlockIndex(true, streaming);
	let nextLiveIndex = -1;
	const filtered = filterRowElements(streaming, (block, index) => {
		if (block.type === "tool_use") return !tools.has(block.id ?? "");
		if (
			block.type !== "text" &&
			block.type !== "reasoning" &&
			block.type !== "web_search" &&
			block.type !== "image_generation"
		)
			return true;
		// A text/reasoning lane is covered by its own persisted version; a provider tool
		// block by the current turn's persisted block of the same id.
		const identity = contentBlockIdentity(block);
		const exact = identity ? versions.get(identity.id) : undefined;
		const covered = identity
			? !!exact && blockSupersedes(exact, block as StreamingBlock)
			: persisted.some((candidate) => blockSupersedes(candidate, block as StreamingBlock));
		if (!covered && index === liveIndex) nextLiveIndex = index;
		return !covered;
	});
	const body = messageBody(filtered);
	if (body.length === 0) return null;
	// Filtering may have shifted the lane. Compare immutable published block objects, not indices.
	if (nextLiveIndex >= 0) nextLiveIndex = body.indexOf(messageBody(streaming)[liveIndex]);
	const toolCalls = (streaming.toolCalls ?? []).filter((call) => !tools.has(call.toolUseId));
	if (filtered === streaming && toolCalls.length === (streaming.toolCalls ?? []).length)
		return streaming;
	return { ...filtered, toolCalls, liveBlockIndex: nextLiveIndex };
}

/** OutputContentAccumulator's private epoch/order, not a persisted RowBlock.attemptId. */
function outputLane(block: BaseContentBlock): { attempt: string; order: number } | null {
	const identity = contentBlockIdentity(block);
	const match = identity && /^([A-Za-z0-9_-]{21}):(0|[1-9][0-9]*)$/.exec(identity.id);
	if (!match) return null;
	const order = Number(match[2]);
	return Number.isSafeInteger(order) ? { attempt: match[1], order } : null;
}

/**
 * A checkpoint can release r1 from the raw accumulator before r2 arrives. Only a
 * consecutive internal lane proves that r2 continues the actual document tail.
 * Keep the server's holders and the filtered live holders, never rebuild their ids.
 */
function projectReasoningContinuation(
	messages: TreeMessage[],
	streaming: TreeMessage,
	liveBlock: BaseContentBlock | undefined,
): TreeMessage {
	const owner = messages.at(-1);
	if (
		!owner ||
		owner.role !== "assistant" ||
		owner.id === "__streaming__" ||
		streaming.id !== "__streaming__" ||
		streaming.role !== "assistant" ||
		offPage(owner, false) ||
		offPage(streaming, false) ||
		!streaming.narratorId ||
		owner.narratorId !== streaming.narratorId
	)
		return streaming;
	const body = messageBody(owner);
	const tail = body.at(-1);
	const lane = tail?.type === "reasoning" ? outputLane(tail) : null;
	if (!lane) return streaming;

	// COW can copy an epoch into another message. Every eligible owner must agree,
	// and duplicate lanes inside the owner are not evidence of a continuation.
	const ownerIds = new Set<string>();
	for (const message of messages) {
		if (
			message.role !== "assistant" ||
			message.narratorId !== streaming.narratorId ||
			offPage(message, false)
		)
			continue;
		for (const block of messageBody(message)) {
			const candidate = outputLane(block);
			if (candidate?.attempt !== lane.attempt) continue;
			if (message !== owner || ownerIds.has(block.id as string) || candidate.order > lane.order)
				return streaming;
			ownerIds.add(block.id as string);
		}
	}
	let previous = lane.order + 1;
	for (let index = body.length - 1; index >= 0 && body[index].type === "reasoning"; index--) {
		const candidate = outputLane(body[index]);
		if (candidate?.attempt !== lane.attempt || candidate.order !== previous - 1) return streaming;
		previous = candidate.order;
	}

	const liveBody = messageBody(streaming);
	const liveIds = new Set(ownerIds);
	for (const block of liveBody) {
		if (outputLane(block)?.attempt !== lane.attempt) continue;
		if (liveIds.has(block.id as string)) return streaming;
		liveIds.add(block.id as string);
	}
	let count = 0;
	let order = lane.order;
	for (const block of liveBody) {
		if (block.type !== "reasoning") break;
		const candidate = outputLane(block);
		if (candidate?.attempt !== lane.attempt || candidate.order !== order + 1) return streaming;
		order = candidate.order;
		count++;
	}
	if (!count) return streaming;
	const prefix = filterRowElements(streaming, (_block, index) => index < count);
	const remaining = filterRowElements(streaming, (_block, index) => index >= count);
	const holderIds = new Set<string>();
	for (const holder of [...owner.blocks, ...prefix.blocks]) {
		if (holderIds.has(holder.id)) return streaming;
		holderIds.add(holder.id);
	}
	// A filtered holder cannot address both the owner and the remaining live row.
	if (remaining.blocks.some((holder) => holderIds.has(holder.id))) return streaming;
	const prefixBody = messageBody(prefix);
	// A late delta may reopen any lane, even before a tool in the builder's order.
	// Exact-id replacement changes the object, so resolve its identity in the owner.
	const activeId = liveBlock && contentBlockIdentity(liveBlock)?.id;
	const ownerLiveIndex = activeId
		? body.findIndex((block) => block.type === liveBlock?.type && block.id === activeId)
		: -1;
	const prefixLiveIndex = liveBlock ? prefixBody.indexOf(liveBlock) : -1;
	messages[messages.length - 1] = {
		...owner,
		blocks: [...owner.blocks, ...prefix.blocks],
		model: streaming.model ?? owner.model,
		provider: streaming.provider ?? owner.provider,
		liveBlockIndex:
			ownerLiveIndex >= 0
				? ownerLiveIndex
				: prefixLiveIndex >= 0
					? body.length + prefixLiveIndex
					: -1,
		liveContentProjection: true,
	} as TreeMessage;
	return remaining;
}

/**
 * A live revision of an already-committed id belongs to that SAME document block.
 * The persisted input remains untouched (pagination/cache/catch-up use it as evidence).
 * Reconcile on EVERY layout build, including the commit before React's next rAF/effect.
 */
export function projectStreamingDocument(
	committed: readonly TreeMessage[],
	streaming: TreeMessage | null,
): readonly TreeMessage[] {
	if (!streaming) return committed;
	const projected = projectStreamingMessage(streaming, committed, true);
	if (!projected) return committed;
	const liveBlocks = messageBody(projected);
	const byId = new Map(
		liveBlocks.flatMap((block) => {
			const identity = contentBlockIdentity(block);
			return identity ? [[identity.id, block] as const] : [];
		}),
	);
	const mergedIds = new Set<string>();
	const liveIndex = resolveLiveBlockIndex(true, projected);
	const messages = committed.map((message) => {
		if (message.role !== "assistant") return message;
		let liveBlockIndex = -1;
		const merged = mapRowElements(message, (block, index) => {
			const identity = contentBlockIdentity(block);
			const live = identity ? byId.get(identity.id) : undefined;
			if (
				!identity ||
				!live ||
				live.type !== block.type ||
				(live.revision as number) <= identity.revision
			)
				return block;
			mergedIds.add(identity.id);
			if (liveBlocks[liveIndex] === live) liveBlockIndex = index;
			// Citations/translations reference the committed text, not the raw newer revision.
			const {
				citations: _citations,
				translatedText: _translated,
				translationGeneration: _generation,
				translationParts: _parts,
				...base
			} = block;
			// Keep a long committed prefix even when the bounded raw accumulator only
			// retains its tail. The raw coordinate is never a cleaned-text length.
			if (
				typeof block.rawTextLength === "number" &&
				typeof live.textOffset === "number" &&
				live.textOffset > 0 &&
				block.rawTextLength >= live.textOffset &&
				block.rawTextLength <= live.textOffset + (live.text?.length ?? 0)
			) {
				return withCommittedReasoningTranslation(
					{
						...base,
						...live,
						text:
							(block.text ?? "") + (live.text ?? "").slice(block.rawTextLength - live.textOffset),
					},
					block,
				);
			}
			return withCommittedReasoningTranslation({ ...base, ...live }, block);
		});
		return merged !== message
			? {
					...merged,
					// The matched newer block belongs to this actual upstream request.
					// Older checkpoints can still carry no identity (or a configured alias).
					model: projected.model ?? message.model,
					provider: projected.provider ?? message.provider,
					liveBlockIndex,
					liveContentProjection: true,
				}
			: message;
	});
	const unmatched = filterRowElements(projected, (block) => !block.id || !mergedIds.has(block.id));
	const remaining = projectReasoningContinuation(messages, unmatched, liveBlocks[liveIndex]);
	if (remaining === projected) messages.push(projected);
	else if (messageBody(remaining).length > 0)
		messages.push({
			...remaining,
			liveBlockIndex: messageBody(remaining).indexOf(liveBlocks[liveIndex]),
		});
	return messages;
}

/**
 * An empty reasoning block may be sealed while the provider keeps thinking without
 * exposing its body. Only the latest output gets the waiting treatment, and only
 * while the session is active. This is a display projection, never persistence.
 */
export function projectPendingEmptyReasoning(
	messages: readonly TreeMessage[],
	active: boolean,
	isSubagent = false,
): readonly TreeMessage[] {
	if (!active) return messages;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message || offPage(message, isSubagent)) continue;
		if (message.role !== "assistant") return messages;
		const blocks = messageBody(message);
		if (message.toolCalls?.length) return messages;
		if (blocks.length === 0) continue;
		const blockIndex = blocks.length - 1;
		const block = blocks[blockIndex];
		if (
			!block ||
			!isReasoningBlock(block) ||
			(block.text || block.thinking || "").length > 0 ||
			(block.translatedText ?? "").length > 0
		)
			return messages;
		// A synthetic row's arrival-order stamp is authoritative: a tool event
		// can close its text lane before the tool card is published/persisted.
		if (message.id === "__streaming__") return messages;
		const projected = messages.slice();
		projected[index] = {
			...message,
			liveBlockIndex: blockIndex,
			liveContentProjection: true,
		} as TreeMessage;
		return projected;
	}
	return messages;
}
