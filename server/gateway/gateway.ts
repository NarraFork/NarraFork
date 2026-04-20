/**
 * IM Gateway core.
 *
 * Bridges IM platforms ↔ NarraFork narrators:
 *   - Inbound:  IM message → find/create narrator → sendMessage()
 *   - Outbound: eventBus narrator events → send back to IM platform
 */

import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import {
	gatewaySessionMappings,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	projects,
} from "../db/schema";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { FOLLOW_DEFAULT_MODEL } from "../lib/settings";
import { sendMessage } from "../services/narrator-session";
import { loadGatewayConfig } from "./config";
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
} from "./types";

// ---------------------------------------------------------------------------
// Gateway singleton
// ---------------------------------------------------------------------------

class Gateway {
	private config: GatewayConfig | null = null;
	private adapters = new Map<GatewayPlatform, PlatformAdapter>();
	private started = false;

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

		// Forward to narrator
		try {
			await sendMessage(mapping.narratorId, msg.text);
		} catch (err) {
			logger.error("[gateway] sendMessage failed", {
				narratorId: mapping.narratorId,
				error: err instanceof Error ? err.message : String(err),
			});
			if (adapter) {
				await adapter.send(
					msg.chatId,
					`❌ Error: ${err instanceof Error ? err.message : "Unknown error"}`,
				);
			}
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
			// Update last message time
			await db
				.update(gatewaySessionMappings)
				.set({ lastMessageAt: now, updatedAt: now })
				.where(eq(gatewaySessionMappings.id, existing.id));
			return existing;
		}

		// Create a new narrator for this IM session
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
			projectId,
			chapterId,
			lastMessageAt: now,
			createdAt: now,
			updatedAt: now,
		});

		logger.info(`[gateway] Created narrator ${narratorId} for ${msg.platform}:${msg.chatId}`);

		return { id: mappingId, narratorId, platform: msg.platform, chatId: msg.chatId };
	}

	// -----------------------------------------------------------------------
	// Outbound: Narrator events → IM
	// -----------------------------------------------------------------------

	private subscribeToEvents(): void {
		// Listen for narrator status changes — deliver the final assistant
		// message only when the narrator becomes idle (turn complete).
		// This avoids sending intermediate tool-use messages to IM.
		eventBus.on("narrator:status_changed", async (event) => {
			if (event.status !== "idle") return;
			await this.deliverToIM(event.narratorId);
		});

		// Listen for errors
		eventBus.on("narrator:error", async (event) => {
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
			.select({ contentText: narratorMessages.contentText, role: narratorMessages.role })
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
						`📊 Session Status`,
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
					// Import interruptNarrator dynamically to avoid circular deps
					const { interruptNarrator } = await import("../services/narrator-session");
					await interruptNarrator(mapping.narratorId);
					await adapter.send(msg.chatId, "⏹ Agent stopped.");
				} else {
					await adapter.send(msg.chatId, "No active session.");
				}
				break;
			}

			case "/help": {
				const help = [
					"📖 Available commands:",
					"/new — Start a fresh conversation",
					"/stop — Interrupt the running agent",
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
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const gateway = new Gateway();
