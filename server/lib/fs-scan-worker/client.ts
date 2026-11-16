/** Bounded filesystem workers; failures never walk directories on the server thread. */
import { compiledWorkerSpecifiers, connectCompiledWorker } from "../compiled-worker";
import { hotSafe } from "../hot-safe";
import { logger } from "../logger";
import { isCompiledRuntime } from "../runtime-target";
import { WorkerCleanupError } from "../worker-runtime/lifecycle";
import { WorkerPool, WorkerPoolError, type WorkerTaskContext } from "../worker-runtime/pool";
import { TaskQueueError } from "../worker-runtime/queue";
import {
	DIR_SCAN_MAX_DEPTH,
	DIR_SCAN_MAX_ENTRIES,
	DirectoryMeasureAbortedError,
	type DirectoryTreeMeasurement,
	type MeasureDirectoryTreesOptions,
} from "./protocol";

export { DirectoryMeasureAbortedError };

const CONCURRENCY = 4;
const READY_TIMEOUT_MS = 5_000;
/** The original long scan budget includes queueing and startup. */
const MEASURE_TIMEOUT_MS = 15 * 60 * 1000;
const RETRY_COOLDOWN_MS = 5_000;

export class FsScanWorkerUnavailableError extends Error {
	constructor(cause: unknown) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		super(`Filesystem scan worker unavailable: ${reason}`, { cause });
		this.name = "FsScanWorkerUnavailableError";
	}
}

export function fsScanWorkerSpecifierCandidates(
	compiled = isCompiledRuntime(),
	moduleUrl = import.meta.url,
): string[] {
	return compiledWorkerSpecifiers(
		"lib/fs-scan-worker/fs-scan-worker-entry.ts",
		"./fs-scan-worker-entry.ts",
		moduleUrl,
		compiled,
	);
}

function validMeasurements(value: unknown, count: number): value is DirectoryTreeMeasurement[] {
	return (
		Array.isArray(value) &&
		value.length === count &&
		value.every(
			(entry) =>
				entry &&
				typeof entry === "object" &&
				Number.isFinite(entry.sizeBytes) &&
				entry.sizeBytes >= 0 &&
				Number.isSafeInteger(entry.entriesScanned) &&
				entry.entriesScanned >= 0 &&
				typeof entry.truncated === "boolean",
		)
	);
}

type Scan = { roots: string[]; options: MeasureDirectoryTreesOptions };
function createPool() {
	return new WorkerPool<Scan, DirectoryTreeMeasurement[]>({
		concurrency: CONCURRENCY,
		maxQueued: 32,
		maxQueuedBytes: 64 * 1024 * 1024,
		timeoutMs: MEASURE_TIMEOUT_MS,
		reuse: false,
		async create(context) {
			checkLegacyScans();
			if (owner.unavailableError && Date.now() < owner.retryAfter) throw owner.unavailableError;
			let connected: Awaited<ReturnType<typeof connectCompiledWorker>>;
			try {
				connected = await connectCompiledWorker(fsScanWorkerSpecifierCandidates(), {
					signal: context.signal,
					deadlineAt: Math.min(context.deadlineAt, Date.now() + READY_TIMEOUT_MS),
					timeoutMs: READY_TIMEOUT_MS,
					sendPing: false,
					isReady: (message) => {
						if ((message as { type?: string })?.type !== "ready")
							throw new Error("filesystem scan worker sent no ready handshake");
						return true;
					},
				});
			} catch (error) {
				if (error instanceof WorkerCleanupError || context.signal.aborted) throw error;
				throw unavailable(error);
			}
			owner.unavailableError = undefined;
			const { worker, handle } = connected;
			return {
				get closed() {
					return handle.closed;
				},
				close: () => handle.close(),
				run: ({ roots, options }, task: WorkerTaskContext) =>
					new Promise<DirectoryTreeMeasurement[]>((resolve, reject) => {
						const requestId = task.requestId;
						const finish = (error?: unknown, result?: DirectoryTreeMeasurement[]) => {
							worker.off("message", onMessage);
							worker.off("error", onError);
							worker.off("exit", onExit);
							if (error !== undefined) reject(error);
							else if (result) resolve(result);
							else reject(new Error("filesystem scan worker returned no measurements"));
						};
						const onError = (error: Error) => finish(error);
						const onExit = (code: number) =>
							finish(new Error(`filesystem scan worker exited before completing (code ${code})`));
						const onMessage = (message: {
							type?: string;
							requestId?: string;
							roots?: unknown;
							entriesScanned: number;
							sizeBytes: number;
							aborted?: boolean;
							message?: string;
						}) => {
							if (!message || typeof message !== "object" || Array.isArray(message)) {
								finish(new Error("filesystem scan worker returned an invalid response"));
								return;
							}
							if (message.type === "ready" && message.requestId === undefined) return;
							if (typeof message.requestId !== "string") {
								finish(new Error("filesystem scan worker returned an invalid response"));
								return;
							}
							if (message.requestId !== requestId) return;
							try {
								if (message.type === "progress") {
									if (
										!Number.isSafeInteger(message.entriesScanned) ||
										message.entriesScanned < 0 ||
										!Number.isSafeInteger(message.sizeBytes) ||
										message.sizeBytes < 0
									)
										throw new Error("filesystem scan worker returned invalid progress");
									options.onProgress?.({
										entriesScanned: message.entriesScanned,
										sizeBytes: message.sizeBytes,
									});
								} else if (message.type === "result") {
									if (!validMeasurements(message.roots, roots.length))
										finish(new Error("filesystem scan worker returned invalid measurements"));
									else finish(undefined, message.roots);
								} else if (message.type === "error")
									finish(
										message.aborted === true
											? new DirectoryMeasureAbortedError()
											: new Error(
													typeof message.message === "string"
														? message.message
														: "filesystem scan worker failed",
												),
									);
								else finish(new Error("filesystem scan worker returned an invalid response"));
							} catch (error) {
								finish(error);
							}
						};
						worker.on("message", onMessage);
						worker.on("error", onError);
						worker.on("exit", onExit);
						try {
							worker.postMessage({
								type: "measure",
								requestId,
								roots,
								maxEntries: options.maxEntries ?? DIR_SCAN_MAX_ENTRIES,
								maxDepth: options.maxDepth ?? DIR_SCAN_MAX_DEPTH,
							});
						} catch (error) {
							finish(error);
						}
					}),
			};
		},
	});
}
const owner = hotSafe("narrafork.fsScan.gate", () => ({
	pool: createPool(),
	restartRequired: false,
	unavailableError: undefined as FsScanWorkerUnavailableError | undefined,
	retryAfter: 0,
}));
// The old gate released counters before observing exit and retained no handles.
// Even zero old counters cannot prove resource reclamation. Preserve that owner and
// require an operator restart for this one-time upgrade, never for ordinary failures.
owner.restartRequired ??= !owner.pool;
owner.pool ??= createPool();
owner.retryAfter ??= 0;
function checkLegacyScans(): void {
	if (owner.restartRequired)
		throw new FsScanWorkerUnavailableError(
			new Error("Legacy filesystem worker ownership cannot be verified; process restart required"),
		);
}
function unavailable(cause: unknown): FsScanWorkerUnavailableError {
	if (cause instanceof FsScanWorkerUnavailableError) return cause;
	const error = new FsScanWorkerUnavailableError(cause);
	owner.unavailableError = error;
	owner.retryAfter = Date.now() + RETRY_COOLDOWN_MS;
	try {
		logger.warn("Filesystem scan worker unavailable; directory measurement failed", {
			kind: "fs-scan",
			outcome: "failed",
		});
	} catch {
		// A diagnostic sink cannot replace the scan failure or bypass cleanup.
	}
	return error;
}

/** Production shutdown: admission remains closed until an explicit test reset. */
export async function closeFsScanWorkers(): Promise<void> {
	await owner.pool.close();
	checkLegacyScans();
}
export async function resetFsScanWorkersForTest(): Promise<void> {
	await closeFsScanWorkers();
	owner.pool = createPool();
	owner.unavailableError = undefined;
	owner.retryAfter = 0;
}
export function fsScanWorkerStats() {
	return owner.pool.stats;
}

export async function measureDirectoriesOffThread(
	roots: string[],
	options: MeasureDirectoryTreesOptions = {},
): Promise<DirectoryTreeMeasurement[]> {
	if (options.signal?.aborted) throw new DirectoryMeasureAbortedError();
	checkLegacyScans();
	// Even empty/control requests must not bypass production shutdown.
	if (roots.length === 0 && !owner.pool.stats.closed) return [];
	try {
		return await owner.pool.run(
			{ roots, options },
			{
				signal: options.signal,
				deadlineAt: Date.now() + MEASURE_TIMEOUT_MS,
				bytes: roots.reduce((bytes, root) => bytes + root.length * 2, 0),
			},
		);
	} catch (error) {
		if (error instanceof WorkerCleanupError) throw error;
		if (options.signal?.aborted) throw new DirectoryMeasureAbortedError();
		if (
			error instanceof DirectoryMeasureAbortedError ||
			error instanceof WorkerCleanupError ||
			error instanceof WorkerPoolError ||
			(error instanceof TaskQueueError && error.code !== "TASK_QUEUE_TIMEOUT")
		)
			throw error;
		throw unavailable(error);
	}
}
