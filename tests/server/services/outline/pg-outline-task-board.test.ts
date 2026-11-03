/**
 * The task board and people's tasks against a real PostgreSQL (outline P2 PR 5): the scenarios of
 * `server/services/outline/__tests__/task-board-scenarios.ts` (run on SQLite by
 * `task-board.test.ts`), with the PostgreSQL outline store and access executor injected, on a
 * database that has every `drizzle-postgres` migration applied verbatim. They cover the new reads
 * on this dialect: the finished-task index and its paging, the head of a block's content, and the
 * readable session spaces of a project's sessions (sessions belong to a project through their
 * explicit project here: the working-directory link index is SQLite-only so far).
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
	type BoardScenarioContext,
	OUTLINE_TASK_BOARD_SCENARIOS,
} from "../../../../server/services/outline/__tests__/task-board-scenarios";
import {
	createPostgresOutlineAccessExecutor,
	outlineAccessBackend,
	setOutlineAccessExecutor,
} from "../../../../server/services/outline/access-reads";
import { invalidateSessionReadScopes } from "../../../../server/services/outline/session-scope";
import { setOutlineStore } from "../../../../server/services/outline/store";
import { createPostgresOutlineStore } from "../../../../server/services/outline/store/postgres-store";
import { invalidateTaskBackend } from "../../../../server/services/task-source";
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

function postgresContext(pg: BunSQLDatabase): BoardScenarioContext {
	return {
		async user(options = {}) {
			const id = generateId();
			const username = `board${id.replace(/[^A-Za-z0-9]/g, "")}`;
			await pg.insert(pgSchema.users).values({
				id,
				username,
				passwordHash: "x",
				role: options.admin ? "admin" : "user",
				createdAt: NOW,
			});
			return { id, username };
		},
		async project({ owner, visibility }) {
			const id = generateId();
			await pg.insert(pgSchema.projects).values({
				id,
				name: `board-${id}`,
				ownerUserId: owner,
				visibility: visibility ?? "private",
				createdAt: NOW,
				updatedAt: NOW,
			});
			return id;
		},
		async session({ owner, projectId, visibility, archived }) {
			const id = generateId();
			await pg.insert(pgSchema.narrators).values({
				id,
				title: `board session ${id}`,
				ownerUserId: owner,
				visibility: visibility ?? "private",
				writeAudience: "owner",
				contextProjectId: projectId ?? null,
				taskBackend: "outline",
				status: archived ? "archived" : "idle",
				createdAt: NOW,
				updatedAt: NOW,
			});
			return id;
		},
		async grant(projectId, userId, capability) {
			await pg.insert(pgSchema.aclGrants).values({
				id: generateId(),
				scopeType: "project",
				scopeId: projectId,
				principalType: "user",
				principalId: userId,
				capability,
				createdAt: NOW,
			});
		},
	};
}

describe("PostgreSQL task board", () => {
	if (!PG_ENABLED) {
		it("skipped: set PG_INTEGRATION=1 to run the real PostgreSQL verification", () => {
			// Explicitly a skip, not a pass: no PostgreSQL work happened here.
			expect(process.env.PG_INTEGRATION).not.toBe("1");
		});
		return;
	}

	it(
		"reads boards and writes people's tasks on a real server",
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
					for (const scenario of OUTLINE_TASK_BOARD_SCENARIOS) {
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
			expect(outcome.passed).toHaveLength(OUTLINE_TASK_BOARD_SCENARIOS.length);
		},
		RUN_TIMEOUT_MS,
	);
});
