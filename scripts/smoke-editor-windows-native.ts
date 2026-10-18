import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionBackend } from "../server/lib/agent/execution/backend";
import { targetPathSemantics } from "../server/lib/agent/execution/path-semantics";
import type { FsStatResult } from "../server/lib/agent/execution/rpc-types";
import { createEditorFileAtomicIo } from "../server/services/editor-file-atomic-io";
import { EditorHelperSession, type EditorRpc } from "../server/services/editor-helper";
import {
	EditorRemoteOperationStore,
	editorReceiptStorageSupported,
} from "../server/services/editor-remote-operation-store";
import type {
	EditorFileApplyContext,
	LocalFileApplyInput,
} from "../server/services/file-change-local-io";
import type {
	EditorApplyResult,
	EditorQueryResult,
	EditorStageHandle,
} from "../shared/editor-provider-contracts";

// Explicit fixture only. The caller provides an isolated existing directory and the
// expected SHA of a controlled precompiled binary; production never uses this resolver.
assert(process.platform === "win32" || process.argv[5] === "--allow-posix-fixture");
const windows = process.platform === "win32";
const artifactRoot = process.argv[2],
	expectedSha = process.argv[3];
const root = process.argv[4] ?? artifactRoot;
assert(artifactRoot && root && /^[a-f0-9]{64}$/.test(expectedSha ?? ""));
const binary = join(artifactRoot, "editor-helper.exe"),
	binaryBytes = await readFile(binary);
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
assert.equal(hash(binaryBytes), expectedSha);
const resolveHelper = async () => ({
	path: binary,
	filename: "controlled-native-fixture",
	version: "0.9.2",
	size: binaryBytes.length,
	sha256: expectedSha,
});
const workspace = join(root, "workspace"),
	state = join(root, "engine"),
	receipts = join(root, "host-receipts");
await mkdir(workspace, { recursive: true });
const canonical = await realpath(workspace),
	target = join(canonical, "target.txt");
const epoch = "windows-native-editor-fixture";
const native = new EditorRemoteOperationStore(receipts, undefined, {
	root: canonical,
	stateDir: state,
	resolveHelper,
});
const backend = {
	kind: "local",
	deviceId: "local",
	pathFlavor: windows ? "windows" : "posix",
	paths: targetPathSemantics(windows ? "windows" : "posix"),
} as ExecutionBackend;
let fence = 0,
	dispatches = 0;
async function peer() {
	const p = await EditorHelperSession.open(resolveHelper, canonical, state, epoch, {
		hostReceiptsDir: receipts,
	});
	const caps = await p.capabilities();
	assert(caps.features.includes("editor.host-receipt.v1"));
	assert(editorReceiptStorageSupported("win32", true));
	return p;
}
async function input(
	next: Uint8Array,
	savedHash = hash(next),
	raw = true,
): Promise<LocalFileApplyInput> {
	const before = await readFile(target),
		info = await lstat(target),
		operationId = randomUUID();
	const editor: EditorFileApplyContext = {
		sourceId: operationId,
		userId: "native-windows-user",
		narratorId: "native-windows-narrator",
		operationId: `host-${operationId}`,
		effectId: `effect-${operationId}`,
		mutationId: `mutation-${operationId}`,
		leaseId: `lease-${operationId}`,
		preparedResult: { hash: savedHash, bytes: next.length },
		snapshotRevision: 7,
		...(raw ? { hashKind: "raw-sha256" as const } : {}),
		requestDigest: hash(operationId),
		executionBinding: {
			deviceId: "local",
			runtimeEpoch: epoch,
			runtimeGeneration: 0,
			fencingToken: ++fence,
		},
		scope: {
			id: "windows-scope",
			sourceInstanceId: "windows-source",
			deviceId: "local",
			workspaceInstanceId: "windows-workspace",
			canonicalRoot: canonical,
			pathFlavor: windows ? "windows" : "posix",
		},
		before: {
			kind: "regular",
			mode: info.mode & 0o7777,
			blob: { algorithm: "sha256", digest: hash(before), sizeBytes: before.length },
		},
		intended: {
			kind: "regular",
			mode: info.mode & 0o7777,
			blob: { algorithm: "sha256", digest: hash(next), sizeBytes: next.length },
		},
	};
	return {
		backend,
		lexicalPath: target,
		canonicalPath: target,
		before: { bytes: before, mode: info.mode & 0o7777, identity: null },
		nextBytes: next,
		signal: AbortSignal.timeout(30_000),
		editor,
		assertTarget: async () => {
			assert.equal(await realpath(workspace), canonical);
		},
		onDispatch: () => {
			dispatches++;
		},
	};
}
async function recover(value: LocalFileApplyInput) {
	assert(value.editor);
	const record = await native.get(value.editor.sourceId);
	assert(record);
	const p = await peer();
	try {
		const request = {
			namespace: record.namespace,
			resourceKey: record.resourceKey,
			operationId: record.operationId,
			requestDigest: record.requestDigest,
		};
		const result = await p.call<EditorQueryResult>("editor.query", request);
		assert.equal(result.outcome, "committed");
		assert(result.result);
		const positive = result.result;
		await p.withMetadata(() => native.markSettled(record.operationId, positive));
		await p.call("editor.query", { ...request, acknowledgeTerminal: true });
	} finally {
		await p.close();
	}
	const cold = new EditorRemoteOperationStore(receipts, undefined, {
		root: canonical,
		stateDir: join(root, "cold-engine"),
		resolveHelper,
	});
	const proof = await cold.get(record.operationId);
	assert.equal(proof?.receipt?.outcome, "committed");
	return proof;
}
const first = await peer();
await first.close();
await writeFile(target, "before");
const io = createEditorFileAtomicIo({
	resourceKey: "windows-resource",
	store: native,
	resolveHelper,
	stateDir: state,
});
const large = new Uint8Array(20 * 1024 * 1024).fill(65);
const largeInput = await input(large);
assert.equal((await io.apply(largeInput)).kind, "applied");
assert.equal(hash(await readFile(target)), hash(large));
await recover(largeInput);

// Distinct v1 text/raw hash domains, real native commit, and a deliberately lost reply.
const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("after\r\n", "utf16le")]);
const v1 = await input(utf16, hash("after\r\n"), false);
let applies = 0;
const lost = createEditorFileAtomicIo({
	resourceKey: "windows-resource",
	store: native,
	open: async (value): Promise<EditorRpc> => {
		assert(value.editor);
		const p = await EditorHelperSession.open(resolveHelper, canonical, state, epoch);
		await p.capabilities();
		return {
			withMetadata: (run) => p.withMetadata(run),
			call: async <T>(method: string, params: object, signal?: AbortSignal) => {
				const result = await p.call<T>(method, params, signal);
				if (method === "editor.apply") {
					applies++;
					throw new Error("fixture drops committed reply");
				}
				return result;
			},
			close: () => p.close(),
		};
	},
});
assert.equal((await lost.apply(v1)).kind, "target_mutation_unknown");
assert.equal(applies, 1);
const recovered = await recover(v1);
assert(recovered);
assert.notEqual(recovered.saved.hash, recovered.rawDigest);
assert.equal(recovered.saved.hash, hash("after\r\n"));
assert.deepEqual(await readFile(target), utf16);
const next = await input(new TextEncoder().encode("next"));
assert.equal((await io.apply(next)).kind, "applied");
await recover(next);
assert.equal((await readFile(target)).toString(), "next");

// Windows read-only metadata is refused before replacement, without a second target write.
if (windows) {
	await chmod(target, 0o444);
	const readonly = await input(new Uint8Array([65]));
	const previousDispatches = dispatches;
	const denied = await io.apply(readonly);
	assert.equal(denied.kind, "not_applied");
	assert.equal(dispatches, previousDispatches);
	assert.equal((await readFile(target)).toString(), "next");
	// Bypass the TS mode fence too: the native editor protocol must reject before replace.
	const p = await peer();
	try {
		const inode = (await lstat(target)).ino;
		const owner = { namespace: "direct-readonly-native", resourceKey: "direct-readonly-resource" };
		const body = new TextEncoder().encode("forbidden");
		const stage = await p.call<EditorStageHandle>("editor.stage.open", {
			...owner,
			maxBytes: 20 * 1024 * 1024,
			idleTimeoutMs: 10000,
		});
		await p.call("editor.stage.append", {
			...owner,
			stageId: stage.stageId,
			seq: 0,
			offset: 0,
			bytes: body.length,
			digest: hash(body),
			dataB64: Buffer.from(body).toString("base64"),
		});
		await p.call("editor.stage.seal", {
			...owner,
			stageId: stage.stageId,
			totalBytes: body.length,
			rawDigest: hash(body),
		});
		const identity = await p.call<FsStatResult>("fs.stat", {
			path: canonical,
			editorRoot: canonical,
			editorIdentity: true,
		});
		const operationId = randomUUID(),
			requestDigest = hash(operationId);
		const result = await p.call<EditorApplyResult>("editor.apply", {
			...owner,
			operationId,
			requestDigest,
			stageId: stage.stageId,
			expectedRawHash: hash("next"),
			metadataPolicy: "preserve",
			identity: {
				deviceId: "local",
				pathFlavor: "windows",
				canonicalPath: target,
				workspaceIdentity: identity.rootIdentity,
				runtimeEpoch: epoch,
				runtimeGeneration: 0,
				fencingToken: ++fence,
			},
		});
		assert.equal(result.outcome, "rejected");
		const proof = await p.call<EditorQueryResult>("editor.query", {
			...owner,
			operationId,
			requestDigest,
		});
		assert.equal(proof.outcome, "rejected");
		assert.equal((await lstat(target)).ino, inode);
		assert.equal((await readFile(target)).toString(), "next");
	} finally {
		await p.close();
	}
	await chmod(target, 0o666);
}

// A replaced/unprotected recovery root cannot be used as if its protected ACL survived.
const retired = `${receipts}-retired`;
await rename(receipts, retired);
await mkdir(receipts);
await assert.rejects(() => native.get(recovered.operationId));
await rm(receipts, { recursive: true, force: true });
await rename(retired, receipts);
console.log(
	JSON.stringify({
		gate: windows ? "EDITOR_WINDOWS_NATIVE" : "EDITOR_COMPILED_NATIVE",
		bytes: large.length,
		actualPlatform: process.platform,
		binarySha256: expectedSha,
		dispatches,
		lostReplyApplies: applies,
		coldProof: recovered.receipt?.outcome,
		v1SeparateHashDomains: recovered.saved.hash !== recovered.rawDigest,
		privateRootReplacementRejected: true,
		readonlyMetadataRejected: windows,
	}),
);
