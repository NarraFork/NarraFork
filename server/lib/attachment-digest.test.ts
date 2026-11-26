import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as crypto from "node:crypto";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ATTACHMENT_DIGEST_MAX_BYTES,
	attachmentDigestWorkerSpecifiers,
	attachmentDigestWorkerStats,
	closeAttachmentDigestWorkers,
	digestAttachment,
	resetAttachmentDigestWorkersForTests,
} from "./attachment-digest";
import { WorkerHandle } from "./worker-runtime/lifecycle";

const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const nativeThread = WorkerHandle.thread;
let directory: string;
let handles: ReturnType<typeof WorkerHandle.thread>[];
let spawns: ReturnType<typeof spyOn<typeof WorkerHandle, "thread">>;

beforeEach(async () => {
	await resetAttachmentDigestWorkersForTests();
	directory = await mkdtemp(join(tmpdir(), "nf-attachment-digest-"));
	handles = [];
	spawns = spyOn(WorkerHandle, "thread").mockImplementation((entry, options) => {
		const handle = nativeThread(entry, options);
		handles.push(handle);
		return handle;
	});
});
afterEach(async () => {
	await closeAttachmentDigestWorkers();
	spawns.mockRestore();
	for (const handle of handles) expect(typeof (await handle.exited)).toBe("number");
	expect(attachmentDigestWorkerStats()).toMatchObject({ active: 0, queued: 0, workers: 0 });
	await rm(directory, { recursive: true, force: true });
});
async function rejected(work: Promise<unknown>): Promise<Error> {
	try {
		await work;
	} catch (error) {
		expect(error).toBeInstanceOf(Error);
		return error as Error;
	}
	throw new Error("Expected the digest operation to reject");
}
async function noMainComputation(work: () => Promise<unknown>): Promise<Error> {
	const hash = spyOn(crypto, "createHash").mockImplementation(() => {
		throw new Error("Main-thread hash forbidden");
	});
	const arrayBuffer = spyOn(Blob.prototype, "arrayBuffer").mockImplementation(() => {
		throw new Error("Main-thread read forbidden");
	});
	const stream = spyOn(Blob.prototype, "stream").mockImplementation(() => {
		throw new Error("Main-thread read forbidden");
	});
	try {
		const error = await rejected(work());
		expect(hash).not.toHaveBeenCalled();
		expect(arrayBuffer).not.toHaveBeenCalled();
		expect(stream).not.toHaveBeenCalled();
		return error;
	} finally {
		hash.mockRestore();
		arrayBuffer.mockRestore();
		stream.mockRestore();
	}
}
async function workerFixture(body: string) {
	const path = join(directory, "fake-worker.ts");
	await writeFile(path, `import { parentPort } from "node:worker_threads";\n${body}`);
	spawns.mockImplementation((_entry, options) => {
		const handle = nativeThread(path, options);
		handles.push(handle);
		return handle;
	});
}

for (const kind of ["Blob", "File", "BunFile", "path"] as const) {
	test(`real Worker hashes ${kind} without reading or hashing on the main thread`, async () => {
		const path = join(directory, "abc.bin");
		await writeFile(path, "abc");
		const input =
			kind === "path"
				? path
				: kind === "BunFile"
					? Bun.file(path)
					: kind === "File"
						? new File(["abc"], "abc.bin")
						: new Blob(["abc"]);
		const hash = spyOn(crypto, "createHash").mockImplementation(() => {
			throw new Error("Main-thread hash forbidden");
		});
		const reads = spyOn(Blob.prototype, "arrayBuffer").mockImplementation(() => {
			throw new Error("Main-thread read forbidden");
		});
		const streams = spyOn(Blob.prototype, "stream").mockImplementation(() => {
			throw new Error("Main-thread read forbidden");
		});
		try {
			expect(await digestAttachment(input)).toBe(ABC);
			expect(spawns).toHaveBeenCalledTimes(1);
			expect(hash).not.toHaveBeenCalled();
			expect(reads).not.toHaveBeenCalled();
			expect(streams).not.toHaveBeenCalled();
		} finally {
			hash.mockRestore();
			reads.mockRestore();
			streams.mockRestore();
		}
	});
}

test("empty content and multi-chunk binary content use the raw bytes", async () => {
	expect(await digestAttachment(new Blob([]), { maxBytes: 0 })).toBe(EMPTY);
	const bytes = Uint8Array.from({ length: 2 * 1024 * 1024 + 777 }, (_, index) => index % 251);
	const expected = crypto.createHash("sha256").update(bytes).digest("hex");
	const path = join(directory, "multi-chunk.bin");
	await writeFile(path, bytes);
	expect(await digestAttachment(path)).toBe(expected);
	expect(await digestAttachment(new File([bytes], "multi-chunk.bin"))).toBe(expected);
});

test("a path is read only in the Worker and byte limits are enforced before hashing", async () => {
	const path = join(directory, "over-limit.bin");
	await writeFile(path, "abc");
	const limited = await noMainComputation(() => digestAttachment(path, { maxBytes: 2 }));
	expect(limited).toMatchObject({ code: "ATTACHMENT_DIGEST_TOO_LARGE", statusCode: 413 });
	const sparse = await open(path, "w");
	try {
		await sparse.truncate(ATTACHMENT_DIGEST_MAX_BYTES + 1);
	} finally {
		await sparse.close();
	}
	expect(await noMainComputation(() => digestAttachment(path))).toMatchObject({
		code: "ATTACHMENT_DIGEST_TOO_LARGE",
	});
});

test("missing files and directory inputs fail rather than returning the empty digest", async () => {
	for (const input of [
		join(directory, "missing.bin"),
		Bun.file(join(directory, "missing-file.bin")),
		directory,
	])
		expect(await noMainComputation(() => digestAttachment(input))).toBeInstanceOf(Error);
});

test("invalid budgets, an oversized Blob and pre-aborted requests do not spawn a worker", async () => {
	for (const maxBytes of [-1, NaN, Infinity, ATTACHMENT_DIGEST_MAX_BYTES + 1])
		await rejected(digestAttachment(new Blob(["abc"]), { maxBytes }));
	for (const timeoutMs of [0, -1, NaN, Infinity])
		await rejected(digestAttachment(new Blob(["abc"]), { timeoutMs }));
	expect(
		await noMainComputation(() => digestAttachment(new Blob(["abc"]), { maxBytes: 2 })),
	).toMatchObject({ code: "ATTACHMENT_DIGEST_TOO_LARGE" });
	const controller = new AbortController();
	const abort = new Error("cancelled before admission");
	controller.abort(abort);
	expect(await rejected(digestAttachment(new Blob(["abc"]), { signal: controller.signal }))).toBe(
		abort,
	);
	expect(spawns).not.toHaveBeenCalled();
});

test("worker creation failure does not compute the digest locally", async () => {
	spawns.mockImplementation(() => {
		throw new Error("Worker creation unavailable");
	});
	expect((await noMainComputation(() => digestAttachment(new Blob(["abc"])))).message).toContain(
		"Worker creation unavailable",
	);
	expect(spawns).toHaveBeenCalledTimes(1);
});

test("a never-ready Worker times out and exits without local computation", async () => {
	await workerFixture(`parentPort.on("message", () => {});`);
	await noMainComputation(() => digestAttachment(new Blob(["abc"]), { timeoutMs: 100 }));
	expect(handles).toHaveLength(1);
	expect(typeof (await handles[0]?.exited)).toBe("number");
});

for (const [name, body, error] of [
	[
		"execution exception",
		`parentPort.once("message", () => { throw new Error("Worker hash failed"); });`,
		"Worker hash failed",
	],
	["premature exit", `parentPort.once("message", () => process.exit(0));`, "exited"],
	[
		"domain failure",
		`parentPort.once("message", () => { parentPort.postMessage({error:"Digest task failed"}); parentPort.close(); });`,
		"Digest task failed",
	],
	[
		"invalid result",
		`parentPort.once("message", () => { parentPort.postMessage({digest:"bad"}); parentPort.close(); });`,
		"invalid result",
	],
] as const) {
	test(`${name} does not trigger main-thread computation`, async () => {
		await workerFixture(`${body}\nparentPort.postMessage({ready:true});`);
		expect((await noMainComputation(() => digestAttachment(new Blob(["abc"])))).message).toContain(
			error,
		);
		expect(handles).toHaveLength(1);
	});
}

test("execution timeout preserves the total deadline and terminates the actual Worker", async () => {
	const marker = join(directory, "dispatched");
	await workerFixture(
		`import {writeFileSync} from "node:fs";\nparentPort.on("message", () => writeFileSync(${JSON.stringify(marker)}, "yes"));\nparentPort.postMessage({ready:true});`,
	);
	const error = await noMainComputation(() =>
		digestAttachment(new Blob(["abc"]), { timeoutMs: 500 }),
	);
	expect(await Bun.file(marker).exists()).toBe(true);
	expect(error).toMatchObject({ code: "ATTACHMENT_DIGEST_TIMEOUT" });
	expect(typeof (await handles[0]?.exited)).toBe("number");
});

test("cancellation during execution terminates the Worker and preserves the caller's reason", async () => {
	const dispatched = Promise.withResolvers<void>();
	const posts: Array<ReturnType<typeof spyOn>> = [];
	await workerFixture(`parentPort.on("message", () => {}); parentPort.postMessage({ready:true});`);
	const create = spawns.getMockImplementation();
	if (!create) throw new Error("Missing worker fixture");
	spawns.mockImplementation((entry, options) => {
		const handle = create(entry, options);
		const post = handle.resource.postMessage.bind(handle.resource);
		posts.push(
			spyOn(handle.resource, "postMessage").mockImplementation((message) => {
				dispatched.resolve();
				post(message);
			}),
		);
		return handle;
	});
	const controller = new AbortController();
	const abort = new Error("caller cancelled digest");
	const waiting = digestAttachment(new Blob(["abc"]), { signal: controller.signal });
	const result = rejected(waiting);
	await dispatched.promise;
	controller.abort(abort);
	try {
		expect(await result).toBe(abort);
		expect(typeof (await handles[0]?.exited)).toBe("number");
	} finally {
		for (const post of posts) post.mockRestore();
	}
});

test("the closed/disabled pool refuses work without creating a Worker or local digest", async () => {
	await closeAttachmentDigestWorkers();
	expect(await noMainComputation(() => digestAttachment(new Blob(["abc"])))).toMatchObject({
		code: "ATTACHMENT_DIGEST_UNAVAILABLE",
	});
	expect(spawns).not.toHaveBeenCalled();
});

test("admission caps concurrency at two and waiting jobs at eight", async () => {
	await workerFixture(`parentPort.on("message", () => {});`);
	const jobs = Array.from({ length: 10 }, () => rejected(digestAttachment("pending-file")));
	expect(attachmentDigestWorkerStats()).toMatchObject({
		active: 2,
		queued: 8,
		concurrency: 2,
		maxQueued: 8,
		maxQueuedBytes: 64 * 1024 * 1024,
	});
	expect(await noMainComputation(() => digestAttachment("overflow-file"))).toMatchObject({
		code: "ATTACHMENT_DIGEST_BUSY",
		statusCode: 429,
	});
	await closeAttachmentDigestWorkers();
	await Promise.all(jobs);
	expect(handles.length).toBeLessThanOrEqual(2);
});

test("the waiting-byte budget accounts for retained Blob contents", async () => {
	await workerFixture(`parentPort.on("message", () => {});`);
	const running = [rejected(digestAttachment("active-a")), rejected(digestAttachment("active-b"))];
	const blob = new Blob([new Uint8Array(33 * 1024 * 1024)]);
	const queued = rejected(digestAttachment(blob));
	expect(attachmentDigestWorkerStats()).toMatchObject({
		active: 2,
		queued: 1,
		queuedBytes: blob.size,
	});
	expect(await noMainComputation(() => digestAttachment(blob))).toMatchObject({
		code: "ATTACHMENT_DIGEST_BUSY",
	});
	await closeAttachmentDigestWorkers();
	await Promise.all([...running, queued]);
});

test("compiled entry resolution includes source and both embedded layouts", () => {
	expect(
		attachmentDigestWorkerSpecifiers(false, "file:///project/server/lib/attachment-digest.ts"),
	).toEqual(["file:///project/server/lib/attachment-digest-worker.ts"]);
	expect(attachmentDigestWorkerSpecifiers(true, "file:///$bunfs/root/narrafork")).toEqual([
		"file:///$bunfs/root/lib/attachment-digest-worker.js",
		"file:///$bunfs/root/server/lib/attachment-digest-worker.js",
		"file:///$bunfs/root/attachment-digest-worker.js",
	]);
});
