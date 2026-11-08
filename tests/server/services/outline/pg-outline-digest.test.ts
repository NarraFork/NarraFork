/**
 * The report job (汇报, outline P2 PR 11) against a real PostgreSQL, with the PostgreSQL outline
 * store and access executor injected: the people and their report settings (`users` joined with
 * `user_preferences`), a project's own grantees, windows cut in two people's time zones, a day
 * continuing where the last one ended, running again adding nothing, and the detail following
 * today's access. The store calls themselves are covered by the digest contract in
 * `pg-outline-store.test.ts`.
 *
 * Rules, same as the other PostgreSQL suites:
 *   - `PG_INTEGRATION=1` means PostgreSQL really has to run; a blocked harness fails;
 *   - migrations are applied exactly as committed;
 *   - the harness owns and removes its database.
 */
import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { ensurePgFts } from "../../../../server/db/pg-fts";
import { createPostgresClient } from "../../../../server/db/postgres-client";
import * as pgSchema from "../../../../server/db/postgres-schema";
import { generateId } from "../../../../server/lib/id";
import {
	createPostgresOutlineAccessExecutor,
	readDigestPeoplePage,
	readProjectGrantees,
	setOutlineAccessExecutor,
} from "../../../../server/services/outline/access-reads";
import {
	resetOutlineDigestJobForTests,
	runOutlineDigestSlice,
	startOutlineDigestSweepForTests,
} from "../../../../server/services/outline/digest-job";
import { readOutlineDigestDetail } from "../../../../server/services/outline/digest-view";
import { invalidateSessionReadScopes } from "../../../../server/services/outline/session-scope";
import { setOutlineStore } from "../../../../server/services/outline/store";
import { createPostgresOutlineStore } from "../../../../server/services/outline/store/postgres-store";
import { writeOutline } from "../../../../server/services/outline/write";
import { withPostgres } from "../../../db/pg-test-harness";
import { migrationSql } from "../read/pg-parity-matrix";

const PG_ENABLED = process.env.PG_INTEGRATION === "1";
const RUN_TIMEOUT_MS = 600_000;
const SETUP = "2026-11-01T00:00:00.000Z";

function urlFor(port: number, credentials: { user: string; password: string }): string {
	return `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(
		credentials.password,
	)}@127.0.0.1:${port}/nf_harness`;
}

describe("PostgreSQL outline reports", () => {
	if (!PG_ENABLED) {
		it("skipped: set PG_INTEGRATION=1 to run the real PostgreSQL verification", () => {
			expect(process.env.PG_INTEGRATION).not.toBe("1");
		});
		return;
	}

	it(
		"makes each person's day in their zone, continues, and follows today's access",
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
				const pg = client.db;
				const store = createPostgresOutlineStore(pg);
				setOutlineStore(store);
				setOutlineAccessExecutor(createPostgresOutlineAccessExecutor(pg));
				invalidateSessionReadScopes();
				resetOutlineDigestJobForTests();
				const problems: string[] = [];
				const check = (label: string, ok: boolean, detail?: unknown) => {
					if (!ok) problems.push(`${label}: ${JSON.stringify(detail)}`);
				};
				try {
					const person = async (label: string, timeZone: string | null) => {
						const id = generateId();
						await pg.insert(pgSchema.users).values({
							id,
							username: `${label}-${id.slice(0, 6)}`,
							passwordHash: "x",
							role: "user",
							createdAt: SETUP,
						});
						if (timeZone)
							await pg.insert(pgSchema.userPreferences).values({
								id: generateId(),
								userId: id,
								createdAt: SETUP,
								updatedAt: SETUP,
								outlineDigestTimeZone: timeZone,
							});
						return id;
					};
					const alice = await person("alice", "Asia/Shanghai");
					const bob = await person("bob", "America/New_York");
					const projectId = generateId();
					await pg.insert(pgSchema.projects).values({
						id: projectId,
						name: "Reports",
						ownerUserId: alice,
						visibility: "private",
						createdAt: SETUP,
						updatedAt: SETUP,
					});
					const grantId = generateId();
					await pg.insert(pgSchema.aclGrants).values({
						id: grantId,
						scopeType: "project",
						scopeId: projectId,
						principalType: "user",
						principalId: bob,
						capability: "write",
						createdAt: SETUP,
					});
					const people = await readDigestPeoplePage(null, 50);
					check(
						"people with their settings",
						people.some((p) => p.id === alice && p.timeZone === "Asia/Shanghai") &&
							people.some((p) => p.id === bob && p.timeZone === "America/New_York"),
						people,
					);
					check("grantees", (await readProjectGrantees(projectId, 10)).join() === bob);
					const agent = generateId();
					await pg.insert(pgSchema.narrators).values({
						id: agent,
						title: "agent",
						ownerUserId: alice,
						createdAt: SETUP,
						updatedAt: SETUP,
					});
					const space = await store.ensureSpace({ kind: "project", projectId }, SETUP);
					const fact = (at: string, content: string) =>
						writeOutline(
							{
								spaceId: space.id,
								ops: [{ op: "insert", parent: null, content }],
								actor: { kind: "agent", id: agent },
								responsibleUserId: alice,
								narratorId: agent,
							},
							{ store, now: () => new Date(at) },
						);
					// 11-05T03:00Z: Shanghai's 11-05, New York's 11-04.
					await fact("2026-11-05T03:00:00.000Z", "early");
					// 11-05T20:00Z: Shanghai's 11-06, New York's 11-05.
					await fact("2026-11-05T20:00:00.000Z", "late");
					const run = async (now: string) => {
						startOutlineDigestSweepForTests();
						let written = 0;
						for (let i = 0; i < 100; i++) {
							const slice = await runOutlineDigestSlice({
								store,
								now: () => new Date(now),
								serverTimeZone: "UTC",
							});
							written += slice.written;
							if (!slice.more) break;
						}
						return written;
					};
					await run("2026-11-07T12:00:00.000Z");
					const days = async (userId: string) =>
						(await store.listDigestHeads(userId, { kind: "daily", limit: 10 })).reverse();
					const titles = async (userId: string, id: string) =>
						(
							await readOutlineDigestDetail({ userId, isAdmin: false }, id, { store })
						).knowledge.map((k) => k.title);
					const aliceDays = await days(alice);
					const bobDays = await days(bob);
					check(
						"alice's days",
						aliceDays.map((d) => d.periodKey).join() === "2026-11-04,2026-11-05,2026-11-06",
						aliceDays.map((d) => d.periodKey),
					);
					check(
						"bob's days",
						bobDays.map((d) => d.periodKey).join() === "2026-11-04,2026-11-05,2026-11-06",
						bobDays.map((d) => d.periodKey),
					);
					for (const list of [aliceDays, bobDays])
						for (let i = 1; i < list.length; i++)
							check("days meet", list[i]?.periodStart === list[i - 1]?.periodEnd, list);
					const a5 = aliceDays.find((d) => d.periodKey === "2026-11-05");
					const a6 = aliceDays.find((d) => d.periodKey === "2026-11-06");
					const b4 = bobDays.find((d) => d.periodKey === "2026-11-04");
					const b5 = bobDays.find((d) => d.periodKey === "2026-11-05");
					check("alice 11-05", (await titles(alice, a5?.id as string)).join() === "early");
					check("alice 11-06", (await titles(alice, a6?.id as string)).join() === "late");
					check("bob 11-04", (await titles(bob, b4?.id as string)).join() === "early");
					check("bob 11-05", (await titles(bob, b5?.id as string)).join() === "late");
					const b4row = await store.getDigest(b4?.id as string);
					const b5row = await store.getDigest(b5?.id as string);
					check(
						"ranges meet",
						b4row?.ranges[space.id]?.[1] === 1 && b5row?.ranges[space.id]?.join() === "1,2",
						[b4row?.ranges, b5row?.ranges],
					);
					check("again: nothing", (await run("2026-11-07T12:00:00.000Z")) === 0);
					// Bob loses the project: his reports show nothing of it.
					await pg.delete(pgSchema.aclGrants).where(eq(pgSchema.aclGrants.id, grantId));
					const gone = await readOutlineDigestDetail(
						{ userId: bob, isAdmin: false },
						b5?.id as string,
						{
							store,
						},
					);
					check("access gone", gone.knowledge.length === 0 && gone.digest.itemCount === 0, gone);
					return { problems };
				} catch (error) {
					return { error: error instanceof Error ? (error.stack ?? error.message) : String(error) };
				} finally {
					resetOutlineDigestJobForTests();
					setOutlineStore(undefined);
					setOutlineAccessExecutor(undefined);
					invalidateSessionReadScopes();
					await client.close();
				}
			});
			if (!outcome || typeof outcome !== "object" || !("problems" in outcome)) {
				throw new Error(`PostgreSQL harness did not run: ${JSON.stringify(outcome)}`);
			}
			expect(outcome.problems).toEqual([]);
		},
		RUN_TIMEOUT_MS,
	);
});
