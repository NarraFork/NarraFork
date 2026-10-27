/**
 * Motion between the outline's two views and between focus levels (design §6.10): FLIP with the
 * Web Animations API, the anchor block kept still on screen, and the practices the prototype
 * measured (`prototypes/outline-editor/RESULTS.md`, "导图与聚焦"):
 *
 *   - A switch takes two frames: the first only reads positions, lays out and builds DOM nobody
 *     sees yet (keyboard focus moves at once); the next frame shows it and starts the animation.
 *     A new switch, a key or a pointer press first finishes a pending second step.
 *   - `prefers-reduced-motion`: everything happens at once, in the same task, with no animation.
 *
 * Timing follows the session list's level switch (`narrator/vlist/vlist-motion-scheduler.ts`,
 * `LOD_MOTION_DURATION_MS` 250 ms, `ease`); the vlist is behind a lazy boundary, so the values
 * are repeated here rather than imported.
 */
import { prefersReducedMotion } from "../../lib/smooth-scroll";

/** Duration of a view switch, a direction switch, and focusing in or out. */
export const OUTLINE_MOTION_MS = 250;
export const OUTLINE_MOTION_EASING = "ease";

export function reducedMotion(): boolean {
	return prefersReducedMotion();
}

/** One step deferred to after the next frame is painted (or run at once with reduced motion). */
export class FrameDeferral {
	private pending: { run: () => void } | null = null;

	/** Run `step` after the next paint; a later `defer` or `flush` runs the pending one first. */
	defer(step: () => void): void {
		this.flush();
		if (reducedMotion()) {
			step();
			return;
		}
		const p = {
			run: () => {
				if (this.pending !== p) return;
				this.pending = null;
				step();
			},
		};
		this.pending = p;
		requestAnimationFrame(() => {
			// After the frame's paint: a message runs before the next frame starts.
			const ch = new MessageChannel();
			ch.port1.onmessage = () => p.run();
			ch.port2.postMessage(0);
		});
	}

	/** Run a pending step now (input arrived: it lands on the right view). */
	flush(): void {
		this.pending?.run();
	}

	get waiting(): boolean {
		return this.pending !== null;
	}

	cancel(): void {
		this.pending = null;
	}
}

/** One switch or focus change, for tests and the measurements in the PR. */
export interface TransitionRecord {
	kind: string;
	/** Synchronous work of the switch, in ms. */
	setupMs: number;
	/** Animations started. */
	animated: number;
	at: number;
	doneAt?: number;
	parts?: Record<string, number>;
	/** The anchor: a block and where its body sat in the frame before the switch. */
	anchor?: { blockId: string; x: number; y: number } | null;
}

interface Running {
	kind: string;
	anims: Animation[];
	done: () => void;
}

/** The running transition: finished early when another starts, so states never stack. */
export class TransitionTracker {
	readonly log: TransitionRecord[] = [];
	private running: Running | null = null;

	track(
		kind: string,
		anims: Animation[],
		done: () => void,
		t0: number,
		extra: Pick<TransitionRecord, "parts" | "anchor"> = {},
	): void {
		const entry: TransitionRecord = {
			kind,
			setupMs: performance.now() - t0,
			animated: anims.length,
			at: t0,
			...extra,
		};
		this.log.push(entry);
		if (this.log.length > 500) this.log.splice(0, 250);
		if (anims.length === 0) {
			done();
			entry.doneAt = performance.now();
			return;
		}
		const run: Running = { kind, anims, done };
		this.running = run;
		Promise.all(anims.map((a) => a.finished)).then(
			() => {
				if (this.running !== run) return;
				this.running = null;
				done();
				entry.doneAt = performance.now();
			},
			() => {},
		);
	}

	/** Jump the running animation to its end and run its clean-up. */
	finish(): void {
		const run = this.running;
		if (!run) return;
		this.running = null;
		for (const a of run.anims) {
			try {
				a.finish();
			} catch {
				// An animation of a node already removed.
			}
		}
		run.done();
		const last = this.log[this.log.length - 1];
		if (last && last.doneAt === undefined) last.doneAt = performance.now();
	}

	get active(): boolean {
		return this.running !== null;
	}
}
