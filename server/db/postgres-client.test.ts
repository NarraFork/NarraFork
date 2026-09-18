import { describe, expect, test } from "bun:test";
import { sql as sqlExpr } from "drizzle-orm";
import { withPostgres } from "../../tests/db/pg-test-harness";
import { createPostgresClient } from "./postgres-client";

describe("postgres client construction", () => {
	test("fails closed for missing URL", () => {
		expect(() => createPostgresClient({ driver: "bun-sql", url: "" })).toThrow("URL is required");
	});

	test.todo("rejects unsupported drivers at the runtime boundary", () => {});

	test("does not connect until used and close is idempotent", async () => {
		const client = createPostgresClient({
			driver: "bun-sql",
			url: "postgres://user:secret@127.0.0.1:1/db",
		});
		await client.close();
		await client.close();
	});
});

describe("postgres client real connection", () => {
	// Opt-in via PG_INTEGRATION=1: the probe provisions a throwaway container. When it
	// is requested, an unavailable database must fail the test — a harness "blocked"
	// result is never allowed to pass as a verified connection.
	test.skipIf(process.env.PG_INTEGRATION !== "1")(
		"connects to an isolated PostgreSQL 17 and runs read-only queries",
		async () => {
			const result = await withPostgres(async ({ port, schema, exec }) => {
				const password = "test-password-must-not-appear";
				const passwordSql = password.replaceAll("'", "''");
				const identity = await exec("SELECT current_user;");
				expect(identity.code).toBe(0);
				const user = identity.stdout.trim();
				expect(user).not.toBe("");
				const passwordResult = await exec(`ALTER ROLE CURRENT_USER PASSWORD '${passwordSql}';`);
				expect(passwordResult.code).toBe(0);
				const client = createPostgresClient({
					driver: "bun-sql",
					url: `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/nf_harness`,
					max: 2,
					idleTimeout: 1,
					maxLifetime: 10,
					connectTimeout: 5,
				});
				try {
					const select = await client.sql`SELECT 1 AS value`;
					expect(select[0]?.value).toBe(1);
					// The Drizzle instance must talk to the same live connection, not just construct.
					// drizzle-orm/bun-sql resolves execute() to the row array itself.
					const viaDrizzle = (await client.db.execute(sqlExpr`SELECT 1 AS value`)) as unknown as {
						value: number;
					}[];
					expect(viaDrizzle[0]?.value).toBe(1);
					const schemaRows = await client.sql`
						SELECT schema_name FROM information_schema.schemata WHERE schema_name = ${schema}
					`;
					expect(schemaRows[0]?.schema_name).toBe(schema);
					const sentinel = (await client.db.execute(
						sqlExpr`SELECT value FROM ${sqlExpr.identifier(schema)}.sentinel`,
					)) as unknown as { value: number }[];
					expect(sentinel[0]?.value).toBe(1);
					await client.close();
					await client.close();
				} finally {
					await client.close();
				}
				return "connected";
			});
			if (typeof result !== "string") {
				throw new Error(
					`real PostgreSQL connection unavailable: ${result.status === "blocked" || result.status === "failed" ? result.reason : "unexpected harness result"}`,
				);
			}
			expect(result).toBe("connected");
		},
		300_000,
	);

	test("redacts URL credentials and honors connection timeout", async () => {
		const password = "secret-password-for-redaction";
		const client = createPostgresClient({
			driver: "bun-sql",
			url: `postgres://user:${encodeURIComponent(password)}@192.0.2.1:5432/db`,
			connectTimeout: 1,
		});
		try {
			let errorMessage = "";
			try {
				await client.sql`SELECT 1`;
			} catch (error) {
				errorMessage = error instanceof Error ? error.message : String(error);
			}
			expect(errorMessage).not.toBe("");
			expect(errorMessage).not.toContain(password);
			expect(errorMessage).not.toContain(encodeURIComponent(password));
		} finally {
			await client.close();
			await client.close();
		}
	});
});
