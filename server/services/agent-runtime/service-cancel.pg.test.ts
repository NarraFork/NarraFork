import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { withPostgres } from "../../../tests/db/pg-test-harness";
import { createPostgresClient } from "../../db/postgres-client";
import {
	runtimeAwaitedTerminalConsumptions as consumptions,
	narratorBufferedMessages as mailbox,
	narrators,
	runtimePublicationOutbox as outbox,
} from "../../db/postgres-schema";
import { createPostgresRuntimePublication } from "./postgres-runtime-publication";
import { createPostgresRuntimeQueue } from "./postgres-runtime-queue";

(process.env.PG_INTEGRATION === "1" ? test : test.skip)(
	"real PG service cancellation retains Await result without terminal outbox or pending mailbox",
	async () => {
		let callbackError: unknown;
		const result = await withPostgres(async ({ port, credentials }) => {
			const url = `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(credentials.password)}@127.0.0.1:${port}/nf_harness`;
			const client = createPostgresClient({ driver: "bun-sql", url });
			try {
				const db = client.db;
				await migrate(db, { migrationsFolder: "drizzle-postgres" } as Parameters<
					typeof migrate
				>[1]);
				const queue = createPostgresRuntimeQueue(db);
				const engine = createPostgresRuntimePublication(
					db,
					queue,
					{ legacyReaders: new Map() },
					{ summarize: (text) => text.slice(0, 600), snapshotBytes: 64 * 1024 },
				);
				const now = new Date().toISOString();
				await db.insert(narrators).values({ id: "parent", createdAt: now, updatedAt: now });
				for (const backgroundKind of ["service", "task"] as const) {
					const run = await engine.startBashRun({
						taskId: backgroundKind,
						recipientId: "parent",
						taskRow: {
							id: backgroundKind,
							parentNarratorId: "parent",
							type: "bash",
							backgroundKind,
							status: "running",
							startedAt: now,
							createdAt: now,
							updatedAt: now,
						},
					});
					const input = {
						taskId: run.taskId,
						now,
						capturedOutput: "saved service output",
						capturedOutputBytes: 20,
						capturedTruncated: false,
					};
					expect((await engine.cancelTask(input))?.status).toBe("cancelled");
					const saved = await engine.readTaskDetail(run.taskId);
					expect(saved?.status).toBe("cancelled");
					expect(saved?.output).toBe("saved service output");
					if (backgroundKind === "service") {
						expect(
							await db.select().from(consumptions).where(eq(consumptions.taskId, run.taskId)),
						).toHaveLength(1);
						expect(
							await db.select().from(outbox).where(eq(outbox.taskId, run.taskId)),
						).toHaveLength(0);
						expect(
							(
								await engine.commit({
									...run,
									eventKind: "failed",
									resultRef: "saved",
									summary: "late callback",
								})
							).status,
						).toBe("duplicate");
						expect((await queue.outbox.transferNext("parent", "bash")).status).toBe("empty");
						expect(await db.select().from(mailbox)).toHaveLength(0);
					} else {
						expect(
							await db.select().from(consumptions).where(eq(consumptions.taskId, run.taskId)),
						).toHaveLength(0);
						expect((await queue.outbox.transferNext("parent", "bash")).status).toBe("transferred");
					}
					expect(await engine.cancelTask(input)).toBeNull();
				}
				const pendingRun = await engine.startBashRun({
					taskId: "pending",
					recipientId: "parent",
					taskRow: {
						id: "pending",
						parentNarratorId: "parent",
						type: "bash",
						backgroundKind: "service",
						status: "running",
						startedAt: now,
						createdAt: now,
						updatedAt: now,
					},
				});
				await engine.commit({
					...pendingRun,
					eventKind: "cancelled",
					resultRef: "saved",
					summary: "old notice",
				});
				await queue.outbox.transferNext("parent", "bash");
				await engine.cancelTask({
					taskId: "pending",
					now,
					capturedOutput: "final output",
					capturedOutputBytes: 12,
					capturedTruncated: false,
				});
				const rows = await db.select().from(mailbox);
				expect(rows.filter((row) => row.state === "cancelled")).toHaveLength(1);
				expect(rows.find((row) => row.state === "cancelled")?.text).toBe("");
				expect(await db.select().from(outbox).where(eq(outbox.taskId, "pending"))).toHaveLength(0);
				expect((await engine.readTaskDetail("pending"))?.output).toBe("final output");
				// Unsolicited service failure/timeout remains a normal publication.
				for (const eventKind of ["completed", "failed", "timed_out"] as const) {
					const run = await engine.startBashRun({
						taskId: eventKind,
						recipientId: "parent",
						taskRow: {
							id: eventKind,
							parentNarratorId: "parent",
							type: "bash",
							backgroundKind: "service",
							status: "running",
							startedAt: now,
							createdAt: now,
							updatedAt: now,
						},
					});
					await engine.commitBashTerminal({
						run,
						eventKind,
						text: "exit",
						summary: "service exited",
					});
					expect((await queue.outbox.transferNext("parent", "bash")).status).toBe("transferred");
					expect(
						await db.select().from(consumptions).where(eq(consumptions.taskId, run.taskId)),
					).toHaveLength(0);
				}
				const rollbackRun = await engine.startBashRun({
					taskId: "rollback",
					recipientId: "parent",
					taskRow: {
						id: "rollback",
						parentNarratorId: "parent",
						type: "bash",
						backgroundKind: "service",
						status: "running",
						startedAt: now,
						createdAt: now,
						updatedAt: now,
					},
				});
				await client.sql.unsafe(
					"CREATE FUNCTION reject_service_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'receipt failure'; END $$; CREATE TRIGGER reject_service_receipt BEFORE INSERT ON runtime_awaited_terminal_consumptions FOR EACH ROW EXECUTE FUNCTION reject_service_receipt()",
				);
				try {
					const error = await engine
						.cancelTask({
							taskId: "rollback",
							now,
							capturedOutput: "cancelled output",
							capturedOutputBytes: 16,
							capturedTruncated: false,
						})
						.then(
							() => null,
							(error: unknown) => error,
						);
					expect(error).toBeInstanceOf(Error);
					expect((await engine.readTaskDetail("rollback"))?.status).toBe("running");
					expect((await engine.readTaskDetail("rollback"))?.output).toBeNull();
					expect(
						(
							await db
								.select()
								.from(outbox)
								.where(eq(outbox.logicalRunId, rollbackRun.logicalRunId))
						)[0]?.state,
					).toBe("reserved");
				} finally {
					await client.sql.unsafe(
						"DROP TRIGGER reject_service_receipt ON runtime_awaited_terminal_consumptions; DROP FUNCTION reject_service_receipt()",
					);
				}
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
