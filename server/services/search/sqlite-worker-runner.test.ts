import { describe, expect, test } from "bun:test";
import {
	createSqliteSearchQueryExecutor,
	SEARCH_MAX_OUTSTANDING,
	SEARCH_QUERY_TIMEOUT_MS,
} from "./sqlite-worker-runner";

const sql = "SELECT id FROM narrator_messages LIMIT ?";

describe("search worker admission and cancellation", () => {
	test("dispatches bounded SELECT and never accepts an oversized input", async () => {
		let calls = 0;
		const execute = createSqliteSearchQueryExecutor("/isolated/fixture.db", {
			runTask: async (path, task, options) => {
				calls++;
				expect(path).toBe("/isolated/fixture.db");
				expect(task).toEqual({ kind: "searchQuery", sql, params: [50], maxRows: 10_000 });
				expect(options.timeoutMs).toBe(SEARCH_QUERY_TIMEOUT_MS);
				expect(options.signal).toBeInstanceOf(AbortSignal);
				return [{ id: "latest" }];
			},
		});
		expect(await execute(sql, [50])).toEqual([{ id: "latest" }]);
		await expect(execute(sql, ["x".repeat(128 * 1024 + 1)])).rejects.toMatchObject({
			code: "SEARCH_QUERY_BUDGET_EXCEEDED",
		});
		await expect(execute("DELETE FROM narrator_messages", [])).rejects.toMatchObject({
			code: "SEARCH_QUERY_BUDGET_EXCEEDED",
		});
		expect(calls).toBe(1);
	});

	test("bounds outstanding work and releases admission after success", async () => {
		let finish: (rows: Record<string, unknown>[]) => void = () => {};
		const execute = createSqliteSearchQueryExecutor("/isolated/fixture.db", {
			maxOutstanding: 1,
			runTask: () =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		});
		const first = execute(sql, [1]);
		await expect(execute(sql, [1])).rejects.toMatchObject({ code: "SEARCH_QUERY_BUSY" });
		finish([]);
		await first;
		const next = execute(sql, [1]);
		finish([{ id: "second" }]);
		expect(await next).toEqual([{ id: "second" }]);
		expect(SEARCH_MAX_OUTSTANDING).toBe(32);
	});

	test("worker failure does not execute SQL locally and frees the slot", async () => {
		let calls = 0;
		const execute = createSqliteSearchQueryExecutor("/isolated/fixture.db", {
			maxOutstanding: 1,
			runTask: async () => {
				calls++;
				throw new Error("Worker unavailable");
			},
		});
		for (let i = 0; i < 2; i++) {
			await expect(execute(sql, [1])).rejects.toMatchObject({ code: "SEARCH_QUERY_UNAVAILABLE" });
		}
		expect(calls).toBe(2);
	});

	test("already aborted requests never dispatch", async () => {
		let calls = 0;
		const controller = new AbortController();
		controller.abort();
		const execute = createSqliteSearchQueryExecutor("/isolated/fixture.db", {
			runTask: async () => {
				calls++;
				return [];
			},
		});
		await expect(execute(sql, [1], { signal: controller.signal })).rejects.toMatchObject({
			code: "SEARCH_QUERY_CANCELLED",
		});
		expect(calls).toBe(0);
	});

	test("cancels a cold or running worker and frees admission without waiting for its reply", async () => {
		let workerSignal: AbortSignal | undefined;
		const controller = new AbortController();
		const execute = createSqliteSearchQueryExecutor("/isolated/fixture.db", {
			maxOutstanding: 1,
			runTask: async (_, __, options) => {
				workerSignal = options.signal;
				return new Promise(() => {});
			},
		});
		const first = execute(sql, [1], { signal: controller.signal });
		controller.abort();
		await expect(first).rejects.toMatchObject({ code: "SEARCH_QUERY_CANCELLED" });
		expect(workerSignal?.aborted).toBe(true);
		const secondController = new AbortController();
		const second = execute(sql, [1], { signal: secondController.signal });
		secondController.abort();
		await expect(second).rejects.toMatchObject({ code: "SEARCH_QUERY_CANCELLED" });
	});

	test("deadline covers worker readiness and aborts the transport", async () => {
		let workerSignal: AbortSignal | undefined;
		const execute = createSqliteSearchQueryExecutor("/isolated/fixture.db", {
			timeoutMs: 25,
			runTask: async (_, __, options) => {
				workerSignal = options.signal;
				return new Promise(() => {});
			},
		});
		await expect(execute(sql, [1])).rejects.toMatchObject({ code: "SEARCH_QUERY_TIMEOUT" });
		expect(workerSignal?.aborted).toBe(true);
	});
});
