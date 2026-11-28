import type { Pointer } from "bun:ffi";
import { describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { WindowsPluginJobNative } from "../../../server/lib/plugins/windows-plugin-job";
import {
	buildWindowsPluginLauncherCommand,
	launchWindowsPluginTarget,
	WINDOWS_PLUGIN_LAUNCHER_MODE,
} from "../../../server/lib/plugins/windows-plugin-launcher";
import { spawnWindowsPluginProcess } from "../../../server/lib/plugins/windows-plugin-process";
import { WorkerCleanupError, WorkerHandle } from "../../../server/lib/worker-runtime/lifecycle";
import {
	LocalProcessRunner,
	type RunnerProcess,
	type RunnerSpawnOptions,
} from "../../../server/services/plugin-runtime";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const jobName = "Local\\NarraForkPlugin-12345678-1234-1234-1234-123456789abc";
const job = 1 as Pointer;
const cwd = join(import.meta.dir, "../../fixtures/plugins/runtime");
const command = [process.execPath, join(cwd, "fixture.ts"), "normal"];
const options: RunnerSpawnOptions = {
	cwd,
	env: { PATH: "original-allowlisted-path" },
	stdin: "pipe",
	stdout: "pipe",
	stderr: "pipe",
	detached: false,
};

function fixture() {
	const calls: string[] = [];
	let active = 0;
	const native: WindowsPluginJobNative = {
		create() {
			calls.push("create");
			return job;
		},
		open() {
			calls.push("open");
			return job;
		},
		assignCurrent() {
			calls.push("assign");
		},
		terminate() {
			calls.push("terminate");
		},
		activeProcesses() {
			calls.push("query");
			return active;
		},
		close() {
			calls.push("close");
		},
	};
	const exit = Promise.withResolvers<number>();
	let stdout!: ReadableStreamDefaultController<Uint8Array>;
	let stderr!: ReadableStreamDefaultController<Uint8Array>;
	let stdoutClosed = false;
	let stderrClosed = false;
	let stopExits = true;
	const resource = {
		pid: 42,
		stdin: { write: (data: Uint8Array) => data.byteLength, flush() {}, end() {} },
		stdout: new ReadableStream<Uint8Array>({
			start(controller) {
				stdout = controller;
			},
		}),
		stderr: new ReadableStream<Uint8Array>({
			start(controller) {
				stderr = controller;
			},
		}),
		exited: exit.promise,
	};
	const closeStdout = () => {
		if (stdoutClosed) return;
		stdoutClosed = true;
		stdout.close();
	};
	const closeStderr = () => {
		if (stderrClosed) return;
		stderrClosed = true;
		stderr.close();
	};
	const finish = (code = 0) => {
		closeStdout();
		closeStderr();
		exit.resolve(code);
	};
	const raw = new WorkerHandle(resource, exit.promise, () => {
		calls.push("stop-wrapper");
		if (stopExits) finish(1);
	});
	let capturedCommand: string[] | undefined;
	let capturedOptions: RunnerSpawnOptions | undefined;
	const spawn = (argv: string[], spawnOptions: RunnerSpawnOptions) => {
		calls.push("spawn-wrapper");
		capturedCommand = argv;
		capturedOptions = spawnOptions;
		return raw as unknown as WorkerHandle<Bun.Subprocess<"pipe", "pipe", "pipe">>;
	};
	const start = () => spawnWindowsPluginProcess(command, options, 1_000, { native, spawn });
	return {
		calls,
		native,
		start,
		finish,
		exit: exit.resolve,
		closeStdout,
		closeStderr,
		setActive(count: number) {
			active = count;
		},
		keepWrapperAlive() {
			stopExits = false;
		},
		captured: () => ({ command: capturedCommand, options: capturedOptions }),
	};
}

function runnerFor(process: RunnerProcess) {
	return new LocalProcessRunner({
		platform: "win32",
		allowUnboundedResourceUsage: true,
		spawn: () => process,
	});
}

describe("Windows plugin job exit barriers (deterministic native adapter)", () => {
	test("natural root exit stops descendants and holds admission until job active=0", async () => {
		const f = fixture();
		f.setActive(2);
		const process = f.start();
		const runner = runnerFor(process);
		const handle = await runner.start({ command, cwd });
		let exited = false;
		void handle.exited.then(() => {
			exited = true;
		});
		f.finish(0); // Root is gone; two descendants are still active in the job.
		await turn();
		expect(f.calls).toContain("terminate");
		expect(f.calls).not.toContain("stop-wrapper");
		expect(f.calls).not.toContain("close");
		expect(exited).toBe(false);
		await expect(runner.start({ command, cwd })).rejects.toMatchObject({ code: "TASK_QUEUE_FULL" });
		f.setActive(0);
		expect(await handle.exited).toBe(0);
		expect(f.calls.at(-1)).toBe("close");
		expect(f.calls.filter((call) => call === "close")).toHaveLength(1);
		await runner.close();
	});

	test("cancellation before assignment waits for actual wrapper exit, then re-stops the job", async () => {
		const f = fixture();
		f.keepWrapperAlive();
		const process = f.start();
		const runner = runnerFor(process);
		const handle = await runner.start({ command, cwd });
		const closing = handle.terminate?.();
		await turn();
		expect(f.calls.slice(-2)).toEqual(["terminate", "stop-wrapper"]);
		expect(f.calls).not.toContain("query");
		expect(f.calls).not.toContain("close");
		await expect(runner.start({ command, cwd })).rejects.toMatchObject({ code: "TASK_QUEUE_FULL" });
		// Model assignment+target launch racing with the initial termination call.
		f.setActive(1);
		f.finish(1);
		await turn();
		expect(f.calls.filter((call) => call === "terminate")).toHaveLength(2);
		expect(f.calls).not.toContain("close");
		f.setActive(0);
		await closing;
		expect(await handle.exited).toBe(1);
		expect(f.calls.at(-1)).toBe("close");
		await runner.close();
	});

	test("job active=0 and wrapper exit do not release admission before both original pipes drain", async () => {
		const f = fixture();
		const runner = runnerFor(f.start());
		const handle = await runner.start({ command, cwd });
		f.exit(0);
		f.closeStdout();
		await turn();
		await expect(runner.start({ command, cwd })).rejects.toMatchObject({ code: "TASK_QUEUE_FULL" });
		f.closeStderr();
		expect(await handle.exited).toBe(0);
		await runner.close();
	});

	for (const operation of ["terminate", "activeProcesses", "close"] as const) {
		test(`${operation} native failure retains job handle and admission without taskkill fallback`, async () => {
			const f = fixture();
			f.native[operation] = () => {
				throw new Error("sensitive native error /private/path");
			};
			const runner = runnerFor(f.start());
			const handle = await runner.start({ command, cwd });
			f.finish();
			await expect(handle.exited).rejects.toThrow("Plugin Windows job");
			expect(f.calls).not.toContain("close");
			await expect(runner.start({ command, cwd })).rejects.toMatchObject({
				code: "TASK_QUEUE_FULL",
			});
			await expect(handle.terminate?.()).rejects.toBeInstanceOf(WorkerCleanupError);
			await expect(runner.close()).rejects.toBeInstanceOf(AggregateError);
		});
	}

	test("active-process timeout does not close an unconfirmed job or release its slot", async () => {
		const f = fixture();
		f.setActive(1);
		const runner = runnerFor(f.start());
		const handle = await runner.start({ command, cwd });
		const now = Date.now();
		let clockReads = 0;
		const clock = spyOn(Date, "now").mockImplementation(() => now + (clockReads++ ? 1_001 : 0));
		try {
			f.finish();
			await expect(handle.exited).rejects.toThrow("job exit unconfirmed");
			expect(f.calls).not.toContain("close");
			await expect(runner.start({ command, cwd })).rejects.toMatchObject({
				code: "TASK_QUEUE_FULL",
			});
			await expect(runner.close()).rejects.toBeInstanceOf(AggregateError);
		} finally {
			clock.mockRestore();
		}
	});

	test("unconfirmed wrapper exit retains the job even when its active-process query is zero", async () => {
		const f = fixture();
		f.keepWrapperAlive();
		const runner = runnerFor(f.start());
		const handle = await runner.start({ command, cwd });
		const original = globalThis.setTimeout;
		let deadline: (() => void) | undefined;
		const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: () => void,
			delay?: number,
		) => {
			if (delay !== undefined && delay > 500 && delay <= 1_000) deadline = callback;
			return original(callback, delay);
		}) as typeof setTimeout);
		try {
			const terminating = handle.terminate?.();
			void terminating?.catch(() => {});
			await turn();
			expect(deadline).toBeFunction();
			deadline?.(); // Inject the existing tree deadline; do not change the budget.
			await expect(terminating).rejects.toBeInstanceOf(WorkerCleanupError);
			expect(f.calls).not.toContain("close");
			await expect(runner.start({ command, cwd })).rejects.toMatchObject({
				code: "TASK_QUEUE_FULL",
			});
			f.finish();
			await expect(handle.exited).rejects.toThrow("launcher exit unconfirmed");
			await expect(runner.close()).rejects.toBeInstanceOf(AggregateError);
		} finally {
			f.finish();
			timer.mockRestore();
		}
	});

	test("job creation failure never constructs a launcher", () => {
		const f = fixture();
		f.native.create = () => {
			throw new Error("create failed");
		};
		expect(() => f.start()).toThrow("create failed");
		expect(f.calls).not.toContain("spawn-wrapper");
		f.finish();
	});

	test("launcher command carries original argv and the identical allowlisted environment", async () => {
		const f = fixture();
		const process = f.start();
		const captured = f.captured();
		expect(captured.command?.slice(-command.length)).toEqual(command);
		expect(captured.command?.[2]).toMatch(/^Local\\NarraForkPlugin-/);
		expect(captured.options).toBe(options);
		f.finish();
		await process.exited;
	});
});

async function boundedPipe(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return Buffer.concat(chunks).toString("utf8");
			bytes += value.byteLength;
			if (bytes > 1_024) throw new Error("Native launcher fixture exceeded output budget");
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
}

describe("Windows native plugin jobs", () => {
	test.skipIf(process.platform !== "win32")(
		"real root exits naturally while its surviving child remains owned until the job exits",
		async () => {
			const childSource = "setInterval(() => {}, 1_000)";
			const rootSource = `const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(childSource)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }); child.unref(); console.log(child.pid); process.exit(0);`;
			const runner = spawnWindowsPluginProcess(
				[process.execPath, "-e", rootSource],
				options,
				1_000,
			);
			try {
				const [code, stdout, stderr] = await Promise.all([
					runner.exited,
					boundedPipe(runner.stdout),
					boundedPipe(runner.stderr),
				]);
				expect(code).toBe(0);
				expect(stderr).toBe("");
				const childPid = Number(stdout.trim());
				expect(Number.isSafeInteger(childPid) && childPid > 0).toBe(true);
				expect(() => process.kill(childPid, 0)).toThrow();
				await runner.terminate?.();
			} finally {
				await runner.terminate?.().catch(() => {});
			}
		},
	);

	test.skipIf(process.platform !== "win32")(
		"a real launcher cannot execute a target when the named owner job does not exist",
		async () => {
			const absentJob = `Local\\NarraForkPlugin-${randomUUID()}`;
			const runner = WorkerHandle.subprocess(
				buildWindowsPluginLauncherCommand(absentJob, [
					process.execPath,
					"-e",
					'console.log("TARGET_MUST_NOT_RUN")',
				]),
				{ ...options, windowsHide: true },
			);
			try {
				const [code, stdout, stderr] = await Promise.all([
					runner.exited,
					boundedPipe(runner.resource.stdout),
					boundedPipe(runner.resource.stderr),
				]);
				expect(code).toBe(1);
				expect(stdout).toBe("");
				expect(stderr.trim()).toBe("Plugin Windows launcher failed");
			} finally {
				await runner.close();
			}
		},
	);
});

describe("Windows trusted plugin launcher", () => {
	test("source and compiled builders share the job/command protocol without a new top-level flag", () => {
		const source = buildWindowsPluginLauncherCommand(jobName, command, false, "bun");
		expect(source[0]).toBe("bun");
		expect(source[1]).toBe(
			join(import.meta.dir, "../../../server/lib/plugins/windows-plugin-launcher.ts"),
		);
		expect(source.slice(2)).toEqual([jobName, ...command]);
		expect(buildWindowsPluginLauncherCommand(jobName, command, true, "narrafork.exe")).toEqual([
			"narrafork.exe",
			"--plugin-runtime-worker",
			WINDOWS_PLUGIN_LAUNCHER_MODE,
			jobName,
			...command,
		]);
	});

	test("assignment and launcher handle close precede target execution, preserving original argv", async () => {
		const f = fixture();
		let spawned: string[] | undefined;
		const code = await launchWindowsPluginTarget([jobName, ...command], f.native, (argv) => {
			f.calls.push("spawn-target");
			spawned = argv;
			return new WorkerHandle({ exited: Promise.resolve(7) }, Promise.resolve(7), () => {
				throw new Error("A naturally exited target must not be killed");
			});
		});
		expect(code).toBe(7);
		expect(spawned).toEqual(command);
		expect(f.calls).toEqual(["open", "assign", "close", "spawn-target"]);
		f.finish();
	});

	for (const operation of ["open", "assignCurrent", "close"] as const) {
		test(`${operation} failure never executes the original target`, async () => {
			const f = fixture();
			f.native[operation] = () => {
				throw new Error("ownership unavailable");
			};
			let spawned = false;
			await expect(
				launchWindowsPluginTarget([jobName, ...command], f.native, () => {
					spawned = true;
					throw new Error("target must never be spawned");
				}),
			).rejects.toThrow("ownership unavailable");
			expect(spawned).toBe(false);
			f.finish();
		});
	}
});
