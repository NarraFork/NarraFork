import { afterEach, describe, expect, test } from "bun:test";
import { textDocumentStore } from "@frontend/lib/text-document-store";
import { copyDocument } from "./document-clipboard";
import { findDocumentMatch } from "./document-search";
import {
	documentAutoscroll,
	markedIntervals,
	moveSelection,
	selectionRange,
	selectOffset,
} from "./document-selection";

const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const savedClipboardItem = Object.getOwnPropertyDescriptor(globalThis, "ClipboardItem");
afterEach(() => {
	for (const [key, value] of [
		["navigator", savedNavigator],
		["ClipboardItem", savedClipboardItem],
	] as const) {
		if (value) Object.defineProperty(globalThis, key, value);
		else Reflect.deleteProperty(globalThis, key);
	}
});

describe("document raw-offset interaction", () => {
	test("reverse drag and Shift expansion survive unmounted windows and append", () => {
		const previous = { anchor: 10000, focus: 10020 };
		const reverse = selectOffset(previous, 10, true, 50000);
		expect(selectionRange(reverse)).toEqual({ start: 10, end: 10000 });
		const appended = selectOffset(reverse, 50020, true, 60000);
		expect(appended.anchor).toBe(10000);
		expect(appended.focus).toBe(50020);
		expect(moveSelection(reverse, -1, false, 60000)).toEqual({ anchor: 10, focus: 10 });
		expect(moveSelection({ anchor: 10, focus: 10 }, 1, true, 60000)).toEqual({
			anchor: 10,
			focus: 11,
		});
	});
	test("virtual row marks preserve both search and selection intersections", () => {
		expect(
			markedIntervals(100, 120, { anchor: 110, focus: 105 }, { start: 108, end: 114 }),
		).toEqual([
			{ start: 100, end: 105, selected: false, found: false },
			{ start: 105, end: 108, selected: true, found: false },
			{ start: 108, end: 110, selected: true, found: true },
			{ start: 110, end: 114, selected: false, found: true },
			{ start: 114, end: 120, selected: false, found: false },
		]);
	});
	test("drag autoscroll is bounded and reverses at viewport edges", () => {
		expect(documentAutoscroll(150, 100, 100)).toBe(0);
		expect(documentAutoscroll(90, 100, 100)).toBeLessThan(0);
		expect(documentAutoscroll(210, 100, 100)).toBeGreaterThan(0);
		expect(documentAutoscroll(10000, 100, 100)).toBe(36);
	});
	test("copy reads raw CRLF and whitespace, never inserts visual wrap separators", async () => {
		const source = `${"FIRST\r\n\t  中文😀".repeat(4000)}\r\nLAST`;
		const ref = textDocumentStore.importText("raw-copy", source);
		const values: string[] = [];
		Object.defineProperty(globalThis, "ClipboardItem", { configurable: true, value: undefined });
		Object.defineProperty(globalThis, "navigator", {
			configurable: true,
			value: {
				clipboard: {
					writeText: async (value: string) => {
						values.push(value);
					},
				},
			},
		});
		await copyDocument(ref, { start: 7, end: source.length - 2 });
		await copyDocument(ref);
		expect(values).toEqual([source.slice(7, -2), source]);
	});
	test("promised ClipboardItem is constructed synchronously before async range recovery", async () => {
		let activated = true;
		let promised: Promise<Blob> | undefined;
		const source = "deferred\r\n \t";
		const ref = {
			id: "promise-copy",
			epoch: "e",
			length: source.length,
			revision: 1,
			complete: true,
			originKnown: true,
		};
		textDocumentStore.register(ref, async (snapshot, offset, limit) => {
			await Promise.resolve();
			return { ref: snapshot, offset, text: source.slice(offset, offset + limit) };
		});
		Object.defineProperty(globalThis, "ClipboardItem", {
			configurable: true,
			value: class {
				constructor(data: Record<string, Promise<Blob>>) {
					expect(activated).toBe(true);
					promised = data["text/plain"];
				}
			},
		});
		Object.defineProperty(globalThis, "navigator", {
			configurable: true,
			value: {
				clipboard: {
					write: async () => {
						expect(activated).toBe(true);
						expect(await (await promised)?.text()).toBe(source);
					},
				},
			},
		});
		const copy = copyDocument(ref);
		activated = false;
		await copy;
	});
	test("copy errors stay explicit rather than reporting success", async () => {
		const ref = textDocumentStore.importText("error-copy", "all");
		Object.defineProperty(globalThis, "ClipboardItem", { configurable: true, value: undefined });
		Object.defineProperty(globalThis, "navigator", {
			configurable: true,
			value: {
				clipboard: {
					writeText: async () => {
						throw new Error("denied");
					},
				},
			},
		});
		expect(copyDocument(ref)).rejects.toThrow("denied");
	});
	test("full source next/previous search reaches unmounted first/middle/tail and wraps", async () => {
		const source = `FIND${"x".repeat(20000)}FIND${"y".repeat(20000)}FIND`;
		const ref = textDocumentStore.importText("full-find", source);
		const first = await findDocumentMatch(ref.id, "FIND", null, 1);
		const middle = await findDocumentMatch(ref.id, "FIND", first, 1);
		const tail = await findDocumentMatch(ref.id, "FIND", middle, 1);
		expect([first?.start, middle?.start, tail?.start]).toEqual([0, 20004, 40008]);
		expect(await findDocumentMatch(ref.id, "FIND", tail, 1)).toEqual(first);
		expect(await findDocumentMatch(ref.id, "FIND", first, -1)).toEqual(tail);
		expect(await findDocumentMatch(ref.id, "FIND", tail, -1)).toEqual(middle);
	});
	test("search spans chunks/pages and starts matching after a streamed append", async () => {
		const prefix = `${"x".repeat(8190)}beg`;
		const ref = {
			id: "append-find",
			epoch: "e",
			length: prefix.length,
			revision: 1,
			complete: false,
			originKnown: true,
		};
		textDocumentStore.append(ref, 0, prefix);
		expect(await findDocumentMatch(ref.id, "begin\r\nend", null, 1)).toBeNull();
		const suffix = "in\r\nend";
		textDocumentStore.append(
			{ ...ref, length: ref.length + suffix.length, revision: 2 },
			prefix.length,
			suffix,
		);
		expect(await findDocumentMatch(ref.id, "begin\r\nend", null, 1)).toEqual({
			start: 8190,
			end: 8200,
		});
		expect(await findDocumentMatch(ref.id, "begin\r\nend", null, -1)).toEqual({
			start: 8190,
			end: 8200,
		});
	});
	test("cancelled search does not publish a false missing result", async () => {
		const ref = textDocumentStore.importText("abort-find", "needle");
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		expect(findDocumentMatch(ref.id, "needle", null, 1, controller.signal)).rejects.toThrow(
			"cancelled",
		);
	});
});
describe("copy ownership across source retirement", () => {
	for (const mode of ["writeText", "promised ClipboardItem"] as const) {
		test(`${mode} finishes a full-source copy when the last streaming owner retires`, async () => {
			const source = `${"FIRST\r\n\t中文😀".repeat(1000)}LAST`;
			const ref = {
				id: `retiring-copy-${mode}`,
				epoch: "retiring-copy-epoch",
				revision: 1,
				length: source.length,
				complete: true,
				originKnown: true,
			};
			let enter = () => {};
			let resume = () => {};
			const entered = new Promise<void>((resolve) => {
				enter = resolve;
			});
			const gate = new Promise<void>((resolve) => {
				resume = resolve;
			});
			textDocumentStore.register(ref, async (snapshot, offset, limit) => {
				enter();
				await gate;
				return { ref: snapshot, offset, text: source.slice(offset, offset + limit) };
			});
			const releaseOwner = textDocumentStore.retainSource(ref.id);
			const copied: string[] = [];
			class Item {
				constructor(readonly data: Record<string, Promise<Blob>>) {}
			}
			Object.defineProperty(globalThis, "ClipboardItem", {
				configurable: true,
				value: mode === "writeText" ? undefined : Item,
			});
			Object.defineProperty(globalThis, "navigator", {
				configurable: true,
				value: {
					clipboard:
						mode === "writeText"
							? {
									writeText: async (text: string) => {
										copied.push(text);
									},
								}
							: {
									write: async (items: Item[]) => {
										copied.push(await (await items[0].data["text/plain"]).text());
									},
								},
				},
			});
			const copy = copyDocument(ref).then(
				() => ({ success: true }),
				(error: unknown) => ({ success: false, error }),
			);
			await entered;
			releaseOwner(true);
			resume();
			expect(await copy).toEqual({ success: true });
			expect(copied).toEqual([source]);
			expect(textDocumentStore.getSnapshot(ref.id)).toBeUndefined();
		});
	}
});
