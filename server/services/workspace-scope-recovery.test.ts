import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FILE_CHANGE_LIMITS,
	type FileChangeActor,
	type FileChangeExecutionBinding,
	type FileChangeState,
} from "@shared/file-change-protocol";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
	fileChangeBlobs,
	fileChangeEffects,
	fileChangeOperations,
	fileChangeScopeRecoveries,
	fileChangeScopes,
	fileChangeStorageBudgets,
	users,
} from "../db/schema";
import { generateId } from "../lib/id";
import { FILE_CHANGE_BLOB_BUDGET_ID } from "./file-change-blob-catalog";
import {
	type BeginFileChangeOperation,
	FileChangeEvidenceService,
	type FileChangeScopeRecord,
	type PrepareFileChangeEffect,
} from "./file-change-evidence";
import { createFileChangeIdentity } from "./file-change-identity";
import { fileChangeLocalIo } from "./file-change-local-io";
import { createWorkspaceScopeRecovery } from "./workspace-scope-recovery";
import {
	createWorkspaceWriteCoordinatorState,
	WorkspaceWriteCoordinator,
} from "./workspace-write-coordinator";

/**
 * Recovery-service tests run on the preload-isolated shared DB with
 * source-scoped cleanup, mirroring file-change-evidence.test.ts. The runtime
 * is a REAL evidence service plus a REAL coordinator with fresh in-memory
 * state; only the filesystem workspace is a temp directory.
 */

let root: string;
let service: FileChangeEvidenceService;
let coordinator: WorkspaceWriteCoordinator;
let recovery: ReturnType<typeof createWorkspaceScopeRecovery>;
let scope: FileChangeScopeRecord;
let source: string;
let binding: FileChangeExecutionBinding;
let actor: FileChangeActor;
let blobIds: string[];
let oldBudget: typeof fileChangeStorageBudgets.$inferSelect | undefined;
let clock: number;
const ABSENT: FileChangeState = { kind: "absent" };
const USER_ID = "recovery-admin";

beforeEach(async () => {
	expect(process.env.NARRAFORK_TEST).toBe("1");
	clock = Date.parse("2026-09-07T00:00:00.000Z");
	root = await mkdtemp(join(tmpdir(), "scope-recovery-test-"));
	service = new FileChangeEvidenceService(db, () => new Date(clock++).toISOString());
	coordinator = new WorkspaceWriteCoordinator({
		db,
		state: createWorkspaceWriteCoordinatorState(),
		readRuntime: () => null,
	});
	recovery = createWorkspaceScopeRecovery({
		database: db,
		getRuntime: async () => ({ coordinator, evidence: service }),
	});
	source = `recovery-test-${generateId()}`;
	blobIds = [];
	db.insert(users)
		.values({
			id: USER_ID,
			username: `recovery-admin-${generateId()}`,
			passwordHash: "not-a-real-hash",
			role: "admin",
			createdAt: new Date(clock).toISOString(),
		})
		.run();
	binding = {
		deviceId: "local",
		runtimeEpoch: "executor-test",
		runtimeGeneration: 1,
		fencingToken: 0,
	};
	actor = {
		kind: "primary",
		subjectKey: `${source}:author`,
		narratorId: null,
		userId: null,
		label: "Author",
		deleted: false,
		parentSubjectKey: null,
	};
	oldBudget = db
		.select()
		.from(fileChangeStorageBudgets)
		.where(eq(fileChangeStorageBudgets.id, FILE_CHANGE_BLOB_BUDGET_ID))
		.get();
	if (oldBudget) {
		db.update(fileChangeStorageBudgets)
			.set({ status: "ready" })
			.where(eq(fileChangeStorageBudgets.id, FILE_CHANGE_BLOB_BUDGET_ID))
			.run();
	} else {
		db.insert(fileChangeStorageBudgets)
			.values({
				id: FILE_CHANGE_BLOB_BUDGET_ID,
				namespaceKey: "isolated-recovery-tests",
				status: "ready",
				quotaBytes: FILE_CHANGE_LIMITS.blobSoftQuotaBytes,
				updatedAt: new Date(clock).toISOString(),
			})
			.run();
	}
	scope = service.prepareScope({
		sourceInstanceId: source,
		deviceId: "local",
		workspaceInstanceId: generateId(),
		pathFlavor: "posix",
		canonicalRoot: root,
	});
});

afterEach(async () => {
	db.delete(fileChangeScopeRecoveries)
		.where(inArray(fileChangeScopeRecoveries.scopeId, scopeIds()))
		.run();
	const operations = db
		.select({ id: fileChangeOperations.id })
		.from(fileChangeOperations)
		.where(eq(fileChangeOperations.sourceInstanceId, source))
		.all();
	if (operations.length) {
		db.delete(fileChangeEffects)
			.where(
				inArray(
					fileChangeEffects.operationId,
					operations.map((row) => row.id),
				),
			)
			.run();
	}
	db.delete(fileChangeOperations).where(eq(fileChangeOperations.sourceInstanceId, source)).run();
	db.delete(fileChangeScopes).where(eq(fileChangeScopes.sourceInstanceId, source)).run();
	if (blobIds.length) db.delete(fileChangeBlobs).where(inArray(fileChangeBlobs.id, blobIds)).run();
	if (oldBudget) {
		db.update(fileChangeStorageBudgets)
			.set(oldBudget)
			.where(eq(fileChangeStorageBudgets.id, FILE_CHANGE_BLOB_BUDGET_ID))
			.run();
	} else {
		db.delete(fileChangeStorageBudgets)
			.where(eq(fileChangeStorageBudgets.id, FILE_CHANGE_BLOB_BUDGET_ID))
			.run();
	}
	db.delete(users).where(eq(users.id, USER_ID)).run();
	await rm(root, { recursive: true, force: true });
});

function scopeIds() {
	return db
		.select({ id: fileChangeScopes.id })
		.from(fileChangeScopes)
		.where(eq(fileChangeScopes.sourceInstanceId, source))
		.all()
		.map((row) => row.id);
}

function hash(value: string | Uint8Array) {
	return createHash("sha256").update(value).digest("hex");
}

function blobState(
	digest: string,
	sizeBytes: number,
	mode: number | null = 0o644,
): FileChangeState {
	const id = generateId();
	blobIds.push(id);
	db.insert(fileChangeBlobs)
		.values({
			id,
			digest,
			sizeBytes,
			status: "ready",
			storageKey: `${digest.slice(0, 2)}/${digest}`,
			createdAt: new Date(clock).toISOString(),
			updatedAt: new Date(clock).toISOString(),
		})
		.run();
	return { kind: "regular", blob: { algorithm: "sha256", digest, sizeBytes }, mode };
}

/** A state guaranteed to equal the physical file (same digest AND mode). */
async function stateOf(path: string): Promise<FileChangeState> {
	const observed = await fileChangeLocalIo.read(path);
	if (observed.bytes === null) throw new Error("Fixture file is absent");
	return blobState(hash(observed.bytes), observed.bytes.byteLength, observed.mode);
}

function activate(target = scope) {
	const verified = service.recordScopeVerification({
		scopeId: target.id,
		canonicalRoot: target.canonicalRoot,
		rootIdentity: { inode: `inode-${target.id}` },
	});
	if (target.id === scope.id) scope = verified;
	return verified;
}

/** Mirror a crashed write's durable barrier: quarantine + dead-epoch lease. */
function quarantine(target = scope) {
	db.update(fileChangeScopes)
		.set({
			status: "needs_verification",
			activeLeaseId: "dead-lease",
			activeLeaseEpoch: "dead-epoch",
			activeLeaseStartedAt: "2026-09-07T00:00:00.000Z",
			activeMutationCount: 1,
		})
		.where(eq(fileChangeScopes.id, target.id))
		.run();
}

function operationInput(
	overrides: Partial<BeginFileChangeOperation> = {},
): BeginFileChangeOperation {
	return {
		sourceInstanceId: source,
		sourceKind: "tool",
		sourceId: generateId(),
		attempt: 1,
		requestDigest: hash(generateId()),
		expectedEffectCount: 1,
		actor,
		executionBinding: binding,
		...overrides,
	};
}

function effectInput(
	name: string,
	before: FileChangeState,
	intendedAfter: FileChangeState,
): PrepareFileChangeEffect {
	return {
		identity: createFileChangeIdentity(scope, {
			deviceId: scope.deviceId,
			pathFlavor: scope.pathFlavor,
			objectRole: "referent",
			lexicalPath: join(scope.canonicalRoot, name),
			canonicalPath: join(scope.canonicalRoot, name),
		}),
		scopeRevision: scope.revision,
		requestDigest: hash(name),
		before,
		intendedAfter,
	};
}

/** A prepared-and-dispatched effect (settlement "applying", never settled). */
async function dispatchedEffect(name: string, before: FileChangeState, after: FileChangeState) {
	activate();
	const operation = service.beginOperation(operationInput());
	const [effect] = service.prepareEffects(operation.id, [effectInput(name, before, after)]);
	if (!effect) throw new Error("Missing prepared fixture");
	await service.finalizePreparation(operation.id);
	service.markApplying({
		operationId: effect.operationId,
		mutationId: effect.mutationId,
		requestDigest: effect.requestDigest,
		executionBinding: binding,
	});
	return { operation, effect };
}

function scopeRow(id = scope.id) {
	return db.select().from(fileChangeScopes).where(eq(fileChangeScopes.id, id)).get();
}

function effectRow(id: string) {
	return db.select().from(fileChangeEffects).where(eq(fileChangeEffects.id, id)).get();
}

function operationRow(id: string) {
	return db.select().from(fileChangeOperations).where(eq(fileChangeOperations.id, id)).get();
}

function auditRows(scopeId = scope.id) {
	return db
		.select()
		.from(fileChangeScopeRecoveries)
		.where(eq(fileChangeScopeRecoveries.scopeId, scopeId))
		.all();
}

describe("workspace barrier observation", () => {
	test("not_applied when the physical file matches the before state", async () => {
		const intended = blobState(hash("intended"), 8);
		const { effect } = await dispatchedEffect("a.txt", ABSENT, intended);
		const { observations } = await recovery.observeWorkspaceBarrier(scope.id);
		expect(observations).toHaveLength(1);
		expect(observations[0]).toMatchObject({
			effectId: effect.id,
			verdict: "not_applied",
			actualKind: "absent",
			observedDigest: null,
		});
	});

	test("applied when the physical file matches the intended state", async () => {
		const path = join(root, "b.txt");
		await writeFile(path, "landed");
		const intended = await stateOf(path);
		const { effect } = await dispatchedEffect("b.txt", ABSENT, intended);
		const { observations } = await recovery.observeWorkspaceBarrier(scope.id);
		expect(observations[0]).toMatchObject({ effectId: effect.id, verdict: "applied" });
		expect(observations[0]?.observedDigest).toBe(hash("landed"));
	});

	test("foreign when the physical file matches neither state", async () => {
		const path = join(root, "c.txt");
		await writeFile(path, "someone else");
		const intended = blobState(hash("intended"), 8);
		await dispatchedEffect("c.txt", ABSENT, intended);
		const { observations } = await recovery.observeWorkspaceBarrier(scope.id);
		expect(observations[0]?.verdict).toBe("foreign");
	});

	test("not_dispatched for an effect that never reached IO", async () => {
		activate();
		const operation = service.beginOperation(operationInput());
		const [effect] = service.prepareEffects(operation.id, [
			effectInput("d.txt", ABSENT, blobState(hash("x"), 1)),
		]);
		if (!effect) throw new Error("Missing prepared fixture");
		await service.finalizePreparation(operation.id);
		const { observations } = await recovery.observeWorkspaceBarrier(scope.id);
		expect(observations[0]).toMatchObject({ verdict: "not_dispatched" });
	});

	test("remote device scopes cannot be observed", async () => {
		const remote = service.prepareScope({
			sourceInstanceId: source,
			deviceId: "remote-device",
			workspaceInstanceId: generateId(),
			pathFlavor: "posix",
			canonicalRoot: "/elsewhere",
		});
		await expect(recovery.observeWorkspaceBarrier(remote.id)).rejects.toThrow(
			expect.objectContaining({ code: "REMOTE_DEVICE_UNSUPPORTED" }),
		);
	});
});

describe("workspace barrier recovery", () => {
	test("closes the books and clears the barrier with matching acknowledgements", async () => {
		const intended = blobState(hash("intended"), 8);
		const { operation, effect } = await dispatchedEffect("a.txt", ABSENT, intended);
		quarantine();
		const before = scopeRow();
		const { observations } = await recovery.observeWorkspaceBarrier(scope.id);
		const result = await recovery.recoverWorkspaceBarrier({
			scopeId: scope.id,
			recoveredByUserId: USER_ID,
			acknowledgements: observations.map((entry) => ({
				effectId: entry.effectId,
				verdict: entry.verdict,
			})),
		});
		expect(result).toMatchObject({
			recovered: "barrier_cleared",
			settledEffectCount: 1,
			revision: (before?.revision ?? 0) + 1,
			fencingToken: (before?.fencingToken ?? 0) + 1,
		});
		expect(scopeRow()).toMatchObject({
			status: "active",
			activeLeaseId: null,
			activeLeaseEpoch: null,
			activeMutationCount: 0,
		});
		// not_applied verdict → no_change; frozen receipt fields stay untouched.
		expect(effectRow(effect.id)).toMatchObject({ settlement: "settled", outcome: "no_change" });
		expect(operationRow(operation.id)).toMatchObject({
			settlement: "settled",
			settledEffectCount: 1,
			unresolvedEffectCount: 0,
			effectOutcome: "no_change",
		});
		const audit = auditRows();
		expect(audit).toHaveLength(1);
		expect(audit[0]).toMatchObject({
			recoveredByUserId: USER_ID,
			canonicalRoot: root,
			scopeRevisionBefore: before?.revision,
			fencingTokenBefore: before?.fencingToken,
		});
		expect(audit[0]?.effectDecisionsJson).toEqual([
			expect.objectContaining({ effectId: effect.id, verdict: "not_applied" }),
		]);
	});

	test("applied verdict settles as changed; foreign settles as unknown", async () => {
		const landedPath = join(root, "landed.txt");
		await writeFile(landedPath, "landed");
		const foreignPath = join(root, "foreign.txt");
		await writeFile(foreignPath, "other bytes");
		activate();
		const operation = service.beginOperation(operationInput({ expectedEffectCount: 2 }));
		const effects = service.prepareEffects(operation.id, [
			effectInput("landed.txt", ABSENT, await stateOf(landedPath)),
			effectInput("foreign.txt", ABSENT, blobState(hash("intended"), 8)),
		]);
		expect(effects).toHaveLength(2);
		await service.finalizePreparation(operation.id);
		for (const effect of effects) {
			service.markApplying({
				operationId: effect.operationId,
				mutationId: effect.mutationId,
				requestDigest: effect.requestDigest,
				executionBinding: binding,
			});
		}
		quarantine();
		const { observations } = await recovery.observeWorkspaceBarrier(scope.id);
		expect(observations.map((entry) => entry.verdict).sort()).toEqual(["applied", "foreign"]);
		await recovery.recoverWorkspaceBarrier({
			scopeId: scope.id,
			recoveredByUserId: USER_ID,
			acknowledgements: observations.map((entry) => ({
				effectId: entry.effectId,
				verdict: entry.verdict,
			})),
		});
		expect(effectRow(effects[0]?.id ?? "")).toMatchObject({
			settlement: "settled",
			outcome: "changed",
		});
		expect(effectRow(effects[1]?.id ?? "")).toMatchObject({
			settlement: "settled",
			outcome: "unknown",
		});
		expect(operationRow(operation.id)).toMatchObject({
			settlement: "settled",
			effectOutcome: "unknown",
		});
	});

	test("rejects mismatched acknowledgements and missing ones", async () => {
		const intended = blobState(hash("intended"), 8);
		const { effect } = await dispatchedEffect("a.txt", ABSENT, intended);
		quarantine();
		await expect(
			recovery.recoverWorkspaceBarrier({
				scopeId: scope.id,
				recoveredByUserId: USER_ID,
				acknowledgements: [],
			}),
		).rejects.toThrow(expect.objectContaining({ code: "ACK_REQUIRED" }));
		await expect(
			recovery.recoverWorkspaceBarrier({
				scopeId: scope.id,
				recoveredByUserId: USER_ID,
				acknowledgements: [{ effectId: effect.id, verdict: "applied" }],
			}),
		).rejects.toThrow(expect.objectContaining({ code: "OBSERVATION_CHANGED" }));
		// Nothing was settled and the barrier still stands.
		expect(effectRow(effect.id)?.settlement).toBe("applying");
		expect(scopeRow()?.status).toBe("needs_verification");
	});

	test("a barrier without effects requires an explicit inspection acknowledgement", async () => {
		activate();
		quarantine();
		await expect(
			recovery.recoverWorkspaceBarrier({
				scopeId: scope.id,
				recoveredByUserId: USER_ID,
				acknowledgements: [],
			}),
		).rejects.toThrow(expect.objectContaining({ code: "ACK_REQUIRED" }));
		const result = await recovery.recoverWorkspaceBarrier({
			scopeId: scope.id,
			recoveredByUserId: USER_ID,
			acknowledgements: [],
			acknowledgeInspected: true,
		});
		expect(result).toMatchObject({ recovered: "barrier_cleared", settledEffectCount: 0 });
		expect(scopeRow()?.status).toBe("active");
		expect(auditRows()[0]?.effectDecisionsJson).toEqual([]);
	});

	test("an unverified root is re-measured instead of closing books", async () => {
		// prepareScope leaves needs_verification + null root identity: the barrier
		// kind that a crash between preparation and verification would leave.
		const result = await recovery.recoverWorkspaceBarrier({
			scopeId: scope.id,
			recoveredByUserId: USER_ID,
			acknowledgements: [],
		});
		expect(result).toMatchObject({ recovered: "root_verified", settledEffectCount: 0 });
		expect(scopeRow()?.status).toBe("active");
		expect(scopeRow()?.rootIdentityJson).not.toBeNull();
	});

	test("a recovered scope leaves the barrier list; live-epoch leases never enter it", async () => {
		const intended = blobState(hash("intended"), 8);
		await dispatchedEffect("a.txt", ABSENT, intended);
		quarantine();
		// A second scope whose lease belongs to THIS live epoch is ordinary work.
		const alive = service.prepareScope({
			sourceInstanceId: source,
			deviceId: "local",
			workspaceInstanceId: generateId(),
			pathFlavor: "posix",
			canonicalRoot: "/elsewhere-live",
		});
		// Root-verified (active) so only the live lease can keep it off the list.
		service.recordScopeVerification({
			scopeId: alive.id,
			canonicalRoot: alive.canonicalRoot,
			rootIdentity: { inode: `inode-${alive.id}` },
		});
		db.update(fileChangeScopes)
			.set({
				activeLeaseId: "live-lease",
				activeLeaseEpoch: coordinator.ownerEpoch(),
				activeLeaseStartedAt: "2026-09-07T00:00:00.000Z",
				activeMutationCount: 1,
			})
			.where(eq(fileChangeScopes.id, alive.id))
			.run();
		const listed = await recovery.listWorkspaceBarriers();
		const ids = listed.items.map((item) => item.scope.id);
		expect(ids).toContain(scope.id);
		expect(ids).not.toContain(alive.id);
		const barrier = listed.items.find((item) => item.scope.id === scope.id);
		expect(barrier).toMatchObject({ kind: "quarantined", local: true });
		expect(barrier?.effects).toHaveLength(1);
		expect(barrier?.operations[0]).toMatchObject({ sourceKind: "tool" });

		const { observations } = await recovery.observeWorkspaceBarrier(scope.id);
		await recovery.recoverWorkspaceBarrier({
			scopeId: scope.id,
			recoveredByUserId: USER_ID,
			acknowledgements: observations.map((entry) => ({
				effectId: entry.effectId,
				verdict: entry.verdict,
			})),
		});
		const after = await recovery.listWorkspaceBarriers();
		expect(after.items.map((item) => item.scope.id)).not.toContain(scope.id);
	});
});
