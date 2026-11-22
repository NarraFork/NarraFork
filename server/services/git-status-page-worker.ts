import { parentPort } from "node:worker_threads";
import type { GitLineStats } from "../../shared/git-line-stats";
import type { GitStatusPageErrorCode } from "../../shared/git-status-page";
import { GitStatusPageEngine } from "./git-status-page-engine";
import { GIT_STATUS_PAGE_SCAN_TIMEOUT_MS } from "./git-status-page-parser";
import {
	GIT_STATUS_PAGE_CONCURRENCY,
	GIT_STATUS_PAGE_QUEUE,
	GitStatusPageError,
	type GitStatusPageRawResult,
	type GitStatusPageRequest,
	type GitStatusPageWorkerInput,
	type GitStatusPageWorkerOutput,
	gitStatusPageScopesOverlap,
} from "./git-status-page-protocol";

interface Job {
	id: number;
	request: GitStatusPageRequest;
	controller: AbortController;
	remote?: { resolve: (value: GitStatusPageRawResult) => void; reject: (error: unknown) => void };
}

/** No database, settings, permissions, event bus, or application imports in this worker graph. */
const port = parentPort;
if (port) {
	const engine = new GitStatusPageEngine();
	const queue: Job[] = [];
	const running = new Map<number, Job>();
	const statisticsReads = new Map<
		number,
		{
			resolve: (value: GitLineStats) => void;
			reject: (error: unknown) => void;
			cleanup: () => void;
		}
	>();
	let nextStatisticsRead = 0;
	// A late cancellation may arrive after a result was posted but before parent accepted it.
	const completed = new Map<number, string>();
	let closing = false;
	const post = (message: GitStatusPageWorkerOutput) => port.postMessage(message);
	const fail = (id: number, error: unknown) => {
		const known = error instanceof GitStatusPageError;
		post({
			action: "error",
			id,
			code: known ? error.code : "GIT_STATUS_PAGE_SOURCE_FAILED",
			message: known ? error.message : "Git status source unavailable",
		});
	};
	const cancel = (job: Job, code: GitStatusPageErrorCode) => {
		const error = new GitStatusPageError(code);
		job.controller.abort(error);
		job.remote?.reject(error);
	};
	const maybeClose = () => {
		if (closing && running.size === 0) {
			clearInterval(sweep);
			engine.close();
			post({ action: "closed" });
			port.close();
		}
	};
	const execute = async (job: Job) => {
		const timer = setTimeout(
			() => cancel(job, "GIT_STATUS_PAGE_SOURCE_FAILED"),
			GIT_STATUS_PAGE_SCAN_TIMEOUT_MS + 1000,
		);
		try {
			const readRemote = () =>
				new Promise<GitStatusPageRawResult>((resolve, reject) => {
					job.remote = { resolve, reject };
					post({ action: "remote", id: job.id });
				});
			const readStats = (signal: AbortSignal) =>
				new Promise<GitLineStats>((resolve, reject) => {
					signal.throwIfAborted();
					const readId = ++nextStatisticsRead;
					const abort = () => {
						statisticsReads.delete(readId);
						post({ action: "stats-cancel", readId });
						reject(signal.reason);
					};
					statisticsReads.set(readId, {
						resolve,
						reject,
						cleanup: () => signal.removeEventListener("abort", abort),
					});
					signal.addEventListener("abort", abort, { once: true });
					post({ action: "stats", id: job.id, readId });
				});
			const value =
				job.request.operation === "stats"
					? await engine.readStats(job.request, job.controller.signal, readStats)
					: job.request.operation === "validate"
						? await engine.validateSnapshots(job.request, job.controller.signal, readRemote)
						: job.request.operation === "assert"
							? await engine.assertScope(job.request, job.controller.signal, readRemote)
							: await engine.read(job.request, job.controller.signal, readRemote);
			job.controller.signal.throwIfAborted();
			if (
				typeof value === "object" &&
				"snapshotId" in value &&
				!job.request.operation &&
				!job.request.query.cursor
			) {
				completed.set(job.id, value.snapshotId);
				if (completed.size > GIT_STATUS_PAGE_CONCURRENCY + GIT_STATUS_PAGE_QUEUE) {
					const oldest = completed.keys().next().value;
					if (oldest !== undefined) completed.delete(oldest);
				}
			}
			post({ action: "result", id: job.id, value });
		} catch (error) {
			fail(job.id, job.controller.signal.aborted ? job.controller.signal.reason : error);
		} finally {
			clearTimeout(timer);
			job.remote = undefined;
			running.delete(job.id);
			pump();
			maybeClose();
		}
	};
	const pump = () => {
		while (!closing && running.size < GIT_STATUS_PAGE_CONCURRENCY && queue.length) {
			const job = queue.shift();
			if (!job) break;
			running.set(job.id, job);
			void execute(job);
		}
	};
	const sweep = setInterval(() => engine.prune(), 15_000);
	sweep.unref();
	port.on("message", (message: GitStatusPageWorkerInput) => {
		if (message.action === "ping") {
			post({ ready: true });
			return;
		}
		if (message.action === "stats") {
			const read = statisticsReads.get(message.id);
			if (!read) return;
			statisticsReads.delete(message.id);
			read.cleanup();
			if (message.result) read.resolve(message.result);
			else read.reject(new GitStatusPageError("GIT_STATUS_PAGE_SOURCE_FAILED"));
			return;
		}
		if (message.action === "remote") {
			const job = running.get(message.id);
			if (!job?.remote) return;
			if (message.result) job.remote.resolve(message.result);
			else job.remote.reject(new GitStatusPageError("GIT_STATUS_PAGE_SOURCE_FAILED"));
			job.remote = undefined;
			return;
		}
		if (message.action === "close") {
			closing = true;
			completed.clear();
			engine.close();
			for (const job of queue.splice(0))
				fail(job.id, new GitStatusPageError("GIT_STATUS_PAGE_CLOSED"));
			for (const job of running.values()) cancel(job, "GIT_STATUS_PAGE_CLOSED");
			maybeClose();
			return;
		}
		if (message.action === "invalidate" || message.action === "invalidate-stats") {
			const statisticsOnly = message.action === "invalidate-stats";
			if (statisticsOnly) engine.invalidateStats(message.queryKey);
			else engine.invalidate(message.queryKey);
			for (let index = queue.length - 1; index >= 0; index--) {
				const job = queue[index];
				if (
					(statisticsOnly && job.request.operation !== "stats") ||
					!gitStatusPageScopesOverlap(job.request.scope.queryKey, message.queryKey)
				)
					continue;
				queue.splice(index, 1);
				fail(job.id, new GitStatusPageError("GIT_STATUS_PAGE_EXPIRED"));
			}
			for (const job of running.values())
				if (
					(!statisticsOnly || job.request.operation === "stats") &&
					gitStatusPageScopesOverlap(job.request.scope.queryKey, message.queryKey)
				)
					cancel(job, "GIT_STATUS_PAGE_EXPIRED");
			return;
		}
		if (message.action === "cancel") {
			const snapshotId = completed.get(message.id);
			if (snapshotId) {
				engine.releaseSnapshot(snapshotId);
				completed.delete(message.id);
			}
			const index = queue.findIndex((job) => job.id === message.id);
			if (index >= 0) {
				queue.splice(index, 1);
				fail(message.id, new GitStatusPageError("GIT_STATUS_PAGE_CANCELLED"));
			}
			const job = running.get(message.id);
			if (job) cancel(job, "GIT_STATUS_PAGE_CANCELLED");
			return;
		}
		if (message.action === "read") {
			if (closing) {
				fail(message.id, new GitStatusPageError("GIT_STATUS_PAGE_CLOSED"));
				return;
			}
			if (queue.length >= GIT_STATUS_PAGE_QUEUE && running.size >= GIT_STATUS_PAGE_CONCURRENCY) {
				fail(message.id, new GitStatusPageError("GIT_STATUS_PAGE_BUSY"));
				return;
			}
			queue.push({ id: message.id, request: message.request, controller: new AbortController() });
			pump();
		}
	});
}
