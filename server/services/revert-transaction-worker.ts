import { Worker } from "node:worker_threads";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";
import { isCompiledRuntime } from "../lib/runtime-target";
import type { TransactionManifestRequest } from "./revert-transaction-manifest-worker";

export class RevertTransactionError extends AppError {
	constructor(code: string) {
		super(`Local revert transaction refused: ${code}`, 409, `REVERT_TRANSACTION_${code}`);
		this.name = "RevertTransactionError";
	}
}

/** Compiled modules share the binary's import.meta.url; extra entries become .js. */
export function revertManifestWorkerSpecifiers(
	compiled = isCompiledRuntime(),
	moduleUrl = import.meta.url,
): string[] {
	const paths = compiled
		? [
				"./services/revert-transaction-manifest-worker.js",
				"./server/services/revert-transaction-manifest-worker.js",
				"./revert-transaction-manifest-worker.js",
			]
		: ["./revert-transaction-manifest-worker.ts"];
	return paths.map((path) => new URL(path, moduleUrl).href);
}

/** Preserve Bun's Windows virtual module key instead of converting it to backslashes. */
export function revertManifestWorkerEntryPoint(specifier: string): string | URL {
	const url = new URL(specifier);
	if (url.protocol === "file:" && /^\/[a-z]:\/(?:~BUN|%7eBUN)\/root\//i.test(url.pathname)) {
		return decodeURIComponent(url.pathname.slice(1));
	}
	return url;
}

const READY_TIMEOUT_MS = 5_000;
interface WorkerOptions {
	/** Trusted test seams, never supplied by HTTP. Only startup probing may retry. */
	specifiers?: readonly string[];
	readyTimeoutMs?: number;
}

export async function runRevertManifestWorker<T>(
	request: TransactionManifestRequest,
	signal: AbortSignal,
	options: WorkerOptions = {},
): Promise<T> {
	signal.throwIfAborted();
	const timeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > READY_TIMEOUT_MS)
		throw new RevertTransactionError("MANIFEST_WORKER_TIMEOUT");
	let failure = new RevertTransactionError("MANIFEST_WORKER_FAILED");
	for (const specifier of (options.specifiers ?? revertManifestWorkerSpecifiers()).slice(0, 3)) {
		signal.throwIfAborted();
		let ready = false;
		try {
			return await workerAt<T>(specifier, request, signal, timeoutMs, () => {
				ready = true;
			});
		} catch (error) {
			// Once ready, the request may have been sent. Never retry validation failures,
			// crashes after dispatch, or cancellation, and never replay the transaction.
			if (ready || signal.aborted) throw error;
			failure = error as RevertTransactionError;
		}
	}
	throw failure;
}

async function workerAt<T>(
	specifier: string,
	request: TransactionManifestRequest,
	signal: AbortSignal,
	timeoutMs: number,
	onReady: () => void,
): Promise<T> {
	let thread: Worker | undefined;
	let abort: (() => void) | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let ready = false;
	let settled = false;
	try {
		return await new Promise<T>((resolve, reject) => {
			const refuse = (error: unknown) => {
				if (settled) return;
				settled = true;
				reject(error);
			};
			abort = () => refuse(new RevertTransactionError("MANIFEST_CANCELLED"));
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) return abort();
			thread = new Worker(revertManifestWorkerEntryPoint(specifier));
			timer = setTimeout(
				() => refuse(new RevertTransactionError("MANIFEST_WORKER_TIMEOUT")),
				timeoutMs,
			);
			thread.once("error", refuse);
			thread.once("exit", () => refuse(new RevertTransactionError("MANIFEST_WORKER_EXITED")));
			thread.on("message", (message: unknown) => {
				if (settled) return;
				if (!message || typeof message !== "object") {
					refuse(new RevertTransactionError("MANIFEST_WORKER_PROTOCOL"));
					return;
				}
				if (!ready) {
					if (
						!("type" in message) ||
						message.type !== "revert-manifest-worker-ready" ||
						!("version" in message) ||
						message.version !== 1
					) {
						refuse(new RevertTransactionError("MANIFEST_WORKER_PROTOCOL"));
						return;
					}
					ready = true;
					clearTimeout(timer);
					onReady();
					if (signal.aborted) return abort?.();
					try {
						thread?.postMessage(request);
					} catch (error) {
						refuse(error);
					}
					return;
				}
				if ("error" in message) {
					// Only validation codes cross the public boundary, never parser excerpts,
					// filesystem paths, or arbitrary exception text containing manifest data.
					const code =
						typeof message.error === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(message.error)
							? message.error
							: "INVALID_MANIFEST";
					refuse(new RevertTransactionError(code));
				} else if ("value" in message) {
					settled = true;
					resolve(message.value as T);
				} else refuse(new RevertTransactionError("MANIFEST_WORKER_PROTOCOL"));
			});
		});
	} catch (error) {
		if (!ready && !signal.aborted) {
			logger.warn("Revert manifest worker failed before ready", {
				specifier: specifier.slice(0, 1024),
				error: (error instanceof Error ? error.message : String(error)).slice(0, 1024),
			});
		}
		throw error instanceof RevertTransactionError
			? error
			: new RevertTransactionError("MANIFEST_WORKER_FAILED");
	} finally {
		settled = true;
		clearTimeout(timer);
		if (abort) signal.removeEventListener("abort", abort);
		await thread?.terminate();
	}
}
