import {
	parseRemoteBackendIdentity,
	type RemoteBackendIdentity,
	sameRemoteBackendIdentity,
} from "./application";
import type { BusinessUploadOptions } from "./business-transport";
import {
	APP_VERSION,
	decodeFrame,
	encodeFrame,
	FRAME_DATA,
	FRAME_END,
	LIMITS,
	VERSION,
} from "./protocol";
import { resolveRemoteRequestRule } from "./request-policy";
import {
	decodeSocketFrame,
	encodeSocketFrame,
	SOCKET_FRAGMENT_BYTES,
	SOCKET_MESSAGE_BYTES,
	SocketAssembly,
	type SocketFrame,
} from "./socket-frames";

const encoder = new TextEncoder();
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;
const LOGIN_PATHS = new Set(["/api/auth/login", "/api/auth/mfa/verify"]);
const FORBIDDEN_HEADERS =
	/^(host|connection|keep-alive|upgrade|transfer-encoding|te|trailer|cookie|set-cookie|proxy-.*|forwarded|x-forwarded-.*|x-narrafork-bridge|x-narrafork-remote-.*)$/i;
const REQUEST_FORBIDDEN_HEADERS = /^(content-length|x-narrafork-.*)$/i;

export type PrototypeChannels = {
	control: RTCDataChannel;
	realtime: RTCDataChannel;
	bulk: RTCDataChannel;
};
export type GrantMessage = { grantId: string; discoveryCapability?: string; expiresAt: number };
export type TransportOptions = {
	/** Fixture identities are accepted only through explicit opt-in. */
	mode?: "narrafork" | "prototype";
	headerTimeoutMs?: number;
	idleTimeoutMs?: number;
	stallTimeoutMs?: number;
	onGrant?: (grant: GrantMessage) => void | Promise<void>;
};

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	// Connection promises may fail before a caller starts awaiting them.
	void promise.catch(() => {});
	return { promise, resolve, reject };
}

type Pending = ReturnType<typeof deferred<void>>;
type HttpState = {
	id: number;
	method: string;
	response: ReturnType<typeof deferred<Response>>;
	readable: ReadableStream<Uint8Array>;
	controller: ReadableStreamDefaultController<Uint8Array>;
	queue: Uint8Array[];
	rxCredit: number;
	rxSequence: number;
	rxEnded: boolean;
	rxDone: boolean;
	rxBytes: number;
	rxLimit: number;
	txCredit: number;
	txOutstanding: number;
	txSequence: number;
	txDone: boolean;
	accepted: boolean;
	head: boolean;
	nullBody: boolean;
	body: ReadableStream<Uint8Array> | null;
	reader?: ReadableStreamDefaultReader<Uint8Array>;
	txLimit: number;
	wake?: Pending;
	creditWake?: Pending;
	timer: ReturnType<typeof setTimeout>;
	abort?: () => void;
	signal: AbortSignal;
	stop: AbortController;
	error?: Error;
	profile: "request" | "sse";
	started: number;
	onProgress?: (fraction: number) => void;
	uploadLength?: number;
};

export function remotePath(path: string, socket = false): string {
	// Never let URL normalization hide an authority, traversal or fragment.
	if (
		typeof path !== "string" ||
		!path.startsWith(socket ? "/ws/" : "/api/") ||
		path.includes("\\") ||
		path.includes("#") ||
		[...path].some(
			(character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
		) ||
		path.length > 8192
	)
		throw new Error("invalid_business_path");
	const url = new URL(path, "https://remote.invalid");
	const decoded = decodeURIComponent(url.pathname);
	if (
		url.origin !== "https://remote.invalid" ||
		!url.pathname.startsWith(socket ? "/ws/" : "/api/") ||
		decoded.includes("\\") ||
		decoded.includes("//") ||
		decoded.split("/").some((part) => part === "." || part === "..") ||
		decoded !== decodeURIComponent(path.split("?")[0] ?? "") ||
		[...url.searchParams.keys()].some((key) =>
			/^(token|authorization|pairingSecret|discoveryCapability|bridgeSecret)$/i.test(key),
		)
	)
		throw new Error("invalid_business_path");
	if (socket && url.pathname !== "/ws/narrator") throw new Error("unsupported_socket_path");
	return path;
}

function headerPairs(headers: Headers, response = false): [string, string][] {
	const pairs: [string, string][] = [];
	let bytes = 0;
	for (const [key, value] of headers) {
		if (
			FORBIDDEN_HEADERS.test(key) ||
			(!response && (REQUEST_FORBIDDEN_HEADERS.test(key) || /^(origin|referer)$/i.test(key)))
		)
			throw new Error("forbidden_header");
		bytes += encoder.encode(`${key}:${value}\r\n`).byteLength;
		if (bytes > 8192) throw new Error("headers_too_large");
		pairs.push([key, value]);
	}
	return pairs;
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("invalid_control");
	return value as Record<string, unknown>;
}
function integer(value: unknown, min = 1, max = 0xffffffff): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
		throw new Error("invalid_integer");
	return value;
}
function text(value: unknown, max = 256): string {
	if (typeof value !== "string" || value.length > max) throw new Error("invalid_string");
	return value;
}
function responseHeaders(value: unknown): Headers {
	if (!Array.isArray(value) || value.length > 128) throw new Error("invalid_headers");
	const headers = new Headers();
	for (const pair of value) {
		if (!Array.isArray(pair) || pair.length !== 2) throw new Error("invalid_headers");
		const key = text(pair[0], 256);
		const val = text(pair[1], 8192);
		if (FORBIDDEN_HEADERS.test(key)) throw new Error("forbidden_header");
		headers.append(key, val);
	}
	headerPairs(headers, true);
	return headers;
}
function asError(reason: unknown): Error {
	return reason instanceof Error ? reason : new Error("transport_closed");
}
/** A logical socket with bounded text/binary messages, not a DataChannel cast. */
export class PrototypeSocket extends EventTarget {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	readonly CONNECTING = 0;
	readonly OPEN = 1;
	readonly CLOSING = 2;
	readonly CLOSED = 3;
	readyState = PrototypeSocket.CONNECTING;
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	binaryType: BinaryType = "blob";
	bufferedAmount = 0;
	private messageId = 1;
	private credit = LIMITS.windowBytes;
	private chain: Promise<void> = Promise.resolve();
	private creditWake?: Pending;
	private assemblyTimer?: ReturnType<typeof setTimeout>;
	private readonly stop = new AbortController();
	private readonly assembly = new SocketAssembly(
		(n) => this.owner.reserveSocket(n, false),
		(n) => this.owner.releaseSocket(n, false),
	);
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	private readonly opened = deferred<void>();
	readonly ready = this.opened.promise;
	constructor(
		readonly streamId: number,
		private readonly owner: PrototypeTransport,
	) {
		super();
	}
	send(message: string | ArrayBuffer | ArrayBufferView): void {
		if (this.readyState !== PrototypeSocket.OPEN) throw new Error("socket_not_open");
		if (typeof message === "string" && message.length > SOCKET_MESSAGE_BYTES)
			throw new Error("socket_message_too_large");
		const source =
			typeof message === "string"
				? encoder.encode(message)
				: message instanceof ArrayBuffer
					? new Uint8Array(message)
					: new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
		if (source.byteLength > SOCKET_MESSAGE_BYTES || this.messageId > 0xffffffff)
			throw new Error("socket_message_too_large");
		this.owner.reserveSocket(source.byteLength, true);
		const bytes = source.slice();
		const messageId = this.messageId++;
		this.bufferedAmount += bytes.byteLength;
		this.chain = this.chain
			.then(async () => {
				let offset = 0,
					sequence = 0;
				do {
					if (this.stop.signal.aborted) throw new Error("socket_closed");
					if (this.credit === 0 && offset < bytes.byteLength) {
						this.creditWake = deferred<void>();
						const timer = setTimeout(
							() => this.creditWake?.reject(new Error("socket_credit_stalled")),
							30_000,
						);
						try {
							await this.creditWake.promise;
						} finally {
							clearTimeout(timer);
						}
					}
					const size = Math.min(SOCKET_FRAGMENT_BYTES, this.credit, bytes.byteLength - offset);
					this.credit -= size;
					await this.owner.sendSocketFrame(
						{
							streamId: this.streamId,
							messageId,
							opcode: typeof message === "string" ? 1 : 2,
							sequence: sequence++,
							total: bytes.byteLength,
							end: offset + size === bytes.byteLength,
							payload: bytes.subarray(offset, offset + size),
						},
						this.stop.signal,
					);
					offset += size;
				} while (offset < bytes.byteLength);
			})
			.catch((error) => {
				if (!this.stop.signal.aborted) this.owner.close(asError(error));
			})
			.finally(() => {
				this.bufferedAmount -= bytes.byteLength;
				this.owner.releaseSocket(bytes.byteLength, true);
			});
	}
	updateCredit(bytes: number): void {
		if (bytes <= 0 || bytes + this.credit > LIMITS.windowBytes)
			throw new Error("invalid_socket_credit");
		this.credit += bytes;
		this.creditWake?.resolve();
	}
	receiveFrame(frame: SocketFrame): void {
		if (this.readyState !== PrototypeSocket.OPEN) throw new Error("socket_not_open");
		const result = this.assembly.accept(frame);
		if (!this.assemblyTimer && this.assembly.pending)
			this.assemblyTimer = setTimeout(
				() => this.owner.close(new Error("socket_assembly_timeout")),
				30_000,
			);
		// Credit is returned after copying into the fully reserved assembly, not after END.
		if (frame.payload.byteLength)
			this.owner.sendRealtime({
				type: "socket.window",
				streamId: this.streamId,
				bytes: frame.payload.byteLength,
			});
		if (result) {
			clearTimeout(this.assemblyTimer);
			this.assemblyTimer = undefined;
			try {
				const data =
					result.opcode === 1
						? new TextDecoder("utf-8", { fatal: true }).decode(result.data)
						: this.binaryType === "arraybuffer"
							? result.data.buffer
							: new Blob([result.data]);
				const event = new MessageEvent("message", { data });
				this.dispatchEvent(event);
				this.onmessage?.(event);
			} finally {
				this.owner.releaseSocket(result.data.byteLength, false);
			}
		}
	}
	close(code = 1000, reason = ""): void {
		if (this.readyState >= PrototypeSocket.CLOSING) return;
		if ((code !== 1000 && (code < 3000 || code > 4999)) || encoder.encode(reason).byteLength > 123)
			throw new Error("invalid_socket_close");
		this.owner.sendRealtime({ type: "socket.close", streamId: this.streamId, code, reason });
		this.finish(code, reason, true);
	}
	accept(): void {
		if (this.readyState !== PrototypeSocket.CONNECTING) return;
		this.readyState = PrototypeSocket.OPEN;
		this.opened.resolve();
		const event = new Event("open");
		this.dispatchEvent(event);
		this.onopen?.(event);
	}
	finish(code: number, reason: string, wasClean = false): void {
		if (this.readyState === PrototypeSocket.CLOSED) return;
		this.readyState = PrototypeSocket.CLOSED;
		this.stop.abort();
		clearTimeout(this.assemblyTimer);
		this.assembly.cancel();
		this.creditWake?.reject(new Error("socket_closed"));
		this.opened.reject(new Error(reason || "socket_closed"));
		this.owner.removeSocket(this.streamId);
		// Bun and older test environments may not expose CloseEvent.
		const event =
			typeof CloseEvent === "function"
				? new CloseEvent("close", { code, reason, wasClean })
				: Object.assign(new Event("close"), { code, reason, wasClean });
		this.dispatchEvent(event);
		this.onclose?.(event as CloseEvent);
	}
}

/**
 * M1 HTTP/socket transport. The native RTC owner supplies hello after validating SDP.
 * fromChannels permits deterministic channel tests; it never bypasses hello/ready versions.
 * request() resolves at response headers, has manual redirect semantics, and streams bodies.
 * Login paths alone are available after paired and before authenticate() resolves ready.
 */
export class PrototypeTransport {
	private readonly pairing = deferred<GrantMessage>();
	private readonly activation = deferred<void>();
	readonly paired = this.pairing.promise;
	readonly ready = this.activation.promise;
	private phase: "connecting" | "paired" | "authenticating" | "ready" | "closed" = "connecting";
	private nextId = 1;
	private readonly streams = new Map<number, HttpState>();
	private readonly sockets = new Map<number, PrototypeSocket>();
	private incomingBytes = 0;
	private outgoingBytes = 0;
	private readonly sendChains = new Map<RTCDataChannel, Promise<void>>();
	private readonly removeListeners: (() => void)[] = [];
	private readonly shutdown = new AbortController();
	private authTimer?: ReturnType<typeof setTimeout>;
	private failure?: Error;
	private identity: RemoteBackendIdentity | null = null;
	get backendIdentity(): RemoteBackendIdentity | null {
		return this.identity ? structuredClone(this.identity) : null;
	}

	constructor(
		readonly channels: PrototypeChannels,
		private readonly options: TransportOptions = {},
	) {
		for (const [kind, channel] of Object.entries(channels)) {
			channel.binaryType = "arraybuffer";
			channel.bufferedAmountLowThreshold = LOW_WATER;
			const message = (event: MessageEvent) => {
				if (this.phase === "closed") return;
				try {
					if (kind === "bulk") this.receiveBulk(event.data);
					else if (kind === "realtime" && typeof event.data !== "string") {
						const frame = decodeSocketFrame(event.data);
						const socket = this.sockets.get(frame.streamId);
						if (socket) socket.receiveFrame(frame);
						else if (frame.streamId >= this.nextId) throw new Error("unknown_socket");
					} else this.receiveControl(event.data, kind === "realtime");
				} catch (error) {
					this.close(asError(error));
				}
			};
			const closed = () => this.close(new Error("datachannel_closed"));
			channel.addEventListener("message", message);
			channel.addEventListener("close", closed);
			channel.addEventListener("error", closed);
			this.removeListeners.push(() => {
				channel.removeEventListener("message", message);
				channel.removeEventListener("close", closed);
				channel.removeEventListener("error", closed);
			});
		}
	}

	static fromChannels(
		channels: PrototypeChannels,
		options: TransportOptions = {},
	): PrototypeTransport {
		return new PrototypeTransport(channels, options);
	}
	get state(): string {
		return this.phase;
	}
	get queueBytes(): { incoming: number; outgoing: number } {
		return { incoming: this.incomingBytes, outgoing: this.outgoingBytes };
	}

	/** JWT is only transmitted on the already authenticated direct control channel. */
	async authenticate(token: string): Promise<void> {
		await this.paired;
		if (this.phase === "closed") throw this.failure;
		if (this.phase === "ready") throw new Error("already_authenticated");
		if (this.phase === "authenticating") return this.ready;
		if (!token || token.length > 8192 || /[\r\n]/.test(token)) throw new Error("invalid_token");
		this.phase = "authenticating";
		this.authTimer = setTimeout(() => this.close(new Error("auth_timeout")), 15_000);
		await this.sendControl({ type: "auth", token });
		return this.ready;
	}

	upload(path: string, body: BodyInit, options: BusinessUploadOptions = {}): Promise<Response> {
		options.onProgress?.(0);
		const length =
			body instanceof Blob
				? body.size
				: typeof body === "string"
					? encoder.encode(body).byteLength
					: body instanceof ArrayBuffer
						? body.byteLength
						: ArrayBuffer.isView(body)
							? body.byteLength
							: body instanceof URLSearchParams
								? encoder.encode(body.toString()).byteLength
								: undefined;
		// Unknown-length multipart/streams report endpoints rather than inventing a percentage.
		return this.request(
			path,
			{ method: "POST", body, headers: options.headers, signal: options.signal },
			options.onProgress,
			length,
		);
	}

	async request(
		path: string,
		init: RequestInit = {},
		onProgress?: (fraction: number) => void,
		uploadLength?: number,
	): Promise<Response> {
		remotePath(path);
		await this.paired;
		if (this.phase !== "ready" && !LOGIN_PATHS.has(path.split("?")[0] ?? ""))
			throw this.failure ?? new Error("not_authenticated");
		if (this.phase === "closed") throw this.failure;
		if (this.streams.size >= LIMITS.streams) throw new Error("too_many_streams");
		if (init.redirect && init.redirect !== "manual") throw new Error("redirect_follow_forbidden");
		if (init.credentials && init.credentials !== "omit") throw new Error("cookies_not_supported");
		// Request supplies multipart boundary and a streaming FormData serializer.
		const request = new Request(`https://remote.invalid${path}`, {
			...init,
			credentials: "omit",
			redirect: "manual",
		});
		if (
			this.options.mode !== "prototype" &&
			!resolveRemoteRequestRule(request.method, path, this.phase === "ready" ? "ready" : "paired")
		)
			throw new Error("path_not_allowed");
		const headers = headerPairs(request.headers);
		if (request.signal.aborted)
			throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
		const id = this.allocateId();
		const response = deferred<Response>();
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		let state!: HttpState;
		const readable = new ReadableStream<Uint8Array>(
			{
				start(value) {
					controller = value;
				},
				pull: async () => {
					while (!state.error && !state.queue.length && !state.rxEnded) {
						state.wake = deferred<void>();
						const timer = setTimeout(
							() => this.cancelStream(state, new Error("response_body_stalled"), true),
							state.profile === "sse"
								? (this.options.idleTimeoutMs ?? 60_000)
								: (this.options.stallTimeoutMs ?? 30_000),
						);
						try {
							await state.wake.promise;
						} finally {
							clearTimeout(timer);
						}
					}
					if (state.error) return;
					const chunk = state.queue.shift();
					if (chunk) {
						this.incomingBytes -= chunk.byteLength;
						state.rxCredit += chunk.byteLength;
						void this.sendControl({ type: "window.update", streamId: id, bytes: chunk.byteLength });
						controller.enqueue(chunk);
					} else if (state.rxEnded) {
						state.rxDone = true;
						controller.close();
						this.maybeDelete(state);
					}
				},
				cancel: (reason) => this.cancelStream(state, asError(reason), true),
			},
			{ highWaterMark: 0 },
		);
		state = {
			id,
			profile: "request",
			started: Date.now(),
			onProgress,
			uploadLength,
			method: request.method,
			response,
			readable,
			controller,
			queue: [],
			rxCredit: LIMITS.windowBytes,
			rxSequence: 0,
			rxEnded: false,
			rxDone: false,
			rxBytes: 0,
			rxLimit: LIMITS.fileBytes,
			txCredit: LIMITS.windowBytes,
			txOutstanding: 0,
			txSequence: 0,
			txDone: false,
			accepted: false,
			head: false,
			nullBody: request.method === "HEAD",
			body: request.body,
			txLimit: /\bjson\b/i.test(request.headers.get("content-type") ?? "")
				? LIMITS.jsonBytes
				: LIMITS.fileBytes,
			timer: setTimeout(
				() => this.cancelStream(state, new Error("response_header_timeout"), true),
				this.options.headerTimeoutMs ?? 30_000,
			),
			signal: request.signal,
			stop: new AbortController(),
		};
		state.abort = () =>
			this.cancelStream(
				state,
				asError(request.signal.reason ?? new DOMException("Aborted", "AbortError")),
				true,
			);
		request.signal.addEventListener("abort", state.abort, { once: true });
		// Mandatory: install response state before sending request.open, even for synchronous mocks.
		this.streams.set(id, state);
		void this.sendControl({
			type: "request.open",
			streamId: id,
			method: request.method,
			path,
			headers,
			hasBody: request.body !== null,
		}).catch((error) => this.cancelStream(state, asError(error), false));
		return response.promise;
	}

	openSocket(path: string, token: string): PrototypeSocket {
		remotePath(path, true);
		if (this.options.mode !== "prototype" && !resolveRemoteRequestRule("GET", path, "ready"))
			throw new Error("path_not_allowed");
		if (this.phase !== "ready") throw this.failure ?? new Error("not_authenticated");
		if (this.sockets.size >= LIMITS.sockets) throw new Error("too_many_sockets");
		if (!token || token.length > 8192 || /[\r\n]/.test(token)) throw new Error("invalid_token");
		const id = this.allocateId();
		const socket = new PrototypeSocket(id, this);
		this.sockets.set(id, socket);
		this.sendRealtime({ type: "socket.open", streamId: id, path, token });
		return socket;
	}
	reserveSocket(n: number, send: boolean): void {
		if (
			n + (send ? this.outgoingBytes : this.incomingBytes) >
			LIMITS.queueBytes - 2 * LIMITS.frameBytes
		)
			throw new Error("socket_queue_exceeded");
		if (send) this.outgoingBytes += n;
		else this.incomingBytes += n;
	}
	releaseSocket(n: number, send: boolean): void {
		if (send) this.outgoingBytes -= n;
		else this.incomingBytes -= n;
	}
	sendSocketFrame(frame: SocketFrame, signal: AbortSignal): Promise<void> {
		return this.send(this.channels.realtime, encodeSocketFrame(frame), signal);
	}
	removeSocket(id: number): void {
		this.sockets.delete(id);
	}
	sendRealtime(message: Record<string, unknown>): void {
		void this.sendJson(this.channels.realtime, message).catch((error) =>
			this.close(asError(error)),
		);
	}
	sendControl(message: Record<string, unknown>): Promise<void> {
		return this.sendJson(this.channels.control, message);
	}

	close(reason: Error = new Error("client_closed")): void {
		if (this.phase === "closed") return;
		this.phase = "closed";
		this.failure = reason;
		clearTimeout(this.authTimer);
		this.shutdown.abort(reason);
		this.pairing.reject(reason);
		this.activation.reject(reason);
		for (const cleanup of this.removeListeners.splice(0)) cleanup();
		for (const state of this.streams.values()) this.cancelStream(state, reason, false);
		for (const socket of this.sockets.values()) socket.finish(1006, reason.message);
		for (const channel of Object.values(this.channels)) channel.close();
	}

	private allocateId(): number {
		if (this.nextId > 0xffffffff) throw new Error("stream_ids_exhausted");
		return this.nextId++;
	}
	private sendJson(channel: RTCDataChannel, message: Record<string, unknown>): Promise<void> {
		const encoded = JSON.stringify(message);
		if (encoder.encode(encoded).byteLength > LIMITS.controlBytes)
			throw new Error("control_too_large");
		return this.send(channel, encoded);
	}
	private send(
		channel: RTCDataChannel,
		data: string | Uint8Array,
		signal?: AbortSignal,
	): Promise<void> {
		if (this.phase === "closed") return Promise.reject(this.failure);
		const bytes = typeof data === "string" ? encoder.encode(data).byteLength : data.byteLength;
		if (this.outgoingBytes + bytes > LIMITS.queueBytes) {
			this.close(new Error("send_queue_exceeded"));
			return Promise.reject(this.failure);
		}
		this.outgoingBytes += bytes;
		const previous = this.sendChains.get(channel) ?? Promise.resolve();
		const pending = previous
			.then(async () => {
				if (signal?.aborted) throw signal.reason;
				if (channel.bufferedAmount > HIGH_WATER) await this.waitLow(channel, signal);
				if (signal?.aborted) throw signal.reason;
				if (this.phase === "closed" || channel.readyState !== "open")
					throw this.failure ?? new Error("datachannel_not_open");
				if (typeof data === "string") channel.send(data);
				else channel.send(data as Uint8Array<ArrayBuffer>);
			})
			.finally(() => {
				this.outgoingBytes -= bytes;
			});
		this.sendChains.set(
			channel,
			pending.catch(() => {}),
		);
		void pending.catch((error) => {
			if (!signal?.aborted) this.close(asError(error));
		});
		return pending;
	}
	private waitLow(channel: RTCDataChannel, signal?: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timer);
				channel.removeEventListener("bufferedamountlow", low);
				this.shutdown.signal.removeEventListener("abort", abort);
				signal?.removeEventListener("abort", abort);
			};
			const low = () => {
				if (channel.bufferedAmount <= LOW_WATER) {
					cleanup();
					resolve();
				}
			};
			const abort = () => {
				cleanup();
				reject(signal?.aborted ? signal.reason : this.failure);
			};
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error("send_stalled"));
			}, this.options.stallTimeoutMs ?? 30_000);
			channel.addEventListener("bufferedamountlow", low);
			this.shutdown.signal.addEventListener("abort", abort, { once: true });
			signal?.addEventListener("abort", abort, { once: true });
			if (this.shutdown.signal.aborted || signal?.aborted) abort();
			else low();
		});
	}

	private receiveControl(data: unknown, realtime: boolean): void {
		if (typeof data !== "string" || encoder.encode(data).byteLength > LIMITS.controlBytes)
			throw new Error("invalid_control_size");
		const message = record(JSON.parse(data));
		const type = text(message.type, 64);
		if (type.startsWith("socket.")) {
			if (!realtime) throw new Error("wrong_channel");
			const id = integer(message.streamId);
			const socket = this.sockets.get(id);
			if (!socket) return; // A close may cross the last message already in flight.
			if (type === "socket.ready") socket.accept();
			else if (type === "socket.window")
				socket.updateCredit(integer(message.bytes, 1, LIMITS.windowBytes));
			else if (type === "socket.close") {
				const code = integer(message.code, 1000, 4999);
				socket.finish(code, text(message.reason, 123), code !== 1006);
			} else throw new Error("unknown_socket_control");
			return;
		}
		if (realtime) throw new Error("wrong_channel");
		if (type === "peer.error") throw new Error(text(message.code));
		if (type === "hello.ready") {
			if (this.phase !== "connecting") throw new Error("duplicate_hello");
			if (message.version !== VERSION) throw new Error("version_mismatch");
			if (this.options.mode !== "prototype")
				this.identity = parseRemoteBackendIdentity(message.backendIdentity);
			else if (message.backendIdentity !== undefined)
				throw new Error("prototype_identity_forbidden");
			const grantId = text(message.grantId);
			if (!/^[A-Za-z0-9_-]{1,256}$/.test(grantId)) throw new Error("invalid_grant");
			const grant: GrantMessage = {
				grantId,
				expiresAt: integer(
					message.expiresAt,
					Math.floor(Date.now() / 1000) + 1,
					Math.floor(Date.now() / 1000) + 31 * 86400,
				),
			};
			if (message.discoveryCapability !== undefined)
				grant.discoveryCapability = text(message.discoveryCapability);
			this.phase = "paired";
			void Promise.resolve(this.options.onGrant?.(grant))
				.then(() => this.pairing.resolve(grant))
				.catch((error) => this.close(asError(error)));
			return;
		}
		if (type === "ready") {
			if (
				this.phase !== "authenticating" ||
				message.version !== VERSION ||
				(this.options.mode === "prototype"
					? message.apiVersion !== 1 ||
						message.appVersion !== APP_VERSION ||
						message.backendIdentity !== undefined
					: !this.identity ||
						!sameRemoteBackendIdentity(
							this.identity,
							parseRemoteBackendIdentity(message.backendIdentity),
						))
			)
				throw new Error("version_mismatch");
			clearTimeout(this.authTimer);
			this.phase = "ready";
			this.activation.resolve();
			return;
		}
		if (
			![
				"request.accept",
				"response.open",
				"window.update",
				"stream.cancel",
				"stream.error",
			].includes(type)
		)
			throw new Error("unknown_control");
		const id = integer(message.streamId);
		const state = this.streams.get(id);
		if (!state) {
			if (id >= this.nextId || this.sockets.has(id)) throw new Error("unknown_stream");
			return; // Cancellation races may deliver late control/body frames.
		}
		if (type === "request.accept") {
			if (state.accepted) throw new Error("duplicate_accept");
			state.accepted = true;
			if (message.profile !== undefined) {
				if (message.profile !== "request" && message.profile !== "sse")
					throw new Error("invalid_profile");
				state.profile = message.profile;
				if (state.profile === "sse") state.rxLimit = 64 * 1024 * 1024;
			}
			void this.sendBody(state).catch((error) => this.cancelStream(state, asError(error), true));
		} else if (type === "response.open") {
			if (state.head) throw new Error("duplicate_response_head");
			const status = integer(message.status, 200, 599);
			if (this.options.mode !== "prototype" && status >= 300 && status < 400 && status !== 304)
				throw new Error("redirect_forbidden");
			const headers = responseHeaders(message.headers);
			if (
				this.options.mode !== "prototype" &&
				[...headers.keys()].some((name) => /authorization|token|secret|^location$/i.test(name))
			)
				throw new Error("forbidden_header");
			state.head = true;
			state.nullBody = state.method === "HEAD" || [204, 205, 304].includes(status);
			state.rxLimit =
				state.profile === "sse"
					? 64 * 1024 * 1024
					: /\bjson\b/i.test(headers.get("content-type") ?? "")
						? LIMITS.jsonBytes
						: LIMITS.fileBytes;
			if (state.rxBytes > state.rxLimit || (state.nullBody && state.rxBytes !== 0))
				throw new Error("response_body_exceeded");
			clearTimeout(state.timer);
			state.timer = setTimeout(
				() => this.cancelStream(state, new Error("stream_lifetime_exceeded"), true),
				Math.max(
					1,
					(state.profile === "sse" ? 2 * 60 * 60 * 1000 : 30_000) - (Date.now() - state.started),
				),
			);
			state.response.resolve(
				new Response(state.nullBody ? null : state.readable, { status, headers }),
			);
			if (state.nullBody && state.rxEnded) {
				state.rxDone = true;
				this.maybeDelete(state);
			}
		} else if (type === "window.update") {
			const bytes = integer(message.bytes, 1, LIMITS.windowBytes);
			if (bytes > state.txOutstanding) throw new Error("invalid_credit");
			state.txOutstanding -= bytes;
			state.txCredit += bytes;
			if (state.txCredit > LIMITS.windowBytes) throw new Error("credit_overflow");
			state.creditWake?.resolve();
		} else if (type === "stream.cancel" || type === "stream.error") {
			this.cancelStream(
				state,
				new Error(type === "stream.error" ? text(message.code) : "remote_cancel"),
				false,
			);
		} else throw new Error("unknown_control");
	}

	private receiveBulk(data: unknown): void {
		if (!(data instanceof ArrayBuffer) && !(data instanceof Uint8Array))
			throw new Error("invalid_bulk");
		const frame = decodeFrame(data instanceof Uint8Array ? data : new Uint8Array(data));
		const state = this.streams.get(frame.streamId);
		if (!state) {
			if (frame.streamId >= this.nextId || this.sockets.has(frame.streamId))
				throw new Error("unknown_stream");
			return;
		}
		if (frame.sequence !== state.rxSequence++ || state.rxEnded) throw new Error("invalid_sequence");
		if (frame.kind === FRAME_END) {
			state.rxEnded = true;
			if (state.nullBody && state.head) {
				state.rxDone = true;
				this.maybeDelete(state);
			}
		} else {
			const payload = frame.payload;
			if (
				!payload?.byteLength ||
				payload.byteLength > state.rxCredit ||
				(state.nullBody && state.head)
			)
				throw new Error("invalid_receive_credit");
			if (
				state.rxBytes + payload.byteLength > state.rxLimit ||
				this.incomingBytes + payload.byteLength > LIMITS.queueBytes
			)
				throw new Error("receive_queue_exceeded");
			state.rxCredit -= payload.byteLength;
			state.rxBytes += payload.byteLength;
			this.incomingBytes += payload.byteLength;
			state.queue.push(payload.slice());
		}
		state.wake?.resolve();
	}

	private async sendBody(state: HttpState): Promise<void> {
		// hasBody:false is implicit EOF; another END would violate B's closed request direction.
		if (!state.body) {
			state.txDone = true;
			state.onProgress?.(1);
			this.maybeDelete(state);
			return;
		}
		let total = 0;
		let admitted = 0;
		try {
			if (state.body) {
				state.reader = state.body.getReader();
				while (!state.error) {
					// Do not pull the upload upstream until both peer credit and RTC capacity exist.
					await this.waitCredit(state);
					if (this.channels.bulk.bufferedAmount > HIGH_WATER)
						await this.waitLow(this.channels.bulk, state.stop.signal);
					const { done, value } = await state.reader.read();
					if (done) break;
					total += value.byteLength;
					if (total > state.txLimit) throw new Error("request_body_exceeded");
					for (let offset = 0; offset < value.byteLength; ) {
						await this.waitCredit(state);
						const count = Math.min(
							value.byteLength - offset,
							LIMITS.frameBytes - LIMITS.headerBytes,
							state.txCredit,
						);
						const payload = value.slice(offset, offset + count);
						state.txCredit -= count;
						state.txOutstanding += count;
						await this.send(
							this.channels.bulk,
							encodeFrame({
								kind: FRAME_DATA,
								streamId: state.id,
								sequence: state.txSequence++,
								payload,
							}),
							state.stop.signal,
						);
						offset += count;
						admitted += count;
						if (state.uploadLength)
							state.onProgress?.(Math.min(0.999, admitted / state.uploadLength));
					}
				}
			}
			if (state.error) return;
			await this.send(
				this.channels.bulk,
				encodeFrame({ kind: FRAME_END, streamId: state.id, sequence: state.txSequence++ }),
				state.stop.signal,
			);
			state.txDone = true;
			state.onProgress?.(1);
			this.maybeDelete(state);
		} finally {
			state.reader?.releaseLock();
		}
	}
	private async waitCredit(state: HttpState): Promise<void> {
		if (state.error) throw state.error;
		if (state.txCredit > 0) return;
		state.creditWake = deferred<void>();
		const timer = setTimeout(
			() => state.creditWake?.reject(new Error("credit_stalled")),
			this.options.stallTimeoutMs ?? 30_000,
		);
		try {
			await state.creditWake.promise;
		} finally {
			clearTimeout(timer);
		}
		if (state.error) throw state.error;
	}
	private cancelStream(state: HttpState, reason: Error, notify: boolean): void {
		if (state.error || !this.streams.has(state.id)) return;
		state.error = reason;
		state.stop.abort(reason);
		clearTimeout(state.timer);
		if (state.abort) state.signal.removeEventListener("abort", state.abort);
		for (const chunk of state.queue) this.incomingBytes -= chunk.byteLength;
		state.queue = [];
		this.streams.delete(state.id);
		state.response.reject(reason);
		try {
			state.controller.error(reason);
		} catch {
			/* Already closed or canceled. */
		}
		state.wake?.resolve();
		state.creditWake?.reject(reason);
		void (state.reader ? state.reader.cancel(reason) : state.body?.cancel(reason))?.catch(() => {});
		if (notify && this.phase !== "closed")
			void this.sendControl({ type: "stream.cancel", streamId: state.id }).catch(() => {});
	}
	private maybeDelete(state: HttpState): void {
		if (!state.rxDone || !state.txDone) return;
		clearTimeout(state.timer);
		if (state.abort) state.signal.removeEventListener("abort", state.abort);
		this.streams.delete(state.id);
	}
}
