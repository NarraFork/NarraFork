import { expect, test } from "bun:test";
import { desc, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { withPostgres } from "../../../tests/db/pg-test-harness";
import { createPostgresClient } from "../../db/postgres-client";
import {
	backgroundTasks,
	narratorBufferedMessages as mailbox,
	narratorMessages as messages,
	narrators,
	runtimePublicationOutbox as outbox,
	narratorMessageRefs as refs,
} from "../../db/postgres-schema";
import { createPostgresRuntimePublication } from "./postgres-runtime-publication";
import { createPostgresRuntimeQueue } from "./postgres-runtime-queue";

const PG_ENABLED = process.env.PG_INTEGRATION === "1";
(PG_ENABLED ? test : test.skip)(
	"real PG journal: actor/task share one reserved run and Await reads only exact terminal/bounded deferred results",
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
				await db.insert(narrators).values([
					{ id: "parent", createdAt: now, updatedAt: now },
					{
						id: "actor",
						type: "subagent",
						variant: "subagent:general",
						parentNarratorId: "parent",
						status: "idle",
						createdAt: now,
						updatedAt: now,
					},
				]);
				async function message(
					id: string,
					text: string,
					role: "assistant" | "system" = "assistant",
				) {
					const top = await db
						.select({ seq: refs.seq })
						.from(refs)
						.where(eq(refs.narratorId, "actor"))
						.orderBy(desc(refs.seq))
						.limit(1);
					await db.insert(messages).values({
						id,
						narratorId: "actor",
						role,
						contentText: text,
						contentJson: [{ type: "text", text }],
						createdAt: now,
					});
					await db.insert(refs).values({
						id: `ref:${id}`,
						narratorId: "actor",
						messageId: id,
						seq: (top[0]?.seq ?? -1) + 1,
					});
				}
				const start = () =>
					engine.startAgentRun({ narratorId: "actor", parentNarratorId: "parent" });
				const taskRow = () => ({
					id: "actor",
					parentNarratorId: "parent",
					type: "agent" as const,
					status: "running" as const,
					subagentNarratorId: "actor",
					startedAt: now,
					createdAt: now,
					updatedAt: now,
				});
				await message("old-history", "OLD HISTORY RESULT");
				await message("old-compact", "OLD COMPACT SUMMARY", "system");
				const first = await start();
				expect(await engine.readAgentTerminalResult(first)).toBeNull();
				expect(
					await engine.readAgentTerminalResult(first, { settledRunId: first.logicalRunId }),
				).toBeNull();
				await message("first-output", "FIRST RUN OUTPUT");
				const before = await db.select().from(outbox);
				const adopted = await engine.startAgentRun({
					narratorId: "actor",
					parentNarratorId: "parent",
					taskRow: taskRow(),
				});
				expect(adopted).toEqual(first);
				expect((await db.select().from(backgroundTasks))[0]?.logicalRunId).toBe(first.logicalRunId);
				expect(await db.select().from(outbox)).toEqual(before);
				expect(await engine.readAgentTerminalResult(first)).toBeNull();
				expect(
					await engine.readAgentTerminalResult(first, { settledRunId: first.logicalRunId }),
				).toEqual({ output: "FIRST RUN OUTPUT", sourceResultRef: "message:first-output" });
				await db.update(narrators).set({ status: "working" }).where(eq(narrators.id, "actor"));
				expect(
					await engine.readAgentTerminalResult(first, { settledRunId: first.logicalRunId }),
				).toBeNull();
				await db.update(narrators).set({ status: "idle" }).where(eq(narrators.id, "actor"));
				await expect(
					engine.startAgentRun({
						narratorId: "actor",
						parentNarratorId: "parent",
						resumeRunId: "explicit-stale",
						taskRow: { ...taskRow(), id: "unused" },
					}),
				).rejects.toThrow("Stale logical run recovery");
				const second = await start();
				expect(second.logicalRunId).not.toBe(first.logicalRunId);
				expect((await db.select().from(backgroundTasks))[0]?.logicalRunId).toBe(
					second.logicalRunId,
				);
				expect(
					await engine.readAgentTerminalResult(first, { settledRunId: first.logicalRunId }),
				).toBeNull();
				await engine.commitAgentTerminal({
					run: first,
					eventKind: "completed",
					text: "FIRST FINAL",
					summary: "done",
				});
				expect(await engine.readAgentTerminalResult(first)).toEqual({
					output: "FIRST FINAL",
					sourceResultRef: "message:first-output",
				});
				await queue.outbox.transferNext("parent", "agent");
				const delivery = (await db.select().from(mailbox))[0];
				if (!delivery?.deliveryId) throw new Error("missing delivery");
				await queue.mailbox.cancel(delivery.deliveryId, "user cancelled notice");
				expect(await engine.readAgentTerminalResult(first)).toEqual({
					output: "FIRST FINAL",
					sourceResultRef: "message:first-output",
				});
				await queue.outbox.consumeAwaitedTerminal(first);
				await db.delete(mailbox);
				expect(await engine.readAgentTerminalResult(first)).toEqual({
					output: "FIRST FINAL",
					sourceResultRef: "message:first-output",
				});
				expect(await engine.readAgentTerminalResult(second)).toBeNull();
				expect(
					await engine.readAgentTerminalResult(second, { settledRunId: second.logicalRunId }),
				).toBeNull();
				await message("second-output", `SECOND RUN ${"x".repeat(300_000)}`);
				expect(await engine.readAgentTerminalResult(second)).toBeNull();
				expect(
					(await engine.readAgentTerminalResult(second, { settledRunId: second.logicalRunId }))
						?.output,
				).toHaveLength(12_000);
				expect(
					await engine.readAgentTerminalResult(second, { settledRunId: first.logicalRunId }),
				).toBeNull();
				await db
					.update(messages)
					.set({
						originalContentJson: [{ type: "text", text: "ORIGINAL SECOND OUTPUT" }],
						contentText: "EDITED",
					})
					.where(eq(messages.id, "second-output"));
				expect(
					await engine.readAgentTerminalResult(second, { settledRunId: second.logicalRunId }),
				).toEqual({ output: "ORIGINAL SECOND OUTPUT", sourceResultRef: "message:second-output" });
				await engine.commitAgentTerminal({
					run: second,
					eventKind: "completed",
					text: "SECOND FINAL",
					summary: "done",
				});
				expect(await engine.readAgentTerminalResult(second)).toEqual({
					output: "SECOND FINAL",
					sourceResultRef: "message:second-output",
				});
				await db.delete(backgroundTasks).where(eq(backgroundTasks.id, "actor"));
				const third = await engine.startAgentRun({
					narratorId: "actor",
					parentNarratorId: "parent",
					taskRow: taskRow(),
				});
				expect(third.logicalRunId).not.toBe(second.logicalRunId);
				expect(await engine.readAgentTerminalResult(third)).toBeNull();
				expect(
					await engine.readAgentTerminalResult(third, { settledRunId: third.logicalRunId }),
				).toBeNull();
				await engine.commitAgentTerminal({
					run: third,
					eventKind: "failed",
					text: "EARLY FAILURE",
					summary: "failed",
				});
				expect(await engine.readAgentTerminalResult(third)).toEqual({ output: "EARLY FAILURE" });
				await queue.outbox.consumeAwaitedTerminal(third);
				await db.delete(backgroundTasks).where(eq(backgroundTasks.id, "actor"));
				const fourth = await engine.startAgentRun({
					narratorId: "actor",
					parentNarratorId: "parent",
					taskRow: taskRow(),
				});
				expect(fourth.logicalRunId).not.toBe(third.logicalRunId);
				expect(await engine.readAgentTerminalResult(fourth)).toBeNull();
				expect(await engine.readAgentTerminalResult(third)).toEqual({ output: "EARLY FAILURE" });
				// Foreground-only deferred outcome: no task row can serve as a fallback source.
				await db.delete(backgroundTasks).where(eq(backgroundTasks.id, "actor"));
				await message("foreground-deferred-source", `FG OUTPUT ${"x".repeat(40_000)}`);
				const read = await engine.readAgentTerminalResult(fourth, {
					settledRunId: fourth.logicalRunId,
				});
				expect(read?.sourceResultRef).toBe("message:foreground-deferred-source");
				expect(read?.output).toContain("Output truncated.");
				await start(); // Read→consume race: actor has already moved to another run.
				await message("future-fg-source", "FUTURE FG OUTPUT");
				await queue.outbox.consumeAwaitedTerminal(fourth, {
					sourceResultRef: read?.sourceResultRef,
				});
				expect((await engine.readAgentTerminalResult(fourth))?.sourceResultRef).toBe(
					"message:foreground-deferred-source",
				);
				await engine.commitAgentTerminal({
					run: fourth,
					eventKind: "completed",
					text: `FG OUTPUT ${"x".repeat(40_000)}`,
					summary: "done",
				});
				const stored = (
					await db
						.select()
						.from(messages)
						.where(eq(messages.id, `publication-result:${fourth.logicalRunId}`))
				)[0];
				const body = stored?.contentJson as
					| Array<{ publicationResult?: { sourceResultRef?: string } }>
					| undefined;
				expect(body?.[0]?.publicationResult?.sourceResultRef).toBe(
					"message:foreground-deferred-source",
				);
				expect((await engine.readAgentTerminalResult(fourth))?.output).toContain(
					"Output truncated.",
				);
				// Foreground snapshot + consumption is one section: no notice, idempotent immutable result.
				const foreground = await start();
				await message("immediate-source", "IMMEDIATE FOREGROUND SOURCE");
				const input = {
					run: foreground,
					eventKind: "completed" as const,
					text: "IMMEDIATE FOREGROUND",
					summary: "done",
					delivery: "foreground" as const,
				};
				expect(await engine.commitAgentTerminal(input)).toMatchObject({
					status: "committed",
					deliveryId: null,
				});
				expect(await engine.commitAgentTerminal({ ...input, text: "DRIFT" })).toMatchObject({
					status: "duplicate",
				});
				expect(await engine.readAgentTerminalResult(foreground)).toEqual({
					output: "IMMEDIATE FOREGROUND",
					sourceResultRef: "message:immediate-source",
				});
				expect(
					await db.select().from(outbox).where(eq(outbox.logicalRunId, foreground.logicalRunId)),
				).toHaveLength(0);
				const noAssistant = await start();
				await engine.commitAgentTerminal({
					...input,
					run: noAssistant,
					eventKind: "failed",
					text: "FAILED WITHOUT ASSISTANT",
				});
				expect(await engine.readAgentTerminalResult(noAssistant)).toEqual({
					output: "FAILED WITHOUT ASSISTANT",
				});
				const atomicFailure = await start();
				await client.sql.unsafe(
					"CREATE FUNCTION reject_fg_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'foreground receipt failure'; END $$; CREATE TRIGGER reject_fg_receipt BEFORE INSERT ON runtime_awaited_terminal_consumptions FOR EACH ROW EXECUTE FUNCTION reject_fg_receipt()",
				);
				try {
					const failure = await engine.commitAgentTerminal({ ...input, run: atomicFailure }).then(
						() => null,
						(error: unknown) => error,
					);
					expect(failure).toBeInstanceOf(Error);
					expect((failure as Error & { cause?: Error }).cause?.message).toContain(
						"foreground receipt failure",
					);
					expect(
						await db
							.select()
							.from(messages)
							.where(eq(messages.id, `publication-result:${atomicFailure.logicalRunId}`)),
					).toHaveLength(0);
					expect(await engine.readAgentTerminalResult(atomicFailure)).toBeNull();
				} finally {
					await client.sql.unsafe(
						"DROP TRIGGER reject_fg_receipt ON runtime_awaited_terminal_consumptions; DROP FUNCTION reject_fg_receipt()",
					);
					await queue.outbox.releaseUnusedRunSlots(atomicFailure);
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
