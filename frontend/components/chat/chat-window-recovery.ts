import type { ChatMessage, ChatMessagePage } from "../../lib/api/chat";

export const CHAT_RECOVERY_MAX_PAGES = 100;
export const CHAT_RECOVERY_MAX_BYTES = 32 * 1024 * 1024;
export const CHAT_NEW_MESSAGE_BUDGET = 400;

/** Read a fixed inclusive seq interval, never substitute a new tail on failure. */
export async function recoverChatRange(args: {
	minSeq: number;
	maxSeq: number;
	signal: AbortSignal;
	fetchPage: (params: {
		afterSeq: number;
		beforeSeq: number;
		limit: number;
		signal: AbortSignal;
		maxResponseBytes: number;
		onResponseBytes: (bytes: number) => void;
	}) => Promise<ChatMessagePage>;
	assertCurrent: () => void;
}): Promise<ChatMessage[]> {
	let afterSeq = args.minSeq - 1;
	let bytes = 0;
	const messages: ChatMessage[] = [];
	const signal = AbortSignal.any([args.signal, AbortSignal.timeout(10_000)]);
	const started = Date.now();
	for (let pageIndex = 0; pageIndex < CHAT_RECOVERY_MAX_PAGES; pageIndex++) {
		args.signal.throwIfAborted();
		args.assertCurrent();
		if (Date.now() - started >= 10_000)
			throw new Error("Chat window recovery timed out; retry to keep your position");
		let responseBytes: number | undefined;
		const page = await args.fetchPage({
			afterSeq,
			beforeSeq: args.maxSeq + 1,
			limit: 100,
			signal,
			maxResponseBytes: CHAT_RECOVERY_MAX_BYTES - bytes,
			onResponseBytes: (size) => {
				responseBytes = size;
			},
		});
		signal.throwIfAborted();
		args.assertCurrent();
		bytes += responseBytes ?? new TextEncoder().encode(JSON.stringify(page)).byteLength;
		if (bytes > CHAT_RECOVERY_MAX_BYTES)
			throw new Error(
				"Chat window recovery exceeded its byte budget; retry without changing position",
			);
		for (const message of page.messages) {
			if (message.seq <= afterSeq || message.seq > args.maxSeq)
				throw new Error("Chat recovery returned an invalid seq interval");
			afterSeq = message.seq;
			messages.push(message);
		}
		if (!page.hasNext) return messages;
		if (!page.messages.length || page.nextAfterSeq !== afterSeq)
			throw new Error("Chat recovery cursor did not advance");
	}
	throw new Error("Chat window recovery exceeded its page budget; retry without changing position");
}
