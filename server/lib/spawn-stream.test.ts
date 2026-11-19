import { describe, expect, mock, setDefaultTimeout, spyOn, test } from "bun:test";
import { logger } from "./logger";
import { safeSpawn } from "./spawn";

// Windows may perform the one-time inheritable-handle scan before the first spawn.
setDefaultTimeout(30_000);

const child = (source: string) => [process.execPath, "-e", source];

describe("safeSpawn termination diagnostics", () => {
	function subprocess(stdout = "out", stderr = "err") {
		const exit = Promise.withResolvers<number>();
		const kill = mock(() => exit.resolve(143));
		const process = {
			stdout: new Blob([stdout]).stream(),
			stderr: new Blob([stderr]).stream(),
			exited: exit.promise,
			kill,
		} as unknown as ReturnType<typeof Bun.spawn>;
		return { process, exit, kill };
	}

	test("capture kill reasons are opt-in while captured output and default result keys stay stable", async () => {
		const deadline: { fire?: () => void } = {};
		const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((fire: () => void) => {
			deadline.fire = fire;
			return 1;
		}) as unknown as typeof setTimeout);
		const clear = spyOn(globalThis, "clearTimeout").mockImplementation(() => {
			deadline.fire = undefined;
		});
		const warning = spyOn(logger, "warn").mockImplementation(() => {});
		const spawn = spyOn(Bun, "spawn");
		try {
			for (const includeTerminationReason of [undefined, false, true]) {
				const child = subprocess();
				spawn.mockReturnValue(child.process);
				const pending = safeSpawn({
					cmd: ["fixture-child"],
					timeout: 10_000,
					includeTerminationReason,
				});
				expect(deadline.fire).toBeDefined();
				deadline.fire?.();
				const result = await pending;
				expect(child.kill).toHaveBeenCalledTimes(1);
				expect(result).toMatchObject({
					stdout: "out",
					stderr: "err",
					exitCode: 143,
					stdoutTruncated: false,
					stderrTruncated: false,
				});
				if (includeTerminationReason) expect(result.terminationReason).toBe("timeout");
				else
					expect(Object.keys(result)).toEqual([
						"stdout",
						"stderr",
						"exitCode",
						"stdoutTruncated",
						"stderrTruncated",
					]);
				expect(deadline.fire).toBeUndefined();
			}
		} finally {
			spawn.mockRestore();
			warning.mockRestore();
			clear.mockRestore();
			timeout.mockRestore();
		}
	});

	test("capture diagnostics retain truncation and draining without terminating at the byte limit", async () => {
		const child = subprocess("output exceeds budget");
		child.exit.resolve(0);
		const spawn = spyOn(Bun, "spawn").mockReturnValue(child.process);
		try {
			const result = await safeSpawn({
				cmd: ["fixture-child"],
				maxOutputBytes: 3,
				includeTerminationReason: true,
			});
			expect(result).toMatchObject({
				exitCode: 0,
				stdoutTruncated: true,
				stderrTruncated: false,
			});
			expect(result).toHaveProperty("terminationReason", undefined);
			expect(child.kill).not.toHaveBeenCalled();
		} finally {
			spawn.mockRestore();
		}
	});

	test("opted-in streaming retains the output-limit reason and existing byte budget", async () => {
		const child = subprocess("output exceeds budget");
		const spawn = spyOn(Bun, "spawn").mockReturnValue(child.process);
		let bytes = 0;
		try {
			const result = await safeSpawn({
				cmd: ["fixture-child"],
				includeTerminationReason: true,
				stdoutStream: {
					maxBytes: 3,
					onChunk: (chunk) => {
						bytes += chunk.byteLength;
					},
				},
			});
			expect(result).toMatchObject({
				terminationReason: "output-limit",
				stdout: "",
				stderr: "err",
				stdoutTruncated: true,
			});
			expect(bytes).toBe(3);
			expect(child.kill).toHaveBeenCalledTimes(1);
		} finally {
			spawn.mockRestore();
		}
	});
});

describe("safeSpawn opt-in streaming", () => {
	test("default capture still returns stdout and stderr", async () => {
		const result = await safeSpawn({
			cmd: child('process.stdout.write("out"); process.stderr.write("err")'),
			timeout: 5000,
		});
		expect(result.stdout).toBe("out");
		expect(result.stderr).toBe("err");
		expect(result).not.toHaveProperty("terminationReason");
	});

	test("infinite output is killed at the byte budget without retained stdout", async () => {
		let bytes = 0;
		const result = await safeSpawn({
			cmd: child('setInterval(() => process.stdout.write("x".repeat(16384)), 1)'),
			timeout: 5000,
			stdoutStream: {
				maxBytes: 1234,
				onChunk: (chunk) => {
					bytes += chunk.byteLength;
				},
			},
		});
		expect(bytes).toBe(1234);
		expect(result.stdout).toBe("");
		expect(result.terminationReason).toBe("output-limit");
		expect(result.stdoutTruncated).toBe(true);
	});

	test("consumer stop is distinct and stderr is capped independently", async () => {
		const result = await safeSpawn({
			cmd: child(
				'process.stderr.write("e".repeat(20000)); setInterval(() => process.stdout.write("ok"), 10)',
			),
			timeout: 5000,
			maxStderrBytes: 4096,
			stdoutStream: { maxBytes: 10000, onChunk: () => false },
		});
		expect(result.terminationReason).toBe("consumer");
		expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(4096);
		expect(result.stderrTruncated).toBe(true);
	});

	test("hard timeout is distinguishable from an intentional stop", async () => {
		const result = await safeSpawn({
			cmd: child("setInterval(() => {}, 1000)"),
			timeout: 100,
			stdoutStream: { maxBytes: 1000, onChunk: () => true },
		});
		expect(result.terminationReason).toBe("timeout");
	});

	test("abort terminates the stream and records cancellation", async () => {
		const controller = new AbortController();
		const result = await safeSpawn({
			cmd: child('setInterval(() => process.stdout.write("ok"), 1)'),
			timeout: 5000,
			signal: controller.signal,
			stdoutStream: {
				maxBytes: 10000,
				onChunk: () => {
					controller.abort();
				},
			},
		});
		expect(result.terminationReason).toBe("abort");
	});

	test("consumer exceptions terminate the producer rather than leak it", async () => {
		await expect(
			safeSpawn({
				cmd: child('setInterval(() => process.stdout.write("ok"), 1)'),
				timeout: 5000,
				stdoutStream: {
					maxBytes: 10000,
					onChunk: () => {
						throw new Error("parse failed");
					},
				},
			}),
		).rejects.toThrow("parse failed");
	});
});

describe("safeSpawn capture failures wait for real producer exit", () => {
	for (const pipe of ["stdout", "stderr"] as const) {
		for (const graceful of [true, false]) {
			test(`${pipe} reader failure kills and awaits the non-streaming producer${graceful ? "" : " (signal exit)"}`, async () => {
				const script =
					(graceful
						? 'process.on("SIGTERM", () => setTimeout(() => process.exit(0), 100)); '
						: "") +
					'process.stdout.write("ready"); process.stderr.write("ready"); setInterval(() => {}, 1000)';
				const original = Bun.spawn;
				let producer: ReturnType<typeof Bun.spawn> | undefined;
				let exited = false;
				let exitStatus: number | undefined;
				let killed = false;
				const spawn = spyOn(Bun, "spawn").mockImplementation((command, options?) => {
					const proc = original(command as never, options as never) as ReturnType<typeof Bun.spawn>;
					if (!Array.isArray(command) || command[2] !== script) return proc;
					producer = proc;
					void proc.exited.then((code) => {
						exitStatus = code;
						exited = true;
					});
					const actual = proc[pipe] as ReadableStream<Uint8Array>;
					const failed = new ReadableStream<Uint8Array>({
						async pull(controller) {
							const reader = actual.getReader();
							try {
								await reader.read();
							} finally {
								reader.releaseLock();
							}
							controller.error(new Error(`${pipe} read failed`));
						},
					});
					return new Proxy(proc, {
						get(target, property) {
							if (property === pipe) return failed;
							if (property === "kill")
								return (...args: Parameters<typeof proc.kill>) => {
									killed = true;
									return proc.kill(...args);
								};
							return Reflect.get(target, property, target);
						},
					});
				});
				try {
					await expect(safeSpawn({ cmd: child(script), timeout: 5000 })).rejects.toThrow(
						`${pipe} read failed`,
					);
					expect(producer).toBeDefined();
					expect(killed).toBe(true);
					expect(exited).toBe(true);
					expect(Number.isInteger(exitStatus)).toBe(true);
					// A terminated process can report a signal rather than a numeric exitCode.
					expect(producer?.exitCode ?? producer?.signalCode).not.toBeNull();
				} finally {
					spawn.mockRestore();
					if (producer && !exited) producer.kill("SIGKILL");
					await producer?.exited;
				}
			});
		}
	}
});
