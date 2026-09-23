import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
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
	workspaceExecutionOwners,
	workspaceWriteLeases,
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
import * as ownerAuthority from "./workspace-execution-owner";
import { createWorkspaceScopeRecovery } from "./workspace-scope-recovery";
import {
	createWorkspaceWriteCoordinatorState,
	WORKSPACE_WRITE_COORDINATOR_LIMITS,
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
		readRuntime: () => binding,
	});
	recovery = createWorkspaceScopeRecovery({
		database: db,
		getRuntime: async () => ({ coordinator, evidence: service }),
		assertMaintenanceAuthority: () => {},
		now: () => clock,
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
	db.delete(workspaceWriteLeases).where(inArray(workspaceWriteLeases.scopeId, scopeIds())).run();
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
			activeLeaseEpoch: coordinator.ownerEpoch(),
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
	quarantine();
	return { operation, effect };
}

async function recover(
	input: Omit<Parameters<typeof recovery.recoverWorkspaceBarrier>[0], "confirmationToken"> & {
		confirmationToken?: string;
	},
) {
	const preview = input.confirmationToken
		? null
		: await recovery.observeWorkspaceBarrier(input.scopeId, input.signal, input.leaseId);
	return recovery.recoverWorkspaceBarrier({
		...input,
		acknowledgeInspected: input.acknowledgeInspected ?? input.acknowledgements.length > 0,
		confirmationToken: input.confirmationToken ?? preview?.confirmationToken ?? "",
	});
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

function durableBarrier(
	effect?: NonNullable<ReturnType<typeof effectRow>>,
	ranges?: { kind: "file" | "subtree"; canonicalPath: string }[],
) {
	const leaseId = generateId();
	const timestamp = new Date(clock++).toISOString();
	db.insert(workspaceWriteLeases)
		.values({
			leaseId,
			scopeId: scope.id,
			deviceId: scope.deviceId,
			pathFlavor: scope.pathFlavor,
			ownerEpoch: coordinator.ownerEpoch(),
			runtimeEpoch: binding.runtimeEpoch,
			runtimeGeneration: binding.runtimeGeneration,
			fencingToken: scope.fencingToken,
			scopeRevision: scope.revision,
			status: "quarantined",
			executionEndedAt: timestamp,
			rangesJson: {
				version: 1,
				ranges: ranges ?? [
					{
						kind: "file",
						canonicalPath: effect?.identityJson.canonicalPath ?? join(root, "unknown.txt"),
					},
				],
			},
			mutationManifestJson: {
				version: 1,
				mutations: effect
					? [
							{
								mutationId: effect.mutationId,
								effectId: effect.id,
								operationId: effect.operationId,
								outcome: "unknown",
							},
						]
					: [],
			},
			createdAt: timestamp,
			updatedAt: timestamp,
		})
		.run();
	db.update(fileChangeScopes)
		.set({
			status: "active",
			activeLeaseId: null,
			activeLeaseEpoch: null,
			activeLeaseStartedAt: null,
			activeMutationCount: 0,
		})
		.where(eq(fileChangeScopes.id, scope.id))
		.run();
	return leaseId;
}

async function confirmedLeaseRecovery(leaseId: string) {
	const preview = await recovery.observeWorkspaceBarrier(scope.id, undefined, leaseId);
	return recovery.recoverWorkspaceBarrier({
		scopeId: scope.id,
		leaseId,
		recoveredByUserId: USER_ID,
		confirmationToken: preview.confirmationToken,
		acknowledgements: preview.observations.map(({ effectId, verdict }) => ({ effectId, verdict })),
		acknowledgeInspected: true,
	});
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
		quarantine();
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
		const result = await recover({
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
		await recover({
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
			recover({
				scopeId: scope.id,
				recoveredByUserId: USER_ID,
				acknowledgements: [],
			}),
		).rejects.toThrow(expect.objectContaining({ code: "ACK_REQUIRED" }));
		await expect(
			recover({
				scopeId: scope.id,
				recoveredByUserId: USER_ID,
				acknowledgements: [{ effectId: effect.id, verdict: "applied" }],
			}),
		).rejects.toThrow(expect.objectContaining({ code: "ACK_REQUIRED" }));
		// Nothing was settled and the barrier still stands.
		expect(effectRow(effect.id)?.settlement).toBe("applying");
		expect(scopeRow()?.status).toBe("needs_verification");
	});

	test("a barrier without effects requires an explicit inspection acknowledgement", async () => {
		activate();
		quarantine();
		await expect(
			recover({
				scopeId: scope.id,
				recoveredByUserId: USER_ID,
				acknowledgements: [],
			}),
		).rejects.toThrow(expect.objectContaining({ code: "ACK_REQUIRED" }));
		const result = await recover({
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
		const result = await recover({
			scopeId: scope.id,
			recoveredByUserId: USER_ID,
			acknowledgements: [],
		});
		expect(result).toMatchObject({ recovered: "root_verified", settledEffectCount: 0 });
		expect(scopeRow()?.status).toBe("active");
		expect(scopeRow()?.rootIdentityJson).not.toBeNull();
	});

	test("a recovered scope leaves the list; same-epoch completed registry leases remain recoverable", async () => {
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
		expect(ids).toContain(alive.id);
		const barrier = listed.items.find((item) => item.scope.id === scope.id);
		expect(barrier).toMatchObject({ kind: "quarantined", local: true });
		expect(barrier?.effects).toHaveLength(1);
		expect(barrier?.operations[0]).toMatchObject({ sourceKind: "tool" });

		const { observations } = await recovery.observeWorkspaceBarrier(scope.id);
		await recover({
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

describe("atomic lease recovery", () => {
	test("a final lease CAS failure rolls back effects, operations, audit and quarantine together", async () => {
		const { effect, operation } = await dispatchedEffect(
			"atomic.txt",
			ABSENT,
			blobState(hash("x"), 1),
		);
		const leaseId = durableBarrier(effect);
		const beforeEffect = effectRow(effect.id);
		const beforeOperation = operationRow(operation.id);
		const beforeScope = scopeRow();
		db.$client.run(
			`CREATE TEMP TRIGGER fail_recovery BEFORE UPDATE OF status ON workspace_write_leases WHEN NEW.lease_id = '${leaseId}' AND NEW.status = 'recovered' BEGIN SELECT RAISE(ABORT, 'injected recovery CAS failure'); END`,
		);
		try {
			await expect(confirmedLeaseRecovery(leaseId)).rejects.toThrow(
				"injected recovery CAS failure",
			);
		} finally {
			db.$client.run("DROP TRIGGER fail_recovery");
		}
		expect(effectRow(effect.id)).toEqual(beforeEffect);
		expect(operationRow(operation.id)).toEqual(beforeOperation);
		expect(scopeRow()).toEqual(beforeScope);
		expect(auditRows()).toEqual([]);
		expect(
			db.select().from(workspaceWriteLeases).where(eq(workspaceWriteLeases.leaseId, leaseId)).get()
				?.status,
		).toBe("quarantined");
		await confirmedLeaseRecovery(leaseId);
		expect(auditRows()[0]?.workspaceLeaseId).toBe(leaseId);
	});

	test("same-epoch completed registry ownership is recoverable without an ended timestamp", async () => {
		const { effect } = await dispatchedEffect("ended.txt", ABSENT, blobState(hash("x"), 1));
		const leaseId = durableBarrier(effect);
		db.update(workspaceWriteLeases)
			.set({ executionEndedAt: null })
			.where(eq(workspaceWriteLeases.leaseId, leaseId))
			.run();
		await confirmedLeaseRecovery(leaseId);
		expect(effectRow(effect.id)?.settlement).toBe("settled");
	});

	test("maintenance holds the whole scope across requests and audits attestation without death proof", async () => {
		const { effect } = await dispatchedEffect("maintenance.txt", ABSENT, blobState(hash("x"), 1));
		const leaseId = durableBarrier(effect);
		db.update(workspaceWriteLeases)
			.set({ executionEndedAt: null, ownerEpoch: "legacy-random" })
			.where(eq(workspaceWriteLeases.leaseId, leaseId))
			.run();
		const permit = await recovery.beginWorkspaceMaintenance({
			scopeId: scope.id,
			leaseId,
			adminUserId: USER_ID,
			acknowledgeWritersStopped: true,
			operatorReason: "Old instance and external writers stopped",
		});
		const input = {
			scopeId: scope.id,
			adminUserId: USER_ID,
			maintenanceToken: permit.maintenanceToken,
		};
		await expect(
			recovery.beginWorkspaceMaintenance({
				scopeId: scope.id,
				leaseId,
				adminUserId: USER_ID,
				acknowledgeWritersStopped: true,
				operatorReason: "duplicate",
			}),
		).rejects.toThrow();
		const preview = await recovery.observeWorkspaceMaintenance(input);
		expect(preview.rangeObservations.some((range) => range.canonicalPath === root)).toBe(true);
		const result = await recovery.commitWorkspaceMaintenance({
			...input,
			confirmationToken: preview.confirmationToken,
			acknowledgeInspected: true,
			acknowledgements: preview.observations.map(({ effectId, verdict }) => ({
				effectId,
				verdict,
			})),
		});
		expect(result.settledEffectCount).toBe(1);
		expect(auditRows()[0]).toMatchObject({
			resolutionAuthority: "administrator_attested",
			recoveredByUserId: USER_ID,
			maintenanceEvidenceJson: { oldOwnerEpoch: "legacy-random", generation: permit.generation },
		});
		expect(
			db.select().from(workspaceWriteLeases).where(eq(workspaceWriteLeases.leaseId, leaseId)).get(),
		).toMatchObject({ status: "recovered", executionEndedAt: null });
		await expect(recovery.observeWorkspaceMaintenance(input)).rejects.toMatchObject({
			code: "MAINTENANCE_INVALID",
		});
	});

	test("automatic local reconciliation records system authority and no invented administrator", async () => {
		const { effect } = await dispatchedEffect("auto.txt", ABSENT, blobState(hash("x"), 1));
		const leaseId = durableBarrier(effect);
		db.update(workspaceWriteLeases)
			.set({ executionClass: "local_file_io" })
			.where(eq(workspaceWriteLeases.leaseId, leaseId))
			.run();
		const result = await recovery.reconcileWorkspaceBarrier(scope.id, leaseId);
		expect(result.recovered).toBe("barrier_cleared");
		expect(auditRows()[0]).toMatchObject({
			recoveredByUserId: null,
			resolutionAuthority: "system_reconciled",
			maintenanceEvidenceJson: null,
		});
	});

	test("automatic recovery leaves opaque writes, foreign observations and unproven owners barred", async () => {
		const { effect } = await dispatchedEffect("auto-foreign.txt", ABSENT, blobState(hash("x"), 1));
		const leaseId = durableBarrier(effect);
		await expect(recovery.reconcileWorkspaceBarrier(scope.id, leaseId)).resolves.toMatchObject({
			recovered: false,
		});
		db.update(workspaceWriteLeases)
			.set({ executionClass: "local_file_io" })
			.where(eq(workspaceWriteLeases.leaseId, leaseId))
			.run();
		await writeFile(join(root, "auto-foreign.txt"), "foreign");
		await expect(recovery.reconcileWorkspaceBarrier(scope.id, leaseId)).resolves.toMatchObject({
			recovered: false,
		});
		db.update(workspaceWriteLeases)
			.set({ executionEndedAt: null, ownerEpoch: "legacy-unproven" })
			.where(eq(workspaceWriteLeases.leaseId, leaseId))
			.run();
		await expect(recovery.reconcileWorkspaceBarrier(scope.id, leaseId)).rejects.toMatchObject({
			statusCode: 409,
		});
		expect(auditRows()).toEqual([]);
		expect(effectRow(effect.id)?.settlement).toBe("applying");
	});

	test("only explicit native observation retries strict owner probing; inventory never probes or writes", async () => {
		const { effect } = await dispatchedEffect("probe-retry.txt", ABSENT, blobState(hash("x"), 1));
		const leaseId = durableBarrier(effect);
		db.update(workspaceWriteLeases)
			.set({
				executionClass: "local_file_io",
				executionEndedAt: null,
				ownerEpoch: "old-probe-unknown",
			})
			.where(eq(workspaceWriteLeases.leaseId, leaseId))
			.run();
		const prove = spyOn(ownerAuthority, "proveWorkspaceOwnerEnded").mockResolvedValue(null);
		const record = spyOn(coordinator, "recordLocalOwnerTermination");
		try {
			await recovery.listWorkspaceBarriers();
			expect(prove).not.toHaveBeenCalled();
			await expect(
				recovery.observeWorkspaceBarrier(scope.id, undefined, leaseId),
			).rejects.toMatchObject({ statusCode: 409 });
			expect(prove).toHaveBeenCalledTimes(1);
			expect(record).not.toHaveBeenCalled();
			expect(
				db
					.select()
					.from(workspaceWriteLeases)
					.where(eq(workspaceWriteLeases.leaseId, leaseId))
					.get()?.executionEndedAt,
			).toBeNull();
		} finally {
			prove.mockRestore();
			record.mockRestore();
		}
	});

	test("maintenance commit rechecks administrator, physical observations and independent root barriers", async () => {
		const { effect } = await dispatchedEffect("attested.txt", ABSENT, blobState(hash("x"), 1));
		const leaseId = durableBarrier(effect);
		db.update(workspaceWriteLeases)
			.set({ executionEndedAt: null, ownerEpoch: "legacy-random" })
			.where(eq(workspaceWriteLeases.leaseId, leaseId))
			.run();
		db.update(fileChangeScopes)
			.set({
				status: "needs_verification",
				activeLeaseId: "independent-bash",
				activeLeaseEpoch: "old-bash",
				activeMutationCount: 1,
			})
			.where(eq(fileChangeScopes.id, scope.id))
			.run();
		const permit = await recovery.beginWorkspaceMaintenance({
			scopeId: scope.id,
			leaseId,
			adminUserId: USER_ID,
			acknowledgeWritersStopped: true,
			operatorReason: "Stopped all writers",
		});
		const input = {
			scopeId: scope.id,
			adminUserId: USER_ID,
			maintenanceToken: permit.maintenanceToken,
		};
		let preview = await recovery.observeWorkspaceMaintenance(input);
		const commit = () =>
			recovery.commitWorkspaceMaintenance({
				...input,
				confirmationToken: preview.confirmationToken,
				acknowledgeInspected: true,
				acknowledgements: preview.observations.map(({ effectId, verdict }) => ({
					effectId,
					verdict,
				})),
			});
		db.update(users).set({ role: "user" }).where(eq(users.id, USER_ID)).run();
		await expect(commit()).rejects.toMatchObject({ statusCode: 403 });
		db.update(users).set({ role: "admin" }).where(eq(users.id, USER_ID)).run();
		await writeFile(join(root, "attested.txt"), "foreign");
		await expect(commit()).rejects.toMatchObject({ code: "OBSERVATION_CHANGED" });
		expect(auditRows()).toEqual([]);
		preview = await recovery.observeWorkspaceMaintenance(input);
		const result = await commit();
		expect(result.remaining).toMatchObject({ rootVerificationRequired: true, legacyBarrier: true });
		expect(scopeRow()).toMatchObject({
			activeLeaseId: "independent-bash",
			status: "needs_verification",
		});
	});

	test("maintenance capabilities do not survive service restart or accept a changed fence", async () => {
		activate();
		quarantine();
		db.update(fileChangeScopes)
			.set({ activeLeaseEpoch: "legacy-random" })
			.where(eq(fileChangeScopes.id, scope.id))
			.run();
		const permit = await recovery.beginWorkspaceMaintenance({
			scopeId: scope.id,
			adminUserId: USER_ID,
			acknowledgeWritersStopped: true,
			operatorReason: "Stopped",
		});
		const input = {
			scopeId: scope.id,
			adminUserId: USER_ID,
			maintenanceToken: permit.maintenanceToken,
		};
		const restarted = createWorkspaceScopeRecovery({
			database: db,
			getRuntime: async () => ({ coordinator, evidence: service }),
			assertMaintenanceAuthority: () => {},
		});
		await expect(restarted.observeWorkspaceMaintenance(input)).rejects.toMatchObject({
			code: "MAINTENANCE_INVALID",
		});
		db.update(fileChangeScopes)
			.set({ fencingToken: 123 })
			.where(eq(fileChangeScopes.id, scope.id))
			.run();
		await expect(recovery.observeWorkspaceMaintenance(input)).rejects.toThrow();
		await recovery.cancelWorkspaceMaintenance(input);
		expect(auditRows()).toEqual([]);
	});

	test("maintenance tokens bind administrator/scope, expire without renewal and leave barriers intact", async () => {
		activate();
		quarantine();
		db.update(fileChangeScopes)
			.set({ activeLeaseEpoch: "legacy-random" })
			.where(eq(fileChangeScopes.id, scope.id))
			.run();
		const begin = () =>
			recovery.beginWorkspaceMaintenance({
				scopeId: scope.id,
				adminUserId: USER_ID,
				acknowledgeWritersStopped: true,
				operatorReason: "Stopped",
			});
		const permit = await begin();
		const input = {
			scopeId: scope.id,
			adminUserId: USER_ID,
			maintenanceToken: permit.maintenanceToken,
		};
		await expect(
			recovery.observeWorkspaceMaintenance({ ...input, adminUserId: "other-admin" }),
		).rejects.toThrow();
		await expect(
			recovery.cancelWorkspaceMaintenance({ ...input, scopeId: "other-scope" }),
		).rejects.toThrow();
		clock += 300001;
		await expect(recovery.observeWorkspaceMaintenance(input)).rejects.toMatchObject({
			code: "MAINTENANCE_EXPIRED",
		});
		await Promise.resolve();
		expect(scopeRow()?.activeLeaseId).toBe("dead-lease");
		const next = await begin();
		expect(next.maintenanceToken).not.toBe(permit.maintenanceToken);
		await recovery.cancelWorkspaceMaintenance({
			...input,
			maintenanceToken: next.maintenanceToken,
		});
		expect(scopeRow()?.activeLeaseId).toBe("dead-lease");
		expect(auditRows()).toEqual([]);
	});

	test("maintenance refuses registered unknown owners and rechecks authority before IO", async () => {
		activate();
		quarantine();
		const epoch = generateId();
		db.update(fileChangeScopes)
			.set({ activeLeaseEpoch: epoch })
			.where(eq(fileChangeScopes.id, scope.id))
			.run();
		db.insert(workspaceExecutionOwners)
			.values({
				ownerEpoch: epoch,
				identityJson: {
					version: 1,
					pid: 42,
					birth: "123456789",
					domain: {
						platform: "linux",
						machine: "1234567890abcdef1234567890abcdef",
						boot: "12345678-1234-1234-1234-123456789012",
						pidNamespace: "pid:[123]",
						timeNamespace: "time:[789]",
					},
				},
				createdAt: new Date(clock).toISOString(),
			})
			.run();
		try {
			await expect(
				recovery.beginWorkspaceMaintenance({
					scopeId: scope.id,
					adminUserId: USER_ID,
					acknowledgeWritersStopped: true,
					operatorReason: "Cannot override a registered owner",
				}),
			).rejects.toMatchObject({ code: "MAINTENANCE_OWNER_INELIGIBLE" });
		} finally {
			db.delete(workspaceExecutionOwners)
				.where(eq(workspaceExecutionOwners.ownerEpoch, epoch))
				.run();
		}
		let allowed = true;
		const guarded = createWorkspaceScopeRecovery({
			database: db,
			getRuntime: async () => ({ coordinator, evidence: service }),
			assertMaintenanceAuthority: () => {
				if (!allowed) throw new Error("exclusive authority lost");
			},
		});
		const permit = await guarded.beginWorkspaceMaintenance({
			scopeId: scope.id,
			adminUserId: USER_ID,
			acknowledgeWritersStopped: true,
			operatorReason: "Stopped",
		});
		allowed = false;
		const input = {
			scopeId: scope.id,
			adminUserId: USER_ID,
			maintenanceToken: permit.maintenanceToken,
		};
		await expect(guarded.observeWorkspaceMaintenance(input)).rejects.toThrow(
			"exclusive authority lost",
		);
		await guarded.cancelWorkspaceMaintenance(input);
		expect(auditRows()).toEqual([]);
	});

	test("an owner registration without identity still requires explicit administrator attestation", async () => {
		activate();
		quarantine();
		const epoch = generateId();
		db.update(fileChangeScopes)
			.set({ activeLeaseEpoch: epoch })
			.where(eq(fileChangeScopes.id, scope.id))
			.run();
		db.insert(workspaceExecutionOwners)
			.values({ ownerEpoch: epoch, identityJson: null, createdAt: new Date(clock).toISOString() })
			.run();
		try {
			await expect(recovery.observeWorkspaceBarrier(scope.id)).rejects.toMatchObject({
				statusCode: 409,
			});
			const inventory = await recovery.listWorkspaceBarriers();
			expect(inventory.items.find((item) => item.scope.id === scope.id)?.maintenanceRequired).toBe(
				true,
			);
			const permit = await recovery.beginWorkspaceMaintenance({
				scopeId: scope.id,
				adminUserId: USER_ID,
				acknowledgeWritersStopped: true,
				operatorReason: "No stored identity; all old writers stopped",
			});
			await recovery.cancelWorkspaceMaintenance({
				scopeId: scope.id,
				adminUserId: USER_ID,
				maintenanceToken: permit.maintenanceToken,
			});
			expect(auditRows()).toEqual([]);
		} finally {
			db.delete(workspaceExecutionOwners)
				.where(eq(workspaceExecutionOwners.ownerEpoch, epoch))
				.run();
		}
	});

	test("maintenance cancellation joins in-flight reads before releasing its reservation", async () => {
		const { effect } = await dispatchedEffect(
			"cancel-maintenance.txt",
			ABSENT,
			blobState(hash("x"), 1),
		);
		await writeFile(join(root, "cancel-maintenance.txt"), "x");
		const leaseId = durableBarrier(effect);
		db.update(workspaceWriteLeases)
			.set({ executionEndedAt: null, ownerEpoch: "legacy-random" })
			.where(eq(workspaceWriteLeases.leaseId, leaseId))
			.run();
		const begin = () =>
			recovery.beginWorkspaceMaintenance({
				scopeId: scope.id,
				leaseId,
				adminUserId: USER_ID,
				acknowledgeWritersStopped: true,
				operatorReason: "Stopped",
			});
		const permit = await begin();
		const input = {
			scopeId: scope.id,
			adminUserId: USER_ID,
			maintenanceToken: permit.maintenanceToken,
		};
		let unblock!: () => void;
		let started!: () => void;
		const entered = new Promise<void>((resolve) => {
			started = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			unblock = resolve;
		});
		const original = fileChangeLocalIo.read.bind(fileChangeLocalIo);
		const spy = spyOn(fileChangeLocalIo, "read").mockImplementation(async (...args) => {
			started();
			await blocked;
			return original(...args);
		});
		try {
			const observing = recovery
				.observeWorkspaceMaintenance(input)
				.catch((error: unknown) => error);
			await entered;
			let cancelled = false;
			const cancelling = recovery.cancelWorkspaceMaintenance(input).then(() => {
				cancelled = true;
			});
			await Promise.resolve();
			expect(cancelled).toBe(false);
			await expect(begin()).rejects.toThrow();
			unblock();
			expect(await observing).toBeInstanceOf(Error);
			await cancelling;
			expect(effectRow(effect.id)?.settlement).toBe("applying");
			expect(auditRows()).toEqual([]);
			const next = await begin();
			await recovery.cancelWorkspaceMaintenance({
				...input,
				maintenanceToken: next.maintenanceToken,
			});
		} finally {
			unblock();
			spy.mockRestore();
		}
	});

	test("unknown owner epoch is rejected before any observation or evidence mutation", async () => {
		const { effect } = await dispatchedEffect("unknown.txt", ABSENT, blobState(hash("x"), 1));
		const leaseId = durableBarrier(effect);
		db.update(workspaceWriteLeases)
			.set({ executionEndedAt: null, ownerEpoch: "unknown-owner" })
			.where(eq(workspaceWriteLeases.leaseId, leaseId))
			.run();
		const before = effectRow(effect.id);
		await expect(confirmedLeaseRecovery(leaseId)).rejects.toMatchObject({ statusCode: 409 });
		expect(effectRow(effect.id)).toEqual(before);
		expect(auditRows()).toEqual([]);
	});

	test("active execution rejects recovery without changing evidence", async () => {
		const { effect } = await dispatchedEffect("active.txt", ABSENT, blobState(hash("x"), 1));
		db.update(fileChangeScopes)
			.set({
				status: "active",
				activeLeaseId: null,
				activeLeaseEpoch: null,
				activeLeaseStartedAt: null,
				activeMutationCount: 0,
			})
			.where(eq(fileChangeScopes.id, scope.id))
			.run();
		const before = effectRow(effect.id);
		await coordinator.withWrite(
			{
				scope,
				runtime: binding,
				ranges: [{ kind: "file", canonicalPath: join(root, "active.txt") }],
			},
			async (lease) => {
				await expect(
					recovery.observeWorkspaceBarrier(scope.id, undefined, lease.leaseId),
				).rejects.toMatchObject({ statusCode: 409 });
				await expect(
					recovery.beginWorkspaceMaintenance({
						scopeId: scope.id,
						leaseId: lease.leaseId,
						adminUserId: USER_ID,
						acknowledgeWritersStopped: true,
						operatorReason: "An attestation cannot override live execution",
					}),
				).rejects.toMatchObject({ statusCode: 409 });
				expect(effectRow(effect.id)).toEqual(before);
				expect(auditRows()).toEqual([]);
			},
		);
	});

	test("recovering detached A never changes running B's lease, fence, count or evidence", async () => {
		const { effect } = await dispatchedEffect("a.txt", ABSENT, blobState(hash("x"), 1));
		const leaseId = durableBarrier(effect);
		await coordinator.withWrite(
			{ scope, runtime: binding, ranges: [{ kind: "file", canonicalPath: join(root, "b.txt") }] },
			async (leaseB) => {
				leaseB.registerMutation("running-b");
				const scopeBefore = scopeRow();
				const bBefore = db
					.select()
					.from(workspaceWriteLeases)
					.where(eq(workspaceWriteLeases.leaseId, leaseB.leaseId))
					.get();
				await confirmedLeaseRecovery(leaseId);
				expect(scopeRow()).toEqual(scopeBefore);
				expect(
					db
						.select()
						.from(workspaceWriteLeases)
						.where(eq(workspaceWriteLeases.leaseId, leaseB.leaseId))
						.get(),
				).toEqual(bBefore);
				leaseB.settle("running-b", "not_applied");
			},
		);
		expect(effectRow(effect.id)?.settlement).toBe("settled");
	});

	test("foreign-to-foreign byte drift invalidates the preview token", async () => {
		const path = join(root, "foreign-drift.txt");
		await writeFile(path, "foreign-one");
		const { effect } = await dispatchedEffect(
			"foreign-drift.txt",
			ABSENT,
			blobState(hash("expected"), 8),
		);
		const leaseId = durableBarrier(effect);
		const preview = await recovery.observeWorkspaceBarrier(scope.id, undefined, leaseId);
		expect(preview.observations[0]?.verdict).toBe("foreign");
		await writeFile(path, "foreign-two");
		await expect(
			recovery.recoverWorkspaceBarrier({
				scopeId: scope.id,
				leaseId,
				recoveredByUserId: USER_ID,
				confirmationToken: preview.confirmationToken,
				acknowledgements: [{ effectId: effect.id, verdict: "foreign" }],
			}),
		).rejects.toMatchObject({ code: "OBSERVATION_CHANGED" });
		expect(effectRow(effect.id)?.settlement).toBe("applying");
		expect(auditRows()).toEqual([]);
	});

	test("mode-only drift and lease generation drift both invalidate confirmation", async () => {
		const path = join(root, "mode.txt");
		await writeFile(path, "foreign");
		await chmod(path, 0o644);
		const { effect } = await dispatchedEffect("mode.txt", ABSENT, blobState(hash("expected"), 8));
		const leaseId = durableBarrier(effect);
		const preview = await recovery.observeWorkspaceBarrier(scope.id, undefined, leaseId);
		await chmod(path, 0o600);
		await expect(
			recovery.recoverWorkspaceBarrier({
				scopeId: scope.id,
				leaseId,
				recoveredByUserId: USER_ID,
				confirmationToken: preview.confirmationToken,
				acknowledgements: preview.observations,
			}),
		).rejects.toMatchObject({ code: "OBSERVATION_CHANGED" });
		const next = await recovery.observeWorkspaceBarrier(scope.id, undefined, leaseId);
		db.update(workspaceWriteLeases)
			.set({ runtimeGeneration: binding.runtimeGeneration + 1 })
			.where(eq(workspaceWriteLeases.leaseId, leaseId))
			.run();
		await expect(
			recovery.recoverWorkspaceBarrier({
				scopeId: scope.id,
				leaseId,
				recoveredByUserId: USER_ID,
				confirmationToken: next.confirmationToken,
				acknowledgements: next.observations,
			}),
		).rejects.toMatchObject({ code: "OBSERVATION_CHANGED" });
		expect(auditRows()).toEqual([]);
	});

	test("scope compatibility resolves the durable manifest instead of settling unrelated effects", async () => {
		activate();
		const operation = service.beginOperation(operationInput({ expectedEffectCount: 2 }));
		const effects = service.prepareEffects(operation.id, [
			effectInput("a.txt", ABSENT, blobState(hash("a"), 1)),
			effectInput("b.txt", ABSENT, blobState(hash("b"), 1)),
		]);
		await service.finalizePreparation(operation.id);
		for (const effect of effects)
			service.markApplying({
				operationId: effect.operationId,
				mutationId: effect.mutationId,
				requestDigest: effect.requestDigest,
				executionBinding: binding,
			});
		const first = effects[0];
		const second = effects[1];
		if (!first || !second) throw new Error("Missing effects");
		const leaseId = durableBarrier(first);
		db.update(fileChangeScopes)
			.set({
				activeLeaseId: leaseId,
				activeLeaseEpoch: coordinator.ownerEpoch(),
				activeMutationCount: 1,
			})
			.where(eq(fileChangeScopes.id, scope.id))
			.run();
		const preview = await recovery.observeWorkspaceBarrier(scope.id);
		expect(preview.leaseId).toBe(leaseId);
		expect(preview.observations.map((entry) => entry.effectId)).toEqual([first.id]);
		await recovery.recoverWorkspaceBarrier({
			scopeId: scope.id,
			recoveredByUserId: USER_ID,
			confirmationToken: preview.confirmationToken,
			acknowledgements: preview.observations,
		});
		expect(effectRow(first.id)?.settlement).toBe("settled");
		expect(effectRow(second.id)?.settlement).toBe("applying");
		expect(auditRows()[0]?.workspaceLeaseId).toBe(leaseId);
	});

	test("legacy half-recovery re-observes matching audit effects even after their books closed", async () => {
		const path = join(root, "legacy.txt");
		await writeFile(path, "old-foreign");
		const { effect } = await dispatchedEffect("legacy.txt", ABSENT, blobState(hash("expected"), 8));
		const first = await recovery.observeWorkspaceBarrier(scope.id);
		service.closeBooksForRecovery({
			scopeId: scope.id,
			recoveredByUserId: USER_ID,
			decisions: first.observations.map(
				({ effectId, canonicalPath, verdict, observedDigest, observedSizeBytes }) => ({
					effectId,
					canonicalPath,
					verdict,
					observedDigest,
					observedSizeBytes,
				}),
			),
		});
		expect(effectRow(effect.id)?.settlement).toBe("settled");
		// Old releases retried settlement after unlock failed and appended empty audits.
		service.closeBooksForRecovery({ scopeId: scope.id, recoveredByUserId: USER_ID, decisions: [] });
		service.closeBooksForRecovery({ scopeId: scope.id, recoveredByUserId: USER_ID, decisions: [] });
		expect(auditRows()).toHaveLength(3);
		const second = await recovery.observeWorkspaceBarrier(scope.id);
		expect(second.observations).toHaveLength(1);
		await writeFile(path, "new-foreign");
		await expect(
			recovery.recoverWorkspaceBarrier({
				scopeId: scope.id,
				recoveredByUserId: USER_ID,
				confirmationToken: second.confirmationToken,
				acknowledgements: [{ effectId: effect.id, verdict: "foreign" }],
				acknowledgeInspected: true,
			}),
		).rejects.toMatchObject({ code: "OBSERVATION_CHANGED" });
		expect(scopeRow()?.status).toBe("needs_verification");
		expect(auditRows()).toHaveLength(3);
	});

	test("settled target effects remain observable when only a parent range was quarantined", async () => {
		const { effect } = await dispatchedEffect("parent-only.txt", ABSENT, blobState(hash("x"), 1));
		const leaseId = durableBarrier(effect, [{ kind: "subtree", canonicalPath: root }]);
		db.update(fileChangeEffects)
			.set({ settlement: "settled", outcome: "no_change" })
			.where(eq(fileChangeEffects.id, effect.id))
			.run();
		const preview = await recovery.observeWorkspaceBarrier(scope.id, undefined, leaseId);
		expect(preview.observations).toHaveLength(1);
		expect(preview.rangeObservations[0]).toMatchObject({
			canonicalPath: root,
			actualKind: "directory",
		});
		await expect(
			recovery.recoverWorkspaceBarrier({
				scopeId: scope.id,
				leaseId,
				recoveredByUserId: USER_ID,
				confirmationToken: preview.confirmationToken,
				acknowledgements: preview.observations,
			}),
		).rejects.toMatchObject({ code: "ACK_REQUIRED" });
		await confirmedLeaseRecovery(leaseId);
		expect(auditRows()[0]?.effectDecisionsJson).toHaveLength(1);
	});

	test("verified root without a lease remains an unknown activity barrier", async () => {
		activate();
		db.update(fileChangeScopes)
			.set({ status: "needs_verification" })
			.where(eq(fileChangeScopes.id, scope.id))
			.run();
		const page = await recovery.listWorkspaceBarriers();
		expect(page.items.find((item) => item.scope.id === scope.id)).toMatchObject({
			kind: "quarantined",
			executionEnded: false,
		});
		await expect(recovery.observeWorkspaceBarrier(scope.id)).rejects.toMatchObject({
			statusCode: 409,
		});
		expect(scopeRow()?.rootIdentityJson).not.toBeNull();
	});
});

describe("recovery observation budgets", () => {
	test("inventory cursors cover durable leases and legacy scopes without offsets or skipped dash IDs", async () => {
		activate();
		const ids = Array.from({ length: 28 }, () => durableBarrier());
		const legacy = service.prepareScope({
			id: `-${generateId()}`,
			sourceInstanceId: source,
			deviceId: "local",
			workspaceInstanceId: generateId(),
			canonicalRoot: join(root, "legacy-root"),
			pathFlavor: "posix",
		});
		const seen: string[] = [];
		let cursor: string | undefined;
		for (let count = 0; count < 5; count++) {
			const page = await recovery.listWorkspaceBarriers(cursor);
			expect(page.items.length).toBeLessThanOrEqual(25);
			seen.push(...page.items.map((item) => item.leaseId ?? item.scope.id));
			if (!page.nextCursor) break;
			cursor = page.nextCursor;
		}
		expect(new Set(seen).size).toBe(seen.length);
		expect(seen.sort()).toEqual([...ids, legacy.id].sort());
		await expect(recovery.listWorkspaceBarriers("invalid-cursor")).rejects.toMatchObject({
			code: "INVALID_CURSOR",
		});
	});

	test.each([
		"manifest-only",
		"repeated-effect",
	] as const)("a legal 2000-mutation %s manifest stays observable and recoverable without leaking its payload", async (mode) => {
		const effect =
			mode === "repeated-effect"
				? (await dispatchedEffect("repeat.txt", ABSENT, blobState(hash("x"), 1))).effect
				: undefined;
		if (!effect) activate();
		const leaseId = durableBarrier(effect);
		const manifest = {
			version: 1 as const,
			mutations: Array.from(
				{ length: WORKSPACE_WRITE_COORDINATOR_LIMITS.mutationsPerLease },
				(_, index) => ({
					mutationId: hash(`real-mutation-${index}`),
					outcome: "unknown" as const,
					...(effect ? { effectId: effect.id, operationId: effect.operationId } : {}),
				}),
			),
		};
		expect(manifest.mutations).toHaveLength(2000);
		expect(Buffer.byteLength(JSON.stringify(manifest))).toBeGreaterThan(128 * 1024);
		db.update(workspaceWriteLeases)
			.set({ mutationManifestJson: manifest })
			.where(eq(workspaceWriteLeases.leaseId, leaseId))
			.run();
		const preview = await recovery.observeWorkspaceBarrier(scope.id, undefined, leaseId);
		expect(preview.observations).toHaveLength(effect ? 1 : 0);
		const page = await recovery.listWorkspaceBarriers();
		const item = page.items.find((entry) => entry.leaseId === leaseId);
		expect(item?.blockedReason).toBeNull();
		expect(Buffer.byteLength(JSON.stringify(item))).toBeLessThan(8 * 1024);
		expect(JSON.stringify(item)).not.toContain(manifest.mutations[0]?.mutationId ?? "missing");
		const result = await recovery.recoverWorkspaceBarrier({
			scopeId: scope.id,
			leaseId,
			recoveredByUserId: USER_ID,
			confirmationToken: preview.confirmationToken,
			acknowledgements: preview.observations,
			acknowledgeInspected: true,
		});
		expect(result.settledEffectCount).toBe(effect ? 1 : 0);
		expect(
			db.select().from(workspaceWriteLeases).where(eq(workspaceWriteLeases.leaseId, leaseId)).get()
				?.status,
		).toBe("recovered");
	});

	test("oversized manifest is rejected instead of observing a truncated file set", async () => {
		const { effect } = await dispatchedEffect("manifest.txt", ABSENT, blobState(hash("x"), 1));
		const leaseId = durableBarrier(effect);
		db.update(workspaceWriteLeases)
			.set({
				mutationManifestJson: {
					version: 1,
					mutations: Array.from(
						{ length: WORKSPACE_WRITE_COORDINATOR_LIMITS.mutationsPerLease + 1 },
						(_, index) => ({
							mutationId: `entry-${index}`,
							outcome: "unknown" as const,
						}),
					),
				},
			})
			.where(eq(workspaceWriteLeases.leaseId, leaseId))
			.run();
		await expect(
			recovery.observeWorkspaceBarrier(scope.id, undefined, leaseId),
		).rejects.toMatchObject({ code: "RECOVERY_MUTATION_LIMIT" });
		expect(effectRow(effect.id)?.settlement).toBe("applying");
		expect(auditRows()).toEqual([]);
	});
	test("too many matching legacy audits refuse recovery instead of dropping older decisions", async () => {
		activate();
		quarantine();
		for (let index = 0; index < 65; index++)
			service.closeBooksForRecovery({
				scopeId: scope.id,
				recoveredByUserId: USER_ID,
				decisions: [],
			});
		await expect(recovery.observeWorkspaceBarrier(scope.id)).rejects.toMatchObject({
			code: "RECOVERY_AUDIT_LIMIT",
		});
		expect(scopeRow()?.status).toBe("needs_verification");
		expect(auditRows()).toHaveLength(65);
	});

	test("an aborted observation is not converted into an unobservable verdict", async () => {
		const { effect } = await dispatchedEffect("cancel.txt", ABSENT, blobState(hash("x"), 1));
		const controller = new AbortController();
		controller.abort();
		await expect(
			recovery.observeWorkspaceBarrier(scope.id, controller.signal),
		).rejects.toMatchObject({ code: "RECOVERY_CANCELLED" });
		expect(effectRow(effect.id)?.settlement).toBe("applying");
	});

	test("single-file and cumulative byte caps stop observation without closing evidence", async () => {
		await writeFile(join(root, "large.txt"), "12345678");
		const { effect } = await dispatchedEffect("large.txt", ABSENT, blobState(hash("expected"), 8));
		const limited = createWorkspaceScopeRecovery({
			database: db,
			getRuntime: async () => ({ coordinator, evidence: service }),
			observationLimits: { fileBytes: 4 },
		});
		await expect(limited.observeWorkspaceBarrier(scope.id)).rejects.toMatchObject({
			code: "RECOVERY_BYTE_LIMIT",
		});
		// One effect plus one manifest-only file exercises the SHARED cumulative budget.
		await writeFile(join(root, "extra.txt"), "12345678");
		const leaseId = durableBarrier(effect, [
			{ kind: "file", canonicalPath: join(root, "large.txt") },
			{ kind: "file", canonicalPath: join(root, "extra.txt") },
		]);
		const cumulative = createWorkspaceScopeRecovery({
			database: db,
			getRuntime: async () => ({ coordinator, evidence: service }),
			observationLimits: { totalBytes: 12 },
		});
		await expect(
			cumulative.observeWorkspaceBarrier(scope.id, undefined, leaseId),
		).rejects.toMatchObject({ code: "RECOVERY_BYTE_LIMIT" });
		expect(effectRow(effect.id)?.settlement).toBe("applying");
	});

	test("cancellation during IO and deadlines are surfaced, not swallowed", async () => {
		await writeFile(join(root, "slow.txt"), "x");
		await dispatchedEffect("slow.txt", ABSENT, blobState(hash("y"), 1));
		const read = spyOn(fileChangeLocalIo, "read").mockImplementation(async (_path, signal) => {
			await new Promise<void>((_resolve, reject) => {
				if (signal?.aborted) reject(signal.reason);
				else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
			throw new Error("unreachable");
		});
		try {
			const limited = createWorkspaceScopeRecovery({
				database: db,
				getRuntime: async () => ({ coordinator, evidence: service }),
				observationLimits: { durationMs: 5 },
			});
			await expect(limited.observeWorkspaceBarrier(scope.id)).rejects.toMatchObject({
				code: "RECOVERY_TIMEOUT",
			});
			const controller = new AbortController();
			const pending = recovery.observeWorkspaceBarrier(scope.id, controller.signal);
			setTimeout(() => controller.abort(), 5);
			await expect(pending).rejects.toMatchObject({ code: "RECOVERY_CANCELLED" });
		} finally {
			read.mockRestore();
		}
		expect(auditRows()).toEqual([]);
	});
});
