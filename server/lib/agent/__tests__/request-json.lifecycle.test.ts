import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as compiledWorkers from "../../compiled-worker";
import { logger } from "../../logger";
import type { WorkerPool } from "../../worker-runtime/pool";
import {
	closeRequestJsonWorkers,
	createRequestBodyEncoder,
	resetRequestJsonWorkersForTests,
	stringifyRequestBody,
} from "../request-json";
import type { JsonPacketPart } from "../request-json-worker";

const connect = compiledWorkers.connectCompiledWorker;
const body = () => ({ text: "x".repeat(40_000) });
const owner = () =>
	Reflect.get(globalThis, Symbol.for("narrafork.requestJson.workers.v1")) as {
		pool: WorkerPool<JsonPacketPart[], string>;
	};

async function until(check: () => boolean): Promise<void> {
	const end = Date.now() + 3_000;
	while (!check()) {
		if (Date.now() >= end) throw new Error("Worker lifecycle condition was not reached");
		await Bun.sleep(1);
	}
}

beforeEach(resetRequestJsonWorkersForTests);
afterEach(async () => {
	// Restore injected close gates before draining the test owner.
	await closeRequestJsonWorkers();
	await resetRequestJsonWorkersForTests();
});

test("a throwing slow-encoding diagnostic cannot replace the native worker result", async () => {
	let now = 0;
	const clock = spyOn(performance, "now").mockImplementation(() => (now += 201));
	const debug = spyOn(logger, "debug").mockImplementation(() => {
		throw new Error("PRIVATE_SINK_FAILURE");
	});
	const connection = spyOn(compiledWorkers, "connectCompiledWorker");
	try {
		const value = body();
		const encoded = await stringifyRequestBody(value);
		expect(JSON.parse(encoded)).toEqual(value);
		expect(connection).toHaveBeenCalledTimes(1);
		expect(debug).toHaveBeenCalledTimes(1);
		expect(debug.mock.calls[0]?.[0]).toBe("Large provider request encoded");
		expect(Object.keys(debug.mock.calls[0]?.[1] ?? {}).sort()).toEqual(["characters", "elapsedMs"]);
		expect(owner().pool.stats.active).toBe(0);
		await closeRequestJsonWorkers();
		expect(owner().pool.stats.workers).toBe(0);
	} finally {
		connection.mockRestore();
		debug.mockRestore();
		clock.mockRestore();
	}
});
describe("request JSON unified worker lifecycle", () => {
	test("bounds the packet queue and rejects overflow without computing or replaying", async () => {
		let dispatches = 0;
		const connection = spyOn(compiledWorkers, "connectCompiledWorker").mockImplementation(
			async (...args) => {
				const connected = await connect(...args);
				spyOn(connected.worker, "postMessage").mockImplementation(() => {
					dispatches++;
				});
				return connected;
			},
		);
		try {
			const tasks = Array.from({ length: 34 }, () =>
				stringifyRequestBody(body()).then(
					() => "unexpected success",
					(error: unknown) => error,
				),
			);
			await until(() => owner().pool.stats.queued === 32 && dispatches === 1);
			expect(owner().pool.stats.active).toBe(1);
			expect(owner().pool.stats.queuedBytes).toBeGreaterThan(0);
			expect(owner().pool.stats.queuedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
			await closeRequestJsonWorkers();
			const results = await Promise.all(tasks);
			expect(
				results.filter((error) => (error as { code?: string }).code === "TASK_QUEUE_FULL"),
			).toHaveLength(1);
			expect(results.every((error) => error instanceof Error)).toBe(true);
			expect(dispatches).toBe(1);
			expect(connection).toHaveBeenCalledTimes(1);
			expect(owner().pool.stats.workers).toBe(0);
		} finally {
			connection.mockRestore();
		}
	});

	test("cancellation keeps the slot until actual exit, without replaying the aborted packet", async () => {
		const gate = Promise.withResolvers<void>();
		const stopping = Promise.withResolvers<void>();
		let exited = false;
		let dispatches = 0;
		let creates = 0;
		const connection = spyOn(compiledWorkers, "connectCompiledWorker").mockImplementation(
			async (...args) => {
				const connected = await connect(...args);
				if (++creates === 1) {
					connected.worker.once("exit", () => {
						exited = true;
					});
					const close = connected.handle.close.bind(connected.handle);
					spyOn(connected.handle, "close").mockImplementation(async () => {
						stopping.resolve();
						await gate.promise;
						await close();
					});
					spyOn(connected.worker, "postMessage").mockImplementation(() => {
						dispatches++;
					});
				}
				return connected;
			},
		);
		const controller = new AbortController();
		const reason = new Error("cancel one packet");
		let settled = false;
		try {
			const first = stringifyRequestBody(body(), controller.signal).catch((error: unknown) => {
				settled = true;
				return error;
			});
			await until(() => dispatches === 1);
			const second = stringifyRequestBody(body());
			await until(() => owner().pool.stats.queued === 1);
			controller.abort(reason);
			await stopping.promise;
			expect(settled).toBe(false);
			expect(exited).toBe(false);
			expect(owner().pool.stats.active).toBe(1);
			expect(owner().pool.stats.queued).toBe(1);
			expect(creates).toBe(1);
			gate.resolve();
			expect(await first).toBe(reason);
			expect(exited).toBe(true);
			expect(await second).toBe(JSON.stringify(body()));
			expect(creates).toBe(2);
			expect(dispatches).toBe(1);
		} finally {
			gate.resolve();
			connection.mockRestore();
		}
	});

	test("waiting packets do not start a 30-second computation or HTTP deadline", async () => {
		const schedule = globalThis.setTimeout;
		let packetTimers = 0;
		const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: (...args: unknown[]) => void,
			delay?: number,
			...args: unknown[]
		) => {
			if (delay === 30_000) packetTimers++;
			return schedule(callback, delay, ...args);
		}) as typeof setTimeout);
		const connection = spyOn(compiledWorkers, "connectCompiledWorker").mockImplementation(
			async (...args) => {
				const connected = await connect(...args);
				spyOn(connected.worker, "postMessage").mockImplementation(() => {});
				return connected;
			},
		);
		try {
			const first = stringifyRequestBody(body()).catch((error: unknown) => error);
			await until(() => packetTimers === 1);
			const second = stringifyRequestBody(body()).catch((error: unknown) => error);
			await until(() => owner().pool.stats.queued === 1);
			expect(packetTimers).toBe(1);
			await closeRequestJsonWorkers();
			expect(await first).toBeInstanceOf(Error);
			expect(await second).toBeInstanceOf(Error);
			expect(connection).toHaveBeenCalledTimes(1);
		} finally {
			timer.mockRestore();
			connection.mockRestore();
		}
	});

	test("a real runtime crash fails the single packet without main-thread recomputation", async () => {
		let exited = false;
		let dispatches = 0;
		const connection = spyOn(compiledWorkers, "connectCompiledWorker").mockImplementation(
			async (...args) => {
				const connected = await connect(...args);
				connected.worker.once("exit", () => {
					exited = true;
				});
				const post = connected.worker.postMessage.bind(connected.worker);
				spyOn(connected.worker, "postMessage").mockImplementation(() => {
					dispatches++;
					// The real packet worker throws outside its domain escaping error handler.
					post(null);
				});
				return connected;
			},
		);
		try {
			await expect(stringifyRequestBody(body())).rejects.toThrow("Request JSON worker exited");
			expect(exited).toBe(true);
			expect(dispatches).toBe(1);
			expect(connection).toHaveBeenCalledTimes(1);
			expect(owner().pool.stats.workers).toBe(0);
		} finally {
			connection.mockRestore();
		}
	});

	test("unready worker fails its finite startup budget and exits without a business dispatch", async () => {
		const connection = spyOn(compiledWorkers, "connectCompiledWorker").mockImplementation(
			(_entries, options) =>
				connect([new URL("./request-json-not-ready.fixture.ts", import.meta.url).href], {
					...options,
					timeoutMs: 25,
				}),
		);
		try {
			await expect(stringifyRequestBody(body())).rejects.toThrow("worker did not become ready");
			expect(connection).toHaveBeenCalledTimes(1);
			expect(owner().pool.stats.active).toBe(0);
			expect(owner().pool.stats.starting).toBe(0);
			expect(owner().pool.stats.workers).toBe(0);
		} finally {
			connection.mockRestore();
		}
	});

	test("close waits for pending native creation and keeps every entry closed across reevaluation", async () => {
		const gate = Promise.withResolvers<void>();
		const ready = Promise.withResolvers<void>();
		let exited = false;
		let dispatched = false;
		const encoder = createRequestBodyEncoder();
		const connection = spyOn(compiledWorkers, "connectCompiledWorker").mockImplementation(
			async (...args) => {
				const connected = await connect(...args);
				connected.worker.once("exit", () => {
					exited = true;
				});
				spyOn(connected.worker, "postMessage").mockImplementation(() => {
					dispatched = true;
				});
				ready.resolve();
				await gate.promise;
				return connected;
			},
		);
		try {
			const running = stringifyRequestBody(body()).catch((error: unknown) => error);
			await ready.promise;
			let closed = false;
			const closing = closeRequestJsonWorkers().then(() => {
				closed = true;
			});
			await Promise.resolve();
			expect(closed).toBe(false);
			expect(exited).toBe(false);
			await expect(encoder({ text: "small" })).rejects.toThrow("closed");
			await expect(stringifyRequestBody(body())).rejects.toThrow("closed");
			expect(() => createRequestBodyEncoder()).toThrow("closed");
			const reloaded = await import(
				new URL("../request-json.ts?closed-owner", import.meta.url).href
			);
			await expect(reloaded.stringifyRequestBody({ text: "small" })).rejects.toThrow("closed");
			gate.resolve();
			await closing;
			expect(await running).toBeInstanceOf(Error);
			expect(exited).toBe(true);
			expect(dispatched).toBe(false);
			expect(connection).toHaveBeenCalledTimes(1);
		} finally {
			gate.resolve();
			connection.mockRestore();
		}
	});
});
