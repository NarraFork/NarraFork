export type VListInteractionAdmissionPhase = "history-scrolling" | "idle" | "at-bottom";

/** Numeric handles keep browser and deterministic test runtimes interchangeable. */
export interface VListInteractionAdmissionRuntime {
	now(): number;
	setTimeout(callback: () => void, delay: number): number;
	clearTimeout(handle: number): void;
	requestAnimationFrame(callback: () => void): number;
	cancelAnimationFrame(handle: number): void;
}

export interface VListInteractionAdmissionOptions {
	runtime?: VListInteractionAdmissionRuntime;
}

export interface VListInteractionAdmissionView {
	scrollTop: number;
	viewportHeight: number;
}

export interface VListInteractionAdmissionLease {
	subscribe(listener: () => void): () => void;
	getSnapshot(): boolean;
	ensure(): void;
}

export interface VListInteractionAdmissionStore {
	observeScroll(
		view: VListInteractionAdmissionView & { atBottom: boolean; activity?: boolean },
	): void;
	markHistoryIntent(): void;
	setAtBottom(atBottom: boolean): void;
	finishScroll(): void;
	resume(atBottom?: boolean): void;
	suspend(): void;
	getPhase(): VListInteractionAdmissionPhase;
	getView(): VListInteractionAdmissionView;
	getDebugSnapshot(): {
		phase: VListInteractionAdmissionPhase;
		pending: number;
		active: number;
		suspended: boolean;
		frameScheduled: boolean;
		quietScheduled: boolean;
	};
	createLease(options?: { priority?: () => number }): VListInteractionAdmissionLease;
}

const QUIET_MS = 120;
const FRAME_BUDGET = 2;

const defaultRuntime: VListInteractionAdmissionRuntime = {
	now: () => performance.now(),
	setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay) as unknown as number,
	clearTimeout: (handle) => globalThis.clearTimeout(handle),
	requestAnimationFrame: (callback) => globalThis.requestAnimationFrame(callback),
	cancelAnimationFrame: (handle) => globalThis.cancelAnimationFrame(handle),
};

/** One owner per list: only subscribed cold leases are retained by this store. */
export function createVListInteractionAdmission(
	options: VListInteractionAdmissionOptions = {},
): VListInteractionAdmissionStore {
	const runtime = options.runtime ?? defaultRuntime;
	let phase: VListInteractionAdmissionPhase = "at-bottom";
	let view: VListInteractionAdmissionView = { scrollTop: 0, viewportHeight: 0 };
	let suspended = false;
	let active = 0;
	let lastMovement: number | null = null;
	let quietTimer: number | null = null;
	let admissionFrame: number | null = null;
	type ColdLease = { priority: () => number; admit: () => void };
	const pending = new Set<ColdLease>();

	function cancelFrame() {
		if (admissionFrame === null) return;
		runtime.cancelAnimationFrame(admissionFrame);
		admissionFrame = null;
	}
	function cancelQuiet() {
		if (quietTimer === null) return;
		runtime.clearTimeout(quietTimer);
		quietTimer = null;
	}
	function scheduleAdmission() {
		if (suspended || phase !== "idle" || pending.size === 0 || admissionFrame !== null) return;
		admissionFrame = runtime.requestAnimationFrame(() => {
			admissionFrame = null;
			if (suspended || phase !== "idle") return;
			const ordered = [...pending].sort((a, b) => a.priority() - b.priority());
			let admitted = 0;
			for (const lease of ordered) {
				if (suspended || phase !== "idle" || admitted >= FRAME_BUDGET) break;
				if (!pending.has(lease)) continue;
				lease.admit();
				admitted++;
			}
			scheduleAdmission();
		});
	}
	function flushBottom() {
		if (suspended || phase !== "at-bottom") return;
		for (const lease of [...pending]) {
			if (suspended || phase !== "at-bottom") break;
			if (pending.has(lease)) lease.admit();
		}
	}
	function enterIdle() {
		cancelQuiet();
		phase = "idle";
		lastMovement = null;
		scheduleAdmission();
	}
	function armQuiet() {
		cancelQuiet();
		if (suspended || phase !== "history-scrolling") return;
		quietTimer = runtime.setTimeout(() => {
			quietTimer = null;
			if (!suspended && phase === "history-scrolling") enterIdle();
		}, QUIET_MS);
	}
	function enterHistory() {
		phase = "history-scrolling";
		cancelFrame();
		armQuiet();
	}
	function setAtBottom(atBottom: boolean) {
		if (atBottom) {
			cancelQuiet();
			cancelFrame();
			lastMovement = null;
			phase = "at-bottom";
			flushBottom();
		} else if (phase === "at-bottom") {
			enterIdle();
		}
	}

	return {
		observeScroll(next) {
			// Anchoring echoes and pinned resizes update the cached viewport without rearming quiet.
			const moved = next.activity !== false && next.scrollTop !== view.scrollTop;
			view = { scrollTop: next.scrollTop, viewportHeight: next.viewportHeight };
			if (next.atBottom) {
				setAtBottom(true);
			} else if (moved) {
				lastMovement = runtime.now();
				enterHistory();
			} else {
				setAtBottom(false);
			}
		},
		markHistoryIntent() {
			// Also valid immediately before an upward gesture detaches the effective bottom pin.
			enterHistory();
		},
		setAtBottom,
		finishScroll() {
			if (suspended || phase !== "history-scrolling") return;
			// A stale scrollend must not admit work during a newer movement burst.
			if (lastMovement !== null && runtime.now() - lastMovement < QUIET_MS) return;
			enterIdle();
		},
		resume(atBottom) {
			suspended = false;
			if (atBottom !== undefined) setAtBottom(atBottom);
			if (phase === "history-scrolling") armQuiet();
			else if (phase === "at-bottom") flushBottom();
			else scheduleAdmission();
		},
		suspend() {
			suspended = true;
			cancelQuiet();
			cancelFrame();
		},
		getPhase: () => phase,
		getView: () => view,
		getDebugSnapshot: () => ({
			phase,
			pending: pending.size,
			active,
			suspended,
			frameScheduled: admissionFrame !== null,
			quietScheduled: quietTimer !== null,
		}),
		createLease({ priority = () => 0 } = {}) {
			// Rendering may provisionally allow bottom controls, but a read must not
			// latch warm state before commit. Only subscription/admission or ensure does.
			let ready = false;
			const listeners = new Set<() => void>();
			const cold: ColdLease = {
				priority,
				admit() {
					if (ready) return;
					ready = true;
					pending.delete(cold);
					if (pending.size === 0) cancelFrame();
					for (const listener of [...listeners]) listener();
				},
			};
			return {
				getSnapshot: () => ready || (listeners.size === 0 && !suspended && phase === "at-bottom"),
				ensure: cold.admit,
				subscribe(listener) {
					// A wrapper gives duplicate callback subscriptions independent cleanup semantics.
					const subscription = () => listener();
					listeners.add(subscription);
					if (listeners.size === 1) {
						active++;
						if (!ready) {
							// Recheck the owner at the first committed subscription: it may
							// have started scrolling or hidden since the render snapshot.
							if (!suspended && phase === "at-bottom") cold.admit();
							else {
								pending.add(cold);
								scheduleAdmission();
							}
						}
					}
					return () => {
						if (!listeners.delete(subscription) || listeners.size !== 0) return;
						active--;
						pending.delete(cold);
						if (pending.size === 0) cancelFrame();
					};
				},
			};
		},
	};
}
