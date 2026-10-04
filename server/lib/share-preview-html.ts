import { Worker } from "node:worker_threads";
import { SHARE_HTML_TIMEOUT_MS } from "../../shared/share-preview";
import { AppError } from "./errors";
import { logger } from "./logger";
import { isCompiledRuntime } from "./runtime-target";

export function shareHtmlWorkerSpecifiers(
	compiled = isCompiledRuntime(),
	moduleUrl = import.meta.url,
): string[] {
	return (
		compiled
			? [
					"./lib/share-preview-worker.js",
					"./server/lib/share-preview-worker.js",
					"./share-preview-worker.js",
				]
			: ["./share-preview-worker.ts"]
	).map((path) => new URL(path, moduleUrl).href);
}
/** Preserve Bun's Windows embedded module key, instead of converting it to backslashes. */
export function shareHtmlWorkerEntry(specifier: string): string | URL {
	const url = new URL(specifier);
	return url.protocol === "file:" && /^\/[a-z]:\/(?:~BUN|%7eBUN)\/root\//i.test(url.pathname)
		? decodeURIComponent(url.pathname.slice(1))
		: url;
}
let activeWorkers = 0;
let resolvedSpecifier: string | undefined;

/** Public endpoint: bounded concurrency, no unbounded pending queue; total job budget includes startup probes. */
export async function renderShareHtml(path: string, externalSignal: AbortSignal): Promise<string> {
	if (activeWorkers >= 2)
		throw new AppError("Preview busy; please retry", 429, "SHARE_PREVIEW_BUSY");
	externalSignal.throwIfAborted();
	const signal = AbortSignal.any([externalSignal, AbortSignal.timeout(SHARE_HTML_TIMEOUT_MS)]);
	activeWorkers++;
	const started = performance.now();
	try {
		let failure: unknown;
		for (const specifier of resolvedSpecifier ? [resolvedSpecifier] : shareHtmlWorkerSpecifiers()) {
			signal.throwIfAborted();
			let ready = false;
			try {
				return await workerAt(specifier, path, signal, () => {
					ready = true;
					resolvedSpecifier = specifier;
				});
			} catch (error) {
				if (ready || signal.aborted) throw error;
				failure = error;
			}
		}
		throw (
			failure ?? new AppError("HTML preview worker is unavailable", 503, "SHARE_PREVIEW_FAILED")
		);
	} finally {
		activeWorkers--;
		const elapsedMs = performance.now() - started;
		if (elapsedMs > 250) logger.warn("Slow share HTML preview", { elapsedMs });
	}
}

async function workerAt(
	specifier: string,
	path: string,
	signal: AbortSignal,
	onReady: () => void,
): Promise<string> {
	let worker: Worker | undefined;
	let abort: (() => void) | undefined;
	try {
		return await new Promise<string>((resolve, reject) => {
			worker = new Worker(shareHtmlWorkerEntry(specifier));
			abort = () =>
				reject(new AppError("HTML preview cancelled or timed out", 504, "SHARE_PREVIEW_TIMEOUT"));
			signal.addEventListener("abort", abort, { once: true });
			worker.once("error", reject);
			worker.once("exit", (code) =>
				reject(new AppError(`HTML preview worker exited (${code})`, 500, "SHARE_PREVIEW_FAILED")),
			);
			let ready = false;
			worker.on("message", (message: { ready?: boolean; html?: string; error?: string }) => {
				if (!ready && message.ready === true) {
					ready = true;
					onReady();
					worker?.postMessage(path);
				} else if (ready && typeof message.html === "string") resolve(message.html);
				else
					reject(new AppError(message.error ?? "HTML preview failed", 422, "SHARE_PREVIEW_FAILED"));
			});
			if (signal.aborted) abort();
		});
	} finally {
		if (abort) signal.removeEventListener("abort", abort);
		if (worker) await worker.terminate();
	}
}
