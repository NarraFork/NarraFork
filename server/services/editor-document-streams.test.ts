import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
	type FileHandle,
	mkdtemp,
	open,
	readdir,
	readlink,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Worker } from "node:worker_threads";
import iconv from "iconv-lite";
import { EDITOR_FILE_MAX_BYTES, type EditorRawMetadata } from "../../shared/editor-document";
import { EditorDocumentJobs } from "./editor-document-jobs";
import { runStreamWorker } from "./editor-document-stream-worker";
import {
	EditorDocumentStreams,
	type EditorRemoteRawSource,
	EditorSourceWorkers,
} from "./editor-document-streams";

const clean: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of clean.splice(0).reverse()) await close();
});
async function fixture(
	bytes: Uint8Array = new TextEncoder().encode("hello\r\nworld\n"),
	budget?: { deadlineMs: number; idleMs: number },
) {
	const root = await mkdtemp(join(tmpdir(), "editor-raw-"));
	clean.push(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "source.txt");
	await writeFile(path, bytes);
	const streams = new EditorDocumentStreams(undefined, budget);
	clean.push(() => streams.dispose());
	return { path, streams, root };
}
async function sourceFds(path: string) {
	if (process.platform !== "linux")
		throw new Error("FD acceptance requires /proc on this test host");
	let count = 0;
	for (const name of await readdir("/proc/self/fd"))
		if ((await readlink(`/proc/self/fd/${name}`).catch(() => "")) === path) count++;
	return count;
}
async function expectRejected(promise: Promise<unknown>, message?: string) {
	// Await the native Worker port normally before running Bun's error matcher.
	let failure: unknown;
	try {
		await promise;
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(Error);
	if (message) expect(String(failure)).toContain(message);
}
async function within<T>(promise: Promise<T>, ms = 500): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Worker lifecycle did not settle")), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
const poolWorker = (workers: EditorSourceWorkers, index: number) =>
	(Reflect.get(workers, "slots") as { worker: Worker }[])[index].worker;
function ownedFile(streams: EditorDocumentStreams, readId: string) {
	const file = (Reflect.get(streams, "reads") as Map<string, { file: FileHandle }>).get(
		readId,
	)?.file;
	if (!file) throw new Error("Fixture source must own an open FileHandle");
	return file;
}

async function remoteBodyFixture(size = 64 * 1024 + 3) {
	const bytes = new Uint8Array(size).fill(65);
	const { streams } = await fixture(new Uint8Array());
	// This fixture tests body publication, not local preflight throughput. ASCII A
	// has identical raw/normalized UTF8 digests and one exact, newline-free line.
	// Native Chrome still performs the real 20MiB metadata/body pipeline; the
	// separate remote-preflight test below exercises the real worker codec too.
	const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
	const metadata: EditorRawMetadata = {
		protocol: "raw-v2",
		hashKind: "raw-sha256",
		formatVersion: 1,
		baseHash: digest,
		textDigest: digest,
		encoding: "utf-8",
		bom: "none",
		sourceBytes: size,
		utf8Bytes: size,
		textLength: size,
		lineCount: 1,
		maxLineLength: size,
		eolCounts: { LF: 0, CRLF: 0, CR: 0 },
		preferredEol: "LF",
		eol: "LF",
	};
	const controller = new AbortController();
	const requests: { offset: number; maxBytes: number }[] = [];
	const closes: boolean[] = [];
	const behavior = {
		peerCredit: 16 * 1024,
		onChunk: async (_index: number) => {},
		changedAt: 0,
		offsetAt: 0,
		oversizedAt: 0,
	};
	const remote: EditorRemoteRawSource = {
		open: async () => ({
			readId: "remote-body",
			sourceGeneration: "generation",
			totalBytes: bytes.length,
			rawDigest: metadata.baseHash,
			identity: {
				deviceId: "peer",
				pathFlavor: "posix",
				canonicalPath: "/peer/file",
				workspaceIdentity: "root",
				runtimeEpoch: "epoch",
				runtimeGeneration: 1,
				fencingToken: 1,
			},
		}),
		chunk: async (input, signal) => {
			requests.push({ offset: input.offset, maxBytes: input.maxBytes });
			expect(input.maxBytes).toBeLessThanOrEqual(16 * 1024);
			await behavior.onChunk(requests.length);
			signal.throwIfAborted();
			const body = bytes.subarray(
				input.offset,
				input.offset +
					Math.min(input.maxBytes, behavior.peerCredit) +
					(behavior.oversizedAt === requests.length ? 1 : 0),
			);
			return {
				readId: input.readId,
				sourceGeneration: behavior.changedAt === requests.length ? "changed" : "generation",
				offset: input.offset + (behavior.offsetAt === requests.length ? 1 : 0),
				bytes: body.length,
				dataB64: Buffer.from(body).toString("base64"),
				eof: input.offset + body.length === bytes.length,
			};
		},
		close: async (input) => {
			closes.push(input.abort);
		},
	};
	const opened = await streams.open(
		"u",
		"remote-doc",
		remote,
		undefined,
		metadata,
		controller.signal,
	);
	return { streams, opened, metadata, bytes, controller, requests, closes, behavior, remote };
}

test("remote body publishes at most two unchanged 16KiB peer frames within one 32KiB HTTP credit", async () => {
	const f = await remoteBodyFixture();
	const result = await f.streams.chunk("remote-doc", f.opened.readId, 0, 64 * 1024);
	expect(result.bytes?.length).toBe(32 * 1024);
	expect(result.bytes).toEqual(f.bytes.subarray(0, 32 * 1024));
	expect(result.eof).toBe(false);
	expect(f.requests).toEqual([
		{ offset: 0, maxBytes: 16 * 1024 },
		{ offset: 16 * 1024, maxBytes: 16 * 1024 },
	]);
	expect(f.streams.diagnostics.windowBytes).toBe(256 * 1024);
	// Conforming RPC envelope <=8KiB beyond base64. Conservatively count its wire,
	// complete UTF16 JSON and parsed UTF16 base64, both decode copies, the 32KiB
	// assembly and a separate 32KiB HTTP body. Preflight's worker path is unchanged.
	const frame = Math.ceil(Math.max(...f.requests.map((r) => r.maxBytes)) / 3) * 4 + 8192;
	const liveHostCopyBound = frame * 5 + 2 * 16 * 1024 + 2 * (result.bytes?.length ?? 0);
	expect(liveHostCopyBound).toBeLessThan(256 * 1024);
});

test.each([
	1, 16383, 16384, 16385, 32768, 65536,
])("remote body respects client credit %i without prefetch or a larger RPC", async (credit) => {
	const f = await remoteBodyFixture();
	const result = await f.streams.chunk("remote-doc", f.opened.readId, 0, credit);
	expect(result.bytes?.length).toBe(Math.min(credit, 32 * 1024));
	expect(f.requests.length).toBe(credit > 16384 ? 2 : 1);
	expect(f.requests.reduce((n, r) => n + r.maxBytes, 0)).toBe(Math.min(credit, 32 * 1024));
});

test.each([
	0, 1, 16384, 16385, 32768, 32769,
])("remote body validates and publishes the exact EOF tail at %i bytes", async (size) => {
	const f = await remoteBodyFixture(size);
	let offset = 0;
	const digest = new Bun.CryptoHasher("sha256");
	for (;;) {
		const result = await f.streams.chunk("remote-doc", f.opened.readId, offset, 65536);
		digest.update(result.bytes ?? new Uint8Array());
		offset += result.bytes?.length ?? 0;
		if (result.eof) break;
	}
	expect(offset).toBe(size);
	expect(digest.digest("hex")).toBe(f.metadata.baseHash);
	expect(f.requests.length).toBe(Math.max(1, Math.ceil(size / 16384)));
	await f.streams.close("remote-doc", f.opened.readId);
	expect(f.closes).toEqual([false]);
	expect(f.streams.diagnostics.windowBytes).toBe(0);
});

test.each([
	"throw",
	"cancel",
	"generation",
	"offset",
	"oversized",
] as const)("second remote frame %s never publishes its first frame or leaves a reusable stream", async (failure) => {
	const f = await remoteBodyFixture();
	f.behavior.onChunk = async (index) => {
		if (index !== 2) return;
		if (failure === "throw") throw new Error("second-frame-failed");
		if (failure === "cancel") f.controller.abort();
	};
	if (failure === "generation") f.behavior.changedAt = 2;
	if (failure === "offset") f.behavior.offsetAt = 2;
	if (failure === "oversized") f.behavior.oversizedAt = 2;
	await expectRejected(f.streams.chunk("remote-doc", f.opened.readId, 0, 65536));
	expect(f.requests.length).toBe(2);
	expect(f.closes).toEqual([true]);
	expect(f.streams.diagnostics.windowBytes).toBe(0);
	expect(f.streams.diagnostics.active).toBe(0);
	await expectRejected(
		f.streams.chunk("remote-doc", f.opened.readId, 0, 65536),
		"EDITOR_STREAM_CLOSED",
	);
});

test("one body publication holds busy across both frames and rejects a concurrent consumer", async () => {
	const f = await remoteBodyFixture();
	let entered!: () => void, resume!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		resume = resolve;
	});
	f.behavior.onChunk = async (index) => {
		if (index === 1) {
			entered();
			await gate;
		}
	};
	const pending = f.streams.chunk("remote-doc", f.opened.readId, 0, 65536);
	await started;
	try {
		await expectRejected(
			f.streams.chunk("remote-doc", f.opened.readId, 0, 65536),
			"EDITOR_STREAM_INVALID",
		);
		expect(f.requests.length).toBe(1);
	} finally {
		resume();
	}
	expect((await pending).bytes?.length).toBe(32768);
	expect(f.requests.length).toBe(2);
});

test("a low-credit peer remains sequential, never requires a larger JSON RPC and never prefetches a third frame", async () => {
	const f = await remoteBodyFixture();
	f.behavior.peerCredit = 4096;
	const result = await f.streams.chunk("remote-doc", f.opened.readId, 0, 65536);
	expect(result.bytes).toEqual(f.bytes.subarray(0, 8192));
	expect(f.requests.length).toBe(2);
	expect(f.requests[1]?.offset).toBe(4096);
	// The shipped WS gate is ceil(maxRpcBytes * 1.4) + 4096. Neither the
	// 16KiB peer nor a 4KiB short-frame peer must accept a 32KiB JSON frame.
	for (const rawBytes of [4096, 16384]) {
		const frame = {
			type: "rpc_result",
			id: "x".repeat(128),
			result: {
				readId: "x".repeat(128),
				sourceGeneration: "x".repeat(128),
				offset: EDITOR_FILE_MAX_BYTES,
				bytes: rawBytes,
				dataB64: Buffer.alloc(rawBytes, 255).toString("base64"),
				eof: false,
			},
		};
		expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(
			Math.ceil(rawBytes * 1.4) + 4096,
		);
	}
});

test("20MiB remote body hashes exactly with 640 bounded publications and the original 1280 peer frames", async () => {
	const f = await remoteBodyFixture(EDITOR_FILE_MAX_BYTES);
	let offset = 0,
		publications = 0;
	const digest = new Bun.CryptoHasher("sha256");
	for (;;) {
		const result = await f.streams.chunk("remote-doc", f.opened.readId, offset, 65536);
		expect(result.bytes?.length).toBeLessThanOrEqual(32768);
		digest.update(result.bytes ?? new Uint8Array());
		offset += result.bytes?.length ?? 0;
		publications++;
		if (result.eof) break;
	}
	expect(offset).toBe(EDITOR_FILE_MAX_BYTES);
	expect(digest.digest("hex")).toBe(f.metadata.baseHash);
	expect(publications).toBe(640);
	expect(f.requests.length).toBe(1280);
	await f.streams.close("remote-doc", f.opened.readId);
	expect(f.streams.diagnostics.windowBytes).toBe(0);
});

test("remote metadata preflight keeps one 16KiB peer/worker frame and releases its original window", async () => {
	const f = await remoteBodyFixture();
	await f.streams.close("remote-doc", f.opened.readId);
	f.requests.length = 0;
	f.closes.length = 0;
	const metadata = await f.streams.metadata("u", f.remote);
	expect(metadata.baseHash).toBe(f.metadata.baseHash);
	expect(metadata.sourceBytes).toBe(f.bytes.length);
	expect(f.requests.length).toBe(5);
	expect(Math.max(...f.requests.map((r) => r.maxBytes))).toBe(16384);
	expect(f.closes).toEqual([false]);
	expect(f.streams.diagnostics.windowBytes).toBe(0);
	expect(f.streams.workers.count).toBeLessThanOrEqual(2);
});

test("ready worker exit releases local and remote read owners, rejects old handles and admits new streams", async () => {
	const { path, streams } = await fixture();
	const local = await streams.open("u", "local", path);
	const unaffected = await streams.open("other", "unaffected", path);
	let remoteCloses = 0;
	const remote: EditorRemoteRawSource = {
		open: async () => ({
			readId: "remote-handle",
			sourceGeneration: "g",
			totalBytes: local.metadata.sourceBytes,
			rawDigest: local.metadata.baseHash,
			identity: {
				deviceId: "peer",
				pathFlavor: "posix",
				canonicalPath: "/peer/file",
				workspaceIdentity: "root",
				runtimeEpoch: "epoch",
				runtimeGeneration: 1,
				fencingToken: 1,
			},
		}),
		chunk: async () => {
			throw new Error("Closed remote handle must never read");
		},
		close: async () => {
			remoteCloses++;
		},
	};
	const peer = await streams.open("u", "remote", remote, undefined, local.metadata);
	expect(await sourceFds(path)).toBe(2);
	const dead = poolWorker(streams.workers, 0);
	let completed = false;
	try {
		await dead.terminate();
		const until = Date.now() + 500;
		while (streams.diagnostics.active !== 1 && Date.now() < until)
			await new Promise((resolve) => setTimeout(resolve, 5));
		expect(streams.diagnostics.active).toBe(1);
		expect(remoteCloses).toBe(1);
		expect(await sourceFds(path)).toBe(1);
		await expectRejected(
			within(streams.chunk("local", local.readId, 0, 64)),
			"EDITOR_STREAM_CLOSED",
		);
		await within(streams.close("local", local.readId));
		await within(streams.close("remote", peer.readId));
		await within(streams.workers.run(0, { action: "diagnostics", stream: "" }), 6000);
		expect(poolWorker(streams.workers, 0)).not.toBe(dead);
		const next = await within(streams.open("u", "next", path, undefined, local.metadata), 6000);
		await streams.close("next", next.readId);
		await streams.close("unaffected", unaffected.readId);
		await within(streams.dispose());
		expect(streams.diagnostics.windowBytes).toBe(0);
		expect(await sourceFds(path)).toBe(0);
		completed = true;
	} finally {
		// Failed/red implementations must not leave this fixture's dead-worker cleanup hanging.
		if (!completed) {
			const run = streams.workers.run.bind(streams.workers);
			const cleanup = spyOn(streams.workers, "run").mockImplementation((slot, request) =>
				request.action === "close" ? Promise.resolve({}) : run(slot, request),
			);
			try {
				await streams.dispose();
			} finally {
				cleanup.mockRestore();
			}
		}
	}
}, 10000);

test("ready worker error settles pending requests and old-slot close without waiting for a dead ACK", async () => {
	const { root } = await fixture();
	const file = join(root, "crash-worker.ts");
	await writeFile(
		file,
		`import { parentPort } from "node:worker_threads"; parentPort.on("message", ({ id, request }) => { if(request.action === "read") throw new Error("fixture worker crash"); parentPort.postMessage({id,result:{counters:{preflightBytes:0,bodyBytes:0,fds:0}}}); }); parentPort.postMessage({ready:true});`,
	);
	const pool = new EditorSourceWorkers([pathToFileURL(file).href]);
	try {
		const slot = pool.assign();
		await pool.run(slot, { action: "diagnostics", stream: "" });
		const worker = poolWorker(pool, 0);
		const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
		const failed = pool
			.run(slot, { action: "read", stream: "read", offset: 0, maxBytes: 1 })
			.catch((error) => error);
		expect(await within(failed)).toBeInstanceOf(Error);
		await within(exited);
		expect(pool.count).toBe(0);
		await within(pool.run(slot, { action: "close", stream: "read" }));
		await within(pool.run(0, { action: "diagnostics", stream: "" }), 6000);
		expect(poolWorker(pool, 0)).not.toBe(worker);
	} finally {
		await pool.dispose();
	}
}, 10000);

for (const operation of ["read", "fstat"] as const)
	test(`close ACK joins its own deferred real ${operation} callback before parent closes the FD`, async () => {
		const { path, streams } = await fixture();
		let closeAcks = 0;
		// Exercise the production worker handler in this realm so only our own FD's
		// real native callback can be delayed, without replacing the filesystem.
		const dispatch = spyOn(streams.workers, "run").mockImplementation(async (_slot, request) => {
			const result = await runStreamWorker(request);
			if (request.action === "close") closeAcks++;
			return result;
		});
		const source = await streams.open("u", "doc", path);
		const file = ownedFile(streams, source.readId);
		let entered!: () => void, releaseIO: (() => void) | undefined;
		const blocked = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const original = operation === "read" ? fs.read : fs.fstat;
		const native = spyOn(fs, operation).mockImplementation(((...args: unknown[]) => {
			if (args[0] !== file.fd || releaseIO) return Reflect.apply(original, fs, args);
			const callback = args[args.length - 1] as (...result: unknown[]) => void;
			return Reflect.apply(original, fs, [
				...args.slice(0, -1),
				(...result: unknown[]) => {
					releaseIO = () => callback(...result);
					entered();
				},
			]);
		}) as typeof original);
		const reading = streams.chunk("doc", source.readId, 0, 1).catch((error) => error);
		let closing: Promise<void> | undefined;
		try {
			await within(blocked);
			closing = streams.close("doc", source.readId);
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(closeAcks).toBe(0);
			expect((await file.stat()).isFile()).toBe(true);
			expect(streams.diagnostics.active).toBe(1);
			releaseIO?.();
			await within(closing);
			expect(await within(reading)).toBeInstanceOf(Error);
			expect(closeAcks).toBe(1);
			expect(file.fd).toBe(-1);
			expect(streams.diagnostics.active).toBe(0);
		} finally {
			releaseIO?.();
			native.mockRestore();
			await Promise.allSettled([reading, closing]);
			await streams.dispose();
			dispatch.mockRestore();
		}
	});

test("pending close rejected by worker error keeps its parent FD until that slot exits", async () => {
	const { path, streams } = await fixture();
	const source = await streams.open("u", "doc", path);
	const file = ownedFile(streams, source.readId);
	const worker = poolWorker(streams.workers, 0);
	const terminate = worker.terminate.bind(worker);
	let posted!: () => void;
	const pending = new Promise<void>((resolve) => {
		posted = resolve;
	});
	const send = worker.postMessage.bind(worker);
	const post = spyOn(worker, "postMessage").mockImplementation((message, transfer) => {
		if (message.request.action === "close") {
			posted();
			return;
		}
		send(message, transfer);
	});
	// Keep this real worker alive between its error notification and actual exit.
	const holdExit = spyOn(worker, "terminate").mockImplementation(() => new Promise(() => {}));
	let settled = false;
	const closing = streams.close("doc", source.readId).then(
		() => {
			settled = true;
		},
		(error) => {
			settled = true;
			throw error;
		},
	);
	const result = closing.catch((error) => error);
	try {
		await within(pending);
		worker.emit("error", new Error("fixture pending close error"));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(settled).toBe(false);
		expect((await file.stat()).isFile()).toBe(true);
		expect((await file.read(Buffer.alloc(1), 0, 1, 0)).bytesRead).toBe(1);
		expect(streams.diagnostics.active).toBe(1);
		holdExit.mockRestore();
		await terminate();
		expect(await within(result)).toBeUndefined();
		expect(file.fd).toBe(-1);
		expect(streams.diagnostics.active).toBe(0);
		await within(streams.workers.run(0, { action: "diagnostics", stream: "" }), 6000);
		expect(poolWorker(streams.workers, 0)).not.toBe(worker);
	} finally {
		holdExit.mockRestore();
		post.mockRestore();
		await terminate();
		await result;
		await streams.dispose();
	}
});

test("source workers preflight and streamed EOF have no idle FD/body", async () => {
	const { path, streams } = await fixture();
	const metadata = await streams.metadata("user", path);
	expect(metadata.eolCounts).toEqual({ LF: 1, CRLF: 1, CR: 0 });
	expect(streams.diagnostics.active).toBe(0);
	expect(await sourceFds(path)).toBe(0);
	const source = await streams.open("user", "doc", path, undefined, metadata);
	expect(await sourceFds(path)).toBe(1);
	let offset = 0;
	for (;;) {
		const chunk = await streams.chunk("doc", source.readId, offset, 3);
		offset += chunk.bytes?.length ?? 0;
		if (chunk.eof) break;
	}
	expect(offset).toBe(metadata.sourceBytes);
	expect(await sourceFds(path)).toBe(0);
	expect(streams.diagnostics.active).toBe(1);
	const eofCounters = await streams.workers.counters();
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(await streams.workers.counters()).toEqual(eofCounters);
	expect(streams.diagnostics.windowBytes).toBe(256 * 1024);
	await streams.close("doc", source.readId);
	expect(streams.diagnostics.active).toBe(0);
});
test("eight streams, per-user two, real consumer pause reads zero extra bytes", async () => {
	const { path, streams } = await fixture(new Uint8Array(1024 * 1024).fill(65));
	const sources = await Promise.all(
		Array.from({ length: 8 }, (_, i) => streams.open(`user${i % 4}`, `doc${i}`, path)),
	);
	expect(streams.diagnostics).toMatchObject({
		active: 8,
		streams: 8,
		windowBytes: 2 * 1024 * 1024,
	});
	const abort = new AbortController();
	const waiting = streams
		.open("user0", "ninth", path, undefined, undefined, abort.signal)
		.catch((error) => error);
	await new Promise((resolve) => setTimeout(resolve, 10));
	expect(streams.diagnostics.queued).toBe(1);
	const queuedControllers = Array.from({ length: 63 }, () => new AbortController());
	const queued = queuedControllers.map((controller, index) =>
		streams
			.open(`q${Math.floor(index / 8)}`, "queued", path, undefined, undefined, controller.signal)
			.catch((error) => error),
	);
	expect(streams.diagnostics.queued).toBe(64);
	await expectRejected(streams.open("overflow", "overflow", path), "EDITOR_BUSY");
	const first = await streams.chunk("doc0", sources[0].readId, 0, 65536);
	expect(first.bytes?.length).toBe(65536);
	const beforePause = await streams.workers.counters();
	// No next-offset credit means no read. A stale offset is rejected, not replayed.
	await new Promise((resolve) => setTimeout(resolve, 40));
	expect(await streams.workers.counters()).toEqual(beforePause);
	expect(beforePause.reduce((total, value) => total + (value?.bodyBytes ?? 0), 0)).toBe(65536);
	expect(streams.diagnostics.active).toBe(8);
	// The existing upload seal/commit IO worker remains available to this same user.
	const sealed = await new EditorDocumentJobs().run("user0", { action: "seal", path });
	expect(sealed.kind).toBe("sealed");
	expect(streams.diagnostics.active).toBe(8);
	abort.abort();
	queuedControllers.forEach((controller) => {
		controller.abort();
	});
	await Promise.all(queued);
	expect(await waiting).toBeInstanceOf(Error);
	await streams.closeOwner("doc0");
	expect(streams.diagnostics.active).toBe(7);
	await Promise.all(sources.map((source, i) => streams.close(`doc${i}`, source.readId)));
	expect(await sourceFds(path)).toBe(0);
});
test("per-user admission and waiting queue are bounded without blocking another user", async () => {
	const { path, streams } = await fixture();
	const active = await Promise.all([streams.open("u", "d1", path), streams.open("u", "d2", path)]);
	const controllers = Array.from({ length: 8 }, () => new AbortController());
	const waiting = controllers.map((controller) =>
		streams
			.open("u", "waiting", path, undefined, undefined, controller.signal)
			.catch((error) => error),
	);
	expect(streams.diagnostics.queued).toBe(8);
	await expectRejected(streams.open("u", "overflow", path), "EDITOR_BUSY");
	const other = await streams.open("other", "other", path);
	expect(streams.diagnostics.active).toBe(3);
	await streams.closeOwner("waiting");
	expect((await Promise.all(waiting)).every((error) => error instanceof Error)).toBe(true);
	expect(streams.diagnostics.queued).toBe(0);
	await streams.close("other", other.readId);
	await Promise.all(active.map((source, i) => streams.close(`d${i + 1}`, source.readId)));
	expect(streams.diagnostics.active).toBe(0);
	expect(streams.diagnostics.queued).toBe(0);
});
for (const timeout of ["idle", "deadline"] as const)
	test(`source ${timeout} closes actual FD and returns its permit`, async () => {
		const { path, streams } = await fixture(
			undefined,
			timeout === "idle" ? { deadlineMs: 2000, idleMs: 25 } : { deadlineMs: 25, idleMs: 2000 },
		);
		await streams.workers.counters();
		await streams.open("u", "d", path);
		const until = Date.now() + 1000;
		while (streams.diagnostics.active && Date.now() < until)
			await new Promise((resolve) => setTimeout(resolve, 5));
		expect(streams.diagnostics.active).toBe(0);
		expect(await sourceFds(path)).toBe(0);
	});
test("same-size overwrite/path replacement and mismatched preflight refuse publication", async () => {
	const { path, streams, root } = await fixture();
	const metadata = await streams.metadata("u", path);
	const source = await streams.open("u", "doc", path);
	await writeFile(path, "other\r\ntext!\n");
	await expectRejected(streams.chunk("doc", source.readId, 0, 65536), "EDITOR_SOURCE_CHANGED");
	expect(await sourceFds(path)).toBe(0);
	const stale = await streams.open("u", "doc", path, undefined, metadata);
	await expectRejected(streams.chunk("doc", stale.readId, 0, 65536), "EDITOR_SOURCE_CHANGED");
	const next = await streams.open("u", "doc", path);
	const replacement = join(root, "replacement");
	await writeFile(replacement, "other\r\ntext!\n");
	await rename(replacement, path);
	await expectRejected(streams.chunk("doc", next.readId, 0, 65536), "EDITOR_SOURCE_CHANGED");
	expect(streams.diagnostics.active).toBe(0);
});
test("20MiB boundary uses fixed source buffers; oversize/invalid codec releases permit", async () => {
	const { path, streams } = await fixture();
	const file = await open(path, "w");
	try {
		const block = Buffer.alloc(65536, 65);
		for (let at = 0; at < EDITOR_FILE_MAX_BYTES; at += block.length) await file.write(block);
	} finally {
		await file.close();
	}
	const metadata = await streams.metadata("u", path);
	expect(metadata.sourceBytes).toBe(EDITOR_FILE_MAX_BYTES);
	const tail = await open(path, "a");
	await tail.write(Uint8Array.of(65));
	await tail.close();
	await expectRejected(streams.metadata("u", path), "EDITOR_RAW_LIMIT");
	await writeFile(path, Uint8Array.of(65, 0xe4, 0xb8));
	await expectRejected(streams.metadata("u", path));
	expect(streams.diagnostics.active).toBe(0);
	expect(await sourceFds(path)).toBe(0);
}, 35_000);
test("legacy hint is explicit and validated by native decode plus streaming roundtrip", async () => {
	const { path, streams } = await fixture(iconv.encode("中文\r\n普通文本", "gbk"));
	await expectRejected(streams.metadata("u", path));
	expect((await streams.metadata("u", path, "gbk")).encoding).toBe("gbk");
	await writeFile(path, iconv.encode("中文😀𠀀", "gb18030"));
	expect((await streams.metadata("u", path, "gb18030")).encoding).toBe("gb18030");
});
test("cancelling an active preflight waits for its real FD close before returning the permit", async () => {
	const { path, streams } = await fixture(new Uint8Array(EDITOR_FILE_MAX_BYTES).fill(65));
	await streams.workers.counters();
	const controller = new AbortController();
	const pending = streams
		.open("u", "preflight-cancel", path, undefined, undefined, controller.signal)
		.catch((error) => error);
	const until = Date.now() + 1000;
	while (!(await sourceFds(path)) && Date.now() < until)
		await new Promise((resolve) => setTimeout(resolve, 1));
	expect(await sourceFds(path)).toBe(1);
	controller.abort();
	await streams.closeOwner("preflight-cancel");
	expect(await sourceFds(path)).toBe(0);
	expect(streams.diagnostics.active).toBe(0);
	expect(await pending).toBeInstanceOf(Error);
});
test("abort at start/midstream closes source and releases permits", async () => {
	const { path, streams } = await fixture(new Uint8Array(1024 * 1024).fill(65));
	const early = new AbortController();
	early.abort();
	await expectRejected(streams.open("u", "doc", path, undefined, undefined, early.signal));
	const mid = new AbortController();
	const source = await streams.open("u", "doc", path, undefined, undefined, mid.signal);
	await streams.chunk("doc", source.readId, 0, 65536);
	mid.abort();
	await streams.closeOwner("doc");
	expect(streams.diagnostics.active).toBe(0);
	expect(await sourceFds(path)).toBe(0);
});
