type WaitOutcome = "available" | "aborted";

export interface ModelAvailabilityWaitTarget {
	abortController: AbortController;
	_modelUnavailableWaitCancel?: () => void;
}

/** A model change cancels only the old poller registration, never the turn. */
export async function waitForModelAvailabilityOrChange(options: {
	target: ModelAvailabilityWaitTarget;
	isCurrent: () => boolean;
	hasModelChanged: () => boolean;
	subscribe: (listener: () => void) => () => void;
	wait: (signal: AbortSignal) => Promise<WaitOutcome>;
}): Promise<WaitOutcome | "changed"> {
	const { target, isCurrent, hasModelChanged, subscribe, wait } = options;
	target._modelUnavailableWaitCancel?.();
	const controller = new AbortController();
	let changed = false;
	const cancel = () => {
		if (!isCurrent()) {
			controller.abort();
			return;
		}
		if (!hasModelChanged()) return;
		changed = true;
		controller.abort();
	};
	const abort = () => controller.abort();
	target._modelUnavailableWaitCancel = cancel;
	target.abortController.signal.addEventListener("abort", abort, { once: true });
	let unsubscribe: (() => void) | undefined;
	try {
		unsubscribe = subscribe(cancel);
		// Register before checking, so changes during async partial/status cleanup
		// (or before this function was entered) cannot be lost.
		cancel();
		if (target.abortController.signal.aborted || !isCurrent()) controller.abort();
		const outcome = await wait(controller.signal);
		if (target.abortController.signal.aborted || !isCurrent()) return "aborted";
		return changed ? "changed" : outcome;
	} finally {
		controller.abort();
		unsubscribe?.();
		target.abortController.signal.removeEventListener("abort", abort);
		if (target._modelUnavailableWaitCancel === cancel) {
			target._modelUnavailableWaitCancel = undefined;
		}
	}
}
