import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { withPostgres } from "../../../tests/db/pg-test-harness";
import { createPostgresClient } from "../../db/postgres-client";
import {
	backgroundTasks,
	runtimeAwaitedTerminalConsumptions as consumptions,
	narratorBufferedMessages as mailbox,
	narrators,
} from "../../db/postgres-schema";
import {
	createPostgresRuntimePublication,
	type PgStaleTaskRow,
} from "./postgres-runtime-publication";
import { createPostgresRuntimeQueue } from "./postgres-runtime-queue";

(process.env.PG_INTEGRATION === "1" ? test : test.skip)(
	"real PG restart recovery skips a row whose identity changed after the scan, and pages queued notices",
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
				for (const id of ["parent", "other"])
					await db.insert(narrators).values({ id, createdAt: now, updatedAt: now });
				const start = (taskId: string) =>
					engine.startBashRun({
						taskId,
						recipientId: "parent",
						taskRow: {
							id: taskId,
							parentNarratorId: "parent",
							type: "bash",
							status: "running",
							command: "build",
							startedAt: now,
							createdAt: now,
							updatedAt: now,
						},
					});
				const scanned = async (taskId: string): Promise<PgStaleTaskRow> => {
					const row = (await engine.readRunningStaleTasks()).find((task) => task.id === taskId);
					if (!row) throw new Error(`not scanned: ${taskId}`);
					return row;
				};
				const recover = (taskId: string, expected: PgStaleTaskRow) =>
					engine.recoverStaleTask({
						taskId,
						now,
						eventKind: "failed",
						text: "Execution outcome unknown after restart; the command was not rerun.",
						expected,
					});

				// Changed after the scan: the stale terminal must not land on the new state.
				const changes: Array<[string, Partial<typeof backgroundTasks.$inferInsert>]> = [
					["run", { logicalRunId: "a-newer-run" }],
					["owner", { parentNarratorId: "other" }],
					["binding", { executionAttempt: 2 }],
				];
				for (const [name, change] of changes) {
					const run = await start(`changed-${name}`);
					const observed = await scanned(run.taskId);
					await db.update(backgroundTasks).set(change).where(eq(backgroundTasks.id, run.taskId));
					expect(await recover(run.taskId, observed)).toBeUndefined();
					const row = (
						await db.select().from(backgroundTasks).where(eq(backgroundTasks.id, run.taskId))
					)[0];
					expect(row?.status).toBe("running");
					expect(row?.output ?? null).toBeNull();
				}

				// Unchanged: recovered exactly as before, with its terminal intent.
				const same = await start("unchanged");
				const observed = await scanned(same.taskId);
				// Output renewal does not change recovery eligibility.
				await db
					.update(backgroundTasks)
					.set({ output: "new tail", updatedAt: "2099-01-01" })
					.where(eq(backgroundTasks.id, same.taskId));
				expect(await recover(same.taskId, observed)).toBeDefined();
				expect((await engine.readTaskDetail(same.taskId))?.status).toBe("failed");
				// The ordinary restart terminal is recorded as an awaited-terminal consumption,
				// exactly as without the identity guard.
				expect(
					await db.select().from(consumptions).where(eq(consumptions.taskId, same.taskId)),
				).toHaveLength(1);

				// The startup wake page lists only queued actionable task notices, id-paged.
				const enqueue = (narratorId: string, sourceKey: string, eventKind: string) =>
					queue.mailbox.enqueue({
						kind: "task_notice",
						noticeKind: "bash",
						narratorId,
						sourceKey,
						text: eventKind,
						projectedByteSize: eventKind.length,
						metadata: { producerKind: "bash", taskId: sourceKey, logicalRunId: "r", eventKind },
					});
				await enqueue("parent", "n-1", "completed");
				await enqueue("parent", "n-2", "failed");
				await enqueue("other", "n-3", "started");
				await enqueue("other", "n-4", "cancelled");
				const first = await queue.mailbox.listQueuedTaskNoticeRecipients({ limit: 1 });
				expect(first.recipientIds).toEqual(["parent"]);
				expect(first.nextAfterId).toBeDefined();
				const second = await queue.mailbox.listQueuedTaskNoticeRecipients({
					afterId: first.nextAfterId,
					limit: 10,
				});
				expect(second).toEqual({ recipientIds: ["parent"] });
				expect(await db.select().from(mailbox)).toHaveLength(4);
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
