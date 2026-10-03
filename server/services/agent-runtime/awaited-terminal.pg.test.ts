import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { withPostgres } from "../../../tests/db/pg-test-harness";
import { createPostgresClient } from "../../db/postgres-client";
import {
	runtimeAwaitedTerminalConsumptions as consumptions,
	narratorBufferedMessages as mailboxRows,
	narratorMessages as messages,
	narrators,
	runtimePublicationOutbox as outboxRows,
	narratorMessageRefs as refs,
} from "../../db/postgres-schema";
import { createPostgresRuntimeQueue } from "./postgres-runtime-queue";
import type { PublicationRun } from "./publication-outbox";

const PG_ENABLED = process.env.PG_INTEGRATION === "1";

(PG_ENABLED ? test : test.skip)(
	"real PostgreSQL journal: Await closes commit, transfer and claimed materialize windows",
	async () => {
		let callbackError: unknown;
		const result = await withPostgres(async ({ port, credentials }) => {
			const url = `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(credentials.password)}@127.0.0.1:${port}/nf_harness`;
			const client = createPostgresClient({ driver: "bun-sql", url, max: 8 });
			try {
				const db = client.db;
				await migrate(db, { migrationsFolder: "drizzle-postgres" } as Parameters<
					typeof migrate
				>[1]);
				const queue = createPostgresRuntimeQueue(db);
				const now = new Date().toISOString();
				await db.insert(narrators).values([
					{ id: "parent", createdAt: now, updatedAt: now },
					{ id: "other", createdAt: now, updatedAt: now },
				]);
				const source = (
					logicalRunId: string,
					producerKind: "agent" | "bash" = "agent",
				): PublicationRun => ({
					producerKind,
					taskId: "task",
					logicalRunId,
					recipientId: "parent",
				});
				const commit = (run: PublicationRun, eventKind: "started" | "completed" = "completed") =>
					queue.outbox.commitIntent({
						...run,
						eventKind,
						resultRef: "result:source",
						summary: "result",
					});

				// Consumption wins BEFORE a deferred publisher ever commits its intent.
				for (const kind of ["agent", "bash"] as const) {
					const run = source(`deferred-${kind}`, kind);
					await queue.outbox.reserveRunSlots(run, { started: true });
					await commit(run, "started");
					await Promise.all(
						Array.from({ length: 8 }, () => queue.outbox.consumeAwaitedTerminal(run)),
					);
					expect((await commit(run)).status).toBe("duplicate");
					await createPostgresRuntimeQueue(db).outbox.reserveRunSlots(run);
					expect(
						await db
							.select()
							.from(consumptions)
							.where(eq(consumptions.logicalRunId, run.logicalRunId)),
					).toHaveLength(1);
					await queue.outbox.transferNext("parent", kind);
				}
				expect(await db.select().from(outboxRows)).toHaveLength(0);
				expect((await db.select().from(mailboxRows)).every((row) => row.state === "queued")).toBe(
					true,
				);
				await db.delete(mailboxRows);

				// A publisher already entering its transaction cannot commit past the receipt.
				for (const kind of ["agent", "bash"] as const) {
					for (let i = 0; i < 6; i++) {
						const run = source(`commit-race-${kind}-${i}`, kind);
						await queue.outbox.reserveRunSlots(run);
						await Promise.all([commit(run), queue.outbox.consumeAwaitedTerminal(run)]);
						expect(await db.select().from(outboxRows)).toHaveLength(0);
						expect(await db.select().from(mailboxRows)).toHaveLength(0);
						expect((await commit(run)).status).toBe("duplicate");
					}
				}

				// Both orderings of a real concurrent outbox transfer/consume race.
				for (let i = 0; i < 12; i++) {
					const run = source(`transfer-${i}`);
					await queue.outbox.reserveRunSlots(run);
					await commit(run);
					await Promise.all([
						queue.outbox.transferNext("parent", "agent"),
						queue.outbox.consumeAwaitedTerminal(run),
					]);
					const rows = await db.select().from(mailboxRows);
					expect(rows.every((row) => row.state === "cancelled")).toBe(true);
					expect(await db.select().from(outboxRows)).toHaveLength(0);
					await db.delete(mailboxRows);
					expect((await commit(run)).status).toBe("duplicate");
				}

				// Await wins while a notice is claimed but materialization has not started.
				const revoked = source("claimed-revoked");
				await queue.outbox.reserveRunSlots(revoked);
				await commit(revoked);
				await queue.outbox.transferNext("parent", "agent");
				const claim = (await queue.mailbox.claimBatch("parent", { token: "t", epoch: "e" }))[0];
				if (!claim) throw new Error("Missing claimed fixture");
				await queue.outbox.consumeAwaitedTerminal(revoked);
				let called = false;
				await expect(
					queue.mailbox.materialize(
						{ id: claim.id, narratorId: "parent", token: "t", epoch: "e" },
						async () => {
							called = true;
							throw new Error("must not execute");
						},
					),
				).rejects.toThrow("Stale mailbox claim");
				expect(called).toBe(false);
				await db.delete(mailboxRows);

				// Materialization wins: hold its transaction AFTER acquiring the common recipient
				// lock, launch Await on another connection, and observe a real PG lock waiter.
				const materialized = source("materialize-first");
				await queue.outbox.reserveRunSlots(materialized);
				await commit(materialized);
				await queue.outbox.transferNext("parent", "agent");
				const heldClaim = (await queue.mailbox.claimBatch("parent", { token: "t", epoch: "e" }))[0];
				if (!heldClaim) throw new Error("Missing held claim");
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				const writing = queue.mailbox.materialize(
					{ id: heldClaim.id, narratorId: "parent", token: "t", epoch: "e" },
					async (tx, row) => {
						entered.resolve();
						await release.promise;
						const messageId = row.recipientMessageId as string;
						await tx.insert(messages).values({
							id: messageId,
							narratorId: "parent",
							role: "user",
							contentJson: [],
							createdAt: now,
						});
						await tx.insert(refs).values({ id: "ref", narratorId: "parent", messageId, seq: 0 });
						return { messageId, refId: "ref" };
					},
				);
				await entered.promise;
				const consuming = queue.outbox.consumeAwaitedTerminal(materialized);
				let waiting = false;
				try {
					for (let i = 0; i < 100; i++) {
						const rows = await db.execute(
							sql`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%narrators%' LIMIT 1`,
						);
						if (rows.length) {
							waiting = true;
							break;
						}
					}
				} finally {
					release.resolve();
				}
				await Promise.all([writing, consuming]);
				expect(waiting).toBe(true);
				expect((await db.select().from(mailboxRows))[0]?.state).toBe("materialized");
				expect(await db.select().from(refs)).toHaveLength(1);
				expect(await db.select().from(messages)).toHaveLength(1);
				expect((await commit(materialized)).status).toBe("duplicate");
				// The production PG journal retains restrictive history FKs; normal narrator
				// deletion removes owned history first. These are throwaway fixture rows only.
				await db.delete(refs).where(eq(refs.narratorId, "parent"));
				await db.delete(messages).where(eq(messages.narratorId, "parent"));
				await db.delete(mailboxRows).where(eq(mailboxRows.narratorId, "parent"));
				await db.delete(narrators).where(eq(narrators.id, "parent"));
				expect((await commit(materialized)).status).toBe("duplicate");
				expect(await db.select().from(consumptions)).toHaveLength(0);
				return "passed";
			} catch (error) {
				callbackError = error;
				throw error;
			} finally {
				await client.close();
			}
		});
		if (callbackError) throw callbackError;
		if (result !== "passed")
			throw new Error(`PostgreSQL harness failed: ${JSON.stringify(result)}`);
	},
	300_000,
);
