/**
 * Abstract base class for IM platform adapters.
 *
 * Provides common utilities: message truncation, reconnection with
 * exponential back-off, and a typed message callback.
 */

import { logger } from "../lib/logger";
import type { GatewayPlatform, InboundMessage, PlatformAdapter, PlatformAdapterEvents } from "./types";

export abstract class BaseAdapter implements PlatformAdapter {
	abstract readonly platform: GatewayPlatform;
	abstract readonly maxMessageLength: number;

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

		logger.info(`[${this.platform}] Reconnecting in ${Math.round(jitter)}ms (attempt ${this.reconnectAttempt})`);

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
