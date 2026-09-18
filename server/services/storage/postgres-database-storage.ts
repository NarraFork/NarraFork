/**
 * PostgreSQL storage measurement adapter.
 *
 * PostgreSQL owns relation storage on the server and NarraFork has no bounded, portable
 * relation-size scan contract yet. Refuse explicitly instead of reporting SQLite-shaped zeroes.
 */
import {
	type DatabaseStorageCapabilities,
	type DatabaseStoragePort,
	type DatabaseStorageScanOptions,
	DatabaseStorageUnsupportedError,
} from "./database-storage-port";

const BACKEND = "postgres";

export const postgresDatabaseStoragePort: DatabaseStoragePort = {
	get capabilities(): DatabaseStorageCapabilities {
		return {
			backend: BACKEND,
			breakdown: false,
			freeSpaceAccounting: false,
			cleanupCandidates: false,
			offRequestThreadScan: false,
		};
	},

	async scanBreakdown(_options: DatabaseStorageScanOptions = {}) {
		throw new DatabaseStorageUnsupportedError(BACKEND, "breakdown");
	},
};
