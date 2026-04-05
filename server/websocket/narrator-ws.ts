import type { ServerWebSocket } from "bun";
import { and, count as countFn, eq } from "drizzle-orm";
import { db, sqlite } from "../db";
import { containerInstances, narrators, overseers, terminals, userPreferences } from "../db/schema";
import { CONTAINER_STATUS_PRIORITY } from "../lib/constants";
import { eventBus } from "../lib/event-bus";
import { hotOnce } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { getUserLanguage } from "../lib/prompt-i18n";
import { narratorWsMessageSchema } from "../lib/validators";
import { type MergeDecision, resolveMergeDecision } from "../services/chapter-batch-merge";
import type { LoadToolNotFound, LoadToolResult } from "../services/command-service";
import { resolveCommand } from "../services/command-service";
import type { GitStatusSummary } from "../services/git-service";
import { getStreamingSnapshot } from "../services/narrator-event-handler";
import { handleLoadToolCommand, narratorService } from "../services/narrator-service";
import {
	clearBufferedMessages,
	getBufferedMessages,
	pushBufferedMessage,
	removeBufferedMessage,
	resolvePermission,
	toBufferSummary,
	updateBufferedMessage,
} from "../services/narrator-session";
import { addStatsSubscriber, removeStatsSubscriber } from "../services/output-stats";
import type { WSData } from "./ws-handler";

// === Types ===

export interface NarratorWSData {
	connectedAt: number;
	lastPongAt: number;
	subscribedNarrators: Set<string>;
	subscribedStats?: boolean;
	userId?: string;
	username?: string;
	avatarColor?: string | null;
	avatarImageId?: string | null;
}

// Server → Client messages
export type NarratorServerMessage =
	| { type: "message"; narratorId: string; message: unknown }
	| { type: "stream_event"; narratorId: string; event: unknown }
	| { type: "permission_request"; narratorId: string; request: unknown }
	| { type: "status_change"; narratorId: string; status: string; turnStartedAt?: string }
	| { type: "tool_progress"; narratorId: string; toolUseId: string; elapsed: number }
	| {
			type: "tool_output";
			narratorId: string;
			toolUseId: string;
			output: string;
			parentToolUseId?: string;
	  }
	// 看门狗检测到 bash/shell 进程运行 ≥60s 时推送，前端据此显示终止按钮
	| { type: "tool_long_running"; narratorId: string; toolUseId: string; elapsed: number }
	| {
			type: "tool_completed";
			narratorId: string;
			toolUseId: string;
			status: string;
			output?: unknown;
			durationMs?: number;
			updatedInput?: Record<string, unknown>;
	  }
	| { type: "title_updated"; narratorId: string; title: string }
	| {
			type: "permission_resolved";
			narratorId: string;
			requestId: string;
			toolUseId?: string;
			decision?: "allow" | "deny";
			updatedInput?: Record<string, unknown>;
			feedbackText?: string;
	  }
	| { type: "todos_updated"; narratorId: string; todos: unknown[]; toolUseId?: string }
	| {
			type: "buffer_set";
			narratorId: string;
			messages: Array<{ id: string; text: string; bufferedAt: string }>;
	  }
	| {
			type: "buffer_consumed";
			narratorId: string;
			messageId: string;
			remaining: Array<{ id: string; text: string; bufferedAt: string }>;
	  }
	| { type: "buffer_cleared"; narratorId: string; reason: "cancelled" | "sent" | "narrator_error" }
	| {
			type: "buffer_preserved";
			narratorId: string;
			messages: Array<{ id: string; text: string; bufferedAt: string }>;
	  }
	| { type: "permission_mode_changed"; narratorId: string; permissionMode: string }
	| { type: "relaxed_plan_changed"; narratorId: string; relaxedPlan: boolean }
	| {
			type: "overseer_reviewing";
			narratorId: string;
			requestId: string;
			toolUseId: string;
			status: "reviewing" | "queued" | "cleared";
			overseerId?: string;
	  }
	| { type: "user_message"; narratorId: string; message: unknown }
	| { type: "compacting"; narratorId: string }
	| { type: "compact_done"; narratorId: string }
	| { type: "compact_failed"; narratorId: string; messageId: string }
	| {
			type: "context_usage";
			narratorId: string;
			percentage: number;
			isSubagent?: boolean;
			promptTokens?: number;
			contextWindow?: number;
			pruneStart?: number;
			compactStart?: number;
	  }
	| {
			type: "prune_boundary";
			narratorId: string;
			boundaryMessageId: string | null;
			prunedPercent: number | null;
	  }
	| {
			type: "metering";
			narratorId: string;
			unit: string;
			unitPlural: string;
			usage: number;
			isSubagent?: boolean;
	  }
	| { type: "messages_deleted"; narratorId: string; deletedMessageIds: string[] }
	| { type: "message_updated"; narratorId: string; message: unknown }
	| { type: "narrator_forked"; narratorId: string; parentNarratorId: string }
	| { type: "narrator_error"; narratorId: string; error: string; errorCode?: string }
	| {
			type: "web_search";
			narratorId: string;
			id: string;
			status: "in_progress" | "searching" | "completed";
			query?: string;
			queries?: string[];
	  }
	| {
			type: "tool_started";
			narratorId: string;
			toolUseId: string;
			toolName: string;
			input: unknown;
			streamStartedAt?: number;
	  }
	| {
			type: "tool_use_chunk";
			narratorId: string;
			toolUseId: string;
			toolName: string;
			inputCharsTotal: number;
			parentToolUseId?: string;
			extractedFilePath?: string;
			contentCharsReceived?: number;
			extractedFields?: Record<string, string>;
	  }
	| {
			type: "subagent_started";
			narratorId: string;
			subagentNarratorId: string;
			toolUseId: string;
			subagentType: string;
			model?: string;
	  }
	| {
			type: "background_task_started";
			narratorId: string;
			taskNarratorId: string;
			toolUseId: string;
			subagentType: string;
	  }
	| {
			type: "background_task_completed";
			narratorId: string;
			taskNarratorId: string;
			toolUseId: string;
			resultPreview: string;
	  }
	| {
			type: "background_task_failed";
			narratorId: string;
			taskNarratorId: string;
			toolUseId: string;
			error: string;
	  }
	| {
			type: "background_task_cancelled";
			narratorId: string;
			taskNarratorId: string;
			toolUseId: string;
	  }
	| {
			type: "git_status";
			narratorId: string;
			chapterId: string;
			toolUseId: string;
			status: GitStatusSummary;
			commitsAhead?: number;
			baseBranch?: string;
			linesAdded?: number;
			linesRemoved?: number;
	  }
	| {
			type: "catch_up";
			narratorId: string;
			orphanChildren: unknown[];
			topLevel: unknown[];
	  }
	| { type: "error"; message: string }
	| {
			type: "warning";
			narratorId: string;
			message: string;
			retryCount?: number;
			maxRetries?: number;
			delayMs?: number;
	  }
	| { type: "context_length_exceeded"; narratorId: string }
	| { type: "interrupt_checking"; narratorId: string }
	| { type: "interrupt_check_done"; narratorId: string }
	| { type: "full_reload"; narratorId: string }
	| { type: "commits_updated"; narratorId: string; chapterId: string; newCount: number }
	| {
			type: "presence_update";
			narratorId: string;
			viewers: Array<{
				userId: string;
				username: string;
				avatarColor: string | null;
				avatarImageId: string | null;
			}>;
	  }
	| {
			type: "terminal_count_changed";
			narratorId: string;
			activeTerminalCount: number;
	  }
	| {
			type: "container_status_changed";
			narratorId: string;
			chapterId: string;
			containerStatus: string | null;
	  }
	| {
			narratorId: string;
			quotaBalance: number | null;
	  }
	| {
			narratorId: string;
			position: number;
			queueDepth: number;
	  }
	| {
			type: "streaming_snapshot";
			narratorId: string;
			streamingBlocks: Array<
				| { type: "reasoning"; text: string }
				| { type: "web_search"; id: string; status: string; query?: string; queries?: string[] }
				| { type: "text"; text: string }
			>;
			toolChunks: Array<{
				toolUseId: string;
				toolName: string;
				inputCharsTotal: number;
				parentToolUseId?: string;
				extractedFilePath?: string;
				contentCharsReceived?: number;
				extractedFields?: Record<string, string>;
				started?: boolean;
				input?: unknown;
				streamStartedAt?: number;
			}>;
	  }
	| { type: "model_changed"; narratorId: string; model: string }
	| { type: "model_switched"; narratorId: string; model: string; provider: string }
	| { type: "sync_ok"; narratorId: string; version: number };

// Client → Server messages
export type NarratorClientMessage =
	| { type: "pong" }
	| { type: "subscribe"; narratorIds: string[]; lastMessageId?: string }
	| { type: "unsubscribe"; narratorIds: string[] }
	| {
			type: "permission_decision";
			requestId: string;
			decision: "allow" | "deny";
			message?: string;
			answers?: Record<string, string>;
			feedbackText?: string;
			updatedPlan?: string;
	  }
	| {
			type: "merge_decision";
			mergeSessionId: string;
			decision: MergeDecision;
	  }
	| { type: "buffer_message"; narratorId: string; text: string }
	| { type: "cancel_buffer"; narratorId: string }
	| { type: "update_buffer"; narratorId: string; messageId: string; text: string }
	| { type: "remove_buffer"; narratorId: string; messageId: string }
	| { type: "presence_join"; narratorId: string }
	| { type: "presence_leave"; narratorId: string }
	| { type: "subscribe_stats" }
	| { type: "unsubscribe_stats" }
	| { type: "sync_check"; narratorId: string; version: number; lastMessageId?: string };

// === Connection registry ===

type NarratorWS = ServerWebSocket<WSData & { channel: "narrator" }>;

type ViewerInfo = {
	userId: string;
	username: string;
	avatarColor: string | null;
	avatarImageId: string | null;
};

const connections = new Set<NarratorWS>();

// === Presence tracking ===
// Map<narratorId, Map<wsInstance, ViewerInfo>>
const presenceMap = new Map<string, Map<NarratorWS, ViewerInfo>>();

function addPresence(ws: NarratorWS, narratorId: string) {
	if (!ws.data.userId) return;
	let viewers = presenceMap.get(narratorId);
	if (!viewers) {
		viewers = new Map();
		presenceMap.set(narratorId, viewers);
	}
	viewers.set(ws, {
		userId: ws.data.userId,
		username: ws.data.username ?? "",
		avatarColor: ws.data.avatarColor ?? null,
		avatarImageId: ws.data.avatarImageId ?? null,
	});
	broadcastPresence(narratorId);
}

function removePresence(ws: NarratorWS, narratorId: string) {
	const viewers = presenceMap.get(narratorId);
	if (!viewers) return;
	viewers.delete(ws);
	if (viewers.size === 0) presenceMap.delete(narratorId);
	else broadcastPresence(narratorId);
}

function removeAllPresence(ws: NarratorWS) {
	for (const [narratorId, viewers] of presenceMap) {
		if (viewers.delete(ws)) {
			if (viewers.size === 0) presenceMap.delete(narratorId);
			else broadcastPresence(narratorId);
		}
	}
}

function broadcastPresence(narratorId: string) {
	const viewers = presenceMap.get(narratorId);
	const uniqueViewers = new Map<string, ViewerInfo>();
	if (viewers) {
		for (const v of viewers.values()) {
			uniqueViewers.set(v.userId, v);
		}
	}
	broadcastToNarrator(narratorId, {
		type: "presence_update",
		narratorId,
		viewers: [...uniqueViewers.values()],
	});
}

/** Get current viewers for a narrator (used by REST API). */
export function getNarratorPresence(narratorId: string): ViewerInfo[] {
	const viewers = presenceMap.get(narratorId);
	if (!viewers) return [];
	const unique = new Map<string, ViewerInfo>();
	for (const v of viewers.values()) unique.set(v.userId, v);
	return [...unique.values()];
}

/** Get presence for multiple narrators at once (batch). */
/** Return the set of narrator IDs that currently have at least one viewer. */
export function getNarratorIdsWithPresence(): Set<string> {
	return new Set(presenceMap.keys());
}

export function getNarratorPresenceBatch(narratorIds: string[]): Map<string, ViewerInfo[]> {
	const result = new Map<string, ViewerInfo[]>();
	for (const id of narratorIds) {
		const viewers = getNarratorPresence(id);
		if (viewers.length > 0) result.set(id, viewers);
	}
	return result;
}

/** Expose connections for heartbeat iteration. */
export function getNarratorConnections(): Set<NarratorWS> {
	return connections;
}

// === Event bus → WebSocket broadcast ===

// === Public API for services to push messages directly ===

export function broadcastToNarrator(narratorId: string, message: NarratorServerMessage): void {
	const payload = JSON.stringify(message);
	for (const ws of connections) {
		if (ws.data.subscribedNarrators.has(narratorId)) {
			try {
				ws.send(payload);
			} catch {
				connections.delete(ws);
			}
		}
	}
}

/** Broadcast a message to all WS connections belonging to a specific user. */
export function broadcastToUser(userId: string, data: unknown): void {
	const msg = JSON.stringify(data);
	for (const ws of connections) {
		if (ws.data.userId !== userId) continue;
		try {
			ws.send(msg);
		} catch {
			connections.delete(ws);
		}
	}
}

/** Broadcast a message to ALL narrator WS connections (not filtered by subscription). */
export function broadcastToAll(message: Record<string, unknown>): void {
	const payload = JSON.stringify(message);
	for (const ws of connections) {
		try {
			ws.send(payload);
		} catch {
			connections.delete(ws);
		}
	}
}

// === Terminal count change listener ===
// When a terminal is created or exits, compute the new running count for its narrator
// and broadcast to subscribers. Debounced per-narrator to avoid redundant queries
// when multiple terminals change rapidly (e.g. batch cleanup).

const pendingTerminalBroadcasts = new Map<string, ReturnType<typeof setTimeout>>();

async function broadcastTerminalCount(narratorId: string | null) {
	if (!narratorId) return;
	const row = await db
		.select({ count: countFn() })
		.from(terminals)
		.where(and(eq(terminals.narratorId, narratorId), eq(terminals.status, "running")))
		.get();
	broadcastToNarrator(narratorId, {
		type: "terminal_count_changed",
		narratorId,
		activeTerminalCount: row?.count ?? 0,
	});
}

function debouncedTerminalCount(narratorId: string | null) {
	if (!narratorId) return;
	const existing = pendingTerminalBroadcasts.get(narratorId);
	if (existing) clearTimeout(existing);
	pendingTerminalBroadcasts.set(
		narratorId,
		setTimeout(() => {
			pendingTerminalBroadcasts.delete(narratorId);
			broadcastTerminalCount(narratorId);
		}, 100),
	);
}

// === Container status change listener ===
// When a container starts/stops/pauses/resumes, compute the aggregate status for the chapter
// and broadcast to subscribers of the chapter's narrator. Debounced per-chapter.

const pendingContainerBroadcasts = new Map<string, ReturnType<typeof setTimeout>>();

async function broadcastContainerStatus(chapterId: string) {
	// A chapter may have multiple narrators — broadcast to all of them.
	const chapterNarrators = await db.query.narrators.findMany({
		where: eq(narrators.chapterId, chapterId),
		columns: { id: true },
	});
	if (chapterNarrators.length === 0) return;

	const rows = await db
		.select({ status: containerInstances.status })
		.from(containerInstances)
		.where(eq(containerInstances.chapterId, chapterId));

	let bestStatus: string | null = null;
	let bestPriority = -1;
	for (const row of rows) {
		const p = CONTAINER_STATUS_PRIORITY[row.status] ?? 0;
		if (p > bestPriority) {
			bestPriority = p;
			bestStatus = row.status;
		}
	}

	for (const narrator of chapterNarrators) {
		broadcastToNarrator(narrator.id, {
			type: "container_status_changed",
			narratorId: narrator.id,
			chapterId,
			containerStatus: bestStatus,
		});
	}
}

function debouncedContainerStatus(chapterId: string) {
	const existing = pendingContainerBroadcasts.get(chapterId);
	if (existing) clearTimeout(existing);
	pendingContainerBroadcasts.set(
		chapterId,
		setTimeout(() => {
			pendingContainerBroadcasts.delete(chapterId);
			broadcastContainerStatus(chapterId);
		}, 100),
	);
}

// === Event bus listeners ===
// Guard against duplicate registration during Bun --hot reloads.
// The eventBus singleton survives reloads (via hotSafe in event-bus.ts),
// but this module re-executes, so without a guard each reload appends
// duplicate handlers — causing N× DB queries and WS broadcasts.

if (hotOnce("narrafork.narratorWs.listenersRegistered")) {
	eventBus.on("terminal:created", (event) => {
		debouncedTerminalCount(event.narratorId);
	});

	eventBus.on("terminal:exited", (event) => {
		debouncedTerminalCount(event.narratorId);
	});

	eventBus.on("container:started", (event) => {
		debouncedContainerStatus(event.chapterId);
		broadcastToAll({ type: "container:started", chapterId: event.chapterId });
	});

	eventBus.on("container:stopped", (event) => {
		debouncedContainerStatus(event.chapterId);
		broadcastToAll({ type: "container:stopped", chapterId: event.chapterId });
	});

	eventBus.on("container:paused", (event) => {
		debouncedContainerStatus(event.chapterId);
		broadcastToAll({ type: "container:paused", chapterId: event.chapterId });
	});

	eventBus.on("container:resumed", (event) => {
		debouncedContainerStatus(event.chapterId);
		broadcastToAll({ type: "container:resumed", chapterId: event.chapterId });
	});

	eventBus.on("container:starting", (event) => {
		broadcastToAll({ type: "container:starting", chapterId: event.chapterId });
	});

	eventBus.on("container:log", (event) => {
		broadcastToAll({
			type: "container:log",
			chapterId: event.chapterId,
			line: event.line,
			phase: event.phase,
		});
	});

	eventBus.on("container:error", (event) => {
		broadcastToAll({ type: "container:error", chapterId: event.chapterId, error: event.error });
	});

	// === Overseer replaced ===
	// When an overseer's narrator is archived and a replacement is created,
	// broadcast to all clients so they can refresh their overseer state.

	eventBus.on("overseer:replaced", (event) => {
		broadcastToAll({
			type: "overseer:replaced",
			oldOverseerId: event.oldOverseerId,
			newOverseerId: event.newOverseerId,
			scope: event.scope,
			projectId: event.projectId,
		});
	});

	// === Overseer narrator status sync ===
	// When an overseer's narrator status changes (thinking/waiting/idle/etc.),
	// broadcast to ALL clients so the nav item updates in real-time without
	// requiring the nav to have an active subscription to the overseer narrator.

	eventBus.on("narrator:status_changed", async (event) => {
		const overseer = await db.query.overseers.findFirst({
			where: eq(overseers.narratorId, event.narratorId),
		});
		if (!overseer) return;
		broadcastToAll({
			type: "overseer:status_changed",
			overseerId: overseer.id,
			narratorId: event.narratorId,
			status: event.status,
		});
	});

	// === Recent tabs title sync ===
	// When a narrator title changes, update the stored title in every user's recent_tabs
	// and broadcast a fresh snapshot so the sidebar reflects the new title immediately.

	eventBus.on("narrator:title_updated", async (event) => {
		try {
			const { broadcastTabsSnapshot } = await import("../routes/user-preferences");
			const rows = db
				.select({ userId: userPreferences.userId, recentTabs: userPreferences.recentTabs })
				.from(userPreferences)
				.all();

			for (const row of rows) {
				let tabs: Record<string, unknown>[];
				try {
					tabs = JSON.parse(row.recentTabs);
				} catch {
					continue;
				}
				if (!Array.isArray(tabs)) continue;

				let changed = false;
				for (const tab of tabs) {
					const isMatch =
						(tab.type === "narrator" && tab.id === event.narratorId) ||
						(tab.type === "chapter" && tab.narratorId === event.narratorId);
					if (isMatch && tab.title !== event.title) {
						tab.title = event.title;
						changed = true;
					}
				}
				if (!changed) continue;

				const now = new Date().toISOString();
				sqlite.run(
					`UPDATE user_preferences SET recent_tabs = ?, updated_at = ? WHERE user_id = ?`,
					[JSON.stringify(tabs), now, row.userId],
				);
				broadcastTabsSnapshot(row.userId, tabs);
			}
		} catch (err) {
			logger.error("Failed to sync recent tabs after title update", {
				narratorId: event.narratorId,
				error: String(err),
			});
		}
	});
} // end of hot-reload guard

// === WebSocket handlers ===

export const handleNarratorWS = {
	open(ws: NarratorWS) {
		ws.data.lastPongAt = Date.now();
		connections.add(ws);
	},

	async message(ws: NarratorWS, parsed: NarratorClientMessage) {
		const result = narratorWsMessageSchema.safeParse(parsed);
		if (!result.success) {
			logger.warn("Invalid narrator WS message", {
				error: result.error.message,
				parsed,
			});
			try {
				ws.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
			} catch {
				// connection may be dead
			}
			return;
		}
		const msg = result.data;

		// Update heartbeat timestamp on any valid message
		ws.data.lastPongAt = Date.now();

		switch (msg.type) {
			case "pong":
				// Heartbeat response — lastPongAt already updated above
				break;
			case "subscribe": {
				for (const id of msg.narratorIds) {
					ws.data.subscribedNarrators.add(id);
				}
				// Send streaming snapshot: restore in-progress tool chunks + text
				for (const id of msg.narratorIds) {
					const snap = getStreamingSnapshot(id);
					if (!snap) continue;
					const hasStreaming = snap.streamingBlocks.length > 0 || snap.toolChunks.size > 0;
					if (!hasStreaming && !hasQueue) continue;
					try {
						if (hasStreaming) {
							ws.send(
								JSON.stringify({
									type: "streaming_snapshot",
									narratorId: id,
									streamingBlocks: snap.streamingBlocks,
									toolChunks: [...snap.toolChunks.values()],
								}),
							);
						}
						if (hasQueue) {
							ws.send(
								JSON.stringify({
									narratorId: id,
								}),
							);
						}
					} catch {
						connections.delete(ws);
					}
				}
				// Catch-up: send messages the client missed while disconnected
				if (msg.lastMessageId && msg.narratorIds.length === 1) {
					const narratorId = msg.narratorIds[0];
					Promise.all([
						narratorService.getMessagesAfter(narratorId, msg.lastMessageId),
						narratorService.getMessageVersion(narratorId),
					])
						.then(([{ topLevel, orphanChildren, hitLimit }, version]) => {
							// Connection may have been removed while the async query ran
							if (!connections.has(ws)) return;
							// Too many missed messages or reference not found — tell client to reload
							if (hitLimit) {
								try {
									ws.send(JSON.stringify({ type: "full_reload", narratorId }));
								} catch {
									connections.delete(ws);
								}
								return;
							}
							if (topLevel.length === 0 && orphanChildren.length === 0) {
								// No new messages — send sync_ok with current version
								try {
									ws.send(
										JSON.stringify({
											type: "sync_ok",
											narratorId,
											version,
										}),
									);
								} catch {
									connections.delete(ws);
								}
								return;
							}
							try {
								ws.send(
									JSON.stringify({
										type: "catch_up",
										narratorId,
										orphanChildren,
										topLevel,
										messageVersion: version,
									}),
								);
							} catch {
								connections.delete(ws);
							}
						})
						.catch((err: unknown) =>
							logger.warn("Failed to send catch-up messages", {
								error: String(err),
							}),
						);
				}
				break;
			}
			case "unsubscribe": {
				for (const id of msg.narratorIds) {
					ws.data.subscribedNarrators.delete(id);
				}
				break;
			}
			case "permission_decision": {
				logger.debug("WS permission_decision received", {
					requestId: msg.requestId,
					decision: msg.decision,
					hasFeedback: !!msg.feedbackText,
					hasAnswers: !!msg.answers,
				});
				resolvePermission(msg.requestId, msg.decision, {
					denyMessage: msg.message,
					answers: msg.answers,
					feedbackText: msg.feedbackText,
					compactAfter: msg.compactAfter,
					updatedPlan: msg.updatedPlan,
					userId: ws.data.userId,
				}).catch((err) => {
					logger.error("Failed to resolve permission", { error: String(err) });
					try {
						ws.send(
							JSON.stringify({
								type: "error",
								message: `Failed to resolve permission: ${String(err)}`,
							}),
						);
					} catch {
						// connection may be dead
					}
				});
				break;
			}
			case "merge_decision": {
				resolveMergeDecision(msg.mergeSessionId, msg.decision).catch((err) => {
					logger.error("Failed to resolve merge decision", { error: String(err) });
					try {
						ws.send(
							JSON.stringify({
								type: "error",
								message: `Failed to resolve merge decision: ${String(err)}`,
							}),
						);
					} catch {
						// connection may be dead
					}
				});
				logger.debug("Merge decision received via WS", {
					mergeSessionId: msg.mergeSessionId,
					decision: msg.decision,
				});
				break;
			}
			case "buffer_message": {
				// Resolve slash commands before buffering
				let bufferText = msg.text;
				let commandText: string | null = null;
				const userId = ws.data.userId;
				if (userId) {
					try {
						const cmdResult = await resolveCommand(bufferText, msg.narratorId, userId);
						if (
							cmdResult.resolved &&
							("loadTool" in cmdResult || "loadToolNotFound" in cmdResult)
						) {
							const locale = await getUserLanguage(userId);
							await handleLoadToolCommand(
								msg.narratorId,
								cmdResult as LoadToolResult | LoadToolNotFound,
								locale,
								userId,
							);
							return;
						}
						if (cmdResult.resolved && "expandedPrompt" in cmdResult) {
							commandText = msg.text;
							bufferText = cmdResult.expandedPrompt;
						}
					} catch (err) {
						logger.warn("Failed to resolve command in buffer message", {
							narratorId: msg.narratorId,
							error: String(err),
						});
					}
				} else {
					logger.warn("Buffer message without userId, skipping command resolution", {
						narratorId: msg.narratorId,
					});
				}
				let bufResult = pushBufferedMessage(
					msg.narratorId,
					bufferText,
					undefined,
					commandText,
					userId,
				);
				// Fallback: try buffering for a running foreground subagent
				let usedSubagent = false;
				if (!bufResult.ok) {
					try {
						const { pushSubagentBufferedMessage } = await import("../services/narrator-subagent");
						bufResult = pushSubagentBufferedMessage(msg.narratorId, bufferText);
						usedSubagent = bufResult.ok;
					} catch {
						// ignore
					}
				}
				if (bufResult.ok) {
					let messages: Array<{ id: string; text: string; bufferedAt: string }>;
					if (usedSubagent) {
						const { getSubagentBufferedMessages } = await import("../services/narrator-subagent");
						messages = toBufferSummary(getSubagentBufferedMessages(msg.narratorId));
					} else {
						messages = toBufferSummary(getBufferedMessages(msg.narratorId));
					}
					broadcastToNarrator(msg.narratorId, {
						type: "buffer_set",
						narratorId: msg.narratorId,
						messages,
					});
				} else {
					try {
						ws.send(
							JSON.stringify({
								type: "error",
								message: "Failed to buffer message: narrator is not active",
							}),
						);
					} catch {
						// connection may be dead
					}
				}
				break;
			}
			case "cancel_buffer": {
				clearBufferedMessages(msg.narratorId);
				try {
					const { clearSubagentBufferedMessages } = await import("../services/narrator-subagent");
					clearSubagentBufferedMessages(msg.narratorId);
				} catch {
					// ignore
				}
				broadcastToNarrator(msg.narratorId, {
					type: "buffer_cleared",
					narratorId: msg.narratorId,
					reason: "cancelled",
				});
				break;
			}
			case "update_buffer": {
				const ok = updateBufferedMessage(msg.narratorId, msg.messageId, msg.text);
				if (ok) {
					const messages = toBufferSummary(getBufferedMessages(msg.narratorId));
					broadcastToNarrator(msg.narratorId, {
						type: "buffer_set",
						narratorId: msg.narratorId,
						messages,
					});
				}
				break;
			}
			case "remove_buffer": {
				const ok = removeBufferedMessage(msg.narratorId, msg.messageId);
				if (ok) {
					const messages = toBufferSummary(getBufferedMessages(msg.narratorId));
					broadcastToNarrator(msg.narratorId, {
						type: "buffer_set",
						narratorId: msg.narratorId,
						messages,
					});
				}
				break;
			}
			case "presence_join": {
				addPresence(ws, msg.narratorId);
				break;
			}
			case "presence_leave": {
				removePresence(ws, msg.narratorId);
				break;
			}
			case "subscribe_stats": {
				if (!ws.data.subscribedStats) {
					ws.data.subscribedStats = true;
					addStatsSubscriber();
				}
				break;
			}
			case "unsubscribe_stats": {
				if (ws.data.subscribedStats) {
					ws.data.subscribedStats = false;
					removeStatsSubscriber();
				}
				break;
			}
			case "sync_check": {
				const narratorId = msg.narratorId;
				narratorService
					.getMessageVersion(narratorId)
					.then((serverVersion) => {
						if (!connections.has(ws)) return;
						if (serverVersion === msg.version) {
							// In sync — cheap ack
							try {
								ws.send(
									JSON.stringify({
										type: "sync_ok",
										narratorId,
										version: serverVersion,
									}),
								);
							} catch {
								connections.delete(ws);
							}
							return;
						}
						// Out of sync — try catch-up if lastMessageId provided
						if (msg.lastMessageId) {
							narratorService
								.getMessagesAfter(narratorId, msg.lastMessageId)
								.then(({ topLevel, orphanChildren, hitLimit }) => {
									if (!connections.has(ws)) return;
									if (hitLimit) {
										try {
											ws.send(JSON.stringify({ type: "full_reload", narratorId }));
										} catch {
											connections.delete(ws);
										}
										return;
									}
									if (topLevel.length === 0 && orphanChildren.length === 0) {
										// Version mismatch but no new messages — likely a delete/update
										try {
											ws.send(JSON.stringify({ type: "full_reload", narratorId }));
										} catch {
											connections.delete(ws);
										}
										return;
									}
									try {
										ws.send(
											JSON.stringify({
												type: "catch_up",
												narratorId,
												orphanChildren,
												topLevel,
												messageVersion: serverVersion,
											}),
										);
									} catch {
										connections.delete(ws);
									}
								})
								.catch((err: unknown) =>
									logger.warn("sync_check catch-up failed", { error: String(err) }),
								);
						} else {
							// No lastMessageId — full reload
							try {
								ws.send(JSON.stringify({ type: "full_reload", narratorId }));
							} catch {
								connections.delete(ws);
							}
						}
					})
					.catch((err: unknown) => logger.warn("sync_check failed", { error: String(err) }));
				break;
			}
		}
	},

	close(ws: NarratorWS) {
		if (ws.data.subscribedStats) {
			ws.data.subscribedStats = false;
			removeStatsSubscriber();
		}
		removeAllPresence(ws);
		connections.delete(ws);
	},
};
