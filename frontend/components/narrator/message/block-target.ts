/**
 * block-target.ts — the block an action on a message element names
 * (docs/BLOCK_STORAGE-DESIGN.md §5.5, P3d).
 *
 * Delete, rollback and edit act on whole blocks. The block holding the element is read
 * from the message's row when the action starts. Only a block the server named can be
 * acted on: a row built on the client (the live streaming row) has none yet.
 */

import { blockAtIndex, messageBlocks } from "@shared/narrator-blocks/message-blocks";
import type { BlockTarget } from "../../../lib/api/narrators";
import type { MessageListHandle } from "./message-list-handle";

type MessageLookup = Pick<MessageListHandle, "messageOf"> | null | undefined;

/** Element `blockIndex` of the message with the block holding it; null unless the server named it. */
export function blockTargetOf(
	list: MessageLookup,
	messageId: string,
	blockIndex: number,
): BlockTarget | null {
	const message = list?.messageOf(messageId);
	const block = message ? blockAtIndex(message, blockIndex) : undefined;
	return block?.named ? { messageId, blockIndex, blockId: block.id } : null;
}

/** The message's input block, when the server named exactly one. */
export function inputBlockIdOf(list: MessageLookup, messageId: string): string | undefined {
	const message = list?.messageOf(messageId);
	const inputs = message ? messageBlocks(message).filter((block) => block.kind === "input") : [];
	return inputs.length === 1 && inputs[0].named ? inputs[0].id : undefined;
}
