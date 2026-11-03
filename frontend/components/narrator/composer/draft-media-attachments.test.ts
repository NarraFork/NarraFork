import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
	type UseComposerAttachmentsResult,
	useComposerAttachments,
} from "../interaction/use-composer-attachments";
import {
	clearDraftImageAttachments,
	getDraftImageAttachmentKey,
	loadDraftImageAttachments,
	saveDraftImageAttachments,
} from "./draft-image-attachments";

// Minimal asynchronous IndexedDB surface: tests the real record encoding/decoding, not a mocked storage module.
const records = new Map<string, Record<string, unknown>>();
let previous: PropertyDescriptor | undefined;
let versionChange: (() => void) | undefined;
function request<T>(value: T) {
	const pending = { result: value, onsuccess: undefined as (() => void) | undefined };
	queueMicrotask(() => pending.onsuccess?.());
	return pending;
}
beforeEach(() => {
	records.clear();
	previous = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
	const db = {
		close() {},
		set onversionchange(handler: () => void) {
			versionChange = handler;
		},
		transaction() {
			const transaction = {
				oncomplete: undefined as (() => void) | undefined,
				objectStore: () => ({
					get: (key: string) => request(records.get(key)),
					getAll: () => request([...records.values()]),
					put(value: Record<string, unknown>) {
						records.set(String(value.draftKey), structuredClone(value));
						queueMicrotask(() => transaction.oncomplete?.());
					},
					delete(key: string) {
						records.delete(key);
						queueMicrotask(() => transaction.oncomplete?.());
					},
				}),
			};
			return transaction;
		},
	};
	Object.defineProperty(globalThis, "indexedDB", {
		configurable: true,
		value: { open: () => request(db) },
	});
});
afterEach(async () => {
	// Let opportunistic pruning finish before closing the fake connection.
	await new Promise((resolve) => setTimeout(resolve, 0));
	versionChange?.();
	versionChange = undefined;
	if (previous) Object.defineProperty(globalThis, "indexedDB", previous);
	else Reflect.deleteProperty(globalThis, "indexedDB");
});

async function withComposer(
	run: (context: {
		mount: () => void;
		get: () => UseComposerAttachmentsResult;
		sendingRef: { current: boolean };
	}) => Promise<void>,
) {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const globals = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const root = createRoot(document.body.appendChild(document.createElement("div")));
	const sendingRef = { current: false };
	const t = (key: string) => key;
	let attachments: UseComposerAttachmentsResult | undefined;
	function Probe() {
		attachments = useComposerAttachments({ narratorId: "n", currentUserId: "u", sendingRef, t });
		return null;
	}
	try {
		await run({
			mount: () => {
				act(() => root.render(createElement(Probe)));
			},
			get: () => {
				if (!attachments) throw new Error("Composer not mounted");
				return attachments;
			},
			sendingRef,
		});
	} finally {
		await act(async () => root.unmount());
		for (const [key, descriptor] of globals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
}

describe("media composer draft concurrency", () => {
	test("an in-flight hydration cannot overwrite freshly attached media", async () => {
		const oldFile = new File(["old"], "old.wav", { type: "audio/wav" });
		const newFile = new File(["new"], "new.wav", { type: "audio/wav" });
		await saveDraftImageAttachments("u", "n", [], [], [oldFile]);
		await withComposer(async ({ mount, get }) => {
			mount();
			act(() => get().updateAttachedMedia([newFile]));
			await act(async () => {});
			expect(get().attachedMedia).toEqual([newFile]);
			expect((await loadDraftImageAttachments("u", "n")).media.map((file) => file.name)).toEqual([
				"new.wav",
			]);
		});
	});
	test("successful send only clears its own attachments, not newly staged binary media", async () => {
		const sent = new File(["sent"], "sent.wav", { type: "audio/wav" });
		const next = new File(["next"], "next.mp4", { type: "video/mp4" });
		await saveDraftImageAttachments("u", "n", [], [], [sent]);
		await withComposer(async ({ mount, get, sendingRef }) => {
			mount();
			await act(async () => {});
			sendingRef.current = true;
			act(() => get().hideAttachedFilesForSend());
			act(() => get().updateAttachedMedia([next]));
			act(() => get().clearAttachedFilesAndDraft());
			sendingRef.current = false;
			await act(async () => {});
			expect(get().attachedMedia).toEqual([next]);
			expect((await loadDraftImageAttachments("u", "n")).media.map((file) => file.name)).toEqual([
				"next.mp4",
			]);
		});
	});
});

describe("binary audio/video draft persistence", () => {
	test("round-trips File bytes alongside existing images/text and clears media-only records", async () => {
		const audio = new File([new Uint8Array([0, 255, 1, 128])], "recording.wav", {
			type: "audio/wav",
			lastModified: 123,
		});
		const video = new File(["video bytes"], "clip.mp4", { type: "video/mp4" });
		const image = new File(["png"], "screen.png", { type: "image/png" });
		const text = new File(["notes"], "notes.md", { type: "text/plain" });
		await saveDraftImageAttachments("u", "n", [image], [text], [audio, video]);
		const loaded = await loadDraftImageAttachments("u", "n");
		expect(loaded.media.map((file) => [file.name, file.type])).toEqual([
			["recording.wav", "audio/wav"],
			["clip.mp4", "video/mp4"],
		]);
		expect(new Uint8Array(await loaded.media[0].arrayBuffer())).toEqual(
			new Uint8Array([0, 255, 1, 128]),
		);
		expect(loaded.media[0].lastModified).toBe(123);
		expect(loaded.images).toHaveLength(1);
		expect(loaded.textFiles).toHaveLength(1);
		expect(loaded.droppedCount).toBe(0);
		expect((await loadDraftImageAttachments("other-user", "n")).media).toEqual([]);
		await clearDraftImageAttachments("u", "n");
		expect((await loadDraftImageAttachments("u", "n")).media).toEqual([]);
	});
	test("media bypasses the older 20 MiB image draft cutoff", async () => {
		const file = new File([new Uint8Array(21 * 1024 * 1024)], "clip.mp4", { type: "video/mp4" });
		await saveDraftImageAttachments("u", "n", [], [], [file]);
		const loaded = await loadDraftImageAttachments("u", "n");
		expect(loaded.media[0]?.size).toBe(file.size);
		expect(loaded.droppedCount).toBe(0);
	});
	test("reads old records without media and reports corrupt media entries", async () => {
		const key = getDraftImageAttachmentKey("u", "n");
		records.set(key, { draftKey: key, updatedAtMs: Date.now(), images: [], textFiles: [] });
		expect((await loadDraftImageAttachments("u", "n")).media).toEqual([]);
		records.set(key, {
			...records.get(key),
			media: [{ name: "lost.wav", type: "audio/wav", size: 20, blob: null }],
		});
		expect((await loadDraftImageAttachments("u", "n")).droppedCount).toBe(1);
	});
});
