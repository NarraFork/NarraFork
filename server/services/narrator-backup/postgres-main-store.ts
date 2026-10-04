import type { SQL } from "bun";
import type { ArchiveRow, ArchiveValue } from "../project-archive/main-store";
import { quoteBackupIdentifier } from "./contract";
import { type BackupSqlConnection, SqlNarratorBackupMainStore } from "./main-store";

/** Genuine asynchronous PG statements, including a repeatable-read source snapshot. */
export function postgresBackupConnection(
	client: Pick<SQL, "unsafe" | "begin">,
): BackupSqlConnection {
	const connection: BackupSqlConnection = {
		byteLength(column) {
			return `coalesce(octet_length(${quoteBackupIdentifier(column)}::text),0)`;
		},
		async query(text: string, values: ArchiveValue[] = []) {
			const rows = await client.unsafe(text, values);
			return Array.from(rows, (value: Record<string, unknown>) =>
				Object.fromEntries(
					Object.entries(value).map(([key, item]) => [
						key,
						item instanceof Date
							? item.toISOString()
							: typeof item === "bigint"
								? Number(item)
								: item != null && typeof item === "object"
									? JSON.stringify(item)
									: item,
					]),
				),
			) as ArchiveRow[];
		},
		async columns(table) {
			const rows = await client.unsafe(
				"SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 AND is_generated='NEVER' ORDER BY ordinal_position",
				[table],
			);
			return Array.from(rows, (row: { column_name: string }) => row.column_name);
		},
		async transaction(write, action) {
			return client.begin(async (tx) => {
				await tx.unsafe(
					write
						? "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE"
						: "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
				);
				await tx.unsafe("SET LOCAL lock_timeout='250ms'");
				await tx.unsafe("SET LOCAL statement_timeout='60s'");
				return action(postgresBackupConnection(tx));
			});
		},
	};
	return connection;
}
export function createPostgresNarratorBackupMainStore(client: Pick<SQL, "unsafe" | "begin">) {
	return new SqlNarratorBackupMainStore(postgresBackupConnection(client));
}
