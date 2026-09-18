/**
 * The agent-runtime queue write shapes, verified against a real PostgreSQL 17.
 *
 * SCOPE — read this before treating a pass as more than it is.
 * The production write paths run on SQLite today; the PostgreSQL adapter is a later,
 * composition-root step. What this suite locks is the part that cannot be fixed later
 * by wiring: the STATEMENT SHAPES the queue's correctness rests on, executed under
 * real multi-connection concurrency. Scratch tables mirror the production columns the
 * shapes touch (`runtime_publication_outbox`, `narrator_buffered_messages`,
 * `narrators.inbox_sequence`, `chat_rooms.next_seq`) inside the harness schema.
 *
 *   A. MAILBOX ARRIVAL-SEQ COUNTER CLAIM — `UPDATE narrators SET inbox_sequence =
 *      inbox_sequence + 1 … RETURNING` (mailbox.ts `allocateArrivalSequence`). 20
 *      concurrent claimants on separate pooled connections each claim + insert their
 *      mailbox row in one transaction: distinct, gapless arrival seqs, no 23505, and
 *      a rolled-back claim is re-issued.
 *   B. CHAT ROOM SEQ COUNTER CLAIM — the `chat_rooms.next_seq` claim shape
 *      (chat-service.ts `claimMessageSeq`): same guarantee, claimed = next_seq - 1.
 *   C. OUTBOX CONCURRENT TRANSFER, NO LOSS NO DUPLICATE — two consumers on separate
 *      connections drain 60 pending events through the `transferNext` shape (SELECT
 *      head → INSERT mailbox → DELETE outbox, one transaction per event). The
 *      deterministic half proves the mechanism: a racing consumer's INSERT blocks on
 *      the `(narrator_id, dedupe_key)` unique index, fails 23505 when the winner
 *      commits, and its whole-section retry moves to the next head — the error is
 *      translated to `WriteConflictError` by `translateWriteError`. The concurrent
 *      half proves the outcome: every event delivered exactly once, split across both
 *      consumers, outbox empty.
 *   D. MAILBOX CLAIM + REDELIVERY — the `claimEligibleHead` shape (UPDATE … WHERE
 *      state='queued' … RETURNING) claims exactly once under a race (the loser
 *      re-evaluates the WHERE after the row lock and gets zero rows), and the
 *      `failClaim` shape returns the row to `queued` so a later pass claims it again
 *      with `claim_attempts` incremented — processing failure redelivers, never
 *      duplicates.
 *   E. INSERTION ORDINAL WITHOUT rowid — the proposed `insert_seq BIGINT GENERATED
 *      BY DEFAULT AS IDENTITY` replacement for the legacy-boundary clock
 *      (publication-outbox.ts "THE INSERTION ORDINAL"): explicit backfill values
 *      (the SQLite rowid copy) coexist with sequence allocation after
 *      `setval(pg_get_serial_sequence(...))`, and the boundary comparison
 *      `insert_seq <= captured_max` classifies pre/post-capture rows exactly.
 *   F. ID-CURSOR COLLATION (separate test, glibc `postgres:17` image) — the
 *      `listPending` cursor paginates by opaque text id; byte order is the only
 *      collation both backends share (services/read/read-cursor.ts). On the glibc
 *      image the default `en_US.utf8` ordering genuinely diverges from byte order
 *      (proved here), and `COLLATE "C"` on ORDER BY + keyset comparison restores
 *      SQLite-BINARY-identical pages. Alpine's musl build degenerates to byte order
 *      and cannot demonstrate this, which is why this phase pins the image.
 *
 * Rules, same as the other PG suites: `PG_INTEGRATION=1` means PostgreSQL really has
 * to run (a blocked harness is a failure, never a quiet pass); the container is the
 * harness' own random name and only it is cleaned up; scratch tables vanish with it.
 */
import { describe, expect, it } from "bun:test";
import { WriteConflictError } from "../../../../server/db/backend/write-port";
import { classifyPgError } from "../../../../server/db/pg-errors";
import { createPostgresClient } from "../../../../server/db/postgres-client";
import { translateWriteError } from "../../../../server/services/agent-runtime/runtime-write";
import { withPostgres } from "../../../db/pg-test-harness";

const PG_ENABLED = process.env.PG_INTEGRATION === "1";
const RUN_TIMEOUT_MS = 300_000;
const GLIBC_IMAGE = process.env.PG_TEST_IMAGE_GLIBC ?? "docker.io/library/postgres:17";

function urlFor(port: number, credentials: { user: string; password: string }): string {
	return `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(credentials.password)}@127.0.0.1:${port}/nf_harness`;
}

function intOf(row: unknown, column: string): number {
	return Number((row as Record<string, number | string>)[column]);
}

type Sql = ReturnType<typeof createPostgresClient>["sql"];
type Tx = { unsafe: Sql["unsafe"] };

/** The `transferNext` statement shape: one event per whole-section transaction. */
async function transferOne(
	begin: (fn: (tx: Tx) => Promise<void>) => Promise<unknown>,
	schema: string,
	recipientId: string,
	consumer: string,
	delivered: string[],
): Promise<boolean> {
	let claimedId: string | undefined;
	await begin(async (tx) => {
		const head = await tx.unsafe(
			`SELECT id, delivery_id, dedupe_key, arrival_seq FROM ${schema}.runtime_publication_outbox
				WHERE recipient_id = '${recipientId}' AND producer_kind = 'bash' AND state = 'pending'
				ORDER BY arrival_seq LIMIT 1`,
		);
		const row = head[0] as
			| { id: string; delivery_id: string; dedupe_key: string; arrival_seq: number }
			| undefined;
		if (!row) return;
		claimedId = row.delivery_id;
		await tx.unsafe(
			`INSERT INTO ${schema}.narrator_buffered_messages
				(id, narrator_id, kind, dedupe_key, delivery_id, arrival_seq, state)
				VALUES ('mb-${consumer}-${row.delivery_id}', '${recipientId}', 'task_notice',
					'${row.dedupe_key}', '${row.delivery_id}', ${row.arrival_seq}, 'queued')`,
		);
		await tx.unsafe(`DELETE FROM ${schema}.runtime_publication_outbox WHERE id = '${row.id}'`);
	});
	// Record the delivery only after the section actually committed.
	if (claimedId !== undefined) delivered.push(claimedId);
	return claimedId !== undefined;
}

describe("PostgreSQL agent-runtime queue write shapes", () => {
	if (!PG_ENABLED) {
		it("skipped: set PG_INTEGRATION=1 to run the real PostgreSQL verification", () => {
			// Explicitly a skip, not a pass: no PostgreSQL work happened here.
			expect(process.env.PG_INTEGRATION).not.toBe("1");
		});
		return;
	}

	it(
		"counter claims, outbox transfer and claim redelivery under real concurrency",
		async () => {
			const outcome = await withPostgres(async ({ port, schema, credentials, exec }) => {
				try {
					const ddl = await exec(`
					CREATE TABLE ${schema}.narrators (id text PRIMARY KEY, inbox_sequence integer NOT NULL DEFAULT 0);
					CREATE TABLE ${schema}.chat_rooms (id text PRIMARY KEY, next_seq integer NOT NULL DEFAULT 1,
						last_message_at text, last_message_preview text, last_message_sender_id text);
					CREATE TABLE ${schema}.runtime_publication_outbox (
						id text PRIMARY KEY,
						producer_kind text NOT NULL,
						task_id text NOT NULL,
						logical_run_id text NOT NULL,
						event_kind text NOT NULL,
						recipient_id text NOT NULL,
						state text NOT NULL DEFAULT 'reserved',
						arrival_seq integer,
						delivery_id text NOT NULL,
						dedupe_key text NOT NULL,
						created_at text NOT NULL,
						updated_at text NOT NULL
					);
					CREATE UNIQUE INDEX idx_runtime_outbox_event ON ${schema}.runtime_publication_outbox
						(producer_kind, task_id, logical_run_id, event_kind, recipient_id);
					CREATE TABLE ${schema}.narrator_buffered_messages (
						id text PRIMARY KEY,
						narrator_id text NOT NULL,
						kind text NOT NULL,
						dedupe_key text,
						delivery_id text,
						arrival_seq integer,
						claim_token text,
						claim_attempts integer NOT NULL DEFAULT 0,
						state text NOT NULL DEFAULT 'queued'
					);
					CREATE UNIQUE INDEX idx_nbm_dedupe ON ${schema}.narrator_buffered_messages (narrator_id, dedupe_key);
					CREATE TABLE ${schema}.ordinal_probe (
						id text PRIMARY KEY,
						insert_seq bigint GENERATED BY DEFAULT AS IDENTITY,
						note text
					);
					INSERT INTO ${schema}.narrators (id) VALUES ('n1'), ('n2');
					INSERT INTO ${schema}.chat_rooms (id) VALUES ('room1');
				`);
					if (ddl.code !== 0) return `ddl:${ddl.stderr.slice(0, 300)}`;
					const url = urlFor(port, credentials);

					// ── A. Mailbox arrival-seq counter claim, 20 concurrent claimants ──
					const poolA = createPostgresClient({
						driver: "bun-sql",
						url,
						max: 8,
						idleTimeout: 5,
						connectTimeout: 10,
					});
					try {
						await Promise.all(
							Array.from({ length: 20 }, (_, i) =>
								poolA.sql.begin(async (tx) => {
									// Exact allocateArrivalSequence shape (mailbox.ts).
									const claimed = await tx.unsafe(
										`UPDATE ${schema}.narrators SET inbox_sequence = inbox_sequence + 1 WHERE id = 'n1' RETURNING inbox_sequence`,
									);
									const arrivalSeq = intOf(claimed[0], "inbox_sequence");
									await tx.unsafe(
										`INSERT INTO ${schema}.narrator_buffered_messages
										(id, narrator_id, kind, dedupe_key, delivery_id, arrival_seq)
										VALUES ('a-mb${i}', 'n1', 'user_input', 'a-dk${i}', 'a-dv${i}', ${arrivalSeq})`,
									);
								}),
							),
						);
						const stats = await poolA.sql.unsafe(
							`SELECT COUNT(*) AS n, COUNT(DISTINCT arrival_seq) AS d, MIN(arrival_seq) AS lo, MAX(arrival_seq) AS hi
							FROM ${schema}.narrator_buffered_messages WHERE narrator_id = 'n1'`,
						);
						expect(intOf(stats[0], "n")).toBe(20);
						expect(intOf(stats[0], "d")).toBe(20);
						// allocateArrivalSequence returns the POST-increment value: seqs start at 1.
						expect(intOf(stats[0], "lo")).toBe(1);
						expect(intOf(stats[0], "hi")).toBe(20);
						const counter = await poolA.sql.unsafe(
							`SELECT inbox_sequence FROM ${schema}.narrators WHERE id = 'n1'`,
						);
						expect(intOf(counter[0], "inbox_sequence")).toBe(20);

						// A rolled-back claim is re-issued (the bump rolls back with the
						// transaction). Manual BEGIN/ROLLBACK needs a pinned connection,
						// never a pool.
						const rb = createPostgresClient({
							driver: "bun-sql",
							url,
							max: 1,
							connectTimeout: 10,
						});
						try {
							await rb.sql.unsafe("BEGIN");
							await rb.sql.unsafe(
								`UPDATE ${schema}.narrators SET inbox_sequence = inbox_sequence + 1 WHERE id = 'n2' RETURNING inbox_sequence`,
							);
							await rb.sql.unsafe("ROLLBACK");
							const again = await rb.sql.begin(async (tx) =>
								tx.unsafe(
									`UPDATE ${schema}.narrators SET inbox_sequence = inbox_sequence + 1 WHERE id = 'n2' RETURNING inbox_sequence`,
								),
							);
							expect(intOf((again as unknown[])[0], "inbox_sequence")).toBe(1);
						} finally {
							await rb.close();
						}
					} finally {
						await poolA.close();
					}

					// ── B. chat_rooms.next_seq claim, 16 concurrent posters ────────────
					const poolB = createPostgresClient({
						driver: "bun-sql",
						url,
						max: 8,
						idleTimeout: 5,
						connectTimeout: 10,
					});
					try {
						const seqs = await Promise.all(
							Array.from({ length: 16 }, (_, i) =>
								poolB.sql.begin(async (tx) => {
									// Exact claimMessageSeq shape (chat-service.ts): multi-column SET,
									// claimed seq = returned next_seq - 1.
									const claimed = await tx.unsafe(
										`UPDATE ${schema}.chat_rooms SET next_seq = next_seq + 1,
										last_message_at = '2026-01-01T00:00:00.000Z',
										last_message_preview = 'm${i}', last_message_sender_id = 'u1'
										WHERE id = 'room1' RETURNING next_seq`,
									);
									return intOf(claimed[0], "next_seq") - 1;
								}),
							),
						);
						// chat_rooms.next_seq defaults to 1 and the claim returns
						// next_seq - 1 (the PRE-increment value): first message claims 1.
						expect([...seqs].sort((a, b) => a - b)).toEqual(
							Array.from({ length: 16 }, (_, i) => i + 1),
						);
					} finally {
						await poolB.close();
					}

					// ── C. Outbox concurrent transfer: no loss, no duplicate ───────────
					const seed = await exec(`
					INSERT INTO ${schema}.runtime_publication_outbox
						(id, producer_kind, task_id, logical_run_id, event_kind, recipient_id, state,
							arrival_seq, delivery_id, dedupe_key, created_at, updated_at)
						SELECT 'ev' || g, 'bash', 'task' || g, 'run' || g, 'completed', 'r1', 'pending',
							g, 'dv' || g, 'dk' || g, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
						FROM generate_series(1, 60) AS g;
				`);
					if (seed.code !== 0) return `seed:${seed.stderr.slice(0, 300)}`;

					// C1. Deterministic race: the loser's INSERT blocks on the dedupe unique
					// index, fails 23505 when the winner commits, and its whole-section retry
					// moves to the next head — the no-duplicate mechanism, named.
					const c1 = createPostgresClient({ driver: "bun-sql", url, max: 1, connectTimeout: 10 });
					const c2 = createPostgresClient({ driver: "bun-sql", url, max: 1, connectTimeout: 10 });
					try {
						await c1.sql.unsafe("BEGIN");
						const head1 = await c1.sql.unsafe(
							`SELECT id, delivery_id, dedupe_key, arrival_seq FROM ${schema}.runtime_publication_outbox
							WHERE recipient_id = 'r1' AND producer_kind = 'bash' AND state = 'pending'
							ORDER BY arrival_seq LIMIT 1`,
						);
						const winner = head1[0] as { id: string; delivery_id: string; dedupe_key: string };
						await c1.sql.unsafe(
							`INSERT INTO ${schema}.narrator_buffered_messages
							(id, narrator_id, kind, dedupe_key, delivery_id, arrival_seq)
							VALUES ('mb-winner-${winner.delivery_id}', 'r1', 'task_notice',
								'${winner.dedupe_key}', '${winner.delivery_id}', 1)`,
						);
						await c2.sql.unsafe("BEGIN");
						// READ COMMITTED: c2's head SELECT still sees the row (c1's DELETE is uncommitted).
						const head2 = await c2.sql.unsafe(
							`SELECT id, delivery_id, dedupe_key FROM ${schema}.runtime_publication_outbox
							WHERE recipient_id = 'r1' AND producer_kind = 'bash' AND state = 'pending'
							ORDER BY arrival_seq LIMIT 1`,
						);
						expect((head2[0] as { id: string }).id).toBe(winner.id);
						// c2's INSERT now blocks on c1's uncommitted unique-index entry.
						const blockedInsert = c2.sql.unsafe(
							`INSERT INTO ${schema}.narrator_buffered_messages
							(id, narrator_id, kind, dedupe_key, delivery_id, arrival_seq)
							VALUES ('mb-loser-${winner.delivery_id}', 'r1', 'task_notice',
								'${winner.dedupe_key}', '${winner.delivery_id}', 1)`,
						);
						await Bun.sleep(250);
						await c1.sql.unsafe(
							`DELETE FROM ${schema}.runtime_publication_outbox WHERE id = '${winner.id}'`,
						);
						await c1.sql.unsafe("COMMIT");
						const conflict = await blockedInsert.then(
							() => null,
							(error: unknown) => error,
						);
						// The duplicate delivery died as 23505 — never delivered twice.
						expect(conflict).not.toBeNull();
						expect(classifyPgError(conflict).kind).toBe("unique-violation");
						// …and crosses the write boundary as the domain vocabulary (runtime-write.ts).
						const translated = translateWriteError(conflict, "outbox.transferNext");
						expect(translated).toBeInstanceOf(WriteConflictError);
						await c2.sql.unsafe("ROLLBACK");
						// The whole-section retry re-selects the head: row 2 now, delivered once.
						await c2.sql.begin(async (tx) => {
							const next = await tx.unsafe(
								`SELECT id, delivery_id, dedupe_key FROM ${schema}.runtime_publication_outbox
								WHERE recipient_id = 'r1' AND producer_kind = 'bash' AND state = 'pending'
								ORDER BY arrival_seq LIMIT 1`,
							);
							const row = next[0] as { id: string; delivery_id: string; dedupe_key: string };
							expect(row.id).toBe("ev2");
							await tx.unsafe(
								`INSERT INTO ${schema}.narrator_buffered_messages
								(id, narrator_id, kind, dedupe_key, delivery_id, arrival_seq)
								VALUES ('mb-c2-${row.delivery_id}', 'r1', 'task_notice',
									'${row.dedupe_key}', '${row.delivery_id}', 2)`,
							);
							await tx.unsafe(
								`DELETE FROM ${schema}.runtime_publication_outbox WHERE id = '${row.id}'`,
							);
						});
					} finally {
						await c1.close();
						await c2.close();
					}

					// C2. Two truly concurrent consumers drain the remaining 58 events.
					const consumerA = createPostgresClient({
						driver: "bun-sql",
						url,
						max: 2,
						idleTimeout: 5,
						connectTimeout: 10,
					});
					const consumerB = createPostgresClient({
						driver: "bun-sql",
						url,
						max: 2,
						idleTimeout: 5,
						connectTimeout: 10,
					});
					try {
						const deliveredA: string[] = [];
						const deliveredB: string[] = [];
						const drain = async (
							client: typeof consumerA,
							consumer: string,
							delivered: string[],
						) => {
							for (;;) {
								let transferred = false;
								let retries = 0;
								// The retry unit is the WHOLE section (pg-retry.ts): a 23505 replay
								// re-selects the head, never re-inserts the loser.
								for (;;) {
									try {
										transferred = await transferOne(
											(fn) => client.sql.begin(fn),
											schema,
											"r1",
											consumer,
											delivered,
										);
										break;
									} catch (error) {
										if (classifyPgError(error).kind !== "unique-violation" || retries++ > 100)
											throw error;
									}
								}
								if (!transferred) return;
							}
						};
						await Promise.all([
							drain(consumerA, "ca", deliveredA),
							drain(consumerB, "cb", deliveredB),
						]);
						// No loss: all 58 remaining events delivered. No duplicate: the two
						// consumers' sets are disjoint (each event exactly once overall).
						expect(deliveredA.length).toBeGreaterThan(0);
						expect(deliveredB.length).toBeGreaterThan(0);
						const all = [...deliveredA, ...deliveredB];
						expect(new Set(all).size).toBe(all.length);
						expect(all.length).toBe(58);
						const remaining = await consumerA.sql.unsafe(
							`SELECT COUNT(*) AS n FROM ${schema}.runtime_publication_outbox WHERE recipient_id = 'r1'`,
						);
						expect(intOf(remaining[0], "n")).toBe(0);
						const mailboxCount = await consumerA.sql.unsafe(
							`SELECT COUNT(*) AS n, COUNT(DISTINCT delivery_id) AS d
							FROM ${schema}.narrator_buffered_messages WHERE narrator_id = 'r1'`,
						);
						expect(intOf(mailboxCount[0], "n")).toBe(60);
						expect(intOf(mailboxCount[0], "d")).toBe(60);
					} finally {
						await consumerA.close();
						await consumerB.close();
					}

					// ── D. Mailbox claim exactly-once + failClaim redelivery ───────────
					const seedClaims = await exec(`
					INSERT INTO ${schema}.narrator_buffered_messages
						(id, narrator_id, kind, dedupe_key, delivery_id, arrival_seq)
						VALUES ('c-mb1', 'r2', 'user_input', 'c-dk1', 'c-dv1', 1),
							('c-mb2', 'r2', 'user_input', 'c-dk2', 'c-dv2', 2);
				`);
					if (seedClaims.code !== 0) return `seed-claims:${seedClaims.stderr.slice(0, 300)}`;
					const d1 = createPostgresClient({ driver: "bun-sql", url, max: 1, connectTimeout: 10 });
					const d2 = createPostgresClient({ driver: "bun-sql", url, max: 1, connectTimeout: 10 });
					try {
						// Both claimers select the same head; the loser blocks on the row lock,
						// re-evaluates WHERE state='queued' after the winner commits (EPQ), and
						// claims NOTHING — exactly-once without a unique-violation round trip.
						const headShape = `SELECT id FROM ${schema}.narrator_buffered_messages
						WHERE narrator_id = 'r2' AND state = 'queued' ORDER BY arrival_seq LIMIT 1`;
						const claimShape = (id: string, token: string) =>
							`UPDATE ${schema}.narrator_buffered_messages SET state = 'claimed',
							claim_token = '${token}', claim_attempts = claim_attempts + 1
							WHERE id = '${id}' AND state = 'queued' RETURNING id`;
						await d1.sql.unsafe("BEGIN");
						const d1Head = await d1.sql.unsafe(headShape);
						const d1Claimed = await d1.sql.unsafe(
							claimShape((d1Head[0] as { id: string }).id, "token-d1"),
						);
						expect(d1Claimed.length).toBe(1);
						await d2.sql.unsafe("BEGIN");
						const d2Head = await d2.sql.unsafe(headShape);
						expect((d2Head[0] as { id: string }).id).toBe((d1Head[0] as { id: string }).id);
						const blockedClaim = d2.sql.unsafe(
							claimShape((d2Head[0] as { id: string }).id, "token-d2"),
						);
						await Bun.sleep(250);
						await d1.sql.unsafe("COMMIT");
						const lost = await blockedClaim;
						expect(lost.length).toBe(0);
						await d2.sql.unsafe("ROLLBACK");
						// The loser's retry claims the NEXT head, exactly once.
						await d2.sql.begin(async (tx) => {
							const next = await tx.unsafe(headShape);
							expect((next[0] as { id: string }).id).toBe("c-mb2");
							const claimed = await tx.unsafe(
								claimShape((next[0] as { id: string }).id, "token-d2"),
							);
							expect(claimed.length).toBe(1);
						});

						// failClaim shape: the row returns to 'queued' with its attempt counted,
						// and a later pass claims it AGAIN — redelivery without duplication.
						await d1.sql.begin(async (tx) => {
							const failed = await tx.unsafe(
								`UPDATE ${schema}.narrator_buffered_messages SET state = 'queued', claim_token = NULL
								WHERE id = 'c-mb1' AND claim_token = 'token-d1' RETURNING id`,
							);
							expect(failed.length).toBe(1);
						});
						await d1.sql.begin(async (tx) => {
							const rehead = await tx.unsafe(headShape);
							expect((rehead[0] as { id: string }).id).toBe("c-mb1");
							const reclaimed = await tx.unsafe(claimShape("c-mb1", "token-d3"));
							expect(reclaimed.length).toBe(1);
						});
						const attempts = await d1.sql.unsafe(
							`SELECT claim_attempts FROM ${schema}.narrator_buffered_messages WHERE id = 'c-mb1'`,
						);
						expect(intOf(attempts[0], "claim_attempts")).toBe(2);
					} finally {
						await d1.close();
						await d2.close();
					}

					// ── E. insert_seq identity ordinal: the rowid replacement ────────
					const e = createPostgresClient({ driver: "bun-sql", url, max: 1, connectTimeout: 10 });
					try {
						// Migration backfill: explicit ordinals copied from SQLite rowids
						// (GENERATED BY DEFAULT accepts them; ALWAYS would reject this insert).
						await e.sql.unsafe(
							`INSERT INTO ${schema}.ordinal_probe (id, insert_seq, note) VALUES
							('e1', 5, 'migrated'), ('e2', 6, 'migrated'), ('e3', 7, 'migrated')`,
						);
						// Explicit inserts do NOT advance the identity sequence: the migration
						// must restart it above the backfilled maximum (schema proposal text).
						await e.sql.unsafe(
							`SELECT setval(pg_get_serial_sequence('${schema}.ordinal_probe', 'insert_seq'),
							(SELECT max(insert_seq) FROM ${schema}.ordinal_probe))`,
						);
						const boundary = await e.sql.unsafe(
							`SELECT max(insert_seq) AS top FROM ${schema}.ordinal_probe`,
						);
						const top = intOf(boundary[0], "top");
						expect(top).toBe(7);
						// Post-capture inserts auto-allocate strictly above the boundary.
						await e.sql.unsafe(
							`INSERT INTO ${schema}.ordinal_probe (id, note) VALUES ('e4', 'post-capture')`,
						);
						const classification = await e.sql.unsafe(
							`SELECT id, insert_seq <= ${top} AS predates FROM ${schema}.ordinal_probe ORDER BY insert_seq`,
						);
						expect(
							classification.map((r: { id: string; predates: boolean }) => [r.id, r.predates]),
						).toEqual([
							["e1", true],
							["e2", true],
							["e3", true],
							["e4", false],
						]);
						const allocated = await e.sql.unsafe(
							`SELECT insert_seq FROM ${schema}.ordinal_probe WHERE id = 'e4'`,
						);
						expect(intOf(allocated[0], "insert_seq")).toBe(8);
					} finally {
						await e.close();
					}

					return "verified";
				} catch (error) {
					// Surface the real failure: the harness' own "callback failed" hides it.
					return `callback:${error instanceof Error ? error.message : String(error)}`;
				}
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

	it(
		'id-cursor pagination is byte-ordered under COLLATE "C" (glibc collation)',
		async () => {
			const outcome = await withPostgres(
				async ({ port, schema, credentials, exec }) => {
					// nanoid-alphabet ids chosen so byte order and en_US.utf8 order disagree:
					// byte order is Z < a (uppercase first); en_US.utf8 interleaves case.
					const ids = ["a1", "Z9", "mM", "Mm", "zz", "AA", "0x", "_q"];
					const ddl = await exec(`
						CREATE TABLE ${schema}.page_probe (id text PRIMARY KEY);
						INSERT INTO ${schema}.page_probe (id) VALUES
							${ids.map((id) => `('${id}')`).join(", ")};
					`);
					if (ddl.code !== 0) return `ddl:${ddl.stderr.slice(0, 300)}`;
					const url = urlFor(port, credentials);
					const client = createPostgresClient({
						driver: "bun-sql",
						url,
						max: 1,
						connectTimeout: 10,
					});
					try {
						const byteOrder = [...ids].sort();
						const defaultOrder = (
							await client.sql.unsafe(`SELECT id FROM ${schema}.page_probe ORDER BY id`)
						).map((r: { id: string }) => r.id);
						const cOrder = (
							await client.sql.unsafe(`SELECT id FROM ${schema}.page_probe ORDER BY id COLLATE "C"`)
						).map((r: { id: string }) => r.id);
						// The glibc default collation genuinely diverges — the reason the
						// read-cursor contract exists — and COLLATE "C" IS byte order.
						expect(defaultOrder).not.toEqual(byteOrder);
						expect(cOrder).toEqual(byteOrder);
						// Keyset pagination over the cursor shape (listPending): WHERE id >
						// cursor COLLATE "C" + ORDER BY id COLLATE "C", walked to exhaustion,
						// yields exactly the byte-ordered suffixes — SQLite-BINARY-identical
						// pages with no overlap and no gap.
						const pageSize = 3;
						const seen: string[] = [];
						let cursor: string | null = null;
						for (;;) {
							const page = (
								await client.sql.unsafe(
									`SELECT id FROM ${schema}.page_probe
										${cursor === null ? "" : `WHERE id > '${cursor}' COLLATE "C"`}
										ORDER BY id COLLATE "C" LIMIT ${pageSize + 1}`,
								)
							).map((r: { id: string }) => r.id);
							const rows = page.slice(0, pageSize);
							seen.push(...rows);
							if (page.length <= pageSize) break;
							cursor = rows[rows.length - 1] as string;
						}
						expect(seen).toEqual(byteOrder);
					} finally {
						await client.close();
					}
					return "verified";
				},
				{ image: GLIBC_IMAGE },
			);
			if (outcome !== "verified") {
				throw new Error(
					`glibc-collation PostgreSQL verification unavailable or failed: ${
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
