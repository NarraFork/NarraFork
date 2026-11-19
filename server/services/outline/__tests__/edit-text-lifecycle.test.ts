import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { copyFile, unlink } from "node:fs/promises";
import type { Worker } from "node:worker_threads";
import { connectCompiledWorker } from "../../../lib/compiled-worker";
import { logger } from "../../../lib/logger";
import { WorkerCleanupError, type WorkerHandle } from "../../../lib/worker-runtime/lifecycle";
import * as core from "../edit-text";
import {
	closeEditTextWorkers,
	createEditTextChannel,
	type EditTextChannel,
	type EditTextChannelLimits,
	type EditTextWorkerConnect,
	OutlineEditTextError,
	processBackgroundText,
	processEditText,
	resetEditTextWorkersForTests,
} from "../edit-text-runner";

const limits: EditTextChannelLimits = {
	inlineBytes: 1024,
	maxBytes: 1024 * 1024,
	timeoutMs: 2_000,
	maxQueued: 2,
	idleMs: 30_000,
	startMs: 1_000,
};
const job: core.EditTextJob = { kind: "notes", text: "word ".repeat(1_000), continued: "(cont.)" };
const small: core.EditTextJob = { kind: "normalize", contents: ["plain"] };
const channels: EditTextChannel[] = [];
let sequence = 0;
const ownerKey = (name: string) => Symbol.for(`narrafork.outline.editTextWorker${name}`);
function channel(connect?: EditTextWorkerConnect) {
	const name = `.native-lifecycle-${++sequence}`;
	const value = createEditTextChannel(name, limits, connect);
	channels.push(value);
	return { value, state: () => Reflect.get(globalThis, ownerKey(name)) };
}
function connectFixture(mode: string, options: Parameters<EditTextWorkerConnect>[0]) {
	return connectCompiledWorker([new URL("./edit-text-worker.fixture.ts", import.meta.url).href], {
		...options,
		workerOptions: { workerData: { mode } },
	});
}
const failure = (promise: Promise<unknown>) => promise.catch((error: unknown) => error);
afterEach(async () => {
	for (const value of channels.splice(0)) await value.stop();
	await resetEditTextWorkersForTests();
	mock.restore();
});

test("permanent close rejects waiters and tiny work without dispatch, and waits for real exit", async () => {
	const gate = Promise.withResolvers<void>();
	const stopping = Promise.withResolvers<void>();
	const posted = Promise.withResolvers<void>();
	const inline = spyOn(core, "runEditTextJob");
	let creates = 0;
	let dispatches = 0;
	let exited = false;
	const { value, state } = channel(async (options) => {
		creates++;
		const connected = await connectFixture("hang", options);
		connected.worker.once("exit", () => {
			exited = true;
		});
		const close = connected.handle.close.bind(connected.handle);
		spyOn(connected.handle, "close").mockImplementation(async () => {
			stopping.resolve();
			await gate.promise;
			await close();
		});
		const send = connected.worker.postMessage.bind(connected.worker);
		spyOn(connected.worker, "postMessage").mockImplementation((message) => {
			dispatches++;
			send(message);
			posted.resolve();
		});
		return connected;
	});
	try {
		const active = failure(value.run(job, { worker: true }));
		await posted.promise;
		const first = failure(value.run(job, { worker: true }));
		const second = failure(value.run(job, { worker: true }));
		expect(await failure(value.run(job, { worker: true }))).toMatchObject({
			code: "OUTLINE_TEXT_BUSY",
			statusCode: 503,
		});
		let closed = false;
		const closing = value.stop({ permanent: true }).then(() => {
			closed = true;
		});
		await stopping.promise;
		expect(closed).toBe(false);
		expect(exited).toBe(false);
		expect(state().pool.stats).toMatchObject({ active: 1, queued: 0, retiring: 1 });
		expect(await first).toBeInstanceOf(OutlineEditTextError);
		expect(await second).toBeInstanceOf(OutlineEditTextError);
		expect(await failure(value.run(small))).toMatchObject({
			code: "OUTLINE_TEXT_FAILED",
			statusCode: 499,
		});
		expect(dispatches).toBe(1);
		expect(creates).toBe(1);
		expect(inline).not.toHaveBeenCalled();
		gate.resolve();
		await closing;
		expect(await active).toBeInstanceOf(OutlineEditTextError);
		expect(exited).toBe(true);
		expect(state().pool.stats).toMatchObject({ active: 0, workers: 0, queued: 0 });
	} finally {
		gate.resolve();
	}
});

test("a queued cancellation settles without touching the active worker or waiting for it", async () => {
	const posted = Promise.withResolvers<void>();
	const activeController = new AbortController();
	let creates = 0;
	const { value } = channel(async (options) => {
		const connected = await connectFixture(++creates === 1 ? "hang" : "ok", options);
		const send = connected.worker.postMessage.bind(connected.worker);
		spyOn(connected.worker, "postMessage").mockImplementation((message) => {
			send(message);
			posted.resolve();
		});
		return connected;
	});
	const active = failure(value.run(job, { worker: true, signal: activeController.signal }));
	await posted.promise;
	const controller = new AbortController();
	const cancelled = failure(value.run(job, { worker: true, signal: controller.signal }));
	controller.abort();
	expect(await cancelled).toMatchObject({ code: "OUTLINE_TEXT_FAILED", statusCode: 499 });
	expect(creates).toBe(1);
	activeController.abort();
	expect(await active).toMatchObject({ code: "OUTLINE_TEXT_FAILED", statusCode: 499 });
	const result = await value.run(job, { worker: true });
	expect(result.count).toBeGreaterThan(0);
	expect(creates).toBe(2);
});

test.each([
	"invalid",
	"crash",
])("native %s never becomes empty success or main-thread computation", async (mode) => {
	const inline = spyOn(core, "runEditTextJob");
	let exited = false;
	const { value, state } = channel(async (options) => {
		const connected = await connectFixture(mode, options);
		connected.worker.once("exit", () => {
			exited = true;
		});
		return connected;
	});
	expect(await failure(value.run(job, { worker: true }))).toMatchObject({
		code: "OUTLINE_TEXT_FAILED",
	});
	expect(exited).toBe(true);
	expect(state().pool.stats.workers).toBe(0);
	expect(inline).not.toHaveBeenCalled();
});

test("duplicate ready and foreign IDs cannot replace a real result, and one thread is reused", async () => {
	const inline = spyOn(core, "runEditTextJob");
	let creates = 0;
	let dispatches = 0;
	const { value } = channel(async (options) => {
		creates++;
		const connected = await connectFixture("stale", options);
		const send = connected.worker.postMessage.bind(connected.worker);
		spyOn(connected.worker, "postMessage").mockImplementation((message) => {
			dispatches++;
			send(message);
		});
		return connected;
	});
	for (let i = 0; i < 2; i++)
		expect((await value.run(job, { worker: true })).count).toBeGreaterThan(0);
	expect(creates).toBe(1);
	expect(dispatches).toBe(2);
	expect(inline).not.toHaveBeenCalled();
});

test("readiness uses the first task budget, and a late ready worker exits without receiving the job", async () => {
	let now = 10_000;
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	let dispatches = 0;
	let exited = false;
	const { value } = channel(async (options) => {
		const connected = await connectFixture("ok", options);
		connected.worker.once("exit", () => {
			exited = true;
		});
		spyOn(connected.worker, "postMessage").mockImplementation(() => {
			dispatches++;
		});
		now += limits.timeoutMs + 1;
		return connected;
	});
	try {
		expect(await failure(value.run(job, { worker: true }))).toMatchObject({
			code: "OUTLINE_TEXT_TIMEOUT",
		});
		expect(exited).toBe(true);
		expect(dispatches).toBe(0);
	} finally {
		clock.mockRestore();
	}
});

test("close also waits for a non-cooperative pending connector and disposes its late worker", async () => {
	const entered = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	let dispatches = 0;
	let exited = false;
	const { value, state } = channel(async () => {
		entered.resolve();
		await gate.promise;
		const connected = await connectFixture("ok", {
			signal: new AbortController().signal,
			deadlineAt: Date.now() + 2_000,
		});
		connected.worker.once("exit", () => {
			exited = true;
		});
		spyOn(connected.worker, "postMessage").mockImplementation(() => {
			dispatches++;
		});
		return connected;
	});
	try {
		const task = failure(value.run(job, { worker: true }));
		await entered.promise;
		let closed = false;
		const closing = value.stop({ permanent: true }).then(() => {
			closed = true;
		});
		await Promise.resolve();
		expect(closed).toBe(false);
		expect(state().pool.stats.starting).toBe(1);
		gate.resolve();
		await closing;
		expect(await task).toBeInstanceOf(OutlineEditTextError);
		expect(exited).toBe(true);
		expect(dispatches).toBe(0);
	} finally {
		gate.resolve();
	}
});

test("failed startup cleanup keeps its physical slot until observed exit, not another stop attempt", async () => {
	let creates = 0;
	let resource: { worker: Worker; handle: WorkerHandle<Worker> } | undefined;
	const entered = Promise.withResolvers<void>();
	const { value, state } = channel(async (options) => {
		const connected = await connectFixture("ok", options);
		if (++creates === 1) {
			resource = connected;
			spyOn(connected.handle, "close").mockRejectedValue(new Error("unconfirmed native exit"));
			throw new WorkerCleanupError(connected.handle, new Error("unconfirmed native exit"));
		}
		entered.resolve();
		return connected;
	});
	try {
		expect(await failure(value.run(job, { worker: true }))).toMatchObject({
			code: "OUTLINE_TEXT_FAILED",
		});
		const next = value.run(job, { worker: true });
		await Promise.resolve();
		expect(creates).toBe(1);
		expect(state().pool.stats.retiring).toBe(1);
		await resource?.worker.terminate();
		await entered.promise;
		expect((await next).count).toBeGreaterThan(0);
		expect(creates).toBe(2);
	} finally {
		if (resource && !resource.handle.closed) await resource.worker.terminate();
	}
});

test("permanent shutdown is shared by actual module reevaluation and even tiny inline calls", async () => {
	await processEditText(small, { worker: true });
	const target = new URL(
		`../edit-text-runner.hmr-${process.pid}-${sequence++}.ts`,
		import.meta.url,
	);
	await copyFile(new URL("../edit-text-runner.ts", import.meta.url), target);
	try {
		const other = await import(target.href);
		expect(other.processEditText).not.toBe(processEditText);
		const original = Reflect.get(globalThis, ownerKey(""));
		await other.closeEditTextWorkers();
		expect(Reflect.get(globalThis, ownerKey(""))).toBe(original);
		expect(await failure(processEditText(small))).toMatchObject({ code: "OUTLINE_TEXT_FAILED" });
		expect(await failure(other.processEditText(small))).toMatchObject({
			code: "OUTLINE_TEXT_FAILED",
		});
		expect(await failure(processBackgroundText(small))).toMatchObject({
			code: "OUTLINE_TEXT_FAILED",
		});
		await resetEditTextWorkersForTests();
		expect(await processEditText(small)).toHaveLength(1);
	} finally {
		await unlink(target);
	}
});

test("a legacy owner without handles fails closed even with no counted active work", async () => {
	await closeEditTextWorkers();
	const key = ownerKey("");
	const current = Reflect.get(globalThis, key);
	const legacy = { worker: null, starting: null, queue: [], active: null, idle: null, nextId: 0 };
	Reflect.set(globalThis, key, legacy);
	const target = new URL(
		`../edit-text-runner.legacy-${process.pid}-${sequence++}.ts`,
		import.meta.url,
	);
	await copyFile(new URL("../edit-text-runner.ts", import.meta.url), target);
	try {
		const other = await import(target.href);
		expect(other.processEditText).not.toBe(processEditText);
		const error = await failure(other.processEditText(small));
		expect(error).toMatchObject({ code: "OUTLINE_TEXT_FAILED", statusCode: 503 });
		expect((error as Error).message).toContain("restart");
		expect(await failure(other.closeEditTextWorkers())).toBeInstanceOf(other.OutlineEditTextError);
		expect(Reflect.get(globalThis, key)).toBe(legacy);
	} finally {
		Reflect.set(globalThis, key, current);
		await unlink(target);
	}
});

test("diagnostic failures cannot replace a worker result or skip exit cleanup", async () => {
	let now = 0;
	spyOn(performance, "now").mockImplementation(() => (now += 1_001));
	const warn = spyOn(logger, "warn").mockImplementation(() => {
		throw new Error("PRIVATE_LOG_FAILURE");
	});
	const { value, state } = channel();
	expect((await value.run(job, { worker: true })).count).toBeGreaterThan(0);
	expect(warn).toHaveBeenCalled();
	await value.stop({ permanent: true });
	expect(state().pool.stats.workers).toBe(0);
	const logged = JSON.stringify(warn.mock.calls);
	for (const secret of ["PRIVATE_LOG_FAILURE", "PRIVATE_OUTLINE_TEXT_FAILURE", import.meta.dir])
		expect(logged).not.toContain(secret);
});
