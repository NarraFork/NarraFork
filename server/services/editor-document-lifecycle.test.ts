import { afterEach, expect, spyOn, test } from "bun:test";
import { fstatSync } from "node:fs";
import { type FileHandle, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Worker } from "node:worker_threads";
import { logger } from "../lib/logger";
import { WorkerHandle } from "../lib/worker-runtime/lifecycle";
import { EditorDocumentJobs } from "./editor-document-jobs";
import {
	closeEditorDocumentService,
	getEditorDocumentService,
	resetEditorDocumentServiceForTests,
} from "./editor-document-runtime";
import { type EditorActor, EditorDocumentService } from "./editor-document-service";
import { EditorDocumentStreams, EditorSourceWorkers } from "./editor-document-streams";

const clean: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of clean.splice(0).reverse()) await close();
});
function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "editor-lifecycle-"));
	clean.push(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "source.txt");
	await writeFile(path, "hello\n");
	return { root, path };
}
async function within<T>(promise: Promise<T>, ms = 3000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Lifecycle did not settle")), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
function workerAt(workers: EditorSourceWorkers, index = 0) {
	return (Reflect.get(workers, "slots") as { worker: Worker }[])[index].worker;
}

test("jobs close rejects waiting/new IO and transfers but joins business permits and body credit", async () => {
	const jobs = new EditorDocumentJobs();
	const gate = deferred();
	const started = deferred();
	const running = jobs.withIo("u", async () => {
		started.resolve();
		await gate.promise;
	});
	await started.promise;
	const queued = jobs
		.withIo("u", async () => {
			throw new Error("Queued IO must not execute");
		})
		.catch((error) => error);
	const transfer = await jobs.acquireTransfer(64 * 1024 * 1024);
	let closed = false;
	const closing = jobs.close().then(() => {
		closed = true;
	});
	expect(jobs.close()).toBe(jobs.close());
	expect((await queued).code).toBe("EDITOR_CLOSED");
	await expect(jobs.withIo("new", async () => {})).rejects.toMatchObject({ code: "EDITOR_CLOSED" });
	await expect(jobs.acquireTransfer(1)).rejects.toMatchObject({ code: "EDITOR_CLOSED" });
	expect(transfer.signal.aborted).toBe(true);
	await pause();
	expect(closed).toBe(false);
	expect(jobs.diagnostics.io.active).toBe(1);
	expect(jobs.diagnostics.transfer.activeBytes).toBe(64 * 1024 * 1024);
	gate.resolve();
	await running;
	expect(closed).toBe(false);
	transfer.release();
	await within(closing);
	expect(jobs.diagnostics.io.active).toBe(0);
	expect(jobs.diagnostics.transfer.active).toBe(0);
});

test("transfer cancellation keeps the editor timeout code while retaining its original queue lease", async () => {
	const jobs = new EditorDocumentJobs();
	const controller = new AbortController();
	const permit = await jobs.acquireTransfer(1024, controller.signal);
	controller.abort(new Error("not a public editor error"));
	expect(permit.signal.reason).toMatchObject({ code: "EDITOR_TIMEOUT", statusCode: 408 });
	expect(jobs.diagnostics.transfer.active).toBe(1);
	expect(jobs.diagnostics.transfer.activeBytes).toBe(1024);
	permit.release();
	await jobs.close();
});

test("nested IO retains one business permit while real worker uses a one-shot physical pool", async () => {
	const { path } = await fixture();
	const jobs = new EditorDocumentJobs();
	clean.push(() => jobs.close());
	await jobs.withIo("u", async () => {
		expect(jobs.diagnostics.io.active).toBe(1);
		const result = await jobs.run("u", { action: "seal", path });
		expect(result.kind).toBe("sealed");
		expect(jobs.diagnostics.io.active).toBe(1);
		expect(jobs.diagnostics.workers.created).toBe(1);
		expect(jobs.diagnostics.workers.workers).toBe(0);
	});
	expect(jobs.diagnostics.io.active).toBe(0);
});

for (const mode of ["missing", "not-ready", "crash", "cancel", "close"] as const)
	test(`real one-shot worker ${mode} never computes inline or replays a dispatched request`, async () => {
		const { root } = await fixture();
		const entry = join(root, `${mode}.ts`);
		const marker = join(root, "executions");
		if (mode !== "missing")
			await writeFile(
				entry,
				`import { parentPort } from "node:worker_threads";
import { appendFileSync } from "node:fs";
${mode === "not-ready" ? "setInterval(() => {}, 1000);" : `parentPort.on("message", request => { appendFileSync(request.path, "x"); ${mode === "crash" ? 'throw new Error("fixture crash");' : "parentPort.postMessage({ started: true });"} }); parentPort.postMessage({type:"editor-worker-ready",version:1});`}`,
			);
		const started = deferred<WorkerHandle<Worker>>();
		const thread = WorkerHandle.thread;
		const launched = spyOn(WorkerHandle, "thread").mockImplementation((...args) => {
			const handle = thread(...args);
			if (mode === "cancel" || mode === "close")
				handle.resource.on("message", (message) => {
					if (message.started) started.resolve(handle);
				});
			else started.resolve(handle);
			return handle;
		});
		const jobs = new EditorDocumentJobs([pathToFileURL(entry).href], {
			readyMs: mode === "not-ready" ? 50 : 5000,
		});
		const controller = new AbortController();
		const result = jobs
			.run("u", { action: "seal", path: marker }, controller.signal)
			.catch((e) => e);
		try {
			const handle = await within(started.promise);
			if (mode === "cancel") controller.abort(new Error("fixture cancellation"));
			if (mode === "close") await within(jobs.close());
			const failure = await within(result);
			expect(failure).toBeInstanceOf(Error);
			if (mode === "cancel") expect(failure.code).toBe("EDITOR_TIMEOUT");
			if (mode === "close") expect(failure.code).toBe("EDITOR_CLOSED");
			await within(handle.exited);
			expect(launched).toHaveBeenCalledTimes(1);
			if (mode === "missing" || mode === "not-ready")
				await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
			else expect(await readFile(marker, "utf8")).toBe("x");
			expect(jobs.diagnostics.workers.workers).toBe(0);
			expect(jobs.diagnostics.io.active).toBe(0);
		} finally {
			controller.abort();
			await jobs.close();
			launched.mockRestore();
		}
	});

test("jobs startup close joins its real pending creation and never admits a replacement", async () => {
	const { root } = await fixture();
	const entry = join(root, "not-ready.ts");
	await writeFile(entry, "setInterval(() => {}, 1000)");
	const started = deferred<WorkerHandle<Worker>>();
	const thread = WorkerHandle.thread;
	const launched = spyOn(WorkerHandle, "thread").mockImplementation((...args) => {
		const handle = thread(...args);
		started.resolve(handle);
		return handle;
	});
	const jobs = new EditorDocumentJobs([pathToFileURL(entry).href]);
	const result = jobs.run("u", { action: "seal", path: "never-dispatched" }).catch((e) => e);
	try {
		const handle = await within(started.promise);
		await within(jobs.close());
		await within(handle.exited);
		expect(await result).toBeInstanceOf(Error);
		expect(launched).toHaveBeenCalledTimes(1);
		expect(jobs.diagnostics.workers.starting).toBe(0);
		expect(jobs.diagnostics.workers.workers).toBe(0);
	} finally {
		await jobs.close();
		launched.mockRestore();
	}
});

test("raw-seal cancellation with failed termination retains its borrowed FD and permit until real exit", async () => {
	const { root, path } = await fixture();
	const entry = join(root, "borrow-fd.ts");
	await writeFile(
		entry,
		`import { parentPort } from "node:worker_threads";
parentPort.on("message", request => parentPort.postMessage({fd:request.fd}));
parentPort.postMessage({type:"editor-worker-ready",version:1});`,
	);
	const started = deferred<{ handle: WorkerHandle<Worker>; fd: number }>();
	const thread = WorkerHandle.thread;
	const launched = spyOn(WorkerHandle, "thread").mockImplementation((...args) => {
		const handle = thread(...args);
		handle.resource.on("message", (message) => {
			if (typeof message.fd === "number") started.resolve({ handle, fd: message.fd });
		});
		return handle;
	});
	const jobs = new EditorDocumentJobs([pathToFileURL(entry).href]);
	const controller = new AbortController();
	const result = jobs
		.run(
			"u",
			{
				action: "raw-seal",
				path,
				encoding: "utf-8",
				bom: "none",
				expected: {
					protocol: "raw-v2",
					hashKind: "raw-sha256",
					bytes: 6,
					rawDigest: "",
					textDigest: "",
					formatDigest: "",
					textLength: 6,
					newlines: 1,
				},
			},
			controller.signal,
		)
		.catch((error) => error);
	const { handle, fd } = await within(started.promise);
	const terminate = handle.resource.terminate.bind(handle.resource);
	const stopping = deferred();
	const failedStop = spyOn(handle.resource, "terminate").mockImplementation(() => {
		stopping.resolve();
		return Promise.reject(new Error("fixture terminate failed"));
	});
	let settled = false;
	void result.then(() => {
		settled = true;
	});
	try {
		controller.abort(new Error("fixture cancel"));
		await stopping.promise;
		await pause();
		expect(settled).toBe(false);
		expect(fstatSync(fd).isFile()).toBe(true);
		expect(jobs.diagnostics.io.active).toBe(1);
		expect(jobs.diagnostics.workers.workers).toBe(1);
		expect(launched).toHaveBeenCalledTimes(1);
		failedStop.mockRestore();
		await terminate();
		expect(await within(result)).toBeInstanceOf(Error);
		expect(() => fstatSync(fd)).toThrow();
		expect(jobs.diagnostics.io.active).toBe(0);
	} finally {
		failedStop.mockRestore();
		await terminate();
		await result;
		await jobs.close().catch(() => {});
		launched.mockRestore();
	}
});

for (const mode of ["delayed-ack", "lost-ack"] as const)
	test(`EOF and ${mode} keep the parent FD/credit until ACK or observed old-slot exit`, async () => {
		const { path } = await fixture();
		const workers = new EditorSourceWorkers(undefined, { readyMs: 5000, ackMs: 80 });
		const streams = new EditorDocumentStreams(workers);
		clean.push(() => streams.dispose());
		const source = await streams.open("u", "doc", path);
		const file = (
			Reflect.get(streams, "reads") as Map<string, { file: import("node:fs/promises").FileHandle }>
		).get(source.readId)?.file;
		if (!file) throw new Error("Parent FD missing");
		const chunk = await streams.chunk("doc", source.readId, 0, 64);
		expect(chunk.eof).toBe(true);
		expect((await file.stat()).isFile()).toBe(true);
		expect(streams.diagnostics.windowBytes).toBe(256 * 1024);
		const worker = workerAt(workers);
		const send = worker.postMessage.bind(worker);
		const posted = deferred();
		let closeMessage: unknown;
		const post = spyOn(worker, "postMessage").mockImplementation((message, transfer) => {
			if (message.request.action === "close") {
				closeMessage = message;
				posted.resolve();
			} else send(message, transfer);
		});
		const terminate = worker.terminate.bind(worker);
		const stopping = deferred();
		const holdExit = spyOn(worker, "terminate").mockImplementation(() => {
			stopping.resolve();
			return new Promise(() => {});
		});
		let closed = false;
		const closing = streams.close("doc", source.readId).then(() => {
			closed = true;
		});
		try {
			await posted.promise;
			if (mode === "lost-ack") await within(stopping.promise);
			else await pause();
			expect(closed).toBe(false);
			expect((await file.stat()).isFile()).toBe(true);
			expect(streams.diagnostics.active).toBe(1);
			expect(workers.count).toBe(1);
			// Reassigning this physical slot before exit must never create a third worker.
			if (mode === "lost-ack") {
				const same = workers.assign();
				await expect(
					workers.run(same, { action: "diagnostics", stream: "" }),
				).resolves.toHaveProperty("counters");
				await expect(workers.run(0, { action: "diagnostics", stream: "" })).rejects.toThrow(
					"TIMEOUT",
				);
				expect(workerAt(workers)).toBe(worker);
				holdExit.mockRestore();
				await terminate();
			} else send(closeMessage);
			await within(closing);
			expect(file.fd).toBe(-1);
			expect(streams.diagnostics.active).toBe(0);
		} finally {
			holdExit.mockRestore();
			post.mockRestore();
			await terminate();
			await closing;
		}
	});

test("failed parent FD cleanup remains charged and makes production drain fail", async () => {
	const { path } = await fixture();
	const streams = new EditorDocumentStreams();
	const source = await streams.open("u", "doc", path);
	const file = (Reflect.get(streams, "reads") as Map<string, { file: FileHandle }>).get(
		source.readId,
	)?.file;
	if (!file) throw new Error("Parent FD missing");
	const close = file.close.bind(file);
	const failure = spyOn(file, "close").mockRejectedValue(new Error("fixture parent close failure"));
	try {
		const closingError = await within(streams.close("doc", source.readId).catch((error) => error));
		expect(String(closingError)).toContain("parent close failure");
		expect((await file.stat()).isFile()).toBe(true);
		expect(streams.diagnostics.active).toBe(1);
		expect(streams.diagnostics.streams).toBe(1);
		const drainError = await within(streams.dispose().catch((error) => error));
		expect(String(drainError)).toContain("parent close failure");
		expect(streams.workers.count).toBe(0);
		expect(streams.diagnostics.active).toBe(1);
	} finally {
		failure.mockRestore();
		await close();
		await streams.dispose().catch(() => {});
	}
});

test("standalone affinity owner close cancels pending startup and remains disabled", async () => {
	const { root } = await fixture();
	const entry = join(root, "stream-not-ready.ts");
	await writeFile(entry, "setInterval(() => {}, 1000)");
	const workers = new EditorSourceWorkers([pathToFileURL(entry).href]);
	const slot = workers.assign();
	const result = workers.run(slot, { action: "diagnostics", stream: "" }).catch((e) => e);
	await within(workers.dispose());
	expect(await result).toBeInstanceOf(Error);
	expect(workers.count).toBe(0);
	expect(() => workers.assign()).toThrow("CLOSED");
	await workers.dispose();
});

test("stream dispose closes pending admission/open and refuses new reads", async () => {
	const { path } = await fixture();
	const streams = new EditorDocumentStreams();
	const opening = streams.open("u", "doc", path).catch((e) => e);
	await within(streams.dispose());
	expect(await opening).toBeInstanceOf(Error);
	await expect(streams.open("u", "new", path)).rejects.toThrow("CLOSED");
	expect(streams.diagnostics.active).toBe(0);
	expect(streams.workers.count).toBe(0);
	await streams.dispose();
});

test("service dispose joins a pending authorized create and prevents late session installation", async () => {
	const { root, path } = await fixture();
	const entered = deferred();
	const gate = deferred();
	const service = new EditorDocumentService({
		root: join(root, "transfers"),
		execute: async () => {
			throw new Error("No writes");
		},
	});
	const actor: EditorActor = {
		userId: "u",
		narratorId: "n",
		authorize: async () => {
			entered.resolve();
			await gate.promise;
			return {
				cwd: root,
				projectId: null,
				lexicalPath: path,
				canonicalPath: path,
				outsideRoots: false,
			};
		},
	};
	const input = { path, origin: "legacy" as const };
	const creating = service.create(actor, input).catch((e) => e);
	await within(entered.promise);
	let closed = false;
	const closing = service.dispose().then(() => {
		closed = true;
	});
	await pause();
	expect(closed).toBe(false);
	await expect(service.create(actor, input)).rejects.toMatchObject({ code: "EDITOR_CLOSED" });
	gate.resolve();
	expect(await within(creating)).toMatchObject({ code: "EDITOR_CLOSED" });
	await within(closing);
	expect((Reflect.get(service, "sessions") as Map<string, unknown>).size).toBe(0);
	expect(service.dispose()).toBe(service.dispose());
});

test("production close without a lazy owner sets an HMR-stable admission latch; reset is idempotent", async () => {
	await resetEditorDocumentServiceForTests();
	await closeEditorDocumentService();
	expect(Reflect.get(globalThis, Symbol.for("narrafork.editor-documents.v1"))).toBeUndefined();
	expect(() => getEditorDocumentService()).toThrow("closed");
	const reloaded = await import(`./editor-document-runtime.ts?editor-lifecycle=${Date.now()}`);
	expect(() => reloaded.getEditorDocumentService()).toThrow("closed");
	await reloaded.resetEditorDocumentServiceForTests();
	await resetEditorDocumentServiceForTests();
	const owner = getEditorDocumentService();
	expect(getEditorDocumentService()).toBe(owner);
	const disposed = spyOn(owner, "dispose");
	await closeEditorDocumentService();
	expect(disposed).toHaveBeenCalledTimes(1);
	await resetEditorDocumentServiceForTests();
	disposed.mockRestore();
});

test("legacy HMR owner without a real handle lifecycle fails closed and remains pinned", async () => {
	await resetEditorDocumentServiceForTests();
	const key = Symbol.for("narrafork.editor-documents.v1");
	const oldOwner = { sessions: new Map(), dispose: async () => {} };
	Reflect.set(globalThis, key, oldOwner);
	try {
		expect(() => getEditorDocumentService()).toThrow("restart");
		await expect(closeEditorDocumentService()).rejects.toMatchObject({
			code: "EDITOR_RESTART_REQUIRED",
		});
		await expect(resetEditorDocumentServiceForTests()).rejects.toMatchObject({
			code: "EDITOR_RESTART_REQUIRED",
		});
		expect(Reflect.get(globalThis, key)).toBe(oldOwner);
	} finally {
		// This fixture owns no resources; production must never perform this deletion.
		Reflect.deleteProperty(globalThis, key);
		await resetEditorDocumentServiceForTests();
	}
});

test("throwing worker timing sink cannot replace a result or skip its real exit", async () => {
	const { path } = await fixture();
	const jobs = new EditorDocumentJobs();
	const now = performance.now.bind(performance);
	let calls = 0;
	const clock = spyOn(performance, "now").mockImplementation(() => now() + calls++ * 1000);
	const sink = spyOn(logger, "warn").mockImplementation(() => {
		throw new Error("diagnostic sink failed");
	});
	try {
		expect((await jobs.run("u", { action: "seal", path })).kind).toBe("sealed");
		expect(sink).toHaveBeenCalled();
		expect(jobs.diagnostics.workers.workers).toBe(0);
		expect(jobs.diagnostics.io.active).toBe(0);
	} finally {
		sink.mockRestore();
		clock.mockRestore();
		await jobs.close();
	}
});
