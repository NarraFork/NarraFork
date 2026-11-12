/**
 * The connected outline's listings (readability E) against a real PostgreSQL, through the
 * production access executor, on a database with every `drizzle-postgres` migration applied
 * verbatim: paging in byte order (ids chosen to order differently under ICU and byte order, with
 * a tie on the commit time and never-committed spaces), at every page size, without repeats or
 * skips; the bounded counts; and who sees which projects and loose sessions.
 *
 * Rules, same as the other PostgreSQL suites:
 *   - `PG_INTEGRATION=1` means PostgreSQL really has to run; a blocked harness fails;
 *   - migrations are applied exactly as committed;
 *   - the harness owns and removes its database.
 */
import { describe, expect, it } from "bun:test";
import { type SQL, sql } from "drizzle-orm";
import { createPostgresClient } from "../../../../server/db/postgres-client";
import {
	countOutlineTreeSpaces,
	createPostgresOutlineAccessExecutor,
	type OutlineTreeScope,
	outlineAccessBackend,
	readOutlineTreeSpacePage,
	setOutlineAccessExecutor,
} from "../../../../server/services/outline/access-reads";
import { withPostgres } from "../../../db/pg-test-harness";
import { migrationSql } from "../read/pg-parity-matrix";

const PG_ENABLED = process.env.PG_INTEGRATION === "1";
const RUN_TIMEOUT_MS = 600_000;
const NOW = "2026-11-03T00:00:00.000Z";

function urlFor(port: number, credentials: { user: string; password: string }): string {
	return `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(
		credentials.password,
	)}@127.0.0.1:${port}/nf_harness`;
}

const me = { userId: "me", isAdmin: false };

async function seed(run: (q: SQL) => Promise<unknown>) {
	for (const u of ["me", "other"]) {
		await run(
			sql`insert into users (id, username, password_hash, created_at) values (${u}, ${u}, 'x', ${NOW})`,
		);
	}
	for (const [id, owner, visibility] of [
		["P1", "me", "private"],
		["P2", "other", "private"],
		["P3", "other", "public"],
		["P4", "other", "private"],
		["P5", "me", "private"],
	] as const) {
		await run(
			sql`insert into projects (id, name, owner_user_id, visibility, created_at, updated_at) values (${id}, ${id}, ${owner}, ${visibility}, ${NOW}, ${NOW})`,
		);
		await run(
			sql`insert into outline_spaces (id, key, kind, project_id, created_at) values (${`sp_${id}`}, ${`project:${id}`}, 'project', ${id}, ${NOW})`,
		);
	}
	await run(sql`update projects set status = 'archived' where id = 'P5'`);
	await run(
		sql`insert into acl_grants (id, scope_type, scope_id, principal_type, principal_id, capability, created_at) values ('g1', 'project', 'P4', 'user', 'me', 'read', ${NOW})`,
	);
	await run(
		sql`update outline_spaces set last_commit_at = '2026-11-02T00:00:00.000Z' where id in ('sp_P1', 'sp_P3')`,
	);
	// Sessions of P1 whose ids order differently under ICU and byte order; one tie group.
	const ids = ["a_b", "aB", "AA", "a-c", "Zz", "zz", "b", "B_", "c", "C"];
	for (const [i, id] of ids.entries()) {
		await run(
			sql`insert into narrators (id, owner_user_id, visibility, context_project_id, status, type, created_at, updated_at, insert_seq) values (${id}, 'me', 'private', 'P1', 'idle', 'primary', ${NOW}, ${NOW}, ${i})`,
		);
		await run(
			sql`insert into outline_spaces (id, key, kind, narrator_id, created_at, last_commit_at) values (${`s${id}`}, ${`session:${id}`}, 'session', ${id}, ${NOW}, ${i < 7 ? "2026-11-01T00:00:00.000Z" : null})`,
		);
	}
	// Loose for me: my session of P2 (a project I cannot read) and a public session of P2;
	// not: someone's private session of P2, and my session of the archived P5.
	await run(
		sql`insert into narrators (id, owner_user_id, visibility, context_project_id, status, type, created_at, updated_at, insert_seq) values ('L1', 'me', 'private', 'P2', 'idle', 'primary', ${NOW}, ${NOW}, 100), ('L2', 'other', 'public', 'P2', 'idle', 'primary', ${NOW}, ${NOW}, 101), ('L3', 'other', 'private', 'P2', 'idle', 'primary', ${NOW}, ${NOW}, 102), ('L4', 'me', 'private', 'P5', 'idle', 'primary', ${NOW}, ${NOW}, 103)`,
	);
	for (const id of ["L1", "L2", "L3", "L4"]) {
		await run(
			sql`insert into outline_spaces (id, key, kind, narrator_id, created_at) values (${`s${id}`}, ${`session:${id}`}, 'session', ${id}, ${NOW})`,
		);
	}
}

async function walk(scope: OutlineTreeScope, limit: number): Promise<string[]> {
	const seen: string[] = [];
	let after: { lastCommitAt: string | null; id: string } | null = null;
	for (let guard = 0; guard < 50; guard++) {
		const rows = await readOutlineTreeSpacePage(me, scope, { after, limit });
		if (rows.length === 0) break;
		seen.push(...rows.map((r) => r.id));
		const last = rows.at(-1) as (typeof rows)[number];
		after = { lastCommitAt: last.lastCommitAt, id: last.id };
	}
	return seen;
}

const byteDesc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);
const byteAsc = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

describe("PostgreSQL connected outline", () => {
	if (!PG_ENABLED) {
		it("skipped: set PG_INTEGRATION=1 to run the real PostgreSQL verification", () => {
			// Explicitly a skip, not a pass: no PostgreSQL work happened here.
			expect(process.env.PG_INTEGRATION).not.toBe("1");
		});
		return;
	}

	it(
		"pages the tree's listings in byte order, filtered and counted in SQL",
		async () => {
			const sqls = await migrationSql();
			const outcome = await withPostgres(async ({ exec, port, credentials }) => {
				for (const statement of sqls) {
					const applied = await exec(statement);
					if (applied.code !== 0) return { migrationError: applied.stderr.slice(0, 400) };
				}
				const client = createPostgresClient({
					driver: "bun-sql",
					url: urlFor(port, credentials),
					max: 4,
					connectTimeout: 10,
				});
				setOutlineAccessExecutor(createPostgresOutlineAccessExecutor(client.db));
				try {
					await seed((q) => client.db.execute(q));
					const sessions = await walk({ kind: "project", projectId: "P1" }, 100);
					const bySize: Record<number, string[]> = {};
					for (const limit of [1, 2, 3, 4]) {
						bySize[limit] = await walk({ kind: "project", projectId: "P1" }, limit);
					}
					return {
						backend: outlineAccessBackend(),
						sessions,
						bySize,
						count: await countOutlineTreeSpaces(me, { kind: "project", projectId: "P1" }, 100),
						capped: await countOutlineTreeSpaces(me, { kind: "project", projectId: "P1" }, 4),
						projects: await walk({ kind: "projects" }, 1),
						loose: await walk({ kind: "loose" }, 1),
						looseCount: await countOutlineTreeSpaces(me, { kind: "loose" }, 100),
						orphaned: await countOutlineTreeSpaces(
							{ userId: "me", isAdmin: true },
							{ kind: "orphaned" },
							100,
						),
					};
				} finally {
					setOutlineAccessExecutor(undefined);
					await client.close();
				}
			});
			if (
				!outcome ||
				typeof outcome !== "object" ||
				!("sessions" in outcome) ||
				!("bySize" in outcome)
			) {
				throw new Error(`PostgreSQL harness did not run: ${JSON.stringify(outcome)}`);
			}
			expect(outcome.backend).toBe("postgres");
			const committed = ["a_b", "aB", "AA", "a-c", "Zz", "zz", "b"]
				.map((i) => `s${i}`)
				.sort(byteDesc);
			const never = ["B_", "c", "C"].map((i) => `s${i}`).sort(byteAsc);
			expect(outcome.sessions).toEqual([...committed, ...never]);
			for (const limit of [1, 2, 3, 4])
				expect(outcome.bySize[limit] ?? null).toEqual(outcome.sessions);
			expect(outcome.count).toBe(10);
			expect(outcome.capped).toBe(4);
			// Readable projects, latest commit first then by id; the archived one left out.
			expect(outcome.projects).toEqual(["sp_P3", "sp_P1", "sp_P4"]);
			expect(new Set(outcome.loose)).toEqual(new Set(["sL1", "sL2"]));
			expect(outcome.looseCount).toBe(2);
			expect(outcome.orphaned).toBe(0);
		},
		RUN_TIMEOUT_MS,
	);
});
