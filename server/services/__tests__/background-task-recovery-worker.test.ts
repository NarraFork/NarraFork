import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import { backgroundTasks, narrators } from "../../db/schema";
import * as reads from "../../db/worker-read";
import * as pool from "../../lib/db-worker/pool";
import { captureWorkerRejection, getNarratorWorkerTestDb } from "./narrator-worker-fixture";

const fixture = getNarratorWorkerTestDb();
await fixture.ready;
const { db, sqlite } = fixture;
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const { backgroundTaskService: service } = await import("../background-task-service");
const { backgroundOccupancyStore } = await import("../background-occupancy-store");
const { runtimePublication } = await import("../agent-runtime/publication");
const now = "2026-01-01T00:00:00.000Z";
const pending = new Set<Promise<unknown>>();
const broadcasters = service as unknown as Record<
	"broadcastTaskUpsert" | "broadcastListDelta",
	(...args: unknown[]) => Promise<void>
>;
for (const method of ["broadcastTaskUpsert", "broadcastListDelta"] as const) {
	const original = broadcasters[method].bind(service);
	const track = (...args: unknown[]) => {
		const work = original(...args);
		pending.add(work);
		void work.then(
			() => pending.delete(work),
			() => pending.delete(work),
		);
		return work;
	};
	broadcasters[method] = track;
}
async function drain() {
	await backgroundOccupancyStore.drain();
	while (pending.size) await Promise.allSettled([...pending]);
}
beforeEach(async () => {
	await drain();
	service.resetListVersionsForTests();
	service.setBroadcastFnForTests(() => {});
	cleanDb(sqlite);
	db.insert(narrators).values({ id: "parent", createdAt: now, updatedAt: now }).run();
});
afterEach(async () => {
	mock.restore();
	service.unregisterAbortController("task");
	await drain();
});
afterAll(async () => {
	await drain();
	service.setBroadcastFnForTests(null);
	mock.module("../../db", () => realDb);
	await fixture.close();
});
function seed(overrides: Partial<typeof backgroundTasks.$inferInsert> = {}) {
	db.insert(backgroundTasks)
		.values({
			id: "task",
			parentNarratorId: "parent",
			type: "bash",
			status: "running",
			command: "build",
			startedAt: now,
			createdAt: now,
			updatedAt: now,
			...overrides,
		})
		.run();
}
function stored(id = "task") {
	return db.select().from(backgroundTasks).where(eq(backgroundTasks.id, id)).get();
}
function interleave(match: (sql: string) => boolean, mutate: () => void) {
	const original = reads.readQuery;
	let fired = false;
	spyOn(reads, "readQuery").mockImplementation((async (query, options) => {
		const result = await original(query as Parameters<typeof reads.readQuery>[0], options);
		if (!fired && match(query.toSQL().sql)) {
			fired = true;
			mutate();
		}
		return result;
	}) as typeof reads.readQuery);
	return () => expect(fired).toBe(true);
}
function expectConflict(error: unknown) {
	expect(error).toMatchObject({
		statusCode: 409,
		code: "RUNTIME_READ_CONFLICT",
		message: "Runtime state changed while reading",
	});
}

function interleaveFirst(mutate: () => void) {
	const original = reads.readQueryFirst;
	let fired = false;
	spyOn(reads, "readQueryFirst").mockImplementation((async (query, options) => {
		const result = await original(query as Parameters<typeof reads.readQueryFirst>[0], options);
		if (!fired && query.toSQL().sql.includes('from "background_tasks"')) {
			fired = true;
			mutate();
		}
		return result;
	}) as typeof reads.readQueryFirst);
	return () => expect(fired).toBe(true);
}

for (const existing of [false, true]) {
	test(`agent ${existing ? "restart" : "creation"} rejects a changed task before registering a run`, async () => {
		db.insert(narrators).values({ id: "task", createdAt: now, updatedAt: now }).run();
		if (existing)
			seed({ type: "agent", subagentNarratorId: "task", status: "failed", logicalRunId: "old" });
		const fired = interleaveFirst(() => {
			if (existing)
				db.update(backgroundTasks)
					.set({ logicalRunId: "winner" })
					.where(eq(backgroundTasks.id, "task"))
					.run();
			else seed({ type: "agent", subagentNarratorId: "task", logicalRunId: "winner" });
		});
		expectConflict(
			await captureWorkerRejection(
				service.createAgentTask({
					id: "task",
					subagentNarratorId: "task",
					subagentType: "general",
					binding: { deliverTo: { narratorId: "parent", toolUseId: "origin" } },
				}),
			),
		);
		fired();
		expect(stored()?.logicalRunId).toBe("winner");
		expect(
			db
				.select({ run: narrators.logicalRunId })
				.from(narrators)
				.where(eq(narrators.id, "task"))
				.get()?.run,
		).toBeNull();
		expect(sqlite.query("SELECT id FROM runtime_publication_outbox").all()).toEqual([]);
	});
}

test("cancel does not abort a run changed after its Worker snapshot", async () => {
	await service.createBashTask({ id: "task", parentNarratorId: "parent", command: "build" });
	await drain();
	const controller = new AbortController();
	service.registerAbortController("task", controller);
	const fired = interleaveFirst(() =>
		db
			.update(backgroundTasks)
			.set({ logicalRunId: "winner" })
			.where(eq(backgroundTasks.id, "task"))
			.run(),
	);
	expectConflict(await captureWorkerRejection(service.cancel("task")));
	fired();
	expect(controller.signal.aborted).toBe(false);
	expect(stored()?.status).toBe("running");
	expect(stored()?.logicalRunId).toBe("winner");
});

for (const command of [`😀${"x".repeat(100)}`, "a😀".repeat(50), "", null]) {
	test(`cancel signals an unchanged task with command ${JSON.stringify(command)}`, async () => {
		await service.createBashTask({
			id: "task",
			parentNarratorId: "parent",
			command: command ?? "",
		});
		if (command === null)
			db.update(backgroundTasks).set({ command }).where(eq(backgroundTasks.id, "task")).run();
		await drain();
		const controller = new AbortController();
		service.registerAbortController("task", controller);
		expect(await service.cancel("task")).toBe(true);
		expect(controller.signal.aborted).toBe(true);
		expect(stored()?.status).toBe("cancelled");
	});
}

test("cancel tolerates output and renewal-only metadata changes", async () => {
	await service.createBashTask({ id: "task", parentNarratorId: "parent", command: "build" });
	await drain();
	const controller = new AbortController();
	service.registerAbortController("task", controller);
	const fired = interleaveFirst(() =>
		db
			.update(backgroundTasks)
			.set({ output: "latest tail", updatedAt: "2099-01-01" })
			.where(eq(backgroundTasks.id, "task"))
			.run(),
	);
	expect(await service.cancel("task")).toBe(true);
	fired();
	expect(controller.signal.aborted).toBe(true);
	expect(stored()?.status).toBe("cancelled");
});

test("list/detail reads preserve budgets, whitelist options and propagate Worker failure", async () => {
	seed();
	const original = reads.readQueryFirst;
	const budget = {
		signal: new AbortController().signal,
		deadlineAt: Date.now() + 10_000,
		timeoutMs: 2_000,
		unrelated: "not a read option",
	};
	const probe = spyOn(reads, "readQueryFirst").mockImplementation((async (query, options) => {
		expect(options).toEqual({
			signal: budget.signal,
			deadlineAt: budget.deadlineAt,
			timeoutMs: budget.timeoutMs,
			executionPolicy: "worker-required",
			maxRows: 1,
		});
		return original(query as Parameters<typeof reads.readQueryFirst>[0], options);
	}) as typeof reads.readQueryFirst);
	expect((await service.getById("task", budget))?.id).toBe("task");
	expect(probe).toHaveBeenCalledTimes(1);
	probe.mockRestore();
	const failure = new Error("list worker unavailable");
	const read = spyOn(reads, "readQuery").mockRejectedValue(failure);
	expect(await service.listByParents([], budget)).toEqual([]);
	expect(read).not.toHaveBeenCalled();
	expect(await captureWorkerRejection(service.listByParents(["parent"], budget))).toBe(failure);
});

test("restart scan is isolated, bounded, empty-safe and preserves the read budget", async () => {
	const original = pool.runReadTask;
	const requests: Array<{ sql: string; maxRows: number }> = [];
	const signal = new AbortController().signal;
	const deadlineAt = Date.now() + 10_000;
	spyOn(pool, "runReadTask").mockImplementation(((path, params, options) => {
		if (params.kind === "selectRows" && params.sql.includes('from "background_tasks"')) {
			requests.push({ sql: params.sql, maxRows: params.maxRows ?? 0 });
			expect(path).toBe(sqlite.filename);
			expect(options).toMatchObject({ signal, deadlineAt, timeoutMs: 2_000 });
		}
		return original(path, params, options);
	}) as typeof pool.runReadTask);
	expect(
		await service.recoverStaleTasksAfterRestart(new Set(), undefined, {
			signal,
			deadlineAt,
			timeoutMs: 2_000,
		}),
	).toBe(0);
	expect(requests).toHaveLength(1);
	expect(requests[0]?.maxRows).toBe(101);
	expect(requests[0]?.sql).toContain("limit");
});

test.each([
	"status",
	"run",
	"owner",
	"binding",
])("restart rejects changed task %s without a terminal intent", async (field) => {
	seed();
	const fired = interleave(
		(sql) => sql.includes('from "background_tasks"'),
		() => {
			if (field === "status")
				db.update(backgroundTasks).set({ status: "completed", output: "winner" }).run();
			if (field === "run") db.update(backgroundTasks).set({ logicalRunId: "new-run" }).run();
			if (field === "owner") {
				db.insert(narrators).values({ id: "other", createdAt: now, updatedAt: now }).run();
				db.update(backgroundTasks).set({ parentNarratorId: "other" }).run();
			}
			if (field === "binding") db.update(backgroundTasks).set({ executionAttempt: 2 }).run();
		},
	);
	expectConflict(await captureWorkerRejection(service.recoverStaleTasksAfterRestart()));
	fired();
	expect(stored()?.output).toBe(field === "status" ? "winner" : null);
	expect(sqlite.query("SELECT id FROM runtime_publication_outbox").all()).toEqual([]);
});

test("restart allows output/updatedAt renewal that does not change recovery eligibility", async () => {
	await service.createBashTask({ id: "task", parentNarratorId: "parent", command: "build" });
	await drain();
	interleave(
		(sql) => sql.includes('from "background_tasks"'),
		() => {
			db.update(backgroundTasks).set({ output: "new tail", updatedAt: "2099-01-01" }).run();
		},
	);
	expect(await service.recoverStaleTasksAfterRestart()).toBe(1);
	expect(stored()?.status).toBe("failed");
	await runtimePublication.flushRecipient("parent");
	expect(
		sqlite.query("SELECT id FROM narrator_buffered_messages WHERE state = 'queued'").all(),
	).toEqual([]);
});

test("paused transfer transition rechecks the observed running projection", async () => {
	seed({ type: "transfer", command: null });
	interleave(
		(sql) => sql.includes('from "background_tasks"'),
		() => {
			db.update(backgroundTasks).set({ status: "completed", output: "winner" }).run();
		},
	);
	expectConflict(await captureWorkerRejection(service.recoverStaleTasksAfterRestart()));
	expect(stored()?.output).toBe("winner");
});

test("a changed service observation detaches the adopted tail without stopping the service", async () => {
	seed({ backgroundKind: "service" });
	const durable = await import("../../lib/agent/execution/durable-service");
	const detach = mock(() => {});
	spyOn(durable, "isDurableServiceSupported").mockReturnValue(true);
	spyOn(durable, "adoptDurableService").mockImplementation(async () => {
		db.update(backgroundTasks).set({ logicalRunId: "replacement-run" }).run();
		return { handle: { detach } } as unknown as Awaited<
			ReturnType<typeof durable.adoptDurableService>
		>;
	});
	expectConflict(await captureWorkerRejection(service.recoverStaleTasksAfterRestart()));
	expect(detach).toHaveBeenCalledTimes(1);
	expect(stored()?.status).toBe("running");
	expect(stored()?.logicalRunId).toBe("replacement-run");
});

test("agent checkpoint selection is batched and narrator cancellation is guarded", async () => {
	for (const id of ["child-a", "child-b"]) {
		db.insert(narrators)
			.values({ id, logicalRunId: `run-${id}`, status: "working", createdAt: now, updatedAt: now })
			.run();
		seed({ id, type: "agent", subagentNarratorId: id, logicalRunId: `run-${id}` });
	}
	const original = reads.readQuery;
	let checkpointReads = 0;
	spyOn(reads, "readQuery").mockImplementation((async (query, options) => {
		const result = await original(query as Parameters<typeof reads.readQuery>[0], options);
		if (
			query.toSQL().sql.includes('from "narrators"') &&
			query.toSQL().sql.includes('"background_completed_at"')
		) {
			checkpointReads++;
			db.update(narrators)
				.set({ logicalRunId: "replacement-run" })
				.where(eq(narrators.id, "child-a"))
				.run();
		}
		return result;
	}) as typeof reads.readQuery);
	expectConflict(await captureWorkerRejection(service.recoverStaleTasksAfterRestart()));
	expect(checkpointReads).toBe(1);
	expect(stored("child-a")?.status).toBe("running");
	expect(
		db
			.select({ run: narrators.logicalRunId })
			.from(narrators)
			.where(eq(narrators.id, "child-a"))
			.get()?.run,
	).toBe("replacement-run");
});

test("notification drain is empty-safe, returns the preview and marks only the observed batch", async () => {
	expect(await service.drainCompletedNotifications("parent")).toEqual([]);
	seed({ status: "completed", output: "\uFEFF  中文 🧭\n" });
	const output = sqlite.query("UPDATE background_tasks SET output = cast(? AS text) WHERE id = ?");
	try {
		output.run(Buffer.from("\uFEFF  中文 🧭\n"), "task");
	} finally {
		output.finalize();
	}
	expect(await service.drainCompletedNotifications("parent")).toEqual([
		{
			id: "task",
			type: "bash",
			title: null,
			alias: null,
			status: "completed",
			outputPreview: "\uFEFF  中文 🧭\n",
		},
	]);
	expect(stored()?.notified).toBe(true);
	expect(await service.drainCompletedNotifications("parent")).toEqual([]);
});
test.each([
	"status",
	"output",
	"notified",
])("notification drain conflicts after %s changes", async (field) => {
	seed({ status: "completed", output: "old result" });
	interleave(
		(sql) => sql.includes('from "background_tasks"'),
		() => {
			db.update(backgroundTasks)
				.set(
					field === "status"
						? { status: "running" }
						: field === "output"
							? { output: "new result" }
							: { notified: true },
				)
				.run();
		},
	);
	expectConflict(await captureWorkerRejection(service.drainCompletedNotifications("parent")));
	expect(stored()?.notified).toBe(field === "notified");
});

test("trait projection detects an interleaved edit without overwriting it", async () => {
	const original = reads.readQueryFirst;
	spyOn(reads, "readQueryFirst").mockImplementation(async (query, options) => {
		const result = await original(query, options);
		db.update(narrators)
			.set({ traits: ["concurrent"] })
			.where(eq(narrators.id, "parent"))
			.run();
		return result;
	});
	expectConflict(await captureWorkerRejection(service.markNarratorRunning("parent")));
	expect(
		db
			.select({ traits: narrators.traits, background: narrators.isBackground })
			.from(narrators)
			.where(eq(narrators.id, "parent"))
			.get(),
	).toEqual({ traits: ["concurrent"], background: false });
});
test("trait projection cannot mark an interleaved replacement run as background", async () => {
	const original = reads.readQueryFirst;
	spyOn(reads, "readQueryFirst").mockImplementation(async (query, options) => {
		const result = await original(query, options);
		db.update(narrators)
			.set({ logicalRunId: "replacement-run" })
			.where(eq(narrators.id, "parent"))
			.run();
		return result;
	});
	expectConflict(await captureWorkerRejection(service.markNarratorRunning("parent")));
	expect(
		db
			.select({ background: narrators.isBackground })
			.from(narrators)
			.where(eq(narrators.id, "parent"))
			.get()?.background,
	).toBe(false);
});
test("trait projection preserves existing traits, tolerates timestamp renewal and missing narrators", async () => {
	await service.markNarratorRunning("missing");
	db.update(narrators)
		.set({ traits: ["kept"] })
		.where(eq(narrators.id, "parent"))
		.run();
	const original = reads.readQueryFirst;
	spyOn(reads, "readQueryFirst").mockImplementation(async (query, options) => {
		const result = await original(query, options);
		db.update(narrators).set({ updatedAt: "2099-01-01" }).where(eq(narrators.id, "parent")).run();
		return result;
	});
	await service.markNarratorRunning("parent");
	expect(
		db.select({ traits: narrators.traits }).from(narrators).where(eq(narrators.id, "parent")).get()
			?.traits,
	).toEqual(["kept", "background"]);
});

test.each([
	"status",
	"owner",
	"narrator",
])("cleanup conflicts after observed %s changes and retains the row", async (field) => {
	seed({ status: "completed", completedAt: now });
	interleave(
		(sql) => sql.includes('from "background_tasks"'),
		() => {
			if (field === "status") db.update(backgroundTasks).set({ status: "running" }).run();
			if (field === "owner") {
				db.insert(narrators).values({ id: "other", createdAt: now, updatedAt: now }).run();
				db.update(backgroundTasks).set({ parentNarratorId: "other" }).run();
			}
			if (field === "narrator") {
				db.insert(narrators)
					.values({ id: "task", status: "working", createdAt: now, updatedAt: now })
					.run();
			}
		},
	);
	expectConflict(await captureWorkerRejection(service.cleanupCompleted(-1)));
	expect(stored()).toBeDefined();
});
test("cleanup is bounded, empty-safe and does not perform serial Worker retention probes", async () => {
	expect(await service.cleanupCompleted(-1)).toBe(0);
	for (let i = 0; i < 101; i++) seed({ id: `task-${i}`, status: "completed", completedAt: now });
	const dispatch = spyOn(pool, "runReadTask");
	expect(await service.cleanupCompleted(-1)).toBe(100);
	const reads = dispatch.mock.calls.filter(
		([, params]) => params.kind === "selectRows" && params.sql.includes('from "background_tasks"'),
	);
	expect(reads).toHaveLength(1);
	expect(await service.cleanupCompleted(-1)).toBe(1);
});

const operations = [
	[
		"restart",
		(options: reads.ReadQueryOptions) =>
			service.recoverStaleTasksAfterRestart(new Set(), undefined, options),
	],
	["cleanup", (options: reads.ReadQueryOptions) => service.cleanupCompleted(-1, options)],
	[
		"notifications",
		(options: reads.ReadQueryOptions) => service.drainCompletedNotifications("parent", options),
	],
	["traits", (options: reads.ReadQueryOptions) => service.markNarratorRunning("parent", options)],
] as const;
for (const [name, run] of operations) {
	test.each([
		"unavailable",
		"crashed",
		"timed out",
		"disabled",
	])(`${name} propagates Worker %s without local fallback`, async (failure) => {
		seed({ status: name === "restart" ? "running" : "completed", completedAt: now });
		spyOn(pool, "runReadTask").mockRejectedValue(new Error(failure));
		const select = spyOn(db, "select");
		expect(await captureWorkerRejection(run({}))).toMatchObject({ message: failure });
		expect(select.mock.calls.length).toBe(name === "cleanup" ? 2 : 1);
		expect(stored()?.notified).toBe(false);
	});
	test(`${name} propagates cancellation and an expired deadline`, async () => {
		const controller = new AbortController();
		controller.abort();
		expect(await captureWorkerRejection(run({ signal: controller.signal }))).toMatchObject({
			code: "DB_READ_ABORTED",
		});
		expect(await captureWorkerRejection(run({ deadlineAt: Date.now() - 1 }))).toMatchObject({
			code: "DB_READ_TASK_TIMEOUT",
		});
	});
}
