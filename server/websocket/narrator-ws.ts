import type { CatchUpCursor } from "@shared/narrator-catch-up";
import type { ServerWebSocket } from "bun";
import { and, count as countFn, eq } from "drizzle-orm";
import { db } from "../db";
import { containerInstances, narrators, narratorToolCalls, terminals } from "../db/schema";
import { updateBashTimeout } from "../lib/agent/tools/bash";
import { listSessions as listBrowserSessions } from "../lib/browser/session";
import { CONTAINER_STATUS_PRIORITY } from "../lib/constants";
import { eventBus } from "../lib/event-bus";
import { hotOnce } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { getUserLanguage } from "../lib/prompt-i18n";
import { narratorWsMessageSchema } from "../lib/validators";
import { type MergeDecision, resolveMergeDecision } from "../services/chapter-batch-merge";
import type {
	LoadToolNotFound,
	LoadToolResult,
	UnloadToolNotFound,
	UnloadToolResult,
} from "../services/command-service";
import { resolveCommand } from "../services/command-service";
import { getStreamingSnapshot } from "../services/narrator-event-handler";
import {
	handleLoadToolCommand,
	handleUnloadToolCommand,
	narratorService,
} from "../services/narrator-service";
import {
	clearBufferedMessages,
	getBufferedMessages,
	pushBufferedMessage,
	removeBufferedMessage,
	resolvePermissionOrDangerReflection,
	toBufferSummary,
	updateBufferedMessage,
} from "../services/narrator-session";
import { addStatsSubscriber, removeStatsSubscriber } from "../services/output-stats";
import type { NarratorServerMessage } from "./narrator-ws-types";
import type { WSData } from "./ws-handler";

// Re-export the type so existing `import { NarratorServerMessage } from "../websocket/narrator-ws"` keeps working
export type { NarratorServerMessage } from "./narrator-ws-types";

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

// Client → Server messages
export type NarratorClientMessage =
	| { type: "pong" }
	| {
			type: "subscribe";
			narratorIds: string[];
			lastMessageId?: string;
			catchUpCursor?: CatchUpCursor;
	  }
	| { type: "unsubscribe"; narratorIds: string[] }
	| {
			type: "permission_decision";
			requestId: string;
			decision: "allow" | "deny";
			message?: string;
			answers?: Record<string, string>;
			feedbackText?: string;
			compactAfter?: boolean;
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
	| {
			type: "sync_check";
			narratorId: string;
			version: number;
			lastMessageId?: string;
			catchUpCursor?: CatchUpCursor;
	  }
	| { type: "update_timeout"; narratorId: string; toolUseId: string; timeoutMs: number };

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
	// Mirror to eventBus so non-WS consumers (e.g. IM gateway) can react.
	eventBus.emit({ type: "narrator:message_broadcast", narratorId, message });
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
			broadcastTerminalCount(narratorId).catch(() => {});
		}, 100),
	);
}

/**
 * When a terminal is created/exited via chapterId (without narratorId),
 * broadcast terminal_count_changed to all narrators bound to that chapter.
 */
async function broadcastTerminalCountByChapter(chapterId: string) {
	const chapterNarrators = await db.query.narrators.findMany({
		where: eq(narrators.chapterId, chapterId),
		columns: { id: true },
	});
	for (const n of chapterNarrators) {
		broadcastTerminalCount(n.id);
	}
}

const pendingChapterTerminalBroadcasts = new Map<string, ReturnType<typeof setTimeout>>();

function debouncedChapterTerminalCount(chapterId: string | null) {
	if (!chapterId) return;
	const existing = pendingChapterTerminalBroadcasts.get(chapterId);
	if (existing) clearTimeout(existing);
	pendingChapterTerminalBroadcasts.set(
		chapterId,
		setTimeout(() => {
			pendingChapterTerminalBroadcasts.delete(chapterId);
			broadcastTerminalCountByChapter(chapterId).catch(() => {});
		}, 100),
	);
}

// === Browser session count change listener ===

const pendingBrowserBroadcasts = new Map<string, ReturnType<typeof setTimeout>>();

function broadcastBrowserSessionCount(narratorId: string) {
	const count = listBrowserSessions(narratorId).length;
	broadcastToNarrator(narratorId, {
		type: "browser_session_count",
		narratorId,
		activeBrowserSessions: count,
	});
}

function debouncedBrowserSessionCount(narratorId: string) {
	const existing = pendingBrowserBroadcasts.get(narratorId);
	if (existing) clearTimeout(existing);
	pendingBrowserBroadcasts.set(
		narratorId,
		setTimeout(() => {
			pendingBrowserBroadcasts.delete(narratorId);
			broadcastBrowserSessionCount(narratorId);
		}, 100),
	);
}

// === Browser session visual change listener ===

const pendingBrowserVisualBroadcasts = new Map<string, ReturnType<typeof setTimeout>>();

function debouncedBrowserVisualChange(narratorId: string, sessionId: string) {
	const key = `${narratorId}:${sessionId}`;
	const existing = pendingBrowserVisualBroadcasts.get(key);
	if (existing) clearTimeout(existing);
	pendingBrowserVisualBroadcasts.set(
		key,
		setTimeout(() => {
			pendingBrowserVisualBroadcasts.delete(key);
			broadcastToNarrator(narratorId, {
				type: "browser_session_visual_change",
				narratorId,
				sessionId,
			});
		}, 300),
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
			broadcastContainerStatus(chapterId).catch(() => {});
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
		debouncedChapterTerminalCount(event.chapterId);
	});

	eventBus.on("terminal:exited", (event) => {
		debouncedTerminalCount(event.narratorId);
		debouncedChapterTerminalCount(event.chapterId);
	});

	eventBus.on("browser:session_created", (event) => {
		debouncedBrowserSessionCount(event.narratorId);
	});

	eventBus.on("browser:session_closed", (event) => {
		debouncedBrowserSessionCount(event.narratorId);
	});

	eventBus.on("browser:session_updated", (event) => {
		debouncedBrowserSessionCount(event.narratorId);
	});

	eventBus.on("browser:session_visual_change", (event) => {
		debouncedBrowserVisualChange(event.narratorId, event.sessionId);
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

	// === Narrator WS broadcast (peripheral services emit this to decouple) ===
	eventBus.on("narrator:ws_broadcast", (event) => {
		broadcastToNarrator(event.narratorId, event.message);
	});

	// === Batch merge progress broadcast ===
	eventBus.onAny((event) => {
		if (!event.type.startsWith("merge:")) return;
		broadcastToAll(event as unknown as Record<string, unknown>);
	});

	// === Codex quota overview broadcast ===
	eventBus.on("codex:quota_overview_updated", (event) => {
		broadcastToAll({ type: "codex_quota_overview_updated", overview: event.overview });
	});

	// === Recent tabs title sync ===
	// Keep the actual JSON read-modify-write in user-preferences-service so every
	// recent-tabs writer shares the same per-user lock.
	eventBus.on("narrator:title_updated", async (event) => {
		try {
			const { syncNarratorTitleToRecentTabs } = await import(
				"../services/user-preferences-service"
			);
			await syncNarratorTitleToRecentTabs(event.narratorId, event.title);
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
				// Determine which narrator needs async catch-up so we can defer
				// its subscription until after the catch-up is sent.  This prevents
				// real-time broadcasts (permission_request, message, etc.) from
				// arriving before the historical catch-up messages, which would
				// cause the frontend to display messages out of order.
				const catchUpAnchor =
					msg.narratorIds.length === 1 ? (msg.catchUpCursor ?? msg.lastMessageId) : undefined;
				const catchUpNarratorId = catchUpAnchor ? msg.narratorIds[0] : undefined;

				for (const id of msg.narratorIds) {
					if (id === catchUpNarratorId) continue; // deferred — added after catch-up
					ws.data.subscribedNarrators.add(id);
				}
				// Send streaming snapshot: restore in-progress tool chunks + text
				for (const id of msg.narratorIds) {
					const snap = getStreamingSnapshot(id);
					if (!snap) continue;
					const hasStreaming = snap.streamingBlocks.length > 0 || snap.toolChunks.size > 0;
					const hasQueueMessage = !!snap.queueMessage;
					if (!hasStreaming && !hasQueue && !hasQueueMessage) continue;
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
						if (hasQueueMessage) {
							ws.send(
								JSON.stringify({
									type: "queue_status",
									narratorId: id,
									queueMessage: snap.queueMessage,
								}),
							);
						} else if (hasQueue) {
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
				// Send initial browser session count so the bar shows after page refresh
				for (const id of msg.narratorIds) {
					const browserCount = listBrowserSessions(id).length;
					if (browserCount > 0) {
						try {
							ws.send(
								JSON.stringify({
									type: "browser_session_count",
									narratorId: id,
									activeBrowserSessions: browserCount,
								}),
							);
						} catch {
							connections.delete(ws);
						}
					}
				}
				// Catch-up: send messages the client missed while disconnected.
				// The narrator is NOT yet in subscribedNarrators, so broadcastToNarrator
				// won't send real-time events to this ws until catch-up completes.
				if (catchUpNarratorId && catchUpAnchor) {
					const narratorId = catchUpNarratorId;
					const anchor = catchUpAnchor;
					Promise.all([
						narratorService.getMessagesAfter(narratorId, anchor),
						narratorService.getMessageVersion(narratorId),
					])
						.then(async ([catchUpResult, version]) => {
							const { topLevel, orphanChildren, hitLimit, cursor } = catchUpResult;
							// Connection may have been removed while the async query ran
							if (!connections.has(ws)) return;
							// Too many missed messages or reference not found — tell client to reload
							if (hitLimit) {
								ws.data.subscribedNarrators.add(narratorId);
								try {
									ws.send(JSON.stringify({ type: "full_reload", narratorId }));
								} catch {
									connections.delete(ws);
								}
								return;
							}

							try {
								if (topLevel.length === 0 && orphanChildren.length === 0) {
									ws.send(
										JSON.stringify({
											type: "sync_ok",
											narratorId,
											version,
										}),
									);
								} else {
									ws.send(
										JSON.stringify({
											type: "catch_up",
											narratorId,
											orphanChildren,
											topLevel,
											cursor,
											messageVersion: version,
										}),
									);
								}
							} catch {
								connections.delete(ws);
								return;
							}

							// Now subscribe to real-time broadcasts.
							ws.data.subscribedNarrators.add(narratorId);

							// Check if new messages arrived while the catch-up query ran.
							// If the version changed, send an incremental catch-up from the
							// compound cursor so child streams are not dropped.
							try {
								const latestVersion = await narratorService.getMessageVersion(narratorId);
								if (!connections.has(ws)) return;
								if (latestVersion !== version && cursor) {
									const delta = await narratorService.getMessagesAfter(narratorId, cursor);
									if (!connections.has(ws)) return;
									if (delta.hitLimit) {
										ws.send(JSON.stringify({ type: "full_reload", narratorId }));
									} else if (delta.topLevel.length > 0 || delta.orphanChildren.length > 0) {
										ws.send(
											JSON.stringify({
												type: "catch_up",
												narratorId,
												orphanChildren: delta.orphanChildren,
												topLevel: delta.topLevel,
												cursor: delta.cursor,
												messageVersion: latestVersion,
											}),
										);
									}
								}
							} catch {
								// Non-critical — real-time broadcasts are now active,
								// and the existing sync_check mechanism will reconcile.
							}
						})
						.catch((err: unknown) => {
							// Ensure the narrator is subscribed even on failure so
							// subsequent real-time events are not silently dropped.
							ws.data.subscribedNarrators.add(narratorId);
							logger.warn("Failed to send catch-up messages", {
								error: String(err),
							});
						});
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
				resolvePermissionOrDangerReflection(msg.requestId, msg.decision, {
					denyMessage: msg.message,
					answers: msg.answers,
					feedbackText: msg.feedbackText,
					compactAfter: msg.compactAfter,
					updatedPlan: msg.updatedPlan,
					userId: ws.data.userId,
					decidedBy: "user",
				})
					.then((resolved) => {
						if (resolved) return;
						logger.warn("Permission request not found", {
							requestId: msg.requestId,
							decision: msg.decision,
						});
						try {
							ws.send(
								JSON.stringify({
									type: "error",
									message: "Permission request not found",
								}),
							);
						} catch {
							// ignore send failure
						}
					})
					.catch((err) => {
						logger.error("Failed to resolve permission", { error: String(err) });
						try {
							ws.send(
								JSON.stringify({
									type: "error",
									message: `Failed to resolve permission: ${String(err)}`,
								}),
							);
						} catch {
							// ignore send failure
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
						if (
							cmdResult.resolved &&
							("unloadTool" in cmdResult || "unloadToolNotFound" in cmdResult)
						) {
							const locale = await getUserLanguage(userId);
							await handleUnloadToolCommand(
								msg.narratorId,
								cmdResult as UnloadToolResult | UnloadToolNotFound,
								locale,
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
				let bufResult = await pushBufferedMessage(
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
						// Out of sync — try catch-up if a compound cursor or legacy lastMessageId is provided
						const catchUpAnchor = msg.catchUpCursor ?? msg.lastMessageId;
						if (catchUpAnchor) {
							narratorService
								.getMessagesAfter(narratorId, catchUpAnchor)
								.then(({ topLevel, orphanChildren, hitLimit, cursor }) => {
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
												cursor,
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
			case "update_timeout": {
				const newMs = updateBashTimeout(msg.toolUseId, msg.timeoutMs);
				if (newMs != null) {
					broadcastToNarrator(msg.narratorId, {
						type: "timeout_updated",
						narratorId: msg.narratorId,
						toolUseId: msg.toolUseId,
						timeoutMs: newMs,
					});
					// Persist the updated timeout into the tool call's inputJson
					// so it survives page refresh.
					try {
						const row = db
							.select({ id: narratorToolCalls.id, inputJson: narratorToolCalls.inputJson })
							.from(narratorToolCalls)
							.where(eq(narratorToolCalls.toolUseId, msg.toolUseId))
							.get();
						if (row) {
							const input = row.inputJson && typeof row.inputJson === "object" ? row.inputJson : {};
							db.update(narratorToolCalls)
								.set({ inputJson: { ...input, timeout: newMs } })
								.where(eq(narratorToolCalls.id, row.id))
								.run();
						}
					} catch (err) {
						logger.warn("Failed to persist updated timeout", {
							toolUseId: msg.toolUseId,
							error: String(err),
						});
					}
				}
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
