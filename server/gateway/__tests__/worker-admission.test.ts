import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import * as reader from "../../db/worker-read";
import { DbReadError } from "../../lib/db-worker/errors";
import {
	DbReadTaskExecutionError,
	DbReadTaskOverloadedError,
	DbReadTaskTimeoutError,
	WorkersUnavailableError,
} from "../../lib/db-worker/pool";
import { loadGatewayConfig } from "../config";
import { resolveGatewayAppUserId } from "../gateway";

const read = spyOn(reader, "readQuery");
afterEach(() => read.mockReset());
afterAll(() => read.mockRestore());

test("an empty gateway installation needs no preference read", async () => {
	read.mockResolvedValueOnce([]);
	expect(await resolveGatewayAppUserId()).toBeNull();
	read.mockResolvedValueOnce([]);
	expect((await loadGatewayConfig()).defaultPermissionMode).toBe("default");
	expect(read).toHaveBeenCalledTimes(2);
	for (const call of read.mock.calls)
		expect(call[1]).toEqual({ executionPolicy: "worker-required", maxRows: 5 });
});

test("gateway selection and preference reads remain bounded and Worker-required", async () => {
	const users = [
		{ id: "user", role: "user" },
		{ id: "admin", role: "admin" },
	];
	read.mockResolvedValueOnce(users);
	expect(await resolveGatewayAppUserId()).toBe("admin");
	read.mockResolvedValueOnce(users).mockImplementationOnce(
		async () =>
			({
				gatewayConfig: JSON.stringify({ defaultPermissionMode: "default" }),
			}) as never,
	);
	expect((await loadGatewayConfig()).defaultPermissionMode).toBe("default");
	expect(read).toHaveBeenCalledTimes(3);
	expect(read.mock.calls[2]?.[1]).toEqual({ executionPolicy: "worker-required", maxRows: 1 });
});

for (const error of [
	new DbReadTaskOverloadedError(),
	new WorkersUnavailableError("disabled"),
	new DbReadTaskTimeoutError("timed out"),
	new DbReadError("DB_READ_ABORTED", "aborted"),
	Object.assign(new DbReadTaskExecutionError("query failed"), { code: "SQLITE_ERROR" }),
]) {
	for (const stage of ["users", "preferences"] as const) {
		test(`gateway config propagates ${error.name}/${error.code} at ${stage} without retry`, async () => {
			if (stage === "preferences") read.mockResolvedValueOnce([{ id: "admin", role: "admin" }]);
			read.mockRejectedValueOnce(error);
			await expect(loadGatewayConfig()).rejects.toBe(error);
			expect(read).toHaveBeenCalledTimes(stage === "preferences" ? 2 : 1);
		});
	}
}
