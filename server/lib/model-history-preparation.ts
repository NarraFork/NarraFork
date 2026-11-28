/** Pure budget/observation primitives: safe to import in read-only history workers. */
export const MODEL_HISTORY_OBSERVE_MS = 10_000;
export const MODEL_HISTORY_EXECUTION_MS = 30_000;

export class ModelHistoryTimeoutError extends Error {
	constructor() {
		super("Model history preparation exceeded 30s budget");
		this.name = "ModelHistoryTimeoutError";
	}
}

export type HistoryPreparationPhase =
	| "prepare"
	| "tools"
	| "source"
	| "signature"
	| "queue"
	| "read"
	| "freeze"
	| "epoch"
	| "placement"
	| "mapping"
	| "attachments"
	| "toolState"
	| "projection"
	| "delivery"
	| "systemPrompt";
export type HistoryPreparationCount =
	| "refs"
	| "toolRows"
	| "sourceBytes"
	| "preparedBytes"
	| "refQueries"
	| "bodyQueries"
	| "toolQueries"
	| "reusedBodies"
	| "reusedTools"
	| "cacheHits"
	| "messages"
	| "tools"
	| "distinctAttachments"
	| "newCopies"
	| "copiedBytes";
export type HistoryPreparationOutcome = "success" | "timeout" | "cancelled" | "failed";

const failures = new WeakMap<
	object,
	{ preparationId: string; outcome: HistoryPreparationOutcome }
>();
/** Follow native Error cause data only, with bounded work and cycle/getter safety. */
function historyErrorCauses(error: unknown): object[] {
	const causes: object[] = [];
	const seen = new Set<object>();
	for (let depth = 0; depth < 16 && typeof error === "object" && error !== null; depth++) {
		if (seen.has(error)) break;
		seen.add(error);
		causes.push(error);
		const cause =
			error instanceof Error ? Object.getOwnPropertyDescriptor(error, "cause") : undefined;
		error = cause && "value" in cause ? cause.value : undefined;
	}
	return causes;
}

export function historyPreparationFailure(error: unknown) {
	for (const cause of historyErrorCauses(error)) {
		const failure = failures.get(cause);
		if (failure) return failure;
	}
	return undefined;
}

export interface HistoryPreparationOptions {
	narratorId: string;
	kind: "initial" | "rebuild" | "projection";
	logicalRunId?: string;
	signal?: AbortSignal;
	deadline?: number;
	/** Default: 30s. Null keeps observation/cancellation without a total preparation timeout. */
	timeoutMs?: number | null;
	warn?: (message: string, fields: Record<string, unknown>) => void;
	stallTimeBetween?: (start: number, end: number) => { stalledMs: number; maxStallMs: number };
	/** Small deterministic clock/scheduler seam; no application dependencies. */
	clock?: {
		wall: () => number;
		monotonic: () => number;
		schedule: (callback: () => void, delay: number) => () => void;
	};
}

const clock = {
	wall: () => Date.now(),
	monotonic: () => performance.now(),
	schedule(callback: () => void, delay: number) {
		const timer = setTimeout(callback, delay);
		timer.unref?.();
		return () => clearTimeout(timer);
	},
};

/** One root per preparation. Children borrow its signal, deadline and request-local counters. */
export class ModelHistoryPreparation {
	readonly preparationId = crypto.randomUUID();
	readonly deadline: number;
	readonly signal: AbortSignal;
	private readonly controller = new AbortController();
	private readonly clock;
	private readonly startedAt: number;
	private readonly startedWall: number;
	private phaseStartedAt: number;
	private currentPhase: HistoryPreparationPhase = "prepare";
	private readonly durations: Partial<Record<HistoryPreparationPhase, number>> = {};
	private readonly counts: Partial<Record<HistoryPreparationCount, number>> = {};
	private observed = false;
	private ended = false;
	private readonly clearObservation: () => void;
	private readonly clearDeadline: () => void;
	private readonly abort = () => {
		this.controller.abort(this.options.signal?.reason);
		this.clearObservation();
		this.clearDeadline();
	};

	constructor(private readonly options: HistoryPreparationOptions) {
		this.clock = options.clock ?? clock;
		this.startedWall = this.clock.wall();
		this.startedAt = this.phaseStartedAt = this.clock.monotonic();
		this.deadline = Math.min(
			options.deadline ?? Infinity,
			options.timeoutMs === null
				? Infinity
				: this.startedWall + (options.timeoutMs ?? MODEL_HISTORY_EXECUTION_MS),
		);
		this.signal = this.controller.signal;
		this.clearObservation = this.clock.schedule(() => this.observe(), MODEL_HISTORY_OBSERVE_MS);
		this.clearDeadline = Number.isFinite(this.deadline)
			? this.clock.schedule(
					() => {
						this.observe();
						this.controller.abort(new ModelHistoryTimeoutError());
						this.clearObservation();
						this.clearDeadline();
						options.signal?.removeEventListener("abort", this.abort);
					},
					Math.max(0, this.deadline - this.clock.wall()),
				)
			: () => {};
		if (options.signal?.aborted) this.abort();
		else options.signal?.addEventListener("abort", this.abort, { once: true });
	}

	private elapsed() {
		return Math.max(this.clock.wall() - this.startedWall, this.clock.monotonic() - this.startedAt);
	}
	private fields() {
		const now = this.clock.monotonic();
		return {
			preparationId: this.preparationId,
			narratorId: this.options.narratorId,
			kind: this.options.kind,
			...(this.options.logicalRunId ? { logicalRunId: this.options.logicalRunId } : {}),
			phase: this.currentPhase,
			elapsedMs: Math.round(this.elapsed()),
			phaseMs: Math.round(now - this.phaseStartedAt),
			phaseDurationsMs: {
				...this.durations,
				[this.currentPhase]: Math.round(
					(this.durations[this.currentPhase] ?? 0) + now - this.phaseStartedAt,
				),
			},
			counts: { ...this.counts },
			...this.options.stallTimeBetween?.(this.startedAt, now),
		};
	}
	private warn(message: string, fields: Record<string, unknown>) {
		try {
			this.options.warn?.(message, fields);
		} catch {
			// Observation must never reject a valid history or replace its original failure.
		}
	}
	private observe() {
		if (this.ended || this.observed || this.elapsed() < MODEL_HISTORY_OBSERVE_MS) return;
		this.observed = true;
		this.warn("Slow model history preparation", this.fields());
	}
	check(): void {
		this.observe();
		// User cancellation wins even if a deadline and an abort land together.
		this.options.signal?.throwIfAborted();
		if (this.clock.wall() >= this.deadline) {
			const error = new ModelHistoryTimeoutError();
			this.controller.abort(error);
			throw error;
		}
		this.signal.throwIfAborted();
	}
	phase(phase: HistoryPreparationPhase): void {
		this.check();
		this.recordPhase(phase);
	}
	/** Record timing without introducing a cancellation checkpoint. */
	recordPhase(phase: HistoryPreparationPhase): void {
		const now = this.clock.monotonic();
		this.durations[this.currentPhase] =
			(this.durations[this.currentPhase] ?? 0) + now - this.phaseStartedAt;
		this.currentPhase = phase;
		this.phaseStartedAt = now;
	}
	count(name: HistoryPreparationCount, value: number): void {
		if (Number.isFinite(value) && value >= 0) this.counts[name] = (this.counts[name] ?? 0) + value;
	}
	finish(error?: unknown): void {
		if (this.ended) return;
		this.observe();
		const outcome: HistoryPreparationOutcome = this.options.signal?.aborted
			? "cancelled"
			: this.clock.wall() >= this.deadline ||
					historyErrorCauses(error).some((cause) => cause instanceof ModelHistoryTimeoutError) ||
					this.signal.reason instanceof ModelHistoryTimeoutError
				? "timeout"
				: error === undefined
					? "success"
					: "failed";
		this.ended = true;
		this.clearObservation();
		this.clearDeadline();
		this.options.signal?.removeEventListener("abort", this.abort);
		if (typeof error === "object" && error !== null)
			failures.set(error, { preparationId: this.preparationId, outcome });
		if (this.observed || outcome !== "success")
			this.warn("Model history preparation finished", { ...this.fields(), outcome });
	}
}
