import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_CHANGE_LIMITS } from "@shared/file-change-protocol";
import type {
	RemoteHistoryBinding,
	RemoteHistoryObject,
	RemoteHistoryOperations,
	RemoteHistoryReceipt,
	RemoteHistoryState,
} from "@shared/remote-history-protocol";
import { SESSION_VERSION_CLAIM } from "@shared/session-auth";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Hono } from "hono";
import { sqlite as isolatedTemplate } from "../db";
import * as relations from "../db/relations";
import * as schema from "../db/schema";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import { localBackend } from "../lib/agent/execution/local-backend";
import { targetPathSemantics } from "../lib/agent/execution/path-semantics";
import { editTool } from "../lib/agent/tools/edit";
import { structSedTool } from "../lib/agent/tools/struct-sed/tool";
import { writeTool } from "../lib/agent/tools/write";
import type { ToolContext } from "../lib/agent/types";
import type { AuthPrincipal } from "../middleware/auth";
import {
	remoteEditorSessionProvenance,
	remoteRecoveryProvenance,
} from "../middleware/remote-recovery-provenance";
import { EditorDocumentJobs } from "./editor-document-jobs";
import { LocalFileChangeRuntime } from "./file-change-runtime";
import { createRemoteEditorAdapter } from "./remote-editor-adapter";
import {
	reconcileRemoteFileOperation,
	reconcileRemoteRevertPlan,
} from "./remote-history-control-recovery";
import { SQLiteRemoteHistoryMetadataStore } from "./remote-history-journal";
import { remoteHistoryObjectId } from "./remote-history-service";
import {
	createRecordQualifiedRevertAccess,
	RemoteRevertTransactionProvider,
} from "./remote-revert-transaction";
import {
	createProductionRemoteEditorAdapter,
	RemoteWorkspaceHistoryRuntime,
	resolveProductionRemoteEditorRoot,
	withRemoteWorkspaceHistoryRuntime,
} from "./remote-workspace-history-runtime";
import { RevertHistoryCommitService } from "./revert-history-commit";
import { type RevertPlannerAccess, RevertPlannerService } from "./revert-planner-service";
import { RevertTransactionService } from "./revert-transaction-service";
import * as windowsEditorPreflight from "./windows-editor-metadata-preflight";
import { createWorkspaceWriteCoordinatorState } from "./workspace-write-coordinator";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();
let directory: string;
let sqlite: Database;
let registry: RemoteWorkspaceHistoryRuntime;
let native: ReturnType<typeof remoteFixture>;
let authorized: boolean;
let checks: number;
let db: ReturnType<typeof database>;
function database(client: Database) {
	return drizzle({ client, schema: { ...schema, ...relations } });
}

/** Fake RPC transport with a durable remote journal distinct from server audit storage. */
function remoteFixture() {
	const files = new Map<string, Uint8Array>([["a.txt", Buffer.from("old\n")]]);
	const incarnations = new Map<string, string>([["a.txt", "inode:1"]]);
	let nextIncarnation = 2;
	const objects = new Map<string, Uint8Array>();
	const scopes = new Map<string, RemoteHistoryBinding>();
	const receipts = new Map<string, RemoteHistoryReceipt>();
	const stages = new Map<
		string,
		{ status: RemoteHistoryOperations["objectStage"]["result"]; chunks: Uint8Array[] }
	>();
	let supportsStage = false;
	const calls: string[] = [];
	let generation = 7;
	let source = "physical-device-source";
	let loseMutationReply = false;
	let loseFinalizeReply = false;
	let refuseBeforeDispatch = false;
	let loseRefusalReply = false;
	let plainWrites = 0;
	function state(binding: RemoteHistoryBinding, path: string): RemoteHistoryState {
		const bytes = files.get(path);
		if (!bytes) return { kind: "absent" };
		const digest = hash(bytes);
		const object: RemoteHistoryObject = {
			algorithm: "sha256",
			kind: "blob",
			path,
			digest,
			sizeBytes: bytes.byteLength,
			objectId: remoteHistoryObjectId(binding.scopeId, "blob", digest, path),
			sourceInstanceId: source,
			workspaceInstanceId: binding.workspaceInstanceId,
			scopeId: binding.scopeId,
		};
		objects.set(object.objectId, bytes);
		const metadataBytes = Buffer.from(
			JSON.stringify({ version: 1, owner: "alice", acl: "owner-rw", mode: 0o600 }),
		);
		const metadataDigest = hash(metadataBytes);
		const metadata: RemoteHistoryObject = {
			...object,
			digest: metadataDigest,
			sizeBytes: metadataBytes.byteLength,
			objectId: remoteHistoryObjectId(binding.scopeId, "blob", metadataDigest, path),
		};
		objects.set(metadata.objectId, metadataBytes);
		return {
			kind: "regular",
			object,
			mode: 0o600,
			metadata,
			incarnation: incarnations.get(path) ?? "inode:initial",
		};
	}
	const backend = Object.assign(Object.create(localBackend) as ExecutionBackend, {
		kind: "remote",
		deviceId: "remote-device",
		pathFlavor: "posix",
		supportsRemoteHistory: true,
		remoteHistoryChunkBytes: 128 * 1024,
		get supportsRemoteObjectStage() {
			return supportsStage;
		},
		get runtimeGeneration() {
			return generation;
		},
		async resolvePathIdentity(path: string) {
			return { lexicalPath: path, canonicalPath: path, runtimeGeneration: generation };
		},
		async statFile(path: string) {
			const bytes = files.get(backend.paths.basename(path));
			return bytes
				? {
						isFile: true,
						isDirectory: false,
						isSymlink: false,
						size: bytes.byteLength,
						mode: 0o600,
					}
				: null;
		},
		async readFileBytes(path: string) {
			const bytes = files.get(backend.paths.basename(path));
			if (!bytes) throw new Error("Fake remote file not found");
			return {
				bytes: new Uint8Array(bytes),
				totalSize: bytes.byteLength,
				truncated: false,
				resolvedPath: path,
			};
		},
		async writeFileBytes() {
			plainWrites++;
			throw new Error("Plain remote writes forbidden in this fixture");
		},
		async remoteHistory<K extends keyof RemoteHistoryOperations>(
			kind: K,
			request: RemoteHistoryOperations[K]["request"],
			_signal?: AbortSignal,
		): Promise<RemoteHistoryOperations[K]["result"]> {
			calls.push(kind);
			if (kind === "open") {
				const input = request as RemoteHistoryOperations["open"]["request"];
				const binding: RemoteHistoryBinding = {
					root: input.root,
					scopeId: input.scopeId,
					fence: input.fence,
					sourceInstanceId: source,
					workspaceInstanceId: `physical-workspace:${input.root}`,
					rootIdentity: "physical-root",
				};
				const old = scopes.get(input.scopeId);
				if (old && old.sourceInstanceId !== source) throw new Error("Device source changed");
				if (
					old &&
					input.fence > old.fence &&
					[...receipts.values()].some(
						(receipt) =>
							receipt.binding.scopeId === input.scopeId &&
							receipt.kind !== "capture" &&
							!["finalized", "compensated", "rejected"].includes(receipt.state),
					)
				)
					throw new Error("Pending native intent blocks fence advance");
				scopes.set(input.scopeId, binding);
				return binding as RemoteHistoryOperations[K]["result"];
			}
			const input = request as RemoteHistoryOperations["mutate"]["request"];
			const binding = input.binding;
			if (scopes.get(binding.scopeId)?.fence !== binding.fence)
				throw new Error("Remote stale fence");
			if (kind === "objectStage") {
				if (!supportsStage) throw new Error("Stage feature not negotiated");
				const stage = request as RemoteHistoryOperations["objectStage"]["request"];
				let entry = stages.get(stage.stageId);
				if (!entry && stage.operation === "begin") {
					entry = {
						status: {
							stageId: stage.stageId,
							binding,
							requestDigest: stage.requestDigest,
							object: stage.object,
							written: 0,
							state: "pending",
						},
						chunks: [],
					};
					stages.set(stage.stageId, entry);
				}
				if (
					!entry ||
					entry.status.requestDigest !== stage.requestDigest ||
					entry.status.object.objectId !== stage.object.objectId
				)
					throw new Error("Stage identity conflict");
				if (stage.operation === "append") {
					const bytes = Buffer.from(stage.contentBase64 ?? "", "base64");
					if (
						stage.offset !== entry.status.written ||
						hash(bytes) !== stage.chunkDigest ||
						bytes.byteLength > 128 * 1024 ||
						entry.status.written + bytes.byteLength > stage.object.sizeBytes
					)
						throw new Error("Stage offset/digest/byte budget mismatch");
					entry.chunks.push(bytes);
					entry.status.written += bytes.byteLength;
				}
				if (stage.operation === "finish") {
					const bytes = Buffer.concat(entry.chunks);
					if (bytes.byteLength !== stage.object.sizeBytes || hash(bytes) !== stage.object.digest)
						throw new Error("Stage complete raw integrity mismatch");
					objects.set(stage.object.objectId, bytes);
					entry.status.state = "ready";
				}
				return structuredClone(entry.status) as RemoteHistoryOperations[K]["result"];
			}
			if (kind === "inspect")
				return {
					binding,
					observations: (request as RemoteHistoryOperations["inspect"]["request"]).paths.map(
						(path) => ({ path, state: state(binding, path) }),
					),
					pending: [],
				} as RemoteHistoryOperations[K]["result"];
			if (kind === "objectRead") {
				const read = request as RemoteHistoryOperations["objectRead"]["request"];
				const bytes = objects.get(read.object.objectId);
				if (!bytes) throw new Error("Remote object absent");
				const end = Math.min(bytes.byteLength, read.offset + read.maxBytes);
				return {
					object: read.object,
					contentBase64: Buffer.from(bytes.subarray(read.offset, end)).toString("base64"),
					offset: read.offset,
					eof: end === bytes.byteLength,
				} as RemoteHistoryOperations[K]["result"];
			}
			if (kind === "status") {
				const receipt = receipts.get(input.operationId);
				if (!receipt) throw new Error("Operation unknown");
				return structuredClone(receipt) as RemoteHistoryOperations[K]["result"];
			}
			if (kind === "finalize") {
				const finalize = request as RemoteHistoryOperations["finalize"]["request"];
				const receipt = receipts.get(finalize.operationId);
				if (!receipt || receipt.requestDigest !== finalize.requestDigest)
					throw new Error("Finalize digest mismatch");
				for (const effect of receipt.effects) {
					const current = state(binding, effect.path);
					if (
						!effect.after ||
						current.kind !== effect.after.kind ||
						(current.kind === "regular" &&
							effect.after.kind === "regular" &&
							(current.object.objectId !== effect.after.object.objectId ||
								current.metadata?.objectId !== effect.after.metadata?.objectId ||
								current.incarnation !== effect.after.incarnation))
					)
						throw new Error("Finalize after state conflict");
				}
				receipt.state = "finalized";
				receipt.serverCommitId = finalize.serverCommitId;
				if (loseFinalizeReply) throw new Error("Connection lost after finalize");
				return structuredClone(receipt) as RemoteHistoryOperations[K]["result"];
			}
			if (kind !== "mutate" && kind !== "restore" && kind !== "compensate")
				throw new Error(`Unexpected RPC ${kind}`);
			const previous = receipts.get(input.operationId);
			if (previous) {
				if (previous.requestDigest !== input.requestDigest) throw new Error("Digest conflict");
				return structuredClone(previous) as RemoteHistoryOperations[K]["result"];
			}
			if (
				[...receipts.values()].some(
					(receipt) =>
						receipt.binding.scopeId === binding.scopeId &&
						receipt.kind !== "capture" &&
						receipt.operationId !== input.operationId &&
						receipt.operationId !== input.originalOperationId &&
						!["finalized", "compensated", "rejected"].includes(receipt.state),
				)
			)
				throw new Error("Pending native scope intent blocks a second operation");
			if (refuseBeforeDispatch && kind !== "compensate") {
				// Deliberately simulated transport proof; actual cross-volume IO is tested in Go.
				const rejected: RemoteHistoryReceipt = {
					binding,
					operationId: input.operationId,
					requestDigest: input.requestDigest,
					payloadDigest: hash(JSON.stringify(input)),
					kind,
					state: "rejected",
					reason: "unsupported_cross_filesystem",
					effects: (input.changes ?? []).map((change) => ({
						path: change.path,
						before: change.expected,
						intended: change.desired,
						outcome: "pending",
					})),
					startedAt: now(),
					finishedAt: now(),
				};
				receipts.set(input.operationId, structuredClone(rejected));
				if (loseRefusalReply)
					throw new Error("Reply lost after durable rejection, without target IO");
				return rejected as RemoteHistoryOperations[K]["result"];
			}
			let changes = input.changes ?? [];
			if (kind === "compensate") {
				const original = receipts.get(input.originalOperationId ?? "");
				if (!original || original.state === "finalized")
					throw new Error("No conditional compensation proof");
				changes = original.effects.map((effect) => ({
					path: effect.path,
					expected: effect.after as RemoteHistoryState,
					desired: effect.before,
				}));
			}
			const effects = changes.map((change) => {
				const before = state(binding, change.path);
				if (
					before.kind !== change.expected.kind ||
					(before.kind === "regular" &&
						change.expected.kind === "regular" &&
						(before.object.objectId !== change.expected.object.objectId ||
							before.mode !== change.expected.mode ||
							before.metadata?.objectId !== change.expected.metadata?.objectId ||
							(change.expected.incarnation !== undefined &&
								before.incarnation !== change.expected.incarnation)))
				)
					throw new Error("Conditional remote state conflict");
				if (change.desired.kind === "absent") files.delete(change.path);
				else {
					const bytes =
						change.contentBase64 !== undefined
							? Buffer.from(change.contentBase64, "base64")
							: objects.get(change.desired.object.objectId);
					if (!bytes) throw new Error("No verified desired bytes");
					files.set(change.path, bytes);
					incarnations.set(change.path, `inode:${nextIncarnation++}`);
				}
				return {
					path: change.path,
					before,
					intended: change.desired,
					after: state(binding, change.path),
					outcome: "applied" as const,
				};
			});
			const receipt: RemoteHistoryReceipt = {
				binding,
				operationId: input.operationId,
				requestDigest: input.requestDigest,
				payloadDigest: hash(JSON.stringify(input)),
				kind,
				state: kind === "compensate" ? "compensated" : "settled",
				effects,
				startedAt: now(),
				finishedAt: now(),
			};
			receipts.set(input.operationId, structuredClone(receipt));
			if (loseMutationReply) throw new Error("Connection lost after actual remote write");
			return receipt as RemoteHistoryOperations[K]["result"];
		},
	});
	Object.defineProperty(backend, "runtimeGeneration", { get: () => generation });
	Object.defineProperty(backend, "supportsRemoteObjectStage", { get: () => supportsStage });
	return {
		backend,
		files,
		objects,
		scopes,
		receipts,
		stages,
		calls,
		enableStage() {
			supportsStage = true;
		},
		setPathFlavor(flavor: "posix" | "windows") {
			Object.defineProperty(backend, "pathFlavor", { value: flavor, configurable: true });
			Object.defineProperty(backend, "paths", {
				value: targetPathSemantics(flavor),
				configurable: true,
			});
		},
		setGeneration(value: number) {
			generation = value;
		},
		replaceSource() {
			source = "replaced-source";
		},
		loseMutationReply() {
			loseMutationReply = true;
		},
		refuseBeforeDispatch(value = true) {
			refuseBeforeDispatch = value;
		},
		loseRefusalReply(value = true) {
			loseRefusalReply = value;
		},
		clearTransportFault() {
			loseMutationReply = false;
			loseFinalizeReply = false;
		},
		replaceIncarnation(path = "a.txt") {
			incarnations.set(path, `inode:${nextIncarnation++}`);
		},
		loseFinalizeReply() {
			loseFinalizeReply = true;
		},
		get plainWrites() {
			return plainWrites;
		},
	};
}

beforeEach(async () => {
	directory = await mkdtemp(join(await realpath(tmpdir()), "remote-production-control-"));
	await mkdir(join(directory, "private"));
	sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;");
	const definitions = isolatedTemplate
		.query<{ sql: string }, []>(
			"SELECT sql FROM sqlite_master WHERE type IN ('table','index') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '*_fts*' ORDER BY type DESC LIMIT 2048",
		)
		.all();
	for (const row of definitions) sqlite.exec(row.sql);
	// Test-only additive metadata tables; schema migration publication belongs to the main task.
	sqlite.exec(
		`CREATE TABLE IF NOT EXISTS remote_history_receipts (id TEXT PRIMARY KEY, source_instance_id TEXT NOT NULL, scope_id TEXT NOT NULL, device_id TEXT NOT NULL, workspace_instance_id TEXT NOT NULL, root_identity TEXT NOT NULL, operation_id TEXT NOT NULL, request_digest TEXT NOT NULL, intent_digest TEXT, intent_json TEXT, fencing_token INTEGER NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, receipt_json TEXT, server_commit_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(source_instance_id,scope_id,operation_id)); CREATE TABLE IF NOT EXISTS remote_history_objects (id TEXT PRIMARY KEY, source_instance_id TEXT NOT NULL, scope_id TEXT NOT NULL, device_id TEXT NOT NULL, workspace_instance_id TEXT NOT NULL, root_identity TEXT NOT NULL, object_id TEXT NOT NULL, kind TEXT NOT NULL, origin_path TEXT NOT NULL, algorithm TEXT NOT NULL, digest TEXT NOT NULL, size_bytes INTEGER NOT NULL, placement TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(source_instance_id,scope_id,object_id,kind));`,
	);
	db = database(sqlite);
	db.insert(schema.users)
		.values({
			id: "alice",
			username: "alice",
			passwordHash: "test-not-a-credential",
			createdAt: now(),
		})
		.run();
	db.insert(schema.narrators)
		.values({
			id: "narrator",
			ownerUserId: "alice",
			cwd: "/remote/repo",
			createdAt: now(),
			updatedAt: now(),
		})
		.run();
	native = remoteFixture();
	authorized = true;
	checks = 0;
	const auditRuntime = new LocalFileChangeRuntime({
		db,
		privateRoot: join(directory, "private"),
		blobStoreOptions: { minimumFreeBytes: 0 },
		coordinatorState: createWorkspaceWriteCoordinatorState(),
	});
	registry = new RemoteWorkspaceHistoryRuntime({
		db,
		auditRuntime,
		backend: () => native.backend,
		metadataStore: new SQLiteRemoteHistoryMetadataStore(db),
		coordinatorState: createWorkspaceWriteCoordinatorState(),
		async authorize(actor, target, _need, signal) {
			signal.throwIfAborted();
			checks++;
			if (
				!authorized ||
				actor.userId !== "alice" ||
				actor.narratorId !== "narrator" ||
				target.deviceId !== "remote-device"
			)
				throw new Error("Live authority revoked");
		},
	});
});
afterEach(async () => {
	sqlite.close();
	await rm(directory, { recursive: true, force: true });
});

async function context(
	toolName: "Write" | "Edit" | "StructSed",
	filePath = "/remote/repo/a.txt",
	cwd = "/remote/repo",
): Promise<ToolContext> {
	const id = crypto.randomUUID();
	const messageId = crypto.randomUUID();
	db.insert(schema.narratorMessages)
		.values({
			id: messageId,
			narratorId: "narrator",
			role: "assistant",
			contentJson: [{ type: "tool_use", id, name: toolName, input: {} }],
			createdAt: now(),
		})
		.run();
	db.insert(schema.narratorMessageRefs)
		.values({
			id: crypto.randomUUID(),
			narratorId: "narrator",
			messageId,
			seq:
				db
					.select({ id: schema.narratorMessageRefs.id })
					.from(schema.narratorMessageRefs)
					.limit(100)
					.all().length + 1,
		})
		.run();
	db.insert(schema.narratorToolCalls)
		.values({
			id,
			messageId,
			narratorId: "narrator",
			toolUseId: id,
			toolName,
			status: "running",
			executionIdentityVersion: 1,
			executionAttempt: 1,
			executionStartedAt: now(),
			executionDeviceId: "remote-device",
			executionCwd: cwd,
			executionPathFlavor: native.backend.pathFlavor,
			resolvedFilePath: filePath,
			canonicalFilePath: filePath,
			runtimeGeneration: 7,
			createdAt: now(),
		})
		.run();
	return {
		narratorId: "narrator",
		userId: "alice",
		cwd,
		locale: "en",
		signal: new AbortController().signal,
		currentToolUseId: id,
		toolCallBinding: { toolCallId: id, attempt: 1 },
		executionTarget: {
			deviceId: "remote-device",
			backendKind: "remote",
			cwd,
			lexicalPath: filePath,
			canonicalPath: filePath,
			pathFlavor: native.backend.pathFlavor,
			runtimeGeneration: 7,
			selectionSource: "explicit",
		},
		resolveBackend: () => native.backend,
		recordFileNoDispatch: async () => {},
		requestPermission: async () => ({ behavior: "allow" }),
	};
}

for (const tool of ["Write", "Edit", "StructSed"] as const)
	test(`actual ${tool} uses native receipts with source-qualified effects and independently imported audit copies`, async () => {
		const ctx = await context(tool);
		const result = await withRemoteWorkspaceHistoryRuntime(registry, () =>
			tool === "Write"
				? writeTool.execute({ file_path: "/remote/repo/a.txt", content: "new\n" }, ctx)
				: tool === "Edit"
					? editTool.execute(
							{ file_path: "/remote/repo/a.txt", old_string: "old", new_string: "new" },
							ctx,
						)
					: structSedTool.execute(
							{
								file_path: "/remote/repo/a.txt",
								command: "substitute",
								address: "1",
								pattern: "old",
								replacement: "new",
								dry_run: false,
							},
							ctx,
						),
		);
		if (result.isError) throw new Error(result.output);
		expect(result.isError).not.toBe(true);
		expect(Buffer.from(native.files.get("a.txt") as Uint8Array).toString()).toBe("new\n");
		expect(native.plainWrites).toBe(0);
		const operations = db.select().from(schema.fileChangeOperations).limit(2).all();
		expect(operations).toHaveLength(1);
		expect(operations[0].sourceInstanceId).toBe("physical-device-source");
		expect(operations[0].settlement).toBe("settled");
		const effect = registry.evidence.listEffects(operations[0].id, { limit: 2 }).items[0];
		expect(effect.identityJson.deviceId).toBe("remote-device");
		expect(effect.attributionGrade).toBe("measured");
		expect(effect.executionConfirmed).toBe(true);
		expect(
			db
				.select()
				.from(schema.remoteHistoryObjects)
				.limit(10)
				.all()
				.every((row) => row.placement === "remote"),
		).toBe(true);
		const namespace = await registry.auditNamespace(AbortSignal.timeout(5_000));
		if (effect.beforeStateJson.kind !== "regular") throw new Error("Expected original raw");
		expect(
			Buffer.from(
				await namespace.store.readBytes(effect.beforeStateJson.blob, {
					signal: AbortSignal.timeout(5_000),
				}),
			).toString(),
		).toBe("old\n");
		expect([...native.receipts.values()][0].state).toBe("finalized");
		expect(checks).toBeGreaterThan(5);
	});

for (const tool of ["Write", "Edit"] as const)
	test(`validated no-dispatch ${tool} refusal settles the original guard without observing a fake after`, async () => {
		native.refuseBeforeDispatch();
		const ctx = await context(tool);
		const result = await withRemoteWorkspaceHistoryRuntime(registry, () =>
			tool === "Write"
				? writeTool.execute({ file_path: "/remote/repo/a.txt", content: "new\n" }, ctx)
				: editTool.execute(
						{ file_path: "/remote/repo/a.txt", old_string: "old", new_string: "new" },
						ctx,
					),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("unsupported_cross_filesystem");
		expect(Buffer.from(native.files.get("a.txt") as Uint8Array).toString()).toBe("old\n");
		expect(native.plainWrites).toBe(0);
		const operation = db.select().from(schema.fileChangeOperations).limit(2).all()[0];
		expect(operation.executionOutcome).toBe("failed");
		expect(operation.settlement).toBe("settled");
		const effect = registry.evidence.listEffects(operation.id, { limit: 2 }).items[0];
		expect(effect.executionConfirmed).toBe(true);
		expect(effect.observedAfterStateJson.kind).toBe("unknown");
		expect(effect.attributionGrade).toBe("unknown");
		expect(db.select().from(schema.remoteHistoryReceipts).limit(2).all()[0].state).toBe("rejected");
		// The coordinator's exact joined-IO terminal state is settled, not released.
		expect(db.select().from(schema.workspaceWriteLeases).limit(2).all()[0].status).toBe("settled");
		expect(db.select().from(schema.fileChangeScopes).limit(2).all()[0].status).toBe("active");
		// A different operation in the same scope can safely proceed after refusal.
		native.refuseBeforeDispatch(false);
		const nextCtx = await context(tool === "Write" ? "Edit" : "Write");
		const next = await withRemoteWorkspaceHistoryRuntime(registry, () =>
			tool === "Write"
				? editTool.execute(
						{ file_path: "/remote/repo/a.txt", old_string: "old", new_string: "new" },
						nextCtx,
					)
				: writeTool.execute({ file_path: "/remote/repo/a.txt", content: "new\n" }, nextCtx),
		);
		if (next.isError) throw new Error(next.output);
		expect(next.isError).not.toBe(true);
	});

test("no-dispatch scoped batch refusal preserves selected history and releases all claimed guards", async () => {
	const prepared = await preparedRemoteHistoryDelete(true);
	native.refuseBeforeDispatch();
	const result = await prepared.service.execute(prepared.request).whenSettled;
	expect(result.status).toBe("compensated");
	const rejected = [...native.receipts.values()].filter((receipt) => receipt.kind === "restore");
	expect(rejected).toHaveLength(1);
	expect(rejected[0].state).toBe("rejected");
	expect(rejected[0].effects).toHaveLength(2);
	expect(native.calls).not.toContain("compensate");
	expect(Buffer.from(native.files.get("a.txt") as Uint8Array).toString()).toBe("new\n");
	expect(Buffer.from(native.files.get("b.txt") as Uint8Array).toString()).toBe("second-new\n");
	expect(
		db
			.select()
			.from(schema.narratorToolCalls)
			.where(eq(schema.narratorToolCalls.id, prepared.ctx.toolCallBinding?.toolCallId as string))
			.get(),
	).toBeDefined();
	expect(
		db
			.select()
			.from(schema.workspaceWriteLeases)
			.limit(10)
			.all()
			.some((lease) => lease.status === "quarantined"),
	).toBe(false);
	expect(db.select().from(schema.fileChangeScopes).limit(2).all()[0].status).toBe("active");
});

test("lost refusal reply keeps Unknown until the original no-dispatch proof settles its whole lease", async () => {
	const ctx = await context("Write");
	native.refuseBeforeDispatch();
	native.loseRefusalReply();
	const failed = await withRemoteWorkspaceHistoryRuntime(registry, () =>
		writeTool.execute({ file_path: "/remote/repo/a.txt", content: "new\n" }, ctx),
	);
	expect(failed.isError).toBe(true);
	const operation = db.select().from(schema.fileChangeOperations).limit(2).all()[0];
	expect(db.select().from(schema.remoteHistoryReceipts).limit(2).all()[0].state).toBe("unknown");
	expect(db.select().from(schema.workspaceWriteLeases).limit(2).all()[0].status).toBe(
		"quarantined",
	);
	expect(Buffer.from(native.files.get("a.txt") as Uint8Array).toString()).toBe("old\n");
	native.loseRefusalReply(false);
	const recovered = await reconcileRemoteFileOperation({
		registry,
		principal: { userId: "alice", isAdmin: false },
		operationId: operation.id,
		signal: AbortSignal.timeout(10_000),
	});
	expect(recovered.state).toBe("rejected");
	expect(recovered.barrierReleased).toBe(true);
	expect(db.select().from(schema.workspaceWriteLeases).limit(2).all()[0].status).toBe("recovered");
	expect(registry.evidence.getOperation(operation.id)?.executionOutcome).toBe("failed");
	expect(registry.evidence.getOperation(operation.id)?.settlement).toBe("settled");
	expect(native.calls).not.toContain("finalize");
	expect(native.calls).not.toContain("compensate");
	native.refuseBeforeDispatch(false);
	const nextCtx = await context("Edit");
	const next = await withRemoteWorkspaceHistoryRuntime(registry, () =>
		editTool.execute(
			{ file_path: "/remote/repo/a.txt", old_string: "old", new_string: "new" },
			nextCtx,
		),
	);
	if (next.isError) throw new Error(next.output);
});

test("lost scoped batch refusal recovers all original claims without deleting selected history", async () => {
	const prepared = await preparedRemoteHistoryDelete(true);
	native.refuseBeforeDispatch();
	native.loseRefusalReply();
	const result = await prepared.service.execute(prepared.request).whenSettled;
	expect(result.status).toBe("recovery_required");
	native.loseRefusalReply(false);
	const count = native.calls.filter((kind) => kind === "restore").length;
	const recovered = await reconcileRemoteRevertPlan({
		registry,
		principal: { userId: "alice", isAdmin: false },
		narratorId: "narrator",
		planId: prepared.preview.plan.id,
		planHash: prepared.preview.plan.planHash as string,
		signal: AbortSignal.timeout(10_000),
	});
	expect(recovered.status).toBe("compensated");
	expect(recovered.barrierReleased).toBe(true);
	expect(native.calls.filter((kind) => kind === "restore")).toHaveLength(count);
	expect(native.calls).not.toContain("compensate");
	expect(Buffer.from(native.files.get("a.txt") as Uint8Array).toString()).toBe("new\n");
	expect(Buffer.from(native.files.get("b.txt") as Uint8Array).toString()).toBe("second-new\n");
	expect(
		db
			.select()
			.from(schema.narratorToolCalls)
			.where(eq(schema.narratorToolCalls.id, prepared.ctx.toolCallBinding?.toolCallId as string))
			.get(),
	).toBeDefined();
	expect(
		db
			.select()
			.from(schema.workspaceWriteLeases)
			.limit(10)
			.all()
			.some((lease) => lease.status === "quarantined"),
	).toBe(false);
});

test("lost mutation response retains unknown remote intent and an unknown-execution server barrier", async () => {
	const ctx = await context("Write");
	native.loseMutationReply();
	const result = await withRemoteWorkspaceHistoryRuntime(registry, () =>
		writeTool.execute({ file_path: "/remote/repo/a.txt", content: "new\n" }, ctx),
	);
	expect(result.isError).toBe(true);
	expect(native.plainWrites).toBe(0);
	expect(Buffer.from(native.files.get("a.txt") as Uint8Array).toString()).toBe("new\n");
	const scope = db
		.select()
		.from(schema.fileChangeScopes)
		.where(eq(schema.fileChangeScopes.deviceId, "remote-device"))
		.get();
	expect(scope?.sourceInstanceId).toBe("physical-device-source");
	const lease = db
		.select()
		.from(schema.workspaceWriteLeases)
		.where(eq(schema.workspaceWriteLeases.deviceId, "remote-device"))
		.get();
	expect(lease?.executionClass).toBe("unknown");
	expect(lease?.status).toBe("quarantined");
	expect(db.select().from(schema.remoteHistoryReceipts).limit(2).all()[0].state).toBe("unknown");
});

test("authorization revocation during construction causes no native mutation or plain fallback", async () => {
	const endpoint = await registry.resolve(
		{ userId: "alice", narratorId: "narrator", projectId: null, kind: "human" },
		{
			deviceId: "remote-device",
			cwd: "/remote/repo",
			lexicalPath: "/remote/repo/a.txt",
			canonicalPath: "/remote/repo/a.txt",
			runtimeGeneration: 7,
		},
		"write",
		AbortSignal.timeout(5_000),
	);
	await expect(
		endpoint.runtime.execute({
			identity: endpoint.identity,
			operationId: "revoked",
			requestDigest: hash("revoked"),
			signal: AbortSignal.timeout(5_000),
			authorize: async () => {},
			construct: () => {
				authorized = false;
				return { nextBytes: Buffer.from("bad"), result: "unused" };
			},
			commit: async () => "never",
		}),
	).rejects.toThrow("revoked");
	expect(native.calls).not.toContain("mutate");
	expect(native.plainWrites).toBe(0);
});

test("recorded source survives cwd changes but a replaced source cannot forge old workspace identity", async () => {
	const actor = {
		userId: "alice",
		narratorId: "narrator",
		projectId: null,
		kind: "human" as const,
	};
	const target = {
		deviceId: "remote-device",
		cwd: "/remote/repo",
		lexicalPath: "/remote/repo/a.txt",
		canonicalPath: "/remote/repo/a.txt",
		runtimeGeneration: 7,
	};
	const endpoint = await registry.resolve(actor, target, "read", AbortSignal.timeout(5_000));
	db.update(schema.narrators)
		.set({ cwd: "/new/current/path", workspaceRevision: 5 })
		.where(eq(schema.narrators.id, "narrator"))
		.run();
	const reopened = await registry.resolve(
		actor,
		target,
		"read",
		AbortSignal.timeout(5_000),
		endpoint.identity,
	);
	expect(reopened.identity).toEqual(endpoint.identity);
	native.replaceSource();
	await expect(
		registry.resolve(actor, target, "read", AbortSignal.timeout(5_000), endpoint.identity),
	).rejects.toThrow("source changed");
});

test("human editor adapter factory composes real runtime with durable owned effects", async () => {
	const binding = {
		deviceId: "remote-device",
		cwd: "/remote/repo",
		projectId: null,
		lexicalPath: "/remote/repo/a.txt",
		canonicalPath: "/remote/repo/a.txt",
		outsideRoots: false,
		runtimeGeneration: 7,
		rootIdentity: "physical-root",
	};
	const actor = { userId: "alice", narratorId: "narrator", authorize: async () => binding };
	const context = {
		userId: "alice",
		narratorId: "narrator",
		projectId: null,
		kind: "human" as const,
	};
	const adapter = createRemoteEditorAdapter({
		resolve: async (_actor, _binding, need, signal) => ({
			...(await registry.resolve(
				context,
				binding as {
					deviceId: string;
					cwd: string;
					lexicalPath: string;
					canonicalPath: string;
					runtimeGeneration: number;
				},
				need,
				signal,
			)),
			maxWriteBytes: 512 * 1024,
			async commit(_receipt, request, result) {
				return registry.completion(context, request.requestId, result);
			},
		}),
		queryOperation: async () => null,
	});
	const completion = await adapter.execute(actor, binding, {
		requestId: "human-save",
		userId: "alice",
		narratorId: "narrator",
		cwd: binding.cwd,
		lexicalPath: binding.lexicalPath,
		canonicalPath: binding.canonicalPath,
		input: { contentDigest: hash("human\n") },
		signal: AbortSignal.timeout(5_000),
		authorize: async () => {},
		construct: () => ({
			nextBytes: Buffer.from("human\n"),
			lineStats: null,
			result: { hash: hash("human\n"), bytes: 6 },
		}),
	});
	expect(completion.fileChangeEvidence.grade).toBe("measured");
	const attribution = db
		.select()
		.from(schema.fileAttributions)
		.where(
			and(
				eq(schema.fileAttributions.deviceId, "remote-device"),
				eq(schema.fileAttributions.action, "human"),
			),
		)
		.get();
	expect(attribution?.userId).toBe("alice");
	expect(attribution?.narratorId).toBeNull();
});

function windowsEditorHttp(
	authentication: "session" | "oauth" | "legacy" = "session",
	jobs = new EditorDocumentJobs(),
) {
	native.setPathFlavor("windows");
	const binding = {
		deviceId: "remote-device",
		cwd: "C:\\repo",
		projectId: null,
		lexicalPath: "C:\\repo\\a.txt",
		canonicalPath: "C:\\repo\\a.txt",
		outsideRoots: false,
		runtimeGeneration: 7,
		rootIdentity: "physical-root",
	};
	const application = new Hono();
	application.use("*", async (c, next) => {
		const seconds = Math.floor(Date.now() / 1000);
		const user = {
			sub: "alice",
			role: "user" as const,
			iat: seconds,
			exp: seconds + 3600,
			[SESSION_VERSION_CLAIM]: 0,
		};
		const auth: AuthPrincipal =
			authentication === "oauth"
				? {
						type: "oauth",
						user,
						oauth: {
							tokenId: "original-token",
							clientId: "client",
							oauthClientId: "client",
							grantId: "grant",
							refreshFamilyId: "family",
							expiresAt: new Date(Date.now() + 3600000).toISOString(),
							scopes: ["narrators:write"],
						},
					}
				: { type: "session", user };
		if (authentication !== "legacy") c.set("auth", auth);
		c.set("user", user);
		await next();
	});
	application.use(
		"*",
		authentication === "legacy" ? remoteRecoveryProvenance : remoteEditorSessionProvenance,
	);
	application.post("/:kind", async (c) =>
		jobs.withIo(
			c.get("user").sub,
			() =>
				withRemoteWorkspaceHistoryRuntime(registry, async () => {
					const adapter = createProductionRemoteEditorAdapter();
					const actor = {
						userId: c.get("user").sub,
						narratorId: "narrator",
						authorize: async () => binding,
					};
					try {
						if (c.req.param("kind") === "source")
							await adapter.source(
								actor,
								binding,
								join(directory, "must-not-create-source"),
								c.req.raw.signal,
							);
						else
							await adapter.execute(actor, binding, {
								requestId: "windows-http-save",
								userId: "alice",
								narratorId: "narrator",
								cwd: binding.cwd,
								lexicalPath: binding.lexicalPath,
								canonicalPath: binding.canonicalPath,
								input: { contentDigest: hash("new\n") },
								signal: c.req.raw.signal,
								authorize: async () => {},
								construct: () => ({
									nextBytes: Buffer.from("new\n"),
									lineStats: null,
									result: { hash: hash("new\n"), bytes: 4 },
								}),
							});
						return c.json({ allowed: true });
					} catch (error) {
						return c.json({
							allowed: false,
							message: error instanceof Error ? error.message : "failure",
							code: (error as { code?: string }).code ?? "internal",
						});
					}
				}),
			c.req.raw.signal,
		),
	);
	return application;
}

test("actual queued Windows save preparing provenance belongs to B, not A's live session", async () => {
	const jobs = new EditorDocumentJobs();
	let release: () => void = () => {},
		started: () => void = () => {},
		submitted: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const occupying = new Promise<void>((resolve) => {
		started = resolve;
	});
	const queued = new Promise<void>((resolve) => {
		submitted = resolve;
	});
	const originalWithIo = jobs.withIo.bind(jobs);
	let entries = 0;
	const observeQueue = spyOn(jobs, "withIo").mockImplementation(
		<T>(user: string, body: (bounded: AbortSignal) => Promise<T>, external?: AbortSignal) => {
			const pending = originalWithIo(user, body, external);
			if (++entries === 2) submitted();
			return pending;
		},
	);
	const aExpiry = Math.floor(Date.now() / 1000) + 7200;
	const first = new Hono();
	first.use("*", async (c, next) => {
		const auth: AuthPrincipal = {
			type: "session",
			user: {
				sub: "alice",
				role: "user",
				iat: Math.floor(Date.now() / 1000),
				exp: aExpiry,
				[SESSION_VERSION_CLAIM]: 0,
			},
		};
		c.set("auth", auth);
		c.set("user", auth.user);
		await next();
	});
	first.use("*", remoteEditorSessionProvenance);
	first.post("/hold", async (c) => {
		await jobs.withIo("alice", async () => {
			started();
			await gate;
		});
		return c.json({ okay: true });
	});
	try {
		const firstRequest = first.request("/hold", { method: "POST" });
		await occupying;
		const second = windowsEditorHttp("session", jobs).request("/save", { method: "POST" });
		await queued;
		release();
		const [a, b] = await Promise.all([firstRequest, second]);
		expect(a.status).toBe(200);
		expect(await b.json()).toHaveProperty("code", "EDITOR_WINDOWS_METADATA_NOT_READY");
		const operation = db.select().from(schema.fileChangeOperations).get();
		if (!operation) throw new Error("B preparing provenance missing");
		const persisted = operation.actorJson as typeof operation.actorJson & {
			recoveryAuth?: { expiresAtSeconds: number };
		};
		expect(persisted.recoveryAuth?.expiresAtSeconds).toBeLessThan(aExpiry - 3000);
		expect(persisted.recoveryAuth?.expiresAtSeconds).toBeGreaterThan(Math.floor(Date.now() / 1000));
		expect(operation?.sourceId).toBe("windows-http-save");
		expect(native.calls).not.toContain("inspect");
		expect(native.calls).not.toContain("mutate");
	} finally {
		release();
		observeQueue.mockRestore();
	}
});

test("Windows HTTP save has new preparing and held lease before fixed preflight; no metadata calls", async () => {
	const application = windowsEditorHttp();
	let checked = false;
	const originalPreflight = windowsEditorPreflight.preflightWindowsEditorMetadata;
	const observer = spyOn(
		windowsEditorPreflight,
		"preflightWindowsEditorMetadata",
	).mockImplementation(async (input) => {
		const rows = db
			.select()
			.from(schema.fileChangeOperations)
			.where(eq(schema.fileChangeOperations.sourceId, "windows-http-save"))
			.all();
		expect(rows).toHaveLength(1);
		const operation = rows[0];
		expect(operation.id).not.toBe(operation.sourceId);
		expect(operation.settlement).toBe("preparing");
		expect(operation.preparedEffectCount).toBe(0);
		expect(operation.actorJson.subjectKey).toBe("human:alice");
		expect(operation.actorJson).not.toHaveProperty("credentialRef");
		const leases = db
			.select()
			.from(schema.workspaceWriteLeases)
			.where(eq(schema.workspaceWriteLeases.status, "executing"))
			.limit(2)
			.all();
		expect(leases).toHaveLength(1);
		const lease = leases[0];
		if (!operation.executionBindingJson) throw new Error("Original execution binding missing");
		expect(lease.fencingToken).toBe(operation.executionBindingJson.fencingToken);
		expect(lease.runtimeEpoch).toBe(operation.executionBindingJson.runtimeEpoch);
		expect(registry.evidence.getScope(lease.scopeId)?.activeLeaseId).toBe(lease.leaseId);
		expect(registry.evidence.getScope(lease.scopeId)?.sourceInstanceId).toBe(
			operation.sourceInstanceId,
		);
		expect(db.select().from(schema.fileChangeEffects).all()).toHaveLength(0);
		checked = true;
		return originalPreflight(input);
	});
	try {
		const response = await application.request("/save", { method: "POST" });
		expect(await response.json()).toHaveProperty("code", "EDITOR_WINDOWS_METADATA_NOT_READY");
		expect(checked).toBe(true);
		const operation = db.select().from(schema.fileChangeOperations).get();
		expect(operation?.settlement).toBe("settled");
		expect(operation?.effectOutcome).toBe("no_change");
		expect(operation?.preparedEffectCount).toBe(0);
		expect(operation?.reason).toBe("no_dispatch:validation_rejected");
		expect(
			native.calls.filter((kind) =>
				["inspect", "objectStage", "mutate", "restore", "compensate"].includes(kind),
			),
		).toHaveLength(0);
		expect(native.plainWrites).toBe(0);
		expect(
			db
				.select()
				.from(schema.workspaceWriteLeases)
				.all()
				.every((lease) => lease.status === "settled"),
		).toBe(true);
		expect(Buffer.from(native.files.get("a.txt") as Uint8Array).toString()).toBe("old\n");
	} finally {
		observer.mockRestore();
	}
});

test("Windows readonly HTTP source denies before inspect and creates no write intent or lease", async () => {
	const response = await windowsEditorHttp().request("/source", { method: "POST" });
	expect(await response.json()).toHaveProperty("code", "EDITOR_WINDOWS_METADATA_NOT_READY");
	expect(native.calls).not.toContain("inspect");
	expect(native.calls).not.toContain("objectRead");
	expect(db.select().from(schema.fileChangeOperations).all()).toHaveLength(0);
	expect(db.select().from(schema.workspaceWriteLeases).all()).toHaveLength(0);
	expect(native.plainWrites).toBe(0);
});

for (const authentication of ["legacy", "oauth"] as const)
	test(`Windows ${authentication} editor cannot borrow a HTTP session origin`, async () => {
		const application = windowsEditorHttp(authentication);
		for (const kind of ["source", "save"] as const) {
			const response = await application.request(`/${kind}`, { method: "POST" });
			expect(await response.json()).toHaveProperty(
				"code",
				authentication === "oauth"
					? "EDITOR_SESSION_ORIGIN_UNSUPPORTED"
					: "EDITOR_SESSION_ORIGIN_MISSING",
			);
		}
		expect(db.select().from(schema.fileChangeOperations).all()).toHaveLength(0);
		expect(native.calls).not.toContain("inspect");
		expect(native.calls).not.toContain("mutate");
		expect(native.plainWrites).toBe(0);
	});

test("retry of old Windows editor attempt never closes it or dispatches again", async () => {
	const application = windowsEditorHttp();
	await application.request("/save", { method: "POST" });
	const operation = db.select().from(schema.fileChangeOperations).get();
	if (!operation) throw new Error("New preparation missing");
	db.update(schema.fileChangeOperations)
		.set({
			settlement: "reconcile_required",
			executionOutcome: "running",
			reason: "original-unknown",
		})
		.where(eq(schema.fileChangeOperations.id, operation.id))
		.run();
	const before = registry.evidence.getOperation(operation.id);
	const response = await application.request("/save", { method: "POST" });
	expect(await response.json()).toHaveProperty("allowed", false);
	expect(registry.evidence.getOperation(operation.id)).toEqual(before);
	expect(native.calls).not.toContain("inspect");
	expect(native.calls).not.toContain("mutate");
	expect(db.select().from(schema.fileChangeOperations).all()).toHaveLength(1);
});

test("Windows session revoked after preparing closes only the new unattempted intent", async () => {
	const application = windowsEditorHttp();
	const original = windowsEditorPreflight.preflightWindowsEditorMetadata;
	const revoke = spyOn(windowsEditorPreflight, "preflightWindowsEditorMetadata").mockImplementation(
		async (input) => {
			db.update(schema.users).set({ tokenVersion: 1 }).where(eq(schema.users.id, "alice")).run();
			return original(input);
		},
	);
	try {
		const response = await application.request("/save", { method: "POST" });
		expect(await response.json()).toHaveProperty("code", "EDITOR_SESSION_ORIGIN_REVOKED");
		expect(db.select().from(schema.fileChangeOperations).get()?.settlement).toBe("settled");
		expect(db.select().from(schema.fileChangeEffects).all()).toHaveLength(0);
		expect(native.calls).not.toContain("inspect");
		expect(native.calls).not.toContain("mutate");
	} finally {
		revoke.mockRestore();
	}
});

test("Windows generation changes after preparing cannot close or dispatch the original intent", async () => {
	const application = windowsEditorHttp();
	const original = windowsEditorPreflight.preflightWindowsEditorMetadata;
	const change = spyOn(windowsEditorPreflight, "preflightWindowsEditorMetadata").mockImplementation(
		async (input) => {
			native.setGeneration(8);
			return original(input);
		},
	);
	try {
		const response = await application.request("/save", { method: "POST" });
		expect(await response.json()).toHaveProperty("allowed", false);
		expect(db.select().from(schema.fileChangeOperations).get()?.settlement).toBe("preparing");
		expect(
			db
				.select()
				.from(schema.workspaceWriteLeases)
				.all()
				.some((lease) => lease.status === "quarantined"),
		).toBe(true);
		expect(native.calls).not.toContain("inspect");
		expect(native.calls).not.toContain("mutate");
	} finally {
		change.mockRestore();
	}
});

test("Windows real scope fence changes after preparing preserve the original barrier", async () => {
	const application = windowsEditorHttp();
	const original = windowsEditorPreflight.preflightWindowsEditorMetadata;
	const change = spyOn(windowsEditorPreflight, "preflightWindowsEditorMetadata").mockImplementation(
		async (input) => {
			const scope = db
				.select({ id: schema.fileChangeScopes.id, fence: schema.fileChangeScopes.fencingToken })
				.from(schema.fileChangeScopes)
				.limit(1)
				.get();
			if (!scope) throw new Error("Original scope missing");
			db.update(schema.fileChangeScopes)
				.set({ fencingToken: scope.fence + 1 })
				.where(eq(schema.fileChangeScopes.id, scope.id))
				.run();
			return original(input);
		},
	);
	try {
		const response = await application.request("/save", { method: "POST" });
		expect(await response.json()).toHaveProperty("allowed", false);
		expect(db.select().from(schema.fileChangeOperations).get()?.settlement).toBe("preparing");
		const leases = db.select().from(schema.workspaceWriteLeases).all();
		expect(leases).toHaveLength(1);
		const retained = leases[0];
		expect(["executing", "quarantined"]).toContain(retained.status);
		expect(registry.evidence.getScope(retained.scopeId)?.activeLeaseId).toBe(retained.leaseId);
		expect(native.calls).not.toContain("inspect");
		expect(native.calls).not.toContain("mutate");
	} finally {
		change.mockRestore();
	}
});

for (const defect of ["missing-row", "owner-epoch", "active-lease", "source"] as const)
	test(`Windows original durable ${defect} failure cannot settle preparing`, async () => {
		const application = windowsEditorHttp();
		const original = windowsEditorPreflight.preflightWindowsEditorMetadata;
		let actualLeaseId = "";
		let actualScopeId = "";
		const change = spyOn(
			windowsEditorPreflight,
			"preflightWindowsEditorMetadata",
		).mockImplementation(async (input) => {
			const held = db
				.select()
				.from(schema.workspaceWriteLeases)
				.where(eq(schema.workspaceWriteLeases.status, "executing"))
				.get();
			if (!held) throw new Error("Held lease missing before fault");
			actualLeaseId = held.leaseId;
			actualScopeId = held.scopeId;
			if (defect === "missing-row")
				db.delete(schema.workspaceWriteLeases)
					.where(eq(schema.workspaceWriteLeases.leaseId, held.leaseId))
					.run();
			if (defect === "owner-epoch")
				db.update(schema.workspaceWriteLeases)
					.set({ ownerEpoch: "foreign-owner" })
					.where(eq(schema.workspaceWriteLeases.leaseId, held.leaseId))
					.run();
			if (defect === "active-lease")
				db.update(schema.fileChangeScopes)
					.set({ activeLeaseId: "other-lease" })
					.where(eq(schema.fileChangeScopes.id, held.scopeId))
					.run();
			if (defect === "source")
				db.update(schema.fileChangeScopes)
					.set({ sourceInstanceId: "foreign-source" })
					.where(eq(schema.fileChangeScopes.id, held.scopeId))
					.run();
			return original(input);
		});
		try {
			const response = await application.request("/save", { method: "POST" });
			expect(await response.json()).toHaveProperty("allowed", false);
			expect(db.select().from(schema.fileChangeOperations).get()?.settlement).toBe("preparing");
			const retainedScope = registry.evidence.getScope(actualScopeId);
			expect(retainedScope?.activeLeaseId).toBe(
				defect === "active-lease" ? "other-lease" : actualLeaseId,
			);
			expect(native.calls).not.toContain("inspect");
			expect(native.calls).not.toContain("mutate");
			expect(native.plainWrites).toBe(0);
		} finally {
			change.mockRestore();
		}
	});

test("changed Windows preparation state cannot be closed by a no-native preflight error", async () => {
	const application = windowsEditorHttp();
	const original = windowsEditorPreflight.preflightWindowsEditorMetadata;
	const change = spyOn(windowsEditorPreflight, "preflightWindowsEditorMetadata").mockImplementation(
		async (input) => {
			db.update(schema.fileChangeOperations).set({ settlement: "reconcile_required" }).run();
			return original(input);
		},
	);
	try {
		const response = await application.request("/save", { method: "POST" });
		expect(await response.json()).toHaveProperty("allowed", false);
		expect(db.select().from(schema.fileChangeOperations).get()?.settlement).toBe(
			"reconcile_required",
		);
		expect(
			db
				.select()
				.from(schema.workspaceWriteLeases)
				.all()
				.some((lease) => lease.status === "quarantined"),
		).toBe(true);
		expect(native.calls).not.toContain("inspect");
		expect(native.calls).not.toContain("mutate");
	} finally {
		change.mockRestore();
	}
});

test("Windows preparation settlement failure retains the new intent and barrier", async () => {
	const application = windowsEditorHttp();
	const failure = spyOn(registry.evidence, "finishPreparationWithoutDispatch").mockImplementation(
		() => {
			throw new Error("Injected preparation settlement failure");
		},
	);
	try {
		const response = await application.request("/save", { method: "POST" });
		expect(await response.json()).toHaveProperty(
			"message",
			"Injected preparation settlement failure",
		);
		expect(db.select().from(schema.fileChangeOperations).get()?.settlement).toBe("preparing");
		expect(
			db
				.select()
				.from(schema.workspaceWriteLeases)
				.all()
				.some((lease) => lease.status === "quarantined"),
		).toBe(true);
		expect(native.calls).not.toContain("inspect");
		expect(native.calls).not.toContain("mutate");
	} finally {
		failure.mockRestore();
	}
});

async function preparedRemoteHistoryDelete(twoFiles = false) {
	const ctx = await context("Write");
	const written = await withRemoteWorkspaceHistoryRuntime(registry, () =>
		writeTool.execute({ file_path: "/remote/repo/a.txt", content: "new\n" }, ctx),
	);
	expect(written.isError).not.toBe(true);
	db.update(schema.narratorToolCalls)
		.set({ status: "success", outputJson: written.metadata ?? {} })
		.where(eq(schema.narratorToolCalls.id, ctx.toolCallBinding?.toolCallId as string))
		.run();
	const selectedCalls = [ctx.toolCallBinding?.toolCallId as string];
	if (twoFiles) {
		native.files.set("b.txt", Buffer.from("second-old\n"));
		const second = await context("Write", "/remote/repo/b.txt");
		const result = await withRemoteWorkspaceHistoryRuntime(registry, () =>
			writeTool.execute({ file_path: "/remote/repo/b.txt", content: "second-new\n" }, second),
		);
		if (result.isError) throw new Error(result.output);
		db.update(schema.narratorToolCalls)
			.set({ status: "success", outputJson: result.metadata ?? {} })
			.where(eq(schema.narratorToolCalls.id, second.toolCallBinding?.toolCallId as string))
			.run();
		selectedCalls.push(second.toolCallBinding?.toolCallId as string);
		const first = db
			.select({ messageId: schema.narratorToolCalls.messageId })
			.from(schema.narratorToolCalls)
			.where(eq(schema.narratorToolCalls.id, selectedCalls[0]))
			.get();
		if (!first) throw new Error("Original history boundary missing");
		db.update(schema.narratorMessages)
			.set({
				contentJson: [
					{ type: "text", text: "Preserved boundary" },
					{ type: "tool_use", id: ctx.currentToolUseId, name: "Write", input: {} },
				],
			})
			.where(eq(schema.narratorMessages.id, first.messageId))
			.run();
	}
	const base: RevertPlannerAccess = {
		async authenticate(principal) {
			if (principal.userId !== "alice" || principal.isAdmin || !authorized)
				throw new Error("Authentication revoked");
		},
		async authorizeNarrator(principal, row) {
			if (principal.userId !== row.ownerUserId || !authorized) throw new Error("Narrator denied");
		},
		async resolveContext() {
			if (!authorized) throw new Error("Project denied");
			return { projectId: null };
		},
		async authorizeFile() {
			throw new Error("No local targets in this integration");
		},
		async resolveFile() {
			throw new Error("No local targets in this integration");
		},
	};
	const access = createRecordQualifiedRevertAccess(base, registry);
	const namespace = await registry.auditNamespace(AbortSignal.timeout(5_000));
	const namespaceKey = namespace.catalog.getBudget()?.namespaceKey;
	if (!namespaceKey) throw new Error("Audit namespace missing");
	const planner = new RevertPlannerService(db, {
		access,
		blobStore: namespace.store,
		blobCatalog: namespace.catalog,
		generation: namespace.generation,
		planOptions: { namespaceKey },
	});
	const principal = { userId: "alice", isAdmin: false };
	const preview = await planner.prepare({
		principal,
		narratorId: "narrator",
		expectedMessageVersion: 0,
		idempotencyKey: "remote-delete-preview",
		kind: twoFiles ? "rollback_to_block" : "history_delete",
		revertScope: "narrator",
		selector: twoFiles
			? {
					kind: "after_block",
					messageId: db
						.select({ messageId: schema.narratorToolCalls.messageId })
						.from(schema.narratorToolCalls)
						.where(eq(schema.narratorToolCalls.id, selectedCalls[0]))
						.get()?.messageId as string,
					keepThroughBlockIndex: 0,
				}
			: { kind: "tool_calls", toolCallIds: selectedCalls },
		uiAction: twoFiles ? "rollback_to_block" : "delete_tool_block",
		signal: AbortSignal.timeout(10_000),
	});
	const service = new RevertTransactionService(db, {
		access,
		runtime: registry.options.auditRuntime,
		namespace,
		planOptions: { namespaceKey },
		coordinator: registry.coordinator,
		provider: new RemoteRevertTransactionProvider(registry),
		readRuntime: (deviceId) => registry.runtimeBinding(deviceId),
	});
	return {
		ctx,
		preview,
		service,
		request: {
			principal,
			narratorId: "narrator",
			planId: preview.plan.id,
			planHash: preview.plan.planHash as string,
			action: twoFiles ? ("rollback_to_block" as const) : ("delete_tool_block" as const),
			signal: AbortSignal.timeout(10_000),
		},
	};
}

test("real scoped preview applies remote restore, server history COW and durable finalization", async () => {
	const prepared = await preparedRemoteHistoryDelete();
	expect(prepared.preview.plan.expectedFileCount).toBe(1);
	const execution = prepared.service.execute(prepared.request);
	const result = await execution.whenSettled;
	expect(result.reason).toBeNull();
	expect(result.status).toBe("committed");
	expect(Buffer.from(native.files.get("a.txt") as Uint8Array).toString()).toBe("old\n");
	expect(native.calls).toContain("restore");
	const restored = [...native.receipts.values()].find((receipt) => receipt.kind === "restore");
	expect(restored?.state).toBe("finalized");
	expect(restored?.serverCommitId).toBe(prepared.preview.plan.id);
	expect(
		db
			.select()
			.from(schema.narratorToolCalls)
			.where(eq(schema.narratorToolCalls.id, prepared.ctx.toolCallBinding?.toolCallId as string))
			.get(),
	).toBeUndefined();
	expect(native.plainWrites).toBe(0);
});

test("external edit after preview prevents remote apply and does not delete selected history", async () => {
	const prepared = await preparedRemoteHistoryDelete();
	native.files.set("a.txt", Buffer.from("external\n"));
	const execution = prepared.service.execute(prepared.request);
	await expect(execution.whenSettled).rejects.toThrow("prepared plan");
	expect(native.calls).not.toContain("restore");
	expect(
		db
			.select()
			.from(schema.narratorToolCalls)
			.where(eq(schema.narratorToolCalls.id, prepared.ctx.toolCallBinding?.toolCallId as string))
			.get(),
	).toBeDefined();
});

test("history commit failure performs only original native conditional compensation", async () => {
	const prepared = await preparedRemoteHistoryDelete();
	const failure = spyOn(
		RevertHistoryCommitService.prototype,
		"applyToTransaction",
	).mockImplementation(() => {
		throw new Error("Injected server history commit failure");
	});
	try {
		const result = await prepared.service.execute(prepared.request).whenSettled;
		expect(result.status).toBe("compensated");
		expect(Buffer.from(native.files.get("a.txt") as Uint8Array).toString()).toBe("new\n");
		expect(native.calls).toContain("compensate");
		expect(
			[...native.receipts.values()].find((receipt) => receipt.kind === "compensate")?.state,
		).toBe("compensated");
		expect(
			db
				.select()
				.from(schema.narratorToolCalls)
				.where(eq(schema.narratorToolCalls.id, prepared.ctx.toolCallBinding?.toolCallId as string))
				.get(),
		).toBeDefined();
		expect(native.plainWrites).toBe(0);
	} finally {
		failure.mockRestore();
	}
});

test("same bytes with a replaced native incarnation are not silently committed or compensated", async () => {
	const prepared = await preparedRemoteHistoryDelete();
	const original = native.backend.remoteHistory?.bind(native.backend);
	if (!original) throw new Error("Missing remote RPC");
	let replaced = false;
	const mutation = spyOn(native.backend, "remoteHistory").mockImplementation(
		async (kind, request, signal) => {
			const receipt = await original(kind, request, signal);
			if (kind === "restore" && !replaced) {
				replaced = true;
				native.replaceIncarnation();
			}
			return receipt;
		},
	);
	try {
		const result = await prepared.service.execute(prepared.request).whenSettled;
		expect(result.status).toBe("recovery_required");
		expect(Buffer.from(native.files.get("a.txt") as Uint8Array).toString()).toBe("old\n");
		expect(
			db
				.select()
				.from(schema.narratorToolCalls)
				.where(eq(schema.narratorToolCalls.id, prepared.ctx.toolCallBinding?.toolCallId as string))
				.get(),
		).toBeDefined();
		expect(
			db
				.select()
				.from(schema.workspaceWriteLeases)
				.where(
					and(
						eq(schema.workspaceWriteLeases.deviceId, "remote-device"),
						eq(schema.workspaceWriteLeases.status, "quarantined"),
					),
				)
				.get(),
		).toBeDefined();
	} finally {
		mutation.mockRestore();
	}
});

test("lost native mutation reply is reconciled from the original durable receipt, not matching bytes", async () => {
	const ctx = await context("Write");
	native.loseMutationReply();
	const failed = await withRemoteWorkspaceHistoryRuntime(registry, () =>
		writeTool.execute({ file_path: "/remote/repo/a.txt", content: "new\n" }, ctx),
	);
	expect(failed.isError).toBe(true);
	const operation = db.select().from(schema.fileChangeOperations).limit(2).all()[0];
	native.clearTransportFault();
	native.setGeneration(8);
	const recovered = await reconcileRemoteFileOperation({
		registry,
		principal: { userId: "alice", isAdmin: false },
		operationId: operation.id,
		signal: AbortSignal.timeout(10_000),
	});
	expect(recovered.reason).toBeUndefined();
	expect(recovered.state).toBe("finalized");
	expect(recovered.barrierReleased).toBe(true);
	expect(registry.evidence.getOperation(operation.id)?.settlement).toBe("settled");
	expect(
		db
			.select()
			.from(schema.workspaceWriteLeases)
			.where(eq(schema.workspaceWriteLeases.deviceId, "remote-device"))
			.get()?.status,
	).toBe("recovered");
	expect(native.calls.filter((kind) => kind === "mutate")).toHaveLength(1);
});

test("a new server epoch releases only an opaque original terminal receipt attestation", async () => {
	const ctx = await context("Write");
	native.loseMutationReply();
	await withRemoteWorkspaceHistoryRuntime(registry, () =>
		writeTool.execute({ file_path: "/remote/repo/a.txt", content: "new\n" }, ctx),
	);
	const operation = db.select().from(schema.fileChangeOperations).limit(2).all()[0];
	const scope = db
		.select()
		.from(schema.fileChangeScopes)
		.where(eq(schema.fileChangeScopes.deviceId, "remote-device"))
		.get();
	const lease = db
		.select()
		.from(schema.workspaceWriteLeases)
		.where(eq(schema.workspaceWriteLeases.deviceId, "remote-device"))
		.get();
	if (!scope || !lease) throw new Error("Expected original quarantine");
	db.update(schema.workspaceWriteLeases)
		.set({ ownerEpoch: "old-server-process", executionEndedAt: null })
		.where(eq(schema.workspaceWriteLeases.leaseId, lease.leaseId))
		.run();
	const restarted = new RemoteWorkspaceHistoryRuntime({
		...registry.options,
		coordinatorState: createWorkspaceWriteCoordinatorState(),
	});
	expect(() => restarted.coordinator.reserveRecovery({ scope, leaseId: lease.leaseId })).toThrow(
		"owner epoch",
	);
	expect(() =>
		restarted.coordinator.reserveRemoteRecovery(
			{ scope, leaseId: lease.leaseId },
			{} as Parameters<typeof restarted.coordinator.reserveRemoteRecovery>[1],
		),
	).toThrow("forged");
	native.clearTransportFault();
	native.setGeneration(8);
	const recovered = await reconcileRemoteFileOperation({
		registry: restarted,
		principal: { userId: "alice", isAdmin: false },
		operationId: operation.id,
		signal: AbortSignal.timeout(10_000),
	});
	expect(recovered.reason).toBeUndefined();
	expect(recovered.barrierReleased).toBe(true);
	expect(native.calls.filter((kind) => kind === "mutate")).toHaveLength(1);
	expect(
		db
			.select()
			.from(schema.workspaceWriteLeases)
			.where(eq(schema.workspaceWriteLeases.leaseId, lease.leaseId))
			.get()?.status,
	).toBe("recovered");
});

test("production human editor factory saves 20MiB via negotiated chunks and has a durable owned query", async () => {
	native.enableStage();
	const binding = {
		deviceId: "remote-device",
		cwd: "/remote/repo",
		projectId: null,
		lexicalPath: "/remote/repo/a.txt",
		canonicalPath: "/remote/repo/a.txt",
		outsideRoots: false,
		runtimeGeneration: 7,
		rootIdentity: "physical-root",
	};
	const actor = {
		userId: "alice",
		narratorId: "narrator",
		async authorize() {
			const root = await resolveProductionRemoteEditorRoot(
				actor,
				binding,
				AbortSignal.timeout(10_000),
			);
			expect(root.rootIdentity).toBe("physical-root");
			expect(root.maxWriteBytes).toBe(FILE_CHANGE_LIMITS.blobBytes);
			return binding;
		},
	};
	const bytes = Buffer.alloc(20 * 1024 * 1024, 0x61);
	const digest = hash(bytes);
	const requestId = crypto.randomUUID();
	const adapter = createProductionRemoteEditorAdapter();
	const completion = await withRemoteWorkspaceHistoryRuntime(registry, () =>
		adapter.execute(actor, binding, {
			requestId,
			userId: "alice",
			narratorId: "narrator",
			cwd: binding.cwd,
			lexicalPath: binding.lexicalPath,
			canonicalPath: binding.canonicalPath,
			signal: AbortSignal.timeout(30_000),
			input: { rawDigest: digest, bytes: bytes.byteLength },
			authorize: async () => {},
			construct: () => ({
				nextBytes: bytes,
				lineStats: null,
				result: { hash: digest, bytes: bytes.byteLength },
			}),
		}),
	);
	expect(completion.fileChangeEvidence.grade).toBe("measured");
	expect(native.plainWrites).toBe(0);
	expect([...native.stages.values()][0].status.written).toBe(bytes.byteLength);
	expect([...native.stages.values()][0].status.state).toBe("ready");
	expect(native.calls.filter((kind) => kind === "objectStage").length).toBeGreaterThan(20);
	expect(hash(native.files.get("a.txt") as Uint8Array)).toBe(digest);
	db.update(schema.narrators)
		.set({ cwd: "/switched/workspace", workspaceRevision: 9 })
		.where(eq(schema.narrators.id, "narrator"))
		.run();
	const recovered = await withRemoteWorkspaceHistoryRuntime(registry, () =>
		adapter.queryOperation(actor, requestId, {
			version: 1,
			userId: "alice",
			narratorId: "narrator",
			operationId: requestId,
			snapshotRevision: 1,
			hash: digest,
			rawDigest: digest,
			bytes: bytes.byteLength,
			createdAt: Date.now(),
		}),
	);
	expect(recovered?.status).toBe("saved");
	expect(
		await withRemoteWorkspaceHistoryRuntime(registry, () =>
			adapter.queryOperation({ ...actor, userId: "bob" }, requestId),
		),
	).toBeNull();
});

test("two files in one native scope restore and finalize through exactly one batch operation", async () => {
	const prepared = await preparedRemoteHistoryDelete(true);
	expect(prepared.preview.plan.expectedFileCount).toBe(2);
	const result = await prepared.service.execute(prepared.request).whenSettled;
	expect(result.reason).toBeNull();
	expect(result.status).toBe("committed");
	const batches = [...native.receipts.values()].filter((receipt) => receipt.kind === "restore");
	expect(batches).toHaveLength(1);
	expect(batches[0].effects).toHaveLength(2);
	expect(batches[0].state).toBe("finalized");
	expect(Buffer.from(native.files.get("a.txt") as Uint8Array).toString()).toBe("old\n");
	expect(Buffer.from(native.files.get("b.txt") as Uint8Array).toString()).toBe("second-old\n");
});

test("a failed two-file history commit uses exactly one native conditional batch compensation", async () => {
	const prepared = await preparedRemoteHistoryDelete(true);
	const failure = spyOn(
		RevertHistoryCommitService.prototype,
		"applyToTransaction",
	).mockImplementation(() => {
		throw new Error("Injected batch COW failure");
	});
	try {
		const result = await prepared.service.execute(prepared.request).whenSettled;
		expect(result.status).toBe("compensated");
		const receipts = [...native.receipts.values()].filter(
			(receipt) => receipt.kind === "compensate",
		);
		expect(receipts).toHaveLength(1);
		expect(receipts[0].effects).toHaveLength(2);
		expect(Buffer.from(native.files.get("a.txt") as Uint8Array).toString()).toBe("new\n");
		expect(Buffer.from(native.files.get("b.txt") as Uint8Array).toString()).toBe("second-new\n");
	} finally {
		failure.mockRestore();
	}
});

for (const flavor of ["posix", "windows"] as const)
	for (const tool of ["Write", "StructSed"] as const)
		test(`${flavor} ${tool} admits a granted outside-cwd file into its own real scope`, async () => {
			native.setPathFlavor(flavor);
			const cwd = flavor === "windows" ? "C:\\repo" : "/remote/repo";
			const path = flavor === "windows" ? "C:\\approved\\out\\a.txt" : "/approved/out/a.txt";
			const ctx = await context(tool, path, cwd);
			const result = await withRemoteWorkspaceHistoryRuntime(registry, () =>
				tool === "Write"
					? writeTool.execute({ file_path: path, content: "new\n" }, ctx)
					: structSedTool.execute(
							{
								file_path: path,
								command: "substitute",
								address: "1",
								pattern: "old",
								replacement: "new",
								dry_run: false,
							},
							ctx,
						),
			);
			if (result.isError) throw new Error(result.output);
			const operation = db.select().from(schema.fileChangeOperations).limit(2).all()[0];
			const effect = registry.evidence.listEffects(operation.id, { limit: 2 }).items[0];
			const scope = registry.evidence.getScope(effect.scopeId);
			expect(scope?.canonicalRoot).toBe(native.backend.paths.dirname(path));
			expect(scope?.canonicalRoot).not.toBe(cwd);
			expect(effect.identityJson.canonicalPath).toBe(path);
			expect(effect.identityJson.pathFlavor).toBe(flavor);
			expect(effect.executionConfirmed).toBe(true);
			expect(native.plainWrites).toBe(0);
			const row = db
				.select({ cwd: schema.narratorToolCalls.executionCwd })
				.from(schema.narratorToolCalls)
				.where(eq(schema.narratorToolCalls.id, ctx.toolCallBinding?.toolCallId as string))
				.get();
			expect(row?.cwd).toBe(cwd);
			const endpoint = await registry.resolve(
				{ userId: "alice", narratorId: "narrator", projectId: null, kind: "human" },
				{
					deviceId: "remote-device",
					cwd: scope?.canonicalRoot as string,
					lexicalPath: path,
					canonicalPath: path,
					runtimeGeneration: 7,
				},
				"read",
				AbortSignal.timeout(5_000),
				effect.identityJson,
			);
			await expect(
				endpoint.runtime.history.captureTree(
					{
						binding: endpoint.runtime.history.binding,
						operationId: "ungranted-parent-tree",
						requestDigest: hash("ungranted"),
					},
					AbortSignal.timeout(5_000),
				),
			).rejects.toThrow();
		});

test("a committed two-file batch with a lost finalize reply recovers only its original native lease", async () => {
	const prepared = await preparedRemoteHistoryDelete(true);
	native.loseFinalizeReply();
	const result = await prepared.service.execute(prepared.request).whenSettled;
	expect(result.status).toBe("committed");
	expect(result.reason).toBe("REMOTE_FINALIZE_REQUIRED");
	const count = native.calls.filter((kind) => kind === "restore").length;
	native.clearTransportFault();
	native.setGeneration(8);
	const recovery = await reconcileRemoteRevertPlan({
		registry,
		principal: { userId: "alice", isAdmin: false },
		narratorId: "narrator",
		planId: prepared.preview.plan.id,
		planHash: prepared.preview.plan.planHash as string,
		signal: AbortSignal.timeout(10_000),
	});
	expect(recovery.reason).toBeUndefined();
	expect(recovery.status).toBe("committed");
	expect(recovery.barrierReleased).toBe(true);
	expect(native.calls.filter((kind) => kind === "restore")).toHaveLength(count);
	expect(native.calls).not.toContain("compensate");
	expect(
		db
			.select()
			.from(schema.workspaceWriteLeases)
			.where(
				and(
					eq(schema.workspaceWriteLeases.deviceId, "remote-device"),
					eq(schema.workspaceWriteLeases.status, "quarantined"),
				),
			)
			.limit(2)
			.all(),
	).toHaveLength(0);
});
