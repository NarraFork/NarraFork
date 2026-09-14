import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const sent: Array<{ target: string; message: Record<string, unknown> }> = [];
const realNarratorWsModule = { ...(await import("../../websocket/narrator-ws")) };

mock.module("../../websocket/narrator-ws", () => ({
	...realNarratorWsModule,
	broadcastToNarrator: (narratorId: string, message: Record<string, unknown>) => {
		sent.push({ target: narratorId, message });
	},
}));

const { publishHistoryDeletion, publishHistoryMessage, publishHistoryUpdate } = await import(
	"../narrator-history-publisher"
);

beforeEach(() => {
	sent.length = 0;
});

afterAll(() => {
	mock.module("../../websocket/narrator-ws", () => realNarratorWsModule);
	mock.restore();
});

describe("narrator history publisher", () => {
	test("publishes created messages with the requested wire event kind", () => {
		const message = { id: "message-1", role: "user", contentText: "hello" };

		publishHistoryMessage("narrator-1", message, "user_message");

		expect(sent).toEqual([
			{
				target: "narrator-1",
				message: {
					type: "user_message",
					narratorId: "narrator-1",
					message,
				},
			},
		]);
	});

	test("publishes updates with replacement aliases", () => {
		const message = { id: "new-message", role: "assistant", contentText: "updated" };

		publishHistoryUpdate("narrator-1", message, {
			oldMessageId: "old-message",
			replacedMessageId: "old-message",
		});

		expect(sent[0]).toEqual({
			target: "narrator-1",
			message: {
				type: "message_updated",
				narratorId: "narrator-1",
				message,
				oldMessageId: "old-message",
				replacedMessageId: "old-message",
			},
		});
	});

	test("does not emit an empty deletion frame", () => {
		publishHistoryDeletion("narrator-1", []);

		expect(sent).toEqual([]);
	});

	test("publishes deleted message ids", () => {
		publishHistoryDeletion("narrator-1", ["message-1", "message-2"]);

		expect(sent[0]).toEqual({
			target: "narrator-1",
			message: {
				type: "messages_deleted",
				narratorId: "narrator-1",
				deletedMessageIds: ["message-1", "message-2"],
			},
		});
	});
});
