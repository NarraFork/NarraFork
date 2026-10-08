import { Database } from "bun:sqlite";
import { getTableName, is, SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { getTableConfig, SQLiteSyncDialect, type SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "../../db/schema";

/** TEST ONLY: actual schema columns, FKs/checks/indexes in memory; no live singleton/migrations. */
export function fixtureDatabase() {
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys=ON");
	const dialect = new SQLiteSyncDialect();
	const done = new Set<SQLiteTable>();
	const quoted = (value: string) => `"${value.replaceAll('"', '""')}"`;
	const materialize = (table: SQLiteTable) => {
		if (done.has(table)) return;
		done.add(table);
		const config = getTableConfig(table);
		for (const fk of config.foreignKeys) materialize(fk.reference().foreignTable);
		const columns = config.columns.map((column) => {
			let text = `${quoted(column.name)} ${column.getSQLType()}`;
			if (column.primary) text += " PRIMARY KEY";
			if (column.notNull) text += " NOT NULL";
			if (column.isUnique) text += " UNIQUE";
			if (column.default !== undefined) {
				const value = is(column.default, SQL)
					? column.default
					: column.mapToDriverValue(column.default);
				const expression = is(value, SQL)
					? dialect.sqlToQuery(value).sql
					: typeof value === "string"
						? `'${value.replaceAll("'", "''")}'`
						: String(value);
				text += ` DEFAULT (${expression})`;
			}
			return text;
		});
		for (const fk of config.foreignKeys) {
			const ref = fk.reference();
			columns.push(
				`FOREIGN KEY (${ref.columns.map((c) => quoted(c.name)).join(",")}) REFERENCES ${quoted(getTableName(ref.foreignTable))} (${ref.foreignColumns.map((c) => quoted(c.name)).join(",")}) ON DELETE ${fk.onDelete ?? "NO ACTION"}`,
			);
		}
		for (const check of config.checks)
			columns.push(`CHECK (${dialect.sqlToQuery(check.value).sql})`);
		for (const key of config.primaryKeys)
			columns.push(`PRIMARY KEY (${key.columns.map((c) => quoted(c.name)).join(",")})`);
		for (const unique of config.uniqueConstraints)
			columns.push(`UNIQUE (${unique.columns.map((c) => quoted(c.name)).join(",")})`);
		const ddl = `CREATE TABLE ${quoted(config.name)} (${columns.join(",")})`;
		try {
			sqlite.exec(ddl);
		} catch (error) {
			throw new Error(`Fixture DDL failed: ${ddl}`, { cause: error });
		}
		for (const index of config.indexes) {
			const fields = index.config.columns
				.map((c) => ("name" in c ? quoted(c.name) : dialect.sqlToQuery(c).sql))
				.join(",");
			const where = index.config.where
				? ` WHERE ${dialect.sqlToQuery(index.config.where).sql}`
				: "";
			sqlite.exec(
				`CREATE ${index.config.unique ? "UNIQUE " : ""}INDEX ${quoted(index.config.name)} ON ${quoted(config.name)} (${fields})${where}`,
			);
		}
	};
	for (const table of [
		schema.narratorWorktreeResources,
		schema.terminals,
		schema.containerInstances,
		schema.portAllocations,
		schema.terminalViewState,
		schema.volumeSnapshots,
		schema.volumeSnapshotApplications,
		schema.aclGrants,
	])
		materialize(table);
	return { sqlite, database: drizzle({ client: sqlite, schema }) };
}
