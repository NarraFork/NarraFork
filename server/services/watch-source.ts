import { hotSafe } from "../lib/hot-safe";

interface Source {
	result: Promise<unknown>;
	controller: AbortController;
	subscribers: number;
}

/** One waiter per observed source condition, shared by every watch subscribed to it. */
const sources = hotSafe("narrafork:watch-sources", () => new Map<string, Source>());

/**
 * Subscribe to the shared waiter for `key`, starting it on first use. The waiter is
 * aborted once its last subscriber leaves. Resolves `undefined` when `signal` aborts.
 * Subscribers still check their own authorization and publish their own results.
 */
export function subscribeWatchSource<T>(
	key: string,
	start: (signal: AbortSignal) => Promise<T>,
	signal: AbortSignal,
): Promise<T | undefined> {
	if (signal.aborted) return Promise.resolve(undefined);
	let source = sources.get(key);
	if (!source) {
		const controller = new AbortController();
		const created: Source = {
			controller,
			subscribers: 0,
			result: Promise.resolve().then(() => start(controller.signal)),
		};
		const forget = () => {
			if (sources.get(key) === created) sources.delete(key);
		};
		created.result.then(forget, forget);
		sources.set(key, created);
		source = created;
	}
	const shared = source;
	shared.subscribers++;
	return new Promise<T | undefined>((resolve, reject) => {
		let left = false;
		const leave = () => {
			if (left) return;
			left = true;
			signal.removeEventListener("abort", onAbort);
			if (--shared.subscribers === 0) {
				if (sources.get(key) === shared) sources.delete(key);
				shared.controller.abort();
			}
		};
		const onAbort = () => {
			leave();
			resolve(undefined);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		shared.result.then(
			(value) => {
				if (left) return;
				leave();
				resolve(value as T);
			},
			(error) => {
				if (left) return;
				leave();
				reject(error);
			},
		);
	});
}

export function activeWatchSourceCount(): number {
	return sources.size;
}
