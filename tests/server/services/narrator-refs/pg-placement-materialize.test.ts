/**
 * The PG placement seam — `createPgPlacedMessageMaterializer` plus the named
 * transaction-local helper `persistPgMessageWithRef` — verified against a real
 * PostgreSQL 17 running the COMPLETE production migration journal.
 *
 * What is proven here (and what a pass means):
 *
 *   1. SAME-TRANSACTION MATERIALIZE — a claimed mailbox row, its recipient
 *      message + ref, the PG `onPersist` hook effect and the mailbox flip all
 *      commit inside the queue's single `mailbox.materialize` section: counters
 *      (next_seq/message_count/message_version), the parent narrator's version
 *      bump and the FTS shadow row are all-or-nothing.
 *   2. FAILURE ATOMICITY — a rejected MESSAGE insert, a rejected REF insert and
 *      a throwing hook each roll back the whole section: no message, no ref, no
 *      counters, no FTS row, and the mailbox row is still claimed by the same
 *      owner (the claim was never consumed).
 *   3. DUPLICATE DELIVERY — re-materializing a consumed claim rejects as stale
 *      and re-enqueueing the same request key returns the duplicate receipt;
 *      exactly one message/ref exists either way.
 *   4. RESERVED IDENTITY — the reserved recipientMessageId is enforced twice
 *      (materializer + queue section); a message id collision committed by
 *      another path surfaces as `WriteConflictError` (SQLSTATE 23505), never a
 *      retry, never a partial write.
 *   5. WHOLE-SECTION RETRY — injected 40001/40P01 on the FIRST attempt replays
 *      the entire materialize section exactly once: one message, one ref, one
 *      mailbox flip, counters as if the failure never happened.
 *   6. THE HELPER STANDALONE — `persistPgMessageWithRef` returns
 *      { messageId, refId, seq } and enforces the 2 MiB write budget for
 *      non-port callers (the materializer path never re-validates elsewhere).
 *
 * Rules, same as the other PG suites: `PG_INTEGRATION=1` means PostgreSQL
 * really has to run (a blocked harness is a failure, never a quiet pass); the
 * container is the harness' own random name and only it is cleaned up.
 */
import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { WriteConflictError } from "../../../../server/db/backend/write-port";
import { ensurePgFts } from "../../../../server/db/pg-fts";
import { createPostgresClient } from "../../../../server/db/postgres-client";
import {
	narratorBufferedMessages,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../../../server/db/postgres-schema";
import type { PgMailboxRow } from "../../../../server/services/agent-runtime/postgres-runtime-queue";
import { createPostgresRuntimeQueue } from "../../../../server/services/agent-runtime/postgres-runtime-queue";
import type { RefMessageInput } from "../../../../server/services/narrator-refs/port";
import {
	createPostgresNarratorMessageRefsPort,
	persistPgMessageWithRef,
} from "../../../../server/services/narrator-refs/postgres-store";
import { type CommandResult, withPostgres } from "../../../db/pg-test-harness";
import { migrationSql } from "../read/pg-parity-matrix";

// narrator-service must be imported before narrator-persistence: the two form a
// module-init cycle and narrator-service binds persistence methods at evaluation.
await import("../../../../server/services/narrator-service");
const { createPgPlacedMessageMaterializer } = await import(
	"../../../../server/services/narrator-persistence"
);

const now = "2026-10-01T00:00:00.000Z";
const OWNER = { token: "tk-placement", epoch: "epoch-placement" };

function placedMessage(
	row: PgMailboxRow,
	overrides: Partial<RefMessageInput> = {},
): RefMessageInput {
	if (!row.recipientMessageId) throw new Error("fixture: claim row has no reserved identity");
	return {
		id: row.recipientMessageId,
		narratorId: row.narratorId,
		role: "user",
		contentJson: [{ type: "text", text: row.text }],
		contentText: row.text,
		createdAt: now,
		...overrides,
	};
}

function claimOf(row: PgMailboxRow) {
	if (!row.claimToken || !row.claimEpoch) throw new Error("fixture: row is not claimed");
	return { id: row.id, narratorId: row.narratorId, token: row.claimToken, epoch: row.claimEpoch };
}

// Opt-in is explicitly skipped, never represented as PG evidence. PG_INTEGRATION=1 cannot skip.
const integration = process.env.PG_INTEGRATION === "1" ? test : test.skip;

integration(
	"PG17 placement journal: same-tx materialize, failure atomicity, duplicate, reserved identity, retry",
	async () => {
		const outcome = await withPostgres(async ({ exec, port, credentials }) => {
			for (const migration of await migrationSql()) {
				const applied = await exec(migration);
				expect(applied.code, applied.stderr).toBe(0);
			}
			const client = createPostgresClient({
				driver: "bun-sql",
				url: `postgres://${credentials.user}:${credentials.password}@127.0.0.1:${port}/${credentials.database}`,
				max: 8,
			});
			try {
				return await journal(client, exec);
			} catch (error) {
				// The harness reduces callback failures to "PostgreSQL callback failed";
				// keep the real assertion visible in the test output.
				console.error("placement journal failed:", error);
				throw error;
			} finally {
				await client.close();
			}
		});
		expect(outcome).toBe("verified");
	},
	300_000,
);

/** The full placement journal, run against the migrated throwaway database. */
async function journal(
	client: ReturnType<typeof createPostgresClient>,
	exec: (sql: string) => Promise<CommandResult>,
): Promise<string> {
	const [{ server_version: version }] = await client.sql.unsafe("SHOW server_version");
	expect(String(version).startsWith("17.")).toBe(true);
	await ensurePgFts(client.sql);
	// The onPersist hook's in-transaction effect is observed through a scratch
	// table; it vanishes with the container like everything else.
	const scratch = await exec(
		"CREATE TABLE placement_marks (id text PRIMARY KEY, ref_id text NOT NULL)",
	);
	expect(scratch.code, scratch.stderr).toBe(0);
	const store = createPostgresNarratorMessageRefsPort(client.db);
	const queue = createPostgresRuntimeQueue(client.db);
	const readiness = await queue.activateLegacyAdmission();
	expect(readiness.legacyAdmission).toBe("available");

	const ids = [
		"pgm-host",
		"pgm-parent",
		"pgm-child",
		"pgm-m-fail",
		"pgm-r-fail",
		"pgm-h-fail",
		"pgm-guard",
		"pgm-conflict",
		"pgm-helper",
		"pgm-retry-40001",
		"pgm-retry-40P01",
	];
	await client.db
		.insert(narrators)
		.values(ids.map((id) => ({ id, createdAt: now, updatedAt: now })));

	const narratorState = async (id: string) => {
		const [row] = await client.db
			.select({
				next: narrators.nextSeq,
				count: narrators.messageCount,
				version: narrators.messageVersion,
				structure: narrators.messageStructureVersion,
			})
			.from(narrators)
			.where(eq(narrators.id, id));
		return row;
	};
	const mailboxState = async (id: string) => {
		const [row] = await client.db
			.select({
				state: narratorBufferedMessages.state,
				claimToken: narratorBufferedMessages.claimToken,
				recipientRefId: narratorBufferedMessages.recipientRefId,
				currentMessageId: narratorBufferedMessages.currentMessageId,
			})
			.from(narratorBufferedMessages)
			.where(eq(narratorBufferedMessages.id, id));
		return row;
	};
	const enqueueAndClaim = async (narratorId: string, requestKey: string, text: string) => {
		const enqueued = await queue.mailbox.enqueue({
			kind: "user_input",
			narratorId,
			requestKey,
			text,
			projectedByteSize: Buffer.byteLength(text),
		});
		expect(enqueued.status).toBe("accepted");
		const row = await queue.mailbox.claimEligibleHead(narratorId, OWNER);
		expect(row).toBeDefined();
		if (!row) throw new Error("claim failed");
		return row;
	};

	// Lock-order proof: an append holding a-parent must not find z-child already
	// held by materialize. Observe an actual PG lock wait, then probe via a third connection.
	await client.db
		.insert(narrators)
		.values(
			["a-parent", "z-child", "z-extra"].map((id) => ({ id, createdAt: now, updatedAt: now })),
		);
	const lockRoot = await store.append({
		id: "lock-root",
		narratorId: "a-parent",
		role: "assistant",
		contentJson: [],
		createdAt: now,
	});
	await client.db.insert(narratorToolCalls).values({
		id: "lock-call",
		narratorId: "a-parent",
		messageId: lockRoot.id,
		toolUseId: "lock-tool",
		toolName: "Agent",
		createdAt: now,
	});
	const lockRow = await enqueueAndClaim("z-child", "lock-order", "locked placement");
	const held = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	const append = client.db.transaction(async (tx) => {
		await tx
			.select({ id: narrators.id })
			.from(narrators)
			.where(eq(narrators.id, "a-parent"))
			.for("update");
		held.resolve();
		await release.promise;
		return persistPgMessageWithRef(tx, {
			id: "lock-append",
			narratorId: "z-child",
			parentToolUseId: "lock-tool",
			role: "assistant",
			contentJson: [],
			createdAt: now,
		});
	});
	await held.promise;
	const planned = Promise.withResolvers<number>();
	const materializer = createPgPlacedMessageMaterializer(
		placedMessage(lockRow, { parentToolUseId: "lock-tool" }),
		{ narratorIds: ["z-extra", "z-child", "a-parent", "z-extra"] },
	);
	const plan = materializer.planNarratorLocks;
	if (!plan) throw new Error("Placement factory must declare narrator dependencies");
	materializer.planNarratorLocks = async (tx, claim) => {
		const result = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
		const ids = await plan(tx, claim);
		planned.resolve(Number(result[0].pid));
		return ids;
	};
	const placement = queue.mailbox.materialize(claimOf(lockRow), materializer);
	try {
		const pid = await planned.promise;
		let waiting = false;
		const deadline = Date.now() + 1000;
		while (!waiting && Date.now() < deadline) {
			const rows = await client.sql.unsafe(
				"SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",
				[pid],
			);
			waiting = rows[0]?.wait_event_type === "Lock";
			if (!waiting) await Bun.sleep(5);
		}
		expect(waiting).toBe(true);
		await client.db.transaction(async (tx) => {
			const rows = await tx
				.select({ id: narrators.id })
				.from(narrators)
				.where(eq(narrators.id, "z-child"))
				.for("update", { noWait: true });
			expect(rows).toHaveLength(1);
		});
	} finally {
		release.resolve();
		await Promise.all([append, placement]);
	}

	// An undeclared callback cannot expand locks during refs writes: roll back all effects.
	const undeclared = await enqueueAndClaim("z-child", "undeclared", "rejected dependency");
	const undeclaredMessage = placedMessage(undeclared, { parentToolUseId: "lock-tool" });
	await expect(
		queue.mailbox.materialize(claimOf(undeclared), async (tx) => {
			const persisted = await persistPgMessageWithRef(tx, undeclaredMessage);
			return { messageId: persisted.messageId, refId: persisted.refId };
		}),
	).rejects.toThrow("Undeclared narrator lock dependency");
	expect((await mailboxState(undeclared.id)).state).toBe("claimed");
	expect(
		await client.db
			.select()
			.from(narratorMessages)
			.where(eq(narratorMessages.id, undeclaredMessage.id)),
	).toHaveLength(0);

	// Claim may change after read-only planning: state/token/epoch recheck remains authoritative.
	const stale = await enqueueAndClaim("z-child", "stale-plan", "stale plan");
	const staleMaterializer = createPgPlacedMessageMaterializer(placedMessage(stale));
	const stalePlan = staleMaterializer.planNarratorLocks;
	if (!stalePlan || !stale.recipientMessageId) throw new Error("Incomplete stale claim fixture");
	staleMaterializer.planNarratorLocks = async (tx, claim) => {
		const ids = await stalePlan(tx, claim);
		await client.db
			.update(narratorBufferedMessages)
			.set({ claimToken: "replacement-token" })
			.where(eq(narratorBufferedMessages.id, stale.id));
		return ids;
	};
	await expect(queue.mailbox.materialize(claimOf(stale), staleMaterializer)).rejects.toThrow(
		"Stale mailbox claim",
	);
	expect(
		await client.db
			.select()
			.from(narratorMessages)
			.where(eq(narratorMessages.id, stale.recipientMessageId)),
	).toHaveLength(0);

	// Reverse lexical IDs still prelock both parent and recipient, including hook dependencies.
	const reverseRoot = await store.append({
		id: "reverse-root",
		narratorId: "z-extra",
		role: "assistant",
		contentJson: [],
		createdAt: now,
	});
	await client.db.insert(narratorToolCalls).values({
		id: "reverse-call",
		narratorId: "z-extra",
		messageId: reverseRoot.id,
		toolUseId: "reverse-tool",
		toolName: "Agent",
		createdAt: now,
	});
	const reverse = await enqueueAndClaim("a-parent", "reverse-placement", "reverse placement");
	const reverseBefore = await narratorState("z-extra");
	await queue.mailbox.materialize(
		claimOf(reverse),
		createPgPlacedMessageMaterializer(placedMessage(reverse, { parentToolUseId: "reverse-tool" }), {
			narratorIds: ["z-child", "z-child", "a-parent"],
			onPersist: async (tx) => {
				// This nested refs helper may touch only the factory's predeclared union.
				await persistPgMessageWithRef(tx, {
					id: "hook-predeclared",
					narratorId: "z-child",
					parentToolUseId: "reverse-tool",
					role: "disp",
					contentJson: [],
					createdAt: now,
				});
			},
		}),
	);
	expect((await narratorState("z-extra")).version).toBe(reverseBefore.version + 2);
	expect((await mailboxState(reverse.id)).state).toBe("materialized");

	// ── 1. Same-transaction materialize: message + ref + hook + mailbox flip ──
	const parentRoot = await store.append({
		id: "pgm-parent-root",
		narratorId: "pgm-parent",
		role: "assistant",
		contentJson: [{ type: "text", text: "parent root" }],
		contentText: "parent root",
		createdAt: now,
	});
	await client.db.insert(narratorToolCalls).values({
		id: "pgm-tc-1",
		narratorId: "pgm-parent",
		messageId: parentRoot.id,
		toolUseId: "pgm-tool-use-1",
		toolName: "Task",
		createdAt: now,
	});
	const parentBefore = await narratorState("pgm-parent");
	const hostRow = await enqueueAndClaim("pgm-host", "rk-host-1", "searchable-placed-host");
	const materialized = await queue.mailbox.materialize(
		claimOf(hostRow),
		createPgPlacedMessageMaterializer(
			placedMessage(hostRow, { parentToolUseId: "pgm-tool-use-1" }),
			{
				onPersist: async (tx, messageId, refId) => {
					await tx.execute(
						sql`INSERT INTO placement_marks (id, ref_id) VALUES (${messageId}, ${refId})`,
					);
				},
			},
		),
	);
	expect(materialized.state).toBe("materialized");
	expect(materialized.currentMessageId).toBe(hostRow.recipientMessageId);
	expect(materialized.recipientRefId).not.toBeNull();
	const hostReserved = hostRow.recipientMessageId;
	if (!hostReserved) throw new Error("fixture: claim row has no reserved identity");
	const hostRefs = await store.page("pgm-host");
	expect(hostRefs.rows.map((row) => row.messageId)).toEqual([hostReserved]);
	expect(hostRefs.rows[0]?.seq).toBe(0);
	expect(await narratorState("pgm-host")).toEqual({
		next: 1,
		count: 1,
		version: 1,
		structure: 0,
	});
	// The parent row is bumped in the SAME section: the tool card it renders
	// changes when a child row lands under its tool_use.
	expect((await narratorState("pgm-parent"))?.version).toBe((parentBefore?.version ?? 0) + 1);
	// The hook committed with the message: its mark carries the REAL ref id.
	const marks = await client.sql.unsafe(
		`SELECT pm.ref_id AS ref_id FROM placement_marks pm WHERE pm.id = '${hostReserved}'`,
	);
	expect(marks.map((mark: Record<string, unknown>) => mark.ref_id)).toEqual([
		materialized.recipientRefId,
	]);
	const fts = await client.sql.unsafe(
		"SELECT id FROM search_narrator_messages WHERE content_text ILIKE '%searchable-placed-host%' LIMIT 2",
	);
	expect(fts).toHaveLength(1);

	// ── 2. Duplicate: consumed claim rejects, replayed enqueue dedupes ──
	await expect(
		queue.mailbox.materialize(
			claimOf(hostRow),
			createPgPlacedMessageMaterializer(placedMessage(hostRow)),
		),
	).rejects.toThrow("Stale mailbox claim");
	expect((await store.page("pgm-host")).rows).toHaveLength(1);
	const replayed = await queue.mailbox.enqueue({
		kind: "user_input",
		narratorId: "pgm-host",
		requestKey: "rk-host-1",
		text: "searchable-placed-host",
		projectedByteSize: Buffer.byteLength("searchable-placed-host"),
	});
	expect(replayed.status).toBe("duplicate");
	expect(await narratorState("pgm-host")).toEqual({
		next: 1,
		count: 1,
		version: 1,
		structure: 0,
	});

	// ── 3. Failure atomicity: message insert, ref insert, hook throw ──
	// Test-only failure injection, confined to the throwaway database.
	await client.sql.unsafe(
		"CREATE FUNCTION reject_placement_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.narrator_id = 'pgm-m-fail' AND TG_TABLE_NAME = 'narrator_messages' THEN PERFORM pg_sleep(0.025); RAISE EXCEPTION 'message fixture rejected' USING ERRCODE = '23514'; ELSIF NEW.narrator_id = 'pgm-r-fail' AND TG_TABLE_NAME = 'narrator_message_refs' THEN PERFORM pg_sleep(0.025); RAISE EXCEPTION 'ref fixture rejected' USING ERRCODE = '23514'; END IF; RETURN NEW; END $$",
	);
	await client.sql.unsafe(
		"CREATE TRIGGER reject_placement_message BEFORE INSERT ON narrator_messages FOR EACH ROW EXECUTE FUNCTION reject_placement_fixture()",
	);
	await client.sql.unsafe(
		"CREATE TRIGGER reject_placement_ref BEFORE INSERT ON narrator_message_refs FOR EACH ROW EXECUTE FUNCTION reject_placement_fixture()",
	);
	// The trigger's RAISE text rides the driver error's cause chain; drizzle's own
	// "Failed query" wrapper is what `.rejects` would see on the surface.
	const causeChain = (error: unknown): string => {
		let text = "";
		for (let current = error; current; current = (current as { cause?: unknown }).cause) {
			text += current instanceof Error ? `${current.message}\n` : `${String(current)}\n`;
		}
		return text;
	};
	const messageFailRow = await enqueueAndClaim("pgm-m-fail", "rk-m-fail", "doomed-message");
	const messageFailure = await queue.mailbox
		.materialize(
			claimOf(messageFailRow),
			createPgPlacedMessageMaterializer(placedMessage(messageFailRow)),
		)
		.catch((error: unknown) => error);
	expect(messageFailure).toBeInstanceOf(Error);
	expect(causeChain(messageFailure)).toContain("message fixture rejected");
	const refFailRow = await enqueueAndClaim("pgm-r-fail", "rk-r-fail", "doomed-ref");
	const refFailure = await queue.mailbox
		.materialize(claimOf(refFailRow), createPgPlacedMessageMaterializer(placedMessage(refFailRow)))
		.catch((error: unknown) => error);
	expect(refFailure).toBeInstanceOf(Error);
	expect(causeChain(refFailure)).toContain("ref fixture rejected");
	const hookFailRow = await enqueueAndClaim("pgm-h-fail", "rk-h-fail", "doomed-hook");
	await expect(
		queue.mailbox.materialize(
			claimOf(hookFailRow),
			createPgPlacedMessageMaterializer(placedMessage(hookFailRow), {
				onPersist: () => {
					throw new Error("hook fixture rejected");
				},
			}),
		),
	).rejects.toThrow("hook fixture rejected");
	for (const [narratorId, row] of [
		["pgm-m-fail", messageFailRow],
		["pgm-r-fail", refFailRow],
		["pgm-h-fail", hookFailRow],
	] as const) {
		// Nothing committed: no message, no ref, no counters, no FTS row, and the
		// claim was never consumed — the SAME owner still holds it.
		expect(await narratorState(narratorId)).toEqual({
			next: 0,
			count: 0,
			version: 0,
			structure: 0,
		});
		expect((await store.page(narratorId)).rows).toHaveLength(0);
		expect(
			await client.db
				.select({ id: narratorMessages.id })
				.from(narratorMessages)
				.where(eq(narratorMessages.narratorId, narratorId)),
		).toHaveLength(0);
		const box = await mailboxState(row.id);
		expect(box?.state).toBe("claimed");
		expect(box?.claimToken).toBe(OWNER.token);
	}
	expect(
		await client.sql.unsafe(
			"SELECT id FROM search_narrator_messages WHERE content_text ILIKE '%doomed-%' LIMIT 3",
		),
	).toHaveLength(0);
	const [markCount] = await client.sql.unsafe("SELECT count(*)::int AS n FROM placement_marks");
	expect(Number((markCount as Record<string, unknown>).n)).toBe(1);
	await client.sql.unsafe("DROP TRIGGER reject_placement_message ON narrator_messages");
	await client.sql.unsafe("DROP TRIGGER reject_placement_ref ON narrator_message_refs");
	// The rejected narrators recover cleanly once the fixture is gone: the
	// rolled-back seq claim is re-issued from 0.
	const recovered = await queue.mailbox.materialize(
		claimOf(refFailRow),
		createPgPlacedMessageMaterializer(placedMessage(refFailRow)),
	);
	expect(recovered.state).toBe("materialized");
	expect((await store.page("pgm-r-fail")).rows[0]?.seq).toBe(0);

	// ── 4. Reserved identity: enforced, and a committed collision is 23505 ──
	const guardRow = await enqueueAndClaim("pgm-guard", "rk-guard", "guard");
	await expect(
		queue.mailbox.materialize(
			claimOf(guardRow),
			createPgPlacedMessageMaterializer(placedMessage(guardRow, { narratorId: "pgm-host" })),
		),
	).rejects.toThrow("Mailbox recipient mismatch");
	await expect(
		queue.mailbox.materialize(
			claimOf(guardRow),
			createPgPlacedMessageMaterializer(placedMessage(guardRow, { id: "pgm-not-reserved" })),
		),
	).rejects.toThrow("reserved recipient identity");
	expect((await mailboxState(guardRow.id))?.state).toBe("claimed");

	const conflictRow = await enqueueAndClaim("pgm-conflict", "rk-conflict", "conflict");
	// Another path commits the reserved message identity first (e.g. an
	// already-materialized attempt whose acknowledgement was lost): the
	// materialize must surface the conflict, never retry it away.
	if (!conflictRow.recipientMessageId) throw new Error("fixture: no reserved identity");
	await store.append({
		id: conflictRow.recipientMessageId,
		narratorId: "pgm-host",
		role: "user",
		contentJson: [{ type: "text", text: "already committed" }],
		contentText: "already committed",
		createdAt: now,
	});
	await expect(
		queue.mailbox.materialize(
			claimOf(conflictRow),
			createPgPlacedMessageMaterializer(placedMessage(conflictRow)),
		),
	).rejects.toBeInstanceOf(WriteConflictError);
	expect(await narratorState("pgm-conflict")).toEqual({
		next: 0,
		count: 0,
		version: 0,
		structure: 0,
	});
	expect((await mailboxState(conflictRow.id))?.state).toBe("claimed");
	// The pre-existing message is untouched and the conflict narrator gained no ref.
	expect((await store.page("pgm-conflict")).rows).toHaveLength(0);

	// ── 5. Whole-section retry on 40001/40P01 ──
	// SQLSTATE injected only in this disposable database, AFTER the message
	// insert and an awaited server delay. nextval is deliberately
	// nontransactional evidence of how many times the section ran.
	await client.sql.unsafe("CREATE SEQUENCE placement_retry_attempts");
	await client.sql.unsafe(
		"CREATE FUNCTION retry_placement_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.narrator_id = TG_ARGV[0] AND nextval('placement_retry_attempts') = 1 THEN PERFORM pg_sleep(0.025); RAISE EXCEPTION 'retry fixture' USING ERRCODE = TG_ARGV[1]; END IF; RETURN NEW; END $$",
	);
	for (const code of ["40001", "40P01"] as const) {
		const target = `pgm-retry-${code}`;
		await client.sql.unsafe("ALTER SEQUENCE placement_retry_attempts RESTART WITH 1");
		await client.sql.unsafe(
			`CREATE TRIGGER retry_placement_fixture BEFORE INSERT ON narrator_message_refs FOR EACH ROW EXECUTE FUNCTION retry_placement_fixture('${target}', '${code}')`,
		);
		const retryRow = await enqueueAndClaim(target, `rk-${target}`, `retry-${code}`);
		const result = await queue.mailbox.materialize(
			claimOf(retryRow),
			createPgPlacedMessageMaterializer(placedMessage(retryRow)),
		);
		expect(result.state).toBe("materialized");
		const rows = await store.page(target);
		expect(rows.rows).toHaveLength(1);
		expect(rows.rows[0]?.seq).toBe(0);
		expect(await narratorState(target)).toEqual({
			next: 1,
			count: 1,
			version: 1,
			structure: 0,
		});
		const [attempts] = await client.sql.unsafe(
			"SELECT last_value::int AS value FROM placement_retry_attempts",
		);
		expect(attempts.value).toBe(2);
		expect(
			await client.db
				.select({ id: narratorMessages.id })
				.from(narratorMessages)
				.where(eq(narratorMessages.narratorId, target)),
		).toHaveLength(1);
		await client.sql.unsafe("DROP TRIGGER retry_placement_fixture ON narrator_message_refs");
	}

	// ── 6. The named helper standalone: identities out, budget enforced ──
	const direct = await client.db.transaction(async (tx) =>
		persistPgMessageWithRef(tx, {
			id: "pgm-helper-direct",
			narratorId: "pgm-helper",
			role: "sys",
			contentJson: [{ type: "text", text: "helper direct" }],
			contentText: "helper direct",
			createdAt: now,
		}),
	);
	expect(direct.messageId).toBe("pgm-helper-direct");
	expect(direct.seq).toBe(0);
	expect(direct.message.id).toBe("pgm-helper-direct");
	const [directRef] = await client.db
		.select({ id: narratorMessageRefs.id })
		.from(narratorMessageRefs)
		.where(eq(narratorMessageRefs.messageId, "pgm-helper-direct"));
	expect(directRef?.id).toBe(direct.refId);
	const oversized = "x".repeat(3 * 1024 * 1024);
	await expect(
		client.db.transaction(async (tx) =>
			persistPgMessageWithRef(tx, {
				id: "pgm-helper-oversized",
				narratorId: "pgm-helper",
				role: "user",
				contentJson: [{ type: "text", text: oversized }],
				contentText: oversized,
				createdAt: now,
			}),
		),
	).rejects.toThrow("write budget");
	expect(await narratorState("pgm-helper")).toEqual({
		next: 1,
		count: 1,
		version: 1,
		structure: 0,
	});
	return "verified";
}
