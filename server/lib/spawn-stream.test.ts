import { describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { safeSpawn } from "./spawn";

// Windows may perform the one-time inheritable-handle scan before the first spawn.
setDefaultTimeout(30_000);

const child = (source: string) => [process.execPath, "-e", source];

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
