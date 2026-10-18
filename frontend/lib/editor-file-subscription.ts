import type { ListenerHandle, ListenerOptions, MessageCallback } from "./narrator-ws-manager";

interface Transport {
	readonly connected: boolean;
	send(message: Record<string, unknown>): boolean;
	addListener(options: ListenerOptions, callback: MessageCallback): ListenerHandle;
	removeListener(handle: ListenerHandle): void;
	onConnectionChange(callback: (connected: boolean, reconnect: boolean) => void): () => void;
}
export type EditorFileHint = "check" | "rebind" | "disconnect" | "denied" | "unavailable";
interface Entry {
	listeners: Set<(reason: EditorFileHint) => void>;
	dispose(): void;
}
let nextId = 0;
/** One wire subscription per verified visible resource. No timers or file text. */
export class EditorFileSubscriptions {
	private entries = new Map<string, Entry>();
	constructor(private readonly transport: Transport) {}
	subscribe(
		target: { resourceId: string; narratorId: string; docId: string },
		callback: (reason: EditorFileHint) => void,
	) {
		const key = target.resourceId;
		let entry = this.entries.get(key);
		if (!entry) {
			if (this.entries.size >= 16) return () => {};
			const listeners = new Set<(reason: EditorFileHint) => void>();
			let id = "",
				generation = "",
				seq = 0,
				active = true;
			let queued: EditorFileHint | undefined;
			const emit = (reason: EditorFileHint) => {
				if (reason === "denied" || reason === "disconnect") {
					queued = undefined;
					for (const listener of listeners) listener(reason);
					return;
				}
				if (queued === "rebind") return;
				const scheduled = queued !== undefined;
				queued = reason;
				if (scheduled) return;
				queueMicrotask(() => {
					if (!active || !queued) return;
					const pending = queued;
					queued = undefined;
					for (const listener of listeners) listener(pending);
				});
			};
			const subscribe = () => {
				if (id) this.transport.send({ type: "editor_file_unsubscribe", subscriptionId: id });
				id = `editor-file-${++nextId}`;
				generation = "";
				seq = 0;
				this.transport.send({
					type: "editor_file_subscribe",
					subscriptionId: id,
					narratorId: target.narratorId,
					docId: target.docId,
				});
			};
			const listener = this.transport.addListener(
				{ types: ["editor_file_subscribed", "editor_file_changed", "editor_file_error"] },
				(frame) => {
					if (!active || frame.subscriptionId !== id) return;
					if (frame.type === "editor_file_error") {
						id = "";
						generation = "";
						emit(frame.code === "access_denied" ? "denied" : "unavailable");
						return;
					}
					if (
						frame.resourceId !== key ||
						typeof frame.generation !== "string" ||
						!Number.isSafeInteger(frame.seq)
					)
						return;
					if (frame.type === "editor_file_subscribed") {
						if (generation) return;
						generation = frame.generation;
					} else if (!generation || frame.generation !== generation) return;
					const next = frame.seq as number;
					if (next <= seq) return;
					// Gap/overflow and normal hints both request exactly one bounded reconciliation.
					seq = next;
					emit(frame.reason === "rebind" ? "rebind" : "check");
				},
			);
			const off = this.transport.onConnectionChange((connected) => {
				generation = "";
				queued = undefined;
				if (connected) {
					subscribe();
					emit("rebind");
				} else {
					id = "";
					emit("disconnect");
				}
			});
			entry = {
				listeners,
				dispose: () => {
					active = false;
					queued = undefined;
					off();
					this.transport.removeListener(listener);
					if (id) this.transport.send({ type: "editor_file_unsubscribe", subscriptionId: id });
				},
			};
			this.entries.set(key, entry);
			if (this.transport.connected) subscribe();
		}
		const ownedCallback = (reason: EditorFileHint) => callback(reason);
		entry.listeners.add(ownedCallback);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			entry.listeners.delete(ownedCallback);
			if (!entry.listeners.size) {
				entry.dispose();
				this.entries.delete(key);
			}
		};
	}
	get size() {
		return this.entries.size;
	}
}
