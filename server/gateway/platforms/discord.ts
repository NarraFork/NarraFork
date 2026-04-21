/**
 * Discord platform adapter.
 *
 * Uses discord.js with Gateway Intents (WebSocket, no public URL required).
 * Supports message editing for progressive streaming.
 */

import { logger } from "../../lib/logger";
import { BaseAdapter } from "../base-adapter";
import type { DiscordConfig, GatewayPlatform, InboundMessage, SendResult } from "../types";

export class DiscordAdapter extends BaseAdapter {
	readonly platform: GatewayPlatform = "discord";
	readonly maxMessageLength = 2000;
	override readonly supportsEdit = true;

	private client: any = null;
	private config: DiscordConfig;

	constructor(config: DiscordConfig) {
		super();
		this.config = config;
	}

	async connect(): Promise<boolean> {
		try {
			const { Client, GatewayIntentBits } = await import("discord.js");

			this.client = new Client({
				intents: [
					GatewayIntentBits.Guilds,
					GatewayIntentBits.GuildMessages,
					GatewayIntentBits.DirectMessages,
					GatewayIntentBits.MessageContent,
				],
			});

			this.client.on("messageCreate", (msg: any) => this.handleDiscordMessage(msg));

			this.client.on("error", (err: any) => {
				logger.error("[discord] Client error", {
					error: err?.message ?? String(err),
				});
			});

			await this.client.login(this.config.token);

			logger.info(`[discord] Connected as ${this.client.user?.tag}`);
			this.connected = true;
			return true;
		} catch (err) {
			logger.error("[discord] Connection failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
	}

	async disconnect(): Promise<void> {
		this.cancelReconnect();
		if (this.client) {
			await this.client.destroy();
			this.client = null;
		}
		this.connected = false;
	}

	async send(chatId: string, text: string): Promise<void> {
		if (!this.client) return;

		const channel = await this.client.channels.fetch(chatId).catch(() => null);
		if (!channel?.isTextBased?.()) return;

		const chunks = this.splitMessage(text);
		for (const chunk of chunks) {
			await channel.send(chunk);
		}
	}

	override async sendAndGetId(chatId: string, text: string): Promise<SendResult> {
		if (!this.client) return { success: false, error: "Client not connected" };

		try {
			const channel = await this.client.channels.fetch(chatId).catch(() => null);
			if (!channel?.isTextBased?.()) {
				return { success: false, error: "Channel not found or not text-based" };
			}

			const sent = await channel.send(text);
			return {
				success: true,
				messageId: sent?.id ?? null,
			};
		} catch (err) {
			return {
				success: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	override async editMessage(chatId: string, messageId: string, text: string): Promise<SendResult> {
		if (!this.client) return { success: false, error: "Client not connected" };

		try {
			const channel = await this.client.channels.fetch(chatId).catch(() => null);
			if (!channel?.isTextBased?.()) {
				return { success: false, error: "Channel not found" };
			}

			const msg = await channel.messages.fetch(messageId).catch(() => null);
			if (!msg) {
				return { success: false, error: "Message not found" };
			}

			await msg.edit(text);
			return { success: true, messageId };
		} catch (err) {
			return {
				success: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	async sendTyping(chatId: string): Promise<void> {
		if (!this.client) return;
		const channel = await this.client.channels.fetch(chatId).catch(() => null);
		if (channel?.sendTyping) {
			await channel.sendTyping().catch(() => {});
		}
	}

	// -----------------------------------------------------------------------
	// Private
	// -----------------------------------------------------------------------

	private async handleDiscordMessage(msg: any): Promise<void> {
		// Ignore bot messages (including self)
		if (msg.author.bot) return;

		// Skip empty messages
		if (!msg.content) return;

		const userId = msg.author.id;
		const username = msg.author.username ?? "unknown";

		// Check allowlist
		if (this.config.allowedUsers?.length) {
			if (!this.config.allowedUsers.includes(userId)) {
				return;
			}
		}

		// In guild channels, require @mention
		if (msg.guild && this.client.user) {
			const mentioned = msg.mentions.has(this.client.user);
			if (!mentioned) return;
		}

		// Strip the bot mention from the message text
		let text = msg.content;
		if (this.client.user) {
			text = text.replace(new RegExp(`<@!?${this.client.user.id}>`, "g"), "").trim();
		}

		if (!text) return;

		const inbound: InboundMessage = {
			platform: "discord",
			chatId: msg.channel.id,
			userId,
			username,
			text,
			raw: msg,
		};

		await this.dispatchMessage(inbound);
	}
}
