import { describe, expect, test } from "bun:test";
import { GatewayStreamConsumer } from "../stream-consumer";
import type { PlatformAdapter, SendResult } from "../types";

function adapter(
	overrides: Pick<PlatformAdapter, "sendAndGetId" | "editMessage">,
): PlatformAdapter {
	return {
		platform: "webhook",
		maxMessageLength: 4000,
		supportsEdit: true,
		connect: async () => true,
		disconnect: async () => {},
		send: async () => {},
		sendTyping: async () => {},
		onMessage: () => {},
		...overrides,
	};
}

describe("GatewayStreamConsumer.abort", () => {
	test("logs when the final edit is not delivered", async () => {
		let markSent: () => void = () => {};
		const sent = new Promise<void>((resolve) => {
			markSent = resolve;
		});
		const adapterUnderTest = adapter({
			sendAndGetId: async () => {
				markSent();
				return { success: true, messageId: "m1" } satisfies SendResult;
			},
			editMessage: async () => ({ success: false, error: "rejected" }) satisfies SendResult,
		});
		const consumer = new GatewayStreamConsumer(adapterUnderTest, "chat", {
			editInterval: 0,
			bufferThreshold: 1,
		});
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (message?: unknown) => {
			warnings.push(String(message));
		};
		const finished = consumer.start();
		try {
			consumer.onDelta("hello");
			await sent;
			await Promise.resolve();
			consumer.abort();
			await finished;
			await Promise.resolve();
			expect(warnings.some((line) => line.includes("Abort final edit was not delivered"))).toBe(
				true,
			);
		} finally {
			console.warn = originalWarn;
			consumer.abort();
		}
	});
});
