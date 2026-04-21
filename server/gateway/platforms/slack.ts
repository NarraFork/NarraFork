/**
 * Slack platform adapter.
 *
 * Uses @slack/bolt in Socket Mode (WebSocket, no public URL required).
 * Supports message editing for progressive streaming via chat.update.
 */

import { logger } from "../../lib/logger";
import { BaseAdapter } from "../base-adapter";
import type { GatewayPlatform, InboundMessage, SendResult, SlackConfig } from "../types";

export class SlackAdapter extends BaseAdapter {
	readonly platform: GatewayPlatform = "slack";
	readonly maxMessageLength = 39000;
	override readonly supportsEdit = true;

	private app: any = null;
	private config: SlackConfig;

	constructor(config: SlackConfig) {
		super();
		this.config = config;
	}

	async connect(): Promise<boolean> {
		try {
			const { App } = await import("@slack/bolt");

			this.app = new App({
				token: this.config.botToken,
				appToken: this.config.appToken,
				socketMode: true,
			});

			// Listen for messages
			this.app.message(async ({ message }: any) => {
				await this.handleSlackMessage(message);
			});

			// Listen for app_mention events (in channels)
			this.app.event("app_mention", async ({ event }: any) => {
				await this.handleSlackMessage(event);
			});

			await this.app.start();

			logger.info("[slack] Connected via Socket Mode");
			this.connected = true;
			return true;
		} catch (err) {
			logger.error("[slack] Connection failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
	}

	async disconnect(): Promise<void> {
		this.cancelReconnect();
		if (this.app) {
			await this.app.stop();
			this.app = null;
		}
		this.connected = false;
	}

	async send(chatId: string, text: string): Promise<void> {
		if (!this.app) return;

		const chunks = this.splitMessage(text);
		for (const chunk of chunks) {
			await this.app.client.chat.postMessage({
				channel: chatId,
				text: chunk,
			});
		}
	}

	override async sendAndGetId(chatId: string, text: string): Promise<SendResult> {
		if (!this.app) return { success: false, error: "App not connected" };

		try {
			const result = await this.app.client.chat.postMessage({
				channel: chatId,
				text,
			});

			return {
				success: result.ok === true,
				messageId: result.ts ?? null, // Slack uses `ts` as message ID
			};
		} catch (err) {
			return {
				success: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	override async editMessage(chatId: string, messageId: string, text: string): Promise<SendResult> {
		if (!this.app) return { success: false, error: "App not connected" };

		try {
			const result = await this.app.client.chat.update({
				channel: chatId,
				ts: messageId, // Slack uses `ts` as message ID
				text,
			});

			return {
				success: result.ok === true,
				messageId,
			};
		} catch (err) {
			return {
				success: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	async sendTyping(_chatId: string): Promise<void> {
		// Slack doesn't have a direct typing indicator API for bots.
	}

	// -----------------------------------------------------------------------
	// Private
	// -----------------------------------------------------------------------

	private async handleSlackMessage(message: any): Promise<void> {
		// Skip bot messages, message_changed, etc.
		if (message.subtype) return;
		if (message.bot_id) return;
		if (!message.text) return;

		const userId = message.user ?? "";
		const username = message.user ?? "unknown";

		// Check allowlist
		if (this.config.allowedUsers?.length) {
			if (!this.config.allowedUsers.includes(userId)) {
				return;
			}
		}

		// Strip bot mention from text
		let text = message.text;
		text = text.replace(/<@[A-Z0-9]+>/g, "").trim();
		if (!text) return;

		const chatId = message.channel ?? "";

		const inbound: InboundMessage = {
			platform: "slack",
			chatId,
			userId,
			username,
			text,
			raw: message,
		};

		await this.dispatchMessage(inbound);
	}
}
