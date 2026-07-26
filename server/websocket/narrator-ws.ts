import type { CatchUpCursor } from "@shared/narrator-catch-up";
import {
	NARRATOR_WS_MAX_SUBSCRIPTIONS_PER_CONNECTION,
	NARRATOR_WS_SUBSCRIPTION_LIMIT_ERROR_CODE,
	type NarratorWsSubscriptionLimitError,
	RECENT_TABS_WS_BATCH_SIZE,
} from "@shared/recent-tabs";
import type { ServerWebSocket } from "bun";

export const MAX_NARRATOR_SUBSCRIPTIONS_PER_CONNECTION =
	NARRATOR_WS_MAX_SUBSCRIPTIONS_PER_CONNECTION;

import { and, count as countFn, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { containerInstances, narrators, narratorToolCalls, terminals } from "../db/schema";
import { updateAwaitTimeout } from "../lib/agent/tools/await";
import { updateBashTimeout } from "../lib/agent/tools/bash";
import { listSessions as listBrowserSessions } from "../lib/browser/session";
import { CONTAINER_STATUS_PRIORITY } from "../lib/constants";
import { eventBus } from "../lib/event-bus";
import { hotOnce } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { parseSubstatus } from "../lib/narrator-utils";
import { nugAvailabilityPoller } from "../lib/nug-availability-poller";
import { getUserLanguage } from "../lib/prompt-i18n";
import { narratorWsMessageSchema } from "../lib/validators";
import { type MergeDecision, resolveMergeDecision } from "../services/chapter-batch-merge";
import type {
	BlockAllSkillsResult,
	BlockSkillResult,
	LoadToolNotFound,
	LoadToolResult,
	UnblockAllSkillsResult,
	UnblockSkillResult,
	UnloadToolNotFound,
	UnloadToolResult,
} from "../services/command-service";
import { resolveCommand } from "../services/command-service";
import { getStreamingSnapshot } from "../services/narrator-event-handler";
import {
	handleBlockAllSkillsCommand,
	handleBlockSkillCommand,
	handleLoadToolCommand,
	handleUnblockAllSkillsCommand,
	handleUnblockSkillCommand,
	handleUnloadToolCommand,
	narratorService,
} from "../services/narrator-service";
import {
	clearBufferedMessageSoftStopIfIdle,
	clearBufferedMessages,
	getBufferedMessages,
	pushBufferedMessage,
	removeBufferedMessage,
	resolvePermissionOrDangerReflection,
	toBufferSummary,
	updateBufferedMessage,
} from "../services/narrator-session";
import { addStatsSubscriber, removeStatsSubscriber } from "../services/output-stats";
import {
	bufferRealtimeMessage,
	type CatchUpBuffer,
	collectMessageIds,
	createCatchUpBuffer,
	drainCatchUpBuffer,
} from "./catch-up-buffer";
import {
	createCodexQuotaOverviewWsMessage,
	type NarratorListStateSnapshotItem,
	type NarratorServerMessage,
} from "./narrator-ws-types";
import type { WSData } from "./ws-handler";

// Re-export the type so existing `import { NarratorServerMessage } from "../websocket/narrator-ws"` keeps working
export type { NarratorServerMessage } from "./narrator-ws-types";

// === Types ===

export interface NarratorWSData {
	connectedAt: number;
	lastPongAt: number;
	subscribedNarrators: Set<string>;
	subscribedStats?: boolean;
	/** narratorId → number of in-flight catch-up queries buffering realtime frames. */
	catchingUpNarrators: Map<string, number>;
	catchUpBuffers: Map<string, CatchUpBuffer>;
	userId?: string;
	username?: string;
	avatarColor?: string | null;
	avatarImageId?: string | null;
}

type NarratorSubscriptionKind = "list" | "panel" | "messages";

// Client → Server messages
export type NarratorClientMessage =
	| { type: "pong" }
	| {
			type: "subscribe";
			narratorIds: string[];
			catchUpCursor?: CatchUpCursor;
			kind?: NarratorSubscriptionKind;
			requestId?: string;
			version?: number;
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
			catchUpCursor?: CatchUpCursor;
			kind?: "messages";
			requestId?: string;
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
const connectionsByUserId = new Map<string, Set<NarratorWS>>();

function addConnection(ws: NarratorWS): void {
	connections.add(ws);
	const userId = ws.data.userId;
	if (!userId) return;
	let userConnections = connectionsByUserId.get(userId);
	if (!userConnections) {
		userConnections = new Set();
		connectionsByUserId.set(userId, userConnections);
	}
	userConnections.add(ws);
}

function removeConnection(ws: NarratorWS): void {
	connections.delete(ws);
	const userId = ws.data.userId;
	if (!userId) return;
	const userConnections = connectionsByUserId.get(userId);
	if (!userConnections) return;
	userConnections.delete(ws);
	if (userConnections.size === 0) connectionsByUserId.delete(userId);
}

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
	if (!viewers?.delete(ws)) return;
	if (viewers.size === 0) presenceMap.delete(narratorId);
	broadcastPresence(narratorId);
}

function removeAllPresence(ws: NarratorWS) {
	for (const [narratorId, viewers] of presenceMap) {
		if (!viewers.delete(ws)) continue;
		if (viewers.size === 0) presenceMap.delete(narratorId);
		broadcastPresence(narratorId);
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
			if (ws.data.catchingUpNarrators.has(narratorId)) {
				const buffer = ws.data.catchUpBuffers.get(narratorId);
				if (buffer) {
					bufferRealtimeMessage(buffer, message, payload.length);
					continue;
				}
			}
			try {
				ws.send(payload);
			} catch {
				removeConnection(ws);
			}
		}
	}
	// Mirror to eventBus so non-WS consumers (e.g. IM gateway) can react.
	eventBus.emit({ type: "narrator:message_broadcast", narratorId, message });
}

function withSubscriptionRequestId<T extends Record<string, unknown>>(
	message: T,
	subscriptionRequestId?: string,
): T & { subscriptionRequestId?: string } {
	return subscriptionRequestId ? { ...message, subscriptionRequestId } : message;
}

function safeSend(ws: NarratorWS, message: Record<string, unknown>): boolean {
	try {
		ws.send(JSON.stringify(message));
		return true;
	} catch {
		removeConnection(ws);
		return false;
	}
}

function canAddSubscriptions(ws: NarratorWS, narratorIds: string[]): boolean {
	let additions = 0;
	for (const narratorId of new Set(narratorIds)) {
		if (!ws.data.subscribedNarrators.has(narratorId)) additions += 1;
	}
	if (
		ws.data.subscribedNarrators.size + additions <=
		NARRATOR_WS_MAX_SUBSCRIPTIONS_PER_CONNECTION
	) {
		return true;
	}
	const error = {
		type: "error",
		code: NARRATOR_WS_SUBSCRIPTION_LIMIT_ERROR_CODE,
		message: `Narrator subscription limit exceeded (${NARRATOR_WS_MAX_SUBSCRIPTIONS_PER_CONNECTION})`,
		maxSubscriptions: NARRATOR_WS_MAX_SUBSCRIPTIONS_PER_CONNECTION,
	} satisfies NarratorWsSubscriptionLimitError;
	safeSend(ws, error);
	return false;
}

type NarratorStatusRow = {
	id: string;
	status: string;
	substatus: string | null;
	turnStartedAt: string | null;
};

async function loadStatusRows(narratorIds: string[]): Promise<NarratorStatusRow[]> {
	if (narratorIds.length === 0) return [];
	return db
		.select({
			id: narrators.id,
			status: narrators.status,
			substatus: narrators.substatus,
			turnStartedAt: narrators.turnStartedAt,
		})
		.from(narrators)
		.where(inArray(narrators.id, narratorIds));
}

function toListStateSnapshotItem(row: NarratorStatusRow): NarratorListStateSnapshotItem {
	return {
		narratorId: row.id,
		status: row.status,
		substatus: parseSubstatus(row.substatus),
		turnStartedAt: row.turnStartedAt ?? undefined,
	};
}

// Panel snapshots retain the existing per-narrator status_change behavior.
async function sendStatusSnapshot(ws: NarratorWS, narratorIds: string[]): Promise<void> {
	const rows = await loadStatusRows(narratorIds);
	for (const row of rows) {
		if (!connections.has(ws)) return;
		if (!safeSend(ws, { type: "status_change", ...toListStateSnapshotItem(row) })) return;
	}
}

// List subscriptions are a high-cardinality RecentTabs window. Send bounded
// batches rather than one status_change frame per narrator. These state frames
// intentionally remain unscoped so wildcard list listeners receive reconnects.
async function sendListStateSnapshot(ws: NarratorWS, narratorIds: string[]): Promise<void> {
	for (let offset = 0; offset < narratorIds.length; offset += RECENT_TABS_WS_BATCH_SIZE) {
		if (!connections.has(ws)) return;
		const batchIds = narratorIds.slice(offset, offset + RECENT_TABS_WS_BATCH_SIZE);
		const rows = await loadStatusRows(batchIds);
		const rowsById = new Map(rows.map((row) => [row.id, row]));
		const items = batchIds.flatMap((id) => {
			const row = rowsById.get(id);
			return row ? [toListStateSnapshotItem(row)] : [];
		});
		if (!safeSend(ws, { type: "list_state_snapshot", items })) return;
	}
}

function sendRuntimeSnapshot(ws: NarratorWS, narratorIds: string[], requestId?: string): void {
	for (const id of narratorIds) {
		const snap = getStreamingSnapshot(id);
		const hasQueue = !!snap && (snap.queuePosition != null || !!snap.queueMessage);
		if (hasQueue) {
			if (
				!safeSend(
					ws,
					withSubscriptionRequestId(
						{
							type: "queue_status",
							narratorId: id,
							position: snap.queuePosition,
							queueDepth: snap.queueDepth ?? 0,
							queueMessage: snap.queueMessage,
						},
						requestId,
					),
				)
			) {
				return;
			}
		}

		const browserCount = listBrowserSessions(id).length;
		if (browserCount > 0) {
			if (
				!safeSend(
					ws,
					withSubscriptionRequestId(
						{
							type: "browser_session_count",
							narratorId: id,
							activeBrowserSessions: browserCount,
						},
						requestId,
					),
				)
			) {
				return;
			}
		}
	}
}

function sendStreamingSnapshot(ws: NarratorWS, narratorIds: string[], requestId?: string): void {
	for (const id of narratorIds) {
		const snap = getStreamingSnapshot(id);
		if (!snap) continue;
		const hasStreaming = snap.streamingBlocks.length > 0 || snap.toolChunks.size > 0;
		if (!hasStreaming) continue;
		if (
			!safeSend(
				ws,
				withSubscriptionRequestId(
					{
						type: "streaming_snapshot",
						narratorId: id,
						streamingBlocks: snap.streamingBlocks,
						toolChunks: [...snap.toolChunks.values()],
					},
					requestId,
				),
			)
		) {
			return;
		}
	}
}

function beginCatchUp(ws: NarratorWS, narratorId: string): void {
	const depth = ws.data.catchingUpNarrators.get(narratorId) ?? 0;
	ws.data.catchingUpNarrators.set(narratorId, depth + 1);
	if (!ws.data.catchUpBuffers.has(narratorId)) {
		ws.data.catchUpBuffers.set(narratorId, createCatchUpBuffer());
	}
}

/**
 * Decrement the catch-up refcount for this narrator. When the last in-flight
 * catch-up completes, flush buffered realtime frames (skipping ids already sent
 * via catch_up) and clear the buffer. Returns true when overflow forced a reload.
 */
function endCatchUp(ws: NarratorWS, narratorId: string, requestId?: string): boolean {
	const depth = ws.data.catchingUpNarrators.get(narratorId) ?? 0;
	if (depth > 1) {
		ws.data.catchingUpNarrators.set(narratorId, depth - 1);
		return false;
	}
	ws.data.catchingUpNarrators.delete(narratorId);
	const buffer = ws.data.catchUpBuffers.get(narratorId);
	ws.data.catchUpBuffers.delete(narratorId);
	if (!buffer) return false;
	// The client may have unsubscribed while the DB catch-up query was in flight.
	// In that case drop the buffered realtime frames instead of resurrecting the
	// subscription or sending events to a listener that no longer exists.
	if (!ws.data.subscribedNarrators.has(narratorId)) return false;
	const drained = drainCatchUpBuffer(buffer);
	if (drained.overflow) {
		safeSend(ws, withSubscriptionRequestId({ type: "full_reload", narratorId }, requestId));
		return true;
	}
	for (const message of drained.messages) {
		if (!safeSend(ws, message as unknown as Record<string, unknown>)) return false;
	}
	return false;
}

function markCatchUpSent(ws: NarratorWS, narratorId: string, ids: Set<string>): void {
	const buffer = ws.data.catchUpBuffers.get(narratorId);
	if (!buffer) return;
	for (const id of ids) buffer.sentMessageIds.add(id);
}

/**
 * Force this narrator's catch-up window to resolve with a single `full_reload`.
 * Used when catch-up itself hits the limit — endCatchUp then emits exactly one
 * reload and drops buffered realtime frames (the client reloads from scratch),
 * avoiding a redundant reload + stale buffered frames racing the refetch.
 */
function markCatchUpOverflow(ws: NarratorWS, narratorId: string): void {
	const buffer = ws.data.catchUpBuffers.get(narratorId);
	if (buffer) buffer.overflowed = true;
}

async function sendCatchUpForAnchor(
	ws: NarratorWS,
	narratorId: string,
	anchor: CatchUpCursor,
	requestId?: string,
	opts: { emptyResult: "sync_ok" | "full_reload" } = { emptyResult: "sync_ok" },
): Promise<void> {
	// Mark subscribed before the DB query starts so realtime broadcasts that happen
	// during catch-up are buffered and replayed after the historical frame.
	ws.data.subscribedNarrators.add(narratorId);
	beginCatchUp(ws, narratorId);
	try {
		const [catchUpResult, version] = await Promise.all([
			narratorService.getMessagesAfter(narratorId, anchor),
			narratorService.getMessageVersion(narratorId),
		]);
		if (!connections.has(ws)) {
			endCatchUp(ws, narratorId, requestId);
			return;
		}
		if (!ws.data.subscribedNarrators.has(narratorId)) {
			endCatchUp(ws, narratorId, requestId);
			return;
		}

		const { topLevel, orphanChildren, subagentActivities, hitLimit, cursor } = catchUpResult;
		if (hitLimit) {
			markCatchUpOverflow(ws, narratorId);
			endCatchUp(ws, narratorId, requestId);
			return;
		}

		const sentMessageIds = new Set<string>();
		collectMessageIds(topLevel, sentMessageIds);
		collectMessageIds(orphanChildren, sentMessageIds);
		markCatchUpSent(ws, narratorId, sentMessageIds);

		if (topLevel.length === 0 && orphanChildren.length === 0 && subagentActivities.length === 0) {
			if (opts.emptyResult === "full_reload") {
				safeSend(ws, withSubscriptionRequestId({ type: "full_reload", narratorId }, requestId));
				endCatchUp(ws, narratorId, requestId);
				return;
			}
			safeSend(ws, withSubscriptionRequestId({ type: "sync_ok", narratorId, version }, requestId));
		} else {
			safeSend(
				ws,
				withSubscriptionRequestId(
					{
						type: "catch_up",
						narratorId,
						orphanChildren,
						topLevel,
						subagentActivities,
						cursor,
						messageVersion: version,
					},
					requestId,
				),
			);
		}

		try {
			const latestVersion = await narratorService.getMessageVersion(narratorId);
			if (connections.has(ws) && latestVersion !== version && cursor) {
				const delta = await narratorService.getMessagesAfter(narratorId, cursor);
				if (connections.has(ws)) {
					if (delta.hitLimit) {
						markCatchUpOverflow(ws, narratorId);
					} else if (
						delta.topLevel.length > 0 ||
						delta.orphanChildren.length > 0 ||
						delta.subagentActivities.length > 0
					) {
						const deltaIds = new Set<string>();
						collectMessageIds(delta.topLevel, deltaIds);
						collectMessageIds(delta.orphanChildren, deltaIds);
						markCatchUpSent(ws, narratorId, deltaIds);
						safeSend(
							ws,
							withSubscriptionRequestId(
								{
									type: "catch_up",
									narratorId,
									orphanChildren: delta.orphanChildren,
									topLevel: delta.topLevel,
									subagentActivities: delta.subagentActivities,
									cursor: delta.cursor,
									messageVersion: latestVersion,
								},
								requestId,
							),
						);
					}
				}
			}
		} catch {
			// Non-critical — buffered realtime frames and future sync_check will reconcile.
		}

		endCatchUp(ws, narratorId, requestId);
	} catch (err) {
		endCatchUp(ws, narratorId, requestId);
		logger.warn("Failed to send catch-up messages", { error: String(err) });
	}
}

/** Broadcast a typed message to every narrator WS connection belonging to one user. */
export function broadcastToUser(userId: string, data: NarratorServerMessage): void {
	const userConnections = connectionsByUserId.get(userId);
	if (!userConnections) return;
	const msg = JSON.stringify(data);
	for (const ws of userConnections) {
		try {
			ws.send(msg);
		} catch {
			removeConnection(ws);
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
			removeConnection(ws);
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

	// Plugin lifecycle is global host state. Broadcast only an invalidation marker;
	// clients must refetch the authenticated, bounded contribution snapshot instead
	// of trusting a potentially stale payload carried over WS.
	eventBus.on("plugin:contributions_changed", (event) => {
		broadcastToAll({
			type: "plugin_contributions_changed",
			revision: event.revision,
			reason: event.reason,
		});
	});

	// === Chat group ready: notify the initiating user so their UI can add a tab ===
	eventBus.on("group:ready", (event) => {
		if (!event.createdBy) return;
		broadcastToUser(event.createdBy, {
			type: "group:ready",
			groupId: event.groupId,
			title: event.title,
		});
	});

	// === Batch merge progress broadcast ===
	eventBus.onAny((event) => {
		if (!event.type.startsWith("merge:")) return;
		broadcastToAll(event as unknown as Record<string, unknown>);
	});

	// === Codex quota overview broadcast ===
	eventBus.on("codex:quota_overview_updated", (event) => {
		broadcastToAll(createCodexQuotaOverviewWsMessage(event.overview));
	});

	// === NUG model availability change broadcast ===
	// When the shared availability poller refreshes a provider's model list
	// (while a narrator waits for a model to recover), notify all clients with a
	// lightweight signal so model pickers can re-fetch and update their
	// disabled/available state. The heavy models+pricing payload is NOT
	// broadcast — clients re-query the `nug/models` endpoint on demand.
	nugAvailabilityPoller.setAvailabilityChangeListener((providerId) => {
		broadcastToAll({ type: "nug_model_availability_changed", providerId });
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
		addConnection(ws);
	},

	async message(ws: NarratorWS, parsed: NarratorClientMessage) {
		const result = narratorWsMessageSchema.safeParse(parsed);
		if (!result.success) {
			logger.warn("Invalid narrator WS message", {
				error: result.error.message,
				parsed,
			});
			safeSend(ws, { type: "error", message: "Invalid message format" });
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
				const kind = msg.kind ?? "messages";
				const requestId = msg.requestId;
				if (!canAddSubscriptions(ws, msg.narratorIds)) break;
				const catchUpAnchor =
					kind === "messages" && msg.narratorIds.length === 1 ? msg.catchUpCursor : undefined;
				const catchUpNarratorId = catchUpAnchor ? msg.narratorIds[0] : undefined;

				// Reserve the full accepted set before any async snapshot/version work so
				// concurrent subscribe frames cannot race past the per-connection limit.
				for (const id of msg.narratorIds) ws.data.subscribedNarrators.add(id);

				if (kind === "list") {
					await sendListStateSnapshot(ws, msg.narratorIds);
				}
				if (kind === "panel") {
					await sendStatusSnapshot(ws, msg.narratorIds);
					sendRuntimeSnapshot(ws, msg.narratorIds, requestId);
				}
				if (kind === "messages") {
					sendStreamingSnapshot(ws, msg.narratorIds, requestId);
				}

				if (catchUpNarratorId && catchUpAnchor) {
					// When the client reports a known messageVersion and it still matches
					// the server, skip the full catch-up query entirely: nothing changed
					// since the client last synced, so a single indexed version read +
					// sync_ok is enough. This makes "switch away and back" cheap on the
					// common path (version unchanged) and avoids the synchronous SQLite
					// tree/hydrate/enrich work blocking the event loop for other narrators.
					if (msg.version != null) {
						const serverVersion = await narratorService
							.getMessageVersion(catchUpNarratorId)
							.catch(() => null);
						if (serverVersion != null && serverVersion === msg.version) {
							// Must subscribe so realtime frames still reach this connection.
							ws.data.subscribedNarrators.add(catchUpNarratorId);
							safeSend(
								ws,
								withSubscriptionRequestId(
									{ type: "sync_ok", narratorId: catchUpNarratorId, version: serverVersion },
									requestId,
								),
							);
							break;
						}
					}
					sendCatchUpForAnchor(ws, catchUpNarratorId, catchUpAnchor, requestId).catch((err) => {
						logger.warn("Failed to send catch-up messages", { error: String(err) });
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
						safeSend(ws, {
							type: "error",
							message: "Permission request not found",
						});
					})
					.catch((err) => {
						logger.error("Failed to resolve permission", { error: String(err) });
						safeSend(ws, {
							type: "error",
							message: `Failed to resolve permission: ${String(err)}`,
						});
					});

				break;
			}
			case "merge_decision": {
				resolveMergeDecision(msg.mergeSessionId, msg.decision).catch((err) => {
					logger.error("Failed to resolve merge decision", { error: String(err) });
					safeSend(ws, {
						type: "error",
						message: `Failed to resolve merge decision: ${String(err)}`,
					});
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
				let preBashCommand: string | null = null;
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
						if (cmdResult.resolved && "blockSkill" in cmdResult) {
							const locale = await getUserLanguage(userId);
							await handleBlockSkillCommand(msg.narratorId, cmdResult as BlockSkillResult, locale);
							return;
						}
						if (cmdResult.resolved && "blockAllSkills" in cmdResult) {
							const locale = await getUserLanguage(userId);
							await handleBlockAllSkillsCommand(
								msg.narratorId,
								cmdResult as BlockAllSkillsResult,
								locale,
							);
							return;
						}
						if (cmdResult.resolved && "unblockSkill" in cmdResult) {
							const locale = await getUserLanguage(userId);
							await handleUnblockSkillCommand(
								msg.narratorId,
								cmdResult as UnblockSkillResult,
								locale,
							);
							return;
						}
						if (cmdResult.resolved && "unblockAllSkills" in cmdResult) {
							const locale = await getUserLanguage(userId);
							await handleUnblockAllSkillsCommand(
								msg.narratorId,
								cmdResult as UnblockAllSkillsResult,
								locale,
							);
							return;
						}
						if (cmdResult.resolved && "expandedPrompt" in cmdResult) {
							commandText = msg.text;
							bufferText = cmdResult.expandedPrompt;
							if ("bashCommand" in cmdResult && cmdResult.bashCommand) {
								preBashCommand = cmdResult.bashCommand;
							}
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
					undefined,
					undefined,
					undefined,
					preBashCommand,
				);
				// Fallback: try buffering for a running foreground subagent
				let usedSubagent = false;
				if (!bufResult.ok) {
					try {
						const { bufferSubagentUserMessage, isTakenOver } = await import(
							"../services/narrator-subagent"
						);
						bufResult = bufferSubagentUserMessage(msg.narratorId, bufferText, {
							commandText,
							createdBy: userId,
							requestSoftStop: !isTakenOver(msg.narratorId),
						});
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
					safeSend(ws, {
						type: "error",
						message: "Failed to buffer message: narrator is not active",
					});
				}
				break;
			}
			case "cancel_buffer": {
				clearBufferedMessages(msg.narratorId);
				// Cancelling queued input must also drop a pending post-tool soft stop,
				// otherwise the running turn ends at the next tool boundary with nothing
				// to resume (clearSubagentBufferedMessages does this for subagents).
				clearBufferedMessageSoftStopIfIdle(msg.narratorId);
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
					clearBufferedMessageSoftStopIfIdle(msg.narratorId);
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
				const requestId = msg.requestId;
				const serverVersion = await narratorService
					.getMessageVersion(narratorId)
					.catch((err: unknown) => {
						logger.warn("sync_check failed", { error: String(err) });
						return null;
					});
				if (serverVersion == null || !connections.has(ws)) return;
				if (!ws.data.subscribedNarrators.has(narratorId)) break;
				if (serverVersion === msg.version) {
					safeSend(
						ws,
						withSubscriptionRequestId(
							{ type: "sync_ok", narratorId, version: serverVersion },
							requestId,
						),
					);
					break;
				}
				const catchUpAnchor = msg.catchUpCursor;
				if (catchUpAnchor) {
					// Empty catch-up result (version bumped but no new top-level/child
					// message since the anchor — e.g. a tool result written into an
					// existing message) resolves with sync_ok, not full_reload: the
					// connection is still subscribed and any structural change (delete /
					// compact) already arrives via its own realtime broadcast. A truly
					// unresolvable anchor still falls back to full_reload via the hitLimit
					// path inside sendCatchUpForAnchor.
					sendCatchUpForAnchor(ws, narratorId, catchUpAnchor, requestId).catch((err: unknown) =>
						logger.warn("sync_check catch-up failed", { error: String(err) }),
					);
				} else {
					safeSend(ws, withSubscriptionRequestId({ type: "full_reload", narratorId }, requestId));
				}
				break;
			}
			case "update_timeout": {
				// Bash and Await both maintain live-timeout registries keyed by toolUseId;
				// only one will match a given running tool.
				const newMs =
					updateBashTimeout(msg.toolUseId, msg.timeoutMs) ??
					updateAwaitTimeout(msg.toolUseId, msg.timeoutMs);
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
		ws.data.catchingUpNarrators?.clear();
		ws.data.catchUpBuffers?.clear();
		removeConnection(ws);
	},
};
