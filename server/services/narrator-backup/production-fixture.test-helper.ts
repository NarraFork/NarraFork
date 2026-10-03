import type { Database } from "bun:sqlite";
import { getTestDb } from "../../../tests/setup";

/** Ancillary ACL/device DDL comes from production migrations, never guessed owner columns. */
const schema = getTestDb().sqlite;
export const productionBackupSchema = schema.serialize();
export const productionBackupAccessDDL = [
	"projects",
	"chapters",
	"remote_devices",
	"acl_grants",
	"integration_resource_bindings",
	"integration_authorities",
	"integration_capability_grants",
	"oauth_clients",
].map(
	(name) =>
		(
			schema.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(name) as {
				sql: string;
			}
		).sql,
);
schema.close();
export function installProductionBackupAccessTables(db: Database) {
	for (const sql of productionBackupAccessDDL) db.run(sql);
}
