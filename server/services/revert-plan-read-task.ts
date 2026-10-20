import type { Database } from "bun:sqlite";
import { FILE_CHANGE_BLOB_BUDGET_ID } from "@shared/file-change-protocol";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { fileChangeStorageBudgets } from "../db/schema";
import {
	assertFileValues,
	assertPlanned,
	assertSameRevision,
	assertScope,
	catalogRef,
	digest,
	type Executor,
	evidenceBudget,
	type FileRecord,
	fail,
	fileValues,
	headerFromRow,
	integer,
	metadata,
	normalizeFile,
	type PlanRecord,
	planHash,
	refBytes,
	requireOwner,
	requireReadyRef,
	selectFiles,
	stateBytes,
	stateRef,
} from "./revert-plan-read";
import type {
	RevertPlanFileCursor,
	RevertPlanManifestProof,
	RevertPlanOwner,
} from "./revert-plan-service";

export type RevertPlanReadTask = {
	kind: "revertPlanReadV1";
	owner: RevertPlanOwner;
	planId: string;
} & (
	| { action: "owner" }
	| { action: "files"; cursor?: RevertPlanFileCursor; limit: number }
	| { action: "append"; namespaceKey: string; now: string }
	| { action: "proof"; namespaceKey: string; proof: RevertPlanManifestProof; now: string }
	| {
			action: "page";
			namespaceKey: string;
			proof: RevertPlanManifestProof;
			now: string;
			original: PlanRecord;
			cursor?: RevertPlanFileCursor;
	  }
);
export interface RevertPlanReadPage {
	rows: FileRecord[];
	verified: { sequence: number; digest: string; bytes: number }[];
}

export function assertRevertPlanNamespace(tx: Executor, namespaceKey: string) {
	const budget = tx
		.select({
			status: fileChangeStorageBudgets.status,
			namespaceKey: fileChangeStorageBudgets.namespaceKey,
		})
		.from(fileChangeStorageBudgets)
		.where(eq(fileChangeStorageBudgets.id, FILE_CHANGE_BLOB_BUDGET_ID))
		.get();
	if (budget?.status !== "ready" || budget.namespaceKey !== namespaceKey)
		throw fail("CATALOG_UNVERIFIED", "The physical blob namespace must be reconciled and ready");
}
export function readRevertPlanRefs(tx: Executor, row: PlanRecord, namespaceKey: string) {
	assertRevertPlanNamespace(tx, namespaceKey);
	return {
		selector: catalogRef(tx, row.selectorBlobDigest),
		plan: catalogRef(tx, row.planBlobDigest),
		historyManifest: catalogRef(tx, row.historyManifestBlobDigest),
	};
}
export function assertRevertPlanProof(
	tx: Executor,
	row: PlanRecord,
	namespaceKey: string,
	proof: RevertPlanManifestProof,
) {
	const refs = readRevertPlanRefs(tx, row, namespaceKey);
	const header = headerFromRow(row, refs);
	if (proof.headerDigest !== digest(header) || row.planHash !== planHash(header, refs.plan, proof))
		throw fail("REQUEST_CONFLICT", "The complete manifest/header commitment changed");
	evidenceBudget(refBytes(refs) + proof.fileEvidenceBytes);
	return refs;
}
export interface RevertPlanAppendRead {
	operation: PlanRecord;
	refs: ReturnType<typeof readRevertPlanRefs>;
}

/** One bounded page and its dependent checks share the original read snapshot. */
export function readRevertPlanTask(
	database: { transaction<T>(work: (tx: Executor) => T): T },
	task: RevertPlanReadTask,
): PlanRecord | FileRecord[] | RevertPlanReadPage | RevertPlanAppendRead {
	return database.transaction((tx) => {
		const operation = requireOwner(tx, task.owner, task.planId);
		if (task.action === "owner") return operation;
		if (task.action === "files") return selectFiles(tx, task.planId, task.cursor, task.limit);
		if (task.action === "page") assertSameRevision(task.original, operation);
		if (task.action === "append") assertPlanned(operation);
		const expiresAt = Date.parse(operation.expiresAt);
		if (!Number.isFinite(expiresAt) || expiresAt <= Date.parse(task.now))
			throw fail("EXPIRED", "The fixed plan expired; rebuild it without deleting its journal");
		if (task.action === "append")
			return { operation, refs: readRevertPlanRefs(tx, operation, task.namespaceKey) };
		assertRevertPlanProof(tx, operation, task.namespaceKey, task.proof);
		if (task.action === "proof") return operation;
		const rows = selectFiles(tx, task.planId, task.cursor, 33);
		const verified: RevertPlanReadPage["verified"] = [];
		for (const row of rows.slice(0, 32)) {
			metadata(row);
			const file = normalizeFile({
				sequence: row.sequence,
				identity: row.identityJson,
				expected: row.expectedStateJson,
				desired: row.desiredStateJson,
			});
			integer(file.sequence, "sequence", 0, operation.fileCount - 1);
			assertFileValues(row, fileValues(operation, file));
			assertScope(tx, file.identity);
			for (const ref of [stateRef(file.expected), stateRef(file.desired)])
				if (ref) requireReadyRef(tx, ref);
			verified.push({
				sequence: file.sequence,
				digest: digest(file),
				bytes: stateBytes(file.expected) + stateBytes(file.desired),
			});
		}
		return { rows, verified };
	});
}

export function executeRevertPlanReadTask(connection: Database, task: RevertPlanReadTask) {
	return readRevertPlanTask(drizzle(connection), task);
}
