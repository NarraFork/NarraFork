import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { splitEnvelope } from "@shared/narrator-blocks/storage";
import { eq } from "drizzle-orm";
import { cleanDb, readTestMessageContent } from "../../../tests/setup";
import {
	backgroundTasks,
	narratorBufferedMessages as mailbox,
	narratorMessages as messages,
	narratorBlocks,
	narrators,
	runtimePublicationOutbox as outbox,
	narratorMessageRefs as refs,
} from "../../db/schema";
import * as workerRead from "../../db/worker-read";
import * as pool from "../../lib/db-worker/pool";
import { settings } from "../../lib/settings";
import { closeRuntimeTestDb, getRuntimeTestDb as getTestDb } from "./agent-runtime-test-database";
import { captureWorkerRejection } from "./narrator-worker-fixture";

const { db, sqlite, ready } = getTestDb();
await ready;
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite, activeDatabaseBackend: "sqlite" }));
const { createRuntimePublicationService, getRuntimePublicationService, runtimePublication } =
	await import("../agent-runtime/publication");
runtimePublication.stop();
const service = createRuntimePublicationService(db);
const time = "2026-10-02T00:00:00.000Z";

for (const change of ["run", "registration", "status", "cancelled", "missing"] as const) {
	test(`recovery admission rejects ${change} changed after its Worker observation`, async () => {
		const { RESTART_NARRATOR_COLUMNS } = await import("../recovery-observation");
		const observed = await workerRead.readQueryFirst(
			db.query.narrators.findMany({
				where: eq(narrators.id, "actor"),
				columns: RESTART_NARRATOR_COLUMNS,
				limit: 1,
			}),
			{ executionPolicy: "worker-required", maxRows: 1 },
		);
		expect(observed).toBeDefined();
		if (!observed) throw new Error("Fixture actor missing");
		db.update(narrators)
			.set({ status: "working", substatus: "[]", updatedAt: new Date().toISOString() })
			.where(eq(narrators.id, "actor"))
			.run();
		if (change === "run")
			db.update(narrators)
				.set({ logicalRunId: "concurrent-run" })
				.where(eq(narrators.id, "actor"))
				.run();
		if (change === "registration")
			db.update(narrators)
				.set({
					runtimeRegistrationJson: {
						version: 1,
						controller: { narratorId: "parent", actions: ["stop"] },
					},
				})
				.where(eq(narrators.id, "actor"))
				.run();
		if (change === "status")
			db.update(narrators).set({ status: "archived" }).where(eq(narrators.id, "actor")).run();
		if (change === "cancelled")
			db.update(narrators)
				.set({ substatus: '["cancelled"]' })
				.where(eq(narrators.id, "actor"))
				.run();
		if (change === "missing") db.delete(narrators).where(eq(narrators.id, "actor")).run();
		expect(() =>
			service.startRun({ narratorId: "actor", binding: {}, recoveryObservation: observed }),
		).toThrow(expect.objectContaining({ statusCode: 409, code: "RUNTIME_READ_CONFLICT" }));
		expect(db.select().from(outbox).all()).toHaveLength(0);
	});
}

test("recovery admission tolerates its own status transition and renewal-only timestamps", async () => {
	const { RESTART_NARRATOR_COLUMNS } = await import("../recovery-observation");
	const observed = await workerRead.readQueryFirst(
		db.query.narrators.findMany({
			where: eq(narrators.id, "actor"),
			columns: RESTART_NARRATOR_COLUMNS,
			limit: 1,
		}),
		{ executionPolicy: "worker-required", maxRows: 1 },
	);
	if (!observed) throw new Error("Fixture actor missing");
	db.update(narrators)
		.set({ status: "working", substatus: "[]", updatedAt: new Date().toISOString() })
		.where(eq(narrators.id, "actor"))
		.run();
	expect(
		service.startRun({ narratorId: "actor", binding: {}, recoveryObservation: observed }).binding
			.logicalRunId,
	).toBeTruthy();
});

function assistant(id: string, text: string, seq: number) {
	db.insert(messages)
		.values({
			id,
			narratorId: "actor",
			role: "assistant",
			contentText: text,
			contentJson: [{ type: "text", text }],
			createdAt: time,
		})
		.run();
	db.insert(refs)
		.values({ id: `ref:${id}`, narratorId: "actor", messageId: id, seq })
		.run();
}
function start() {
	return service.startRun({
		narratorId: "actor",
		binding: { deliverTo: { narratorId: "parent", toolUseId: "test-tool-use" } },
	}).publication!;
}

test("publication state batches preserve identity order within the Worker SQL budget", async () => {
	const committed = start();
	snapshot(committed, "answer");
	const runs = Array.from({ length: 21 }, (_, index) =>
		index === 10
			? committed
			: {
					producerKind: "agent" as const,
					taskId: `task-${index}`,
					logicalRunId: `run-${index}`,
					recipientId: "parent",
				},
	);
	const original = pool.runReadTask;
	let calls = 0;
	const signal = new AbortController().signal;
	const deadlineAt = Date.now() + 10_000;
	const probe = spyOn(pool, "runReadTask").mockImplementation(((path, params, options) => {
		if (params.kind === "selectRows" || params.kind === "selectValues") {
			calls++;
			expect(Buffer.byteLength(params.sql)).toBeLessThanOrEqual(64 * 1024);
			expect(options).toMatchObject({ signal, deadlineAt, timeoutMs: 2_000 });
		}
		return original(path, params, options);
	}) as typeof pool.runReadTask);
	try {
		const states = await service.readRunPublicationStates(runs, {
			signal,
			deadlineAt,
			timeoutMs: 2_000,
		});
		expect(states).toHaveLength(21);
		expect(states[10]).toEqual({ state: "settled", eventKind: "completed" });
		expect(states.filter((state) => state.state === "none")).toHaveLength(20);
		expect(calls).toBe(3);
		expect(await service.readRunPublicationStates([])).toEqual([]);
		const failure = new Error("publication batch failed");
		probe.mockImplementation(() => Promise.reject(failure));
		expect(await captureWorkerRejection(service.readRunPublicationStates(runs))).toBe(failure);
	} finally {
		probe.mockRestore();
	}
});

test.each([
	{ name: "default", timeoutMs: undefined, withDeadline: false, expectedTimeoutMs: 5_000 },
	{ name: "shorter", timeoutMs: 2_000, withDeadline: true, expectedTimeoutMs: 2_000 },
	{ name: "capped", timeoutMs: 10_000, withDeadline: true, expectedTimeoutMs: 5_000 },
])("committed terminal reads forward only the $name Worker budget", async (budget) => {
	const run = start();
	const signal = new AbortController().signal;
	const deadlineAt = budget.withDeadline ? Date.now() + 10_000 : undefined;
	const observation = {
		ownerNarratorId: "parent",
		signal,
		timeoutMs: budget.timeoutMs,
		...(deadlineAt !== undefined ? { deadlineAt } : {}),
	};
	const dispatch = spyOn(pool, "runReadTask");
	try {
		const publication = getRuntimePublicationService();
		expect(await publication.readAgentTerminalResult(run, {}, observation)).toBeNull();
		snapshot(run, "COMMITTED ANSWER");
		expect(await publication.readAgentTerminalResult(run, {}, observation)).toEqual({
			output: "COMMITTED ANSWER",
		});
		expect(dispatch).toHaveBeenCalledWith(
			sqlite.filename,
			expect.objectContaining({ kind: "publicationTerminalResult", run }),
			{
				signal,
				timeoutMs: budget.expectedTimeoutMs,
				...(deadlineAt !== undefined ? { deadlineAt } : {}),
			},
		);
		const failure = new Error("terminal Worker read failed");
		dispatch.mockRejectedValueOnce(failure);
		expect(
			await captureWorkerRejection(publication.readAgentTerminalResult(run, {}, observation)),
		).toBe(failure);
	} finally {
		dispatch.mockRestore();
	}
});

function snapshot(run: ReturnType<typeof start>, text: string, commit = true) {
	return db.transaction((tx) => {
		const resultRef = service.persistResult(run, text, tx);
		if (commit) service.commit({ ...run, eventKind: "completed", resultRef, summary: "done" }, tx);
		return resultRef;
	});
}
beforeEach(() => {
	cleanDb(sqlite);
	db.insert(narrators)
		.values([
			{ id: "parent", createdAt: time, updatedAt: time },
			{
				id: "actor",
				type: "subagent",
				variant: "subagent:general",
				parentNarratorId: "parent",
				status: "idle",
				createdAt: time,
				updatedAt: time,
			},
		])
		.run();
});
afterAll(async () => {
	service.stop();
	await closeRuntimeTestDb(sqlite);
	mock.restore();
});

test("publication state is read in a Worker independently from terminal body readability", async () => {
	const run = start();
	const read = spyOn(workerRead, "readDbAll");
	const ownerQuery = spyOn(sqlite, "query").mockImplementation(() => {
		throw new Error("Publication observations must not SELECT on the owner connection");
	});
	try {
		expect(await service.readRunPublicationState(run)).toEqual({ state: "reserved" });
		expect(await service.readAgentTerminalResult(run)).toBeNull();
		expect(read).toHaveBeenCalledTimes(1);
		expect(read.mock.calls[0]?.[2]).toMatchObject({
			executionPolicy: "worker-required",
			maxRows: 1,
		});
		expect(ownerQuery).not.toHaveBeenCalled();
	} finally {
		ownerQuery.mockRestore();
		read.mockRestore();
	}
	snapshot(run, "RESULT");
	db.delete(refs)
		.where(eq(refs.messageId, `publication-result:${run.logicalRunId}`))
		.run();
	db.delete(messages)
		.where(eq(messages.id, `publication-result:${run.logicalRunId}`))
		.run();
	expect(await service.readAgentTerminalResult(run)).toBeNull();
	expect(await service.readRunPublicationState(run)).toEqual({
		state: "settled",
		eventKind: "completed",
	});
	service.consumeAwaitedTerminal(run);
	db.delete(mailbox).run();
	db.delete(outbox).run();
	expect(await service.readRunPublicationState(run)).toEqual({ state: "settled" });
	expect(await service.readRunPublicationState({ ...run, logicalRunId: "different-run" })).toEqual({
		state: "none",
	});
});

function taskProjection() {
	return {
		id: "task-projection",
		parentNarratorId: "parent",
		type: "agent" as const,
		status: "completed" as const,
		subagentNarratorId: "actor",
		logicalRunId: "old-task-run",
		startedAt: time,
		createdAt: time,
		updatedAt: time,
	};
}

function afterTaskPreflight(mutate: () => void) {
	const original = workerRead.readQueryFirst;
	let changed = false;
	async function read<T>(
		query: PromiseLike<T[]> & { toSQL(): { sql: string; params: unknown[] } },
		options?: workerRead.ReadQueryOptions,
	): Promise<T | undefined> {
		const row = await original(query, options);
		if (!changed && query.toSQL().sql.includes("background_tasks")) {
			changed = true;
			mutate();
		}
		return row;
	}
	return spyOn(workerRead, "readQueryFirst").mockImplementation(read);
}

test("task projection rejects a destination changed after the Worker snapshot", async () => {
	const first = start();
	const snapshot = await workerRead.readQueryFirst(
		db.query.narrators.findMany({
			limit: 1,
			where: eq(narrators.id, "actor"),
			columns: { runtimeRegistrationJson: true },
		}),
		{ executionPolicy: "worker-required", maxRows: 1 },
	);
	const destination = snapshot?.runtimeRegistrationJson?.run?.deliverTo;
	if (!destination) throw new Error("Missing registered destination");
	db.insert(narrators).values({ id: "other", createdAt: time, updatedAt: time }).run();
	const next = service.startRun({
		narratorId: "actor",
		binding: {
			deliverTo: { narratorId: "other", toolUseId: "new-tool" },
		},
	});
	expect(next.binding.logicalRunId).not.toBe(first.logicalRunId);
	const registered = db
		.select()
		.from(narrators)
		.where(eq(narrators.id, "actor"))
		.get()?.runtimeRegistrationJson;
	expect(() =>
		service.startRun({
			narratorId: "actor",
			binding: { deliverTo: destination },
			taskRow: taskProjection(),
		}),
	).toThrow("Stale task publication destination");
	expect(
		db.select().from(backgroundTasks).where(eq(backgroundTasks.id, "task-projection")).get(),
	).toBeUndefined();
	expect(
		db.select().from(narrators).where(eq(narrators.id, "actor")).get()?.runtimeRegistrationJson,
	).toEqual(registered);
});

for (const changed of ["logicalRun", "destination", "taskGeneration"] as const) {
	test(`restart rejects changed ${changed} after its Worker preflight`, async () => {
		const run = start();
		db.insert(backgroundTasks).values(taskProjection()).run();
		let registered: (typeof narrators.$inferSelect)["runtimeRegistrationJson"] | undefined;
		const probe = afterTaskPreflight(() => {
			if (changed === "logicalRun") start();
			else if (changed === "destination") {
				const current = db
					.select()
					.from(narrators)
					.where(eq(narrators.id, "actor"))
					.get()?.runtimeRegistrationJson;
				const currentRun = current?.run;
				if (!current || !currentRun) throw new Error("Missing registered actor run");
				db.update(narrators)
					.set({
						runtimeRegistrationJson: {
							...current,
							run: {
								...currentRun,
								deliverTo: { narratorId: "parent", toolUseId: "replacement-tool" },
							},
						},
					})
					.where(eq(narrators.id, "actor"))
					.run();
			} else
				db.update(backgroundTasks)
					.set({ logicalRunId: "replacement-task-run" })
					.where(eq(backgroundTasks.id, "task-projection"))
					.run();
			registered = db
				.select()
				.from(narrators)
				.where(eq(narrators.id, "actor"))
				.get()?.runtimeRegistrationJson;
		});
		try {
			const error = await getRuntimePublicationService()
				.restartAgentTask({
					taskId: "task-projection",
					logicalRunId: run.logicalRunId,
					subagentNarratorId: "actor",
					subagentType: "general",
					toolUseId: "test-tool-use",
					expectedStatus: "completed",
					now: time,
				})
				.catch((error) => error);
			expect(error).toMatchObject({ code: "RUNTIME_READ_CONFLICT", statusCode: 409 });
			expect(
				db.select().from(backgroundTasks).where(eq(backgroundTasks.id, "task-projection")).get()
					?.status,
			).toBe("completed");
			expect(
				db.select().from(narrators).where(eq(narrators.id, "actor")).get()?.runtimeRegistrationJson,
			).toEqual(registered);
		} finally {
			probe.mockRestore();
		}
	});
}

test("restart projects the registered actor run when the task has a distinct ID", async () => {
	const run = start();
	db.insert(backgroundTasks).values(taskProjection()).run();
	expect(
		await getRuntimePublicationService().restartAgentTask({
			taskId: "task-projection",
			logicalRunId: run.logicalRunId,
			subagentNarratorId: "actor",
			subagentType: "general",
			toolUseId: "test-tool-use",
			expectedStatus: "completed",
			now: time,
		}),
	).toEqual({ id: "task-projection" });
	expect(
		db.select().from(backgroundTasks).where(eq(backgroundTasks.id, "task-projection")).get(),
	).toMatchObject({ status: "running", logicalRunId: run.logicalRunId });
});

test("foreground terminal persists then consumes atomically, preserves source and never publishes notices", async () => {
	const facade = getRuntimePublicationService();
	const run = (
		await facade.startRun({
			narratorId: "actor",
			binding: { deliverTo: { narratorId: "parent", toolUseId: "test-tool-use" } },
		})
	).publication!;
	const output = `FIRST ${"x".repeat(40_000)}`;
	assistant("foreground-current", output, 0);
	const input = {
		run,
		eventKind: "completed" as const,
		text: output,
		summary: "done",
		delivery: "foreground" as const,
	};
	expect(await facade.commitAgentTerminal(input)).toMatchObject({
		status: "committed",
		deliveryId: null,
	});
	expect(await facade.commitAgentTerminal({ ...input, text: "DRIFT" })).toMatchObject({
		status: "duplicate",
	});
	expect(await facade.readAgentTerminalResult(run)).toMatchObject({
		sourceResultRef: "message:foreground-current",
	});
	expect((await facade.readAgentTerminalResult(run))?.output).toContain("FIRST");
	expect(db.select().from(outbox).all()).toHaveLength(0);
	expect(db.select().from(mailbox).all()).toHaveLength(0);
	const next = (
		await facade.startRun({
			narratorId: "actor",
			binding: { deliverTo: { narratorId: "parent", toolUseId: "test-tool-use" } },
		})
	).publication!;
	await facade.commitAgentTerminal({
		...input,
		run: next,
		eventKind: "failed",
		text: "SECOND FAILURE",
	});
	expect(await facade.readAgentTerminalResult(next)).toEqual({ output: "SECOND FAILURE" });
	expect((await facade.readAgentTerminalResult(run))?.sourceResultRef).toBe(
		"message:foreground-current",
	);
	expect(await facade.readAgentTerminalResult({ ...next, recipientId: "wrong" })).toBeNull();
	// Consumption failure must roll back the snapshot/ref/counters, not leave a half receipt.
	const failed = (
		await facade.startRun({
			narratorId: "actor",
			binding: { deliverTo: { narratorId: "parent", toolUseId: "test-tool-use" } },
		})
	).publication!;
	sqlite.exec(
		"CREATE TRIGGER fail_foreground_consumption BEFORE INSERT ON runtime_awaited_terminal_consumptions BEGIN SELECT RAISE(ABORT, 'receipt failure'); END",
	);
	try {
		await expect(facade.commitAgentTerminal({ ...input, run: failed })).rejects.toThrow(
			"receipt failure",
		);
		expect(
			db
				.select()
				.from(messages)
				.where(eq(messages.id, `publication-result:${failed.logicalRunId}`))
				.get(),
		).toBeUndefined();
		expect(await facade.readAgentTerminalResult(failed)).toBeNull();
	} finally {
		sqlite.exec("DROP TRIGGER fail_foreground_consumption");
		await facade.releaseUnusedRunSlots(failed);
	}
});

test("readonly result lookup never adopts old history/compact or initial idle as a terminal result", async () => {
	assistant("old", "OLD RESULT", 0);
	db.insert(messages)
		.values({
			id: "compact",
			narratorId: "actor",
			role: "system",
			contentText: "OLD SUMMARY",
			contentJson: [{ type: "compact", summary: "OLD SUMMARY" }],
			createdAt: time,
		})
		.run();
	db.insert(refs)
		.values({
			id: "compact-ref",
			narratorId: "actor",
			messageId: "compact",
			seq: 1,
			isCompact: 1,
		})
		.run();
	const run = start();
	const before = db.select().from(outbox).all();
	expect(await service.readAgentTerminalResult(run)).toBeNull();
	expect(await service.readAgentTerminalResult(run, { settledRunId: run.logicalRunId })).toBeNull();
	assistant("current", "CURRENT RUN RESULT", 2);
	expect(await service.readAgentTerminalResult(run)).toBeNull();
	expect(await service.readAgentTerminalResult(run, { settledRunId: "different-run" })).toBeNull();
	for (const status of ["working", "waiting"] as const) {
		db.update(narrators).set({ status }).where(eq(narrators.id, "actor")).run();
		expect(
			await service.readAgentTerminalResult(run, { settledRunId: run.logicalRunId }),
		).toBeNull();
	}
	db.update(narrators).set({ status: "idle" }).where(eq(narrators.id, "actor")).run();
	expect(await service.readAgentTerminalResult(run, { settledRunId: run.logicalRunId })).toEqual({
		output: "CURRENT RUN RESULT",
		sourceResultRef: "message:current",
	});
	expect(db.select().from(outbox).all()).toEqual(before);
	start();
	expect(await service.readAgentTerminalResult(run, { settledRunId: run.logicalRunId })).toBeNull();
});

test("snapshot requires committed terminal proof and remains readable after consume/GC without UI-edit drift", async () => {
	const run = start();
	const resultRef = snapshot(run, "IMMUTABLE RUN RESULT", false);
	expect(await service.readAgentTerminalResult(run)).toBeNull();
	db.transaction((tx) =>
		service.commit({ ...run, eventKind: "completed", resultRef, summary: "done" }, tx),
	);
	expect(await service.readAgentTerminalResult(run)).toEqual({ output: "IMMUTABLE RUN RESULT" });
	const id = `publication-result:${run.logicalRunId}`;
	const original = readTestMessageContent(sqlite, id);
	db.update(messages)
		.set({
			originalContentJson: original,
			contentJson: [{ type: "text", text: "EDITED" }],
			contentText: "EDITED",
		})
		.where(eq(messages.id, id))
		.run();
	expect(await service.readAgentTerminalResult(run)).toEqual({ output: "IMMUTABLE RUN RESULT" });
	service.consumeAwaitedTerminal(run);
	db.delete(mailbox).run();
	expect(await service.readAgentTerminalResult(run)).toEqual({ output: "IMMUTABLE RUN RESULT" });
	expect(await service.readAgentTerminalResult({ ...run, logicalRunId: "different" })).toBeNull();
	expect(await service.readAgentTerminalResult({ ...run, recipientId: "other-parent" })).toBeNull();
	db.update(messages)
		.set({ originalContentJson: [{ type: "text", text: "x".repeat(300_000) }] })
		.where(eq(messages.id, id))
		.run();
	expect(await service.readAgentTerminalResult(run)).toBeNull();
});

test("Worker terminal receipt honors restored JSON when block reads are disabled", async () => {
	const run = start();
	snapshot(run, "RESTORED JSON");
	const id = `publication-result:${run.logicalRunId}`;
	const restored = readTestMessageContent(sqlite, id);
	const [block] = splitEnvelope({
		id,
		narratorId: "actor",
		role: "disp",
		contentJson: readTestMessageContent(sqlite, id),
		contentText: "RESTORED JSON",
		parentToolUseId: null,
	}).blocks;
	if (!block) throw new Error("Missing receipt block");
	db.delete(narratorBlocks).where(eq(narratorBlocks.messageId, id)).run();
	db.insert(narratorBlocks)
		.values({
			id: "rollback-block",
			messageId: id,
			ordinal: 0,
			kind: block.kind,
			subtype: block.subtype,
			phase: block.phase,
			payload: JSON.parse(JSON.stringify(block.payload).replaceAll("RESTORED JSON", "STALE BLOCK")),
			state: block.state,
			createdAt: time,
		})
		.run();
	db.update(messages)
		.set({ bodyFormat: 2, bodyRowsOnly: 0, contentJson: restored })
		.where(eq(messages.id, id))
		.run();
	sqlite.run("DELETE FROM narrator_block_sync_queue WHERE message_id = ?", [id]);
	const previous = settings.narratorBlocks.read;
	try {
		settings.narratorBlocks.read = false;
		expect(await service.readAgentTerminalResult(run)).toEqual({ output: "RESTORED JSON" });
		settings.narratorBlocks.read = true;
		expect(await service.readAgentTerminalResult(run)).toEqual({ output: "STALE BLOCK" });
	} finally {
		settings.narratorBlocks.read = previous;
	}
});

test("rows-only terminal receipt uses its bounded body while original output stays authoritative", async () => {
	const run = start();
	snapshot(run, "ORIGINAL RECEIPT");
	const id = `publication-result:${run.logicalRunId}`;
	const stored = db.select().from(messages).where(eq(messages.id, id)).get();
	const body = readTestMessageContent(sqlite, id);
	expect(body).toHaveLength(1);
	const [block] = splitEnvelope({
		id,
		narratorId: "actor",
		role: "disp",
		contentJson: body,
		contentText: stored?.contentText ?? null,
		parentToolUseId: null,
	}).blocks;
	if (!block) throw new Error("Receipt fixture requires a stored block");
	db.delete(narratorBlocks).where(eq(narratorBlocks.messageId, id)).run();
	db.insert(narratorBlocks)
		.values({
			id: `receipt-block:${run.logicalRunId}`,
			messageId: id,
			ordinal: 0,
			kind: block.kind,
			subtype: block.subtype,
			phase: block.phase,
			payload: block.payload,
			state: block.state,
			createdAt: time,
		})
		.run();
	db.update(messages)
		.set({ bodyFormat: 2, bodyRowsOnly: 1, contentJson: [] })
		.where(eq(messages.id, id))
		.run();
	const previousRead = settings.narratorBlocks.read;
	try {
		settings.narratorBlocks.read = false;
		expect(await service.readAgentTerminalResult(run)).toEqual({ output: "ORIGINAL RECEIPT" });
	} finally {
		settings.narratorBlocks.read = previousRead;
	}
	db.update(messages).set({ originalContentJson: body }).where(eq(messages.id, id)).run();
	db.update(narratorBlocks)
		.set({ payload: { raw: [{ type: "text", text: "EDITED BODY" }] } })
		.where(eq(narratorBlocks.messageId, id))
		.run();
	expect(await service.readAgentTerminalResult(run)).toEqual({ output: "ORIGINAL RECEIPT" });
	db.update(messages)
		.set({ originalContentJson: [{ type: "text", text: "x".repeat(300_000) }] })
		.where(eq(messages.id, id))
		.run();
	expect(await service.readAgentTerminalResult(run)).toBeNull();
});

test("queued/cancelled mailbox dedupe is a terminal authority even after outbox transfer and actor restart", async () => {
	const run = start();
	snapshot(run, "FIRST RUN");
	service.store.transferNext("parent", "agent");
	expect(await service.readAgentTerminalResult(run)).toEqual({ output: "FIRST RUN" });
	db.update(mailbox).set({ state: "cancelled", text: "", metadataJson: null }).run();
	const next = start();
	expect(await service.readAgentTerminalResult(run)).toEqual({ output: "FIRST RUN" });
	expect(await service.readAgentTerminalResult(next)).toBeNull();
});

test("Worker result projections preserve leading BOM, whitespace and Unicode exactly", async () => {
	const run = start();
	const text = "\uFEFF  exact\r\n故障🙂  ";
	assistant("exact-source", text, 0);
	sqlite
		.prepare("UPDATE narrator_messages SET content_text = CAST(? AS TEXT) WHERE id = ?")
		.run(Buffer.from(text), "exact-source");
	expect(await service.readAgentTerminalResult(run, { settledRunId: run.logicalRunId })).toEqual({
		output: text,
		sourceResultRef: "message:exact-source",
	});
	snapshot(run, text);
	expect(await service.readAgentTerminalResult(run)).toEqual({
		output: text,
		sourceResultRef: "message:exact-source",
	});
});

test("foreground deferred getter → consume → late commit preserves the actual full-source message", async () => {
	const run = start();
	const text = `FOREGROUND RESULT ${"x".repeat(40_000)}`;
	assistant("foreground-source", text, 0);
	const result = await service.readAgentTerminalResult(run, { settledRunId: run.logicalRunId });
	expect(result?.output).toContain("Output truncated.");
	expect(result?.sourceResultRef).toBe("message:foreground-source");
	start(); // Start a new run BEFORE consumption to exercise read→consume ABA.
	assistant("future-source", "FUTURE RUN RESULT", 1);
	service.consumeAwaitedTerminal(run, { sourceResultRef: result?.sourceResultRef });
	service.consumeAwaitedTerminal(run, { sourceResultRef: "message:future-source" }); // first receipt wins
	expect((await service.readAgentTerminalResult(run))?.sourceResultRef).toBe(
		"message:foreground-source",
	);
	snapshot(run, text);
	const body = readTestMessageContent<{ publicationResult?: { sourceResultRef?: string } }>(
		sqlite,
		`publication-result:${run.logicalRunId}`,
	);
	const block = body[0];
	expect(block?.publicationResult?.sourceResultRef).toBe("message:foreground-source");
	expect((await service.readAgentTerminalResult(run))?.output).toContain("Output truncated.");
});

test("deferred assistant output is source-after-only and bounded; absent/thinking-only output is not received", async () => {
	const run = start();
	assistant("large", "x".repeat(300_000), 0);
	expect(await service.readAgentTerminalResult(run)).toBeNull();
	expect(
		(await service.readAgentTerminalResult(run, { settledRunId: run.logicalRunId }))?.output,
	).toHaveLength(12_000);
	db.update(messages)
		.set({
			originalContentJson: [{ type: "text", text: "BEFORE EDIT" }],
			contentText: "AFTER EDIT",
		})
		.where(eq(messages.id, "large"))
		.run();
	expect(await service.readAgentTerminalResult(run, { settledRunId: run.logicalRunId })).toEqual({
		output: "BEFORE EDIT",
		sourceResultRef: "message:large",
	});
	db.update(messages)
		.set({
			originalContentJson: null,
			contentText: "",
			contentJson: [{ type: "thinking", thinking: "no result" }],
		})
		.where(eq(messages.id, "large"))
		.run();
	expect(await service.readAgentTerminalResult(run, { settledRunId: run.logicalRunId })).toBeNull();
});
