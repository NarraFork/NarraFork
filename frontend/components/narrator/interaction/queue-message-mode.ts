import type { BufferMessageSummary } from "../../../lib/api";
import type { QueueMode } from "../composer/SendOptionsSplitButton";

export function queuedMessageMode(message: BufferMessageSummary): QueueMode {
	return message.queueMode ?? (message.priority ? "tool" : "turn");
}

/** Reorder only ordinary messages, preserving guidance slots and relative order. */
export function moveQueuedTurn(
	messages: BufferMessageSummary[],
	id: string,
	targetId: string,
): BufferMessageSummary[] {
	const ordinary = messages.filter((message) => queuedMessageMode(message) === "turn");
	const from = ordinary.findIndex((message) => message.id === id);
	const to = ordinary.findIndex((message) => message.id === targetId);
	if (from < 0 || to < 0 || from === to) return messages;
	const [moved] = ordinary.splice(from, 1);
	ordinary.splice(to, 0, moved);
	let index = 0;
	return messages.map((message) =>
		queuedMessageMode(message) === "turn" ? ordinary[index++] : message,
	);
}
