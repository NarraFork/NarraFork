import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as compiledWorkers from "../../compiled-worker";
import { isPrivateRequestRecordingPath, isSecretPlatformPath } from "../../fs-secret-paths";
import * as streamTimeout from "../../stream-timeout";
import { getImagePath } from "../../uploads";
import {
	generateAndStoreImages,
	ImageGenerationResponseError,
	imageGenerationResponseDirectory,
	recoverStoredImages,
} from "../image-generation-response";

const originalHome = process.env.NARRAFORK_HOME;
const narratorId = "image-response-test";
const signal = () => new AbortController().signal;
const realConnect = compiledWorkers.connectCompiledWorker;
const realReadWithTimeout = streamTimeout.readWithTimeout;

function pngBytes(tailBytes = 0): Buffer {
	const bytes = Buffer.alloc(24 + tailBytes);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
	bytes.writeUInt32BE(13, 8);
	bytes.write("IHDR", 12, 4, "ascii");
	bytes.writeUInt32BE(1, 16);
	bytes.writeUInt32BE(1, 20);
	return bytes;
}

function response(bytes: Buffer[], status = 200): Response {
	return new Response(
		JSON.stringify({ data: bytes.map((value) => ({ b64_json: value.toString("base64") })) }),
		{ status, headers: { "content-type": "application/json" } },
	);
}

async function tempHome(): Promise<string> {
	const home = await mkdtemp(join(tmpdir(), "nf-image-response-"));
	process.env.NARRAFORK_HOME = home;
	return home;
}

function params() {
	return { prompt: "generate", model: "image-model", signal: signal() };
}

async function failedGeneration(body: Response, generatedSignal = signal()) {
	const send = mock(async () => ({ response: body }));
	let failure: unknown;
	try {
		await generateAndStoreImages(params(), { narratorId, signal: generatedSignal }, send);
	} catch (error) {
		failure = error;
	}
	expect(send).toHaveBeenCalledTimes(1);
	expect(failure).toBeInstanceOf(ImageGenerationResponseError);
	const typed = failure as ImageGenerationResponseError;
	expect(typed.responseId).toBeTruthy();
	return { failure: typed, responseId: typed.responseId as string, send };
}

afterEach(async () => {
	mock.restore();
	if (process.env.NARRAFORK_HOME && process.env.NARRAFORK_HOME !== originalHome)
		await rm(process.env.NARRAFORK_HOME, { recursive: true, force: true });
	if (originalHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = originalHome;
});

describe("image generation response preservation", () => {
	test("stores every returned image in uploads and recovery is idempotent", async () => {
		const home = await tempHome();
		const send = mock(async () => ({ response: response([pngBytes(), pngBytes()]) }));
		const result = await generateAndStoreImages(params(), { narratorId, signal: signal() }, send);
		expect(send).toHaveBeenCalledTimes(1);
		expect(result.images).toHaveLength(2);
		expect(result.images.map((image) => image.imageId)).toEqual([
			`${result.responseId}_1`,
			`${result.responseId}_2`,
		]);
		for (const image of result.images) {
			expect(getImagePath(narratorId, image.imageId)).toBe(image.filePath);
			expect(image.width).toBe(1);
		}
		const timestamps = await Promise.all(
			result.images.map((image) => stat(image.filePath).then((info) => info.mtimeMs)),
		);
		const recovered = await recoverStoredImages(result.responseId, {
			narratorId,
			signal: signal(),
		});
		expect(recovered).toEqual(result);
		expect(
			await Promise.all(
				recovered.images.map((image) => stat(image.filePath).then((info) => info.mtimeMs)),
			),
		).toEqual(timestamps);
		expect(send).toHaveBeenCalledTimes(1);
		const dir = imageGenerationResponseDirectory(narratorId, result.responseId);
		expect(isSecretPlatformPath(dir, home)).toBe(true);
		expect(isPrivateRequestRecordingPath(home, home, true)).toBe(true);
	});

	test("keeps a failed local save recoverable without sending again", async () => {
		const home = await tempHome();
		await writeFile(join(home, "uploads"), "not a directory");
		const { responseId, send } = await failedGeneration(response([pngBytes()]));
		await rm(join(home, "uploads"), { force: true });
		await mkdir(join(home, "uploads"));
		const recovered = await recoverStoredImages(responseId, { narratorId, signal: signal() });
		expect(recovered.images).toHaveLength(1);
		expect(send).toHaveBeenCalledTimes(1);
	});

	test("accepts an image over 20 MiB and response over 32 MiB without text JSON caps", async () => {
		await tempHome();
		const generated = await generateAndStoreImages(
			params(),
			{ narratorId, signal: signal() },
			async () => ({ response: response([pngBytes(25 * 1024 * 1024 + 1)]) }),
		);
		expect((await stat(generated.images[0].filePath)).size).toBe(25 * 1024 * 1024 + 25);
		expect(
			(
				await stat(
					join(imageGenerationResponseDirectory(narratorId, generated.responseId), "response.json"),
				)
			).size,
		).toBeGreaterThan(32 * 1024 * 1024);
	});

	test("upstream error message/code are diagnosed and redacted by the worker; Codex request ID survives", async () => {
		await tempHome();
		const raw = JSON.stringify({
			error: { code: "quota_exceeded", message: "No credits; Authorization: Bearer private-token" },
		});
		const { responseId, failure, send } = await failedGeneration(
			new Response(raw, {
				status: 429,
				headers: {
					"x-request-id": "request-standard",
					"x-codex-imagegen-request-id": "request-codex",
				},
			}),
		);
		expect(failure.message).toContain("HTTP 429");
		expect(failure.message).toContain("No credits");
		expect(failure.message).not.toContain("private-token");
		expect(failure.code).toBe("quota_exceeded");
		const directory = imageGenerationResponseDirectory(narratorId, responseId);
		expect(await readFile(join(directory, "response.json"), "utf8")).toBe(raw);
		const metadata = JSON.parse(await readFile(join(directory, "metadata.json"), "utf8"));
		expect(metadata.requestId).toBe("request-standard");
		expect(metadata.codexImagegenRequestId).toBe("request-codex");
		await expect(recoverStoredImages(responseId, { narratorId, signal: signal() })).rejects.toThrow(
			"No credits",
		);
		expect(send).toHaveBeenCalledTimes(1);
	});

	test.each([
		["empty data", '{"data":[]}', "no images"],
		["bad JSON", '{"data":', "invalid JSON"],
		["invalid base64", '{"data":[{"b64_json":"!!!="}]}', "base64"],
		["noncanonical base64", '{"data":[{"b64_json":"AB=="}]}', "base64"],
		["nonimage bytes", '{"data":[{"b64_json":"dGV4dA=="}]}', "signature"],
	])("preserves %s and recovery never sends again", async (_name, raw, message) => {
		await tempHome();
		const { responseId, failure, send } = await failedGeneration(new Response(raw));
		expect(failure.message).toContain(message);
		await expect(recoverStoredImages(responseId, { narratorId, signal: signal() })).rejects.toThrow(
			message,
		);
		expect(
			await readFile(
				join(imageGenerationResponseDirectory(narratorId, responseId), "response.json"),
				"utf8",
			),
		).toBe(raw);
		expect(send).toHaveBeenCalledTimes(1);
	});

	test("non-JSON upstream errors retain generic HTTP diagnostics and saved bytes", async () => {
		await tempHome();
		const { responseId, failure } = await failedGeneration(
			new Response("<h1>failed</h1>", { status: 502 }),
		);
		expect(failure.message).toContain("HTTP 502");
		await expect(recoverStoredImages(responseId, { narratorId, signal: signal() })).rejects.toThrow(
			"HTTP 502",
		);
	});

	test("a later invalid image does not delete earlier success", async () => {
		const home = await tempHome();
		const raw = JSON.stringify({
			data: [{ b64_json: pngBytes().toString("base64") }, { b64_json: "bad" }],
		});
		const { responseId, send } = await failedGeneration(new Response(raw));
		const firstPath = getImagePath(narratorId, `${responseId}_1`);
		expect(firstPath).not.toBeNull();
		await expect(recoverStoredImages(responseId, { narratorId, signal: signal() })).rejects.toThrow(
			"base64",
		);
		expect(firstPath && (await readFile(firstPath)).equals(pngBytes())).toBe(true);
		expect(await readdir(join(home, "uploads", narratorId))).toEqual([`${responseId}_1.png`]);
		expect(send).toHaveBeenCalledTimes(1);
	});

	test("missing or disabled worker fails before sending", async () => {
		await tempHome();
		const unavailable = spyOn(compiledWorkers, "connectCompiledWorker").mockRejectedValue(
			new Error("worker unavailable"),
		);
		const send = mock(async () => ({ response: response([pngBytes()]) }));
		await expect(
			generateAndStoreImages(params(), { narratorId, signal: signal() }, send),
		).rejects.toThrow("worker unavailable");
		expect(unavailable).toHaveBeenCalledTimes(1);
		expect(send).not.toHaveBeenCalled();
	});

	test("worker crash retains the complete response; recovery only reruns local work", async () => {
		const home = await tempHome();
		const fixture = join(home, "crash-worker.ts");
		await writeFile(
			fixture,
			`import { parentPort } from "node:worker_threads";
parentPort?.on("message", (message) => { if (message.action === "ping") parentPort?.postMessage({ ready: true }); else if (message.action === "process") throw new Error("injected worker crash"); });`,
		);
		const connection = spyOn(compiledWorkers, "connectCompiledWorker").mockImplementation(
			(_specifiers, options) => realConnect([pathToFileURL(fixture).href], options),
		);
		const { responseId, failure, send } = await failedGeneration(response([pngBytes()]));
		expect(failure.message).toContain("injected worker crash");
		connection.mockRestore();
		expect(
			(await recoverStoredImages(responseId, { narratorId, signal: signal() })).images,
		).toHaveLength(1);
		expect(send).toHaveBeenCalledTimes(1);
	});

	test("local worker timeout preserves response and never invokes a main-thread fallback", async () => {
		await tempHome();
		const connection = spyOn(compiledWorkers, "connectCompiledWorker").mockImplementation(
			async (specifiers, options) => {
				const connected = await realConnect(specifiers, options);
				const post = connected.worker.postMessage.bind(connected.worker);
				spyOn(connected.worker, "postMessage").mockImplementation((message) => {
					if (message.action !== "process") post(message);
				});
				return connected;
			},
		);
		const watchdog = spyOn(streamTimeout, "readWithTimeout").mockImplementation((reader) =>
			realReadWithTimeout(reader, 30),
		);
		const { responseId, failure, send } = await failedGeneration(response([pngBytes()]));
		expect(failure.message).toContain("Stream stale");
		expect(watchdog).toHaveBeenCalledTimes(1);
		expect(getImagePath(narratorId, `${responseId}_1`)).toBeNull();
		connection.mockRestore();
		watchdog.mockRestore();
		expect(
			(await recoverStoredImages(responseId, { narratorId, signal: signal() })).images,
		).toHaveLength(1);
		expect(send).toHaveBeenCalledTimes(1);
	});

	test("cancelling a live response actually cancels the reader and retains incomplete bytes", async () => {
		await tempHome();
		const cancellation = new AbortController();
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{"data":['));
			},
			pull() {
				cancellation.abort(new Error("user cancelled capture"));
			},
			cancel() {
				cancelled = true;
			},
		});
		const { responseId, failure, send } = await failedGeneration(
			new Response(body),
			cancellation.signal,
		);
		expect(failure.message).toContain("user cancelled");
		expect(cancelled).toBe(true);
		await expect(recoverStoredImages(responseId, { narratorId, signal: signal() })).rejects.toThrow(
			"incomplete",
		);
		expect(send).toHaveBeenCalledTimes(1);
	});

	test("cancelling local processing terminates its worker but allows later recovery", async () => {
		await tempHome();
		const cancellation = new AbortController();
		let exited: Promise<number> | undefined;
		const connection = spyOn(compiledWorkers, "connectCompiledWorker").mockImplementation(
			async (specifiers, options) => {
				const connected = await realConnect(specifiers, options);
				exited = new Promise((resolve) => connected.worker.once("exit", resolve));
				spyOn(connected.worker, "postMessage").mockImplementation((message) => {
					if (message.action === "process")
						cancellation.abort(new Error("user cancelled local processing"));
				});
				return connected;
			},
		);
		const { responseId, failure, send } = await failedGeneration(
			response([pngBytes()]),
			cancellation.signal,
		);
		expect(failure.message).toContain("user cancelled local");
		await exited;
		expect(getImagePath(narratorId, `${responseId}_1`)).toBeNull();
		connection.mockRestore();
		expect(
			(await recoverStoredImages(responseId, { narratorId, signal: signal() })).images,
		).toHaveLength(1);
		expect(send).toHaveBeenCalledTimes(1);
	});

	test("an HTTP Content-Length mismatch is incomplete, not a valid recoverable response", async () => {
		await tempHome();
		const raw = JSON.stringify({ data: [{ b64_json: pngBytes().toString("base64") }] });
		const { responseId } = await failedGeneration(
			new Response(raw, { headers: { "Content-Length": String(raw.length + 4) } }),
		);
		const directory = imageGenerationResponseDirectory(narratorId, responseId);
		expect(existsSync(join(directory, "response.json"))).toBe(false);
		expect(await readFile(join(directory, "response.json.partial"), "utf8")).toBe(raw);
		await expect(recoverStoredImages(responseId, { narratorId, signal: signal() })).rejects.toThrow(
			"incomplete",
		);
	});

	test("recovery validates scope and path identity, and rejects changed complete byte counts", async () => {
		await tempHome();
		const generated = await generateAndStoreImages(
			params(),
			{ narratorId, signal: signal() },
			async () => ({ response: response([pngBytes()]) }),
		);
		await expect(recoverStoredImages("../other", { narratorId, signal: signal() })).rejects.toThrow(
			"Invalid",
		);
		await expect(
			recoverStoredImages(generated.responseId, { narratorId: "other-narrator", signal: signal() }),
		).rejects.toThrow();
		await writeFile(
			join(imageGenerationResponseDirectory(narratorId, generated.responseId), "response.json"),
			"truncated",
		);
		await expect(
			recoverStoredImages(generated.responseId, { narratorId, signal: signal() }),
		).rejects.toThrow("incomplete");
	});

	test("header metadata failure does not stop capture of the already-paid response", async () => {
		await tempHome();
		const write = fsPromises.writeFile;
		let writes = 0;
		const injected = spyOn(fsPromises, "writeFile").mockImplementation((...args) => {
			if (String(args[0]).includes("metadata.json.") && ++writes === 2)
				return Promise.reject(new Error("injected header metadata failure"));
			return write(...args);
		});
		const send = mock(async () => ({ response: response([pngBytes()]) }));
		const stored = await generateAndStoreImages(params(), { narratorId, signal: signal() }, send);
		expect(writes).toBeGreaterThan(2);
		injected.mockRestore();
		expect(
			existsSync(
				join(imageGenerationResponseDirectory(narratorId, stored.responseId), "response.json"),
			),
		).toBe(true);
		expect(
			(await recoverStoredImages(stored.responseId, { narratorId, signal: signal() })).images,
		).toEqual(stored.images);
		expect(send).toHaveBeenCalledTimes(1);
	});

	test("EOF-published bytes survive final metadata failure and are recoverable after repair", async () => {
		await tempHome();
		const write = fsPromises.writeFile;
		let writes = 0;
		const injected = spyOn(fsPromises, "writeFile").mockImplementation((...args) => {
			if (String(args[0]).includes("metadata.json.") && ++writes >= 3)
				return Promise.reject(new Error("injected final metadata failure"));
			return write(...args);
		});
		const { responseId, send } = await failedGeneration(response([pngBytes()]));
		injected.mockRestore();
		expect(
			existsSync(join(imageGenerationResponseDirectory(narratorId, responseId), "response.json")),
		).toBe(true);
		expect(
			(await recoverStoredImages(responseId, { narratorId, signal: signal() })).images,
		).toHaveLength(1);
		expect(send).toHaveBeenCalledTimes(1);
	});

	test("a worker that never reports ready is cancelled before send", async () => {
		const home = await tempHome();
		const fixture = join(home, "not-ready-worker.ts");
		await writeFile(
			fixture,
			'import { parentPort } from "node:worker_threads"; parentPort?.on("message", () => {});',
		);
		spyOn(compiledWorkers, "connectCompiledWorker").mockImplementation((_specifiers, options) =>
			realConnect([pathToFileURL(fixture).href], options),
		);
		const send = mock(async () => ({ response: response([pngBytes()]) }));
		await expect(
			generateAndStoreImages(params(), { narratorId, signal: AbortSignal.timeout(80) }, send),
		).rejects.toThrow();
		expect(send).not.toHaveBeenCalled();
	});

	test("main-thread JSON/text/base64 body processing is never used", async () => {
		await tempHome();
		const body = response([pngBytes()]);
		const json = spyOn(body, "json").mockRejectedValue(new Error("main-thread JSON forbidden"));
		const text = spyOn(body, "text").mockRejectedValue(new Error("main-thread text forbidden"));
		const generated = await generateAndStoreImages(
			params(),
			{ narratorId, signal: signal() },
			async () => ({ response: body }),
		);
		expect(generated.images).toHaveLength(1);
		expect(json).not.toHaveBeenCalled();
		expect(text).not.toHaveBeenCalled();
	});

	test("private response paths reject generic reads/shares including roots, ancestors and aliases", async () => {
		const home = await tempHome();
		const stored = await generateAndStoreImages(
			params(),
			{ narratorId, signal: signal() },
			async () => ({ response: response([pngBytes()]) }),
		);
		const directory = imageGenerationResponseDirectory(narratorId, stored.responseId);
		const link = join(home, "ordinary-link");
		await symlink(directory, link);
		for (const path of [
			directory,
			join(directory, "response.json"),
			link,
			join(link, "response.json"),
		]) {
			expect(isSecretPlatformPath(path, home)).toBe(true);
			expect(isPrivateRequestRecordingPath(path, home, true)).toBe(true);
		}
		expect(isPrivateRequestRecordingPath(home, home, true)).toBe(true);
		expect(
			isSecretPlatformPath(join(home, "image-generation-responses-other", "notes.json"), home),
		).toBe(false);
	});

	test("oversized dimensions are only discarded layout hints, not a reason to discard paid images", async () => {
		await tempHome();
		const image = pngBytes();
		image.writeUInt32BE(0xffff_ffff, 16);
		const generated = await generateAndStoreImages(
			params(),
			{ narratorId, signal: signal() },
			async () => ({ response: response([image]) }),
		);
		expect(generated.images).toHaveLength(1);
		expect(generated.images[0].width).toBeUndefined();
		expect(existsSync(generated.images[0].filePath)).toBe(true);
	});

	test("upload directory symlinks cannot redirect output outside uploads", async () => {
		const home = await tempHome();
		const outside = join(home, "outside");
		await mkdir(outside);
		await mkdir(join(home, "uploads"));
		await symlink(outside, join(home, "uploads", narratorId));
		await failedGeneration(response([pngBytes()]));
		expect(await readdir(outside)).toEqual([]);
	});
});
