import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { editorDocumentApi } from "../../../lib/api/editor-documents";
import {
	EditorDraftCheckpoint,
	EditorDraftScheduler,
	queryDraftOperation,
} from "./editor-draft-checkpoint";
import { EditorDraftStore } from "./editor-draft-store";
import { sessionDirty } from "./editor-session-state";
import * as worker from "./editor-worker-client";
import * as working from "./editor-working-copy";
import { TestEditorModel } from "./file-editor-test-model";

const scope = {
	recoveryKey: "verified-owner",
	resourceKey: "verified-resource",
	narratorId: "n",
	deviceId: "local",
	origin: "reference" as const,
	canonicalPath: "/repo/a",
};
let model: TestEditorModel,
	copy: working.EditorWorkingCopy,
	controller: EditorDraftCheckpoint,
	store: EditorDraftStore;
let cleanup: (() => void)[];
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const tick = async () => {
	for (let i = 0; i < 8; i++) await Promise.resolve();
};
beforeEach(async () => {
	globalThis.IDBKeyRange = IDBKeyRange;
	// Factory must remain stable over reopen; each test uses an independent store/database.
	const factory = new IDBFactory();
	store = new EditorDraftStore(() => factory);
	cleanup = [];
	const create = spyOn(editorDocumentApi, "create").mockResolvedValue({
		docId: "volatile-not-persisted",
		resourceKey: scope.resourceKey,
		target: { deviceId: "local", path: "/repo/a" },
		versionHandle: "version",
		baseHash: "old-disk",
		encoding: "utf-8",
		eol: "LF",
		sourceBytes: 5,
		utf8Bytes: 5,
	});
	const source = spyOn(editorDocumentApi, "source").mockResolvedValue("disk\n");
	const release = spyOn(editorDocumentApi, "release").mockResolvedValue(undefined);
	const factorySpy = spyOn(working, "createWorkingCopyModel").mockImplementation(async () => {
		model = new TestEditorModel({ filePath: "/repo/a", documentKey: "test", initialValue: "" });
		return model.getModel();
	});
	const encode = spyOn(worker, "encodeEditorSnapshot").mockImplementation(
		async (snapshot, signal) => {
			const chunks: string[] = [];
			while (true) {
				const next = snapshot.read();
				if (next === null) break;
				signal?.throwIfAborted();
				chunks.push(next);
			}
			return new Blob(chunks);
		},
	);
	cleanup.push(
		() => create.mockRestore(),
		() => source.mockRestore(),
		() => release.mockRestore(),
		() => factorySpy.mockRestore(),
		() => encode.mockRestore(),
	);
	const anchors = new Map<
		string,
		Awaited<ReturnType<typeof editorDocumentApi.createDraftAnchor>>
	>();
	const anchorCreate = spyOn(editorDocumentApi, "createDraftAnchor").mockImplementation(
		async (_narrator, input) => {
			const anchor = {
				...input,
				anchorId: crypto.randomUUID(),
				checkpointGeneration: crypto.randomUUID(),
				recoveryKey: scope.recoveryKey,
				status: input.operation ? ("query-first" as const) : ("no-dispatch" as const),
				retired: false,
				expiresAt: Date.now() + 60_000,
			};
			anchors.set(anchor.anchorId, anchor);
			return anchor;
		},
	);
	const anchorPublish = spyOn(editorDocumentApi, "publishDraftAnchor").mockImplementation(
		async (_narrator, id) => {
			const row = anchors.get(id);
			if (!row) throw new Error("missing anchor");
			return row;
		},
	);
	const anchorRelease = spyOn(editorDocumentApi, "releaseDraftAnchor").mockResolvedValue({
		released: true,
	});
	cleanup.push(
		() => anchorCreate.mockRestore(),
		() => anchorPublish.mockRestore(),
		() => anchorRelease.mockRestore(),
	);
	copy = new working.EditorWorkingCopy({
		narratorId: "n",
		path: "/repo/a",
		deviceId: "local",
		origin: () => "reference",
	});
	await copy.ensureLoaded();
	controller = new EditorDraftCheckpoint(
		copy,
		scope,
		store,
		new EditorDraftScheduler(),
		"realm-current",
	);
});
afterEach(async () => {
	controller.dispose();
	copy.dispose();
	await store.close();
	for (const restore of cleanup.reverse()) restore();
});
test("invisible working copy checkpoints immutable model and accounts/releases snapshot pin exactly once", async () => {
	model.edit("edited 中文🙂\n");
	const encode = deferred<Blob>();
	const encoder = spyOn(worker, "encodeEditorSnapshot").mockImplementation(() => encode.promise);
	cleanup.push(() => encoder.mockRestore());
	const snapshot = spyOn(model, "createSnapshot");
	cleanup.push(() => snapshot.mockRestore());
	const work = controller.run(new AbortController().signal);
	expect(copy.pinReasons).toContain("checkpoint");
	expect(copy.resourceCosts.bytes).toBeGreaterThan(model.text.length * 8);
	model.edit("next revision");
	controller.changed(); // continued typing must not starve this already captured complete checkpoint
	encode.resolve(new Blob(["edited 中文🙂\n"]));
	await work;
	const [row] = await store.list(scope.recoveryKey);
	expect(row.revision).not.toBe(model.revision);
	expect(await (await store.read(row, scope.recoveryKey)).text()).toBe("edited 中文🙂\n");
	expect(row.baseVersion.hash).toBe("old-disk");
	expect(snapshot).toHaveBeenCalledTimes(1);
	expect(copy.pinReasons).not.toContain("checkpoint");
	controller.dispose();
	controller.dispose();
	expect(copy.resourceCosts.bytes).toBeGreaterThanOrEqual(0);
});
test("cancelled snapshot is single pass and a late encoder cannot publish or resurrect", async () => {
	model.edit("draft");
	const gate = deferred<Blob>(),
		signal = new AbortController();
	let reads = 0;
	const encode = spyOn(worker, "encodeEditorSnapshot").mockImplementation((snapshot) => {
		while (snapshot.read() !== null) reads++;
		return gate.promise;
	});
	cleanup.push(() => encode.mockRestore());
	const work = controller.run(signal.signal);
	signal.abort();
	controller.dispose();
	gate.resolve(new Blob(["draft"]));
	await work;
	expect(reads).toBe(1);
	expect(await store.list(scope.recoveryKey)).toEqual([]);
	expect(copy.pinReasons).not.toContain("checkpoint");
});
test("a receipt arriving during encoding fences that revision even before a write manifest exists", async () => {
	model.edit("saved snapshot");
	const revision = model.revision;
	const encoded = deferred<Blob>();
	const encode = spyOn(worker, "encodeEditorSnapshot").mockReturnValue(encoded.promise);
	cleanup.push(() => encode.mockRestore());
	const work = controller.run(new AbortController().signal);
	await controller.saved(revision);
	encoded.resolve(new Blob(["saved snapshot"]));
	await work;
	expect(await store.list(scope.recoveryKey)).toEqual([]);
	expect(store.diagnostics.published).toBe(0);
});
test("late completion after native publication cannot revive a saved pointer, anchor flag or lease", async () => {
	model.edit("saved revision");
	const revision = model.revision;
	const published = deferred<Awaited<ReturnType<EditorDraftStore["write"]>>>(),
		release = deferred<void>();
	const original = store.write.bind(store);
	const write = spyOn(store, "write").mockImplementation(async (...args) => {
		const row = await original(...args);
		published.resolve(row);
		await release.promise;
		return row;
	});
	cleanup.push(() => write.mockRestore());
	const running = controller.run(new AbortController().signal);
	await published.promise;
	await controller.saved(revision);
	release.resolve();
	await running;
	expect(await store.list(scope.recoveryKey)).toEqual([]);
	expect(
		await controller.beforeDispatch({ status: "query-first", snapshotRevision: revision + 1 }),
	).toBeUndefined();
	expect(copy.pinReasons).not.toContain("checkpoint");
});
test("an already cancelled checkpoint captures and reads no model snapshot", async () => {
	model.edit("draft");
	const signal = new AbortController();
	signal.abort();
	const snapshot = spyOn(model, "createSnapshot");
	cleanup.push(() => snapshot.mockRestore());
	await controller.run(signal.signal);
	expect(snapshot).not.toHaveBeenCalled();
	expect(store.diagnostics.published).toBe(0);
});
test("confirmed save only removes exact writer/revision; typing checkpoint survives late save", async () => {
	model.edit("first");
	const first = model.revision;
	await controller.run(new AbortController().signal);
	model.edit("newer");
	await controller.run(new AbortController().signal);
	await controller.saved(first);
	const [row] = await store.list(scope.recoveryKey);
	expect(row.revision).toBe(model.revision);
	expect(await (await store.read(row, scope.recoveryKey)).text()).toBe("newer");
	await controller.saved(model.revision);
	expect(await store.list(scope.recoveryKey)).toEqual([]);
});
test("late saved cleanup never releases a newer checkpoint's server coverage", async () => {
	model.edit("first");
	const revision = model.revision;
	await controller.run(new AbortController().signal);
	const removed = deferred<void>(),
		release = deferred<void>(),
		original = store.removeSaved.bind(store);
	const cleanupSave = spyOn(store, "removeSaved").mockImplementation(async (...args) => {
		const result = await original(...args);
		removed.resolve();
		await release.promise;
		return result;
	});
	const releaseAnchor = spyOn(editorDocumentApi, "releaseDraftAnchor");
	cleanup.push(
		() => cleanupSave.mockRestore(),
		() => releaseAnchor.mockRestore(),
	);
	const saved = controller.saved(revision);
	await removed.promise;
	model.edit("newer input");
	await controller.run(new AbortController().signal);
	const [newer] = await store.list(scope.recoveryKey);
	release.resolve();
	await saved;
	expect((await store.list(scope.recoveryKey))[0].generation).toBe(newer.generation);
	expect(releaseAnchor.mock.calls.some((call) => call[1] === newer.anchor?.anchorId)).toBe(false);
	expect(
		await controller.beforeDispatch({
			status: "query-first",
			operationId: "next-operation",
			snapshotRevision: model.revision,
		}),
	).toMatchObject({ draftWriterId: "realm-current" });
});
test("write-ahead operation marker keeps unknown checkpoint query-first without docId", async () => {
	model.edit("possibly committed");
	await controller.run(new AbortController().signal);
	await controller.beforeDispatch({
		operationId: "original-operation",
		snapshotRevision: model.revision,
		status: "query-first",
	});
	const [row] = await store.list(scope.recoveryKey);
	expect(row.operation?.operationId).toBe("original-operation");
	expect(row).not.toHaveProperty("docId");
	const op = spyOn(editorDocumentApi, "operation").mockResolvedValue({
		operationId: "original-operation",
		status: "uncertain",
	});
	cleanup.push(() => op.mockRestore());
	await queryDraftOperation(row, new AbortController().signal);
	expect(op).toHaveBeenCalledWith("n", "original-operation", expect.any(AbortSignal));
});
test("IDB marker failure still carries the original writer/lifetime to server dispatch provenance", async () => {
	model.edit("ordinary complete backup");
	await controller.run(new AbortController().signal);
	const marker = spyOn(store, "markOperation").mockRejectedValue(
		new DOMException("quota", "QuotaExceededError"),
	);
	cleanup.push(() => marker.mockRestore());
	const provenance = await controller.beforeDispatch({
		operationId: "original-operation",
		snapshotRevision: model.revision,
		status: "query-first",
	});
	expect(provenance).toEqual({
		draftWriterId: "realm-current",
		draftModelLifetime: copy.lifetimeId,
	});
	expect((await store.list(scope.recoveryKey))[0].operation).toBeUndefined();
	expect(copy.getSnapshot().backupIncomplete).toBe(true);
});
test("missing operation evidence never re-applies and receipt mismatch is rejected", async () => {
	model.edit("unknown");
	await controller.beforeDispatch({ status: "query-first", snapshotRevision: 4 });
	await controller.run(new AbortController().signal);
	const [row] = await store.list(scope.recoveryKey);
	await expect(queryDraftOperation(row, new AbortController().signal)).rejects.toThrow(
		"EDITOR_DRAFT_QUERY_REQUIRED",
	);
	const op = spyOn(editorDocumentApi, "operation").mockResolvedValue({
		operationId: "wrong-operation",
		status: "saved",
	});
	cleanup.push(() => op.mockRestore());
	await expect(
		queryDraftOperation(
			{
				...row,
				operation: { status: "query-first", operationId: "expected", snapshotRevision: 4 },
			},
			new AbortController().signal,
		),
	).rejects.toThrow("EDITOR_DRAFT_RECEIPT_MISMATCH");
});
test("storage failure warns but leaves ordinary editing, dirty guard and v1 save available", async () => {
	model.edit("still editable");
	const failure = spyOn(store, "write").mockRejectedValue(
		new DOMException("quota", "QuotaExceededError"),
	);
	cleanup.push(() => failure.mockRestore());
	await controller.run(new AbortController().signal);
	expect(copy.getSnapshot().backupIncomplete).toBe(true);
	expect(sessionDirty(copy.getSnapshot())).toBe(true);
	expect(copy.protected).toBe(true);
	model.edit("still editable again");
	expect(model.text).toBe("still editable again");
	expect(copy.getSnapshot().phase).toBe("idle");
});
test("restoring identical text is always dirty and preserves original draft baseline when disk changed", () => {
	expect(copy.session.restoreDraft("disk\n", "original-before-crash", "utf-8")).toBe(true);
	expect(sessionDirty(copy.getSnapshot())).toBe(true);
	expect(copy.getSnapshot().baseHash).toBe("original-before-crash");
	expect(copy.getSnapshot().restoredDiskChanged).toBe(true);
	expect(copy.session.restoreDraft("second", "new", "utf-8")).toBe(false);
});
function clock() {
	let now = 0,
		next = 0;
	const timers = new Map<number, { at: number; run: () => void }>();
	const scheduler = new EditorDraftScheduler(
		() => now,
		(run, ms) => {
			const id = ++next;
			timers.set(id, { at: now + ms, run });
			return id as unknown as ReturnType<typeof setTimeout>;
		},
		(id) => {
			timers.delete(id as unknown as number);
		},
	);
	return {
		scheduler,
		timers,
		async advance(ms: number) {
			now += ms;
			for (const [id, timer] of [...timers])
				if (timer.at <= now) {
					timers.delete(id);
					timer.run();
				}
			await tick();
		},
	};
}
test("one shared timer debounces 1s, and continuous edits cannot postpone past 5s", async () => {
	const c = clock();
	let calls = 0;
	const owner = {
		run: async () => {
			calls++;
		},
		flush() {},
	} as unknown as EditorDraftCheckpoint;
	c.scheduler.schedule(owner);
	await c.advance(999);
	expect(calls).toBe(0);
	await c.advance(1);
	expect(calls).toBe(1);
	c.scheduler.schedule(owner);
	for (let i = 0; i < 9; i++) {
		await c.advance(500);
		c.scheduler.schedule(owner);
		expect(c.timers.size).toBe(1);
	}
	await c.advance(500);
	expect(calls).toBe(2);
});
test("latest intent coalesces per doc, globally one task, save priority aborts background", async () => {
	const c = clock(),
		gate = deferred<void>();
	let runs = 0,
		aborted = false;
	const a = {
		run: async (signal: AbortSignal) => {
			runs++;
			signal.addEventListener("abort", () => {
				aborted = true;
			});
			await gate.promise;
		},
		flush() {},
	} as unknown as EditorDraftCheckpoint;
	const b = {
		run: async () => {
			runs++;
		},
		flush() {},
	} as unknown as EditorDraftCheckpoint;
	for (let i = 0; i < 100; i++) c.scheduler.schedule(a);
	c.scheduler.schedule(b);
	expect(c.scheduler.diagnostics().queued).toBe(2);
	expect(c.timers.size).toBe(1);
	await c.advance(1000);
	expect(runs).toBe(1);
	c.scheduler.priority(b, true);
	expect(aborted).toBe(true);
	gate.resolve();
	await tick();
	await c.advance(0);
	expect(runs).toBe(1);
	c.scheduler.priority(b, false);
	await c.advance(0);
	expect(runs).toBe(2);
	expect(c.scheduler.diagnostics()).toEqual({ queued: 0, running: 0, foreground: 0 });
});
test("explicit discard removes only this writer/model lifetime and fences a delayed encoder", async () => {
	model.edit("old draft");
	await controller.run(new AbortController().signal);
	const [row] = await store.list(scope.recoveryKey);
	await store.write({ ...row, writerId: "other-window" }, new Blob(["other window"]));
	model.edit("later snapshot");
	const delayed = deferred<Blob>();
	const encode = spyOn(worker, "encodeEditorSnapshot").mockReturnValue(delayed.promise);
	cleanup.push(() => encode.mockRestore());
	const running = controller.run(new AbortController().signal);
	expect(await controller.discard()).toBe(true);
	expect(await controller.discard()).toBe(true);
	delayed.resolve(new Blob(["later snapshot"]));
	await running;
	const remaining = await store.list(scope.recoveryKey);
	expect(remaining).toHaveLength(1);
	expect(remaining[0].writerId).toBe("other-window");
});
test("failed persistent discard retains the model and warns instead of pretending removal succeeded", async () => {
	model.edit("preserved");
	await controller.run(new AbortController().signal);
	const remove = spyOn(store, "removeSaved").mockRejectedValue(new Error("transaction abort"));
	cleanup.push(() => remove.mockRestore());
	expect(await controller.discard()).toBe(false);
	expect(copy.getSnapshot().backupIncomplete).toBe(true);
	expect(model.disposed).toBe(false);
	expect(model.text).toBe("preserved");
	expect(await store.list(scope.recoveryKey)).toHaveLength(1);
});
test("uploading save permits a checkpoint of newer input with the original attempt association", async () => {
	const pending = deferred<Awaited<ReturnType<typeof editorDocumentApi.createUpload>>>();
	const upload = spyOn(editorDocumentApi, "createUpload").mockReturnValue(pending.promise);
	cleanup.push(() => upload.mockRestore());
	controller.dispose();
	copy.dispose();
	// WorkingCopy deliberately captures its API adapter once at construction.
	copy = new working.EditorWorkingCopy({
		narratorId: "n",
		path: "/repo/a",
		deviceId: "local",
		origin: () => "reference",
	});
	await copy.ensureLoaded();
	controller = new EditorDraftCheckpoint(
		copy,
		scope,
		store,
		new EditorDraftScheduler(),
		"realm-current",
	);
	model.edit("sent snapshot");
	const sentRevision = model.revision;
	const save = copy.session.save();
	await tick();
	expect(copy.getSnapshot()).toMatchObject({ phase: "uploading", error: null });
	model.edit("new input during slow upload");
	await controller.run(new AbortController().signal);
	const [row] = await store.list(scope.recoveryKey);
	expect(row.revision).toBe(model.revision);
	expect(row.operation?.snapshotRevision).toBe(sentRevision);
	expect(row.operation?.status).toBe("query-first");
	copy.session.cancel();
	pending.resolve({ uploadId: "never-dispatched", state: "uploading", operationId: "original-op" });
	await save;
});
