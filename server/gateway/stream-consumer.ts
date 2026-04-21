/**
 * Gateway stream consumer — bridges narrator streaming events to progressive
 * IM message editing.
 *
 * Inspired by hermes-agent's GatewayStreamConsumer, adapted for narrafork's
 * event-bus architecture.
 *
 * Design:
 *   1. Listens to `narrator:ws_broadcast` events for a specific narratorId
 *   2. Accumulates text deltas from `stream_event` messages
 *   3. Periodically edits the IM message with accumulated text + cursor
 *   4. On tool boundaries, finalizes current message and starts a new one
 *   5. Handles flood control with adaptive backoff and fallback mode
 */

import { logger } from "../lib/logger";
import type { PlatformAdapter } from "./types";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface StreamConsumerConfig {
	/** Minimum interval between edits (seconds). */
	editInterval: number;
	/** Minimum accumulated chars before triggering an edit. */
	bufferThreshold: number;
	/** Cursor character appended during streaming. */
	cursor: string;
}

const DEFAULT_CONFIG: StreamConsumerConfig = {
	editInterval: 1.0,
	bufferThreshold: 40,
	cursor: " ▉",
};

// ---------------------------------------------------------------------------
// Stream consumer
// ---------------------------------------------------------------------------

export class GatewayStreamConsumer {
	private adapter: PlatformAdapter;
	private chatId: string;
	private cfg: StreamConsumerConfig;

	// Accumulated text from stream deltas
	private accumulated = "";
	// Platform message ID for editing
	private messageId: string | null = null;
	// Whether at least one message was sent
	private alreadySent = false;
	// Whether the final response was delivered
	private _finalResponseSent = false;
	// Last text that was successfully sent/edited
	private lastSentText = "";
	// Timestamp of last edit
	private lastEditTime = 0;
	// Whether editing is still supported (disabled after repeated failures)
	private editSupported = true;
	// Flood control
	private floodStrikes = 0;
	private currentEditInterval: number;
	// Fallback mode: when edits fail, send only the missing tail at the end
	private fallbackFinalSend = false;
	private fallbackPrefix = "";

	private static readonly MAX_FLOOD_STRIKES = 3;

	// Timer for periodic flush
	private flushTimer: ReturnType<typeof setInterval> | null = null;
	// Whether the stream is done
	private done = false;
	// Resolve function for the completion promise
	private resolveCompletion: (() => void) | null = null;
	// Concurrency guard: prevents overlapping flushSegment calls
	private flushing = false;
	// Deferred segment break: set when onSegmentBreak() is called while flushing
	private pendingFinalize = false;

	constructor(adapter: PlatformAdapter, chatId: string, config?: Partial<StreamConsumerConfig>) {
		this.adapter = adapter;
		this.chatId = chatId;
		this.cfg = { ...DEFAULT_CONFIG, ...config };
		this.currentEditInterval = this.cfg.editInterval;
	}

	get finalResponseSent(): boolean {
		return this._finalResponseSent;
	}

	// -----------------------------------------------------------------------
	// Public API
	// -----------------------------------------------------------------------

	/**
	 * Feed a text delta from a stream event.
	 */
	onDelta(text: string): void {
		if (this.done) return;
		this.accumulated += text;
	}

	/**
	 * Signal a tool boundary — finalize current message, start a new one.
	 */
	onSegmentBreak(): void {
		if (this.done) return;
		if (this.flushing) {
			// Another flush is in progress — defer the finalize until it completes
			this.pendingFinalize = true;
			return;
		}
		// Flush current accumulated text as a finalized message
		this.flushSegment(true).catch((err) => {
			logger.error("[stream-consumer] Segment break flush error", {
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}

	/**
	 * Signal that the stream is complete. Returns a promise that resolves
	 * when the final message has been delivered.
	 */
	async finish(): Promise<void> {
		this.done = true;
		this.stopFlushTimer();
		await this.flushFinal();
		this.resolveCompletion?.();
	}

	/**
	 * Start the periodic flush timer. Returns a promise that resolves when
	 * finish() is called and the final message is delivered.
	 */
	start(): Promise<void> {
		return new Promise<void>((resolve) => {
			this.resolveCompletion = resolve;
			// Check every 100ms if we should flush
			this.flushTimer = setInterval(() => {
				this.maybeFlush();
			}, 100);
		});
	}

	/**
	 * Abort the consumer (e.g. on error). Best-effort final edit.
	 */
	abort(): void {
		this.done = true;
		this.stopFlushTimer();
		// Best-effort: try to deliver what we have
		if (this.accumulated && this.messageId) {
			this.sendOrEdit(this.accumulated).catch(() => {});
		}
		this.resolveCompletion?.();
	}

	// -----------------------------------------------------------------------
	// Internal flush logic
	// -----------------------------------------------------------------------

	private stopFlushTimer(): void {
		if (this.flushTimer) {
			clearInterval(this.flushTimer);
			this.flushTimer = null;
		}
	}

	private maybeFlush(): void {
		if (this.done || !this.accumulated || this.flushing) return;

		const now = Date.now();
		const elapsed = (now - this.lastEditTime) / 1000;

		const shouldEdit =
			elapsed >= this.currentEditInterval || this.accumulated.length >= this.cfg.bufferThreshold;

		if (shouldEdit) {
			this.flushSegment(false).catch((err) => {
				logger.error("[stream-consumer] Periodic flush error", {
					error: err instanceof Error ? err.message : String(err),
				});
			});
		}
	}

	private async flushSegment(finalize: boolean): Promise<void> {
		if (!this.accumulated || this.flushing) return;
		this.flushing = true;
		try {
			const safeLimit = Math.max(500, this.adapter.maxMessageLength - 100);

			// Handle overflow: split if text exceeds platform limit
			if (this.accumulated.length > safeLimit && this.messageId) {
				// Edit current message with first chunk, send rest as new
				const splitAt = this.findSplitPoint(this.accumulated, safeLimit);
				const chunk = this.accumulated.slice(0, splitAt);
				await this.sendOrEdit(chunk);
				this.accumulated = this.accumulated.slice(splitAt).replace(/^\n/, "");
				this.messageId = null;
				this.lastSentText = "";
			}

			const displayText = finalize ? this.accumulated : this.accumulated + this.cfg.cursor;

			await this.sendOrEdit(displayText, finalize);
			this.lastEditTime = Date.now();

			if (finalize) {
				this.messageId = null;
				this.accumulated = "";
				this.lastSentText = "";
				this.fallbackFinalSend = false;
				this.fallbackPrefix = "";
			}
		} finally {
			this.flushing = false;
			// If a segment break arrived while we were flushing, execute it now
			if (this.pendingFinalize && !this.done) {
				this.pendingFinalize = false;
				this.flushSegment(true).catch((err) => {
					logger.error("[stream-consumer] Deferred segment break flush error", {
						error: err instanceof Error ? err.message : String(err),
					});
				});
			}
		}
	}

	private async flushFinal(): Promise<void> {
		if (!this.accumulated) {
			this._finalResponseSent = this.alreadySent;
			return;
		}

		if (this.fallbackFinalSend) {
			await this.sendFallbackFinal(this.accumulated);
			return;
		}

		const ok = await this.sendOrEdit(this.accumulated, true);
		if (ok) {
			this._finalResponseSent = true;
		}
	}

	private async sendFallbackFinal(text: string): Promise<void> {
		// Send only the part the user hasn't seen yet
		const prefix = this.fallbackPrefix || this.lastSentText;
		let continuation = text;
		if (prefix && text.startsWith(prefix)) {
			continuation = text.slice(prefix.length).trimStart();
		}

		if (!continuation.trim()) {
			this._finalResponseSent = this.alreadySent;
			return;
		}

		const safeLimit = Math.max(500, this.adapter.maxMessageLength - 100);
		const chunks = this.splitText(continuation, safeLimit);

		for (const chunk of chunks) {
			const result = await this.adapter.sendAndGetId(this.chatId, chunk);
			if (!result.success) {
				logger.error("[stream-consumer] Fallback send failed", {
					error: result.error,
				});
				return;
			}
			this.alreadySent = true;
		}

		this._finalResponseSent = true;
	}

	private async sendOrEdit(text: string, finalize = false): Promise<boolean> {
		if (!text.trim()) return true;

		try {
			if (this.messageId && this.editSupported) {
				// Skip if text is identical to what we last sent
				if (text === this.lastSentText) return true;

				const result = await this.adapter.editMessage(this.chatId, this.messageId, text);

				if (result.success) {
					this.alreadySent = true;
					this.lastSentText = text;
					this.floodStrikes = 0;
					return true;
				}

				// Edit failed — check for flood control
				if (this.isFloodError(result.error)) {
					this.floodStrikes++;
					this.currentEditInterval = Math.min(this.currentEditInterval * 2, 10.0);
					logger.debug(
						`[stream-consumer] Flood control (strike ${this.floodStrikes}/${GatewayStreamConsumer.MAX_FLOOD_STRIKES}), backoff → ${this.currentEditInterval}s`,
					);

					if (this.floodStrikes < GatewayStreamConsumer.MAX_FLOOD_STRIKES) {
						this.lastEditTime = Date.now();
						return false;
					}
				}

				// Enter fallback mode
				this.fallbackPrefix = this.lastSentText.replace(this.cfg.cursor, "");
				this.fallbackFinalSend = true;
				this.editSupported = false;
				this.alreadySent = true;
				return false;
			}

			// No existing message — send new
			const result = await this.adapter.sendAndGetId(this.chatId, text);
			if (result.success) {
				if (result.messageId) {
					this.messageId = result.messageId;
				} else {
					// Platform doesn't return message IDs — disable editing
					this.editSupported = false;
					this.fallbackPrefix = text.replace(this.cfg.cursor, "");
					this.fallbackFinalSend = true;
				}
				this.alreadySent = true;
				this.lastSentText = text;
				return true;
			}

			this.editSupported = false;
			return false;
		} catch (err) {
			logger.error("[stream-consumer] Send/edit error", {
				error: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
	}

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	private isFloodError(error?: string): boolean {
		if (!error) return false;
		const lower = error.toLowerCase();
		return lower.includes("flood") || lower.includes("retry after") || lower.includes("rate");
	}

	private findSplitPoint(text: string, limit: number): number {
		const splitAt = text.lastIndexOf("\n", limit);
		if (splitAt < limit * 0.5) return limit;
		return splitAt;
	}

	private splitText(text: string, limit: number): string[] {
		if (text.length <= limit) return [text];
		const chunks: string[] = [];
		let remaining = text;
		while (remaining.length > limit) {
			const splitAt = this.findSplitPoint(remaining, limit);
			chunks.push(remaining.slice(0, splitAt));
			remaining = remaining.slice(splitAt).replace(/^\n/, "");
		}
		if (remaining) chunks.push(remaining);
		return chunks;
	}
}
