import { broadcastToNarrator } from "../websocket/narrator-ws";
import type { NarratorServerMessage } from "../websocket/narrator-ws-types";

/**
 * Single service boundary for canonical-history websocket frames.
 *
 * The wire event names stay unchanged for compatibility; callers only provide the
 * canonical row and optional replacement aliases, not a hand-built frame.
 */
export type HistoryMessage =
	Extract<NarratorServerMessage, { type: "message" }> extends {
		message: infer T;
	}
		? T
		: never;

export function publishHistoryMessage(
	narratorId: string,
	message: HistoryMessage,
	kind: "message" | "user_message" = "message",
): void {
	broadcastToNarrator(narratorId, { type: kind, narratorId, message } as NarratorServerMessage);
}

export function publishHistoryUpdate(
	narratorId: string,
	message: HistoryMessage,
	aliases?: Partial<Extract<NarratorServerMessage, { type: "message_updated" }>>,
): void {
	broadcastToNarrator(narratorId, {
		...aliases,
		type: "message_updated",
		narratorId,
		message,
	});
}

export function publishHistoryDeletion(
	narratorId: string,
	deletedMessageIds: string[],
	aliases?: Partial<Extract<NarratorServerMessage, { type: "messages_deleted" }>>,
): void {
	if (deletedMessageIds.length === 0) return;
	broadcastToNarrator(narratorId, {
		...aliases,
		type: "messages_deleted",
		narratorId,
		deletedMessageIds,
	});
}
