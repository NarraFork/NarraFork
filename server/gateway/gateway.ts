/**
 * IM Gateway core.
 *
 * Bridges IM platforms ↔ NarraFork narrators:
 *   - Inbound:  IM message → find/create narrator → sendMessage()
 *   - Outbound: eventBus narrator events → stream / send back to IM platform
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { and, desc, eq, inArray, isNotNull, like, ne } from "drizzle-orm";
import { db } from "../db";
import {
	chapters,
	gatewaySessionMappings,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	projects,
	userPreferences,
	users,
} from "../db/schema";
import { eventBus } from "../lib/event-bus";
import type { Locale } from "../lib/i18n";
import { getUserLanguage, t } from "../lib/i18n";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { resolveProxyForUrl } from "../lib/net/proxy";
import { resolveInitialRelaxedPlan } from "../lib/permission-modes";
import { FOLLOW_DEFAULT_MODEL, settings } from "../lib/settings";
import type { ImageRef } from "../lib/uploads";
import { sendMessage } from "../services/narrator-session";
import { pendingPermissions } from "../services/narrator-session-state";
import { RateLimiter } from "./base-adapter";
import { loadGatewayConfig } from "./config";
import { GatewayStreamConsumer } from "./stream-consumer";
import type {
	DiscordConfig,
	FeishuConfig,
	GatewayConfig,
	GatewayPlatform,
	InboundMessage,
	PlatformAdapter,
	PlatformConfigUnion,
	QQBotConfig,
	SlackConfig,
	TelegramConfig,
	WeixinConfig,
} from "./types";

// ---------------------------------------------------------------------------
// Gateway singleton
// ---------------------------------------------------------------------------

class Gateway {
	private config: GatewayConfig | null = null;
	private adapters = new Map<GatewayPlatform, PlatformAdapter>();
	private started = false;
	private rateLimiter: RateLimiter | null = null;
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;

	// Active stream consumers keyed by narratorId
	private streamConsumers = new Map<string, GatewayStreamConsumer>();

	// Narrators whose assistant messages were already delivered via message_broadcast
	// (non-streaming platforms). Cleared when deliverToIM runs or narrator goes idle.
	private deliveredNarrators = new Set<string>();

	// Cache: appUserId → { narratorIds in recentTabs, timestamp }
	// Avoids parsing JSON on every status change event.
	private recentTabsCache = new Map<string, { ids: Set<string>; ts: number }>();
	private static readonly RECENT_TABS_CACHE_TTL = 60_000; // 60 seconds

	// Cache: platform:chatId:userId → { locale, timestamp }
	private localeCache = new Map<string, { locale: Locale; ts: number }>();
	private static readonly LOCALE_CACHE_TTL = 60_000; // 60 seconds

	// Map: platform message ID → { permission request ID, timestamp }.
	// Used by platforms (e.g. QQ Bot) where quoted messages carry only the
	// original message ID, not the full text containing [perm:xxx].
	private permMessageIdMap = new Map<string, { requestId: string; ts: number }>();
	private static readonly PERM_MSG_MAP_TTL = 600_000; // 10 minutes

	// Cache: chatKey (platform:chatId:userId) → ordered narrator IDs from last /list or /search.
	// Allows /switch <number> to pick by index instead of typing the full ID.
	private listResultCache = new Map<string, { ids: string[]; ts: number }>();
	private static readonly LIST_RESULT_CACHE_TTL = 300_000; // 5 minutes

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	async start(): Promise<void> {
		if (this.started) return;

		this.config = await loadGatewayConfig();
		if (!this.config.enabled) {
			logger.info("[gateway] Gateway disabled by configuration");
			return;
		}

		const enabledPlatforms = this.config.platforms.filter((p) => p.enabled);
		if (enabledPlatforms.length === 0) {
			logger.info("[gateway] No platforms configured");
			return;
		}

		logger.info(`[gateway] Starting with ${enabledPlatforms.length} platform(s)`);

		// Initialize rate limiter
		const rateLimit = this.config.rateLimitPerMinute ?? 20;
		if (rateLimit > 0) {
			this.rateLimiter = new RateLimiter(rateLimit);
			// Periodic cleanup every 5 minutes
			this.cleanupTimer = setInterval(() => this.rateLimiter?.cleanup(), 300_000);
		}

		// Create and connect adapters
		for (const pConfig of enabledPlatforms) {
			try {
				const adapter = await this.createAdapter(pConfig);
				if (!adapter) continue;

				adapter.onMessage((msg) => this.handleInboundMessage(msg));

				const ok = await adapter.connect();
				if (ok) {
					this.adapters.set(pConfig.platform, adapter);
					logger.info(`[gateway] ${pConfig.platform} connected`);
				} else {
					logger.warn(`[gateway] ${pConfig.platform} failed to connect`);
				}
			} catch (err) {
				logger.error(`[gateway] ${pConfig.platform} init error`, {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		// Subscribe to narrator events for outbound delivery
		this.subscribeToEvents();

		this.started = true;
		logger.info(`[gateway] Started with ${this.adapters.size} active adapter(s)`);
	}

	async stop(): Promise<void> {
		if (!this.started) return;

		// Abort all active stream consumers
		for (const [, consumer] of this.streamConsumers) {
			consumer.abort();
		}
		this.streamConsumers.clear();

		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}

		for (const [platform, adapter] of this.adapters) {
			try {
				await adapter.disconnect();
				logger.info(`[gateway] ${platform} disconnected`);
			} catch (err) {
				logger.error(`[gateway] ${platform} disconnect error`, {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		this.adapters.clear();
		this.started = false;
		logger.info("[gateway] Stopped");
	}

	getStatus() {
		return {
			started: this.started,
			platforms: Array.from(this.adapters.keys()),
		};
	}

	getAdapter(platform: GatewayPlatform): PlatformAdapter | undefined {
		return this.adapters.get(platform);
	}

	/**
	 * Reload the gateway — optionally only the specified platforms.
	 * If `platforms` is empty/undefined, does a full stop → start cycle.
	 * Otherwise, only the listed platforms are disconnected and reconnected
	 * with the latest config (new platforms are added, removed ones are cleaned up).
	 */
	async reload(platforms?: GatewayPlatform[]): Promise<{ reloaded: GatewayPlatform[] }> {
		const newConfig = await loadGatewayConfig();

		// Full reload
		if (!platforms || platforms.length === 0) {
			await this.stop();
			// Reset started so start() can proceed
			this.config = null;
			await this.start();
			return { reloaded: Array.from(this.adapters.keys()) };
		}

		// Partial reload — only the specified platforms
		const reloaded: GatewayPlatform[] = [];

		for (const p of platforms) {
			// Disconnect existing adapter if any
			const existing = this.adapters.get(p);
			if (existing) {
				try {
					await existing.disconnect();
					logger.info(`[gateway] ${p} disconnected for reload`);
				} catch (err) {
					logger.error(`[gateway] ${p} disconnect error during reload`, {
						error: err instanceof Error ? err.message : String(err),
					});
				}
				this.adapters.delete(p);
			}

			// Find the new config for this platform
			const pConfig = newConfig.platforms.find((c) => c.platform === p);
			if (!pConfig?.enabled) {
				// Platform removed or disabled — already disconnected above
				reloaded.push(p);
				continue;
			}

			// Create and connect new adapter
			try {
				const adapter = await this.createAdapter(pConfig);
				if (adapter) {
					adapter.onMessage((msg) => this.handleInboundMessage(msg));
					const ok = await adapter.connect();
					if (ok) {
						this.adapters.set(p, adapter);
						logger.info(`[gateway] ${p} reconnected after reload`);
					} else {
						logger.warn(`[gateway] ${p} failed to reconnect after reload`);
					}
				}
			} catch (err) {
				logger.error(`[gateway] ${p} reload error`, {
					error: err instanceof Error ? err.message : String(err),
				});
			}
			reloaded.push(p);
		}

		// Update stored config
		this.config = newConfig;

		// If gateway wasn't started yet but now has enabled config, do a full start
		if (!this.started && newConfig.enabled) {
			await this.start();
			return { reloaded: Array.from(this.adapters.keys()) };
		}

		return { reloaded };
	}

	// -----------------------------------------------------------------------
	// Adapter factory
	// -----------------------------------------------------------------------

	private async createAdapter(config: PlatformConfigUnion): Promise<PlatformAdapter | null> {
		switch (config.platform) {
			case "telegram": {
				const { TelegramAdapter } = await import("./platforms/telegram");
				return new TelegramAdapter(config as TelegramConfig);
			}
			case "discord": {
				const { DiscordAdapter } = await import("./platforms/discord");
				return new DiscordAdapter(config as DiscordConfig);
			}
			case "slack": {
				const { SlackAdapter } = await import("./platforms/slack");
				return new SlackAdapter(config as SlackConfig);
			}
			case "feishu": {
				const { FeishuAdapter } = await import("./platforms/feishu");
				return new FeishuAdapter(config as FeishuConfig);
			}
			case "webhook": {
				// Webhook adapter is handled via HTTP routes, not a persistent connection
				return null;
			}
			case "weixin": {
				const { WeixinAdapter } = await import("./platforms/weixin");
				return new WeixinAdapter(config as WeixinConfig);
			}
			case "qqbot": {
				const { QQBotAdapter } = await import("./platforms/qqbot");
				return new QQBotAdapter(config as QQBotConfig);
			}
			default: {
				const unknownConfig = config as { platform?: unknown };
				logger.warn(`[gateway] Unknown platform: ${String(unknownConfig.platform)}`);
				return null;
			}
		}
	}

	// -----------------------------------------------------------------------
	// Inbound: IM → Narrator
	// -----------------------------------------------------------------------

	private async handleInboundMessage(msg: InboundMessage): Promise<void> {
		logger.info(`[gateway] Inbound from ${msg.platform}:${msg.chatId}`, {
			user: msg.username,
			textLen: msg.text.length,
		});

		// Rate limiting
		if (this.rateLimiter) {
			const key = `${msg.platform}:${msg.userId}`;
			if (!this.rateLimiter.allow(key)) {
				logger.warn(`[gateway] Rate limited: ${key}`);
				const adapter = this.adapters.get(msg.platform);
				if (adapter) {
					const locale = await this.resolveLocale(msg);
					await adapter.send(msg.chatId, t("gateway.rateLimited", locale)).catch(() => {});
				}
				return;
			}
		}

		// Handle chat commands
		const command = this.parseCommand(msg.text);
		if (command) {
			await this.handleCommand(command, msg);
			return;
		}

		// Handle permission approval/denial via quoted message
		if (await this.handlePermissionByQuote(msg)) {
			return;
		}

		await this.forwardToNarrator(msg);
	}

	/** Forward a message to the bound narrator (no command parsing). */
	private async forwardToNarrator(msg: InboundMessage): Promise<void> {
		// Find or create narrator for this IM session
		const mapping = await this.getOrCreateMapping(msg);

		// Send typing indicator
		const adapter = this.adapters.get(msg.platform);
		if (adapter) {
			adapter.sendTyping(msg.chatId).catch(() => {});
		}

		// If streaming is enabled and adapter supports editing, set up stream consumer
		const streamingEnabled = this.config?.streaming !== false;
		if (streamingEnabled && adapter?.supportsEdit) {
			this.setupStreamConsumer(mapping.narratorId, adapter, msg.chatId);
		}

		// Forward to narrator
		try {
			// Convert IM images to ImageRef (download URL → save to uploads)
			const imageRefs = await this.convertImages(mapping.narratorId, msg.images);

			// Convert IM files to File objects for textFiles parameter
			const textFiles = this.convertFiles(msg.files);

			await sendMessage(
				mapping.narratorId,
				msg.text,
				imageRefs.length > 0 ? imageRefs : undefined,
				/* locale */ undefined,
				/* replyInUserLanguage */ false,
				/* commandText */ undefined,
				/* userId */ undefined,
				textFiles.length > 0 ? textFiles : undefined,
			);
		} catch (err) {
			logger.error("[gateway] sendMessage failed", {
				narratorId: mapping.narratorId,
				error: err instanceof Error ? err.message : String(err),
			});
			// Clean up stream consumer on error
			this.cleanupStreamConsumer(mapping.narratorId);
			if (adapter) {
				const locale = await this.resolveLocale(msg);
				await adapter.send(
					msg.chatId,
					t("gateway.error", locale, {
						error: err instanceof Error ? err.message : "Unknown error",
					}),
				);
			}
		}
	}

	// -----------------------------------------------------------------------
	// Stream consumer management
	// -----------------------------------------------------------------------

	private setupStreamConsumer(narratorId: string, adapter: PlatformAdapter, chatId: string): void {
		// Clean up any existing consumer for this narrator
		this.cleanupStreamConsumer(narratorId);

		const consumer = new GatewayStreamConsumer(adapter, chatId, {
			editInterval: 1.0,
			bufferThreshold: 40,
			cursor: " ▉",
		});

		this.streamConsumers.set(narratorId, consumer);

		// Start the consumer's flush loop
		consumer.start().catch((err) => {
			logger.error("[gateway] Stream consumer error", {
				narratorId,
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}

	private cleanupStreamConsumer(narratorId: string): void {
		const existing = this.streamConsumers.get(narratorId);
		if (existing) {
			existing.abort();
			this.streamConsumers.delete(narratorId);
		}
	}

	// -----------------------------------------------------------------------
	// Session mapping
	// -----------------------------------------------------------------------

	private async getOrCreateMapping(msg: InboundMessage) {
		const now = new Date().toISOString();

		// Look up existing mapping
		const existing = await db.query.gatewaySessionMappings.findFirst({
			where: and(
				eq(gatewaySessionMappings.platform, msg.platform),
				eq(gatewaySessionMappings.chatId, msg.chatId),
				eq(gatewaySessionMappings.userId, msg.userId),
			),
		});

		if (existing) {
			// Check session idle timeout
			const idleMinutes = this.config?.sessionIdleMinutes ?? 0;
			if (idleMinutes > 0 && existing.lastMessageAt) {
				const lastMsg = new Date(existing.lastMessageAt).getTime();
				const elapsed = (Date.now() - lastMsg) / 60_000;
				if (elapsed > idleMinutes) {
					logger.info(`[gateway] Session idle for ${Math.round(elapsed)}min, auto-resetting`);
					// Delete old mapping — next call will create a fresh one
					await db.delete(gatewaySessionMappings).where(eq(gatewaySessionMappings.id, existing.id));

					const adapter = this.adapters.get(msg.platform);
					if (adapter) {
						const locale = await this.resolveLocaleForAppUser(existing.appUserId);
						await adapter.send(msg.chatId, t("gateway.sessionExpired", locale)).catch(() => {});
					}

					return this.createNewMapping(msg, now);
				}
			}

			// Update last message time
			await db
				.update(gatewaySessionMappings)
				.set({ lastMessageAt: now, updatedAt: now })
				.where(eq(gatewaySessionMappings.id, existing.id));
			return existing;
		}

		return this.createNewMapping(msg, now);
	}

	// -----------------------------------------------------------------------
	// Image conversion: IM attachments → ImageRef (saved to uploads dir)
	// -----------------------------------------------------------------------

	private async convertImages(
		narratorId: string,
		images?: InboundMessage["images"],
	): Promise<ImageRef[]> {
		if (!images || images.length === 0) return [];

		const { saveUploadedImage } = await import("../lib/uploads");
		const refs: ImageRef[] = [];

		for (const img of images) {
			try {
				let buffer: ArrayBuffer;

				if (img.base64) {
					buffer = Buffer.from(img.base64, "base64").buffer as ArrayBuffer;
				} else if (img.url) {
					// Local file path (e.g. from weixin temp dir) or remote URL
					if (img.url.startsWith("/") || img.url.startsWith("~")) {
						if (!existsSync(img.url)) {
							logger.warn("[gateway] Local image file not found", { path: img.url });
							continue;
						}
						const fileData = readFileSync(img.url);
						buffer = fileData.buffer.slice(
							fileData.byteOffset,
							fileData.byteOffset + fileData.byteLength,
						) as ArrayBuffer;
						// Clean up temp file after reading
						try {
							unlinkSync(img.url);
						} catch {
							/* non-fatal */
						}
					} else {
						// Downloading user-referenced remote content (not a platform API
						// call); follows the global outbound proxy policy.
						const imgProxy = resolveProxyForUrl(img.url);
						const resp = await fetch(img.url, imgProxy ? { proxy: imgProxy } : undefined);
						if (!resp.ok) {
							logger.warn("[gateway] Failed to download image", {
								url: img.url,
								status: resp.status,
							});
							continue;
						}
						buffer = await resp.arrayBuffer();
					}
				} else {
					continue;
				}

				const file = new File([buffer], img.filename || "image.jpg", {
					type: img.mediaType || "image/jpeg",
				});

				const ref = await saveUploadedImage(narratorId, file);
				refs.push(ref);
			} catch (err) {
				logger.warn("[gateway] Image conversion failed", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		return refs;
	}

	/** Convert inbound file attachments to File objects for the narrator textFiles parameter. */
	private convertFiles(files?: InboundMessage["files"]): File[] {
		if (!files || files.length === 0) return [];
		return files
			.map((f) => {
				try {
					const ab = f.data.buffer.slice(
						f.data.byteOffset,
						f.data.byteOffset + f.data.byteLength,
					) as ArrayBuffer;
					return new File([ab], f.filename, { type: f.mediaType });
				} catch (err) {
					logger.warn("[gateway] File conversion failed", {
						filename: f.filename,
						error: err instanceof Error ? err.message : String(err),
					});
					return null;
				}
			})
			.filter((f): f is File => f !== null);
	}

	// -----------------------------------------------------------------------
	// New mapping creation
	// -----------------------------------------------------------------------

	private async createNewMapping(msg: InboundMessage, now: string) {
		const narratorId = generateId();
		const mappingId = generateId();

		// Resolve project/chapter binding
		const projectId = this.config?.defaultProjectId ?? null;
		const chapterId = this.config?.defaultChapterId ?? null;

		// Validate project exists if specified
		if (projectId) {
			const project = await db.query.projects.findFirst({
				where: eq(projects.id, projectId),
				columns: { id: true },
			});
			if (!project) {
				logger.warn(`[gateway] Default project ${projectId} not found, creating unbound narrator`);
			}
		}

		// Auto-resolve NarraFork user: for private deployments, pick the first
		// (or only) user so recentTabs and notifications work out of the box.
		const appUserId = await this.resolveAppUserId();

		// Create narrator
		const gwPermMode = this.config?.defaultPermissionMode ?? "default";
		await db.insert(narrators).values({
			id: narratorId,
			chapterId: chapterId,
			type: "primary",
			title: `IM: ${msg.username} (${msg.platform})`,
			status: "idle",
			model: FOLLOW_DEFAULT_MODEL,
			permissionMode: gwPermMode,
			messageCount: 0,
			totalCostUsd: 0,
			pruneEnabled: settings.agent.defaultPruneEnabled,
			fastMode: false,
			// 全部允许时强制宽松，忽略用户默认设置，避免无人值守 IM 被计划模式卡住。
			relaxedPlan: resolveInitialRelaxedPlan({
				permissionMode: gwPermMode,
				defaultRelaxedPlan: settings.agent.defaultRelaxedPlan,
			}),
			planMode: false,
			isBackground: false,
			isAskInPassing: false,
			variant: "primary",
			traits: chapterId ? [] : ["standalone"],
			messageVersion: 0,
			createdAt: now,
			updatedAt: now,
		});

		// Create mapping
		await db.insert(gatewaySessionMappings).values({
			id: mappingId,
			platform: msg.platform,
			chatId: msg.chatId,
			userId: msg.userId,
			username: msg.username,
			narratorId,
			appUserId,
			projectId,
			chapterId,
			lastMessageAt: now,
			createdAt: now,
			updatedAt: now,
		});

		logger.info(`[gateway] Created narrator ${narratorId} for ${msg.platform}:${msg.chatId}`);

		return {
			id: mappingId,
			narratorId,
			appUserId,
			platform: msg.platform,
			chatId: msg.chatId,
		};
	}

	/** Resolve the NarraFork user ID for an IM session.
	 *  For single-user deployments, returns the only user.
	 *  For multi-user, returns the first admin (ordered by creation time). */
	private async resolveAppUserId(): Promise<string | null> {
		const allUsers = await db
			.select({ id: users.id, role: users.role })
			.from(users)
			.orderBy(users.createdAt)
			.limit(5);
		if (allUsers.length === 0) return null;
		if (allUsers.length === 1) return allUsers[0].id;
		// Multi-user: prefer admin
		const admin = allUsers.find((u) => u.role === "admin");
		return admin?.id ?? allUsers[0].id;
	}

	// -----------------------------------------------------------------------
	// Outbound: Narrator events → IM
	// -----------------------------------------------------------------------

	/** Format tool input into a short summary for IM display. */
	private formatToolSummary(toolName: string, input: unknown): string {
		const inp = input as Record<string, unknown> | null;
		if (!inp) return "";
		let summary = "";
		switch (toolName) {
			case "Bash":
				summary = typeof inp.command === "string" ? inp.command : "";
				break;
			case "Read":
			case "Write":
			case "Edit":
				summary = typeof inp.file_path === "string" ? inp.file_path : "";
				break;
			case "Glob":
				summary = typeof inp.pattern === "string" ? inp.pattern : "";
				break;
			case "Grep":
				summary = typeof inp.pattern === "string" ? inp.pattern : "";
				break;
			case "WebSearch":
				summary = typeof inp.query === "string" ? inp.query : "";
				break;
			case "Agent":
				summary = typeof inp.description === "string" ? inp.description : "";
				break;
			default:
				summary = JSON.stringify(inp).slice(0, 120);
				break;
		}
		if (summary.length > 200) summary = `${summary.slice(0, 197)}…`;
		return summary;
	}

	/** Find the first pending permission request for a narrator. */
	private findPendingPermissionForNarrator(
		narratorId: string,
	): { requestId: string; toolName: string; input: Record<string, unknown> } | null {
		for (const [requestId, pending] of pendingPermissions) {
			if (pending.narratorId === narratorId) {
				return { requestId, toolName: pending.toolName, input: pending.input };
			}
		}
		return null;
	}

	// -----------------------------------------------------------------------
	// Permission message ID tracking (for platforms without text in quotes)
	// -----------------------------------------------------------------------

	private trackPermMessageId(platformMsgId: string, requestId: string): void {
		this.permMessageIdMap.set(platformMsgId, { requestId, ts: Date.now() });

		// Prune expired entries
		if (this.permMessageIdMap.size > 200) {
			const cutoff = Date.now() - Gateway.PERM_MSG_MAP_TTL;
			for (const [id, entry] of this.permMessageIdMap) {
				if (entry.ts < cutoff) {
					this.permMessageIdMap.delete(id);
				}
			}
		}
	}

	// -----------------------------------------------------------------------
	// Permission approval via quoted message
	// -----------------------------------------------------------------------

	private static readonly PERM_TAG_RE = /\[perm:([a-zA-Z0-9_-]+)\]/;
	private static readonly APPROVE_KEYWORDS = new Set([
		"y",
		"yes",
		"ok",
		"approve",
		"allow",
		"同意",
		"允许",
		"批准",
		"通过",
		"是",
		"好",
		"行",
		"可以",
	]);
	private static readonly DENY_KEYWORDS = new Set([
		"n",
		"no",
		"deny",
		"reject",
		"refuse",
		"拒绝",
		"不行",
		"不可以",
		"否",
		"不",
	]);

	/**
	 * Extract a permission requestId from the quoted (ref_msg) text in the raw message.
	 * Supports:
	 *   - WeChat: item_list[].ref_msg containing [perm:xxx] in text fields
	 *   - QQ Bot: message_reference.message_id mapped via permMessageIdMap
	 *   - Generic: [perm:xxx] tag in msg.text itself (fallback)
	 * Returns the requestId if found, null otherwise.
	 */
	private extractRefPermissionId(msg: InboundMessage): string | null {
		if (!msg.raw || typeof msg.raw !== "object") return null;
		const raw = msg.raw as Record<string, unknown>;

		// --- QQ Bot: message_reference.message_id lookup ---
		const msgRef = raw.message_reference as Record<string, unknown> | undefined;
		if (msgRef) {
			const refMsgId = typeof msgRef.message_id === "string" ? msgRef.message_id : null;
			if (refMsgId) {
				const entry = this.permMessageIdMap.get(refMsgId);
				if (entry) return entry.requestId;
			}
		}

		// --- WeChat: item_list[].ref_msg text parsing ---
		const itemList = (raw.item_list as unknown[]) ?? [];
		for (const item of itemList) {
			if (!item || typeof item !== "object") continue;
			const it = item as Record<string, unknown>;
			const refMsg = it.ref_msg as Record<string, unknown> | undefined;
			if (!refMsg) continue;

			// Collect all text from ref_msg to search for the perm tag
			const candidates: string[] = [];

			// ref_msg.title — summary of the quoted message
			if (refMsg.title) candidates.push(String(refMsg.title));

			// ref_msg.message_item.text_item.text — full text of quoted message
			const refItem = refMsg.message_item as Record<string, unknown> | undefined;
			if (refItem?.type === 1) {
				const textItem = refItem.text_item as Record<string, unknown> | undefined;
				if (textItem?.text) candidates.push(String(textItem.text));
			}

			// ref_msg.desc / ref_msg.content — some platforms put text here
			if (refMsg.desc) candidates.push(String(refMsg.desc));
			if (refMsg.content) candidates.push(String(refMsg.content));

			// Search all candidates
			for (const text of candidates) {
				const match = Gateway.PERM_TAG_RE.exec(text);
				if (match) return match[1];
			}

			// Fallback: stringify the entire ref_msg and search
			try {
				const refStr = JSON.stringify(refMsg);
				const match = Gateway.PERM_TAG_RE.exec(refStr);
				if (match) return match[1];
			} catch {
				/* ignore */
			}
		}
		return null;
	}

	/**
	 * If the user quoted a permission request message, handle approve/deny.
	 * Returns true if handled, false if not a permission quote.
	 */
	private async handlePermissionByQuote(msg: InboundMessage): Promise<boolean> {
		const requestId = this.extractRefPermissionId(msg);
		if (!requestId) return false;

		// Check if this permission is still pending
		const pending = pendingPermissions.get(requestId);
		if (!pending) return false;

		const adapter = this.adapters.get(msg.platform);
		if (!adapter) return false;
		const locale = await this.resolveLocale(msg);

		// Extract the user's own reply text (without the [引用: ...] prefix)
		const replyText = this.extractPureReplyText(msg).toLowerCase();
		const isApprove = Gateway.APPROVE_KEYWORDS.has(replyText);
		const isDeny = Gateway.DENY_KEYWORDS.has(replyText);

		// If the reply doesn't match any known keyword, don't intercept —
		// let the message flow through to the narrator as normal input.
		if (!isApprove && !isDeny) return false;

		const { resolvePermission } = await import("../services/narrator-permission");
		if (isApprove) {
			await resolvePermission(requestId, "allow");
			await adapter.send(msg.chatId, t("gateway.permissionApproved", locale));
		} else {
			await resolvePermission(requestId, "deny", {
				denyMessage: replyText || undefined,
			});
			await adapter.send(msg.chatId, t("gateway.permissionDenied", locale));
		}
		return true;
	}

	/**
	 * Extract the user's own text from a reply message, ignoring the quoted part.
	 * Falls back to msg.text if raw parsing fails.
	 */
	private extractPureReplyText(msg: InboundMessage): string {
		if (msg.raw && typeof msg.raw === "object") {
			const raw = msg.raw as Record<string, unknown>;
			const itemList = (raw.item_list as unknown[]) ?? [];
			for (const item of itemList) {
				if (!item || typeof item !== "object") continue;
				const it = item as Record<string, unknown>;
				if (it.type === 1 && it.ref_msg) {
					// This is a text item with a quote — extract just the user's text
					const textItem = it.text_item as Record<string, unknown> | undefined;
					return String(textItem?.text ?? "").trim();
				}
			}
		}
		return msg.text.trim();
	}

	private subscribeToEvents(): void {
		// Listen for narrator status changes — deliver the final assistant
		// message only when the narrator becomes idle (turn complete).
		eventBus.on("narrator:status_changed", async (event) => {
			// Handle the directly-bound narrator (deliver response on idle)
			if (event.status === "idle") {
				const consumer = this.streamConsumers.get(event.narratorId);
				if (consumer) {
					await consumer.finish();
					this.streamConsumers.delete(event.narratorId);
					if (consumer.finalResponseSent) {
						// Still notify about other narrators below
					} else {
						await this.deliverToIM(event.narratorId);
					}
				} else {
					await this.deliverToIM(event.narratorId);
				}
			}
		});

		// Notify IM users whose recentTabs contain this narrator (but it's NOT
		// their currently-bound narrator). Driven by the semantic attention intent
		// rather than re-derived from status/substatus, so reflection mid-states
		// and takeover fallbacks never trigger a spurious IM ping.
		eventBus.on("narrator:attention", async (event) => {
			await this.notifyRecentTabStatusChange(event.narratorId, event.reason);
		});

		// Listen for all narrator broadcasts — tool calls, permission requests, stream deltas
		eventBus.on("narrator:message_broadcast", async (event) => {
			const msg = event.message;

			// --- Stream consumer: text deltas ---
			const consumer = this.streamConsumers.get(event.narratorId);
			if (consumer) {
				if (msg.type === "stream_event") {
					const streamEvent = msg.event;
					if (
						streamEvent &&
						typeof streamEvent === "object" &&
						(streamEvent as Record<string, unknown>).type === "content_block_delta"
					) {
						const delta = (streamEvent as Record<string, unknown>).delta;
						if (
							delta &&
							typeof delta === "object" &&
							(delta as Record<string, unknown>).type === "text_delta"
						) {
							const text = (delta as Record<string, unknown>).text;
							if (typeof text === "string") {
								consumer.onDelta(text);
							}
						}
					}
				} else if (msg.type === "tool_started") {
					// Tool boundary — finalize current message segment
					consumer.onSegmentBreak();
				}
			}

			// --- Tool call notifications to IM ---
			if (
				msg.type === "tool_started" ||
				msg.type === "tool_completed" ||
				msg.type === "permission_request"
			) {
				const mapping = await this.findMappingByNarrator(event.narratorId);
				if (!mapping) return;
				const adapter = this.adapters.get(mapping.platform as GatewayPlatform);
				if (!adapter) return;
				const locale = await this.resolveLocaleForAppUser(mapping.appUserId);

				if (msg.type === "tool_started") {
					const summary = this.formatToolSummary(msg.toolName, msg.input);
					await adapter
						.send(
							mapping.chatId,
							t("gateway.toolStarted", locale, {
								toolName: msg.toolName,
								summary,
							}),
						)
						.catch(() => {});
				} else if (msg.type === "tool_completed") {
					const duration = msg.durationMs != null ? `${(msg.durationMs / 1000).toFixed(1)}s` : "?";
					const toolName = msg.toolName ?? msg.toolUseId.slice(0, 8);
					if (msg.status === "fail" || msg.status === "error") {
						const error =
							typeof msg.output === "string" ? msg.output.slice(0, 100) : "execution failed";
						await adapter
							.send(mapping.chatId, t("gateway.toolFailed", locale, { toolName, error }))
							.catch(() => {});
					} else {
						await adapter
							.send(mapping.chatId, t("gateway.toolCompleted", locale, { toolName, duration }))
							.catch(() => {});
					}
				} else if (msg.type === "permission_request") {
					const req = msg.request as Record<string, unknown>;
					if (req.suppressNotifications === true) return;
					const requestId = typeof req.id === "string" ? req.id : "";
					const toolName = typeof req.toolName === "string" ? req.toolName : "unknown";
					const inputJson = req.inputJson as Record<string, unknown> | undefined;
					const summary = this.formatToolSummary(toolName, inputJson);
					const text = `${t("gateway.permissionRequest", locale, {
						toolName,
						summary,
					})}\n[perm:${requestId}]`;
					// Use sendAndGetId to track the message ID for quote-reply approval
					const result = await adapter.sendAndGetId(mapping.chatId, text).catch(() => null);
					if (result?.messageId && requestId) {
						this.trackPermMessageId(result.messageId, requestId);
					}
				}
			}

			// --- Assistant message delivery for non-streaming platforms ---
			// When there's no stream consumer (platform doesn't support editing),
			// deliver each assistant message as it's saved, so mid-turn text
			// (before tool calls) isn't lost.
			if (msg.type === "message" && !this.streamConsumers.has(event.narratorId)) {
				const payload = msg.message as Record<string, unknown> | undefined;
				if (payload?.role === "assistant") {
					const contentText = typeof payload.contentText === "string" ? payload.contentText : "";
					if (contentText.trim()) {
						const mapping = await this.findMappingByNarrator(event.narratorId);
						if (mapping) {
							const adapter = this.adapters.get(mapping.platform as GatewayPlatform);
							if (adapter) {
								// Track that we already delivered this turn's messages
								this.deliveredNarrators.add(event.narratorId);
								await adapter.send(mapping.chatId, contentText).catch(() => {});
							}
						}
					}
				}
			}
		});

		// Listen for errors
		eventBus.on("narrator:error", async (event) => {
			// Clean up stream consumer
			this.cleanupStreamConsumer(event.narratorId);

			const mapping = await this.findMappingByNarrator(event.narratorId);
			if (!mapping) return;

			const adapter = this.adapters.get(mapping.platform as GatewayPlatform);
			if (!adapter) return;

			const locale = await this.resolveLocaleForAppUser(mapping.appUserId);
			await adapter.send(mapping.chatId, t("gateway.error", locale, { error: event.error }));

			// Clean up deliveredNarrators to prevent leaks when narrator never reaches idle
			this.deliveredNarrators.delete(event.narratorId);
		});
	}

	private async deliverToIM(narratorId: string): Promise<void> {
		// If messages were already delivered via message_broadcast (non-streaming),
		// skip the final delivery to avoid duplicates.
		if (this.deliveredNarrators.delete(narratorId)) return;

		const mapping = await this.findMappingByNarrator(narratorId);
		if (!mapping) return; // Not an IM-bound narrator

		const adapter = this.adapters.get(mapping.platform as GatewayPlatform);
		if (!adapter) return;

		// Get the latest assistant message from DB via message refs
		const latestRef = await db
			.select({ messageId: narratorMessageRefs.messageId })
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.narratorId, narratorId))
			.orderBy(desc(narratorMessageRefs.seq))
			.limit(1)
			.get();

		if (!latestRef) return;

		const msg = await db
			.select({
				contentText: narratorMessages.contentText,
				role: narratorMessages.role,
			})
			.from(narratorMessages)
			.where(
				and(eq(narratorMessages.id, latestRef.messageId), eq(narratorMessages.role, "assistant")),
			)
			.get();

		if (!msg?.contentText) return;

		try {
			await adapter.send(mapping.chatId, msg.contentText);
		} catch (err) {
			logger.error(`[gateway] Failed to deliver to ${mapping.platform}:${mapping.chatId}`, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async findMappingByNarrator(narratorId: string) {
		return db.query.gatewaySessionMappings.findFirst({
			where: eq(gatewaySessionMappings.narratorId, narratorId),
		});
	}

	// -----------------------------------------------------------------------
	// Notify IM users when a narrator in their recentTabs changes status
	// -----------------------------------------------------------------------

	/**
	 * Driven by the semantic `narrator:attention` intent (reason = done / error /
	 * waiting_permission). Skip if the narrator is the user's currently-bound one
	 * (already handled by deliverToIM / stream consumer).
	 *
	 * Optimized: uses an in-memory cache of recentTabs narrator IDs (TTL 60s)
	 * to avoid repeated JSON parsing and DB queries on every status change.
	 */
	private async notifyRecentTabStatusChange(
		narratorId: string,
		reason: "waiting_permission" | "done" | "error",
	): Promise<void> {
		// No adapters → nothing to send
		if (this.adapters.size === 0) return;

		// Find gateway sessions that are NOT bound to this narrator and have an appUserId
		const mappings = await db
			.select({
				platform: gatewaySessionMappings.platform,
				chatId: gatewaySessionMappings.chatId,
				narratorId: gatewaySessionMappings.narratorId,
				appUserId: gatewaySessionMappings.appUserId,
			})
			.from(gatewaySessionMappings)
			.where(
				and(
					ne(gatewaySessionMappings.narratorId, narratorId),
					isNotNull(gatewaySessionMappings.appUserId),
				),
			)
			.all();

		if (mappings.length === 0) return;

		// Deduplicate by appUserId
		const uniqueUserIds = [
			...new Set(mappings.map((m) => m.appUserId).filter(Boolean)),
		] as string[];
		if (uniqueUserIds.length === 0) return;

		// Build userId → recentTabs narratorId set (with cache)
		const now = Date.now();
		const userTabNarratorIds = new Map<string, Set<string>>();
		const uncachedUserIds: string[] = [];

		for (const uid of uniqueUserIds) {
			const cached = this.recentTabsCache.get(uid);
			if (cached && now - cached.ts < Gateway.RECENT_TABS_CACHE_TTL) {
				userTabNarratorIds.set(uid, cached.ids);
			} else {
				uncachedUserIds.push(uid);
			}
		}

		// Fetch uncached preferences
		if (uncachedUserIds.length > 0) {
			const prefs = await db
				.select({
					userId: userPreferences.userId,
					recentTabs: userPreferences.recentTabs,
				})
				.from(userPreferences)
				.where(inArray(userPreferences.userId, uncachedUserIds));

			for (const pref of prefs) {
				let tabs: Record<string, unknown>[] = [];
				try {
					tabs = JSON.parse(pref.recentTabs ?? "[]");
				} catch {
					continue;
				}
				const ids = new Set<string>();
				for (const t of tabs) {
					if (t.type === "narrator" && typeof t.id === "string") ids.add(t.id);
					if (t.type === "chapter" && typeof t.narratorId === "string") ids.add(t.narratorId);
				}
				userTabNarratorIds.set(pref.userId, ids);
				this.recentTabsCache.set(pref.userId, { ids, ts: now });
			}
		}

		// Check if any user's recentTabs contains this narrator before fetching title
		let hasMatch = false;
		for (const mapping of mappings) {
			if (!mapping.appUserId) continue;
			if (userTabNarratorIds.get(mapping.appUserId)?.has(narratorId)) {
				hasMatch = true;
				break;
			}
		}
		if (!hasMatch) return;

		// Get narrator title for the notification
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { id: true, title: true },
		});
		if (!narrator) return;

		// Send notifications
		const shortId = narratorId.slice(0, 8);
		const title = narrator.title || "(untitled)";
		const statusEmoji = reason === "done" ? "✅" : reason === "error" ? "❌" : "⏳";
		const displayStatus = reason === "done" ? "done" : reason === "error" ? "error" : "waiting";
		let message = `${statusEmoji} ${title} (${shortId}…) → ${displayStatus}`;

		// When waiting for permission, append the pending request details so the
		// user can quote-reply to approve/deny from any IM session.
		if (reason === "waiting_permission") {
			const pending = this.findPendingPermissionForNarrator(narratorId);
			if (pending) {
				const summary = this.formatToolSummary(pending.toolName, pending.input);
				message += `\n🔐 ${pending.toolName}: ${summary}\n[perm:${pending.requestId}]`;
			}
		}

		for (const mapping of mappings) {
			if (!mapping.appUserId) continue;
			const tabIds = userTabNarratorIds.get(mapping.appUserId);
			if (!tabIds?.has(narratorId)) continue;

			const adapter = this.adapters.get(mapping.platform as GatewayPlatform);
			if (!adapter) continue;

			await adapter.send(mapping.chatId, message).catch(() => {});
		}
	}

	// -----------------------------------------------------------------------
	// Locale resolution
	// -----------------------------------------------------------------------

	private async resolveLocale(msg: InboundMessage): Promise<Locale> {
		const cacheKey = `${msg.platform}:${msg.chatId}:${msg.userId}`;
		const cached = this.localeCache.get(cacheKey);
		if (cached && Date.now() - cached.ts < Gateway.LOCALE_CACHE_TTL) {
			return cached.locale;
		}

		let locale: Locale = "en";
		try {
			// Try to find appUserId from existing mapping
			const mapping = await db.query.gatewaySessionMappings.findFirst({
				where: and(
					eq(gatewaySessionMappings.platform, msg.platform),
					eq(gatewaySessionMappings.chatId, msg.chatId),
					eq(gatewaySessionMappings.userId, msg.userId),
				),
				columns: { appUserId: true },
			});

			const appUserId = mapping?.appUserId ?? (await this.resolveAppUserId());
			if (appUserId) {
				locale = await getUserLanguage(appUserId);
			}
		} catch {
			// Non-fatal — default to "en"
		}

		this.localeCache.set(cacheKey, { locale, ts: Date.now() });
		return locale;
	}

	/** Resolve locale from a known appUserId (avoids extra mapping lookup). */
	private async resolveLocaleForAppUser(appUserId: string | null): Promise<Locale> {
		if (!appUserId) return "en";
		try {
			return await getUserLanguage(appUserId);
		} catch {
			return "en";
		}
	}

	// -----------------------------------------------------------------------
	// Chat commands
	// -----------------------------------------------------------------------

	private parseCommand(text: string): { cmd: string; args: string } | null {
		const trimmed = text.trim();
		if (!trimmed.startsWith("/")) return null;

		const spaceIdx = trimmed.indexOf(" ");
		if (spaceIdx === -1) {
			return { cmd: trimmed.toLowerCase(), args: "" };
		}
		return {
			cmd: trimmed.slice(0, spaceIdx).toLowerCase(),
			args: trimmed.slice(spaceIdx + 1).trim(),
		};
	}

	private async handleCommand(
		command: { cmd: string; args: string },
		msg: InboundMessage,
	): Promise<void> {
		const adapter = this.adapters.get(msg.platform);
		if (!adapter) return;

		const locale = await this.resolveLocale(msg);

		switch (command.cmd) {
			case "/new":
			case "/reset": {
				// Delete existing mapping so next message creates a fresh narrator
				await db
					.delete(gatewaySessionMappings)
					.where(
						and(
							eq(gatewaySessionMappings.platform, msg.platform),
							eq(gatewaySessionMappings.chatId, msg.chatId),
							eq(gatewaySessionMappings.userId, msg.userId),
						),
					);
				await adapter.send(msg.chatId, t("gateway.sessionReset", locale));
				break;
			}

			case "/model": {
				const mapping = await db.query.gatewaySessionMappings.findFirst({
					where: and(
						eq(gatewaySessionMappings.platform, msg.platform),
						eq(gatewaySessionMappings.chatId, msg.chatId),
						eq(gatewaySessionMappings.userId, msg.userId),
					),
				});

				if (!mapping) {
					await adapter.send(msg.chatId, t("gateway.noActiveSession", locale));
					break;
				}

				if (!command.args) {
					// Show current model
					const narrator = await db.query.narrators.findFirst({
						where: eq(narrators.id, mapping.narratorId),
						columns: { model: true },
					});
					await adapter.send(
						msg.chatId,
						t("gateway.currentModel", locale, { model: narrator?.model ?? "default" }),
					);
				} else {
					// Switch model
					const newModel = command.args;
					await db
						.update(narrators)
						.set({ model: newModel, updatedAt: new Date().toISOString() })
						.where(eq(narrators.id, mapping.narratorId));
					await adapter.send(msg.chatId, t("gateway.modelSwitched", locale, { model: newModel }));
				}
				break;
			}

			case "/status": {
				const mapping = await db.query.gatewaySessionMappings.findFirst({
					where: and(
						eq(gatewaySessionMappings.platform, msg.platform),
						eq(gatewaySessionMappings.chatId, msg.chatId),
						eq(gatewaySessionMappings.userId, msg.userId),
					),
				});
				if (!mapping) {
					await adapter.send(msg.chatId, t("gateway.noActiveSession", locale));
				} else {
					const narrator = await db.query.narrators.findFirst({
						where: eq(narrators.id, mapping.narratorId),
						columns: {
							id: true,
							status: true,
							model: true,
							messageCount: true,
							totalCostUsd: true,
						},
					});
					const lines = [
						t("gateway.sessionStatusHeader", locale),
						t("gateway.statusNarrator", locale, {
							id: `${mapping.narratorId.slice(0, 8)}…`,
						}),
						t("gateway.statusStatus", locale, {
							status: narrator?.status ?? "unknown",
						}),
						t("gateway.statusModel", locale, {
							model: narrator?.model ?? "default",
						}),
						t("gateway.statusMessages", locale, {
							count: narrator?.messageCount ?? 0,
						}),
						t("gateway.statusCost", locale, {
							costDisplay: `$${(narrator?.totalCostUsd ?? 0).toFixed(4)}`,
						}),
					];
					await adapter.send(msg.chatId, lines.join("\n"));
				}
				break;
			}

			case "/stop": {
				const mapping = await db.query.gatewaySessionMappings.findFirst({
					where: and(
						eq(gatewaySessionMappings.platform, msg.platform),
						eq(gatewaySessionMappings.chatId, msg.chatId),
						eq(gatewaySessionMappings.userId, msg.userId),
					),
				});
				if (mapping) {
					// Clean up stream consumer
					this.cleanupStreamConsumer(mapping.narratorId);
					// Import interruptNarrator dynamically to avoid circular deps
					const { interruptNarrator } = await import("../services/narrator-session");
					await interruptNarrator(mapping.narratorId);
					await adapter.send(msg.chatId, t("gateway.agentStopped", locale));
				} else {
					await adapter.send(msg.chatId, t("gateway.noActiveSessionShort", locale));
				}
				break;
			}

			case "/list": {
				await this.handleListCommand(msg, adapter, locale);
				break;
			}

			case "/search": {
				await this.handleSearchCommand(command.args, msg, adapter, locale);
				break;
			}

			case "/switch": {
				await this.handleSwitchCommand(command.args, msg, adapter, locale);
				break;
			}

			case "/approve": {
				const mapping = await db.query.gatewaySessionMappings.findFirst({
					where: and(
						eq(gatewaySessionMappings.platform, msg.platform),
						eq(gatewaySessionMappings.chatId, msg.chatId),
						eq(gatewaySessionMappings.userId, msg.userId),
					),
				});
				if (!mapping) {
					await adapter.send(msg.chatId, t("gateway.noActiveSession", locale));
					break;
				}
				const pending = this.findPendingPermissionForNarrator(mapping.narratorId);
				if (!pending) {
					await adapter.send(msg.chatId, t("gateway.noPermissionPending", locale));
					break;
				}
				const { resolvePermission } = await import("../services/narrator-permission");
				await resolvePermission(pending.requestId, "allow");
				await adapter.send(msg.chatId, t("gateway.permissionApproved", locale));
				break;
			}

			case "/deny": {
				const mapping = await db.query.gatewaySessionMappings.findFirst({
					where: and(
						eq(gatewaySessionMappings.platform, msg.platform),
						eq(gatewaySessionMappings.chatId, msg.chatId),
						eq(gatewaySessionMappings.userId, msg.userId),
					),
				});
				if (!mapping) {
					await adapter.send(msg.chatId, t("gateway.noActiveSession", locale));
					break;
				}
				const pendingReq = this.findPendingPermissionForNarrator(mapping.narratorId);
				if (!pendingReq) {
					await adapter.send(msg.chatId, t("gateway.noPermissionPending", locale));
					break;
				}
				const { resolvePermission: resolveP } = await import("../services/narrator-permission");
				const denyReason = command.args || undefined;
				await resolveP(pendingReq.requestId, "deny", {
					denyMessage: denyReason,
				});
				await adapter.send(msg.chatId, t("gateway.permissionDenied", locale));
				break;
			}

			case "/help": {
				const help = [
					t("gateway.helpHeader", locale),
					t("gateway.helpNew", locale),
					t("gateway.helpStop", locale),
					t("gateway.helpModel", locale),
					t("gateway.helpModelSwitch", locale),
					t("gateway.helpList", locale),
					t("gateway.helpSearch", locale),
					t("gateway.helpSwitch", locale),
					t("gateway.helpApprove", locale),
					t("gateway.helpDeny", locale),
					t("gateway.helpStatus", locale),
					t("gateway.helpHelp", locale),
				];
				await adapter.send(msg.chatId, help.join("\n"));
				break;
			}

			default:
				// Unknown command — forward as a normal message to the narrator
				// (bypass parseCommand to avoid infinite recursion)
				await this.forwardToNarrator(msg);
		}
	}

	// -----------------------------------------------------------------------
	// /list — List narrators from the user's recentTabs
	// -----------------------------------------------------------------------

	private async handleListCommand(
		msg: InboundMessage,
		adapter: PlatformAdapter,
		locale: Locale,
	): Promise<void> {
		// Get the current mapping to find appUserId and active narrator
		const mapping = await db.query.gatewaySessionMappings.findFirst({
			where: and(
				eq(gatewaySessionMappings.platform, msg.platform),
				eq(gatewaySessionMappings.chatId, msg.chatId),
				eq(gatewaySessionMappings.userId, msg.userId),
			),
		});
		const activeNarratorId = mapping?.narratorId ?? null;
		const appUserId = mapping?.appUserId ?? (await this.resolveAppUserId());

		if (!appUserId) {
			await adapter.send(msg.chatId, t("gateway.noUserLinked", locale));
			return;
		}

		// Load recentTabs from user_preferences
		const pref = await db.query.userPreferences.findFirst({
			where: eq(userPreferences.userId, appUserId),
			columns: { recentTabs: true },
		});

		let tabs: Record<string, unknown>[] = [];
		try {
			tabs = JSON.parse(pref?.recentTabs ?? "[]");
		} catch {
			// corrupted
		}

		if (tabs.length === 0) {
			await adapter.send(msg.chatId, t("gateway.noRecentTabs", locale));
			return;
		}

		// Collect narrator IDs from tabs for status lookup
		const narratorIds: string[] = [];
		for (const t of tabs) {
			if (t.type === "narrator" && typeof t.id === "string") narratorIds.push(t.id);
			else if (t.type === "chapter" && typeof t.narratorId === "string")
				narratorIds.push(t.narratorId);
		}

		// Batch-fetch narrator statuses
		const statusMap = new Map<string, string>();
		if (narratorIds.length > 0) {
			const rows = await db
				.select({ id: narrators.id, status: narrators.status })
				.from(narrators)
				.where(inArray(narrators.id, narratorIds));
			for (const r of rows) statusMap.set(r.id, r.status);
		}

		// Format output: group by workspace, show narrator/chapter tabs
		const lines: string[] = [t("gateway.recentTabs", locale)];
		const orderedNarratorIds: string[] = [];
		let idx = 0;

		for (const tab of tabs) {
			const type = typeof tab.type === "string" ? tab.type : "";

			if (type === "workspace") {
				lines.push(`\n📁 ${typeof tab.title === "string" ? tab.title : "Workspace"}`);
				continue;
			}

			if (type === "project") {
				const indent = tab.workspaceId ? "    " : "  ";
				lines.push(`${indent}📂 ${tab.title ?? tab.id ?? "?"}`);
				continue;
			}

			const indent = tab.workspaceId ? "    " : "  ";
			const narratorId =
				type === "narrator"
					? typeof tab.id === "string"
						? tab.id
						: undefined
					: typeof tab.narratorId === "string"
						? tab.narratorId
						: undefined;

			if (!narratorId) {
				lines.push(`${indent}📄 ${tab.title ?? tab.id ?? "?"}`);
				continue;
			}

			idx++;
			orderedNarratorIds.push(narratorId);
			const isActive = narratorId === activeNarratorId;
			const marker = isActive ? "▸" : " ";
			const title = typeof tab.title === "string" && tab.title ? tab.title : "(untitled)";
			const status =
				statusMap.get(narratorId) ?? (typeof tab.status === "string" ? tab.status : "?");
			const suffix = isActive ? t("gateway.currentSuffix", locale) : "";

			lines.push(`${indent}${marker} [${idx}] ${title} (${status})${suffix}`);
		}

		// Cache the ordered narrator IDs so /switch <number> works
		const chatKey = `${msg.platform}:${msg.chatId}:${msg.userId}`;
		this.listResultCache.set(chatKey, { ids: orderedNarratorIds, ts: Date.now() });

		lines.push("", t("gateway.useSwitchHint", locale));
		await adapter.send(msg.chatId, lines.join("\n"));
	}

	// -----------------------------------------------------------------------
	// /search <query> — Search narrators by title
	// -----------------------------------------------------------------------

	private async handleSearchCommand(
		query: string,
		msg: InboundMessage,
		adapter: PlatformAdapter,
		locale: Locale,
	): Promise<void> {
		if (!query) {
			await adapter.send(msg.chatId, t("gateway.searchUsage", locale));
			return;
		}

		const { searchService } = await import("../services/search-service");
		const results = searchService.search({
			query,
			entities: ["narrators"],
			limit: 10,
		});

		if (results.length === 0) {
			await adapter.send(msg.chatId, t("gateway.searchNoResults", locale, { query }));
			return;
		}

		const lines = [t("gateway.searchResults", locale, { query })];
		const orderedNarratorIds: string[] = [];
		for (let i = 0; i < results.length; i++) {
			const r = results[i];
			const title = r.title || "(untitled)";
			orderedNarratorIds.push(r.id);
			lines.push(` [${i + 1}] ${title}`);
		}

		// Cache the ordered narrator IDs so /switch <number> works
		const chatKey = `${msg.platform}:${msg.chatId}:${msg.userId}`;
		this.listResultCache.set(chatKey, { ids: orderedNarratorIds, ts: Date.now() });

		lines.push("", t("gateway.useSwitchHint", locale));

		await adapter.send(msg.chatId, lines.join("\n"));
	}

	// -----------------------------------------------------------------------
	// /switch <id> — Switch the IM session to an existing narrator
	// -----------------------------------------------------------------------

	private async handleSwitchCommand(
		idPrefix: string,
		msg: InboundMessage,
		adapter: PlatformAdapter,
		locale: Locale,
	): Promise<void> {
		if (!idPrefix) {
			await adapter.send(msg.chatId, t("gateway.switchUsage", locale));
			return;
		}

		let trimmed = idPrefix.trim();

		// Support numeric index from last /list or /search result
		if (/^\d+$/.test(trimmed)) {
			const idx = Number.parseInt(trimmed, 10);
			const chatKey = `${msg.platform}:${msg.chatId}:${msg.userId}`;
			const cached = this.listResultCache.get(chatKey);
			if (cached && Date.now() - cached.ts < Gateway.LIST_RESULT_CACHE_TTL) {
				if (idx >= 1 && idx <= cached.ids.length) {
					trimmed = cached.ids[idx - 1];
				} else {
					await adapter.send(
						msg.chatId,
						t("gateway.switchIndexOutOfRange", locale, { max: cached.ids.length }),
					);
					return;
				}
			} else {
				await adapter.send(msg.chatId, t("gateway.switchNoListCache", locale));
				return;
			}
		}

		// Support both full ID and short prefix (≥4 chars)
		let narrator:
			| {
					id: string;
					title: string | null;
					status: string;
					model: string | null;
					chapterId: string | null;
			  }
			| undefined;

		// Try exact match first
		narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, trimmed),
			columns: { id: true, title: true, status: true, model: true, chapterId: true },
		});

		// If not found, try prefix match (LIKE)
		if (!narrator && trimmed.length >= 4) {
			// Escape LIKE wildcards to prevent matching unintended rows
			const escaped = trimmed.replace(/[%_]/g, "\\$&");
			narrator = await db.query.narrators.findFirst({
				where: like(narrators.id, `${escaped}%`),
				columns: { id: true, title: true, status: true, model: true, chapterId: true },
			});
		}

		if (!narrator) {
			await adapter.send(msg.chatId, t("gateway.narratorNotFound", locale, { id: trimmed }));
			return;
		}

		// Ownership check: if the gateway has a default project, only allow
		// switching to narrators that belong to that project (via chapter).
		const defaultProjectId = this.config?.defaultProjectId;
		if (defaultProjectId && narrator.chapterId) {
			const chapter = await db.query.chapters.findFirst({
				where: eq(chapters.id, narrator.chapterId),
				columns: { projectId: true },
			});
			if (chapter && chapter.projectId !== defaultProjectId) {
				await adapter.send(msg.chatId, t("gateway.narratorWrongProject", locale));
				return;
			}
		}

		// Find or create the session mapping
		const now = new Date().toISOString();
		const existing = await db.query.gatewaySessionMappings.findFirst({
			where: and(
				eq(gatewaySessionMappings.platform, msg.platform),
				eq(gatewaySessionMappings.chatId, msg.chatId),
				eq(gatewaySessionMappings.userId, msg.userId),
			),
		});

		if (existing) {
			// Clean up stream consumer for old narrator
			this.cleanupStreamConsumer(existing.narratorId);
			// Update mapping to point to the new narrator
			await db
				.update(gatewaySessionMappings)
				.set({ narratorId: narrator.id, updatedAt: now, lastMessageAt: now })
				.where(eq(gatewaySessionMappings.id, existing.id));
		} else {
			// Create new mapping pointing to the existing narrator
			await db.insert(gatewaySessionMappings).values({
				id: generateId(),
				platform: msg.platform,
				chatId: msg.chatId,
				userId: msg.userId,
				username: msg.username,
				narratorId: narrator.id,
				lastMessageAt: now,
				createdAt: now,
				updatedAt: now,
			});
		}

		const title = narrator.title || "(untitled)";
		await adapter.send(
			msg.chatId,
			t("gateway.switchedTo", locale, {
				title,
				id: `${narrator.id.slice(0, 8)}…`,
				status: narrator.status,
				model: narrator.model ?? "default",
			}),
		);
	}
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const gateway = new Gateway();
