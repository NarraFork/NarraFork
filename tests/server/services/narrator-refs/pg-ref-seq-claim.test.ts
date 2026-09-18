/**
 * The narrator-refs seq claim, verified against a real PostgreSQL 17.
 *
 * SCOPE — read this before treating a pass as more than it is.
 * The production schema does NOT yet carry `narrators.next_seq` (the schema change is
 * a separate, manager-owned step; the exact proposal lives at the top of
 * server/services/narrator-refs/seq-store.ts). This suite therefore cannot run the
 * production code path. What it CAN and DOES verify, on scratch tables inside the
 * harness container, is the statement shape the frozen design will execute once the
 * column lands, and the equivalence claim the SQLite phase relies on:
 *
 *   A. COUNTER CLAIM UNDER REAL CONCURRENCY — 20 claimants on separate pooled
 *      connections each run `UPDATE narrators SET next_seq = next_seq + 1 … RETURNING`
 *      plus their ref insert in one transaction. All 20 succeed with distinct,
 *      gapless seqs: the narrators row lock serializes them, no 23505, no retry.
 *   B. NEGATIVE CONTROL — the same interleaving with a bare `MAX(seq)+1` read and NO
 *      narrators-row lock produces a DUPLICATE seq deterministically. This is the
 *      hazard the counter claim removes; without this control, phase A would prove
 *      nothing about why the shape matters.
 *   C. EQUIVALENCE — `MAX(seq)+1` serialized on the narrators row (FOR UPDATE) yields
 *      the same unique, contiguous allocation as the counter claim. That is exactly
 *      the guarantee SQLite's single-writer synchronous transaction already provides
 *      for the phase-1 primitive bodies, so the phase-1 → phase-2 swap preserves
 *      behavior.
 *   D. SHIFT ACCOUNTING — shift+insert consumes one top-of-history slot: claiming the
 *      counter BEFORE shifting keeps the invariant `next_seq = MAX(seq) + 1`.
 *   E. ROLLBACK — a rolled-back claim is re-issued (the counter bump rolls back with
 *      the transaction), matching the SQLite contract test of the same name.
 *
 * Rules, same as the other PG suites:
 *   - `PG_INTEGRATION=1` means PostgreSQL really has to run. A blocked harness is a
 *     failure in that mode, never a quiet pass;
 *   - the container is the harness' own random name and only it is cleaned up;
 *   - scratch tables live in the per-run harness schema and vanish with the container.
 */
import { describe, expect, it } from "bun:test";
import { createPostgresClient } from "../../../../server/db/postgres-client";
import { withPostgres } from "../../../db/pg-test-harness";

const PG_ENABLED = process.env.PG_INTEGRATION === "1";
const RUN_TIMEOUT_MS = 300_000;

function urlFor(port: number, credentials: { user: string; password: string }): string {
	return `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(credentials.password)}@127.0.0.1:${port}/nf_harness`;
}

/** Integer-only interpolations; the schema name is harness-generated hex. */
function refSeqOf(row: unknown): number {
	return Number((row as { next_seq: number | string }).next_seq);
}

describe("PostgreSQL narrator-refs seq claim shape", () => {
	if (!PG_ENABLED) {
		it("skipped: set PG_INTEGRATION=1 to run the real PostgreSQL verification", () => {
			// Explicitly a skip, not a pass: no PostgreSQL work happened here.
			expect(process.env.PG_INTEGRATION).not.toBe("1");
		});
		return;
	}

	it(
		"counter claim serializes concurrent writers; serialized MAX+1 is equivalent",
		async () => {
			const outcome = await withPostgres(async ({ port, schema, credentials, exec }) => {
				const ddl = await exec(`
					CREATE TABLE ${schema}.narrators (id text PRIMARY KEY, next_seq integer NOT NULL DEFAULT 0);
					CREATE TABLE ${schema}.refs (
						id text PRIMARY KEY,
						narrator_id text NOT NULL,
						message_id text NOT NULL,
						seq integer NOT NULL
					);
					INSERT INTO ${schema}.narrators (id) VALUES ('n1'), ('n2'), ('n3'), ('n4'), ('n5');
					INSERT INTO ${schema}.refs (id, narrator_id, message_id, seq) VALUES
						('n4-r0', 'n4', 'n4-m0', 0), ('n4-r1', 'n4', 'n4-m1', 1), ('n4-r2', 'n4', 'n4-m2', 2);
					UPDATE ${schema}.narrators SET next_seq = 3 WHERE id = 'n4';
				`);
				if (ddl.code !== 0) return `ddl:${ddl.stderr.slice(0, 300)}`;

				const url = urlFor(port, credentials);

				// ── A. Counter claim, 20 truly concurrent claimants ──────────────
				const pool = createPostgresClient({
					driver: "bun-sql",
					url,
					max: 8,
					idleTimeout: 5,
					connectTimeout: 10,
				});
				try {
					await Promise.all(
						Array.from({ length: 20 }, (_, i) =>
							pool.sql.begin(async (tx) => {
								const claimed = await tx.unsafe(
									`UPDATE ${schema}.narrators SET next_seq = next_seq + 1 WHERE id = 'n1' RETURNING next_seq`,
								);
								const seq = refSeqOf(claimed[0]) - 1;
								await tx.unsafe(
									`INSERT INTO ${schema}.refs (id, narrator_id, message_id, seq) VALUES ('a-r${i}', 'n1', 'a-m${i}', ${seq})`,
								);
							}),
						),
					);
					const stats = await pool.sql.unsafe(
						`SELECT COUNT(*) AS n, COUNT(DISTINCT seq) AS distinct_seq, MIN(seq) AS lo, MAX(seq) AS hi FROM ${schema}.refs WHERE narrator_id = 'n1'`,
					);
					expect(Number(stats[0].n)).toBe(20);
					expect(Number(stats[0].distinct_seq)).toBe(20);
					expect(Number(stats[0].lo)).toBe(0);
					expect(Number(stats[0].hi)).toBe(19);
					const counter = await pool.sql.unsafe(
						`SELECT next_seq FROM ${schema}.narrators WHERE id = 'n1'`,
					);
					expect(refSeqOf(counter[0])).toBe(20);
				} finally {
					await pool.close();
				}

				// ── B. Negative control: MAX+1 WITHOUT the row lock duplicates ───
				const b1 = createPostgresClient({ driver: "bun-sql", url, max: 1, connectTimeout: 10 });
				const b2 = createPostgresClient({ driver: "bun-sql", url, max: 1, connectTimeout: 10 });
				try {
					await b1.sql.unsafe("BEGIN");
					await b2.sql.unsafe("BEGIN");
					const readShape = `SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM ${schema}.refs WHERE narrator_id = 'n2'`;
					const maxA = await b1.sql.unsafe(readShape);
					const maxB = await b2.sql.unsafe(readShape);
					// Both read the same top: the classic claim race, fully deterministic.
					expect(Number(maxA[0].seq)).toBe(0);
					expect(Number(maxB[0].seq)).toBe(0);
					await b1.sql.unsafe(
						`INSERT INTO ${schema}.refs (id, narrator_id, message_id, seq) VALUES ('b-r1', 'n2', 'b-m1', 0)`,
					);
					await b2.sql.unsafe(
						`INSERT INTO ${schema}.refs (id, narrator_id, message_id, seq) VALUES ('b-r2', 'n2', 'b-m2', 0)`,
					);
					await b1.sql.unsafe("COMMIT");
					await b2.sql.unsafe("COMMIT");
					const dupes = await b1.sql.unsafe(
						`SELECT COUNT(*) AS n FROM ${schema}.refs WHERE narrator_id = 'n2' AND seq = 0`,
					);
					// The hazard is real: two committed refs share seq 0.
					expect(Number(dupes[0].n)).toBe(2);
				} finally {
					await b1.close();
					await b2.close();
				}

				// ── C. MAX+1 serialized on the narrators row ≡ counter claim ─────
				const c1 = createPostgresClient({ driver: "bun-sql", url, max: 1, connectTimeout: 10 });
				const c2 = createPostgresClient({ driver: "bun-sql", url, max: 1, connectTimeout: 10 });
				try {
					await c1.sql.unsafe("BEGIN");
					await c2.sql.unsafe("BEGIN");
					// c1 takes the narrators row lock first (awaited before c2 asks).
					await c1.sql.unsafe(`SELECT id FROM ${schema}.narrators WHERE id = 'n3' FOR UPDATE`);
					const c2Blocked = c2.sql.unsafe(
						`SELECT id FROM ${schema}.narrators WHERE id = 'n3' FOR UPDATE`,
					);
					const seqA = await c1.sql.unsafe(
						`SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM ${schema}.refs WHERE narrator_id = 'n3'`,
					);
					await c1.sql.unsafe(
						`INSERT INTO ${schema}.refs (id, narrator_id, message_id, seq) VALUES ('c-r1', 'n3', 'c-m1', ${Number(seqA[0].seq)})`,
					);
					await c1.sql.unsafe("COMMIT");
					await c2Blocked; // unblocks only after c1 commits
					const seqB = await c2.sql.unsafe(
						`SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM ${schema}.refs WHERE narrator_id = 'n3'`,
					);
					await c2.sql.unsafe(
						`INSERT INTO ${schema}.refs (id, narrator_id, message_id, seq) VALUES ('c-r2', 'n3', 'c-m2', ${Number(seqB[0].seq)})`,
					);
					await c2.sql.unsafe("COMMIT");
					// Same allocation the counter claim produced in phase A: distinct,
					// contiguous, no duplicate.
					expect(Number(seqA[0].seq)).toBe(0);
					expect(Number(seqB[0].seq)).toBe(1);
					const seqs = await c1.sql.unsafe(
						`SELECT seq FROM ${schema}.refs WHERE narrator_id = 'n3' ORDER BY seq`,
					);
					expect(seqs.map((r: { seq: number | string }) => Number(r.seq))).toEqual([0, 1]);
				} finally {
					await c1.close();
					await c2.close();
				}

				// ── D. Shift+insert consumes exactly one top slot ────────────────
				const d = createPostgresClient({ driver: "bun-sql", url, max: 1, connectTimeout: 10 });
				try {
					await d.sql.begin(async (tx) => {
						// Claim the top slot FIRST (this is also the row lock), then shift,
						// then insert into the freed interior slot.
						const claimed = await tx.unsafe(
							`UPDATE ${schema}.narrators SET next_seq = next_seq + 1 WHERE id = 'n4' RETURNING next_seq`,
						);
						expect(refSeqOf(claimed[0])).toBe(4);
						await tx.unsafe(
							`UPDATE ${schema}.refs SET seq = seq + 1 WHERE narrator_id = 'n4' AND seq >= 1`,
						);
						await tx.unsafe(
							`INSERT INTO ${schema}.refs (id, narrator_id, message_id, seq) VALUES ('d-r1', 'n4', 'd-m1', 1)`,
						);
					});
					const invariant = await d.sql.unsafe(
						`SELECT (SELECT next_seq FROM ${schema}.narrators WHERE id = 'n4') AS next_seq,
								(SELECT MAX(seq) + 1 FROM ${schema}.refs WHERE narrator_id = 'n4') AS floor`,
					);
					expect(refSeqOf(invariant[0])).toBe(Number((invariant[0] as { floor: number }).floor));
					const seqs = await d.sql.unsafe(
						`SELECT seq FROM ${schema}.refs WHERE narrator_id = 'n4' ORDER BY seq`,
					);
					expect(seqs.map((r: { seq: number | string }) => Number(r.seq))).toEqual([0, 1, 2, 3]);
				} finally {
					await d.close();
				}

				// ── E. A rolled-back claim is re-issued ──────────────────────────
				const e = createPostgresClient({ driver: "bun-sql", url, max: 1, connectTimeout: 10 });
				try {
					await e.sql.unsafe("BEGIN");
					await e.sql.unsafe(
						`UPDATE ${schema}.narrators SET next_seq = next_seq + 1 WHERE id = 'n5' RETURNING next_seq`,
					);
					await e.sql.unsafe("ROLLBACK");
					const again = await e.sql.unsafe(
						`UPDATE ${schema}.narrators SET next_seq = next_seq + 1 WHERE id = 'n5' RETURNING next_seq`,
					);
					// The bump rolled back with the transaction: seq 0 is claimed again.
					expect(refSeqOf(again[0])).toBe(1);
				} finally {
					await e.close();
				}

				return "verified";
			});
			if (outcome !== "verified") {
				throw new Error(
					`real PostgreSQL verification unavailable or failed: ${
						typeof outcome === "string"
							? outcome
							: outcome.status === "blocked" || outcome.status === "failed"
								? outcome.reason
								: "unexpected harness result"
					}`,
				);
			}
		},
		RUN_TIMEOUT_MS,
	);
});
