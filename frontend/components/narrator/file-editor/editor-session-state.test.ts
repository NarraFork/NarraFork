import { expect, mock, test } from "bun:test";
import type { EditorCommitResult, EditorDocumentDescriptor } from "@shared/editor-document";
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
async function setup() {
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
		release: mock(async () => ({})),
	};
	const hashes = new WeakMap<Blob, string>();
	const textOf = (snapshot: EditorTextSnapshot) => {
		const chunks: string[] = [];
		for (let chunk = snapshot.read(); chunk !== null; chunk = snapshot.read()) chunks.push(chunk);
		return chunks.join("");
	};
	const hash = mock(async (snapshot: EditorTextSnapshot) => textOf(snapshot));
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
	await session.load();
	snapshot.mockClear();
	const change = (next: string, alt?: number) => {
		text = next;
		revision++;
		alternativeVersionId = alt ?? revision;
		session.change({ revision, alternativeVersionId, length: text.length });
	};
	return { session, api, encode, hash, applyContent, snapshot, change, text: () => text };
}

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

test("failed reauthorization retains saveable draft and old baseline", async () => {
	const { session, api, change, text } = await setup();
	api.createUpload.mockRejectedValueOnce(new ApiError("Expired", 410));
	api.create.mockRejectedValue(new ApiError("Forbidden", 403));
	change("draft");
	await session.save();
	expect(text()).toBe("draft");
	expect(session.state.baseHash).toBe("original-hash");
	expect(sessionCanSave(session.state)).toBe(true);
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
