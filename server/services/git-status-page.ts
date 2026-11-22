import type { Worker } from "node:worker_threads";
import type { GitLineStats } from "../../shared/git-line-stats";
import {
	GIT_STATUS_PAGE_MAX_LIMIT,
	type GitStatusPage,
	type GitStatusPageCacheState,
	type GitStatusPageQuery,
	type GitStatusPageResult,
	type GitStatusPageScopeProof,
	type GitStatusPageStatsQuery,
	type GitStatusPageStatsResponse,
	type GitStatusPageStatsResult,
	type GitStatusPageValidation,
	isGitStatusFilterChar,
} from "../../shared/git-status-page";
import { compiledWorkerSpecifiers, connectCompiledWorker } from "../lib/compiled-worker";
import { logger } from "../lib/logger";
import { WorkerCleanupError, type WorkerHandle } from "../lib/worker-runtime/lifecycle";
import { TaskQueue, TaskQueueError, type TaskQueuePermit } from "../lib/worker-runtime/queue";
import {
	GIT_STATUS_PAGE_CONCURRENCY,
	GIT_STATUS_PAGE_QUEUE,
	GIT_STATUS_PAGE_RAW_MAX_CHARS,
	GitStatusPageError,
	type GitStatusPageScope,
	type GitStatusPageSource,
	type GitStatusPageWorkerInput,
	type GitStatusPageWorkerOutput,
	type GitStatusPageWorkerValue,
	gitStatusPageScopesOverlap,
	gitStatusPageSourceIdentity,
} from "./git-status-page-protocol";

import { validateGitStatusPageStatsQuery } from "./git-status-page-stats";

export type {
	GitStatusPageRawResult,
	GitStatusPageScope,
	GitStatusPageSource,
} from "./git-status-page-protocol";
export { GitStatusPageError } from "./git-status-page-protocol";

export interface ReadGitStatusPageOptions {
	scope: GitStatusPageScope;
	query: GitStatusPageQuery;
	source: GitStatusPageSource;
	signal?: AbortSignal;
}
export interface ReadGitStatusPageStatsOptions extends Omit<ReadGitStatusPageOptions, "query"> {
	query: GitStatusPageStatsQuery;
	/** Used by producers and by the legacy on-demand statistics endpoint. */
	readStats?: (signal: AbortSignal) => Promise<GitLineStats>;
}
export interface ValidateGitStatusPagesOptions {
	queryKey: string;
	source: GitStatusPageSource;
	signal?: AbortSignal;
}
export interface AssertGitStatusPageScopeOptions {
	scope: GitStatusPageScope;
	source: GitStatusPageSource;
	proof: GitStatusPageScopeProof;
	files: string[];
	signal?: AbortSignal;
}
export interface ObserveGitStatusPagesOptions extends ValidateGitStatusPagesOptions {
	readStats: (signal: AbortSignal) => Promise<GitLineStats>;
	onPublished?: (cache: GitStatusPageCacheState) => void;
}
interface TaskOptions extends ReadGitStatusPageOptions {
	operation?:
		| "validate"
		| "assert"
		| "stats"
		| "observe"
		| "cache-state"
		| "read-on-demand"
		| "stats-on-demand";
	onPublished?: (cache: GitStatusPageCacheState) => void;
	statsQuery?: GitStatusPageStatsQuery;
	readStats?: ReadGitStatusPageStatsOptions["readStats"];
	proof?: GitStatusPageScopeProof;
	files?: string[];
}
interface Pending {
	startedAt: number;
	options: TaskOptions;
	controller: AbortController;
	resolve: (value: GitStatusPageWorkerValue) => void;
	reject: (error: unknown) => void;
	cleanup: () => void;
	sent: boolean;
	remoteStarted: boolean;
	admitted: boolean;
	invalidated?: boolean;
	released?: boolean;
	dispatching?: Promise<void>;
	permit?: TaskQueuePermit;
}

function statisticsCancellation(reason: unknown): unknown {
	if (reason instanceof DOMException && reason.name === "AbortError") {
		const error = new GitStatusPageError("GIT_STATUS_PAGE_CANCELLED");
		error.cause = reason;
		return error;
	}
	return reason;
}

/** The parent retains only request metadata and current-page promises, never snapshot arrays. */
export class GitStatusPageService {
	private worker: Worker | undefined;
	private handle: WorkerHandle<Worker> | undefined;
	private connecting: Promise<Worker> | undefined;
	private retiring: Promise<void> | undefined;
	private readonly admission = new TaskQueue({
		concurrency: GIT_STATUS_PAGE_CONCURRENCY,
		maxQueued: GIT_STATUS_PAGE_QUEUE,
	});
	private readonly startup = new AbortController();
	private readonly pending = new Map<number, Pending>();
	private readonly leases = new Map<string, number>();
	private readonly statisticsReads = new Map<
		number,
		{ queryKey: string; controller: AbortController }
	>();
	private nextId = 0;
	private closed = false;
	private closing: Promise<void> | undefined;
	private onClosed: (() => void) | undefined;

	read(options: ReadGitStatusPageOptions): Promise<GitStatusPageResult> {
		return this.submit(options) as Promise<GitStatusPageResult>;
	}

	readOnDemand(options: ReadGitStatusPageOptions): Promise<GitStatusPage> {
		return this.submit({ ...options, operation: "read-on-demand" }) as Promise<GitStatusPage>;
	}

	readStatsOnDemand(options: ReadGitStatusPageStatsOptions): Promise<GitStatusPageStatsResult> {
		if (options.signal?.aborted)
			return Promise.reject(statisticsCancellation(options.signal.reason));
		validateGitStatusPageStatsQuery(options.query);
		return this.submit({
			...options,
			query: { filter: options.query.filter },
			statsQuery: options.query,
			operation: "stats-on-demand",
		}) as Promise<GitStatusPageStatsResult>;
	}

	readStats(options: ReadGitStatusPageStatsOptions): Promise<GitStatusPageStatsResponse> {
		if (this.closed) return Promise.reject(new GitStatusPageError("GIT_STATUS_PAGE_CLOSED"));
		if (options.signal?.aborted)
			return Promise.reject(statisticsCancellation(options.signal.reason));
		try {
			validateGitStatusPageStatsQuery(options.query);
		} catch (error) {
			return Promise.reject(error);
		}
		return this.submit({
			...options,
			query: { filter: options.query.filter },
			statsQuery: options.query,
			operation: "stats",
		}) as Promise<GitStatusPageStatsResponse>;
	}

	validate(options: ValidateGitStatusPagesOptions): Promise<GitStatusPageValidation> {
		if (this.closed) return Promise.reject(new GitStatusPageError("GIT_STATUS_PAGE_CLOSED"));
		if (options.signal?.aborted) return Promise.reject(options.signal.reason);
		return this.submit({
			scope: { actorId: "git-watch", workspaceKey: "git-watch", queryKey: options.queryKey },
			query: {},
			source: options.source,
			signal: options.signal,
			operation: "validate",
		}) as Promise<GitStatusPageValidation>;
	}

	observe(options: ObserveGitStatusPagesOptions): Promise<GitStatusPageCacheState> {
		return this.submit({
			...options,
			scope: { actorId: "git-watch", workspaceKey: "git-watch", queryKey: options.queryKey },
			query: {},
			operation: "observe",
		}) as Promise<GitStatusPageCacheState>;
	}

	cacheState(options: ValidateGitStatusPagesOptions): Promise<GitStatusPageCacheState> {
		return this.submit({
			...options,
			scope: { actorId: "git-watch", workspaceKey: "git-watch", queryKey: options.queryKey },
			query: {},
			operation: "cache-state",
		}) as Promise<GitStatusPageCacheState>;
	}

	retain(queryKey: string, source?: GitStatusPageSource): void {
		const sourceIdentity = source && gitStatusPageSourceIdentity(source);
		const key = JSON.stringify([queryKey, sourceIdentity ?? null]);
		const count = this.leases.get(key) ?? 0;
		if (count === 0 && this.leases.size >= 128)
			throw new GitStatusPageError("GIT_STATUS_PAGE_BUSY");
		this.leases.set(key, count + 1);
		if (count === 0) this.post({ action: "retain", queryKey, sourceIdentity });
	}
	release(queryKey: string, source?: GitStatusPageSource): void {
		const sourceIdentity = source && gitStatusPageSourceIdentity(source);
		const key = JSON.stringify([queryKey, sourceIdentity ?? null]);
		const count = this.leases.get(key) ?? 0;
		if (count > 1) {
			this.leases.set(key, count - 1);
			return;
		}
		this.leases.delete(key);
		for (const pending of this.pending.values())
			if (
				pending.options.scope.queryKey === queryKey &&
				(sourceIdentity === undefined ||
					gitStatusPageSourceIdentity(pending.options.source) === sourceIdentity) &&
				["observe", "validate", "assert"].includes(pending.options.operation ?? "")
			) {
				pending.invalidated = true;
				pending.released = true;
			}
		this.post({ action: "release", queryKey, sourceIdentity });
	}

	async assertScope(options: AssertGitStatusPageScopeOptions): Promise<void> {
		if (
			!Array.isArray(options.files) ||
			options.files.length === 0 ||
			options.files.length > 10_000 ||
			options.files.some((file) => typeof file !== "string")
		)
			throw new GitStatusPageError("GIT_STATUS_PAGE_EXPIRED");
		let chars = 0;
		for (const file of options.files) chars += file.length;
		if (chars > GIT_STATUS_PAGE_RAW_MAX_CHARS)
			throw new GitStatusPageError("GIT_STATUS_PAGE_EXPIRED");
		await this.submit({ ...options, query: { filter: options.proof.filter }, operation: "assert" });
	}

	private submit(options: TaskOptions): Promise<GitStatusPageWorkerValue> {
		if (this.closed) return Promise.reject(new GitStatusPageError("GIT_STATUS_PAGE_CLOSED"));
		if (options.signal?.aborted) return Promise.reject(options.signal.reason);
		const { cursor, filter, limit } = options.query;
		if (
			(cursor !== undefined &&
				(typeof cursor !== "string" || cursor.length === 0 || cursor.length > 2048)) ||
			(filter !== undefined &&
				(!Array.isArray(filter) || filter.length > 6 || !filter.every(isGitStatusFilterChar))) ||
			(limit !== undefined &&
				(!Number.isInteger(limit) || limit < 1 || limit > GIT_STATUS_PAGE_MAX_LIMIT))
		)
			return Promise.reject(new GitStatusPageError("GIT_STATUS_PAGE_INVALID_QUERY"));
		for (const value of [
			options.scope.actorId,
			options.scope.workspaceKey,
			options.scope.queryKey,
			options.source.kind === "local" ? options.source.cwd : options.source.identity,
		])
			if (typeof value !== "string" || value.length === 0 || value.length > 16_384)
				return Promise.reject(new GitStatusPageError("GIT_STATUS_PAGE_INVALID_QUERY"));
		if (this.pending.size >= GIT_STATUS_PAGE_CONCURRENCY + GIT_STATUS_PAGE_QUEUE)
			return Promise.reject(new GitStatusPageError("GIT_STATUS_PAGE_BUSY"));
		const id = ++this.nextId;
		const promise = new Promise<GitStatusPageWorkerValue>((resolve, reject) => {
			const controller = new AbortController();
			const abort = () => {
				controller.abort(
					options.operation === "stats" || options.operation === "stats-on-demand"
						? statisticsCancellation(options.signal?.reason)
						: options.signal?.reason,
				);
				const pending = this.pending.get(id);
				if (!pending) return;
				if (pending.sent) {
					// Preserve port order for already admitted readers sharing this source/bridge.
					const dispatches = [...this.pending.values()].flatMap((read) =>
						read.admitted && !read.sent && read.dispatching ? [read.dispatching] : [],
					);
					const cancel = () => {
						if (this.pending.get(id) === pending) this.post({ action: "cancel", id });
					};
					if (dispatches.length) void Promise.all(dispatches).then(cancel);
					else cancel();
				} else this.finish(id, undefined, new GitStatusPageError("GIT_STATUS_PAGE_CANCELLED"));
			};
			this.pending.set(id, {
				startedAt: performance.now(),
				options,
				controller,
				resolve,
				reject,
				sent: false,
				remoteStarted: false,
				admitted: false,
				cleanup: () => options.signal?.removeEventListener("abort", abort),
			});
			options.signal?.addEventListener("abort", abort, { once: true });
			if (options.signal?.aborted) abort();
		});
		const pending = this.pending.get(id);
		if (pending) pending.dispatching = this.dispatch(id);
		return promise;
	}

	private dirtyPending(queryKey: string, includePages = true): void {
		for (const pending of this.pending.values())
			if (
				(["observe", "validate", "stats-on-demand"].includes(pending.options.operation ?? "") ||
					(includePages &&
						["assert", "read-on-demand"].includes(pending.options.operation ?? ""))) &&
				gitStatusPageScopesOverlap(pending.options.scope.queryKey, queryKey)
			)
				pending.invalidated = true;
	}
	invalidateStats(queryKey: string): void {
		this.dirtyPending(queryKey, false);
		this.post({ action: "invalidate-stats", queryKey });
	}

	invalidate(queryKey: string): void {
		// The parent remembers dirty generations even before the Worker has connected.
		this.dirtyPending(queryKey);
		this.post({ action: "invalidate", queryKey });
	}

	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		const drained = this.admission.close(new GitStatusPageError("GIT_STATUS_PAGE_CLOSED"));
		this.startup.abort(new GitStatusPageError("GIT_STATUS_PAGE_CLOSED"));
		for (const read of this.statisticsReads.values())
			read.controller.abort(new GitStatusPageError("GIT_STATUS_PAGE_CLOSED"));
		this.statisticsReads.clear();
		for (const [id, pending] of this.pending) {
			pending.controller.abort(new GitStatusPageError("GIT_STATUS_PAGE_CLOSED"));
			if (!pending.sent)
				this.finish(id, undefined, new GitStatusPageError("GIT_STATUS_PAGE_CLOSED"));
		}
		this.closing = (async () => {
			try {
				await this.connecting;
			} catch {
				/* startup cancellation */
			}
			const worker = this.worker;
			const handle = this.handle;
			if (worker && handle) {
				await new Promise<void>((resolve) => {
					this.onClosed = resolve;
					worker.ref();
					this.post({ action: "close" });
				});
				// The ACK drains owned Git subprocesses; the Handle then confirms native exit.
				await this.retire(handle);
				this.worker = undefined;
				this.handle = undefined;
			}
			await this.retiring;
			await drained;
		})();
		return this.closing;
	}

	private async dispatch(id: number): Promise<void> {
		let permit: TaskQueuePermit | undefined;
		try {
			const waiting = this.pending.get(id);
			if (!waiting) return;
			// Cache projections must not queue behind a scan or a numstat bridge.
			if (
				["observe", "validate", "assert", "read-on-demand", "stats-on-demand"].includes(
					waiting.options.operation ?? "",
				)
			) {
				const active = this.admission.stats.active;
				const acquiring = this.admission.acquire({
					signal: waiting.controller.signal,
					deadlineAt: Infinity,
				});
				waiting.admitted = this.admission.stats.active > active;
				permit = await acquiring;
			}
			waiting.admitted = true;
			if (!this.pending.has(id) || this.closed) return;
			waiting.permit = permit;
			permit = undefined;
			const worker = this.worker ?? (await this.connect());
			const pending = this.pending.get(id);
			if (!pending || this.closed) return;
			if (pending.invalidated)
				throw new GitStatusPageError(
					pending.released ? "GIT_STATUS_PAGE_CANCELLED" : "GIT_STATUS_PAGE_EXPIRED",
				);
			const { scope, query, source } = pending.options;
			pending.sent = true;
			worker.ref();
			this.post({
				action: "read",
				id,
				request: {
					scope,
					query,
					operation: pending.options.operation,
					statsQuery: pending.options.statsQuery,
					proof: pending.options.proof,
					files: pending.options.files,
					source:
						source.kind === "local"
							? { kind: "local", cwd: source.cwd }
							: { kind: "remote", identity: source.identity },
				},
			});
		} catch (error) {
			this.finish(
				id,
				undefined,
				error instanceof TaskQueueError && error.code === "TASK_QUEUE_FULL"
					? new GitStatusPageError("GIT_STATUS_PAGE_BUSY")
					: error,
			);
		} finally {
			permit?.release();
		}
	}

	private connect(): Promise<Worker> {
		if (this.closed) return Promise.reject(new GitStatusPageError("GIT_STATUS_PAGE_CLOSED"));
		if (this.worker) return Promise.resolve(this.worker);
		if (this.connecting) return this.connecting;
		this.connecting = (async () => {
			// A failed owner's termination request does not free the singleton's native capacity.
			await this.retiring;
			this.startup.signal.throwIfAborted();
			const { worker, handle } = await connectCompiledWorker(
				compiledWorkerSpecifiers(
					"services/git-status-page-worker.ts",
					"./git-status-page-worker.ts",
					import.meta.url,
				),
				{ signal: this.startup.signal },
			);
			this.worker = worker;
			this.handle = handle;
			for (const key of this.leases.keys()) {
				const [queryKey, sourceIdentity] = JSON.parse(key) as [string, string | null];
				this.post({ action: "retain", queryKey, sourceIdentity: sourceIdentity ?? undefined });
			}
			worker.on("message", (message: GitStatusPageWorkerOutput) => this.receive(message));
			worker.on("error", () => this.failWorker(worker));
			worker.on("messageerror", () => this.failWorker(worker));
			worker.on("exit", () => this.failWorker(worker));
			worker.unref();
			return worker;
		})()
			.catch((error: unknown) => {
				if (error instanceof WorkerCleanupError) void this.retire(error.handle).catch(() => {});
				throw error;
			})
			.finally(() => {
				this.connecting = undefined;
			});
		return this.connecting;
	}

	private post(message: GitStatusPageWorkerInput): void {
		try {
			this.worker?.postMessage(message);
		} catch {
			if (this.worker) this.failWorker(this.worker);
		}
	}

	private receive(message: GitStatusPageWorkerOutput): void {
		if ("ready" in message) return;
		if (message.action === "closed") {
			this.onClosed?.();
			return;
		}
		if (message.action === "stats-cancel") {
			this.statisticsReads
				.get(message.readId)
				?.controller.abort(new GitStatusPageError("GIT_STATUS_PAGE_CANCELLED"));
			this.statisticsReads.delete(message.readId);
			return;
		}
		if (message.action === "stats") {
			const pending = this.pending.get(message.id);
			if (!pending?.options.readStats || this.statisticsReads.has(message.readId)) return;
			const read = {
				queryKey: pending.options.scope.queryKey,
				controller: new AbortController(),
			};
			this.statisticsReads.set(message.readId, read);
			const readStats = pending.options.readStats;
			void (async () => {
				try {
					const reason: unknown = pending.controller.signal.reason;
					if (reason instanceof GitStatusPageError && reason.code !== "GIT_STATUS_PAGE_CANCELLED")
						throw reason;
					// The Worker owns shared-read cancellation, not the request which opened the bridge.
					const result = await readStats(read.controller.signal);
					read.controller.signal.throwIfAborted();
					if (this.statisticsReads.get(message.readId) !== read) return;
					this.post({ action: "stats", id: message.readId, result });
				} catch {
					if (this.statisticsReads.get(message.readId) === read)
						this.post({ action: "stats", id: message.readId, error: "unavailable" });
				} finally {
					if (this.statisticsReads.get(message.readId) === read)
						this.statisticsReads.delete(message.readId);
				}
			})();
			return;
		}
		if (message.action === "cache-published") {
			const pending = this.pending.get(message.id);
			if (pending && !pending.invalidated && !pending.controller.signal.aborted)
				pending.options.onPublished?.(message.cache);
			return;
		}
		if (message.action === "result") {
			this.finish(message.id, message.value);
			return;
		}
		if (message.action === "error") {
			this.finish(message.id, undefined, new GitStatusPageError(message.code, message.message));
			return;
		}
		const pending = this.pending.get(message.id);
		if (!pending || pending.remoteStarted || pending.options.source.kind !== "remote") return;
		pending.remoteStarted = true;
		const source = pending.options.source;
		void (async () => {
			try {
				pending.controller.signal.throwIfAborted();
				const raw = await source.read(pending.controller.signal);
				pending.controller.signal.throwIfAborted();
				if (!this.pending.has(message.id)) return;
				// Bound transport size without parsing; Worker enforces the UTF-8 byte budget.
				if (typeof raw.stdout !== "string")
					throw new GitStatusPageError("GIT_STATUS_PAGE_SOURCE_FAILED");
				this.post({
					action: "remote",
					id: message.id,
					result: {
						stdout: raw.stdout.slice(0, GIT_STATUS_PAGE_RAW_MAX_CHARS),
						complete: raw.complete,
						limitReason:
							raw.stdout.length > GIT_STATUS_PAGE_RAW_MAX_CHARS ? "bytes" : raw.limitReason,
					},
				});
			} catch {
				if (this.pending.has(message.id))
					this.post({ action: "remote", id: message.id, error: "unavailable" });
			}
		})();
	}

	private finish(id: number, value?: GitStatusPageWorkerValue, error?: unknown): void {
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		pending.cleanup();
		if (this.retiring)
			void this.retiring.then(
				() => pending.permit?.release(),
				() => {},
			);
		else pending.permit?.release();
		const reason = pending.controller.signal.reason;
		const durationMs = Math.round(performance.now() - pending.startedAt);
		if (durationMs >= 2_000) {
			try {
				logger.warn("Slow Git status page operation", {
					operation:
						pending.options.operation === "read-on-demand"
							? "read"
							: pending.options.operation === "stats-on-demand"
								? "stats"
								: (pending.options.operation ?? "read"),
					durationMs,
					success: !this.closed && !reason && !error && value !== undefined,
				});
			} catch {}
		}
		pending.controller.abort();
		if (this.closed) pending.reject(new GitStatusPageError("GIT_STATUS_PAGE_CLOSED"));
		else if (reason) pending.reject(reason);
		else if (pending.invalidated)
			pending.reject(
				new GitStatusPageError(
					pending.released ? "GIT_STATUS_PAGE_CANCELLED" : "GIT_STATUS_PAGE_EXPIRED",
				),
			);
		else if (error) pending.reject(error);
		else if (value !== undefined) pending.resolve(value);
		else pending.reject(new GitStatusPageError("GIT_STATUS_PAGE_SOURCE_FAILED"));
		if (this.pending.size === 0 && !this.closed) this.worker?.unref();
	}

	private retire(handle: WorkerHandle<unknown>): Promise<void> {
		const retiring = handle.close().catch(async () => {
			// Failed cleanup retains ownership until its native exit, never a fabricated ACK.
			await handle.exited;
		});
		this.retiring = retiring;
		void retiring.then(
			() => {
				if (this.retiring === retiring) this.retiring = undefined;
			},
			() => {},
		);
		return retiring;
	}

	private failWorker(worker: Worker): void {
		if (this.worker !== worker) return;
		this.worker = undefined;
		if (this.handle) void this.retire(this.handle).catch(() => {});
		this.handle = undefined;
		for (const read of this.statisticsReads.values())
			read.controller.abort(new GitStatusPageError("GIT_STATUS_PAGE_SOURCE_FAILED"));
		this.statisticsReads.clear();
		for (const id of this.pending.keys())
			this.finish(
				id,
				undefined,
				new GitStatusPageError(
					this.closed ? "GIT_STATUS_PAGE_CLOSED" : "GIT_STATUS_PAGE_SOURCE_FAILED",
				),
			);
		this.onClosed?.();
	}
}

const pages = new GitStatusPageService();
export function readGitStatusPageOnDemand(
	options: ReadGitStatusPageOptions,
): Promise<GitStatusPage> {
	return pages.readOnDemand(options);
}
export function readGitStatusPageStatsOnDemand(
	options: ReadGitStatusPageStatsOptions,
): Promise<GitStatusPageStatsResult> {
	return pages.readStatsOnDemand(options);
}
export function observeGitStatusPages(
	options: ObserveGitStatusPagesOptions,
): Promise<GitStatusPageCacheState> {
	return pages.observe(options);
}
export function getGitStatusPagesCacheState(
	options: ValidateGitStatusPagesOptions,
): Promise<GitStatusPageCacheState> {
	return pages.cacheState(options);
}
export function retainGitStatusPages(queryKey: string, source?: GitStatusPageSource): void {
	pages.retain(queryKey, source);
}
export function releaseGitStatusPages(queryKey: string, source?: GitStatusPageSource): void {
	pages.release(queryKey, source);
}
export function readGitStatusPage(options: ReadGitStatusPageOptions): Promise<GitStatusPageResult> {
	return pages.read(options);
}
export function readGitStatusPageStats(
	options: ReadGitStatusPageStatsOptions,
): Promise<GitStatusPageStatsResponse> {
	return pages.readStats(options);
}
export function invalidateGitStatusPageStats(queryKey: string): void {
	pages.invalidateStats(queryKey);
}
export function invalidateGitStatusPages(queryKey: string): void {
	pages.invalidate(queryKey);
}
export function closeGitStatusPages(): Promise<void> {
	return pages.close();
}
export function validateGitStatusPages(
	options: ValidateGitStatusPagesOptions,
): Promise<GitStatusPageValidation> {
	return pages.validate(options);
}
export function assertGitStatusPageScope(options: AssertGitStatusPageScopeOptions): Promise<void> {
	return pages.assertScope(options);
}
