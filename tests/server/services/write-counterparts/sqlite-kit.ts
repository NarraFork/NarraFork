/**
 * The SQLite implementation of the equivalence kit: the production classes
 * (`FileChangeBlobCatalog`, `WorkspaceWriteCoordinator`, `FileChangeEvidenceService`,
 * `RevertPlanService`, `RevertMutationJournal`) behind the suite's facades.
 *
 * Lives in `tests/` so BOTH runners share it: the always-on SQLite baseline
 * (`server/services/__tests__/write-counterparts-equivalence.test.ts`) passes the
 * isolated application db, and the PostgreSQL runner passes an in-memory test db
 * over a mocked `@server/db` — the exact equivalence comparison needs the SAME
 * factory on both sides.
 *
 * The `db` parameter is a root handle with the full production schema, foreign
 * keys ON and busy_timeout ≤ 250ms (the catalog/journal constructors check both).
 */
import { eq } from "drizzle-orm";
import type { db as appDb } from "../../../../server/db";
import {
	fileChangeScopes,
	fileChangeStorageBudgets,
	revertOperationFiles,
	revertOperations,
	workspaceWriteLeases,
} from "../../../../server/db/schema";
import { generateId } from "../../../../server/lib/id";
import {
	FILE_CHANGE_BLOB_BUDGET_ID,
	FileChangeBlobCatalog,
} from "../../../../server/services/file-change-blob-catalog";
import type { FileChangeBlobRelease } from "../../../../server/services/file-change-blob-store";
import { FileChangeEvidenceService } from "../../../../server/services/file-change-evidence";
import type { FileChangeScopeIdentity } from "../../../../server/services/file-change-identity";
import { RevertMutationJournal } from "../../../../server/services/revert-mutation-journal";
import { RevertPlanService } from "../../../../server/services/revert-plan-service";
import {
	createWorkspaceWriteCoordinatorState,
	WorkspaceWriteCoordinator,
} from "../../../../server/services/workspace-write-coordinator";
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

export function makeSqliteKit(db: typeof appDb): EquivalenceKit {
	const blobCatalog = new FileChangeBlobCatalog({ db, namespaceKey: NAMESPACE });
	const evidence = new FileChangeEvidenceService(db);
	const plans = new RevertPlanService(db, { namespaceKey: NAMESPACE });
	const journal = new RevertMutationJournal(db, { namespaceKey: NAMESPACE });
	const coordinator = new WorkspaceWriteCoordinator({
		db,
		state: createWorkspaceWriteCoordinatorState(),
		readRuntime: () => RUNTIME,
	});

	const blob: BlobCatalogFacade = {
		getBudget: async () => blobCatalog.getBudget(),
		initializeNamespace: async (input) => blobCatalog.initializeNamespace(input),
		beginReconciliation: async (input) => blobCatalog.beginReconciliation(input),
		completeReconciliation: async (input) => blobCatalog.completeReconciliation(input),
		reserve: async (input) => {
			const lease = blobCatalog.reserve(input);
			return {
				reservationId: lease.reservationId,
				ownerEpoch: lease.ownerEpoch,
				generation: lease.generation,
				release: async (releaseInput: FileChangeBlobRelease) => lease.release(releaseInput),
			};
		},
		getMetadata: async (input) => blobCatalog.getMetadata(input),
		reconcileBlob: async (input) => blobCatalog.reconcileBlob(input),
	};

	const scopeRow = async (scope: Readonly<FileChangeScopeIdentity>) => {
		const row = await db.query.fileChangeScopes.findFirst({
			where: eq(fileChangeScopes.id, scope.id),
		});
		if (!row) throw new Error("scope vanished");
		return row as unknown as Record<string, unknown>;
	};

	const workspace: WorkspaceLeaseFacade = {
		runCleanWrite: async (scope, ranges) => {
			let counterDuringWrite: unknown;
			await coordinator.withWrite({ scope, runtime: RUNTIME, ranges }, async (lease) => {
				lease.registerMutation("mutation-1");
				counterDuringWrite = (await scopeRow(scope)).activeMutationCount;
				lease.settle("mutation-1", "applied");
			});
			return { counterDuringWrite };
		},
		runUncertainWrite: async (scope, ranges) => {
			await coordinator.withWrite({ scope, runtime: RUNTIME, ranges }, async (lease) => {
				lease.registerMutation("mutation-uncertain");
				lease.markUncertain();
			});
		},
		admitLease: async (scope) => {
			await coordinator.withWrite({ scope, runtime: RUNTIME, waitTimeoutMs: 0 }, async () => {});
		},
		readLeases: async (scope) =>
			db
				.select()
				.from(workspaceWriteLeases)
				.where(eq(workspaceWriteLeases.scopeId, scope.id))
				.all(),
		readScope: scopeRow,
	};

	const evidenceFacade: EvidenceFacade = {
		prepareScope: async (input) => evidence.prepareScope(input),
		recordScopeVerification: async (input) => evidence.recordScopeVerification(input),
		beginOperation: async (input) => evidence.beginOperation(input),
		prepareEffects: async (operationId, inputs) => evidence.prepareEffects(operationId, inputs),
		finalizePreparation: async (operationId) => evidence.finalizePreparation(operationId),
		markApplying: async (input) => evidence.markApplying(input),
		settleEffect: async (input) => evidence.settleEffect(input),
		finishOperation: async (operationId, outcome) => evidence.finishOperation(operationId, outcome),
		getOperation: async (operationId) => evidence.getOperation(operationId),
		getEffect: async (operationId, mutationId) => evidence.getEffect(operationId, mutationId),
	};

	const plan: PlanFacade = {
		begin: async (input) => plans.begin(input),
		appendFiles: async (owner, planId, inputs) => plans.appendFiles(owner, planId, inputs),
		finalize: async (owner, planId, proof) => plans.finalize(owner, planId, proof),
	};

	const journalFacade: JournalFacade = {
		startExecution: async (ctx, proof) => journal.startExecution(ctx, proof),
		claimApply: async (ctx, fixed, lease) => journal.claimApply(ctx, fixed, lease),
		recordApplyReceipt: async (ctx, fileId, receipt) =>
			journal.recordApplyReceipt(ctx, fileId, receipt),
		finishFiles: async (ctx) => journal.finishFiles(ctx),
		commit: async (ctx, probe) =>
			journal.commit(ctx, {
				db,
				apply: (tx) => {
					probe.apply();
					tx.update(fileChangeStorageBudgets)
						.set({ updatedAt: "history-marker" })
						.where(eq(fileChangeStorageBudgets.id, FILE_CHANGE_BLOB_BUDGET_ID))
						.run();
				},
			}),
		beginCompensation: async (ctx) => journal.beginCompensation(ctx),
		claimCompensate: async (ctx, fixed, lease) => journal.claimCompensate(ctx, fixed, lease),
		recordCompensateReceipt: async (ctx, fileId, receipt) =>
			journal.recordCompensateReceipt(ctx, fileId, receipt),
		finishCompensation: async (ctx) => journal.finishCompensation(ctx),
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
			const prepared = evidence.prepareScope({
				sourceInstanceId: "source-1",
				deviceId: "device-1",
				workspaceInstanceId,
				pathFlavor: "posix",
				canonicalRoot,
			});
			evidence.recordScopeVerification({
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
			const current = await db.query.fileChangeScopes.findFirst({
				where: eq(fileChangeScopes.id, scope.id),
			});
			if (!current) throw new Error("scope vanished");
			const leaseId = `durable-lease-${generateId(6)}`;
			const fencingToken = current.fencingToken + 1;
			const revision = current.revision + 1;
			await db
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
			const row = await db.query.revertOperationFiles.findFirst({
				where: eq(revertOperationFiles.id, fileId),
			});
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
			const row = await db.query.fileChangeStorageBudgets.findFirst({
				where: eq(fileChangeStorageBudgets.id, FILE_CHANGE_BLOB_BUDGET_ID),
			});
			return row?.updatedAt === "history-marker";
		},
		readRevertOperation: async (planId) => {
			const row = await db.query.revertOperations.findFirst({
				where: eq(revertOperations.id, planId),
			});
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
