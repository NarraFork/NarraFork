import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";
import { normalizePathForOS } from "../lib/platform-path";
import type { GitStatusSummary } from "./git-service";

type Loader<T> = (signal: AbortSignal) => Promise<T>;
interface Waiter<T> {
	resolve(value: T): void;
	reject(error: unknown): void;
	cleanup(): void;
}
interface Job<T> {
	key: string;
	loader: Loader<T>;
	controller: AbortController;
	waiters: Set<Waiter<T>>;
	state: "queued" | "running" | "finished";
	invalidated: boolean;
	discardResult?: boolean;
	createdAt: number;
	startedAt?: number;
	queueDepth: number;
	runningAtStart?: number;
	source: "miss" | "dirty" | "expired" | "bypass" | "trailing";
	trailing: boolean;
	readers: number;
	peakReaders: number;
	outcome?: "success" | "error";
	timer?: ReturnType<typeof setTimeout>;
}
interface Entry<T> {
	current: Job<T>;
	next?: Job<T>;
}

/** Stable log-only scope identity; never emit repository paths or remote query keys. */
export function getGitStatusQueryScopeId(key: string): string {
	return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export function getLocalGitStatusQueryKey(path: string): string {
	return JSON.stringify(["local", normalizePathForOS(resolve(path), process.platform)]);
}

/** A root write also invalidates scoped file-tree reads, and vice versa. */
export function localGitStatusScopesOverlap(key: string, rawPath: string): boolean {
	let parts: unknown;
	try {
		parts = JSON.parse(key);
	} catch {
		return false;
	}
	if (!Array.isArray(parts) || parts[0] !== "local" || typeof parts[1] !== "string") return false;
	const scope = parts[1];
	const changed = normalizePathForOS(resolve(rawPath), process.platform);
	const within = (path: string, parent: string) =>
		path === parent || path.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
	return within(scope, changed) || within(changed, scope);
}

export const GIT_QUERY_CACHE_MAX_ENTRIES = 128;
export const GIT_STATUS_TTL_MS = 3000;

/** Single flight and bounded results per target, with one trailing refresh after invalidation. */
export class GitStatusQueryCoordinator<T = GitStatusSummary> {
	private entries = new Map<string, Entry<T>>();
	private results = new Map<string, { value: T; producedAt: number; dirty: boolean }>();
	private queue: Job<T>[] = [];
	private running = 0;
	private clearing = false;

	constructor(
		private readonly limits = { concurrency: 4, queued: 128, timeoutMs: 30_000 },
		private readonly ttlMs = GIT_STATUS_TTL_MS,
	) {}

	query(key: string, loader: Loader<T>, options: { signal?: AbortSignal; ttlMs?: number } = {}) {
		const signal = options.signal;
		if (signal?.aborted) return Promise.reject(signal.reason);
		const cached = this.results.get(key);
		const ttl = options.ttlMs ?? this.ttlMs;
		if (cached && !cached.dirty && ttl > 0 && Date.now() - cached.producedAt < ttl) {
			this.results.delete(key);
			this.results.set(key, cached);
			return Promise.resolve(cached.value);
		}
		const entry = this.entries.get(key);
		let job = entry
			? entry.current.invalidated || entry.current.controller.signal.aborted
				? entry.next
				: entry.current
			: undefined;
		if (!job) {
			if (
				this.queue.length >= this.limits.queued &&
				(entry || this.running >= this.limits.concurrency)
			) {
				return Promise.reject(
					new AppError("Git status queue is full; retry shortly", 503, "GIT_STATUS_BUSY"),
				);
			}
			job = {
				key,
				loader,
				controller: new AbortController(),
				waiters: new Set(),
				state: "queued",
				invalidated: false,
				createdAt: performance.now(),
				queueDepth: this.queue.length,
				trailing: entry?.current.invalidated === true,
				source: entry?.current.invalidated
					? "trailing"
					: !cached
						? "miss"
						: cached.dirty
							? "dirty"
							: ttl <= 0
								? "bypass"
								: "expired",
				readers: 0,
				peakReaders: 0,
			};
			if (entry) entry.next = job;
			else this.entries.set(key, { current: job });
			this.queue.push(job);
			const pending = job;
			job.timer = setTimeout(() => {
				this.cancel(pending, new Error("Git status query timed out"));
			}, this.limits.timeoutMs);
		}
		const shared = job;
		if (shared.waiters.size >= 256)
			return Promise.reject(
				new AppError("Too many Git status readers; retry shortly", 503, "GIT_STATUS_BUSY"),
			);
		const result = new Promise<T>((resolve, reject) => {
			const abort = () => {
				shared.waiters.delete(waiter);
				waiter.cleanup();
				reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
				if (shared.waiters.size === 0)
					this.cancel(shared, new DOMException("No remaining status readers", "AbortError"));
			};
			const waiter: Waiter<T> = {
				resolve,
				reject,
				cleanup: () => signal?.removeEventListener("abort", abort),
			};
			shared.waiters.add(waiter);
			shared.readers++;
			shared.peakReaders = Math.max(shared.peakReaders, shared.waiters.size);
			signal?.addEventListener("abort", abort, { once: true });
		});
		this.pump();
		return result;
	}

	peek(key: string): T | null {
		return this.results.get(key)?.value ?? null;
	}

	get size(): number {
		return this.results.size;
	}

	/** A matching filesystem fingerprint can renew only an existing, clean result. */
	validate(key: string): void {
		const cached = this.results.get(key);
		if (cached && !cached.dirty) cached.producedAt = Date.now();
	}

	drop(key: string): void {
		this.invalidate(key);
		this.results.delete(key);
		const entry = this.entries.get(key);
		if (entry) entry.current.discardResult = true;
		if (entry?.next) entry.next.discardResult = true;
	}

	dropMatching(matches: (key: string) => boolean): void {
		for (const key of new Set([...this.results.keys(), ...this.entries.keys()])) {
			if (matches(key)) this.drop(key);
		}
	}

	invalidate(key: string): void {
		const cached = this.results.get(key);
		if (cached) cached.dirty = true;
		const job = this.entries.get(key)?.current;
		// A queued query has not observed the repository yet, so it is already fresh.
		if (job?.state === "running") job.invalidated = true;
	}

	invalidateMatching(matches: (key: string) => boolean): void {
		for (const key of new Set([...this.results.keys(), ...this.entries.keys()])) {
			if (matches(key)) this.invalidate(key);
		}
	}

	clear(): void {
		this.results.clear();
		this.clearing = true;
		try {
			for (const entry of [...this.entries.values()]) {
				if (entry.next) this.cancel(entry.next, new DOMException("Status reset", "AbortError"));
				this.cancel(entry.current, new DOMException("Status reset", "AbortError"));
			}
		} finally {
			this.clearing = false;
		}
	}

	private cancel(job: Job<T>, error: unknown): void {
		if (job.state === "finished") return;
		job.controller.abort(error);
		this.settle(job, undefined, error);
		// Running work keeps its slot until its subprocess actually exits.
		if (job.state === "queued") this.finish(job);
	}

	private settle(job: Job<T>, value?: T, error?: unknown): void {
		if (job.timer) clearTimeout(job.timer);
		for (const waiter of job.waiters) {
			waiter.cleanup();
			if (value !== undefined) waiter.resolve(value);
			else waiter.reject(error);
		}
		job.waiters.clear();
	}

	private finish(job: Job<T>): void {
		if (job.state === "finished") return;
		if (job.state === "running") this.running--;
		else this.queue = this.queue.filter((queued) => queued !== job);
		job.state = "finished";
		const finishedAt = performance.now();
		const elapsedMs = Math.round(finishedAt - job.createdAt);
		if (elapsedMs > 1000)
			logger.warn("Slow coordinated Git status", {
				scopeId: getGitStatusQueryScopeId(job.key),
				elapsedMs,
				queueMs: Math.round((job.startedAt ?? finishedAt) - job.createdAt),
				loaderMs: job.startedAt === undefined ? 0 : Math.round(finishedAt - job.startedAt),
				queueDepth: job.queueDepth,
				runningAtStart: job.runningAtStart ?? 0,
				source: job.source,
				trailing: job.trailing,
				invalidated: job.invalidated,
				shared: job.readers > 1,
				readers: job.readers,
				peakReaders: job.peakReaders,
				outcome: job.controller.signal.aborted ? "cancelled" : job.outcome,
				cancelled: job.controller.signal.aborted,
			});
		const entry = this.entries.get(job.key);
		if (entry?.current === job) {
			if (entry.next) this.entries.set(job.key, { current: entry.next });
			else this.entries.delete(job.key);
		} else if (entry?.next === job) {
			entry.next = undefined;
		}
		this.pump();
	}

	private pump(): void {
		if (this.clearing) return;
		while (this.running < this.limits.concurrency) {
			const index = this.queue.findIndex((job) => {
				const entry = this.entries.get(job.key);
				return entry?.current === job;
			});
			if (index < 0) return;
			const [job] = this.queue.splice(index, 1);
			if (!job) return;
			job.state = "running";
			this.running++;
			job.runningAtStart = this.running;
			Promise.resolve()
				.then(() => {
					job.controller.signal.throwIfAborted();
					job.startedAt = performance.now();
					return job.loader(job.controller.signal);
				})
				.then(
					(value) => {
						job.outcome = "success";
						if (!job.invalidated && !job.discardResult && !job.controller.signal.aborted) {
							this.results.delete(job.key);
							this.results.set(job.key, { value, producedAt: Date.now(), dirty: false });
							while (this.results.size > GIT_QUERY_CACHE_MAX_ENTRIES) {
								const oldest = this.results.keys().next().value;
								if (oldest !== undefined) this.results.delete(oldest);
							}
						}
						this.finish(job);
						if (!job.controller.signal.aborted) this.settle(job, value);
					},
					(error: unknown) => {
						job.outcome = "error";
						this.finish(job);
						this.settle(job, undefined, error);
					},
				);
		}
	}
}

const coordinator = new GitStatusQueryCoordinator();
export const coordinateGitStatusQuery = coordinator.query.bind(coordinator);
export const invalidateGitStatusQuery = coordinator.invalidate.bind(coordinator);
export const clearGitStatusQueries = coordinator.clear.bind(coordinator);
export const peekGitStatusQuery = coordinator.peek.bind(coordinator);
export const validateGitStatusQuery = coordinator.validate.bind(coordinator);
export const gitStatusQueryCacheSize = () => coordinator.size;

export function dropLocalGitStatusQueries(path: string): void {
	coordinator.dropMatching((key) => localGitStatusScopesOverlap(key, path));
}

export function invalidateLocalGitStatusQueries(path: string): void {
	coordinator.invalidateMatching((key) => localGitStatusScopesOverlap(key, path));
}
