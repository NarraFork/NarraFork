import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import * as compiled from "../lib/compiled-worker";
import { WorkerHandle } from "../lib/worker-runtime/lifecycle";
import {
	type HistoricalWriteDocumentIdentity,
	ToolInputStreamSourceService,
} from "./tool-input-stream-source";
import { HistoricalWriteWorkerRuntime } from "./tool-input-stream-source-worker";

const identity: HistoricalWriteDocumentIdentity = {
	narratorId: "author",
	toolUseId: "tool",
	toolName: "Write",
	toolCallId: "row",
	messageId: "message",
	executionAttempt: 1,
};
const reference = { toolCallId: "row", messageId: "message", executionAttempt: 1 };
const directories: string[] = [];
const runtimes: HistoricalWriteWorkerRuntime[] = [];
const services: ToolInputStreamSourceService[] = [];
const spies: Array<{ mockRestore(): void }> = [];
const controllers: AbortController[] = [];
const handles: WorkerHandle<Worker>[] = [];
const controller = () => {
	const control = new AbortController();
	controllers.push(control);
	return control;
};
async function fixture(text = "page".repeat(10000)) {
	const directory = await mkdtemp(join(tmpdir(), "nf-history-runtime-"));
	directories.push(directory);
	const path = join(directory, "input.sqlite");
	const db = new Database(path);
	db.run(
		"CREATE TABLE narrator_tool_calls (id TEXT, message_id TEXT, tool_use_id TEXT, narrator_id TEXT, execution_attempt INTEGER, tool_name TEXT, input_json TEXT)",
	);
	db.run("INSERT INTO narrator_tool_calls VALUES (?, ?, ?, ?, ?, ?, ?)", [
		identity.toolCallId,
		identity.messageId,
		identity.toolUseId,
		identity.narratorId,
		identity.executionAttempt,
		identity.toolName,
		JSON.stringify({ content: text }),
	]);
	db.close();
	const runtime = new HistoricalWriteWorkerRuntime();
	runtimes.push(runtime);
	return { directory, path, runtime, text };
}
function observeWorkers() {
	const launch = WorkerHandle.thread;
	spies.push(
		spyOn(WorkerHandle, "thread").mockImplementation((entry, options) => {
			const handle = launch(entry, options);
			handles.push(handle);
			return handle;
		}),
	);
}
async function until(check: () => boolean) {
	const deadline = Date.now() + 2000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("Fixture observation timed out");
		await Bun.sleep(1);
	}
}
afterEach(async () => {
	for (const control of controllers.splice(0)) control.abort(new Error("test cleanup"));
	await Promise.all(services.splice(0).map((service) => service.closeHistoricalWorkers()));
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
	for (const handle of handles.splice(0)) await handle.close();
	for (const spy of spies.splice(0).reverse()) spy.mockRestore();
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

test("one page in flight, cancel waits for real exit before replacing the stream; no replay", async () => {
	const { runtime, path, text } = await fixture();
	observeWorkers();
	const started = Promise.withResolvers<void>();
	const active = controller();
	let pages = 0;
	const pending = runtime
		.stream(
			path,
			identity,
			async () => {
				pages++;
				started.resolve();
				await new Promise(() => {});
			},
			active.signal,
			10_000,
		)
		.catch((error) => error);
	await started.promise;
	const stop = handles[0].resource.terminate.bind(handles[0].resource);
	const stopping = Promise.withResolvers<void>();
	const exitGate = Promise.withResolvers<void>();
	spies.push(
		spyOn(handles[0].resource, "terminate").mockImplementation(async () => {
			stopping.resolve();
			await exitGate.promise;
			return stop();
		}),
	);
	active.abort(new Error("stop stream"));
	await stopping.promise;
	let result = "";
	const queued = runtime.stream(
		path,
		identity,
		async (chunk) => {
			result += chunk;
		},
		controller().signal,
		10_000,
	);
	await Bun.sleep(5);
	expect(pages).toBe(1);
	expect(handles).toHaveLength(1);
	exitGate.resolve();
	expect((await pending).message).toBe("stop stream");
	await queued;
	expect(handles).toHaveLength(2);
	expect(result).toBe(text);
	expect(pages).toBe(1);
});

test("permanently unacknowledged page times out, actually exits and never emits empty success", async () => {
	const { runtime, path } = await fixture();
	observeWorkers();
	let pages = 0;
	await expect(
		runtime.stream(
			path,
			identity,
			async () => {
				pages++;
				await new Promise(() => {});
			},
			controller().signal,
			500,
		),
	).rejects.toMatchObject({ code: "TEXT_DOCUMENT_READ_TIMEOUT" });
	expect(pages).toBe(1);
	expect(handles).toHaveLength(1);
	await handles[0].exited;
	await runtime.close();
	await expect(
		runtime.stream(path, identity, async () => {}, controller().signal, 10_000),
	).rejects.toMatchObject({ code: "TEXT_DOCUMENT_HISTORY_CLOSED" });
	expect(handles).toHaveLength(1);
});

test("readonly connection keeps busy_timeout zero and packet budget is not the 1GiB source ceiling", async () => {
	const { runtime, path, text } = await fixture();
	const launch = WorkerHandle.thread;
	let maxSource = 0;
	let pageChars = 0;
	spies.push(
		spyOn(WorkerHandle, "thread").mockImplementation((entry, options) => {
			const handle = launch(entry, options);
			handles.push(handle);
			const post = handle.resource.postMessage.bind(handle.resource);
			spies.push(
				spyOn(handle.resource, "postMessage").mockImplementation((message) => {
					if (message.action === "read") {
						maxSource = message.data.maxInputBytes;
						pageChars = message.data.pageChars;
					}
					post(message);
				}),
			);
			return handle;
		}),
	);
	let received = "";
	await runtime.stream(
		path,
		identity,
		async (chunk) => {
			expect(chunk.length).toBeLessThanOrEqual(8192);
			received += chunk;
		},
		controller().signal,
		10_000,
	);
	expect(maxSource).toBe(1024 * 1024 * 1024);
	expect(pageChars).toBe(8192);
	expect(received).toBe(text);
	const locked = new Database(path);
	try {
		locked.run("BEGIN EXCLUSIVE");
		await expect(
			runtime.stream(
				path,
				identity,
				async () => {
					throw new Error("must not receive data under lock");
				},
				controller().signal,
				500,
			),
		).rejects.toMatchObject({ code: "TEXT_DOCUMENT_WORKER_FAILED" });
	} finally {
		locked.run("ROLLBACK");
		locked.close();
	}
});

test("shared subscription cancellation cannot stop another viewer's stream", async () => {
	const { runtime, path, directory, text } = await fixture();
	observeWorkers();
	const gate = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	let cancelled = false;
	const service = new ToolInputStreamSourceService({
		directory,
		memoryBytes: 16,
		loadHistoricalIdentity: async () => identity,
		streamHistorical: (row, sink, signal) =>
			runtime.stream(
				path,
				row,
				async (chunk, offset) => {
					started.resolve();
					await gate.promise;
					cancelled ||= signal.aborted;
					await sink(chunk, offset);
				},
				signal,
				10_000,
			),
	});
	services.push(service);
	const firstController = controller();
	const first = service
		.ensureWriteDocumentSource("viewer", "tool", reference, firstController.signal)
		.catch((error) => error);
	await started.promise;
	const second = service.ensureWriteDocumentSource(
		"viewer",
		"tool",
		reference,
		controller().signal,
	);
	await Bun.sleep(0);
	firstController.abort(new Error("first viewer left"));
	expect((await first).message).toBe("first viewer left");
	expect(cancelled).toBe(false);
	gate.resolve();
	const ref = await second;
	expect(ref.length).toBe(text.length);
	expect(handles).toHaveLength(1);
	await service.closeHistoricalWorkers();
	expect((await service.getTextDocumentRange("viewer", ref.id, 0, 16)).text).toBe(
		text.slice(0, 16),
	);
	await expect(
		service.ensureWriteDocumentSource("viewer", "tool", reference),
	).rejects.toMatchObject({ code: "TEXT_DOCUMENT_HISTORY_CLOSED" });
	await service.discard(ref.id);
});

test("production close drains pending FD writes and partial cleanup without deleting durable aliases", async () => {
	const { directory, runtime, path } = await fixture();
	observeWorkers();
	const writeStarted = Promise.withResolvers<void>();
	const writeGate = Promise.withResolvers<void>();
	const service = new ToolInputStreamSourceService({
		directory,
		memoryBytes: 0,
		loadHistoricalIdentity: async () => identity,
		streamHistorical: (row, sink, signal) => runtime.stream(path, row, sink, signal, 10_000),
		write: async (file, bytes, position) => {
			writeStarted.resolve();
			await writeGate.promise;
			await file.write(bytes, 0, bytes.length, position);
		},
	});
	services.push(service);
	const pending = service
		.ensureWriteDocumentSource("viewer", "tool", reference)
		.catch((error) => error);
	await writeStarted.promise;
	let closed = false;
	const closing = service.closeHistoricalWorkers().then(() => {
		closed = true;
	});
	await handles[0].exited;
	expect(closed).toBe(false);
	expect((await pending).code).toBe("TEXT_DOCUMENT_HISTORY_CLOSED");
	writeGate.resolve();
	await closing;
	expect(service.usage.sources).toBe(0);
	expect((await readdir(directory)).filter((name) => name.startsWith("nf-tool-input-"))).toEqual(
		[],
	);
});

test("unconfirmed FD cleanup permanently closes history admission and reports close failure without losing evidence", async () => {
	const { directory } = await fixture();
	let closeFailure: { mockRestore(): void } | undefined;
	const service = new ToolInputStreamSourceService({
		directory,
		memoryBytes: 0,
		loadHistoricalIdentity: async () => identity,
		streamHistorical: async (_identity, sink) => {
			await sink("raw", 0);
			throw new Error("read failed after spill");
		},
		write: async (file, bytes, position) => {
			closeFailure = spyOn(file, "close").mockRejectedValue(new Error("FD cleanup not confirmed"));
			spies.push(closeFailure);
			await file.write(bytes, 0, bytes.length, position);
		},
	});
	services.push(service);
	await expect(service.ensureWriteDocumentSource("viewer", "tool", reference)).rejects.toThrow(
		"FD cleanup not confirmed",
	);
	await expect(service.closeHistoricalWorkers()).rejects.toThrow("FD cleanup not confirmed");
	await expect(
		service.ensureWriteDocumentSource("viewer", "tool", reference),
	).rejects.toMatchObject({ code: "TEXT_DOCUMENT_HISTORY_CLOSED" });
	expect(service.usage.sources).toBe(1);
	const files = (await readdir(directory)).filter((name) => name.startsWith("nf-tool-input-"));
	expect(files).toHaveLength(1);
	closeFailure?.mockRestore();
	await service.discard(files[0].slice("nf-tool-input-".length, -".utf16".length));
	expect(service.usage.sources).toBe(0);
	services.splice(services.indexOf(service), 1);
});

test("pending startup close and create/not-ready/crash failures hold their real owner and never replay", async () => {
	const { runtime, path } = await fixture();
	const originalLaunch = WorkerHandle.thread;
	const createFailure = spyOn(WorkerHandle, "thread").mockImplementation(() => {
		throw new Error("creation disabled");
	});
	spies.push(createFailure);
	await expect(
		runtime.stream(
			path,
			identity,
			async () => {
				throw new Error("main-thread fallback");
			},
			controller().signal,
			10_000,
		),
	).rejects.toThrow("creation disabled");
	createFailure.mockRestore();
	const state = new Int32Array(new SharedArrayBuffer(20));
	spies.push(
		spyOn(WorkerHandle, "thread").mockImplementation(() => {
			const handle = originalLaunch(
				new URL("./git-current-baseline-session.fixture.ts", import.meta.url),
				{ workerData: { mode: "not-ready", state: state.buffer } },
			);
			handles.push(handle);
			return handle;
		}),
	);
	const connect = compiled.connectCompiledWorker;
	const readiness = spyOn(compiled, "connectCompiledWorker").mockImplementation(
		(entries, options = {}) => connect(entries, { ...options, deadlineAt: Date.now() + 40 }),
	);
	spies.push(readiness);
	await expect(
		runtime.stream(path, identity, async () => {}, controller().signal, 10_000),
	).rejects.toThrow("ready");
	expect(readiness).toHaveBeenCalled();
	await handles[0].exited;
	readiness.mockRestore();
	const pending = runtime
		.stream(
			path,
			identity,
			async () => {
				throw new Error("no fallback");
			},
			controller().signal,
			10_000,
		)
		.catch((error) => error);
	await until(() => handles.length === 2 && Atomics.load(state, 0) === 1);
	await runtime.close();
	expect(await pending).toBeInstanceOf(Error);
	await handles[1].exited;
	expect(Atomics.load(state, 1)).toBe(0);
});

test("history queue holds one active plus fifteen waiters, removes queued cancellation and close drains domain cleanup", async () => {
	const { directory } = await fixture();
	const started = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	let streams = 0;
	const service = new ToolInputStreamSourceService({
		directory,
		loadHistoricalIdentity: async (_viewer, toolUseId, reference) => ({
			...identity,
			...reference,
			toolUseId,
		}),
		streamHistorical: async () => {
			streams++;
			started.resolve();
			await gate.promise;
		},
	});
	services.push(service);
	const read = (index: number, signal?: AbortSignal) =>
		service
			.ensureWriteDocumentSource(
				"viewer",
				"tool",
				{ ...reference, toolCallId: `row-${index}` },
				signal,
			)
			.catch((error) => error);
	const first = read(0);
	await started.promise;
	const waiting = Array.from({ length: 15 }, (_, index) => ({
		control: controller(),
		index: index + 1,
	}));
	const queued = waiting.map(({ index, control }) => read(index, control.signal));
	await Bun.sleep(0);
	expect((await read(16)).code).toBe("TEXT_DOCUMENT_HISTORY_QUEUE_LIMIT");
	waiting[0].control.abort(new Error("queued viewer left"));
	expect((await queued[0]).message).toBe("queued viewer left");
	const replacement = read(17);
	await Bun.sleep(0);
	expect(streams).toBe(1);
	let closed = false;
	const closing = service.closeHistoricalWorkers().then(() => {
		closed = true;
	});
	await Bun.sleep(0);
	expect(closed).toBe(false);
	gate.resolve();
	await closing;
	await Promise.all([first, ...queued, replacement]);
	expect(streams).toBe(1);
	expect(service.usage.sources).toBe(0);
});

test("throwing scalar-only historical diagnostic sink cannot replace publication or cleanup", async () => {
	const { directory } = await fixture();
	let now = Date.now();
	spies.push(spyOn(Date, "now").mockImplementation(() => now));
	const metadata: object[] = [];
	const service = new ToolInputStreamSourceService({
		directory,
		loadHistoricalIdentity: async () => identity,
		streamHistorical: async (_identity, sink) => {
			await sink("raw", 0);
			now += 2000;
		},
		slowLog: (value) => {
			metadata.push(value);
			throw new Error("log sink failed");
		},
	});
	services.push(service);
	const ref = await service.ensureWriteDocumentSource("viewer", "tool", reference);
	expect(ref.complete).toBe(true);
	expect(metadata).toHaveLength(1);
	expect(Object.keys(metadata[0]).sort()).toEqual(["elapsedMs", "length"]);
	await service.discard(ref.id);
});

test.each([
	["crash", "TEXT_DOCUMENT_WORKER_FAILED"],
	["invalid", "TEXT_DOCUMENT_WORKER_PROTOCOL"],
])("running worker %s does not become empty success or replay its historical read", async (mode, code) => {
	const { path, runtime } = await fixture();
	const state = new Int32Array(new SharedArrayBuffer(20));
	const launch = WorkerHandle.thread;
	spies.push(
		spyOn(WorkerHandle, "thread").mockImplementation(() => {
			const handle = launch(new URL("./git-current-baseline-session.fixture.ts", import.meta.url), {
				workerData: { mode, state: state.buffer },
			});
			handles.push(handle);
			return handle;
		}),
	);
	let sinkCalls = 0;
	await expect(
		runtime.stream(
			path,
			identity,
			async () => {
				sinkCalls++;
			},
			controller().signal,
			10_000,
		),
	).rejects.toMatchObject({ code });
	await handles[0].exited;
	expect(handles).toHaveLength(1);
	expect(Atomics.load(state, 1)).toBe(1);
	expect(sinkCalls).toBe(0);
});

test("HMR retains the real owner and old untracked shape fails closed without losing its aliases", async () => {
	const first = await import("./tool-input-stream-source");
	const next = await import(`./tool-input-stream-source.ts?generation=${Date.now()}`);
	expect(next.toolInputStreamSource).toBe(first.toolInputStreamSource);
	await first.closeToolInputHistoricalWorkers();
	await expect(
		next.toolInputStreamSource.ensureWriteDocumentSource("viewer", "tool", reference),
	).rejects.toMatchObject({ code: "TEXT_DOCUMENT_HISTORY_CLOSED" });
	await expect(
		next.streamHistoricalWriteContent("/unused", identity, async () => {}, controller().signal),
	).rejects.toMatchObject({ code: "TEXT_DOCUMENT_HISTORY_CLOSED" });
	const globals = globalThis as unknown as Record<symbol, unknown>;
	const key = Symbol.for("toolInputStreamSource");
	const saved = globals[key];
	const old = { aliases: new Map([["durable", "still-present"]]) };
	globals[key] = old;
	try {
		await expect(import(`./tool-input-stream-source.ts?legacy=${Date.now()}`)).rejects.toThrow(
			"manually restart",
		);
		expect(globals[key]).toBe(old);
		expect(old.aliases.get("durable")).toBe("still-present");
	} finally {
		globals[key] = saved;
	}
});
