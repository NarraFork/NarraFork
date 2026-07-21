/**
 * Tracks the outcome of each graceful-shutdown teardown step so the shutdown sequence can
 * decide, at the very end, whether the database clean-shutdown marker may be persisted.
 *
 * The clean marker means "the previous process reached a quiescent, consistent state, so the
 * next startup may skip the expensive integrity check + FTS rebuild". That guarantee only holds
 * when in-flight requests drained AND every teardown step finished successfully. If any step
 * timed out or threw, we must NOT persist the marker — the next startup should run its integrity
 * check because we cannot prove the DB is consistent. On that degraded path the shutdown still
 * releases the instance lock (so an update-handoff replacement can start), it just skips the
 * clean marker.
 */
export type ShutdownStepOutcome = "ok" | "timeout" | "failed";

export interface ShutdownStepRecord {
	label: string;
	outcome: ShutdownStepOutcome;
}

export interface ShutdownActivitySummary {
	clean: boolean;
	drainComplete: boolean;
	steps: ShutdownStepRecord[];
	degradedSteps: ShutdownStepRecord[];
}

export class ShutdownActivityTracker {
	private readonly steps: ShutdownStepRecord[] = [];
	private drainComplete = false;

	/** Record the outcome of a single teardown step. */
	recordStep(label: string, outcome: ShutdownStepOutcome): void {
		this.steps.push({ label, outcome });
	}

	/** Mark that in-flight requests were drained and the HTTP server stopped cleanly. */
	markDrainComplete(): void {
		this.drainComplete = true;
	}

	/** True when any recorded teardown step timed out or failed. */
	get hasDegradedSteps(): boolean {
		return this.steps.some((step) => step.outcome !== "ok");
	}

	/**
	 * A shutdown is clean only when in-flight requests drained AND every recorded teardown step
	 * finished successfully (no timeout, no failure). Only then may the clean marker be written.
	 */
	isCleanShutdown(): boolean {
		return this.drainComplete && !this.hasDegradedSteps;
	}

	summary(): ShutdownActivitySummary {
		return {
			clean: this.isCleanShutdown(),
			drainComplete: this.drainComplete,
			steps: [...this.steps],
			degradedSteps: this.steps.filter((step) => step.outcome !== "ok"),
		};
	}
}
