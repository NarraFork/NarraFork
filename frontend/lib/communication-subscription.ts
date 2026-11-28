import {
	applyCommunicationTopologyDelta,
	type CommunicationScope,
	type CommunicationServerMessage,
	type CommunicationTopology,
	communicationScopeKey,
	COMMUNICATION_LIMITS as limits,
} from "@shared/narrator-communication";
import type { ListenerHandle, ListenerOptions, MessageCallback } from "./narrator-ws-manager";
import { observePageLifecycle, type PageLifecycleTarget } from "./page-lifecycle";

export type CommunicationStatus = "connecting" | "live" | "disconnected" | "denied" | "unavailable";
export interface CommunicationView {
	topology: CommunicationTopology | null;
	status: CommunicationStatus;
}
export interface CommunicationTransport {
	readonly connected: boolean;
	connect?(): void;
	reconnect?(): void;
	getCredentialIdentity(): unknown;
	getConnectionCredentialIdentity(): unknown;
	onCredentialChange(callback: () => void): () => void;
	send(message: Record<string, unknown>): boolean;
	addListener(options: ListenerOptions, callback: MessageCallback): ListenerHandle;
	removeListener(handle: ListenerHandle): void;
	onConnectionChange(callback: (connected: boolean, isReconnect: boolean) => void): () => void;
}
interface Entry {
	scope: CommunicationScope;
	refs: number;
	id: string | null;
	epoch: string | null;
	seq: number;
	view: CommunicationView;
	listeners: Set<() => void>;
}
const EMPTY: CommunicationView = { topology: null, status: "connecting" };
let nextId = 0;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** One lightweight subscription per scope, sharing the application's existing socket. */
export class CommunicationTopologySubscriptions {
	private entries = new Map<string, Entry>();
	private byId = new Map<string, Entry>();
	private pending = new Set<Entry>();
	private scheduled = false;
	private dispose?: () => void;
	private credential: unknown;
	private visible: boolean;
	constructor(
		private readonly transport: CommunicationTransport,
		private readonly lifecycle?: PageLifecycleTarget,
	) {
		this.credential = transport.getCredentialIdentity();
		this.visible =
			(lifecycle?.document ?? (typeof document === "undefined" ? undefined : document))
				?.visibilityState !== "hidden";
	}
	getSnapshot = (scope: CommunicationScope): CommunicationView =>
		this.entries.get(communicationScopeKey(scope))?.view ?? EMPTY;
	watch(scope: CommunicationScope, callback: () => void): () => void {
		const key = communicationScopeKey(scope);
		let entry = this.entries.get(key);
		if (!entry) {
			entry = { scope, refs: 0, id: null, epoch: null, seq: -1, view: EMPTY, listeners: new Set() };
			this.entries.set(key, entry);
		}
		entry.refs++;
		entry.listeners.add(callback);
		if (!this.dispose) this.observe();
		if (entry.refs === 1) this.start(entry);
		let disposed = false;
		return () => {
			if (disposed) return;
			disposed = true;
			entry.listeners.delete(callback);
			if (--entry.refs) return;
			this.retire(entry);
			this.pending.delete(entry);
			this.entries.delete(key);
			if (!this.entries.size) {
				this.dispose?.();
				this.dispose = undefined;
			}
		};
	}
	private publish(entry: Entry, view: CommunicationView) {
		entry.view = view;
		for (const callback of entry.listeners) callback();
	}
	private retire(entry: Entry) {
		if (entry.id) {
			this.byId.delete(entry.id);
			this.transport.send({ type: "communication_unsubscribe", subscriptionId: entry.id });
		}
		entry.id = null;
		entry.epoch = null;
		entry.seq = -1;
	}
	private trusted() {
		return (
			this.transport.connected &&
			this.credential !== undefined &&
			this.credential === this.transport.getCredentialIdentity() &&
			this.credential === this.transport.getConnectionCredentialIdentity()
		);
	}
	private start(entry: Entry) {
		this.retire(entry);
		if (!this.visible || !this.trusted()) {
			this.publish(entry, {
				topology: null,
				status: this.transport.connected ? "connecting" : "disconnected",
			});
			return;
		}
		if (this.byId.size >= limits.maxSubscriptionsPerSocket) {
			this.publish(entry, { topology: null, status: "unavailable" });
			return;
		}
		entry.id = `communication-${++nextId}`;
		this.byId.set(entry.id, entry);
		this.publish(entry, { topology: null, status: "connecting" });
		if (
			!this.transport.send({
				type: "communication_subscribe",
				subscriptionId: entry.id,
				scope: entry.scope,
			})
		) {
			this.byId.delete(entry.id);
			entry.id = null;
			this.publish(entry, { topology: null, status: "disconnected" });
		}
	}
	private resync(entry: Entry) {
		this.retire(entry);
		this.publish(entry, { topology: null, status: "connecting" });
		this.pending.add(entry);
		if (this.scheduled) return;
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			const pending = [...this.pending];
			this.pending.clear();
			for (const entry of pending) if (entry.refs) this.start(entry);
		});
	}
	retry = (scope: CommunicationScope) => {
		const entry = this.entries.get(communicationScopeKey(scope));
		if (!entry) return;
		if (!this.transport.connected) this.transport.reconnect?.();
		this.resync(entry);
	};
	private receive(data: Record<string, unknown>) {
		if (!this.trusted() || !this.visible || typeof data.subscriptionId !== "string") return;
		const entry = this.byId.get(data.subscriptionId);
		if (!entry) return;
		if (bytes(data) > limits.maxBufferedBytes) {
			this.resync(entry);
			return;
		}
		const frame = data as unknown as CommunicationServerMessage;
		if (frame.type === "communication_error") {
			if (frame.code === "resync_required") this.resync(entry);
			else {
				this.retire(entry);
				this.publish(entry, {
					topology: null,
					status: frame.code === "access_denied" ? "denied" : "unavailable",
				});
			}
			return;
		}
		try {
			if (frame.type === "communication_snapshot") {
				// An id is unique for every re-subscribe. Once acknowledged, even a different
				// epoch snapshot is stale unless an explicit resync has first retired that id.
				if (entry.epoch) return;
				if (
					frame.seq !== 0 ||
					!frame.epoch ||
					communicationScopeKey(frame.topology.scope) !== communicationScopeKey(entry.scope)
				)
					throw new Error("Invalid snapshot");
				const topology = frame.topology;
				if (
					topology.nodes.length > limits.maxVisibleNodes ||
					topology.peers.length > limits.maxVisiblePeers ||
					bytes(topology) > limits.maxSnapshotBytes
				)
					throw new Error("Snapshot overflow");
				const ids = new Set(topology.nodes.map((node) => node.id));
				if (
					ids.size !== topology.nodes.length ||
					new Set(topology.peers.map((peer) => peer.id)).size !== topology.peers.length ||
					topology.peers.some(
						(peer) =>
							!ids.has(peer.endpointLo) ||
							!ids.has(peer.endpointHi) ||
							peer.endpointLo === peer.endpointHi,
					)
				)
					throw new Error("Invalid endpoints");
				entry.epoch = frame.epoch;
				entry.seq = 0;
				this.publish(entry, { topology, status: "live" });
			} else if (frame.type === "communication_delta") {
				if (!entry.epoch) {
					this.resync(entry);
					return;
				}
				if (frame.epoch !== entry.epoch || frame.seq <= entry.seq) return;
				if (frame.baseSeq !== entry.seq || frame.seq !== entry.seq + 1 || !entry.view.topology)
					throw new Error("Sequence gap");
				const topology = applyCommunicationTopologyDelta(entry.view.topology, frame.delta);
				if (bytes(topology) > limits.maxSnapshotBytes) throw new Error("Projection overflow");
				entry.seq = frame.seq;
				this.publish(entry, { topology, status: "live" });
			}
		} catch {
			this.resync(entry);
		}
	}
	private observe() {
		this.credential = this.transport.getCredentialIdentity();
		this.visible =
			(this.lifecycle?.document ?? (typeof document === "undefined" ? undefined : document))
				?.visibilityState !== "hidden";
		const listener = this.transport.addListener({ typePrefixes: ["communication_"] }, (data) =>
			this.receive(data),
		);
		const connection = this.transport.onConnectionChange((connected) => {
			for (const entry of this.entries.values()) {
				this.pending.delete(entry);
				if (connected) this.start(entry);
				else {
					this.retire(entry);
					this.publish(entry, { topology: null, status: "disconnected" });
				}
			}
		});
		const credential = this.transport.onCredentialChange(() => {
			this.credential = this.transport.getCredentialIdentity();
			for (const entry of this.entries.values()) {
				this.retire(entry);
				this.pending.delete(entry);
				this.publish(entry, { topology: null, status: "connecting" });
			}
			// Also retire a CONNECTING socket: it may still be authenticating with the
			// previous credential even though `connected` is false. Logout must cancel it too.
			this.transport.reconnect?.();
		});
		const lifecycle = observePageLifecycle(
			{
				onHidden: () => {
					this.visible = false;
					for (const entry of this.entries.values()) {
						this.retire(entry);
						this.pending.delete(entry);
						this.publish(entry, { topology: null, status: "disconnected" });
					}
				},
				onForeground: () => {
					if (this.visible) return;
					this.visible = true;
					for (const entry of this.entries.values()) this.start(entry);
				},
			},
			this.lifecycle,
		);
		this.dispose = () => {
			this.transport.removeListener(listener);
			connection();
			credential();
			lifecycle();
		};
		if (this.transport.connected && !this.trusted()) this.transport.reconnect?.();
		else this.transport.connect?.();
	}
}
