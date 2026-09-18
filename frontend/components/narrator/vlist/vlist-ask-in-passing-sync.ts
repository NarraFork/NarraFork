import type { TreeMessage } from "@frontend/lib/api/types";

export function askInPassingBlock(message: TreeMessage) {
	return Array.isArray(message.contentJson)
		? message.contentJson.find((block) => block?.type === "ask_in_passing")
		: undefined;
}

/** Source-id anchored insertion; only the first observation consumes a seq slot. */
export function syncAskInPassingMessage(
	loaded: readonly TreeMessage[],
	message: TreeMessage,
	structureVersion?: number,
) {
	const block = askInPassingBlock(message);
	if (!block) return undefined;
	const existingIndex = loaded.findIndex((row) => row.id === message.id);
	if (existingIndex >= 0) {
		const previous = loaded[existingIndex];
		if (askInPassingBlock(previous)?.status === "resolved" && block.status === "pending") {
			return { messages: loaded, changed: false, appended: false };
		}
		const messages = [...loaded];
		// HTTP can arrive after later inserts shifted this row: retain the local seq.
		messages[existingIndex] = { ...previous, ...message, seq: previous.seq };
		return { messages, changed: true, appended: false };
	}
	// A seq collision does not prove that our snapshot predates this insertion.
	// Gaps, out-of-order HTTP/WS acknowledgements and fetched projections all make
	// that inference unsafe. Only an adjacent atomic version proves one shift.
	if (structureVersion == null || message.askInsertVersion !== structureVersion + 1)
		return undefined;
	const sourceIndex = loaded.findIndex((row) => row.id === block.sourceMessageId);
	const sourceSeq = loaded[sourceIndex]?.seq;
	if (typeof sourceSeq !== "number" || !Number.isFinite(sourceSeq)) return undefined;
	const seq = sourceSeq + 1;
	if (message.seq !== seq) return undefined;
	const messages = loaded.map((row) =>
		typeof row.seq === "number" && row.seq >= seq ? { ...row, seq: row.seq + 1 } : row,
	);
	messages.splice(sourceIndex + 1, 0, { ...message, seq });
	return { messages, changed: true, appended: sourceIndex === loaded.length - 1 };
}
