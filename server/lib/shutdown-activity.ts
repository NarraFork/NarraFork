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

/** Cancel only the waiter; callers must treat cancellation as degraded shutdown. */
export function waitForShutdownWork(work: Promise<unknown>, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason ?? new Error("Shutdown drain cancelled"));
		if (signal.aborted) {
			abort();
			return;
		}
		signal.addEventListener("abort", abort, { once: true });
		work.then(
			() => {
				signal.removeEventListener("abort", abort);
				resolve();
			},
			(error) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}

/** The same bounded step is used by production shutdown and its isolated orchestration tests. */
export async function shutdownStep(
	tracker: ShutdownActivityTracker,
	label: string,
	fn: (signal: AbortSignal) => unknown,
	timeoutMs = 4000,
	report?: (outcome: ShutdownStepOutcome, error?: unknown) => void,
): Promise<ShutdownStepOutcome> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => {
				resolve("timeout");
				controller.abort(new Error(`Shutdown step timed out: ${label}`));
			}, timeoutMs);
		});
		const outcome = await Promise.race([
			Promise.resolve()
				.then(() => fn(controller.signal))
				.then(() => "ok" as const)
				.catch((error) => {
					if (!controller.signal.aborted) report?.("failed", error);
					return "failed" as const;
				}),
			timeout,
		]);
		if (outcome === "timeout") report?.(outcome);
		tracker.recordStep(label, outcome);
		return outcome;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export interface ShutdownEffectDrain {
	drain(signal: AbortSignal): Promise<void>;
	state(): { pending: number; failureCount: number; firstError?: unknown };
}

/** Revisit earlier sets when a later listener creates recovery/occupancy work. */
export async function drainShutdownEffects(
	effects: ShutdownEffectDrain[],
	signal: AbortSignal,
): Promise<void> {
	for (;;) {
		signal.throwIfAborted();
		const errors: unknown[] = [];
		for (const effect of effects) {
			signal.throwIfAborted();
			try {
				await effect.drain(signal);
			} catch (error) {
				errors.push(error);
			}
		}
		signal.throwIfAborted();
		await Promise.resolve();
		const states = effects.map((effect) => effect.state());
		const failed = states.find((state) => state.failureCount > 0);
		if (failed) throw failed.firstError ?? new Error("Shutdown side effect failed");
		if (errors.length) throw errors[0];
		if (states.every((state) => state.pending === 0)) return;
	}
}

/** Database-dependent tail only: no server import, global registry, or runtime startup. */
export async function runShutdownDatabaseTail(
	tracker: ShutdownActivityTracker,
	hooks: {
		drainProducers(signal: AbortSignal): Promise<void>;
		drainEffects(signal: AbortSignal): Promise<void>;
		teardown(): Promise<void>;
		closeProjects(): unknown;
		drainReadPool(): Promise<void>;
		forceReadPool(): unknown;
		closeDatabase(): unknown;
	},
	step: typeof shutdownStep = shutdownStep,
): Promise<void> {
	await step(tracker, "producers.drain", hooks.drainProducers, 10_000);
	await step(tracker, "effects.drain", hooks.drainEffects, 10_000);
	try {
		await hooks.teardown();
	} catch (error) {
		// Individual teardown hooks carry their own budgets; synchronous glue must also degrade.
		await step(tracker, "teardown", () => {
			throw error;
		});
	}
	// Teardown hooks may themselves emit events or persist recovery cards.
	await step(tracker, "effects.finalDrain", hooks.drainEffects, 10_000);
	await step(tracker, "projectDbManager.closeAll", hooks.closeProjects);
	const poolOutcome = await step(tracker, "dbWorkerPool.drain", hooks.drainReadPool, 10_000);
	if (poolOutcome !== "ok") await step(tracker, "dbWorkerPool.forceShutdown", hooks.forceReadPool);
	await step(tracker, "postgresRuntime.close", hooks.closeDatabase);
}

/** Only checkpoint-backed exits may leave recoverable processes/browser sessions alive. */
export function preservesRecoveryOnShutdown(reason: string): boolean {
	return reason === "replacement_started" || reason === "system_prepared_shutdown";
}

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
