import type { Database } from "bun:sqlite";
import { FILE_CHANGE_BLOB_BUDGET_ID } from "@shared/file-change-protocol";
import { and, asc, eq, sql } from "drizzle-orm";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import {
	fileChangeBlobs as blobs,
	fileChangeStorageBudgets as budgets,
	fileChangeBlobReservations as reservations,
} from "../db/schema";

export type FileChangeBlobCatalogReadParams = {
	kind: "fileChangeBlobCatalogV1";
} & (
	| { mode: "metadata"; digest: string }
	| {
			mode: "reservations";
			status: "reserved" | "reconcile_required";
			limit: number;
			after?: { createdAt: string; id: string };
	  }
);

export function executeFileChangeBlobCatalogRead(
	client: Database,
	params: FileChangeBlobCatalogReadParams,
) {
	return readFileChangeBlobCatalog(drizzle(client), params);
}

export function readFileChangeBlobCatalog(
	db: { transaction<T>(work: (tx: Pick<BunSQLiteDatabase, "select">) => T): T },
	params: FileChangeBlobCatalogReadParams,
) {
	return db.transaction((tx) => {
		const budget = tx
			.select()
			.from(budgets)
			.where(eq(budgets.id, FILE_CHANGE_BLOB_BUDGET_ID))
			.get();
		if (params.mode === "metadata") {
			const blob = tx.select().from(blobs).where(eq(blobs.digest, params.digest)).get();
			return { budget, blob, reservations: [] };
		}
		const rows = tx
			.select()
			.from(reservations)
			.where(
				and(
					eq(reservations.budgetId, FILE_CHANGE_BLOB_BUDGET_ID),
					eq(reservations.status, params.status),
					params.after
						? sql`(${reservations.createdAt}, ${reservations.id}) > (${params.after.createdAt}, ${params.after.id})`
						: undefined,
				),
			)
			.orderBy(asc(reservations.createdAt), asc(reservations.id))
			.limit(params.limit + 1)
			.all();
		return { budget, blob: undefined, reservations: rows };
	});
}
