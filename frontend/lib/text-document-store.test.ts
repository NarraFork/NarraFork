import { describe, expect, test } from "bun:test";
import {
	TEXT_DOCUMENT_PAGE_CHARS,
	type TextDocumentRef,
} from "@shared/pretext-layout/text-document";
import { TextDocumentStore } from "./text-document-store";

function ref(length: number, revision = 0, id = "doc", epoch = "epoch"): TextDocumentRef {
	return { id, epoch, revision, length, complete: false, originKnown: true };
}
describe("complete sparse text document store", () => {
	test("gap/duplicate/overlap merging preserves CRLF and split/lone surrogates", async () => {
		const store = new TextDocumentStore();
		const text = "a\r\n中😀\ud800z".repeat(2000);
		const metadata = ref(text.length);
		store.append(metadata, 12_000, text.slice(12_000));
		store.append(metadata, 0, text.slice(0, 100));
		store.append(metadata, 80, text.slice(80, 120));
		expect(store.peekRange("doc", 0, text.length)).toBeUndefined();
		let reads = 0;
		store.register(metadata, async (snapshot, offset, limit) => {
			reads++;
			return { ref: snapshot, offset, text: text.slice(offset, offset + limit) };
		});
		expect(await store.readAll("doc")).toBe(text);
		expect(reads).toBeGreaterThan(0);
		const before = store.getSnapshot("doc");
		store.append(metadata, 0, text);
		expect(store.getSnapshot("doc")).toBe(before);
		expect(() => store.append(ref(text.length, 1), 0, `b${text.slice(1)}`)).toThrow("Conflicting");
		expect(store.getSnapshot("doc")).toBe(before);
		expect(await store.readAll("doc")).toBe(text);
	});
	test("original first/middle/tail remain recoverable beyond preview limits and cache eviction", async () => {
		const store = new TextDocumentStore(128);
		const text = `first${"中😀\r\n".repeat(9000)}last`;
		const metadata = store.importText("doc", text);
		expect(store.stats().bytes).toBeLessThanOrEqual(128);
		expect(store.peekRange("doc", 0, 5)).toBeUndefined();
		expect(await store.readRange("doc", 0, 5)).toBe("first");
		expect(await store.readRange("doc", 25_000, 25_010)).toBe(text.slice(25_000, 25_010));
		expect(await store.readAll("doc")).toBe(text);
		expect(store.importText("doc", text)).toBe(metadata);
		expect(store.getSnapshot("doc")).toBe(metadata);
	});
	test("same-content import and authoritative seal preserve stable snapshot/epoch", () => {
		const store = new TextDocumentStore();
		const a = store.importText("a", "complete\r\nsource");
		const b = store.importText("a", "complete\r\nsource");
		expect(a).toBe(b);
		store.append(ref(5, 2, "live", "live-epoch"), 0, "hello");
		const live = store.getSnapshot("live");
		if (!live) throw new Error("Live ref missing");
		const sealed = store.importText("live", "hello");
		expect(sealed.epoch).toBe(live.epoch);
		expect(sealed.revision).toBe(live.revision);
		expect(sealed.complete).toBe(true);
		expect(store.importText("live", "hello")).toBe(sealed);
		const replaced = store.importText("live", "changed", true, "live-epoch");
		expect(replaced.epoch).not.toBe(sealed.epoch);
	});
	test("reader can fill arbitrary short packets; rejects zero progress and epoch changes", async () => {
		const store = new TextDocumentStore();
		const metadata = ref(30);
		store.register(metadata, async (snapshot, offset) => ({
			ref: snapshot,
			offset,
			text: "0123456789".repeat(3).slice(offset, offset + 3),
		}));
		expect(await store.readAll("doc")).toBe("012345678901234567890123456789");
		const empty = ref(1, 0, "empty");
		store.register(empty, async (snapshot, offset) => ({ ref: snapshot, offset, text: "" }));
		expect(store.readAll("empty")).rejects.toThrow("no progress");
		const changed = ref(1, 0, "changed");
		store.register(changed, async (snapshot, offset) => ({
			ref: { ...snapshot, epoch: "new" },
			offset,
			text: "x",
		}));
		expect(store.readAll("changed")).rejects.toThrow("changed while reading");
	});
	test("search matches query across page/CRLF/surrogate boundaries without joining the document", async () => {
		const store = new TextDocumentStore();
		const text = `${"x".repeat(TEXT_DOCUMENT_PAGE_CHARS - 2)}\r\n😀needle中${"z".repeat(60_000)}`;
		store.importText("doc", text);
		expect(await store.search("doc", "\r\n😀needle中")).toEqual({
			start: TEXT_DOCUMENT_PAGE_CHARS - 2,
			end: TEXT_DOCUMENT_PAGE_CHARS + 9,
		});
		expect(await store.search("doc", "needle", TEXT_DOCUMENT_PAGE_CHARS + 6)).toBeNull();
		expect(await store.search("doc", "")).toBeNull();
	});
	test("subscriptions are document-scoped and unsubscribe survives epoch reset", () => {
		const store = new TextDocumentStore();
		let a = 0,
			b = 0;
		const stop = store.subscribe("a", () => a++);
		store.subscribe("b", () => b++);
		expect(store.getSnapshot("missing")).toBeUndefined();
		expect(store.getSnapshot("a")).toBeUndefined();
		store.importText("a", "a");
		store.importText("a", "aa");
		expect(a).toBe(2);
		expect(b).toBe(0);
		stop();
		store.importText("a", "aaa");
		expect(a).toBe(2);
	});
	test("same-revision split packets publish newly readable holes but duplicate packets keep identity", async () => {
		const store = new TextDocumentStore();
		const snapshot = ref(6, 2);
		store.append(snapshot, 3, "def");
		const before = store.getSnapshot("doc");
		let changes = 0;
		store.subscribe("doc", () => changes++);
		store.append(snapshot, 0, "abc");
		expect(store.getSnapshot("doc")).not.toBe(before);
		expect(store.getSnapshot("doc")?.revision).toBe(2);
		expect(changes).toBe(1);
		expect(await store.readAll("doc")).toBe("abcdef");
		const filled = store.getSnapshot("doc");
		store.append(snapshot, 0, "abcdef");
		expect(store.getSnapshot("doc")).toBe(filled);
		expect(changes).toBe(1);
	});
	test("multi-page conflicting overlap is atomic and does not advance metadata", async () => {
		const store = new TextDocumentStore();
		const original = "a".repeat(TEXT_DOCUMENT_PAGE_CHARS * 2);
		store.append(ref(original.length), 0, original);
		const snapshot = store.getSnapshot("doc");
		expect(() => store.append(ref(original.length, 1), 0, `${original.slice(0, -1)}b`)).toThrow(
			"Conflicting",
		);
		expect(store.getSnapshot("doc")).toBe(snapshot);
		expect(await store.readAll("doc")).toBe(original);
	});
	test("source timeout is explicit and retry succeeds without losing earlier source", async () => {
		const store = new TextDocumentStore(1024, 20);
		let first = true;
		store.register(ref(2), async (snapshot, offset, limit) => {
			if (first) {
				first = false;
				return new Promise(() => {});
			}
			return { ref: snapshot, offset, text: "ab".slice(offset, offset + limit) };
		});
		await expect(store.readAll("doc")).rejects.toThrow("timed out (10s)");
		expect(await store.readAll("doc")).toBe("ab");
	});
	test("never evicts unrecoverable chunks, even while retained view is closed", async () => {
		const store = new TextDocumentStore(10);
		store.append(ref(30), 0, "a".repeat(30));
		const release = store.retain("doc");
		release();
		release();
		expect(await store.readAll("doc")).toBe("a".repeat(30));
	});
	test("read cancellation is prompt even when the source ignores the signal; later retry works", async () => {
		const store = new TextDocumentStore();
		let first = true;
		store.register(ref(1), async (snapshot, offset) => {
			if (first) {
				first = false;
				return new Promise(() => {});
			}
			return { ref: snapshot, offset, text: "x" };
		});
		const controller = new AbortController();
		const request = store.readAll("doc", controller.signal);
		controller.abort();
		expect(request).rejects.toThrow();
		expect(await store.readAll("doc")).toBe("x");
	});
});
