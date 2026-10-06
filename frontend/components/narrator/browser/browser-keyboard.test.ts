import { describe, expect, it } from "bun:test";
import {
	appendBrowserKeyInput,
	type BrowserKeyInput,
	BrowserKeyStrokeBroker,
	mapBrowserKeyEvent,
} from "./browser-keyboard";

const noMods = { ctrlKey: false, metaKey: false, altKey: false };

describe("mapBrowserKeyEvent", () => {
	it("maps special keys", () => {
		expect(mapBrowserKeyEvent("Enter", noMods)).toEqual({ key: "Enter" });
		expect(mapBrowserKeyEvent("ArrowDown", noMods)).toEqual({ key: "ArrowDown" });
		expect(mapBrowserKeyEvent(" ", noMods)).toEqual({ key: "Space" });
	});

	it("maps printable characters without modifiers", () => {
		expect(mapBrowserKeyEvent("a", noMods)).toEqual({ text: "a" });
		expect(mapBrowserKeyEvent("1", noMods)).toEqual({ text: "1" });
	});

	it("ignores modifier-only and chorded keys", () => {
		expect(mapBrowserKeyEvent("Shift", noMods)).toBe("ignore");
		expect(mapBrowserKeyEvent("a", { ...noMods, ctrlKey: true })).toBe("ignore");
		expect(mapBrowserKeyEvent("a", { ...noMods, metaKey: true })).toBe("ignore");
	});
});

describe("appendBrowserKeyInput", () => {
	it("merges consecutive printable characters", () => {
		let queue: BrowserKeyInput[] = [];
		queue = appendBrowserKeyInput(queue, { text: "h" });
		queue = appendBrowserKeyInput(queue, { text: "i" });
		expect(queue).toEqual([{ text: "hi" }]);
	});

	it("keeps special keys as separate entries", () => {
		let queue: BrowserKeyInput[] = [];
		queue = appendBrowserKeyInput(queue, { text: "hi" });
		queue = appendBrowserKeyInput(queue, { key: "Enter" });
		queue = appendBrowserKeyInput(queue, { text: "!" });
		expect(queue).toEqual([{ text: "hi" }, { key: "Enter" }, { text: "!" }]);
	});
});

describe("BrowserKeyStrokeBroker", () => {
	it("batches rapid keystrokes after the debounce window", async () => {
		const sent: BrowserKeyInput[][] = [];
		const broker = new BrowserKeyStrokeBroker((keys) => sent.push(keys), 20);

		broker.push({ text: "a" });
		broker.push({ text: "b" });
		broker.push({ key: "Enter" });
		expect(sent).toEqual([]);

		await new Promise((r) => setTimeout(r, 40));
		expect(sent).toEqual([[{ text: "ab" }, { key: "Enter" }]]);
		expect(broker.pendingCount).toBe(0);
		broker.dispose();
	});

	it("does not drop keys pressed while an interaction is in flight", async () => {
		const sent: BrowserKeyInput[][] = [];
		const broker = new BrowserKeyStrokeBroker((keys) => sent.push(keys), 20);

		// First burst flushes and blocks (simulates screenshot/type round-trip).
		broker.push({ text: "a" });
		await new Promise((r) => setTimeout(r, 40));
		expect(sent).toEqual([[{ text: "a" }]]);
		expect(broker.isBlocked).toBe(true);

		// Rapid keys during the in-flight interaction must queue, not vanish.
		broker.push({ text: "b" });
		broker.push({ text: "c" });
		broker.push({ key: "ArrowDown" });
		await new Promise((r) => setTimeout(r, 40));
		expect(sent).toEqual([[{ text: "a" }]]);
		// "b"+"c" merge into one text entry + ArrowDown → 2 queued items.
		expect(broker.pendingCount).toBe(2);

		// Settle → remaining keys flush immediately without another debounce wait.
		// That flush itself starts a new in-flight send, so the broker stays blocked
		// until that interaction also settles.
		broker.release();
		expect(sent).toEqual([[{ text: "a" }], [{ text: "bc" }, { key: "ArrowDown" }]]);
		expect(broker.pendingCount).toBe(0);
		expect(broker.isBlocked).toBe(true);

		broker.release();
		expect(broker.isBlocked).toBe(false);
		broker.dispose();
	});

	it("keeps the queue when drain is attempted while blocked", () => {
		const sent: BrowserKeyInput[][] = [];
		const broker = new BrowserKeyStrokeBroker((keys) => sent.push(keys), 20);

		broker.block();
		broker.push({ text: "x" });
		broker.drain();
		expect(sent).toEqual([]);
		expect(broker.pendingCount).toBe(1);

		broker.release();
		expect(sent).toEqual([[{ text: "x" }]]);
		broker.dispose();
	});

	it("flushes keys that arrived during a mouse interaction after release", async () => {
		const sent: BrowserKeyInput[][] = [];
		const broker = new BrowserKeyStrokeBroker((keys) => sent.push(keys), 20);

		// Mouse interaction path: block without sending keys first.
		broker.block();
		broker.push({ text: "z" });
		await new Promise((r) => setTimeout(r, 40));
		expect(sent).toEqual([]);
		expect(broker.pendingCount).toBe(1);

		broker.release();
		expect(sent).toEqual([[{ text: "z" }]]);
		broker.dispose();
	});
});
