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
	gitStatusPageSourceIdentity,
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
				job.request.operation === "read-on-demand"
					? await engine.readOnDemand(job.request, job.controller.signal, readRemote)
					: job.request.operation === "stats-on-demand"
						? await engine.readStatsOnDemand(job.request, job.controller.signal, readStats)
						: job.request.operation === "observe"
							? await engine.observe(
									job.request,
									job.controller.signal,
									readRemote,
									readStats,
									(cache) => post({ action: "cache-published", id: job.id, cache }),
								)
							: job.request.operation === "cache-state"
								? engine.cacheState(job.request)
								: job.request.operation === "stats"
									? await engine.readStats(job.request, job.controller.signal, readStats)
									: job.request.operation === "validate"
										? await engine.validateSnapshots(job.request, job.controller.signal, readRemote)
										: job.request.operation === "assert"
											? await engine.assertScope(job.request, job.controller.signal, readRemote)
											: await engine.read(job.request, job.controller.signal, readRemote);
			job.controller.signal.throwIfAborted();
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
			const index = queue.findIndex(
				(candidate) =>
					candidate.request.operation !== "read-on-demand" ||
					![...running.values()].some(
						(active) =>
							active.request.operation === "read-on-demand" &&
							active.request.scope.queryKey === candidate.request.scope.queryKey &&
							gitStatusPageSourceIdentity(active.request.source) ===
								gitStatusPageSourceIdentity(candidate.request.source),
					),
			);
			if (index < 0) break;
			const [job] = queue.splice(index, 1);
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
			engine.close();
			for (const job of queue.splice(0))
				fail(job.id, new GitStatusPageError("GIT_STATUS_PAGE_CLOSED"));
			for (const job of running.values()) cancel(job, "GIT_STATUS_PAGE_CLOSED");
			maybeClose();
			return;
		}
		if (message.action === "invalidate-stats") {
			engine.invalidateStats(message.queryKey);
			return;
		}
		if (message.action === "invalidate") {
			engine.invalidate(message.queryKey);
			return;
		}
		if (message.action === "retain") {
			engine.retain(message.queryKey, message.sourceIdentity);
			return;
		}
		if (message.action === "release") {
			engine.release(message.queryKey, message.sourceIdentity);
			const owns = (job: Job) =>
				job.request.scope.queryKey === message.queryKey &&
				(message.sourceIdentity === undefined ||
					gitStatusPageSourceIdentity(job.request.source) === message.sourceIdentity);
			for (const job of running.values()) if (owns(job)) cancel(job, "GIT_STATUS_PAGE_CANCELLED");
			for (let index = queue.length - 1; index >= 0; index--) {
				if (!owns(queue[index])) continue;
				const [job] = queue.splice(index, 1);
				fail(job.id, new GitStatusPageError("GIT_STATUS_PAGE_CANCELLED"));
			}
			return;
		}
		if (message.action === "cancel") {
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
			if (
				!["observe", "validate", "assert", "read-on-demand", "stats-on-demand"].includes(
					message.request.operation ?? "",
				)
			) {
				const job = { id: message.id, request: message.request, controller: new AbortController() };
				running.set(job.id, job);
				void execute(job);
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
