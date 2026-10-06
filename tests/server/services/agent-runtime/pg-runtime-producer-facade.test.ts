/**
 * Phase-2 producer-half proof: the mailbox producer facades run on the REAL
 * PostgreSQL 17 runtime queue, against the complete committed `drizzle-postgres`
 * journal, with the SQLite handles poisoned.
 *
 * WHAT THIS SUITE PROVES
 * ----------------------
 * Driven through the PUBLIC facades (not the adapter directly):
 *
 *   - `enqueueInboxAgent` (Send) — accept, duplicate replay, stale execution
 *     receipt rejection, queue capacity rejection — all via the ONE named PG
 *     admission operation (`mailbox.admitAgentMessage`);
 *   - `deliverTeamMessage` / `drainTeamInbox` (TeamStatus) — accept + projection
 *     fields over `listPending` rows;
 *   - `pushPendingInjection` / `drainPendingInjections` / `hasPendingInjections`
 *     (parent channel) — accept + read-only projection;
 *   - `peekInbox` / `hasInboxKind` / `listInboxRows` — PG read projections;
 *   - `markAgentMessageConsumed` + `track/consumeAgentMessageHistory` — the PG ack
 *     composite (`mailbox.recordDeliveryConsumption`) flips mailbox/refs/narrators
 *     in one section and returns the broadcast facts;
 *   - `narrator-buffer` writes (`enqueueBufferedMessage` front/back/FIFO,
 *     `updateBufferedMessage` incl. payloadRef, `removeBufferedMessage`,
 *     `reorderBufferedMessages`, `retryBufferedMessage`, `clearBufferedMessages`)
 *     against the named PG port operations.
 *
 * The SQLite `db`/`sqlite` exports are POISONED for the whole exercise: any touch
 * fails the suite (`sqliteTouches === 0`). Two explicitly out-of-scope consumers
 * are stubbed and SAY so: the publication module (stage-4 producer wiring) so the
 * post-accept wake's outbox flush cannot run, and `send-delivery-resolution`'s WS
 * broadcast (post-commit side effect). `projectPendingInjection`'s task_notice
 * branch reads backgroundTasks/narratorMessages — an unmigrated domain, NOT
 * exercised here (fail-closed boundary, listed in the phase report).
 *
 * Rules, same as the other PG suites: `PG_INTEGRATION=1` means PostgreSQL really
 * has to run (a blocked harness is a failure, never a quiet pass); the container is
 * the harness' own random name and only it is cleaned up.
 */
import { afterAll, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { createPostgresClient } from "../../../../server/db/postgres-client";
import {
	narratorBufferedMessages as pgMailbox,
	narratorMessages as pgMessages,
	narrators as pgNarrators,
	narratorMessageRefs as pgRefs,
	narratorToolCalls as pgToolCalls,
} from "../../../../server/db/postgres-schema";
import { withPostgres } from "../../../db/pg-test-harness";
import { getTestDb } from "../../../setup";

const PG_ENABLED = process.env.PG_INTEGRATION === "1";

/** Narrow a fixture value that must exist; absence is a test bug, not an assertion. */
function required<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("Missing test fixture value");
	return value;
}
const RUN_TIMEOUT_MS = 300_000;
const OLD = "2026-01-01T00:00:00.000Z";

// Poison both SQLite exports for the whole producer exercise. Even a swallowed read
// increments the counter: empty tables alone cannot prove zero reads.
const { db: sqliteDb, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../../../server/db")) };
let sqliteTouches = 0;
function poisonHandle<T extends object>(handle: T): T {
	return new Proxy(handle, {
		get(): never {
			sqliteTouches += 1;
			throw new Error("P2 producer facade unexpectedly accessed SQLite");
		},
	});
}
mock.module("../../../../server/db", () => ({
	...realDbModule,
	db: poisonHandle(sqliteDb),
	sqlite: poisonHandle(sqlite),
}));
// The wake's publication flush is stage-4 wiring; the whole publication module is
// stubbed (its REAL module body touches the poisoned SQLite handle at import time —
// that is the documented stage-4 boundary, not something this suite may fix).
// `setRuntimePublicationWake` is a recording stub: it proves inbox.ts still performs
// its module-level facade registration without running the SQLite-backed worker.
let registeredWake: unknown;
mock.module("../../../../server/services/agent-runtime/publication", () => ({
	PUBLICATION_FALLBACK_BYTES: 64 * 1024,
	publicationEvent: (status: string) =>
		status === "timeout" || status === "timed out" || status === "timed_out"
			? "timed_out"
			: status === "cancelled"
				? "cancelled"
				: status === "started" || status === "running"
					? "started"
					: status === "completed"
						? "completed"
						: "failed",
	publicationSummary: (text: string) => text.slice(0, 600),
	isRuntimePublicationUnavailableError: () => false,
	createRuntimePublicationService: () => {
		throw new Error("stage-4 boundary: no SQLite publication service in this suite");
	},
	getRuntimePublicationService: () => ({
		backend: "postgres",
	}),
	createUnwiredPublicationFacade: () => {
		throw new Error("stage-4 boundary: no publication facade in this suite");
	},
	runtimePublication: new Proxy(
		{},
		{
			// Absorb every stage-4 method call made at module-init time (e.g.
			// background-task-service registering its legacy admission reader).
			get: () => () => {},
		},
	),
	workerLifecycle: { stop: () => {} },
	flushRuntimePublications: () => {},
	setLegacyCompletionAdmissionReader: () => {},
	migrateLegacyTaskNotice: () => "migrated",
	setRuntimePublicationWake: (handler: unknown) => {
		registeredWake = handler;
	},
	taskPublicationRun: () => {
		throw new Error("stage-4 boundary");
	},
}));
// Post-commit WS broadcast: a recording spy over the REAL module (its other exports
// are used across the import graph; the module body itself performs no database I/O).
const broadcasts: unknown[][] = [];
const realSendResolution = {
	...(await import("../../../../server/services/send-delivery-resolution")),
};
mock.module("../../../../server/services/send-delivery-resolution", () => ({
	...realSendResolution,
	broadcastSendDeliveryResolved: (...args: unknown[]) => {
		broadcasts.push(args);
		return Promise.resolve();
	},
}));
const ws = { ...(await import("../../../../server/websocket/narrator-ws")) };
mock.module("../../../../server/websocket/narrator-ws", () => ({
	...ws,
	broadcastToNarrator: () => {},
}));

const { createPostgresRuntimeQueue, setPostgresRuntimeQueue } = await import(
	"../../../../server/services/agent-runtime/postgres-runtime-queue"
);
const inbox = await import("../../../../server/services/agent-runtime/inbox");
const { createAgentMessageDelivery, consumeAgentMessageHistory, trackAgentMessageHistory } =
	await import("../../../../server/services/agent-message-delivery");
const { deliverTeamMessage, drainTeamInbox } = await import(
	"../../../../server/services/subagent-team"
);
const { pushPendingInjection, drainPendingInjections, hasPendingInjections } = await import(
	"../../../../server/services/parent-injection-queue"
);
const buffer = await import("../../../../server/services/narrator-buffer");
const ownership = await import("../../../../server/services/agent-runtime/ownership");
const { markAgentMessageConsumed } = await import(
	"../../../../server/services/agent-message-delivery"
);

afterAll(() => {
	setPostgresRuntimeQueue(undefined);
	mock.restore();
	sqlite.close();
});

test.skipIf(!PG_ENABLED)(
	"producer facades on the formal PG17 journal: Send/TeamStatus/duplicate/receipt/ack/capacity/edit/cancel, SQLite untouched",
	async () => {
		const outcome = await withPostgres(async ({ port, credentials }) => {
			const client = createPostgresClient({
				driver: "bun-sql",
				url: `postgres://${credentials.user}:${credentials.password}@127.0.0.1:${port}/${credentials.database}`,
				max: 8,
				connectTimeout: 10,
			});
			let owner: { release(): void } | null = null;
			try {
				const db = client.db;
				await migrate(db, { migrationsFolder: "drizzle-postgres" });
				const journal = readMigrationFiles({ migrationsFolder: "drizzle-postgres" });
				const ledger = await client.sql.unsafe(
					"SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at",
				);
				expect(ledger.map((r: { hash: string }) => r.hash)).toEqual(
					journal.map((entry) => entry.hash),
				);

				// Fixtures: three narrators and a sender Send receipt factory.
				for (const [id, variant, parent] of [
					["parent", "primary", null],
					["child", "subagent:general", "parent"],
					["sender", "subagent:general", "parent"],
				] as const)
					await db.insert(pgNarrators).values({
						id,
						variant,
						parentNarratorId: parent,
						createdAt: OLD,
						updatedAt: OLD,
					});
				let serial = 0;
				const sendDelivery = async (recipient: string, text: string) => {
					const id = `src-${++serial}`;
					await db.insert(pgMessages).values({
						id,
						narratorId: "sender",
						role: "assistant",
						contentJson: [],
						createdAt: OLD,
					});
					await db.insert(pgToolCalls).values({
						id: `${id}-tool`,
						narratorId: "sender",
						messageId: id,
						toolUseId: `${id}-use`,
						toolName: "Send",
						executionAttempt: 1,
						executionIdentityVersion: 1,
						executionStartedAt: OLD,
						createdAt: OLD,
					});
					return createAgentMessageDelivery(
						recipient,
						{ id: "sender", title: "Sender", label: "sender", type: "general", isParent: false },
						`${id}-use`,
						text,
						{ toolCallId: `${id}-tool`, attempt: 1 },
					);
				};

				const queue = createPostgresRuntimeQueue(db);
				await queue.activateLegacyAdmission({ timeoutMs: 60_000 });
				setPostgresRuntimeQueue(queue);

				// ── Send admission: accept, then idempotent duplicate, then stale receipt ──
				const first = await sendDelivery("child", "first hello");
				const accepted = await inbox.enqueueInboxAgent(first, first.text);
				expect(accepted.status).toBe("accepted");
				expect(accepted.delivery.text).toBe("first hello");
				expect(first.deliveryId).toBe(accepted.delivery.deliveryId ?? undefined);
				const replay = await sendDelivery("child", "first hello");
				// Same execution receipt identity (same toolCallId+attempt) replays as duplicate.
				replay.senderToolCallBinding = first.senderToolCallBinding;
				replay.fromToolUseId = first.fromToolUseId;
				const duplicate = await inbox.enqueueInboxAgent(replay, replay.text);
				expect(duplicate.status).toBe("duplicate");
				expect(duplicate.delivery.id).toBe(accepted.delivery.id);
				expect(replay.deliveryId).toBe(first.deliveryId);
				const stale = await sendDelivery("child", "stale");
				stale.senderToolCallBinding = {
					toolCallId: required(first.senderToolCallBinding).toolCallId,
					attempt: 2,
				};
				const staleError = await inbox.enqueueInboxAgent(stale, stale.text).then(
					() => null,
					(error: unknown) => error,
				);
				expect(String(staleError)).toContain("execution receipt is stale or missing");
				// A delivery WITHOUT an execution receipt never reaches the queue.
				const unbound = await sendDelivery("child", "unbound");
				unbound.senderToolCallBinding = undefined;
				const unboundError = await inbox.enqueueInboxAgent(unbound, unbound.text).then(
					() => null,
					(error: unknown) => error,
				);
				expect(String(unboundError)).toContain("requires exact tool execution receipt");

				// ── Read projections support the consumers' fields ──
				expect(await inbox.hasInboxKind("child", ["agent_message"])).toBe(true);
				expect(await inbox.hasInboxKind("child", ["user_input"])).toBe(false);
				const peeked = await inbox.peekInbox("child");
				expect(peeked?.id).toBe(accepted.delivery.id);
				expect(peeked?.claimToken).toBeNull();
				const listed = await inbox.listInboxRows("child", ["agent_message"]);
				expect(listed).toHaveLength(1);
				const row = required(listed[0]);
				expect(row.text).toBe("first hello");
				expect(row.deliveryId).toBe(required(first.deliveryId));
				expect(row.metadataJson).toContain('"channel":"buffer"');
				const projected = inbox.inboxDelivery(row);
				expect(projected.sender.id).toBe("sender");
				expect(inbox.inboxAgentText(row)).toBe("first hello");

				// ── TeamStatus producer path (deliverTeamMessage → drainTeamInbox) ──
				// An execution owner makes the post-accept wake decline without any read.
				owner = ownership.tryClaimExecution("child", "tool-replay");
				expect(owner).toBeTruthy();
				const teamDelivery = await sendDelivery("child", "team note");
				const teamMessageId = await deliverTeamMessage(
					"child",
					{
						delivery: teamDelivery,
						fromId: "sender",
						fromTitle: "Sender",
						fromLabel: "sender",
						fromType: "general",
						fromToolUseId: teamDelivery.fromToolUseId,
						fromToolCallBinding: teamDelivery.senderToolCallBinding,
						text: "team note",
						timestamp: OLD,
						isBroadcast: false,
					},
					"parent",
				);
				expect(typeof teamMessageId).toBe("string");
				const teamRows = await drainTeamInbox("child");
				const teamEntry = teamRows.find((entry) => entry.text === "team note");
				expect(teamEntry?.fromId).toBe("sender");
				expect(teamEntry?.delivery?.recipientMessageId).toBe(teamMessageId);

				// ── Parent channel (pushPendingInjection → drainPendingInjections) ──
				const parentDelivery = await sendDelivery("parent", "report to parent");
				await pushPendingInjection("parent", {
					kind: "subagent_message",
					message: {
						delivery: parentDelivery,
						fromId: "sender",
						fromTitle: "Sender",
						fromLabel: "sender",
						fromType: "general",
						fromToolUseId: parentDelivery.fromToolUseId,
						text: "report to parent",
						timestamp: OLD,
					},
				});
				expect(await hasPendingInjections("parent")).toBe(true);
				const pending = await drainPendingInjections("parent");
				expect(pending).toHaveLength(1);
				const pendingEntry = required(pending[0]);
				if (pendingEntry.kind !== "subagent_message") throw new Error("wrong projection kind");
				expect(pendingEntry.message.text).toBe("report to parent");
				// Read-only projection: a second drain sees the same row.
				expect(await drainPendingInjections("parent")).toHaveLength(1);

				// ── Capacity: the 51st agent message is rejected, never silently evicted ──
				// ("child" already holds two queued agent messages: first + team note.)
				for (let index = 0; index < 48; index++) {
					const d = await sendDelivery("child", `flood ${index}`);
					expect((await inbox.enqueueInboxAgent(d, d.text)).status).toBe("accepted");
				}
				const overflow = await sendDelivery("child", "overflow");
				const overflowError = await inbox.enqueueInboxAgent(overflow, overflow.text).then(
					() => null,
					(error: unknown) => error,
				);
				expect(String(overflowError)).toContain("queue is full");

				// ── Materialize + consumption ack (one PG section, broadcast facts returned) ──
				const claimOwner = { token: "process:integration:ack", epoch: "epoch-ack" };
				const claimed = await queue.mailbox.claimEligibleHead("child", claimOwner);
				if (!claimed) throw new Error("expected a claimable head");
				const refId = `ref-${claimed.id}`;
				const materialized = await queue.mailbox.materialize(
					{ id: claimed.id, narratorId: "child", token: claimOwner.token, epoch: claimOwner.epoch },
					async (tx, row) => {
						await tx.insert(pgMessages).values({
							id: required(row.recipientMessageId),
							narratorId: "child",
							role: "user",
							contentText: "first hello",
							contentJson: [{ type: "text", text: "first hello" }],
							createdAt: OLD,
						});
						await tx.insert(pgRefs).values({
							id: refId,
							narratorId: "child",
							messageId: required(row.recipientMessageId),
							seq: 1,
						});
						return { messageId: required(row.recipientMessageId), refId };
					},
				);
				expect(materialized.state).toBe("materialized");
				const versionBefore = await db
					.select({ v: pgNarrators.messageVersion })
					.from(pgNarrators)
					.where(eq(pgNarrators.id, "sender"));
				await markAgentMessageConsumed({
					recipientNarratorId: "child",
					recipientMessageId: required(materialized.recipientMessageId),
					deliveryId: required(materialized.deliveryId),
					recipientRefId: refId,
					revision: materialized.contentRevision,
					senderNarratorId: "sender",
					fromToolUseId: first.fromToolUseId,
					senderToolCallBinding: first.senderToolCallBinding,
				});
				const acked = await queue.mailbox.getByDelivery(required(materialized.deliveryId));
				expect(acked?.adoptedRevision).toBe(materialized.contentRevision);
				expect(acked?.adoptedAt).toBeTruthy();
				const refAfter = await db
					.select({ consumed: pgRefs.injectionConsumedAt })
					.from(pgRefs)
					.where(eq(pgRefs.id, refId));
				expect(refAfter[0]?.consumed).not.toBeNull();
				const versionAfter = await db
					.select({ v: pgNarrators.messageVersion })
					.from(pgNarrators)
					.where(eq(pgNarrators.id, "sender"));
				expect(required(versionAfter[0]).v).toBe(required(versionBefore[0]).v + 1);
				// The sender resolution + broadcast facts survived commit.
				expect(broadcasts).toHaveLength(1);
				// Idempotent: a second ack of the same receipt stays a no-op success.
				await markAgentMessageConsumed({
					recipientNarratorId: "child",
					recipientMessageId: required(materialized.recipientMessageId),
					deliveryId: required(materialized.deliveryId),
					recipientRefId: refId,
					revision: materialized.contentRevision,
					senderNarratorId: "sender",
					fromToolUseId: first.fromToolUseId,
					senderToolCallBinding: first.senderToolCallBinding,
				});

				// ── History track/consume recovers the materialized receipt via the PG join ──
				const history: unknown[] = [];
				await trackAgentMessageHistory("child", history, [
					{
						id: required(materialized.currentMessageId),
						narratorId: "child",
						role: "user",
						contentJson: [{ type: "text", text: "first hello" }],
					},
				]);
				consumeAgentMessageHistory(history, "first hello");
				// track+consume only queue bookkeeping; the ack promise is not exposed here, so
				// assert through the already-proven direct path above and the zero-touch gate.

				// ── narrator-buffer writes against the PG port ──
				const bufA = await buffer.enqueueBufferedMessage("parent", "buf A");
				expect(bufA.ok).toBe(true);
				const bufB = await buffer.enqueueBufferedMessage(
					"parent",
					"buf B",
					undefined,
					null,
					null,
					null,
					undefined,
					"front",
				);
				const bufC = await buffer.enqueueBufferedMessage(
					"parent",
					"buf C",
					undefined,
					null,
					null,
					null,
					undefined,
					"front",
					undefined,
					undefined,
					"fifo",
				);
				// front stack (B) then FIFO front (C after B) then back (A).
				const order1 = (await queue.mailbox.listPending("parent", { kinds: ["user_input"] })).map(
					(r) => r.text,
				);
				expect(order1.slice(0, 3)).toEqual(["buf B", "buf C", "buf A"]);

				// Edit, including the payloadRef branch (body beyond the inline budget).
				const bigText = `big ${"x".repeat(300 * 1024)}`;
				const edited = await buffer.updateBufferedMessage("parent", bufA.id, bigText);
				expect(edited).toBe(true);
				const editedRow = await queue.mailbox.getById(bufA.id);
				expect(editedRow?.contentRevision).toBe(2);
				expect(editedRow?.text).toBe("");
				expect(editedRow?.payloadRefJson).toContain("buffered_file");
				expect(editedRow?.byteSize).toBe(Buffer.byteLength(bigText));

				// Reorder: full-set swap commits; a non-matching set refuses with NO writes.
				expect(await buffer.reorderBufferedMessages("parent", [bufC.id, bufA.id, bufB.id])).toBe(
					true,
				);
				const order2 = (await queue.mailbox.listPending("parent", { kinds: ["user_input"] })).map(
					(r) => r.id,
				);
				expect(order2.slice(0, 3)).toEqual([bufC.id, bufA.id, bufB.id]);
				expect(await buffer.reorderBufferedMessages("parent", [bufA.id, bufB.id])).toBe(false);
				const order3 = (await queue.mailbox.listPending("parent", { kinds: ["user_input"] })).map(
					(r) => r.id,
				);
				expect(order3.slice(0, 3)).toEqual([bufC.id, bufA.id, bufB.id]);

				// Retry a failed row.
				await db
					.update(pgMailbox)
					.set({ state: "failed", lastError: "boom" })
					.where(eq(pgMailbox.id, bufB.id));
				expect(await buffer.retryBufferedMessage("parent", bufB.id)).toBe(true);
				expect((await queue.mailbox.getById(bufB.id))?.state).toBe("queued");
				// Rejecting a retry of a non-failed row.
				expect(await buffer.retryBufferedMessage("parent", bufB.id)).toBe(false);

				// Remove one, clear the rest.
				expect(await buffer.removeBufferedMessage("parent", bufC.id)).toBe(true);
				const removed = await queue.mailbox.getById(bufC.id);
				expect(removed?.state).toBe("cancelled");
				expect(removed?.text).toBe("");
				await buffer.clearBufferedMessages("parent");
				const remaining = await queue.mailbox.listPending("parent", {
					kinds: ["user_input"],
					includeFailed: true,
				});
				expect(remaining).toHaveLength(0);

				// ── The poison gate: the whole exercise never touched SQLite ──
				expect(sqliteTouches).toBe(0);
				// inbox.ts registered its wake with the publication facade at module load.
				expect(typeof registeredWake).toBe("function");
				return { sqliteTouches };
			} catch (error) {
				// The harness collapses callback failures; carry the real one out.
				return { sqliteTouches, callbackError: String((error as Error)?.stack ?? error) };
			} finally {
				owner?.release();
				setPostgresRuntimeQueue(undefined);
				await client.close();
			}
		});
		// A harness status here means PostgreSQL did not actually run the suite. With
		// PG_INTEGRATION=1 that is a failure, never a skip.
		if ("status" in (outcome as Record<string, unknown>)) {
			throw new Error(
				`PostgreSQL integration required but harness returned ${JSON.stringify(outcome)}`,
			);
		}
		const result = outcome as { sqliteTouches: number; callbackError?: string };
		if (result.callbackError)
			throw new Error(`producer facade exercise failed:\n${result.callbackError}`);
		expect(result.sqliteTouches).toBe(0);
	},
	RUN_TIMEOUT_MS,
);
