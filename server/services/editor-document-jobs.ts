import { AsyncLocalStorage } from "node:async_hooks";
import { Worker } from "node:worker_threads";
import { EDITOR_IO_TIMEOUT_MS } from "../../shared/editor-document";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";
import { isCompiledRuntime } from "../lib/runtime-target";
import type { EditorWorkerRequest, EditorWorkerResult } from "./editor-document-worker";

/** Additional build entries become .js paths relative to the build root, whereas
 * import.meta.url in every compiled module identifies the binary itself. */
export function editorWorkerSpecifierCandidates(
	compiled = isCompiledRuntime(),
	moduleUrl = import.meta.url,
): string[] {
	const paths = compiled
		? [
				"./services/editor-document-worker.js",
				"./server/services/editor-document-worker.js",
				"./editor-document-worker.js",
			]
		: ["./editor-document-worker.ts"];
	return paths.map((path) => new URL(path, moduleUrl).href);
}
const WORKER_READY_TIMEOUT_MS = 5_000;

type Permit = { userId: string; signal: AbortSignal };
type Waiting = { userId: string; start(): void; cancel(): void };
const timeoutError = () =>
	new AppError("Editor task cancelled or timed out", 408, "EDITOR_TIMEOUT");
/** Admission covers the entire raw-before/blob/dispatch/receipt IO task, not only its
 * encoding stage. Nested worker jobs reuse the same permit without deadlocking. */
export class EditorDocumentJobs {
	private active = new Set<string>();
	private queue: Waiting[] = [];
	private context = new AsyncLocalStorage<Permit>();
	private resolvedWorkerSpecifier?: string;
	/** Explicit specifiers are a trusted test seam, never taken from HTTP metadata. */
	constructor(private readonly workerSpecifiers?: readonly string[]) {}
	withIo<T>(
		userId: string,
		body: (signal: AbortSignal) => Promise<T>,
		external?: AbortSignal,
	): Promise<T> {
		const inherited = this.context.getStore();
		if (inherited?.userId === userId)
			return body(external ? AbortSignal.any([external, inherited.signal]) : inherited.signal);
		if (external?.aborted) return Promise.reject(external.reason);
		if (this.queue.length >= 8)
			return Promise.reject(new AppError("Editor IO queue is full", 429, "EDITOR_BUSY"));
		return new Promise<T>((resolve, reject) => {
			const controller = new AbortController();
			const timer = setTimeout(() => entry.cancel(), EDITOR_IO_TIMEOUT_MS);
			const signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal;
			const finish = () => {
				clearTimeout(timer);
				external?.removeEventListener("abort", entry.cancel);
			};
			const entry: Waiting = {
				userId,
				cancel: () => {
					controller.abort(timeoutError());
					const index = this.queue.indexOf(entry);
					if (index >= 0) {
						this.queue.splice(index, 1);
						finish();
						reject(timeoutError());
					}
					// Running durable dispatch is awaited to settlement; cancellation is not proof of no write.
				},
				start: () => {
					this.active.add(userId);
					void this.context.run({ userId, signal }, async () => {
						try {
							signal.throwIfAborted();
							resolve(await body(signal));
						} catch (error) {
							reject(error);
						} finally {
							finish();
							this.active.delete(userId);
							this.pump();
						}
					});
				},
			};
			external?.addEventListener("abort", entry.cancel, { once: true });
			this.queue.push(entry);
			this.pump();
		});
	}
	private pump() {
		while (this.active.size < 2) {
			const index = this.queue.findIndex((entry) => !this.active.has(entry.userId));
			if (index < 0) return;
			this.queue.splice(index, 1)[0].start();
		}
	}
	run(
		userId: string,
		request: EditorWorkerRequest,
		signal?: AbortSignal,
	): Promise<EditorWorkerResult> {
		return this.withIo(userId, (admitted) => this.worker(request, admitted), signal);
	}
	private async worker(
		request: EditorWorkerRequest,
		signal: AbortSignal,
	): Promise<EditorWorkerResult> {
		const candidates = this.resolvedWorkerSpecifier
			? [this.resolvedWorkerSpecifier]
			: (this.workerSpecifiers ?? editorWorkerSpecifierCandidates());
		let failure: unknown = new AppError(
			"No editor worker entry is available",
			503,
			"EDITOR_WORKER_FAILED",
		);
		for (const specifier of candidates.slice(0, 3)) {
			signal.throwIfAborted();
			let ready = false;
			try {
				return await this.workerAt(specifier, request, signal, () => {
					ready = true;
					this.resolvedWorkerSpecifier = specifier;
				});
			} catch (error) {
				// A readiness acknowledgement is the no-replay boundary. The job may have
				// created a source/conflict/receipt object even if its reply was lost.
				if (ready || signal.aborted) throw error;
				failure = error;
			}
		}
		throw failure;
	}
	private async workerAt(
		specifier: string,
		request: EditorWorkerRequest,
		signal: AbortSignal,
		onReady: () => void,
	): Promise<EditorWorkerResult> {
		const started = performance.now();
		let worker: Worker | undefined;
		let abort: (() => void) | undefined;
		let exited = false;
		let ready = false;
		let startupTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await new Promise<EditorWorkerResult>((resolve, reject) => {
				abort = () => reject(timeoutError());
				signal.addEventListener("abort", abort, { once: true });
				if (signal.aborted) {
					abort();
					return;
				}
				worker = new Worker(new URL(specifier));
				startupTimer = setTimeout(
					() =>
						reject(new AppError("Editor worker did not become ready", 503, "EDITOR_WORKER_FAILED")),
					WORKER_READY_TIMEOUT_MS,
				);
				let response: { result?: EditorWorkerResult; error?: string } | undefined;
				worker.once("error", reject);
				worker.once("exit", (code) => {
					exited = true;
					if (code !== 0 || !response)
						reject(
							new AppError("Editor worker exited without a result", 500, "EDITOR_WORKER_FAILED"),
						);
					else if (response.error || !response.result)
						reject(
							new AppError(response.error ?? "Editor worker failed", 422, "EDITOR_INVALID_CONTENT"),
						);
					else resolve(response.result);
				});
				worker.on(
					"message",
					(message: {
						type?: string;
						version?: number;
						result?: EditorWorkerResult;
						error?: string;
					}) => {
						if (!ready) {
							if (message.type !== "editor-worker-ready" || message.version !== 1) {
								reject(
									new AppError(
										"Invalid editor worker readiness handshake",
										503,
										"EDITOR_WORKER_FAILED",
									),
								);
								return;
							}
							ready = true;
							clearTimeout(startupTimer);
							onReady();
							try {
								signal.throwIfAborted();
								worker?.postMessage(request);
							} catch (error) {
								reject(error);
							}
							return;
						}
						if (message.type === "editor-worker-ready") return;
						response = message;
					},
				);
			});
		} finally {
			clearTimeout(startupTimer);
			if (abort) signal.removeEventListener("abort", abort);
			// Await worker exit before letting callers unlink its files or release reservations.
			// Normal jobs close their port and exit themselves. Force termination is reserved
			// for cancellation/failure, not raced against every successful postMessage.
			if (!exited) await worker?.terminate();
			if (performance.now() - started > 1000)
				logger.warn("Slow editor worker", {
					action: request.action,
					elapsedMs: Math.round(performance.now() - started),
				});
		}
	}
}
