/**
 * Phase-2 consumption-side proof against a real PostgreSQL 17 running the COMPLETE
 * production migration journal: the wired inbox consumer path
 * (`server/services/agent-runtime/inbox.ts`) drives enqueue → claim → persist
 * message/ref → materialize → ack through the bound PG queue and refs ports, while a
 * poisoned `server/db` mock proves zero SQLite touches.
 *
 * What is proven here (and what a pass means):
 *
 *   1. USER INPUT — `queue.mailbox.enqueue` → `claimInboxHead` →
 *      `materializeClaimedInboxUserMessage` (the `createPgPlacedMessageMaterializer`
 *      seam): message + ref + mailbox flip + counters commit in ONE section, and the
 *      adoption ack lands afterwards. `withInboxOwner` wraps the pass: the unwired
 *      publication facade's fail-closed flush is tolerated on PG, and the
 *      owner-terminated claim recovery runs at release.
 *   2. SEND (agent_message) — `enqueueInboxAgent` (PG admission: dedupe + execution
 *      receipt in one section), an exact duplicate replay returns the original
 *      receipt, then `deliverInboxInjection` materializes the reserved sys row
 *      through the queue's materialize section with the post-commit broadcast.
 *   3. FAIL/RETRY — `releaseInboxClaim` fails the live claim back to `queued` with
 *      the error recorded; the claim never stays `claimed`, and the SAME row is
 *      claimable again.
 *   4. COLD-START RECOVERY — `recoverInboxClaimsOnColdStartup` requeues
 *      foreign-process claims (and legacy unprefixed ones whose owner is gone) while
 *      leaving the current process's live claims alone.
 *   5. WAKE ELIGIBILITY — `wakeInboxIfEligible` reads routing/queue state only
 *      through named PG port operations: a mounted owner, an archived narrator and a
 *      started/cancelled-only notice queue all decline with ZERO SQLite touches, and
 *      the positive gate degrades to `false` through the narrator-buffer PG guard
 *      (the unmigrated start path fails closed rather than reaching SQLite).
 *
 * Rules, same as the sibling PG suites: `PG_INTEGRATION=1` means PostgreSQL really
 * has to run (a blocked harness is a failure, never a quiet pass); the container is
 * the harness' own random name and only it is cleaned up.
 */
import { afterAll, expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { ensurePgFts } from "../../../../server/db/pg-fts";
import { createPostgresClient } from "../../../../server/db/postgres-client";
import {
	narratorBufferedMessages,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../../../server/db/postgres-schema";

// ── SQLite poison ────────────────────────────────────────────────────────────
// The PG path must never reach the SQLite handles. `db`/`sqlite` are mocked with a
// proxy whose EVERY access throws; the hit counter doubles as the poison=0 evidence.
let poisonHits = 0;
const poison = <T>(handle: string): T =>
	new Proxy(
		{},
		{
			get: (_target, prop) => {
				poisonHits++;
				throw new Error(
					`SQLite handle "${handle}" touched on the PostgreSQL path (${String(prop)})`,
				);
			},
		},
	) as T;
mock.module("../../../../server/db", () => ({ db: poison("db"), sqlite: poison("sqlite") }));
// No WS server exists in this process; the broadcast is asserted via the recorded frames.
// The mock module mirrors the real module's export NAMES (scanned from source) so every
// named import in the lazily-loaded graph links, without pulling the real module (its
// graph starts pollers and reaches the database handle).
const broadcasts: unknown[] = [];
const narratorWsSource = await readFile(
	join(import.meta.dir, "../../../../server/websocket/narrator-ws.ts"),
	"utf8",
);
const narratorWsExports = new Set(
	[
		...narratorWsSource.matchAll(
			/export (?:async )?(?:function|const|class|interface|type) (\w+)/g,
		),
	].map((match) => match[1] as string),
);
mock.module("../../../../server/websocket/narrator-ws", () =>
	Object.fromEntries(
		[...narratorWsExports].map((name) => [
			name,
			name === "broadcastToNarrator"
				? (narratorId: string, frame: unknown) => {
						broadcasts.push({ narratorId, frame });
					}
				: () => undefined,
		]),
	),
);

import {
	createPostgresRuntimeQueue,
	setPostgresRuntimeQueue,
} from "../../../../server/services/agent-runtime/postgres-runtime-queue";
import { createPostgresNarratorMessageRefsPort } from "../../../../server/services/narrator-refs/postgres-store";
import { bindNarratorMessageRefs } from "../../../../server/services/narrator-refs/store";
import { withPostgres } from "../../../db/pg-test-harness";
import { migrationSql } from "../read/pg-parity-matrix";

const now = "2026-10-01T00:00:00.000Z";

afterAll(() => {
	setPostgresRuntimeQueue(undefined);
	bindNarratorMessageRefs(undefined);
	delete process.env.NF_DATABASE_BACKEND;
	delete process.env.NF_DATABASE_URL;
});

// Opt-in is explicitly skipped, never represented as PG evidence. PG_INTEGRATION=1 cannot skip.
const integration = process.env.PG_INTEGRATION === "1" ? test : test.skip;

integration(
	"PG17 inbox consumption journal: user input, Send, fail/retry, claim recovery, wake eligibility",
	async () => {
		const outcome = await withPostgres(async ({ exec, port, credentials }) => {
			for (const migration of await migrationSql()) {
				const applied = await exec(migration);
				expect(applied.code, applied.stderr).toBe(0);
			}
			const url = `postgres://${credentials.user}:${credentials.password}@127.0.0.1:${port}/${credentials.database}`;
			const client = createPostgresClient({ driver: "bun-sql", url, max: 8 });
			try {
				return await journal(client, url);
			} catch (error) {
				// The harness reduces callback failures to "PostgreSQL callback failed";
				// keep the real assertion visible in the test output.
				console.error("inbox consumption journal failed:", error);
				throw error;
			} finally {
				await client.close();
			}
		});
		expect(outcome).toBe("verified");
	},
	300_000,
);

/** The full consumption journal, run against the migrated throwaway database. */
async function journal(
	client: ReturnType<typeof createPostgresClient>,
	url: string,
): Promise<string> {
	const [{ server_version: version }] = await client.sql.unsafe("SHOW server_version");
	expect(String(version).startsWith("17.")).toBe(true);
	await ensurePgFts(client.sql);
	await client.db.insert(narrators).values([
		{ id: "pgc-main", createdAt: now, updatedAt: now },
		{ id: "pgc-sender", createdAt: now, updatedAt: now },
		{ id: "pgc-archived", status: "archived", createdAt: now, updatedAt: now },
		{ id: "pgc-owned", createdAt: now, updatedAt: now },
		{ id: "pgc-notice-idle", createdAt: now, updatedAt: now },
		{ id: "pgc-notice-started", createdAt: now, updatedAt: now },
	]);
	const queue = createPostgresRuntimeQueue(client.db);
	const readiness = await queue.activateLegacyAdmission();
	expect(readiness.legacyAdmission).toBe("available");

	// Composition bindings, then the backend env the unwired publication facade reads at
	// import time. Everything from here is the production wiring path.
	setPostgresRuntimeQueue(queue);
	const refsPort = createPostgresNarratorMessageRefsPort(client.db);
	bindNarratorMessageRefs({ backend: "postgres", port: refsPort });
	process.env.NF_DATABASE_BACKEND = "postgres";
	process.env.NF_DATABASE_URL = url;

	const inbox = await import("../../../../server/services/agent-runtime/inbox");
	const { tryClaimExecution, getExecutionOwner } = await import(
		"../../../../server/services/agent-runtime/ownership"
	);

	const mailboxState = async (id: string) => {
		const [row] = await client.db
			.select({
				state: narratorBufferedMessages.state,
				claimToken: narratorBufferedMessages.claimToken,
				claimEpoch: narratorBufferedMessages.claimEpoch,
				currentMessageId: narratorBufferedMessages.currentMessageId,
				recipientRefId: narratorBufferedMessages.recipientRefId,
				lastError: narratorBufferedMessages.lastError,
				text: narratorBufferedMessages.text,
			})
			.from(narratorBufferedMessages)
			.where(eq(narratorBufferedMessages.id, id));
		return row;
	};
	const narratorState = async (id: string) => {
		const [row] = await client.db
			.select({
				next: narrators.nextSeq,
				count: narrators.messageCount,
				version: narrators.messageVersion,
			})
			.from(narrators)
			.where(eq(narrators.id, id));
		return row;
	};

	// ── 1. User input: enqueue → claim → materialize → ack, under withInboxOwner ──
	poisonHits = 0;
	const enqueued = await queue.mailbox.enqueue({
		kind: "user_input",
		narratorId: "pgc-main",
		requestKey: "rk-user-1",
		text: "hello pg",
		projectedByteSize: Buffer.byteLength("hello pg"),
	});
	if (!("delivery" in enqueued)) throw new Error("user input not accepted");
	let claimedEpoch = "";
	const persisted = await inbox.withInboxOwner("pgc-main", async () => {
		// withInboxOwner mounts the transient owner itself; the claim inherits its epoch.
		claimedEpoch = getExecutionOwner("pgc-main")?.epoch ?? "";
		const row = await inbox.claimInboxHead("pgc-main", (c) => c.kind === "user_input");
		if (!row) throw new Error("user input not claimed");
		expect(row.text).toBe("hello pg");
		expect(row.state).toBe("claimed");
		expect(row.claimEpoch).toBe(claimedEpoch);
		const materialized = await inbox.persistClaimedUserInput({
			claim: inbox.inboxClaim(row),
			reservedMessageId: row.recipientMessageId,
			narratorId: "pgc-main",
			text: "hello pg",
			contentBlocks: [{ type: "text", text: "hello pg" }],
		});
		expect(materialized.seq).toBe(0);
		expect(materialized.creator).toBeNull();
		expect(materialized.mailbox?.state).toBe("materialized");
		return materialized;
	});
	// withInboxOwner released the transient owner and ran owner-terminated recovery.
	expect(getExecutionOwner("pgc-main")).toBeUndefined();
	const userBox = await mailboxState(enqueued.delivery.id);
	expect(userBox?.state).toBe("materialized");
	expect(userBox?.claimToken).toBeNull();
	expect(userBox?.currentMessageId).toBe(persisted.id);
	expect(userBox?.text).toBe(""); // payload released at materialization
	expect(await narratorState("pgc-main")).toEqual({ next: 1, count: 1, version: 1 });
	const userRefs = await refsPort.page("pgc-main");
	expect(userRefs.rows.map((row) => [row.messageId, row.seq, row.role])).toEqual([
		[persisted.id, 0, "user"],
	]);
	const fts = await client.sql.unsafe(
		"SELECT id FROM search_narrator_messages WHERE content_text ILIKE '%hello pg%' LIMIT 2",
	);
	expect(fts).toHaveLength(1);
	// The adoption ack: exact delivery/ref/revision identity, after the materialize commit.
	expect(userBox?.recipientRefId).not.toBeNull();
	expect(
		await queue.mailbox.ackAdopted(
			enqueued.delivery.deliveryId as string,
			"pgc-main",
			userBox?.recipientRefId as string,
			1,
		),
	).toBe(true);
	// A stale ack (wrong revision) is refused.
	expect(
		await queue.mailbox.ackAdopted(
			enqueued.delivery.deliveryId as string,
			"pgc-main",
			userBox?.recipientRefId as string,
			7,
		),
	).toBe(false);
	expect(poisonHits).toBe(0);

	// Duplicate replay of the same request key returns the original receipt and writes nothing.
	const replayed = await queue.mailbox.enqueue({
		kind: "user_input",
		narratorId: "pgc-main",
		requestKey: "rk-user-1",
		text: "hello pg",
		projectedByteSize: Buffer.byteLength("hello pg"),
	});
	expect(replayed.status).toBe("duplicate");
	if (replayed.status !== "duplicate") throw new Error("unreachable");
	expect(replayed.delivery.id).toBe(enqueued.delivery.id);
	expect((await refsPort.page("pgc-main")).rows).toHaveLength(1);
	// A consumed claim can never materialize again.
	const consumedClaim = {
		id: enqueued.delivery.id,
		narratorId: "pgc-main",
		token: "process:dead:stale",
		epoch: claimedEpoch,
	};
	await expect(
		inbox.materializeClaimedInboxUserMessage({
			claim: consumedClaim,
			reservedMessageId: persisted.id,
			narratorId: "pgc-main",
			text: "hello pg",
			contentBlocks: [{ type: "text", text: "hello pg" }],
		}),
	).rejects.toThrow();
	expect((await refsPort.page("pgc-main")).rows).toHaveLength(1);
	expect(poisonHits).toBe(0);

	// ── 2. Send (agent_message): admission, exact duplicate, claimed delivery ──
	const sourceMessage = await refsPort.append({
		id: "pgc-src-msg",
		narratorId: "pgc-sender",
		role: "assistant",
		contentJson: [{ type: "text", text: "sender turn" }],
		contentText: "sender turn",
		createdAt: now,
	});
	await client.db.insert(narratorToolCalls).values({
		id: "pgc-tc-send",
		narratorId: "pgc-sender",
		messageId: sourceMessage.id,
		toolUseId: "pgc-use-send",
		toolName: "Send",
		executionAttempt: 1,
		executionIdentityVersion: 1,
		createdAt: now,
	});
	const { createAgentMessageDelivery } = await import(
		"../../../../server/services/agent-message-delivery"
	);
	const deliveryText = "same words";
	const delivery = createAgentMessageDelivery(
		"pgc-main",
		{ id: "pgc-sender", title: "Sender", label: "sender", type: "general", isParent: false },
		"pgc-use-send",
		deliveryText,
		{ toolCallId: "pgc-tc-send", attempt: 1 },
	);
	const admitted = await inbox.enqueueInboxAgent(delivery, `[sender] ${deliveryText}`);
	if (!("delivery" in admitted)) throw new Error("agent message not admitted");
	expect(admitted.status).toBe("accepted");
	// The exact retry navigates to the original receipt.
	const retryDelivery = createAgentMessageDelivery(
		"pgc-main",
		{ id: "pgc-sender", title: "Sender", label: "sender", type: "general", isParent: false },
		"pgc-use-send",
		deliveryText,
		{ toolCallId: "pgc-tc-send", attempt: 1 },
	);
	const retry = await inbox.enqueueInboxAgent(retryDelivery, `[sender] ${deliveryText}`);
	expect(retry.status).toBe("duplicate");
	expect(retryDelivery.deliveryId).toBe(delivery.deliveryId);
	// A forged receipt (unknown tool call) is rejected by the admission section.
	const forged = createAgentMessageDelivery(
		"pgc-main",
		{ id: "pgc-sender", title: "Sender", label: "sender", type: "general", isParent: false },
		"pgc-use-send",
		deliveryText,
		{ toolCallId: "pgc-tc-missing", attempt: 1 },
	);
	await expect(inbox.enqueueInboxAgent(forged, `[sender] ${deliveryText}`)).rejects.toThrow(
		/receipt|source/i,
	);
	expect(poisonHits).toBe(0);

	// Claim + deliver through the injection consumer: message + ref + mailbox flip in one
	// materialize section, broadcast after commit.
	const sendOwner = tryClaimExecution("pgc-main", "primary");
	if (!sendOwner) throw new Error("owner missing");
	const agentRow = await inbox.claimInboxHead("pgc-main", (c) => c.kind === "agent_message");
	if (!agentRow) throw new Error("agent message not claimed");
	const delivered = await inbox.deliverInboxInjection(
		"pgc-main",
		{
			messageId: agentRow.recipientMessageId ?? undefined,
			content: `[sender] ${deliveryText}`,
			source: "subagent_message",
			schedule: "none",
		},
		inbox.inboxClaim(agentRow),
	);
	expect(delivered.messageId).toBe(agentRow.recipientMessageId);
	expect(delivered.turnText).toBeNull();
	const agentBox = await mailboxState(agentRow.id);
	expect(agentBox?.state).toBe("materialized");
	expect(agentBox?.claimToken).toBeNull();
	const [sysRow] = await client.db
		.select()
		.from(narratorMessages)
		.where(eq(narratorMessages.id, agentRow.recipientMessageId as string));
	expect(sysRow?.role).toBe("sys");
	expect((sysRow?.contentJson as Array<{ type: string }>)[0]?.type).toBe("system_injection");
	expect(
		broadcasts.some(
			(frame) =>
				(frame as { narratorId?: string }).narratorId === "pgc-main" &&
				(frame as { frame?: { type?: string } }).frame?.type === "message",
		),
	).toBe(true);
	expect(poisonHits).toBe(0);

	// A lost post-commit frame: the committed projection is returned, never redelivered.
	const committed = await inbox.deliverInboxInjection(
		"pgc-main",
		{
			messageId: agentRow.recipientMessageId ?? undefined,
			content: `[sender] ${deliveryText}`,
			source: "subagent_message",
			schedule: "none",
		},
		// The consumed claim is stale by identity — the committed check must answer it.
		{
			id: agentRow.id,
			narratorId: "pgc-main",
			token: agentRow.claimToken as string,
			epoch: sendOwner.epoch,
		},
	);
	expect(committed.messageId).toBe(agentRow.recipientMessageId);
	expect((await refsPort.page("pgc-main")).rows).toHaveLength(2);
	expect(poisonHits).toBe(0);
	sendOwner.release();

	// ── 3. Fail/retry: a released claim never stays claimed, the same row is claimable ──
	const failEnqueued = await queue.mailbox.enqueue({
		kind: "user_input",
		narratorId: "pgc-main",
		requestKey: "rk-user-2",
		text: "retry me",
		projectedByteSize: Buffer.byteLength("retry me"),
	});
	if (!("delivery" in failEnqueued)) throw new Error("user input not accepted");
	const failOwner = tryClaimExecution("pgc-main", "primary");
	if (!failOwner) throw new Error("owner missing");
	const failRow = await inbox.claimInboxHead("pgc-main", (c) => c.id === failEnqueued.delivery.id);
	if (!failRow) throw new Error("row not claimed");
	await inbox.releaseInboxClaim(failRow, new Error("preparation failed"));
	const failedBox = await mailboxState(failRow.id);
	expect(failedBox?.state).toBe("queued");
	expect(failedBox?.claimToken).toBeNull();
	expect(failedBox?.claimEpoch).toBeNull();
	expect(failedBox?.lastError).toContain("preparation failed");
	// The SAME row heads the queue again — nothing was lost or duplicated.
	const reclaimed = await inbox.claimInboxHead("pgc-main", (c) => c.kind === "user_input");
	expect(reclaimed?.id).toBe(failRow.id);
	await inbox.releaseInboxClaim(reclaimed as NonNullable<typeof reclaimed>, "still not ready");
	expect((await mailboxState(failRow.id))?.state).toBe("queued");
	failOwner.release();
	expect(poisonHits).toBe(0);

	// ── 4. Cold-start recovery: foreign-process and ownerless legacy claims requeue ──
	const foreignEnqueued = await queue.mailbox.enqueue({
		kind: "user_input",
		narratorId: "pgc-notice-idle",
		requestKey: "rk-foreign",
		text: "foreign claim",
		projectedByteSize: 13,
	});
	if (!("delivery" in foreignEnqueued)) throw new Error("foreign fixture not accepted");
	await client.db
		.update(narratorBufferedMessages)
		.set({
			state: "claimed",
			claimToken: "process:dead-process:token",
			claimEpoch: "old-epoch",
			claimedAt: now,
		})
		.where(eq(narratorBufferedMessages.id, foreignEnqueued.delivery.id));
	const legacyEnqueued = await queue.mailbox.enqueue({
		kind: "user_input",
		narratorId: "pgc-notice-idle",
		requestKey: "rk-legacy",
		text: "legacy claim",
		projectedByteSize: 12,
	});
	if (!("delivery" in legacyEnqueued)) throw new Error("legacy fixture not accepted");
	await client.db
		.update(narratorBufferedMessages)
		.set({
			state: "claimed",
			claimToken: "unprefixed-old",
			claimEpoch: "old-epoch",
			claimedAt: now,
		})
		.where(eq(narratorBufferedMessages.id, legacyEnqueued.delivery.id));
	const recovered = await inbox.recoverInboxClaimsOnColdStartup();
	expect(recovered).toBe(2);
	expect((await mailboxState(foreignEnqueued.delivery.id))?.state).toBe("queued");
	expect((await mailboxState(legacyEnqueued.delivery.id))?.state).toBe("queued");
	// Idempotent within the process: the one-shot startup gate has run.
	expect(await inbox.recoverInboxClaimsOnColdStartup()).toBe(0);
	expect(poisonHits).toBe(0);

	// ── 5. Wake eligibility: named PG reads only; ineligible cases never touch SQLite ──
	// (a) A mounted execution owner declines before any queue read beyond the barrier.
	const heldOwner = tryClaimExecution("pgc-owned", "primary");
	if (!heldOwner) throw new Error("owner missing");
	expect(await inbox.wakeInboxIfEligible("pgc-owned")).toBe(false);
	heldOwner.release();
	// (b) An archived narrator never wakes, even with an actionable notice queued.
	await queue.mailbox.enqueue({
		kind: "task_notice",
		narratorId: "pgc-archived",
		noticeKind: "agent",
		sourceKey: "notice-archived",
		text: "",
		projectedByteSize: 1,
		metadata: { eventKind: "completed", taskId: "pgc-task-2" },
	});
	expect(await inbox.wakeInboxIfEligible("pgc-archived")).toBe(false);
	// (c) A queue holding only started/cancelled notices is not actionable: the
	// jsonb-extraction probe answers through the named PG read, never json_extract.
	await queue.mailbox.enqueue({
		kind: "task_notice",
		narratorId: "pgc-notice-started",
		noticeKind: "agent",
		sourceKey: "notice-started",
		text: "",
		projectedByteSize: 1,
		metadata: { eventKind: "started", taskId: "pgc-task-1" },
	});
	expect(await inbox.wakeInboxIfEligible("pgc-notice-started")).toBe(false);
	expect(poisonHits).toBe(0);
	// (d) The positive gate (recovered user inputs are queued for pgc-notice-idle)
	// reaches the narrator start path, whose reads are still SQLite-direct (a later
	// track): the wake degrades to false through the narrator-buffer PG guard — and
	// even that failure touches no SQLite handle.
	const poisonBefore = poisonHits;
	expect(await inbox.wakeInboxIfEligible("pgc-notice-idle")).toBe(false);
	expect(poisonHits).toBe(poisonBefore); // the unmigrated start path fails closed, not into SQLite
	poisonHits = 0;

	return "verified";
}
