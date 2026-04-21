/**
 * Abstract base class for IM platform adapters.
 *
 * Provides common utilities: message truncation, reconnection with
 * exponential back-off, rate limiting, and a typed message callback.
 */

import { logger } from "../lib/logger";
import type {
	GatewayPlatform,
	InboundMessage,
	PlatformAdapter,
	PlatformAdapterEvents,
	SendResult,
} from "./types";

export abstract class BaseAdapter implements PlatformAdapter {
	abstract readonly platform: GatewayPlatform;
	abstract readonly maxMessageLength: number;

	/** Override in subclass to enable streaming (progressive edits). */
	readonly supportsEdit: boolean = false;

	protected messageHandler: PlatformAdapterEvents["message"] | null = null;
	protected connected = false;

	// Reconnection state
	private reconnectAttempt = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly maxReconnectDelay = 60_000; // 60 s
	private readonly baseReconnectDelay = 1_000; // 1 s

	// -----------------------------------------------------------------------
	// Lifecycle (to be implemented by subclasses)
	// -----------------------------------------------------------------------

	abstract connect(): Promise<boolean>;
	abstract disconnect(): Promise<void>;
	abstract send(chatId: string, text: string): Promise<void>;
	abstract sendTyping(chatId: string): Promise<void>;

	// -----------------------------------------------------------------------
	// Edit support — default no-op implementations
	// Subclasses that support editing override these.
	// -----------------------------------------------------------------------

	async sendAndGetId(chatId: string, text: string): Promise<SendResult> {
		try {
			await this.send(chatId, text);
			return { success: true, messageId: null };
		} catch (err) {
			return {
				success: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	async editMessage(_chatId: string, _messageId: string, _text: string): Promise<SendResult> {
		return { success: false, error: "Edit not supported" };
	}

	// -----------------------------------------------------------------------
	// Message handler registration
	// -----------------------------------------------------------------------

	onMessage(handler: PlatformAdapterEvents["message"]): void {
		this.messageHandler = handler;
	}

	protected async dispatchMessage(msg: InboundMessage): Promise<void> {
		if (!this.messageHandler) {
			logger.warn(`[${this.platform}] No message handler registered, dropping message`);
			return;
		}
		try {
			await this.messageHandler(msg);
		} catch (err) {
			logger.error(`[${this.platform}] Message handler error`, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// -----------------------------------------------------------------------
	// Message truncation
	// -----------------------------------------------------------------------

	protected truncate(text: string): string {
		if (text.length <= this.maxMessageLength) return text;
		const suffix = "\n\n… (truncated)";
		return text.slice(0, this.maxMessageLength - suffix.length) + suffix;
	}

	/**
	 * Split a long message into chunks that fit within the platform limit.
	 * Tries to split on newline boundaries when possible.
	 */
	protected splitMessage(text: string): string[] {
		if (text.length <= this.maxMessageLength) return [text];

		const chunks: string[] = [];
		let remaining = text;

		while (remaining.length > 0) {
			if (remaining.length <= this.maxMessageLength) {
				chunks.push(remaining);
				break;
			}

			// Try to find a newline near the limit
			let splitAt = remaining.lastIndexOf("\n", this.maxMessageLength);
			if (splitAt < this.maxMessageLength * 0.5) {
				// No good newline break — split at limit
				splitAt = this.maxMessageLength;
			}

			chunks.push(remaining.slice(0, splitAt));
			remaining = remaining.slice(splitAt).replace(/^\n/, "");
		}

		return chunks;
	}

	// -----------------------------------------------------------------------
	// Reconnection with exponential back-off + jitter
	// -----------------------------------------------------------------------

	protected scheduleReconnect(): void {
		if (this.reconnectTimer) return;

		this.reconnectAttempt++;
		const delay = Math.min(
			this.baseReconnectDelay * 2 ** (this.reconnectAttempt - 1),
			this.maxReconnectDelay,
		);
		// Add ±25 % jitter
		const jitter = delay * (0.75 + Math.random() * 0.5);

		logger.info(
			`[${this.platform}] Reconnecting in ${Math.round(jitter)}ms (attempt ${this.reconnectAttempt})`,
		);

		this.reconnectTimer = setTimeout(async () => {
			this.reconnectTimer = null;
			try {
				const ok = await this.connect();
				if (ok) {
					this.reconnectAttempt = 0;
					logger.info(`[${this.platform}] Reconnected successfully`);
				} else {
					this.scheduleReconnect();
				}
			} catch (err) {
				logger.error(`[${this.platform}] Reconnect failed`, {
					error: err instanceof Error ? err.message : String(err),
				});
				this.scheduleReconnect();
			}
		}, jitter);
	}

	protected cancelReconnect(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.reconnectAttempt = 0;
	}
}

// ---------------------------------------------------------------------------
// Simple in-memory rate limiter (per-user sliding window)
// ---------------------------------------------------------------------------

export class RateLimiter {
	private windows = new Map<string, number[]>();
	private readonly maxPerMinute: number;

	constructor(maxPerMinute: number) {
		this.maxPerMinute = maxPerMinute;
	}

	/** Returns true if the request is allowed, false if rate-limited. */
	allow(key: string): boolean {
		if (this.maxPerMinute <= 0) return true;

		const now = Date.now();
		const cutoff = now - 60_000;

		let timestamps = this.windows.get(key);
		if (!timestamps) {
			timestamps = [];
			this.windows.set(key, timestamps);
		}

		// Prune old entries
		while (timestamps.length > 0 && timestamps[0] < cutoff) {
			timestamps.shift();
		}

		if (timestamps.length >= this.maxPerMinute) {
			return false;
		}

		timestamps.push(now);
		return true;
	}

	/** Periodic cleanup of stale entries. */
	cleanup(): void {
		const cutoff = Date.now() - 60_000;
		for (const [key, timestamps] of this.windows) {
			while (timestamps.length > 0 && timestamps[0] < cutoff) {
				timestamps.shift();
			}
			if (timestamps.length === 0) {
				this.windows.delete(key);
			}
		}
	}
}
