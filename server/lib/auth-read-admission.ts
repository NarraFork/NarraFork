/**
 * FIFO admission in front of the short-read pool for SQLite authentication reads.
 *
 * A page load fans out into many authenticated requests at once. The short-read pool keeps
 * its own queue small on purpose, so auth reads wait here (bounded, deadline-aware) instead of
 * overflowing it. Every admitted caller still performs its own live database read: nothing is
 * cached or shared between requests.
 */
import { DbReadError, readAborted } from "./db-worker/errors";
import { DbReadTaskOverloadedError, DbReadTaskTimeoutError } from "./db-worker/pool";
import { hotSafe } from "./hot-safe";

export interface AuthReadOptions {
	signal?: AbortSignal;
	/** Absolute deadline in epoch milliseconds, shared with the database read. */
	deadlineAt?: number;
}

export interface AuthReadContext {
	signal: AbortSignal;
	/** Absolute deadline shared by admission and the downstream database read. */
	deadlineAt: number;
	/** Remaining budget for the database read, already net of time spent queued here. */
	timeoutMs: number;
}

interface Waiter {
	start(): void;
}

/** FIFO admission only: every admitted caller performs its own live database read. */
export class AuthReadAdmission {
	private active = 0;
	private readonly queue: Array<Waiter | (() => void)> = [];
	private readonly concurrency: number;
	private readonly maxQueued: number;
	private readonly timeoutMs: number;
	runtimeVersion = 2;

	constructor(options: { concurrency?: number; maxQueued?: number; timeoutMs?: number } = {}) {
		this.concurrency = options.concurrency ?? 2;
		this.maxQueued = options.maxQueued ?? 64;
		this.timeoutMs = options.timeoutMs ?? 30_000;
		if (
			!Number.isInteger(this.concurrency) ||
			this.concurrency < 1 ||
			!Number.isInteger(this.maxQueued) ||
			this.maxQueued < 0 ||
			!Number.isFinite(this.timeoutMs) ||
			this.timeoutMs <= 0
		)
			throw new Error("Invalid authentication read admission limits");
	}

	/** Refresh methods in place: old waiter closures still own these same counters. */
	static upgrade(admission: AuthReadAdmission): AuthReadAdmission {
		Object.setPrototypeOf(admission, AuthReadAdmission.prototype);
		admission.runtimeVersion = 2;
		return admission;
	}

	get stats() {
		return { active: this.active, queued: this.queue.length };
	}

	run<T>(
		read: (context: AuthReadContext) => Promise<T>,
		{ signal, deadlineAt }: AuthReadOptions = {},
	): Promise<T> {
		if (signal?.aborted)
			return Promise.reject(Object.assign(readAborted(), { name: "AbortError" }));
		if (deadlineAt !== undefined && !Number.isFinite(deadlineAt)) {
			return Promise.reject(new DbReadError("DB_READ_INVALID", "Invalid authentication deadline"));
		}
		const deadline = Math.min(deadlineAt ?? Infinity, Date.now() + this.timeoutMs);
		const timeout = () => new DbReadTaskTimeoutError("Authentication read timed out");
		if (deadline <= Date.now()) return Promise.reject(timeout());
		if (this.active >= this.concurrency && this.queue.length >= this.maxQueued) {
			return Promise.reject(new DbReadTaskOverloadedError());
		}
		const controller = new AbortController();
		return new Promise<T>((resolve, reject) => {
			let settled = false;
			let started = false;
			const finish = (result: { value: T } | { error: unknown }) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				if (!started) {
					const index = this.queue.indexOf(waiter);
					if (index !== -1) this.queue.splice(index, 1);
				}
				if ("error" in result) reject(result.error);
				else resolve(result.value);
			};
			const cancel = (error: Error) => {
				// Settle with the original cause before downstream abort listeners can reject.
				finish({ error });
				controller.abort(error);
			};
			const abort = () => cancel(Object.assign(readAborted(), { name: "AbortError" }));
			const timer = setTimeout(() => cancel(timeout()), Math.max(0, deadline - Date.now()));
			const waiter: Waiter = {
				start: () => {
					started = true;
					this.active++;
					void Promise.resolve()
						.then<T | undefined>(() => {
							if (settled) return undefined;
							if (signal?.aborted) {
								abort();
								return undefined;
							}
							if (Date.now() >= deadline) {
								cancel(timeout());
								return undefined;
							}
							return read({
								signal: controller.signal,
								deadlineAt: deadline,
								timeoutMs: Math.max(0, deadline - Date.now()),
							});
						})
						.then(
							(value) => {
								if (settled) return;
								if (signal?.aborted) return abort();
								if (Date.now() >= deadline) return cancel(timeout());
								finish({ value: value as T });
							},
							(error: unknown) => finish({ error }),
						)
						.finally(() => {
							// Caller cancellation does not prove the original read has settled.
							this.active--;
							this.drain();
						});
				},
			};
			signal?.addEventListener("abort", abort, { once: true });
			if (this.active < this.concurrency) waiter.start();
			else this.queue.push(waiter);
		});
	}

	private drain(): void {
		while (this.active < this.concurrency && this.queue.length) {
			const waiter = this.queue.shift();
			if (typeof waiter === "function") waiter();
			else waiter?.start();
		}
	}
}

export const authReadAdmission = AuthReadAdmission.upgrade(
	hotSafe("narrafork.authReadAdmission", () => new AuthReadAdmission()),
);
