import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SQL } from "bun";
import { applyPendingMigrationsByHash } from "../run-migrations";

const root = resolve(import.meta.dir, "../../..");
const sqliteMigration = readFileSync(
	resolve(root, "drizzle/0182_reference_cost_status.sql"),
	"utf8",
);
test("SQLite cost migration preserves historical amounts and unknown coverage", () => {
	const db = new Database(":memory:");
	try {
		db.exec(
			"CREATE TABLE api_requests(id text primary key, cost_usd real); CREATE TABLE narrator_messages(id text primary key, cost_usd real); CREATE TABLE narrator_tool_calls(id text primary key, total_cost real); CREATE TABLE credential_usage_totals(id text primary key, cost_usd real, unpriced_request_count integer); CREATE TABLE user_usage_totals(user_id text primary key, cost_usd real, unpriced_request_count integer)",
		);
		db.exec(
			"INSERT INTO api_requests VALUES ('old', 12.5); INSERT INTO narrator_messages VALUES ('old', 3.25); INSERT INTO narrator_tool_calls VALUES ('old', 4.5); INSERT INTO credential_usage_totals VALUES ('old', 20, 2); INSERT INTO user_usage_totals VALUES ('old', 30, 3)",
		);
		for (const statement of sqliteMigration.split("--> statement-breakpoint")) db.exec(statement);
		expect(db.query("SELECT * FROM api_requests").get()).toEqual({
			id: "old",
			cost_usd: 12.5,
			cost_status: null,
			cost_missing_fields: null,
		});
		expect(db.query("SELECT * FROM narrator_messages").get()).toMatchObject({
			cost_usd: 3.25,
			cost_status: null,
		});
		expect(db.query("SELECT * FROM narrator_tool_calls").get()).toMatchObject({
			total_cost: 4.5,
			cost_status: null,
		});
		expect(db.query("SELECT * FROM credential_usage_totals").get()).toMatchObject({
			cost_usd: 20,
			unpriced_request_count: 2,
			partial_request_count: 0,
		});
		expect(db.query("SELECT * FROM user_usage_totals").get()).toMatchObject({
			cost_usd: 30,
			unpriced_request_count: 3,
			partial_request_count: 0,
		});
	} finally {
		db.close();
	}
});

test("SQLite journal applies the cost migration idempotently to a fresh database", () => {
	const db = new Database(":memory:");
	try {
		applyPendingMigrationsByHash(db, resolve(root, "drizzle"));
		applyPendingMigrationsByHash(db, resolve(root, "drizzle"));
		expect(
			db
				.query<{ name: string }, []>("PRAGMA table_info(api_requests)")
				.all()
				.some((row) => row.name === "cost_status"),
		).toBe(true);
	} finally {
		db.close();
	}
});

// Explicit opt-in, using only newly created databases with our own prefix.
const postgresUrl = process.env.NF_REFERENCE_COST_PG_URL;
test.skipIf(!postgresUrl)(
	"PostgreSQL fresh install and populated 0002 upgrade preserve historical costs",
	async () => {
		if (!postgresUrl) throw new Error("Explicit PostgreSQL test URL required");
		const admin = new SQL(postgresUrl);
		const journal = JSON.parse(
			readFileSync(resolve(root, "drizzle-postgres/meta/_journal.json"), "utf8"),
		) as { entries: { tag: string }[] };
		const migrations = journal.entries.map((entry) =>
			readFileSync(resolve(root, `drizzle-postgres/${entry.tag}.sql`), "utf8"),
		);
		const target = journal.entries.findIndex((entry) => entry.tag === "0003_reference_cost_status");
		expect(target).toBeGreaterThan(0);
		const names = [`reference_cost_fresh_${process.pid}`, `reference_cost_upgrade_${process.pid}`];
		try {
			for (const [index, name] of names.entries()) {
				await admin.unsafe(`CREATE DATABASE "${name}"`);
				const url = new URL(postgresUrl);
				url.pathname = `/${name}`;
				const db = new SQL(url.toString());
				try {
					for (const migration of migrations.slice(0, target)) {
						for (const statement of migration
							.split("--> statement-breakpoint")
							.filter((value) => value.trim()))
							await db.unsafe(statement);
					}
					if (index === 1) {
						await db`INSERT INTO api_requests (id, cost_usd, created_at) VALUES ('history', 12.5, '2026-01-01')`;
						await db`INSERT INTO credential_usage_totals (id, provider, credential_id, model, cost_usd, unpriced_request_count, first_seen_at, last_seen_at) VALUES ('history', 'openai', 'fixture', 'old', 20, 2, '2026-01-01', '2026-01-01')`;
					}
					for (const migration of migrations.slice(target)) {
						for (const statement of migration
							.split("--> statement-breakpoint")
							.filter((value) => value.trim()))
							await db.unsafe(statement);
					}
					const [columns] =
						await db`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND column_name='cost_status'`;
					expect(columns.n).toBe(3);
					if (index === 1) {
						const [row] =
							await db`SELECT cost_usd, cost_status, cost_missing_fields FROM api_requests WHERE id='history'`;
						expect(row).toEqual({ cost_usd: 12.5, cost_status: null, cost_missing_fields: null });
						const [total] =
							await db`SELECT cost_usd, unpriced_request_count, partial_request_count FROM credential_usage_totals WHERE id='history'`;
						expect(total).toEqual({
							cost_usd: 20,
							unpriced_request_count: 2,
							partial_request_count: 0,
						});
					}
					await db`INSERT INTO user_usage_totals(user_id, cost_usd, partial_request_count, first_used_at, last_used_at) VALUES ('fixture', 1, 1, '2026-01-01', '2026-01-01')`;
					const [newTotal] =
						await db`SELECT partial_request_count FROM user_usage_totals WHERE user_id='fixture'`;
					expect(newTotal.partial_request_count).toBe(1);
				} finally {
					await db.close();
				}
			}
		} finally {
			for (const name of names) await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
			await admin.close();
		}
	},
	120_000,
);
