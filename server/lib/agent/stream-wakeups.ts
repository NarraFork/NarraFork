/**
 * stream-wakeups.ts — let the agent loop act between provider stream events.
 *
 * The loop consumes the provider with `for await`, so it can only run code when the
 * provider yields. Tools started mid-stream settle on their own schedule: without a
 * wakeup their results (and the successors waiting on them) stay parked until the
 * provider's next event — and after the model stops producing output, the next
 * "event" may be a connection that closes much later.
 *
 * `interleaveWakeups` merges a wake signal into the stream: it yields `STREAM_WAKEUP`
 * whenever the signal is raised while the provider is idle, and otherwise passes the
 * provider's events through unchanged and in order.
 */

/** Marker yielded by `interleaveWakeups` in place of a provider event. */
export const STREAM_WAKEUP: unique symbol = Symbol("stream-wakeup");

/** A level-triggered, single-waiter wake signal. Notifications coalesce. */
export class WakeSignal {
	private pending = false;
	private resolveWaiter: (() => void) | undefined;

	notify(): void {
		const resolve = this.resolveWaiter;
		if (resolve) {
			this.resolveWaiter = undefined;
			resolve();
		} else {
			this.pending = true;
		}
	}

	/** Resolves at the next notification, or immediately for one that arrived unobserved. */
	wait(): Promise<void> {
		if (this.pending) {
			this.pending = false;
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			this.resolveWaiter = resolve;
		});
	}
}

export async function* interleaveWakeups<T>(
	source: AsyncIterable<T>,
	wake: WakeSignal,
): AsyncGenerator<T | typeof STREAM_WAKEUP> {
	const iterator = source[Symbol.asyncIterator]();
	// A provider read that is still in flight survives wakeups: it is raced again on
	// the next iteration rather than re-requested, so no event is ever dropped.
	let inFlight: Promise<IteratorResult<T>> | undefined;
	try {
		while (true) {
			inFlight ??= iterator.next();
			const next = await Promise.race([
				inFlight,
				wake.wait().then((): typeof STREAM_WAKEUP => STREAM_WAKEUP),
			]);
			if (next === STREAM_WAKEUP) {
				yield STREAM_WAKEUP;
				continue;
			}
			inFlight = undefined;
			if (next.done) return;
			yield next.value;
		}
	} finally {
		if (inFlight) {
			// The consumer left while a provider read was pending. `return()` on an async
			// generator queues behind that read, so awaiting it would block the consumer
			// until the provider's next event or close — exactly the wait this module
			// exists to avoid. Close it in the background; the attempt's abort signal is
			// what actually tears the connection down.
			inFlight.catch(() => {});
			void iterator.return?.()?.catch(() => {});
		} else {
			await iterator.return?.();
		}
	}
}
