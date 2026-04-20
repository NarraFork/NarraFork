/**
 * Telegram platform adapter.
 *
 * Uses node-telegram-bot-api in long-polling mode (no public URL required).
 */

import { logger } from "../../lib/logger";
import { BaseAdapter } from "../base-adapter";
import type { GatewayPlatform, InboundMessage, TelegramConfig } from "../types";

export class TelegramAdapter extends BaseAdapter {
	readonly platform: GatewayPlatform = "telegram";
	readonly maxMessageLength = 4096;

	private bot: any = null;
	private config: TelegramConfig;

	constructor(config: TelegramConfig) {
		super();
		this.config = config;
	}

	async connect(): Promise<boolean> {
		try {
			const TelegramBot = (await import("node-telegram-bot-api")).default;
			this.bot = new TelegramBot(this.config.token, { polling: true });

			this.bot.on("message", (msg: any) => this.handleTelegramMessage(msg));

			this.bot.on("polling_error", (err: any) => {
				logger.error("[telegram] Polling error", {
					error: err?.message ?? String(err),
				});
			});

			// Verify connection by getting bot info
			const me = await this.bot.getMe();
			logger.info(`[telegram] Connected as @${me.username} (${me.id})`);

			this.connected = true;
			return true;
		} catch (err) {
			logger.error("[telegram] Connection failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
	}

	async disconnect(): Promise<void> {
		this.cancelReconnect();
		if (this.bot) {
			await this.bot.stopPolling();
			this.bot = null;
		}
		this.connected = false;
	}

	async send(chatId: string, text: string): Promise<void> {
		if (!this.bot) return;

		const chunks = this.splitMessage(text);
		for (const chunk of chunks) {
			await this.bot.sendMessage(chatId, chunk, {
				parse_mode: "Markdown",
				disable_web_page_preview: true,
			}).catch(async () => {
				// Fallback: send without Markdown if parsing fails
				await this.bot.sendMessage(chatId, chunk);
			});
		}
	}

	async sendTyping(chatId: string): Promise<void> {
		if (!this.bot) return;
		await this.bot.sendChatAction(chatId, "typing").catch(() => {});
	}

	// -----------------------------------------------------------------------
	// Private
	// -----------------------------------------------------------------------

	private async handleTelegramMessage(msg: any): Promise<void> {
		// Skip non-text messages for now
		if (!msg.text) return;

		const userId = String(msg.from?.id ?? "");
		const username = msg.from?.username ?? msg.from?.first_name ?? "unknown";

		// Check allowlist
		if (this.config.allowedUsers?.length) {
			if (!this.config.allowedUsers.includes(userId)) {
				logger.debug(`[telegram] Ignoring message from unauthorized user ${userId}`);
				return;
			}
		}

		const inbound: InboundMessage = {
			platform: "telegram",
			chatId: String(msg.chat.id),
			userId,
			username,
			text: msg.text,
			raw: msg,
		};

		await this.dispatchMessage(inbound);
	}
}
