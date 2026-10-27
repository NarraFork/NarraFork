import { OUTLINE_PAGE_SUBSCRIPTION_LIMITS } from "@shared/outline-page-events";
import type { ListenerHandle, ListenerOptions, MessageCallback } from "./narrator-ws-manager";

interface Transport {
	readonly connected: boolean;
	send(message: Record<string, unknown>): boolean;
	addListener(options: ListenerOptions, callback: MessageCallback): ListenerHandle;
	removeListener(handle: ListenerHandle): void;
	onConnectionChange(callback: (connected: boolean, reconnect: boolean) => void): () => void;
}

/**
 * What a page subscription tells its listeners. `subscribed` and `changed` carry the space's
 * newest seq: a listener re-reads when it is newer than what it shows. Nothing carries content.
 */
export type OutlinePageHint =
	| { kind: "subscribed"; seq: number }
	| { kind: "changed"; seq: number }
	| { kind: "denied" }
	| { kind: "unavailable" }
	| { kind: "disconnect" };

interface Entry {
	listeners: Set<(hint: OutlinePageHint) => void>;
	dispose(): void;
}

let nextId = 0;

/**
 * Read-only outline page subscriptions over the narrator socket: one wire subscription per page,
 * shared by every listener of that page, re-sent after a reconnect. At most as many pages as
 * the server allows per socket; past that, a subscription silently does nothing and the page
 * keeps what it last read.
 */
export class OutlinePageSubscriptions {
	private entries = new Map<string, Entry>();

	constructor(private readonly transport: Transport) {}

	subscribe(pageId: string, callback: (hint: OutlinePageHint) => void): () => void {
		let entry = this.entries.get(pageId);
		if (!entry) {
			if (this.entries.size >= OUTLINE_PAGE_SUBSCRIPTION_LIMITS.perSocket) return () => {};
			const listeners = new Set<(hint: OutlinePageHint) => void>();
			let id = "";
			let seq = -1;
			let active = true;
			const emit = (hint: OutlinePageHint) => {
				for (const listener of listeners) listener(hint);
			};
			const send = () => {
				if (id) this.transport.send({ type: "outline_page_unsubscribe", subscriptionId: id });
				id = `outline-page-${++nextId}`;
				seq = -1;
				this.transport.send({ type: "outline_page_subscribe", subscriptionId: id, pageId });
			};
			const listener = this.transport.addListener(
				{ types: ["outline_page_subscribed", "outline_page_changed", "outline_page_error"] },
				(frame) => {
					if (!active || !id || frame.subscriptionId !== id) return;
					if (frame.type === "outline_page_error") {
						id = "";
						emit({ kind: frame.code === "access_denied" ? "denied" : "unavailable" });
						return;
					}
					if (frame.pageId !== pageId || !Number.isSafeInteger(frame.seq)) return;
					const next = frame.seq as number;
					if (frame.type === "outline_page_subscribed") {
						seq = next;
						emit({ kind: "subscribed", seq: next });
						return;
					}
					// Frames for one subscription arrive in order; a stale one says nothing new.
					if (next <= seq) return;
					seq = next;
					emit({ kind: "changed", seq: next });
				},
			);
			const off = this.transport.onConnectionChange((connected) => {
				if (connected) send();
				else {
					id = "";
					emit({ kind: "disconnect" });
				}
			});
			entry = {
				listeners,
				dispose: () => {
					active = false;
					off();
					this.transport.removeListener(listener);
					if (id) this.transport.send({ type: "outline_page_unsubscribe", subscriptionId: id });
				},
			};
			this.entries.set(pageId, entry);
			if (this.transport.connected) send();
		}
		const owned = (hint: OutlinePageHint) => callback(hint);
		entry.listeners.add(owned);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const current = this.entries.get(pageId);
			if (!current) return;
			current.listeners.delete(owned);
			if (current.listeners.size === 0) {
				current.dispose();
				this.entries.delete(pageId);
			}
		};
	}

	get size(): number {
		return this.entries.size;
	}
}
