import { expect, mock, test } from "bun:test";
import type { EditorRawDocumentDescriptor, EditorSaveResult } from "@shared/editor-document";
import { EditorStreamCodec } from "@shared/editor-stream-codec";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { ApiError } from "../../../lib/api/client";
import { editorDocumentApi } from "../../../lib/api/editor-documents";
import { EditorAttemptSpool } from "./editor-attempt-spool";
import { spliceEols, tagBlock } from "./editor-format-rope";
import type { EditorRawSnapshot } from "./editor-save-client";
import { EditorSaveCodec } from "./editor-save-codec";
import { EditorDocumentSession, sessionDirty } from "./editor-session-state";

globalThis.IDBKeyRange = IDBKeyRange;
const deferred = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
};
function setup(factory: IDBFactory | null = new IDBFactory()) {
	const decoder = new EditorStreamCodec("utf-8");
	decoder.push(new TextEncoder().encode("a\r\nb\nc\n"), true);
	const doc: EditorRawDocumentDescriptor = {
		...decoder.finish(),
		docId: "raw-doc",
		resourceKey: "key",
		versionHandle: "raw-version",
		target: { deviceId: "local", path: "/file" },
		capabilities: {
			boundedRead: true,
			v1Save: false,
			rawRead: true,
			stage: true,
			durableApply: true,
			durableQuery: true,
			watch: false,
		},
	};
	let text = "a\nb\nc\n",
		revision = 1,
		lifetime = "A",
		root = tagBlock(Uint8Array.of(2, 1, 1)),
		upload = 0;
	const sent: { id: string; text: string; spool: EditorAttemptSpool }[] = [];
	const version = () => ({
		revision,
		alternativeVersionId: revision,
		length: text.length,
		modelLifetime: lifetime,
	});
	const snapshot = mock((): EditorRawSnapshot => {
		const captured = text;
		let read = false;
		return {
			...version(),
			rawFormat: { root, encoding: "utf-8", bom: "none" },
			modelLifetime: lifetime,
			read: () => {
				if (read) return null;
				read = true;
				return captured;
			},
		};
	});
	const encodeRaw = mock(async (snapshot: import("./editor-worker-client").EditorTextSnapshot) => {
		const value = snapshot as EditorRawSnapshot,
			codec = await EditorSaveCodec.create(value.rawFormat),
			spool = await EditorAttemptSpool.create(value.revision, value.modelLifetime, factory);
		for (;;) {
			const chunk = value.read();
			await spool.append(codec.push(chunk ?? "", chunk === null));
			if (chunk === null) break;
		}
		return spool.finish(codec.finish());
	});
	const api = {
		...editorDocumentApi,
		create: mock(async () => doc),
		release: mock(async () => undefined),
		createUpload: mock(async (..._args: Parameters<typeof editorDocumentApi.createUpload>) => ({
			uploadId: `upload-${++upload}`,
			operationId: `op-${upload}`,
			state: "uploading" as const,
		})),
		uploadRaw: mock(async (_n, _d, id, spool) => {
			const parts: Uint8Array[] = [];
			for await (const chunk of spool.chunks()) parts.push(chunk.data);
			sent.push({
				id,
				spool: spool as EditorAttemptSpool,
				text: Buffer.concat(parts).toString("utf8"),
			});
			return {
				uploadId: id,
				state: "sealed" as const,
				operationId: `op-${upload}`,
				bytes: spool.seal?.bytes,
				digest: spool.seal?.rawDigest,
			};
		}),
		commit: mock(async (_n, _d, id): Promise<EditorSaveResult> => {
			const current = sent.find((value) => value.id === id);
			if (!current?.spool.seal) throw new Error("No seal");
			return {
				status: "saved",
				hashKind: "raw-sha256",
				operationId: `op-${id}`,
				hash: current.spool.seal.rawDigest,
				bytes: current.spool.seal.bytes,
				snapshotRevision: current.spool.revision,
			};
		}),
		cancelUpload: mock(async (_n, _d, uploadId) => ({ uploadId, state: "cancelled" as const })),
		operation: mock(async (_n, operationId) => ({ operationId, status: "uncertain" as const })),
		getUpload: mock(async (_n, _d, uploadId) => ({ uploadId, state: "committing" as const })),
	} satisfies typeof editorDocumentApi;
	let prepare = async () => ({ install: () => version(), dispose() {} });
	const session = new EditorDocumentSession({
		narratorId: "n",
		path: "/file",
		deviceId: "local",
		protocol: "raw-v2",
		origin: () => "legacy",
		resourceKey: "key",
		snapshot,
		encode: async () => {
			throw new Error("v1 encoder forbidden");
		},
		encodeRaw,
		rawReady: () => ({ formatReady: true, codecSafe: true }),
		loadRaw: () => prepare(),
		applyContent: () => {
			throw new Error("v1 install forbidden");
		},
		onChange() {},
		api,
	});
	return {
		session,
		api,
		doc,
		sent,
		snapshot,
		encodeRaw,
		edit(next: string, nextRoot = root) {
			text = next;
			root = nextRoot;
			revision++;
			session.change(version());
		},
		otherLifetime() {
			lifetime = "B";
			session.change(version());
		},
		prepare(next: typeof prepare) {
			prepare = next;
		},
		get root() {
			return root;
		},
	};
}
test("raw save captures format and bytes once across confirmation while typing remains dirty", async () => {
	const value = setup();
	await value.session.load();
	value.edit("A\nb\nc\n");
	const original = value.api.commit.getMockImplementation();
	value.api.commit.mockImplementationOnce(async () => {
		throw new ApiError("confirm", 409, {
			code: "NEEDS_CONFIRMATION",
			confirmationToken: "token",
			physicalPath: "/file",
		});
	});
	await value.session.save();
	expect(value.session.state.confirmation).not.toBeNull();
	expect(value.encodeRaw).toHaveBeenCalledTimes(1);
	value.api.commit.mockImplementation(original as NonNullable<typeof original>);
	await value.session.confirm();
	expect(value.sent.map((s) => s.text)).toEqual(["A\r\nb\nc\n"]);
	expect(value.encodeRaw).toHaveBeenCalledTimes(1);
	expect(sessionDirty(value.session.state)).toBe(false);
	value.session.dispose();
});
test("410 pre-dispatch retry reuses identical attempt spool and original raw baseline", async () => {
	const value = setup();
	await value.session.load();
	value.edit("A\nb\nc\n");
	const initialBase = value.doc.baseHash;
	value.api.createUpload.mockImplementationOnce(async () => {
		value.edit("B\nb\nc\n");
		value.doc.baseHash = "f".repeat(64);
		throw new ApiError("expired", 410);
	});
	await value.session.save();
	expect(value.encodeRaw).toHaveBeenCalledTimes(1);
	expect(value.sent[0]?.text).toBe("A\r\nb\nc\n");
	expect(value.api.createUpload.mock.calls.map((call) => call[2].baseHash)).toEqual([
		initialBase,
		initialBase,
	]);
	expect(sessionDirty(value.session.state)).toBe(true);
	value.session.dispose();
});
for (const field of ["hashKind", "hash", "bytes"] as const)
	test(`raw receipt mismatch (${field}) stays unknown and never cleans or reapplies`, async () => {
		const value = setup();
		await value.session.load();
		value.edit("A\nb\nc\n");
		const commit = value.api.commit.getMockImplementation();
		if (!commit) throw new Error("No fixture commit");
		value.api.commit.mockImplementation(async (...args) => {
			const result = await commit(...args);
			return {
				...result,
				[field]:
					field === "bytes" ? result.bytes + 1 : field === "hashKind" ? undefined : "f".repeat(64),
			} as EditorSaveResult;
		});
		await value.session.save();
		expect(value.session.state.phase).toBe("unknown");
		expect(sessionDirty(value.session.state)).toBe(true);
		await value.session.save();
		expect(value.api.commit).toHaveBeenCalledTimes(1);
		value.session.dispose();
	});
test("raw unknown is query-only: no extra encoding, create, upload or apply", async () => {
	const value = setup();
	await value.session.load();
	value.edit("A\nb\nc\n");
	value.api.commit.mockImplementation(async () => {
		throw new ApiError("lost", 503);
	});
	await value.session.save();
	expect(value.session.state.phase).toBe("unknown");
	await value.session.save();
	await value.session.reconcile();
	expect(value.api.commit).toHaveBeenCalledTimes(1);
	expect(value.api.createUpload).toHaveBeenCalledTimes(1);
	expect(value.encodeRaw).toHaveBeenCalledTimes(1);
	expect(value.api.operation.mock.calls.length).toBeGreaterThan(0);
	value.session.dispose();
	for (const sent of value.sent) await sent.spool.dispose();
});
test("RAM fallback warns about crash backup without disabling subsequent ordinary saves", async () => {
	const value = setup(null);
	await value.session.load();
	value.edit("A\nb\nc\n");
	await value.session.save();
	expect(value.session.state.phase).toBe("idle");
	expect(value.session.state.backupIncomplete).toBe(true);
	expect(sessionDirty(value.session.state)).toBe(false);
	value.edit("B\nb\nc\n");
	await value.session.save();
	expect(value.api.commit).toHaveBeenCalledTimes(2);
	expect(sessionDirty(value.session.state)).toBe(false);
	value.session.dispose();
});
test("disposing an unknown raw session releases the realm RAM slot without reapplying", async () => {
	const value = setup(null);
	await value.session.load();
	value.edit("A\nb\nc\n");
	value.api.commit.mockImplementation(async () => {
		throw new ApiError("lost", 503);
	});
	await value.session.save();
	expect(value.session.state.phase).toBe("unknown");
	expect(value.sent[0]?.spool.storage).toBe("memory");
	value.session.dispose();
	const next = await EditorAttemptSpool.create(9, "new-model", null);
	expect(next.storage).toBe("memory");
	expect(value.api.commit).toHaveBeenCalledTimes(1);
	await next.dispose();
});
test("raw conflict Reload never installs the normalized v1 preview as a formatted model", async () => {
	const value = setup();
	await value.session.load();
	value.edit("A\nb\nc\n");
	value.api.commit.mockImplementation(async () => {
		throw new ApiError("stale", 409, {
			code: "STALE_WRITE",
			currentHash: "a".repeat(64),
			conflictVersionHandle: "conflict",
			encoding: "utf-8",
			size: 9,
		});
	});
	await value.session.save();
	expect(value.session.state.conflict).not.toBeNull();
	await value.session.takeTheirs();
	expect(value.session.state.conflict).toBeNull();
	expect(value.session.state.loading).toBe(false);
	value.session.dispose();
});
test("same normalized text with changed EOL root stays dirty under idle equality", async () => {
	const value = setup();
	await value.session.load();
	const root = spliceEols(value.root, 0, 1, 1, 1);
	value.edit("a\nb\nc\n", root);
	await value.session.verifyEquivalent(new AbortController().signal);
	expect(sessionDirty(value.session.state)).toBe(true);
	await value.session.save();
	expect(value.sent[0]?.text).toBe("a\nb\nc\n");
	value.session.dispose();
});
test("same numeric revision after a model lifetime change cannot become clean or accept an old load", async () => {
	const value = setup();
	await value.session.load();
	const captured = deferred(),
		entered = deferred();
	let disposed = 0;
	value.prepare(async () => {
		entered.resolve();
		await captured.promise;
		return {
			install: () => ({ revision: 1, alternativeVersionId: 1, length: 6, modelLifetime: "C" }),
			dispose() {
				disposed++;
			},
		};
	});
	const loading = value.session.load(true);
	await entered.promise;
	value.otherLifetime();
	expect(sessionDirty(value.session.state)).toBe(true);
	captured.resolve();
	expect(await loading).toBe(false);
	expect(value.session.state.version?.modelLifetime).toBe("B");
	expect(disposed).toBe(1);
	value.session.dispose();
});
