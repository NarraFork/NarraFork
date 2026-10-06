import { describe, expect, test } from "bun:test";
import {
	bufferRealtimeMessage,
	CATCH_UP_BUFFER_MAX_MESSAGES,
	collectMessageIds,
	createCatchUpBuffer,
	drainCatchUpBuffer,
	getBufferedMessageId,
} from "./catch-up-buffer";
import type { NarratorServerMessage } from "./narrator-ws-types";

function messageFrame(id: string): NarratorServerMessage {
	return { type: "message", narratorId: "n1", message: { id } };
}

function statusFrame(status: string): NarratorServerMessage {
	return { type: "status_change", narratorId: "n1", status };
}

describe("collectMessageIds", () => {
	test("collects ids from a nested catch-up tree", () => {
		const ids = collectMessageIds([
			{ id: "top-1", children: [{ id: "child-1" }, { id: "child-2" }] },
			{ id: "top-2" },
		]);
		expect([...ids].sort()).toEqual(["child-1", "child-2", "top-1", "top-2"]);
	});

	test("ignores non-object values", () => {
		expect(collectMessageIds(null).size).toBe(0);
		expect(collectMessageIds("nope").size).toBe(0);
	});
});

describe("getBufferedMessageId", () => {
	test("extracts the id from message / user_message frames", () => {
		expect(getBufferedMessageId(messageFrame("m1"))).toBe("m1");
		expect(
			getBufferedMessageId({ type: "user_message", narratorId: "n1", message: { id: "u1" } }),
		).toBe("u1");
	});

	test("returns undefined for non-message frames", () => {
		expect(getBufferedMessageId(statusFrame("working"))).toBeUndefined();
	});
});

describe("catch-up buffer accumulation + drain", () => {
	test("drains buffered realtime frames in order", () => {
		const buffer = createCatchUpBuffer();
		bufferRealtimeMessage(buffer, statusFrame("working"), 20);
		bufferRealtimeMessage(buffer, messageFrame("m2"), 20);
		const result = drainCatchUpBuffer(buffer);
		expect(result.overflow).toBe(false);
		if (!result.overflow) {
			expect(result.messages).toEqual([statusFrame("working"), messageFrame("m2")]);
		}
	});

	test("skips buffered messages already delivered via catch_up", () => {
		const buffer = createCatchUpBuffer();
		// m1 was included in the catch_up frame; the realtime echo must be dropped.
		buffer.sentMessageIds.add("m1");
		bufferRealtimeMessage(buffer, messageFrame("m1"), 20);
		bufferRealtimeMessage(buffer, messageFrame("m2"), 20);
		bufferRealtimeMessage(buffer, statusFrame("idle"), 20);
		const result = drainCatchUpBuffer(buffer);
		expect(result.overflow).toBe(false);
		if (!result.overflow) {
			expect(result.messages).toEqual([messageFrame("m2"), statusFrame("idle")]);
		}
	});

	test("overflows to a reload when the message budget is exceeded", () => {
		const buffer = createCatchUpBuffer();
		for (let i = 0; i < CATCH_UP_BUFFER_MAX_MESSAGES + 5; i++) {
			bufferRealtimeMessage(buffer, messageFrame(`m${i}`), 10);
		}
		expect(buffer.overflowed).toBe(true);
		expect(drainCatchUpBuffer(buffer)).toEqual({ overflow: true });
	});

	test("overflows to a reload when the byte budget is exceeded", () => {
		const buffer = createCatchUpBuffer();
		bufferRealtimeMessage(buffer, messageFrame("m1"), 3_000_000);
		expect(buffer.overflowed).toBe(true);
		expect(drainCatchUpBuffer(buffer)).toEqual({ overflow: true });
	});
});
