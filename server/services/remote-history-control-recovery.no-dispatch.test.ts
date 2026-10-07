import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	RemoteHistoryBinding,
	RemoteHistoryOperations,
	RemoteHistoryReceipt,
	RemoteHistoryRequest,
} from "@shared/remote-history-protocol";
import { remoteHistoryFileState } from "@shared/remote-history-protocol";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqlite as isolatedTemplate } from "../db";
import * as relations from "../db/relations";
import * as schema from "../db/schema";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import { localBackend } from "../lib/agent/execution/local-backend";
import { targetPathSemantics } from "../lib/agent/execution/path-semantics";
import { createFileChangeIdentity } from "./file-change-identity";
import { LocalFileChangeRuntime } from "./file-change-runtime";
import { reconcileRemoteFileOperation } from "./remote-history-control-recovery";
import {
	createPersistentRemoteHistoryJournal,
	SQLiteRemoteHistoryMetadataStore,
} from "./remote-history-journal";
import { RemoteHistoryService, remoteHistoryObjectId } from "./remote-history-service";
import { RemoteWorkspaceHistoryRuntime } from "./remote-workspace-history-runtime";
import { createWorkspaceWriteCoordinatorState } from "./workspace-write-coordinator";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
	expect(process.env.NARRAFORK_TEST).toBe("1");
	const directory = await mkdtemp(join(tmpdir(), "remote-refusal-recovery-"));
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;");
	cleanups.push(async () => {
		sqlite.close();
		await rm(directory, { recursive: true, force: true });
	});
	for (const row of isolatedTemplate
		.query<{ sql: string }, []>(
			"SELECT sql FROM sqlite_master WHERE type IN ('table','index') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '*_fts*' ORDER BY type DESC LIMIT 2048",
		)
		.all())
		sqlite.exec(row.sql);
	const db = drizzle({ client: sqlite, schema: { ...schema, ...relations } });
	const now = new Date().toISOString();
	db.insert(schema.users)
		.values({ id: "alice", username: "alice", passwordHash: "test-only", createdAt: now })
		.run();
	db.insert(schema.narrators)
		.values({
			id: "narrator",
			ownerUserId: "alice",
			cwd: "/remote/repo",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	let binding: RemoteHistoryBinding;
	let nativeReceipt: RemoteHistoryReceipt | undefined;
	let authorized = true;
	let generation = 7;
	const calls: string[] = [];
	const backend = Object.assign(Object.create(localBackend) as ExecutionBackend, {
		kind: "remote" as const,
		deviceId: "remote-device",
		pathFlavor: "posix" as const,
		paths: targetPathSemantics("posix"),
		supportsRemoteHistory: true,
		async resolvePathIdentity(path: string) {
			return { canonicalPath: path, lexicalPath: path, runtimeGeneration: generation };
		},
		async remoteHistory<K extends keyof RemoteHistoryOperations>(
			kind: K,
			request: RemoteHistoryOperations[K]["request"],
		): Promise<RemoteHistoryOperations[K]["result"]> {
			calls.push(kind);
			if (kind === "open") return { ...binding } as RemoteHistoryOperations[K]["result"];
			if (kind === "status") {
				if (!nativeReceipt) throw new Error("Missing native receipt");
				return structuredClone(nativeReceipt) as RemoteHistoryOperations[K]["result"];
			}
			if (kind === "mutate") {
				const input = request as RemoteHistoryRequest;
				nativeReceipt = structuredClone<RemoteHistoryReceipt>({
					binding: input.binding,
					operationId: input.operationId,
					requestDigest: input.requestDigest,
					payloadDigest: hash("native payload"),
					kind: "mutate",
					state: "rejected",
					reason: "unsupported_cross_filesystem",
					startedAt: now,
					finishedAt: now,
					effects: (input.changes ?? []).map((change) => ({
						path: change.path,
						before: change.expected,
						intended: change.desired,
						outcome: "pending",
					})),
				});
				throw new Error("native refusal is durable but response was lost");
			}
			throw new Error(`Unexpected IO primitive during no-dispatch recovery: ${kind}`);
		},
	});
	Object.defineProperty(backend, "runtimeGeneration", { get: () => generation });
	const registry = new RemoteWorkspaceHistoryRuntime({
		db,
		auditRuntime: new LocalFileChangeRuntime({
			db,
			privateRoot: join(directory, "private"),
			blobStoreOptions: { minimumFreeBytes: 0 },
			coordinatorState: createWorkspaceWriteCoordinatorState(),
		}),
		backend: () => backend,
		metadataStore: new SQLiteRemoteHistoryMetadataStore(db),
		async authorize(actor, target, _need, signal) {
			signal.throwIfAborted();
			if (
				!authorized ||
				actor.userId !== "alice" ||
				actor.narratorId !== "narrator" ||
				target.deviceId !== "remote-device"
			)
				throw new Error("Live authority revoked");
		},
	});
	let scope = registry.evidence.prepareScope({
		sourceInstanceId: "native-source",
		deviceId: "remote-device",
		workspaceInstanceId: "native-workspace",
		pathFlavor: "posix",
		canonicalRoot: "/remote/repo",
	});
	scope = registry.evidence.recordScopeVerification({
		scopeId: scope.id,
		canonicalRoot: scope.canonicalRoot,
		rootIdentity: { object: "original-root" },
	});
	const identity = createFileChangeIdentity(scope, {
		deviceId: scope.deviceId,
		pathFlavor: scope.pathFlavor,
		canonicalPath: "/remote/repo/file.txt",
		lexicalPath: "/remote/repo/file.txt",
		objectRole: "referent",
	});
	const digest = hash("old bytes");
	const namespace = await registry.auditNamespace(AbortSignal.timeout(5_000));
	await namespace.store.putBytes(Buffer.from("old bytes"), {
		signal: AbortSignal.timeout(5_000),
		expectedSize: 9,
	});
	const object = {
		sourceInstanceId: scope.sourceInstanceId,
		workspaceInstanceId: scope.workspaceInstanceId,
		scopeId: scope.id,
		path: "file.txt",
		algorithm: "sha256" as const,
		digest,
		sizeBytes: 9,
		kind: "blob" as const,
		objectId: remoteHistoryObjectId(scope.id, "blob", digest, "file.txt"),
	};
	const before = {
		kind: "regular" as const,
		object,
		metadata: { ...object },
		mode: 0o640,
		incarnation: "original-inode",
	};
	const operationDigest = hash("original request");
	let operationId = "";
	let mutationId = "";
	const runtime = registry.runtimeBinding(scope.deviceId);
	if (!runtime) throw new Error("Missing original runtime");
	await expect(
		registry.coordinator.withWrite(
			{
				scope,
				runtime,
				executionClass: "unknown",
				ranges: [{ canonicalPath: scope.canonicalRoot, kind: "subtree" }],
				signal: AbortSignal.timeout(5_000),
			},
			async (lease) => {
				binding = {
					sourceInstanceId: scope.sourceInstanceId,
					workspaceInstanceId: scope.workspaceInstanceId,
					scopeId: scope.id,
					root: scope.canonicalRoot,
					rootIdentity: "original-root",
					fence: lease.executionBinding.fencingToken,
				};
				const operation = registry.evidence.beginOperation({
					sourceInstanceId: scope.sourceInstanceId,
					sourceKind: "editor",
					sourceId: "native-op",
					attempt: 1,
					requestDigest: operationDigest,
					expectedEffectCount: 1,
					ownerUserId: "alice",
					narratorId: "narrator",
					projectId: null,
					actor: {
						kind: "human",
						subjectKey: "human:alice",
						userId: "alice",
						narratorId: null,
						label: null,
						deleted: false,
						parentSubjectKey: null,
					},
					executionBinding: lease.executionBinding,
				});
				const effect = registry.evidence.prepareEffects(operation.id, [
					{
						identity,
						scopeRevision: lease.scopeRevision,
						requestDigest: operationDigest,
						before: remoteHistoryFileState(before),
						intendedAfter: { kind: "absent" },
					},
				])[0];
				operationId = operation.id;
				mutationId = effect.mutationId;
				await registry.evidence.finalizePreparation(operation.id, {
					signal: AbortSignal.timeout(5_000),
				});
				registry.evidence.markApplying({
					operationId,
					mutationId,
					requestDigest: operationDigest,
					executionBinding: lease.executionBinding,
				});
				lease.registerMutation(mutationId, { operationId, effectId: effect.id });
				const service = new RemoteHistoryService(
					backend,
					binding,
					createPersistentRemoteHistoryJournal(scope.deviceId, binding, {
						store: new SQLiteRemoteHistoryMetadataStore(db),
					}),
				);
				await service.dispatch("mutate", {
					binding,
					operationId: "native-op",
					requestDigest: operationDigest,
					changes: [{ path: "file.txt", expected: before, desired: { kind: "absent" } }],
				});
			},
		),
	).rejects.toThrow("unknown");
	return {
		db,
		registry,
		scope,
		operationId,
		mutationId,
		calls,
		get nativeReceipt() {
			if (!nativeReceipt) throw new Error("No native proof");
			return nativeReceipt;
		},
		setGeneration(value: number) {
			generation = value;
		},
		revoke() {
			authorized = false;
		},
	};
}

test("lost rejected reply reopens only its original private proof and releases original lease", async () => {
	const f = await fixture();
	expect(f.db.select().from(schema.remoteHistoryReceipts).get()?.state).toBe("unknown");
	expect(f.db.select().from(schema.workspaceWriteLeases).get()?.status).toBe("quarantined");
	f.setGeneration(8);
	const recovered = await reconcileRemoteFileOperation({
		registry: f.registry,
		principal: { userId: "alice", isAdmin: false },
		operationId: f.operationId,
		signal: AbortSignal.timeout(5_000),
	});
	expect(recovered).toMatchObject({ state: "rejected", barrierReleased: true });
	expect(f.db.select().from(schema.remoteHistoryReceipts).get()?.state).toBe("rejected");
	expect(f.registry.evidence.getOperation(f.operationId)).toMatchObject({
		executionOutcome: "failed",
		settlement: "settled",
	});
	expect(f.registry.evidence.getEffect(f.operationId, f.mutationId)).toMatchObject({
		settlement: "settled",
		executionConfirmed: true,
		executionReceiptJson: { outcome: "not_applied" },
		observedAfterStateJson: { kind: "unknown" },
	});
	expect(f.db.select().from(schema.workspaceWriteLeases).get()?.status).toBe("recovered");
	expect(
		f.calls.filter((kind) =>
			["mutate", "restore", "compensate", "finalize", "inspect", "objectRead"].includes(kind),
		),
	).toEqual(["mutate"]);
	const scope = f.registry.evidence.getScope(f.scope.id);
	const runtime = f.registry.runtimeBinding(f.scope.deviceId);
	if (!scope || !runtime) throw new Error("Missing recovered scope/runtime");
	expect(scope.status).toBe("active");
	await expect(
		f.registry.coordinator.withWrite(
			{
				scope,
				runtime,
				signal: AbortSignal.timeout(5_000),
			},
			async () => "new-operation-admitted",
		),
	).resolves.toBe("new-operation-admitted");
});

for (const tamper of [
	"incarnation",
	"digest",
	"source",
	"original-intent",
	"authority",
	"extra-lease-target",
] as const)
	test(`mismatched rejected proof keeps original barrier: ${tamper}`, async () => {
		const f = await fixture();
		if (tamper === "incarnation" && f.nativeReceipt.effects[0].before.kind === "regular")
			f.nativeReceipt.effects[0].before.incarnation = "foreign-same-bytes-inode";
		if (tamper === "digest") f.nativeReceipt.requestDigest = hash("foreign");
		if (tamper === "source")
			f.nativeReceipt.binding = { ...f.nativeReceipt.binding, sourceInstanceId: "foreign" };
		if (tamper === "original-intent")
			f.db.update(schema.remoteHistoryReceipts).set({ intentJson: null }).run();
		if (tamper === "authority") f.revoke();
		if (tamper === "extra-lease-target") {
			const lease = f.db.select().from(schema.workspaceWriteLeases).get();
			if (!lease) throw new Error("Missing original lease");
			f.db
				.update(schema.workspaceWriteLeases)
				.set({
					mutationManifestJson: {
						...lease.mutationManifestJson,
						mutations: [
							...lease.mutationManifestJson.mutations,
							{ mutationId: "unrelated", outcome: "pending" },
						],
					},
				})
				.where(eq(schema.workspaceWriteLeases.leaseId, lease.leaseId))
				.run();
		}
		const recovered = await reconcileRemoteFileOperation({
			registry: f.registry,
			principal: { userId: "alice", isAdmin: false },
			operationId: f.operationId,
			signal: AbortSignal.timeout(5_000),
		});
		expect(recovered.barrierReleased).toBe(false);
		expect(f.db.select().from(schema.workspaceWriteLeases).get()?.status).toBe("quarantined");
		if (tamper !== "extra-lease-target")
			expect(f.db.select().from(schema.remoteHistoryReceipts).get()?.state).toBe("unknown");
	});
