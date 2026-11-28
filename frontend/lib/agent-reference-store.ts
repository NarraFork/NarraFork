import type { narratorWSManager } from "./narrator-ws-manager";

export type AgentReferenceState =
	| { kind: "unknown" | "unavailable" }
	| { kind: "ready"; status: string; substatus: string[] };
const UNKNOWN: AgentReferenceState = { kind: "unknown" };
const UNAVAILABLE: AgentReferenceState = { kind: "unavailable" };
type Manager = Pick<
	typeof narratorWSManager,
	"addListener" | "removeListener" | "subscribe" | "unsubscribe" | "onConnectionChange"
>;

/** Visible references share one lightweight subscription per ID, never a message/REST fetch. */
export function createAgentReferenceStore(manager: Manager) {
	const entries = new Map<
		string,
		{
			state: AgentReferenceState;
			listeners: Set<() => void>;
			stop: () => void;
		}
	>();
	return {
		get(id: string): AgentReferenceState {
			return entries.get(id)?.state ?? UNKNOWN;
		},
		subscribe(id: string, listener: () => void): () => void {
			let entry = entries.get(id);
			if (!entry) {
				// A malicious message must not consume the connection's subscription budget.
				if (entries.size >= 64) return () => {};
				entry = { state: UNKNOWN, listeners: new Set(), stop: () => {} };
				entries.set(id, entry);
				const current = entry;
				const publish = (state: AgentReferenceState) => {
					current.state = state;
					for (const notify of current.listeners) notify();
				};
				const apply = (data: Record<string, unknown>) => {
					if (current.state.kind === "unavailable") return;
					const previous = current.state.kind === "ready" ? current.state : undefined;
					const status = typeof data.status === "string" ? data.status : previous?.status;
					if (!status) return;
					const substatus = Array.isArray(data.substatus)
						? data.substatus.filter((value): value is string => typeof value === "string")
						: (previous?.substatus ?? []);
					publish({ kind: "ready", status, substatus });
				};
				const events = manager.addListener(
					{
						narratorIds: "*",
						types: [
							"list_state_snapshot",
							"status_change",
							"substatus_change",
							"subscribe_denied",
							"narrator_access_changed",
						],
					},
					(data) => {
						if (data.type === "list_state_snapshot") {
							if (Array.isArray(data.items))
								for (const item of data.items) {
									if (item?.narratorId === id) apply(item);
								}
							return;
						}
						if (
							data.type === "narrator_access_changed" &&
							(!data.narratorId || data.narratorId === id)
						) {
							// Clear stale metadata immediately; only an authorized fresh snapshot restores it.
							publish(UNKNOWN);
							manager.unsubscribe(subscription);
							subscription = manager.subscribe([id], { kind: "activity" });
							return;
						}
						if (data.narratorId !== id) return;
						if (data.type === "subscribe_denied") publish(UNAVAILABLE);
						else apply(data);
					},
				);
				let subscription = manager.subscribe([id], { kind: "activity" });
				const disconnect = manager.onConnectionChange(() => publish(UNKNOWN));
				current.stop = () => {
					disconnect();
					manager.removeListener(events);
					manager.unsubscribe(subscription);
				};
			}
			const current = entry;
			current.listeners.add(listener);
			return () => {
				current.listeners.delete(listener);
				if (current.listeners.size === 0) {
					current.stop();
					entries.delete(id);
				}
			};
		},
	};
}
