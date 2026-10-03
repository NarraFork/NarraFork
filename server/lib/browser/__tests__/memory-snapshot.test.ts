import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createSnapshotExporter,
	exportHeapSnapshot,
	snapshotWorkerEntryPoint,
	snapshotWorkerSpecifiers,
} from "../memory-snapshot";
import { SNAPSHOT_PENDING_BYTES, type SnapshotIO, SnapshotStream } from "../memory-snapshot-stream";
import {
	connectSnapshotTarget,
	runSnapshot,
	type SnapshotConnection,
	type SnapshotRequest,
} from "../memory-snapshot-worker";

const request = (savePath: string): SnapshotRequest => ({
	wsEndpoint: "ws://private-token-canary",
	targetId: "precise-id",
	savePath,
	maxBytes: 1024,
	timeoutMs: 500,
	collectGarbage: false,
});
function fakeConnection(chunks: string[], behavior?: (method: string) => Promise<unknown>) {
	const events = new EventEmitter();
	const commands: string[] = [];
	let detached = 0,
		disconnected = 0;
	const connection: SnapshotConnection = {
		session: {
			on: (event, listener) => events.on(event, listener),
			off: (event, listener) => events.off(event, listener),
			send: async (method) => {
				commands.push(method);
				if (method === "HeapProfiler.takeHeapSnapshot")
					for (const chunk of chunks) events.emit("HeapProfiler.addHeapSnapshotChunk", { chunk });
				return behavior?.(method);
			},
			detach: async () => {
				detached++;
			},
		},
		disconnect: async () => {
			disconnected++;
		},
	};
	return { connection, commands, events, counts: () => ({ detached, disconnected }) };
}
async function withPath(action: (path: string) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "nf-heap-test-"));
	try {
		await action(join(root, "snapshot.heapsnapshot"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

class FakeWorker extends EventEmitter {
	messages: unknown[] = [];
	terminated = false;
	postMessage(value: unknown) {
		this.messages.push(value);
		if ((value as { kind: string }).kind === "cancel") queueMicrotask(() => this.emit("exit", 0));
	}
	async terminate() {
		this.terminated = true;
		return 0;
	}
}

describe("heap snapshot stream and worker", () => {
	test("independent connection attaches exact targetId, verifies identity and only disconnects", async () => {
		let rootDetached = 0,
			disconnected = 0;
		const calls: unknown[] = [];
		const fake = fakeConnection([]);
		const session = {
			...fake.connection.session,
			send: async () => ({ targetInfo: { targetId: "precise-id" } }),
		};
		const browser = {
			target: () => ({
				createCDPSession: async () => ({
					connection: () => ({
						send: async (method: string, params: unknown) => {
							calls.push({ method, params });
							return { sessionId: "attached" };
						},
						session: (id: string) => {
							expect(id).toBe("attached");
							return session;
						},
					}),
					detach: async () => {
						rootDetached++;
					},
				}),
			}),
			disconnect: async () => {
				disconnected++;
			},
		};
		const connector = (async (options: unknown) => {
			calls.push(options);
			return browser;
		}) as unknown as Parameters<typeof connectSnapshotTarget>[1];
		const result = await connectSnapshotTarget(request("unused"), connector);
		expect(calls[1]).toEqual({
			method: "Target.attachToTarget",
			params: { targetId: "precise-id", flatten: true },
		});
		expect(rootDetached).toBe(1);
		await result.disconnect();
		expect(disconnected).toBe(1);
		session.send = async () => ({ targetInfo: { targetId: "different-target" } });
		await expect(connectSnapshotTarget(request("unused"), connector)).rejects.toThrow("(target)");
		expect(disconnected).toBe(2);
	});
	test("surrogate pairs split across chunks preserve exact UTF8 bytes", async () => {
		await withPath(async (path) => {
			const fake = fakeConnection(['{"strings":["中\ud83d', '\ude42"]}']);
			const result = await runSnapshot(request(path), new AbortController().signal, {
				connect: async () => fake.connection,
			});
			const data = await readFile(path, "utf8");
			expect(data).toBe('{"strings":["中🙂"]}');
			expect(result.fileSize).toBe(Buffer.byteLength(data));
		});
	});
	test("partial filesystem writes preserve exact order", async () => {
		const written: number[] = [];
		let renamed = false;
		const io: SnapshotIO = {
			open: async () => ({
				write: async (buffer, offset) => {
					written.push(buffer[offset]);
					return { bytesWritten: 1 };
				},
				close: async () => {},
			}),
			rename: async () => {
				renamed = true;
			},
			unlink: async () => {},
		};
		const stream = new SnapshotStream("unused", 100, () => {}, io);
		await stream.start();
		stream.push("中");
		stream.push("🙂");
		expect(await stream.finish()).toEqual({ fileSize: 7 });
		expect(Buffer.from(written).toString("utf8")).toBe("中🙂");
		expect(renamed).toBe(true);
	});
	test("writes ordered UTF8 bytes atomically, optional GC precedes capture, no body result", () =>
		withPath(async (path) => {
			const fake = fakeConnection(['{"value":"', "中文🙂", '"}']);
			const result = await runSnapshot(
				{ ...request(path), collectGarbage: true },
				new AbortController().signal,
				{
					connect: async (opts) => {
						expect(opts.targetId).toBe("precise-id");
						expect(await stat(path).catch(() => null)).toBeNull();
						return fake.connection;
					},
				},
			);
			const body = '{"value":"中文🙂"}';
			expect(await readFile(path, "utf8")).toBe(body);
			expect(result).toEqual({ fileSize: Buffer.byteLength(body) });
			expect(await stat(`${path}.partial`).catch(() => null)).toBeNull();
			expect(fake.commands).toEqual([
				"HeapProfiler.enable",
				"HeapProfiler.collectGarbage",
				"HeapProfiler.takeHeapSnapshot",
			]);
			expect(fake.counts()).toEqual({ detached: 1, disconnected: 1 });
			expect(fake.events.listenerCount("HeapProfiler.addHeapSnapshotChunk")).toBe(0);
		}));
	test("UTF8 total limit refuses and removes partial files; no implicit GC", () =>
		withPath(async (path) => {
			const fake = fakeConnection(["中文"]);
			await expect(
				runSnapshot({ ...request(path), maxBytes: 5 }, new AbortController().signal, {
					connect: async () => fake.connection,
				}),
			).rejects.toThrow("(bytes)");
			expect(fake.commands).not.toContain("HeapProfiler.collectGarbage");
			expect(await stat(path).catch(() => null)).toBeNull();
			expect(await stat(`${path}.partial`).catch(() => null)).toBeNull();
		}));
	test("pending queue includes in-flight bytes and refuses slow writes", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const failures: string[] = [];
		const io: SnapshotIO = {
			open: async () => ({
				write: async (_, __, length) => {
					await gate;
					return { bytesWritten: length };
				},
				close: async () => {},
			}),
			rename: async () => {},
			unlink: async () => {},
		};
		const stream = new SnapshotStream(
			"unused",
			256 * 1024 * 1024,
			(error) => failures.push(error.stage),
			io,
		);
		await stream.start();
		stream.push("a".repeat(SNAPSHOT_PENDING_BYTES));
		await Promise.resolve();
		stream.push("b");
		expect(failures).toEqual(["queue"]);
		release();
		await expect(stream.finish()).rejects.toThrow("(queue)");
		await stream.cleanup();
	});
	for (const mode of ["cancelled", "timeout", "capture", "write", "finalize"] as const) {
		test(`${mode} failure sanitizes errors and cleans resources`, () =>
			withPath(async (path) => {
				const controller = new AbortController();
				const fake = fakeConnection(["heap-secret-canary"], async (method) => {
					if (method !== "HeapProfiler.takeHeapSnapshot") return;
					if (mode === "capture") throw new Error("ws://private-token-canary heap-secret-canary");
					if (mode === "cancelled") controller.abort();
					if (mode === "cancelled" || mode === "timeout") await new Promise(() => {});
				});
				let closed = false,
					removed = false;
				const io: SnapshotIO | undefined =
					mode === "write" || mode === "finalize"
						? {
								open: async () => ({
									write: async (_, __, length) => {
										if (mode === "write") throw new Error("heap-secret-canary");
										return { bytesWritten: length };
									},
									close: async () => {
										closed = true;
									},
								}),
								rename: async () => {
									throw new Error("ws://private-token-canary");
								},
								unlink: async () => {
									removed = true;
								},
							}
						: undefined;
				try {
					await runSnapshot({ ...request(path), timeoutMs: 30 }, controller.signal, {
						connect: async () => fake.connection,
						io,
					});
					throw new Error("expected refusal");
				} catch (error) {
					expect(String(error)).toContain(`(${mode})`);
					expect(String(error)).not.toContain("canary");
				}
				expect(fake.counts()).toEqual({ detached: 1, disconnected: 1 });
				expect(fake.events.listenerCount("HeapProfiler.addHeapSnapshotChunk")).toBe(0);
				if (io) {
					expect(closed).toBe(true);
					expect(removed).toBe(true);
				}
				expect(await stat(`${path}.partial`).catch(() => null)).toBeNull();
			}));
	}
});

describe("snapshot supervisor", () => {
	test("startup failures fall back before dispatch, clamp cap; silent worker times out", async () => {
		let attempts = 0;
		const worker = new FakeWorker();
		const exporter = createSnapshotExporter({
			specifiers: () => ["missing", "present"],
			spawn: () => {
				if (++attempts === 1) throw new Error("ws://private-canary");
				queueMicrotask(() => worker.emit("message", { kind: "ready" }));
				return worker;
			},
		});
		const result = exporter({
			...request("unused"),
			maxBytes: 500 * 1024 * 1024,
			signal: new AbortController().signal,
		});
		await Promise.resolve();
		expect((worker.messages[0] as { opts: { maxBytes: number } }).opts.maxBytes).toBe(
			256 * 1024 * 1024,
		);
		worker.emit("message", { kind: "done", fileSize: 20 });
		expect(await result).toEqual({ fileSize: 20 });
		const silent = new FakeWorker();
		await expect(
			createSnapshotExporter({ specifiers: () => ["silent"], spawn: () => silent })({
				...request("unused"),
				timeoutMs: 20,
				signal: new AbortController().signal,
			}),
		).rejects.toThrow("(timeout)");
		expect(silent.terminated).toBe(true);
		await expect(
			createSnapshotExporter({
				specifiers: () => ["bad"],
				spawn: () => {
					throw new Error("private-canary");
				},
			})({ ...request("unused"), signal: new AbortController().signal }),
		).rejects.toThrow("(startup)");
	});
	test("global admission fails fast; only metadata crosses thread boundary; releases lock", async () => {
		const workers: FakeWorker[] = [];
		const exporter = createSnapshotExporter({
			specifiers: () => ["fake"],
			spawn: () => {
				const worker = new FakeWorker();
				workers.push(worker);
				queueMicrotask(() => worker.emit("message", { kind: "ready" }));
				return worker;
			},
		});
		const opts = { ...request("unused"), signal: new AbortController().signal };
		const first = exporter(opts);
		await expect(exporter(opts)).rejects.toThrow("(busy)");
		await Promise.resolve();
		workers[0].emit("message", { kind: "done", fileSize: 9 });
		expect(await first).toEqual({ fileSize: 9 });
		expect(workers[0].messages).toHaveLength(2);
		expect(workers[0].terminated).toBe(true);
		const next = exporter(opts);
		await Promise.resolve();
		workers[1].emit("message", { kind: "done", fileSize: 5 });
		expect(await next).toEqual({ fileSize: 5 });
	});
	for (const mode of ["abort", "timeout", "exit", "failed"] as const) {
		test(`${mode} removes orphan outputs after worker stops`, async () => {
			const worker = new FakeWorker();
			const removed: string[] = [];
			const controller = new AbortController();
			const exporter = createSnapshotExporter({
				specifiers: () => ["fake"],
				spawn: () => {
					queueMicrotask(() => worker.emit("message", { kind: "ready" }));
					return worker;
				},
				unlink: async (path) => {
					expect(worker.terminated).toBe(true);
					removed.push(path);
				},
			});
			const running = exporter({ ...request("orphan"), timeoutMs: 30, signal: controller.signal });
			await Promise.resolve();
			if (mode === "abort") controller.abort();
			if (mode === "exit") worker.emit("exit", 1);
			if (mode === "failed")
				worker.emit("message", { kind: "failed", stage: "ws://secret-canary" });
			await expect(running).rejects.toThrow(/Heap snapshot failed/);
			expect(removed.sort()).toEqual(["orphan", "orphan.partial"]);
		});
	}
	test("development worker boots and connection failures expose no endpoint", () =>
		withPath(async (path) => {
			await expect(
				exportHeapSnapshot({
					...request(path),
					wsEndpoint: "bad-endpoint-canary",
					timeoutMs: 5000,
					signal: new AbortController().signal,
				}),
			).rejects.toThrow("(connect)");
		}));
	test("compiled candidates and Windows virtual-drive paths", () => {
		expect(snapshotWorkerSpecifiers(true, "file:///$bunfs/root/narrafork")[0]).toBe(
			"file:///$bunfs/root/lib/browser/memory-snapshot-worker.js",
		);
		expect(
			snapshotWorkerEntryPoint("file:///B:/%7EBUN/root/lib/browser/memory-snapshot-worker.js"),
		).toBe("B:/~BUN/root/lib/browser/memory-snapshot-worker.js");
	});
});
