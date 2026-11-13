import type { RemoteBackendIdentity } from "./application";

/** The subset used by NF's socket manager; not a cast to a browser WebSocket. */
export interface BusinessSocket extends EventTarget {
	readonly readyState: number;
	readonly bufferedAmount: number;
	binaryType: BinaryType;
	onopen: ((event: Event) => void) | null;
	onmessage: ((event: MessageEvent) => void) | null;
	onerror: ((event: Event) => void) | null;
	onclose: ((event: CloseEvent) => void) | null;
	send(data: string | ArrayBuffer | ArrayBufferView<ArrayBuffer>): void;
	close(code?: number, reason?: string): void;
}

export interface BusinessUploadOptions {
	headers?: HeadersInit;
	signal?: AbortSignal;
	/** Bytes admitted to transport, not a claim of durable storage on the server. */
	onProgress?: (fraction: number) => void;
}

export interface BusinessTransport {
	request(path: string, init?: RequestInit): Promise<Response>;
	upload(path: string, body: BodyInit, options?: BusinessUploadOptions): Promise<Response>;
	openSocket(path: string, credential: string): BusinessSocket;
}

export interface RemoteBusinessTransport extends BusinessTransport {
	readonly backendIdentity: RemoteBackendIdentity | null;
	authenticate(token: string): Promise<void>;
	close(reason?: Error): void;
}

/** Versioned hand-off ABI between the small host bootstrap and the selected NF module. */
export interface RemoteFrontendMountOptions {
	root: HTMLElement;
	transport: RemoteBusinessTransport;
	backendIdentity: RemoteBackendIdentity;
	assetBase: string;
}

export interface RemoteFrontendModule {
	mount(options: RemoteFrontendMountOptions): Promise<() => void> | (() => void);
}
