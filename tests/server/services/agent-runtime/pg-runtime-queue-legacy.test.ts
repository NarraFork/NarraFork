/**
 * Production-schema proof: the complete committed drizzle-postgres journal is
 * applied with the real Bun SQL migrator to the harness's disposable PostgreSQL 17.
 * No CREATE/ALTER production tables, no scratch replacement columns. Fixtures use
 * the real constraints/defaults/identity sequences. Other runtime caller paths are
 * deliberately not claimed as migrated by this suite.
 */
import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { WriteConflictError } from "../../../../server/db/backend/write-port";
import { classifyPgError } from "../../../../server/db/pg-errors";
import { createPostgresClient } from "../../../../server/db/postgres-client";
import {
	backgroundTasks,
	narratorMessages,
	narrators,
	narratorToolCalls,
	narratorToolContinuations,
	runtimePublicationOutbox as outbox,
} from "../../../../server/db/postgres-schema";
import {
	createPostgresRuntimeQueue,
	RuntimeQueueSchemaPendingError,
} from "../../../../server/services/agent-runtime/postgres-runtime-queue";
import {
	LEGACY_UNKNOWN_BASH_FAILURE_SUMMARY,
	type LegacyCompletionAdmission,
	type LegacyPublicationSource,
	publicationDedupeKey,
} from "../../../../server/services/agent-runtime/publication-outbox";
import { withPostgres } from "../../../db/pg-test-harness";

const OLD = "2026-01-01T00:00:00.000Z";
const source = (
	taskId: string,
	producerKind: "bash" | "agent" = "bash",
	recipientId = "parent",
): LegacyPublicationSource => ({ taskId, producerKind, recipientId });
const failed = async (promise: Promise<unknown>) =>
	promise.then(
		() => undefined,
		(error: unknown) => error,
	);

test.skipIf(process.env.PG_INTEGRATION !== "1")(
	"formal journal: legacy proof, cutoff, retries, rollback, capacity and unknown Bash delivery",
	async () => {
		const result = await withPostgres(async ({ port, credentials }) => {
			const client = createPostgresClient({
				driver: "bun-sql",
				url: `postgres://${credentials.user}:${credentials.password}@127.0.0.1:${port}/${credentials.database}`,
				max: 8,
				connectTimeout: 10,
			});
			let stage = "formal migrations";
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
				expect(journal.length).toBeGreaterThanOrEqual(2);
				const version = await client.sql.unsafe(
					"SELECT current_setting('server_version_num')::int AS version",
				);
				expect(Number(version[0].version)).toBeGreaterThanOrEqual(170000);

				const narrator = async (id: string, patch: Partial<typeof narrators.$inferInsert> = {}) => {
					await db.insert(narrators).values({ id, createdAt: OLD, updatedAt: OLD, ...patch });
				};
				const task = async (
					id: string,
					patch: Partial<typeof backgroundTasks.$inferInsert> = {},
				) => {
					await db.insert(backgroundTasks).values({
						id,
						parentNarratorId: "parent",
						type: "bash",
						status: "running",
						startedAt: OLD,
						createdAt: OLD,
						updatedAt: OLD,
						...patch,
					});
				};
				const receipt = async (
					id: string,
					patch: Partial<typeof narratorToolCalls.$inferInsert> = {},
				) => {
					await db.insert(narratorToolCalls).values({
						id,
						narratorId: "parent",
						messageId: "message",
						toolUseId: id,
						toolName: "Bash",
						executionAttempt: 1,
						executionIdentityVersion: 1,
						executionStartedAt: OLD,
						createdAt: OLD,
						...patch,
					});
				};
				const checkpoint = async (
					id: string,
					toolCallId: string,
					patch: Partial<typeof narratorToolContinuations.$inferInsert> = {},
				) => {
					await db.insert(narratorToolContinuations).values({
						id,
						toolCallId,
						narratorId: "parent",
						updateEpoch: "epoch",
						kind: "deferred_tool",
						createdAt: OLD,
						updatedAt: OLD,
						...patch,
					});
				};
				const taskRun = async (id: string) =>
					(
						await db
							.select({ run: backgroundTasks.logicalRunId })
							.from(backgroundTasks)
							.where(eq(backgroundTasks.id, id))
					)[0]?.run;
				const slots = async (id: string) => db.select().from(outbox).where(eq(outbox.taskId, id));

				stage = "nonempty pre-boundary fixtures";
				await narrator("parent", { insertSeq: 1 });
				await narrator("deleted-parent", { insertSeq: 2 });
				await narrator("agent", {
					type: "subagent",
					parentNarratorId: "parent",
					status: "working",
					originToolCallId: "call-agent",
					turnStartedAt: OLD,
					insertSeq: 3,
				});
				await narrator("agent-cp", {
					type: "subagent",
					parentNarratorId: "parent",
					status: "idle",
					originToolCallId: "call-agent-cp",
					turnStartedAt: OLD,
					insertSeq: 4,
				});
				await narrator("agent-done", {
					type: "subagent",
					parentNarratorId: "parent",
					status: "idle",
					backgroundStatus: "completed",
					turnStartedAt: OLD,
					backgroundCompletedAt: OLD,
					insertSeq: 5,
				});
				await narrator("ordinal-42", { insertSeq: 42 });
				await db.insert(narratorMessages).values({
					id: "message",
					narratorId: "parent",
					role: "assistant",
					contentJson: [],
					createdAt: OLD,
				});
				for (const id of [
					"call-bash",
					"call-agent",
					"call-agent-cp",
					"call-cp",
					"call-late-cp",
					"call-boundary",
					"call-bad",
				])
					await receipt(id);
				await task("bash", { toolCallId: "call-bash", executionAttempt: 1, insertSeq: 1 });
				await task("unknown", { insertSeq: 2 });
				await task("concurrent", { insertSeq: 3 });
				await task("rollback", { insertSeq: 4 });
				await task("unique-fault", { insertSeq: 16 });
				await task("serialize-fault", { insertSeq: 17 });
				await task("bad-proof", { toolCallId: "call-bad", executionAttempt: 2, insertSeq: 5 });
				await task("bash-cp", { toolCallId: "call-cp", executionAttempt: 1, insertSeq: 6 });
				await task("late-cp-source", {
					toolCallId: "call-late-cp",
					executionAttempt: 1,
					insertSeq: 7,
				});
				await task("new-protocol", { logicalRunId: "new-run", insertSeq: 8 });
				await task("no-runtime", { insertSeq: 9 });
				await task("done", { status: "completed", completedAt: OLD, insertSeq: 10 });
				await task("wrong-outcome", { status: "failed", completedAt: OLD, insertSeq: 11 });
				await task("deleted-source", { status: "completed", completedAt: OLD, insertSeq: 12 });
				await task("deleted-recipient", {
					parentNarratorId: "deleted-parent",
					status: "completed",
					completedAt: OLD,
					insertSeq: 13,
				});
				await task("capacity", { insertSeq: 14 });
				await task("capacity-completed", { status: "completed", completedAt: OLD, insertSeq: 15 });
				await task("boundary-42", { insertSeq: 42 });
				await checkpoint("cp-agent", "call-agent-cp", { kind: "foreground_agent", insertSeq: 1 });
				await checkpoint("cp-bash", "call-cp", { insertSeq: 2 });
				await checkpoint("cp-boundary", "call-boundary", { insertSeq: 42 });
				// Explicit imports do not advance identity sequences. Match the migration's
				// documented importer convention: setval(42,true), so next native insert is 43.
				for (const table of ["background_tasks", "narrators", "narrator_tool_continuations"]) {
					await client.sql.unsafe(
						`SELECT setval(pg_get_serial_sequence('${table}', 'insert_seq'), 42, true)`,
					);
				}
				const admissions = new Map<string, LegacyCompletionAdmission>();
				for (const id of [
					"done",
					"wrong-outcome",
					"deleted-source",
					"deleted-recipient",
					"capacity-completed",
					"agent-done",
				]) {
					admissions.set(id, {
						...source(
							id,
							id === "agent-done" ? "agent" : "bash",
							id === "deleted-recipient" ? "deleted-parent" : "parent",
						),
						token: {},
						eventKind: "completed",
					});
				}
				const opts = {
					readLegacyRuntimeAdmission: (s: LegacyPublicationSource) =>
						s.taskId === "agent" ? { ...s, startedAtMs: Date.parse(OLD) } : undefined,
					readLegacyCompletionAdmission: (s: LegacyPublicationSource) => admissions.get(s.taskId),
				};
				const store = createPostgresRuntimeQueue(db, opts);
				expect(
					await failed(store.legacy.registerLegacyUnknownBashFailure(source("unknown"))),
				).toBeInstanceOf(RuntimeQueueSchemaPendingError);
				const active = await store.activateLegacyAdmission();
				expect(active).toEqual({
					insertSeqOrdinal: "available",
					pendingSchema: [],
					legacyAdmission: "available",
				});

				stage = "running proofs and duplicate recovery";
				const bashRun = await store.legacy.registerLegacyRunningRunSlots(
					source("bash"),
					{ kind: "persisted_task" },
					{ started: true },
				);
				expect(bashRun.logicalRunId.startsWith("legacy:")).toBe(true);
				expect((await slots("bash")).map((r) => r.eventKind).sort()).toEqual([
					"started",
					"terminal",
				]);
				// Durable registration survives loss of the original runtime evidence.
				expect(
					await store.legacy.registerLegacyRunningRunSlots(source("bash"), { kind: "runtime" }),
				).toEqual(bashRun);
				const agentRun = await store.legacy.registerLegacyRunningRunSlots(
					source("agent", "agent"),
					{ kind: "runtime" },
				);
				expect((await slots("agent")).length).toBe(1);
				expect(agentRun.logicalRunId.startsWith("legacy:")).toBe(true);
				await store.legacy.registerLegacyRunningRunSlots(source("agent-cp", "agent"), {
					kind: "checkpoint",
					checkpointId: "cp-agent",
					updateEpoch: "epoch",
				});
				expect((await slots("agent-cp"))[0]?.eventKind).toBe("terminal");
				expect(
					await failed(
						store.legacy.registerLegacyRunningRunSlots(source("bash-cp"), {
							kind: "checkpoint",
							checkpointId: "cp-bash",
							updateEpoch: "WRONG",
						}),
					),
				).toBeInstanceOf(Error);
				expect(await taskRun("bash-cp")).toBeNull();
				expect(await slots("bash-cp")).toHaveLength(0);
				await store.legacy.registerLegacyRunningRunSlots(source("bash-cp"), {
					kind: "checkpoint",
					checkpointId: "cp-bash",
					updateEpoch: "epoch",
				});
				for (const s of [
					source("bad-proof"),
					source("missing"),
					source("new-protocol"),
					source("bash", "bash", "wrong-parent"),
				]) {
					expect(
						await failed(store.legacy.registerLegacyRunningRunSlots(s, { kind: "persisted_task" })),
					).toBeInstanceOf(Error);
				}
				expect(
					await failed(
						store.legacy.registerLegacyRunningRunSlots(source("no-runtime"), { kind: "runtime" }),
					),
				).toBeInstanceOf(Error);
				expect(await taskRun("bad-proof")).toBeNull();
				expect(await slots("bad-proof")).toHaveLength(0);

				stage = "concurrent dedup and unknown Bash correction delivery";
				const runs = await Promise.all(
					Array.from({ length: 8 }, () =>
						store.legacy.registerLegacyUnknownBashFailure(source("concurrent")),
					),
				);
				expect(new Set(runs.map((r) => r.logicalRunId)).size).toBe(1);
				expect(await slots("concurrent")).toHaveLength(1);
				const unknown = await store.legacy.registerLegacyUnknownBashFailure(source("unknown"));
				expect(unknown.logicalRunId.startsWith("legacy:unknown:")).toBe(true);
				expect((await slots("unknown")).map((r) => r.eventKind)).toEqual(["failed"]);
				expect(await store.legacy.registerLegacyUnknownBashFailure(source("unknown"))).toEqual(
					unknown,
				);
				expect(
					await failed(store.legacy.registerLegacyUnknownBashFailure(source("bash"))),
				).toBeInstanceOf(Error);
				expect(
					await failed(
						store.outbox.commitIntent({
							...unknown,
							eventKind: "completed",
							resultRef: "result:unknown",
							summary: "false success",
						}),
					),
				).toBeInstanceOf(Error);
				await store.outbox.commitIntent({
					...unknown,
					eventKind: "failed",
					resultRef: "result:unknown",
					summary: "must be replaced",
				});
				expect((await store.outbox.transferNext("parent", "bash")).status).toBe("transferred");
				const delivered = await db.execute(
					sql`SELECT text FROM narrator_buffered_messages WHERE dedupe_key = ${publicationDedupeKey(unknown, "failed")}`,
				);
				expect((delivered as unknown as { text: string }[])[0]?.text).toBe(
					LEGACY_UNKNOWN_BASH_FAILURE_SUMMARY,
				);

				stage = "terminal evidence and deleted identities";
				const completed = await store.legacy.registerLegacyCompletedRunSlots(source("done"));
				expect(completed.status).toBe("registered");
				const repeatCompleted = await Promise.all(
					Array.from({ length: 6 }, () =>
						store.legacy.registerLegacyCompletedRunSlots(source("done")),
					),
				);
				for (const r of repeatCompleted) expect(r).toEqual(completed);
				expect(await slots("done")).toHaveLength(1);
				expect(
					(await store.legacy.registerLegacyCompletedRunSlots(source("agent-done", "agent")))
						.status,
				).toBe("registered");
				expect(
					(await store.legacy.registerLegacyCompletedRunSlots(source("wrong-outcome"))).status,
				).toBe("unmigratable");
				expect(
					(await store.legacy.registerLegacyCompletedRunSlots(source("no-evidence"))).status,
				).toBe("unmigratable");
				await db.delete(backgroundTasks).where(eq(backgroundTasks.id, "deleted-source"));
				expect(
					(await store.legacy.registerLegacyCompletedRunSlots(source("deleted-source"))).status,
				).toBe("unmigratable");
				await db.delete(narrators).where(eq(narrators.id, "deleted-parent"));
				expect(
					(
						await store.legacy.registerLegacyCompletedRunSlots(
							source("deleted-recipient", "bash", "deleted-parent"),
						)
					).status,
				).toBe("unmigratable");
				// A frozen queue token cannot be retargeted after its first commit.
				const doneAdmission = admissions.get("done");
				if (!doneAdmission) throw new Error("fixture admission missing");
				admissions.set("wrong-outcome", {
					...source("wrong-outcome"),
					token: doneAdmission.token,
					eventKind: "failed",
				});
				expect(
					(await store.legacy.registerLegacyCompletedRunSlots(source("wrong-outcome"))).status,
				).toBe("unmigratable");

				stage = "rollback after source write (real SQLSTATE)";
				// Inject a failing statement AFTER the real source UPDATE but before the
				// outbox INSERT. Still the real database transaction: no production DDL patch.
				let fault: "division" | "unique" | "serialization" | undefined = "division";
				let faultHits = 0;
				const injected = new Proxy(db, {
					get(target, key, receiver) {
						if (key !== "transaction") return Reflect.get(target, key, receiver);
						return (section: (tx: unknown) => Promise<unknown>) =>
							target.transaction((tx) =>
								section(
									new Proxy(tx, {
										get(inner, name, recv) {
											if (name !== "insert") return Reflect.get(inner, name, recv);
											return (table: unknown) => {
												if (table === outbox && fault) {
													const selected = fault;
													fault = undefined;
													faultHits += 1;
													return {
														values: () =>
															selected === "division"
																? inner.execute(sql`SELECT 1 / 0`)
																: selected === "unique"
																	? inner.execute(
																			sql`INSERT INTO runtime_publication_outbox SELECT * FROM runtime_publication_outbox WHERE task_id = 'concurrent'`,
																		)
																	: inner.execute(
																			sql`DO $$ BEGIN RAISE EXCEPTION 'test rollback' USING ERRCODE = '40001'; END $$`,
																		),
													};
												}
												return inner.insert(table as typeof outbox);
											};
										},
									}),
								),
							);
					},
				}) as BunSQLDatabase;
				const rollbackStore = createPostgresRuntimeQueue(injected, opts);
				await rollbackStore.activateLegacyAdmission();
				const failure = await failed(
					rollbackStore.legacy.registerLegacyUnknownBashFailure(source("rollback")),
				);
				expect(classifyPgError(failure).sqlstate).toBe("22012");
				expect(await taskRun("rollback")).toBeNull();
				expect(await slots("rollback")).toHaveLength(0);
				await rollbackStore.legacy.registerLegacyUnknownBashFailure(source("rollback"));
				expect(await slots("rollback")).toHaveLength(1);
				fault = "unique";
				const conflict = await failed(
					rollbackStore.legacy.registerLegacyUnknownBashFailure(source("unique-fault")),
				);
				expect(conflict).toBeInstanceOf(WriteConflictError);
				expect(classifyPgError(conflict).sqlstate).toBe("23505");
				expect(await taskRun("unique-fault")).toBeNull();
				expect(await slots("unique-fault")).toHaveLength(0);
				fault = "serialization";
				await rollbackStore.legacy.registerLegacyUnknownBashFailure(source("serialize-fault"));
				expect(await slots("serialize-fault")).toHaveLength(1);
				expect(await taskRun("serialize-fault")).toBe(
					(await slots("serialize-fault"))[0]?.logicalRunId,
				);
				expect(faultHits).toBe(3);

				stage = "post-boundary identities cannot impersonate old sources";
				await task("late-bash");
				await narrator("late-agent", {
					type: "subagent",
					parentNarratorId: "parent",
					status: "working",
					turnStartedAt: OLD,
				});
				await checkpoint("late-cp", "call-late-cp");
				const lateOrdinals = await client.sql.unsafe(`SELECT
					(SELECT insert_seq FROM background_tasks WHERE id='late-bash') AS b,
					(SELECT insert_seq FROM narrators WHERE id='late-agent') AS n,
					(SELECT insert_seq FROM narrator_tool_continuations WHERE id='late-cp') AS c`);
				expect([
					Number(lateOrdinals[0].b),
					Number(lateOrdinals[0].n),
					Number(lateOrdinals[0].c),
				]).toEqual([43, 43, 43]);
				// Backdated timestamps deliberately pass the timestamp guard; the ordinal
				// boundary MUST reject. Identity=42 import -> setval -> native 43 is safe.
				expect(
					await failed(store.legacy.registerLegacyUnknownBashFailure(source("late-bash"))),
				).toBeInstanceOf(Error);
				expect(
					await failed(
						store.legacy.registerLegacyRunningRunSlots(source("late-agent", "agent"), {
							kind: "runtime",
						}),
					),
				).toBeInstanceOf(Error);
				expect(
					await failed(
						store.legacy.registerLegacyRunningRunSlots(source("late-cp-source"), {
							kind: "checkpoint",
							checkpointId: "late-cp",
							updateEpoch: "epoch",
						}),
					),
				).toBeInstanceOf(Error);
				expect(await slots("late-bash")).toHaveLength(0);
				const rebuilt = createPostgresRuntimeQueue(db, opts);
				await rebuilt.activateLegacyAdmission();
				expect(
					await failed(rebuilt.legacy.registerLegacyUnknownBashFailure(source("late-bash"))),
				).toBeInstanceOf(Error);

				stage = "grandfathered capacity obligations do not vanish at quotas";
				await client.sql.unsafe(`INSERT INTO runtime_publication_outbox
					(id,producer_kind,task_id,logical_run_id,event_kind,recipient_id,delivery_id,dedupe_key,created_at,updated_at)
					SELECT 'fill-'||g,'bash','fill-'||g,'fill-run-'||g,'terminal','parent','fill-dv-'||g,'fill-dk-'||g,'${OLD}','${OLD}'
					FROM generate_series(1,1000) AS g`);
				expect(
					(
						await store.outbox.reserveRunSlots({
							producerKind: "bash",
							taskId: "fresh",
							logicalRunId: "fresh-run",
							recipientId: "parent",
						})
					).status,
				).toBe("full");
				await store.legacy.registerLegacyUnknownBashFailure(source("capacity"));
				expect(await slots("capacity")).toHaveLength(1);
				expect(
					(await store.legacy.registerLegacyCompletedRunSlots(source("capacity-completed"))).status,
				).toBe("registered");
				expect(await slots("capacity-completed")).toHaveLength(1);
				stage = "activation cancellation and lock timeout";
				const freshHandle = () => new Proxy(db, {}) as BunSQLDatabase;
				const cancelledStore = createPostgresRuntimeQueue(freshHandle());
				const aborted = new AbortController();
				aborted.abort(new Error("cancel activation"));
				expect(
					await failed(cancelledStore.activateLegacyAdmission({ signal: aborted.signal })),
				).toBeInstanceOf(Error);
				expect(cancelledStore.schemaReadiness.legacyAdmission).toBe("blocked");
				// Hold an ordinary source write: activation's SHARE table lock must wait,
				// then fail within its server-side timeout without publishing a cutoff.
				let releaseWriter = () => {};
				let writerReady = () => {};
				const released = new Promise<void>((resolve) => {
					releaseWriter = resolve;
				});
				const ready = new Promise<void>((resolve) => {
					writerReady = resolve;
				});
				const writer = client.sql.begin(async (tx) => {
					await tx.unsafe(
						"UPDATE background_tasks SET updated_at = updated_at WHERE id = 'capacity'",
					);
					writerReady();
					await released;
				});
				await ready;
				const blockedStore = createPostgresRuntimeQueue(freshHandle());
				try {
					const started = Date.now();
					const blocked = await failed(blockedStore.activateLegacyAdmission({ timeoutMs: 150 }));
					expect(blocked).toBeInstanceOf(Error);
					expect(Date.now() - started).toBeLessThan(3000);
					expect(blockedStore.schemaReadiness.legacyAdmission).toBe("blocked");
				} finally {
					releaseWriter();
					await writer;
				}
				// Failure has no sticky success or late background activation. A deliberate
				// startup retry after the writer is released captures the boundary once.
				expect((await blockedStore.activateLegacyAdmission()).legacyAdmission).toBe("available");
				return "verified";
			} catch (error) {
				return `failure at ${stage}: ${error instanceof Error ? error.message : String(error)}`;
			} finally {
				await client.close();
			}
		});
		expect(result).toBe("verified");
	},
	300_000,
);
