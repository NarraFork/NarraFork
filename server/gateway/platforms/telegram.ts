/**
 * Telegram platform adapter.
 *
 * Uses node-telegram-bot-api in long-polling mode (no public URL required).
 * Supports message editing for progressive streaming.
 */

import type TelegramBot from "node-telegram-bot-api";
import type { TelegramMessage } from "node-telegram-bot-api";
import { logger } from "../../lib/logger";
import { getOutboundProxy } from "../../lib/net/proxy";
import { BaseAdapter } from "../base-adapter";
import type { GatewayPlatform, InboundMessage, SendResult, TelegramConfig } from "../types";

export class TelegramAdapter extends BaseAdapter {
	readonly platform: GatewayPlatform = "telegram";
	readonly maxMessageLength = 4096;
	override readonly supportsEdit = true;

	private bot: TelegramBot | null = null;
	private config: TelegramConfig;

	constructor(config: TelegramConfig) {
		super();
		this.config = config;
	}

	async connect(): Promise<boolean> {
		try {
			const TelegramBotCtor = (await import("node-telegram-bot-api")).default;
			// Telegram uses long-polling over HTTP; route all API traffic through the
			// global outbound proxy when configured (underlying @cypress/request
			// accepts a `proxy` URL). Empty proxy → default direct behaviour.
			const proxy = getOutboundProxy();
			this.bot = new TelegramBotCtor(this.config.token, {
				polling: true,
				...(proxy ? { request: { proxy } } : {}),
			});

			this.bot.on("message", (msg) => this.handleTelegramMessage(msg));

			this.bot.on("polling_error", (err) => {
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
		const bot = this.bot;
		if (!bot) return;

		const chunks = this.splitMessage(text);
		for (const chunk of chunks) {
			await bot
				.sendMessage(chatId, chunk, {
					parse_mode: "Markdown",
					disable_web_page_preview: true,
				})
				.catch(async () => {
					// Fallback: send without Markdown if parsing fails
					await bot.sendMessage(chatId, chunk);
				});
		}
	}

	override async sendAndGetId(chatId: string, text: string): Promise<SendResult> {
		const bot = this.bot;
		if (!bot) return { success: false, error: "Bot not connected" };

		try {
			const sent = await bot
				.sendMessage(chatId, text, {
					parse_mode: "Markdown",
					disable_web_page_preview: true,
				})
				.catch(async () => {
					// Fallback: send without Markdown
					return bot.sendMessage(chatId, text);
				});

			return {
				success: true,
				messageId: sent?.message_id ? String(sent.message_id) : null,
			};
		} catch (err) {
			return {
				success: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	override async editMessage(chatId: string, messageId: string, text: string): Promise<SendResult> {
		const bot = this.bot;
		if (!bot) return { success: false, error: "Bot not connected" };

		try {
			await bot
				.editMessageText(text, {
					chat_id: chatId,
					message_id: Number(messageId),
					parse_mode: "Markdown",
					disable_web_page_preview: true,
				})
				.catch(async () => {
					// Fallback: edit without Markdown
					await bot.editMessageText(text, {
						chat_id: chatId,
						message_id: Number(messageId),
					});
				});

			return { success: true, messageId };
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			return { success: false, error: errMsg };
		}
	}

	async sendTyping(chatId: string): Promise<void> {
		if (!this.bot) return;
		await this.bot.sendChatAction(chatId, "typing").catch(() => {});
	}

	// -----------------------------------------------------------------------
	// Private
	// -----------------------------------------------------------------------

	private async handleTelegramMessage(msg: TelegramMessage): Promise<void> {
		const bot = this.bot;
		if (!bot) return;

		const userId = String(msg.from?.id ?? "");
		const username = msg.from?.username ?? msg.from?.first_name ?? "unknown";

		// Check allowlist
		if (this.config.allowedUsers?.length) {
			if (!this.config.allowedUsers.includes(userId)) {
				logger.debug(`[telegram] Ignoring message from unauthorized user ${userId}`);
				return;
			}
		}

		// Extract images from photo messages
		const images: InboundMessage["images"] = [];
		if (msg.photo?.length) {
			// Telegram sends multiple sizes — pick the largest
			const largest = msg.photo[msg.photo.length - 1];
			try {
				const fileLink = await bot.getFileLink(largest.file_id);
				images.push({
					url: fileLink,
					mediaType: "image/jpeg",
					filename: `photo_${largest.file_id}.jpg`,
				});
			} catch (err) {
				logger.warn("[telegram] Failed to get photo file link", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		// Extract document images
		if (msg.document?.mime_type?.startsWith("image/")) {
			try {
				const fileLink = await bot.getFileLink(msg.document.file_id);
				images.push({
					url: fileLink,
					mediaType: msg.document.mime_type,
					filename: msg.document.file_name ?? `doc_${msg.document.file_id}`,
				});
			} catch (err) {
				logger.warn("[telegram] Failed to get document file link", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		// Use caption for photo messages, text for text messages
		const text = msg.text ?? msg.caption ?? "";

		// Skip messages with no text and no images
		if (!text && images.length === 0) return;

		const inbound: InboundMessage = {
			platform: "telegram",
			chatId: String(msg.chat.id),
			userId,
			username,
			text,
			images: images.length > 0 ? images : undefined,
			raw: msg,
		};

		await this.dispatchMessage(inbound);
	}
}
