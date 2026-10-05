import { afterAll, afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { ExecFileOptions } from "node:child_process";

const platform = { ...(await import("../../../server/lib/platform")) };
const childProcess = { ...(await import("node:child_process")) };
const execute = mock(
	(
		_command: string,
		_args: string[],
		_options: ExecFileOptions,
		callback: (error: Error | null, stdout: string) => void,
	) => callback(null, ""),
);
mock.module("../../../server/lib/platform", () => ({ ...platform, IS_WINDOWS: true }));
mock.module("node:child_process", () => ({ ...childProcess, execFile: execute }));
const { readWindowsExcludedPortRangesAsync } = await import(
	"../../../server/lib/windows-excluded-ports"
);

afterEach(() => {
	mock.restore();
	execute.mockReset();
});
afterAll(() => {
	mock.module("../../../server/lib/platform", () => platform);
	mock.module("node:child_process", () => childProcess);
});

function respond(error: Error | null, stdout: string) {
	execute.mockImplementation((_command, _args, _options, callback) => callback(error, stdout));
}

describe("Windows async excluded port detection", () => {
	it("uses bounded async execution and parses the reported reservation", async () => {
		respond(null, "开始端口 结束端口\n1356 1455\n1456 1555\n");
		expect(await readWindowsExcludedPortRangesAsync()).toEqual([{ start: 1356, end: 1555 }]);
		expect(execute).toHaveBeenCalledWith(
			"netsh",
			["interface", "ipv4", "show", "excludedportrange", "protocol=tcp"],
			{ timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true },
			expect.any(Function),
		);
	});

	it("does not trust partial output after timeout or buffer overflow", async () => {
		for (const code of ["ETIMEDOUT", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"]) {
			respond(Object.assign(new Error(code), { code }), "1356 1455\n");
			expect(await readWindowsExcludedPortRangesAsync()).toEqual([]);
		}
	});

	it("fails open on command failure or missing netsh", async () => {
		for (const code of ["EACCES", "ENOENT"]) {
			respond(Object.assign(new Error(code), { code }), "");
			expect(await readWindowsExcludedPortRangesAsync()).toEqual([]);
		}
	});

	it("reads fresh ranges rather than caching across calls", async () => {
		respond(null, "1356 1455\n");
		expect(await readWindowsExcludedPortRangesAsync()).toEqual([{ start: 1356, end: 1455 }]);
		respond(null, "2000 2100\n");
		expect(await readWindowsExcludedPortRangesAsync()).toEqual([{ start: 2000, end: 2100 }]);
		expect(execute).toHaveBeenCalledTimes(2);
	});

	it("real timeout cleanup remains asynchronous and discards partial output", async () => {
		const sync = spyOn(Bun, "spawnSync").mockImplementation(() => {
			throw new Error("Synchronous subprocess cleanup is forbidden");
		});
		execute.mockImplementation((_command, _args, options, callback) => {
			childProcess.execFile(
				process.execPath,
				["-e", 'console.log("1356 1455"); setInterval(() => {}, 1000);'],
				{ ...options, timeout: 100, encoding: "utf8" },
				(error, stdout) => callback(error, stdout),
			);
		});
		let ticks = 0;
		const timer = setInterval(() => ticks++, 10);
		try {
			expect(await readWindowsExcludedPortRangesAsync()).toEqual([]);
			expect(ticks).toBeGreaterThan(0);
			expect(sync).not.toHaveBeenCalled();
		} finally {
			clearInterval(timer);
		}
	});

	it("real output overflow fails open without synchronous cleanup", async () => {
		const sync = spyOn(Bun, "spawnSync").mockImplementation(() => {
			throw new Error("Synchronous subprocess cleanup is forbidden");
		});
		execute.mockImplementation((_command, _args, options, callback) => {
			childProcess.execFile(
				process.execPath,
				["-e", 'console.log("1356 1455"); console.log("x".repeat(100000));'],
				{ ...options, encoding: "utf8" },
				(error, stdout) => callback(error, stdout),
			);
		});
		expect(await readWindowsExcludedPortRangesAsync()).toEqual([]);
		expect(sync).not.toHaveBeenCalled();
	});
});
