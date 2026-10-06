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

describe("document source lifecycle and budgets", () => {
	test("complete imports and their pages converge to separate budgets after owners close", () => {
		const store = new TextDocumentStore(16, 1000, {
			maxImportedBytes: 40,
			maxIdleDocuments: 2,
		});
		for (let i = 0; i < 25; i++) {
			store.importText(`doc-${i}`, "x".repeat(10));
			store.retainSource(`doc-${i}`)();
		}
		expect(store.stats().importedBytes).toBeLessThanOrEqual(40);
		expect(store.stats().pageBytes).toBeLessThanOrEqual(16);
		expect(store.stats().documents).toBeLessThanOrEqual(2);
		expect(store.stats().totalBytes).toBe(store.stats().pageBytes + store.stats().importedBytes);
		expect(store.hasReadableSource("doc-0")).toBe(false);
	});
	test("new admission survives until pinned, but closing an oversized source releases it", () => {
		const store = new TextDocumentStore(0, 1000, {
			maxImportedBytes: 2,
			maxIdleDocuments: 0,
		});
		store.importText("doc", "oversized");
		expect(store.hasReadableSource("doc")).toBe(true);
		const release = store.retainSource("doc");
		expect(store.stats().pinnedDocuments).toBe(1);
		expect(store.stats().overBudgetBytes).toBeGreaterThan(0);
		release();
		expect(store.stats().documents).toBe(0);
		expect(store.stats().totalBytes).toBe(0);
	});
	test("idle external readers cannot retain unbounded entries or bypass local source accounting", async () => {
		const store = new TextDocumentStore(0, 1000, {
			maxImportedBytes: 4,
			maxIdleDocuments: 2,
		});
		for (let i = 0; i < 10; i++) {
			store.register(ref(1, 0, `remote-${i}`), async (snapshot, offset) => ({
				ref: snapshot,
				offset,
				text: "r",
			}));
		}
		expect(store.stats().documents).toBeLessThanOrEqual(2);
		store.importText("local", "abc");
		store.register(store.getSnapshot("local") as TextDocumentRef, async () => {
			throw new Error("local imports must take precedence");
		});
		expect(await store.readAll("local")).toBe("abc");
		expect(store.hasReadableSource("local")).toBe(false);
		expect(store.stats().importedBytes).toBe(0);
	});
	test("readability requires a real source or full sparse coverage, without assembling text", () => {
		const store = new TextDocumentStore();
		store.subscribe("placeholder", () => {});
		expect(store.hasReadableSource("placeholder")).toBe(false);
		store.append(ref(6), 3, "def");
		expect(store.hasReadableSource("doc")).toBe(false);
		store.append(ref(6), 0, "abc");
		expect(store.hasReadableSource("doc", "epoch")).toBe(true);
		expect(store.hasReadableSource("doc", "wrong")).toBe(false);
		store.register(ref(100, 0, "remote"), async (snapshot, offset) => ({
			ref: snapshot,
			offset,
			text: "x",
		}));
		expect(store.hasReadableSource("remote")).toBe(true);
	});
	test("unique incomplete local chunks survive zero observers and budget pressure until explicit discard", async () => {
		const store = new TextDocumentStore(0, 1000, {
			maxImportedBytes: 0,
			maxIdleDocuments: 0,
		});
		store.append(ref(6), 0, "abc");
		store.retainSource("doc")();
		store.retain("doc")();
		store.importText("other", "x");
		expect(store.peekRange("doc", 0, 3)).toBe("abc");
		expect(store.stats().unrecoverableDocuments).toBe(1);
		store.discard("doc", "wrong");
		expect(await store.readRange("doc", 0, 3)).toBe("abc");
		store.discard("doc", "epoch");
		expect(store.getSnapshot("doc")).toBeUndefined();
	});
	test("discard waits for every source owner, view retain and subscription; releases are idempotent", () => {
		const store = new TextDocumentStore();
		store.importText("doc", "abc");
		const first = store.retainSource("doc");
		const second = store.retainSource("doc");
		const closeView = store.retain("doc");
		const unsubscribe = store.subscribe("doc", () => {});
		first(true);
		first(true);
		expect(store.hasReadableSource("doc")).toBe(true);
		second();
		closeView();
		expect(store.hasReadableSource("doc")).toBe(true);
		unsubscribe();
		unsubscribe();
		expect(store.stats().documents).toBe(0);
		expect(store.stats().totalBytes).toBe(0);
	});
	test("unsubscribe evicts now-idle imported sources without requiring a source owner", () => {
		const store = new TextDocumentStore(0, 1000, { maxImportedBytes: 0 });
		const stop = store.subscribe("doc", () => {});
		store.importText("doc", "abc");
		expect(store.stats().importedBytes).toBe(6);
		stop();
		expect(store.stats().documents).toBe(0);
		expect(store.stats().importedBytes).toBe(0);
	});
	test("old epoch owner release cannot retire a newly pinned replacement", async () => {
		const store = new TextDocumentStore();
		store.importText("doc", "old");
		const releaseOld = store.retainSource("doc");
		const next = store.importText("doc", "new");
		const releaseNew = store.retainSource("doc");
		releaseOld(true);
		store.discard("doc", "wrong");
		expect(await store.readAll("doc")).toBe("new");
		expect(store.getSnapshot("doc")).toBe(next);
		expect(store.stats().importedBytes).toBe(6);
		releaseNew(true);
		expect(store.stats().documents).toBe(0);
	});
	test("epoch replacement subtracts old imported bytes and sparse pages", () => {
		const store = new TextDocumentStore();
		store.importText("doc", "long old body");
		store.importText("doc", "new");
		expect(store.stats().importedBytes).toBe(6);
		expect(store.stats().pageBytes).toBe(6);
		store.register(ref(10, 0, "doc", "external"));
		expect(store.stats().importedBytes).toBe(0);
		expect(store.stats().pageBytes).toBe(0);
	});
	test("evicted IDs receive fresh default epochs while current same-content seals stay stable", () => {
		const store = new TextDocumentStore(0, 1000, { maxIdleDocuments: 0 });
		const first = store.importText("doc", "abc");
		store.retainSource("doc")(true);
		const second = store.importText("doc", "abc");
		expect(second.epoch).not.toBe(first.epoch);
		expect(store.hasReadableSource("doc", first.epoch)).toBe(false);
		expect(store.importText("doc", "abc")).toBe(second);
	});
	test("in-flight full-source copy holds its reader across owner discard and idle pressure", async () => {
		const store = new TextDocumentStore(0, 1000, { maxIdleDocuments: 0 });
		let complete: (() => void) | undefined;
		store.register(ref(3), async (snapshot, offset) => {
			await new Promise<void>((resolve) => {
				complete = resolve;
			});
			return { ref: snapshot, offset, text: "abc" };
		});
		const release = store.retainSource("doc");
		const copy = store.readAll("doc");
		release(true);
		store.importText("pressure", "pressure");
		expect(store.hasReadableSource("doc")).toBe(true);
		complete?.();
		expect(await copy).toBe("abc");
		expect(store.hasReadableSource("doc")).toBe(false);
	});
	test("entire multi-page search is pinned between readRange calls and yields", async () => {
		const store = new TextDocumentStore(0, 1000, { maxIdleDocuments: 0 });
		const text = `${"x".repeat(TEXT_DOCUMENT_PAGE_CHARS * 2)}needle`;
		let started: (() => void) | undefined;
		let complete: (() => void) | undefined;
		const firstRead = new Promise<void>((resolve) => {
			started = resolve;
		});
		store.register(ref(text.length), async (snapshot, offset, limit) => {
			if (offset === 0) {
				started?.();
				await new Promise<void>((resolve) => {
					complete = resolve;
				});
			}
			return { ref: snapshot, offset, text: text.slice(offset, offset + limit) };
		});
		const release = store.retainSource("doc");
		const search = store.search("doc", "needle");
		await firstRead;
		release(true);
		complete?.();
		expect(await search).toEqual({ start: text.length - 6, end: text.length });
		expect(store.getSnapshot("doc")).toBeUndefined();
	});
	test("unowned multi-document imports close through subscriptions and are bounded", () => {
		const store = new TextDocumentStore(16, 1000, {
			maxImportedBytes: 40,
			maxIdleDocuments: 2,
		});
		for (let i = 0; i < 25; i++) {
			const stop = store.subscribe(`doc-${i}`, () => {});
			store.importText(`doc-${i}`, "x".repeat(10));
			stop();
		}
		expect(store.stats().sourceOwners).toBe(0);
		expect(store.stats().documents).toBeLessThanOrEqual(2);
		expect(store.stats().importedBytes).toBeLessThanOrEqual(40);
	});
	test("idle source LRU preserves recently read documents instead of admission order", async () => {
		const store = new TextDocumentStore(0, 1000, { maxIdleDocuments: 2 });
		store.importText("a", "a");
		store.importText("b", "b");
		expect(await store.readAll("a")).toBe("a");
		store.importText("c", "c");
		expect(store.hasReadableSource("a")).toBe(true);
		expect(store.hasReadableSource("b")).toBe(false);
		expect(store.hasReadableSource("c")).toBe(true);
	});
	test("normal source-owner handoff stays readable under budget, while explicit discard releases it", async () => {
		const store = new TextDocumentStore();
		const snapshot = store.importText("doc", "handoff");
		store.retainSource("doc")();
		expect(store.getSnapshot("doc")).toBe(snapshot);
		expect(await store.readAll("doc")).toBe("handoff");
		store.discard("doc", snapshot.epoch);
		expect(store.stats().documents).toBe(0);
		expect(store.stats().totalBytes).toBe(0);
	});
	test("cancellation and timeout release read pins even when external readers never settle", async () => {
		const store = new TextDocumentStore(0, 20);
		for (const id of ["cancel", "timeout"])
			store.register(ref(1, 0, id), async () => new Promise(() => {}));
		const controller = new AbortController();
		const cancelled = store.readAll("cancel", controller.signal);
		store.discard("cancel");
		expect(store.stats().activeReads).toBe(1);
		controller.abort();
		await expect(cancelled).rejects.toThrow();
		expect(store.hasReadableSource("cancel")).toBe(false);
		const timedOut = store.readAll("timeout");
		store.discard("timeout");
		await expect(timedOut).rejects.toThrow("timed out");
		expect(store.stats().activeReads).toBe(0);
		expect(store.stats().documents).toBe(0);
	});
	test("only the local imported prefix is page-evictable after streaming grows its watermark", async () => {
		const store = new TextDocumentStore(0, 1000, { maxIdleDocuments: 0 });
		const prefix = "x".repeat(TEXT_DOCUMENT_PAGE_CHARS + 3);
		const initial = store.importText("doc", prefix, false);
		const next = { ...initial, revision: initial.revision + 1, length: prefix.length + 4 };
		store.append(next, prefix.length, "tail");
		store.retainSource("doc")();
		expect(await store.readAll("doc")).toBe(`${prefix}tail`);
		store.discard("doc");
		expect(store.stats().totalBytes).toBe(0);
	});
	test("a late page result after cancellation stays inert even if the entry still exists", async () => {
		const store = new TextDocumentStore();
		let complete: (() => void) | undefined;
		store.register(ref(3), async (snapshot, offset) => {
			await new Promise<void>((resolve) => {
				complete = resolve;
			});
			return { ref: snapshot, offset, text: "old" };
		});
		const controller = new AbortController();
		const pending = store.readAll("doc", controller.signal);
		controller.abort();
		await expect(pending).rejects.toThrow();
		complete?.();
		await Promise.resolve();
		await Promise.resolve();
		expect(store.stats().pageBytes).toBe(0);
		expect(store.stats().activeReads).toBe(0);
	});
	test("late read completion cannot write pages into a new epoch", async () => {
		const store = new TextDocumentStore();
		let complete: (() => void) | undefined;
		store.register(ref(3), async (snapshot, offset) => {
			await new Promise<void>((resolve) => {
				complete = resolve;
			});
			return { ref: snapshot, offset, text: "old" };
		});
		const pending = store.readAll("doc");
		store.importText("doc", "new");
		complete?.();
		await expect(pending).rejects.toThrow("changed while reading");
		expect(await store.readAll("doc")).toBe("new");
		expect(store.stats().pageBytes).toBe(6);
	});
});
