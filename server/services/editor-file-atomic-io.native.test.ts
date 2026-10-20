import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { tagBlock } from "../../frontend/components/narrator/file-editor/editor-format-rope";
import { EditorSaveCodec } from "../../frontend/components/narrator/file-editor/editor-save-codec";
import type { EditorRawDocumentDescriptor } from "../../shared/editor-document";
import { testEnvironment } from "../../tests/preload";
import { db } from "../db";
import { fileChangeOperations, narrators, users } from "../db/schema";
import { resolveBackend } from "../lib/agent/execution/registry";
import { safeSpawn } from "../lib/spawn";
import { denyHostEditorHelpers, nativeEditorFixture } from "../routes/editor-native-fixture";
import { RemoteBackend } from "./device-remote-backend";
import {
	executeEditorDocumentFileChange,
	getEditorDocumentService,
	queryEditorOperation,
} from "./editor-document-runtime";
import {
	type EditorActor,
	type EditorBinding,
	type EditorDocumentService,
	editorResourceKey,
} from "./editor-document-service";
import { getDefaultLocalFileChangeRuntime } from "./file-change-runtime";
import { workspaceContextService } from "./workspace-context-service";
import { withProtectionReservation } from "./worktree-lifecycle-guard";

const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
let root: string, workspace: string, target: string;
let fixture: Awaited<ReturnType<typeof nativeEditorFixture>>;
let guard: ReturnType<typeof denyHostEditorHelpers>;
let service: EditorDocumentService, actor: EditorActor, backend: RemoteBackend;
let revoked = false;
let documents: string[] = [];
beforeEach(async () => {
	documents = [];
	root = await mkdtemp(join(testEnvironment.isolatedHome, "remote-atomic-"));
	workspace = join(root, "workspace");
	await mkdir(workspace);
	target = join(workspace, "file.txt");
	await writeFile(target, "before");
	guard = denyHostEditorHelpers();
	fixture = await nativeEditorFixture(root, workspace);
	await fixture.start();
	const resolved = resolveBackend({ requested: fixture.deviceId });
	if (!(resolved instanceof RemoteBackend)) throw new Error("Remote fixture unavailable");
	backend = resolved;
	const userId = randomUUID(),
		narratorId = randomUUID(),
		now = new Date().toISOString();
	db.insert(users)
		.values({ id: userId, username: userId, passwordHash: "fixture", role: "user", createdAt: now })
		.run();
	db.insert(narrators)
		.values({
			id: narratorId,
			cwd: workspace,
			defaultDeviceId: fixture.deviceId,
			ownerUserId: userId,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	revoked = false;
	actor = {
		userId,
		narratorId,
		authorizeOperation: async (device) => {
			if (revoked || device !== fixture.deviceId) throw new Error("revoked");
		},
		authorize: async (input) => {
			if (revoked) throw new Error("revoked");
			const identity = await backend.editorRootIdentity();
			const binding: EditorBinding = {
				cwd: identity.canonicalRoot,
				canonicalPath: target,
				lexicalPath: target,
				projectId: null,
				outsideRoots: false,
				deviceId: fixture.deviceId,
				workspaceRevision: 0,
				contextKey: "fixture",
				workspaceIdentity: identity.rootIdentity,
				pathFlavor: backend.pathFlavor,
				runtimeEpoch: identity.runtimeEpoch,
				runtimeGeneration: backend.runtimeGeneration,
				writeTarget: {
					backend,
					rootIdentity: identity.rootIdentity,
					runtime: {
						runtimeEpoch: identity.runtimeEpoch,
						runtimeGeneration: backend.runtimeGeneration,
					},
					currentRuntime: () =>
						backend.supportsEditorDurableWrite
							? {
									runtimeEpoch: identity.runtimeEpoch,
									runtimeGeneration: backend.runtimeGeneration,
								}
							: null,
					assertParent: async () => {},
				},
			};
			binding.rawSource = backend.editorRawSource(
				{
					deviceId: fixture.deviceId,
					pathFlavor: backend.pathFlavor,
					canonicalPath: target,
					workspaceIdentity: identity.rootIdentity,
					runtimeEpoch: identity.runtimeEpoch,
					runtimeGeneration: backend.runtimeGeneration,
					fencingToken: backend.runtimeGeneration,
				},
				editorResourceKey(actor, input, binding),
			);
			return binding;
		},
	};
	service = getEditorDocumentService();
});
afterEach(async () => {
	revoked = false;
	for (const docId of documents) await service.remove(actor, docId);
	await fixture?.dispose();
	expect(guard.starts).toBe(0);
	guard.restore();
	await rm(root, { recursive: true, force: true });
});
afterAll(async () => {
	await service?.dispose();
});
async function document() {
	const doc = await service.create(actor, {
		path: target,
		origin: "legacy",
		deviceId: fixture.deviceId,
		protocol: "raw-v2",
	});
	if (doc.protocol !== "raw-v2") throw new Error("Expected raw document");
	documents.push(doc.docId);
	return doc;
}
async function stage(
	doc: EditorRawDocumentDescriptor,
	text: string,
	tags = new Uint8Array(),
	revision = 7,
) {
	const codec = await EditorSaveCodec.create({
		encoding: doc.encoding,
		bom: doc.bom,
		root: tagBlock(tags),
	});
	const chunks: Uint8Array[] = [];
	if (!text.length) chunks.push(codec.push("", true));
	for (let offset = 0; offset < text.length; offset += 65536)
		chunks.push(codec.push(text.slice(offset, offset + 65536), offset + 65536 >= text.length));
	const bytes = Buffer.concat(chunks),
		seal = codec.finish();
	const upload = await service.createUpload(actor, doc.docId, {
		protocol: "raw-v2",
		hashKind: "raw-sha256",
		encoding: doc.encoding,
		bom: doc.bom,
		baseHash: doc.baseHash,
		snapshotRevision: revision,
	});
	for (let offset = 0, seq = 0; offset < bytes.length; offset += 65536, seq++) {
		const part = bytes.subarray(offset, offset + 65536);
		await service.putChunk(
			actor,
			doc.docId,
			upload.uploadId,
			{ seq, offset, bytes: part.length, digest: hash(part) },
			new Response(Uint8Array.from(part)).body,
		);
	}
	await service.sealRaw(actor, doc.docId, upload.uploadId, seal);
	return {
		upload,
		bytes,
		commit: async () => {
			const result = await service.commit(actor, doc.docId, upload.uploadId, {});
			if (result.status !== "saved") throw new Error("Fixture commit did not settle");
			return result;
		},
	};
}

test("real remote replacement preserves mode/ACL/xattr; ordinary Host tools retain inode", async () => {
	await chmod(target, 0o640);
	let acl: string | undefined;
	if (process.platform === "linux") {
		expect(
			(
				await safeSpawn({
					cmd: ["setfacl", "-m", "u:65534:r--", target],
					timeout: 5000,
					maxOutputBytes: 4096,
				})
			).exitCode,
		).toBe(0);
		acl = (
			await safeSpawn({
				cmd: ["getfacl", "--omit-header", target],
				timeout: 5000,
				maxOutputBytes: 4096,
			})
		).stdout;
		expect(
			(
				await safeSpawn({
					cmd: [
						"python3",
						"-c",
						"import os,sys;os.setxattr(sys.argv[1],'user.editor-fixture',b'preserved')",
						target,
					],
					timeout: 5000,
					maxOutputBytes: 4096,
				})
			).exitCode,
		).toBe(0);
	}
	const inode = (await lstat(target)).ino,
		doc = await document(),
		saved = await stage(doc, "after\n", Uint8Array.of(2));
	expect((await saved.commit()).status).toBe("saved");
	expect(await readFile(target, "utf8")).toBe("after\r\n");
	expect((await lstat(target)).ino).not.toBe(inode);
	expect((await lstat(target)).mode & 0o777).toBe(0o640);
	if (process.platform === "linux") {
		if (acl === undefined) throw new Error("Missing captured ACL");
		expect(
			(
				await safeSpawn({
					cmd: ["getfacl", "--omit-header", target],
					timeout: 5000,
					maxOutputBytes: 4096,
				})
			).stdout,
		).toBe(acl);
		expect(
			(
				await safeSpawn({
					cmd: [
						"python3",
						"-c",
						"import os,sys;assert os.getxattr(sys.argv[1],'user.editor-fixture')==b'preserved'",
						target,
					],
					timeout: 5000,
					maxOutputBytes: 4096,
				})
			).exitCode,
		).toBe(0);
	}
	expect(fixture.queries).toBe(0);
	expect(fixture.acks).toBe(1);
}, 30_000);

test("real remote 20 MiB and only one same-base save wins", async () => {
	const doc = await document(),
		large = await stage(doc, "A".repeat(20 * 1024 * 1024));
	expect((await large.commit()).bytes).toBe(20 * 1024 * 1024);
	expect(hash(await readFile(target))).toBe(hash(large.bytes));
	await writeFile(target, "same-base");
	const [a, b] = await Promise.all([document(), document()]);
	const [one, two] = await Promise.all([stage(a, "winner-one"), stage(b, "winner-two")]);
	const result = await Promise.allSettled([one.commit(), two.commit()]);
	expect(result.filter((value) => value.status === "fulfilled")).toHaveLength(1);
	expect(fixture.applies).toBe(2);
}, 30_000);

test("lost apply reply stays unknown until original executor proof; no second apply", async () => {
	const doc = await document(),
		saved = await stage(doc, "after");
	const reads = spyOn(backend, "editorObservation");
	fixture.dropSuccess();
	try {
		await expect(saved.commit()).rejects.toMatchObject({ code: "WRITE_RECONCILE_REQUIRED" });
		// Only the before observation: a commit receipt, not a 20 MiB re-read, is the proof.
		expect(reads).toHaveBeenCalledTimes(1);
	} finally {
		reads.mockRestore();
	}
	await fixture.reconnect();
	const reconnected = resolveBackend({ requested: fixture.deviceId });
	if (!(reconnected instanceof RemoteBackend)) throw new Error("Remote fixture unavailable");
	backend = reconnected;
	expect(await readFile(target, "utf8")).toBe("after");
	expect(fixture.applies).toBe(1);
	expect(fixture.acks).toBe(0);
	if (!saved.upload.operationId) throw new Error("Original operation missing");
	for (const outcome of ["not_found", "uncertain"] as const) {
		fixture.forceQueryOutcome(outcome);
		expect(await service.operation(actor, saved.upload.operationId)).toMatchObject({
			status: "uncertain",
		});
	}
	fixture.forceQueryOutcome();
	const runtime = await getDefaultLocalFileChangeRuntime(),
		source = await runtime.verifyNamespace();
	const operation = await runtime.evidence.getEditorOperation(
		source.sourceInstanceId,
		saved.upload.operationId,
	);
	if (!operation) throw new Error("Missing original operation");
	for (const patch of [
		{ workspaceLeaseId: randomUUID() },
		{ requestDigest: hash("wrong") },
		{ editorRawSnapshotRevision: null },
	]) {
		db.update(fileChangeOperations)
			.set(patch)
			.where(eq(fileChangeOperations.id, operation.id))
			.run();
		expect(await service.operation(actor, saved.upload.operationId)).toMatchObject({
			status: "uncertain",
		});
		db.update(fileChangeOperations)
			.set({
				workspaceLeaseId: operation.workspaceLeaseId,
				requestDigest: operation.requestDigest,
				editorRawSnapshotRevision: operation.editorRawSnapshotRevision,
			})
			.where(eq(fileChangeOperations.id, operation.id))
			.run();
	}
	await expect(
		queryEditorOperation({ ...actor, userId: "wrong-owner" }, saved.upload.operationId),
	).rejects.toMatchObject({ code: "EDITOR_OPERATION_UNKNOWN" });
	expect(await service.operation(actor, saved.upload.operationId)).toMatchObject({
		status: "saved",
		result: { snapshotRevision: 7 },
	});
	expect(fixture.applies).toBe(1);
	const next = await stage(await document(), "next");
	expect((await next.commit()).status).toBe("saved");
	expect(fixture.applies).toBe(2);
});

test("UTF16 BOM/mixed EOL saves exact raw bytes, with immutable SQLite snapshot revision", async () => {
	await writeFile(
		target,
		Buffer.concat([Buffer.from([255, 254]), Buffer.from("before\r\nsecond\rthird\n", "utf16le")]),
	);
	const doc = await document(),
		saved = await stage(
			doc,
			"after\nsecond\nthird\n",
			Uint8Array.of(2, 3, 1),
			Number.MAX_SAFE_INTEGER,
		);
	const result = await saved.commit();
	expect(await readFile(target)).toEqual(saved.bytes);
	expect(result.hash).toBe(hash(saved.bytes));
	expect(result.hash).not.toBe(hash("after\r\nsecond\rthird\n"));
	const purgeRoot = join(testEnvironment.narraforkHome, "editor-transfers");
	await rm(join(purgeRoot, `ed-${result.operationId}.json`));
	expect(await service.operation(actor, result.operationId)).toMatchObject({
		status: "saved",
		result: {
			hashKind: "raw-sha256",
			hash: hash(saved.bytes),
			snapshotRevision: Number.MAX_SAFE_INTEGER,
		},
	});
	revoked = true;
	await expect(service.operation(actor, result.operationId)).rejects.toThrow("revoked");
});

test("readonly and pre-dispatch cancellation never reach executor apply", async () => {
	const doc = await document(),
		saved = await stage(doc, "forbidden");
	await chmod(target, 0o444);
	try {
		await expect(saved.commit()).rejects.toThrow();
		expect(fixture.applies).toBe(0);
		expect(await readFile(target, "utf8")).toBe("before");
	} finally {
		await chmod(target, 0o666);
	}
	const binding = await actor.authorize(
		{ path: target, deviceId: fixture.deviceId, origin: "legacy", protocol: "raw-v2" },
		"write",
	);
	await expect(
		executeEditorDocumentFileChange({
			requestId: randomUUID(),
			resourceKey: "cancelled",
			workspaceRevision: 0,
			remote: binding.writeTarget,
			cwd: workspace,
			canonicalPath: target,
			lexicalPath: target,
			userId: actor.userId,
			narratorId: actor.narratorId,
			signal: AbortSignal.abort(),
			input: { hashKind: "raw-sha256", snapshotRevision: 1 },
			authorize: async () => {},
			construct: () => {
				throw new Error("must not construct");
			},
		}),
	).rejects.toThrow();
	expect(fixture.applies).toBe(0);
});

test("expected absence cannot replace a concurrently created target", async () => {
	await rm(target);
	const binding = await actor.authorize(
		{ path: target, deviceId: fixture.deviceId, origin: "legacy", protocol: "raw-v2" },
		"write",
	);
	await expect(
		executeEditorDocumentFileChange({
			requestId: randomUUID(),
			resourceKey: "expected-absence",
			workspaceRevision: 0,
			remote: binding.writeTarget,
			cwd: workspace,
			lexicalPath: target,
			canonicalPath: target,
			userId: actor.userId,
			narratorId: actor.narratorId,
			signal: new AbortController().signal,
			input: { hashKind: "raw-sha256", snapshotRevision: 1 },
			authorize: async () => {},
			construct: async (before) => {
				expect(before.bytes).toBeNull();
				await writeFile(target, "racer");
				return {
					nextBytes: Buffer.from("forbidden"),
					result: { hash: hash("forbidden"), bytes: 9 },
					lineStats: null,
				};
			},
		}),
	).rejects.toThrow();
	expect(await readFile(target, "utf8")).toBe("racer");
});

test("cancellation after sealed stage but before apply has positive no-dispatch proof", async () => {
	const binding = await actor.authorize(
		{ path: target, deviceId: fixture.deviceId, origin: "legacy", protocol: "raw-v2" },
		"write",
	);
	const controller = new AbortController(),
		original = backend.editorWriteRpc.bind(backend);
	const fault = spyOn(backend, "editorWriteRpc").mockImplementation(() => {
		const rpc = original();
		return {
			...rpc,
			call: async <T>(method: string, params: object, signal?: AbortSignal) => {
				const value = await rpc.call<T>(method, params, signal);
				if (method === "editor.stage.seal") controller.abort();
				return value;
			},
		};
	});
	try {
		await expect(
			executeEditorDocumentFileChange({
				requestId: randomUUID(),
				resourceKey: "cancel-before-apply",
				workspaceRevision: 0,
				remote: binding.writeTarget,
				cwd: workspace,
				lexicalPath: target,
				canonicalPath: target,
				userId: actor.userId,
				narratorId: actor.narratorId,
				signal: controller.signal,
				input: { hashKind: "raw-sha256", snapshotRevision: 1 },
				authorize: async () => {},
				construct: () => ({
					nextBytes: Buffer.from("forbidden"),
					result: { hash: hash("forbidden"), bytes: 9 },
					lineStats: null,
				}),
			}),
		).rejects.toThrow();
	} finally {
		fault.mockRestore();
	}
	expect(fixture.applies).toBe(0);
	expect(fixture.acks).toBe(0);
	expect(await readFile(target, "utf8")).toBe("before");
});

test("production Host wrapper retains workspace revision and retirement admission through settlement", async () => {
	let entered!: () => void, release!: () => void;
	const ready = new Promise<void>((resolve) => {
			entered = resolve;
		}),
		held = new Promise<void>((resolve) => {
			release = resolve;
		});
	const saving = executeEditorDocumentFileChange({
		requestId: randomUUID(),
		resourceKey: "host-admission",
		workspaceRevision: 0,
		cwd: workspace,
		canonicalPath: target,
		lexicalPath: target,
		userId: actor.userId,
		narratorId: actor.narratorId,
		signal: new AbortController().signal,
		input: {},
		authorize: async () => {},
		construct: async () => {
			entered();
			await held;
			return {
				nextBytes: Buffer.from("host-saved"),
				result: { hash: hash("host-saved"), bytes: 10 },
				lineStats: null,
			};
		},
	});
	try {
		await ready;
		await expect(
			workspaceContextService.switch(
				actor.narratorId,
				{ expectedRevision: 0, requestId: "switch", target: { deviceId: "local", cwd: root } },
				{ origin: "http", userId: actor.userId },
			),
		).rejects.toMatchObject({ code: "WORKSPACE_CONTEXT_BUSY" });
		await expect(
			withProtectionReservation(
				[{ deviceId: "local", path: workspace }],
				"fixture retirement",
				async () => {},
			),
		).rejects.toThrow();
		expect(await readFile(target, "utf8")).toBe("before");
	} finally {
		release();
		await saving;
	}
	expect(await readFile(target, "utf8")).toBe("host-saved");
	const runtime = await getDefaultLocalFileChangeRuntime();
	expect(runtime).toBeDefined();
});
