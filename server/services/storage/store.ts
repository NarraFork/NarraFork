/**
 * The one place that decides which backend answers "how big is the database".
 *
 * The master database selector owns this choice. SQLite uses its worker-backed breakdown adapter;
 * PostgreSQL uses an explicit unsupported adapter until a server-side relation-size scan contract is
 * implemented. The latter is intentional: storage UI must say "unavailable" rather than render a
 * SQLite-shaped zero for a database NarraFork cannot measure safely.
 */
import { activeDatabaseBackend } from "@server/db";
import type { DatabaseStoragePort } from "./database-storage-port";
import { postgresDatabaseStoragePort } from "./postgres-database-storage";
import { sqliteDatabaseStoragePort } from "./sqlite-database-storage";

/** Select by the master backend, never by an independent read/write knob. */
export const databaseStoragePort: DatabaseStoragePort =
	activeDatabaseBackend === "postgres" ? postgresDatabaseStoragePort : sqliteDatabaseStoragePort;
