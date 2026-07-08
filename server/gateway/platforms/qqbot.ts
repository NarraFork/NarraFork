/**
 * QQ Bot platform adapter using the Official QQ Bot API (v2).
 *
 * Connects via WebSocket Gateway for inbound events and uses the
 * REST API (api.sgroup.qq.com) for outbound messages and media uploads.
 *
 * Supports: C2C (private), group @-mentions, guild, direct messages,
 * image/voice/video/file attachments, voice STT, markdown, typing indicator.
 *
 * Reference: https://bot.q.qq.com/wiki/develop/api-v2/
 */

import WebSocket from "ws";
import { logger } from "../../lib/logger";
import { createProxyAgent, type ProxyAgentLike, resolveProxyForUrl } from "../../lib/net/proxy";
import { BaseAdapter } from "../base-adapter";
import type { GatewayPlatform, InboundMessage, QQBotConfig, SendResult } from "../types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE = "https://api.sgroup.qq.com";
const SANDBOX_API_BASE = "https://sandbox.api.sgroup.qq.com";
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const GATEWAY_URL_PATH = "/gateway";

const DEFAULT_API_TIMEOUT = 30_000;
const MAX_MESSAGE_LENGTH = 4000;
const DEDUP_WINDOW_MS = 300_000;
const DEDUP_MAX_SIZE = 1000;

const RECONNECT_BACKOFF = [2000, 5000, 10_000, 30_000, 60_000];
const MAX_RECONNECT_ATTEMPTS = 100;
const RATE_LIMIT_DELAY = 60_000;
const QUICK_DISCONNECT_THRESHOLD = 5000;
const MAX_QUICK_DISCONNECT_COUNT = 3;

const MSG_TYPE_TEXT = 0;
const MSG_TYPE_MARKDOWN = 2;
const MSG_TYPE_INPUT_NOTIFY = 6;
const MSG_TYPE_MEDIA = 7;

const MEDIA_TYPE_IMAGE = 1;
const MEDIA_TYPE_VIDEO = 2;
const MEDIA_TYPE_VOICE = 3;
const MEDIA_TYPE_FILE = 4;

// Intents: C2C_GROUP_AT_MESSAGES (1<<25) | PUBLIC_GUILD_MESSAGES (1<<30) | DIRECT_MESSAGE (1<<12)
const BOT_INTENTS = (1 << 25) | (1 << 30) | (1 << 12);

// ---------------------------------------------------------------------------
// QQBotAdapter
// ---------------------------------------------------------------------------

export class QQBotAdapter extends BaseAdapter {
	readonly platform: GatewayPlatform = "qqbot";
	readonly maxMessageLength = MAX_MESSAGE_LENGTH;
	override readonly supportsEdit = false;

	private config: QQBotConfig;
	private apiBase: string;

	// Auth
	private accessToken: string | null = null;
	private tokenExpiresAt = 0;
	private tokenRefreshPromise: Promise<string> | null = null;

	// WebSocket
	private ws: WebSocket | null = null;
	/** Proxy agent for the gateway WS; destroyed in cleanup() to avoid leaking on reconnect. */
	private wsAgent: ProxyAgentLike | null = null;
	private sessionId: string | null = null;
	private lastSeq: number | null = null;
	private heartbeatInterval = 30_000;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private listenActive = false;

	// Chat type routing
	private chatTypeMap = new Map<string, "c2c" | "group" | "guild" | "dm">();

	// Dedup
	private seenMessages = new Map<string, number>();

	// Typing debounce
	private lastMsgIdPerChat = new Map<string, string>();
	private typingSentAt = new Map<string, number>();
	private static readonly TYPING_DEBOUNCE = 50_000;

	// DM/group policies
	private dmPolicy: string;
	private groupPolicy: string;
	private allowedUsers: string[];
	private allowedGroups: string[];
	private markdownSupport: boolean;

	// STT config
	private sttConfig: { apiKey: string; baseUrl: string; model: string } | null;

	constructor(config: QQBotConfig) {
		super();
		this.config = config;
		this.apiBase = config.sandbox ? SANDBOX_API_BASE : API_BASE;
		this.dmPolicy = (config.dmPolicy ?? "open").toLowerCase();
		this.groupPolicy = (config.groupPolicy ?? "open").toLowerCase();
		this.allowedUsers = config.allowedUsers ?? [];
		this.allowedGroups = config.allowedGroups ?? [];
		this.markdownSupport = config.markdownSupport ?? false;
		this.sttConfig = config.stt
			? {
					apiKey: config.stt.apiKey,
					baseUrl: config.stt.baseUrl ?? "https://open.bigmodel.cn/api/coding/paas/v4",
					model: config.stt.model ?? "glm-asr",
				}
			: null;
	}

	// -----------------------------------------------------------------------
	// Connection lifecycle
	// -----------------------------------------------------------------------

	async connect(): Promise<boolean> {
		if (!this.config.appId || !this.config.clientSecret) {
			logger.error("[qqbot] QQ_APP_ID and QQ_CLIENT_SECRET are required");
			return false;
		}

		try {
			await this.ensureToken();
			const gatewayUrl = await this.getGatewayUrl();
			logger.info(`[qqbot] Gateway URL: ${gatewayUrl}`);
			await this.openWebSocket(gatewayUrl);
			this.connected = true;
			logger.info("[qqbot] Connected");
			return true;
		} catch (err) {
			logger.error("[qqbot] Connection failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			this.cleanup();
			return false;
		}
	}

	async disconnect(): Promise<void> {
		this.cancelReconnect();
		this.listenActive = false;
		this.cleanup();
		this.connected = false;
		logger.info("[qqbot] Disconnected");
	}

	private cleanup(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
		if (this.ws) {
			try {
				this.ws.close();
			} catch {
				/* ignore */
			}
			this.ws = null;
		}
		if (this.wsAgent) {
			try {
				this.wsAgent.destroy?.();
			} catch {
				/* ignore */
			}
			this.wsAgent = null;
		}
	}

	// -----------------------------------------------------------------------
	// Token management
	// -----------------------------------------------------------------------

	private async ensureToken(): Promise<string> {
		if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
			return this.accessToken;
		}

		// Singleflight: if a refresh is already in progress, await it
		if (this.tokenRefreshPromise) {
			return this.tokenRefreshPromise;
		}

		this.tokenRefreshPromise = this.refreshToken();
		try {
			return await this.tokenRefreshPromise;
		} finally {
			this.tokenRefreshPromise = null;
		}
	}

	private async refreshToken(): Promise<string> {
		const proxy = resolveProxyForUrl(TOKEN_URL);
		const resp = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				appId: this.config.appId,
				clientSecret: this.config.clientSecret,
			}),
			signal: AbortSignal.timeout(DEFAULT_API_TIMEOUT),
			...(proxy ? { proxy } : {}),
		});

		if (!resp.ok) {
			throw new Error(`Token request failed: ${resp.status} ${resp.statusText}`);
		}

		const data = (await resp.json()) as { access_token?: string; expires_in?: number };
		if (!data.access_token) {
			throw new Error(`Token response missing access_token: ${JSON.stringify(data)}`);
		}

		this.accessToken = data.access_token;
		this.tokenExpiresAt = Date.now() + (data.expires_in ?? 7200) * 1000;
		logger.info(`[qqbot] Access token refreshed, expires in ${data.expires_in ?? 7200}s`);
		return this.accessToken;
	}

	private async getGatewayUrl(): Promise<string> {
		const token = await this.ensureToken();
		const gwUrl = `${this.apiBase}${GATEWAY_URL_PATH}`;
		const proxy = resolveProxyForUrl(gwUrl);
		const resp = await fetch(gwUrl, {
			headers: {
				Authorization: `QQBot ${token}`,
				"User-Agent": "NarraFork-QQBot/1.0",
			},
			signal: AbortSignal.timeout(DEFAULT_API_TIMEOUT),
			...(proxy ? { proxy } : {}),
		});

		if (!resp.ok) {
			throw new Error(`Gateway URL request failed: ${resp.status}`);
		}

		const data = (await resp.json()) as { url?: string };
		if (!data.url) {
			throw new Error(`Gateway response missing url: ${JSON.stringify(data)}`);
		}
		return data.url;
	}

	// -----------------------------------------------------------------------
	// WebSocket lifecycle
	// -----------------------------------------------------------------------

	private async openWebSocket(gatewayUrl: string): Promise<void> {
		// Resolve/create the proxy agent BEFORE cleanup+connect so the socket-pool
		// reference lives on `this.wsAgent` and is destroyed on the next cleanup().
		const proxy = resolveProxyForUrl(gatewayUrl);
		const agent = await createProxyAgent(proxy);
		return new Promise<void>((resolve, reject) => {
			this.cleanup();
			this.listenActive = true;
			this.wsAgent = agent ?? null;

			const ws = new WebSocket(gatewayUrl, {
				headers: { "User-Agent": "NarraFork-QQBot/1.0" },
				handshakeTimeout: 20_000,
				// biome-ignore lint/suspicious/noExplicitAny: ws Agent type differs across proxy agents
				...(agent ? { agent: agent as any } : {}),
			});

			let resolved = false;

			ws.on("open", () => {
				logger.info("[qqbot] WebSocket connected");
				this.ws = ws;
			});

			ws.on("message", (raw: WebSocket.Data) => {
				try {
					const payload = JSON.parse(raw.toString()) as Record<string, unknown>;
					this.dispatchPayload(payload);

					// Resolve on first successful Hello (op 10)
					if (!resolved && payload.op === 10) {
						resolved = true;
						resolve();
					}
				} catch (err) {
					logger.warn("[qqbot] Failed to parse WS message", {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			});

			ws.on("close", (code: number, reason: Buffer) => {
				const reasonStr = reason.toString();
				logger.warn(`[qqbot] WebSocket closed: code=${code} reason=${reasonStr}`);
				this.connected = false;

				if (!resolved) {
					resolved = true;
					reject(new Error(`WebSocket closed during connect: code=${code}`));
					return;
				}

				if (this.listenActive) {
					this.handleDisconnect(code, reasonStr);
				}
			});

			ws.on("error", (err: Error) => {
				logger.error("[qqbot] WebSocket error", { error: err.message });
				if (!resolved) {
					resolved = true;
					reject(err);
				}
			});

			// Timeout for initial connection
			setTimeout(() => {
				if (!resolved) {
					resolved = true;
					ws.close();
					reject(new Error("WebSocket connection timeout"));
				}
			}, 20_000);
		});
	}

	private async handleDisconnect(code: number, _reason: string): Promise<void> {
		this.connected = false;

		// Fatal codes — stop reconnecting
		if (code === 4914 || code === 4915) {
			const desc = code === 4914 ? "offline/sandbox-only" : "banned";
			logger.error(`[qqbot] Bot is ${desc}. Check QQ Open Platform.`);
			return;
		}

		// Token invalid → clear cached token
		if (code === 4004) {
			this.accessToken = null;
			this.tokenExpiresAt = 0;
		}

		// Session invalid → clear session for re-identify
		if (code === 4006 || code === 4007 || code === 4009 || (code >= 4900 && code <= 4913)) {
			this.sessionId = null;
			this.lastSeq = null;
		}

		// Rate limited
		if (code === 4008) {
			logger.info(`[qqbot] Rate limited (4008), waiting ${RATE_LIMIT_DELAY / 1000}s`);
			await this.sleep(RATE_LIMIT_DELAY);
		}

		// Attempt reconnection with backoff
		let quickDisconnects = 0;
		for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS && this.listenActive; attempt++) {
			const delay = RECONNECT_BACKOFF[Math.min(attempt, RECONNECT_BACKOFF.length - 1)];
			logger.info(`[qqbot] Reconnecting in ${delay / 1000}s (attempt ${attempt + 1})`);
			await this.sleep(delay);

			if (!this.listenActive) return;

			const connectStart = Date.now();
			try {
				await this.ensureToken();
				const gatewayUrl = await this.getGatewayUrl();
				await this.openWebSocket(gatewayUrl);
				this.connected = true;
				logger.info("[qqbot] Reconnected successfully");
				return;
			} catch (err) {
				const duration = Date.now() - connectStart;
				if (duration < QUICK_DISCONNECT_THRESHOLD) {
					quickDisconnects++;
					if (quickDisconnects >= MAX_QUICK_DISCONNECT_COUNT) {
						logger.error("[qqbot] Too many quick disconnects — check bot permissions");
						return;
					}
				} else {
					quickDisconnects = 0;
				}
				logger.warn("[qqbot] Reconnect failed", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	// -----------------------------------------------------------------------
	// Heartbeat
	// -----------------------------------------------------------------------

	private startHeartbeat(): void {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		// Send at 80% of the server interval
		const interval = this.heartbeatInterval * 0.8;
		this.heartbeatTimer = setInterval(() => {
			if (this.ws?.readyState === WebSocket.OPEN) {
				try {
					this.ws.send(JSON.stringify({ op: 1, d: this.lastSeq }));
				} catch (err) {
					logger.debug("[qqbot] Heartbeat send failed", {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
		}, interval);
	}

	// -----------------------------------------------------------------------
	// Payload dispatch
	// -----------------------------------------------------------------------

	private dispatchPayload(payload: Record<string, unknown>): void {
		const op = payload.op as number | undefined;
		const t = payload.t as string | undefined;
		const s = payload.s as number | undefined;
		const d = payload.d as Record<string, unknown> | undefined;

		if (typeof s === "number" && (this.lastSeq === null || s > this.lastSeq)) {
			this.lastSeq = s;
		}

		// op 10 = Hello
		if (op === 10) {
			const intervalMs = (d?.heartbeat_interval as number) ?? 30_000;
			this.heartbeatInterval = intervalMs;
			this.startHeartbeat();

			if (this.sessionId && this.lastSeq !== null) {
				this.sendResume();
			} else {
				this.sendIdentify();
			}
			return;
		}

		// op 0 = Dispatch
		if (op === 0 && t) {
			if (t === "READY") {
				this.sessionId = (d?.session_id as string) ?? null;
				logger.info(`[qqbot] Ready, session_id=${this.sessionId}`);
			} else if (t === "RESUMED") {
				logger.info("[qqbot] Session resumed");
			} else if (
				t === "C2C_MESSAGE_CREATE" ||
				t === "GROUP_AT_MESSAGE_CREATE" ||
				t === "DIRECT_MESSAGE_CREATE" ||
				t === "GUILD_MESSAGE_CREATE" ||
				t === "GUILD_AT_MESSAGE_CREATE"
			) {
				this.onMessage_internal(t, d ?? {}).catch((err) => {
					logger.error("[qqbot] Message handler error", {
						error: err instanceof Error ? err.message : String(err),
					});
				});
			}
			return;
		}

		// op 11 = Heartbeat ACK — no action needed
	}

	private sendIdentify(): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
		const payload = {
			op: 2,
			d: {
				token: `QQBot ${this.accessToken}`,
				intents: BOT_INTENTS,
				shard: [0, 1],
				properties: {
					$os: "linux",
					$browser: "narrafork",
					$device: "narrafork",
				},
			},
		};
		this.ws.send(JSON.stringify(payload));
		logger.info("[qqbot] Identify sent");
	}

	private sendResume(): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
		const payload = {
			op: 6,
			d: {
				token: `QQBot ${this.accessToken}`,
				session_id: this.sessionId,
				seq: this.lastSeq,
			},
		};
		this.ws.send(JSON.stringify(payload));
		logger.info(`[qqbot] Resume sent (session=${this.sessionId}, seq=${this.lastSeq})`);
	}

	// -----------------------------------------------------------------------
	// Inbound message handling
	// -----------------------------------------------------------------------

	private async onMessage_internal(eventType: string, d: Record<string, unknown>): Promise<void> {
		const msgId = String(d.id ?? "");
		if (!msgId || this.isDuplicate(msgId)) return;

		const content = String(d.content ?? "").trim();
		const author = (typeof d.author === "object" && d.author !== null ? d.author : {}) as Record<
			string,
			unknown
		>;
		const attachments = Array.isArray(d.attachments) ? d.attachments : [];

		switch (eventType) {
			case "C2C_MESSAGE_CREATE":
				await this.handleC2CMessage(d, msgId, content, author, attachments);
				break;
			case "GROUP_AT_MESSAGE_CREATE":
				await this.handleGroupMessage(d, msgId, content, author, attachments);
				break;
			case "DIRECT_MESSAGE_CREATE":
				await this.handleDMMessage(d, msgId, content, author, attachments);
				break;
			case "GUILD_MESSAGE_CREATE":
			case "GUILD_AT_MESSAGE_CREATE":
				await this.handleGuildMessage(d, msgId, content, author, attachments);
				break;
		}
	}

	private async handleC2CMessage(
		d: Record<string, unknown>,
		msgId: string,
		content: string,
		author: Record<string, unknown>,
		attachments: unknown[],
	): Promise<void> {
		const userOpenId = String(author.user_openid ?? "");
		if (!userOpenId) return;
		if (!this.isDmAllowed(userOpenId)) return;

		const { text, images, files } = await this.processAttachments(content, attachments);
		if (!text.trim() && images.length === 0) return;

		this.chatTypeMap.set(userOpenId, "c2c");
		this.lastMsgIdPerChat.set(userOpenId, msgId);

		await this.dispatchMessage({
			platform: "qqbot",
			chatId: userOpenId,
			userId: userOpenId,
			username: String(author.user_openid ?? "QQ User"),
			text,
			images: images.length > 0 ? images : undefined,
			files: files.length > 0 ? files : undefined,
			raw: d,
		});
	}

	private async handleGroupMessage(
		d: Record<string, unknown>,
		msgId: string,
		content: string,
		author: Record<string, unknown>,
		attachments: unknown[],
	): Promise<void> {
		const groupOpenId = String(d.group_openid ?? "");
		if (!groupOpenId) return;
		if (!this.isGroupAllowed(groupOpenId)) return;

		// Strip @bot mention prefix
		const strippedContent = content.replace(/^@\S+\s*/, "").trim();
		const { text, images, files } = await this.processAttachments(strippedContent, attachments);
		if (!text.trim() && images.length === 0) return;

		this.chatTypeMap.set(groupOpenId, "group");
		this.lastMsgIdPerChat.set(groupOpenId, msgId);

		await this.dispatchMessage({
			platform: "qqbot",
			chatId: groupOpenId,
			userId: String(author.member_openid ?? ""),
			username: String(author.member_openid ?? "QQ Group User"),
			text,
			images: images.length > 0 ? images : undefined,
			files: files.length > 0 ? files : undefined,
			raw: d,
		});
	}

	private async handleDMMessage(
		d: Record<string, unknown>,
		msgId: string,
		content: string,
		author: Record<string, unknown>,
		attachments: unknown[],
	): Promise<void> {
		// DM messages use guild_id as the primary identifier
		const guildId = String(d.guild_id ?? "");
		if (!guildId) return;

		// Use channel_id for sending replies (DM channel within the guild)
		const channelId = String(d.channel_id ?? "");
		const chatId = channelId || guildId;

		const userId = String(author.id ?? "");
		if (!this.isDmAllowed(userId)) return;

		const { text, images, files } = await this.processAttachments(content, attachments);
		if (!text.trim() && images.length === 0) return;

		this.chatTypeMap.set(chatId, "dm");
		this.lastMsgIdPerChat.set(chatId, msgId);

		await this.dispatchMessage({
			platform: "qqbot",
			chatId,
			userId,
			username: String(author.username ?? "QQ DM User"),
			text,
			images: images.length > 0 ? images : undefined,
			files: files.length > 0 ? files : undefined,
			raw: d,
		});
	}

	private async handleGuildMessage(
		d: Record<string, unknown>,
		msgId: string,
		content: string,
		author: Record<string, unknown>,
		attachments: unknown[],
	): Promise<void> {
		const channelId = String(d.channel_id ?? "");
		if (!channelId) return;

		const userId = String(author.id ?? "");
		const member = (typeof d.member === "object" && d.member !== null ? d.member : {}) as Record<
			string,
			unknown
		>;
		const username = String(member.nick ?? "") || String(author.username ?? "") || "QQ Guild User";

		const { text, images, files } = await this.processAttachments(content, attachments);
		if (!text.trim() && images.length === 0) return;

		this.chatTypeMap.set(channelId, "guild");
		this.lastMsgIdPerChat.set(channelId, msgId);

		await this.dispatchMessage({
			platform: "qqbot",
			chatId: channelId,
			userId,
			username,
			text,
			images: images.length > 0 ? images : undefined,
			files: files.length > 0 ? files : undefined,
			raw: d,
		});
	}

	// -----------------------------------------------------------------------
	// Attachment processing
	// -----------------------------------------------------------------------

	private async processAttachments(
		text: string,
		attachments: unknown[],
	): Promise<{
		text: string;
		images: InboundMessage["images"] & object;
		files: InboundMessage["files"] & object;
	}> {
		const images: NonNullable<InboundMessage["images"]> = [];
		const files: NonNullable<InboundMessage["files"]> = [];
		let resultText = text;

		for (const raw of attachments) {
			if (!raw || typeof raw !== "object") continue;
			const att = raw as Record<string, unknown>;
			const contentType = String(att.content_type ?? "");
			const url = String(att.url ?? "");
			const filename = String(att.filename ?? "attachment");

			if (!url) continue;

			const fullUrl = url.startsWith("//") ? `https:${url}` : url;

			if (contentType.startsWith("image/")) {
				// Download image and convert to base64
				try {
					const imgData = await this.downloadMedia(fullUrl);
					if (imgData) {
						images.push({
							base64: Buffer.from(imgData).toString("base64"),
							mediaType: contentType || "image/jpeg",
							filename,
						});
					}
				} catch (err) {
					logger.warn("[qqbot] Failed to download image", {
						url: fullUrl.slice(0, 80),
						error: err instanceof Error ? err.message : String(err),
					});
					// Fallback: pass URL directly
					images.push({
						url: fullUrl,
						mediaType: contentType || "image/jpeg",
						filename,
					});
				}
			} else if (
				contentType.startsWith("audio/") ||
				filename.endsWith(".silk") ||
				filename.endsWith(".amr")
			) {
				// Voice message — try STT
				const transcript = await this.transcribeVoice(att, fullUrl, filename);
				if (transcript) {
					resultText = resultText
						? `${resultText}\n\n[语音转文字] ${transcript}`
						: `[语音转文字] ${transcript}`;
				}
			} else {
				// Generic file attachment
				try {
					const fileData = await this.downloadMedia(fullUrl);
					if (fileData) {
						files.push({
							data: Buffer.from(fileData),
							filename,
							mediaType: contentType || "application/octet-stream",
						});
					}
				} catch (err) {
					logger.warn("[qqbot] Failed to download file attachment", {
						filename,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
		}

		return { text: resultText, images, files };
	}

	private async downloadMedia(url: string): Promise<ArrayBuffer | null> {
		try {
			const token = await this.ensureToken();
			const proxy = resolveProxyForUrl(url);
			const resp = await fetch(url, {
				headers: {
					Authorization: `QQBot ${token}`,
					"User-Agent": "NarraFork-QQBot/1.0",
				},
				signal: AbortSignal.timeout(30_000),
				...(proxy ? { proxy } : {}),
			});
			if (!resp.ok) {
				logger.warn(`[qqbot] Media download failed: ${resp.status} for ${url.slice(0, 80)}`);
				return null;
			}
			return await resp.arrayBuffer();
		} catch (err) {
			logger.warn("[qqbot] Media download error", {
				error: err instanceof Error ? err.message : String(err),
			});
			return null;
		}
	}

	// -----------------------------------------------------------------------
	// Voice STT (speech-to-text)
	// -----------------------------------------------------------------------

	private async transcribeVoice(
		att: Record<string, unknown>,
		url: string,
		filename: string,
	): Promise<string | null> {
		// 1. QQ built-in ASR (free, always tried first)
		const asrText = att.asr_refer_text;
		if (typeof asrText === "string" && asrText.trim()) {
			logger.debug("[qqbot] Using QQ built-in ASR text");
			return asrText.trim();
		}

		// 2. External STT provider
		if (!this.sttConfig) return null;

		try {
			// Prefer voice_wav_url (pre-converted WAV from QQ)
			let downloadUrl = url;
			const voiceWavUrl = att.voice_wav_url;
			if (typeof voiceWavUrl === "string" && voiceWavUrl) {
				downloadUrl = voiceWavUrl.startsWith("//") ? `https:${voiceWavUrl}` : voiceWavUrl;
			}

			const audioData = await this.downloadMedia(downloadUrl);
			if (!audioData || audioData.byteLength < 10) return null;

			// Call OpenAI-compatible STT API
			const formData = new FormData();
			const blob = new Blob([audioData], { type: "audio/wav" });
			formData.append("file", blob, filename.replace(/\.\w+$/, ".wav"));
			formData.append("model", this.sttConfig.model);

			const sttUrl = `${this.sttConfig.baseUrl}/audio/transcriptions`;
			const proxy = resolveProxyForUrl(sttUrl);
			const resp = await fetch(sttUrl, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.sttConfig.apiKey}`,
				},
				body: formData,
				signal: AbortSignal.timeout(30_000),
				...(proxy ? { proxy } : {}),
			});

			if (!resp.ok) {
				logger.warn(`[qqbot] STT API failed: ${resp.status}`);
				return null;
			}

			const result = (await resp.json()) as Record<string, unknown>;

			// Zhipu/GLM format
			const choices = result.choices as Array<Record<string, unknown>> | undefined;
			if (choices?.[0]) {
				const msg = choices[0].message as Record<string, unknown> | undefined;
				const content = msg?.content;
				if (typeof content === "string" && content.trim()) return content.trim();
			}

			// OpenAI/Whisper format
			const text = result.text;
			if (typeof text === "string" && text.trim()) return text.trim();

			return null;
		} catch (err) {
			logger.warn("[qqbot] STT failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			return null;
		}
	}

	// -----------------------------------------------------------------------
	// Outbound messaging
	// -----------------------------------------------------------------------

	/** Wait for reconnection if disconnected. Returns true if connected. */
	private async waitForConnection(timeoutMs = 15_000): Promise<boolean> {
		if (this.connected) return true;

		logger.info(`[qqbot] Not connected — waiting for reconnection (up to ${timeoutMs / 1000}s)`);
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			await this.sleep(500);
			if (this.connected) {
				logger.info(`[qqbot] Reconnected after ${((Date.now() - start) / 1000).toFixed(1)}s`);
				return true;
			}
		}
		logger.warn("[qqbot] Still not connected after wait");
		return false;
	}

	async send(chatId: string, text: string): Promise<void> {
		if (!text.trim()) return;
		if (!this.connected && !(await this.waitForConnection())) return;

		const chunks = this.splitMessage(text);
		const replyTo = this.lastMsgIdPerChat.get(chatId);

		for (let i = 0; i < chunks.length; i++) {
			await this.sendChunkWithRetry(chatId, chunks[i], i === 0 ? replyTo : undefined);
		}
	}

	override async sendAndGetId(chatId: string, text: string): Promise<SendResult> {
		if (!text.trim()) return { success: true, messageId: null };
		if (!this.connected && !(await this.waitForConnection())) {
			return { success: false, error: "Not connected" };
		}

		try {
			const replyTo = this.lastMsgIdPerChat.get(chatId);
			const data = await this.sendChunkWithRetry(chatId, text, replyTo);
			const messageId = data?.id ? String(data.id) : null;
			return { success: true, messageId };
		} catch (err) {
			return {
				success: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	async sendTyping(chatId: string): Promise<void> {
		const chatType = this.chatTypeMap.get(chatId);
		if (chatType !== "c2c") return;

		const msgId = this.lastMsgIdPerChat.get(chatId);
		if (!msgId) return;

		// Debounce
		const now = Date.now();
		const lastSent = this.typingSentAt.get(chatId) ?? 0;
		if (now - lastSent < QQBotAdapter.TYPING_DEBOUNCE) return;

		try {
			const msgSeq = this.nextMsgSeq();
			await this.apiRequest("POST", `/v2/users/${chatId}/messages`, {
				msg_type: MSG_TYPE_INPUT_NOTIFY,
				msg_id: msgId,
				input_notify: { input_type: 1, input_second: 60 },
				msg_seq: msgSeq,
			});
			this.typingSentAt.set(chatId, now);
		} catch {
			// Non-fatal
		}
	}

	private async sendChunkWithRetry(
		chatId: string,
		content: string,
		replyTo?: string,
	): Promise<Record<string, unknown> | null> {
		const chatType = this.chatTypeMap.get(chatId) ?? "c2c";
		let lastErr: Error | null = null;

		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				return await this.sendToChat(chatType, chatId, content, replyTo);
			} catch (err) {
				lastErr = err instanceof Error ? err : new Error(String(err));
				const errMsg = lastErr.message.toLowerCase();

				// Permanent errors — don't retry
				if (
					errMsg.includes("invalid") ||
					errMsg.includes("forbidden") ||
					errMsg.includes("not found")
				) {
					break;
				}

				if (attempt < 2) {
					await this.sleep(1000 * 2 ** attempt);
				}
			}
		}

		if (lastErr) {
			logger.error(`[qqbot] Send failed to ${chatId}: ${lastErr.message}`);
		}
		return null;
	}

	private async sendToChat(
		chatType: string,
		chatId: string,
		content: string,
		replyTo?: string,
	): Promise<Record<string, unknown>> {
		const msgSeq = this.nextMsgSeq();
		const body = this.buildTextBody(content, msgSeq, replyTo);

		let path: string;
		switch (chatType) {
			case "c2c":
				path = `/v2/users/${chatId}/messages`;
				break;
			case "group":
				path = `/v2/groups/${chatId}/messages`;
				break;
			case "guild":
			case "dm":
				path = `/channels/${chatId}/messages`;
				// Guild/DM uses simpler body format
				return await this.apiRequest("POST", path, {
					content: content.slice(0, MAX_MESSAGE_LENGTH),
					...(replyTo ? { msg_id: replyTo } : {}),
				});
			default:
				path = `/v2/users/${chatId}/messages`;
		}

		return await this.apiRequest("POST", path, body);
	}

	private buildTextBody(
		content: string,
		msgSeq: number,
		replyTo?: string,
	): Record<string, unknown> {
		const truncated = content.slice(0, MAX_MESSAGE_LENGTH);

		if (this.markdownSupport) {
			const body: Record<string, unknown> = {
				markdown: { content: truncated },
				msg_type: MSG_TYPE_MARKDOWN,
				msg_seq: msgSeq,
			};
			if (replyTo) body.msg_id = replyTo;
			return body;
		}

		const body: Record<string, unknown> = {
			content: truncated,
			msg_type: MSG_TYPE_TEXT,
			msg_seq: msgSeq,
		};
		if (replyTo) {
			body.msg_id = replyTo;
			// message_reference only supported in non-markdown mode
			body.message_reference = { message_id: replyTo };
		}
		return body;
	}

	// -----------------------------------------------------------------------
	// Media upload & sending
	// -----------------------------------------------------------------------

	/**
	 * Upload media (image/voice/video/file) to QQ and send as a native message.
	 * Supports both URL and base64 file_data.
	 */
	async sendMedia(
		chatId: string,
		mediaSource: string,
		fileType: number,
		caption?: string,
		replyTo?: string,
	): Promise<SendResult> {
		const chatType = this.chatTypeMap.get(chatId) ?? "c2c";
		if (chatType === "guild" || chatType === "dm") {
			return { success: false, error: "Guild/DM media upload not supported via this path" };
		}

		try {
			// 1. Upload media
			const targetPath =
				chatType === "c2c" ? `/v2/users/${chatId}/files` : `/v2/groups/${chatId}/files`;

			const uploadBody: Record<string, unknown> = {
				file_type: fileType,
				srv_send_msg: false,
			};

			if (mediaSource.startsWith("http://") || mediaSource.startsWith("https://")) {
				uploadBody.url = mediaSource;
			} else {
				// Assume base64
				uploadBody.file_data = mediaSource;
			}

			let uploadResult: Record<string, unknown> | null = null;
			for (let attempt = 0; attempt < 3; attempt++) {
				try {
					uploadResult = await this.apiRequest("POST", targetPath, uploadBody);
					break;
				} catch (err) {
					if (attempt === 2) throw err;
					await this.sleep(1500 * (attempt + 1));
				}
			}

			const fileInfo = uploadResult?.file_info;
			if (!fileInfo) {
				return {
					success: false,
					error: `Upload returned no file_info: ${JSON.stringify(uploadResult)}`,
				};
			}

			// 2. Send media message
			const msgSeq = this.nextMsgSeq();
			const sendBody: Record<string, unknown> = {
				msg_type: MSG_TYPE_MEDIA,
				media: { file_info: fileInfo },
				msg_seq: msgSeq,
			};
			if (caption) sendBody.content = caption.slice(0, MAX_MESSAGE_LENGTH);
			if (replyTo) sendBody.msg_id = replyTo;

			const sendPath =
				chatType === "c2c" ? `/v2/users/${chatId}/messages` : `/v2/groups/${chatId}/messages`;

			const sendData = await this.apiRequest("POST", sendPath, sendBody);
			return {
				success: true,
				messageId: sendData.id ? String(sendData.id) : null,
			};
		} catch (err) {
			logger.error("[qqbot] Media send failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	/** Send an image by URL or base64. */
	async sendImage(chatId: string, imageSource: string, caption?: string): Promise<SendResult> {
		const replyTo = this.lastMsgIdPerChat.get(chatId);
		const result = await this.sendMedia(chatId, imageSource, MEDIA_TYPE_IMAGE, caption, replyTo);
		if (!result.success && imageSource.startsWith("http")) {
			// Fallback: send as text URL
			const fallback = caption ? `${caption}\n${imageSource}` : imageSource;
			await this.send(chatId, fallback);
			return { success: true, messageId: null };
		}
		return result;
	}

	/** Send a voice message. */
	async sendVoice(chatId: string, audioSource: string, caption?: string): Promise<SendResult> {
		return this.sendMedia(chatId, audioSource, MEDIA_TYPE_VOICE, caption);
	}

	/** Send a video. */
	async sendVideo(chatId: string, videoSource: string, caption?: string): Promise<SendResult> {
		return this.sendMedia(chatId, videoSource, MEDIA_TYPE_VIDEO, caption);
	}

	/** Send a file/document. */
	async sendDocument(chatId: string, fileSource: string, caption?: string): Promise<SendResult> {
		return this.sendMedia(chatId, fileSource, MEDIA_TYPE_FILE, caption);
	}

	// -----------------------------------------------------------------------
	// REST API helper
	// -----------------------------------------------------------------------

	private async apiRequest(
		method: string,
		path: string,
		body?: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const token = await this.ensureToken();
		const url = `${this.apiBase}${path}`;
		const proxy = resolveProxyForUrl(url);

		const resp = await fetch(url, {
			method,
			headers: {
				Authorization: `QQBot ${token}`,
				"Content-Type": "application/json",
				"User-Agent": "NarraFork-QQBot/1.0",
			},
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(DEFAULT_API_TIMEOUT),
			...(proxy ? { proxy } : {}),
		});

		const data = (await resp.json()) as Record<string, unknown>;
		if (resp.status >= 400) {
			throw new Error(
				`QQ Bot API error [${resp.status}] ${path}: ${data.message ?? JSON.stringify(data)}`,
			);
		}
		return data;
	}

	// -----------------------------------------------------------------------
	// Access control
	// -----------------------------------------------------------------------

	private isDmAllowed(userId: string): boolean {
		if (this.dmPolicy === "disabled") return false;
		if (this.dmPolicy === "allowlist") {
			return this.entryMatches(this.allowedUsers, userId);
		}
		// "open" — allow all
		return true;
	}

	private isGroupAllowed(groupId: string): boolean {
		if (this.groupPolicy === "disabled") return false;
		if (this.groupPolicy === "allowlist") {
			return this.entryMatches(this.allowedGroups, groupId);
		}
		// "open" — allow all
		return true;
	}

	private entryMatches(entries: string[], target: string): boolean {
		const normalized = target.trim().toLowerCase();
		return entries.some((e) => {
			const n = e.trim().toLowerCase();
			return n === "*" || n === normalized;
		});
	}

	// -----------------------------------------------------------------------
	// Dedup
	// -----------------------------------------------------------------------

	private isDuplicate(msgId: string): boolean {
		const now = Date.now();

		// Prune old entries — rebuild map to avoid iterating+deleting
		if (this.seenMessages.size > DEDUP_MAX_SIZE) {
			const cutoff = now - DEDUP_WINDOW_MS;
			const fresh = new Map<string, number>();
			for (const [key, ts] of this.seenMessages) {
				if (ts > cutoff) fresh.set(key, ts);
			}
			this.seenMessages = fresh;
		}

		if (this.seenMessages.has(msgId)) return true;
		this.seenMessages.set(msgId, now);
		return false;
	}

	// -----------------------------------------------------------------------
	// Utilities
	// -----------------------------------------------------------------------

	private nextMsgSeq(): number {
		// Time-based + random to avoid collisions (matches hermes approach)
		const timePart = Date.now() % 100_000_000;
		const rand = Math.floor(Math.random() * 0xffff);
		return (timePart ^ rand) % 65536;
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((r) => setTimeout(r, ms));
	}
}
