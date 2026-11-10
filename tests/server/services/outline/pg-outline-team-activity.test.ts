/**
 * Team activity against a real PostgreSQL (outline P2 PR 10b): the store scenarios of
 * `server/services/outline/__tests__/team-activity-scenarios.ts` (run on SQLite by
 * `team-activity.test.ts`), with the PostgreSQL outline store and access executor injected, on a
 * database that has every `drizzle-postgres` migration applied verbatim. They cover what a look
 * reads on this dialect: the session facts (`narrators`, `narrator_turns`), the commit window and
 * its versions, the related tasks, claims and ancestors, and what the session may name.
 *
 * Rules, same as the other PostgreSQL suites:
 *   - `PG_INTEGRATION=1` means PostgreSQL really has to run; a blocked harness fails;
 *   - migrations are applied exactly as committed;
 *   - the harness owns and removes its database.
 */
import { describe, expect, it } from "bun:test";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { ensurePgFts } from "../../../../server/db/pg-fts";
import { createPostgresClient } from "../../../../server/db/postgres-client";
import * as pgSchema from "../../../../server/db/postgres-schema";
import { generateId } from "../../../../server/lib/id";
import { settings } from "../../../../server/lib/settings";
import {
	OUTLINE_TEAM_ACTIVITY_SCENARIOS,
	type TeamActivityContext,
} from "../../../../server/services/outline/__tests__/team-activity-scenarios";
import {
	createPostgresOutlineAccessExecutor,
	outlineAccessBackend,
	setOutlineAccessExecutor,
} from "../../../../server/services/outline/access-reads";
import { invalidateSessionReadScopes } from "../../../../server/services/outline/session-scope";
import { setOutlineStore } from "../../../../server/services/outline/store";
import { createPostgresOutlineStore } from "../../../../server/services/outline/store/postgres-store";
import { invalidateTaskBackend } from "../../../../server/services/task-source/backend";
import { withPostgres } from "../../../db/pg-test-harness";
import { migrationSql } from "../read/pg-parity-matrix";

const PG_ENABLED = process.env.PG_INTEGRATION === "1";
const RUN_TIMEOUT_MS = 600_000;
const NOW = "2026-11-01T00:00:00.000Z";

function urlFor(port: number, credentials: { user: string; password: string }): string {
	return `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(
		credentials.password,
	)}@127.0.0.1:${port}/nf_harness`;
}

function postgresContext(pg: BunSQLDatabase): TeamActivityContext {
	return {
		async person(name) {
			const id = generateId();
			const username = `${name}${id.replace(/[^A-Za-z0-9]/g, "").slice(0, 6)}`;
			await pg
				.insert(pgSchema.users)
				.values({ id, username, passwordHash: "x", role: "user", createdAt: NOW });
			return { id, username };
		},
		async project(owner) {
			const id = generateId();
			await pg.insert(pgSchema.projects).values({
				id,
				name: `team-${id}`,
				ownerUserId: owner,
				visibility: "private",
				createdAt: NOW,
				updatedAt: NOW,
			});
			return id;
		},
		async session(owner, projectId, options) {
			const id = generateId();
			await pg.insert(pgSchema.narrators).values({
				id,
				title: options.title,
				ownerUserId: owner,
				taskBackend: options.backend ?? "outline",
				visibility: "private",
				contextProjectId: projectId,
				status: "idle",
				createdAt: options.createdAt,
				updatedAt: options.createdAt,
			});
			return id;
		},
		async subagent(root, owner, projectId) {
			const id = generateId();
			await pg.insert(pgSchema.narrators).values({
				id,
				type: "subagent",
				title: "Helper",
				ownerUserId: owner,
				parentNarratorId: root,
				aclRootNarratorId: root,
				taskBackend: "outline",
				contextProjectId: projectId,
				status: "idle",
				createdAt: NOW,
				updatedAt: NOW,
			});
			return id;
		},
		async finishedRun(narratorId, endedAt) {
			await pg.insert(pgSchema.narratorTurns).values({
				id: generateId(),
				narratorId,
				status: "completed",
				startedAt: new Date(Date.parse(endedAt) - 60_000).toISOString(),
				endedAt,
			});
		},
	};
}

describe("PostgreSQL outline team activity", () => {
	if (!PG_ENABLED) {
		it("skipped: set PG_INTEGRATION=1 to run the real PostgreSQL verification", () => {
			// Explicitly a skip, not a pass: no PostgreSQL work happened here.
			expect(process.env.PG_INTEGRATION).not.toBe("1");
		});
		return;
	}

	it(
		"reads what others did around a session on a real server",
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
				await ensurePgFts(client.sql);
				setOutlineStore(createPostgresOutlineStore(client.db));
				setOutlineAccessExecutor(createPostgresOutlineAccessExecutor(client.db));
				invalidateSessionReadScopes();
				invalidateTaskBackend();
				const enabled = settings.outline.enabled;
				settings.outline.enabled = true;
				const passed: string[] = [];
				const problems: string[] = [];
				try {
					const ctx = postgresContext(client.db);
					for (const scenario of OUTLINE_TEAM_ACTIVITY_SCENARIOS) {
						try {
							await scenario.run(ctx);
							passed.push(scenario.name);
						} catch (error) {
							problems.push(
								`${scenario.name}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`.slice(
									0,
									2000,
								),
							);
						}
					}
					return { backend: outlineAccessBackend(), passed, problems };
				} finally {
					settings.outline.enabled = enabled;
					setOutlineStore(undefined);
					setOutlineAccessExecutor(undefined);
					invalidateSessionReadScopes();
					invalidateTaskBackend();
					await client.close();
				}
			});
			if (!outcome || typeof outcome !== "object" || !("problems" in outcome)) {
				throw new Error(`PostgreSQL harness did not run: ${JSON.stringify(outcome)}`);
			}
			expect(outcome.backend).toBe("postgres");
			expect(outcome.problems).toEqual([]);
			expect(outcome.passed).toHaveLength(OUTLINE_TEAM_ACTIVITY_SCENARIOS.length);
		},
		RUN_TIMEOUT_MS,
	);
});
