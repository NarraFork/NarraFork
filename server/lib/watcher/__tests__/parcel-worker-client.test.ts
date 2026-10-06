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
import { afterEach, describe, expect, spyOn, test } from "bun:test";
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
			proc.killed = true;
			exitResolve(1);
		},
	};
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
	return {
		rejections,
		stop: () => {
			process.off("unhandledRejection", handler);
		},
	};
}

const previousEnv = process.env.NARRAFORK_ENABLE_NATIVE_WATCHER;

afterEach(async () => {
	if (previousEnv === undefined) {
		delete process.env.NARRAFORK_ENABLE_NATIVE_WATCHER;
	} else {
		process.env.NARRAFORK_ENABLE_NATIVE_WATCHER = previousEnv;
	}
	// Restore any spies installed via spyOn(Bun, "spawn").
	try {
		const maybe = Bun.spawn as unknown as { mockRestore?: () => void };
		maybe.mockRestore?.();
	} catch {
		// ignore
	}
	await sleep(10);
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
			await sleep(20);
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

			// Long enough that an orphaned 5s timer would not fire yet; the point
			// is that pending is already empty and nothing is scheduled under our
			// control. Also verify a shorter private path leaves nothing behind.
			await sleep(30);
			expect(pending.size).toBe(0);

			// Drive a short-timeout request against the broken sink via the same
			// public send path: unwatch also creates a pending then send fails.
			await client.unwatch("/tmp/nf-pending").catch(() => {});
			expect(pending.size).toBe(0);
		} finally {
			collector.stop();
			spawn.mockRestore();
			await client.shutdown().catch(() => {});
			await sleep(20);
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
			// Public watch() hardcodes the 5s ACK timeout; start the fake worker
			// first, then drive sendWatch with a short timeout so the test stays fast.
			await internals.ensureStarted();
			await expect(internals.sendWatch("/tmp/nf-timeout", [], 40)).rejects.toThrow(/timed out/);

			const pending = pendingMapOf(client);
			expect(pending.size).toBe(0);
			// Timed-out watch disables the session (existing coordinator contract).
			expect(unavailable.length).toBeGreaterThan(0);

			await sleep(30);
			expect(collector.rejections).toEqual([]);
			expect(sink.writes.length).toBeGreaterThan(0);
			expect(sink.getWriterCalls).toBe(0);
		} finally {
			collector.stop();
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
			await sleep(5);
			expect(pendingMapOf(client).size).toBe(1);

			await client.shutdown();
			expect(pendingMapOf(client).size).toBe(0);
			expect(sink.endCount).toBeGreaterThan(0);
			await expect(inflight).rejects.toThrow(/shutting down|timed out|exited/);
			await sleep(20);
			expect(collector.rejections).toEqual([]);
			expect(proc.killed || sink.endCount > 0).toBe(true);
		} finally {
			collector.stop();
			spawn.mockRestore();
			await client.shutdown().catch(() => {});
		}
	});
});

describe("coordinator fallback after retries", () => {
	test("first attempt + 3 retries then exactly one fallback notification", async () => {
		process.env.NARRAFORK_ENABLE_NATIVE_WATCHER = "1";
		expect(isNativeWatcherEnabled()).toBe(true);

		const unavailable: string[] = [];
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
			// parcel-watcher onError waits 800ms between restarts; 3 retries → ~2.4s.
			await sleep(800 * 3 + 600);

			// 1 initial + 3 retries
			expect(attempts).toBe(4);
			// Fallback notification exactly once for this watch sequence.
			expect(unavailable.length).toBe(1);
			expect(unavailable[0]).toContain("getWriter");
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
			await sleep(20);
			expect(collector.rejections).toEqual([]);
		} finally {
			collector.stop();
			spawn.mockRestore();
			await client.shutdown().catch(() => {});
		}
	});
});
