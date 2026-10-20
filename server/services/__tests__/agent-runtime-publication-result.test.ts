import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { openSchemaCopyAt } from "../../../tests/sqlite-schema-image";
import {
	narratorBufferedMessages as mailbox,
	narratorMessages as messages,
	narrators,
	runtimePublicationOutbox as outbox,
	narratorMessageRefs as refs,
} from "../../db/schema";
import { closeDbWorkerConnections, runReadTask } from "../../lib/db-worker/pool";
import { runPublicationTerminalResultRead } from "../agent-runtime/publication-result-read";

const { db, sqlite } = getTestDb();
mock.module("../../db", () => ({ db, sqlite, activeDatabaseBackend: "sqlite" }));
const { createRuntimePublicationService, getRuntimePublicationService, runtimePublication } =
	await import("../agent-runtime/publication");
runtimePublication.stop();
const service = createRuntimePublicationService(db);
const time = "2026-10-02T00:00:00.000Z";
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
afterAll(() => {
	service.stop();
	sqlite.close();
	mock.restore();
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
	const original = db.select().from(messages).where(eq(messages.id, id)).get()?.contentJson;
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
	const stored = db
		.select()
		.from(messages)
		.where(eq(messages.id, `publication-result:${run.logicalRunId}`))
		.get();
	const body = stored?.contentJson as
		| Array<{ publicationResult?: { sourceResultRef?: string } }>
		| undefined;
	const block = body?.[0];
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

test("file-backed terminal task returns the same bounded immutable result as its local snapshot", async () => {
	const dir = await mkdtemp(join(tmpdir(), "nf-publication-read-"));
	const path = join(dir, "fixture.db");
	const file = openSchemaCopyAt(sqlite, path);
	try {
		file.exec("PRAGMA journal_mode=WAL");
		const local = drizzle(file);
		local
			.insert(narrators)
			.values([
				{ id: "parent", createdAt: time, updatedAt: time },
				{
					id: "actor",
					parentNarratorId: "parent",
					status: "idle",
					createdAt: time,
					updatedAt: time,
				},
			])
			.run();
		const run = {
			producerKind: "agent" as const,
			taskId: "actor",
			recipientId: "parent",
			logicalRunId: "file-run",
		};
		local
			.insert(messages)
			.values({
				id: "publication-result:file-run",
				narratorId: "actor",
				role: "disp",
				contentJson: [
					{
						type: "text",
						text: "worker snapshot",
						publicationResult: { logicalRunId: "file-run", truncated: false, originalBytes: 15 },
					},
				],
				createdAt: time,
			})
			.run();
		local
			.insert(outbox)
			.values({
				id: "terminal",
				deliveryId: "file-delivery",
				...run,
				eventKind: "completed",
				dedupeKey: JSON.stringify([
					"publication",
					"agent",
					"actor",
					"file-run",
					"completed",
					"parent",
				]),
				state: "pending",
				summary: "done",
				resultRef: "message-original:publication-result:file-run",
				createdAt: time,
				updatedAt: time,
			})
			.run();
		const task = { kind: "publication-terminal-result-v1" as const, run };
		const expected = runPublicationTerminalResultRead(file, task);
		expect(expected).toEqual({ output: "worker snapshot" });
		expect(await runReadTask(path, task)).toEqual(expected);
		expect(
			await runReadTask(path, { ...task, run: { ...run, recipientId: "another" } }),
		).toBeNull();
	} finally {
		await closeDbWorkerConnections(path, () => file.close());
		await rm(dir, { recursive: true, force: true });
	}
});
