/**
 * The PostgreSQL runtime queue ADAPTER, verified against a real PostgreSQL 17.
 *
 * ⚠️ THIS IS NOT THE PRODUCTION SCHEMA PATH — READ BEFORE TRUSTING A PASS.
 * The tables below are SCRATCH tables created in the `public` schema of a throwaway
 * harness container. They carry the production table NAMES and the exact production
 * columns/defaults the adapter's statements touch, so the drizzle query builder
 * resolves them unqualified — but no migration, journal or `postgres-schema.ts`
 * change is exercised here, and the scratch layout deliberately omits production
 * foreign keys and the pending `insert_seq` identity columns. What this suite locks
 * is the adapter's semantics under a real engine: FOR UPDATE SKIP LOCKED claiming,
 * idempotent enqueue/commit under races, fail/redelivery, materialize + ack, outbox
 * reserve/commit/transfer, error vocabulary, and the fail-closed legacy surface.
 * The statement-SHAPE proofs from first principles (EPQ re-evaluation, unique-index
 * blocking, collation divergence) live in the sibling `pg-runtime-queue.test.ts`.
 *
 * Rules, same as the other PG suites: `PG_INTEGRATION=1` means PostgreSQL really has
 * to run (a blocked harness is a failure, never a quiet pass); the container is the
 * harness' own random name and only it is cleaned up; scratch tables vanish with it.
 */
import { describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { createPostgresClient } from "../../../../server/db/postgres-client";
import {
	createPostgresRuntimeQueue,
	probeRuntimeQueueSchema,
	RuntimeQueueSchemaPendingError,
} from "../../../../server/services/agent-runtime/postgres-runtime-queue";
import type { PublicationRun } from "../../../../server/services/agent-runtime/publication-outbox";
import { withPostgres } from "../../../db/pg-test-harness";

const PG_ENABLED = process.env.PG_INTEGRATION === "1";
const RUN_TIMEOUT_MS = 300_000;

function urlFor(port: number, credentials: { user: string; password: string }): string {
	return `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(credentials.password)}@127.0.0.1:${port}/nf_harness`;
}

function intOf(row: unknown, column: string): number {
	return Number((row as Record<string, unknown>)[column]);
}

/**
 * Scratch DDL: production table names and the production column set/defaults for the
 * columns the adapter touches. NOT the production migration path (see the header).
 */
const SCRATCH_DDL = `
CREATE TABLE public.narrators (
	id text PRIMARY KEY,
	inbox_sequence integer NOT NULL DEFAULT 0,
	logical_run_id text
);
CREATE TABLE public.narrator_buffered_messages (
	id text PRIMARY KEY,
	narrator_id text NOT NULL,
	text text NOT NULL,
	images_json text,
	command_text text,
	bash_command text,
	created_by text,
	creator_json text,
	text_file_paths_json text,
	file_references_json text,
	priority boolean NOT NULL DEFAULT false,
	seq integer NOT NULL,
	buffered_at text NOT NULL,
	kind text NOT NULL DEFAULT 'user_input',
	notice_kind text,
	envelope_version integer NOT NULL DEFAULT 1,
	metadata_json text,
	source_narrator_id text,
	source_tool_call_id text,
	source_attempt integer,
	source_key text,
	dedupe_key text,
	delivery_id text,
	recipient_message_id text,
	recipient_ref_id text,
	current_message_id text,
	content_revision integer NOT NULL DEFAULT 1,
	adopted_revision integer,
	adopted_at text,
	current_revision integer NOT NULL DEFAULT 1,
	current_adopted_revision integer,
	current_adopted_at text,
	receipt_disposition text NOT NULL DEFAULT 'active',
	arrival_seq integer,
	state text NOT NULL DEFAULT 'queued',
	claim_token text,
	claim_epoch text,
	claimed_at text,
	claim_attempts integer NOT NULL DEFAULT 0,
	last_error text,
	byte_size integer NOT NULL DEFAULT 0,
	projected_byte_size integer NOT NULL DEFAULT 0,
	payload_ref_json text,
	dedupe_expires_at text,
	updated_at text
);
CREATE UNIQUE INDEX idx_nbm_dedupe ON public.narrator_buffered_messages (narrator_id, dedupe_key);
CREATE UNIQUE INDEX idx_nbm_delivery ON public.narrator_buffered_messages (delivery_id);
CREATE TABLE public.runtime_publication_outbox (
	id text PRIMARY KEY,
	producer_kind text NOT NULL,
	task_id text NOT NULL,
	logical_run_id text NOT NULL,
	event_kind text NOT NULL,
	recipient_id text NOT NULL,
	state text NOT NULL DEFAULT 'reserved',
	arrival_seq integer,
	result_ref text,
	summary text,
	delivery_id text NOT NULL,
	dedupe_key text NOT NULL,
	last_error text,
	created_at text NOT NULL,
	updated_at text NOT NULL
);
CREATE UNIQUE INDEX idx_runtime_outbox_event ON public.runtime_publication_outbox
	(producer_kind, task_id, logical_run_id, event_kind, recipient_id);
CREATE TABLE public.narrator_message_refs (
	id text PRIMARY KEY,
	narrator_id text NOT NULL,
	message_id text NOT NULL,
	seq integer NOT NULL DEFAULT 0,
	is_compact integer NOT NULL DEFAULT 0,
	injection_consumed_at bigint
);
-- insert_seq probe targets: two of the three tables carry the (proposed) column from
-- the start, so the probe's MISSING verdict names exactly the third; the ALTER in
-- section F then demonstrates the available verdict. Scratch only — no migration runs.
CREATE TABLE public.background_tasks (
	id text PRIMARY KEY,
	insert_seq bigint GENERATED BY DEFAULT AS IDENTITY
);
CREATE TABLE public.narrator_tool_continuations (
	id text PRIMARY KEY,
	insert_seq bigint GENERATED BY DEFAULT AS IDENTITY
);
INSERT INTO public.narrators (id) VALUES
	('n-a'), ('n-b'), ('n-c'), ('n-d'), ('n-e'), ('n-f'), ('n-g'), ('n-h');
`;

describe("PostgreSQL runtime queue adapter (scratch schema, real engine)", () => {
	if (!PG_ENABLED) {
		it("skipped: set PG_INTEGRATION=1 to run the real PostgreSQL verification", () => {
			// Explicitly a skip, not a pass: no PostgreSQL work happened here.
			expect(process.env.PG_INTEGRATION).not.toBe("1");
		});
		return;
	}

	it(
		"claim/ack/fail/materialize/outbox semantics under real concurrency",
		async () => {
			const outcome = await withPostgres(async ({ port, credentials, exec }) => {
				let stage = "ddl";
				try {
					const ddl = await exec(SCRATCH_DDL);
					if (ddl.code !== 0) return `ddl:${ddl.stderr.slice(0, 400)}`;
					const client = createPostgresClient({
						driver: "bun-sql",
						url: urlFor(port, credentials),
						max: 10,
						idleTimeout: 5,
						connectTimeout: 10,
					});
					try {
						const store = createPostgresRuntimeQueue(client.db);

						// The staging ownership probe is a bounded, narrator-scoped lookup rather
						// than a payload scan. It must find the row in its own mailbox and never
						// mistake the same staging id in another narrator for ownership.
						const staged = await store.mailbox.enqueue({
							kind: "user_input",
							narratorId: "n-c",
							requestKey: "staging-contract",
							text: "staged",
							metadata: { stagingId: "stage-contract" },
							projectedByteSize: 6,
						});
						expect(staged.status).toBe("accepted");
						if (staged.status === "accepted") {
							expect((await store.mailbox.getByStagingId("n-c", "stage-contract"))?.id).toBe(
								staged.delivery.id,
							);
							expect(await store.mailbox.getByStagingId("n-d", "stage-contract")).toBeUndefined();
						}

						// ── A. enqueue: idempotent replay and concurrent counter claims ──
						stage = "A-enqueue";
						const first = await store.mailbox.enqueue({
							kind: "user_input",
							narratorId: "n-a",
							requestKey: "rk-1",
							text: "hello",
							projectedByteSize: 5,
						});
						if (first.status !== "accepted") return `enqueue:first:${first.status}`;
						expect(first.delivery.arrivalSeq).toBe(1);
						const replay = await store.mailbox.enqueue({
							kind: "user_input",
							narratorId: "n-a",
							requestKey: "rk-1",
							text: "hello",
							projectedByteSize: 5,
						});
						// Lost-confirmation replay returns the ORIGINAL receipt, never a second row.
						expect(replay.status).toBe("duplicate");
						if (replay.status === "duplicate")
							expect(replay.delivery.deliveryId).toBe(first.delivery.deliveryId);

						// 20 concurrent distinct inputs: gapless unique arrival seqs, no 23505 escape.
						const accepted = await Promise.all(
							Array.from({ length: 20 }, (_, i) =>
								store.mailbox.enqueue({
									kind: "user_input",
									narratorId: "n-a",
									requestKey: `rk-batch-${i}`,
									text: `m${i}`,
									projectedByteSize: Buffer.byteLength(`m${i}`),
								}),
							),
						);
						expect(accepted.every((r) => r.status === "accepted")).toBe(true);
						const seqs = accepted
							.map((r) =>
								r.status === "accepted" || r.status === "duplicate" ? r.delivery.arrivalSeq : -1,
							)
							.sort((a, b) => (a ?? 0) - (b ?? 0));
						expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 2));

						// 8 concurrent SAME-key enqueues: exactly one acceptance; every loser gets
						// the duplicate receipt through the WriteConflictError recovery, and the
						// unique index is the no-duplicate authority (one row total).
						const raced = await Promise.all(
							Array.from({ length: 8 }, () =>
								store.mailbox.enqueue({
									kind: "user_input",
									narratorId: "n-a",
									requestKey: "rk-race",
									text: "race",
									projectedByteSize: 4,
								}),
							),
						);
						expect(raced.filter((r) => r.status === "accepted").length).toBe(1);
						expect(raced.filter((r) => r.status === "duplicate").length).toBe(7);
						const countA = await client.sql.unsafe(
							`SELECT count(*)::int AS n FROM narrator_buffered_messages WHERE narrator_id = 'n-a'`,
						);
						expect(intOf(countA[0], "n")).toBe(22);

						// ── B. claim exactly-once + SKIP LOCKED batch drain ─────────────
						stage = "B-claim";
						for (let i = 0; i < 10; i++)
							await store.mailbox.enqueue({
								kind: "user_input",
								narratorId: "n-b",
								requestKey: `rk-b-${i}`,
								text: `b${i}`,
								projectedByteSize: 2,
							});
						const claimed = await Promise.all(
							Array.from({ length: 10 }, (_, i) =>
								store.mailbox.claimEligibleHead("n-b", { token: `tk-${i}`, epoch: "e1" }),
							),
						);
						// Ten concurrent claimers, ten distinct rows: SKIP LOCKED never hands the
						// same head to two owners, and the conditional UPDATE is the backstop.
						expect(claimed.every((row) => row !== undefined)).toBe(true);
						expect(new Set(claimed.map((row) => row?.id)).size).toBe(10);
						expect(claimed.every((row) => row?.state === "claimed")).toBe(true);
						expect(
							await store.mailbox.claimEligibleHead("n-b", { token: "tk-x", epoch: "e1" }),
						).toBeUndefined();

						for (let i = 0; i < 5; i++)
							await store.mailbox.enqueue({
								kind: "task_notice",
								narratorId: "n-c",
								noticeKind: "bash",
								sourceKey: `pk-notice-${i}`,
								text: `done ${i}`,
								projectedByteSize: 6,
							});
						// Two racing batch consumers split the queue with no overlap.
						const [batch1, batch2] = await Promise.all([
							store.mailbox.claimBatch("n-c", { token: "tb-1", epoch: "e1" }, { count: 16 }),
							store.mailbox.claimBatch("n-c", { token: "tb-2", epoch: "e1" }, { count: 16 }),
						]);
						const batchIds = [...batch1, ...batch2].map((row) => row.id);
						expect(batchIds.length).toBe(5);
						expect(new Set(batchIds).size).toBe(5);

						// ── C. fail/redelivery: claim → fail → re-claim, terminal at max attempts ──
						stage = "C-fail";
						await store.mailbox.enqueue({
							kind: "user_input",
							narratorId: "n-d",
							requestKey: "rk-d-1",
							text: "d1",
							projectedByteSize: 2,
						});
						const owner = (n: number) => ({ token: `td-${n}`, epoch: "e1" });
						let claimRow = await store.mailbox.claimEligibleHead("n-d", owner(1));
						if (!claimRow) return "claim:d:first";
						const firstClaim = {
							id: claimRow.id,
							narratorId: "n-d",
							token: "td-1",
							epoch: "e1",
						};
						expect(claimRow.claimAttempts).toBe(1);
						expect(await store.mailbox.failClaim(firstClaim, "boom")).toBe(true);
						// The released claim is stale immediately: the same claim object can never ack/fail again.
						const stale = await store.mailbox.failClaim(firstClaim, "again").then(
							() => null,
							(error: unknown) => error,
						);
						expect(stale).toBeInstanceOf(Error);
						expect((stale as Error).message).toContain("Stale mailbox claim");
						// Redelivery: the same row comes back to the next owner with attempts counted.
						for (let attempt = 2; attempt <= 5; attempt++) {
							claimRow = await store.mailbox.claimEligibleHead("n-d", owner(attempt));
							if (!claimRow) return `claim:d:attempt-${attempt}`;
							expect(claimRow.claimAttempts).toBe(attempt);
							const deliveredId = claimRow.deliveryId;
							const failed = await store.mailbox.failClaim(
								{ id: claimRow.id, narratorId: "n-d", token: `td-${attempt}`, epoch: "e1" },
								`boom-${attempt}`,
							);
							expect(failed).toBe(true);
							if (attempt === 5) {
								// claimMaxAttempts reached: the row is terminally failed, not requeued.
								expect(await store.mailbox.claimEligibleHead("n-d", owner(6))).toBeUndefined();
								expect(await store.mailbox.retryFailed(deliveredId ?? "")).toBe(true);
								claimRow = await store.mailbox.claimEligibleHead("n-d", owner(7));
								if (!claimRow) return "claim:d:after-retry";
								expect(claimRow.claimAttempts).toBe(1);
							}
						}

						// ── D. materialize + ack: reserved identity, payload release, stale replay ──
						stage = "D-materialize";
						const matClaim = {
							id: claimRow.id,
							narratorId: "n-d",
							token: "td-7",
							epoch: "e1",
						};
						const refId = "ref-d-1";
						const materialized = await store.mailbox.materialize(matClaim, async (tx, row) => {
							// The materializer persists the recipient ref in the SAME transaction and
							// uses the reserved message identity — both enforced by the section.
							await tx.execute(
								sql`INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq)
									VALUES (${refId}, ${row.narratorId}, ${row.recipientMessageId ?? ""}, 0)`,
							);
							return { messageId: row.recipientMessageId ?? "", refId };
						});
						expect(materialized.state).toBe("materialized");
						expect(materialized.recipientRefId).toBe(refId);
						expect(materialized.text).toBe("");
						expect(materialized.claimToken).toBeNull();
						const staleMaterialize = await store.mailbox
							.materialize(matClaim, async () => ({ messageId: "m", refId: "r" }))
							.then(
								() => null,
								(error: unknown) => error,
							);
						expect((staleMaterialize as Error).message).toContain("Stale mailbox claim");

						// A materializer that ignores the reserved identity is rejected and rolls back.
						await store.mailbox.enqueue({
							kind: "user_input",
							narratorId: "n-d",
							requestKey: "rk-d-2",
							text: "d2",
							projectedByteSize: 2,
						});
						const badClaimRow = await store.mailbox.claimEligibleHead("n-d", owner(8));
						if (!badClaimRow) return "claim:d:bad-materialize";
						const badClaim = {
							id: badClaimRow.id,
							narratorId: "n-d",
							token: "td-8",
							epoch: "e1",
						};
						const badMaterialize = await store.mailbox
							.materialize(badClaim, async () => ({
								messageId: "not-the-reserved-id",
								refId: "r-x",
							}))
							.then(
								() => null,
								(error: unknown) => error,
							);
						expect((badMaterialize as Error).message).toContain("reserved message identity");
						// Rolled back: the row is still claimed by the same owner, not half-materialized.
						expect(await store.mailbox.cancelClaim(badClaim, "cleanup")).toBe(true);

						// ackCurrentRevision / ackAdopted on the materialized row.
						const acked = await store.mailbox.ackCurrentRevision(
							materialized.deliveryId ?? "",
							"n-d",
							refId,
							1,
						);
						expect(acked).toBe(true);
						const adopted = await store.mailbox.ackAdopted(
							materialized.deliveryId ?? "",
							"n-d",
							refId,
							1,
						);
						expect(adopted).toBe(true);
						const refRow = await client.sql.unsafe(
							`SELECT injection_consumed_at FROM narrator_message_refs WHERE id = '${refId}'`,
						);
						expect(Number(refRow[0]?.injection_consumed_at)).toBeGreaterThan(0);
						// Wrong revision is a quiet false, never a state change.
						expect(
							await store.mailbox.ackCurrentRevision(
								materialized.deliveryId ?? "",
								"n-d",
								refId,
								99,
							),
						).toBe(false);

						// ── E. outbox: reserve → commit → duplicate → transfer, and failRecipient ──
						stage = "E-outbox";
						const run: PublicationRun = {
							producerKind: "bash",
							taskId: "task-e1",
							logicalRunId: "run-e1",
							recipientId: "n-e",
						};
						expect(await store.outbox.reserveRunSlots(run, { started: true })).toEqual({
							status: "reserved",
							logicalRunId: "run-e1",
						});
						const started = await store.outbox.commitIntent({
							...run,
							eventKind: "started",
							resultRef: "result:task-e1:started",
							summary: "started",
						});
						expect(started.status).toBe("committed");
						const completed = await store.outbox.commitIntent({
							...run,
							eventKind: "completed",
							resultRef: "result:task-e1:final",
							summary: "done",
						});
						expect(completed.status).toBe("committed");
						// Idempotent republish: the existing receipt wins over a regenerated summary.
						const republish = await store.outbox.commitIntent({
							...run,
							eventKind: "completed",
							resultRef: "result:task-e1:final",
							summary: "REGENERATED — must not win",
						});
						expect(republish.status).toBe("duplicate");
						expect(republish.deliveryId).toBe(completed.deliveryId);
						// Transfer drains in arrival order, exactly once, then reports empty.
						const t1 = await store.outbox.transferNext("n-e", "bash");
						const t2 = await store.outbox.transferNext("n-e", "bash");
						expect(t1.status).toBe("transferred");
						expect(t2.status).toBe("transferred");
						expect(t1.deliveryId).not.toBe(t2.deliveryId);
						expect((await store.outbox.transferNext("n-e", "bash")).status).toBe("empty");
						const notices = await store.mailbox.list("n-e", { kind: "task_notice" });
						expect(notices.length).toBe(2);

						// A committed intent for a deleted recipient fails the slot, never fabricates delivery.
						const ghostRun: PublicationRun = {
							producerKind: "agent",
							taskId: "task-e2",
							logicalRunId: "run-e2",
							recipientId: "n-ghost",
						};
						await store.outbox.reserveRunSlots(ghostRun);
						const ghost = await store.outbox.commitIntent({
							...ghostRun,
							eventKind: "failed",
							resultRef: "result:task-e2",
							summary: "failed",
						});
						expect(ghost).toEqual({
							status: "committed",
							deliveryId: ghost.deliveryId,
							arrivalSeq: null,
						});
						expect(
							await store.outbox.collectFailed(["unused"], (id) =>
								Promise.resolve(id === "unused"),
							),
						).toBe(0);

						// listPending walks pages in byte order with no overlap (COLLATE "C" cursor).
						const pageRunBase = { producerKind: "bash" as const, recipientId: "n-f" };
						const pendingIds: string[] = [];
						for (let i = 0; i < 5; i++) {
							const pRun = { ...pageRunBase, taskId: `task-f${i}`, logicalRunId: `run-f${i}` };
							await store.outbox.reserveRunSlots(pRun);
							const committed = await store.outbox.commitIntent({
								...pRun,
								eventKind: "completed",
								resultRef: `result:task-f${i}`,
								summary: `f${i}`,
							});
							if (committed.deliveryId) pendingIds.push(committed.deliveryId);
						}
						const walked: string[] = [];
						let cursor: string | undefined;
						for (;;) {
							const page = await store.outbox.listPending({ afterId: cursor, limit: 2 });
							walked.push(...page.slice(0, 2).map((row) => row.id));
							if (page.length <= 2) break;
							cursor = page[1]?.id;
						}
						expect(new Set(walked).size).toBe(walked.length);
						expect(walked.length).toBe(5);
						expect([...walked].sort()).toEqual(walked);

						// ── F. publication barrier: pending outbox blocks later arrivals ──
						stage = "F-barrier";
						await store.mailbox.enqueue({
							kind: "user_input",
							narratorId: "n-g",
							requestKey: "rk-g-1",
							text: "g1",
							projectedByteSize: 2,
						});
						const barrierRun: PublicationRun = {
							producerKind: "bash",
							taskId: "task-g1",
							logicalRunId: "run-g1",
							recipientId: "n-g",
						};
						await store.outbox.reserveRunSlots(barrierRun);
						await store.outbox.commitIntent({
							...barrierRun,
							eventKind: "completed",
							resultRef: "result:task-g1",
							summary: "barrier",
						});
						await store.mailbox.enqueue({
							kind: "user_input",
							narratorId: "n-g",
							requestKey: "rk-g-2",
							text: "g2",
							projectedByteSize: 2,
						});
						const g1 = await store.mailbox.claimEligibleHead("n-g", { token: "tg-1", epoch: "e1" });
						expect(g1?.kind).toBe("user_input");
						// The second user input is BEHIND the pending publication: not claimable yet.
						expect(
							await store.mailbox.claimEligibleHead("n-g", { token: "tg-2", epoch: "e1" }),
						).toBeUndefined();
						expect((await store.outbox.transferNext("n-g", "bash")).status).toBe("transferred");
						const notice = await store.mailbox.claimEligibleHead("n-g", {
							token: "tg-3",
							epoch: "e1",
						});
						expect(notice?.kind).toBe("task_notice");
						const g2 = await store.mailbox.claimEligibleHead("n-g", { token: "tg-4", epoch: "e1" });
						expect(g2?.kind).toBe("user_input");

						// ── G. fail-closed legacy + schema probe against the live database ──
						stage = "G-legacy";
						const legacyFailure = await store.legacy
							.registerLegacyCompletedRunSlots({
								producerKind: "agent",
								taskId: "t",
								recipientId: "n-a",
							})
							.then(
								() => null,
								(error: unknown) => error,
							);
						expect(legacyFailure).toBeInstanceOf(RuntimeQueueSchemaPendingError);
						expect(store.schemaReadiness.legacyAdmission).toBe("blocked");

						// The probe reads the LIVE catalog: scratch has two of the three columns,
						// so the missing verdict must name exactly narrators.insert_seq.
						const executor = {
							unsafe: (query: string, params?: unknown[]) =>
								client.sql.unsafe(query, params) as Promise<Record<string, unknown>[]>,
						};
						const before = await probeRuntimeQueueSchema(executor);
						expect(before.insertSeqOrdinal).toBe("missing");
						expect(before.pendingSchema).toEqual(["narrators.insert_seq"]);
						expect((await store.activateLegacyAdmission()).legacyAdmission).toBe("blocked");
						const alter = await exec(
							`ALTER TABLE public.narrators ADD COLUMN insert_seq bigint GENERATED BY DEFAULT AS IDENTITY;`,
						);
						if (alter.code !== 0) return `alter:${alter.stderr.slice(0, 300)}`;
						const after = await probeRuntimeQueueSchema(executor);
						expect(after.insertSeqOrdinal).toBe("available");
						expect(after.pendingSchema).toEqual([]);
						// A catalog probe does not itself capture a store boundary. Explicit
						// activation is required; full legacy semantics are proved on the formal
						// journal in pg-runtime-queue-legacy.test.ts, NOT by this scratch schema.
						expect(after.legacyAdmission).toBe("blocked");
						expect((await store.activateLegacyAdmission()).legacyAdmission).toBe("available");

						return "verified";
					} finally {
						await client.close();
					}
				} catch (error) {
					// Surface the real failure: the harness' own "callback failed" hides it.
					return `callback@${stage}:${error instanceof Error ? error.message : String(error)}`;
				}
			});
			if (outcome !== "verified") {
				throw new Error(
					`real PostgreSQL adapter verification unavailable or failed: ${
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
