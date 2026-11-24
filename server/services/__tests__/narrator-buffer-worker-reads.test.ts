import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import {
	narratorBufferedMessages as mailbox,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../db/schema";
import * as pool from "../../lib/db-worker/pool";
import { captureWorkerRejection, getNarratorWorkerTestDb } from "./narrator-worker-fixture";

const fixture = getNarratorWorkerTestDb();
await fixture.ready;
const { db, sqlite } = fixture;
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
await import("../narrator-service");
const buffer = await import("../narrator-buffer");
const session = await import("../narrator-session");
const { activeNarrators } = await import("../narrator-session-state");
const { bumpParentNarratorMessageVersion, narratorPersistence: persistence } = await import(
	"../narrator-persistence"
);
const { interjectSpecEditAsUserMessage } = await import("../spec-edit-interject");
const { backgroundOccupancyStore } = await import("../background-occupancy-store");
const now = "2026-11-23T00:00:00.000Z";

beforeEach(() => {
	cleanDb(sqlite);
	db.insert(narrators).values({ id: "actor", createdAt: now, updatedAt: now }).run();
});
afterEach(async () => {
	mock.restore();
	activeNarrators.clear();
	await backgroundOccupancyStore.drain();
	await buffer.drainBufferedFilePreparations({ deadlineAt: Date.now() + 10_000 });
});
afterAll(async () => {
	await fixture.close();
	mock.module("../../db", () => realDb);
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function gateRead(table: string) {
	const entered = deferred();
	const release = deferred();
	const original = pool.runReadTask;
	let armed = true;
	const probe = spyOn(pool, "runReadTask").mockImplementation(((path, params, options) => {
		const result = original(path, params, options);
		if (
			armed &&
			(params.kind === "selectRows" || params.kind === "selectValues") &&
			params.sql.includes(table)
		) {
			armed = false;
			return result.then(async (value) => {
				entered.resolve();
				await release.promise;
				return value;
			});
		}
		return result;
	}) as typeof pool.runReadTask);
	return { entered: entered.promise, release: release.resolve, restore: () => probe.mockRestore() };
}

function register() {
	const active = { narratorId: "actor", alive: true, _loopRunning: true } as NonNullable<
		ReturnType<typeof activeNarrators.get>
	>;
	activeNarrators.set("actor", active);
	return active;
}

test("empty and populated buffer reads use the Worker and whitelist caller budgets", async () => {
	const signal = new AbortController().signal;
	const deadlineAt = Date.now() + 10_000;
	const options = { signal, deadlineAt, timeoutMs: 2_000, unrelated: "must not escape" };
	const original = pool.runReadTask;
	let calls = 0;
	const probe = spyOn(pool, "runReadTask").mockImplementation(((path, params, budget) => {
		calls++;
		expect(budget).toMatchObject({ signal, deadlineAt, timeoutMs: 2_000 });
		expect(budget).not.toHaveProperty("unrelated");
		return original(path, params, budget);
	}) as typeof pool.runReadTask);
	expect(await buffer.getBufferedMessages("actor", options)).toEqual([]);
	await buffer.enqueueBufferedMessage("actor", "hello");
	expect((await buffer.getBufferedMessages("actor", options)).map((row) => row.text)).toEqual([
		"hello",
	]);
	expect(calls).toBe(2);
	probe.mockRestore();
});

test("unavailable and failed Workers never perform the dependent buffer write", async () => {
	const queued = await buffer.enqueueBufferedMessage("actor", "original");
	for (const error of [
		new pool.WorkersUnavailableError("disabled"),
		new pool.WorkersUnavailableError("creation failed"),
		new pool.DbReadTaskTimeoutError("timed out"),
		new Error("worker crashed"),
	]) {
		const probe = spyOn(pool, "runReadTask").mockRejectedValue(error);
		expect(
			await captureWorkerRejection(buffer.updateBufferedMessage("actor", queued.id, "lost")),
		).toBe(error);
		probe.mockRestore();
		expect((await buffer.getBufferedMessages("actor"))[0]?.text).toBe("original");
	}
});

test("cancelled and expired reads leave the buffer and status untouched", async () => {
	const controller = new AbortController();
	controller.abort();
	for (const options of [{ signal: controller.signal }, { deadlineAt: Date.now() - 1 }]) {
		expect(
			await captureWorkerRejection(buffer.getBufferedMessages("actor", options)),
		).toBeDefined();
		expect(
			await captureWorkerRejection(persistence.updateRelaxedPlan("actor", true, options)),
		).toBeDefined();
	}
	expect(db.select().from(narrators).where(eq(narrators.id, "actor")).get()?.relaxedPlan).toBe(
		false,
	);
});

test("persistence whitelists and caps budgets without forwarding status options", async () => {
	const signal = new AbortController().signal;
	const deadlineAt = Date.now() + 10_000;
	const original = pool.runReadTask;
	const budgets: unknown[] = [];
	const probe = spyOn(pool, "runReadTask").mockImplementation(((path, params, options) => {
		budgets.push(options);
		return original(path, params, options);
	}) as typeof pool.runReadTask);
	try {
		const options = {
			signal,
			deadlineAt,
			timeoutMs: 100_000,
			substatus: ["thinking"],
			unrelated: true,
		};
		await persistence.updateStatus("actor", "working", options);
		expect(budgets[0]).toMatchObject({ signal, deadlineAt, timeoutMs: 30_000 });
		expect(budgets[0]).not.toHaveProperty("substatus");
		expect(budgets[0]).not.toHaveProperty("unrelated");
	} finally {
		probe.mockRestore();
	}
});

test("failed persistence Workers cannot replace durable substatus", async () => {
	const before = db
		.select({ substatus: narrators.substatus })
		.from(narrators)
		.where(eq(narrators.id, "actor"))
		.get();
	for (const error of [
		new pool.WorkersUnavailableError("disabled"),
		new pool.WorkersUnavailableError("creation failed"),
		new pool.DbReadTaskTimeoutError("timed out"),
		new Error("worker crashed"),
	]) {
		const probe = spyOn(pool, "runReadTask").mockRejectedValue(error);
		try {
			expect(await captureWorkerRejection(persistence.updateSubstatus("actor", ["lost"]))).toBe(
				error,
			);
		} finally {
			probe.mockRestore();
		}
		expect(
			db
				.select({ substatus: narrators.substatus })
				.from(narrators)
				.where(eq(narrators.id, "actor"))
				.get(),
		).toEqual(before);
	}
});

test("queue replacement conflicts without overwriting a newer edit", async () => {
	register();
	const update = {
		uri: "spec://tasks.json",
		path: "tasks.json",
		revisionId: "one",
		updatedBy: "user" as const,
		preview: null,
		taskSummary: "first",
		timestamp: now,
	};
	await interjectSpecEditAsUserMessage("actor", update, "en", null);
	const [queued] = await buffer.getBufferedMessages("actor");
	if (!queued) throw new Error("Missing queued spec edit");
	const gate = gateRead("narrator_buffered_messages");
	const work = interjectSpecEditAsUserMessage(
		"actor",
		{ ...update, taskSummary: "stale" },
		"en",
		null,
	);
	const outcome = captureWorkerRejection(work);
	try {
		await gate.entered;
		db.update(mailbox)
			.set({ text: "newer", contentRevision: 9 })
			.where(eq(mailbox.id, queued.id))
			.run();
	} finally {
		gate.release();
	}
	expect(await outcome).toMatchObject({ statusCode: 409, code: "RUNTIME_READ_CONFLICT" });
	gate.restore();
	expect((await buffer.getBufferedMessages("actor")).map((row) => row.text)).toEqual(["newer"]);
});

test("a Spec replacement lost to a claim enqueues the new notice", async () => {
	register();
	const update = {
		uri: "spec://claim.json",
		path: "claim.json",
		revisionId: "one",
		updatedBy: "user" as const,
		preview: null,
		taskSummary: "first",
		timestamp: now,
	};
	await interjectSpecEditAsUserMessage("actor", update, "en", null);
	const [previous] = await buffer.getBufferedMessages("actor");
	const { createMailboxStore } = await import("../agent-runtime/mailbox");
	const store = createMailboxStore(db);
	const gate = gateRead("narrator_buffered_messages");
	const work = interjectSpecEditAsUserMessage(
		"actor",
		{ ...update, taskSummary: "replacement notice" },
		"en",
		null,
	);
	try {
		await gate.entered;
		const claimed = store.claimBatch("actor", { token: "owner", epoch: "epoch" }, { count: 1 });
		expect(claimed.map((row) => row.id)).toEqual([previous.id]);
	} finally {
		gate.release();
	}
	expect(await work).toEqual({ delivered: "interjected" });
	gate.restore();
	const queued = await buffer.getBufferedMessages("actor");
	expect(queued).toHaveLength(1);
	expect(queued[0].id).not.toBe(previous.id);
	expect(queued[0].text).toContain("replacement notice");
	expect(db.select().from(mailbox).where(eq(mailbox.id, previous.id)).get()).toMatchObject({
		state: "claimed",
		text: previous.text,
	});
});

test("a concurrent enqueue cannot be erased by an empty soft-stop observation", async () => {
	const active = register();
	active._bufferSoftStop = true;
	const gate = gateRead("narrator_buffered_messages");
	const outcome = captureWorkerRejection(session.consumeBufferedSoftStopRequest(active));
	try {
		await gate.entered;
		await buffer.enqueueBufferedMessage(
			"actor",
			"new guidance",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"front",
		);
		session.requestBufferedMessageSoftStop("actor");
	} finally {
		gate.release();
	}
	expect(await outcome).toMatchObject({ statusCode: 409, code: "RUNTIME_READ_CONFLICT" });
	expect(active._bufferSoftStop).toBe(true);
	gate.restore();
	expect(await session.consumeBufferedSoftStopRequest(active)).toBe(true);
	expect(active._bufferSoftStopTaken).toBe(true);
	expect(await buffer.getBufferedMessages("actor")).toHaveLength(1);
});

test("a tool boundary without a soft stop never waits on the buffer Worker", async () => {
	const active = register();
	const probe = spyOn(pool, "runReadTask").mockRejectedValue(new Error("must not read"));
	expect(await session.consumeBufferedSoftStopRequest(active)).toBe(false);
	active._feedbackSoftStop = true;
	expect(await session.consumeBufferedSoftStopRequest(active)).toBe(true);
	expect(probe).not.toHaveBeenCalled();
});

test("an ordinary enqueue does not conflict with an unchanged guidance decision", async () => {
	const active = register();
	active._bufferSoftStop = true;
	const gate = gateRead("narrator_buffered_messages");
	const outcome = session.consumeBufferedSoftStopRequest(active);
	try {
		await gate.entered;
		await buffer.enqueueBufferedMessage("actor", "ordinary next step");
	} finally {
		gate.release();
	}
	expect(await outcome).toBe(false);
	gate.restore();
	expect(active._bufferSoftStop).toBe(false);
	expect((await buffer.getBufferedMessages("actor")).map((row) => row.text)).toEqual([
		"ordinary next step",
	]);
});

test("pre-prompt guidance cancellation rejects a removed Worker observation before aborting", async () => {
	const active = register();
	active._bufferSoftStop = true;
	active._guidanceAbortController = new AbortController();
	const enqueue = () =>
		buffer.enqueueBufferedMessage(
			"actor",
			"guidance",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"front",
		);
	const queued = await enqueue();
	const gate = gateRead("narrator_buffered_messages");
	const outcome = captureWorkerRejection(session.abortPendingBufferedGuidance(active));
	try {
		await gate.entered;
		await buffer.removeBufferedMessage("actor", queued.id);
	} finally {
		gate.release();
	}
	expect(await outcome).toMatchObject({ statusCode: 409, code: "RUNTIME_READ_CONFLICT" });
	gate.restore();
	expect(active._guidanceAbortController.signal.aborted).toBe(false);
	await session.abortPendingBufferedGuidance(active);
	expect(active._guidanceAbortController.signal.aborted).toBe(false);
	await enqueue();
	await session.abortPendingBufferedGuidance(active);
	expect(active._guidanceAbortController.signal.aborted).toBe(true);
});

test.each([
	"status",
	"compare",
	"replace",
	"add",
	"remove",
	"permission",
] as const)("persistence %s rejects a changed Worker observation in its write transaction", async (kind) => {
	db.update(narrators)
		.set({ substatus: '["remove"]', permissionMode: "default" })
		.where(eq(narrators.id, "actor"))
		.run();
	const gate = gateRead('"narrators"');
	const work =
		kind === "status"
			? persistence.updateStatus("actor", "working")
			: kind === "compare"
				? persistence.compareAndSetStatus("actor", "idle", "working")
				: kind === "replace"
					? persistence.updateSubstatus("actor", ["replacement"])
					: kind === "add"
						? persistence.addSubstatus("actor", "added")
						: kind === "remove"
							? persistence.removeSubstatus("actor", "remove")
							: persistence.updateRelaxedPlan("actor", true);
	const outcome = captureWorkerRejection(work);
	try {
		await gate.entered;
		db.update(narrators)
			.set({ substatus: '["concurrent"]', permissionMode: "readOnly" })
			.where(eq(narrators.id, "actor"))
			.run();
	} finally {
		gate.release();
	}
	expect(await outcome).toMatchObject({ statusCode: 409, code: "RUNTIME_READ_CONFLICT" });
	expect(db.select().from(narrators).where(eq(narrators.id, "actor")).get()?.substatus).toBe(
		'["concurrent"]',
	);
	gate.restore();
});

test("ordinary and missing-row substatus decisions retain their behavior", async () => {
	expect(await persistence.addSubstatus("actor", "tag")).toContain("tag");
	expect(await persistence.removeSubstatus("actor", "tag")).not.toContain("tag");
	await persistence.updateSubstatus("absent", ["tag"]);
	expect(await buffer.getBufferedMessages("absent")).toEqual([]);
});

test("a title save after a terminal observation does not reject the idle transition", async () => {
	db.update(narrators)
		.set({ status: "working", substatus: '["thinking"]', title: "before" })
		.where(eq(narrators.id, "actor"))
		.run();
	const gate = gateRead('"narrators"');
	const work = persistence.updateStatus("actor", "idle", { substatus: ["unread"] });
	try {
		await gate.entered;
		db.update(narrators)
			.set({ title: "automatic title", updatedAt: "2026-11-24T00:00:00.000Z" })
			.where(eq(narrators.id, "actor"))
			.run();
	} finally {
		gate.release();
	}
	await work;
	gate.restore();
	expect(db.select().from(narrators).where(eq(narrators.id, "actor")).get()).toMatchObject({
		status: "idle",
		title: "automatic title",
	});
});

test("a title save after a status snapshot cannot move updatedAt backwards", async () => {
	db.update(narrators).set({ status: "working" }).where(eq(narrators.id, "actor")).run();
	const gate = gateRead('"narrators"');
	const work = persistence.updateStatus("actor", "idle", { substatus: ["unread"] });
	const titleSavedAt = new Date(Date.now() + 1_000).toISOString();
	try {
		await gate.entered;
		db.update(narrators)
			.set({ title: "new title", updatedAt: titleSavedAt })
			.where(eq(narrators.id, "actor"))
			.run();
	} finally {
		gate.release();
	}
	await work;
	gate.restore();
	expect(db.select().from(narrators).where(eq(narrators.id, "actor")).get()).toMatchObject({
		status: "idle",
		title: "new title",
		updatedAt: titleSavedAt,
	});
});

test("a reparented initiating tool cannot bump the stale parent's message version", async () => {
	db.insert(narrators).values({ id: "other", createdAt: now, updatedAt: now }).run();
	db.insert(narratorMessages)
		.values({
			id: "parent-message",
			narratorId: "actor",
			role: "assistant",
			contentJson: [],
			createdAt: now,
		})
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: "tool",
			narratorId: "actor",
			messageId: "parent-message",
			toolUseId: "wire",
			toolName: "Agent",
			createdAt: now,
		})
		.run();
	const gate = gateRead("narrator_tool_calls");
	const outcome = captureWorkerRejection(bumpParentNarratorMessageVersion("wire"));
	try {
		await gate.entered;
		db.update(narratorToolCalls)
			.set({ narratorId: "other" })
			.where(eq(narratorToolCalls.id, "tool"))
			.run();
	} finally {
		gate.release();
	}
	expect(await outcome).toMatchObject({ statusCode: 409, code: "RUNTIME_READ_CONFLICT" });
	gate.restore();
	expect(db.select().from(narrators).where(eq(narrators.id, "actor")).get()?.messageVersion).toBe(
		0,
	);
	await bumpParentNarratorMessageVersion("wire");
	expect(db.select().from(narrators).where(eq(narrators.id, "other")).get()?.messageVersion).toBe(
		1,
	);
	await bumpParentNarratorMessageVersion("missing");
});

test("clearing a stale empty queue snapshot retains a newly queued guidance request", async () => {
	const active = register();
	active._bufferSoftStop = true;
	await buffer.enqueueBufferedMessage(
		"actor",
		"new guidance",
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		"front",
	);
	await session.clearBufferedMessageSoftStopIfIdle("actor", false);
	expect(active._bufferSoftStop).toBe(true);
	expect(active._bufferGuidancePending).toBe(true);
});

test("clearing soft-stop rejects an enqueue after its Worker snapshot", async () => {
	const active = register();
	active._bufferSoftStop = true;
	const gate = gateRead("narrator_buffered_messages");
	const outcome = captureWorkerRejection(
		session.clearBufferedMessageSoftStopIfIdle("actor", false),
	);
	try {
		await gate.entered;
		await buffer.enqueueBufferedMessage(
			"actor",
			"new guidance",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"front",
		);
		session.requestBufferedMessageSoftStop("actor");
	} finally {
		gate.release();
	}
	expect(await outcome).toMatchObject({ statusCode: 409, code: "RUNTIME_READ_CONFLICT" });
	gate.restore();
	expect(active._bufferSoftStop).toBe(true);
	await session.clearBufferedMessageSoftStopIfIdle("actor");
	expect(active._bufferSoftStop).toBe(true);
});
