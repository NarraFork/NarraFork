/**
 * Discord platform adapter.
 *
 * Uses discord.js with Gateway Intents (WebSocket, no public URL required).
 * Supports message editing for progressive streaming.
 */

import { logger } from "../../lib/logger";
import {
	closeUndiciDispatcher,
	createUndiciProxyDispatcher,
	getOutboundProxy,
	type UndiciDispatcherLike,
} from "../../lib/net/proxy";
import { BaseAdapter } from "../base-adapter";
import type { DiscordConfig, GatewayPlatform, InboundMessage, SendResult } from "../types";

interface DiscordUserLike {
	id: string;
	tag?: string;
	username?: string;
	bot?: boolean;
}

interface DiscordTextChannelLike {
	id?: string;
	isTextBased?: () => boolean;
	send: (text: string) => Promise<{ id?: string | null }>;
	sendTyping?: () => Promise<unknown>;
	messages: {
		fetch: (messageId: string) => Promise<{ edit: (text: string) => Promise<unknown> } | null>;
	};
}

interface DiscordClientLike {
	on(event: "messageCreate", listener: (msg: DiscordMessageLike) => void): void;
	on(event: "error", listener: (err: unknown) => void): void;
	login(token: string): Promise<unknown>;
	destroy(): Promise<unknown> | unknown;
	user?: DiscordUserLike | null;
	channels: {
		fetch: (chatId: string) => Promise<DiscordTextChannelLike | null>;
	};
}

interface DiscordMessageLike {
	author: DiscordUserLike;
	content?: string;
	guild?: unknown;
	mentions: { has: (user: DiscordUserLike) => boolean };
	channel: { id: string };
}

export class DiscordAdapter extends BaseAdapter {
	readonly platform: GatewayPlatform = "discord";
	readonly maxMessageLength = 2000;
	override readonly supportsEdit = true;

	private client: DiscordClientLike | null = null;
	/** undici ProxyAgent (dispatcher) for REST; closed on disconnect to avoid leaks. */
	private restAgent: UndiciDispatcherLike | null = null;
	private config: DiscordConfig;

	constructor(config: DiscordConfig) {
		super();
		this.config = config;
	}

	async connect(): Promise<boolean> {
		try {
			const { Client, GatewayIntentBits } = await import("discord.js");

			// Route Discord REST traffic through the global outbound proxy when
			// configured. discord.js REST `agent` expects an undici Dispatcher.
			// NOTE: this covers REST (sending/editing messages); the Gateway
			// WebSocket has no proxy entry point and is not routed through it.
			const proxy = getOutboundProxy();
			this.restAgent = (await createUndiciProxyDispatcher(proxy)) ?? null;
			if (proxy) {
				logger.warn(
					"[discord] Outbound proxy applies to REST only; the Gateway WebSocket is not proxied. In a locked-down network the bot may send but not receive events.",
				);
			}

			this.client = new Client({
				intents: [
					GatewayIntentBits.Guilds,
					GatewayIntentBits.GuildMessages,
					GatewayIntentBits.DirectMessages,
					GatewayIntentBits.MessageContent,
				],
				// biome-ignore lint/suspicious/noExplicitAny: rest.agent typed as undici Dispatcher
				...(this.restAgent ? { rest: { agent: this.restAgent as any } } : {}),
			}) as DiscordClientLike;

			this.client.on("messageCreate", (msg) => this.handleDiscordMessage(msg));

			this.client.on("error", (err) => {
				logger.error("[discord] Client error", {
					error: err instanceof Error ? err.message : String(err),
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
		await closeUndiciDispatcher(this.restAgent);
		this.restAgent = null;
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

	private async handleDiscordMessage(msg: DiscordMessageLike): Promise<void> {
		const client = this.client;
		if (!client) return;

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
		if (msg.guild && client.user) {
			const mentioned = msg.mentions.has(client.user);
			if (!mentioned) return;
		}

		// Strip the bot mention from the message text
		let text = msg.content;
		if (client.user) {
			text = text.replace(new RegExp(`<@!?${client.user.id}>`, "g"), "").trim();
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
