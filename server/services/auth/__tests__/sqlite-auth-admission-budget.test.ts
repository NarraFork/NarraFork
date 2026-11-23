import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import * as reader from "../../../db/worker-read";
import { WorkersUnavailableError } from "../../../lib/db-worker/pool";
import { authRead } from "../sqlite-auth-read";

const query = {} as Parameters<typeof authRead<number>>[0];
const read = spyOn(reader, "readQuery");
afterEach(() => read.mockReset());
afterAll(() => read.mockRestore());

test("authentication forwards one absolute budget to a Worker-required short read", async () => {
	read.mockResolvedValueOnce([1]);
	const deadlineAt = Date.now() + 2_000;
	expect(await authRead<number>(query, { deadlineAt })).toEqual([1]);
	expect(read).toHaveBeenCalledTimes(1);
	expect(read.mock.calls[0]?.[0]).toBe(query);
	expect(read.mock.calls[0]?.[1]).toMatchObject({
		executionPolicy: "worker-required",
		shortRead: true,
		maxRows: 1,
		diagnosticSource: "auth.session",
	});
	const options = read.mock.calls[0]?.[1];
	expect(options?.timeoutMs).toBeGreaterThan(0);
	expect(options?.timeoutMs).toBeLessThanOrEqual(2_000);
	expect(options?.signal?.aborted).toBe(false);
});

test("expired and canceled callers do not dispatch authentication queries", async () => {
	await expect(authRead(query, { deadlineAt: Date.now() - 1 })).rejects.toMatchObject({
		code: "DB_READ_TASK_TIMEOUT",
	});
	const controller = new AbortController();
	controller.abort(new Error("private reason"));
	await expect(authRead(query, { signal: controller.signal })).rejects.toMatchObject({
		name: "AbortError",
		code: "DB_READ_ABORTED",
		message: "database read task aborted",
	});
	expect(read).not.toHaveBeenCalled();
});

test("Worker unavailability propagates without retry or main-thread execution", async () => {
	const failure = new WorkersUnavailableError("disabled");
	read.mockRejectedValueOnce(failure);
	await expect(authRead(query)).rejects.toBe(failure);
	expect(read).toHaveBeenCalledTimes(1);
});
