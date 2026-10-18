import { expect, mock, test } from "bun:test";
import type { EditorCommitResult, EditorDocumentDescriptor } from "@shared/editor-document";
import {
	EDITOR_BOUNDED_READ_CAPABILITIES,
	EDITOR_LOCAL_V1_CAPABILITIES,
} from "@shared/editor-provider-contracts";
import { ApiError } from "../../../lib/api/client";
import type { editorDocumentApi } from "../../../lib/api/editor-documents";
import {
	EditorDocumentSession,
	sessionCanSave,
	sessionDirty,
	sessionExitBlocked,
} from "./editor-session-state";
import type { EditorTextSnapshot } from "./editor-worker-client";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
const descriptor: EditorDocumentDescriptor = {
	docId: "doc",
	versionHandle: "immutable-v1",
	target: { deviceId: "local", path: "/work/a.txt" },
	baseHash: "original-hash",
	encoding: "utf-16le",
	eol: "CRLF",
	sourceBytes: 8,
	utf8Bytes: 4,
};
async function setup(load = true) {
	let text = "";
	let revision = 0;
	let alternativeVersionId = 0;
	const api = {
		create: mock<typeof editorDocumentApi.create>(async () => descriptor),
		source: mock<typeof editorDocumentApi.source>(async () => "a\nb\n"),
		sourcePreview: mock<typeof editorDocumentApi.sourcePreview>(async () => ({
			content: "theirs",
			truncated: false,
		})),
		sourceBlob: mock<typeof editorDocumentApi.sourceBlob>(async () => new Blob(["theirs"])),
		createUpload: mock<typeof editorDocumentApi.createUpload>(async () => ({
			uploadId: "upload",
			state: "uploading" as const,
		})),
		upload: mock<typeof editorDocumentApi.upload>(async () => ({
			uploadId: "upload",
			state: "sealed" as const,
		})),
		commit: mock<typeof editorDocumentApi.commit>(
			async (): Promise<EditorCommitResult> => ({
				status: "saved",
				hash: "saved-hash",
				operationId: "op",
				snapshotRevision: revision,
				bytes: 8,
			}),
		),
		getUpload: mock<typeof editorDocumentApi.getUpload>(async () => ({
			uploadId: "upload",
			state: "committing" as const,
			operationId: "op",
		})),
		operation: mock<typeof editorDocumentApi.operation>(async () => ({
			status: "uncertain",
			operationId: "op",
		})),
		cancelUpload: mock<typeof editorDocumentApi.cancelUpload>(async () => ({
			uploadId: "upload",
			state: "cancelled",
		})),
		release: mock<typeof editorDocumentApi.release>(async () => ({})),
	};
	const hashes = new WeakMap<Blob, string>();
	const textOf = (snapshot: EditorTextSnapshot) => {
		const chunks: string[] = [];
		for (let chunk = snapshot.read(); chunk !== null; chunk = snapshot.read()) chunks.push(chunk);
		return chunks.join("");
	};
	const hash = mock(async (snapshot: EditorTextSnapshot, _signal?: AbortSignal) =>
		textOf(snapshot),
	);
	const encode = mock(async (snapshot: EditorTextSnapshot) => {
		const text = textOf(snapshot);
		const blob = new Blob([text]);
		hashes.set(blob, text);
		return blob;
	});
	const applyContent = mock((next: string) => {
		text = next;
		revision++;
		alternativeVersionId = revision;
		return { revision, alternativeVersionId, length: text.length };
	});
	const snapshot = mock(() => {
		let copy: string | null = text;
		return {
			revision,
			alternativeVersionId,
			length: text.length,
			read: () => {
				const result = copy;
				copy = null;
				return result;
			},
		};
	});
	const session = new EditorDocumentSession({
		narratorId: "child",
		path: "/work/a.txt",
		deviceId: "local",
		origin: () => "reference",
		api: api as unknown as typeof editorDocumentApi,
		snapshot,
		encode,
		hash,
		encodedHash: (blob) => hashes.get(blob) ?? null,
		applyContent,
		onChange: () => {},
	});
	if (load) await session.load();
	snapshot.mockClear();
	const change = (next: string, alt?: number) => {
		text = next;
		revision++;
		alternativeVersionId = alt ?? revision;
		session.change({ revision, alternativeVersionId, length: text.length });
	};
	return { session, api, encode, hash, applyContent, snapshot, change, text: () => text };
}

test("a background reauthorization completing during upload cannot release its active document", async () => {
	const { session, api, change } = await setup();
	const authorization = deferred<EditorDocumentDescriptor>(),
		upload = deferred<Awaited<ReturnType<typeof editorDocumentApi.createUpload>>>();
	api.create.mockReturnValueOnce(authorization.promise);
	const refreshing = session.refreshDocument();
	change("saved while authorizing");
	api.createUpload.mockReturnValueOnce(upload.promise);
	const saving = session.save();
	for (let step = 0; step < 20 && !api.createUpload.mock.calls.length; step++)
		await Promise.resolve();
	expect(api.createUpload).toHaveBeenCalledTimes(1);
	authorization.resolve({ ...descriptor, docId: "background-doc" });
	expect(await refreshing).toBe(false);
	expect(api.release).toHaveBeenCalledWith("child", "background-doc");
	expect(api.release.mock.calls.some((call) => call[1] === "doc")).toBe(false);
	upload.resolve({ uploadId: "upload", state: "uploading" });
	await saving;
	expect(api.commit.mock.calls[0]?.[1]).toBe("doc");
	expect(sessionDirty(session.state)).toBe(false);
	session.dispose();
});

test("runtime change at commit verifies fresh scope but retains the original sealed proof for query-first cancellation", async () => {
	const { session, api, change, text } = await setup(false);
	api.create.mockResolvedValue({
		...descriptor,
		resourceKey: "runtime-A",
		stableResourceKey: "verified-root",
	});
	await session.load();
	change("immutable draft");
	api.create.mockResolvedValue({
		...descriptor,
		docId: "fresh",
		resourceKey: "runtime-B",
		stableResourceKey: "verified-root",
	});
	Object.assign(api, { diskState: mock(async () => ({ exists: true, ...descriptor })) });
	api.createUpload.mockResolvedValue({
		uploadId: "upload",
		state: "uploading",
		operationId: "original-op",
	});
	api.commit.mockRejectedValue(
		new ApiError("runtime restarted", 403, { code: "EDITOR_IDENTITY_CHANGED" }),
	);
	api.operation.mockRejectedValue(new ApiError("missing", 404));
	api.getUpload.mockImplementation(async (_narrator, id) => {
		expect(id).toBe("doc");
		expect(api.release.mock.calls.some((call) => call[1] === "doc")).toBe(false);
		return { uploadId: "upload", state: "sealed" };
	});
	await session.save();
	expect(api.operation).toHaveBeenCalledWith("child", "original-op");
	expect(api.commit).toHaveBeenCalledTimes(1);
	expect(api.createUpload).toHaveBeenCalledTimes(1);
	expect(api.release).toHaveBeenCalledWith("child", "fresh");
	expect(session.state.phase).toBe("idle");
	expect(session.state.invalidated).not.toBe(true);
	expect(session.state.baseHash).toBe("original-hash");
	expect(text()).toBe("immutable draft");
	expect(sessionDirty(session.state)).toBe(true);
	session.dispose();
});

test("410 reauthorization cannot bind a dirty draft to another authorized execution scope", async () => {
	const { session, api, change, text } = await setup(false);
	api.create.mockResolvedValue({ ...descriptor, resourceKey: "original-scope" });
	await session.load();
	change("old draft");
	api.createUpload.mockRejectedValueOnce(new ApiError("Expired", 410));
	api.create.mockResolvedValue({
		...descriptor,
		docId: "new-doc",
		resourceKey: "new-scope",
		baseHash: "new-disk",
	});
	await session.save();
	expect(text()).toBe("old draft");
	expect(session.state.baseHash).toBe("original-hash");
	expect(session.state.invalidated).toBe(true);
	expect(sessionCanSave(session.state)).toBe(false);
	expect(api.release).toHaveBeenCalledWith("child", "new-doc");
	expect(api.commit).not.toHaveBeenCalled();
});

test("410 refresh replaces capabilities with the new descriptor without rebuilding the draft", async () => {
	const { session, api, change, text, applyContent } = await setup(false);
	api.create.mockResolvedValue({
		...descriptor,
		resourceKey: "scope",
		capabilities: EDITOR_LOCAL_V1_CAPABILITIES,
	});
	await session.load();
	expect(sessionCanSave(session.state)).toBe(false); // clean
	change("draft");
	expect(sessionCanSave(session.state)).toBe(true);
	const before = session.state;
	// Same authorized resource, but the provider now only offers a bounded read.
	api.create.mockResolvedValue({
		...descriptor,
		docId: "doc-2",
		resourceKey: "scope",
		capabilities: EDITOR_BOUNDED_READ_CAPABILITIES,
	});
	expect(await session.refreshDocument()).toBe(true);
	// A new immutable snapshot is what useSyncExternalStore subscribers re-render on.
	expect(session.state).not.toBe(before);
	expect(session.state.capabilities).toEqual(EDITOR_BOUNDED_READ_CAPABILITIES);
	expect(session.documentId).toBe("doc-2");
	expect(text()).toBe("draft");
	expect(applyContent).toHaveBeenCalledTimes(1); // no model rebuild
	expect(sessionDirty(session.state)).toBe(true);
	expect(sessionCanSave(session.state)).toBe(false);
	await session.save(); // a caller bypassing the UI is refused too
	expect(api.createUpload).not.toHaveBeenCalled();
});

test("invalidation keeps the last declared capabilities and never falls back to the local heuristic", async () => {
	const { session, api, change } = await setup(false);
	api.create.mockResolvedValue({ ...descriptor, capabilities: EDITOR_LOCAL_V1_CAPABILITIES });
	await session.load();
	change("draft");
	session.invalidate("revoked");
	expect(session.state.capabilities).toEqual(EDITOR_LOCAL_V1_CAPABILITIES);
	expect(sessionCanSave(session.state)).toBe(false);
	await session.save();
	expect(api.createUpload).not.toHaveBeenCalled();
	expect(sessionDirty(session.state)).toBe(true);
});

test("an older server without declared capabilities keeps the v1 save path", async () => {
	const { session, api, change } = await setup();
	expect(session.state.capabilities).toBeUndefined();
	change("draft");
	expect(sessionCanSave(session.state)).toBe(true);
	await session.save();
	expect(api.commit).toHaveBeenCalledTimes(1);
});

test("invalidation during commit preserves unknown attempt and rejects late success and confirmation dispatch", async () => {
	const { session, api, change, text } = await setup();
	change("inflight draft");
	const pending = deferred<EditorCommitResult>();
	api.commit.mockReturnValue(pending.promise);
	const saving = session.save();
	for (let step = 0; step < 10 && !api.commit.mock.calls.length; step++) await Promise.resolve();
	expect(session.state.phase).toBe("committing");
	session.invalidate("scope changed");
	pending.resolve({
		status: "saved",
		hash: "late-hash",
		operationId: "op",
		snapshotRevision: 2,
		bytes: 14,
	});
	await saving;
	await session.confirm();
	await session.load();
	expect(session.state.phase).toBe("unknown");
	expect(session.state.baseHash).toBe("original-hash");
	expect(text()).toBe("inflight draft");
	expect(sessionExitBlocked(session.state)).toBe(true);
	expect(api.commit).toHaveBeenCalledTimes(1);
	expect(api.operation).not.toHaveBeenCalled();
	expect(api.cancelUpload).not.toHaveBeenCalled();
});

for (const status of ["saved", "conflict", "not-applied", "uncertain", "denied"] as const)
	test(`invalidated dispatched attempt explicitly queries its ${status} receipt without rebinding or losing the draft`, async () => {
		const { session, api, change, text, applyContent } = await setup();
		change("old draft");
		const baseline = session.state.baseline;
		const pending = deferred<EditorCommitResult>();
		api.commit.mockReturnValue(pending.promise);
		const saving = session.save();
		for (let step = 0; step < 10 && !api.commit.mock.calls.length; step++) await Promise.resolve();
		session.invalidate("scope changed");
		expect(session.discardRetainedDraft()).toBe(false);
		pending.resolve({
			status: "saved",
			operationId: "op",
			hash: "late-hash",
			snapshotRevision: 2,
			bytes: 9,
		});
		await saving;
		expect(api.operation).not.toHaveBeenCalled();
		if (status === "saved")
			api.operation.mockResolvedValue({
				status: "saved",
				operationId: "op",
				result: {
					status: "saved",
					operationId: "op",
					hash: "saved-hash",
					snapshotRevision: 2,
					bytes: 9,
				},
			});
		else if (status === "conflict")
			api.operation.mockResolvedValue({
				status: "failed",
				operationId: "op",
				error: { code: "STALE_WRITE", message: "Conflict" },
			});
		else if (status === "not-applied") {
			api.operation.mockRejectedValue(new ApiError("Not found", 404));
			api.getUpload.mockResolvedValue({ uploadId: "upload", state: "cancelled" });
		} else if (status === "denied") api.operation.mockRejectedValue(new ApiError("Forbidden", 403));
		await session.reconcile();
		expect(api.operation).toHaveBeenCalledWith("child", "op");
		expect(session.state.phase).toBe(
			status === "uncertain" || status === "denied" ? "unknown" : "idle",
		);
		expect(session.state.invalidated).toBe(true);
		expect(sessionCanSave(session.state)).toBe(false);
		expect(session.state.baseHash).toBe("original-hash");
		expect(session.state.baseline).toBe(baseline);
		expect(sessionDirty(session.state)).toBe(true);
		expect(text()).toBe("old draft");
		expect(applyContent).toHaveBeenCalledTimes(1);
		expect(api.create).toHaveBeenCalledTimes(1);
		expect(api.commit).toHaveBeenCalledTimes(1);
		expect(api.cancelUpload).not.toHaveBeenCalled();
		if (status === "denied") expect(session.state.receiptError).toContain("Forbidden");
		else expect(session.state.receipt?.status).toBe(status === "conflict" ? "failed" : status);
	});

test("a late conflict response after invalidation retains its operation id for explicit receipt recovery only", async () => {
	const { session, api, change, text } = await setup();
	change("old draft");
	const pending = deferred<EditorCommitResult>();
	api.commit.mockReturnValue(pending.promise);
	const saving = session.save();
	for (let step = 0; step < 10 && !api.commit.mock.calls.length; step++) await Promise.resolve();
	session.invalidate("scope changed");
	pending.reject(
		new ApiError("Conflict", 409, { code: "STALE_WRITE", operationId: "late-conflict" }),
	);
	await saving;
	expect(api.operation).not.toHaveBeenCalled();
	expect(session.state.phase).toBe("unknown");
	api.operation.mockResolvedValue({
		status: "failed",
		operationId: "late-conflict",
		error: { code: "STALE_WRITE", message: "Conflict" },
	});
	await session.reconcile();
	expect(api.operation).toHaveBeenCalledWith("child", "late-conflict");
	expect(session.state.phase).toBe("idle");
	expect(session.state.invalidated).toBe(true);
	expect(text()).toBe("old draft");
	expect(api.commit).toHaveBeenCalledTimes(1);
});

test("invalidated receipt queries are single-flight, reject mismatched revisions and preserve edits made while checking", async () => {
	const { session, api, change, text } = await setup();
	change("sent");
	const pending = deferred<EditorCommitResult>();
	api.commit.mockReturnValue(pending.promise);
	const saving = session.save();
	for (let step = 0; step < 10 && !api.commit.mock.calls.length; step++) await Promise.resolve();
	session.invalidate("scope changed");
	pending.resolve({
		status: "saved",
		operationId: "op",
		hash: "late",
		snapshotRevision: 2,
		bytes: 4,
	});
	await saving;
	const query = deferred<Awaited<ReturnType<typeof editorDocumentApi.operation>>>();
	api.operation.mockReturnValue(query.promise);
	const first = session.reconcile();
	const second = session.reconcile();
	await Promise.resolve();
	expect(api.operation).toHaveBeenCalledTimes(1);
	expect(session.state.checkingReceipt).toBe(true);
	change("preserved later draft");
	query.resolve({
		status: "saved",
		operationId: "op",
		result: {
			status: "saved",
			operationId: "op",
			hash: "mismatch",
			snapshotRevision: 99,
			bytes: 4,
		},
	});
	await Promise.all([first, second]);
	expect(session.state.phase).toBe("unknown");
	expect(session.state.receiptError).toContain("revision");
	api.operation.mockResolvedValue({
		status: "saved",
		operationId: "op",
		result: { status: "saved", operationId: "op", hash: "right", snapshotRevision: 2, bytes: 4 },
	});
	await session.reconcile();
	expect(session.state.phase).toBe("idle");
	expect(session.state.checkingReceipt).toBe(false);
	expect(text()).toBe("preserved later draft");
	expect(sessionDirty(session.state)).toBe(true);
	expect(session.state.baseHash).toBe("original-hash");
	expect(api.commit).toHaveBeenCalledTimes(1);
});

for (const cancellation of ["cancelled", "committing", "empty", "denied"] as const)
	test(`invalidated not-found receipt requires authorized cancellation evidence: ${cancellation}`, async () => {
		const { session, api, change, text } = await setup();
		change("old draft");
		const pending = deferred<EditorCommitResult>();
		api.commit.mockReturnValue(pending.promise);
		const saving = session.save();
		for (let step = 0; step < 10 && !api.commit.mock.calls.length; step++) await Promise.resolve();
		session.invalidate("scope changed");
		pending.resolve({
			status: "saved",
			operationId: "op",
			hash: "late",
			snapshotRevision: 2,
			bytes: 9,
		});
		await saving;
		api.operation.mockRejectedValue(new ApiError("missing", 404));
		api.getUpload.mockResolvedValue({ uploadId: "upload", state: "sealed" });
		if (cancellation === "denied") api.getUpload.mockRejectedValue(new ApiError("Forbidden", 403));
		else
			api.cancelUpload.mockResolvedValue(
				cancellation === "empty" ? undefined : { uploadId: "upload", state: cancellation },
			);
		await session.reconcile();
		expect(session.state.phase).toBe(cancellation === "cancelled" ? "idle" : "unknown");
		if (cancellation === "cancelled") expect(session.state.receipt?.status).toBe("not-applied");
		else expect(session.state.receiptError).toBeTruthy();
		expect(text()).toBe("old draft");
		expect(sessionDirty(session.state)).toBe(true);
		expect(session.state.invalidated).toBe(true);
		expect(api.commit).toHaveBeenCalledTimes(1);
		if (cancellation === "denied") expect(api.cancelUpload).not.toHaveBeenCalled();
	});

test("source is immutable, authorized as child/reference, and bound to declared bytes", async () => {
	const { session, api } = await setup();
	expect(api.create).toHaveBeenCalledWith(
		"child",
		{ path: "/work/a.txt", deviceId: "local", origin: "reference" },
		expect.any(AbortSignal),
	);
	expect(api.source).toHaveBeenCalledWith(
		"child",
		"doc",
		"immutable-v1",
		expect.any(AbortSignal),
		4,
	);
	expect(sessionDirty(session.state)).toBe(false);
});

const sourceChanged = () => new ApiError("Source changed", 409, { code: "EDITOR_SOURCE_CHANGED" });

for (const stage of ["create", "source"] as const)
	test(`initial load retries ${stage} source changes once with fresh metadata`, async () => {
		const { session, api, applyContent } = await setup(false);
		const fresh = { ...descriptor, docId: "fresh", versionHandle: "v2", baseHash: "new-hash" };
		api[stage].mockRejectedValueOnce(sourceChanged());
		if (stage === "source") api.create.mockResolvedValueOnce(descriptor);
		api.create.mockResolvedValue(fresh);
		await session.load();
		expect(api.create).toHaveBeenCalledTimes(2);
		expect(api.source).toHaveBeenLastCalledWith("child", "fresh", "v2", expect.any(AbortSignal), 4);
		expect(api.release).toHaveBeenCalledTimes(stage === "source" ? 1 : 0);
		if (stage === "source") expect(api.release).toHaveBeenCalledWith("child", "doc");
		expect(applyContent).toHaveBeenCalledTimes(1);
		expect(session.state.baseHash).toBe("new-hash");
		expect(session.state.error).toBeNull();
		expect(session.state.loading).toBe(false);
	});

test("repeated source changes stop after one retry and release both failed sessions", async () => {
	const { session, api, applyContent } = await setup(false);
	api.create.mockResolvedValueOnce(descriptor).mockResolvedValue({ ...descriptor, docId: "retry" });
	api.source.mockRejectedValue(sourceChanged());
	await session.load();
	expect(api.create).toHaveBeenCalledTimes(2);
	expect(api.source).toHaveBeenCalledTimes(2);
	expect(api.release.mock.calls).toEqual([
		["child", "doc"],
		["child", "retry"],
	]);
	expect(applyContent).not.toHaveBeenCalled();
	expect(session.state.loaded).toBe(false);
	expect(session.state.loading).toBe(false);
	expect(session.state.error).toBe("Source changed");
});

for (const failure of [
	new ApiError("Other conflict", 409, { code: "OTHER_CONFLICT" }),
	new ApiError("Wrong status", 403, { code: "EDITOR_SOURCE_CHANGED" }),
	new ApiError("Expired", 410),
	new TypeError("Network failure"),
])
	test(`initial load does not retry ${failure.message}`, async () => {
		const { session, api, applyContent } = await setup(false);
		api.source.mockRejectedValue(failure);
		await session.load();
		expect(api.create).toHaveBeenCalledTimes(1);
		expect(api.source).toHaveBeenCalledTimes(1);
		expect(api.release).toHaveBeenCalledWith("child", "doc");
		expect(applyContent).not.toHaveBeenCalled();
		if (failure instanceof ApiError && failure.status === 403) {
			expect(session.state.invalidated).toBe(true);
			expect(session.state.error).toContain("authorization changed");
		} else expect(session.state.error).toBe(failure.message);
	});

test("source retry preserves a draft edited while retry authorization is pending", async () => {
	const { session, api, applyContent, change, text } = await setup();
	const pending = deferred<EditorDocumentDescriptor>();
	api.create.mockResolvedValueOnce({ ...descriptor, docId: "stale" });
	api.create.mockImplementationOnce(() => pending.promise);
	api.source.mockRejectedValueOnce(sourceChanged());
	const loading = session.load();
	await new Promise((resolve) => setTimeout(resolve, 0));
	change("keep my draft");
	pending.resolve({ ...descriptor, docId: "retry" });
	await loading;
	expect(text()).toBe("keep my draft");
	expect(applyContent).toHaveBeenCalledTimes(1);
	expect(session.state.baseHash).toBe("original-hash");
	expect(sessionDirty(session.state)).toBe(true);
	expect(session.state.error).toContain("draft changed");
	expect(api.release.mock.calls).toEqual([
		["child", "stale"],
		["child", "retry"],
	]);
});

for (const superseded of [false, true])
	test(`late source change does not retry after ${superseded ? "a newer load" : "dispose"}`, async () => {
		const { session, api, applyContent } = await setup(false);
		const pending = deferred<string>();
		api.source.mockImplementationOnce(() => pending.promise);
		const loading = session.load();
		await new Promise((resolve) => setTimeout(resolve, 0));
		if (superseded) {
			api.create.mockResolvedValue({ ...descriptor, docId: "newer" });
			await session.load();
		} else session.dispose();
		pending.reject(sourceChanged());
		await loading;
		expect(api.create).toHaveBeenCalledTimes(superseded ? 2 : 1);
		expect(applyContent).toHaveBeenCalledTimes(superseded ? 1 : 0);
		expect(api.release).toHaveBeenCalledWith("child", "doc");
		if (superseded) {
			expect(session.state.error).toBeNull();
			expect(session.state.loaded).toBe(true);
		}
	});

test("dispose during retry authorization releases the late session without fetching content", async () => {
	const { session, api, applyContent } = await setup(false);
	const pending = deferred<EditorDocumentDescriptor>();
	api.create.mockResolvedValueOnce(descriptor).mockImplementationOnce(() => pending.promise);
	api.source.mockRejectedValueOnce(sourceChanged());
	const loading = session.load();
	await new Promise((resolve) => setTimeout(resolve, 0));
	session.dispose();
	pending.resolve({ ...descriptor, docId: "retry" });
	await loading;
	expect(api.source).toHaveBeenCalledTimes(1);
	expect(applyContent).not.toHaveBeenCalled();
	expect(api.release.mock.calls).toEqual([
		["child", "doc"],
		["child", "retry"],
	]);
});

test("ordinary changes only carry version metadata, never capture or encode text", async () => {
	const { session, change, snapshot, encode } = await setup();
	for (let i = 0; i < 100; i++) change(`draft ${i}`);
	expect(snapshot).not.toHaveBeenCalled();
	expect(encode).not.toHaveBeenCalled();
	expect(session.state).not.toHaveProperty("buffer");
	expect(session.state).not.toHaveProperty("content");
	change("a\nb\n", 1);
	expect(sessionDirty(session.state)).toBe(false);
});

test("save snapshots once, binds original hash/encoding, and guards simultaneous shortcuts", async () => {
	const { session, api, change, snapshot } = await setup();
	change("latest keystroke");
	await Promise.all([session.save(), session.save()]);
	expect(snapshot).toHaveBeenCalledTimes(1);
	expect(api.createUpload.mock.calls[0]).toEqual([
		"child",
		"doc",
		{ baseHash: "original-hash", encoding: "utf-16le", snapshotRevision: 2 },
		expect.any(AbortSignal),
	]);
	const args = api.upload.mock.calls[0] as unknown as [string, string, string, Blob];
	expect(await args[3].text()).toBe("latest keystroke");
	expect(sessionDirty(session.state)).toBe(false);
});

for (const undo of [false, true])
	test(`pending save preserves ${undo ? "undo to old baseline" : "new typing"} and dirty exit`, async () => {
		const { session, api, change, text } = await setup();
		const pending = deferred<EditorCommitResult>();
		api.commit.mockImplementation(() => pending.promise);
		change("sent");
		const saving = session.save();
		await new Promise((resolve) => setTimeout(resolve, 0));
		change(undo ? "a\nb\n" : "newer", undo ? 1 : undefined);
		expect(sessionExitBlocked(session.state)).toBe(true);
		pending.resolve({
			status: "saved",
			hash: "new-hash",
			operationId: "op",
			snapshotRevision: 2,
			bytes: 4,
		});
		await saving;
		expect(text()).toBe(undo ? "a\nb\n" : "newer");
		expect(sessionDirty(session.state)).toBe(true);
		change("sent", 2);
		expect(sessionDirty(session.state)).toBe(false);
	});

test("410 reauthorization preserves draft, undo versions, original hash and encoding", async () => {
	const { session, api, change, applyContent } = await setup();
	api.create.mockResolvedValue({
		...descriptor,
		docId: "recovered",
		baseHash: "disk-moved",
		encoding: "utf-8",
	});
	api.createUpload.mockRejectedValueOnce(
		new ApiError("Expired", 410, { code: "EDITOR_SESSION_EXPIRED" }),
	);
	change("draft");
	await session.save();
	expect(applyContent).toHaveBeenCalledTimes(1);
	expect(api.source).toHaveBeenCalledTimes(1);
	expect(api.createUpload.mock.calls[1]).toEqual([
		"child",
		"recovered",
		{ baseHash: "original-hash", encoding: "utf-16le", snapshotRevision: 2 },
		expect.any(AbortSignal),
	]);
});

test("denied reauthorization retains draft and old baseline but revokes saving", async () => {
	const { session, api, change, text } = await setup();
	api.createUpload.mockRejectedValueOnce(new ApiError("Expired", 410));
	api.create.mockRejectedValue(new ApiError("Forbidden", 403));
	change("draft");
	await session.save();
	expect(text()).toBe("draft");
	expect(session.state.baseHash).toBe("original-hash");
	expect(session.state.invalidated).toBe(true);
	expect(sessionCanSave(session.state)).toBe(false);
});

const confirmation = new ApiError("Confirm", 409, {
	code: "NEEDS_CONFIRMATION",
	physicalPath: "/outside/a.txt",
	confirmationToken: "token",
});
test("confirmation retries the same sealed upload and snapshot without re-encoding", async () => {
	const { session, api, change, encode } = await setup();
	change("draft");
	api.commit.mockRejectedValueOnce(confirmation);
	await session.save();
	expect(sessionCanSave(session.state)).toBe(false);
	await session.confirm();
	expect(api.createUpload).toHaveBeenCalledTimes(1);
	expect(encode).toHaveBeenCalledTimes(1);
	expect(api.commit.mock.calls[1]).toEqual([
		"child",
		"doc",
		"upload",
		{ confirmationToken: "token" },
		expect.any(AbortSignal),
	]);
	expect(sessionDirty(session.state)).toBe(false);
});

test("editing after confirmation invalidates its upload/token; old confirmation cannot overwrite new draft", async () => {
	const { session, api, change, text } = await setup();
	change("draft");
	api.commit.mockRejectedValueOnce(confirmation);
	await session.save();
	change("new draft");
	await session.confirm();
	expect(api.commit).toHaveBeenCalledTimes(1);
	expect(api.cancelUpload).toHaveBeenCalledTimes(1);
	expect(text()).toBe("new draft");
	expect(sessionCanSave(session.state)).toBe(true);
});

test("late confirmation after typing cannot authorize the stale snapshot", async () => {
	const { session, api, change } = await setup();
	const pending = deferred<EditorCommitResult>();
	api.commit.mockImplementation(() => pending.promise);
	change("sent");
	const saving = session.save();
	await new Promise((resolve) => setTimeout(resolve, 0));
	change("new");
	pending.reject(confirmation);
	await saving;
	expect(session.state.confirmation).toBeNull();
	expect(sessionCanSave(session.state)).toBe(true);
});

test("unknown commit queries upload then operation and blocks new save and reload", async () => {
	const { session, api, change, applyContent } = await setup();
	change("draft");
	api.commit.mockRejectedValue(new TypeError("Connection lost"));
	await session.save();
	expect(api.getUpload).toHaveBeenCalledTimes(1);
	expect(api.operation).toHaveBeenCalledWith("child", "op");
	expect(session.state.phase).toBe("unknown");
	await session.save();
	await session.load();
	expect(api.commit).toHaveBeenCalledTimes(1);
	expect(applyContent).toHaveBeenCalledTimes(1);
});

test("unknown receipt success advances only the sent snapshot baseline", async () => {
	const { session, api, change } = await setup();
	change("sent");
	api.commit.mockRejectedValue(new TypeError("Connection lost"));
	await session.save();
	change("newer");
	(api.operation as unknown as { mockResolvedValue(value: unknown): void }).mockResolvedValue({
		status: "saved",
		operationId: "op",
		result: { status: "saved", hash: "saved", operationId: "op", snapshotRevision: 2, bytes: 4 },
	});
	await session.reconcile();
	expect(session.state.baseHash).toBe("saved");
	expect(sessionDirty(session.state)).toBe(true);
});

test("expired upload plus unknown commit never reauthorizes or blindly resends", async () => {
	const { session, api, change } = await setup();
	change("draft");
	api.commit.mockRejectedValue(new ApiError("Expired", 410));
	api.getUpload.mockRejectedValue(new ApiError("Expired", 410));
	await session.save();
	await session.save();
	expect(api.create).toHaveBeenCalledTimes(1);
	expect(api.commit).toHaveBeenCalledTimes(1);
	expect(session.state.phase).toBe("unknown");
});

const stale = new ApiError("Stale", 409, {
	code: "STALE_WRITE",
	currentHash: "winning",
	conflictVersionHandle: "immutable-conflict",
	encoding: "utf-8",
	size: 6,
});
test("stale conflict never advances hash until explicit mine and fetches same immutable doc version", async () => {
	const { session, api, change, text } = await setup();
	change("mine");
	api.commit.mockRejectedValueOnce(stale);
	await session.save();
	expect(session.state.baseHash).toBe("original-hash");
	expect(sessionCanSave(session.state)).toBe(false);
	await session.conflictSource();
	expect(api.source.mock.calls.at(-1)).toEqual(["child", "doc", "immutable-conflict", undefined]);
	session.keepMine();
	expect(text()).toBe("mine");
	expect(session.state.baseHash).toBe("winning");
	expect(sessionCanSave(session.state)).toBe(true);
});

test("take theirs explicitly installs conflict snapshot and clean baseline", async () => {
	const { session, api, change, text } = await setup();
	change("mine");
	api.commit.mockRejectedValueOnce(stale);
	await session.save();
	api.source.mockResolvedValue("theirs");
	await session.takeTheirs();
	expect(text()).toBe("theirs");
	expect(session.state.baseHash).toBe("winning");
	expect(sessionDirty(session.state)).toBe(false);
});

test("failed reload and a delayed read both preserve draft and old baseline", async () => {
	const { session, api, change, text } = await setup();
	change("draft");
	api.source.mockRejectedValueOnce(new Error("offline"));
	await session.load();
	expect(text()).toBe("draft");
	const pending = deferred<string>();
	api.source.mockImplementation(() => pending.promise);
	const loading = session.load();
	change("newer");
	pending.resolve("disk");
	await loading;
	expect(text()).toBe("newer");
	expect(session.state.baseHash).toBe("original-hash");
	expect(sessionCanSave(session.state)).toBe(true);
});

test("cancelled encoder cannot create an upload or apply late results", async () => {
	const { session, api, change, encode } = await setup();
	const pending = deferred<Blob>();
	encode.mockImplementation(() => pending.promise);
	change("draft");
	const saving = session.save();
	session.cancel();
	pending.resolve(new Blob(["draft"]));
	await saving;
	expect(api.createUpload).not.toHaveBeenCalled();
	expect(sessionCanSave(session.state)).toBe(true);
});

test("dispose releases session and cancels pending work without discarding a dispatched write receipt", async () => {
	const { session, api, change } = await setup();
	const pending = deferred<EditorCommitResult>();
	api.commit.mockImplementation(() => pending.promise);
	change("draft");
	const saving = session.save();
	await new Promise((resolve) => setTimeout(resolve, 0));
	session.dispose();
	expect(api.release).toHaveBeenCalledWith("child", "doc");
	expect(api.cancelUpload).toHaveBeenCalledWith("child", "doc", "upload");
	pending.resolve({
		status: "saved",
		hash: "saved",
		operationId: "op",
		snapshotRevision: 2,
		bytes: 4,
	});
	await saving;
});

test("equivalent text with different history becomes clean only after background verification", async () => {
	const { session, change, hash } = await setup();
	change("a\nb\n");
	expect(sessionDirty(session.state)).toBe(true);
	await session.verifyEquivalent(new AbortController().signal);
	expect(hash).toHaveBeenCalledTimes(2);
	expect(sessionDirty(session.state)).toBe(false);
	change("other text");
	expect(sessionDirty(session.state)).toBe(true);
	change("a\nb\n", 1);
	expect(sessionDirty(session.state)).toBe(false);
});

test("hidden baseline hash cancellation retries its consumed immutable prefix without caching null", async () => {
	const { session, change, hash, snapshot, text } = await setup(false);
	let snapshots = 0;
	let baselineReads = 0;
	snapshot.mockImplementation(() => {
		const value = text();
		const baseline = ++snapshots === 1;
		let offset = 0;
		return {
			revision: session.state.version?.revision ?? 1,
			alternativeVersionId: session.state.version?.alternativeVersionId ?? 1,
			length: value.length,
			read: () => {
				if (baseline) baselineReads++;
				if (offset === value.length) return null;
				const chunk = value.slice(offset, offset + 2);
				offset += chunk.length;
				return chunk;
			},
		};
	});
	await session.load();
	change("c\nd\n");
	change("a\nb\n");
	const pending = deferred<string>();
	let hashSignal: AbortSignal | undefined;
	hash.mockImplementationOnce(async (source, signal) => {
		expect(source.read()).toBe("a\n");
		hashSignal = signal;
		signal?.addEventListener(
			"abort",
			() => pending.reject(new DOMException("hidden", "AbortError")),
			{ once: true },
		);
		return pending.promise;
	});
	const checking = session.verifyEquivalent(new AbortController().signal);
	expect(hash).toHaveBeenCalledTimes(1);
	session.cancelBackgroundVerification();
	expect(hashSignal?.aborted).toBe(true);
	await checking;
	expect(sessionDirty(session.state)).toBe(true);
	expect(sessionExitBlocked(session.state)).toBe(true);
	expect(hash).toHaveBeenCalledTimes(1);
	// An equal-length later draft must still compare against the ORIGINAL baseline.
	change("c\nd\n");
	await session.verifyEquivalent(new AbortController().signal);
	expect(hash).toHaveBeenCalledTimes(3);
	expect(sessionDirty(session.state)).toBe(true);
	change("a\nb\n");
	await session.verifyEquivalent(new AbortController().signal);
	expect(sessionDirty(session.state)).toBe(false);
	expect(sessionExitBlocked(session.state)).toBe(false);
	expect(baselineReads).toBe(3);
	session.dispose();
});

test("a cancelled uncooperative baseline hash cannot overwrite the newer replay result", async () => {
	const { session, change, hash } = await setup();
	const pending = deferred<string>();
	hash.mockImplementationOnce(async (source) => {
		source.read();
		return pending.promise;
	});
	change("a\nb\n");
	const oldCheck = session.verifyEquivalent(new AbortController().signal);
	session.cancelBackgroundVerification();
	await session.verifyEquivalent(new AbortController().signal);
	expect(sessionDirty(session.state)).toBe(false);
	change("c\nd\n");
	pending.resolve("c\nd\n");
	await oldCheck;
	await session.verifyEquivalent(new AbortController().signal);
	expect(sessionDirty(session.state)).toBe(true);
	change("a\nb\n");
	await session.verifyEquivalent(new AbortController().signal);
	expect(sessionDirty(session.state)).toBe(false);
	expect(hash).toHaveBeenCalledTimes(5);
	session.dispose();
});

test("hiding background verification cannot cancel an inflight save or clean its guarded snapshot early", async () => {
	const { session, change, api, hash } = await setup();
	change("a\nb\n");
	const upload = deferred<Awaited<ReturnType<typeof editorDocumentApi.createUpload>>>();
	api.createUpload.mockReturnValueOnce(upload.promise);
	const saving = session.save();
	await Promise.resolve();
	expect(session.state.phase).toBe("uploading");
	const signal = api.createUpload.mock.calls[0]?.[3];
	session.cancelBackgroundVerification();
	await session.verifyEquivalent(new AbortController().signal);
	expect(signal?.aborted).toBe(false);
	expect(hash).not.toHaveBeenCalled();
	expect(sessionExitBlocked(session.state)).toBe(true);
	upload.resolve({ uploadId: "upload", state: "uploading" });
	await saving;
	expect(api.commit).toHaveBeenCalledTimes(1);
	expect(sessionExitBlocked(session.state)).toBe(false);
	session.dispose();
});

test("unequal length skips background snapshot hashing entirely", async () => {
	const { session, change, hash, snapshot } = await setup();
	change("much longer text");
	await session.verifyEquivalent(new AbortController().signal);
	expect(hash).not.toHaveBeenCalled();
	expect(snapshot).not.toHaveBeenCalled();
});

test("saved baseline reuses encoded digest and comparison cannot clean a late edit", async () => {
	const { session, change, hash } = await setup();
	change("sent");
	await session.save();
	change("sent");
	const pending = deferred<string>();
	hash.mockImplementation(() => pending.promise);
	const checking = session.verifyEquivalent(new AbortController().signal);
	await Promise.resolve();
	change("late");
	pending.resolve("sent");
	await checking;
	expect(hash).toHaveBeenCalledTimes(1);
	expect(sessionDirty(session.state)).toBe(true);
});

test("cancelled equivalent-text verification cannot clear dirty", async () => {
	const { session, change } = await setup();
	change("a\nb\n");
	const controller = new AbortController();
	controller.abort();
	await session.verifyEquivalent(controller.signal);
	expect(sessionDirty(session.state)).toBe(true);
});

test("preallocated operation id recovers commit response loss without an upload lookup", async () => {
	const { session, api, change } = await setup();
	api.createUpload.mockResolvedValue({
		uploadId: "upload",
		state: "uploading",
		operationId: "preallocated",
	});
	api.commit.mockRejectedValue(new TypeError("Connection lost"));
	change("draft");
	await session.save();
	expect(api.getUpload).not.toHaveBeenCalled();
	expect(api.operation).toHaveBeenCalledWith("child", "preallocated");
	expect(session.state.phase).toBe("unknown");
});

async function setupLostCommit() {
	const context = await setup();
	const { api, change } = context;
	// The server allocates this ID at upload creation, before an operation exists.
	api.createUpload.mockResolvedValue({
		uploadId: "upload",
		state: "uploading",
		operationId: "preallocated",
	});
	api.upload.mockResolvedValue({
		uploadId: "upload",
		state: "sealed",
		operationId: "preallocated",
	});
	api.getUpload.mockResolvedValue({
		uploadId: "upload",
		state: "sealed",
		operationId: "preallocated",
	});
	api.operation.mockRejectedValue(
		new ApiError("No durable receipt is available; verify before retrying", 404, {
			code: "EDITOR_OPERATION_UNKNOWN",
		}),
	);
	api.commit.mockRejectedValueOnce(new TypeError("Commit request never arrived"));
	change("sent");
	return context;
}

for (const uploadState of ["sealed", "uploading"] as const)
	for (const action of ["save", "load"] as const)
		test(`lost commit with preallocated ID cancels ${uploadState} before allowing ${action}`, async () => {
			const { session, api, change, text, applyContent } = await setupLostCommit();
			api.getUpload.mockResolvedValue({
				uploadId: "upload",
				state: uploadState,
				operationId: "preallocated",
			});
			const cancellation = deferred<unknown>();
			api.cancelUpload.mockImplementationOnce(() => cancellation.promise);
			const saving = session.save();
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(api.operation).toHaveBeenCalledWith("child", "preallocated");
			expect(api.getUpload).toHaveBeenCalledWith("child", "doc", "upload");
			expect(api.cancelUpload).toHaveBeenCalledWith("child", "doc", "upload");
			expect(session.state.phase).toBe("unknown");
			change("newer");
			await session.save();
			await session.load();
			expect(api.commit).toHaveBeenCalledTimes(1);
			expect(applyContent).toHaveBeenCalledTimes(1);
			cancellation.resolve({ uploadId: "upload", state: "cancelled" });
			await saving;
			expect(session.state.phase).toBe("idle");
			expect(session.state.baseHash).toBe("original-hash");
			expect(session.state.baseline).toBe(1);
			expect(text()).toBe("newer");
			expect(sessionCanSave(session.state)).toBe(true);
			await session[action]();
			expect(sessionDirty(session.state)).toBe(false);
			expect(api.commit).toHaveBeenCalledTimes(action === "save" ? 2 : 1);
			expect(applyContent).toHaveBeenCalledTimes(action === "load" ? 2 : 1);
		});

for (const state of ["committing", "settled"] as const)
	for (const raced of [false, true])
		test(`unknown operation stays locked when ${raced ? "cancellation races into" : "upload is"} ${state}`, async () => {
			const { session, api, applyContent } = await setupLostCommit();
			if (raced) api.cancelUpload.mockResolvedValue({ uploadId: "upload", state });
			else
				api.getUpload.mockResolvedValue({
					uploadId: "upload",
					state,
					operationId: "preallocated",
				});
			await session.save();
			expect(api.cancelUpload).toHaveBeenCalledTimes(raced ? 1 : 0);
			expect(session.state.phase).toBe("unknown");
			expect(session.state.baseHash).toBe("original-hash");
			expect(sessionCanSave(session.state)).toBe(false);
			await session.save();
			await session.load();
			expect(api.commit).toHaveBeenCalledTimes(1);
			expect(applyContent).toHaveBeenCalledTimes(1);
		});

for (const state of ["cancelled", "expired"] as const)
	test(`unknown operation unlocks on verified ${state} upload metadata`, async () => {
		const { session, api } = await setupLostCommit();
		api.getUpload.mockResolvedValue({ uploadId: "upload", state, operationId: "preallocated" });
		await session.save();
		expect(sessionCanSave(session.state)).toBe(true);
		expect(session.state.baseHash).toBe("original-hash");
	});

for (const failure of [new ApiError("Expired", 410), new TypeError("Offline")])
	test(`unavailable upload metadata (${failure.message}) is not proof of cancellation`, async () => {
		const { session, api } = await setupLostCommit();
		api.getUpload.mockRejectedValue(failure);
		await session.save();
		expect(session.state.phase).toBe("unknown");
		expect(api.cancelUpload).not.toHaveBeenCalled();
	});

for (const failure of [new ApiError("Unavailable", 503), new TypeError("Offline")])
	test(`operation lookup failure (${failure.message}) does not trigger cancellation`, async () => {
		const { session, api } = await setupLostCommit();
		api.operation.mockRejectedValue(failure);
		await session.save();
		expect(session.state.phase).toBe("unknown");
		expect(api.getUpload).not.toHaveBeenCalled();
		expect(api.cancelUpload).not.toHaveBeenCalled();
	});

for (const failed of [false, true])
	test(`${failed ? "failed" : "empty"} cancellation response cannot unlock an unknown commit`, async () => {
		const { session, api } = await setupLostCommit();
		if (failed) api.cancelUpload.mockRejectedValue(new TypeError("Cancellation response lost"));
		else api.cancelUpload.mockResolvedValue(undefined);
		await session.save();
		expect(api.cancelUpload).toHaveBeenCalledTimes(1);
		expect(session.state.phase).toBe("unknown");
		expect(sessionCanSave(session.state)).toBe(false);
	});

for (const receiptRevision of [2, 99])
	test(`preallocated saved receipt preserves draft and validates revision ${receiptRevision}`, async () => {
		const { session, api, change, text } = await setupLostCommit();
		api.operation.mockResolvedValue({ status: "uncertain", operationId: "preallocated" });
		await session.save();
		change("newer");
		api.operation.mockResolvedValue({
			status: "saved",
			operationId: "preallocated",
			result: {
				status: "saved",
				operationId: "preallocated",
				snapshotRevision: receiptRevision,
				hash: "saved",
				bytes: 4,
			},
		});
		await session.reconcile();
		expect(api.getUpload).not.toHaveBeenCalled();
		expect(api.cancelUpload).not.toHaveBeenCalled();
		expect(text()).toBe("newer");
		expect(sessionDirty(session.state)).toBe(true);
		expect(session.state.phase).toBe(receiptRevision === 2 ? "idle" : "unknown");
		expect(session.state.baseHash).toBe(receiptRevision === 2 ? "saved" : "original-hash");
		expect(session.state.baseline).toBe(receiptRevision === 2 ? 2 : 1);
	});

test("strict effect cleanup and replay can authorize a new session", async () => {
	const { session, api } = await setup();
	session.dispose();
	session.activate();
	await session.load();
	expect(api.create).toHaveBeenCalledTimes(2);
	expect(session.state.loaded).toBe(true);
	expect(session.state.loading).toBe(false);
});

test("conflict prefix and full download use the same immutable version identity", async () => {
	const { session, api, change } = await setup();
	change("mine");
	api.commit.mockRejectedValueOnce(stale);
	await session.save();
	await session.conflictPreview();
	const blob = await session.conflictDownload();
	expect(api.sourcePreview).toHaveBeenCalledWith("child", "doc", "immutable-conflict", undefined);
	expect(api.sourceBlob).toHaveBeenCalledWith("child", "doc", "immutable-conflict", undefined);
	expect(await blob.text()).toBe("theirs");
	expect(session.state.baseHash).toBe("original-hash");
});

test("expired PUT retries only the uncommitted immutable blob with the old baseline", async () => {
	const { session, api, change, encode } = await setup();
	api.upload.mockRejectedValueOnce(new ApiError("Expired", 410));
	api.create.mockResolvedValue({ ...descriptor, docId: "new-session", baseHash: "new-disk" });
	change("draft");
	await session.save();
	expect(encode).toHaveBeenCalledTimes(1);
	expect(api.upload).toHaveBeenCalledTimes(2);
	expect(api.upload.mock.calls[0]?.[3]).toBe(api.upload.mock.calls[1]?.[3]);
	expect(api.createUpload.mock.calls[1]?.[2].baseHash).toBe("original-hash");
	expect(api.commit).toHaveBeenCalledTimes(1);
});

test("cancel during upload creation releases unseen upload resources and next save reauthorizes", async () => {
	const { session, api, change } = await setup();
	const pending = deferred<Awaited<ReturnType<typeof editorDocumentApi.createUpload>>>();
	api.createUpload.mockImplementationOnce(() => pending.promise);
	change("draft");
	const saving = session.save();
	await new Promise((resolve) => setTimeout(resolve, 0));
	session.cancel();
	expect(api.release).toHaveBeenCalledWith("child", "doc");
	pending.resolve({ uploadId: "late-upload", state: "uploading" });
	await saving;
	expect(api.upload).not.toHaveBeenCalled();
	await session.save();
	expect(api.create).toHaveBeenCalledTimes(2);
	expect(api.createUpload.mock.calls[1]?.[2].baseHash).toBe("original-hash");
	expect(sessionDirty(session.state)).toBe(false);
});

test("a pending explicit reload prevents confirmation from dispatching the older sealed upload", async () => {
	const { session, api, change, text } = await setup();
	change("draft");
	api.commit.mockRejectedValueOnce(confirmation);
	await session.save();
	const pending = deferred<string>();
	api.source.mockImplementation(() => pending.promise);
	const loading = session.load();
	await session.confirm();
	expect(api.commit).toHaveBeenCalledTimes(1);
	pending.resolve("reloaded");
	await loading;
	expect(text()).toBe("reloaded");
	expect(session.state.confirmation).toBeNull();
	expect(sessionDirty(session.state)).toBe(false);
});

test("one queued save intent during an in-flight commit serializes with the next captured snapshot", async () => {
	const { session, api, change, encode } = await setup();
	change("first draft");
	const firstCommit = deferred<EditorCommitResult>();
	api.commit.mockImplementationOnce(() => firstCommit.promise);
	const firstSave = session.save();
	for (let step = 0; step < 10 && !api.commit.mock.calls.length; step++) await Promise.resolve();
	expect(session.state.phase).toBe("committing");
	change("second draft");
	// Multiple extra save requests during the in-flight attempt collapse to one intent.
	void session.save();
	void session.save();
	void session.save();
	expect(api.commit).toHaveBeenCalledTimes(1);
	expect(encode).toHaveBeenCalledTimes(1);
	firstCommit.resolve({
		status: "saved",
		operationId: "op-a",
		hash: "hash-a",
		snapshotRevision: 2,
		bytes: 11,
	});
	await firstSave;
	// Settle must advance the baseline AND start exactly one more save with the latest text.
	await new Promise((resolve) => setTimeout(resolve, 10));
	expect(api.commit).toHaveBeenCalledTimes(2);
	expect(encode).toHaveBeenCalledTimes(2);
	// Second attempt binds against the hash of the first receipt, never the stale initial baseline.
	expect(api.createUpload.mock.calls[1]?.[2].baseHash).toBe("hash-a");
	// Second upload's Blob reflects the newest buffer, not the already-saved snapshot.
	const uploaded = (await api.upload.mock.calls[1]?.[3].text()) ?? "";
	expect(uploaded).toBe("second draft");
});

test("intents while committing do not accumulate: only the final visible edit is saved", async () => {
	const { session, api, change } = await setup();
	change("first");
	const firstCommit = deferred<EditorCommitResult>();
	api.commit.mockImplementationOnce(() => firstCommit.promise);
	const firstSave = session.save();
	for (let step = 0; step < 10 && !api.commit.mock.calls.length; step++) await Promise.resolve();
	change("final");
	void session.save();
	change("final-plus");
	void session.save();
	firstCommit.resolve({
		status: "saved",
		operationId: "op-a",
		hash: "hash-a",
		snapshotRevision: 2,
		bytes: 5,
	});
	await firstSave;
	await new Promise((resolve) => setTimeout(resolve, 10));
	expect(api.commit).toHaveBeenCalledTimes(2);
	// Only one additional attempt, which captured the newest buffer.
	expect(api.createUpload).toHaveBeenCalledTimes(2);
});

test("repeated saves on the same revision after settle do not create a redundant commit", async () => {
	const { session, api, change } = await setup();
	change("first");
	const firstCommit = deferred<EditorCommitResult>();
	api.commit.mockImplementationOnce(() => firstCommit.promise);
	const firstSave = session.save();
	for (let step = 0; step < 10 && !api.commit.mock.calls.length; step++) await Promise.resolve();
	// A duplicate request on the same (already in-flight) revision records one intent.
	void session.save();
	firstCommit.resolve({
		status: "saved",
		operationId: "op-a",
		hash: "hash-a",
		snapshotRevision: 2,
		bytes: 5,
	});
	await firstSave;
	// After the receipt, the buffer equals the saved baseline — no second attempt starts.
	await new Promise((resolve) => setTimeout(resolve, 10));
	expect(api.commit).toHaveBeenCalledTimes(1);
	expect(sessionDirty(session.state)).toBe(false);
});

test("a repeat at the in-flight revision never auto-saves text typed afterwards", async () => {
	const { session, api, change, encode } = await setup();
	change("first");
	const firstCommit = deferred<EditorCommitResult>();
	api.commit.mockImplementationOnce(() => firstCommit.promise);
	const firstSave = session.save();
	for (let step = 0; step < 10 && !api.commit.mock.calls.length; step++) await Promise.resolve();
	void session.save();
	void session.save();
	change("typed after the shortcut");
	firstCommit.resolve({
		status: "saved",
		operationId: "op-a",
		hash: "hash-a",
		snapshotRevision: 2,
		bytes: 5,
	});
	await firstSave;
	await new Promise((resolve) => setTimeout(resolve, 10));
	expect(encode).toHaveBeenCalledTimes(1);
	expect(api.commit).toHaveBeenCalledTimes(1);
	expect(sessionDirty(session.state)).toBe(true);
	expect(session.state.baseHash).toBe("hash-a");
});

test("cancelling an in-flight upload drops the queued intent", async () => {
	const { session, api, change } = await setup();
	change("first");
	const sealed = deferred<Awaited<ReturnType<typeof editorDocumentApi.upload>>>();
	api.upload.mockImplementationOnce(() => sealed.promise);
	const saving = session.save();
	for (let step = 0; step < 10 && !api.upload.mock.calls.length; step++) await Promise.resolve();
	change("second");
	void session.save();
	session.cancel();
	sealed.resolve({ uploadId: "upload", state: "sealed" });
	await saving;
	for (let step = 0; step < 20; step++) await Promise.resolve();
	expect(api.commit).not.toHaveBeenCalled();
	expect(api.createUpload).toHaveBeenCalledTimes(1);
});

test("confirmation path clears the queued intent and never dispatches another write", async () => {
	const { session, api, change } = await setup();
	change("first");
	api.commit.mockRejectedValueOnce(
		new ApiError("needs confirmation", 409, {
			code: "NEEDS_CONFIRMATION",
			confirmationToken: "tok",
			physicalPath: "/outside",
		}),
	);
	// Attempt once; while server is "deciding" the user mashes Ctrl+S again.
	await session.save();
	expect(session.state.confirmation?.code).toBe("NEEDS_CONFIRMATION");
	expect(session.state.phase).toBe("idle");
	// Any queued intent that pre-dated the confirmation must NOT trigger another save.
	await Promise.resolve();
	expect(api.commit).toHaveBeenCalledTimes(1);
	expect(api.createUpload).toHaveBeenCalledTimes(1);
});

test("stale-write conflict clears any queued intent and never auto-resaves", async () => {
	const { session, api, change } = await setup();
	change("first");
	api.commit.mockRejectedValueOnce(
		new ApiError("stale", 409, {
			code: "STALE_WRITE",
			currentHash: "new-hash",
			conflictVersionHandle: "conflict-v1",
			encoding: "utf-8",
			size: 10,
		}),
	);
	const slowCommit = api.commit.mock;
	void session.save();
	// Queue multiple extra intents while save is still forming its single attempt.
	void session.save();
	void session.save();
	for (let step = 0; step < 10 && !slowCommit.calls.length; step++) await Promise.resolve();
	for (let step = 0; step < 10 && session.state.conflict === null; step++) await Promise.resolve();
	expect(session.state.conflict?.code).toBe("STALE_WRITE");
	expect(api.commit).toHaveBeenCalledTimes(1);
});

test("500 error leaves the attempt in unknown and no queued save continues automatically", async () => {
	const { session, api, change } = await setup();
	change("first");
	api.commit.mockRejectedValueOnce(new ApiError("boom", 500));
	void session.save();
	// Request a second save while the error is in flight.
	void session.save();
	for (let step = 0; step < 20 && session.state.phase !== "unknown"; step++)
		await Promise.resolve();
	expect(session.state.phase).toBe("unknown");
	expect(api.commit).toHaveBeenCalledTimes(1);
});
