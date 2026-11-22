import { randomUUID } from "node:crypto";
import type { GitStagingActionResult } from "../../shared/git-staging-lists";
import type { GitStagingObservationState } from "../../shared/git-workspace-events";
import { AppError } from "../lib/errors";

/** Internal Worker error metadata; never part of HTTP/CLI error payloads. */
export interface GitStagingObservationRetryError {
	readonly observationRetriesExhausted?: boolean;
}
export interface GitStagingObservationIdentity {
	rootPath: string;
	workspaceKey: string;
}
export interface GitStagingObservationPrepared {
	/** Includes the published generation, observation and workspace state. */
	baseline: string;
	/** Digest of the complete, independently authorized path set. */
	scope: string;
	revalidate?(signal: AbortSignal): Promise<void>;
	run(signal: AbortSignal): Promise<GitStagingActionResult>;
}
export interface GitStagingObservationConsumer {
	authorizationKey: string;
	signal?: AbortSignal;
	prepare(signal: AbortSignal): Promise<GitStagingObservationPrepared>;
}
interface Waiter {
	consumer: GitStagingObservationConsumer;
	target: number;
	resolve(result: GitStagingActionResult): void;
	reject(error: unknown): void;
	cleanup(): void;
}
interface Entry {
	identity: GitStagingObservationIdentity;
	state: GitStagingObservationState;
	listeners: Map<symbol, (state: GitStagingObservationState) => void>;
	writers: Map<symbol, GitStagingObservationConsumer>;
	waiters: Set<Waiter>;
	running?: {
		controller: AbortController;
		consumers: Set<GitStagingObservationConsumer>;
		completion?: Promise<void>;
	};
	scheduled: boolean;
	retry?: ReturnType<typeof setTimeout>;
	failures: number;
}
const MAX_ENTRIES = 128;
const MAX_CONSUMERS = 128;
const MAX_WAIT_MS = 120_000;
const entries = new Map<string, Entry>();
const queues = new Map<string, { promise: Promise<void>; size: number }>();
const keyOf = (identity: GitStagingObservationIdentity) =>
	JSON.stringify([identity.rootPath, identity.workspaceKey]);
const errorCode = (error: unknown) =>
	error instanceof AppError ? error.code : "GIT_STAGING_OBSERVATION_FAILED";
const retryableObservation = (error: unknown) =>
	[
		"GIT_STAGING_BUSY",
		"GIT_STAGING_STALE",
		"GIT_STAGING_STALE_VERSION",
		"GIT_STAGING_SOURCE_CHANGED",
		"GIT_STAGING_CONCURRENT_CHANGE",
	].includes(errorCode(error)) &&
	!(
		errorCode(error) === "GIT_STAGING_CONCURRENT_CHANGE" &&
		(error as GitStagingObservationRetryError).observationRetriesExhausted === true
	);
const busy = () => new AppError("ChangeList observation capacity reached", 409, "GIT_STAGING_BUSY");
const stale = () =>
	new AppError("ChangeList observation changed; refresh before writing", 409, "GIT_STAGING_STALE");

function cancelled(signal: AbortSignal) {
	return signal.reason ?? new DOMException("ChangeList observation cancelled", "AbortError");
}
async function waitSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	signal.throwIfAborted();
	let abort = () => {};
	const stopped = new Promise<never>((_resolve, reject) => {
		abort = () => reject(cancelled(signal));
		signal.addEventListener("abort", abort, { once: true });
	});
	try {
		return await Promise.race([promise, stopped]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}

/** All observations and ownership actions use this same bounded root queue. */
export async function serialGitStaging<T>(
	rootPath: string,
	run: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (!queues.has(rootPath) && queues.size >= MAX_ENTRIES) throw busy();
	const queue = queues.get(rootPath) ?? { promise: Promise.resolve(), size: 0 };
	if (queue.size >= MAX_CONSUMERS) throw busy();
	const previous = queue.promise;
	let release = () => {};
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	queue.promise = previous.then(() => current);
	const queued = queue.promise;
	queue.size++;
	queues.set(rootPath, queue);
	const waiting = new AbortController();
	const timeout = setTimeout(
		() =>
			waiting.abort(new AppError("ChangeList queue wait timed out", 503, "GIT_STAGING_TIMEOUT")),
		MAX_WAIT_MS,
	);
	timeout.unref?.();
	const waitingSignal = signal ? AbortSignal.any([signal, waiting.signal]) : waiting.signal;
	try {
		await waitSignal(previous, waitingSignal);
		clearTimeout(timeout);
		signal?.throwIfAborted();
		return await run();
	} finally {
		clearTimeout(timeout);
		release();
		queue.size--;
		// A cancelled queued waiter must not detach the still-running predecessor.
		void queued.then(() => {
			if (!queue.size && queues.get(rootPath) === queue) queues.delete(rootPath);
		});
	}
}
function entryFor(identity: GitStagingObservationIdentity): Entry {
	const key = keyOf(identity);
	let entry = entries.get(key);
	if (!entry) {
		if (entries.size >= MAX_ENTRIES) throw busy();
		entry = {
			identity,
			state: {
				instanceId: randomUUID(),
				stateSequence: 0,
				epoch: 1,
				completedEpoch: 0,
				round: 0,
				status: "pending",
				generation: 0,
				observationId: null,
			},
			listeners: new Map(),
			writers: new Map(),
			waiters: new Set(),
			scheduled: false,
			failures: 0,
		};
		entries.set(key, entry);
	}
	return entry;
}
function publish(entry: Entry, patch: Partial<GitStagingObservationState>) {
	entry.state = { ...entry.state, ...patch, stateSequence: entry.state.stateSequence + 1 };
	for (const [id, listener] of entry.listeners) {
		try {
			listener({ ...entry.state });
		} catch {
			entry.listeners.delete(id);
			entry.writers.delete(id);
		}
	}
}
function live(entry: Entry, consumer: GitStagingObservationConsumer) {
	return (
		!consumer.signal?.aborted &&
		([...entry.writers.values()].includes(consumer) ||
			[...entry.waiters].some((waiter) => waiter.consumer === consumer))
	);
}
function cleanup(entry: Entry) {
	if (entry.running && ![...entry.running.consumers].some((consumer) => live(entry, consumer)))
		entry.running.controller.abort(
			new DOMException("No authorized observation consumers", "AbortError"),
		);
	if (entry.listeners.size || entry.waiters.size || entry.writers.size) return;
	if (entry.retry) clearTimeout(entry.retry);
	entry.retry = undefined;
	if (!entry.running && entries.get(keyOf(entry.identity)) === entry)
		entries.delete(keyOf(entry.identity));
}
function settle(entry: Entry, waiter: Waiter, error?: unknown, result?: GitStagingActionResult) {
	if (!entry.waiters.delete(waiter)) return;
	waiter.cleanup();
	if (error !== undefined) waiter.reject(error);
	else if (result) waiter.resolve(result);
}
function schedule(entry: Entry) {
	if (
		entry.running ||
		entry.scheduled ||
		entry.retry ||
		(!entry.writers.size && !entry.waiters.size)
	)
		return;
	entry.scheduled = true;
	queueMicrotask(() => {
		entry.scheduled = false;
		if (entries.get(keyOf(entry.identity)) !== entry || entry.running) return;
		const completion = run(entry);
		const running = entries.get(keyOf(entry.identity))?.running;
		if (running) running.completion = completion;
	});
}
async function run(entry: Entry) {
	const controller = new AbortController();
	const consumers = new Set([
		...[...entry.waiters].map((waiter) => waiter.consumer),
		...entry.writers.values(),
	]);
	if (!consumers.size) return cleanup(entry);
	const running = { controller, consumers };
	entry.running = running;
	const epoch = entry.state.epoch;
	publish(entry, { status: "observing", round: entry.state.round + 1, errorCode: undefined });
	let successful = false;
	try {
		await serialGitStaging(
			entry.identity.rootPath,
			async () => {
				const prepared: Array<{
					consumer: GitStagingObservationConsumer;
					work: GitStagingObservationPrepared;
				}> = [];
				let failure: unknown;
				for (const consumer of consumers) {
					if (!live(entry, consumer)) continue;
					try {
						const work = await consumer.prepare(controller.signal);
						if (live(entry, consumer)) prepared.push({ consumer, work });
					} catch (error) {
						failure = error;
						const retryable = retryableObservation(error);
						if (!retryable) {
							for (const waiter of entry.waiters)
								if (waiter.consumer === consumer) settle(entry, waiter, error);
							if (error instanceof AppError && [401, 403, 404].includes(error.statusCode))
								for (const [id, writer] of entry.writers)
									if (writer === consumer) entry.writers.delete(id);
						}
					}
				}
				controller.signal.throwIfAborted();
				let selected: (typeof prepared)[number] | undefined;
				for (const candidate of prepared) {
					if (!live(entry, candidate.consumer)) continue;
					try {
						await candidate.work.revalidate?.(controller.signal);
						if (live(entry, candidate.consumer)) {
							selected = candidate;
							break;
						}
					} catch (error) {
						failure = error;
						if (!retryableObservation(error)) {
							for (const waiter of entry.waiters)
								if (waiter.consumer === candidate.consumer) settle(entry, waiter, error);
							if (error instanceof AppError && [401, 403, 404].includes(error.statusCode))
								for (const [id, writer] of entry.writers)
									if (writer === candidate.consumer) entry.writers.delete(id);
						}
					}
				}
				if (!selected)
					throw failure ?? new AppError("No writable observation subject", 403, "FORBIDDEN");
				const subject = selected;
				const shared = prepared.filter(
					(item) =>
						live(entry, item.consumer) &&
						item.consumer.authorizationKey === subject.consumer.authorizationKey &&
						item.work.baseline === subject.work.baseline &&
						item.work.scope === subject.work.scope,
				);
				running.consumers = new Set(shared.map((item) => item.consumer));
				cleanup(entry);
				controller.signal.throwIfAborted();
				const result = await selected.work.run(controller.signal);
				controller.signal.throwIfAborted();
				if (result.outcome !== "applied")
					throw new AppError(
						result.reason ?? "Observation is incomplete",
						409,
						"GIT_STAGING_OBSERVATION_FAILED",
					);
				successful = true;
				entry.failures = 0;
				publish(entry, {
					generation: result.generation,
					observationId: result.observationId,
					completedEpoch: Math.max(entry.state.completedEpoch, epoch),
					status: entry.state.epoch === epoch ? "settled" : "pending",
					errorCode: undefined,
				});
				const authorized = new Set(shared.map((item) => item.consumer));
				for (const waiter of entry.waiters)
					if (waiter.target <= epoch && authorized.has(waiter.consumer))
						settle(entry, waiter, undefined, {
							...result,
							observation: { ...entry.state },
							observationTargetEpoch: waiter.target,
						});
			},
			controller.signal,
		);
	} catch (error) {
		const retryable = retryableObservation(error);
		publish(entry, { status: "failed", errorCode: errorCode(error) });
		if (retryable && entry.failures++ < 2 && (entry.writers.size || entry.waiters.size)) {
			entry.retry = setTimeout(
				() => {
					entry.retry = undefined;
					schedule(entry);
				},
				50 * 2 ** (entry.failures - 1),
			);
			entry.retry.unref?.();
		} else {
			for (const waiter of [...entry.waiters])
				if (waiter.target <= epoch && running.consumers.has(waiter.consumer))
					settle(entry, waiter, error);
		}
	} finally {
		entry.running = undefined;
		cleanup(entry);
		// Newer explicit targets and other independently authorized domains are not
		// failures of this round, even if its last subject left or its result is unknown.
		const independent =
			[...entry.waiters].some(
				(waiter) => waiter.target > epoch || !running.consumers.has(waiter.consumer),
			) || [...entry.writers.values()].some((writer) => !consumers.has(writer));
		// One trailing batch covers the newest epoch, not one scan per event.
		if (
			independent ||
			entry.state.epoch > epoch ||
			(successful && (entry.state.completedEpoch < entry.state.epoch || entry.waiters.size))
		)
			schedule(entry);
	}
}

export function subscribeGitStagingObservation(
	identity: GitStagingObservationIdentity,
	listener: (state: GitStagingObservationState) => void,
	consumer?: GitStagingObservationConsumer,
) {
	const entry = entryFor(identity);
	if (entry.listeners.size >= MAX_CONSUMERS) throw busy();
	const id = Symbol();
	entry.listeners.set(id, listener);
	if (consumer && !consumer.signal?.aborted) entry.writers.set(id, consumer);
	try {
		listener({ ...entry.state });
	} catch (error) {
		entry.listeners.delete(id);
		entry.writers.delete(id);
		cleanup(entry);
		throw error;
	}
	const stop = () => {
		entry.listeners.delete(id);
		entry.writers.delete(id);
		consumer?.signal?.removeEventListener("abort", stop);
		cleanup(entry);
	};
	consumer?.signal?.addEventListener("abort", stop, { once: true });
	// A read-only subscriber may already have established a dirty baseline without
	// ever starting round 1. A later writer must cover that pending baseline.
	if (entry.state.epoch > 1 && entry.state.completedEpoch < entry.state.epoch) schedule(entry);
	return stop;
}
export function dirtyGitStagingObservation(identity: GitStagingObservationIdentity): number {
	const entry = entries.get(keyOf(identity));
	if (!entry) return 0;
	if (entry.retry) clearTimeout(entry.retry);
	entry.retry = undefined;
	entry.failures = 0;
	publish(entry, { epoch: entry.state.epoch + 1, status: "pending", errorCode: undefined });
	schedule(entry);
	return entry.state.epoch;
}
export function requestGitStagingObservation(
	identity: GitStagingObservationIdentity,
	consumer: GitStagingObservationConsumer,
): Promise<GitStagingActionResult> {
	consumer.signal?.throwIfAborted();
	const entry = entryFor(identity);
	if (entry.waiters.size >= MAX_CONSUMERS) return Promise.reject(busy());
	const promise = new Promise<GitStagingActionResult>((resolve, reject) => {
		const waiter: Waiter = {
			consumer,
			target: entry.state.epoch + 1,
			resolve,
			reject,
			cleanup: () => {},
		};
		const abort = () => {
			if (consumer.signal) settle(entry, waiter, cancelled(consumer.signal));
			cleanup(entry);
		};
		const timer = setTimeout(() => {
			settle(entry, waiter, new AppError("Observation wait timed out", 503, "GIT_STAGING_TIMEOUT"));
			cleanup(entry);
		}, MAX_WAIT_MS);
		timer.unref?.();
		waiter.cleanup = () => {
			clearTimeout(timer);
			consumer.signal?.removeEventListener("abort", abort);
		};
		entry.waiters.add(waiter);
		consumer.signal?.addEventListener("abort", abort, { once: true });
	});
	dirtyGitStagingObservation(identity);
	return promise;
}
/** Snapshot one current round; continuous edits never extend this wait indefinitely. */
export async function settleGitStagingObservations(workspaceKey: string, signal?: AbortSignal) {
	const current = [...entries.values()]
		.filter((entry) => entry.identity.workspaceKey === workspaceKey)
		.flatMap((entry) => (entry.running?.completion ? [entry.running.completion] : []));
	await waitSignal(Promise.all(current), signal);
}
export function gitStagingObservationState(identity: GitStagingObservationIdentity) {
	const state = entries.get(keyOf(identity))?.state;
	return state ? { ...state } : undefined;
}
export function assertGitStagingObservationClean(
	identity: GitStagingObservationIdentity,
	enqueued: GitStagingObservationState | undefined,
	version: { expectedGeneration: number; observationId: string },
) {
	const current = gitStagingObservationState(identity);
	if (!current) {
		if (enqueued) throw stale();
		return;
	}
	if (
		current.status !== "settled" ||
		current.completedEpoch < current.epoch ||
		(enqueued &&
			(enqueued.instanceId !== current.instanceId ||
				enqueued.epoch !== current.epoch ||
				enqueued.status !== "settled")) ||
		current.generation !== version.expectedGeneration ||
		current.observationId !== version.observationId
	)
		throw stale();
}
export function publishGitStagingWrite(
	identity: GitStagingObservationIdentity,
	result: GitStagingActionResult,
) {
	const entry = entries.get(keyOf(identity));
	if (!entry) return;
	publish(entry, { generation: result.generation, observationId: result.observationId });
	if (entry.state.completedEpoch < entry.state.epoch) schedule(entry);
}
