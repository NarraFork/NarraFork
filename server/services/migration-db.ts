/**
 * Backend access for the startup migrations (aggregation values, reserved `auto` prefix).
 *
 * They were written against the synchronous SQLite handle, which does not exist under
 * PostgreSQL (server/db/index.ts makes `db` a fail-closed proxy there). This adapter runs the
 * same queries on either backend: reads are awaited, and a batch of updates runs in one
 * transaction — synchronous on SQLite, async on PostgreSQL.
 */
import type { SelectedFields, SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { activeDatabaseBackend, db } from "../db";

const isPg = () => activeDatabaseBackend === "postgres";

/**
 * The PostgreSQL handle, injected by the composition root (postgres-composition.ts). A static
 * import of postgresRuntime would break the SQLite tests, which mock ../db with { db, sqlite };
 * an async getter cannot work either, because awaiting a Drizzle builder executes it.
 */
// biome-ignore lint/suspicious/noExplicitAny: PostgreSQL driver handle
let pgHandle: any = null;
// biome-ignore lint/suspicious/noExplicitAny: PostgreSQL driver handle
export function setMigrationPgHandle(handle: any): void {
	pgHandle = handle;
}

/** A SELECT builder on the active backend (PostgreSQL's handle, not the SQLite proxy). */
export function selectFrom<T extends SQLiteTable>(
	table: T,
	columns: SelectedFields<SQLiteColumn, SQLiteTable>,
) {
	if (isPg()) {
		if (!pgHandle) throw new Error("PostgreSQL runtime is not ready");
		return pgHandle.select(columns).from(table);
	}
	return db.select(columns).from(table);
}

/** One SELECT builder → its rows. */
// biome-ignore lint/suspicious/noExplicitAny: driver-specific builder, awaited or .all()
export async function allRows<T>(builder: any): Promise<T[]> {
	return isPg() ? await builder : builder.all();
}

/** One SELECT builder → its first row, or undefined. */
// biome-ignore lint/suspicious/noExplicitAny: driver-specific builder, awaited or .get()
export async function firstRow<T>(builder: any): Promise<T | undefined> {
	return isPg() ? (await builder)[0] : builder.get();
}

export interface PlannedUpdate {
	table: SQLiteTable;
	set: Record<string, unknown>;
	where: SQL | undefined;
}

function idColumn(table: SQLiteTable): SQLiteColumn {
	return (table as unknown as { id: SQLiteColumn }).id;
}

/**
 * Apply updates in one transaction and return how many rows were actually written
 * (a conditional update that matched nothing does not count).
 */
export async function applyUpdates(updates: readonly PlannedUpdate[]): Promise<number> {
	if (updates.length === 0) return 0;
	if (isPg()) {
		if (!pgHandle) throw new Error("PostgreSQL runtime is not ready");
		const database = pgHandle;
		// biome-ignore lint/suspicious/noExplicitAny: PostgreSQL transaction handle
		return database.transaction(async (tx: any) => {
			let applied = 0;
			for (const update of updates) {
				const rows = await tx
					.update(update.table)
					.set(update.set)
					.where(update.where)
					.returning({ id: idColumn(update.table) });
				applied += rows.length;
			}
			return applied;
		});
	}
	return db.transaction((tx) => {
		let applied = 0;
		for (const update of updates) {
			applied += tx
				.update(update.table)
				.set(update.set)
				.where(update.where)
				.returning({ id: idColumn(update.table) })
				.all().length;
		}
		return applied;
	});
}
