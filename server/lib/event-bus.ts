import { EventEmitter } from "node:events";
import type { BackgroundTaskType } from "@shared/background-task-list";
import type { ChatRoomKind } from "@shared/chat-room-kinds";
import type { NOTIFICATION_CENTER_CHANGED_WS_TYPE } from "@shared/notification-center";
import type { PublicationRun } from "../services/agent-runtime/publication-outbox";
import type { NarratorServerMessage } from "../websocket/narrator-ws-types";
import type { ApiRequestDiagnostics } from "./agent/types";
import type { PublicCodexQuotaOverview } from "./codex-manager";
import { logger } from "./logger";

// === Event type definitions ===

export type NarraForkEvent =
	| { type: "auth:changed"; userId?: string }
	| { type: "git:workspace_invalidated"; queryKey: string }
	// OAuth authorization transport invalidation (fixed identifiers only; no bearer material)
	| {
			type: "oauth:token_invalidated";
			tokenId: string;
			refreshFamilyId?: string | null;
			reasonCode: string;
	  }
	| {
			type: "oauth:grant_changed";
			grantId: string;
			change: "revoked" | "restricted";
			reasonCode: string;
	  }
	| {
			type: "oauth:client_changed";
			oauthClientId: string;
			change: "revoked" | "restricted";
			reasonCode: string;
	  }
	| { type: "human_attention:changed" }
	/**
	 * Notification-center projection changed for one user (insert/mark-read/delete).
	 * Carries no titles/rows — clients refetch unread-count and, if open, the list.
	 * `userId` is required: this is a per-user event; broadcasting it fleet-wide
	 * would wake every client into a useless empty-list refetch.
	 */
	| {
			type: typeof NOTIFICATION_CENTER_CHANGED_WS_TYPE;
			userId: string;
			/** Optional kind hints only; never titles/previews/ids of rows. */
			kinds?: Array<"chat_message" | "permission_request">;
	  }
	// Narrator lifecycle
	| { type: "narrator:message"; narratorId: string; role: string }
	| { type: "narrator:status_changed"; narratorId: string; status: string; substatus?: string[] }
	| {
			type: "spec:changed";
			narratorId: string;
			path: string;
			uri: string;
			revisionId: string | null;
			updatedBy: string;
	  }
	| {
			type: "narrator:error";
			narratorId: string;
			error: string;
			diagnostics?: ApiRequestDiagnostics;
	  }
	| { type: "narrator:warning"; narratorId: string; message: string }
	| { type: "narrator:permission_request"; narratorId: string; requestId: string }
	| { type: "plugin:permission_request"; pluginId: string; requestId: string; capability: string }
	| {
			type: "plugin:permission_resolved";
			pluginId: string;
			requestId: string;
			status: "granted" | "denied";
	  }
	/**
	 * A tool call reached a terminal state. Carries only bounded metadata (never the tool input or
	 * output), so it is safe to surface to external integrations that must show execution progress
	 * without gaining access to raw payloads.
	 */
	| {
			type: "narrator:tool_changed";
			narratorId: string;
			toolUseId: string;
			toolName: string;
			status: "success" | "fail";
			durationMs?: number;
			executionDeviceId?: string | null;
			errorMessage?: string;
	  }
	// Semantic "the user should be notified" intent — emitted only when a status
	// change actually warrants alerting the user. Notification consumers (IM /
	// gateway) listen to this instead of re-deriving intent from status+substatus.
	// Reflection mid-states (danger/plan/goal) and takeover fallbacks never emit it.
	//
	// `backgroundWorkActive` (only ever set for reason "done"): the turn finished
	// but background work WHOSE COMPLETION WAKES THE NARRATOR (background bash
	// tasks, background subagents) is still running. Notification channels (IM
	// webhooks, recent-tab IM pings, browser PWA, sound) suppress on it — the
	// wake-up turn after the last such task completes emits a fresh, unflagged
	// "done" which notifies normally. Transfers and services never set it: a
	// transfer's terminal commit skips publication (no wake-up turn exists to
	// re-raise the attention), and a service is not work. Hooks still receive
	// the event with this flag so the receiver decides.
	| {
			type: "narrator:attention";
			narratorId: string;
			reason: "waiting_permission" | "done" | "error";
			detail?: string;
			backgroundWorkActive?: boolean;
	  }
	// Semantic "a previously-raised attention was resolved" intent — the mirror of
	// `narrator:attention`. Emitted only when an attention that actually alerted the
	// user is cleared (first scope: a pending permission request answered by the
	// user via allow/deny). Consumers (hook bridge) can use it to close the loop.
	| {
			type: "narrator:attention_resolved";
			narratorId: string;
			reason: "waiting_permission" | "done" | "error";
			detail?: string;
	  }
	| { type: "narrator:title_updated"; narratorId: string; title: string }
	// Narrator fork. `extracted: true` means extract-to-primary: parentNarratorId is
	// the SOURCE subagent for provenance, not the new row's DB parent (which is null).
	| {
			type: "narrator:forked";
			narratorId: string;
			parentNarratorId: string;
			extracted?: boolean;
	  }
	// Narrator subagent
	| {
			type: "narrator:subagent_started";
			narratorId: string;
			parentNarratorId: string;
			toolUseId: string;
			subagentType: string;
			model?: string;
			reasoningEffort?: string;
	  }
	| {
			type: "narrator:subagent_completed";
			narratorId: string;
			parentNarratorId: string;
			toolUseId: string;
	  }
	// Background task lifecycle
	| {
			type: "narrator:background_task_started";
			narratorId: string;
			parentNarratorId: string;
			taskNarratorId: string;
			toolUseId: string;
			subagentType: string;
	  }
	| {
			type: "narrator:background_task_cancelled";
			narratorId: string;
			parentNarratorId: string;
			taskNarratorId: string;
			toolUseId: string;
	  }
	| {
			type: "narrator:team_message";
			narratorId: string;
			fromId: string;
			parentNarratorId: string;
			text: string;
			isBroadcast: boolean;
	  }
	// Browser session lifecycle
	| { type: "browser:session_created"; sessionId: string; narratorId: string; url: string }
	| { type: "browser:session_closed"; sessionId: string; narratorId: string }
	| { type: "browser:session_updated"; sessionId: string; narratorId: string }
	| { type: "browser:session_visual_change"; sessionId: string; narratorId: string }
	// Terminal lifecycle
	| {
			type: "terminal:created";
			terminalId: string;
			narratorId: string | null;
	  }
	| {
			type: "terminal:exited";
			terminalId: string;
			narratorId: string | null;
	  }
	// MCP server lifecycle
	| { type: "mcp:server_connected"; serverId: string; name: string; toolCount: number }
	| { type: "mcp:server_disconnected"; serverId: string; name: string; reason?: string }
	| { type: "mcp:server_error"; serverId: string; name: string; error: string }
	// Hooks
	| {
			type: "hook:executed";
			hookId: string;
			event: string;
			hookType: string;
			outcome: "success" | "blocked" | "error";
			narratorId?: string;
			durationMs: number;
	  }
	// Narrator WebSocket broadcast (used by peripheral services to decouple from narrator-ws)
	| {
			type: "narrator:ws_broadcast";
			narratorId: string;
			message: NarratorServerMessage;
	  }
	// Unified background task lifecycle (covers both bash and agent tasks)
	| {
			type: "background_task:completed";
			taskId: string;
			parentNarratorId: string;
			taskType: BackgroundTaskType;
			output: string | null;
			/** Identity captured with the terminal result, never inferred from a later run. */
			publicationRun?: PublicationRun;
	  }
	| {
			type: "background_task:failed";
			taskId: string;
			parentNarratorId: string;
			taskType: BackgroundTaskType;
			error: string | null;
			/** Distinguishes an execution timeout from an ordinary failure. */
			status?: "failed" | "timeout";
			publicationRun?: PublicationRun;
	  }
	| {
			type: "background_task:cancelled";
			taskId: string;
			parentNarratorId: string;
			taskType: BackgroundTaskType;
			output?: string | null;
			publicationRun?: PublicationRun;
	  }
	| {
			type: "background_task:output";
			taskId: string;
			parentNarratorId: string;
			chunk: string;
	  }
	// Codex quota overview lifecycle
	| {
			type: "codex:quota_overview_updated";
			overview: PublicCodexQuotaOverview;
	  }
	// Mirror of every broadcastToNarrator call — for non-WS consumers (e.g. IM gateway)
	| {
			type: "narrator:message_broadcast";
			narratorId: string;
			message: NarratorServerMessage;
	  }
	// Remote executor device lifecycle
	| { type: "device:changed"; deviceId: string }
	/**
	 * A project- or user-level trait layer changed. Consumers that cache resolved
	 * traits use this to drop their entries; resolution itself re-reads on demand.
	 */
	| { type: "trait-layer:changed"; layer: "user" | "project"; ownerId: string }
	| { type: "device:status"; deviceId: string; status: "online" | "offline" }
	| { type: "device:token-rotated"; deviceId: string }
	| { type: "device:revoked"; deviceId: string }
	// File transfer lifecycle. NOTE: these three events are emitted but have never
	// had a listener in any release — live progress and completion are consumed
	// through the TransferFile tool's `onProgress` callbacks and the background
	// task projection instead. `transfer:progress` is not emitted any more; these
	// types stay until the remaining `transfer:done`/`transfer:error` emitters are
	// cleaned up, so the bus keeps compiling.
	| {
			type: "transfer:progress";
			transferId: string;
			deviceId: string;
			direction: "download" | "upload";
			bytesTransferred: number;
			totalBytes: number;
			filesDone: number;
			totalFiles: number;
			currentFile?: string;
	  }
	| {
			type: "transfer:done";
			transferId: string;
			deviceId: string;
			bytesTransferred: number;
			filesDone: number;
	  }
	| { type: "transfer:error"; transferId: string; deviceId: string; error: string }
	// Plugin host control-plane changes are broadcast as an invalidation signal;
	// clients refetch the bounded contribution snapshot over authenticated HTTP.
	| {
			type: "plugin:contributions_changed";
			revision: number;
			reason: string;
	  }
	| {
			type: "plugin:provider_models_changed";
			pluginId: string;
			providerInstanceId: string;
	  }
	// Knowledge base publish/review lifecycle. Payloads carry ONLY ids and decision
	// scalars — never entry/draft content — so a listener can route notifications
	// without re-reading (or leaking) classified bodies. Emitted AFTER the owning
	// transaction commits so listener callbacks never extend a write lock.
	| {
			/** A publish request was created and is awaiting review. */
			type: "knowledge:submission_created";
			submissionId: string;
			/** Target global entry for a LINKED publish; null for a standalone publish. */
			entryId: string | null;
			/** Target collection for a STANDALONE publish; null for a linked publish. */
			collectionId: string | null;
			submitterUserId: string;
	  }
	| {
			/** A reviewer reached a verdict (approved / changes_requested / conflict / …). */
			type: "knowledge:submission_reviewed";
			submissionId: string;
			status: string;
			submitterUserId: string;
			reviewerUserId: string;
	  }
	| {
			/**
			 * An open submission was closed without a review verdict: the draft it proposed
			 * changed (`draft_updated`), the author retired the personal entry altogether
			 * (`entry_deleted`), or the author pulled the request back (`withdrawn`).
			 */
			type: "knowledge:submission_invalidated";
			submissionId: string;
			submitterUserId: string;
			reason: "draft_updated" | "entry_deleted" | "withdrawn";
	  }
	| {
			/** An approved submission became a new main revision (merged or newly created). */
			type: "knowledge:entry_published";
			entryId: string;
			submissionId: string;
			submitterUserId: string;
	  }
	| {
			/**
			 * A global entry advanced, so every OTHER user holding an active personal version of
			 * it is now based on a stale revision (drifted) and should rebase.
			 *
			 * Emitted on any main write (direct revision, approved publish, resolved conflict).
			 * `driftedUserIds` is resolved by the emitter — bounded, and it never includes the
			 * author of the change (their own draft was just rebased or archived).
			 */
			type: "knowledge:entry_drifted";
			entryId: string;
			driftedUserIds: string[];
	  }
	| {
			/**
			 * A principal's knowledge authorization changed (grant added/removed, ACL replaced).
			 * The affected user must refetch: their readable set, review scope and badges may all
			 * have moved. Carries no level/tag detail — the client re-reads through the
			 * ACL-checked endpoints.
			 */
			type: "knowledge:acl_changed";
			/** Users whose effective capabilities changed. */
			userIds: string[];
			/**
			 * `project_gate_changed` covers the indirect case: no knowledge grant moved, but a
			 * project membership change opened or closed the ancestor gate for collections that
			 * inherit it, so the readable set differs anyway.
			 */
			reason: "grant_added" | "grant_removed" | "user_acl_replaced" | "project_gate_changed";
	  }
	| {
			/**
			 * Ownership of an entry or collection moved. Both the old and the new owner are
			 * notified: ownership is an ACL short-circuit, so one of them just gained full
			 * access and the other may have lost it.
			 */
			type: "knowledge:owner_transferred";
			targetType: "entry" | "collection";
			targetId: string;
			previousOwnerUserId: string | null;
			newOwnerUserId: string | null;
	  }
	| {
			/**
			 * An outline transaction committed. Ids and scalars only, never block content: a
			 * listener (page subscriptions over WebSocket) re-reads what its subscriber may see.
			 * Emitted after the commit, once per commit.
			 */
			type: "outline:committed";
			spaceId: string;
			commitId: string;
			seq: number;
			/** Pages whose blocks changed, including pages blocks moved out of. */
			pageIds: string[];
			actorKind: "human" | "agent" | "system";
			actorId: string;
	  }
	// Human-to-human chat. Ids and scalars only — never message bodies — so a
	// listener (WS fan-out today, an IM bridge later) can route without holding a
	// copy of content it has no authorization story for.
	| {
			/** A person (or a bot, through Send) posted in a chat room. */
			type: "chat:message_created";
			roomId: string;
			messageId: string;
			seq: number;
			senderUserId: string | null;
			/** Set when a bot wrote the message; `senderUserId` is then null. */
			senderNarratorId?: string | null;
			roomKind: ChatRoomKind;
			/** Set for a narrator or bot room, so a consumer can scope by narrator. */
			narratorId: string | null;
	  }
	| {
			type: "chat:message_deleted";
			roomId: string;
			messageId: string;
			narratorId: string | null;
	  }
	| {
			/** A member advanced their read watermark (read receipts, badge refresh). */
			type: "chat:room_read";
			roomId: string;
			userId: string;
			lastReadSeq: number;
	  };

export type NarraForkEventType = NarraForkEvent["type"];

// Extract event payload by type
type EventOfType<T extends NarraForkEventType> = Extract<NarraForkEvent, { type: T }>;

type EventHandler<T extends NarraForkEventType> = (event: EventOfType<T>) => void;

class NarraForkEventBus {
	private emitter = new EventEmitter();

	constructor() {
		// Allow many listeners (multiple WS clients + logger)
		this.emitter.setMaxListeners(100);
	}

	private static SILENT_EVENTS: Set<string> = new Set([
		"narrator:message_broadcast",
		"narrator:ws_broadcast",
	]);

	emit(event: NarraForkEvent): void {
		if (!NarraForkEventBus.SILENT_EVENTS.has(event.type)) {
			logger.debug("Event emitted", { eventType: event.type, ...event });
		}
		// Manually iterate listeners with try-catch so one failure doesn't break others
		for (const eventName of [event.type, "*"]) {
			const listeners = this.emitter.rawListeners(eventName);
			for (const listener of listeners) {
				try {
					const result = (listener as (e: NarraForkEvent) => void | Promise<void>)(event);
					// If a listener returns a Promise, catch its errors to prevent
					// unhandled rejections (without changing emit's sync semantics)
					if (result && typeof (result as Promise<void>).catch === "function") {
						(result as Promise<void>).catch((err) => {
							logger.error("Async event listener error", {
								eventType: event.type,
								listenedEvent: eventName,
								error: err instanceof Error ? err.message : String(err),
							});
						});
					}
				} catch (err) {
					logger.error("Event listener threw an error", {
						eventType: event.type,
						listenedEvent: eventName,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
		}
	}

	on<T extends NarraForkEventType>(type: T, handler: EventHandler<T>): void {
		this.emitter.on(type, handler);
	}

	off<T extends NarraForkEventType>(type: T, handler: EventHandler<T>): void {
		this.emitter.off(type, handler);
	}

	/** Subscribe to all events */
	onAny(handler: (event: NarraForkEvent) => void): void {
		this.emitter.on("*", handler);
	}

	offAny(handler: (event: NarraForkEvent) => void): void {
		this.emitter.off("*", handler);
	}
}

export const eventBus = new NarraForkEventBus();
