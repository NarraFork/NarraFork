import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { TOKEN_ACCOUNTING_VERSION } from "@shared/token-accounting";

const sqliteMigration = new URL(
	"../../../drizzle/0226_token_accounting_version.sql",
	import.meta.url,
);
const postgresMigration = new URL(
	"../../../drizzle-postgres/0043_token_accounting_version.sql",
	import.meta.url,
);

test("accounting migration keeps historical buckets intact and marks them pending", async () => {
	const database = new Database(":memory:");
	try {
		database.exec(`CREATE TABLE api_requests (
			id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
			input_tokens INTEGER, cached_input_tokens INTEGER, cache_creation_input_tokens INTEGER,
			output_tokens INTEGER, cost_usd REAL
		);
		INSERT INTO api_requests VALUES ('old', '2026-01-01', 1000, 800, 50, 100, 0.25);`);
		database.exec(await Bun.file(sqliteMigration).text());
		expect(database.query("SELECT * FROM api_requests").get()).toEqual({
			id: "old",
			created_at: "2026-01-01",
			input_tokens: 1000,
			cached_input_tokens: 800,
			cache_creation_input_tokens: 50,
			output_tokens: 100,
			cost_usd: 0.25,
			token_accounting_version: null,
		});
		const columns = database.query("PRAGMA table_info(api_requests)").all() as {
			name: string;
			notnull: number;
			dflt_value: string | null;
		}[];
		expect(columns.find((column) => column.name === "token_accounting_version")).toMatchObject({
			notnull: 0,
			dflt_value: null,
		});
		database
			.query("INSERT INTO api_requests (id, created_at, token_accounting_version) VALUES (?, ?, ?)")
			.run("new", "2026-01-02", TOKEN_ACCOUNTING_VERSION);
		expect(
			database
				.query(
					`SELECT id FROM api_requests INDEXED BY idx_api_requests_token_accounting_pending
					 WHERE token_accounting_version IS NULL ORDER BY created_at, id LIMIT 100`,
				)
				.all(),
		).toEqual([{ id: "old" }]);
	} finally {
		database.close();
	}
});

test("generated PostgreSQL migration has the same nullable field and partial range index", async () => {
	const migration = await Bun.file(postgresMigration).text();
	expect(migration).toContain(
		'ALTER TABLE "api_requests" ADD COLUMN "token_accounting_version" integer;',
	);
	expect(migration).toContain(
		'CREATE INDEX "idx_api_requests_token_accounting_pending" ON "api_requests" USING btree ("created_at","id") WHERE "token_accounting_version" IS NULL;',
	);
	expect(migration).not.toMatch(/\b(UPDATE|DELETE|INSERT|DEFAULT|NOT NULL)\b/);
});
