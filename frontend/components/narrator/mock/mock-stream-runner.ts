/**
 * mock-stream-runner.ts — Drives a built script into the WS listener fan-out.
 *
 * TEMPORARY MODULE (see ./README-REMOVAL.md).
 *
 * Timing model: one `setTimeout` per tick, re-armed after each batch, rather than
 * a `setInterval`. A fixed interval keeps firing while the main thread is busy
 * re-measuring, so the queue would silently pile up and the harness would measure
 * its own backlog instead of the list. Re-arming after the batch means a slow
 * frame simply slows the run down — which is the honest behaviour for a
 * calibration tool.
 *
 * `framesPerTick` exists for the same reason a real provider bursts: it lets the
 * operator ask for more pressure per frame without lowering the interval below
 * the browser's timer floor.
 */

import { narratorWSManager } from "@frontend/lib/narrator-ws-manager";
import { mockPermissionResolvedFrame, mockStreamingResetFrame } from "./mock-stream-frames";
import { buildMockScript, type MockScenario, type MockStep } from "./mock-stream-script";
import {
	resetMockStreamStats,
	setMockStreamActiveNarrator,
	setMockStreamStats,
} from "./mock-stream-store";

export type MockRunnerPhase = "idle" | "running" | "paused" | "finished";

export interface MockRunnerSnapshot {
	phase: MockRunnerPhase;
	/** Index of the next step to dispatch. */
	cursor: number;
	totalSteps: number;
	/** Round of the step last dispatched, or 0 before the run starts. */
	round: number;
}

export interface MockRunnerOptions {
	/** Delay between ticks, in ms. */
	intervalMs: number;
	/** How many steps to dispatch per tick. */
	framesPerTick: number;
	/** Restart from the beginning when the script ends. */
	loop: boolean;
}

export const DEFAULT_RUNNER_OPTIONS: MockRunnerOptions = {
	intervalMs: 40,
	framesPerTick: 1,
	loop: false,
};

/**
 * One mock run. Created per panel mount; `dispose()` guarantees no timer or
 * active-narrator flag survives an unmount.
 */
export class MockStreamRunner {
	private steps: MockStep[] = [];
	private cursor = 0;
	private phase: MockRunnerPhase = "idle";
	private timer: ReturnType<typeof setTimeout> | null = null;
	private startedAt = 0;
	private frames = 0;
	private chars = 0;
	private totalChars = 0;
	/** Round of the last dispatched step, surfaced so the UI can show progress. */
	private round = 0;
	private narratorId: string | null = null;
	private options: MockRunnerOptions = DEFAULT_RUNNER_OPTIONS;
	/** The loaded scenario, kept so a replay can rebuild with fresh request ids. */
	private scenario: MockScenario | null = null;
	/** Bumped per build: the panel drops a permission id it has seen resolved. */
	private runSeq = 0;
	/**
	 * The permission request currently on screen, if any. Stopping mid-hold must
	 * retire it explicitly — `streaming_reset` clears live blocks but not the
	 * panel's pending-permission map, so the form would otherwise outlive the run.
	 */
	private openPermission: { requestId: string; toolUseId: string } | null = null;
	private readonly onChange: () => void;

	constructor(onChange: () => void) {
		this.onChange = onChange;
	}

	get snapshot(): MockRunnerSnapshot {
		return {
			phase: this.phase,
			cursor: this.cursor,
			totalSteps: this.steps.length,
			round: this.round,
		};
	}

	setOptions(options: MockRunnerOptions): void {
		this.options = options;
	}

	/**
	 * Load a scenario, discarding any run in flight.
	 *
	 * Loading always stops first (and emits a `streaming_reset`), so a previous
	 * run's half-finished tool cards cannot bleed into the new one — nothing was
	 * persisted, so no structural hand-off would ever retire them.
	 */
	load(scenario: MockScenario, options: MockRunnerOptions): void {
		this.stop();
		this.options = options;
		this.narratorId = scenario.narratorId;
		this.scenario = scenario;
		this.rebuild();
		this.cursor = 0;
		this.frames = 0;
		this.chars = 0;
		this.round = 0;
		this.phase = "idle";
		resetMockStreamStats(this.steps.length, this.totalChars);
		this.onChange();
	}

	start(): void {
		if (this.steps.length === 0) return;
		if (this.phase === "running") return;
		if (this.phase === "finished" || this.cursor >= this.steps.length) {
			// A replay needs fresh permission ids, or its forms would never appear.
			this.rebuild();
			this.cursor = 0;
			this.frames = 0;
			this.chars = 0;
			this.round = 0;
		}
		// The streaming tail only mounts while the page believes the narrator is
		// active; flag it BEFORE the first frame so no delta is dropped.
		if (this.narratorId) setMockStreamActiveNarrator(this.narratorId);
		this.phase = "running";
		this.startedAt = Date.now();
		this.publishStats();
		this.onChange();
		this.arm();
	}

	pause(): void {
		if (this.phase !== "running") return;
		this.clearTimer();
		this.phase = "paused";
		this.onChange();
	}

	/** Dispatch exactly one step without starting the timer. */
	stepOnce(): void {
		if (this.cursor >= this.steps.length) return;
		if (this.narratorId) setMockStreamActiveNarrator(this.narratorId);
		if (this.phase === "idle" || this.phase === "finished") {
			this.phase = "paused";
			if (this.startedAt === 0) this.startedAt = Date.now();
		}
		this.dispatchNext();
		this.publishStats();
		this.onChange();
	}

	/**
	 * Stop and clear every live block.
	 *
	 * The reset frame is essential: the synthetic row is retired by the STRUCTURAL
	 * hand-off (a persisted message containing the same content), and mock content
	 * is never persisted — without the reset the row would stay on screen with a
	 * running elapsed timer forever.
	 */
	stop(): void {
		this.clearTimer();
		const hadRun = this.phase !== "idle" || this.cursor > 0;
		this.phase = "idle";
		this.cursor = 0;
		this.retireOpenPermission();
		if (this.narratorId && hadRun) {
			narratorWSManager.dispatchLocalFrame(mockStreamingResetFrame(this.narratorId));
		}
		setMockStreamActiveNarrator(null);
		this.frames = 0;
		this.chars = 0;
		this.round = 0;
		this.startedAt = 0;
		this.publishStats();
		this.onChange();
	}

	dispose(): void {
		this.clearTimer();
		this.retireOpenPermission();
		if (this.narratorId && (this.phase !== "idle" || this.cursor > 0)) {
			narratorWSManager.dispatchLocalFrame(mockStreamingResetFrame(this.narratorId));
		}
		setMockStreamActiveNarrator(null);
		this.steps = [];
		this.phase = "idle";
	}

	private arm(delayMs = this.options.intervalMs): void {
		this.clearTimer();
		this.timer = setTimeout(
			() => {
				this.timer = null;
				if (this.phase !== "running") return;
				const batch = Math.max(1, Math.floor(this.options.framesPerTick));
				// A step that asks for a hold (a permission request) ends the burst: the
				// next frame must wait the hold, not arrive in the same tick.
				let holdMs: number | undefined;
				for (let i = 0; i < batch; i++) {
					if (this.cursor >= this.steps.length) break;
					holdMs = this.dispatchNext();
					if (holdMs != null) break;
				}
				this.publishStats();
				if (this.cursor >= this.steps.length) {
					if (this.options.loop) {
						// A loop must reset the live blocks first, otherwise the second pass
						// re-sends the same tool ids into cards that are already terminal and
						// the phase guard (`resolveLiveToolStatus`) correctly refuses them.
						this.retireOpenPermission();
						if (this.narratorId) {
							narratorWSManager.dispatchLocalFrame(mockStreamingResetFrame(this.narratorId));
						}
						this.rebuild();
						this.cursor = 0;
						this.round = 0;
						this.onChange();
						this.arm();
						return;
					}
					this.phase = "finished";
					this.onChange();
					return;
				}
				this.onChange();
				this.arm(holdMs);
			},
			Math.max(0, delayMs),
		);
	}

	/** Build the script from the loaded scenario under a fresh run id. */
	private rebuild(): void {
		if (!this.scenario) return;
		this.runSeq += 1;
		this.steps = buildMockScript({ ...this.scenario, runId: String(this.runSeq) });
		this.totalChars = this.steps.reduce((sum, step) => sum + step.chars, 0);
	}

	/** Send a decision-less resolve for a request left open, so its form goes away. */
	private retireOpenPermission(): void {
		const open = this.openPermission;
		this.openPermission = null;
		if (!open || !this.narratorId) return;
		narratorWSManager.dispatchLocalFrame(
			mockPermissionResolvedFrame({ narratorId: this.narratorId, ...open }),
		);
	}

	/** Dispatch the next step; returns the hold it asks for before the following one. */
	private dispatchNext(): number | undefined {
		const step = this.steps[this.cursor];
		if (!step) return undefined;
		this.cursor++;
		this.frames++;
		this.chars += step.chars;
		this.round = step.round;
		if (step.kind === "permission-request") {
			const request = step.frame.request as { id: string; toolUseId: string };
			this.openPermission = { requestId: request.id, toolUseId: request.toolUseId };
		} else if (step.kind === "permission-resolved") {
			this.openPermission = null;
		}
		narratorWSManager.dispatchLocalFrame(step.frame);
		return step.holdMs;
	}

	private publishStats(): void {
		setMockStreamStats({
			frames: this.frames,
			chars: this.chars,
			totalSteps: this.steps.length,
			totalChars: this.totalChars,
			elapsedMs: this.startedAt ? Date.now() - this.startedAt : 0,
		});
	}

	private clearTimer(): void {
		if (this.timer != null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}
}
