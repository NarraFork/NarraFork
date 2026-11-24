/**
 * The project team tables (P1) behave the same on both dialects: the same statements, run
 * against the migrated SQLite test database and against a PostgreSQL migrated from
 * `drizzle-postgres`, must succeed or be refused alike.
 *
 * What the contract pins: the team row RESTRICTs its narrator and project deletes (the record of
 * a team's worktrees never disappears by cascade); deleting the team cascades its work items and
 * events; worktree and worker references go NULL with their rows; the status / state / review
 * checks and the byte budgets (brief 4 KB, settings 16 KB, changed paths 128 KiB, event detail
 * 8 KB, counted in bytes on both sides); the exclusive key is unique per project only while set.
 *
 * The PostgreSQL half is gated by PG_INTEGRATION=1; when requested, an unavailable database
 * FAILS the test.
 */
import { describe, expect, test } from "bun:test";
import type { PgRemoteDatabase } from "drizzle-orm/pg-proxy";
import { drizzle as drizzleProxy } from "drizzle-orm/pg-proxy";
import { migrate } from "drizzle-orm/pg-proxy/migrator";
import { migrationScript, psqlProxyCallback } from "../../../../tests/db/pg-baseline-model";
import { withPostgres } from "../../../../tests/db/pg-test-harness";

interface Driver {
	/** Run one statement; resolve true when it succeeded, false when the database refused it. */
	run(statement: string): Promise<boolean>;
	/** One scalar from a single-row, single-column query (as text, or null). */
	scalar(query: string): Promise<string | null>;
}

const NOW = "2026-11-16T00:00:00.000Z";
const q = (value: string) => `'${value.replaceAll("'", "''")}'`;

async function runContract(driver: Driver, prefix: string): Promise<void> {
	const id = (name: string) => `${prefix}-${name}`;
	const ok = async (statement: string) => expect(await driver.run(statement)).toBe(true);
	const refused = async (statement: string) => expect(await driver.run(statement)).toBe(false);
	const count = async (table: string, where: string) =>
		Number(await driver.scalar(`SELECT count(*) FROM ${table} WHERE ${where}`));

	for (const name of ["lead", "lead2", "worker"])
		await ok(
			`INSERT INTO narrators (id, created_at, updated_at) VALUES (${q(id(name))}, ${q(NOW)}, ${q(NOW)})`,
		);
	for (const name of ["project", "project2"])
		await ok(
			`INSERT INTO projects (id, name, created_at, updated_at) VALUES (${q(id(name))}, 'p', ${q(NOW)}, ${q(NOW)})`,
		);
	await ok(
		`INSERT INTO narrator_worktree_resources (id, device_id, repository_key, worktree_path, state, create_request_id)
		VALUES (${q(id("wt"))}, 'local', 'repo', ${q(`/repo/.worktrees/${prefix}`)}, 'ready', ${q(id("req"))})`,
	);

	const team = (narrator: string, project: string, extra = "", values = "") =>
		`INSERT INTO project_teams (narrator_id, project_id, base_branch, created_at, updated_at${extra})
		VALUES (${q(id(narrator))}, ${q(id(project))}, 'main', ${q(NOW)}, ${q(NOW)}${values})`;

	// Checks and byte budgets on the team row. "é" is 2 bytes: 2,049 of them are 4,098 bytes.
	await refused(team("lead", "project", ", status", ", 'bogus'"));
	await refused(team("lead", "project", ", brief", `, ${q("é".repeat(2049))}`));
	await refused(team("lead", "project", ", settings_json", `, ${q(`"${"x".repeat(16_400)}"`)}`));
	await refused(team("lead", "missing-project"));
	await ok(team("lead", "project", ", brief", `, ${q("é".repeat(2048))}`));
	expect(
		await driver.scalar(`SELECT status FROM project_teams WHERE narrator_id = ${q(id("lead"))}`),
	).toBe("active");
	expect(
		await driver.scalar(
			`SELECT settings_json FROM project_teams WHERE narrator_id = ${q(id("lead"))}`,
		),
	).toBe("{}");
	await ok(team("lead2", "project2"));

	// Work items.
	const item = (name: string, columns = "", values = "", project = "project", teamId = "lead") =>
		`INSERT INTO team_work_items (id, team_id, project_id, title, created_at, updated_at${columns})
		VALUES (${q(id(name))}, ${q(id(teamId))}, ${q(id(project))}, 'work', ${q(NOW)}, ${q(NOW)}${values})`;
	await refused(item("bad-state", ", state", ", 'done'"));
	await refused(item("bad-review", ", last_review", ", 'maybe'"));
	await refused(item("bad-rounds", ", review_rounds", ", -1"));
	await refused(item("bad-paths", ", changed_paths_json", `, ${q(`["${"a".repeat(131_100)}"]`)}`));
	await refused(item("bad-team", "", "", "project", "worker"));
	await ok(
		item(
			"a",
			", state, worktree_resource_id, worker_narrator_id, exclusive_key, last_review",
			`, 'in_progress', ${q(id("wt"))}, ${q(id("worker"))}, 'migrations', 'clear'`,
		),
	);
	expect(
		await driver.scalar(`SELECT review_rounds FROM team_work_items WHERE id = ${q(id("a"))}`),
	).toBe("0");
	// The exclusive key is unique per project while set; unset keys never collide.
	await refused(item("b", ", exclusive_key", ", 'migrations'"));
	await ok(item("c"));
	await ok(item("d"));
	await ok(item("e", ", exclusive_key", ", 'migrations'", "project2", "lead2"));

	// Events.
	const event = (name: string, item: string | null, columns = "", values = "") =>
		`INSERT INTO team_work_events (id, team_id, work_item_id, kind, actor_kind, created_at${columns})
		VALUES (${q(id(name))}, ${q(id("lead"))}, ${item ? q(id(item)) : "NULL"}, 'team.created', 'person', ${q(NOW)}${values})`;
	await refused(
		`INSERT INTO team_work_events (id, team_id, kind, actor_kind, created_at)
		VALUES (${q(id("bad-actor"))}, ${q(id("lead"))}, 'k', 'robot', ${q(NOW)})`,
	);
	await refused(event("bad-detail", null, ", detail_json", `, ${q(`"${"x".repeat(8200)}"`)}`));
	await ok(event("ev1", null));
	await ok(event("ev2", "a"));

	// SET NULL references.
	await ok(`DELETE FROM narrator_worktree_resources WHERE id = ${q(id("wt"))}`);
	await ok(`DELETE FROM narrators WHERE id = ${q(id("worker"))}`);
	expect(
		await driver.scalar(
			`SELECT count(*) FROM team_work_items WHERE id = ${q(id("a"))} AND worktree_resource_id IS NULL AND worker_narrator_id IS NULL`,
		),
	).toBe("1");

	// RESTRICT: the coordinator and the project cannot go while the team row exists.
	await refused(`DELETE FROM narrators WHERE id = ${q(id("lead"))}`);
	await refused(`DELETE FROM projects WHERE id = ${q(id("project"))}`);
	expect(await count("project_teams", `narrator_id = ${q(id("lead"))}`)).toBe(1);

	// Deleting the team cascades its items and events; then the narrator can go.
	await ok(`DELETE FROM project_teams WHERE narrator_id = ${q(id("lead"))}`);
	expect(await count("team_work_items", `team_id = ${q(id("lead"))}`)).toBe(0);
	expect(await count("team_work_events", `team_id = ${q(id("lead"))}`)).toBe(0);
	await ok(`DELETE FROM narrators WHERE id = ${q(id("lead"))}`);
	expect(await count("team_work_items", `team_id = ${q(id("lead2"))}`)).toBe(1);
}

describe("project team tables contract", () => {
	test("SQLite", async () => {
		const { sqlite } = await import("../../../db");
		const driver: Driver = {
			async run(statement) {
				try {
					sqlite.run(statement);
					return true;
				} catch {
					return false;
				}
			},
			async scalar(query) {
				const row = sqlite.prepare(query).values()[0];
				return row?.[0] === null || row?.[0] === undefined ? null : String(row[0]);
			},
		};
		await runContract(driver, `sqlite-${Date.now()}`);
	});

	test.skipIf(process.env.PG_INTEGRATION !== "1")(
		"PostgreSQL",
		async () => {
			const result = await withPostgres(async ({ exec }) => {
				const proxyDb = drizzleProxy(psqlProxyCallback(exec)) as unknown as PgRemoteDatabase;
				await migrate(
					proxyDb,
					async (queries) => {
						const applied = await exec(migrationScript(queries));
						if (applied.code !== 0) throw new Error(`migration failed: ${applied.stderr}`);
					},
					{ migrationsFolder: "drizzle-postgres" },
				);
				const driver: Driver = {
					async run(statement) {
						return (await exec(`${statement};`)).code === 0;
					},
					async scalar(query) {
						const out = await exec(`${query};`);
						if (out.code !== 0) throw new Error(`query failed: ${out.stderr.slice(0, 500)}`);
						const text = out.stdout.trim();
						return text === "" ? null : text;
					},
				};
				await runContract(driver, "pg");
				return "done" as const;
			});
			expect(result).toBe("done");
		},
		300_000,
	);
});
