import {
	type RemoteBackendIdentity,
	sameRemoteBackendIdentity,
} from "@shared/remote-access/application";
import type {
	BusinessSocket,
	BusinessUploadOptions,
	RemoteBusinessTransport,
} from "@shared/remote-access/business-transport";

export type RemoteConnectionState =
	| "connecting"
	| "paired"
	| "authenticating"
	| "ready"
	| "recovering"
	| "failed";
export interface RecoverableClient extends RemoteBusinessTransport {
	readonly state: string;
}

/** Owns the RTC across business-module mount and bounded grant-based recovery. */
export class RecoveringTransport implements RemoteBusinessTransport {
	private client: RecoverableClient;
	private identity: RemoteBackendIdentity;
	private token: string | null = null;
	private stopped = false;
	private recovery: Promise<RecoverableClient> | null = null;
	private sockets = new Set<DeferredBusinessSocket>();
	constructor(
		client: RecoverableClient,
		private reconnect: () => Promise<RecoverableClient>,
		private status: (state: RemoteConnectionState) => void = () => {},
	) {
		if (!client.backendIdentity) throw new Error("REMOTE_BACKEND_IDENTITY_MISSING");
		this.client = client;
		this.identity = structuredClone(client.backendIdentity);
		this.status("paired");
	}
	get backendIdentity(): RemoteBackendIdentity {
		return structuredClone(this.identity);
	}
	private async connected(): Promise<RecoverableClient> {
		if (this.stopped) throw new Error("REMOTE_CONNECTION_CLOSED");
		if (this.client.state !== "closed") return this.client;
		if (this.recovery) return this.recovery;
		this.status("recovering");
		this.recovery = (async () => {
			const next = await this.reconnect();
			if (
				this.stopped ||
				!next.backendIdentity ||
				!sameRemoteBackendIdentity(this.identity, next.backendIdentity)
			) {
				next.close();
				this.close(new Error("REMOTE_BACKEND_IDENTITY_CHANGED"));
				throw new Error("REMOTE_BACKEND_IDENTITY_CHANGED");
			}
			this.client = next;
			if (this.token) await next.authenticate(this.token);
			this.status(this.token ? "ready" : "paired");
			return next;
		})()
			.catch((error) => {
				this.status("failed");
				throw error;
			})
			.finally(() => {
				this.recovery = null;
			});
		return this.recovery;
	}
	async authenticate(token: string): Promise<void> {
		const client = await this.connected();
		if (this.token === token && client.state === "ready") return;
		this.status("authenticating");
		try {
			await client.authenticate(token);
			this.token = token;
			this.status("ready");
		} catch (error) {
			this.status("failed");
			throw error;
		}
	}
	async request(path: string, options?: RequestInit): Promise<Response> {
		options?.signal?.throwIfAborted();
		const client = await this.connected();
		options?.signal?.throwIfAborted();
		try {
			return await client.request(path, options);
		} catch (error) {
			// Writes may have committed: never replay them, even after an ambiguous close.
			if (
				options?.signal?.aborted ||
				client.state !== "closed" ||
				!["GET", "HEAD"].includes((options?.method ?? "GET").toUpperCase())
			)
				throw error;
			const recovered = await this.connected();
			options?.signal?.throwIfAborted();
			return recovered.request(path, options);
		}
	}
	async upload(path: string, body: BodyInit, options?: BusinessUploadOptions): Promise<Response> {
		options?.signal?.throwIfAborted();
		const client = await this.connected();
		options?.signal?.throwIfAborted();
		return client.upload(path, body, options);
	}
	openSocket(path: string, credential: string): BusinessSocket {
		const socket = new DeferredBusinessSocket(
			async () => (await this.connected()).openSocket(path, credential),
			(code) => {
				if (code === 4001) {
					this.close(new Error("REMOTE_SESSION_ENDED"));
					globalThis.dispatchEvent?.(new Event("narrafork:remote-session-ended"));
				}
			},
		);
		this.sockets.add(socket);
		socket.addEventListener("close", () => this.sockets.delete(socket), { once: true });
		return socket;
	}
	close(reason = new Error("REMOTE_CONNECTION_CLOSED")): void {
		if (this.stopped) return;
		this.stopped = true;
		this.token = null;
		this.client.close(reason);
		for (const socket of this.sockets) socket.close();
		this.sockets.clear();
		this.status("failed");
	}
}

/** A minimal logical socket, not a DataChannel/WebSocket cast. It never queues writes. */
export class DeferredBusinessSocket extends EventTarget implements BusinessSocket {
	readyState = 0;
	private inner: BusinessSocket | null = null;
	private binary: BinaryType = "blob";
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	get bufferedAmount() {
		return this.inner?.bufferedAmount ?? 0;
	}
	get binaryType() {
		return this.binary;
	}
	set binaryType(value: BinaryType) {
		this.binary = value;
		if (this.inner) this.inner.binaryType = value;
	}
	constructor(
		connect: () => Promise<BusinessSocket>,
		private ended: (code: number) => void = () => {},
	) {
		super();
		void connect()
			.then((inner) => {
				if (this.readyState === 3) {
					inner.close();
					return;
				}
				this.inner = inner;
				inner.binaryType = this.binary;
				inner.onopen = (event) => {
					this.readyState = 1;
					this.onopen?.(event);
					this.dispatchEvent(new Event("open"));
				};
				inner.onmessage = (event) => {
					this.onmessage?.(event);
					this.dispatchEvent(new MessageEvent("message", { data: event.data }));
				};
				inner.onerror = (event) => {
					this.onerror?.(event);
					this.dispatchEvent(new Event("error"));
				};
				inner.onclose = (event) => {
					this.finish(event.code, event.reason);
				};
				if (inner.readyState === 1) inner.onopen(new Event("open"));
				else if (inner.readyState === 3) this.finish(1006, "Socket closed before binding");
			})
			.catch(() => {
				this.onerror?.(new Event("error"));
				this.finish(1006, "Remote reconnect failed");
			});
	}
	send(data: string | ArrayBuffer | ArrayBufferView<ArrayBuffer>): void {
		if (this.readyState !== 1 || !this.inner) throw new Error("REMOTE_SOCKET_NOT_OPEN");
		this.inner.send(data);
	}
	close(code = 1000, reason = ""): void {
		if (this.readyState === 3) return;
		this.inner?.close(code, reason);
		this.finish(code, reason);
	}
	private finish(code: number, reason: string): void {
		if (this.readyState === 3) return;
		this.readyState = 3;
		const event = new CloseEvent("close", { code, reason, wasClean: code === 1000 });
		this.onclose?.(event);
		this.dispatchEvent(event);
		this.ended(code);
	}
}
