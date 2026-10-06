import { describe, expect, test } from "bun:test";
import { textDocumentStore } from "@frontend/lib/text-document-store";
import type {
	TextDocumentRangeReader,
	TextDocumentRef,
} from "@shared/pretext-layout/text-document";
import { copyDocument } from "./document-clipboard";
import { readCurrentDocumentRange, recoveringDocumentRangeReader } from "./document-range-recovery";
import { findDocumentMatch } from "./document-search";
import { bindWriteDocumentReader, documentWriteInput } from "./document-source";

const source = {
	narratorId: "range-recovery",
	toolUseId: "same",
	toolCallId: "pk",
	messageId: "message",
	executionAttempt: 0,
	field: "content",
};
function ref(id: string, length: number): TextDocumentRef {
	return { id, epoch: `${id}:e`, length, revision: 7, complete: true, originKnown: true, source };
}
const expired = () =>
	Object.assign(new Error("source expired"), {
		status: 404,
		data: { code: "TEXT_DOCUMENT_SOURCE_EXPIRED" },
	});

describe("complete field range recovery", () => {
	test("expired source keeps the local id/attempt zero but replaces the byte-cache epoch", async () => {
		const text = `FIRST\r\n${"中文😀\t".repeat(6000)}\r\nLAST`;
		const old = ref("expired-old", text.length);
		const fresh = ref("regenerated-new", text.length);
		let ensures = 0;
		const reads: string[] = [];
		const raw: TextDocumentRangeReader = async (document, offset, limit) => {
			reads.push(document.id);
			if (document.id === old.id) throw expired();
			return { ref: fresh, offset, text: text.slice(offset, offset + limit) };
		};
		const reader = recoveringDocumentRangeReader(raw, async (narrator, toolUseId, pin) => {
			ensures++;
			expect(narrator).toBe(source.narratorId);
			expect(toolUseId).toBe(source.toolUseId);
			expect(pin).toEqual({ toolCallId: "pk", messageId: "message", executionAttempt: 0 });
			return fresh;
		});
		textDocumentStore.register(old, reader);
		expect(await readCurrentDocumentRange(old.id, 0)).toBe(text);
		expect(ensures).toBe(1);
		expect(reads[0]).toBe(old.id);
		expect(reads.slice(1).every((id) => id === fresh.id)).toBe(true);
		expect(textDocumentStore.getSnapshot(old.id)?.id).toBe(old.id);
		expect(textDocumentStore.getSnapshot(old.id)?.epoch).not.toBe(old.epoch);
	});
	test("a legal completed input marker gets the recovering reader on reopen instead of retaining a dead reader", async () => {
		const text = "restored\r\nsource";
		const old = ref("completed-marker", text.length);
		const fresh = ref("completed-regenerated", text.length);
		textDocumentStore.register(old, async () => {
			throw expired();
		});
		const prepared = documentWriteInput(
			source.narratorId,
			source.toolUseId,
			{ content: "bounded", textDocument: old },
			source,
		);
		const reader = recoveringDocumentRangeReader(
			async (document, offset, limit) => {
				if (document.id === old.id) throw expired();
				return { ref: fresh, offset, text: text.slice(offset, offset + limit) };
			},
			async () => fresh,
		);
		bindWriteDocumentReader(prepared, reader);
		expect(await readCurrentDocumentRange(old.id, 0)).toBe(text);
	});
	test("same-length permission edits never combine cached AAAA with regenerated DDDD", async () => {
		const page = 8192;
		const before = "A".repeat(page) + "B".repeat(page);
		const after = "C".repeat(page) + "D".repeat(page);
		const old = ref("two-page-old", before.length);
		const fresh = ref("two-page-new", after.length);
		let expiredNow = false;
		const reader = recoveringDocumentRangeReader(
			async (document, offset, limit) => {
				if (document.id === old.id && expiredNow) throw expired();
				return {
					ref: document.id === old.id ? old : fresh,
					offset,
					text: (document.id === old.id ? before : after).slice(offset, offset + limit),
				};
			},
			async () => fresh,
		);
		textDocumentStore.register(old, reader);
		expect(await textDocumentStore.readRange(old.id, 0, page)).toBe("A".repeat(page));
		expiredNow = true;
		const navigatorBefore = Object.getOwnPropertyDescriptor(globalThis, "navigator");
		const itemBefore = Object.getOwnPropertyDescriptor(globalThis, "ClipboardItem");
		let copied = "";
		try {
			Object.defineProperty(globalThis, "ClipboardItem", { configurable: true, value: undefined });
			Object.defineProperty(globalThis, "navigator", {
				configurable: true,
				value: {
					clipboard: {
						writeText: async (value: string) => {
							copied = value;
						},
					},
				},
			});
			await copyDocument(old);
		} finally {
			for (const [key, descriptor] of [
				["navigator", navigatorBefore],
				["ClipboardItem", itemBefore],
			] as const) {
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else Reflect.deleteProperty(globalThis, key);
			}
		}
		expect(copied).toBe(after);
		expect(copied).not.toBe("A".repeat(page) + "D".repeat(page));
		expect(textDocumentStore.getSnapshot(old.id)?.epoch).not.toBe(old.epoch);
		expect(textDocumentStore.peekRange(old.id, 0, page)).toBe("C".repeat(page));
		expect(await findDocumentMatch(old.id, "AAAA", null, 1)).toBeNull();
		expect(await findDocumentMatch(old.id, "CDDD", null, 1)).toEqual({
			start: page - 1,
			end: page + 3,
		});
		const restoredMarker = documentWriteInput(
			source.narratorId,
			source.toolUseId,
			{ content: "old preview", textDocument: old },
			source,
		) as { textDocument: TextDocumentRef };
		const latest = textDocumentStore.getSnapshot(old.id);
		if (!latest) throw new Error("missing recovered document");
		expect(restoredMarker.textDocument.epoch).toBe(latest.epoch);
		expect(restoredMarker.textDocument.length).toBe(after.length);
	});
	test("ACL failures do not regenerate or switch authorization policy", async () => {
		let ensures = 0;
		const reader = recoveringDocumentRangeReader(
			async () => {
				throw Object.assign(new Error("denied"), { status: 403, data: { code: "FORBIDDEN" } });
			},
			async () => {
				ensures++;
				return ref("unreachable", 10);
			},
		);
		await expect(reader(ref("acl-old", 10), 0, 10)).rejects.toThrow("denied");
		expect(ensures).toBe(0);
	});
	test("legacy incomplete identity is never completed by guessing a missing attempt", async () => {
		let ensures = 0;
		const reader = recoveringDocumentRangeReader(
			async () => {
				throw expired();
			},
			async () => {
				ensures++;
				return ref("unreachable", 10);
			},
		);
		await expect(
			reader(
				{
					...ref("no-pin", 10),
					source: { narratorId: source.narratorId, toolUseId: "same", field: "content" },
				},
				0,
				10,
			),
		).rejects.toThrow("source expired");
		expect(ensures).toBe(0);
	});
	test("different row identity fails explicitly instead of binding to another field", async () => {
		const old = ref("wrong-old", 10);
		const reader = recoveringDocumentRangeReader(
			async () => {
				throw expired();
			},
			async () => ({ ...ref("wrong-new", 10), source: { ...source, toolCallId: "different-pk" } }),
		);
		await expect(reader(old, 0, 10)).rejects.toThrow("pinned source");
	});
});
test("an evicted rebound can recover a re-registered old descriptor through its exact pin", async () => {
	const text = `FIRST${"rebound source\r\n".repeat(1000)}LAST`;
	const old = ref("evicted-rebound-old", text.length);
	const fresh = ref("evicted-rebound-fresh", text.length);
	let ensures = 0;
	const reader = recoveringDocumentRangeReader(
		async (document, offset, limit) => {
			if (document.id === old.id) throw expired();
			return { ref: fresh, offset, text: text.slice(offset, offset + limit) };
		},
		async () => {
			ensures++;
			return fresh;
		},
	);
	textDocumentStore.register(old, reader);
	expect(await readCurrentDocumentRange(old.id, 0)).toBe(text);
	const rebound = textDocumentStore.getSnapshot(old.id);
	if (!rebound) throw new Error("rebound missing");
	textDocumentStore.discard(rebound.id, rebound.epoch);
	expect(textDocumentStore.getSnapshot(old.id)).toBeUndefined();
	textDocumentStore.register(old, reader);
	expect(await readCurrentDocumentRange(old.id, 0)).toBe(text);
	expect(ensures).toBe(2);
	expect(textDocumentStore.getSnapshot(old.id)?.epoch).not.toBe(old.epoch);
});
describe("outer range read ownership", () => {
	test("a discarded replacement epoch is retried without publishing old source bytes", async () => {
		const oldText = "old source bytes";
		const newText = "new replacement source bytes";
		const old = ref("outer-pin-replacement", oldText.length);
		let enter = () => {};
		let resume = () => {};
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			resume = resolve;
		});
		textDocumentStore.register(old, async (snapshot, offset, limit) => {
			enter();
			await gate;
			return { ref: snapshot, offset, text: oldText.slice(offset, offset + limit) };
		});
		const reading = readCurrentDocumentRange(old.id, 0);
		await entered;
		const replacement = { ...old, epoch: "outer-pin-new-epoch", length: newText.length };
		textDocumentStore.register(replacement, async (snapshot, offset, limit) => ({
			ref: snapshot,
			offset,
			text: newText.slice(offset, offset + limit),
		}));
		textDocumentStore.discard(replacement.id, replacement.epoch);
		resume();
		expect(await reading).toBe(newText);
		expect(textDocumentStore.getSnapshot(old.id)).toBeUndefined();
	});

	test("cancelling an in-flight outer read releases the final pin on a retired source", async () => {
		const document = ref("outer-pin-cancel", 4);
		let enter = () => {};
		let resume = () => {};
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			resume = resolve;
		});
		textDocumentStore.register(document, async (snapshot, offset) => {
			enter();
			await gate;
			return { ref: snapshot, offset, text: "FULL" };
		});
		const releaseOwner = textDocumentStore.retainSource(document.id);
		const controller = new AbortController();
		const reading = readCurrentDocumentRange(document.id, 0, undefined, controller.signal);
		const outcome = reading.then(
			() => ({ success: true }),
			(error: Error) => ({ success: false, message: error.message }),
		);
		await entered;
		releaseOwner(true);
		controller.abort(new Error("copy aborted"));
		try {
			expect(await outcome).toEqual({ success: false, message: "copy aborted" });
			expect(textDocumentStore.getSnapshot(document.id)).toBeUndefined();
		} finally {
			resume();
		}
	});
});
