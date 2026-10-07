import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FILE_CHANGE_LIMITS, type FileChangeIdentity } from "@shared/file-change-protocol";
import type {
	RemoteHistoryBackend,
	RemoteHistoryBinding,
	RemoteHistoryObject,
	RemoteHistoryReceipt,
	RemoteHistoryState,
} from "@shared/remote-history-protocol";
import { testEnvironment } from "../../tests/preload";
import { posixPathSemantics } from "../lib/agent/execution/path-semantics";
import type { EditorActor, EditorBinding } from "./editor-document-service";
import { EditorDocumentError } from "./editor-document-service";
import {
	type EditorFileChangeRequest,
	EditorFileChangeUncertainError,
} from "./file-change-runtime";
import { createRemoteEditorAdapter } from "./remote-editor-adapter";
import { RemoteFileChangeRuntime } from "./remote-file-change-runtime";
import { RemoteHistoryService, remoteHistoryObjectId } from "./remote-history-service";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const remoteBinding: RemoteHistoryBinding = {
	sourceInstanceId: "remote-source",
	workspaceInstanceId: "remote-workspace",
	scopeId: "scope",
	root: "/selected",
	rootIdentity: "remote-inode",
	fence: 3,
};
const binding: EditorBinding = {
	deviceId: "executor",
	cwd: "/selected",
	projectId: "project",
	lexicalPath: "/selected/file.txt",
	canonicalPath: "/selected/file.txt",
	outsideRoots: false,
	workspaceRevision: 6,
	contextKey: "context-six",
	runtimeGeneration: 2,
	canonicalIdentity: "/selected/file.txt",
	rootIdentity: "remote-inode",
	editable: true,
};
const identity: FileChangeIdentity = {
	sourceInstanceId: remoteBinding.sourceInstanceId,
	workspaceInstanceId: remoteBinding.workspaceInstanceId,
	scopeId: remoteBinding.scopeId,
	deviceId: "executor",
	pathFlavor: "posix",
	objectRole: "referent",
	canonicalPath: binding.canonicalPath,
	lexicalPath: binding.lexicalPath,
	displayPath: "file.txt",
};
let root: string;
let bytes: Uint8Array;
let state: RemoteHistoryState;
let trace: string[];
let chunks: number[];
let lostResponse: boolean;
let externalChange: boolean;
let receipt: RemoteHistoryReceipt | undefined;
const actor: EditorActor = {
	userId: "human-user",
	narratorId: "narrator",
	authorize: async () => ({ ...binding }),
};
function object(value: Uint8Array): RemoteHistoryObject {
	const hash = digest(value);
	return {
		...remoteBinding,
		kind: "blob",
		path: "file.txt",
		algorithm: "sha256",
		digest: hash,
		objectId: remoteHistoryObjectId(remoteBinding.scopeId, "blob", hash, "file.txt"),
		sizeBytes: value.byteLength,
	};
}
function runtime() {
	const backend = {
		supportsRemoteHistory: true,
		async remoteHistory(kind: string, input: Record<string, unknown>) {
			trace.push(kind);
			if (kind === "inspect")
				return { binding: remoteBinding, observations: [{ path: "file.txt", state }], pending: [] };
			if (kind === "objectRead") {
				const offset = input.offset as number,
					max = input.maxBytes as number;
				chunks.push(max);
				return {
					object: input.object,
					offset,
					contentBase64: Buffer.from(bytes.subarray(offset, offset + max)).toString("base64"),
					eof: offset + max >= bytes.length,
				};
			}
			if (kind === "mutate") {
				const changes = input.changes as {
					expected: RemoteHistoryState;
					desired: RemoteHistoryState;
					contentBase64: string;
				}[];
				if (externalChange) throw new Error("current state conflicts; no write");
				expect(changes[0].expected).toEqual(state);
				const before = state;
				bytes = Buffer.from(changes[0].contentBase64, "base64");
				state = changes[0].desired;
				receipt = {
					binding: remoteBinding,
					operationId: input.operationId as string,
					requestDigest: input.requestDigest as string,
					payloadDigest: "0".repeat(64),
					kind: "mutate",
					state: "settled",
					startedAt: new Date().toISOString(),
					effects: [
						{ path: "file.txt", before, intended: state, after: state, outcome: "applied" },
					],
				};
				if (lostResponse) throw new Error("response lost after actual remote write");
				return receipt;
			}
			if (kind === "finalize") {
				if (!receipt) throw new Error("No actual receipt");
				receipt = {
					...receipt,
					state: "finalized",
					serverCommitId: input.serverCommitId as string,
				};
				return receipt;
			}
			throw new Error(`Unexpected RPC ${kind}`);
		},
	} as RemoteHistoryBackend;
	const history = new RemoteHistoryService(backend, remoteBinding, {
		async putIntent() {
			trace.push("durable-intent");
		},
		async putReceipt() {
			trace.push("durable-receipt");
		},
		async markUnknown() {
			trace.push("unknown");
		},
		async putObject() {
			trace.push("source-qualified-object");
		},
	});
	return new RemoteFileChangeRuntime(history, {
		deviceId: "executor",
		pathFlavor: "posix",
		paths: posixPathSemantics,
	});
}
function request(): EditorFileChangeRequest<{ hash: string; bytes: number }> {
	return {
		requestId: "editor-request",
		userId: actor.userId,
		narratorId: actor.narratorId,
		projectId: "project",
		cwd: binding.cwd,
		lexicalPath: binding.lexicalPath,
		canonicalPath: binding.canonicalPath,
		signal: AbortSignal.timeout(10_000),
		input: { snapshotRevision: 5 },
		async authorize() {
			trace.push("human-live-authorization");
		},
		async construct(before) {
			expect(before.bytes).toEqual(bytes);
			return {
				nextBytes: new TextEncoder().encode("human edit"),
				result: { hash: "normalized-hash", bytes: 10 },
				lineStats: null,
			};
		},
	};
}
function adapter(options: { cap?: number; commitFailure?: boolean } = {}) {
	const io = runtime();
	return createRemoteEditorAdapter({
		async resolve() {
			return {
				runtime: io,
				identity,
				maxWriteBytes: options.cap ?? FILE_CHANGE_LIMITS.blobBytes,
				async commit(actual, _req, result) {
					trace.push("commit-real-human-evidence");
					if (!receipt) throw new Error("Real receipt missing");
					expect(actual).toEqual(receipt);
					if (options.commitFailure) throw new Error("evidence transaction unavailable");
					return {
						serverCommitId: "durable-human-operation",
						completion: {
							result,
							linesAdded: null,
							linesRemoved: null,
							fileChangeEvidence: {
								version: 2 as const,
								operationId: "durable-human-operation",
								effectId: "actual-effect",
								grade: "measured" as const,
								settlement: "settled" as const,
								outcome: "changed" as const,
							},
						},
					};
				},
			};
		},
		queryOperation: mock(async () => ({
			status: "uncertain" as const,
			operationId: "editor-request",
		})),
	});
}
beforeEach(async () => {
	root = await mkdtemp(join(testEnvironment.isolatedHome, "remote-editor-adapter-"));
	bytes = new TextEncoder().encode("remote before");
	state = { kind: "regular", object: object(bytes), mode: 0o755 };
	trace = [];
	chunks = [];
	lostResponse = false;
	externalChange = false;
	receipt = undefined;
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

test("source reads immutable remote object in bounded chunks, never a host path", async () => {
	bytes = new Uint8Array(FILE_CHANGE_LIMITS.streamChunkBytes + 17).fill(65);
	state = { kind: "regular", object: object(bytes), mode: 0o644 };
	const path = join(root, "transfer");
	await adapter().source(actor, binding, path, AbortSignal.timeout(10_000));
	expect(await readFile(path)).toEqual(Buffer.from(bytes));
	expect(chunks.length).toBe(2);
	expect(Math.max(...chunks)).toBe(FILE_CHANGE_LIMITS.streamChunkBytes);
	expect(trace).not.toContain("mutate");
});
test("save journals intent, preserves mode, commits real human effects then finalizes receipt", async () => {
	const result = await adapter().execute(actor, binding, request());
	expect(new TextDecoder().decode(bytes)).toBe("human edit");
	expect(state.kind === "regular" && state.mode).toBe(0o755);
	expect(trace.indexOf("durable-intent")).toBeLessThan(trace.indexOf("mutate"));
	expect(trace.indexOf("commit-real-human-evidence")).toBeLessThan(trace.indexOf("finalize"));
	expect(receipt?.state).toBe("finalized");
	expect(result.fileChangeEvidence.effectId).toBe("actual-effect");
});
test("lost mutation response keeps durable unknown and original operation; never blindly retries", async () => {
	lostResponse = true;
	const a = adapter();
	await expect(a.execute(actor, binding, request())).rejects.toBeInstanceOf(
		EditorFileChangeUncertainError,
	);
	expect(new TextDecoder().decode(bytes)).toBe("human edit");
	expect(trace.filter((value) => value === "mutate")).toHaveLength(1);
	expect(trace).toContain("unknown");
	expect(trace).not.toContain("finalize");
	expect((await a.queryOperation(actor, "editor-request"))?.status).toBe("uncertain");
});
test("commit failure does not pretend durable remote write was failed/no-write", async () => {
	await expect(
		adapter({ commitFailure: true }).execute(actor, binding, request()),
	).rejects.toBeInstanceOf(EditorFileChangeUncertainError);
	expect(receipt?.state).toBe("settled");
	expect(trace).not.toContain("finalize");
});
test("unavailable chunk save capability refuses before remote intent or write", async () => {
	await expect(adapter({ cap: 4 }).execute(actor, binding, request())).rejects.toBeInstanceOf(
		EditorDocumentError,
	);
	expect(trace).not.toContain("durable-intent");
	expect(trace).not.toContain("mutate");
});
test("canonical root replacement cannot read or save using a same-named endpoint", async () => {
	const path = join(root, "host-lure");
	await writeFile(path, "host must not change");
	await expect(
		adapter().source(
			actor,
			{ ...binding, rootIdentity: "replaced-root" },
			path,
			AbortSignal.timeout(10_000),
		),
	).rejects.toThrow("endpoint changed");
	expect(await readFile(path, "utf8")).toBe("host must not change");
	expect(trace).toHaveLength(0);
});
test("external state conflict does not overwrite or automatically redispatch", async () => {
	externalChange = true;
	await expect(adapter().execute(actor, binding, request())).rejects.toBeInstanceOf(
		EditorFileChangeUncertainError,
	);
	expect(new TextDecoder().decode(bytes)).toBe("remote before");
	expect(trace.filter((value) => value === "mutate")).toHaveLength(1);
});
