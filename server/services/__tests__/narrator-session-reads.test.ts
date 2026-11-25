import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanDb } from "../../../tests/setup";
import { DbReadError } from "../../lib/db-worker/errors";
import * as pool from "../../lib/db-worker/pool";
import { getNarratorWorkerTestDb } from "./narrator-worker-fixture";

const fixture = getNarratorWorkerTestDb();
await fixture.ready;
const { db, sqlite } = fixture;
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const session = await import("../narrator-session");
const { narratorService } = await import("../narrator-service");
const fileChanges = await import("../subagent-file-changes");
const { drainRuntimeTestWork } = await import("./agent-runtime-test-database");
const now = "2026-10-14T00:00:00.000Z";
const conflict = { error: { code: "RUNTIME_READ_CONFLICT", statusCode: 409 } };

function seed(id = "n1") {
	sqlite
		.query(
			"INSERT INTO narrators (id, status, traits, last_stop_reason, created_at, updated_at) VALUES (?, 'idle', '[]', 'normal', ?, ?)",
		)
		.run(id, now, now);
}
beforeEach(() => {
	cleanDb(sqlite);
	seed();
});
afterEach(async () => {
	mock.restore();
	await drainRuntimeTestWork();
	delete (globalThis as Record<symbol, unknown>)[Symbol.for("narrafork.narrator.initialized")];
});
afterAll(async () => {
	mock.module("../../db", () => realDb);
	await fixture.close();
});

function settle<T>(work: Promise<T>) {
	return work.then(
		(value) => ({ value }),
		(error: unknown) => ({ error }),
	);
}

function gateRead(matches: (sql: string) => boolean) {
	const observed = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const run = pool.runReadTask;
	let intercepted = false;
	spyOn(pool, "runReadTask").mockImplementation((async (path, task, options) => {
		const result = await run(path, task, options);
		if (
			!intercepted &&
			(task.kind === "selectRows" || task.kind === "selectValues") &&
			matches(task.sql)
		) {
			intercepted = true;
			observed.resolve();
			await release.promise;
		}
		return result;
	}) as typeof pool.runReadTask);
	return {
		release: release.resolve,
		async wait(work: Promise<unknown>) {
			await Promise.race([
				observed.promise,
				work.then(() => {
					if (!intercepted) throw new Error("Work settled without the Worker observation gate");
				}),
			]);
		},
	};
}

describe("required session metadata reads", () => {
	test("a missing persisted tool is rejected without preparing execution", async () => {
		expect(
			await session.executePersistedToolCall({ narratorId: "n1", toolCallId: "missing" }),
		).toEqual({ ok: false, reason: "not_found" });
	});
	for (const code of [
		"DB_READ_FAILED",
		"DB_READ_TASK_TIMEOUT",
		"DB_READ_ABORTED",
		"DB_READ_UNAVAILABLE",
	]) {
		test(`${code} propagates without a main-thread read`, async () => {
			const error = new DbReadError(code, "injected session read failure");
			spyOn(pool, "runReadTask").mockRejectedValue(error);
			const main = spyOn(sqlite, "prepare");
			expect(await settle(session.readSessionDeliverTo("n1"))).toEqual({ error });
			expect(await settle(session.restorePendingModelOverrides())).toEqual({ error });
			expect(main).not.toHaveBeenCalled();
		});
	}
	test("missing and unregistered sessions return no delivery; registered sessions retain the target", async () => {
		expect(await session.readSessionDeliverTo("missing")).toBeUndefined();
		expect(await session.readSessionDeliverTo("n1")).toBeUndefined();
		sqlite.query("UPDATE narrators SET runtime_registration_json = ? WHERE id = 'n1'").run(
			JSON.stringify({
				version: 1,
				run: { logicalRunId: "run", deliverTo: { narratorId: "parent", toolUseId: "tool" } },
			}),
		);
		expect(await session.readSessionDeliverTo("n1")).toEqual({
			narratorId: "parent",
			toolUseId: "tool",
		});
	});
	test("Worker disablement fails closed after a successful read", async () => {
		await session.readSessionDeliverTo("n1");
		const previous = process.env.NARRAFORK_DB_WORKER;
		const main = spyOn(sqlite, "prepare");
		try {
			process.env.NARRAFORK_DB_WORKER = "off";
			expect(await settle(session.readSessionDeliverTo("n1"))).toMatchObject({
				error: { code: "DB_READ_UNAVAILABLE" },
			});
			expect(main).not.toHaveBeenCalled();
		} finally {
			if (previous === undefined) delete process.env.NARRAFORK_DB_WORKER;
			else process.env.NARRAFORK_DB_WORKER = previous;
		}
	});
	test("cancellation and expired deadlines submit nothing", async () => {
		const dispatch = spyOn(pool, "runReadTask");
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		expect(
			await settle(session.readSessionDeliverTo("n1", { signal: controller.signal })),
		).toMatchObject({ error: { message: "cancelled" } });
		expect(
			await settle(session.restorePendingModelOverrides({ deadlineAt: Date.now() - 1 })),
		).toMatchObject({ error: { code: "DB_READ_TASK_TIMEOUT" } });
		expect(dispatch).not.toHaveBeenCalled();
	});
	test("the caller's budget is bounded and no unrelated fields reach the Worker", async () => {
		const dispatch = spyOn(pool, "runReadTask");
		const signal = new AbortController().signal;
		const deadlineAt = Date.now() + 50_000;
		await session.readSessionDeliverTo(
			"n1",
			Object.assign({ signal, deadlineAt, timeoutMs: 90_000 }, { privateValue: "not forwarded" }),
		);
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(dispatch.mock.calls[0]?.[2]).toMatchObject({
			signal,
			deadlineAt,
			timeoutMs: 30_000,
		});
		expect(dispatch.mock.calls[0]?.[2]).not.toHaveProperty("privateValue");
	});
});

describe("session observation guards", () => {
	function seedPartial(status?: string) {
		sqlite.run(
			"INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at) VALUES ('partial', 'n1', 'assistant', '[]', ?)",
			[now],
		);
		if (status)
			sqlite.run(
				"INSERT INTO narrator_tool_calls (id, narrator_id, message_id, tool_use_id, tool_name, status, created_at) VALUES ('partial-tool', 'n1', 'partial', 'partial-use', 'Read', ?, ?)",
				[status, now],
			);
	}
	for (const status of [undefined, "pending", "success", "running"]) {
		test(`partial finalization retains executed calls and deletes empty unexecuted messages (${status})`, async () => {
			seedPartial(status);
			const kept = status === "success" || status === "running";
			expect(await session.finalizeOrCleanupPartialMessage("partial", "n1")).toBe(kept);
			expect(!!sqlite.query("SELECT id FROM narrator_messages WHERE id = 'partial'").get()).toBe(
				kept,
			);
			if (kept)
				expect(
					sqlite.query("SELECT status FROM narrator_tool_calls WHERE id = 'partial-tool'").get(),
				).toEqual({ status: status === "running" ? "fail" : "success" });
		});
	}
	for (const code of [
		"DB_READ_FAILED",
		"DB_READ_TASK_TIMEOUT",
		"DB_READ_ABORTED",
		"DB_READ_UNAVAILABLE",
	]) {
		test(`partial metadata ${code} cannot fall through to destructive cleanup`, async () => {
			seedPartial("pending");
			const run = pool.runReadTask;
			spyOn(pool, "runReadTask").mockImplementation((async (path, task, options) => {
				if (
					(task.kind === "selectRows" || task.kind === "selectValues") &&
					task.sql.includes('"narrator_tool_calls"')
				)
					throw new DbReadError(code, "partial read failed");
				return run(path, task, options);
			}) as typeof pool.runReadTask);
			expect(await settle(session.finalizeOrCleanupPartialMessage("partial", "n1"))).toMatchObject({
				error: { code },
			});
			expect(
				sqlite.query("SELECT status FROM narrator_tool_calls WHERE id = 'partial-tool'").get(),
			).toEqual({ status: "pending" });
			expect(sqlite.query("SELECT id FROM narrator_messages WHERE id = 'partial'").get()).toEqual({
				id: "partial",
			});
		});
	}
	for (const mutation of [
		"UPDATE narrator_tool_calls SET status = 'running' WHERE id = 'partial-tool'",
		"DELETE FROM narrator_tool_calls WHERE id = 'partial-tool'",
		"INSERT INTO narrator_tool_calls (id, narrator_id, message_id, tool_use_id, tool_name, status, created_at) VALUES ('new-tool', 'n1', 'partial', 'new-use', 'Read', 'running', '2026-10-14T00:00:00.000Z')",
	]) {
		test(`partial cleanup rejects changed tool membership/status: ${mutation}`, async () => {
			seedPartial("pending");
			const gate = gateRead((sql) => sql.includes('"narrator_tool_calls"'));
			const work = settle(session.finalizeOrCleanupPartialMessage("partial", "n1"));
			try {
				await gate.wait(work);
				sqlite.run(mutation);
				gate.release();
				expect(await work).toMatchObject(conflict);
				expect(sqlite.query("SELECT id FROM narrator_messages WHERE id = 'partial'").get()).toEqual(
					{ id: "partial" },
				);
			} finally {
				gate.release();
				await work;
			}
		});
	}
	test("legacy plan migration cannot overwrite a concurrent permission decision", async () => {
		sqlite.run("UPDATE narrators SET permission_mode = 'plan' WHERE id = 'n1'");
		const gate = gateRead((sql) => sql.includes('"permission_mode"') && sql.includes('"traits"'));
		const work = settle(session.recoverOnStartup());
		try {
			await gate.wait(work);
			sqlite.run("UPDATE narrators SET permission_mode = 'readOnly' WHERE id = 'n1'");
			gate.release();
			expect(await work).toMatchObject(conflict);
			expect(
				sqlite.query("SELECT permission_mode, traits FROM narrators WHERE id = 'n1'").get(),
			).toEqual({ permission_mode: "readOnly", traits: "[]" });
		} finally {
			gate.release();
			await work;
		}
	});
	for (const mutation of [
		"SELECT 1",
		"UPDATE narrator_tool_calls SET status = 'fail' WHERE id = 'tool'",
		"UPDATE narrator_tool_calls SET execution_started_at = '2099-01-01T00:00:00Z' WHERE id = 'tool'",
		"UPDATE narrators SET turn_started_at = '2099-01-01T00:00:00Z' WHERE id = 'child'",
	]) {
		test(`conclusion settlement protects its observation during ${mutation}`, async () => {
			seed("child");
			sqlite.run(
				"INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at) VALUES ('message', 'n1', 'assistant', '[]', ?)",
				[now],
			);
			sqlite.run(
				"INSERT INTO narrator_tool_calls (id, narrator_id, message_id, tool_use_id, tool_name, status, created_at) VALUES ('tool', 'n1', 'message', 'use', 'Agent', 'running', ?)",
				[now],
			);
			spyOn(fileChanges, "appendSubagentFileChanges").mockImplementation(
				async (_scope, text) => text,
			);
			const gate = gateRead(
				(sql) =>
					sql.includes('"narrator_tool_calls"') &&
					sql.includes('"permission_started_at"') &&
					sql.includes('"status"'),
			);
			const work = settle(
				session.updateToolCallConclusion({
					subagentId: "child",
					parentNarratorId: "n1",
					toolUseId: "use",
					toolCallId: "tool",
					messageId: "message",
					finalText: "done",
					hasError: false,
					refreshTiming: true,
				}),
			);
			try {
				await gate.wait(work);
				sqlite.run(mutation);
				gate.release();
				if (mutation === "SELECT 1") {
					expect(await work).toEqual({ value: undefined });
					expect(
						sqlite.query("SELECT status FROM narrator_tool_calls WHERE id = 'tool'").get(),
					).toEqual({ status: "success" });
				} else {
					expect(await work).toMatchObject(conflict);
					expect(
						sqlite.query("SELECT output_json FROM narrator_tool_calls WHERE id = 'tool'").get(),
					).toEqual({ output_json: null });
				}
			} finally {
				gate.release();
				await work;
			}
		});
	}
	for (const mutation of ["model = 'newer'", "pending_model_restore = 'different'"]) {
		test(`startup model restoration rejects concurrent ${mutation}`, async () => {
			sqlite.run(
				"UPDATE narrators SET model = 'temporary', pending_model_restore = 'baseline' WHERE id = 'n1'",
			);
			const gate = gateRead(
				(sql) => sql.includes('"pending_model_restore"') && sql.includes('"traits"'),
			);
			const work = settle(session.restorePendingModelOverrides());
			try {
				await gate.wait(work);
				sqlite.run(`UPDATE narrators SET ${mutation} WHERE id = 'n1'`);
				gate.release();
				expect(await work).toMatchObject(conflict);
				expect(
					sqlite.query("SELECT pending_model_restore FROM narrators WHERE id = 'n1'").get(),
				).not.toEqual({ pending_model_restore: null });
			} finally {
				gate.release();
				await work;
			}
		});
	}
	test("a title save neither conflicts with restoration nor loses its newer timestamp", async () => {
		sqlite.run(
			"UPDATE narrators SET model = 'temporary', pending_model_restore = 'baseline' WHERE id = 'n1'",
		);
		const gate = gateRead(
			(sql) => sql.includes('"pending_model_restore"') && sql.includes('"traits"'),
		);
		const work = settle(session.restorePendingModelOverrides());
		try {
			await gate.wait(work);
			sqlite.run(
				"UPDATE narrators SET title = 'new title', updated_at = '2099-01-01T00:00:00Z' WHERE id = 'n1'",
			);
			gate.release();
			expect(await work).toEqual({ value: undefined });
			expect(
				sqlite
					.query(
						"SELECT model, pending_model_restore, title, updated_at FROM narrators WHERE id = 'n1'",
					)
					.get(),
			).toEqual({
				model: "baseline",
				pending_model_restore: null,
				title: "new title",
				updated_at: "2099-01-01T00:00:00Z",
			});
		} finally {
			gate.release();
			await work;
		}
	});
	test("restoration uses bounded pages rather than per-narrator Worker reads", async () => {
		for (let i = 0; i < 260; i++) seed(`restore-${i.toString().padStart(3, "0")}`);
		sqlite.run("UPDATE narrators SET model = 'temporary', pending_model_restore = 'baseline'");
		const dispatch = spyOn(pool, "runReadTask");
		await session.restorePendingModelOverrides();
		expect(
			sqlite
				.query(
					"SELECT count(*) AS total FROM narrators WHERE model = 'baseline' AND pending_model_restore IS NULL",
				)
				.get(),
		).toEqual({ total: 261 });
		expect(dispatch).toHaveBeenCalledTimes(5);
		for (const [, task] of dispatch.mock.calls) {
			if (task.kind === "selectRows" || task.kind === "selectValues")
				expect(task.sql.toLowerCase()).toContain("limit");
		}
		await session.restorePendingModelOverrides();
	});
	for (const mutation of [
		"status = 'archived'",
		"substatus = '[\"error\"]'",
		"traits = '[\"plan\"]'",
		"last_stop_reason = 'user_interrupt'",
	]) {
		test(`wake transaction rejects concurrent ${mutation}`, async () => {
			const expectedWakeObservation = {
				status: "idle" as const,
				substatus: "[]",
				lastStopReason: "normal" as const,
				traits: [],
			};
			const gate = gateRead((sql) => sql.includes('"turn_started_at"'));
			const work = settle(
				narratorService.updateStatus("n1", "working", {
					setTurnStart: true,
					expectedWakeObservation,
				}),
			);
			try {
				await gate.wait(work);
				sqlite.run(`UPDATE narrators SET ${mutation} WHERE id = 'n1'`);
				gate.release();
				expect(await work).toMatchObject(conflict);
				expect(sqlite.query("SELECT status FROM narrators WHERE id = 'n1'").get()).not.toEqual({
					status: "working",
				});
			} finally {
				gate.release();
				await work;
			}
		});
	}
	test("unrelated traits and title timestamps do not invalidate a wake", async () => {
		sqlite.run(
			"UPDATE narrators SET traits = '[\"standalone\"]', title = 'new title', updated_at = '2099-01-01T00:00:00Z' WHERE id = 'n1'",
		);
		await narratorService.updateStatus("n1", "working", {
			expectedWakeObservation: {
				status: "idle",
				substatus: "[]",
				lastStopReason: "normal",
				traits: [],
			},
		});
		expect(
			sqlite.query("SELECT status, title, updated_at FROM narrators WHERE id = 'n1'").get(),
		).toEqual({ status: "working", title: "new title", updated_at: "2099-01-01T00:00:00Z" });
	});
	for (const mutation of ["substatus = '[\"error\"]'", "logical_run_id = 'new-run'"]) {
		test(`status reconciliation rejects concurrent ${mutation}`, async () => {
			sqlite.run("UPDATE narrators SET status = 'working' WHERE id = 'n1'");
			const gate = gateRead((sql) => sql.includes('"status"') && sql.includes('"substatus"'));
			const work = settle(session.reconcileRunningStatus("n1"));
			try {
				await gate.wait(work);
				sqlite.run(`UPDATE narrators SET ${mutation} WHERE id = 'n1'`);
				gate.release();
				expect(await work).toMatchObject(conflict);
				expect(sqlite.query("SELECT status FROM narrators WHERE id = 'n1'").get()).toEqual({
					status: "working",
				});
			} finally {
				gate.release();
				await work;
			}
		});
	}
	test("stale startup substatus cleanup fails instead of overwriting a newer tag", async () => {
		sqlite.run("UPDATE narrators SET substatus = '[\"error\"]' WHERE id = 'n1'");
		expect(
			await settle(
				narratorService.updateSubstatus("n1", [], { expectedSubstatus: '["compacting"]' }),
			),
		).toMatchObject(conflict);
		expect(sqlite.query("SELECT substatus FROM narrators WHERE id = 'n1'").get()).toEqual({
			substatus: '["error"]',
		});
	});
});
