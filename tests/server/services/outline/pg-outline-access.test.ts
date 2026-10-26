/**
 * Outline spaces and access against a real PostgreSQL: the cases of
 * `server/services/outline/__tests__/access-matrix.ts` (run on SQLite by `access.test.ts`), with
 * the PostgreSQL outline store and access executor injected, on a database that has every
 * `drizzle-postgres` migration applied verbatim.
 *
 * Sessions get their project from `context_project_id` here: the working-directory link index is
 * SQLite-only so far, and `resolveNarratorProjectId` reads only the explicit project on
 * PostgreSQL.
 *
 * Rules, same as the other PostgreSQL suites:
 *   - `PG_INTEGRATION=1` means PostgreSQL really has to run; a blocked harness fails;
 *   - migrations are applied exactly as committed;
 *   - the harness owns and removes its database.
 */
import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { createPostgresClient } from "../../../../server/db/postgres-client";
import * as pgSchema from "../../../../server/db/postgres-schema";
import { generateId } from "../../../../server/lib/id";
import {
	type AccessFixtures,
	accessCases,
	buildAccessWorld,
	runAccessCases,
} from "../../../../server/services/outline/__tests__/access-matrix";
import {
	createPostgresOutlineAccessExecutor,
	outlineAccessBackend,
	setOutlineAccessExecutor,
} from "../../../../server/services/outline/access-reads";
import { invalidateSessionReadScopes } from "../../../../server/services/outline/session-scope";
import { setOutlineStore } from "../../../../server/services/outline/store";
import { createPostgresOutlineStore } from "../../../../server/services/outline/store/postgres-store";
import { withPostgres } from "../../../db/pg-test-harness";
import { migrationSql } from "../read/pg-parity-matrix";

const PG_ENABLED = process.env.PG_INTEGRATION === "1";
const RUN_TIMEOUT_MS = 600_000;
const NOW = "2026-10-26T00:00:00.000Z";

function urlFor(port: number, credentials: { user: string; password: string }): string {
	return `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(
		credentials.password,
	)}@127.0.0.1:${port}/nf_harness`;
}

function postgresFixtures(pg: BunSQLDatabase): AccessFixtures {
	return {
		async user(label, role = "user") {
			const id = generateId();
			await pg
				.insert(pgSchema.users)
				.values({ id, username: `${label}-${id}`, passwordHash: "x", role, createdAt: NOW });
			return id;
		},
		async project({ owner, visibility }) {
			const id = generateId();
			await pg.insert(pgSchema.projects).values({
				id,
				name: `outline-access-${id}`,
				ownerUserId: owner,
				visibility,
				createdAt: NOW,
				updatedAt: NOW,
			});
			return id;
		},
		async narrator({ owner, visibility, writeAudience, projectId, subagentOf }) {
			const id = generateId();
			await pg.insert(pgSchema.narrators).values({
				id,
				title: "outline access",
				ownerUserId: owner,
				visibility: visibility as "private",
				writeAudience: (writeAudience ?? "owner") as "owner",
				type: subagentOf === undefined ? "primary" : "subagent",
				aclRootNarratorId: subagentOf ?? null,
				contextProjectId: projectId ?? null,
				createdAt: NOW,
				updatedAt: NOW,
			});
			return id;
		},
		async grant(scope, principal, capability) {
			await pg.insert(pgSchema.aclGrants).values({
				id: generateId(),
				scopeType: scope.type,
				scopeId: scope.id,
				principalType: "user" in principal ? "user" : "role",
				principalId: "user" in principal ? principal.user : principal.role,
				capability,
				createdAt: NOW,
			});
		},
		async shareLink(narratorId, { revoked, createdBy }) {
			await pg.insert(pgSchema.narratorPublicShares).values({
				id: generateId(),
				narratorId,
				tokenHash: generateId(),
				guestName: "Guest",
				createdByUserId: createdBy,
				createdAt: NOW,
				revokedAt: revoked ? NOW : null,
			});
		},
		async deleteProject(id) {
			await pg.delete(pgSchema.projects).where(eq(pgSchema.projects.id, id));
		},
		async deleteUser(id) {
			await pg.delete(pgSchema.users).where(eq(pgSchema.users.id, id));
		},
	};
}

describe("PostgreSQL outline access", () => {
	if (!PG_ENABLED) {
		it("skipped: set PG_INTEGRATION=1 to run the real PostgreSQL verification", () => {
			// Explicitly a skip, not a pass: no PostgreSQL work happened here.
			expect(process.env.PG_INTEGRATION).not.toBe("1");
		});
		return;
	}

	it(
		"answers the access matrix on a real server",
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
				setOutlineStore(createPostgresOutlineStore(client.db));
				setOutlineAccessExecutor(createPostgresOutlineAccessExecutor(client.db));
				invalidateSessionReadScopes();
				try {
					const world = await buildAccessWorld(postgresFixtures(client.db));
					const cases = accessCases(world);
					return {
						backend: outlineAccessBackend(),
						cases: cases.length,
						failures: await runAccessCases(cases),
					};
				} catch (error) {
					return {
						error: error instanceof Error ? (error.stack ?? error.message) : String(error),
					};
				} finally {
					setOutlineStore(undefined);
					setOutlineAccessExecutor(undefined);
					invalidateSessionReadScopes();
					await client.close();
				}
			});
			if (!outcome || typeof outcome !== "object" || !("failures" in outcome)) {
				throw new Error(`PostgreSQL harness did not run: ${JSON.stringify(outcome)}`);
			}
			expect(outcome.backend).toBe("postgres");
			expect(outcome.failures).toEqual([]);
			expect(outcome.cases).toBeGreaterThan(100);
		},
		RUN_TIMEOUT_MS,
	);
});
