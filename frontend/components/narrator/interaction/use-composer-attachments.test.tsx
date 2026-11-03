import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { notifications } from "@mantine/notifications";
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as storage from "../composer/draft-image-attachments";
import { useComposerAttachments } from "./use-composer-attachments";

let root: Root;
let host: HTMLElement;
let hook: ReturnType<typeof useComposerAttachments>;
let narratorId: string;
let currentUserId: string | null;
let hydrationRenders: boolean[];
let failureRenders: boolean[];
let resourceRenders: ReadonlyMap<string, File>[];
let attachmentRenders: {
	userId: string | null;
	narratorId: string;
	images: File[];
	textFiles: File[];
	imageRefs: File[];
	textFileRefs: File[];
	assetIds: string[];
}[];
const sendingRef = { current: false };
const t = (key: string) => key;
const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
type Draft = storage.LoadedDraftAttachments;
let loads: {
	userId: string;
	narratorId: string;
	resolve: (draft: Draft) => void;
	reject: (error: unknown) => void;
}[];
let saved: Map<string, Draft>;
let save: ReturnType<typeof spyOn<typeof storage, "saveDraftImageAttachments">>;
const empty = (): Draft => ({ images: [], textFiles: [], media: [], droppedCount: 0 });
function image(id: string) {
	const file = new File([id], `${id}.png`, { type: "image/png" });
	storage.setComposerAssetId(file, id);
	return file;
}
function text(id: string) {
	const file = new File([id], `${id}.txt`, { type: "text/plain" });
	storage.setComposerAssetId(file, id);
	return file;
}
function Harness() {
	hook = useComposerAttachments({ narratorId, currentUserId, sendingRef, t });
	hydrationRenders.push(hook.attachmentsHydrating);
	failureRenders.push(hook.attachmentsRestoreFailed);
	resourceRenders.push(hook.restoredAttachmentResources);
	attachmentRenders.push({
		userId: currentUserId,
		narratorId,
		images: [...hook.attachedImages],
		textFiles: [...hook.attachedTextFiles],
		imageRefs: [...hook.attachedImagesRef.current],
		textFileRefs: [...hook.attachedTextFilesRef.current],
		assetIds: hook.composerAssets.map((asset) => asset.id),
	});
	return null;
}
async function render() {
	await act(async () => root.render(createElement(Harness)));
}
async function hydrate(draft: Draft, request = loads.length - 1) {
	await act(async () => loads[request].resolve(draft));
}
function persisted(user = currentUserId, narrator = narratorId) {
	return user ? saved.get(storage.getDraftImageAttachmentKey(user, narrator)) : undefined;
}
beforeEach(async () => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	narratorId = "narrator-a";
	currentUserId = "user-a";
	sendingRef.current = false;
	loads = [];
	hydrationRenders = [];
	failureRenders = [];
	resourceRenders = [];
	attachmentRenders = [];
	saved = new Map();
	spyOn(storage, "loadDraftImageAttachments").mockImplementation(
		(userId, narrator) =>
			new Promise((resolve, reject) =>
				loads.push({ userId, narratorId: narrator, resolve, reject }),
			),
	);
	save = spyOn(storage, "saveDraftImageAttachments").mockImplementation(
		async (userId, narrator, images, textFiles = [], media = []) => {
			saved.set(storage.getDraftImageAttachmentKey(userId, narrator), {
				images: [...images],
				textFiles: [...textFiles],
				media: [...media],
				droppedCount: 0,
			});
		},
	);
	spyOn(storage, "clearDraftImageAttachments").mockImplementation(async (userId, narrator) => {
		saved.delete(storage.getDraftImageAttachmentKey(userId, narrator));
	});
	spyOn(notifications, "show").mockImplementation(() => "notification");
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await render();
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	mock.restore();
	for (const [key, descriptor] of previousGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	previousGlobals.clear();
});

test("manifest arriving before IndexedDB filters deleted files but preserves referenced blobs", async () => {
	const keep = image("keep");
	const removed = image("removed");
	const keepText = text("keep-text");
	const removedText = text("removed-text");
	await act(async () => hook.reconcileDocumentAssets(["keep", "keep-text"]));
	expect(save).not.toHaveBeenCalled();
	await hydrate({
		images: [keep, removed],
		textFiles: [keepText, removedText],
		media: [],
		droppedCount: 0,
	});
	expect(hook.attachedImages).toEqual([keep]);
	expect(hook.attachedTextFiles).toEqual([keepText]);
	expect(hook.composerAssets.map((asset) => asset.id)).toEqual(["keep", "keep-text"]);
	expect([...hook.restoredAttachmentResources.values()]).toEqual([
		keep,
		removed,
		keepText,
		removedText,
	]);
	expect(persisted()).toEqual({
		images: [keep],
		textFiles: [keepText],
		media: [],
		droppedCount: 0,
	});
});

test("latest manifest wins during hydrate, including an empty remote document", async () => {
	await act(async () => {
		hook.reconcileDocumentAssets(["f"]);
		hook.reconcileDocumentAssets([]);
	});
	await hydrate({ images: [image("f")], textFiles: [], media: [], droppedCount: 0 });
	expect(hook.attachedImages).toEqual([]);
	expect(persisted()).toEqual(empty());
});

test("manifest after hydrate removes F from arrays and persistence before adding G", async () => {
	const f = image("f");
	const oldText = text("old-text");
	const g = image("g");
	await hydrate({ images: [f], textFiles: [oldText], media: [], droppedCount: 0 });
	await act(async () => {
		hook.reconcileDocumentAssets([]);
		// Exercise a same-event functional append: its previous array must already
		// be filtered, not the render's stale pre-reconciliation state.
		hook.updateAttachedImages((previous) => [...previous, g]);
	});
	expect(hook.attachedImages).toEqual([g]);
	expect(hook.attachedTextFiles).toEqual([]);
	expect(persisted()).toEqual({ images: [g], textFiles: [], media: [], droppedCount: 0 });
	await act(async () => hook.reconcileDocumentAssets(["g"]));
	expect(hook.attachedImagesRef.current).toEqual([g]);
	const stored = persisted();
	expect(stored).toBeDefined();
	await act(async () => {
		root.unmount();
		root = createRoot(host);
		root.render(createElement(Harness));
	});
	await act(async () => hook.reconcileDocumentAssets(["g"]));
	await hydrate(stored as Draft);
	expect(hook.attachedImages.map(storage.getComposerAssetId)).toEqual(["g"]);
});

test("new local G wins over a late hydrate and is allowed before document adoption", async () => {
	const g = image("g");
	const newText = text("new-text");
	await act(async () => {
		hook.reconcileDocumentAssets([]);
		hook.updateAttachedImages((previous) => [...previous, g]);
		hook.updateAttachedTextFiles((previous) => [...previous, newText]);
	});
	await hydrate({
		images: [image("f")],
		textFiles: [text("old-text")],
		media: [],
		droppedCount: 0,
	});
	expect(hook.attachedImages).toEqual([g]);
	expect(hook.attachedTextFiles).toEqual([newText]);
	expect(persisted()).toEqual({ images: [g], textFiles: [newText], media: [], droppedCount: 0 });
	await act(async () => hook.reconcileDocumentAssets(["g", "new-text"]));
	expect(hook.composerAssets.map((asset) => asset.id)).toEqual(["g", "new-text"]);
});

test("document declarations alone do not suppress valid F hydration", async () => {
	const f = image("f");
	await act(async () => hook.reconcileDocumentAssets(["f"]));
	await act(async () => hook.reconcileDocumentAssets(["f"]));
	await hydrate({ images: [f], textFiles: [], media: [], droppedCount: 0 });
	expect(hook.attachedImages).toEqual([f]);
	expect(persisted()?.images).toEqual([f]);
});

for (const switchScope of ["narrator", "user"] as const) {
	test(`${switchScope} switch exposes empty arrays, refs and manifest on its first reused-hook render`, async () => {
		const f = image("f");
		const oldText = text("old-text");
		await hydrate({ images: [f], textFiles: [oldText], media: [], droppedCount: 0 });
		const imageRef = hook.attachedImagesRef;
		const textRef = hook.attachedTextFilesRef;
		expect(attachmentRenders.at(-1)?.images).toEqual([f]);
		expect(attachmentRenders.at(-1)?.imageRefs).toEqual([f]);
		const firstNewOwnerRender = attachmentRenders.length;
		if (switchScope === "narrator") narratorId = "narrator-b";
		else currentUserId = "user-b";
		await render();
		expect(attachmentRenders[firstNewOwnerRender]).toEqual({
			userId: currentUserId,
			narratorId,
			images: [],
			textFiles: [],
			imageRefs: [],
			textFileRefs: [],
			assetIds: [],
		});
		expect(hook.attachedImagesRef).toBe(imageRef);
		expect(hook.attachedTextFilesRef).toBe(textRef);
		const b = image("b");
		const bText = text("b-text");
		await hydrate({ images: [b], textFiles: [bText], media: [], droppedCount: 0 }, 1);
		expect(hook.attachedImages).toEqual([b]);
		expect(hook.attachedTextFiles).toEqual([bText]);
		expect(hook.attachedImagesRef.current).toEqual([b]);
		expect(hook.attachedTextFilesRef.current).toEqual([bText]);
		for (const snapshot of attachmentRenders.slice(firstNewOwnerRender)) {
			expect([...snapshot.images, ...snapshot.imageRefs]).not.toContain(f);
			expect([...snapshot.textFiles, ...snapshot.textFileRefs]).not.toContain(oldText);
		}
		// Returning to A creates a new scope object, not the first A state tag.
		const firstReturnRender = attachmentRenders.length;
		if (switchScope === "narrator") narratorId = "narrator-a";
		else currentUserId = "user-a";
		await render();
		expect(attachmentRenders[firstReturnRender].images).toEqual([]);
		expect(attachmentRenders[firstReturnRender].textFiles).toEqual([]);
		expect(attachmentRenders[firstReturnRender].imageRefs).toEqual([]);
		expect(attachmentRenders[firstReturnRender].textFileRefs).toEqual([]);
	});

	test(`${switchScope} switch tags pending local files and ignores the old owner's late result`, async () => {
		const old = image("old-local");
		const oldText = text("old-local-text");
		await act(async () => {
			hook.updateAttachedImages([old]);
			hook.updateAttachedTextFiles([oldText]);
		});
		const firstNewOwnerRender = attachmentRenders.length;
		if (switchScope === "narrator") narratorId = "narrator-b";
		else currentUserId = "user-b";
		await render();
		expect(attachmentRenders[firstNewOwnerRender].images).toEqual([]);
		expect(attachmentRenders[firstNewOwnerRender].textFiles).toEqual([]);
		expect(attachmentRenders[firstNewOwnerRender].imageRefs).toEqual([]);
		expect(attachmentRenders[firstNewOwnerRender].textFileRefs).toEqual([]);
		const fresh = image("fresh-b");
		await hydrate({ images: [fresh], textFiles: [], media: [], droppedCount: 0 }, 1);
		await hydrate({ images: [old], textFiles: [oldText], media: [], droppedCount: 0 }, 0);
		expect(hook.attachedImages).toEqual([fresh]);
		expect(hook.attachedTextFiles).toEqual([]);
		expect(hook.attachedImagesRef.current).toEqual([fresh]);
		expect(hook.attachedTextFilesRef.current).toEqual([]);
		expect([...hook.restoredAttachmentResources.values()]).toEqual([fresh]);
		expect(persisted()?.images).toEqual([fresh]);
		expect(persisted("user-a", "narrator-a")).toBeUndefined();
	});

	test(`${switchScope} scope switch resets allowed ids and ignores the old late hydrate`, async () => {
		await act(async () => hook.reconcileDocumentAssets([]));
		if (switchScope === "narrator") narratorId = "narrator-b";
		else currentUserId = "user-b";
		await render();
		expect(hook.attachmentsHydrating).toBe(true);
		const fresh = image("fresh");
		await hydrate({ images: [fresh], textFiles: [], media: [], droppedCount: 0 }, 1);
		await hydrate({ images: [image("stale")], textFiles: [], media: [], droppedCount: 0 }, 0);
		expect(hook.attachedImages).toEqual([fresh]);
		expect(persisted()?.images).toEqual([fresh]);
		expect(persisted("user-a", "narrator-a")).toBeUndefined();
	});

	test(`${switchScope} switch merges only the current owner's pending and local assets`, async () => {
		await act(async () => {
			hook.reconcileDocumentAssets(["old"]);
			hook.updateAttachedImages([image("old")]);
		});
		if (switchScope === "narrator") narratorId = "narrator-b";
		else currentUserId = "user-b";
		await render();
		const fresh = image("fresh");
		const local = image("local");
		await act(async () => {
			hook.reconcileDocumentAssets(["fresh", "local"]);
			hook.updateAttachedImages([local]);
		});
		expect(save).not.toHaveBeenCalled();
		await hydrate({ images: [image("stale")], textFiles: [], media: [], droppedCount: 0 }, 0);
		expect(hook.attachmentsHydrating).toBe(true);
		expect(hook.attachedImages).toEqual([local]);
		await hydrate({ images: [fresh], textFiles: [], media: [], droppedCount: 0 }, 1);
		expect(hook.attachedImages).toEqual([fresh, local]);
		expect(persisted()?.images).toEqual([fresh, local]);
		expect(persisted("user-a", "narrator-a")).toBeUndefined();
	});
}

test("narrator A to B to A does not reuse the first A ownership declaration or hydrate", async () => {
	await act(async () => hook.reconcileDocumentAssets([]));
	narratorId = "narrator-b";
	await render();
	narratorId = "narrator-a";
	await render();
	const current = image("current");
	await hydrate({ images: [current], textFiles: [], media: [], droppedCount: 0 }, 2);
	await hydrate({ images: [image("stale")], textFiles: [], media: [], droppedCount: 0 }, 0);
	expect(hook.attachedImages).toEqual([current]);
	expect(persisted()?.images).toEqual([current]);
});

test("send hide during hydrate keeps files hidden without overwriting the recovery draft", async () => {
	const f = image("f");
	const draft = { images: [f], textFiles: [], media: [], droppedCount: 0 };
	saved.set(storage.getDraftImageAttachmentKey("user-a", narratorId), draft);
	await act(async () => {
		hook.reconcileDocumentAssets(["f"]);
		sendingRef.current = true;
		hook.hideAttachedFilesForSend();
		// The composer declares its temporarily empty document after sending.
		hook.reconcileDocumentAssets([]);
	});
	await hydrate(draft);
	expect(hook.attachedImages).toEqual([]);
	expect(hook.attachmentsHydrating).toBe(false);
	expect(save).not.toHaveBeenCalled();
	expect(persisted()).toEqual(draft);
	// A render after sending ends must not save the temporary empty arrays.
	sendingRef.current = false;
	await render();
	expect(save).not.toHaveBeenCalled();
	await act(async () => {
		hook.reconcileDocumentAssets(["f"]);
		hook.updateAttachedImages([f]);
	});
	expect(hook.attachedImages).toEqual([f]);
	expect(persisted()).toEqual(draft);
});

test("F pending plus newly attached G merges the declared document before any partial save", async () => {
	const f = image("f");
	const g = image("g");
	const fText = text("f-text");
	const gText = text("g-text");
	await act(async () => hook.reconcileDocumentAssets(["f", "f-text"]));
	await act(async () => {
		hook.reconcileDocumentAssets(["f", "g", "f-text", "g-text"]);
		hook.updateAttachedImages([g]);
		hook.updateAttachedTextFiles([gText]);
	});
	expect(hook.attachmentsHydrating).toBe(true);
	expect(save).not.toHaveBeenCalled();
	await hydrate({ images: [f], textFiles: [fText], media: [], droppedCount: 0 });
	expect(hook.attachedImages).toEqual([f, g]);
	expect(hook.attachedTextFiles).toEqual([fText, gText]);
	expect(hook.attachmentsHydrating).toBe(false);
	expect(persisted()).toEqual({
		images: [f, g],
		textFiles: [fText, gText],
		media: [],
		droppedCount: 0,
	});
	for (const [, , images, textFiles] of save.mock.calls) {
		expect(images).toEqual([f, g]);
		expect(textFiles).toEqual([fText, gText]);
	}
});

test("deleting unhydrated F while adding G never resurrects F", async () => {
	const g = image("g");
	await act(async () => hook.reconcileDocumentAssets(["f"]));
	await act(async () => {
		hook.reconcileDocumentAssets(["f", "g"]);
		hook.updateAttachedImages([g]);
	});
	await act(async () => hook.reconcileDocumentAssets(["g"]));
	expect(save).not.toHaveBeenCalled();
	await hydrate({ images: [image("f")], textFiles: [], media: [], droppedCount: 0 });
	expect(hook.attachedImages).toEqual([g]);
	expect(persisted()?.images).toEqual([g]);
});

test("same filename never merges different asset IDs and a local same-ID file wins", async () => {
	const original = new File(["old"], "same.png", { type: "image/png" });
	const other = new File(["other"], "same.png", { type: "image/png" });
	const replacement = new File(["local"], "same.png", { type: "image/png" });
	storage.setComposerAssetId(original, "f");
	storage.setComposerAssetId(other, "g");
	storage.setComposerAssetId(replacement, "f");
	await act(async () => {
		hook.reconcileDocumentAssets(["f", "g"]);
		hook.updateAttachedImages([replacement]);
	});
	await hydrate({ images: [original, other], textFiles: [], media: [], droppedCount: 0 });
	expect(hook.attachedImages).toEqual([replacement, other]);
	expect(hook.attachedImages[0]).toBe(replacement);
	expect(hook.restoredAttachmentResources.get("f")).toBe(replacement);
	expect(persisted()?.images).toEqual([replacement, other]);
	const previousPool = hook.restoredAttachmentResources;
	const nextReplacement = image("f");
	await act(async () => hook.updateAttachedImages([nextReplacement, other]));
	expect(hook.restoredAttachmentResources.get("f")).toBe(nextReplacement);
	expect(hook.restoredAttachmentResources).not.toBe(previousPool);
});

test("explicit clear during hydrate empties membership and the persisted draft", async () => {
	await act(async () => hook.reconcileDocumentAssets(["f"]));
	await act(async () => hook.clearAttachedFilesAndDraft());
	expect(storage.clearDraftImageAttachments).toHaveBeenCalledWith("user-a", narratorId);
	await hydrate({ images: [image("f")], textFiles: [text("old")], media: [], droppedCount: 0 });
	expect(hook.attachedImages).toEqual([]);
	expect(hook.attachedTextFiles).toEqual([]);
	expect(persisted()).toEqual(empty());
});

test("legacy callers with no membership retain local-version replacement semantics", async () => {
	const g = image("g");
	await act(async () => hook.updateAttachedImages([g]));
	expect(save).not.toHaveBeenCalled();
	await hydrate({ images: [image("f")], textFiles: [text("old")], media: [], droppedCount: 0 });
	expect(hook.attachedImages).toEqual([g]);
	expect(hook.attachedTextFiles).toEqual([]);
	expect(persisted()).toEqual({ images: [g], textFiles: [], media: [], droppedCount: 0 });
});

test("hydration status resets on the first owner render and only current completion settles it", async () => {
	expect(hook.attachmentsHydrating).toBe(true);
	await hydrate(empty());
	expect(hook.attachmentsHydrating).toBe(false);
	const beforeSwitch = hydrationRenders.length;
	narratorId = "narrator-b";
	await render();
	expect(hydrationRenders[beforeSwitch]).toBe(true);
	narratorId = "narrator-a";
	await render();
	await hydrate(empty(), 1);
	expect(hook.attachmentsHydrating).toBe(true);
	await hydrate(empty(), 2);
	expect(hook.attachmentsHydrating).toBe(false);
});

test("failed hydration notifies consumers even when no files changed", async () => {
	expect(hook.attachmentsHydrating).toBe(true);
	const beforeFailure = hydrationRenders.length;
	await act(async () => loads[0].reject(new Error("storage unavailable")));
	expect(hydrationRenders.length).toBeGreaterThan(beforeFailure);
	expect(hook.attachmentsHydrating).toBe(false);
	expect(save).not.toHaveBeenCalled();
});

for (const missingKind of ["image", "textFile"] as const) {
	test(`failed read preserves unrestored ${missingKind} F until membership explicitly removes it`, async () => {
		const f = missingKind === "image" ? image("f") : text("f");
		const g = image("g");
		const draft = {
			images: missingKind === "image" ? [f] : [],
			textFiles: missingKind === "textFile" ? [f] : [],
			media: [],
			droppedCount: 0,
		};
		saved.set(storage.getDraftImageAttachmentKey("user-a", narratorId), draft);
		await act(async () => {
			hook.reconcileDocumentAssets(["f", "g"]);
			hook.updateAttachedImages([g]);
		});
		await act(async () => loads[0].reject(new Error("storage read failed")));
		expect(hook.attachmentsHydrating).toBe(false);
		expect(hook.attachedImages).toEqual([g]);
		expect(save).not.toHaveBeenCalled();
		expect(persisted()).toEqual(draft);
		// Later local changes and renders must not bypass the failed-read guard.
		await act(async () => hook.updateAttachedImages((files) => [...files]));
		await act(async () => hook.reconcileDocumentAssets(["f", "g"]));
		await render();
		expect(save).not.toHaveBeenCalled();
		expect(loads).toHaveLength(1);
		// F has no local file, so deleting it does not change the file arrays.
		// The membership declaration itself must schedule the now-safe save.
		const imagesBeforeDeletion = hook.attachedImages;
		await act(async () => hook.reconcileDocumentAssets(["g"]));
		expect(hook.attachedImages).toBe(imagesBeforeDeletion);
		expect(persisted()).toEqual({ images: [g], textFiles: [], media: [], droppedCount: 0 });
	});
}

test("explicit clear after a failed read can remove the protected stored record", async () => {
	const draft = { images: [image("f")], textFiles: [], media: [], droppedCount: 0 };
	saved.set(storage.getDraftImageAttachmentKey("user-a", narratorId), draft);
	await act(async () => {
		hook.reconcileDocumentAssets(["f", "g"]);
		hook.updateAttachedImages([image("g")]);
	});
	await act(async () => loads[0].reject(new Error("storage read failed")));
	expect(save).not.toHaveBeenCalled();
	expect(persisted()).toEqual(draft);
	await act(async () => hook.clearAttachedFilesAndDraft());
	expect(storage.clearDraftImageAttachments).toHaveBeenCalledWith("user-a", narratorId);
	expect(hook.attachedImages).toEqual([]);
	expect(persisted()).toEqual(empty());
});

test("returning to the owner retries a failed read without losing its original stored F", async () => {
	const f = image("f");
	const draft = { images: [f], textFiles: [], media: [], droppedCount: 0 };
	saved.set(storage.getDraftImageAttachmentKey("user-a", narratorId), draft);
	await act(async () => {
		hook.reconcileDocumentAssets(["f", "g"]);
		hook.updateAttachedImages([image("g")]);
	});
	await act(async () => loads[0].reject(new Error("storage read failed")));
	expect(save).not.toHaveBeenCalled();
	narratorId = "narrator-b";
	await render();
	narratorId = "narrator-a";
	await render();
	expect(hook.attachmentsHydrating).toBe(true);
	expect(persisted()).toEqual(draft);
	await act(async () => hook.reconcileDocumentAssets(["f", "g"]));
	await hydrate(persisted() as Draft, 2);
	expect(hook.attachedImages).toEqual([f]);
	expect(hook.attachmentsHydrating).toBe(false);
	expect(persisted()).toEqual(draft);
});

test("failed read with unknown membership never replaces an unknown stored draft with local G", async () => {
	const draft = { images: [image("f")], textFiles: [], media: [], droppedCount: 0 };
	saved.set(storage.getDraftImageAttachmentKey("user-a", narratorId), draft);
	await act(async () => hook.updateAttachedImages([image("g")]));
	await act(async () => loads[0].reject(new Error("storage read failed")));
	expect(hook.attachmentsHydrating).toBe(false);
	expect(save).not.toHaveBeenCalled();
	await act(async () => hook.updateAttachedImages((files) => [...files]));
	await render();
	expect(save).not.toHaveBeenCalled();
	expect(persisted()).toEqual(draft);
	await act(async () => hook.clearAttachedFilesAndDraft());
	expect(storage.clearDraftImageAttachments).toHaveBeenCalledWith("user-a", narratorId);
	expect(persisted()).toEqual(empty());
});

test("declared deleted assets restore from the undo pool only when referenced again", async () => {
	const f = image("f");
	const g = image("g");
	// Text attachment kind must come from the stored array, not MIME guessing.
	const textFile = new File(["text"], "text.png", { type: "image/png" });
	storage.setComposerAssetId(textFile, "text");
	await act(async () => hook.reconcileDocumentAssets(["g"]));
	await hydrate({ images: [f, g], textFiles: [textFile], media: [], droppedCount: 0 });
	expect(hook.attachedImages).toEqual([g]);
	expect(hook.attachedTextFiles).toEqual([]);
	expect(hook.restoredAttachmentResources.get("f")).toBe(f);
	expect(hook.restoredAttachmentResources.get("text")).toBe(textFile);
	expect(persisted()).toEqual({ images: [g], textFiles: [], media: [], droppedCount: 0 });
	// Replacing G with F has the same length but different resource identity.
	await act(async () => hook.reconcileDocumentAssets(["f", "text"]));
	expect(hook.attachedImages).toEqual([f]);
	expect(hook.attachedTextFiles).toEqual([textFile]);
	expect(persisted()).toEqual({ images: [f], textFiles: [textFile], media: [], droppedCount: 0 });
});

test("an undo pool declaration cannot unhide sending attachments or rewrite their stored draft", async () => {
	const f = image("f");
	await hydrate({ images: [f], textFiles: [], media: [], droppedCount: 0 });
	const beforeHide = save.mock.calls.length;
	await act(async () => hook.hideAttachedFilesForSend());
	await act(async () => hook.reconcileDocumentAssets(["f"]));
	expect(hook.restoredAttachmentResources.get("f")).toBe(f);
	expect(hook.attachedImages).toEqual([]);
	expect(save.mock.calls).toHaveLength(beforeHide);
	expect(persisted()?.images).toEqual([f]);
});

for (const switchScope of ["user", "narrator"] as const) {
	test(`undo resource pool resets on the first ${switchScope} scope render and ignores stale loads`, async () => {
		await hydrate({ images: [image("a")], textFiles: [], media: [], droppedCount: 0 }, 0);
		expect(hook.restoredAttachmentResources.has("a")).toBe(true);
		const beforeSwitch = resourceRenders.length;
		if (switchScope === "user") currentUserId = "user-b";
		else narratorId = "narrator-b";
		await render();
		expect(resourceRenders[beforeSwitch].size).toBe(0);
		if (switchScope === "user") currentUserId = "user-a";
		else narratorId = "narrator-a";
		await render();
		await hydrate({ images: [image("stale-b")], textFiles: [], media: [], droppedCount: 0 }, 1);
		expect(hook.restoredAttachmentResources.size).toBe(0);
		const fresh = image("fresh");
		await hydrate({ images: [fresh], textFiles: [], media: [], droppedCount: 0 }, 2);
		expect([...hook.restoredAttachmentResources.values()]).toEqual([fresh]);
	});
}

for (const knownMembership of [false, true]) {
	test(`failed restore retry merges F with retained local G (known membership: ${knownMembership})`, async () => {
		const f = image("f");
		const g = image("g");
		const remoteG = image("g");
		const localText = text("local-text");
		await act(async () => {
			if (knownMembership) hook.reconcileDocumentAssets(["f", "g", "local-text"]);
			hook.updateAttachedImages([g]);
			hook.updateAttachedTextFiles([localText]);
		});
		await act(async () => loads[0].reject(new Error("initial read failed")));
		expect(hook.attachmentsRestoreFailed).toBe(true);
		expect(hook.attachmentsHydrating).toBe(false);
		const imagesBeforeRetry = hook.attachedImages;
		const textBeforeRetry = hook.attachedTextFiles;
		const poolBeforeRetry = hook.restoredAttachmentResources;
		const firstRetryRender = hydrationRenders.length;
		await act(async () => {
			hook.retryAttachmentRestore();
			hook.retryAttachmentRestore();
		});
		expect(loads).toHaveLength(2);
		expect(hydrationRenders[firstRetryRender]).toBe(true);
		expect(failureRenders[firstRetryRender]).toBe(false);
		expect(hook.attachedImages).toBe(imagesBeforeRetry);
		expect(hook.attachedTextFiles).toBe(textBeforeRetry);
		expect(hook.restoredAttachmentResources).toBe(poolBeforeRetry);
		expect(save).not.toHaveBeenCalled();
		await hydrate({ images: [f, remoteG], textFiles: [], media: [], droppedCount: 0 }, 1);
		expect(hook.attachmentsRestoreFailed).toBe(false);
		expect(hook.attachmentsHydrating).toBe(false);
		expect(hook.attachedImages).toEqual([f, g]);
		expect(hook.attachedImages[1]).toBe(g);
		expect(hook.attachedTextFiles).toEqual([localText]);
		expect(hook.restoredAttachmentResources.get("g")).toBe(g);
		expect(persisted()).toEqual({
			images: [f, g],
			textFiles: [localText],
			media: [],
			droppedCount: 0,
		});
	});
}

test("a failed retry retains local G and can be retried again without any partial save", async () => {
	const g = image("g");
	await act(async () => hook.updateAttachedImages([g]));
	await act(async () => loads[0].reject(new Error("initial read failed")));
	const imagesBeforeRetry = hook.attachedImages;
	await act(async () => hook.retryAttachmentRestore());
	await act(async () => loads[1].reject(new Error("retry read failed")));
	expect(hook.attachmentsRestoreFailed).toBe(true);
	expect(hook.attachmentsHydrating).toBe(false);
	expect(hook.attachedImages).toBe(imagesBeforeRetry);
	expect(save).not.toHaveBeenCalled();
	await act(async () => hook.retryAttachmentRestore());
	const f = image("f");
	await hydrate({ images: [f], textFiles: [], media: [], droppedCount: 0 }, 2);
	expect(hook.attachedImages).toEqual([f, g]);
	expect(hook.attachmentsRestoreFailed).toBe(false);
	expect(persisted()?.images).toEqual([f, g]);
});

test("retry does nothing while sending or hidden", async () => {
	await act(async () => loads[0].reject(new Error("initial read failed")));
	sendingRef.current = true;
	await act(async () => hook.retryAttachmentRestore());
	expect(loads).toHaveLength(1);
	expect(hook.attachmentsRestoreFailed).toBe(true);
	sendingRef.current = false;
	await act(async () => hook.hideAttachedFilesForSend());
	await act(async () => hook.retryAttachmentRestore());
	expect(loads).toHaveLength(1);
	expect(hook.attachmentsHydrating).toBe(false);
});

test("clear ends restore failure and invalidates an in-flight retry's late error", async () => {
	await act(async () => hook.updateAttachedImages([image("g")]));
	await act(async () => loads[0].reject(new Error("initial read failed")));
	await act(async () => hook.retryAttachmentRestore());
	expect(hook.attachmentsHydrating).toBe(true);
	await act(async () => hook.clearAttachedFilesAndDraft());
	expect(hook.attachmentsHydrating).toBe(false);
	expect(hook.attachmentsRestoreFailed).toBe(false);
	await act(async () => loads[1].reject(new Error("late retry failure")));
	expect(hook.attachmentsRestoreFailed).toBe(false);
	expect(hook.attachedImages).toEqual([]);
	expect(persisted()).toEqual(empty());
});

test("clear in the retry event cancels the queued read before its effect starts", async () => {
	await act(async () => loads[0].reject(new Error("initial read failed")));
	await act(async () => {
		hook.retryAttachmentRestore();
		hook.clearAttachedFilesAndDraft();
	});
	expect(loads).toHaveLength(1);
	expect(hook.attachmentsHydrating).toBe(false);
	expect(hook.attachmentsRestoreFailed).toBe(false);
});

for (const switchScope of ["user", "narrator"] as const) {
	test(`pending retry cannot apply resources or failure status to a different ${switchScope} owner`, async () => {
		await act(async () => hook.updateAttachedImages([image("old-g")]));
		await act(async () => loads[0].reject(new Error("initial read failed")));
		await act(async () => hook.retryAttachmentRestore());
		const firstOwnerRender = hydrationRenders.length;
		if (switchScope === "user") currentUserId = "user-b";
		else narratorId = "narrator-b";
		await render();
		expect(hydrationRenders[firstOwnerRender]).toBe(true);
		expect(failureRenders[firstOwnerRender]).toBe(false);
		expect(hook.attachedImages).toEqual([]);
		if (switchScope === "user") {
			await hydrate(
				{ images: [image("stale-retry")], textFiles: [], media: [], droppedCount: 0 },
				1,
			);
		} else {
			await act(async () => loads[1].reject(new Error("old owner retry failed")));
		}
		expect(hook.attachmentsHydrating).toBe(true);
		expect(hook.attachmentsRestoreFailed).toBe(false);
		expect(hook.restoredAttachmentResources.size).toBe(0);
		const fresh = image("fresh");
		await hydrate({ images: [fresh], textFiles: [], media: [], droppedCount: 0 }, 2);
		expect(hook.attachedImages).toEqual([fresh]);
		expect(persisted()?.images).toEqual([fresh]);
	});
}

test("A to B to A isolates the original A retry failure from the new A restore", async () => {
	await act(async () => loads[0].reject(new Error("initial read failed")));
	await act(async () => hook.retryAttachmentRestore());
	narratorId = "narrator-b";
	await render();
	narratorId = "narrator-a";
	await render();
	await act(async () => loads[1].reject(new Error("original A retry failed")));
	expect(hook.attachmentsHydrating).toBe(true);
	expect(hook.attachmentsRestoreFailed).toBe(false);
	const fresh = image("fresh-a");
	await hydrate({ images: [fresh], textFiles: [], media: [], droppedCount: 0 }, 3);
	expect(hook.attachedImages).toEqual([fresh]);
	expect(hook.attachmentsRestoreFailed).toBe(false);
});

test("unknown users are not hydrating and a late known-user read cannot apply", async () => {
	currentUserId = null;
	const beforeSwitch = hydrationRenders.length;
	await render();
	expect(hydrationRenders[beforeSwitch]).toBe(false);
	expect(hook.attachmentsHydrating).toBe(false);
	await hydrate({ images: [image("stale")], textFiles: [], media: [], droppedCount: 0 }, 0);
	expect(hook.attachedImages).toEqual([]);
	expect(loads).toHaveLength(1);
	expect(save).not.toHaveBeenCalled();
});
