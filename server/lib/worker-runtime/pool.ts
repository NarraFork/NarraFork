import { generateId } from "../id";
import { WorkerCleanupError } from "./lifecycle";
import {
	type TaskClass,
	TaskQueue,
	type TaskQueueAdmission,
	type TaskQueueClaim,
	TaskQueueError,
	type TaskQueueOptions,
} from "./queue";

export interface WorkerTaskContext {
	readonly signal: AbortSignal;
	readonly deadlineAt: number;
	readonly requestId: string;
}

export interface WorkerTaskOptions extends TaskQueueAdmission {
	fresh?: boolean;
	/** Reuse an existing RPC ID, never a message/connection's business identity. */
	requestId?: string;
}

/** Fixed, payload-free summary. Close time includes the domain's drain/ACK and actual exit. */
export interface WorkerTaskTiming {
	requestId: string;
	kind: "task" | "warmup";
	outcome: "ok" | "error";
	reused: boolean;
	queueMs: number;
	readyMs: number;
	execMs: number;
	closeMs: number;
	totalMs: number;
}

/** Domain adapters own the wire protocol, validation, and actual worker shutdown. */
export interface PoolWorker<Request, Result> {
	/** True once unusable, including closing. Domain validation failures do not close a worker. */
	readonly closed: boolean;
	run(request: Request, context: WorkerTaskContext): Promise<Result>;
	/** Resolves only after the actual worker and its owned resources have stopped. */
	close(): Promise<void>;
}

export interface WorkerPoolOptions<Request, Result> extends TaskQueueOptions {
	/** Fixed short-only native capacity. Omitted preserves the existing unclassified pool. */
	reservedCapacity?: number;
	/** Returns a ready worker; failed/cancelled startup must clean up anything it created. */
	create(context: WorkerTaskContext): Promise<PoolWorker<Request, Result>>;
	/** Positive idle TTL; default 60 seconds. Idle timers never keep a process alive. */
	idleTimeoutMs?: number;
	/** False keeps existing one-shot isolation: every completed job closes its worker. */
	reuse?: boolean;
	/** Optional synchronous logger; its closure supplies the pool name and caller trace context. */
	onTaskComplete?: (timing: Readonly<WorkerTaskTiming>) => void;
}

export class WorkerPoolError extends Error {
	constructor(readonly code: "WORKER_POOL_CLOSED" | "WORKER_POOL_UNAVAILABLE") {
		super(code === "WORKER_POOL_CLOSED" ? "Worker pool is closed" : "Worker is unavailable");
		this.name = "WorkerPoolError";
	}
}

interface Slot<Request, Result> {
	worker: PoolWorker<Request, Result>;
	busy: boolean;
	idleTimer?: ReturnType<typeof setTimeout>;
	closing?: Promise<void>;
	quarantined?: boolean;
	cell?: CapacityCell<Request, Result>;
}

interface CapacityCell<Request, Result> {
	readonly reserved: boolean;
	claim?: CapacityClaim<Request, Result>;
	starting: boolean;
	slot?: Slot<Request, Result>;
}

interface CapacityClaim<Request, Result> extends TaskQueueClaim {
	readonly token: symbol;
	readonly taskClass: TaskClass;
	readonly cell: CapacityCell<Request, Result>;
}

function diagnosticClock(): () => number {
	let previous = 0;
	let failed = false;
	return () => {
		if (failed) return previous;
		try {
			const now = performance.now();
			if (Number.isFinite(now)) previous = Math.max(previous, now);
			else failed = true;
		} catch {
			failed = true;
		}
		// Once unavailable, freeze this observation rather than inventing elapsed time.
		return previous;
	};
}

/** Same-type reuse over TaskQueue; no global scheduler, task replay, or inline computation. */
export class WorkerPool<Request, Result> {
	private readonly queue: TaskQueue;
	private readonly create: WorkerPoolOptions<Request, Result>["create"];
	private readonly idleTimeoutMs: number;
	private readonly reuse: boolean;
	private readonly concurrency: number;
	private readonly reservedCapacity: number | undefined;
	private readonly cells: CapacityCell<Request, Result>[] | undefined;
	private readonly queueLimits: {
		maxQueued: number;
		maxQueuedBytes: number;
		normalQueue?: { maxQueued: number; maxQueuedBytes: number };
	};
	private readonly onTaskComplete: WorkerPoolOptions<Request, Result>["onTaskComplete"];
	private readonly slots = new Set<Slot<Request, Result>>();
	private readonly scopes = new Set<AbortController>();
	private starting = 0;
	private created = 0;
	private reused = 0;
	/** Failed run/warmup attempts, including admission, startup and cleanup failures. */
	private failed = 0;
	private closed = false;
	private closeReason: unknown;
	private closing: Promise<void> | undefined;
	private warming: Promise<void> | undefined;

	constructor(options: WorkerPoolOptions<Request, Result>) {
		this.reservedCapacity = options.reservedCapacity;
		if (
			this.reservedCapacity !== undefined &&
			(!Number.isSafeInteger(this.reservedCapacity) ||
				this.reservedCapacity < 0 ||
				this.reservedCapacity > options.concurrency)
		)
			throw new RangeError("reservedCapacity must be a safe integer between 0 and concurrency");
		this.cells =
			this.reservedCapacity === undefined
				? undefined
				: Array.from({ length: options.concurrency }, (_, index) => ({
						reserved: index < (this.reservedCapacity ?? 0),
						starting: false,
					}));
		this.queue = new TaskQueue(
			options,
			this.cells
				? {
						canGrant: (taskClass) => this.availableCell(taskClass) !== undefined,
						claim: (taskClass) => this.claimCell(taskClass),
					}
				: undefined,
		);
		this.queueLimits = {
			maxQueued: options.maxQueued ?? 32,
			maxQueuedBytes: options.maxQueuedBytes ?? 64 * 1024 * 1024,
			normalQueue: options.normalQueue ? { ...options.normalQueue } : undefined,
		};
		this.create = options.create;
		this.concurrency = options.concurrency;
		this.onTaskComplete = options.onTaskComplete;
		this.reuse = options.reuse ?? true;
		this.idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
		if (
			!Number.isSafeInteger(this.idleTimeoutMs) ||
			this.idleTimeoutMs <= 0 ||
			this.idleTimeoutMs > 2_147_483_647
		)
			throw new RangeError("idleTimeoutMs must be between 1 and 2147483647 ms");
	}

	get stats() {
		const { active, queued, queuedBytes, activeByClass, queuedByClass, queuedBytesByClass } =
			this.queue.stats;
		return {
			active,
			queued,
			queuedBytes,
			concurrency: this.concurrency,
			reservedCapacity: this.reservedCapacity ?? 0,
			normalCapacity: this.concurrency - (this.reservedCapacity ?? 0),
			...this.queueLimits,
			normalQueue: this.queueLimits.normalQueue ? { ...this.queueLimits.normalQueue } : undefined,
			activeByClass: activeByClass ?? { normal: active, short: 0 },
			queuedByClass: queuedByClass ?? { normal: queued, short: 0 },
			queuedBytesByClass: queuedBytesByClass ?? { normal: queuedBytes, short: 0 },
			reservation: this.cells
				? { shared: this.cellStats(false), reserved: this.cellStats(true) }
				: undefined,
			closed: this.closed,
			workers: this.slots.size,
			starting: this.starting,
			idle: [...this.slots].filter((s) => !s.busy && !s.closing && !s.worker.closed).length,
			retiring: [...this.slots].filter((s) => s.closing).length,
			quarantined: [...this.slots].filter((s) => s.quarantined).length,
			created: this.created,
			reused: this.reused,
			failed: this.failed,
		};
	}

	run(request: Request, options: WorkerTaskOptions = {}): Promise<Result> {
		return this.withWorker((worker, context) => worker.run(request, context), options);
	}

	/** Best effort: warm one reusable worker without joining a full/busy task queue. */
	warmup(
		options: Pick<TaskQueueAdmission, "signal" | "deadlineAt" | "taskClass"> = {},
	): Promise<void> {
		if (this.closed) return this.withWorker(async () => {}, options, "warmup");
		if (this.warming) return this.warming;
		if (
			!this.reuse ||
			this.queue.stats.queued > 0 ||
			this.queue.stats.active >= this.concurrency ||
			(this.cells && !this.availableCell(options.taskClass ?? "normal"))
		)
			return Promise.resolve();
		const warming = this.withWorker(async () => {}, options, "warmup");
		this.warming = warming;
		void warming
			.finally(() => {
				if (this.warming === warming) this.warming = undefined;
			})
			.catch(() => {});
		return warming;
	}

	close(reason: unknown = new WorkerPoolError("WORKER_POOL_CLOSED")): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		this.closeReason = reason;
		let resolve!: () => void;
		let reject!: (reason: unknown) => void;
		this.closing = new Promise<void>((accept, fail) => {
			resolve = accept;
			reject = fail;
		});
		// Stop queue admission BEFORE aborting active work: releasing an aborted task must not
		// dispatch another waiter. Start closing live workers even if a task ignores its signal.
		const drained = this.queue.close(reason);
		for (const scope of this.scopes) scope.abort(reason);
		void Promise.all([drained, ...[...this.slots].map((slot) => this.retire(slot))])
			// A cancelled factory may finish after the initial snapshot. Check its cleanup too.
			.then(() => Promise.all([...this.slots].map((slot) => this.retire(slot))))
			.then(() => resolve(), reject);
		return this.closing;
	}

	private async withWorker<T>(
		work: (worker: PoolWorker<Request, Result>, context: WorkerTaskContext) => Promise<T>,
		options: WorkerTaskOptions,
		kind: WorkerTaskTiming["kind"] = "task",
	): Promise<T> {
		const now = diagnosticClock();
		const startedAt = now();
		const timing: WorkerTaskTiming = {
			requestId: options.requestId ?? generateId(),
			kind,
			outcome: "error",
			reused: false,
			queueMs: 0,
			readyMs: 0,
			execMs: 0,
			closeMs: 0,
			totalMs: 0,
		};
		type Phase = "queueMs" | "readyMs" | "execMs" | "closeMs";
		let phase: Phase | undefined = "queueMs";
		let phaseAt = startedAt;
		const mark = (next?: Phase) => {
			const observedAt = now();
			if (phase) timing[phase] += observedAt - phaseAt;
			phaseAt = observedAt;
			phase = next;
		};
		const { signal } = options;
		const scope = new AbortController();
		const forwardAbort = () => scope.abort(signal?.reason);
		try {
			if (this.closed) throw this.closeReason;
			signal?.addEventListener("abort", forwardAbort, { once: true });
			if (signal?.aborted) forwardAbort();
			this.scopes.add(scope);
			const result = await this.queue.run(
				async (permit) => {
					mark("readyMs");
					const context = {
						signal: permit.signal,
						deadlineAt: permit.deadlineAt,
						requestId: timing.requestId,
					};
					const slot = permit.claim
						? await this.borrowClaimed(
								context,
								timing,
								options.fresh ?? false,
								permit.claim as CapacityClaim<Request, Result>,
							)
						: await this.borrow(context, timing, options.fresh ?? false);
					let dispatched = false;
					try {
						this.check(context);
						if (slot.worker.closed) throw new WorkerPoolError("WORKER_POOL_UNAVAILABLE");
						mark("execMs");
						dispatched = true;
						const value = await this.execute(slot, context, work);
						this.check(context);
						return value;
					} finally {
						mark("closeMs");
						try {
							if (
								!dispatched ||
								options.fresh ||
								!this.reuse ||
								context.signal.aborted ||
								this.closed ||
								slot.worker.closed
							)
								await this.retire(slot);
							else this.idle(slot);
						} finally {
							mark();
						}
					}
				},
				{ ...options, signal: scope.signal },
			);
			timing.outcome = "ok";
			return result;
		} catch (error) {
			this.failed++;
			throw error;
		} finally {
			this.scopes.delete(scope);
			signal?.removeEventListener("abort", forwardAbort);
			mark();
			timing.totalMs = phaseAt - startedAt;
			try {
				this.onTaskComplete?.({
					...timing,
					queueMs: Math.round(timing.queueMs),
					readyMs: Math.round(timing.readyMs),
					execMs: Math.round(timing.execMs),
					closeMs: Math.round(timing.closeMs),
					totalMs: Math.round(timing.totalMs),
				});
			} catch {
				// A synchronous diagnostic sink cannot change a task or its cleanup outcome.
			}
		}
	}

	private check(context: WorkerTaskContext): void {
		context.signal.throwIfAborted();
		if (this.closed) throw this.closeReason;
		if (Date.now() >= context.deadlineAt) throw new TaskQueueError("TASK_QUEUE_TIMEOUT");
	}

	private async execute<T>(
		slot: Slot<Request, Result>,
		context: WorkerTaskContext,
		work: (worker: PoolWorker<Request, Result>, context: WorkerTaskContext) => Promise<T>,
	): Promise<T> {
		let abort!: () => void;
		const cancelled = new Promise<never>((_resolve, reject) => {
			abort = () => {
				void this.retire(slot).then(() => reject(context.signal.reason), reject);
			};
			context.signal.addEventListener("abort", abort, { once: true });
			if (context.signal.aborted) abort();
		});
		try {
			const running = Promise.resolve().then(() => {
				this.check(context);
				return work(slot.worker, context);
			});
			return await Promise.race([running, cancelled]);
		} catch (error) {
			// Termination may reject the RPC before close() resolves; preserve its cancellation cause.
			context.signal.throwIfAborted();
			throw error;
		} finally {
			context.signal.removeEventListener("abort", abort);
		}
	}

	private cellStats(reserved: boolean) {
		const cells = this.cells?.filter((cell) => cell.reserved === reserved) ?? [];
		return {
			capacity: cells.length,
			claimed: cells.filter((cell) => cell.claim).length,
			starting: cells.filter((cell) => cell.starting).length,
			running: cells.filter(
				(cell) => cell.slot?.busy && !cell.slot.closing && !cell.slot.quarantined,
			).length,
			idle: cells.filter(
				(cell) => cell.slot && !cell.slot.busy && !cell.slot.closing && !cell.slot.worker.closed,
			).length,
			retiring: cells.filter((cell) => cell.slot?.closing && !cell.slot.quarantined).length,
			quarantined: cells.filter((cell) => cell.slot?.quarantined).length,
		};
	}

	private availableCell(taskClass: TaskClass): CapacityCell<Request, Result> | undefined {
		const eligible = (cell: CapacityCell<Request, Result>) =>
			!cell.claim && !cell.starting && !cell.slot?.closing && !cell.slot?.quarantined;
		if (taskClass === "short") {
			const reserved = this.cells?.find((cell) => cell.reserved && eligible(cell));
			if (reserved) return reserved;
		}
		return this.cells?.find((cell) => !cell.reserved && eligible(cell));
	}

	private claimCell(taskClass: TaskClass): CapacityClaim<Request, Result> {
		const cell = this.availableCell(taskClass);
		if (!cell) throw new WorkerPoolError("WORKER_POOL_UNAVAILABLE");
		const claim: CapacityClaim<Request, Result> = {
			token: Symbol("worker-capacity-claim"),
			taskClass,
			cell,
			release: () => {
				// A prior request's finally must never clear a successor's claim or native owner.
				if (cell.claim?.token !== claim.token) return;
				cell.claim = undefined;
				const slot = cell.slot;
				if (slot && !slot.closing) {
					if (slot.worker.closed) void this.retire(slot).catch(() => {});
					else if (slot.busy) this.idle(slot);
				}
			},
		};
		cell.claim = claim;
		if (cell.slot) {
			cell.slot.busy = true;
			clearTimeout(cell.slot.idleTimer);
			cell.slot.idleTimer = undefined;
		}
		return claim;
	}

	private async borrowClaimed(
		context: WorkerTaskContext,
		timing: WorkerTaskTiming,
		fresh: boolean,
		claim: CapacityClaim<Request, Result>,
	): Promise<Slot<Request, Result>> {
		this.check(context);
		const { cell } = claim;
		if (cell.claim?.token !== claim.token) throw new WorkerPoolError("WORKER_POOL_UNAVAILABLE");
		if (cell.slot) {
			if (fresh || cell.slot.worker.closed) {
				await this.retire(cell.slot);
				this.check(context);
			} else {
				this.reused++;
				timing.reused = true;
				return cell.slot;
			}
		}
		// This exact cell remains claimed while the factory is suspended.
		cell.starting = true;
		this.starting++;
		try {
			const worker = await this.create(context);
			const slot: Slot<Request, Result> = { worker, busy: true, cell };
			cell.slot = slot;
			this.slots.add(slot);
			this.created++;
			return slot;
		} catch (error) {
			if (error instanceof WorkerCleanupError) {
				const slot: Slot<Request, Result> = {
					busy: true,
					quarantined: true,
					cell,
					worker: {
						closed: true,
						run: async () => {
							throw error;
						},
						// Startup already attempted stop. Observe exit without calling terminate again.
						close: async () => {
							await error.handle.exited;
						},
					},
				};
				cell.slot = slot;
				this.slots.add(slot);
				void this.retire(slot).catch(() => {});
			}
			// The original failed task is not held hostage by a worker that may never exit.
			throw error;
		} finally {
			cell.starting = false;
			this.starting--;
		}
	}

	private async borrow(
		context: WorkerTaskContext,
		timing: WorkerTaskTiming,
		fresh: boolean,
	): Promise<Slot<Request, Result>> {
		for (;;) {
			this.check(context);
			for (const slot of this.slots) {
				if (slot.busy || slot.closing) continue;
				if (slot.worker.closed) {
					void this.retire(slot).catch(() => {});
					continue;
				}
				if (fresh) {
					// Fresh jobs use the SAME admission permit and native capacity as reusable jobs.
					// At capacity, reserve one idle owner before awaiting its real exit; no caller
					// may borrow it or count a termination request as a free native slot.
					if (this.slots.size + this.starting >= this.concurrency) {
						slot.busy = true;
						await this.retire(slot);
						this.check(context);
						break;
					}
					continue;
				}
				// Claim before the first await so concurrent callers cannot share this worker.
				slot.busy = true;
				clearTimeout(slot.idleTimer);
				slot.idleTimer = undefined;
				this.reused++;
				timing.reused = true;
				return slot;
			}
			if (this.slots.size + this.starting >= this.concurrency) {
				const retiring = [...this.slots].flatMap((slot) => (slot.closing ? [slot.closing] : []));
				if (!retiring.length) throw new WorkerPoolError("WORKER_POOL_UNAVAILABLE");
				// Waiting for someone else's retirement owns no worker: cancellation removes only
				// this wait, while the retiring slot continues to account for its real resource.
				let abort!: () => void;
				const cancelled = new Promise<never>((_resolve, reject) => {
					abort = () => reject(context.signal.reason);
					context.signal.addEventListener("abort", abort, { once: true });
					if (context.signal.aborted) abort();
				});
				try {
					await Promise.race([...retiring, cancelled]);
				} finally {
					context.signal.removeEventListener("abort", abort);
				}
				continue;
			}
			this.starting++;
			let worker: PoolWorker<Request, Result>;
			try {
				worker = await this.create(context);
			} catch (error) {
				if (error instanceof WorkerCleanupError) {
					// Failed startup still consumes a native slot. Do not retry stop or forget it;
					// only its actual exit can make this resource available for replacement.
					const slot: Slot<Request, Result> = {
						busy: true,
						worker: {
							closed: true,
							run: async () => {
								throw error;
							},
							close: async () => {
								await error.handle.exited;
							},
						},
					};
					this.slots.add(slot);
					void this.retire(slot).catch(() => {});
				}
				throw error;
			} finally {
				this.starting--;
			}
			const slot = { worker, busy: true };
			this.slots.add(slot);
			this.created++;
			return slot;
		}
	}

	private idle(slot: Slot<Request, Result>): void {
		if (slot.closing) return;
		slot.busy = false;
		clearTimeout(slot.idleTimer);
		slot.idleTimer = setTimeout(() => void this.retire(slot).catch(() => {}), this.idleTimeoutMs);
		slot.idleTimer.unref?.();
	}

	private retire(slot: Slot<Request, Result>): Promise<void> {
		if (!slot.closing) {
			clearTimeout(slot.idleTimer);
			slot.idleTimer = undefined;
			slot.closing = Promise.resolve()
				.then(() => slot.worker.close())
				.then(
					() => {
						this.slots.delete(slot);
						if (slot.cell?.slot === slot) slot.cell.slot = undefined;
						// A fresh request may still hold this cell's claim; wake cannot take it.
						this.queue.wake();
					},
					(error: unknown) => {
						slot.quarantined = true;
						throw error;
					},
				);
			// A rejected close leaves this resource quarantined in the set: an unsuccessful
			// stop must not be counted as freed capacity or silently replaced by a new worker.
			void slot.closing.catch(() => {});
		}
		return slot.closing;
	}
}
