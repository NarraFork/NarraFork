import type { Database } from "bun:sqlite";
import { FILE_CHANGE_BLOB_BUDGET_ID } from "@shared/file-change-protocol";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { fileChangeStorageBudgets } from "../db/schema";
import {
	assertRevision,
	catalogRef,
	fail,
	requireOperation,
	selectFiles,
} from "./revert-journal-read";
import type {
	RevertJournalContext,
	RevertJournalDatabase,
	RevertJournalOperation,
	RevertJournalTransaction,
} from "./revert-mutation-journal";

export type RevertJournalReadTask = {
	kind: "revertJournalReadV1";
	context: RevertJournalContext;
} & (
	| { action: "operation" }
	| { action: "files"; cursor?: string; limit: number }
	| { action: "catalog"; digest: string }
	| { action: "start"; namespaceKey: string }
	| { action: "page"; original: RevertJournalOperation; namespaceKey: string; cursor?: string }
);
export function assertJournalNamespace(tx: RevertJournalTransaction, namespaceKey: string) {
	const row = tx
		.select({
			status: fileChangeStorageBudgets.status,
			namespaceKey: fileChangeStorageBudgets.namespaceKey,
		})
		.from(fileChangeStorageBudgets)
		.where(eq(fileChangeStorageBudgets.id, FILE_CHANGE_BLOB_BUDGET_ID))
		.get();
	if (row?.status !== "ready" || row.namespaceKey !== namespaceKey)
		throw fail("CATALOG_UNVERIFIED", "The physical evidence namespace must be ready");
}
export function readJournalManifests(
	tx: RevertJournalTransaction,
	operation: RevertJournalOperation,
	namespaceKey: string,
) {
	assertJournalNamespace(tx, namespaceKey);
	return [
		operation.planBlobDigest,
		operation.selectorBlobDigest,
		operation.historyManifestBlobDigest,
	].reduce((sum, value) => sum + catalogRef(tx, value).sizeBytes, 0);
}
/** Preserve the journal page's revision, namespace and row snapshot. */
export function readRevertJournalTask(
	database: Pick<RevertJournalDatabase, "transaction">,
	task: RevertJournalReadTask,
) {
	return database.transaction((tx) => {
		if (task.action === "catalog") return catalogRef(tx, task.digest);
		const operation = requireOperation(tx, task.context);
		if (task.action === "operation") return operation;
		if (task.action === "files") return selectFiles(tx, operation.id, task.cursor, task.limit);
		if (task.action === "start")
			return { operation, bytes: readJournalManifests(tx, operation, task.namespaceKey) };
		assertRevision(task.original, operation);
		assertJournalNamespace(tx, task.namespaceKey);
		return selectFiles(tx, operation.id, task.cursor, 33);
	});
}
export function executeRevertJournalReadTask(connection: Database, task: RevertJournalReadTask) {
	return readRevertJournalTask(drizzle(connection), task);
}
