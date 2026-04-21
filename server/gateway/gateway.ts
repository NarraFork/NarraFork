/**
 * IM Gateway core.
 *
 * Bridges IM platforms ↔ NarraFork narrators:
 *   - Inbound:  IM message → find/create narrator → sendMessage()
 *   - Outbound: eventBus narrator events → stream / send back to IM platform
 */

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
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { FOLLOW_DEFAULT_MODEL } from "../lib/settings";
import type { ImageRef } from "../lib/uploads";
import { sendMessage } from "../services/narrator-session";
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

	// Cache: appUserId → { narratorIds in recentTabs, timestamp }
	// Avoids parsing JSON on every status change event.
	private recentTabsCache = new Map<string, { ids: Set<string>; ts: number }>();
	private static readonly RECENT_TABS_CACHE_TTL = 60_000; // 60 seconds

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	async start(): Promise<void> {
		if (this.started) return;

		this.config = loadGatewayConfig();
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
			default:
				logger.warn(`[gateway] Unknown platform: ${(config as any).platform}`);
				return null;
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
					await adapter.send(msg.chatId, "⏳ Rate limited. Please wait a moment.").catch(() => {});
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

			await sendMessage(mapping.narratorId, msg.text, imageRefs.length > 0 ? imageRefs : undefined);
		} catch (err) {
			logger.error("[gateway] sendMessage failed", {
				narratorId: mapping.narratorId,
				error: err instanceof Error ? err.message : String(err),
			});
			// Clean up stream consumer on error
			this.cleanupStreamConsumer(mapping.narratorId);
			if (adapter) {
				await adapter.send(
					msg.chatId,
					`❌ Error: ${err instanceof Error ? err.message : "Unknown error"}`,
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
						await adapter
							.send(msg.chatId, "🔄 Session expired due to inactivity. Starting fresh.")
							.catch(() => {});
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
					const resp = await fetch(img.url);
					if (!resp.ok) {
						logger.warn("[gateway] Failed to download image", {
							url: img.url,
							status: resp.status,
						});
						continue;
					}
					buffer = await resp.arrayBuffer();
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
		await db.insert(narrators).values({
			id: narratorId,
			chapterId: chapterId,
			type: "primary",
			title: `IM: ${msg.username} (${msg.platform})`,
			status: "idle",
			model: FOLLOW_DEFAULT_MODEL,
			permissionMode: (this.config?.defaultPermissionMode as any) ?? "bypassPermissions",
			messageCount: 0,
			totalCostUsd: 0,
			pruneEnabled: true,
			fastMode: false,
			relaxedPlan: false,
			planMode: false,
			isBackground: false,
			isAskInPassing: false,
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

	private subscribeToEvents(): void {
		// Listen for narrator status changes — deliver the final assistant
		// message only when the narrator becomes idle (turn complete).
		eventBus.on("narrator:status_changed", async (event) => {
			// 1. Handle the directly-bound narrator (deliver response)
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

			// 2. Notify IM users whose recentTabs contain this narrator
			//    (but it's NOT their currently-bound narrator)
			await this.notifyRecentTabStatusChange(event.narratorId, event.status);
		});

		// Listen for streaming events — feed deltas to stream consumer
		eventBus.on("narrator:ws_broadcast", (event) => {
			const consumer = this.streamConsumers.get(event.narratorId);
			if (!consumer) return;

			const msg = event.message;
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
		});

		// Listen for errors
		eventBus.on("narrator:error", async (event) => {
			// Clean up stream consumer
			this.cleanupStreamConsumer(event.narratorId);

			const mapping = await this.findMappingByNarrator(event.narratorId);
			if (!mapping) return;

			const adapter = this.adapters.get(mapping.platform as GatewayPlatform);
			if (!adapter) return;

			await adapter.send(mapping.chatId, `❌ Error: ${event.error}`);
		});
	}

	private async deliverToIM(narratorId: string): Promise<void> {
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
	 * Only notify for "interesting" transitions (idle = done, error, waiting).
	 * Skip if the narrator is the user's currently-bound one (already handled
	 * by deliverToIM / stream consumer).
	 *
	 * Optimized: uses an in-memory cache of recentTabs narrator IDs (TTL 60s)
	 * to avoid repeated JSON parsing and DB queries on every status change.
	 */
	private async notifyRecentTabStatusChange(narratorId: string, status: string): Promise<void> {
		// Only notify for meaningful status changes
		if (status !== "idle" && status !== "error" && status !== "waiting") return;

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
		const statusEmoji =
			status === "idle" ? "✅" : status === "error" ? "❌" : status === "waiting" ? "⏳" : "ℹ️";
		const message = `${statusEmoji} ${title} (${shortId}…) → ${status}`;

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
				await adapter.send(
					msg.chatId,
					"🔄 Session reset. Send a message to start a new conversation.",
				);
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
					await adapter.send(msg.chatId, "No active session. Send a message to start one.");
					break;
				}

				if (!command.args) {
					// Show current model
					const narrator = await db.query.narrators.findFirst({
						where: eq(narrators.id, mapping.narratorId),
						columns: { model: true },
					});
					await adapter.send(msg.chatId, `🤖 Current model: ${narrator?.model ?? "default"}`);
				} else {
					// Switch model
					const newModel = command.args;
					await db
						.update(narrators)
						.set({ model: newModel, updatedAt: new Date().toISOString() })
						.where(eq(narrators.id, mapping.narratorId));
					await adapter.send(msg.chatId, `🤖 Model switched to: ${newModel}`);
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
					await adapter.send(msg.chatId, "No active session. Send a message to start one.");
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
						"📊 Session Status",
						`Narrator: ${mapping.narratorId.slice(0, 8)}…`,
						`Status: ${narrator?.status ?? "unknown"}`,
						`Model: ${narrator?.model ?? "default"}`,
						`Messages: ${narrator?.messageCount ?? 0}`,
						`Cost: $${(narrator?.totalCostUsd ?? 0).toFixed(4)}`,
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
					await adapter.send(msg.chatId, "⏹ Agent stopped.");
				} else {
					await adapter.send(msg.chatId, "No active session.");
				}
				break;
			}

			case "/list": {
				await this.handleListCommand(msg, adapter);
				break;
			}

			case "/search": {
				await this.handleSearchCommand(command.args, msg, adapter);
				break;
			}

			case "/switch": {
				await this.handleSwitchCommand(command.args, msg, adapter);
				break;
			}

			case "/help": {
				const help = [
					"📖 Available commands:",
					"/new — Start a fresh conversation",
					"/stop — Interrupt the running agent",
					"/model — Show current model",
					"/model <name> — Switch to a different model",
					"/list — List recent narrators",
					"/search <query> — Search narrators by title",
					"/switch <id> — Switch to an existing narrator",
					"/status — Show session info",
					"/help — Show this message",
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

	private async handleListCommand(msg: InboundMessage, adapter: PlatformAdapter): Promise<void> {
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
			await adapter.send(msg.chatId, "No NarraFork user linked. Cannot list tabs.");
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
			await adapter.send(msg.chatId, "No recent tabs found.");
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
		const lines: string[] = ["📋 Recent tabs:"];

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

			const isActive = narratorId === activeNarratorId;
			const marker = isActive ? "▸" : " ";
			const shortId = narratorId.slice(0, 8);
			const title = typeof tab.title === "string" && tab.title ? tab.title : "(untitled)";
			const status =
				statusMap.get(narratorId) ?? (typeof tab.status === "string" ? tab.status : "?");
			const suffix = isActive ? " ← current" : "";

			lines.push(`${indent}${marker} ${shortId} — ${title} (${status})${suffix}`);
		}

		lines.push("", "Use /switch <id> to switch.");
		await adapter.send(msg.chatId, lines.join("\n"));
	}

	// -----------------------------------------------------------------------
	// /search <query> — Search narrators by title
	// -----------------------------------------------------------------------

	private async handleSearchCommand(
		query: string,
		msg: InboundMessage,
		adapter: PlatformAdapter,
	): Promise<void> {
		if (!query) {
			await adapter.send(msg.chatId, "Usage: /search <query>");
			return;
		}

		const { searchService } = await import("../services/search-service");
		const results = searchService.search({
			query,
			entities: ["narrators"],
			limit: 10,
		});

		if (results.length === 0) {
			await adapter.send(msg.chatId, `No narrators found for "${query}".`);
			return;
		}

		const lines = [`🔍 Search results for "${query}":`];
		for (const r of results) {
			const shortId = r.id.slice(0, 8);
			const title = r.title || "(untitled)";
			lines.push(` ${shortId} — ${title}`);
		}
		lines.push("", "Use /switch <id> to switch.");

		await adapter.send(msg.chatId, lines.join("\n"));
	}

	// -----------------------------------------------------------------------
	// /switch <id> — Switch the IM session to an existing narrator
	// -----------------------------------------------------------------------

	private async handleSwitchCommand(
		idPrefix: string,
		msg: InboundMessage,
		adapter: PlatformAdapter,
	): Promise<void> {
		if (!idPrefix) {
			await adapter.send(
				msg.chatId,
				"Usage: /switch <narrator-id>\nUse /list or /search to find IDs.",
			);
			return;
		}

		const trimmed = idPrefix.trim();

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
			await adapter.send(
				msg.chatId,
				`❌ Narrator not found: ${trimmed}\nUse /list or /search to find valid IDs.`,
			);
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
				await adapter.send(
					msg.chatId,
					`❌ Narrator belongs to a different project.\nUse /list or /search to find narrators in the current project.`,
				);
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
			`🔗 Switched to: ${title}\nID: ${narrator.id.slice(0, 8)}… | Status: ${narrator.status} | Model: ${narrator.model ?? "default"}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const gateway = new Gateway();
