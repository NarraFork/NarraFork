import type { ServerWebSocket } from "bun";
import { and, count as countFn, eq } from "drizzle-orm";
import { db } from "../db";
import { containerInstances, narrators, terminals } from "../db/schema";
import { CONTAINER_STATUS_PRIORITY } from "../lib/constants";
import { eventBus, type NarraForkEvent } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { narratorWsMessageSchema } from "../lib/validators";
import { type MergeDecision, resolveMergeDecision } from "../services/chapter-batch-merge";
import { resolveCommand } from "../services/command-service";
import type { GitStatusSummary } from "../services/git-service";
import { narratorService } from "../services/narrator-service";
import {
	clearBufferedMessage,
	resolvePermission,
	setBufferedMessage,
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
}

// Server → Client messages
export type NarratorServerMessage =
	| { type: "message"; narratorId: string; message: unknown }
	| { type: "stream_event"; narratorId: string; event: unknown }
	| { type: "permission_request"; narratorId: string; request: unknown }
	| { type: "status_change"; narratorId: string; status: string }
	| { type: "tool_progress"; narratorId: string; toolUseId: string; elapsed: number }
	| { type: "tool_output"; narratorId: string; toolUseId: string; output: string }
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
	| { type: "permission_resolved"; narratorId: string; requestId: string; toolUseId?: string }
	| { type: "todos_updated"; narratorId: string; todos: unknown[]; toolUseId?: string }
	| { type: "buffer_set"; narratorId: string; text: string; bufferedAt: string }
	| { type: "buffer_cleared"; narratorId: string; reason: "cancelled" | "sent" | "narrator_error" }
	| { type: "plan_mode_changed"; narratorId: string; planMode: boolean }
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
	// Narrator fork events forwarded via eventBus.onAny
	| { type: "narrator:forked"; narratorId: string; parentNarratorId: string }
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
	  }
	| {
			type: "subagent_started";
			narratorId: string;
			subagentNarratorId: string;
			toolUseId: string;
			subagentType: string;
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
	| { type: "auto_commit_started"; narratorId: string; chapterId: string }
	| {
			type: "auto_commit_done";
			narratorId: string;
			chapterId: string;
			commitSha: string;
			message: string;
	  }
	| { type: "auto_commit_failed"; narratorId: string; chapterId: string; error: string }
	| {
			type: "commit_reminder";
			narratorId: string;
			chapterId: string;
			linesAdded: number;
			linesRemoved: number;
			filesChanged: number;
	  }
	| {
			type: "force_commit_done";
			narratorId: string;
			chapterId: string;
			commitSha: string;
			message: string;
			linesAdded: number;
			linesRemoved: number;
			filesChanged: number;
	  }
	| {
			type: "catch_up";
			narratorId: string;
			orphanChildren: unknown[];
			topLevel: unknown[];
	  }
	| { type: "error"; message: string }
	| { type: "warning"; narratorId: string; message: string }
	| { type: "context_length_exceeded"; narratorId: string }
	| { type: "full_reload"; narratorId: string }
	| { type: "commits_updated"; narratorId: string; chapterId: string; newCount: number }
	| {
			type: "presence_update";
			narratorId: string;
			viewers: Array<{ userId: string; username: string; avatarColor: string | null }>;
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
	  };

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
	  }
	| {
			type: "merge_decision";
			mergeSessionId: string;
			decision: MergeDecision;
	  }
	| { type: "buffer_message"; narratorId: string; text: string }
	| { type: "cancel_buffer"; narratorId: string }
	| { type: "presence_join"; narratorId: string }
	| { type: "presence_leave"; narratorId: string }
	| { type: "subscribe_stats" }
	| { type: "unsubscribe_stats" };

// === Connection registry ===

type NarratorWS = ServerWebSocket<WSData & { channel: "narrator" }>;

const connections = new Set<NarratorWS>();

// === Presence tracking ===
// Map<narratorId, Map<wsInstance, { userId, username, avatarColor }>>
const presenceMap = new Map<
	string,
	Map<NarratorWS, { userId: string; username: string; avatarColor: string | null }>
>();

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
	// Deduplicate by userId
	const uniqueViewers = new Map<
		string,
		{ userId: string; username: string; avatarColor: string | null }
	>();
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
export function getNarratorPresence(
	narratorId: string,
): Array<{ userId: string; username: string; avatarColor: string | null }> {
	const viewers = presenceMap.get(narratorId);
	if (!viewers) return [];
	const unique = new Map<
		string,
		{ userId: string; username: string; avatarColor: string | null }
	>();
	for (const v of viewers.values()) unique.set(v.userId, v);
	return [...unique.values()];
}

/** Get presence for multiple narrators at once (batch). */
export function getNarratorPresenceBatch(
	narratorIds: string[],
): Map<string, Array<{ userId: string; username: string; avatarColor: string | null }>> {
	const result = new Map<
		string,
		Array<{ userId: string; username: string; avatarColor: string | null }>
	>();
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

/**
 * Events that are already pushed to WS clients via broadcastToNarrator()
 * in narrator-session.ts / narrator-title.ts. Forwarding them again from
 * the event bus would cause duplicate delivery.
 */
const ALREADY_BROADCAST_EVENTS = new Set([
	"narrator:message",
	"narrator:permission_request",
	"narrator:title_updated",
	"narrator:subagent_started",
	"narrator:subagent_completed",
	"user:recent_tabs_changed",
	"terminal:created",
	"terminal:exited",
	"container:started",
	"container:stopped",
	"container:paused",
	"container:resumed",
]);

function shouldForwardEvent(event: NarraForkEvent): boolean {
	if (ALREADY_BROADCAST_EVENTS.has(event.type)) return false;
	return (
		event.type.startsWith("narrator:") ||
		event.type.startsWith("chapter:") ||
		event.type.startsWith("merge:") ||
		event.type.startsWith("container:") ||
		event.type.startsWith("user:")
	);
}

function eventToNarratorId(event: NarraForkEvent): string | null {
	if ("narratorId" in event) return event.narratorId;
	return null;
}

eventBus.onAny((event) => {
	if (!shouldForwardEvent(event)) return;

	const narratorId = eventToNarratorId(event);

	for (const ws of connections) {
		// If event has a narratorId, only send to subscribers of that narrator
		// Otherwise (chapter/merge events), broadcast to all narrator WS clients
		if (narratorId && !ws.data.subscribedNarrators.has(narratorId)) continue;

		try {
			ws.send(JSON.stringify(event));
		} catch {
			connections.delete(ws);
		}
	}
});

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

// === Terminal count change listener ===
// When a terminal is created or exits, compute the new running count for its narrator
// and broadcast to subscribers.

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

eventBus.on("terminal:created", (event) => {
	broadcastTerminalCount(event.narratorId);
});

eventBus.on("terminal:exited", (event) => {
	broadcastTerminalCount(event.narratorId);
});

// === Container status change listener ===
// When a container starts/stops/pauses/resumes, compute the aggregate status for the chapter
// and broadcast to subscribers of the chapter's narrator.

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

eventBus.on("container:started", (event) => {
	broadcastContainerStatus(event.chapterId);
});

eventBus.on("container:stopped", (event) => {
	broadcastContainerStatus(event.chapterId);
});

eventBus.on("container:paused", (event) => {
	broadcastContainerStatus(event.chapterId);
});

eventBus.on("container:resumed", (event) => {
	broadcastContainerStatus(event.chapterId);
});

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
				// Catch-up: send messages the client missed while disconnected
				if (msg.lastMessageId && msg.narratorIds.length === 1) {
					const narratorId = msg.narratorIds[0];
					narratorService
						.getMessagesAfter(narratorId, msg.lastMessageId)
						.then(({ topLevel, orphanChildren, hitLimit }) => {
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
							if (topLevel.length === 0 && orphanChildren.length === 0) return;
							try {
								ws.send(
									JSON.stringify({
										type: "catch_up",
										narratorId,
										orphanChildren,
										topLevel,
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
				resolvePermission(
					msg.requestId,
					msg.decision,
					msg.message,
					msg.answers,
					msg.feedbackText,
					msg.compactAfter,
				).catch((err) => logger.error("Failed to resolve permission", { error: String(err) }));
				break;
			}
			case "merge_decision": {
				resolveMergeDecision(msg.mergeSessionId, msg.decision).catch((err) =>
					logger.error("Failed to resolve merge decision", { error: String(err) }),
				);
				logger.debug("Merge decision received via WS", {
					mergeSessionId: msg.mergeSessionId,
					decision: msg.decision,
				});
				break;
			}
			case "buffer_message": {
				// Resolve slash commands before buffering
				let bufferText = msg.text;
				const userId = ws.data.userId;
				if (userId) {
					try {
						const cmdResult = await resolveCommand(bufferText, msg.narratorId, userId);
						if (cmdResult.resolved) {
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
				const bufResult = setBufferedMessage(msg.narratorId, bufferText);
				if (bufResult.ok) {
					broadcastToNarrator(msg.narratorId, {
						type: "buffer_set",
						narratorId: msg.narratorId,
						text: bufferText,
						bufferedAt: bufResult.bufferedAt,
					});
				}
				break;
			}
			case "cancel_buffer": {
				clearBufferedMessage(msg.narratorId);
				broadcastToNarrator(msg.narratorId, {
					type: "buffer_cleared",
					narratorId: msg.narratorId,
					reason: "cancelled",
				});
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
