/**
 * progress-phase.ts — Shared two-phase progress contract for auxiliary model
 * calls (context compaction and the reflection gates).
 *
 * WHY TWO PHASES
 *
 * Some models emit reasoning/thinking deltas before they produce any visible
 * output. A single "N chars" counter therefore sat at 0 for the whole thinking
 * window and looked stalled. Splitting the progress into a `thinking` phase and
 * an `output` phase lets the UI say "thinking · N chars" first and switch to the
 * real output count once visible text starts arriving.
 *
 * The phase only ever moves FORWARD (`thinking` → `output`). Providers can
 * interleave reasoning and text deltas, and flipping the label back and forth
 * would just look like a glitch, so once visible text has been seen the phase
 * stays on `output` while `thinkingChars` keeps accumulating in the background.
 *
 * WHY THIS LIVES IN shared/ ROOT
 *
 * Both the server broadcast path and the frontend renderers need it, exactly
 * like `shared/compact-message.ts`. It deliberately does NOT live in
 * `shared/pretext-layout/`: that directory's `shared-core.guard.test.ts` guards
 * a pure layout core, and a contract imported by server broadcast code is not
 * part of that core.
 */

export type ProgressPhase = "thinking" | "output";

/**
 * Below this many thinking characters the UI shows a bare "thinking" label with
 * no number. A handful of characters conveys nothing and makes the label jitter
 * while the stream warms up.
 *
 * The threshold is applied at RENDER time, not at broadcast time: the server
 * always reports the true counts, so tuning this never requires a server change
 * and cannot interact with the broadcast throttle window.
 */
export const THINKING_CHARS_MIN_DISPLAY = 20;

/** Whether a thinking-phase character count is worth showing next to the label. */
export function shouldShowThinkingChars(chars: number | null | undefined): boolean {
	return typeof chars === "number" && Number.isFinite(chars) && chars >= THINKING_CHARS_MIN_DISPLAY;
}

/**
 * One progress observation. `thinkingChars` and `outputChars` are independent
 * running totals; `phase` says which one the label should feature.
 */
export interface ProgressSnapshot {
	phase: ProgressPhase;
	thinkingChars: number;
	outputChars: number;
}

/** The count the label should feature for a snapshot's current phase. */
export function phaseChars(snapshot: ProgressSnapshot): number {
	return snapshot.phase === "thinking" ? snapshot.thinkingChars : snapshot.outputChars;
}

function nonNegativeInt(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.floor(value));
}

/**
 * Normalize an untrusted progress payload (WS event / persisted block).
 *
 * Backward compatibility: a payload from an older server carries only
 * `outputChars`, which normalizes to `{ phase: "output", thinkingChars: 0 }` —
 * i.e. exactly the previous single-phase behaviour.
 */
export function coerceProgressSnapshot(value: {
	phase?: unknown;
	thinkingChars?: unknown;
	outputChars?: unknown;
}): ProgressSnapshot {
	return {
		phase: value.phase === "thinking" ? "thinking" : "output",
		thinkingChars: nonNegativeInt(value.thinkingChars),
		outputChars: nonNegativeInt(value.outputChars),
	};
}

/**
 * Accumulator behind every two-phase progress reporter (compact + reflection).
 *
 * Owns the two rules that must not be re-derived per call site:
 *   1. The phase only moves forward, so late reasoning cannot un-switch a stream
 *      that already produced visible text.
 *   2. De-duplication keys on the WHOLE snapshot, not just `outputChars`. Keying
 *      on the output count alone silently dropped every thinking-phase update,
 *      because `outputChars` stays 0 for the entire thinking window.
 */
export class ProgressAccumulator {
	private thinkingChars = 0;
	private outputChars = 0;
	private phase: ProgressPhase = "thinking";
	private lastPublished: ProgressSnapshot | null = null;

	/** Record a reasoning/thinking delta. Never moves the phase backwards. */
	addThinking(delta: string): void {
		if (!delta) return;
		this.thinkingChars += delta.length;
	}

	/** Record a visible-text delta. Latches the phase to `output`. */
	addOutput(delta: string): void {
		if (!delta) return;
		this.outputChars += delta.length;
		this.phase = "output";
	}

	snapshot(): ProgressSnapshot {
		return {
			phase: this.phase,
			thinkingChars: this.thinkingChars,
			outputChars: this.outputChars,
		};
	}

	/** True when the accumulator moved since the last {@link markPublished}. */
	hasPendingChange(): boolean {
		const next = this.snapshot();
		const last = this.lastPublished;
		if (!last) return next.thinkingChars > 0 || next.outputChars > 0;
		return (
			last.phase !== next.phase ||
			last.thinkingChars !== next.thinkingChars ||
			last.outputChars !== next.outputChars
		);
	}

	/** True when the phase differs from the last published snapshot. */
	hasPhaseChange(): boolean {
		return this.lastPublished !== null && this.lastPublished.phase !== this.phase;
	}

	markPublished(): ProgressSnapshot {
		const snapshot = this.snapshot();
		this.lastPublished = snapshot;
		return snapshot;
	}
}

/** Default publish cadence for progress updates. */
export const PROGRESS_THROTTLE_MS = 120;

export interface ThrottledProgressReporter {
	/** Record a reasoning/thinking delta. */
	addThinking: (delta: string) => void;
	/** Record a visible-text delta (latches the phase to `output`). */
	addOutput: (delta: string) => void;
	/** Flush any pending update and stop reporting. Idempotent. */
	finish: () => void;
}

/**
 * Throttled two-phase progress reporter — the single implementation behind
 * compaction, the reflection loop, and the AskUserQuestion reflection.
 *
 * Two behaviours worth keeping in one place:
 *   - A PHASE TRANSITION flushes immediately instead of waiting out the throttle
 *     window, so the label cannot keep saying "thinking" after visible output has
 *     already started.
 *   - De-duplication keys on the whole snapshot (see {@link ProgressAccumulator}),
 *     which is what makes thinking-phase updates observable at all.
 *
 * Passing no `publish` yields a no-op reporter, so call sites can wire the
 * callbacks unconditionally.
 */
export function createThrottledProgressReporter(
	publish?: (snapshot: ProgressSnapshot) => void,
	throttleMs: number = PROGRESS_THROTTLE_MS,
): ThrottledProgressReporter {
	if (!publish) {
		const noop = () => {};
		return { addThinking: noop, addOutput: noop, finish: noop };
	}
	const progress = new ProgressAccumulator();
	let timer: ReturnType<typeof setTimeout> | null = null;
	let finished = false;

	const flush = () => {
		timer = null;
		if (finished || !progress.hasPendingChange()) return;
		publish(progress.markPublished());
	};

	const schedule = () => {
		if (progress.hasPhaseChange()) {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			flush();
			return;
		}
		if (!timer) timer = setTimeout(flush, throttleMs);
	};

	return {
		addThinking: (delta) => {
			if (finished || !delta) return;
			progress.addThinking(delta);
			schedule();
		},
		addOutput: (delta) => {
			if (finished || !delta) return;
			progress.addOutput(delta);
			schedule();
		},
		finish: () => {
			if (finished) return;
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			flush();
			finished = true;
		},
	};
}
