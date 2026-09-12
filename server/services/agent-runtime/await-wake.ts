import { hotSafe } from "../../lib/hot-safe";

export type AwaitWakeReason = "agent_message" | "task_notice";
export type AwaitWakeListener = (narratorId: string, reason: AwaitWakeReason) => void;

const listeners = hotSafe(
	"narrafork:runtime-await-wake-listeners",
	() => new Set<AwaitWakeListener>(),
);

/** Subscribe to durable runtime notification hints. The callback receives no message body. */
export function subscribeAwaitWake(listener: AwaitWakeListener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Notify in-process Await waiters after the durable producer commit. */
export function notifyAwaitWake(narratorId: string, reason: AwaitWakeReason): void {
	for (const listener of [...listeners]) {
		try {
			listener(narratorId, reason);
		} catch {
			// Await wake hints are best-effort and must never break mailbox delivery.
		}
	}
}
