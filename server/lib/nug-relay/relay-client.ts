/**
 * NUG client-egress relay client (nf side).
 *
 * One instance per NUG provider with egressMode "local-direct"/"local-proxy":
 * keeps a WSS connection to the gateway's /v1/relay endpoint alive, answers
 * DIAL requests against the local allowlist, and splices opaque ciphertext
 * between the relay channel and local TCP connections. This process never
 * sees request or response plaintext — TLS terminates on the NUG side, which
 * is exactly why the codex credentials never reach this machine.
 *
 * Flow control mirrors the Go implementation in internal/relay: per-stream
 * send window of INITIAL_STREAM_WINDOW, topped up by WINDOW_UPDATE frames as
 * the peer consumes.
 */
import type { Socket } from "bun";

import { logger } from "../logger";
import {
	DEFAULT_ALLOWED_RELAY_HOSTS,
	dialRelayTarget,
	parseAndValidateTarget,
	RelayTargetRejectedError,
} from "./dialer";
import {
	decodeFrame,
	decodeWindowUpdate,
	encodeFrame,
	encodeWindowUpdate,
	INITIAL_STREAM_WINDOW,
	MAX_DATA_PAYLOAD,
	OP_DATA,
	OP_DIAL,
	OP_DIAL_ERR,
	OP_DIAL_OK,
	OP_FIN,
	OP_RST,
	OP_WINDOW_UPDATE,
} from "./protocol";

export type NugRelayStatus = "offline" | "connecting" | "online";

export interface NugRelayClientOptions {
	/** Owning NUG provider id (for logs). */
	providerId: string;
	/** NUG base URL (http/https); converted to ws/wss for the relay endpoint. */
	baseUrl: string;
	/** NUG API key, sent as Authorization: Bearer on the relay upgrade. */
	apiKey: string;
	/** Local proxy URL for egress (e.g. "http://127.0.0.1:7890"); empty = direct. */
	egressProxyUrl?: string;
	/** Dial allowlist; defaults to chatgpt.com only. Tests may extend it. */
	allowedHosts?: readonly string[];
	/** Reconnect backoff bounds. */
	reconnect?: { initialMs?: number; maxMs?: number };
}

interface RelayStream {
	socket: Socket | null;
	/** Bytes this side may still send to the server before a WINDOW_UPDATE. */
	sendWindow: number;
	/** Socket data buffered while the send window is exhausted. */
	queue: Uint8Array[];
	queuedBytes: number;
	closed: boolean;
}

/** Beyond this much buffered upstream data per stream, something is stuck: RST. */
const MAX_QUEUED_BYTES_PER_STREAM = 4 * INITIAL_STREAM_WINDOW;

export class NugRelayClient {
	private ws: WebSocket | null = null;
	private readonly streams = new Map<bigint, RelayStream>();
	private statusValue: NugRelayStatus = "offline";
	private stopped = false;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectDelay: number;

	private channelIdValue: string | null = null;

	constructor(private readonly options: NugRelayClientOptions) {
		this.reconnectDelay = options.reconnect?.initialMs ?? 1000;
	}

	get status(): NugRelayStatus {
		return this.statusValue;
	}

	get currentChannelId(): string | null {
		return this.channelIdValue;
	}

	start(): void {
		if (this.stopped || this.ws) {
			return;
		}
		this.connect();
	}

	stop(): void {
		this.stopped = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		const ws = this.ws;
		this.ws = null;
		if (ws) {
			try {
				ws.close();
			} catch {
				// best effort
			}
		}
		this.failAllStreams(new Error("relay client stopped"));
		this.statusValue = "offline";
		this.channelIdValue = null;
	}

	private relayWsUrl(): string {
		const base = this.options.baseUrl
			.trim()
			.replace(/\/+$/, "")
			.replace(/\/(?:api\/v1|api|v1)$/i, "");
		return `${base.replace(/^http/i, "ws")}/v1/relay`;
	}

	private connect(): void {
		if (this.stopped) {
			return;
		}
		this.statusValue = "connecting";
		let ws: WebSocket;
		try {
			// Bun extension: headers on the WebSocket constructor. The relay
			// endpoint authenticates with the same API key as chat requests.
			ws = new WebSocket(this.relayWsUrl(), {
				headers: { Authorization: `Bearer ${this.options.apiKey}` },
			} as never);
		} catch (err) {
			logger.warn("nug relay connect failed", {
				providerId: this.options.providerId,
				error: String(err),
			});
			this.scheduleReconnect();
			return;
		}
		this.ws = ws;
		ws.binaryType = "arraybuffer";
		ws.addEventListener("message", (event) => this.onMessage(event));
		ws.addEventListener("close", () => this.onClose());
		ws.addEventListener("error", () => {
			// The close event follows; nothing to do here.
		});
	}

	private scheduleReconnect(): void {
		if (this.stopped || this.reconnectTimer) {
			return;
		}
		const max = this.options.reconnect?.maxMs ?? 60_000;
		const delay = Math.min(this.reconnectDelay, max);
		this.reconnectDelay = Math.min(this.reconnectDelay * 2, max);
		this.reconnectTimer = setTimeout(
			() => {
				this.reconnectTimer = null;
				this.ws = null;
				this.connect();
			},
			delay + Math.floor(Math.random() * 500),
		);
	}

	private onClose(): void {
		if (this.stopped) {
			return;
		}
		logger.warn("nug relay channel closed; reconnecting", { providerId: this.options.providerId });
		this.failAllStreams(new Error("relay channel closed"));
		this.statusValue = "offline";
		this.channelIdValue = null;
		this.scheduleReconnect();
	}

	private onMessage(event: MessageEvent): void {
		const data = event.data;
		if (typeof data === "string") {
			// Text frames carry JSON control messages.
			try {
				const msg = JSON.parse(data) as { type?: string; channel_id?: string };
				if (msg.type === "hello_ack" && typeof msg.channel_id === "string" && msg.channel_id) {
					this.channelIdValue = msg.channel_id;
					this.statusValue = "online";
					this.reconnectDelay = this.options.reconnect?.initialMs ?? 1000;
					logger.info("nug relay channel online", {
						providerId: this.options.providerId,
						channelId: msg.channel_id,
					});
				}
			} catch (err) {
				logger.warn("nug relay bad control message", { error: String(err) });
			}
			return;
		}
		const raw = new Uint8Array(data as ArrayBuffer);
		let frame: ReturnType<typeof decodeFrame>;
		try {
			frame = decodeFrame(raw);
		} catch (err) {
			logger.warn("nug relay malformed frame", { error: String(err) });
			return;
		}
		this.handleFrame(frame.op, frame.streamId, frame.payload);
	}

	private handleFrame(op: number, streamId: bigint, payload: Uint8Array): void {
		switch (op) {
			case OP_DIAL:
				this.handleDial(streamId, new TextDecoder().decode(payload));
				return;
			case OP_DATA:
				this.handleData(streamId, payload);
				return;
			case OP_FIN:
				this.handleFin(streamId);
				return;
			case OP_RST:
				this.handleRst(streamId);
				return;
			case OP_WINDOW_UPDATE:
				this.handleWindowUpdate(streamId, payload);
				return;
			default:
				logger.warn("nug relay unknown opcode", { op });
		}
	}

	private send(frame: Uint8Array<ArrayBuffer>): void {
		try {
			this.ws?.send(frame);
		} catch (err) {
			logger.warn("nug relay send failed", { error: String(err) });
		}
	}

	private handleDial(streamId: bigint, addr: string): void {
		let target: import("./dialer").DialTarget;
		try {
			target = parseAndValidateTarget(
				addr,
				this.options.allowedHosts ?? DEFAULT_ALLOWED_RELAY_HOSTS,
			);
		} catch (err) {
			if (err instanceof RelayTargetRejectedError) {
				logger.warn("nug relay dial rejected by allowlist", { addr });
			}
			this.send(encodeFrame(OP_DIAL_ERR, streamId, new TextEncoder().encode(String(err))));
			return;
		}

		const stream: RelayStream = {
			socket: null,
			sendWindow: INITIAL_STREAM_WINDOW,
			queue: [],
			queuedBytes: 0,
			closed: false,
		};
		this.streams.set(streamId, stream);

		dialRelayTarget(target, this.options.egressProxyUrl || undefined, {
			onData: (data) => this.onSocketData(streamId, data),
			onClose: () => this.onSocketClose(streamId),
			onError: () => this.onSocketClose(streamId),
		})
			.then((socket) => {
				if (stream.closed) {
					socket.end();
					return;
				}
				stream.socket = socket;
				this.send(encodeFrame(OP_DIAL_OK, streamId, new Uint8Array(0)));
			})
			.catch((err) => {
				this.streams.delete(streamId);
				this.send(
					encodeFrame(OP_DIAL_ERR, streamId, new TextEncoder().encode(String(err).slice(0, 256))),
				);
			});
	}

	/** Upstream → server: data read from the local socket goes out as DATA. */
	private onSocketData(streamId: bigint, data: Uint8Array): void {
		const stream = this.streams.get(streamId);
		if (!stream || stream.closed) {
			return;
		}
		stream.queue.push(data);
		stream.queuedBytes += data.byteLength;
		this.flushQueue(streamId, stream);
		if (stream.queuedBytes > MAX_QUEUED_BYTES_PER_STREAM) {
			// The server is not consuming. Rather than buffering without bound,
			// abort this stream; the request fails and can be retried.
			logger.warn("nug relay stream queue overflow; resetting", {
				providerId: this.options.providerId,
			});
			this.resetStream(streamId, "send window stalled");
		}
	}

	private flushQueue(streamId: bigint, stream: RelayStream): void {
		while (stream.queue.length > 0 && stream.sendWindow > 0 && !stream.closed) {
			const head = stream.queue[0];
			const n = Math.min(head.byteLength, stream.sendWindow, MAX_DATA_PAYLOAD);
			const chunk = n === head.byteLength ? head : head.subarray(0, n);
			this.send(encodeFrame(OP_DATA, streamId, chunk));
			stream.sendWindow -= n;
			stream.queuedBytes -= n;
			if (n === head.byteLength) {
				stream.queue.shift();
			} else {
				stream.queue[0] = head.subarray(n);
			}
		}
	}

	/** Server → upstream: DATA payload is written to the local socket. */
	private handleData(streamId: bigint, payload: Uint8Array): void {
		const stream = this.streams.get(streamId);
		if (!stream?.socket || stream.closed) {
			return;
		}
		stream.socket.write(payload);
		// Grant the server its credit back once the bytes are handed to the
		// socket; local writes are to clash/kernel buffers and complete fast.
		this.send(encodeWindowUpdate(streamId, payload.byteLength));
	}

	private handleFin(streamId: bigint): void {
		const stream = this.streams.get(streamId);
		if (!stream) {
			return;
		}
		// Server half-close: it will not send more. Our sockets are not
		// half-closeable through the Bun API, and at this point the request
		// body has long been sent, so a full close after flush is equivalent.
		stream.closed = true;
		stream.socket?.end();
		this.streams.delete(streamId);
	}

	private handleRst(streamId: bigint): void {
		this.resetStream(streamId, null);
	}

	private handleWindowUpdate(streamId: bigint, payload: Uint8Array): void {
		const stream = this.streams.get(streamId);
		if (!stream) {
			return;
		}
		let increment: number;
		try {
			increment = decodeWindowUpdate(payload);
		} catch {
			return;
		}
		stream.sendWindow += increment;
		this.flushQueue(streamId, stream);
	}

	private onSocketClose(streamId: bigint): void {
		const stream = this.streams.get(streamId);
		if (!stream) {
			return;
		}
		this.streams.delete(streamId);
		if (!stream.closed) {
			// Upstream closed its write side: tell the server there will be no
			// more DATA (its Read returns EOF after draining).
			this.send(encodeFrame(OP_FIN, streamId, new Uint8Array(0)));
		}
	}

	private resetStream(streamId: bigint, reason: string | null): void {
		const stream = this.streams.get(streamId);
		if (!stream) {
			return;
		}
		stream.closed = true;
		this.streams.delete(streamId);
		try {
			stream.socket?.end();
		} catch {
			// best effort
		}
		if (reason !== null) {
			this.send(encodeFrame(OP_RST, streamId, new TextEncoder().encode(reason)));
		}
	}

	private failAllStreams(err: Error): void {
		for (const [id, stream] of this.streams) {
			stream.closed = true;
			try {
				stream.socket?.end();
			} catch {
				// best effort
			}
			this.streams.delete(id);
		}
		if (this.streams.size > 0) {
			logger.warn("nug relay dropped streams", { error: String(err) });
		}
	}
}
