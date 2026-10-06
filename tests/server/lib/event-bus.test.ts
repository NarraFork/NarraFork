import { afterEach, describe, expect, it } from "bun:test";
import { eventBus, type NarraForkEvent } from "../../../server/lib/event-bus";

describe("eventBus", () => {
	const handlers: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of handlers) cleanup();
		handlers.length = 0;
	});

	it("delivers typed events to subscribers", () => {
		const received: NarraForkEvent[] = [];
		const handler = (e: NarraForkEvent) => received.push(e);
		// biome-ignore lint/suspicious/noExplicitAny: test utility cast
		eventBus.on("chapter:created", handler as any);
		// biome-ignore lint/suspicious/noExplicitAny: test utility cast
		handlers.push(() => eventBus.off("chapter:created", handler as any));

		eventBus.emit({ type: "chapter:created", chapterId: "c1", projectId: "p1" });
		expect(received).toHaveLength(1);
		expect(received[0].type).toBe("chapter:created");
	});

	it("does not deliver events of other types", () => {
		const received: NarraForkEvent[] = [];
		const handler = (e: NarraForkEvent) => received.push(e);
		// biome-ignore lint/suspicious/noExplicitAny: test utility cast
		eventBus.on("chapter:dormant", handler as any);
		// biome-ignore lint/suspicious/noExplicitAny: test utility cast
		handlers.push(() => eventBus.off("chapter:dormant", handler as any));

		eventBus.emit({ type: "chapter:created", chapterId: "c1", projectId: "p1" });
		expect(received).toHaveLength(0);
	});

	it("onAny receives all events", () => {
		const received: NarraForkEvent[] = [];
		const handler = (e: NarraForkEvent) => received.push(e);
		eventBus.onAny(handler);
		handlers.push(() => eventBus.offAny(handler));

		eventBus.emit({ type: "chapter:created", chapterId: "c1", projectId: "p1" });
		eventBus.emit({ type: "narrator:status_changed", narratorId: "n1", status: "idle" });
		expect(received).toHaveLength(2);
	});
});
