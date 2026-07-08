/**
 * Feishu (Lark) platform adapter.
 *
 * Uses @larksuiteoapi/node-sdk with WebSocket event subscription.
 * Supports message editing for progressive streaming via PATCH API.
 */

import { logger } from "../../lib/logger";
import { createProxyAgent, getOutboundProxy } from "../../lib/net/proxy";
import { BaseAdapter } from "../base-adapter";
import type { FeishuConfig, GatewayPlatform, InboundMessage, SendResult } from "../types";

interface FeishuClientLike {
	contact: {
		user: {
			get: (args: Record<string, unknown>) => Promise<{ data?: { user?: { open_id?: string } } }>;
		};
	};
	im: {
		message: {
			create: (args: Record<string, unknown>) => Promise<{ data?: { message_id?: string } }>;
			patch: (args: Record<string, unknown>) => Promise<unknown>;
		};
	};
}

interface FeishuWsClientLike {
	start: (args: { eventDispatcher: unknown }) => Promise<unknown>;
}

interface FeishuMessageData {
	message?: {
		message_type?: string;
		sender?: { sender_id?: { open_id?: string; union_id?: string } };
		content?: string;
		chat_id?: string;
	};
}

export class FeishuAdapter extends BaseAdapter {
	readonly platform: GatewayPlatform = "feishu";
	readonly maxMessageLength = 8000;
	override readonly supportsEdit = true;

	private client: FeishuClientLike | null = null;
	private wsClient: FeishuWsClientLike | null = null;
	private config: FeishuConfig;
	private botOpenId: string | null = null;

	constructor(config: FeishuConfig) {
		super();
		this.config = config;
	}

	async connect(): Promise<boolean> {
		try {
			const lark = await import("@larksuiteoapi/node-sdk");

			// Route Feishu REST traffic through the global outbound proxy when
			// configured. Reuse the SDK's own defaultHttpInstance (an axios
			// instance) so its request/response interceptors are preserved, and
			// only attach an https agent — passing a bare axios instance would drop
			// those interceptors and break response parsing.
			// NOTE: this covers REST; the event WSClient has no proxy entry point
			// and is not routed through the proxy.
			// `defaultHttpInstance` is a process-wide shared singleton. Always set the
			// agent fields explicitly (agent when proxied, undefined when not) so a
			// later reconnect after switching from custom/system to direct clears a
			// previously-attached agent instead of leaving it stale on the singleton.
			const proxy = getOutboundProxy();
			const agent = await createProxyAgent(proxy);
			if (proxy) {
				logger.warn(
					"[feishu] Outbound proxy applies to REST only; the event WSClient is not proxied. In a locked-down network the bot may send but not receive events.",
				);
			}
			// biome-ignore lint/suspicious/noExplicitAny: axios instance defaults are loosely typed here
			const inst = lark.defaultHttpInstance as any;
			inst.defaults.httpsAgent = agent;
			inst.defaults.httpAgent = agent;
			// Disable axios's own env-based proxy so the agent (or direct) is used exclusively.
			inst.defaults.proxy = false;
			const httpInstance: unknown = inst;

			this.client = new lark.Client({
				appId: this.config.appId,
				appSecret: this.config.appSecret,
				appType: lark.AppType.SelfBuild,
				// biome-ignore lint/suspicious/noExplicitAny: httpInstance typed as lark HttpInstance
				...(httpInstance ? { httpInstance: httpInstance as any } : {}),
			}) as unknown as FeishuClientLike;

			// Create WebSocket client for event subscription
			this.wsClient = new lark.WSClient({
				appId: this.config.appId,
				appSecret: this.config.appSecret,
				loggerLevel: lark.LoggerLevel.warn,
			}) as unknown as FeishuWsClientLike;

			// Register message event handler
			const eventDispatcher = new lark.EventDispatcher({}).register({
				"im.message.receive_v1": (data: FeishuMessageData) => {
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

	override async sendAndGetId(chatId: string, text: string): Promise<SendResult> {
		if (!this.client) return { success: false, error: "Client not connected" };

		try {
			const result = await this.client.im.message.create({
				params: { receive_id_type: "chat_id" },
				data: {
					receive_id: chatId,
					msg_type: "text",
					content: JSON.stringify({ text }),
				},
			});

			const messageId = result?.data?.message_id ?? null;
			return { success: true, messageId };
		} catch (err) {
			return {
				success: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	override async editMessage(
		_chatId: string,
		messageId: string,
		text: string,
	): Promise<SendResult> {
		if (!this.client) return { success: false, error: "Client not connected" };

		try {
			await this.client.im.message.patch({
				path: { message_id: messageId },
				data: {
					content: JSON.stringify({ text }),
				},
			});

			return { success: true, messageId };
		} catch (err) {
			return {
				success: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	async sendTyping(_chatId: string): Promise<void> {
		// Feishu doesn't have a public typing indicator API
	}

	// -----------------------------------------------------------------------
	// Private
	// -----------------------------------------------------------------------

	private async handleFeishuMessage(data: FeishuMessageData): Promise<void> {
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
