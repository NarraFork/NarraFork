/** Bounded FIFO for disk-heavy compatibility merges, not the native merge-tree path. */
export class GitMergeLimiter {
	private active = 0;
	private readonly waiting = new Set<() => void>();

	constructor(
		private readonly concurrency: number,
		private readonly maxWaiting: number,
	) {
		if (
			!Number.isSafeInteger(concurrency) ||
			concurrency < 1 ||
			!Number.isSafeInteger(maxWaiting) ||
			maxWaiting < 0
		) {
			throw new Error("Invalid compatibility merge concurrency limits");
		}
	}

	async acquire(deadline: number, signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) throw new Error("Git tree merge was cancelled");
		if (Date.now() >= deadline)
			throw new Error("Git tree merge timed out while waiting for a slot");
		if (this.active < this.concurrency) return this.claim();
		if (this.waiting.size >= this.maxWaiting) {
			throw new Error("Compatibility merge queue is full; retry after the running merges finish");
		}
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				this.waiting.delete(grant);
			};
			const abort = () => {
				cleanup();
				reject(new Error("Git tree merge was cancelled"));
			};
			const grant = () => {
				cleanup();
				// Timers may be delayed by other work; never grant an already expired job.
				if (signal?.aborted) reject(new Error("Git tree merge was cancelled"));
				else if (Date.now() >= deadline) {
					reject(new Error("Git tree merge timed out while waiting for a slot"));
				} else resolve(this.claim());
			};
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error("Git tree merge timed out while waiting for a slot"));
			}, deadline - Date.now());
			this.waiting.add(grant);
			signal?.addEventListener("abort", abort, { once: true });
		});
	}

	private claim(): () => void {
		this.active++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active--;
			while (this.active < this.concurrency && this.waiting.size) {
				this.waiting.values().next().value?.();
			}
		};
	}
}
