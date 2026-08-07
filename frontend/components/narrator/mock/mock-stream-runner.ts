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
import { mockStreamingResetFrame } from "./mock-stream-frames";
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
		this.steps = buildMockScript(scenario);
		this.cursor = 0;
		this.frames = 0;
		this.chars = 0;
		this.round = 0;
		this.totalChars = this.steps.reduce((sum, step) => sum + step.chars, 0);
		this.phase = "idle";
		resetMockStreamStats(this.steps.length, this.totalChars);
		this.onChange();
	}

	start(): void {
		if (this.steps.length === 0) return;
		if (this.phase === "running") return;
		if (this.phase === "finished" || this.cursor >= this.steps.length) {
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
		if (this.narratorId && (this.phase !== "idle" || this.cursor > 0)) {
			narratorWSManager.dispatchLocalFrame(mockStreamingResetFrame(this.narratorId));
		}
		setMockStreamActiveNarrator(null);
		this.steps = [];
		this.phase = "idle";
	}

	private arm(): void {
		this.clearTimer();
		this.timer = setTimeout(
			() => {
				this.timer = null;
				if (this.phase !== "running") return;
				const batch = Math.max(1, Math.floor(this.options.framesPerTick));
				for (let i = 0; i < batch; i++) {
					if (this.cursor >= this.steps.length) break;
					this.dispatchNext();
				}
				this.publishStats();
				if (this.cursor >= this.steps.length) {
					if (this.options.loop) {
						// A loop must reset the live blocks first, otherwise the second pass
						// re-sends the same tool ids into cards that are already terminal and
						// the phase guard (`resolveLiveToolStatus`) correctly refuses them.
						if (this.narratorId) {
							narratorWSManager.dispatchLocalFrame(mockStreamingResetFrame(this.narratorId));
						}
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
				this.arm();
			},
			Math.max(0, this.options.intervalMs),
		);
	}

	private dispatchNext(): void {
		const step = this.steps[this.cursor];
		if (!step) return;
		this.cursor++;
		this.frames++;
		this.chars += step.chars;
		this.round = step.round;
		narratorWSManager.dispatchLocalFrame(step.frame);
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
