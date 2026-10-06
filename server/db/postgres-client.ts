import { SQL } from "bun";
import { type BunSQLDatabase, drizzle } from "drizzle-orm/bun-sql";
export type PostgresClientOptions = {
	driver: "bun-sql";
	url: string;
	max?: number;
	idleTimeout?: number;
	maxLifetime?: number;
	connectTimeout?: number;
};

export type PostgresClient = {
	sql: SQL;
	db: BunSQLDatabase;
	close(): Promise<void>;
};

function safeError(message: string): Error {
	return new Error(message);
}

/** Creates an explicitly configured, lazily connecting PostgreSQL client. */
export function createPostgresClient(options: PostgresClientOptions): PostgresClient {
	if (options.driver !== "bun-sql") {
		throw safeError("Unsupported PostgreSQL driver");
	}
	if (typeof options.url !== "string" || options.url.length === 0) {
		throw safeError("PostgreSQL URL is required");
	}

	const sql = new SQL(options.url, {
		max: options.max,
		idleTimeout: options.idleTimeout,
		maxLifetime: options.maxLifetime,
		connectTimeout: options.connectTimeout,
	});
	const db = drizzle({ client: sql });
	let closed = false;

	return {
		sql,
		db,
		async close() {
			if (closed) return;
			closed = true;
			await sql.close();
		},
	};
}
