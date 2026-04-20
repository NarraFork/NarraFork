/**
 * Feishu (Lark) platform adapter.
 *
 * Uses @larksuiteoapi/node-sdk with WebSocket event subscription.
 */

import { logger } from "../../lib/logger";
import { BaseAdapter } from "../base-adapter";
import type { FeishuConfig, GatewayPlatform, InboundMessage } from "../types";

export class FeishuAdapter extends BaseAdapter {
	readonly platform: GatewayPlatform = "feishu";
	readonly maxMessageLength = 8000;

	private client: any = null;
	private wsClient: any = null;
	private config: FeishuConfig;
	private botOpenId: string | null = null;

	constructor(config: FeishuConfig) {
		super();
		this.config = config;
	}

	async connect(): Promise<boolean> {
		try {
			const lark = await import("@larksuiteoapi/node-sdk");

			this.client = new lark.Client({
				appId: this.config.appId,
				appSecret: this.config.appSecret,
				appType: lark.AppType.SelfBuild,
			});

			// Create WebSocket client for event subscription
			this.wsClient = new lark.WSClient({
				appId: this.config.appId,
				appSecret: this.config.appSecret,
				loggerLevel: lark.LoggerLevel.warn,
			});

			// Register message event handler
			const eventDispatcher = new lark.EventDispatcher({}).register({
				"im.message.receive_v1": (data: any) => {
					this.handleFeishuMessage(data).catch((err) => {
						logger.error("[feishu] Message handler error", {
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
			});

			await this.wsClient.start({ eventDispatcher });

			// Get bot identity
			try {
				const botInfo = await this.client.contact.user.get({
					path: { user_id: "me" },
					params: { user_id_type: "open_id" },
				});
				this.botOpenId = botInfo?.data?.user?.open_id ?? null;
			} catch {
				// Non-critical — just means we can't filter self-messages
			}

			logger.info("[feishu] Connected via WebSocket");
			this.connected = true;
			return true;
		} catch (err) {
			logger.error("[feishu] Connection failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
	}

	async disconnect(): Promise<void> {
		this.cancelReconnect();
		if (this.wsClient) {
			// The SDK doesn't expose a clean stop method; null it out
			this.wsClient = null;
		}
		this.client = null;
		this.connected = false;
	}

	async send(chatId: string, text: string): Promise<void> {
		if (!this.client) return;

		const chunks = this.splitMessage(text);
		for (const chunk of chunks) {
			await this.client.im.message.create({
				params: { receive_id_type: "chat_id" },
				data: {
					receive_id: chatId,
					msg_type: "text",
					content: JSON.stringify({ text: chunk }),
				},
			});
		}
	}

	async sendTyping(chatId: string): Promise<void> {
		// Feishu doesn't have a public typing indicator API
	}

	// -----------------------------------------------------------------------
	// Private
	// -----------------------------------------------------------------------

	private async handleFeishuMessage(data: any): Promise<void> {
		const message = data?.message;
		if (!message) return;

		// Skip non-text messages
		if (message.message_type !== "text") return;

		// Skip bot's own messages
		const senderId = message.sender?.sender_id?.open_id;
		if (senderId && senderId === this.botOpenId) return;

		// Parse text content
		let text = "";
		try {
			const content = JSON.parse(message.content ?? "{}");
			text = content.text ?? "";
		} catch {
			return;
		}

		if (!text.trim()) return;

		const userId = senderId ?? "";
		const username = message.sender?.sender_id?.union_id ?? senderId ?? "unknown";

		// Check allowlist
		if (this.config.allowedUsers?.length) {
			if (!this.config.allowedUsers.includes(userId)) {
				return;
			}
		}

		// Strip @mention
		text = text.replace(/@_all|@_user_\d+/g, "").trim();
		if (!text) return;

		const chatId = message.chat_id ?? "";

		const inbound: InboundMessage = {
			platform: "feishu",
			chatId,
			userId,
			username,
			text,
			raw: data,
		};

		await this.dispatchMessage(inbound);
	}
}
