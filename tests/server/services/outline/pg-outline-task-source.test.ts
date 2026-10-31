/**
 * The outline task source against a real PostgreSQL: the store scenarios of
 * `server/services/task-source/__tests__/outline-task-source-scenarios.ts` (run on SQLite by
 * `outline-task-source.test.ts`), with the PostgreSQL outline store and access executor injected,
 * on a database that has every `drizzle-postgres` migration applied verbatim. They cover the new
 * reads of PR 3 on this dialect: the session's task backend (`narrators.task_backend`, a
 * subagent's root's), the candidate reads behind the source, and the promotion claim.
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
	createPostgresOutlineAccessExecutor,
	outlineAccessBackend,
	setOutlineAccessExecutor,
} from "../../../../server/services/outline/access-reads";
import { invalidateSessionReadScopes } from "../../../../server/services/outline/session-scope";
import { setOutlineStore } from "../../../../server/services/outline/store";
import { createPostgresOutlineStore } from "../../../../server/services/outline/store/postgres-store";
import {
	OUTLINE_TASK_SOURCE_SCENARIOS,
	type OutlineScenarioContext,
} from "../../../../server/services/task-source/__tests__/outline-task-source-scenarios";
import { withPostgres } from "../../../db/pg-test-harness";
import { migrationSql } from "../read/pg-parity-matrix";

const PG_ENABLED = process.env.PG_INTEGRATION === "1";
const RUN_TIMEOUT_MS = 600_000;
const NOW = "2026-10-31T00:00:00.000Z";

function urlFor(port: number, credentials: { user: string; password: string }): string {
	return `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(
		credentials.password,
	)}@127.0.0.1:${port}/nf_harness`;
}

function postgresContext(pg: BunSQLDatabase): OutlineScenarioContext {
	return {
		async session(options = {}) {
			const id = generateId();
			await pg.insert(pgSchema.narrators).values({
				id,
				title: "outline task source",
				taskBackend: options.backend ?? "outline",
				ownerUserId: options.owner ?? null,
				createdAt: NOW,
				updatedAt: NOW,
			});
			return id;
		},
		async subagent(rootId, options = {}) {
			const id = generateId();
			await pg.insert(pgSchema.narrators).values({
				id,
				title: "outline task source subagent",
				type: "subagent",
				parentNarratorId: rootId,
				aclRootNarratorId: rootId,
				taskBackend: options.backend ?? "spec",
				createdAt: NOW,
				updatedAt: NOW,
			});
			return id;
		},
	};
}

describe("PostgreSQL outline task source", () => {
	if (!PG_ENABLED) {
		it("skipped: set PG_INTEGRATION=1 to run the real PostgreSQL verification", () => {
			// Explicitly a skip, not a pass: no PostgreSQL work happened here.
			expect(process.env.PG_INTEGRATION).not.toBe("1");
		});
		return;
	}

	it(
		"reads backends and tasks, and claims, on a real server",
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
				const enabled = settings.outline.enabled;
				settings.outline.enabled = true;
				const passed: string[] = [];
				const problems: string[] = [];
				try {
					const ctx = postgresContext(client.db);
					for (const scenario of OUTLINE_TASK_SOURCE_SCENARIOS) {
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
					await client.close();
				}
			});
			if (!outcome || typeof outcome !== "object" || !("problems" in outcome)) {
				throw new Error(`PostgreSQL harness did not run: ${JSON.stringify(outcome)}`);
			}
			expect(outcome.backend).toBe("postgres");
			expect(outcome.problems).toEqual([]);
			expect(outcome.passed).toHaveLength(OUTLINE_TASK_SOURCE_SCENARIOS.length);
		},
		RUN_TIMEOUT_MS,
	);
});
