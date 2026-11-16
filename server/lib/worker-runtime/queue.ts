/**
 * Bounded admission for worker jobs. The queue never executes the job or owns its resources:
 * abort/deadline signals request cancellation, but only release() returns an active slot.
 */

export class TaskQueueError extends Error {
	constructor(readonly code: "TASK_QUEUE_FULL" | "TASK_QUEUE_TIMEOUT" | "TASK_QUEUE_CLOSED") {
		super(
			{
				TASK_QUEUE_FULL: "Worker task queue is full",
				TASK_QUEUE_TIMEOUT: "Worker task deadline exceeded",
				TASK_QUEUE_CLOSED: "Worker task queue is closed",
			}[code],
		);
		this.name = "TaskQueueError";
	}
}

export interface TaskQueueOptions {
	concurrency: number;
	/** Waiting jobs only; 0 refuses to queue, without disabling immediate admission. */
	maxQueued?: number;
	/** Waiting input bytes only. Callers retain their own per-job input/output limits. */
	maxQueuedBytes?: number;
	/** Optional existing in-flight resource budget; omitted/+Infinity adds no active byte cap. */
	maxActiveBytes?: number;
	/** Used only when a caller does not supply its operation's absolute deadline. */
	timeoutMs?: number;
	/** Optional existing domain quotas (e.g. one active editor job per user). */
	maxActivePerKey?: number;
	maxQueuedPerKey?: number;
}

export interface TaskQueueAdmission {
	signal?: AbortSignal;
	/** Epoch milliseconds, never reset on admission; +Infinity preserves domain-owned phase budgets. */
	deadlineAt?: number;
	/** Optional finite wait on this queue only; cleared on grant. Zero allows immediate grant only. */
	waitTimeoutMs?: number;
	/** Byte reservation for waiting input and any configured active budget; 0 for payload-free control. */
	bytes?: number;
	/** An opaque domain identity. Keyed jobs rotate fairly; unkeyed jobs remain FIFO. */
	key?: string;
}

export interface TaskQueuePermit {
	readonly signal: AbortSignal;
	readonly deadlineAt: number;
	/** Idempotent. Call only after the job and its resource cleanup have actually finished. */
	release(): void;
}

interface Waiting {
	key?: string;
	bytes: number;
	deadlineAt: number;
	waitDeadlineAt?: number;
	controller: AbortController;
	resolve(permit: TaskQueuePermit): void;
	reject(reason: unknown): void;
	cleanup(): void;
}

const MAX_TIMER_MS = 2_147_483_647;

function integer(value: number, minimum: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < minimum)
		throw new RangeError(`${name} must be a safe integer >= ${minimum}`);
	return value;
}

export class TaskQueue {
	private readonly options: Required<TaskQueueOptions>;
	private readonly waiting: Waiting[] = [];
	private readonly activeKeys = new Map<string, number>();
	private active = 0;
	private activeBytes = 0;
	private queuedBytes = 0;
	private lastKey: string | undefined;
	private closed = false;
	private closeReason: unknown;
	private closing: Promise<void> | undefined;
	private drained: (() => void) | undefined;

	constructor(options: TaskQueueOptions) {
		this.options = {
			concurrency: integer(options.concurrency, 1, "concurrency"),
			maxQueued: integer(options.maxQueued ?? 32, 0, "maxQueued"),
			maxQueuedBytes: integer(options.maxQueuedBytes ?? 64 * 1024 * 1024, 0, "maxQueuedBytes"),
			maxActiveBytes:
				options.maxActiveBytes === undefined || options.maxActiveBytes === Infinity
					? Infinity
					: integer(options.maxActiveBytes, 0, "maxActiveBytes"),
			timeoutMs: integer(options.timeoutMs ?? 30_000, 1, "timeoutMs"),
			maxActivePerKey: integer(
				options.maxActivePerKey ?? options.concurrency,
				1,
				"maxActivePerKey",
			),
			maxQueuedPerKey: integer(
				options.maxQueuedPerKey ?? options.maxQueued ?? 32,
				0,
				"maxQueuedPerKey",
			),
		};
	}

	get stats() {
		return {
			active: this.active,
			activeBytes: this.activeBytes,
			queued: this.waiting.length,
			queuedBytes: this.queuedBytes,
			closed: this.closed,
		};
	}

	async acquire(options: TaskQueueAdmission = {}): Promise<TaskQueuePermit> {
		const { signal } = options;
		signal?.throwIfAborted();
		if (this.closed) throw this.closeReason;
		const bytes = integer(options.bytes ?? 0, 0, "bytes");
		if (bytes > this.options.maxActiveBytes) throw new TaskQueueError("TASK_QUEUE_FULL");
		const waitTimeoutMs =
			options.waitTimeoutMs === undefined
				? undefined
				: integer(options.waitTimeoutMs, 0, "waitTimeoutMs");
		const deadlineAt = options.deadlineAt ?? Date.now() + this.options.timeoutMs;
		if (!Number.isFinite(deadlineAt) && deadlineAt !== Number.POSITIVE_INFINITY)
			throw new RangeError("deadlineAt must be finite or +Infinity");
		if (deadlineAt <= Date.now()) throw new TaskQueueError("TASK_QUEUE_TIMEOUT");
		this.pump();
		const canStart =
			this.active < this.options.concurrency &&
			this.keyAvailable(options.key) &&
			bytes <= this.options.maxActiveBytes - this.activeBytes;
		if (
			!canStart &&
			(this.waiting.length >= this.options.maxQueued ||
				bytes > this.options.maxQueuedBytes - this.queuedBytes ||
				(options.key !== undefined &&
					this.waiting.filter((entry) => entry.key === options.key).length >=
						this.options.maxQueuedPerKey))
		)
			throw new TaskQueueError("TASK_QUEUE_FULL");

		return new Promise((resolve, reject) => {
			const controller = new AbortController();
			let timer: ReturnType<typeof setTimeout> | undefined;
			let waitTimer: ReturnType<typeof setTimeout> | undefined;
			const forwardAbort = () => controller.abort(signal?.reason);
			const cancelWaiting = () => {
				this.remove(entry);
				entry.cleanup();
				reject(controller.signal.reason);
				this.pump();
			};
			const entry: Waiting = {
				key: options.key,
				bytes,
				deadlineAt,
				// A ready slot never consumes a queue-only deadline, even at a 1ms domain budget.
				waitDeadlineAt:
					!canStart && waitTimeoutMs !== undefined ? Date.now() + waitTimeoutMs : undefined,
				controller,
				resolve: (permit) => {
					clearTimeout(waitTimer);
					waitTimer = undefined;
					entry.waitDeadlineAt = undefined;
					controller.signal.removeEventListener("abort", cancelWaiting);
					resolve(permit);
				},
				reject,
				cleanup: () => {
					clearTimeout(timer);
					clearTimeout(waitTimer);
					signal?.removeEventListener("abort", forwardAbort);
					controller.signal.removeEventListener("abort", cancelWaiting);
				},
			};
			const armDeadline = () => {
				if (deadlineAt === Number.POSITIVE_INFINITY) return;
				const remaining = deadlineAt - Date.now();
				if (remaining <= 0) controller.abort(new TaskQueueError("TASK_QUEUE_TIMEOUT"));
				else timer = setTimeout(armDeadline, Math.min(remaining, MAX_TIMER_MS));
			};
			const armWait = () => {
				if (entry.waitDeadlineAt === undefined) return;
				const remaining = entry.waitDeadlineAt - Date.now();
				if (remaining <= 0) controller.abort(new TaskQueueError("TASK_QUEUE_TIMEOUT"));
				else waitTimer = setTimeout(armWait, Math.min(remaining, MAX_TIMER_MS));
			};
			controller.signal.addEventListener("abort", cancelWaiting, { once: true });
			signal?.addEventListener("abort", forwardAbort, { once: true });
			if (signal?.aborted) forwardAbort();
			else {
				armDeadline();
				if (!controller.signal.aborted) armWait();
			}
			if (controller.signal.aborted) return;
			if (canStart) this.grant(entry);
			else {
				this.waiting.push(entry);
				this.queuedBytes += bytes;
			}
		});
	}

	async run<T>(
		work: (permit: TaskQueuePermit) => T | Promise<T>,
		options?: TaskQueueAdmission,
	): Promise<T> {
		const permit = await this.acquire(options);
		try {
			permit.signal.throwIfAborted();
			if (Date.now() >= permit.deadlineAt) throw new TaskQueueError("TASK_QUEUE_TIMEOUT");
			return await work(permit);
		} finally {
			permit.release();
		}
	}

	/** Stop admission and reject waiting jobs; active jobs retain their permits until cleanup. */
	close(reason: unknown = new TaskQueueError("TASK_QUEUE_CLOSED")): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		this.closeReason = reason;
		this.closing = new Promise((resolve) => {
			this.drained = resolve;
		});
		for (const entry of [...this.waiting]) entry.controller.abort(reason);
		if (this.active === 0) this.drained?.();
		return this.closing;
	}

	private keyAvailable(key: string | undefined): boolean {
		return key === undefined || (this.activeKeys.get(key) ?? 0) < this.options.maxActivePerKey;
	}

	private next(): Waiting | undefined {
		let first: Waiting | undefined;
		for (const entry of this.waiting) {
			if (
				!this.keyAvailable(entry.key) ||
				entry.bytes > this.options.maxActiveBytes - this.activeBytes
			)
				continue;
			first ??= entry;
			if (first.key === undefined) return first;
			if (entry.key !== undefined && entry.key !== this.lastKey) return entry;
		}
		return first;
	}

	private remove(entry: Waiting): boolean {
		const index = this.waiting.indexOf(entry);
		if (index < 0) return false;
		this.waiting.splice(index, 1);
		this.queuedBytes -= entry.bytes;
		return true;
	}

	private pump(): void {
		while (!this.closed && this.active < this.options.concurrency) {
			const entry = this.next();
			if (!entry) return;
			this.remove(entry);
			this.grant(entry);
		}
	}

	private grant(entry: Waiting): void {
		const now = Date.now();
		if (
			entry.deadlineAt <= now ||
			(entry.waitDeadlineAt !== undefined && entry.waitDeadlineAt <= now)
		) {
			const error = new TaskQueueError("TASK_QUEUE_TIMEOUT");
			entry.cleanup();
			entry.controller.abort(error);
			entry.reject(error);
			return;
		}
		this.active++;
		this.activeBytes += entry.bytes;
		this.lastKey = entry.key;
		if (entry.key !== undefined)
			this.activeKeys.set(entry.key, (this.activeKeys.get(entry.key) ?? 0) + 1);
		let released = false;
		entry.resolve({
			signal: entry.controller.signal,
			deadlineAt: entry.deadlineAt,
			release: () => {
				if (released) return;
				released = true;
				entry.cleanup();
				this.active--;
				this.activeBytes -= entry.bytes;
				if (entry.key !== undefined) {
					const count = (this.activeKeys.get(entry.key) ?? 1) - 1;
					if (count) this.activeKeys.set(entry.key, count);
					else this.activeKeys.delete(entry.key);
				}
				this.pump();
				if (this.closed && this.active === 0) this.drained?.();
			},
		});
	}
}
