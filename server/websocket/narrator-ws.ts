import { HUMAN_ATTENTION_CHANGED_WS_TYPE } from "@shared/human-attention";
import type { CatchUpCursor } from "@shared/narrator-catch-up";
import { NOTIFICATION_CENTER_CHANGED_WS_TYPE } from "@shared/notification-center";
import {
	TEXT_DOCUMENT_PACKET_BYTES,
	TEXT_DOCUMENT_PAGE_CHARS,
} from "@shared/pretext-layout/text-document";
import {
	NARRATOR_WS_MAX_SUBSCRIPTIONS_PER_CONNECTION,
	NARRATOR_WS_SUBSCRIPTION_LIMIT_ERROR_CODE,
	type NarratorWsSubscriptionLimitError,
	RECENT_TABS_WS_BATCH_SIZE,
} from "@shared/recent-tabs";
import type { ServerWebSocket } from "bun";
import {
	measureSerializedCharacters,
	queueContextCharacterRefresh,
} from "../lib/context-characters";
import { toolInputStreamSource } from "../services/tool-input-stream-source";

export const MAX_NARRATOR_SUBSCRIPTIONS_PER_CONNECTION =
	NARRATOR_WS_MAX_SUBSCRIPTIONS_PER_CONNECTION;

import type { GitWorkspaceClientMessage } from "@shared/git-workspace-events";
import { and, count as countFn, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { narrators, narratorToolCalls, terminals } from "../db/schema";
import { updateAwaitTimeout } from "../lib/agent/tools/await";
import { updateBashTimeout } from "../lib/agent/tools/bash";
import { listSessions as listBrowserSessions } from "../lib/browser/session";
import { eventBus } from "../lib/event-bus";
import { hotOnce, hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { parseSubstatus } from "../lib/narrator-utils";
import { nugAvailabilityPoller } from "../lib/nug-availability-poller";
import { getUserLanguage } from "../lib/prompt-i18n";
import { narratorWsMessageSchema } from "../lib/validators";
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
import { editorFileSubscriptions } from "../services/editor-file-subscription";
import { canReadNarrator, canWriteNarrator, NARRATOR_ACL_COLUMNS } from "../services/narrator-acl";
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
	getBufferedMessagesAsync,
	pushBufferedMessage,
	removeBufferedMessage,
	resolveDecisionNarratorId,
	resolvePermissionOrDangerReflection,
	toBufferSummary,
	updateBufferedMessage,
} from "../services/narrator-session";
import { addStatsSubscriber, removeStatsSubscriber } from "../services/output-stats";
import { permissionPolicyChanges } from "../services/permission-rule-service";
import type { PublicShareConnectionLease } from "../services/public-narrator-share-connections";
import {
	isPublicToolSourceAllowed,
	projectPublicNarratorEvent,
	rememberPublicToolIdentity,
} from "../services/public-narrator-share-gen-ui";
import {
	onPublicShareRevoked,
	revalidatePublicShare,
	type VerifiedPublicShare,
} from "../services/public-narrator-share-service";
import {
	bufferRealtimeMessage,
	type CatchUpBuffer,
	collectMessageIds,
	createCatchUpBuffer,
	drainCatchUpBuffer,
} from "./catch-up-buffer";
import { handleEditorFileMessage, releaseEditorFileSubscriptions } from "./editor-file-ws";
import { handleGitWorkspaceMessage, releaseGitWorkspaceSubscriptions } from "./git-workspace-ws";
import { projectNarratorActivityEvent } from "./narrator-activity-projection";
import {
	toBlockCatchUp,
	toBlockFrames,
	toBlockSnapshot,
	toolOpened,
} from "./narrator-block-protocol";
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
	/**
	 * Subset of `subscribedNarrators` watched only at activity level: they receive
	 * the {@link projectNarratorActivityEvent} projection instead of the full stream.
	 * The client owns the level (it ref-counts its handles): an `activity` subscribe
	 * sets it, any other kind clears it.
	 */
	activityOnlyNarrators?: Set<string>;
	subscribedStats?: boolean;
	/** narratorId → number of in-flight catch-up queries buffering realtime frames. */
	catchingUpNarrators: Map<string, number>;
	catchUpBuffers: Map<string, CatchUpBuffer>;
	/**
	 * Chat rooms this connection receives live messages for.
	 *
	 * Kept on the narrator channel rather than a new endpoint: this socket already
	 * carries the user identity, heartbeat and session-expiry eviction that a chat
	 * channel would otherwise have to reimplement.
	 */
	subscribedChatRooms: Set<string>;
	userId?: string;
	sessionId?: string;
	sessionExp?: number;
	username?: string;
	avatarColor?: string | null;
	avatarImageId?: string | null;
	/**
	 * Live role, for the admin short-circuit in narrator authorization. Captured at
	 * upgrade and refreshed whenever the user's authorization changes (see
	 * `revalidateSessionSockets`). Absent on connections whose user row could not be
	 * resolved, which are treated as non-admin.
	 */
	userRole?: string;
	/**
	 * Anonymous public-share reader. When present the connection carries NO user
	 * identity: narrator subscribe is scoped to exactly this share's narrator,
	 * chat subscribe to exactly its discussion room, and write frames stay
	 * refused by the existing `!userId` guard (read-only by construction).
	 * Revalidated at subscribe time; a revocation closes the socket.
	 */
	publicShare?: VerifiedPublicShare;
	publicShareConnectionLease?: PublicShareConnectionLease;
}

type NarratorSubscriptionKind = "list" | "panel" | "messages" | "activity";

// Client → Server messages
export type NarratorClientMessage =
	| GitWorkspaceClientMessage
	| import("@shared/editor-file-events").EditorFileClientMessage
	| { type: "pong" }
	| {
			type: "subscribe";
			narratorIds: string[];
			catchUpCursor?: CatchUpCursor;
			kind?: NarratorSubscriptionKind;
			requestId?: string;
			version?: number;
			/** `activity` only: lower narrators already streamed in full (see subscribe). */
			downgrade?: boolean;
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
	| { type: "buffer_message"; narratorId: string; text: string }
	| { type: "cancel_buffer"; narratorId: string }
	| { type: "update_buffer"; narratorId: string; messageId: string; text: string }
	| { type: "remove_buffer"; narratorId: string; messageId: string }
	| { type: "presence_join"; narratorId: string }
	| { type: "presence_leave"; narratorId: string }
	| { type: "chat_subscribe"; roomIds: string[] }
	| { type: "chat_unsubscribe"; roomIds: string[] }
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

const connections = hotSafe("narrafork.narratorWs.connections", () => new Set<NarratorWS>());
const connectionsByUserId = hotSafe(
	"narrafork.narratorWs.connectionsByUserId",
	() => new Map<string, Set<NarratorWS>>(),
);

// A revoked share link drops its open sockets immediately rather than waiting
// for the next revalidation: the revoke listener fires post-commit, and closing
// here is the only place that sees the live connection set.
onPublicShareRevoked((shareId) => {
	for (const ws of connections) {
		if (ws.data.publicShare?.shareId !== shareId) continue;
		toolInputLaneSender.close(ws);
		try {
			ws.close(4001, "Share link revoked");
		} catch {
			// An already-closing socket is the outcome we wanted anyway.
		}
	}
});

function addConnection(ws: NarratorWS): void {
	connections.add(ws);
	const userId = ws.data.userId;
	if (!userId || ws.data.publicShare) return;
	let userConnections = connectionsByUserId.get(userId);
	if (!userConnections) {
		userConnections = new Set();
		connectionsByUserId.set(userId, userConnections);
	}
	userConnections.add(ws);
}

function removeConnection(ws: NarratorWS): void {
	toolInputLaneSender.close(ws);
	ws.data.publicShareConnectionLease?.release();
	removeAllChatSubscriptions(ws);
	releaseGitWorkspaceSubscriptions(ws);
	releaseEditorFileSubscriptions(ws);
	const removed = connections.delete(ws);
	if (removed && ws.data.publicShare) {
		try {
			ws.close(1001, "Share connection closed");
		} catch {
			/* Already closed. */
		}
	}
	const userId = ws.data.userId;
	if (!userId || ws.data.publicShare) return;
	const userConnections = connectionsByUserId.get(userId);
	if (!userConnections) return;
	userConnections.delete(ws);
	if (userConnections.size === 0) connectionsByUserId.delete(userId);
}

// === Chat room subscriptions ===
//
// A reverse index so delivering one chat message walks only that room's
// subscribers instead of the whole connection set (which is what
// `broadcastToNarrator` has to do, and what makes `broadcastToAll` expensive).
//
// Authorization happens exactly once, at subscribe time (`assertCanRead`). That
// is sufficient because neither room kind's readable set changes over time: a DM's
// two members are fixed at creation, and a narrator room follows the narrator's
// visibility. ⚠️ If leaving/kicking is ever added, that path MUST also evict the
// user's sockets from this index.
const chatRoomSubscribers = hotSafe(
	"narrafork.narratorWs.chatRoomSubscribers",
	() => new Map<string, Set<NarratorWS>>(),
);

/** Per-connection ceiling, mirroring the narrator subscription cap's intent. */
export const MAX_CHAT_ROOM_SUBSCRIPTIONS_PER_CONNECTION = 50;

function addChatSubscription(ws: NarratorWS, roomId: string): void {
	ws.data.subscribedChatRooms.add(roomId);
	let subscribers = chatRoomSubscribers.get(roomId);
	if (!subscribers) {
		subscribers = new Set();
		chatRoomSubscribers.set(roomId, subscribers);
	}
	subscribers.add(ws);
}

function removeChatSubscription(ws: NarratorWS, roomId: string): void {
	ws.data.subscribedChatRooms.delete(roomId);
	const subscribers = chatRoomSubscribers.get(roomId);
	if (!subscribers) return;
	subscribers.delete(ws);
	if (subscribers.size === 0) chatRoomSubscribers.delete(roomId);
}

function removeAllChatSubscriptions(ws: NarratorWS): void {
	for (const roomId of ws.data.subscribedChatRooms ?? []) {
		const subscribers = chatRoomSubscribers.get(roomId);
		if (!subscribers) continue;
		subscribers.delete(ws);
		if (subscribers.size === 0) chatRoomSubscribers.delete(roomId);
	}
	ws.data.subscribedChatRooms?.clear();
}

/** Deliver a chat frame to every connection subscribed to that room. */
export function broadcastToChatRoom(roomId: string, message: NarratorServerMessage): void {
	const subscribers = chatRoomSubscribers.get(roomId);
	if (!subscribers || subscribers.size === 0) return;
	const payload = JSON.stringify(message);
	for (const ws of subscribers) {
		if (ws.data.publicShare && ws.data.publicShare.roomId !== roomId) continue;
		try {
			ws.send(payload);
		} catch {
			removeConnection(ws);
		}
	}
}

/** User ids that currently have this room open (used to skip redundant badge pushes). */
export function getChatRoomSubscriberUserIds(roomId: string): Set<string> {
	const result = new Set<string>();
	const subscribers = chatRoomSubscribers.get(roomId);
	if (!subscribers) return result;
	for (const ws of subscribers) {
		if (ws.data.userId) result.add(ws.data.userId);
	}
	return result;
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

type ToolInputChunkMessage = Extract<NarratorServerMessage, { type: "tool_use_chunk" }>;

/** Split only the recoverable tool-input lane; the raw UTF16 offset, not JSON chars, advances. */
export function* toolInputFrames(message: ToolInputChunkMessage): Generator<string> {
	const update = message.inputDocument;
	if (!update) {
		yield JSON.stringify(message);
		return;
	}
	const field = message.streamingField;
	const delta = field?.delta ?? "";
	const { preview: _preview, ...ref } = update.ref;
	// This lane carries source identity/progress plus a bounded path label, never a second body preview.
	const base = {
		type: message.type,
		narratorId: message.narratorId,
		toolCallId: message.toolCallId,
		toolUseId: message.toolUseId,
		toolName: message.toolName,
		inputCharsTotal: message.inputCharsTotal,
		...(message.parentToolUseId ? { parentToolUseId: message.parentToolUseId } : {}),
		...(message.subagentNarratorId ? { subagentNarratorId: message.subagentNarratorId } : {}),
		...(message.extractedFilePath
			? { extractedFilePath: message.extractedFilePath.slice(0, 4096) }
			: {}),
		...(message.contentCharsReceived != null
			? { contentCharsReceived: message.contentCharsReceived }
			: {}),
		...(message.extractedFields?.file_path
			? { extractedFields: { file_path: message.extractedFields.file_path.slice(0, 4096) } }
			: {}),
	};
	let at = 0;
	do {
		let count = Math.min(TEXT_DOCUMENT_PAGE_CHARS, delta.length - at);
		let payload: string;
		while (true) {
			const last = at + count === delta.length;
			const offset = update.offset + at;
			payload = JSON.stringify({
				...base,
				inputDocument: { ref: { ...ref, complete: last && ref.complete }, offset },
				...(field
					? {
							streamingField: {
								...field,
								delta: delta.slice(at, at + count),
								offset,
								startsField: at === 0 && field.startsField,
								complete: last && field.complete,
							},
						}
					: {}),
			});
			if (
				Buffer.byteLength(payload) <= TEXT_DOCUMENT_PACKET_BYTES &&
				(count > 0 || delta.length === 0)
			)
				break;
			if (!count) throw new Error("Tool input metadata exceeds packet budget");
			count = Math.floor(count / 2);
		}
		yield payload;
		at += count;
	} while (at < delta.length);
}

type InputLaneSocket = Pick<NarratorWS, "send" | "close" | "getBufferedAmount">;
const INPUT_LANE_BACKLOG_BYTES = 256 * 1024;

export interface ToolInputFrameIdentity {
	narratorId: string;
	refId: string;
	epoch: string;
}
interface QueuedToolInputFrame {
	payload: string;
	identity?: ToolInputFrameIdentity;
	bytes: number;
}
interface ToolInputSocketQueue {
	frames: QueuedToolInputFrame[];
	bytes: number;
	blocked: boolean;
	flushing: boolean;
	blockedAt?: number;
	timer?: ReturnType<typeof setTimeout>;
}

/** Bun send(-1) has ALREADY enqueued that frame. Only later unsent frames enter our bounded queue. */
export class ToolInputLaneSender {
	private readonly states = new WeakMap<InputLaneSocket, ToolInputSocketQueue>();
	constructor(
		private readonly maxBytes = INPUT_LANE_BACKLOG_BYTES,
		private readonly revalidate: (
			ws: InputLaneSocket,
			identity: ToolInputFrameIdentity,
		) => boolean | Promise<boolean> = () => true,
	) {}

	close(ws: InputLaneSocket): void {
		const state = this.states.get(ws);
		if (state?.timer) clearTimeout(state.timer);
		this.states.delete(ws);
	}

	clearNarrator(ws: InputLaneSocket, narratorId: string): void {
		const state = this.states.get(ws);
		if (!state) return;
		state.frames = state.frames.filter((frame) => frame.identity?.narratorId !== narratorId);
		state.bytes = state.frames.reduce((bytes, frame) => bytes + frame.bytes, 0);
	}

	private recover(ws: InputLaneSocket): false {
		this.close(ws);
		try {
			ws.close(1013, "Tool input recovery required");
		} catch {
			/* Already closed. */
		}
		return false;
	}

	send(ws: InputLaneSocket, payload: string, identity?: ToolInputFrameIdentity): boolean {
		let state = this.states.get(ws);
		if (!state) {
			state = { frames: [], bytes: 0, blocked: false, flushing: false };
			this.states.set(ws, state);
		}
		const bytes = Buffer.byteLength(payload);
		if (ws.getBufferedAmount() + state.bytes + bytes > this.maxBytes) return this.recover(ws);
		if (state.blocked || state.flushing || state.frames.length) {
			state.frames.push({ payload, identity, bytes });
			state.bytes += bytes;
		} else {
			try {
				const result = ws.send(payload);
				if (result === 0) return this.recover(ws);
				state.blocked = result === -1;
				if (state.blocked) state.blockedAt = Date.now();
			} catch {
				return this.recover(ws);
			}
		}
		this.schedule(ws, state);
		return true;
	}

	private schedule(ws: InputLaneSocket, state: ToolInputSocketQueue): void {
		if (state.flushing || state.timer || (!state.blocked && !state.frames.length)) return;
		state.timer = setTimeout(() => {
			state.timer = undefined;
			void this.flush(ws, state);
		}, 16);
		state.timer.unref?.();
	}

	private async flush(ws: InputLaneSocket, state: ToolInputSocketQueue): Promise<void> {
		if (this.states.get(ws) !== state || state.flushing) return;
		if (state.blockedAt != null && Date.now() - state.blockedAt >= 10_000) {
			this.recover(ws);
			return;
		}
		state.flushing = true;
		try {
			if (ws.getBufferedAmount() !== 0) return;
			state.blocked = false;
			while (state.frames.length && !state.blocked) {
				const frame = state.frames.shift();
				if (!frame) break;
				state.bytes -= frame.bytes;
				if (frame.identity && !(await this.revalidate(ws, frame.identity))) continue;
				if (this.states.get(ws) !== state) return;
				const result = ws.send(frame.payload);
				if (result === 0) {
					this.recover(ws);
					return;
				}
				state.blocked = result === -1;
				if (state.blocked) state.blockedAt = Date.now();
			}
		} catch {
			this.recover(ws);
		} finally {
			state.flushing = false;
			if (this.states.get(ws) === state) this.schedule(ws, state);
		}
	}
}
export async function revalidateQueuedToolInputFrame(
	socket: InputLaneSocket,
	identity: ToolInputFrameIdentity,
): Promise<boolean> {
	const ws = socket as NarratorWS;
	const current = () =>
		connections.has(ws) &&
		ws.data.subscribedNarrators.has(identity.narratorId) &&
		toolInputStreamSource.isCurrentInputLane(identity.narratorId, identity.refId, identity.epoch);
	if (!current()) return false;
	if (ws.data.publicShare) {
		if (ws.data.publicShare.narratorId !== identity.narratorId) return false;
		try {
			revalidatePublicShare(ws.data.publicShare);
			const source = toolInputStreamSource.descriptor(identity.refId).source;
			const toolUseId = (source as { toolUseId?: string } | undefined)?.toolUseId;
			if (!toolUseId || !isPublicToolSourceAllowed(identity.narratorId, { toolUseId }))
				return false;
		} catch {
			return false;
		}
		return current();
	}
	if (!ws.data.userId) return false;
	const allowed = await authorizeNarratorId(
		identity.narratorId,
		{
			userId: ws.data.userId,
			isAdmin: ws.data.userRole === "admin",
		},
		"read",
	);
	// ACL lookup is async: subscription, connection and occurrence may change while it runs.
	return allowed && current();
}
const toolInputLaneSender = hotSafe(
	"toolInputLaneSender",
	() => new ToolInputLaneSender(INPUT_LANE_BACKLOG_BYTES, revalidateQueuedToolInputFrame),
);

function sendToolInputLane(ws: NarratorWS, message: ToolInputChunkMessage): boolean {
	try {
		if (!message.inputDocument) return false;
		const ref = toolInputStreamSource.descriptor(message.inputDocument.ref.id);
		if (ref.source?.narratorId !== message.narratorId) return false;
		const identity = { narratorId: message.narratorId, refId: ref.id, epoch: ref.epoch };
		if (
			!toolInputStreamSource.isCurrentInputLane(identity.narratorId, identity.refId, identity.epoch)
		)
			return true;
		if (ws.data.publicShare) {
			revalidatePublicShare(ws.data.publicShare);
			if (
				!isPublicToolSourceAllowed(message.narratorId, {
					toolUseId: message.toolUseId,
					toolName: message.toolName,
				})
			)
				return true;
		}
		for (const payload of toolInputFrames(message)) {
			if (!toolInputLaneSender.send(ws, payload, identity)) return false;
		}
		return true;
	} catch {
		// Never claim an unavailable source is recoverable, or send an oversized packet.
		return false;
	}
}

export function broadcastToNarrator(narratorId: string, message: NarratorServerMessage): void {
	if (
		["workspace_context_changed", "workspace_paths_changed", "permission_policy_changed"].includes(
			message.type,
		)
	)
		editorFileSubscriptions.hint(narratorId);
	if (
		"toolUseId" in message &&
		typeof message.toolUseId === "string" &&
		"toolName" in message &&
		typeof message.toolName === "string"
	) {
		rememberPublicToolIdentity(narratorId, {
			toolUseId: message.toolUseId,
			toolName: message.toolName,
		});
	}
	if (message.type === "tool_use_chunk" && message.inputDocument) {
		let opened: string | null | undefined;
		for (const ws of connections) {
			if (ws.data.publicShare && ws.data.publicShare.narratorId !== narratorId) continue;
			if (!ws.data.subscribedNarrators.has(narratorId)) continue;
			if (ws.data.activityOnlyNarrators?.has(narratorId)) continue;
			if (ws.data.publicShare && !projectPublicNarratorEvent(narratorId, message)) continue;
			if (opened === undefined) {
				const frame = toolOpened(message as unknown as Record<string, unknown> & { type: string });
				opened = frame ? JSON.stringify(frame) : null;
			}
			if (opened && !sendPayload(ws, opened)) continue;
			if (!sendToolInputLane(ws, message)) removeConnection(ws);
		}
		eventBus.emit({ type: "narrator:message_broadcast", narratorId, message });
		return;
	}
	let publicMessage: NarratorServerMessage | null | undefined;
	let activityMessage: NarratorServerMessage | null | undefined;
	let activityPayload: string | undefined;
	// Protocol v2 frames (§8.2), built once per broadcast for each audience that needs them.
	let blockFrames: Array<[NarratorServerMessage, string]> | undefined;
	let publicBlockFrames: Array<[NarratorServerMessage, string]> | undefined;
	const inBlockProtocol = (
		frame: NarratorServerMessage,
	): Array<[NarratorServerMessage, string]> => {
		try {
			return toBlockFrames(frame).map((item) => [item, JSON.stringify(item)]);
		} catch (error) {
			// A broadcast never fails its emitter; the v2 client reloads what it missed.
			logger.warn("Message protocol v2 frame failed; asking the client to reload", {
				narratorId,
				type: frame.type,
				error: String(error),
			});
			const reload: NarratorServerMessage = { type: "full_reload", narratorId };
			return [[reload, JSON.stringify(reload)]];
		}
	};
	for (const ws of connections) {
		if (ws.data.publicShare && ws.data.publicShare.narratorId !== narratorId) continue;
		if (!ws.data.subscribedNarrators.has(narratorId)) continue;
		if (ws.data.activityOnlyNarrators?.has(narratorId)) {
			if (activityMessage === undefined) activityMessage = projectNarratorActivityEvent(message);
			if (!activityMessage) continue;
			activityPayload ??= JSON.stringify(activityMessage);
			try {
				ws.send(activityPayload);
			} catch {
				removeConnection(ws);
			}
			continue;
		}
		let frames: Array<[NarratorServerMessage, string]>;
		if (ws.data.publicShare) {
			if (publicMessage === undefined)
				publicMessage = projectPublicNarratorEvent(narratorId, message);
			if (!publicMessage) continue;
			publicBlockFrames ??= inBlockProtocol(publicMessage);
			frames = publicBlockFrames;
		} else {
			blockFrames ??= inBlockProtocol(message);
			frames = blockFrames;
		}
		if (ws.data.catchingUpNarrators.has(narratorId)) {
			const buffer = ws.data.catchUpBuffers.get(narratorId);
			if (buffer) {
				for (const [frame, framePayload] of frames)
					bufferRealtimeMessage(buffer, frame, framePayload.length);
				continue;
			}
		}
		for (const [, framePayload] of frames) if (!sendPayload(ws, framePayload)) break;
	}
	eventBus.emit({ type: "narrator:message_broadcast", narratorId, message });
}

// Replace the callback on hot reload; a hotOnce listener would retain the old emitter.
const permissionPolicyBridge = hotSafe<{ dispose?: () => void }>(
	"narrafork.permissionPolicyWsBridge",
	() => ({}),
);
permissionPolicyBridge.dispose?.();
permissionPolicyBridge.dispose = permissionPolicyChanges.on((event) => {
	broadcastToNarrator(event.narratorId, event);
});

function withSubscriptionRequestId<T extends Record<string, unknown>>(
	message: T,
	subscriptionRequestId?: string,
): T & { subscriptionRequestId?: string } {
	return subscriptionRequestId ? { ...message, subscriptionRequestId } : message;
}

/** Send one serialized frame; a failed send drops the connection. */
function sendPayload(ws: NarratorWS, payload: string): boolean {
	try {
		ws.send(payload);
		return true;
	} catch {
		removeConnection(ws);
		return false;
	}
}

/**
 * Send one frame to one connection, projected for a public-share reader. `inProtocol`
 * maps the (projected) frame for a connection that negotiated message protocol v2.
 */
function safeSend(
	ws: NarratorWS,
	message: Record<string, unknown>,
	inProtocol?: (frame: Record<string, unknown> & { type: string }) => Record<string, unknown>,
): boolean {
	let outgoing = message;
	if (ws.data.publicShare) {
		if (typeof message.type !== "string") return true;
		const projected = projectPublicNarratorEvent(
			ws.data.publicShare.narratorId,
			message as Record<string, unknown> & { type: string },
		);
		if (!projected) return true;
		outgoing = projected;
	}
	if (inProtocol) outgoing = inProtocol(outgoing as Record<string, unknown> & { type: string });
	if (outgoing.type === "tool_use_chunk" && outgoing.inputDocument)
		return sendToolInputLane(ws, outgoing as unknown as ToolInputChunkMessage);
	try {
		ws.send(JSON.stringify(outgoing));
		return true;
	} catch {
		removeConnection(ws);
		return false;
	}
}

/** Both actor types expose the same persistent user mailbox projection. */
async function broadcastBufferQueueForNarrator(narratorId: string): Promise<void> {
	const messages = toBufferSummary(await getBufferedMessagesAsync(narratorId));
	broadcastToNarrator(narratorId, { type: "buffer_set", narratorId, messages });
}

/**
 * The subset of `narratorIds` this connection's user may read, telling the client
 * about each rejection.
 *
 * Already-subscribed ids are re-checked rather than trusted: a share can be
 * revoked while the socket is open, and this is the cheapest point to notice.
 * Ids the user cannot see are reported as `subscribe_denied` — the same shape
 * whether the narrator is private or absent, so the frame cannot be used to test
 * for existence.
 *
 * A lookup failure denies. Errors here are database problems, and answering "sure,
 * subscribe" on a failed authorization check is the one outcome that must never
 * happen.
 */
async function authorizeReadableNarrators(
	ws: NarratorWS,
	narratorIds: string[],
	requestId?: string,
): Promise<string[]> {
	const userId = ws.data.userId;
	if (!userId) {
		// Public-share reader: the share itself is the grant, scoped to exactly one
		// narrator. Revalidated synchronously so a revoked link cannot hold a
		// subscription; anything else is denied in the same indistinguishable shape.
		const share = ws.data.publicShare;
		if (!share) {
			for (const narratorId of narratorIds) {
				safeSend(ws, { type: "subscribe_denied", narratorId, requestId });
			}
			return [];
		}
		let liveShare: VerifiedPublicShare;
		try {
			liveShare = revalidatePublicShare(share);
		} catch {
			for (const narratorId of narratorIds) {
				safeSend(ws, { type: "subscribe_denied", narratorId, requestId });
			}
			return [];
		}
		const allowed: string[] = [];
		for (const narratorId of new Set(narratorIds)) {
			if (narratorId === liveShare.narratorId) {
				allowed.push(narratorId);
			} else {
				ws.data.subscribedNarrators.delete(narratorId);
				toolInputLaneSender.clearNarrator(ws, narratorId);
				safeSend(ws, { type: "subscribe_denied", narratorId, requestId });
			}
		}
		return allowed;
	}
	const principal = { userId, isAdmin: ws.data.userRole === "admin" };
	const allowed: string[] = [];
	for (const narratorId of new Set(narratorIds)) {
		let ok = false;
		try {
			const row = await db.query.narrators.findFirst({
				where: eq(narrators.id, narratorId),
				columns: NARRATOR_ACL_COLUMNS,
			});
			ok = row ? await canReadNarrator(row, principal) : false;
		} catch (err) {
			logger.warn("Narrator subscribe authorization failed", {
				narratorId,
				error: String(err),
			});
			ok = false;
		}
		if (ok) {
			allowed.push(narratorId);
		} else {
			ws.data.subscribedNarrators.delete(narratorId);
			toolInputLaneSender.clearNarrator(ws, narratorId);
			safeSend(ws, { type: "subscribe_denied", narratorId, requestId });
		}
	}
	return allowed;
}

/**
 * Per-frame authorization for the single-narrator client messages.
 *
 * Returns false when the frame must be dropped. Silent on refusal: unlike
 * `subscribe`, these frames have no UI state waiting on an answer, and a reply
 * would only tell a prober which ids exist.
 */
const NARRATOR_FRAME_WRITE_TYPES = new Set([
	"buffer_message",
	"cancel_buffer",
	"update_buffer",
	"remove_buffer",
	// Changing a running tool's timeout alters how another user's session behaves and
	// echoes a `timeout_updated` frame to its subscribers, so it is a write.
	"update_timeout",
]);
const NARRATOR_FRAME_READ_TYPES = new Set(["presence_join", "presence_leave"]);

/**
 * Frames that act on a narrator without naming it: the owner is found by looking the
 * request id up in the pending-decision registries.
 *
 * These cannot be authorized by `narratorId` because they deliberately carry none —
 * the client answers a request it was told about, not a session it names. Skipping
 * the lookup left them authorized by nothing but knowledge of the request id, which
 * is broadcast to every reader of the session: a user holding read-only access
 * through `visibility = 'public'` could approve someone else's tool call.
 */
const NARRATOR_FRAME_INDIRECT_WRITE_TYPES = new Set(["permission_decision"]);

async function authorizeNarratorFrame(
	ws: NarratorWS,
	msg: NarratorClientMessage,
): Promise<boolean> {
	const needsWrite = NARRATOR_FRAME_WRITE_TYPES.has(msg.type);
	const needsRead = NARRATOR_FRAME_READ_TYPES.has(msg.type);
	const needsIndirectWrite = NARRATOR_FRAME_INDIRECT_WRITE_TYPES.has(msg.type);
	if (!needsWrite && !needsRead && !needsIndirectWrite) return true;

	const userId = ws.data.userId;
	if (!userId) return false;
	const principal = { userId, isAdmin: ws.data.userRole === "admin" };

	if (needsIndirectWrite) {
		const requestId = (msg as { requestId?: string }).requestId;
		if (!requestId) return false;
		try {
			const ownerNarratorId = await resolveDecisionNarratorId(requestId);
			// An unknown request id is refused rather than passed through: the handler
			// would only report "not found", and returning true here would mean a future
			// registry that this resolver does not know about is silently unauthorized.
			if (!ownerNarratorId) return false;
			return await authorizeNarratorId(ownerNarratorId, principal, "write");
		} catch (err) {
			logger.warn("Narrator WS decision frame authorization failed", {
				requestId,
				frame: msg.type,
				error: String(err),
			});
			return false;
		}
	}

	const narratorId = (msg as { narratorId?: string }).narratorId;
	if (!narratorId) return true;

	try {
		return await authorizeNarratorId(narratorId, principal, needsWrite ? "write" : "read");
	} catch (err) {
		// Fail closed: a failed check must never be read as approval.
		logger.warn("Narrator WS frame authorization failed", {
			narratorId,
			frame: msg.type,
			error: String(err),
		});
		return false;
	}
}

/** Load the ACL columns for one narrator and apply the read or write verdict. */
async function authorizeNarratorId(
	narratorId: string,
	principal: { userId: string; isAdmin: boolean },
	need: "read" | "write",
): Promise<boolean> {
	const row = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: NARRATOR_ACL_COLUMNS,
	});
	if (!row) return false;
	return need === "write"
		? await canWriteNarrator(row, principal)
		: await canReadNarrator(row, principal);
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
	// Replay the done-transition suppression flag: an idle+unread narrator whose
	// background work is still running must not re-trigger the client's sound/PWA
	// on (re)subscribe. Consumed by RecentTabs' shared-connection listener, which
	// also sees panel snapshot frames for narrators in its window. Materialized
	// read only — a snapshot path never flushes.
	let workActiveIds: Set<string> | undefined;
	try {
		const { backgroundOccupancyStore } = await import("../services/background-occupancy-store");
		if (backgroundOccupancyStore.isReady) {
			workActiveIds = new Set(
				rows
					.filter((row) => backgroundOccupancyStore.countActiveWakeWork(row.id) > 0)
					.map((row) => row.id),
			);
		}
	} catch {
		// Occupancy may be incomplete during startup: omit the flag, notify as usual.
	}
	for (const row of rows) {
		if (!connections.has(ws)) return;
		const item = toListStateSnapshotItem(row);
		const backgroundWorkActive =
			item.status === "idle" &&
			item.substatus?.includes("unread") &&
			workActiveIds?.has(row.id) === true;
		if (
			!safeSend(ws, {
				type: "status_change",
				...item,
				...(backgroundWorkActive ? { backgroundWorkActive } : {}),
			})
		)
			return;
	}
}

// List subscriptions are a high-cardinality RecentTabs window. Send bounded
// batches rather than one status_change frame per narrator. These state frames
// intentionally remain unscoped so wildcard list listeners receive reconnects.
/** Max tool rows an activity card shows; the snapshot sends no more than that. */
const ACTIVITY_SNAPSHOT_TOOL_CALLS = 4;

async function sendActivitySnapshot(
	ws: NarratorWS,
	narratorIds: string[],
	requestId?: string,
): Promise<void> {
	for (let offset = 0; offset < narratorIds.length; offset += RECENT_TABS_WS_BATCH_SIZE) {
		if (!connections.has(ws)) return;
		const batchIds = narratorIds.slice(offset, offset + RECENT_TABS_WS_BATCH_SIZE);
		let toolCalls: Awaited<
			ReturnType<typeof import("../services/narrator-messages").loadRecentToolCallActivity>
		>;
		try {
			const { loadRecentToolCallActivity } = await import("../services/narrator-messages");
			toolCalls = await loadRecentToolCallActivity(batchIds, ACTIVITY_SNAPSHOT_TOOL_CALLS);
		} catch (err) {
			logger.warn("Failed to load narrator activity snapshot", {
				count: batchIds.length,
				error: err instanceof Error ? err.message : String(err),
			});
			return;
		}
		for (const narratorId of batchIds) {
			// Unsubscribed while the query ran: nobody is listening for it any more.
			if (!ws.data.subscribedNarrators.has(narratorId)) continue;
			safeSend(
				ws,
				withSubscriptionRequestId(
					{
						type: "activity_snapshot",
						narratorId,
						toolCalls: (toolCalls.get(narratorId) ?? []).map((call) => ({
							toolUseId: call.toolUseId,
							toolName: call.toolName,
							status: call.status,
							createdAt: call.createdAt,
							...(call.inputSummary ? { inputSummary: call.inputSummary } : {}),
						})),
					},
					requestId,
				),
			);
		}
	}
}

async function sendListStateSnapshot(ws: NarratorWS, narratorIds: string[]): Promise<void> {
	for (let offset = 0; offset < narratorIds.length; offset += RECENT_TABS_WS_BATCH_SIZE) {
		if (!connections.has(ws)) return;
		const batchIds = narratorIds.slice(offset, offset + RECENT_TABS_WS_BATCH_SIZE);
		const rows = await loadStatusRows(batchIds);
		// Load counts after status so an idle snapshot also carries the background
		// occupancy signal. Use the same bounded count semantics as the runtime API.
		let counts:
			| Map<string, import("@shared/background-task-list").BackgroundTaskActiveCounts>
			| undefined;
		const freshCountIds = new Set<string>();
		const wakeWorkActiveIds = new Set<string>();
		try {
			const { backgroundTaskService } = await import("../services/background-task-service");
			const { backgroundOccupancyStore } = await import("../services/background-occupancy-store");
			const versionsAtRead = new Map(
				rows.map((row) => [row.id, backgroundTaskService.getListVersion(row.id)]),
			);
			counts = await backgroundTaskService.countActiveKindsByParentBatch(rows.map((row) => row.id));
			// The batch count read flushed the store, so the wake-work read below is
			// materialized and free. Wake-work (bash tasks + subagents) is a STRICTER
			// set than the badge's work count: transfers count as work but never wake
			// the parent, so they must not suppress the notification.
			for (const row of rows) {
				if (backgroundOccupancyStore.countActiveWakeWork(row.id) > 0) wakeWorkActiveIds.add(row.id);
			}
			// List subscriptions are already live. A count frame delivered during
			// this read must win over the older snapshot, independently per narrator.
			for (const row of rows) {
				if (versionsAtRead.get(row.id) === backgroundTaskService.getListVersion(row.id)) {
					freshCountIds.add(row.id);
				}
			}
		} catch (err) {
			// Occupancy can be incomplete; do not lose basic status or invent zeros.
			logger.warn("Failed to load background counts for narrator list snapshot", {
				count: rows.length,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		if (!connections.has(ws)) return;
		const rowsById = new Map(rows.map((row) => [row.id, row]));
		const items = batchIds.flatMap((id) => {
			const row = rowsById.get(id);
			if (!row) return [];
			const item = toListStateSnapshotItem(row);
			const freshCounts = counts && freshCountIds.has(id) ? counts.get(id) : undefined;
			return [
				{
					...item,
					...(freshCounts
						? {
								activeBackgroundTaskCount: freshCounts.activeCount,
								activeBackgroundWorkCount: freshCounts.activeWorkCount,
								activeBackgroundServiceCount: freshCounts.activeServiceCount,
							}
						: {}),
					// Snapshot replay of the done-transition flag (see sendStatusSnapshot).
					// The flag comes from the flushed wake-work read above. It must not
					// depend on the badge counts being fresh: a list-version bump during
					// this read correctly drops the counts (a newer count frame wins),
					// but nothing else carries the suppression flag. Dropping it here
					// makes a resubscribe play sound/PWA for a done that is still waiting
					// on wake-capable background work.
					...(counts &&
					wakeWorkActiveIds.has(id) &&
					item.status === "idle" &&
					item.substatus?.includes("unread")
						? { backgroundWorkActive: true }
						: {}),
				},
			];
		});
		if (!safeSend(ws, { type: "list_state_snapshot", items })) return;
	}
}

function sendRuntimeSnapshot(ws: NarratorWS, narratorIds: string[], requestId?: string): void {
	for (const id of narratorIds) {
		const snap = getStreamingSnapshot(id);
		// Always sync queue state: a reconnect may have missed the clear event.
		if (
			!safeSend(
				ws,
				withSubscriptionRequestId(
					{
						type: "queue_status",
						narratorId: id,
						position: snap?.queuePosition ?? (snap?.queueMessage ? undefined : 0),
						queueDepth: snap?.queueDepth ?? 0,
						queueMessage: snap?.queueMessage,
					},
					requestId,
				),
			)
		) {
			return;
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
		const hasStreaming =
			snap.streamingBlocks.length > 0 || snap.toolChunks.size > 0 || snap.model !== undefined;
		if (!hasStreaming) continue;
		if (
			!safeSend(
				ws,
				withSubscriptionRequestId(
					{
						type: "streaming_snapshot",
						narratorId: id,
						model: snap.model,
						provider: snap.provider,
						streamingBlocks: snap.streamingBlocks,
						toolChunks: [...snap.toolChunks.values()],
					},
					requestId,
				),
				toBlockSnapshot,
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
				toBlockCatchUp,
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
							toBlockCatchUp,
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
/**
 * Drop live subscriptions to one narrator from every connection whose user may no
 * longer read it.
 *
 * Subscriptions are authorized once, at subscribe time, so un-sharing alone would
 * leave the previous viewer receiving events until they reconnected. Called after
 * any sharing change; each evicted connection also gets `subscribe_denied` so its
 * UI can stop rendering a session it no longer has.
 *
 * Iterates connections rather than querying: the set is small (one per open tab),
 * and only the distinct users actually subscribed are checked.
 */
export async function dropNarratorSubscriptionsForUnauthorizedUsers(
	narratorId: string,
): Promise<void> {
	editorFileSubscriptions.hint(narratorId);
	const row = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: NARRATOR_ACL_COLUMNS,
	});

	const verdicts = new Map<string, boolean>();
	for (const ws of connections) {
		if (!ws.data.subscribedNarrators.has(narratorId)) continue;
		const userId = ws.data.userId;
		const cacheKey = `${userId ?? ""}:${ws.data.userRole ?? ""}`;
		let allowed = verdicts.get(cacheKey);
		if (allowed === undefined) {
			allowed =
				row !== undefined &&
				userId !== undefined &&
				(await canReadNarrator(row, { userId, isAdmin: ws.data.userRole === "admin" }));
			verdicts.set(cacheKey, allowed);
		}
		if (allowed) continue;
		ws.data.subscribedNarrators.delete(narratorId);
		toolInputLaneSender.clearNarrator(ws, narratorId);
		safeSend(ws, { type: "subscribe_denied", narratorId });
	}
}

export function broadcastToUser(userId: string, data: NarratorServerMessage): void {
	if (data.type === "project_access_changed") editorFileSubscriptions.hint();
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

let humanAttentionBroadcastTimer: ReturnType<typeof setTimeout> | undefined;

/** A bounded, data-free wake-up for inboxes, including sessions absent from RecentTabs. */
function scheduleHumanAttentionBroadcast(): void {
	if (humanAttentionBroadcastTimer) return;
	humanAttentionBroadcastTimer = setTimeout(() => {
		humanAttentionBroadcastTimer = undefined;
		const payload = JSON.stringify({ type: HUMAN_ATTENTION_CHANGED_WS_TYPE });
		for (const ws of connections) {
			if (!ws.data.userId) continue;
			try {
				ws.send(payload);
			} catch {
				removeConnection(ws);
			}
		}
	}, 50);
}

// A separate key also registers the new bridge when an older WS module was hot-loaded.
if (hotOnce("narrafork.humanAttentionWs.listenersRegistered")) {
	eventBus.on("human_attention:changed", scheduleHumanAttentionBroadcast);
	// Deleting history can cascade-delete an async question without calling its
	// decision service. The frame is emitted after the history change commits.
	eventBus.on("narrator:message_broadcast", ({ message }) => {
		if (message.type === "messages_deleted") scheduleHumanAttentionBroadcast();
	});
}

/**
 * Per-user coalescing for notification-center frames.
 *
 * Fan-out can insert many rows for one user in a burst (DM + permission offer).
 * The client is required to treat the frame as "stale", not as data — so we
 * collapse bursts to one wake-up per user per flush window instead of one frame
 * per row.
 */
const NOTIFICATION_CENTER_FLUSH_MS = 50;
const notificationCenterPending = hotSafe(
	"narrafork.notificationCenterWs.pending",
	() =>
		new Map<
			string,
			{
				kinds?: Set<"chat_message" | "permission_request">;
				timer?: ReturnType<typeof setTimeout>;
			}
		>(),
);

function flushNotificationCenterBroadcast(userId: string): void {
	const pending = notificationCenterPending.get(userId);
	if (!pending) return;
	notificationCenterPending.delete(userId);
	if (pending.timer !== undefined) clearTimeout(pending.timer);
	const frame: Extract<
		NarratorServerMessage,
		{ type: typeof NOTIFICATION_CENTER_CHANGED_WS_TYPE }
	> = {
		type: NOTIFICATION_CENTER_CHANGED_WS_TYPE,
	};
	if (pending.kinds && pending.kinds.size > 0) {
		frame.kinds = [...pending.kinds];
	}
	broadcastToUser(userId, frame);
}

function scheduleNotificationCenterBroadcast(
	userId: string,
	kinds?: Array<"chat_message" | "permission_request">,
): void {
	if (!userId) return;
	let pending = notificationCenterPending.get(userId);
	if (!pending) {
		pending = {};
		notificationCenterPending.set(userId, pending);
	}
	if (kinds?.length) {
		if (!pending.kinds) pending.kinds = new Set();
		for (const kind of kinds) pending.kinds.add(kind);
	}
	if (pending.timer !== undefined) return;
	pending.timer = setTimeout(() => {
		flushNotificationCenterBroadcast(userId);
	}, NOTIFICATION_CENTER_FLUSH_MS);
}

if (hotOnce("narrafork.notificationCenterWs.listenersRegistered")) {
	eventBus.on(NOTIFICATION_CENTER_CHANGED_WS_TYPE, (event) => {
		scheduleNotificationCenterBroadcast(event.userId, event.kinds);
	});
}

/** Deployment-wide frames are for authenticated sessions, NEVER anonymous share readers. */
export function broadcastToAll(message: Record<string, unknown>): void {
	const payload = JSON.stringify(message);
	for (const ws of connections) {
		if (ws.data.publicShare) continue;
		try {
			ws.send(payload);
		} catch {
			removeConnection(ws);
		}
	}
}

/**
 * Broadcast only to admin connections. For frames that only an admin can act on
 * (plugin permission prompts): sending them to everyone leaks which plugins ask
 * for which capabilities and relies on each client to filter by role.
 */
export function broadcastToAdmins(message: Record<string, unknown>): void {
	const payload = JSON.stringify(message);
	for (const ws of connections) {
		if (ws.data.publicShare || ws.data.userRole !== "admin") continue;
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

	eventBus.on("plugin:provider_models_changed", (event) => {
		broadcastToAll({
			type: "plugin_provider_models_changed",
			pluginId: event.pluginId,
			providerInstanceId: event.providerInstanceId,
		});
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
		const lease = ws.data.publicShareConnectionLease;
		if (
			lease &&
			!lease.open(() => {
				removeConnection(ws);
				try {
					ws.close(1001, "Share connection expired");
				} catch {
					/* Already closed. */
				}
			})
		) {
			ws.close(1008, "Share connection reservation expired");
			return;
		}
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

		// Anonymous grants permit only the transcript/room protocol and heartbeat.
		// In particular, output-stats sends directly from the connection registry.
		if (
			ws.data.publicShare &&
			![
				"pong",
				"subscribe",
				"unsubscribe",
				"sync_check",
				"chat_subscribe",
				"chat_unsubscribe",
			].includes(msg.type)
		)
			return;

		// Update heartbeat timestamp on any valid message
		ws.data.lastPongAt = Date.now();

		// Frames that act on one narrator are authorized here, once, instead of in each
		// case. Queueing or editing buffered input is indistinguishable from sending a
		// message, so it needs write access; presence announces "I am looking at this",
		// so read is enough. Decision frames (`permission_decision`)
		// name only a request/session id, so their owner is resolved first — see
		// `authorizeNarratorFrame`. `subscribe` authorizes itself (it takes a list, and
		// reports per-id denials), and `sync_check` is covered transitively because it
		// requires an already-authorized subscription.
		if (!(await authorizeNarratorFrame(ws, msg))) return;

		switch (msg.type) {
			case "editor_file_subscribe":
			case "editor_file_unsubscribe":
				await handleEditorFileMessage(ws, msg);
				break;
			case "git_workspace_subscribe":
			case "git_workspace_unsubscribe":
			case "git_workspace_refresh":
				await handleGitWorkspaceMessage(ws, msg);
				break;
			case "pong":
				// Heartbeat response — lastPongAt already updated above
				break;
			case "subscribe": {
				// Public-share readers get the share's own filtered stream; the activity
				// projection is not share-aware, so it is never offered to them.
				const kind =
					msg.kind === "activity" && ws.data.publicShare ? "list" : (msg.kind ?? "messages");
				const requestId = msg.requestId;
				if (!canAddSubscriptions(ws, msg.narratorIds)) break;

				// Authorize BEFORE anything is added to the subscription set. This socket
				// carries a user identity but the ids come from the client, so without this
				// any authenticated user could stream a private narrator's whole timeline by
				// guessing (or observing) its id — the catch-up path below happily replays
				// history to whoever is subscribed.
				const allowedIds = await authorizeReadableNarrators(ws, msg.narratorIds, requestId);
				if (allowedIds.length === 0) break;

				const messageNarratorId =
					kind === "messages" && allowedIds.length === 1 ? allowedIds[0] : undefined;
				const catchUpAnchor = messageNarratorId ? msg.catchUpCursor : undefined;

				// An activity frame lowers only what it newly subscribes, or what the client
				// explicitly downgrades after its last full handle went away; otherwise it
				// just asks for the activity snapshot of a narrator streamed in full.
				const activityLevelIds =
					kind === "activity"
						? allowedIds.filter(
								(id) => msg.downgrade === true || !ws.data.subscribedNarrators.has(id),
							)
						: [];
				// Reserve the full accepted set before any async snapshot/version work so
				// concurrent subscribe frames cannot race past the per-connection limit.
				for (const id of allowedIds) ws.data.subscribedNarrators.add(id);
				if (kind === "activity") {
					ws.data.activityOnlyNarrators ??= new Set();
					for (const id of activityLevelIds) ws.data.activityOnlyNarrators.add(id);
				} else {
					for (const id of allowedIds) ws.data.activityOnlyNarrators?.delete(id);
				}

				if (kind === "activity") {
					await sendListStateSnapshot(ws, allowedIds);
					await sendActivitySnapshot(ws, allowedIds, requestId);
					break;
				}

				if (kind === "list") {
					await sendListStateSnapshot(ws, allowedIds);
				}
				if (kind === "panel") {
					await sendStatusSnapshot(ws, allowedIds);
					sendRuntimeSnapshot(ws, allowedIds, requestId);
				}
				if (kind === "messages") sendStreamingSnapshot(ws, allowedIds, requestId);

				if (messageNarratorId && msg.version != null) {
					// The version belongs to the REST snapshot used by THIS subscription,
					// not necessarily the shared connection's latest optimistic state. Check
					// it even for an empty snapshot with no cursor: if the first message
					// landed between REST and subscribe, the body must reload rather than
					// accepting a misleading sync_ok.
					const serverVersion = await narratorService
						.getMessageVersion(messageNarratorId)
						.catch(() => null);
					if (serverVersion != null && serverVersion === msg.version) {
						safeSend(
							ws,
							withSubscriptionRequestId(
								{ type: "sync_ok", narratorId: messageNarratorId, version: serverVersion },
								requestId,
							),
						);
						break;
					}
					if (!catchUpAnchor) {
						safeSend(
							ws,
							withSubscriptionRequestId(
								{ type: "full_reload", narratorId: messageNarratorId },
								requestId,
							),
						);
						break;
					}
				}

				if (messageNarratorId && catchUpAnchor) {
					sendCatchUpForAnchor(ws, messageNarratorId, catchUpAnchor, requestId).catch((err) => {
						logger.warn("Failed to send catch-up messages", { error: String(err) });
					});
				}
				break;
			}
			case "unsubscribe": {
				for (const id of msg.narratorIds) {
					ws.data.subscribedNarrators.delete(id);
					ws.data.activityOnlyNarrators?.delete(id);
					toolInputLaneSender.clearNarrator(ws, id);
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
								userId,
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
				let { ok } = await pushBufferedMessage(
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
				// No live session to queue behind: the ordinary admission of any session
				// (queues behind an owner, or starts a run that adopts the input).
				if (!ok) {
					try {
						const { acceptUserMessage } = await import("../services/narrator-session");
						await acceptUserMessage(msg.narratorId, bufferText, {
							locale: userId ? await getUserLanguage(userId) : "en",
							commandText,
							userId,
							preBashCommand,
						});
						ok = true;
					} catch (err) {
						logger.warn("Failed to admit buffered message", {
							narratorId: msg.narratorId,
							error: String(err),
						});
					}
				}
				if (ok) {
					broadcastToNarrator(msg.narratorId, {
						type: "buffer_set",
						narratorId: msg.narratorId,
						messages: toBufferSummary(await getBufferedMessagesAsync(msg.narratorId)),
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
				await clearBufferedMessages(msg.narratorId);
				// Cancelling queued input must also drop a pending post-tool soft stop,
				// otherwise the running turn ends at the next tool boundary with nothing
				// to resume.
				clearBufferedMessageSoftStopIfIdle(msg.narratorId);
				broadcastToNarrator(msg.narratorId, {
					type: "buffer_cleared",
					narratorId: msg.narratorId,
					reason: "cancelled",
				});
				break;
			}
			case "update_buffer": {
				const ok = await updateBufferedMessage(msg.narratorId, msg.messageId, msg.text);
				if (ok) await broadcastBufferQueueForNarrator(msg.narratorId);
				break;
			}
			case "remove_buffer": {
				const ok = await removeBufferedMessage(msg.narratorId, msg.messageId);
				if (ok) {
					clearBufferedMessageSoftStopIfIdle(msg.narratorId);
					await broadcastBufferQueueForNarrator(msg.narratorId);
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
			case "chat_subscribe": {
				const userId = ws.data.userId;
				if (!userId) {
					// Public-share reader: exactly the share's own discussion room, nothing
					// else. Revalidated so a revoked link cannot keep the room feed.
					const share = ws.data.publicShare;
					if (!share) break;
					let liveShare: VerifiedPublicShare;
					try {
						liveShare = revalidatePublicShare(share);
					} catch {
						break;
					}
					for (const roomId of msg.roomIds) {
						if (roomId !== liveShare.roomId) continue;
						if (ws.data.subscribedChatRooms.has(roomId)) continue;
						addChatSubscription(ws, roomId);
					}
					break;
				}
				const { assertCanRead } = await import("../services/chat-service");
				for (const roomId of msg.roomIds) {
					if (ws.data.subscribedChatRooms.has(roomId)) continue;
					if (ws.data.subscribedChatRooms.size >= MAX_CHAT_ROOM_SUBSCRIPTIONS_PER_CONNECTION) {
						safeSend(ws, {
							type: "error",
							message: "Too many chat room subscriptions on one connection",
						});
						break;
					}
					// The single delivery-side authorization point. A room the caller
					// cannot read never enters the index, so it can never be delivered.
					try {
						await assertCanRead(roomId, userId);
					} catch {
						logger.debug("Chat subscribe denied", { roomId, userId });
						continue;
					}
					addChatSubscription(ws, roomId);
				}
				break;
			}
			case "chat_unsubscribe": {
				for (const roomId of msg.roomIds) removeChatSubscription(ws, roomId);
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
							.select({
								id: narratorToolCalls.id,
								messageId: narratorToolCalls.messageId,
								inputJson: narratorToolCalls.inputJson,
							})
							.from(narratorToolCalls)
							.where(eq(narratorToolCalls.toolUseId, msg.toolUseId))
							.get();
						if (row) {
							const input = row.inputJson && typeof row.inputJson === "object" ? row.inputJson : {};
							db.update(narratorToolCalls)
								.set({
									inputJson: { ...input, timeout: newMs },
									inputChars: measureSerializedCharacters({ ...input, timeout: newMs }),
								})
								.where(eq(narratorToolCalls.id, row.id))
								.run();
							queueContextCharacterRefresh(msg.narratorId, row.messageId);
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
		removeAllChatSubscriptions(ws);
		ws.data.catchingUpNarrators?.clear();
		ws.data.catchUpBuffers?.clear();
		removeConnection(ws);
	},
};
