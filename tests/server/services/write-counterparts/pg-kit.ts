/**
 * The PostgreSQL implementation of the equivalence kit: the PG counterparts
 * (`PostgresFileChangeBlobCatalog`, `PostgresWorkspaceLeaseStore`,
 * `PostgresFileChangeEvidenceStore`, `PostgresRevertPlanStore`,
 * `PostgresRevertMutationJournal`) behind the suite's facades.
 *
 * The two workspace facade methods that compose a whole write lifecycle
 * (`runCleanWrite` / `runUncertainWrite`) mirror what the SQLite coordinator's
 * `withWrite` finalizer does — admit → register → settle → release, and admit →
 * register → mark-uncertain → quarantine-with-lease-retained — because the PG
 * store exposes the durable SECTIONS while the coordinator exposes the composed
 * lifecycle. That composition is the wrapper's equivalence claim for this domain.
 */
import { eq } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import {
	fileChangeScopes,
	fileChangeStorageBudgets,
	revertOperationFiles,
	revertOperations,
} from "../../../../server/db/postgres-schema";
import { generateId } from "../../../../server/lib/id";
import { FILE_CHANGE_BLOB_BUDGET_ID } from "../../../../server/services/file-change-blob-catalog";
import type { FileChangeScopeIdentity } from "../../../../server/services/file-change-identity";
import { createPostgresFileChangeBlobCatalog } from "../../../../server/services/postgres-file-change-blob-catalog";
import { createPostgresFileChangeEvidenceStore } from "../../../../server/services/postgres-file-change-evidence-store";
import { createPostgresRevertMutationJournal } from "../../../../server/services/postgres-revert-journal-store";
import { createPostgresRevertPlanStore } from "../../../../server/services/postgres-revert-plan-store";
import { createPostgresWorkspaceLeaseStore } from "../../../../server/services/postgres-workspace-lease-store";
import type {
	BlobCatalogFacade,
	EquivalenceKit,
	EvidenceFacade,
	JournalFacade,
	PlanFacade,
	WorkspaceLeaseFacade,
} from "./equivalence-suite";

const NAMESPACE = "equivalence-sqlite";
const OWNER_EPOCH = "sqlite-epoch-1";
const RUNTIME = { runtimeEpoch: "sqlite-runtime-epoch", runtimeGeneration: 7 };

let serial = 0;

export function makePostgresKit(pgDb: BunSQLDatabase): EquivalenceKit {
	const blobCatalog = createPostgresFileChangeBlobCatalog({ db: pgDb, namespaceKey: NAMESPACE });
	const leaseStore = createPostgresWorkspaceLeaseStore(pgDb, {
		ownerEpoch: OWNER_EPOCH,
		readRuntime: () => RUNTIME,
	});
	const evidence = createPostgresFileChangeEvidenceStore(pgDb);
	const plans = createPostgresRevertPlanStore(pgDb, { namespaceKey: NAMESPACE });
	const journal = createPostgresRevertMutationJournal(pgDb, { namespaceKey: NAMESPACE }, plans);

	const blob: BlobCatalogFacade = {
		getBudget: () => blobCatalog.getBudget(),
		initializeNamespace: (input) => blobCatalog.initializeNamespace(input),
		beginReconciliation: (input) => blobCatalog.beginReconciliation(input),
		completeReconciliation: (input) => blobCatalog.completeReconciliation(input),
		reserve: async (input) => {
			const lease = await blobCatalog.reserve(input);
			return {
				reservationId: lease.reservationId,
				ownerEpoch: lease.ownerEpoch,
				generation: lease.generation,
				release: (releaseInput) => lease.release(releaseInput),
			};
		},
		getMetadata: (input) => blobCatalog.getMetadata(input),
		reconcileBlob: (input) => blobCatalog.reconcileBlob(input),
	};

	const scopeRow = async (scope: Readonly<FileChangeScopeIdentity>) => {
		const rows = await pgDb
			.select()
			.from(fileChangeScopes)
			.where(eq(fileChangeScopes.id, scope.id));
		const row = rows[0];
		if (!row) throw new Error("scope vanished");
		return row as unknown as Record<string, unknown>;
	};

	const workspace: WorkspaceLeaseFacade = {
		runCleanWrite: async (scope) => {
			const leaseId = `clean-${generateId(6)}`;
			const claim = await leaseStore.admitLease({
				scope,
				runtime: RUNTIME,
				leaseId,
				kind: "write",
			});
			const lease = {
				scope,
				binding: {
					deviceId: scope.deviceId,
					runtimeEpoch: RUNTIME.runtimeEpoch,
					runtimeGeneration: RUNTIME.runtimeGeneration,
					fencingToken: claim.fencingToken,
				},
				leaseId,
				revision: claim.revision,
				pendingMutations: 0,
			};
			await leaseStore.registerMutation(lease);
			const counterDuringWrite = (await scopeRow(scope)).activeMutationCount;
			await leaseStore.settleMutation({ ...lease, pendingMutations: 1 });
			await leaseStore.clearLease({ ...lease, pendingMutations: 0 });
			return { counterDuringWrite };
		},
		runUncertainWrite: async (scope) => {
			const leaseId = `uncertain-${generateId(6)}`;
			const claim = await leaseStore.admitLease({
				scope,
				runtime: RUNTIME,
				leaseId,
				kind: "write",
			});
			await leaseStore.registerMutation({
				scope,
				binding: {
					deviceId: scope.deviceId,
					runtimeEpoch: RUNTIME.runtimeEpoch,
					runtimeGeneration: RUNTIME.runtimeGeneration,
					fencingToken: claim.fencingToken,
				},
				leaseId,
				revision: claim.revision,
				pendingMutations: 0,
			});
			// The uncertain finalizer: quarantine, durable lease RETAINED.
			await leaseStore.persistUncertainScope(scope);
		},
		admitLease: async (scope) => {
			await leaseStore.admitLease({
				scope,
				runtime: RUNTIME,
				leaseId: `barrier-probe-${generateId(6)}`,
				kind: "write",
			});
		},
		recoverSameEpoch: async (scope) => leaseStore.recoverScopeBarrier(scope),
		recoverForeignEpoch: async (scope) => {
			const foreign = createPostgresWorkspaceLeaseStore(pgDb, {
				ownerEpoch: "sqlite-epoch-foreign",
				readRuntime: () => RUNTIME,
			});
			return foreign.recoverScopeBarrier(scope);
		},
		readScope: scopeRow,
	};

	const evidenceFacade: EvidenceFacade = {
		prepareScope: (input) => evidence.prepareScope(input),
		recordScopeVerification: (input) => evidence.recordScopeVerification(input),
		beginOperation: (input) => evidence.beginOperation(input),
		prepareEffects: (operationId, inputs) => evidence.prepareEffects(operationId, inputs),
		finalizePreparation: (operationId) => evidence.finalizePreparation(operationId),
		markApplying: (input) => evidence.markApplying(input),
		settleEffect: (input) => evidence.settleEffect(input),
		finishOperation: (operationId, outcome) => evidence.finishOperation(operationId, outcome),
		getOperation: (operationId) => evidence.getOperation(operationId),
		getEffect: (operationId, mutationId) => evidence.getEffect(operationId, mutationId),
	};

	const plan: PlanFacade = {
		begin: (input) => plans.begin(input),
		appendFiles: (owner, planId, inputs) => plans.appendFiles(owner, planId, inputs),
		finalize: (owner, planId, proof) => plans.finalize(owner, planId, proof),
	};

	const journalFacade: JournalFacade = {
		startExecution: (ctx, proof) => journal.startExecution(ctx, proof),
		claimApply: (ctx, fixed, lease) => journal.claimApply(ctx, fixed, lease),
		recordApplyReceipt: (ctx, fileId, receipt) => journal.recordApplyReceipt(ctx, fileId, receipt),
		finishFiles: (ctx) => journal.finishFiles(ctx),
		commit: async (ctx, probe) =>
			journal.commit(ctx, {
				db: pgDb,
				apply: async (tx) => {
					probe.apply();
					await tx
						.update(fileChangeStorageBudgets)
						.set({ updatedAt: "history-marker" })
						.where(eq(fileChangeStorageBudgets.id, FILE_CHANGE_BLOB_BUDGET_ID));
				},
			}),
		beginCompensation: (ctx) => journal.beginCompensation(ctx),
		claimCompensate: (ctx, fixed, lease) => journal.claimCompensate(ctx, fixed, lease),
		recordCompensateReceipt: (ctx, fileId, receipt) =>
			journal.recordCompensateReceipt(ctx, fileId, receipt),
		finishCompensation: (ctx) => journal.finishCompensation(ctx),
	};

	return {
		blob,
		workspace,
		evidence: evidenceFacade,
		plan,
		journal: journalFacade,
		namespaceKey: NAMESPACE,
		ownerEpoch: OWNER_EPOCH,
		runtime: RUNTIME,
		seedVerifiedScope: async (overrides = {}) => {
			const n = ++serial;
			const canonicalRoot = overrides.canonicalRoot ?? `/equiv/${n}`;
			const workspaceInstanceId = overrides.workspaceInstanceId ?? `workspace-${n}`;
			const prepared = await evidence.prepareScope({
				sourceInstanceId: "source-1",
				deviceId: "device-1",
				workspaceInstanceId,
				pathFlavor: "posix",
				canonicalRoot,
			});
			await evidence.recordScopeVerification({
				scopeId: prepared.id,
				canonicalRoot,
				rootIdentity: { marker: "verified" },
			});
			return {
				id: prepared.id,
				sourceInstanceId: prepared.sourceInstanceId,
				deviceId: prepared.deviceId,
				workspaceInstanceId: prepared.workspaceInstanceId,
				pathFlavor: prepared.pathFlavor,
				canonicalRoot: prepared.canonicalRoot,
			};
		},
		seedLeasedScope: async (scope) => {
			const rows = await pgDb
				.select()
				.from(fileChangeScopes)
				.where(eq(fileChangeScopes.id, scope.id));
			const current = rows[0];
			if (!current) throw new Error("scope vanished");
			const leaseId = `durable-lease-${generateId(6)}`;
			const fencingToken = current.fencingToken + 1;
			const revision = current.revision + 1;
			await pgDb
				.update(fileChangeScopes)
				.set({
					activeLeaseId: leaseId,
					activeLeaseEpoch: OWNER_EPOCH,
					activeLeaseStartedAt: new Date().toISOString(),
					fencingToken,
					revision,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(fileChangeScopes.id, scope.id));
			return { revision, fencingToken, leaseId };
		},
		fixedFileMetadata: async (planId, fileId) => {
			const rows = await pgDb
				.select()
				.from(revertOperationFiles)
				.where(eq(revertOperationFiles.id, fileId));
			const row = rows[0] as
				| typeof import("../../../../server/db/schema").revertOperationFiles.$inferSelect
				| undefined;
			if (!row || row.revertOperationId !== planId) throw new Error("plan file vanished");
			return {
				id: row.id,
				fileKey: row.fileKey,
				sequence: row.sequence,
				identityJson: row.identityJson,
				expectedStateJson: row.expectedStateJson,
				desiredStateJson: row.desiredStateJson,
				applyMutationId: row.applyMutationId,
				applyRequestDigest: row.applyRequestDigest,
				compensateMutationId: row.compensateMutationId,
				compensateRequestDigest: row.compensateRequestDigest,
				status: row.status,
			};
		},
		historyWriteVisible: async () => {
			const rows = await pgDb
				.select()
				.from(fileChangeStorageBudgets)
				.where(eq(fileChangeStorageBudgets.id, FILE_CHANGE_BLOB_BUDGET_ID));
			return rows[0]?.updatedAt === "history-marker";
		},
		readRevertOperation: async (planId) => {
			const rows = await pgDb
				.select()
				.from(revertOperations)
				.where(eq(revertOperations.id, planId));
			const row = rows[0];
			if (!row) throw new Error("revert operation vanished");
			return {
				status: row.status,
				appliedFileCount: row.appliedFileCount,
				reason: row.reason,
				coverageComplete: row.coverageComplete,
			};
		},
	};
}
