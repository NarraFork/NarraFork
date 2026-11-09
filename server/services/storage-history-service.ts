import { open, rename, unlink, writeFile } from "node:fs/promises";
import {
	STORAGE_RETENTION_TARGETS,
	type StorageHistoryCandidate,
	type StorageHistoryJob,
	type StorageHistoryJobs,
	type StorageHistoryMutationResult,
	type StorageHistoryPreview,
	type StorageRetentionSettings,
	type StorageRetentionTarget,
} from "@shared/storage-retention";
import { z } from "zod/v4";
import { AsyncMutex } from "../lib/async-mutex";
import type {
	StorageHistoryBucket,
	StorageHistoryReadParams,
} from "../lib/db-worker/storage-history-query";
import { AppError, ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";

const DAY_MS = 86_400_000;
const PREVIEW_TTL_MS = 5 * 60_000;
const JOURNAL_LIMIT = 32 * 1024;
const JOB_BUDGET_MS = 12 * 60 * 60_000;
const statuses = ["queued", "running", "completed", "cancelled", "failed"] as const;
const storedJobSchema = z.object({
	id: z.string().max(64),
	target: z.enum(STORAGE_RETENTION_TARGETS),
	cutoffAt: z.string().datetime({ offset: true }),
	source: z.enum(["manual", "automatic"]),
	status: z.enum(statuses),
	processed: z.number().nonnegative(),
	cleared: z.number().nonnegative(),
	retained: z.number().nonnegative(),
	approxBytes: z.number().nonnegative(),
	startedAt: z.string(),
	finishedAt: z.string().nullable(),
	error: z.string().max(2000).nullable(),
	cursor: z.number().int().nonnegative(),
	retentionDays: z.number().int().positive().nullable().default(null),
	cancelRequested: z.boolean().default(false),
});
type StoredJob = z.infer<typeof storedJobSchema>;
const journalSchema = z.object({
	version: z.literal(1),
	jobs: z.object({
		toolCallPayloads: storedJobSchema.nullable(),
		messageHistory: storedJobSchema.nullable(),
	}),
	lastAutomaticAt: z.object({
		toolCallPayloads: z.string().nullable(),
		messageHistory: z.string().nullable(),
	}),
});

export interface StorageHistoryServiceDependencies {
	journalPath: string;
	policies: () => StorageRetentionSettings;
	read: <T>(params: StorageHistoryReadParams, signal?: AbortSignal) => Promise<T>;
	clear: (input: {
		target: StorageRetentionTarget;
		candidate: StorageHistoryCandidate;
		cutoffAt: string;
		clearedAt: string;
		signal?: AbortSignal;
		/** Recheck synchronously at the actual store write, after any worker/admission await. */
		canClear?: () => boolean;
	}) => Promise<StorageHistoryMutationResult>;
	maintenance: <T>(work: () => Promise<T>) => Promise<T>;
	onChanged?: () => void;
	now?: () => number;
}

export function normalizeStorageHistoryCutoff(value: string, now = Date.now()): string {
	const parsed = z.string().datetime({ offset: true }).safeParse(value);
	const ms = parsed.success ? Date.parse(parsed.data) : Number.NaN;
	if (!Number.isFinite(ms) || ms > now)
		throw new ValidationError("Choose a valid date up to today");
	return new Date(ms).toISOString();
}

function publicJob(job: StoredJob | null): StorageHistoryJob | null {
	if (!job) return null;
	const {
		cursor: _cursor,
		retentionDays: _retentionDays,
		cancelRequested: _cancelRequested,
		...result
	} = job;
	return { ...result };
}

function observe<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Preview cancelled"));
	return new Promise<T>((resolve, reject) => {
		const abort = () => {
			cleanup();
			reject(signal.reason ?? new Error("Preview cancelled"));
		};
		const cleanup = () => signal.removeEventListener("abort", abort);
		signal.addEventListener("abort", abort, { once: true });
		promise.then(
			(result) => {
				cleanup();
				resolve(result);
			},
			(error) => {
				cleanup();
				reject(error);
			},
		);
	});
}

/** Two bounded, persistent jobs. Database writes remain in the caller's short-transaction store. */
export function createStorageHistoryService(deps: StorageHistoryServiceDependencies) {
	const now = deps.now ?? Date.now;
	const control = new AsyncMutex();
	let journal: z.infer<typeof journalSchema> = {
		version: 1,
		jobs: { toolCallPayloads: null, messageHistory: null },
		lastAutomaticAt: { toolCallPayloads: null, messageHistory: null },
	};
	let loaded: Promise<void> | null = null;
	let scheduler: ReturnType<typeof setInterval> | null = null;
	let stopping = false;
	const active = new Map<StorageRetentionTarget, AbortController>();
	const pending = new Map<string, Promise<void>>();
	const stats = new Map<
		string,
		{
			at: number;
			controller: AbortController;
			promise: Promise<StorageHistoryBucket[]>;
		}
	>();

	async function save() {
		const text = JSON.stringify(journal);
		if (Buffer.byteLength(text) > JOURNAL_LIMIT)
			throw new Error("History cleanup journal exceeded its budget");
		const temporary = `${deps.journalPath}.${generateId()}.tmp`;
		try {
			await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
			await rename(temporary, deps.journalPath);
		} finally {
			await unlink(temporary).catch(() => {});
		}
	}
	async function ensureLoaded() {
		if (!loaded)
			loaded = (async () => {
				let file: Awaited<ReturnType<typeof open>> | undefined;
				try {
					file = await open(deps.journalPath, "r");
					const buffer = Buffer.alloc(JOURNAL_LIMIT + 1);
					const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
					if (bytesRead > JOURNAL_LIMIT)
						throw new Error("History cleanup journal exceeded its budget");
					journal = journalSchema.parse(JSON.parse(buffer.toString("utf8", 0, bytesRead)));
					for (const target of STORAGE_RETENTION_TARGETS) {
						const job = journal.jobs[target];
						if (job?.target !== undefined && job.target !== target)
							throw new Error("History cleanup target mismatch");
						if (job?.status === "running") job.status = "queued";
					}
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				} finally {
					await file?.close();
				}
			})();
		await loaded;
	}
	function invalidate() {
		for (const entry of stats.values()) entry.controller.abort();
		stats.clear();
		deps.onChanged?.();
	}
	function buckets(target: StorageRetentionTarget, dayOffsetMs: number) {
		const key = `${target}:${dayOffsetMs}`;
		const cached = stats.get(key);
		if (cached && now() - cached.at < PREVIEW_TTL_MS) return cached.promise;
		cached?.controller.abort();
		if (!cached && stats.size >= 8) {
			const oldest = stats.keys().next().value;
			if (oldest !== undefined) {
				stats.get(oldest)?.controller.abort();
				stats.delete(oldest);
			}
		}
		const controller = new AbortController();
		const entry = {
			at: now(),
			controller,
			promise: deps.read<StorageHistoryBucket[]>(
				{ kind: "storageHistoryRead", mode: "buckets", target, dayOffsetMs },
				controller.signal,
			),
		};
		stats.set(key, entry);
		entry.promise.catch(() => {
			if (stats.get(key) === entry) stats.delete(key);
		});
		return entry.promise;
	}
	async function preview(
		target: StorageRetentionTarget,
		value: string,
		signal?: AbortSignal,
	): Promise<StorageHistoryPreview> {
		const cutoffAt = normalizeStorageHistoryCutoff(value, now());
		const day = cutoffAt.slice(0, 10);
		const dayOffsetMs = Date.parse(cutoffAt) - Date.parse(`${day}T00:00:00.000Z`);
		const all = await observe(buckets(target, dayOffsetMs), signal);
		const selected = all.filter((b) => b.day < day);
		const count = selected.reduce((n, b) => n + b.count, 0);
		return {
			target,
			cutoffAt,
			count,
			approxBytes: selected.reduce((n, b) => n + b.approxBytes, 0),
		};
	}
	function automaticPolicyMatches(job: StoredJob): boolean {
		if (job.source === "manual") return true;
		const rule = deps.policies()[job.target];
		return (
			rule.autoCleanup && rule.retentionDays !== null && rule.retentionDays === job.retentionDays
		);
	}
	async function run(job: StoredJob) {
		if (job.cancelRequested || job.status === "cancelled" || stopping) return;
		const controller = new AbortController();
		active.set(job.target, controller);
		const deadline = now() + JOB_BUDGET_MS;
		try {
			await control.acquire("journal", async () => {
				job.status = "running";
				await save();
			});
			while (!controller.signal.aborted) {
				if (!automaticPolicyMatches(job)) controller.abort(new Error("Retention policy changed"));
				controller.signal.throwIfAborted();
				if (now() > deadline)
					throw new Error("History cleanup reached its time budget; run it again to continue");
				let done = false;
				await deps.maintenance(async () => {
					controller.signal.throwIfAborted();
					const rows = await deps.read<StorageHistoryCandidate[]>(
						{
							kind: "storageHistoryRead",
							mode: "candidates",
							target: job.target,
							cutoffAt: job.cutoffAt,
							afterRowid: job.cursor,
							limit: 32,
						},
						controller.signal,
					);
					if (!rows.length) {
						done = true;
						return;
					}
					for (const candidate of rows) {
						if (!automaticPolicyMatches(job))
							controller.abort(new Error("Retention policy changed"));
						controller.signal.throwIfAborted();
						const started = performance.now();
						const result = await deps.clear({
							target: job.target,
							candidate,
							cutoffAt: job.cutoffAt,
							clearedAt: new Date(now()).toISOString(),
							signal: controller.signal,
							canClear: () =>
								!job.cancelRequested && !controller.signal.aborted && automaticPolicyMatches(job),
						});
						job.processed++;
						if (result.cleared) {
							job.cleared++;
							job.approxBytes += candidate.approxBytes;
						}
						if (result.retained) job.retained++;
						job.cursor = candidate.rowid;
						if (!automaticPolicyMatches(job))
							controller.abort(new Error("Retention policy changed"));
						const elapsed = performance.now() - started;
						if (elapsed > 100)
							logger.warn("Slow history cleanup item", {
								target: job.target,
								durationMs: Math.round(elapsed),
							});
						// Yield and pace the short transactions; HTTP/WS/agents keep their share of the loop.
						await new Promise((resolve) =>
							setTimeout(resolve, Math.min(250, Math.max(1, elapsed * 2))),
						);
					}
				});
				await control.acquire("journal", save);
				if (done) break;
			}
			job.status = controller.signal.aborted ? "cancelled" : "completed";
		} catch (error) {
			job.status = controller.signal.aborted ? "cancelled" : "failed";
			job.error = controller.signal.aborted
				? null
				: (error instanceof Error ? error.message : String(error)).slice(0, 2000);
			if (job.error)
				logger.warn("History cleanup failed", { target: job.target, error: job.error });
		} finally {
			active.delete(job.target);
			if (
				stopping &&
				controller.signal.aborted &&
				!job.cancelRequested &&
				automaticPolicyMatches(job)
			) {
				job.status = "queued";
				job.finishedAt = null;
				job.error = null;
			} else job.finishedAt = new Date(now()).toISOString();
			await control.acquire("journal", save);
			invalidate();
		}
	}
	function enqueue(job: StoredJob) {
		if (pending.has(job.id)) return;
		const promise = Promise.resolve().then(() => run(job));
		pending.set(job.id, promise);
		promise
			.catch((error) => logger.warn("History cleanup state save failed", { error: String(error) }))
			.finally(() => pending.delete(job.id));
	}
	async function start(
		target: StorageRetentionTarget,
		value: string,
		source: "manual" | "automatic" = "manual",
	) {
		const requestedCutoff = normalizeStorageHistoryCutoff(value, now());
		await ensureLoaded();
		// A confirmed cancellation may still be finishing its current short transaction.
		const previous = journal.jobs[target];
		if (previous && previous.status !== "queued" && previous.status !== "running")
			await pending.get(previous.id);
		const job = await control.acquire("journal", async () => {
			const rule = deps.policies()[target];
			if (source === "automatic" && (!rule.autoCleanup || rule.retentionDays === null))
				throw new AppError("Retention policy changed", 409, "HISTORY_POLICY_CHANGED");
			const cutoffAt =
				source === "automatic"
					? new Date(now() - (rule.retentionDays as number) * DAY_MS).toISOString()
					: requestedCutoff;
			const existing = journal.jobs[target];
			if (existing && (existing.status === "queued" || existing.status === "running")) {
				if (source === "automatic" || existing.cutoffAt === cutoffAt) return existing;
				throw new AppError(
					"A cleanup is already running for this history",
					409,
					"HISTORY_CLEANUP_RUNNING",
				);
			}
			const next: StoredJob = {
				id: generateId(),
				target,
				cutoffAt,
				source,
				status: "queued",
				processed: 0,
				cleared: 0,
				retained: 0,
				approxBytes: 0,
				cursor: 0,
				retentionDays: source === "automatic" ? rule.retentionDays : null,
				cancelRequested: false,
				startedAt: new Date(now()).toISOString(),
				finishedAt: null,
				error: null,
			};
			const previousAutomaticAt = journal.lastAutomaticAt[target];
			journal.jobs[target] = next;
			if (source === "automatic") journal.lastAutomaticAt[target] = next.startedAt;
			try {
				await save();
			} catch (error) {
				journal.jobs[target] = existing;
				journal.lastAutomaticAt[target] = previousAutomaticAt;
				throw error;
			}
			return next;
		});
		enqueue(job);
		return publicJob(job) as StorageHistoryJob;
	}
	async function jobs(): Promise<StorageHistoryJobs> {
		await ensureLoaded();
		return {
			toolCallPayloads: publicJob(journal.jobs.toolCallPayloads),
			messageHistory: publicJob(journal.jobs.messageHistory),
		};
	}
	async function cancel(
		target: StorageRetentionTarget,
		stillRequested: () => boolean = () => true,
	): Promise<StorageHistoryJob | null> {
		await ensureLoaded();
		return control.acquire("journal", async () => {
			const job = journal.jobs[target];
			if (!stillRequested()) return publicJob(job);
			if (job && (job.status === "queued" || job.status === "running")) {
				job.cancelRequested = true;
				job.status = "cancelled";
				job.finishedAt = new Date(now()).toISOString();
				active.get(target)?.abort(new Error("Cleanup cancelled"));
				// Persist the user's intent before acknowledging cancellation, even mid-transaction.
				await save();
			}
			return publicJob(job);
		});
	}
	async function automatic(
		force = false,
		targets: readonly StorageRetentionTarget[] = STORAGE_RETENTION_TARGETS,
	) {
		await ensureLoaded();
		for (const target of targets) {
			// Read each policy after any prior await; another administrator may have just changed it.
			const existing = journal.jobs[target];
			if (
				existing?.source === "automatic" &&
				(existing.status === "queued" || existing.status === "running") &&
				!automaticPolicyMatches(existing)
			) {
				const cancelled = await cancel(
					target,
					() => journal.jobs[target]?.id === existing.id && !automaticPolicyMatches(existing),
				);
				if (cancelled?.id === existing.id && cancelled.status === "cancelled")
					await pending.get(existing.id);
			}
			const rule = deps.policies()[target];
			if (!rule.autoCleanup || rule.retentionDays === null) continue;
			const last = journal.lastAutomaticAt[target];
			if (!force && last && now() - Date.parse(last) < DAY_MS) continue;
			try {
				await start(
					target,
					new Date(now() - rule.retentionDays * DAY_MS).toISOString(),
					"automatic",
				);
			} catch (error) {
				if (!(error instanceof AppError) || error.code !== "HISTORY_POLICY_CHANGED") throw error;
			}
		}
	}
	async function startScheduler() {
		await ensureLoaded();
		stopping = false;
		for (const target of STORAGE_RETENTION_TARGETS) {
			const job = journal.jobs[target];
			if (job?.status !== "queued") continue;
			if (job.source === "automatic" && !automaticPolicyMatches(job)) {
				journal.lastAutomaticAt[target] = null;
				job.status = "cancelled";
				job.finishedAt = new Date(now()).toISOString();
				await control.acquire("journal", save);
			} else enqueue(job);
		}
		await automatic();
		if (!scheduler) {
			scheduler = setInterval(() => {
				void automatic().catch((error) =>
					logger.warn("Automatic history cleanup failed", { error: String(error) }),
				);
			}, 60 * 60_000);
			scheduler.unref();
		}
	}
	function stop() {
		stopping = true;
		if (scheduler) clearInterval(scheduler);
		scheduler = null;
		for (const controller of active.values())
			controller.abort(new Error("Cleanup paused for shutdown"));
		for (const entry of stats.values()) entry.controller.abort();
		stats.clear();
	}
	return {
		preview,
		start,
		jobs,
		cancel,
		automatic,
		startScheduler,
		stop,
		settled: () => Promise.all([...pending.values()]).then(() => undefined),
		invalidate,
	};
}
