import { expect, mock, test } from "bun:test";
import type { ChatMessage } from "../../lib/api/chat";
import { CHAT_RECOVERY_MAX_PAGES, recoverChatRange } from "./chat-window-recovery";

function row(seq: number): ChatMessage {
	return { id: `m${seq}`, seq, deletedAt: seq === 2 ? "deleted" : null } as ChatMessage;
}

test("fixed inclusive range walks ASC with limit100 and preserves tombstones", async () => {
	const calls: { afterSeq: number; beforeSeq: number; limit: number }[] = [];
	const result = await recoverChatRange({
		minSeq: 1,
		maxSeq: 3,
		signal: new AbortController().signal,
		assertCurrent() {},
		fetchPage: async (params) => {
			calls.push(params);
			return params.afterSeq === 0
				? {
						messages: [row(1), row(2)],
						hasMore: true,
						nextBeforeSeq: null,
						hasNext: true,
						nextAfterSeq: 2,
					}
				: {
						messages: [row(3)],
						hasMore: false,
						nextBeforeSeq: null,
						hasNext: false,
						nextAfterSeq: 3,
					};
		},
	});
	expect(calls.map(({ afterSeq, beforeSeq, limit }) => ({ afterSeq, beforeSeq, limit }))).toEqual([
		{ afterSeq: 0, beforeSeq: 4, limit: 100 },
		{ afterSeq: 2, beforeSeq: 4, limit: 100 },
	]);
	expect(result.map((message) => message.seq)).toEqual([1, 2, 3]);
	expect(result[1]?.deletedAt).toBe("deleted");
});

test("late retired epoch and cancellation reject instead of committing stale rows", async () => {
	const controller = new AbortController();
	const fetchPage = mock(async () => {
		controller.abort();
		return { messages: [row(1)], hasMore: false, nextBeforeSeq: null, hasNext: false };
	});
	await expect(
		recoverChatRange({
			minSeq: 1,
			maxSeq: 1,
			signal: controller.signal,
			assertCurrent() {},
			fetchPage,
		}),
	).rejects.toMatchObject({ name: "AbortError" });
	expect(fetchPage).toHaveBeenCalledTimes(1);
});

test("page budget throws without issuing a tail request or mutating the original window", async () => {
	const original = [row(1), row(1000)];
	const fetchPage = mock(async ({ afterSeq }: { afterSeq: number }) => ({
		messages: [row(afterSeq + 1)],
		hasMore: true,
		nextBeforeSeq: null,
		hasNext: true,
		nextAfterSeq: afterSeq + 1,
	}));
	await expect(
		recoverChatRange({
			minSeq: 1,
			maxSeq: 1000,
			signal: new AbortController().signal,
			assertCurrent() {},
			fetchPage,
		}),
	).rejects.toThrow("page budget");
	expect(fetchPage).toHaveBeenCalledTimes(CHAT_RECOVERY_MAX_PAGES);
	expect(original.map((message) => message.seq)).toEqual([1, 1000]);
});

test("temporary failure has no tail fallback and nonadvancing cursor is rejected", async () => {
	const fetchPage = mock(async () => {
		throw new Error("temporarily unavailable");
	});
	await expect(
		recoverChatRange({
			minSeq: 20,
			maxSeq: 30,
			signal: new AbortController().signal,
			assertCurrent() {},
			fetchPage,
		}),
	).rejects.toThrow("temporarily unavailable");
	expect(fetchPage).toHaveBeenCalledTimes(1);
	await expect(
		recoverChatRange({
			minSeq: 20,
			maxSeq: 30,
			signal: new AbortController().signal,
			assertCurrent() {},
			fetchPage: async () => ({
				messages: [],
				hasMore: true,
				nextBeforeSeq: null,
				hasNext: true,
				nextAfterSeq: 19,
			}),
		}),
	).rejects.toThrow("did not advance");
});
