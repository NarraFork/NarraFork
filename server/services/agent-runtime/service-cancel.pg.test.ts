import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { withPostgres } from "../../../tests/db/pg-test-harness";
import { createPostgresClient } from "../../db/postgres-client";
import {
	backgroundTasks,
	runtimeAwaitedTerminalConsumptions as consumptions,
	deviceTransferTasks,
	narratorBufferedMessages as mailbox,
	narrators,
	runtimePublicationOutbox as outbox,
	remoteDevices,
} from "../../db/postgres-schema";
import { createPostgresRuntimePublication } from "./postgres-runtime-publication";
import { createPostgresRuntimeQueue } from "./postgres-runtime-queue";

(process.env.PG_INTEGRATION === "1" ? test : test.skip)(
	"real PG service cancellation, transfer notification and silent observation retain durable results",
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
				// Transfers need no new notice kind. Their terminal CAS reserves a bash
				// publication, and a paused projection produces neither terminal nor notice.
				for (const status of ["completed", "failed", "cancelled"] as const) {
					const id = `transfer-${status}`;
					await db.insert(backgroundTasks).values({
						id,
						parentNarratorId: "parent",
						type: "transfer",
						status: "paused",
						startedAt: now,
						createdAt: now,
						updatedAt: now,
					});
					expect(await db.select().from(outbox).where(eq(outbox.taskId, id))).toHaveLength(0);
					await db
						.update(backgroundTasks)
						.set({ status: "running" })
						.where(eq(backgroundTasks.id, id));
					if (status === "cancelled") {
						const input = {
							taskId: id,
							now,
							capturedOutput: null,
							capturedOutputBytes: 0,
							capturedTruncated: false,
						};
						expect(await engine.cancelTask(input)).not.toBeNull();
						expect(await engine.cancelTask(input)).toBeNull();
					} else {
						const input = {
							taskId: id,
							setFields: { status, output: "transfer result", completedAt: now },
							fullOutput: "transfer result",
							summary: `transfer ${status}`,
							eventKind: status,
						};
						expect(await engine.commitTerminalTransition(input)).toBeDefined();
						expect(await engine.commitTerminalTransition(input)).toBeUndefined();
					}
					expect((await engine.readTaskDetail(id))?.logicalRunId).toBeTruthy();
					expect((await queue.outbox.transferNext("parent", "bash")).status).toBe("transferred");
				}

				await db.insert(remoteDevices).values({
					id: "retry-device",
					name: "retry",
					slug: "retry",
					tokenHash: "hash",
					tokenPrefix: "test",
					createdBy: "test",
					createdAt: now,
					updatedAt: now,
				});
				for (const status of ["completed", "failed"] as const) {
					const ownerId = `retry-${status}`;
					await db.insert(deviceTransferTasks).values({
						id: ownerId,
						deviceId: "retry-device",
						parentNarratorId: "parent",
						direction: "upload",
						remotePath: "/remote",
						localPath: "/local",
						status: "running",
						createdAt: now,
						updatedAt: now,
					});
					const taskRow = {
						id: `projection-${ownerId}`,
						parentNarratorId: "parent",
						transferTaskId: ownerId,
						type: "transfer" as const,
						status: "running" as const,
						startedAt: now,
						createdAt: now,
						updatedAt: now,
					};
					const first = await engine.startTransferTask({ taskRow, runGeneration: 0 });
					expect(first?.logicalRunId).toBe(`transfer:${ownerId}:0`);
					await db
						.update(deviceTransferTasks)
						.set({ status: "failed" })
						.where(eq(deviceTransferTasks.id, ownerId));
					const failed = {
						taskId: taskRow.id,
						expectedTransfer: { id: ownerId, generation: 0 },
						setFields: { status: "failed", output: "first failure", completedAt: now },
						eventKind: "failed" as const,
						fullOutput: "first failure",
						summary: `${ownerId} first failure`,
					};
					expect(await engine.commitTerminalTransition(failed)).toBeDefined();
					await queue.outbox.transferNext("parent", "bash");
					// Same owner transition as resume + claim: generation advances exactly once.
					await db
						.update(deviceTransferTasks)
						.set({ status: "running", runGeneration: 1 })
						.where(eq(deviceTransferTasks.id, ownerId));
					if (status === "completed") {
						await client.sql.unsafe(
							"CREATE FUNCTION reject_retry_slot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'retry slot failure'; END $$; CREATE TRIGGER reject_retry_slot BEFORE INSERT ON runtime_publication_outbox FOR EACH ROW EXECUTE FUNCTION reject_retry_slot()",
						);
						try {
							await expect(
								engine.startTransferTask({ taskRow, runGeneration: 1 }),
							).rejects.toThrow();
							expect(await engine.readTaskDetail(taskRow.id)).toMatchObject({
								status: "failed",
								logicalRunId: first?.logicalRunId,
							});
							expect(
								await db.select().from(outbox).where(eq(outbox.taskId, taskRow.id)),
							).toHaveLength(0);
						} finally {
							await client.sql.unsafe(
								"DROP TRIGGER reject_retry_slot ON runtime_publication_outbox; DROP FUNCTION reject_retry_slot()",
							);
						}
					}
					const [second, replayed] = await Promise.all([
						engine.startTransferTask({ taskRow, runGeneration: 1 }),
						engine.startTransferTask({ taskRow, runGeneration: 1 }),
					]);
					expect(replayed?.logicalRunId).toBe(second?.logicalRunId);
					expect(await db.select().from(outbox).where(eq(outbox.taskId, taskRow.id))).toHaveLength(
						1,
					);
					expect(second?.id).toBe(first?.id);
					expect(second?.logicalRunId).toBe(`transfer:${ownerId}:1`);
					expect(second?.logicalRunId).not.toBe(first?.logicalRunId);
					expect(
						(await engine.startTransferTask({ taskRow, runGeneration: 0 }))?.logicalRunId,
					).toBe(second?.logicalRunId);
					expect(await engine.commitTerminalTransition(failed)).toBeUndefined();
					expect((await engine.readTaskDetail(taskRow.id))?.status).toBe("running");
					await db
						.update(deviceTransferTasks)
						.set({ status })
						.where(eq(deviceTransferTasks.id, ownerId));
					const terminal = {
						taskId: taskRow.id,
						expectedTransfer: { id: ownerId, generation: 1 },
						setFields: { status, output: "second result", completedAt: now },
						eventKind: status,
						fullOutput: "second result",
						summary: `${ownerId} second ${status}`,
					};
					expect(await engine.commitTerminalTransition(terminal)).toBeDefined();
					expect(await engine.commitTerminalTransition(terminal)).toBeUndefined();
					await engine.startTransferTask({ taskRow, runGeneration: 1 });
					await queue.outbox.transferNext("parent", "bash");
					const notices = (await db.select().from(mailbox)).filter((row) =>
						row.text.includes(ownerId),
					);
					expect(notices).toHaveLength(2);
					expect(new Set(notices.map((row) => row.dedupeKey)).size).toBe(2);
					expect((await engine.readTaskDetail(taskRow.id))?.status).toBe(status);
				}
				await db.insert(deviceTransferTasks).values({
					id: "pause-owner",
					deviceId: "retry-device",
					parentNarratorId: "parent",
					direction: "upload",
					remotePath: "/remote",
					localPath: "/local",
					status: "running",
					createdAt: now,
					updatedAt: now,
				});
				const pausedRow = {
					id: "pause-projection",
					parentNarratorId: "parent",
					transferTaskId: "pause-owner",
					type: "transfer" as const,
					status: "running" as const,
					startedAt: now,
					createdAt: now,
					updatedAt: now,
				};
				const pausedRun = await engine.startTransferTask({ taskRow: pausedRow, runGeneration: 0 });
				await db
					.update(backgroundTasks)
					.set({ status: "paused" })
					.where(eq(backgroundTasks.id, pausedRow.id));
				const pausedSlots = await db.select().from(outbox).where(eq(outbox.taskId, pausedRow.id));
				await db
					.update(deviceTransferTasks)
					.set({ status: "running", runGeneration: 1 })
					.where(eq(deviceTransferTasks.id, "pause-owner"));
				expect(
					(await engine.startTransferTask({ taskRow: pausedRow, runGeneration: 1 }))?.logicalRunId,
				).toBe(pausedRun?.logicalRunId);
				expect(await db.select().from(outbox).where(eq(outbox.taskId, pausedRow.id))).toEqual(
					pausedSlots,
				);
				expect(
					await engine.commitTerminalTransition({
						taskId: pausedRow.id,
						expectedTransfer: { id: "pause-owner", generation: 0 },
						setFields: { status: "failed" },
						fullOutput: "late",
						summary: "late",
						eventKind: "failed",
					}),
				).toBeUndefined();

				await engine.cleanupTasks({
					cutoff: "2099-01-01T00:00:00.000Z",
					limit: 100,
					excludedStatuses: ["running", "paused"],
					excludedNarratorStatuses: ["working", "waiting"],
					subagentPath: "$",
				});
				for (const status of ["completed", "failed", "cancelled"])
					expect(await engine.readTaskDetail(`transfer-${status}`)).not.toBeNull();

				for (const prefix of ["[watch]", "[terminal watch]"]) {
					const id = `observation-${prefix}`;
					const run = await engine.startBashRun({
						taskId: id,
						recipientId: "parent",
						taskRow: {
							id,
							parentNarratorId: "parent",
							type: "bash",
							command: `${prefix} source-task`,
							status: "running",
							startedAt: now,
							createdAt: now,
							updatedAt: now,
						},
					});
					const before = await db.select().from(mailbox);
					const input = {
						taskId: id,
						setFields: {
							status: "completed",
							output: "source completed",
							completedAt: now,
							notified: true,
						},
						fullOutput: "source completed",
						summary: "",
						eventKind: "completed" as const,
						silentObservation: true,
					};
					expect(await engine.commitTerminalTransition(input)).toBeDefined();
					expect(await engine.commitTerminalTransition(input)).toBeUndefined();
					expect(
						await db.select().from(outbox).where(eq(outbox.logicalRunId, run.logicalRunId)),
					).toHaveLength(0);
					expect(
						await db.select().from(consumptions).where(eq(consumptions.taskId, id)),
					).toHaveLength(0);
					expect(await db.select().from(mailbox)).toEqual(before);
				}
				const notWatch = await engine.startBashRun({
					taskId: "not-observation",
					recipientId: "parent",
					taskRow: {
						id: "not-observation",
						parentNarratorId: "parent",
						type: "bash",
						command: "build",
						status: "running",
						startedAt: now,
						createdAt: now,
						updatedAt: now,
					},
				});
				expect(
					await engine.commitTerminalTransition({
						taskId: notWatch.taskId,
						setFields: { status: "completed" },
						fullOutput: "",
						summary: "",
						eventKind: "completed",
						silentObservation: true,
					}),
				).toBeUndefined();
				expect((await engine.readTaskDetail(notWatch.taskId))?.status).toBe("running");
				await db.insert(backgroundTasks).values({
					id: "legacy-watch",
					parentNarratorId: "parent",
					type: "bash",
					status: "running",
					command: "[watch] source",
					startedAt: now,
					createdAt: now,
					updatedAt: now,
				});
				await engine.recoverStaleTask({
					taskId: "legacy-watch",
					now,
					eventKind: "failed",
					text: "Observation interrupted; the target was not stopped.",
				});
				await queue.outbox.transferNext("parent", "bash");
				expect(
					(await db.select().from(mailbox)).some((row) =>
						row.text.includes("Observation interrupted"),
					),
				).toBe(true);

				const restarted = await engine.startBashRun({
					taskId: "ordinary-restart",
					recipientId: "parent",
					taskRow: {
						id: "ordinary-restart",
						parentNarratorId: "parent",
						type: "bash",
						status: "running",
						command: "build",
						startedAt: now,
						createdAt: now,
						updatedAt: now,
					},
				});
				await engine.recoverStaleTask({
					taskId: restarted.taskId,
					now,
					eventKind: "failed",
					text: "Execution outcome unknown after restart; the command was not rerun.",
				});
				await queue.outbox.transferNext("parent", "bash");
				expect((await engine.readTaskDetail(restarted.taskId))?.status).toBe("failed");
				expect(await db.select().from(outbox).where(eq(outbox.taskId, restarted.taskId))).toEqual(
					[],
				);
				expect(
					await db.select().from(consumptions).where(eq(consumptions.taskId, restarted.taskId)),
				).toHaveLength(1);
				expect(
					(await db.select().from(mailbox)).some((row) =>
						row.text.includes("Execution outcome unknown"),
					),
				).toBe(false);

				await engine.startBashRun({
					taskId: "silent-rollback",
					recipientId: "parent",
					taskRow: {
						id: "silent-rollback",
						parentNarratorId: "parent",
						type: "bash",
						status: "running",
						command: "[watch] source",
						startedAt: now,
						createdAt: now,
						updatedAt: now,
					},
				});
				await client.sql.unsafe(
					"CREATE FUNCTION reject_silent_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'silent cleanup failure'; END $$; CREATE TRIGGER reject_silent_cleanup BEFORE DELETE ON runtime_publication_outbox FOR EACH ROW EXECUTE FUNCTION reject_silent_cleanup()",
				);
				try {
					await expect(
						engine.commitTerminalTransition({
							taskId: "silent-rollback",
							setFields: { status: "completed", notified: true },
							fullOutput: "done",
							summary: "",
							eventKind: "completed",
							silentObservation: true,
						}),
					).rejects.toThrow();
					expect(await engine.readTaskDetail("silent-rollback")).toMatchObject({
						status: "running",
						notified: false,
					});
					expect(
						await db.select().from(outbox).where(eq(outbox.taskId, "silent-rollback")),
					).toHaveLength(1);
				} finally {
					await client.sql.unsafe(
						"DROP TRIGGER reject_silent_cleanup ON runtime_publication_outbox; DROP FUNCTION reject_silent_cleanup()",
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
