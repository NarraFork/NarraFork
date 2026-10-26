import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
	clearDraftImageAttachments,
	DRAFT_ATTACHMENT_TTL_MS,
	getComposerAssetId,
	getDraftImageAttachmentKey,
	loadDraftImageAttachments,
	MAX_DRAFT_ATTACHMENT_BYTES,
	MAX_DRAFT_ATTACHMENT_TOTAL_BYTES,
	retainInterruptedDraftAttachments,
	saveDraftImageAttachments,
	setComposerAssetId,
} from "./draft-image-attachments";

const previousIndexedDb = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
const closeCachedConnections: (() => void)[] = [];
const retainedOwners: [string, string][] = [];
let nowSpy: ReturnType<typeof spyOn<DateConstructor, "now">> | null = null;
afterEach(() => {
	nowSpy?.mockRestore();
	nowSpy = null;
	for (const [userId, narratorId] of retainedOwners.splice(0)) {
		retainInterruptedDraftAttachments(userId, narratorId, [], []);
	}
	for (const close of closeCachedConnections.splice(0)) close();
	if (previousIndexedDb) Object.defineProperty(globalThis, "indexedDB", previousIndexedDb);
	else Reflect.deleteProperty(globalThis, "indexedDB");
});

function installIndexedDbFacade(firstOpen?: "error" | "blocked" | "throw") {
	const records = new Map<string, Record<string, unknown>>();
	const request = (result: unknown) => {
		const value = { result, onsuccess: null as (() => void) | null };
		queueMicrotask(() => value.onsuccess?.());
		return value;
	};
	const createDatabase = () => {
		const database = {
			closed: false,
			close: () => {
				database.closed = true;
			},
			onversionchange: null as (() => void) | null,
			transaction: () => {
				const transaction = {
					oncomplete: null as (() => void) | null,
					objectStore: () => ({
						get: (key: string) =>
							request(records.has(key) ? structuredClone(records.get(key)) : undefined),
						getAll: () => request([...records.values()].map((entry) => structuredClone(entry))),
						put: (record: Record<string, unknown>) =>
							records.set(String(record.draftKey), structuredClone(record)),
						delete: (key: string) => records.delete(key),
					}),
				};
				setTimeout(() => transaction.oncomplete?.(), 0);
				return transaction;
			},
		};
		closeCachedConnections.push(() => database.onversionchange?.());
		return database;
	};
	const opens: {
		result: ReturnType<typeof createDatabase>;
		error: Error;
		onsuccess: (() => void) | null;
		onerror: (() => void) | null;
		onblocked: (() => void) | null;
	}[] = [];
	let attempts = 0;
	Object.defineProperty(globalThis, "indexedDB", {
		configurable: true,
		value: {
			open: () => {
				const outcome = attempts++ === 0 ? firstOpen : undefined;
				if (outcome === "throw") throw new Error("IndexedDB open threw");
				const openRequest = {
					result: createDatabase(),
					error: new Error("IndexedDB open failed"),
					onsuccess: null as (() => void) | null,
					onerror: null as (() => void) | null,
					onblocked: null as (() => void) | null,
				};
				opens.push(openRequest);
				queueMicrotask(() => {
					if (outcome === "error") openRequest.onerror?.();
					else if (outcome === "blocked") openRequest.onblocked?.();
					else openRequest.onsuccess?.();
				});
				return openRequest;
			},
		},
	});
	return { records, opens };
}

describe("draft attachment storage failures", () => {
	for (const failure of ["error", "blocked", "throw"] as const) {
		test(`first open ${failure} rejects instead of returning absent; a retry preserves the record`, async () => {
			const { records, opens } = installIndexedDbFacade(failure);
			const key = getDraftImageAttachmentKey("u", "n");
			const blob = new Blob(["original"], { type: "image/png" });
			const record = {
				draftKey: key,
				userId: "u",
				narratorId: "n",
				updatedAtMs: Date.now(),
				images: [{ id: "f", name: "f.png", type: blob.type, size: blob.size, blob }],
				textFiles: [],
			};
			records.set(key, record);
			await expect(loadDraftImageAttachments("u", "n")).rejects.toThrow();
			expect(records.get(key)).toBe(record);
			const restored = await loadDraftImageAttachments("u", "n");
			expect(restored.images.map(getComposerAssetId)).toEqual(["f"]);
			expect(await restored.images[0].text()).toBe("original");
			expect(records.get(key)).toBe(record);
			if (failure === "blocked") {
				// The abandoned blocked open can succeed late. Close only that handle,
				// retaining the successful retry's cache and untouched stored blobs.
				opens[0].onsuccess?.();
				expect(opens[0].result.closed).toBe(true);
				expect(opens[1].result.closed).toBe(false);
				await loadDraftImageAttachments("u", "n");
				expect(opens).toHaveLength(2);
			}
		});
	}

	test("an absent record remains a successful empty restore", async () => {
		installIndexedDbFacade();
		expect(await loadDraftImageAttachments("u", "absent")).toEqual({
			images: [],
			textFiles: [],
			droppedCount: 0,
		});
	});

	test("missing IndexedDB rejects for a valid owner, but an unknown owner remains empty", async () => {
		Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: undefined });
		await expect(loadDraftImageAttachments("u", "n")).rejects.toThrow("storage unavailable");
		expect(await loadDraftImageAttachments("", "n")).toEqual({
			images: [],
			textFiles: [],
			droppedCount: 0,
		});
	});
});

function retainForTest(userId: string, narratorId: string, images: File[], textFiles: File[] = []) {
	retainedOwners.push([userId, narratorId]);
	retainInterruptedDraftAttachments(userId, narratorId, images, textFiles);
}

function fileWithBudgetSize(size: number): File {
	// Budget accounting only inspects File.size; no need to allocate 100+ MiB
	// for each eviction scenario. The identity/IDB-limit test uses real bytes.
	const file = new File(["budget"], "budget.log");
	Object.defineProperty(file, "size", { value: size });
	return file;
}

describe("switch-interrupted attachment snapshots", () => {
	test("retains original Files and ids above the IDB limit without opening storage or copying blobs", async () => {
		const { opens } = installIndexedDbFacade();
		const image = new File(["image"], "same.png", { type: "image/png" });
		const text = new File([new Uint8Array(MAX_DRAFT_ATTACHMENT_BYTES + 1)], "large.log");
		setComposerAssetId(image, "image-id");
		setComposerAssetId(text, "text-id");
		const imageSlice = spyOn(image, "slice").mockImplementation(() => {
			throw new Error("must not copy the image");
		});
		const textSlice = spyOn(text, "slice").mockImplementation(() => {
			throw new Error("must not copy the text");
		});
		try {
			const images = [image];
			const texts = [text];
			retainForTest("u", "n", images, texts);
			images.length = 0;
			texts.length = 0;
			const loaded = await loadDraftImageAttachments("u", "n");
			expect(loaded.images[0]).toBe(image);
			expect(loaded.textFiles[0]).toBe(text);
			expect([...loaded.images, ...loaded.textFiles].map(getComposerAssetId)).toEqual([
				"image-id",
				"text-id",
			]);
			expect(loaded.droppedCount).toBe(0);
			loaded.images.length = 0;
			loaded.textFiles.length = 0;
			const anotherPanel = await loadDraftImageAttachments("u", "n");
			expect(anotherPanel.images[0]).toBe(image);
			expect(anotherPanel.textFiles[0]).toBe(text);
			expect(opens).toHaveLength(0);
			expect(imageSlice).not.toHaveBeenCalled();
			expect(textSlice).not.toHaveBeenCalled();
		} finally {
			imageSlice.mockRestore();
			textSlice.mockRestore();
		}
	});

	test("prefers the explicit snapshot over older IDB contents and isolates owners", async () => {
		installIndexedDbFacade();
		const old = new File(["old"], "old.png", { type: "image/png" });
		const current = new File(["new"], "new.png", { type: "image/png" });
		await saveDraftImageAttachments("u", "n", [old]);
		retainForTest("u", "n", [current]);
		expect((await loadDraftImageAttachments("u", "n")).images[0]).toBe(current);
		expect((await loadDraftImageAttachments("other", "n")).images).toEqual([]);
		expect((await loadDraftImageAttachments("u", "other")).images).toEqual([]);
		// Length-prefixed owner keys cannot collide at delimiter boundaries.
		retainForTest("a:b", "c", [old]);
		expect((await loadDraftImageAttachments("a", "b:c")).images).toEqual([]);
		retainForTest("", "n", [old]);
		retainForTest("u", "", [old]);
		expect((await loadDraftImageAttachments("", "n")).images).toEqual([]);
	});

	test("normal save updates only opted-in snapshots and clear cannot resurrect deleted files", async () => {
		const { records } = installIndexedDbFacade();
		const first = new File(["first"], "first.png", { type: "image/png" });
		const replacement = fileWithBudgetSize(MAX_DRAFT_ATTACHMENT_BYTES + 1);
		retainForTest("u", "n", [first]);
		const saving = saveDraftImageAttachments("u", "n", [], [replacement]);
		// The synchronous update must precede both the IDB write and this load.
		expect((await loadDraftImageAttachments("u", "n")).textFiles[0]).toBe(replacement);
		await saving;
		expect(records.has(getDraftImageAttachmentKey("u", "n"))).toBe(false);
		expect((await loadDraftImageAttachments("u", "n")).textFiles[0]).toBe(replacement);
		const clearing = clearDraftImageAttachments("u", "n");
		expect((await loadDraftImageAttachments("u", "n")).textFiles).toEqual([]);
		await clearing;
		expect((await loadDraftImageAttachments("u", "n")).images).toEqual([]);

		await saveDraftImageAttachments("u", "n", [], [replacement]);
		expect((await loadDraftImageAttachments("u", "n")).textFiles).toEqual([]);
		await saveDraftImageAttachments("u", "ordinary", [first], [replacement]);
		const ordinary = await loadDraftImageAttachments("u", "ordinary");
		expect(ordinary.images[0]).not.toBe(first);
		expect(ordinary.textFiles).toEqual([]);
	});

	test("save removals and clear invalidate the snapshot even without IndexedDB", async () => {
		Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: undefined });
		const first = new File(["first"], "first.log");
		const second = new File(["second"], "second.log");
		retainForTest("u", "n", [], [first, second]);
		await saveDraftImageAttachments("u", "n", [], [second]);
		expect((await loadDraftImageAttachments("u", "n")).textFiles).toEqual([second]);
		await clearDraftImageAttachments("u", "n");
		await expect(loadDraftImageAttachments("u", "n")).rejects.toThrow("storage unavailable");
	});

	test("an older pending save cannot overwrite a later retain, and ordinary save/read order stays intact", async () => {
		installIndexedDbFacade();
		const old = new File(["old"], "old.png", { type: "image/png" });
		const current = new File(["new"], "new.png", { type: "image/png" });
		const saving = saveDraftImageAttachments("u", "n", [old]);
		retainForTest("u", "n", [current]);
		await saving;
		expect((await loadDraftImageAttachments("u", "n")).images[0]).toBe(current);
		const ordinarySave = saveDraftImageAttachments("u", "ordinary", [old]);
		const ordinaryRead = loadDraftImageAttachments("u", "ordinary");
		expect((await ordinaryRead).images.map(getComposerAssetId)).toEqual([getComposerAssetId(old)]);
		await ordinarySave;
	});

	test("expires after the existing TTL; reads do not keep snapshots alive", async () => {
		installIndexedDbFacade();
		let now = Date.now();
		nowSpy = spyOn(Date, "now").mockImplementation(() => now);
		const file = new File(["draft"], "draft.log");
		retainForTest("u", "n", [], [file]);
		now += DRAFT_ATTACHMENT_TTL_MS;
		expect((await loadDraftImageAttachments("u", "n")).textFiles[0]).toBe(file);
		now++;
		expect((await loadDraftImageAttachments("u", "n")).textFiles).toEqual([]);
	});

	test("keeps at most eight snapshots, evicts oldest updates first and ignores reads for recency", async () => {
		installIndexedDbFacade();
		const file = new File(["draft"], "draft.log");
		for (let index = 0; index < 8; index++) retainForTest("u", `n${index}`, [], [file]);
		await loadDraftImageAttachments("u", "n1");
		retainForTest("u", "n0", [], [file]);
		retainForTest("u", "n8", [], [file]);
		expect((await loadDraftImageAttachments("u", "n1")).textFiles).toEqual([]);
		for (const index of [0, 2, 3, 4, 5, 6, 7, 8]) {
			expect((await loadDraftImageAttachments("u", `n${index}`)).textFiles[0]).toBe(file);
		}
	});

	test("enforces the 100 MiB total across users but protects the latest over-budget snapshot", async () => {
		installIndexedDbFacade();
		const file = fileWithBudgetSize(40 * 1024 * 1024);
		retainForTest("first-user", "n", [], [file]);
		retainForTest("second-user", "n", [], [file]);
		retainForTest("third-user", "n", [], [file]);
		expect((await loadDraftImageAttachments("first-user", "n")).textFiles).toEqual([]);
		expect((await loadDraftImageAttachments("second-user", "n")).textFiles[0]).toBe(file);
		expect((await loadDraftImageAttachments("third-user", "n")).textFiles[0]).toBe(file);
		const huge = fileWithBudgetSize(MAX_DRAFT_ATTACHMENT_TOTAL_BYTES + 1);
		retainForTest("u", "huge", [], [huge]);
		expect((await loadDraftImageAttachments("second-user", "n")).textFiles).toEqual([]);
		expect((await loadDraftImageAttachments("third-user", "n")).textFiles).toEqual([]);
		expect((await loadDraftImageAttachments("u", "huge")).textFiles[0]).toBe(huge);
		expect((await loadDraftImageAttachments("u", "huge")).textFiles[0]).toBe(huge);
		retainForTest("u", "small", [], [file]);
		expect((await loadDraftImageAttachments("u", "huge")).textFiles).toEqual([]);
		expect((await loadDraftImageAttachments("u", "small")).textFiles[0]).toBe(file);
	});
});

describe("composer resource identity", () => {
	test("same-name files remain distinct and explicit restored ids stay stable", () => {
		const first = new File(["first"], "same.png", { type: "image/png" });
		const second = new File(["second"], "same.png", { type: "image/png" });
		expect(getComposerAssetId(first)).toBe(getComposerAssetId(first));
		expect(getComposerAssetId(first)).not.toBe(getComposerAssetId(second));
		setComposerAssetId(second, "restored-resource");
		expect(getComposerAssetId(second)).toBe("restored-resource");
		expect(Object.keys(second)).not.toContain("assetId");
		expect(() => setComposerAssetId(second, "bad identity")).toThrow();
	});

	test("IDB serialization restores resource ids, migrates legacy entries and keeps blob budgets", async () => {
		// Exercise the real serialization functions with an async IDB transaction facade.
		const { records } = installIndexedDbFacade();
		const first = new File(["first"], "same.png", { type: "image/png" });
		const second = new File(["other"], "same.png", { type: "image/png" });
		const text = new File(["log"], "a.log", { type: "text/plain" });
		const ids = [getComposerAssetId(first), getComposerAssetId(second), getComposerAssetId(text)];
		await saveDraftImageAttachments("u", "n", [first, second], [text]);
		const loaded = await loadDraftImageAttachments("u", "n");
		expect([...loaded.images, ...loaded.textFiles].map(getComposerAssetId)).toEqual(ids);
		expect(await loaded.images[0].text()).toBe("first");
		expect(await loaded.images[1].text()).toBe("other");
		expect(loaded.droppedCount).toBe(0);
		expect((await loadDraftImageAttachments("other-user", "n")).images).toEqual([]);

		const key = getDraftImageAttachmentKey("u", "legacy");
		const updatedAt = new Date().toISOString();
		records.set(key, {
			draftKey: key,
			userId: "u",
			narratorId: "legacy",
			updatedAt,
			images: [{ name: "old.png", type: "image/png", size: first.size, blob: first }],
		});
		const migrated = await loadDraftImageAttachments("u", "legacy");
		const migratedId = getComposerAssetId(migrated.images[0]);
		expect((await loadDraftImageAttachments("u", "legacy")).images.map(getComposerAssetId)).toEqual(
			[migratedId],
		);
		expect(records.get(key)?.updatedAt).toBe(updatedAt);

		const oversized = new File([new Uint8Array(MAX_DRAFT_ATTACHMENT_BYTES + 1)], "huge.log");
		await saveDraftImageAttachments("u", "limited", [], [text, oversized]);
		const limited = await loadDraftImageAttachments("u", "limited");
		expect(limited.textFiles.map((file) => file.name)).toEqual(["a.log"]);
		expect(limited.textFiles.map(getComposerAssetId)).toEqual([ids[2]]);
	});
});
