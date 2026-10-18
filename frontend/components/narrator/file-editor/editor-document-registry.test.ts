import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { EditorDocumentDescriptor } from "@shared/editor-document";
import { EditorStreamCodec } from "@shared/editor-stream-codec";
import { ApiError } from "../../../lib/api/client";
import { editorDocumentApi } from "../../../lib/api/editor-documents";
import {
	type EditorDocumentLease,
	EditorDocumentRegistry,
	type EditorRecoveryLease,
} from "./editor-document-registry";
import * as modelLoader from "./editor-model-loader";
import { sessionCanSave } from "./editor-session-state";
import * as worker from "./editor-worker-client";
import * as workingCopies from "./editor-working-copy";
import { TestEditorModel } from "./file-editor-test-model";

const options = {
	narratorId: "source",
	path: "/repo/a",
	deviceId: "local",
	origin: () => "reference" as const,
};
const descriptor = (id: number, resourceKey = "authorized-scope"): EditorDocumentDescriptor => ({
	docId: `doc-${id}`,
	resourceKey,
	target: { deviceId: "local", path: "/repo/a" },
	versionHandle: "v1",
	baseHash: "base",
	encoding: "utf-8",
	eol: "LF",
	sourceBytes: 5,
	utf8Bytes: 5,
});
let registry: EditorDocumentRegistry;
let leases: EditorDocumentLease[];
let recoveryLeases: EditorRecoveryLease[];
let models: TestEditorModel[];
let restores: (() => void)[];
let create: ReturnType<typeof spyOn<typeof editorDocumentApi, "create">>;
let source: ReturnType<typeof spyOn<typeof editorDocumentApi, "source">>;
let release: ReturnType<typeof spyOn<typeof editorDocumentApi, "release">>;
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const tick = async () => {
	await Promise.resolve();
	await Promise.resolve();
};
async function acquire(signal = new AbortController().signal) {
	const lease = await registry.acquire(options, signal);
	leases.push(lease);
	return lease;
}
beforeEach(() => {
	registry = new EditorDocumentRegistry();
	leases = [];
	recoveryLeases = [];
	models = [];
	restores = [];
	let next = 0;
	create = spyOn(editorDocumentApi, "create").mockImplementation(async () => descriptor(++next));
	source = spyOn(editorDocumentApi, "source").mockResolvedValue("hello");
	release = spyOn(editorDocumentApi, "release").mockResolvedValue(undefined);
	const factory = spyOn(workingCopies, "createWorkingCopyModel").mockImplementation(
		async (filePath, documentKey) => {
			const model = new TestEditorModel({ filePath, documentKey, initialValue: "" });
			models.push(model);
			return model.getModel();
		},
	);
	restores.push(
		() => create.mockRestore(),
		() => source.mockRestore(),
		() => release.mockRestore(),
		() => factory.mockRestore(),
	);
});
afterEach(async () => {
	for (const lease of recoveryLeases) lease.release();
	for (const lease of leases) {
		lease.release();
		lease.copy.dispose();
	}
	await tick();
	registry.shutdown();
	for (const restore of restores.reverse()) restore();
});

test("two independently authorized consumers share one working copy, model, baseline, undo and save coordinator", async () => {
	const [a, b] = await Promise.all([acquire(), acquire()]);
	expect(a.copy).toBe(b.copy);
	expect(a.copy.session).toBe(b.copy.session);
	await Promise.all([a.copy.ensureLoaded(), b.copy.ensureLoaded()]);
	expect(create).toHaveBeenCalledTimes(2);
	expect(source).toHaveBeenCalledTimes(1);
	expect(models).toHaveLength(1);
	expect(release).toHaveBeenCalledWith("source", "doc-2");
	models[0].edit("shared draft");
	expect(b.copy.getSnapshot().version?.length).toBe(12);
	a.release();
	a.release();
	await tick();
	expect(models[0].disposed).toBe(false);
	models[0].undo();
	expect(models[0].text).toBe("hello");
	expect(b.copy.protected).toBe(false);
	b.release();
	await tick();
	// Clean final consumers enter the bounded cache; invalidated clean entries are released.
	expect(models[0].disposed).toBe(false);
	registry.invalidateNarrator("source", "test context retired");
	await tick();
	expect(models[0].disposed).toBe(true);
	expect(registry.size).toBe(0);
	expect(release).toHaveBeenCalledWith("source", "doc-1");
});

test("raw-v2 and v1 never share a session/cache entry even with equal opaque keys and ASCII digests", async () => {
	const codec = new EditorStreamCodec("utf-8");
	codec.push(new TextEncoder().encode("hello"), true);
	const metadata = codec.finish();
	let id = 0;
	create.mockImplementation(async (_narrator, input) =>
		input.protocol === "raw-v2"
			? { ...descriptor(++id), ...metadata }
			: { ...descriptor(++id), baseHash: metadata.baseHash },
	);
	const v1 = await acquire();
	const raw = await registry.acquire(
		{ ...options, protocol: "raw-v2" },
		new AbortController().signal,
	);
	leases.push(raw);
	const sameV1 = await acquire();
	const sameRaw = await registry.acquire(
		{ ...options, protocol: "raw-v2" },
		new AbortController().signal,
	);
	leases.push(sameRaw);
	expect(v1.copy).not.toBe(raw.copy);
	expect(v1.copy.session).not.toBe(raw.copy.session);
	expect(sameV1.copy).toBe(v1.copy);
	expect(sameRaw.copy).toBe(raw.copy);
	expect(models).toHaveLength(0);
	expect(source).not.toHaveBeenCalled();
});
test("opening raw preview does not invalidate a v1 dirty draft under the same authorized owner/path", async () => {
	const codec = new EditorStreamCodec("utf-8");
	codec.push(new TextEncoder().encode("hello"), true);
	const metadata = codec.finish();
	let id = 0;
	create.mockImplementation(async (_narrator, input) =>
		input.protocol === "raw-v2"
			? { ...descriptor(++id, "raw-resource"), recoveryKey: "same-owner", ...metadata }
			: { ...descriptor(++id), recoveryKey: "same-owner", baseHash: metadata.baseHash },
	);
	const v1 = await acquire();
	await v1.copy.ensureLoaded();
	models[0].edit("draft");
	const raw = await registry.acquire(
		{ ...options, protocol: "raw-v2" },
		new AbortController().signal,
	);
	leases.push(raw);
	const recovery = await registry.discoverRetained(
		{ ...options, protocol: "raw-v2" },
		new AbortController().signal,
		Promise.resolve(raw.copy),
		async () => ({ recoveryKey: "same-owner" }),
	);
	recoveryLeases.push(recovery);
	expect(recovery.retainedCopies).toHaveLength(0);
	expect(v1.copy.getSnapshot().invalidated).not.toBe(true);
	expect(sessionCanSave(v1.copy.getSnapshot())).toBe(true);
	expect(models[0].text).toBe("draft");
	expect(v1.copy).not.toBe(raw.copy);
	create.mockImplementation(async (_narrator, input) =>
		input.protocol === "raw-v2"
			? { ...descriptor(++id, "new-actual-context-raw"), recoveryKey: "same-owner", ...metadata }
			: { ...descriptor(++id, "new-actual-context"), recoveryKey: "same-owner" },
	);
	const changed = await acquire();
	await changed.copy.ensureLoaded();
	models[1].edit("new context draft");
	expect(changed.copy.getSnapshot().invalidated).not.toBe(true);
	expect(v1.copy.getSnapshot().invalidated).toBe(true);
	expect(raw.copy.getSnapshot().invalidated).toBe(true);
	const newRaw = await registry.acquire(
		{ ...options, protocol: "raw-v2" },
		new AbortController().signal,
	);
	leases.push(newRaw);
	const sameV1 = await acquire();
	const sameRaw = await registry.acquire(
		{ ...options, protocol: "raw-v2" },
		new AbortController().signal,
	);
	leases.push(sameRaw);
	expect(sameV1.copy).toBe(changed.copy);
	expect(sameRaw.copy).toBe(newRaw.copy);
	expect(changed.copy.getSnapshot().invalidated).not.toBe(true);
	expect(newRaw.copy.getSnapshot().invalidated).not.toBe(true);
	expect(sessionCanSave(changed.copy.getSnapshot())).toBe(true);
	const oldDraft = await registry.discoverRetained(
		options,
		new AbortController().signal,
		Promise.resolve(changed.copy),
		async () => ({ recoveryKey: "same-owner" }),
	);
	recoveryLeases.push(oldDraft);
	expect(oldDraft.retainedCopies).toEqual([v1.copy]);
	expect(oldDraft.retainedCopies[0].session).toBe(v1.copy.session);
	expect(v1.copy.getSnapshot().invalidated).toBe(true);
	// The retained copy still provides the public immutable snapshot used by export.
	const model = oldDraft.retainedCopies[0].model;
	if (!model) throw new Error("Retained draft must keep its exportable model");
	const snapshot = model.createSnapshot();
	let text = "";
	for (let chunk = snapshot.read(); chunk !== null; chunk = snapshot.read()) text += chunk;
	expect(text).toBe("draft");
});
for (const rapid of [false, true])
	test(`last raw visibility cancels the candidate and ${rapid ? "rapid reveal retries after old cancellation" : "another visible view keeps it alive"}`, async () => {
		const codec = new EditorStreamCodec("utf-8");
		codec.push(new TextEncoder().encode("hello"), true);
		const metadata = codec.finish();
		let id = 0;
		create.mockImplementation(async () => ({ ...descriptor(++id), ...metadata }));
		const closing = deferred<void>();
		const signals: AbortSignal[] = [];
		const loader = spyOn(modelLoader, "loadEditorRawCandidate").mockImplementation(
			async (input) => {
				signals.push(input.signal);
				if (signals.length === 1)
					return new Promise((_resolve, reject) =>
						input.signal.addEventListener(
							"abort",
							() => {
								void (rapid ? closing.promise : Promise.resolve()).then(() =>
									reject(input.signal.reason),
								);
							},
							{ once: true },
						),
					);
				const target = new TestEditorModel({
					filePath: options.path,
					documentKey: "retry",
					initialValue: "hello",
				});
				models.push(target);
				return {
					model: target.getModel(),
					format: { height: 1, kind: "uniform", tag: 1, count: 0 },
					batches: 1,
					maxBatchMs: 0,
					maxQueuedBytes: 0,
				};
			},
		);
		restores.push(() => loader.mockRestore());
		const a = await registry.acquire(
			{ ...options, protocol: "raw-v2" },
			new AbortController().signal,
		);
		leases.push(a);
		const b = !rapid
			? await registry.acquire({ ...options, protocol: "raw-v2" }, new AbortController().signal)
			: undefined;
		if (b) leases.push(b);
		const loading = a.copy.ensureLoaded();
		try {
			for (let turn = 0; turn < 8; turn++) await Promise.resolve();
			expect(signals).toHaveLength(1);
			a.setVisible(false);
			if (b) {
				expect(signals[0].aborted).toBe(false);
				b.setVisible(false);
			}
			expect(signals[0].aborted).toBe(true);
			if (rapid) {
				a.setVisible(true);
				expect(signals).toHaveLength(1);
				closing.resolve();
			}
			await loading;
			for (let turn = 0; turn < 20; turn++) await Promise.resolve();
			if (rapid) {
				expect(signals).toHaveLength(2);
				expect(a.copy.getSnapshot().loaded).toBe(true);
			} else {
				expect(a.copy.pinReasons).not.toContain("candidate");
				expect(a.copy.model).toBeNull();
			}
		} finally {
			closing.resolve();
			a.copy.dispose();
			await loading;
		}
	});

test("simultaneous saves from two leases encode, upload and commit one immutable attempt", async () => {
	const pending = deferred<Blob>();
	const encode = spyOn(worker, "encodeEditorSnapshot").mockReturnValue(pending.promise);
	const begin = spyOn(editorDocumentApi, "createUpload").mockResolvedValue({
		uploadId: "upload",
		state: "uploading",
	});
	const put = spyOn(editorDocumentApi, "upload").mockResolvedValue({
		uploadId: "upload",
		state: "sealed",
	});
	const commit = spyOn(editorDocumentApi, "commit").mockImplementation(async () => ({
		status: "saved",
		operationId: "op",
		hash: "saved",
		snapshotRevision: models[0].revision,
		bytes: 5,
	}));
	restores.push(
		() => encode.mockRestore(),
		() => begin.mockRestore(),
		() => put.mockRestore(),
		() => commit.mockRestore(),
	);
	const [a, b] = await Promise.all([acquire(), acquire()]);
	await a.copy.ensureLoaded();
	models[0].edit("draft");
	const saving = a.copy.session.save();
	const duplicate = b.copy.session.save();
	expect(encode).toHaveBeenCalledTimes(1);
	a.release();
	await tick();
	expect(models[0].disposed).toBe(false);
	pending.resolve(new Blob(["draft"]));
	await Promise.all([saving, duplicate]);
	expect(begin).toHaveBeenCalledTimes(1);
	expect(put).toHaveBeenCalledTimes(1);
	expect(commit).toHaveBeenCalledTimes(1);
	expect(b.copy.protected).toBe(false);
});

test("different server bindings never merge even with identical UI path/narrator", async () => {
	create.mockImplementation(async () =>
		descriptor(create.mock.calls.length, `scope-${create.mock.calls.length}`),
	);
	const [a, b] = await Promise.all([acquire(), acquire()]);
	expect(a.copy).not.toBe(b.copy);
	await Promise.all([a.copy.ensureLoaded(), b.copy.ensureLoaded()]);
	expect(models).toHaveLength(2);
});

for (const authorized of [true, false])
	test(`reopening a changed binding ${authorized ? "exposes" : "never exposes"} the retained draft under its verified recovery principal`, async () => {
		create.mockResolvedValue({ ...descriptor(1), recoveryKey: "verified-principal" });
		const old = await acquire();
		await old.copy.ensureLoaded();
		models[0].edit("retained draft");
		registry.invalidateNarrator("source", "scope changed");
		expect(registry.discardRetained(old.copy)).toBe(false);
		old.release();
		await tick();
		create.mockResolvedValue({
			...descriptor(2, "new-context"),
			recoveryKey: authorized ? "verified-principal" : "another-principal",
		});
		const current = await acquire();
		await current.copy.ensureLoaded();
		expect(current.copy).not.toBe(old.copy);
		const proof = spyOn(editorDocumentApi, "recoveryScope").mockResolvedValue({
			recoveryKey: authorized ? "verified-principal" : "another-principal",
		});
		restores.push(() => proof.mockRestore());
		const recovered = await registry.discoverRetained(
			options,
			new AbortController().signal,
			Promise.resolve(current.copy),
		);
		recoveryLeases.push(recovered);
		expect(recovered.retainedCopies).toEqual(authorized ? [old.copy] : []);
		expect(models[0].text).toBe("retained draft");
		expect(models[0].disposed).toBe(false);
		expect(models[1].text).toBe("hello");
		expect(current.copy.getSnapshot().invalidated).not.toBe(true);
		if (authorized) {
			expect(registry.discardRetained(old.copy)).toBe(true);
			expect(models[0].disposed).toBe(true);
			expect(models[1].disposed).toBe(false);
			expect(old.copy.getSnapshot().discarded).toBe(true);
			expect(registry.size).toBe(1);
		}
	});

for (const access of ["owner", "different-user", "revoked"] as const)
	test(`independent retained discovery ${access} never depends on current create or a client path as authorization`, async () => {
		create.mockResolvedValue({ ...descriptor(1), recoveryKey: "original-owner" });
		const old = await acquire();
		await old.copy.ensureLoaded();
		models[0].edit("private draft");
		old.release();
		await tick();
		const proof = spyOn(editorDocumentApi, "recoveryScope");
		restores.push(() => proof.mockRestore());
		if (access === "revoked") proof.mockRejectedValue(new ApiError("Forbidden", 403));
		else
			proof.mockResolvedValue({
				recoveryKey: access === "owner" ? "original-owner" : "other-owner",
			});
		create.mockRejectedValue(new ApiError("Current path unavailable", 403));
		if (access === "revoked")
			await expect(
				registry.discoverRetained(options, new AbortController().signal),
			).rejects.toThrow("Forbidden");
		else {
			const recovered = await registry.discoverRetained(options, new AbortController().signal);
			recoveryLeases.push(recovered);
			expect(recovered.retainedCopies).toEqual(access === "owner" ? [old.copy] : []);
			if (access === "owner") expect(old.copy.getSnapshot().invalidated).toBe(true);
		}
		expect(proof).toHaveBeenCalledWith(
			"source",
			{ deviceId: "local", origin: "reference" },
			expect.any(AbortSignal),
		);
		expect(create).toHaveBeenCalledTimes(1);
		expect(source).toHaveBeenCalledTimes(1);
		expect(models[0].text).toBe("private draft");
		expect(models[0].disposed).toBe(false);
	});

for (const fence of ["abort", "generation"] as const)
	test(`late independent recovery proof cannot publish after ${fence}`, async () => {
		create.mockResolvedValue({ ...descriptor(1), recoveryKey: "owner" });
		const old = await acquire();
		await old.copy.ensureLoaded();
		models[0].edit("private draft");
		old.release();
		await tick();
		const pending = deferred<{ recoveryKey: string }>();
		const proof = spyOn(editorDocumentApi, "recoveryScope").mockReturnValue(pending.promise);
		restores.push(() => proof.mockRestore());
		const controller = new AbortController();
		const recovering = registry.discoverRetained(options, controller.signal);
		if (fence === "abort") controller.abort();
		else registry.invalidateNarrator("source", "new context");
		pending.resolve({ recoveryKey: "owner" });
		await expect(recovering).rejects.toThrow();
		expect(models[0].text).toBe("private draft");
		expect(models[0].disposed).toBe(false);
		expect(
			[...(Reflect.get(registry, "entries") as Set<{ references: number }>)][0].references,
		).toBe(0);
	});

test("a discarded draft is not resurrected by a delayed independent recovery response", async () => {
	create.mockResolvedValue({ ...descriptor(1), recoveryKey: "owner" });
	const old = await acquire();
	await old.copy.ensureLoaded();
	models[0].edit("old draft");
	registry.invalidateNarrator("source", "old scope");
	old.release();
	await tick();
	const pending = deferred<{ recoveryKey: string }>();
	const proof = spyOn(editorDocumentApi, "recoveryScope").mockReturnValue(pending.promise);
	restores.push(() => proof.mockRestore());
	const recovering = registry.discoverRetained(options, new AbortController().signal);
	expect(registry.discardRetained(old.copy)).toBe(true);
	pending.resolve({ recoveryKey: "owner" });
	const recovered = await recovering;
	recoveryLeases.push(recovered);
	expect(recovered.retainedCopies).toEqual([]);
	expect(registry.size).toBe(0);
	expect(models[0].disposed).toBe(true);
});

test("independent discovery never invalidates the ordinary dirty working copy reacquired by the current view", async () => {
	create.mockImplementation(async () => ({
		...descriptor(create.mock.calls.length),
		recoveryKey: "owner",
	}));
	const old = await acquire();
	await old.copy.ensureLoaded();
	models[0].edit("same draft and undo");
	old.release();
	await tick();
	const proof = spyOn(editorDocumentApi, "recoveryScope").mockResolvedValue({
		recoveryKey: "owner",
	});
	restores.push(() => proof.mockRestore());
	const viewing = acquire();
	const recovered = await registry.discoverRetained(
		options,
		new AbortController().signal,
		viewing.then((lease) => lease.copy),
	);
	recoveryLeases.push(recovered);
	const current = await viewing;
	expect(current.copy).toBe(old.copy);
	expect(recovered.retainedCopies).toEqual([]);
	expect(current.copy.getSnapshot().invalidated).not.toBe(true);
	expect(models).toHaveLength(1);
	expect(models[0].text).toBe("same draft and undo");
	expect(source).toHaveBeenCalledTimes(1);
});

test("cancellation stops independent discovery even while an uncooperative current create remains pending", async () => {
	create.mockResolvedValue({ ...descriptor(1), recoveryKey: "owner" });
	const old = await acquire();
	await old.copy.ensureLoaded();
	models[0].edit("private draft");
	old.release();
	await tick();
	const proof = spyOn(editorDocumentApi, "recoveryScope").mockResolvedValue({
		recoveryKey: "owner",
	});
	restores.push(() => proof.mockRestore());
	const excluding = deferred<null>();
	const controller = new AbortController();
	const recovering = registry.discoverRetained(options, controller.signal, excluding.promise);
	await tick();
	controller.abort();
	await expect(recovering).rejects.toThrow();
	excluding.resolve(null);
	await tick();
	expect([...(Reflect.get(registry, "entries") as Set<{ references: number }>)][0].references).toBe(
		0,
	);
	expect(models[0].text).toBe("private draft");
	expect(models[0].disposed).toBe(false);
});

test("old v1 descriptors without opaque bindings remain exclusive", async () => {
	create.mockImplementation(async () => ({
		...descriptor(create.mock.calls.length),
		resourceKey: undefined,
	}));
	const [a, b] = await Promise.all([acquire(), acquire()]);
	expect(a.copy).not.toBe(b.copy);
});

test("last dirty reference is pinned; reacquire restores the same draft and undo", async () => {
	const a = await acquire();
	await a.copy.ensureLoaded();
	models[0].edit("unsaved");
	a.release();
	await tick();
	expect(registry.size).toBe(1);
	expect(models[0].disposed).toBe(false);
	const b = await acquire();
	expect(b.copy).toBe(a.copy);
	await b.copy.ensureLoaded();
	expect(source).toHaveBeenCalledTimes(1);
	models[0].undo();
	expect(models[0].text).toBe("hello");
});

test("cancellation after an uncooperative create releases the extra descriptor without installing it", async () => {
	const pending = deferred<EditorDocumentDescriptor>();
	create.mockReturnValue(pending.promise);
	const controller = new AbortController();
	const result = acquire(controller.signal);
	controller.abort();
	pending.resolve(descriptor(99));
	await expect(result).rejects.toThrow();
	expect(release).toHaveBeenCalledWith("source", "doc-99");
	expect(registry.size).toBe(0);
	expect(source).not.toHaveBeenCalled();
});

test("context invalidation fences pending authorization and retains old dirty model without rebinding", async () => {
	const a = await acquire();
	await a.copy.ensureLoaded();
	models[0].edit("old draft");
	const pending = deferred<EditorDocumentDescriptor>();
	create.mockReturnValue(pending.promise);
	const late = acquire();
	registry.invalidateNarrator("source", "context changed");
	pending.resolve(descriptor(99));
	await expect(late).rejects.toThrow("authorization changed");
	expect(a.copy.getSnapshot().invalidated).toBe(true);
	expect(models[0].text).toBe("old draft");
	await a.copy.session.load();
	await a.copy.session.save();
	expect(models[0].text).toBe("old draft");
	expect(source).toHaveBeenCalledTimes(1);
	expect(release).toHaveBeenCalledWith("source", "doc-99");
});

test("late model candidate after release is disposed and never starts a source load", async () => {
	const pending = deferred<ReturnType<TestEditorModel["getModel"]>>();
	const factory = spyOn(workingCopies, "createWorkingCopyModel").mockReturnValue(pending.promise);
	const a = await acquire();
	const loading = a.copy.ensureLoaded();
	a.release();
	await tick();
	const model = new TestEditorModel({ filePath: "/repo/a", documentKey: "late", initialValue: "" });
	pending.resolve(model.getModel());
	await loading;
	expect(model.disposed).toBe(true);
	expect(source).not.toHaveBeenCalled();
	factory.mockRestore();
});

test("initial source retry cannot change the registry's authorized resource binding", async () => {
	const a = await acquire();
	source.mockRejectedValueOnce(new ApiError("changed", 409, { code: "EDITOR_SOURCE_CHANGED" }));
	create.mockResolvedValue(descriptor(99, "new-workspace"));
	await a.copy.ensureLoaded();
	expect(a.copy.getSnapshot().invalidated).toBe(true);
	expect(a.copy.getSnapshot().loaded).toBe(false);
	expect(models[0].text).toBe("");
	expect(source).toHaveBeenCalledTimes(1);
	expect(release).toHaveBeenCalledWith("source", "doc-99");
});

test("source failure retry reuses its existing model without leaking another candidate", async () => {
	source.mockRejectedValueOnce(new Error("offline"));
	const a = await acquire();
	await a.copy.ensureLoaded();
	expect(a.copy.getSnapshot().loaded).toBe(false);
	await a.copy.ensureLoaded();
	expect(a.copy.getSnapshot().loaded).toBe(true);
	expect(models).toHaveLength(1);
});

test("clean hidden tab leases do not keep a model, baseline or server doc alive under pressure", async () => {
	registry = new EditorDocumentRegistry({ count: 0, bytes: 0, idleMs: 300_000 });
	const onEvicted = spyOn({ run() {} }, "run");
	const lease = await registry.acquire(options, new AbortController().signal, onEvicted);
	leases.push(lease);
	await lease.copy.ensureLoaded();
	expect(models[0].disposed).toBe(false);
	lease.setVisible(false);
	await tick();
	expect(models[0].disposed).toBe(true);
	expect(registry.size).toBe(0);
	expect(onEvicted).toHaveBeenCalledTimes(1);
	expect(lease.copy.session.resourceCosts).toEqual({ documents: 0, baselineBytes: 0 });
	expect(release).toHaveBeenCalledWith("source", "doc-1");
	lease.release();
	lease.setVisible(true);
	expect(registry.size).toBe(0);
});

for (const reason of [
	"dirty",
	"encoding",
	"uploading",
	"committing",
	"unknown",
	"confirmation",
	"conflict",
] as const)
	test(`registry protects real working copy ${reason} state while hidden and all budgets are exceeded`, async () => {
		registry = new EditorDocumentRegistry({ count: 0, bytes: 0, idleMs: 1 });
		const lease = await acquire();
		await lease.copy.ensureLoaded();
		const clean = lease.copy.session.state;
		if (reason === "dirty") models[0].edit("protected draft");
		else if (reason === "confirmation" || reason === "conflict")
			lease.copy.session.state = { ...clean, [reason]: {} };
		else lease.copy.session.state = { ...clean, phase: reason };
		lease.setVisible(false);
		await tick();
		expect(models[0].disposed).toBe(false);
		expect(registry.diagnostics().pinReasons[reason]).toBe(1);
		expect(registry.diagnostics().pinnedBytes).toBeGreaterThan(0);
		lease.copy.session.state = clean;
		lease.release();
		await tick();
		expect(models[0].disposed).toBe(true);
	});

test("one visible lease protects a shared model when the other hides and releases", async () => {
	registry = new EditorDocumentRegistry({ count: 0, bytes: 0, idleMs: 1 });
	const a = await acquire();
	const b = await acquire();
	await a.copy.ensureLoaded();
	a.setVisible(false);
	a.release();
	await tick();
	expect(models[0].disposed).toBe(false);
	expect(registry.diagnostics().visibleConsumers).toBe(1);
	b.setVisible(false);
	await tick();
	expect(models[0].disposed).toBe(true);
});

test("a valid candidate installation reference survives final consumer release even before a model exists", async () => {
	const lease = await acquire();
	const releaseCandidate = lease.copy.pin("candidate-install", { models: 1, bytes: 100 });
	lease.release();
	await tick();
	expect(registry.size).toBe(1);
	expect(source).not.toHaveBeenCalled();
	expect(registry.diagnostics().pinReasons["candidate-install"]).toBe(1);
	releaseCandidate();
	await tick();
	expect(registry.size).toBe(0);
	expect(release).toHaveBeenCalledWith("source", "doc-1");
});

test("candidate reservations and independent pin owners account for old plus future costs", async () => {
	registry = new EditorDocumentRegistry({ count: 0, bytes: 0, idleMs: 1 });
	const lease = await acquire();
	await lease.copy.ensureLoaded();
	const initial = lease.copy.resourceCosts;
	const releaseA = lease.copy.pin("candidate-install", { models: 1, bytes: 100 });
	const releaseB = lease.copy.pin("candidate-install");
	expect(lease.copy.resourceCosts.models).toBe(initial.models + 1);
	expect(lease.copy.resourceCosts.bytes).toBe(initial.bytes + 100);
	lease.setVisible(false);
	await tick();
	releaseA();
	releaseA();
	await tick();
	expect(models[0].disposed).toBe(false);
	expect(lease.copy.resourceCosts).toEqual(initial);
	releaseB();
	await tick();
	expect(models[0].disposed).toBe(true);
});

test("a clean cached tab is authorized again before reattaching, not trusted by its old path", async () => {
	const first = await acquire();
	await first.copy.ensureLoaded();
	first.setVisible(false);
	await tick();
	create.mockRejectedValueOnce(new ApiError("revoked", 403));
	await expect(acquire()).rejects.toThrow("revoked");
	expect(source).toHaveBeenCalledTimes(1);
	expect(models[0].disposed).toBe(false);
	registry.invalidateNarrator("source", "revoked");
	first.release();
	await tick();
	expect(models[0].disposed).toBe(true);
});

test("late source results cannot install after binding invalidation", async () => {
	const pending = deferred<string>();
	source.mockReturnValue(pending.promise);
	const a = await acquire();
	const loading = a.copy.ensureLoaded();
	await tick();
	registry.invalidateNarrator("source", "context changed");
	pending.resolve("late new text");
	await loading;
	expect(models[0].text).toBe("");
	expect(a.copy.getSnapshot().loaded).toBe(false);
	expect(a.copy.getSnapshot().invalidated).toBe(true);
});
