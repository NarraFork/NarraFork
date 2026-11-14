import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as compiledWorkers from "../../compiled-worker";
import { logger } from "../../logger";
import type { WorkerPool } from "../../worker-runtime/pool";
import {
	closeImageGenerationResponseWorkers,
	generateAndStoreImages,
	ImageGenerationResponseError,
	imageGenerationResponseDirectory,
	recoverStoredImages,
	resetImageGenerationResponseWorkersForTests,
} from "../image-generation-response";

const connect = compiledWorkers.connectCompiledWorker;
const originalHome = process.env.NARRAFORK_HOME;
const narratorId = "image-lifecycle";
const signal = () => new AbortController().signal;
const params = () => ({ prompt: "generate", model: "image", signal: signal() });
const response = () => new Response('{"data":[{"b64_json":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"}]}');
const stats = () =>
	(
		Reflect.get(globalThis, Symbol.for("narrafork.imageGenerationResponse.workers.v1")) as {
			pool: WorkerPool<unknown, unknown>;
		}
	).pool.stats;

async function until(check: () => boolean): Promise<void> {
	const end = Date.now() + 3_000;
	while (!check()) {
		if (Date.now() >= end) throw new Error("Image worker lifecycle condition was not reached");
		await Bun.sleep(1);
	}
}

beforeEach(async () => {
	await resetImageGenerationResponseWorkersForTests();
	process.env.NARRAFORK_HOME = await mkdtemp(join(tmpdir(), "nf-image-lifecycle-"));
});
afterEach(async () => {
	await closeImageGenerationResponseWorkers();
	mock.restore();
	await resetImageGenerationResponseWorkersForTests();
	if (process.env.NARRAFORK_HOME !== originalHome)
		await rm(process.env.NARRAFORK_HOME as string, { recursive: true, force: true });
	if (originalHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = originalHome;
});

test("throwing slow and header diagnostics preserve paid raw bytes, the result and real cleanup", async () => {
	const nativeWrite = fsPromises.writeFile;
	let writes = 0;
	spyOn(fsPromises, "writeFile").mockImplementation((...args) => {
		if (++writes === 2) return Promise.reject(new Error("PRIVATE_HEADER_FAILURE"));
		return nativeWrite(...args);
	});
	let now = 0;
	spyOn(performance, "now").mockImplementation(() => (now += 2_001));
	const warn = spyOn(logger, "warn").mockImplementation(() => {
		throw new Error("PRIVATE_SINK_FAILURE");
	});
	let exited = false;
	const connection = spyOn(compiledWorkers, "connectCompiledWorker").mockImplementation(
		async (...args) => {
			const connected = await connect(...args);
			connected.worker.once("exit", () => {
				exited = true;
			});
			return connected;
		},
	);
	const send = mock(async () => ({ response: response() }));
	const result = await generateAndStoreImages(params(), { narratorId, signal: signal() }, send);
	expect(result.images).toHaveLength(1);
	expect(send).toHaveBeenCalledTimes(1);
	expect(connection).toHaveBeenCalledTimes(1);
	expect(exited).toBe(true);
	expect(stats()).toMatchObject({ active: 0, workers: 0 });
	const directory = imageGenerationResponseDirectory(narratorId, result.responseId);
	expect(await readFile(join(directory, "response.json"), "utf8")).toContain("b64_json");
	const metadata = JSON.parse(await readFile(join(directory, "metadata.json"), "utf8"));
	expect(metadata.integrity.complete).toBe(true);
	expect(metadata.processed).toBe(true);
	const messages = warn.mock.calls.map(([message]) => message);
	expect(messages).toContain(
		"Image response header metadata could not be saved; preserving response body",
	);
	expect(messages).toContain("Slow image generation local response processing");
	expect(messages).toContain("Slow image generation response capture");
	const logged = JSON.stringify(warn.mock.calls);
	for (const secret of [
		"PRIVATE_HEADER_FAILURE",
		"PRIVATE_SINK_FAILURE",
		result.responseId,
		directory,
	])
		expect(logged).not.toContain(secret);
});
describe("image response exclusive bounded worker sessions", () => {
	test("two paid sessions, 32 queued, overflow rejected; close waits for the active handlers", async () => {
		const network = Promise.withResolvers<void>();
		const send = mock(async () => {
			await network.promise;
			return { response: response() };
		});
		const connection = spyOn(compiledWorkers, "connectCompiledWorker");
		try {
			const tasks = Array.from({ length: 35 }, () =>
				generateAndStoreImages(params(), { narratorId, signal: signal() }, send).catch(
					(error: unknown) => error,
				),
			);
			await until(() => send.mock.calls.length === 2 && stats().queued === 32);
			expect(stats().active).toBe(2);
			expect(stats().queuedBytes).toBeGreaterThan(0);
			let closed = false;
			const closing = closeImageGenerationResponseWorkers().then(() => {
				closed = true;
			});
			await until(() => stats().retiring === 2);
			expect(closed).toBe(false);
			expect(stats().active).toBe(2);
			expect(stats().queued).toBe(0);
			network.resolve();
			await closing;
			const results = await Promise.all(tasks);
			expect(results.every((error) => error instanceof Error)).toBe(true);
			expect(
				results.filter((error) => (error as { code?: string }).code === "TASK_QUEUE_FULL"),
			).toHaveLength(1);
			expect(send).toHaveBeenCalledTimes(2);
			expect(connection).toHaveBeenCalledTimes(2);
			expect(stats().workers).toBe(0);
			expect(stats().active).toBe(0);
		} finally {
			network.resolve();
		}
	});

	test("queued prompt bytes are bounded without scanning/serializing the prompt", async () => {
		const network = Promise.withResolvers<void>();
		const send = mock(async () => {
			await network.promise;
			return { response: response() };
		});
		const tasks: Array<Promise<unknown>> = [];
		try {
			tasks.push(
				...Array.from({ length: 2 }, () =>
					generateAndStoreImages(params(), { narratorId, signal: signal() }, send).catch(
						(error: unknown) => error,
					),
				),
			);
			await until(() => send.mock.calls.length === 2);
			const prompt = "x".repeat(17 * 1024 * 1024);
			tasks.push(
				generateAndStoreImages(
					{ ...params(), prompt },
					{ narratorId, signal: signal() },
					send,
				).catch((error: unknown) => error),
			);
			await until(() => stats().queued === 1);
			expect(stats().queuedBytes).toBeGreaterThan(34 * 1024 * 1024);
			await expect(
				generateAndStoreImages({ ...params(), prompt }, { narratorId, signal: signal() }, send),
			).rejects.toMatchObject({ code: "TASK_QUEUE_FULL" });
			expect(send).toHaveBeenCalledTimes(2);
		} finally {
			const closing = closeImageGenerationResponseWorkers();
			network.resolve();
			await closing;
			await Promise.all(tasks);
		}
	});

	test("cancelled raw capture retains its slot until reader cleanup AND actual worker exit", async () => {
		const cancelRequested = Promise.withResolvers<void>();
		const cancelAck = Promise.withResolvers<void>();
		const holdSecond = Promise.withResolvers<void>();
		const controller = new AbortController();
		let readStarted = false;
		let firstExited = false;
		let connects = 0;
		const connection = spyOn(compiledWorkers, "connectCompiledWorker").mockImplementation(
			async (...args) => {
				const connected = await connect(...args);
				if (++connects === 1)
					connected.worker.once("exit", () => {
						firstExited = true;
					});
				return connected;
			},
		);
		const body = new ReadableStream<Uint8Array>({
			start(stream) {
				stream.enqueue(new TextEncoder().encode('{"data":['));
			},
			pull() {
				readStarted = true;
			},
			cancel() {
				cancelRequested.resolve();
				return cancelAck.promise;
			},
		});
		let sends = 0;
		const send = mock(async () => {
			if (++sends === 1) return { response: new Response(body) };
			if (sends === 2) await holdSecond.promise;
			return { response: response() };
		});
		let settled = false;
		const first = generateAndStoreImages(params(), { narratorId, signal: controller.signal }, send)
			.catch((error: unknown) => error)
			.finally(() => {
				settled = true;
			});
		let second: Promise<unknown> | undefined;
		let third: Promise<unknown> | undefined;
		try {
			// Ensure the first real native connection owns the response that is cancelled.
			await until(() => readStarted);
			second = generateAndStoreImages(params(), { narratorId, signal: signal() }, send);
			await until(() => sends === 2);
			third = generateAndStoreImages(params(), { narratorId, signal: signal() }, send);
			await until(() => stats().queued === 1);
			controller.abort(new Error("cancel response capture"));
			await cancelRequested.promise;
			await until(() => firstExited);
			expect(settled).toBe(false);
			expect(stats().active).toBe(2);
			expect(stats().queued).toBe(1);
			expect(sends).toBe(2);
			cancelAck.resolve();
			const failure = (await first) as ImageGenerationResponseError;
			expect(failure).toBeInstanceOf(ImageGenerationResponseError);
			expect(failure.responseId).toBeTruthy();
			expect(
				await readFile(
					join(
						imageGenerationResponseDirectory(narratorId, failure.responseId as string),
						"response.json.partial",
					),
					"utf8",
				),
			).toBe('{"data":[');
			await third;
			expect(sends).toBe(3);
			expect(connection).toHaveBeenCalledTimes(3);
			holdSecond.resolve();
			await second;
		} finally {
			cancelAck.resolve();
			holdSecond.resolve();
			await Promise.allSettled([first, second, third]);
		}
	});

	test("pending creation is awaited; production close permanently blocks generate/recover and HMR", async () => {
		const gate = Promise.withResolvers<void>();
		const ready = Promise.withResolvers<void>();
		let exited = false;
		const connection = spyOn(compiledWorkers, "connectCompiledWorker").mockImplementation(
			async (...args) => {
				const connected = await connect(...args);
				connected.worker.once("exit", () => {
					exited = true;
				});
				ready.resolve();
				await gate.promise;
				return connected;
			},
		);
		const send = mock(async () => ({ response: response() }));
		try {
			const task = generateAndStoreImages(params(), { narratorId, signal: signal() }, send).catch(
				(error: unknown) => error,
			);
			await ready.promise;
			let closed = false;
			const closing = closeImageGenerationResponseWorkers().then(() => {
				closed = true;
			});
			await Promise.resolve();
			expect(closed).toBe(false);
			expect(exited).toBe(false);
			await expect(
				generateAndStoreImages(params(), { narratorId, signal: signal() }, send),
			).rejects.toThrow("closed");
			await expect(
				recoverStoredImages("previous-response", { narratorId, signal: signal() }),
			).rejects.toThrow("closed");
			const reloaded = await import(
				new URL("../image-generation-response.ts?closed-owner", import.meta.url).href
			);
			await expect(
				reloaded.generateAndStoreImages(params(), { narratorId, signal: signal() }, send),
			).rejects.toThrow("closed");
			gate.resolve();
			await closing;
			expect(await task).toBeInstanceOf(Error);
			expect(exited).toBe(true);
			expect(send).not.toHaveBeenCalled();
			expect(connection).toHaveBeenCalledTimes(1);
		} finally {
			gate.resolve();
		}
	});

	test.each([
		[null],
		["invalid"],
		[[]],
		[{}],
		[{ ok: false, error: 1 }],
	])("malformed local reply %j preserves raw bytes and waits for actual exit without replay", async (frame) => {
		let exited = false;
		let dispatched = 0;
		spyOn(compiledWorkers, "connectCompiledWorker").mockImplementation(async (...args) => {
			const connected = await connect(...args);
			connected.worker.once("exit", () => {
				exited = true;
			});
			spyOn(connected.worker, "postMessage").mockImplementation(() => {
				dispatched++;
				connected.worker.emit("message", frame);
			});
			return connected;
		});
		const send = mock(async () => ({ response: response() }));
		const failure = (await generateAndStoreImages(
			params(),
			{ narratorId, signal: signal() },
			send,
		).catch((error: unknown) => error)) as ImageGenerationResponseError;
		expect(failure).toBeInstanceOf(ImageGenerationResponseError);
		expect(failure.message).toBe("Invalid image response worker reply");
		expect(exited).toBe(true);
		expect(dispatched).toBe(1);
		expect(send).toHaveBeenCalledTimes(1);
		expect(
			await readFile(
				join(
					imageGenerationResponseDirectory(narratorId, failure.responseId as string),
					"response.json",
				),
				"utf8",
			),
		).toContain("b64_json");
		expect(stats().workers).toBe(0);
	});

	test("network generation has no new total deadline; the stale-read budget starts only locally", async () => {
		const network = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const send = mock(async () => {
			entered.resolve();
			await network.promise;
			return { response: response() };
		});
		const now = Date.now;
		const task = generateAndStoreImages(params(), { narratorId, signal: signal() }, send);
		let restoreClock: (() => void) | undefined;
		try {
			await entered.promise;
			// Crossing an entire hour must not turn a local resource budget into a paid HTTP deadline.
			const clock = spyOn(Date, "now").mockImplementation(() => now() + 60 * 60 * 1000);
			restoreClock = () => clock.mockRestore();
			network.resolve();
			expect((await task).images).toHaveLength(1);
			expect(send).toHaveBeenCalledTimes(1);
		} finally {
			restoreClock?.();
			network.resolve();
		}
	});

	test("a real unready worker exhausts startup budget before any potentially paid send", async () => {
		const connection = spyOn(compiledWorkers, "connectCompiledWorker").mockImplementation(
			(_entries, options) =>
				connect([new URL("./request-json-not-ready.fixture.ts", import.meta.url).href], {
					...options,
					timeoutMs: 25,
				}),
		);
		const send = mock(async () => ({ response: response() }));
		await expect(
			generateAndStoreImages(params(), { narratorId, signal: signal() }, send),
		).rejects.toThrow("worker did not become ready");
		expect(send).not.toHaveBeenCalled();
		expect(connection).toHaveBeenCalledTimes(1);
		expect(stats().active).toBe(0);
		expect(stats().starting).toBe(0);
		expect(stats().workers).toBe(0);
	});
});
