import type { ConnectionTransport } from "puppeteer-core";
import type WebSocketType from "ws";
import type { RawData } from "ws";
// Bun's builtin "ws" shim does not honor all upstream receiver limits. A static file
// import bundles the real RFC6455 receiver in source AND compiled workers.
// @ts-expect-error ws exposes declarations only for its package entry, not internal JS files.
import WebSocketImplementation from "../../../node_modules/ws/lib/websocket.js";

const WebSocket = WebSocketImplementation as typeof WebSocketType;

import { MemoryProfileError, PROFILE_LIMITS } from "./memory-profile-constants";

/** Bounded before Puppeteer's JSON parser, including fragmented WebSocket messages. */
export class MemoryProfileTransport implements ConnectionTransport {
	onmessage?: (message: string) => void;
	onclose?: () => void;
	failureStage?: string;
	private closed = false;

	private constructor(private readonly socket: WebSocketType) {
		socket.on("message", (data: RawData) => {
			const bytes = Array.isArray(data)
				? data.reduce((sum, part) => sum + part.byteLength, 0)
				: data.byteLength;
			if (bytes > PROFILE_LIMITS.messageBytes) {
				this.failureStage = "profile_limit";
				this.close();
				return;
			}
			if (this.closed) return;
			const message = Array.isArray(data)
				? Buffer.concat(data).toString("utf8")
				: Buffer.from(data as ArrayBuffer).toString("utf8");
			this.onmessage?.(message);
		});
		socket.on("error", (error: Error & { code?: string }) => {
			this.failureStage =
				error.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH" ? "profile_limit" : "transport";
			this.close();
		});
		socket.on("close", () => this.notifyClose());
	}

	static async create(
		endpoint: string,
		timeoutMs: number = PROFILE_LIMITS.startTimeoutMs,
	): Promise<MemoryProfileTransport> {
		return new Promise((resolve, reject) => {
			let settled = false;
			let socket: WebSocketType;
			try {
				socket = new WebSocket(endpoint, {
					maxPayload: PROFILE_LIMITS.messageBytes,
					perMessageDeflate: false,
					handshakeTimeout: timeoutMs,
					followRedirects: false,
				});
			} catch {
				reject(new MemoryProfileError("connect"));
				return;
			}
			// Install a persistent error listener before connect can fail.
			const transport = new MemoryProfileTransport(socket);
			const fail = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				transport.close();
				reject(new MemoryProfileError("connect"));
			};
			const timer = setTimeout(fail, timeoutMs);
			socket.once("error", fail);
			socket.once("close", fail);
			socket.once("open", () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				socket.off("error", fail);
				socket.off("close", fail);
				resolve(transport);
			});
		});
	}

	send(message: string): void {
		if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
			throw new MemoryProfileError(this.failureStage ?? "transport");
		}
		if (Buffer.byteLength(message) > PROFILE_LIMITS.messageBytes) {
			this.failureStage = "profile_limit";
			this.close();
			throw new MemoryProfileError("profile_limit");
		}
		this.socket.send(message);
	}

	/** This is our private socket, never Browser.close / shared Chrome shutdown. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.socket.terminate();
		this.notifyClose();
	}

	private notified = false;
	private notifyClose(): void {
		this.closed = true;
		if (this.notified) return;
		this.notified = true;
		this.onclose?.();
	}
}
