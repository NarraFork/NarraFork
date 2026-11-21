/**
 * FIFO admission in front of the short-read pool for SQLite authentication reads.
 *
 * A page load fans out into many authenticated requests at once. The short-read pool keeps
 * its own queue small on purpose, so auth reads wait here (bounded, deadline-aware) instead of
 * overflowing it. Every admitted caller still performs its own live database read: nothing is
 * cached or shared between requests.
 */
import { DbReadTaskOverloadedError, DbReadTaskTimeoutError } from "./db-worker/pool";
import { hotSafe } from "./hot-safe";

export interface AuthReadOptions {
	signal?: AbortSignal;
}

export interface AuthReadContext {
	signal: AbortSignal;
	/** Remaining budget for the database read, already net of time spent queued here. */
	timeoutMs: number;
}

function aborted(): Error {
	return Object.assign(new Error("Authentication read aborted"), { name: "AbortError" });
}

export class AuthReadAdmission {
	private active = 0;
	private readonly queue: Array<() => void> = [];
	readonly concurrency: number;
	readonly maxQueued: number;
	readonly timeoutMs: number;

	constructor(options: { concurrency?: number; maxQueued?: number; timeoutMs?: number } = {}) {
		this.concurrency = options.concurrency ?? 2;
		this.maxQueued = options.maxQueued ?? 64;
		this.timeoutMs = options.timeoutMs ?? 5_000;
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

	get stats() {
		return { active: this.active, queued: this.queue.length };
	}

	run<T>(
		read: (context: AuthReadContext) => Promise<T>,
		{ signal }: AuthReadOptions = {},
	): Promise<T> {
		if (signal?.aborted) return Promise.reject(aborted());
		if (this.active >= this.concurrency && this.queue.length >= this.maxQueued)
			return Promise.reject(new DbReadTaskOverloadedError());
		const deadlineAt = Date.now() + this.timeoutMs;
		return new Promise<T>((resolve, reject) => {
			let started = false;
			let settled = false;
			const controller = new AbortController();
			const settle = (fn: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				if (!started) {
					const index = this.queue.indexOf(start);
					if (index !== -1) this.queue.splice(index, 1);
				}
				fn();
			};
			const cancel = (error: Error) => {
				settle(() => reject(error));
				controller.abort(error);
			};
			const onAbort = () => cancel(aborted());
			const timer = setTimeout(
				() => cancel(new DbReadTaskTimeoutError("authentication read timed out")),
				this.timeoutMs,
			);
			const start = () => {
				started = true;
				this.active++;
				const timeoutMs = deadlineAt - Date.now();
				void Promise.resolve()
					.then(() =>
						settled || timeoutMs <= 0 ? undefined : read({ signal: controller.signal, timeoutMs }),
					)
					.then(
						(value) => settle(() => resolve(value as T)),
						(error: unknown) => settle(() => reject(error)),
					)
					.finally(() => {
						// A cancelled caller does not prove its read settled; the slot frees only now.
						this.active--;
						this.drain();
					});
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			if (this.active < this.concurrency) start();
			else this.queue.push(start);
		});
	}

	private drain(): void {
		while (this.active < this.concurrency && this.queue.length) this.queue.shift()?.();
	}
}

export const authReadAdmission = hotSafe(
	"narrafork.authReadAdmission",
	() => new AuthReadAdmission(),
);
