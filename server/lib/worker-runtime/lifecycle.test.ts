import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { once } from "node:events";
import { connectCompiledWorker } from "../compiled-worker";
import { WorkerCleanupError, WorkerHandle } from "./lifecycle";
import { type PoolWorker, WorkerPool, type WorkerTaskContext } from "./pool";

// Bun 1.4.3's .resolves can block reentrant messages from the same native worker.
// Await the reply normally, then assert its value; production promise chains stay unchanged.
const handles = new Set<WorkerHandle<unknown>>();
const pools = new Set<{ close(): Promise<void> }>();
const urls = new Set<string>();

function own<T>(handle: WorkerHandle<T>): WorkerHandle<T> {
	handles.add(handle);
	return handle;
}

function blob(source: string): string {
	const url = URL.createObjectURL(new Blob([source], { type: "application/javascript" }));
	urls.add(url);
	return url;
}

afterEach(async () => {
	await Promise.allSettled([...pools].map((pool) => pool.close()));
	await Promise.allSettled([...handles].map((handle) => handle.close()));
	await Promise.allSettled([...handles].map((handle) => handle.exited));
	for (const url of urls) URL.revokeObjectURL(url);
	pools.clear();
	handles.clear();
	urls.clear();
});

describe("WorkerHandle native threads", () => {
	test("Node workers preserve their API and close waits for observed exit", async () => {
		const handle = own(
			WorkerHandle.thread(
				`const { parentPort } = require("node:worker_threads");
				parentPort.on("message", value => parentPort.postMessage(value));`,
				{ eval: true },
			),
		);
		const reply = once(handle.resource, "message");
		handle.resource.postMessage({ value: 42 });
		expect(await reply).toEqual([{ value: 42 }]);
		expect(handle.closed).toBe(false);
		let exited = false;
		void handle.exited.then(() => {
			exited = true;
		});
		const closing = handle.close();
		expect(handle.close()).toBe(closing);
		expect(handle.closed).toBe(true);
		await closing;
		expect(exited).toBe(true);
		expect(typeof (await handle.exited)).toBe("number");
	});

	test("natural exit keeps the real exit status", async () => {
		const handle = own(WorkerHandle.thread("process.exit(7);", { eval: true }));
		expect(await handle.exited).toBe(7);
		expect(handle.closed).toBe(true);
		await handle.close();
		expect(await handle.exited).toBe(7);
	});

	test("an uncaught error is retained and its worker is stopped without an unhandled error", async () => {
		const handle = own(
			WorkerHandle.thread('throw new Error("owned worker failed");', { eval: true }),
		);
		await handle.exited;
		expect(handle.error).toBeInstanceOf(Error);
		expect(String(handle.error)).toContain("owned worker failed");
		expect(handle.closed).toBe(true);
		await handle.close();
	});

	test("a message decoding error retires the actual thread", async () => {
		const handle = own(
			WorkerHandle.thread('require("node:worker_threads").parentPort.on("message", () => {});', {
				eval: true,
			}),
		);
		handle.resource.emit("messageerror", new Error("bad transport"));
		expect(handle.closed).toBe(true);
		await handle.close();
		expect(String(handle.error)).toContain("could not be decoded");
		await handle.exited;
	});

	test("Bun Blob workers retain native message and close events", async () => {
		const handle = own(
			WorkerHandle.bunThread(blob("self.onmessage = event => postMessage(event.data);"), {
				ref: true,
			}),
		);
		const reply = new Promise<unknown>((resolve) => {
			handle.resource.addEventListener("message", (event) => resolve(event.data), { once: true });
		});
		handle.resource.postMessage({ value: 9 });
		expect(await reply).toEqual({ value: 9 });
		let exited = false;
		void handle.exited.then(() => {
			exited = true;
		});
		const closing = handle.close();
		expect(handle.close()).toBe(closing);
		await closing;
		expect(exited).toBe(true);
		expect(typeof (await handle.exited)).toBe("number");
	});

	test("Bun natural exit is observed without changing its execution mode", async () => {
		const handle = own(
			WorkerHandle.bunThread(blob("self.onmessage = () => process.exit(7);"), { ref: true }),
		);
		handle.resource.postMessage("exit");
		expect(await handle.exited).toBe(7);
		expect(handle.closed).toBe(true);
		await handle.close();
	});

	test("Bun worker exceptions are handled and stopped", async () => {
		const handle = own(
			WorkerHandle.bunThread(blob('throw new Error("Blob worker failed");'), { ref: true }),
		);
		await handle.exited;
		expect(String(handle.error)).toContain("Blob worker failed");
		expect(handle.closed).toBe(true);
		await handle.close();
	});
});

describe("WorkerHandle owned subprocesses", () => {
	test("normal subprocess exit is preserved and does not call the stop callback", async () => {
		let stopped = false;
		const handle = own(
			WorkerHandle.subprocess(
				[process.execPath, "--eval", "process.exit(7)"],
				{ stdout: "ignore", stderr: "ignore" },
				() => {
					stopped = true;
				},
			),
		);
		expect(await handle.exited).toBe(7);
		await handle.close();
		expect(stopped).toBe(false);
		expect(handle.closed).toBe(true);
	});

	test("default close kills only the owned child and waits for its exit", async () => {
		const handle = own(
			WorkerHandle.subprocess(
				[process.execPath, "--eval", 'process.stdout.write("ready"); setInterval(() => {}, 1000);'],
				{ stdout: "pipe", stderr: "ignore" },
			),
		);
		const reader = handle.resource.stdout.getReader();
		try {
			const ready = await reader.read();
			expect(new TextDecoder().decode(ready.value)).toBe("ready");
		} finally {
			reader.releaseLock();
		}
		let exited = false;
		void handle.exited.then(() => {
			exited = true;
		});
		const closing = handle.close();
		expect(handle.close()).toBe(closing);
		await closing;
		expect(exited).toBe(true);
		expect(typeof (await handle.exited)).toBe("number");
	});

	test("a domain stop callback can drain before the shared handle confirms exit", async () => {
		let stopCalls = 0;
		const handle = own(
			WorkerHandle.subprocess(
				[
					process.execPath,
					"--eval",
					'process.stdin.once("data", () => { process.stdout.write("drained"); process.exit(0); }); process.stdin.resume();',
				],
				{ stdin: "pipe", stdout: "pipe", stderr: "ignore" },
				(child) => {
					stopCalls++;
					child.stdin.write("stop\n");
					return child.stdin.end();
				},
			),
		);
		await handle.close();
		expect(await handle.exited).toBe(0);
		expect(await new Response(handle.resource.stdout).text()).toBe("drained");
		expect(stopCalls).toBe(1);
	});

	test("failed stop cannot be reported as a confirmed exit", async () => {
		const failure = new Error("stop failed");
		const handle = own(
			WorkerHandle.subprocess(
				[process.execPath, "--eval", 'process.stdout.write("ready"); setInterval(() => {}, 1000);'],
				{ stdout: "pipe", stderr: "ignore" },
				() => {
					throw failure;
				},
			),
		);
		try {
			const reader = handle.resource.stdout.getReader();
			await reader.read();
			reader.releaseLock();
			let exited = false;
			void handle.exited.then(() => {
				exited = true;
			});
			await expect(handle.close()).rejects.toBe(failure);
			expect(exited).toBe(false);
		} finally {
			// This is the isolated child created above, never a running NarraFork server.
			handle.resource.kill("SIGKILL");
			await handle.exited;
		}
	});
});

const echoSource = `const { parentPort } = require("node:worker_threads");
parentPort.on("message", message => {
	if (message.action === "ping") parentPort.postMessage({ ready: true });
	else if (message.id !== 99) parentPort.postMessage({ id: message.id, value: message.value * 2 });
});`;

type Request = { id: number; value: number };

/** A real wire adapter; the pool manages admission/reuse, not the domain message schema. */
function realPool() {
	const created: WorkerHandle<import("node:worker_threads").Worker>[] = [];
	let dispatched!: () => void;
	const hungDispatched = new Promise<void>((resolve) => {
		dispatched = resolve;
	});
	const pool = new WorkerPool<Request, number>({
		concurrency: 1,
		create: async (context): Promise<PoolWorker<Request, number>> => {
			const connected = await connectCompiledWorker([echoSource], {
				signal: context.signal,
				deadlineAt: context.deadlineAt,
				workerOptions: { eval: true },
			});
			const handle = own(connected.handle);
			created.push(handle);
			const worker = handle.resource;
			return {
				get closed() {
					return handle.closed;
				},
				run: (request) =>
					new Promise<number>((resolve, reject) => {
						const cleanup = () => {
							worker.off("message", message);
							worker.off("error", failed);
							worker.off("exit", exited);
						};
						const failed = (error: unknown) => {
							cleanup();
							reject(error);
						};
						const exited = () => failed(new Error("Worker exited before the RPC reply"));
						const message = (value: unknown) => {
							if (!value || typeof value !== "object" || !("id" in value)) return;
							if (value.id !== request.id) return;
							cleanup();
							if ("value" in value && typeof value.value === "number") resolve(value.value);
							else reject(new Error("Invalid RPC reply"));
						};
						worker.on("message", message);
						worker.on("error", failed);
						worker.on("exit", exited);
						try {
							worker.postMessage(request);
							if (request.id === 99) dispatched();
						} catch (error) {
							failed(error);
						}
					}),
				close: () => handle.close(),
			};
		},
	});
	pools.add(pool);
	return { pool, created, hungDispatched };
}

describe("WorkerPool with real thread handles", () => {
	test("warmup and repeated jobs reuse an actual native thread", async () => {
		const { pool, created } = realPool();
		await pool.warmup();
		expect(await pool.run({ id: 1, value: 3 })).toBe(6);
		expect(await pool.run({ id: 2, value: 4 })).toBe(8);
		expect(created).toHaveLength(1);
		expect(pool.stats.created).toBe(1);
		await pool.close();
		await created[0]?.exited;
		expect(pool.stats.workers).toBe(0);
	});

	test("a failed startup stop stays counted while a waiting caller can cancel independently", async () => {
		const handle = own(WorkerHandle.thread(echoSource, { eval: true }));
		const actualClose = handle.close.bind(handle);
		const failure = new Error("startup stop rejected before exit");
		const stop = spyOn(handle, "close").mockRejectedValue(failure);
		const nextAttempt = new Error("new factory after confirmed exit");
		let creates = 0;
		const pool = new WorkerPool<number, number>({
			concurrency: 1,
			create: async () => {
				if (++creates > 1) throw nextAttempt;
				try {
					await handle.close();
				} catch (error) {
					throw new WorkerCleanupError(handle, error);
				}
				throw new Error("injected stop must reject");
			},
		});
		pools.add(pool);
		try {
			expect(await pool.run(1).catch((error: unknown) => error)).toBeInstanceOf(WorkerCleanupError);
			expect(pool.stats).toMatchObject({ workers: 1, retiring: 1, starting: 0, active: 0 });
			const controller = new AbortController();
			const waiting = pool.run(2, { signal: controller.signal });
			void waiting.catch(() => {});
			await Bun.sleep(0);
			expect(creates).toBe(1);
			const reason = new Error("cancel only the waiter");
			controller.abort(reason);
			const cancelled = await Promise.race([
				waiting.catch((error: unknown) => error),
				Bun.sleep(250).then(() => "waiter did not cancel"),
			]);
			expect(cancelled).toBe(reason);
			expect(pool.stats).toMatchObject({ workers: 1, retiring: 1, active: 0 });
			const next = pool.run(3);
			void next.catch(() => {});
			await Bun.sleep(0);
			expect(creates).toBe(1);
			await actualClose();
			expect(typeof (await handle.exited)).toBe("number");
			expect(await next.catch((error: unknown) => error)).toBe(nextAttempt);
			expect(creates).toBe(2);
			expect(pool.stats.workers).toBe(0);
		} finally {
			stop.mockRestore();
			await actualClose();
		}
	});

	test("one unconfirmed startup resource does not consume another physical slot", async () => {
		const stalled = own(WorkerHandle.thread(echoSource, { eval: true }));
		let creates = 0;
		const pool = new WorkerPool<number, number>({
			concurrency: 2,
			create: async (context) => {
				if (++creates === 1)
					throw new WorkerCleanupError(stalled, new Error("unconfirmed startup"));
				const connected = await connectCompiledWorker([echoSource], {
					signal: context.signal,
					deadlineAt: context.deadlineAt,
					workerOptions: { eval: true },
				});
				const handle = own(connected.handle);
				return {
					get closed() {
						return handle.closed;
					},
					close: () => handle.close(),
					run: async (value: number, task: WorkerTaskContext) => {
						const reply = once(handle.resource, "message", { signal: task.signal });
						handle.resource.postMessage({ id: value, value });
						return (await reply)[0].value as number;
					},
				};
			},
		});
		pools.add(pool);
		try {
			expect(await pool.run(1).catch((error: unknown) => error)).toBeInstanceOf(WorkerCleanupError);
			expect(
				await Promise.race([
					pool.run(2),
					Bun.sleep(1_000).then(() => {
						throw new Error("spare capacity was incorrectly blocked");
					}),
				]),
			).toBe(4);
			expect(creates).toBe(2);
			expect(pool.stats).toMatchObject({ workers: 2, retiring: 1, idle: 1 });
		} finally {
			await stalled.close();
		}
	});
	test("a real flush ACK and exit must both precede one-shot capacity release", async () => {
		const created: WorkerHandle<import("node:worker_threads").Worker>[] = [];
		const exited = new Set<WorkerHandle<import("node:worker_threads").Worker>>();
		let beginFlush!: () => void;
		const flushing = new Promise<void>((resolve) => {
			beginFlush = resolve;
		});
		const source = `const { parentPort, workerData } = require("node:worker_threads");
	const finish = () => { parentPort.postMessage({ phase: "flushed" }); parentPort.close(); };
	parentPort.on("message", message => {
	 if (message.action === "ping") parentPort.postMessage({ ready: true });
	 else if (message.action === "work") parentPort.postMessage({ phase: "result", value: message.value * 2 });
	 else if (message.action === "flush") {
	  if (workerData.gated) parentPort.postMessage({ phase: "flush-started" });
	  else finish();
	 } else if (message.action === "finish-flush") finish();
	});`;
		const pool = new WorkerPool<number, number>({
			concurrency: 1,
			reuse: false,
			create: async (context) => {
				// Do not await an old exit here: creating early must fail this assertion.
				expect(exited.size).toBe(created.length);
				const connected = await connectCompiledWorker([source], {
					signal: context.signal,
					deadlineAt: context.deadlineAt,
					workerOptions: { eval: true, workerData: { gated: created.length === 0 } },
				});
				const handle = own(connected.handle);
				created.push(handle);
				void handle.exited.then(() => exited.add(handle));
				const worker = handle.resource;
				worker.on("message", (reply: { phase: string }) => {
					if (reply.phase === "flush-started") beginFlush();
				});
				const exchange = (action: string, phase: string, value?: number) =>
					new Promise<number | undefined>((resolve, reject) => {
						const cleanup = () => {
							worker.off("message", receive);
							worker.off("error", failed);
							worker.off("exit", stopped);
						};
						const failed = (error: unknown) => {
							cleanup();
							reject(error);
						};
						const stopped = () => failed(new Error("Worker stopped before domain ACK"));
						const receive = (reply: { phase: string; value?: number }) => {
							if (reply.phase !== phase) return;
							cleanup();
							resolve(reply.value);
						};
						worker.on("message", receive);
						worker.once("error", failed);
						worker.once("exit", stopped);
						worker.postMessage({ action, value });
					});
				return {
					get closed() {
						return handle.closed;
					},
					run: async (value: number) => {
						const result = await exchange("work", "result", value);
						if (typeof result !== "number") throw new Error("Invalid result");
						return result;
					},
					close: async () => {
						try {
							if (!handle.closed) {
								await exchange("flush", "flushed");
								await handle.exited;
							}
						} finally {
							await handle.close();
						}
					},
				};
			},
		});
		pools.add(pool);
		let settled = false;
		const first = pool.run(3).finally(() => {
			settled = true;
		});
		void first.catch(() => {});
		try {
			await flushing;
			const second = pool.run(4);
			void second.catch(() => {});
			expect(settled).toBe(false);
			expect(created).toHaveLength(1);
			expect(exited.size).toBe(0);
			expect(pool.stats).toMatchObject({ active: 1, queued: 1, retiring: 1 });
			created[0]?.resource.postMessage({ action: "finish-flush" });
			expect(await first).toBe(6);
			expect(await second).toBe(8);
			expect(exited.size).toBe(2);
			expect(pool.stats.workers).toBe(0);
		} finally {
			if (!created[0]?.closed) created[0]?.resource.postMessage({ action: "finish-flush" });
		}
	});
	test("native RPC exit caused by cancellation preserves the caller's original reason", async () => {
		const { pool, created, hungDispatched } = realPool();
		await pool.warmup();
		const controller = new AbortController();
		const first = pool.run({ id: 99, value: 0 }, { signal: controller.signal });
		void first.catch(() => {});
		await hungDispatched;
		const second = pool.run({ id: 2, value: 9 });
		const reason = new Error("cancel native task");
		controller.abort(reason);
		await expect(first).rejects.toBe(reason);
		await created[0]?.exited;
		expect(await second).toBe(18);
		expect(created).toHaveLength(2);
	});

	test("native execution timeout stops the worker, not only its RPC promise", async () => {
		const { pool, created, hungDispatched } = realPool();
		await pool.warmup();
		const first = pool.run({ id: 99, value: 0 }, { deadlineAt: Date.now() + 50 });
		void first.catch(() => {});
		await hungDispatched;
		await expect(first).rejects.toMatchObject({ code: "TASK_QUEUE_TIMEOUT" });
		await created[0]?.exited;
		expect(pool.stats.workers).toBe(0);
		expect(await pool.run({ id: 3, value: 5 })).toBe(10);
		expect(created).toHaveLength(2);
	});
});
