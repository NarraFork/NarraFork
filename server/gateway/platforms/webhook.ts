/**
 * Generic Webhook platform adapter.
 *
 * Receives inbound messages via HTTP POST with HMAC-SHA256 signature
 * verification. This adapter is used via the gateway HTTP routes rather
 * than a persistent connection.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "../../lib/logger";
import { BaseAdapter } from "../base-adapter";
import type { GatewayPlatform, InboundMessage, WebhookConfig } from "../types";

export class WebhookAdapter extends BaseAdapter {
	readonly platform: GatewayPlatform = "webhook";
	readonly maxMessageLength = 65536; // No real limit for webhooks

	private config: WebhookConfig;

	constructor(config: WebhookConfig) {
		super();
		this.config = config;
	}

	/**
	 * Webhook adapter doesn't maintain a persistent connection.
	 * It's driven by HTTP requests via the gateway route.
	 */
	async connect(): Promise<boolean> {
		this.connected = true;
		logger.info("[webhook] Adapter ready (HTTP-driven)");
		return true;
	}

	async disconnect(): Promise<void> {
		this.connected = false;
	}

	/**
	 * Webhooks are typically one-way inbound. Outbound delivery is not
	 * supported unless a callback URL is provided in the payload.
	 */
	async send(_chatId: string, _text: string): Promise<void> {
		logger.warn("[webhook] send() called but webhooks are inbound-only");
	}

	async sendTyping(_chatId: string): Promise<void> {
		// No-op for webhooks
	}

	// -----------------------------------------------------------------------
	// Signature verification
	// -----------------------------------------------------------------------

	/**
	 * Verify HMAC-SHA256 signature from the request.
	 * Supports common header formats:
	 *   - X-Hub-Signature-256: sha256=<hex>  (GitHub)
	 *   - X-Webhook-Signature: <hex>
	 */
	verifySignature(body: string, signature: string | null): boolean {
		if (!signature) return false;

		const expected = createHmac("sha256", this.config.secret).update(body).digest("hex");

		// Handle "sha256=..." prefix (GitHub style)
		const actual = signature.startsWith("sha256=") ? signature.slice(7) : signature;

		try {
			return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
		} catch {
			return false;
		}
	}

	/**
	 * Parse an inbound webhook payload into an InboundMessage.
	 * Expected JSON format:
	 * {
	 *   "chat_id": "some-identifier",
	 *   "user_id": "sender-id",
	 *   "username": "sender-name",
	 *   "text": "message content"
	 * }
	 */
	parsePayload(body: Record<string, unknown>): InboundMessage | null {
		const text = typeof body.text === "string" ? body.text : null;
		if (!text) return null;

		return {
			platform: "webhook",
			chatId: String(body.chat_id ?? body.chatId ?? "webhook"),
			userId: String(body.user_id ?? body.userId ?? "webhook-user"),
			username: String(body.username ?? "webhook"),
			text,
			raw: body,
		};
	}
}
