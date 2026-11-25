export interface SharedReadOptions {
	signal?: AbortSignal;
	/** A reconnect must never join a read started before the disconnect. */
	fresh?: boolean;
}

interface ReadEntry<T> {
	controller: AbortController;
	promise: Promise<T>;
	readers: number;
	settled: boolean;
}

/** Share only live reads, never authorization or a completed snapshot. */
export function createSharedInflight<T>() {
	const entries = new Map<string, ReadEntry<T>>();
	return (
		key: string,
		read: (signal: AbortSignal) => Promise<T>,
		options: SharedReadOptions = {},
	) => {
		const { signal } = options;
		if (signal?.aborted)
			return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
		let entry = options.fresh ? undefined : entries.get(key);
		if (!entry || entry.controller.signal.aborted) {
			const controller = new AbortController();
			const created: ReadEntry<T> = {
				controller,
				promise: Promise.resolve().then(() => {
					// StrictMode can detach every reader before this microtask starts.
					controller.signal.throwIfAborted();
					return read(controller.signal);
				}),
				readers: 0,
				settled: false,
			};
			entry = created;
			entries.set(key, created);
			const settle = () => {
				created.settled = true;
				if (entries.get(key) === created) entries.delete(key);
			};
			created.promise.then(settle, settle);
		}
		const current = entry;
		current.readers++;
		return new Promise<T>((resolve, reject) => {
			let finished = false;
			const finish = () => {
				if (finished) return false;
				finished = true;
				signal?.removeEventListener("abort", abort);
				if (--current.readers === 0 && !current.settled) {
					current.controller.abort();
					if (entries.get(key) === current) entries.delete(key);
				}
				return true;
			};
			const abort = () => {
				if (finish()) reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
			};
			signal?.addEventListener("abort", abort, { once: true });
			current.promise.then(
				(value) => {
					if (finish()) resolve(value);
				},
				(error) => {
					if (finish()) reject(error);
				},
			);
		});
	};
}
