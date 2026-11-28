import { hotSafe } from "../../lib/hot-safe";

const state = hotSafe("communication.database-tails.v1", () => ({
	pending: new Set<Promise<unknown>>(),
	failed: false,
	failureCount: 0,
}));
state.failureCount ??= 0;

/** Track detached producers; awaited operations stay with their request or transaction. */
export function trackCommunicationWork<T>(work: Promise<T>): Promise<T> {
	if (state.pending.has(work)) return work;
	state.pending.add(work);
	work.then(
		() => state.pending.delete(work),
		() => {
			markCommunicationWorkFailed();
			state.pending.delete(work);
		},
	);
	return work;
}

export function markCommunicationWorkFailed(): void {
	state.failed = true;
	state.failureCount++;
}

export function getCommunicationWorkFailureCount(): number {
	return state.failureCount;
}

/** Content-free audit, including after the reader pool has closed. */
export function getCommunicationWorkStatus(): { pending: number; failed: boolean } {
	return { pending: state.pending.size, failed: state.failed };
}

/** Stop producers first; a settling tail can enqueue another tracked operation. */
export async function drainCommunicationWork(options: { deadlineAt?: number } = {}): Promise<void> {
	const deadlineAt = options.deadlineAt ?? Date.now() + 4_000;
	while (state.pending.size) {
		const remaining = deadlineAt - Date.now();
		if (remaining <= 0) throw new Error("Communication database tails did not drain");
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				Promise.allSettled([...state.pending]),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(
						() => reject(new Error("Communication database tails did not drain")),
						remaining,
					);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
	if (state.failed) throw new Error("Communication database tail failed");
}
