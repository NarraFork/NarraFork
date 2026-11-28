import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import { compiledWorkerSpecifiers, connectCompiledWorker } from "../compiled-worker";
import { diskSafetySettings, guardDiskWrite } from "../disk-safety";
import { hotSafe } from "../hot-safe";
import { generateId } from "../id";
import { logger } from "../logger";
import { getNarraforkPath } from "../narrafork-home";
import { redactDiagnosticText } from "../net/diagnostic-redaction";
import { readWithTimeout } from "../stream-timeout";
import { getUploadsDir } from "../uploads";
import { type PoolWorker, WorkerPool, type WorkerTaskContext } from "../worker-runtime/pool";
import type { ImageGenerationRequest, ImageGenerationResponse } from "./image-generation-api";
import type {
	ImageGenerationWorkerReply,
	ImageGenerationWorkerRequest,
} from "./image-generation-response-protocol";

const RESPONSE_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const RESPONSE_ROOT = "image-generation-responses";

export interface StoredGeneratedImage {
	imageId: string;
	mediaType: string;
	uploadNarratorId: string;
	filePath: string;
	width?: number;
	height?: number;
}

export interface StoredImageGeneration {
	responseId: string;
	images: StoredGeneratedImage[];
	model?: string;
}

export class ImageGenerationResponseError extends Error {
	readonly responseId?: string;
	readonly code?: string;

	constructor(
		message: string,
		options: { responseId?: string; code?: string; cause?: unknown } = {},
	) {
		super(redactDiagnosticText(message), { cause: options.cause });
		this.name = "ImageGenerationResponseError";
		this.responseId = options.responseId;
		this.code = options.code ? redactDiagnosticText(options.code) : undefined;
	}
}

interface StoredResponseMetadata {
	version: 1;
	responseId: string;
	narratorId: string;
	model?: string;
	status: number;
	requestId?: string;
	codexImagegenRequestId?: string;
	integrity: {
		complete: boolean;
		byteLength: number;
		expectedByteLength?: number;
	};
	processed: boolean;
}

interface ImageGenerationScope {
	narratorId: string;
	callId?: string;
	signal: AbortSignal;
}

function assertResponseId(responseId: string): void {
	if (!RESPONSE_ID_RE.test(responseId))
		throw new ImageGenerationResponseError("Invalid image response or narrator ID");
}

export function imageGenerationResponseDirectory(narratorId: string, responseId: string): string {
	assertResponseId(narratorId);
	assertResponseId(responseId);
	return getNarraforkPath(RESPONSE_ROOT, narratorId, responseId);
}

function responseBodyPath(narratorId: string, responseId: string): string {
	return join(imageGenerationResponseDirectory(narratorId, responseId), "response.json");
}

function responseMetadataPath(narratorId: string, responseId: string): string {
	return join(imageGenerationResponseDirectory(narratorId, responseId), "metadata.json");
}

async function writeMetadata(metadata: StoredResponseMetadata): Promise<void> {
	const target = responseMetadataPath(metadata.narratorId, metadata.responseId);
	const temporary = `${target}.${generateId()}.partial`;
	await writeFile(temporary, JSON.stringify(metadata), { mode: 0o600, flag: "wx" });
	await rename(temporary, target);
}

function expectedLengthFromResponse(response: Response): number | undefined {
	// fetch may transparently decompress the body, making wire length unsuitable for comparison.
	if (response.headers.get("content-encoding")) return undefined;
	const value = response.headers.get("content-length");
	if (!value || !/^\d+$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function errorWithResponseId(error: unknown, responseId: string): ImageGenerationResponseError {
	if (error instanceof ImageGenerationResponseError && error.responseId === responseId)
		return error;
	const message = error instanceof Error ? error.message : String(error);
	const code = (error as { code?: unknown } | null)?.code;
	return new ImageGenerationResponseError(message, {
		responseId,
		cause: error,
		...(typeof code === "string" ? { code } : {}),
	});
}

async function persistResponseBody(
	response: Response,
	metadata: StoredResponseMetadata,
	signal: AbortSignal,
): Promise<void> {
	const target = responseBodyPath(metadata.narratorId, metadata.responseId);
	const partial = `${target}.partial`;
	const file = await open(partial, "wx", 0o600);
	let byteLength = 0;
	let fileClosed = false;
	let bodyComplete = false;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let cancelling: Promise<void> | undefined;
	const cancelReader = (reason: unknown) => {
		cancelling ??= reader?.cancel(reason) ?? Promise.resolve();
		return cancelling;
	};
	const onAbort = () => {
		void cancelReader(signal.reason).catch(() => {});
	};
	try {
		signal.throwIfAborted();
		if (!response.body) throw new Error("Image generation response has no body");
		reader = response.body.getReader();
		signal.addEventListener("abort", onAbort, { once: true });
		while (true) {
			// Do not impose a text-JSON size/first-token limit or a new generation deadline.
			const result = await reader.read();
			signal.throwIfAborted();
			if (result.done) break;
			await guardDiskWrite(target, result.value.byteLength);
			let offset = 0;
			while (offset < result.value.byteLength) {
				signal.throwIfAborted();
				const { bytesWritten } = await file.write(result.value.subarray(offset));
				if (!bytesWritten) throw new Error("Image response storage made no progress");
				offset += bytesWritten;
				byteLength += bytesWritten;
			}
		}
		if (
			metadata.integrity.expectedByteLength !== undefined &&
			metadata.integrity.expectedByteLength !== byteLength
		)
			throw new Error(
				"Image response is incomplete: received length does not match Content-Length",
			);
		await file.sync();
		await file.close();
		fileClosed = true;
		// Only EOF-published response.json proves a full body. Metadata write failure cannot erase it.
		await rename(partial, target);
		bodyComplete = true;
		metadata.integrity.complete = true;
		metadata.integrity.byteLength = byteLength;
		await writeMetadata(metadata);
	} catch (error) {
		metadata.integrity.complete = bodyComplete;
		metadata.integrity.byteLength = byteLength;
		await writeMetadata(metadata).catch(() => {});
		await cancelReader(error).catch(() => {});
		throw error;
	} finally {
		signal.removeEventListener("abort", onAbort);
		try {
			await cancelling;
		} finally {
			reader?.releaseLock();
			if (!fileClosed) await file.close();
		}
	}
}

interface ResponseProcessor {
	worker: Worker;
	failure?: unknown;
	/** Resolves only after actual exit. No fire-and-forget resource disposal. */
	dispose(): Promise<void>;
}

type ImageResponseJob = (
	processor: ResponseProcessor,
	signal: AbortSignal,
) => Promise<StoredImageGeneration>;

function createResponsePool() {
	return new WorkerPool<ImageResponseJob, StoredImageGeneration>({
		concurrency: 2,
		maxQueued: 32,
		maxQueuedBytes: 64 * 1024 * 1024,
		// Each permit leases one exclusive worker for readiness, the paid send and its response.
		reuse: false,
		create: createProcessor,
	});
}

const responseOwner = hotSafe("narrafork.imageGenerationResponse.workers.v1", () => ({
	pool: createResponsePool(),
}));

/** Permanent production close; pending creation, handler cleanup and native exits are awaited. */
export function closeImageGenerationResponseWorkers(): Promise<void> {
	return responseOwner.pool.close(new Error("Image response workers are closed"));
}

export async function resetImageGenerationResponseWorkersForTests(): Promise<void> {
	await closeImageGenerationResponseWorkers();
	responseOwner.pool = createResponsePool();
}

async function createProcessor(
	context: WorkerTaskContext,
): Promise<PoolWorker<ImageResponseJob, StoredImageGeneration>> {
	const { worker, handle } = await connectCompiledWorker(
		compiledWorkerSpecifiers(
			"lib/agent/image-generation-response-worker.ts",
			"./image-generation-response-worker.ts",
			import.meta.url,
		),
		{
			signal: context.signal,
			deadlineAt: Math.min(Date.now() + 5_000, context.deadlineAt),
		},
	);
	const processor: ResponseProcessor = {
		worker,
		dispose: () => handle.close(),
	};
	worker.on("error", (error: Error) => {
		processor.failure = error;
	});
	worker.on("exit", (code: number) => {
		processor.failure ??= new Error(`Image response worker exited with code ${code}`);
	});
	let running: Promise<StoredImageGeneration> | undefined;
	return {
		get closed() {
			return handle.closed;
		},
		run(job, task) {
			running = Promise.resolve().then(() => job(processor, task.signal));
			return running;
		},
		async close() {
			// An exited worker alone does not prove the response reader/file writer has drained.
			// Waiting for both also prevents cancellation returning a slot ahead of body cleanup.
			await Promise.all([
				handle.close(),
				running?.then(
					() => {},
					() => {},
				),
			]);
		},
	};
}

async function processWithWorker(
	processor: ResponseProcessor,
	metadata: StoredResponseMetadata,
	signal: AbortSignal,
): Promise<StoredGeneratedImage[]> {
	signal.throwIfAborted();
	if (processor.failure) throw processor.failure;
	const { worker } = processor;
	let controller: ReadableStreamDefaultController<StoredGeneratedImage[]>;
	const stream = new ReadableStream<StoredGeneratedImage[]>({
		start(value) {
			controller = value;
		},
		cancel() {
			return processor.dispose();
		},
	});
	const onAbort = () =>
		controller.error(signal.reason ?? new Error("Image response processing cancelled"));
	const onError = (error: Error) => controller.error(error);
	const onExit = (code: number) =>
		controller.error(new Error(`Image response worker exited before completing (${code})`));
	const onMessage = (frame: unknown) => {
		if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
			controller.error(new Error("Invalid image response worker reply"));
			return;
		}
		const message = frame as ImageGenerationWorkerReply;
		if ("ready" in message && message.ready === true && !("ok" in message)) return;
		if ("ok" in message && message.ok === false && typeof message.error === "string")
			controller.error(
				new ImageGenerationResponseError(message.error, {
					responseId: metadata.responseId,
					code: typeof message.code === "string" ? message.code : undefined,
				}),
			);
		else if ("ok" in message && message.ok === true) {
			if (!Array.isArray(message.images) || !message.images.length)
				controller.error(new Error("Image response worker returned no images"));
			else {
				controller.enqueue(message.images);
				controller.close();
			}
		} else controller.error(new Error("Invalid image response worker reply"));
	};
	worker.on("message", onMessage);
	worker.on("error", onError);
	worker.on("exit", onExit);
	signal.addEventListener("abort", onAbort, { once: true });
	const reader = stream.getReader();
	const started = performance.now();
	try {
		signal.throwIfAborted();
		const request: ImageGenerationWorkerRequest = {
			action: "process",
			responseId: metadata.responseId,
			narratorId: metadata.narratorId,
			responsePath: responseBodyPath(metadata.narratorId, metadata.responseId),
			uploadsRoot: getUploadsDir(),
			diskSafety: diskSafetySettings(),
			httpStatus: metadata.status,
		};
		worker.postMessage(request);
		// Existing five-minute stale-read watchdog is local-only. The raw response is never removed.
		const result = await readWithTimeout(reader);
		if (result.done || !result.value.length)
			throw new Error("Image response worker returned no images");
		metadata.processed = true;
		await writeMetadata(metadata);
		return result.value;
	} finally {
		const elapsedMs = performance.now() - started;
		if (elapsedMs > 1_000) {
			try {
				logger.warn("Slow image generation local response processing", {
					elapsedMs: Math.round(elapsedMs),
				});
			} catch {
				// Diagnostics must not skip listener, reader or worker cleanup below.
			}
		}
		signal.removeEventListener("abort", onAbort);
		worker.off("message", onMessage);
		worker.off("error", onError);
		worker.off("exit", onExit);
		try {
			await processor.dispose();
		} finally {
			reader.releaseLock();
		}
	}
}

export async function generateAndStoreImages(
	params: ImageGenerationRequest,
	scope: ImageGenerationScope,
	send: (params: ImageGenerationRequest) => Promise<ImageGenerationResponse>,
): Promise<StoredImageGeneration> {
	assertResponseId(scope.narratorId);
	const signal = AbortSignal.any([params.signal, scope.signal]);
	// Only fixed scalar lengths: never scan/serialize the prompt to estimate admission bytes.
	const bytes =
		2 *
			(params.prompt.length +
				params.model.length +
				(params.size?.length ?? 0) +
				(params.quality?.length ?? 0) +
				(params.conversationId?.length ?? 0) +
				(params.chatModel?.length ?? 0) +
				(params.callId?.length ?? 0) +
				scope.narratorId.length +
				(scope.callId?.length ?? 0)) +
		1024;
	let responseId: string | undefined;
	try {
		return await responseOwner.pool.run(
			(processor, activeSignal) => {
				responseId = generateId();
				return captureGeneratedImages(params, scope, send, processor, activeSignal, responseId);
			},
			{ signal, bytes, deadlineAt: Infinity },
		);
	} catch (error) {
		// The pool preserves cancellation causes; restore the domain's paid-response receipt.
		if (responseId) throw errorWithResponseId(error, responseId);
		throw error;
	}
}

async function captureGeneratedImages(
	params: ImageGenerationRequest,
	scope: ImageGenerationScope,
	send: (params: ImageGenerationRequest) => Promise<ImageGenerationResponse>,
	processor: ResponseProcessor,
	signal: AbortSignal,
	responseId: string,
): Promise<StoredImageGeneration> {
	// Pool creation has already proved ready before the only potentially paid send.
	const metadata: StoredResponseMetadata = {
		version: 1,
		responseId,
		narratorId: scope.narratorId,
		model: params.model,
		status: 0,
		integrity: { complete: false, byteLength: 0 },
		processed: false,
	};
	const started = performance.now();
	let received: Response | undefined;
	try {
		// Storage must be writable before payment, too. No credentials or prompt are persisted.
		await guardDiskWrite(imageGenerationResponseDirectory(scope.narratorId, responseId));
		await mkdir(imageGenerationResponseDirectory(scope.narratorId, responseId), {
			recursive: true,
			mode: 0o700,
		});
		await writeMetadata(metadata);
		signal.throwIfAborted();
		if (processor.failure) throw processor.failure;
		const generated = await send({ ...params, signal });
		received = generated.response;
		metadata.status = received.status;
		metadata.requestId =
			received.headers.get("x-request-id") ?? received.headers.get("request-id") ?? undefined;
		metadata.codexImagegenRequestId =
			received.headers.get("x-codex-imagegen-request-id") ?? undefined;
		metadata.integrity.expectedByteLength = expectedLengthFromResponse(received);
		try {
			await writeMetadata(metadata);
		} catch {
			// A header receipt failure must not throw away bytes from an already-paid response.
			try {
				logger.warn("Image response header metadata could not be saved; preserving response body");
			} catch {
				// A failed warning cannot discard an already-paid response body.
			}
		}
		await persistResponseBody(received, metadata, signal);
		const images = await processWithWorker(processor, metadata, signal);
		return { responseId, images, model: params.model };
	} catch (error) {
		// Cancellation and all local failures keep both partial and complete response bytes.
		await received?.body?.cancel(error).catch(() => {});
		throw errorWithResponseId(error, responseId);
	} finally {
		await processor.dispose();
		const elapsedMs = performance.now() - started;
		if (elapsedMs > 1_000) {
			try {
				logger.warn("Slow image generation response capture", {
					elapsedMs: Math.round(elapsedMs),
					complete: metadata.integrity.complete,
				});
			} catch {
				// Preserve the stored result and cleanup outcome when diagnostics fail.
			}
		}
	}
}

export async function recoverStoredImages(
	responseId: string,
	scope: ImageGenerationScope,
): Promise<StoredImageGeneration> {
	assertResponseId(responseId);
	assertResponseId(scope.narratorId);
	return responseOwner.pool
		.run(
			(processor, signal) => recoverResponseImages(responseId, { ...scope, signal }, processor),
			{
				signal: scope.signal,
				bytes:
					(responseId.length + scope.narratorId.length + (scope.callId?.length ?? 0)) * 2 + 512,
				deadlineAt: Infinity,
			},
		)
		.catch((error: unknown) => {
			throw errorWithResponseId(error, responseId);
		});
}

async function recoverResponseImages(
	responseId: string,
	scope: ImageGenerationScope,
	processor: ResponseProcessor,
): Promise<StoredImageGeneration> {
	try {
		scope.signal.throwIfAborted();
		const metadata = JSON.parse(
			await readFile(responseMetadataPath(scope.narratorId, responseId), "utf8"),
		) as StoredResponseMetadata;
		if (
			metadata.version !== 1 ||
			metadata.responseId !== responseId ||
			metadata.narratorId !== scope.narratorId
		)
			throw new Error("Image response does not belong to this narrator");
		const saved = await stat(responseBodyPath(scope.narratorId, responseId)).catch(() => undefined);
		if (!saved || !metadata.integrity)
			throw new Error(
				"Image response is incomplete: missing network bytes cannot be recovered locally; no generation was resent",
			);
		// response.json is only published after EOF and fsync. Repair a failed final metadata write.
		if (!metadata.integrity.complete) {
			if (
				metadata.integrity.expectedByteLength !== undefined &&
				metadata.integrity.expectedByteLength !== saved.size
			)
				throw new Error("Saved image response is incomplete; no generation was resent");
			metadata.integrity.complete = true;
			metadata.integrity.byteLength = saved.size;
		}
		if (!saved.isFile() || saved.size !== metadata.integrity.byteLength)
			throw new Error(
				"Saved image response is incomplete: its stored byte length changed; no generation was resent",
			);
		const images = await processWithWorker(processor, metadata, scope.signal);
		return { responseId, images, ...(metadata.model ? { model: metadata.model } : {}) };
	} catch (error) {
		throw errorWithResponseId(error, responseId);
	} finally {
		await processor.dispose();
	}
}
