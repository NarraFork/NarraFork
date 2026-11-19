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
	fileChangeStorageBudgets,
	revertOperationFiles,
	revertOperations,
} from "../../../../server/db/schema";
import {
	FILE_CHANGE_BLOB_BUDGET_ID,
	FileChangeBlobCatalog,
} from "../../../../server/services/file-change-blob-catalog";
import type { FileChangeBlobRelease } from "../../../../server/services/file-change-blob-store";
import { FileChangeEvidenceService } from "../../../../server/services/file-change-evidence";
import { RevertMutationJournal } from "../../../../server/services/revert-mutation-journal";
import { RevertPlanService } from "../../../../server/services/revert-plan-service";
import type {
	BlobCatalogFacade,
	EquivalenceKit,
	EvidenceFacade,
	JournalFacade,
	PlanFacade,
} from "./equivalence-suite";

const NAMESPACE = "equivalence-sqlite";
const OWNER_EPOCH = "sqlite-epoch-1";
const _RUNTIME = { runtimeEpoch: "sqlite-runtime-epoch", runtimeGeneration: 7 };

let serial = 0;

export function makeSqliteKit(db: typeof appDb): EquivalenceKit {
	const blobCatalog = new FileChangeBlobCatalog({ db, namespaceKey: NAMESPACE });
	const evidence = new FileChangeEvidenceService(db);
	const plans = new RevertPlanService(db, { namespaceKey: NAMESPACE });
	const journal = new RevertMutationJournal(db, { namespaceKey: NAMESPACE });

	const blob: BlobCatalogFacade = {
		getBudget: async () => blobCatalog.getBudget(),
		initializeNamespace: async (input) => blobCatalog.initializeNamespace(input),

		reserve: async (input) => {
			const lease = await blobCatalog.reserve(input);
			return {
				reservationId: lease.reservationId,
				ownerEpoch: lease.ownerEpoch,
				generation: lease.generation,
				release: async (releaseInput: FileChangeBlobRelease) => lease.release(releaseInput),
			};
		},
		getMetadata: async (input) => blobCatalog.getMetadata(input),
	};

	const evidenceFacade: EvidenceFacade = {
		prepareScope: async (input) => evidence.prepareScope(input),
		beginOperation: async (input) => evidence.beginOperation(input),
		recordEffect: async (input) => evidence.recordEffect(input),
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
		startFile: async (ctx, fileId) => journal.startFile(ctx, fileId),
		recordResult: async (ctx, fileId, result) => journal.recordResult(ctx, fileId, result),
		finishFiles: async (ctx, options) => journal.finishFiles(ctx, options),
		failHistory: async (ctx, reason) => journal.failHistory(ctx, reason),
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
	};

	return {
		blob,
		evidence: evidenceFacade,
		plan,
		journal: journalFacade,
		namespaceKey: NAMESPACE,
		ownerEpoch: OWNER_EPOCH,
		seedScope: async (overrides = {}) => {
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
			return {
				id: prepared.id,
				sourceInstanceId: prepared.sourceInstanceId,
				deviceId: prepared.deviceId,
				workspaceInstanceId: prepared.workspaceInstanceId,
				pathFlavor: prepared.pathFlavor,
				canonicalRoot: prepared.canonicalRoot,
			};
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
