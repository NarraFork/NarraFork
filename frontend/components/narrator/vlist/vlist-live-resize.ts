import {
	isExternalGeometryChange,
	pushCommittedWidth,
	resolveWidthSettle,
	type WidthSettleTrigger,
} from "./vlist-width-settle";

export interface VListResizeSize {
	width: number;
	boxWidth: number;
	height: number;
}

export interface VListResizeController {
	observe(): void;
	release(): void;
	refresh(): void;
	dispose(): void;
	isPending(): boolean;
}

/**
 * Owns scheduling, not measurement: previews patch only the caller's bounded window.
 * Only initial/commit callbacks may publish the global layout width. Every deferred
 * burst ends with an explicit commit, even if its final width equals an earlier one.
 */
export function createVListResizeController(options: {
	readSize: () => VListResizeSize;
	getCommittedWidth: () => number;
	pointerDown: () => boolean;
	onInitial: (size: VListResizeSize) => void;
	onPreview: (size: VListResizeSize) => boolean;
	onCommit: (size: VListResizeSize) => void;
	requestFrame?: (callback: () => void) => number;
	cancelFrame?: (id: number) => void;
	setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
	clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
}): VListResizeController {
	const requestFrame = options.requestFrame ?? ((callback) => requestAnimationFrame(callback));
	const cancelFrame = options.cancelFrame ?? ((id) => cancelAnimationFrame(id));
	const setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
	const clearTimer = options.clearTimer ?? ((id) => clearTimeout(id));
	let disposed = false;
	let pending = false;
	let previewFailed = false;
	let frame: number | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let generation = 0;
	let observedWidth: number | undefined;
	let committedBoxWidth: number | undefined;
	let recentCommittedWidths: readonly number[] = [];

	function stop(): void {
		generation++;
		if (frame !== null) cancelFrame(frame);
		if (timer !== null) clearTimer(timer);
		frame = null;
		timer = null;
		pending = false;
		previewFailed = false;
	}

	function preview(): void {
		if (disposed || !pending || previewFailed || frame !== null) return;
		const scheduledGeneration = generation;
		frame = requestFrame(() => {
			if (disposed || !pending || scheduledGeneration !== generation) return;
			frame = null;
			let needsMore: boolean;
			try {
				needsMore = options.onPreview(options.readSize());
			} catch (error) {
				// Surface the original diagnostic, but do not repeatedly retry a broken
				// callback on every frame/observer/refresh. The settle timer still converges.
				if (scheduledGeneration === generation) previewFailed = true;
				throw error;
			}
			if (needsMore && scheduledGeneration === generation) preview();
		});
	}

	function evaluate(trigger: WidthSettleTrigger): void {
		if (disposed) return;
		const size = options.readSize();
		const committedWidth = options.getCommittedWidth();
		const widthChanged = observedWidth !== Math.round(size.width);
		if (trigger === "observer") observedWidth = Math.round(size.width);

		if (trigger === "observer" && committedWidth === 0) {
			stop();
			committedBoxWidth = size.boxWidth;
			recentCommittedWidths = pushCommittedWidth([], size.width);
			options.onInitial(size);
			return;
		}

		const decision = resolveWidthSettle({
			nextWidth: size.width,
			committedWidth,
			trigger,
			// Capture-phase pointerup/cancel may run before the tracker clears its flag.
			pointerDown: trigger === "gesture-end" ? false : options.pointerDown(),
			hasPendingPreview: pending,
			recentCommittedWidths,
			boxWidth: size.boxWidth,
			committedBoxWidth,
		});
		if (decision.commit) {
			stop();
			if (trigger === "gesture-end" || isExternalGeometryChange(size.boxWidth, committedBoxWidth)) {
				recentCommittedWidths = [];
			}
			committedBoxWidth = size.boxWidth;
			recentCommittedWidths = pushCommittedWidth(recentCommittedWidths, size.width);
			options.onCommit(size);
			return;
		}
		if (!decision.defer) {
			stop();
			return;
		}
		pending = true;
		// Height-only observer traffic and scroll/snapshot refreshes must not postpone
		// settling forever. Only a new width restarts the idle deadline.
		if (widthChanged || timer === null) {
			if (timer !== null) clearTimer(timer);
			const scheduledGeneration = generation;
			timer = setTimer(() => {
				if (disposed || !pending || scheduledGeneration !== generation) return;
				timer = null;
				evaluate("timer");
			}, decision.deferForMs);
		}
		preview();
	}

	return {
		observe: () => evaluate("observer"),
		release: () => {
			if (!disposed && pending) evaluate("gesture-end");
			// A real gesture also releases a previously pinned feedback cycle.
			if (!disposed) recentCommittedWidths = [];
		},
		refresh: preview,
		dispose: () => {
			disposed = true;
			stop();
		},
		isPending: () => pending,
	};
}
