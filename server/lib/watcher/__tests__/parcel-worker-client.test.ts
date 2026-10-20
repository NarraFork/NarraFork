/**
 * Parcel native-watcher worker client: stdin protocol + ACK lifecycle.
 *
 * Production failure (0.7.7): Bun.spawn `stdin: "pipe"` returns a FileSink, but
 * the client called Web `WritableStream.getWriter()`. The watch command never
 * reached the worker; each abandoned ACK timer then rejected ~5s later as an
 * unhandled rejection (first attempt + 3 retries = 4 timers).
 *
 * These tests pin the fix: FileSink write/flush/end, immediate pending cleanup
 * on send failure, ACK timeout without unhandled rejection, and a single
 * fallback after the coordinator's retry budget.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { logger } from "../../logger";
import { ParcelRecursiveWatcher } from "../parcel-watcher";
import {
	asWorkerStdinSink,
	encodeWorkerCommand,
	endWorkerStdin,
	isNativeWatcherEnabled,
	ParcelWorkerClient,
	type WorkerStdinSink,
	writeFileSinkCommand,
} from "../parcel-worker-client";
import { WATCHER_STAGES } from "../worker-protocol";

const timers = new Map<number, { callback: () => void; delay: number }>();
const fakeProcs: FakeProc[] = [];
const rejectionCollectors: ReturnType<typeof collectUnhandledRejections>[] = [];
let nextTimer: number;
let timeoutSpy: ReturnType<typeof spyOn<typeof globalThis, "setTimeout">>;
let clearTimeoutSpy: ReturnType<typeof spyOn<typeof globalThis, "clearTimeout">>;

// A real event-loop boundary drains stream/Promise continuations and lets Bun
// report unhandled rejections; it does not wait for an arbitrary elapsed delay.
const drainEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

async function fireTimeout(delay: number) {
	const matches = Array.from(timers).filter(([, timer]) => timer.delay === delay);
	expect(matches).toHaveLength(1);
	const entry = matches[0];
	if (!entry) throw new Error(`expected a registered ${delay}ms timeout`);
	const [id, timer] = entry;
	timers.delete(id);
	timer.callback();
	await drainEventLoop();
}

interface FakeFileSink extends WorkerStdinSink {
	writes: Uint8Array[];
	flushCount: number;
	endCount: number;
	getWriterCalls: number;
	failWrite: Error | null;
	failFlush: Error | null;
}

function createFakeFileSink(options?: {
	failWrite?: Error;
	writableStreamShape?: boolean;
}): FakeFileSink {
	const sink: FakeFileSink = {
		writes: [],
		flushCount: 0,
		endCount: 0,
		getWriterCalls: 0,
		failWrite: options?.failWrite ?? null,
		failFlush: null,
		write(chunk: Uint8Array) {
			if (options?.writableStreamShape) {
				sink.getWriterCalls++;
				throw new TypeError("r.getWriter is not a function");
			}
			if (sink.failWrite) throw sink.failWrite;
			sink.writes.push(chunk);
			return chunk.byteLength;
		},
		flush() {
			if (sink.failFlush) throw sink.failFlush;
			sink.flushCount++;
			return 0;
		},
		end() {
			sink.endCount++;
			return 0;
		},
	};
	if (options?.writableStreamShape) {
		// Regression guard: production stdin must not look like this.
		(sink as unknown as { getWriter: () => never }).getWriter = () => {
			sink.getWriterCalls++;
			throw new TypeError("r.getWriter is not a function");
		};
	}
	return sink;
}

interface FakeProc {
	pid: number;
	stdin: WorkerStdinSink | { getWriter(): never };
	stdout: ReadableStream<Uint8Array>;
	stderr: null;
	exited: Promise<number>;
	killed: boolean;
	emitLine(line: string): void;
	emitReady(): void;
	kill(): void;
}

function createFakeProc(stdin: WorkerStdinSink | { getWriter(): never }): FakeProc {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	let exitResolve!: (code: number) => void;
	const proc: FakeProc = {
		pid: 4242,
		stdin,
		stdout: new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
			},
		}),
		stderr: null,
		exited: new Promise((r) => {
			exitResolve = r;
		}),
		killed: false,
		emitLine(line: string) {
			controller.enqueue(new TextEncoder().encode(`${line}\n`));
		},
		emitReady() {
			proc.emitLine(JSON.stringify({ type: "ready", pid: proc.pid, backend: "inotify" }));
		},
		kill() {
			if (proc.killed) return;
			proc.killed = true;
			controller.close();
			exitResolve(1);
		},
	};
	fakeProcs.push(proc);
	return proc;
}

function pendingMapOf(client: ParcelWorkerClient): Map<string, { timer: unknown }> {
	return (client as unknown as { pending: Map<string, { timer: unknown }> }).pending;
}

function spawnAndInstall(options?: {
	failWrite?: Error;
	writableStreamShape?: boolean;
	autoAck?: boolean;
}): { sink: FakeFileSink; proc: FakeProc; spawn: ReturnType<typeof spyOn> } {
	const sink = createFakeFileSink(options);
	const proc = createFakeProc(options?.writableStreamShape ? (sink as never) : sink);

	if (options?.writableStreamShape) {
		// Replace stdin with a pure WritableStream-shaped object.
		const bad = {
			getWriter() {
				sink.getWriterCalls++;
				throw new TypeError("r.getWriter is not a function");
			},
		};
		proc.stdin = bad;
	}

	const originalWrite = sink.write.bind(sink);
	sink.write = (chunk: Uint8Array) => {
		const result = originalWrite(chunk);
		if (options?.autoAck) {
			const text = new TextDecoder().decode(chunk).trim();
			try {
				const msg = JSON.parse(text) as { type: string; requestId?: string; id?: string };
				if ((msg.type === "watch" || msg.type === "unwatch") && msg.requestId) {
					const requestId = msg.requestId;
					const id = msg.id ?? "";
					const ackType = msg.type === "watch" ? "watch_ack" : "unwatch_ack";
					queueMicrotask(() => {
						proc.emitLine(JSON.stringify({ type: ackType, requestId, id }));
					});
				}
			} catch {
				// ignore non-json
			}
		}
		return result;
	};

	const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
		proc.emitReady();
		return proc as unknown as ReturnType<typeof Bun.spawn>;
	});

	return { sink, proc, spawn };
}

function collectUnhandledRejections(): {
	rejections: unknown[];
	stop: () => void;
} {
	const rejections: unknown[] = [];
	const handler = (reason: unknown) => {
		rejections.push(reason);
	};
	process.on("unhandledRejection", handler);
	const collector = {
		rejections,
		stop: () => {
			process.off("unhandledRejection", handler);
		},
	};
	rejectionCollectors.push(collector);
	return collector;
}

const previousEnv = process.env.NARRAFORK_ENABLE_NATIVE_WATCHER;

beforeEach(() => {
	nextTimer = 1;
	timers.clear();
	fakeProcs.length = 0;
	rejectionCollectors.length = 0;
	timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
		callback: (...args: unknown[]) => void,
		delay = 0,
		...args: unknown[]
	) => {
		const id = nextTimer++;
		timers.set(id, { callback: () => callback(...args), delay });
		return id;
	}) as typeof setTimeout);
	clearTimeoutSpy = spyOn(globalThis, "clearTimeout").mockImplementation(((id: number) => {
		timers.delete(id);
	}) as typeof clearTimeout);
});

afterEach(async () => {
	try {
		// Execute shutdown's actual deferred kill before restoring any globals.
		// Multiple shutdown calls may register more than one such callback.
		for (const [id, timer] of timers) {
			if (timer.delay !== 500) continue;
			timers.delete(id);
			timer.callback();
		}
		for (const proc of fakeProcs) proc.kill();
		await drainEventLoop();
		// Every fake process has exited and its stdout reader released the lock;
		// no pending ACK/retry callback is left to run after this test.
		expect(fakeProcs.every((proc) => !proc.stdout.locked)).toBe(true);
		expect(timers.size).toBe(0);
		for (const collector of rejectionCollectors) expect(collector.rejections).toEqual([]);
	} finally {
		for (const collector of rejectionCollectors) collector.stop();
		rejectionCollectors.length = 0;
		fakeProcs.length = 0;
		timers.clear();
		clearTimeoutSpy.mockRestore();
		timeoutSpy.mockRestore();
		const spawn = Bun.spawn as unknown as { mockRestore?: () => void };
		spawn.mockRestore?.();
		if (previousEnv === undefined) {
			delete process.env.NARRAFORK_ENABLE_NATIVE_WATCHER;
		} else {
			process.env.NARRAFORK_ENABLE_NATIVE_WATCHER = previousEnv;
		}
	}
});

describe("FileSink write protocol", () => {
	test("asWorkerStdinSink accepts FileSink and rejects WritableStream shape", () => {
		const good = createFakeFileSink();
		expect(asWorkerStdinSink(good)).toBe(good);

		const writableOnly = {
			getWriter() {
				return { write: async () => {}, releaseLock: () => {} };
			},
		};
		expect(asWorkerStdinSink(writableOnly)).toBeUndefined();
		expect(asWorkerStdinSink(undefined)).toBeUndefined();
		expect(asWorkerStdinSink(null)).toBeUndefined();
	});

	test("writeFileSinkCommand uses write+flush, never getWriter", async () => {
		const sink = createFakeFileSink();
		const data = encodeWorkerCommand({
			type: "watch",
			requestId: "req-1",
			id: "/tmp/wt",
			path: "/tmp/wt",
			ignore: [],
		});

		await writeFileSinkCommand(sink, data);

		expect(sink.writes).toHaveLength(1);
		expect(sink.flushCount).toBe(1);
		expect(sink.getWriterCalls).toBe(0);
		const first = sink.writes[0];
		if (!first) throw new Error("expected one FileSink write");
		const line = new TextDecoder().decode(first);
		expect(line.endsWith("\n")).toBe(true);
		expect(JSON.parse(line.trim())).toEqual({
			type: "watch",
			requestId: "req-1",
			id: "/tmp/wt",
			path: "/tmp/wt",
			ignore: [],
		});
	});

	test("writeFileSinkCommand awaits thenable write/flush results", async () => {
		const order: string[] = [];
		const sink: WorkerStdinSink = {
			write() {
				return Promise.resolve().then(() => {
					order.push("write");
					return 1;
				});
			},
			flush() {
				return Promise.resolve().then(() => {
					order.push("flush");
					return 0;
				});
			},
			end() {
				return 0;
			},
		};
		await writeFileSinkCommand(sink, new Uint8Array([1, 2, 3]));
		expect(order).toEqual(["write", "flush"]);
	});

	test("endWorkerStdin calls end and swallows failures", () => {
		const sink = createFakeFileSink();
		endWorkerStdin(sink);
		expect(sink.endCount).toBe(1);

		const broken: WorkerStdinSink = {
			write: () => 0,
			flush: () => 0,
			end() {
				throw new Error("already closed");
			},
		};
		expect(() => endWorkerStdin(broken)).not.toThrow();
	});

	test("client send writes JSONL through FileSink after ready", async () => {
		process.env.NARRAFORK_ENABLE_NATIVE_WATCHER = "1";
		const { sink, proc, spawn } = spawnAndInstall({ autoAck: true });
		const client = new ParcelWorkerClient(
			() => {},
			() => {},
		);

		try {
			const sub = await client.watch("/tmp/nf-watcher-test", [".git"]);
			expect(pendingMapOf(client).size).toBe(0);
			expect(timers.size).toBe(0);
			expect(sink.getWriterCalls).toBe(0);
			expect(sink.flushCount).toBeGreaterThan(0);
			expect(sink.writes.length).toBeGreaterThan(0);

			const watchLine = sink.writes
				.map((w) => new TextDecoder().decode(w))
				.find((line) => line.includes('"type":"watch"'));
			if (!watchLine) throw new Error("expected a watch JSONL write");
			expect(watchLine.trim().endsWith("}")).toBe(true);
			const parsed = JSON.parse(watchLine.trim()) as { type: string; path: string };
			expect(parsed.type).toBe("watch");
			expect(parsed.path).toBe("/tmp/nf-watcher-test");

			await client.shutdown();
			// shutdown command then end() on the sink
			await fireTimeout(500);
			expect(sink.endCount).toBeGreaterThan(0);
			await sub.unsubscribe().catch(() => {});
			expect(proc.killed || sink.endCount > 0).toBe(true);
		} finally {
			spawn.mockRestore();
			await client.shutdown().catch(() => {});
		}
	});
});

describe("pending ACK lifecycle", () => {
	test("send failure settles pending immediately — no leftover timer", async () => {
		process.env.NARRAFORK_ENABLE_NATIVE_WATCHER = "1";
		const sendError = new Error("watcher worker stdin is not available");
		const { sink, spawn } = spawnAndInstall({ failWrite: sendError });
		const client = new ParcelWorkerClient(
			() => {},
			() => {},
		);
		const collector = collectUnhandledRejections();

		try {
			await expect(client.watch("/tmp/nf-pending", [])).rejects.toThrow(
				/stdin is not available|not a function/,
			);
			const pending = pendingMapOf(client);
			expect(pending.size).toBe(0);
			expect(sink.flushCount).toBe(0);

			// An empty pending map alone could hide an orphaned ACK callback.
			// Check the actual registered timers and drain the rejection boundary.
			expect(timers.size).toBe(0);
			await drainEventLoop();
			expect(pending.size).toBe(0);

			// The public unwatch path also creates a pending before send fails.
			await client.unwatch("/tmp/nf-pending").catch(() => {});
			expect(pending.size).toBe(0);
			expect(timers.size).toBe(0);
		} finally {
			spawn.mockRestore();
			await client.shutdown().catch(() => {});
			await drainEventLoop();
			expect(collector.rejections).toEqual([]);
			expect(sink.getWriterCalls).toBe(0);
		}
	});

	test("ACK timeout rejects the request and leaves no pending or unhandled rejection", async () => {
		process.env.NARRAFORK_ENABLE_NATIVE_WATCHER = "1";
		// Ready succeeds; writes succeed; worker never ACKs.
		const { sink, spawn } = spawnAndInstall({ autoAck: false });
		const unavailable: string[] = [];
		const client = new ParcelWorkerClient(
			() => {},
			(reason) => unavailable.push(reason),
		);
		const collector = collectUnhandledRejections();

		try {
			const internals = client as unknown as {
				sendWatch: (path: string, ignore: string[], timeoutMs: number) => Promise<void>;
				ensureStarted: () => Promise<void>;
			};
			// Use the full production ACK deadline and fire its registered callback;
			// no smaller timeout or wall-clock wait is needed.
			await internals.ensureStarted();
			const request = internals.sendWatch("/tmp/nf-timeout", [], 5000);
			// Handle the outer async request immediately, but assert only after
			// firing: Bun's rejects matcher may synchronously wait for settlement.
			request.catch(() => {});
			await drainEventLoop();
			expect(pendingMapOf(client).size).toBe(1);
			expect(sink.writes.length).toBeGreaterThan(0);
			await fireTimeout(5000);
			await expect(request).rejects.toThrow(/timed out/);

			const pending = pendingMapOf(client);
			expect(pending.size).toBe(0);
			// Timed-out watch disables the session (existing coordinator contract).
			expect(unavailable.length).toBeGreaterThan(0);

			await drainEventLoop();
			expect(collector.rejections).toEqual([]);
			expect(sink.writes.length).toBeGreaterThan(0);
			expect(sink.getWriterCalls).toBe(0);
		} finally {
			spawn.mockRestore();
			await client.shutdown().catch(() => {});
		}
	});

	test("shutdown closes stdin and clears all pending", async () => {
		process.env.NARRAFORK_ENABLE_NATIVE_WATCHER = "1";
		const { sink, proc, spawn } = spawnAndInstall({ autoAck: false });
		const client = new ParcelWorkerClient(
			() => {},
			() => {},
		);
		const collector = collectUnhandledRejections();

		try {
			const sendWatch = client as unknown as {
				sendWatch: (path: string, ignore: string[], timeoutMs: number) => Promise<void>;
				ensureStarted: () => Promise<void>;
			};
			await sendWatch.ensureStarted();
			// Leave an in-flight ACK pending, then shutdown.
			const inflight = sendWatch.sendWatch("/tmp/nf-shutdown", [], 5000);
			inflight.catch(() => {});
			await drainEventLoop();
			expect(pendingMapOf(client).size).toBe(1);
			expect(Array.from(timers.values(), (timer) => timer.delay)).toEqual([5000]);

			await client.shutdown();
			expect(pendingMapOf(client).size).toBe(0);
			expect(sink.endCount).toBeGreaterThan(0);
			await expect(inflight).rejects.toThrow(/shutting down|timed out|exited/);
			await fireTimeout(500);
			expect(timers.size).toBe(0);
			expect(collector.rejections).toEqual([]);
			expect(proc.killed || sink.endCount > 0).toBe(true);
		} finally {
			spawn.mockRestore();
			await client.shutdown().catch(() => {});
		}
	});
});

describe("bounded lifecycle diagnostics", () => {
	for (const lastStage of ["subscribe_start", "ack_send"] as const) {
		test(`timeout retains ${lastStage} without treating worker clocks as parent clocks`, async () => {
			process.env.NARRAFORK_ENABLE_NATIVE_WATCHER = "1";
			const { sink, proc, spawn } = spawnAndInstall();
			const warn = spyOn(logger, "warn").mockImplementation(() => {});
			const client = new ParcelWorkerClient(
				() => {},
				() => {},
			);
			try {
				const request = client.watch("/tmp/nf-diagnostic", []);
				request.catch(() => {});
				await drainEventLoop();
				const command = JSON.parse(new TextDecoder().decode(sink.writes[0]));
				const stage = {
					type: "stage",
					requestId: command.requestId,
					watchId: command.id,
					stage: lastStage,
					workerElapsedMs: 123,
					workerStageDurationMs: 7,
					activeWatches: 0,
					starting: 1,
					stopping: 1,
				};
				proc.emitLine(JSON.stringify(stage));
				await drainEventLoop();
				// Duplicate / invalid / mismatched observations cannot extend the deadline or grow state.
				for (let i = 0; i < 100; i++) proc.emitLine(JSON.stringify(stage));
				proc.emitLine(JSON.stringify({ ...stage, stage: "unknown", extra: "x".repeat(1000) }));
				proc.emitLine(JSON.stringify({ ...stage, stage: "binding_end", watchId: "wrong" }));
				proc.emitLine(JSON.stringify({ ...stage, stage: "binding_end", workerElapsedMs: -1 }));
				await drainEventLoop();
				expect(Array.from(timers.values(), (timer) => timer.delay)).toEqual([5000]);
				await fireTimeout(5000);
				await expect(request).rejects.toThrow("timed out after 5000ms");
				const diagnostic = warn.mock.calls.find(([message]) =>
					message.includes("request lifecycle"),
				)?.[1];
				expect(diagnostic).toMatchObject({
					outcome: "timeout",
					requestId: command.requestId,
					watchId: command.id,
					lastWorkerStage: lastStage,
					workerPid: 4242,
					workerState: "ready",
					parentSendStartMs: expect.any(Number),
					parentFlushEndMs: expect.any(Number),
					workerReadyMs: expect.any(Number),
					parentLastStageAgeMs: expect.any(Number),
					parentAckReceivedMs: null,
					stages: [
						{
							stage: lastStage,
							workerElapsedMs: 123,
							workerStageDurationMs: 7,
							activeWatches: 0,
							starting: 1,
							stopping: 1,
						},
					],
				});
				expect(pendingMapOf(client).size).toBe(0);
			} finally {
				spawn.mockRestore();
				warn.mockRestore();
				await client.shutdown();
			}
		});
	}

	test("success, worker error, late ACK/stage and FS events keep diagnostics bounded", async () => {
		process.env.NARRAFORK_ENABLE_NATIVE_WATCHER = "1";
		const { sink, proc, spawn } = spawnAndInstall();
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		const debug = spyOn(logger, "debug").mockImplementation(() => {});
		let eventCount = 0;
		const client = new ParcelWorkerClient(
			() => {
				eventCount++;
			},
			() => {},
		);
		try {
			for (let attempt = 0; attempt < 14; attempt++) {
				const request = client.watch("/tmp/nf-diagnostic", []);
				request.catch(() => {});
				await drainEventLoop();
				const command = JSON.parse(new TextDecoder().decode(sink.writes.at(-1)));
				const stage = {
					type: "stage",
					requestId: command.requestId,
					watchId: command.id,
					stage: "received",
					workerElapsedMs: 0,
					workerStageDurationMs: 0,
					activeWatches: 0,
					starting: 1,
					stopping: 0,
				};
				for (const name of WATCHER_STAGES) {
					if (attempt === 0 && name === "unsubscribe_error") continue;
					proc.emitLine(JSON.stringify({ ...stage, stage: name }));
				}
				proc.emitLine(
					JSON.stringify(
						attempt === 0
							? { type: "watch_ack", requestId: command.requestId, id: command.id }
							: {
									type: "error",
									requestId: command.requestId,
									id: command.id,
									error: "controlled subscribe failure",
								},
					),
				);
				await drainEventLoop();
				if (attempt === 0) {
					await request;
					expect(warn.mock.calls).toHaveLength(0);
					expect(debug.mock.calls.some(([message]) => message.includes("request lifecycle"))).toBe(
						true,
					);
				} else await expect(request).rejects.toThrow("controlled subscribe failure");
				proc.emitLine(JSON.stringify(stage));
				proc.emitLine(
					JSON.stringify({ type: "watch_ack", requestId: command.requestId, id: command.id }),
				);
				await drainEventLoop();
				expect(pendingMapOf(client).size).toBe(0);
			}
			const countBeforeEvents = warn.mock.calls.length + debug.mock.calls.length;
			for (let i = 0; i < 1000; i++)
				proc.emitLine(JSON.stringify({ type: "events", id: "x", path: "x", events: [] }));
			await drainEventLoop();
			expect(eventCount).toBe(1000);
			expect(warn.mock.calls.length + debug.mock.calls.length).toBe(countBeforeEvents);
			const diagnostics = warn.mock.calls.filter(([message]) =>
				message.includes("request lifecycle"),
			);
			expect(diagnostics).toHaveLength(10);
			for (const [, data] of diagnostics) expect(JSON.stringify(data).length).toBeLessThan(4096);
		} finally {
			spawn.mockRestore();
			warn.mockRestore();
			debug.mockRestore();
			await client.shutdown();
		}
	});

	test("pending flush timeout records send start without claiming flush or worker receipt", async () => {
		process.env.NARRAFORK_ENABLE_NATIVE_WATCHER = "1";
		const { sink, spawn } = spawnAndInstall();
		let release!: (value: number) => void;
		const flush = new Promise<number>((resolve) => {
			release = resolve;
		});
		sink.flush = () => flush;
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		const client = new ParcelWorkerClient(
			() => {},
			() => {},
		);
		try {
			const request = client.watch("/tmp/nf-flush", []);
			request.catch(() => {});
			await drainEventLoop();
			await fireTimeout(5000);
			const diagnostic = warn.mock.calls.find(([message]) =>
				message.includes("request lifecycle"),
			)?.[1];
			expect(diagnostic).toMatchObject({
				outcome: "timeout",
				parentSendStartMs: expect.any(Number),
				parentFlushEndMs: null,
				lastWorkerStage: null,
				stages: [],
			});
			expect(pendingMapOf(client).size).toBe(0);
			release(0);
			await drainEventLoop();
			await expect(request).rejects.toThrow("timed out");
		} finally {
			release(0);
			spawn.mockRestore();
			warn.mockRestore();
			await client.shutdown();
		}
	});

	test("diagnostic logger failure preserves the worker error and clears pending", async () => {
		process.env.NARRAFORK_ENABLE_NATIVE_WATCHER = "1";
		const { sink, proc, spawn } = spawnAndInstall();
		const warn = spyOn(logger, "warn").mockImplementation(() => {
			throw new Error("logger failed");
		});
		const client = new ParcelWorkerClient(
			() => {},
			() => {},
		);
		try {
			const request = client.watch("/tmp/nf-diagnostic", []);
			request.catch(() => {});
			await drainEventLoop();
			const command = JSON.parse(new TextDecoder().decode(sink.writes[0]));
			proc.emitLine(
				JSON.stringify({ type: "error", requestId: command.requestId, error: "original failure" }),
			);
			await drainEventLoop();
			await expect(request).rejects.toThrow("original failure");
			expect(pendingMapOf(client).size).toBe(0);
		} finally {
			spawn.mockRestore();
			warn.mockRestore();
			await client.shutdown();
		}
	});
});

describe("coordinator fallback after retries", () => {
	test("first attempt + 3 retries then exactly one fallback notification", async () => {
		process.env.NARRAFORK_ENABLE_NATIVE_WATCHER = "1";
		expect(isNativeWatcherEnabled()).toBe(true);

		const unavailable: string[] = [];
		const collector = collectUnhandledRejections();
		const watcher = new ParcelRecursiveWatcher(
			() => {},
			(reason) => unavailable.push(reason),
		);

		const client = (watcher as unknown as { workerClient: ParcelWorkerClient }).workerClient;

		let attempts = 0;
		// Non-timeout, non-disabled error: coordinator retries MAX_RESTARTS (3)
		// times, then calls handleBackendUnavailable once. Matching the old
		// getWriter failure shape.
		client.watch = (async () => {
			attempts++;
			throw new TypeError("r.getWriter is not a function");
		}) as ParcelWorkerClient["watch"];

		try {
			await watcher.watch("/tmp/nf-fallback-once");
			expect(attempts).toBe(1);
			expect(unavailable).toEqual([]);
			// Advance only the three 800ms callbacks registered by the real
			// coordinator. Drain each async restart before firing the next timer.
			for (let retry = 1; retry <= 3; retry++) {
				await fireTimeout(800);
				expect(attempts).toBe(1 + retry);
				if (retry < 3) expect(unavailable).toEqual([]);
			}

			// 1 initial + 3 retries
			expect(attempts).toBe(4);
			// Fallback notification exactly once for this watch sequence.
			expect(unavailable.length).toBe(1);
			expect(unavailable[0]).toContain("getWriter");
			expect(timers.size).toBe(0);
			await drainEventLoop();
			expect(attempts).toBe(4);
			expect(unavailable).toHaveLength(1);
			expect(collector.rejections).toEqual([]);
		} finally {
			await watcher.shutdown().catch(() => {});
		}
	});

	test("WritableStream-shaped stdin fails closed without calling getWriter", async () => {
		process.env.NARRAFORK_ENABLE_NATIVE_WATCHER = "1";
		const { sink, spawn } = spawnAndInstall({ writableStreamShape: true });
		const client = new ParcelWorkerClient(
			() => {},
			() => {},
		);
		const collector = collectUnhandledRejections();

		try {
			await expect(client.watch("/tmp/nf-writable-shape", [])).rejects.toThrow(
				/stdin is not available/,
			);
			// The bug signature must not reappear.
			expect(sink.getWriterCalls).toBe(0);
			expect(pendingMapOf(client).size).toBe(0);
			await drainEventLoop();
			expect(collector.rejections).toEqual([]);
		} finally {
			spawn.mockRestore();
			await client.shutdown().catch(() => {});
		}
	});
});
