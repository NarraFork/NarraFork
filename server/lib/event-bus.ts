import { EventEmitter } from "node:events";
import type { NarratorServerMessage } from "../websocket/narrator-ws-types";
import type { PublicCodexQuotaOverview } from "./codex-manager";
import { logger } from "./logger";

// === Event type definitions ===

export type NarraForkEvent =
	// Chapter lifecycle
	| { type: "chapter:created"; chapterId: string; projectId: string }
	| { type: "chapter:forked"; chapterId: string; parentId: string }
	| { type: "chapter:merged"; sourceId: string; targetId: string; userId?: string }
	| { type: "chapter:conflict"; sourceId: string; targetId: string; files: string[] } // TODO: not yet emitted
	| { type: "chapter:dormant"; chapterId: string }
	| { type: "chapter:woken"; chapterId: string }
	| { type: "chapter:abandoned"; chapterId: string; projectId: string }
	| { type: "review:created"; reviewChapterId: string; sourceChapterId: string }
	| { type: "review:concluded"; reviewChapterId: string; sourceChapterId: string }
	| { type: "review:converted"; reviewChapterId: string; action: "subagent" | "promote" }
	| { type: "review:dismissed"; reviewChapterId: string }
	| {
			type: "chapter:split"; // TODO: not yet emitted
			prefixChapterId: string;
			continuationChapterId: string;
			newForkChapterId: string;
			commitSha: string;
	  }
	| { type: "chapter:cherry_picked"; sourceId: string; targetId: string; commits: string[] } // TODO: not yet emitted
	| { type: "chapter:frozen"; chapterId: string } // TODO: not yet emitted
	| { type: "chapter:role_changed"; chapterId: string; role: string } // TODO: not yet emitted
	| { type: "chapter:files_changed"; chapterId: string; worktreePath: string }
	| { type: "chapter:commits_updated"; chapterId: string; newCount: number }
	// 依赖关系
	| { type: "dependency:created"; edgeId: string; sourceId: string; targetId: string } // TODO: not yet emitted
	| { type: "dependency:removed"; edgeId: string; sourceId: string; targetId: string } // TODO: not yet emitted
	| {
			type: "dependency:upstream_updated"; // TODO: not yet emitted
			edgeId: string;
			targetChapterId: string;
			newCommitCount: number;
	  }
	| { type: "dependency:synced"; edgeId: string; targetChapterId: string; strategy: string } // TODO: not yet emitted
	// 探索组
	| { type: "exploration:created"; groupId: string; chapterIds: string[] } // TODO: not yet emitted
	| { type: "exploration:decided"; groupId: string; decidedChapterId: string } // TODO: not yet emitted
	| { type: "exploration:abandoned"; groupId: string } // TODO: not yet emitted
	| { type: "exploration:chapter_added"; groupId: string; chapterId: string } // TODO: not yet emitted
	// Batch merge session
	| {
			type: "merge:started";
			mergeSessionId: string;
			projectId: string;
			targetChapterId: string;
			sourceChapterIds: string[];
	  }
	| {
			type: "merge:step_ok";
			mergeSessionId: string;
			projectId: string;
			targetChapterId: string;
			sourceChapterId: string;
			index: number;
			total: number;
			commitSha?: string;
	  }
	| {
			type: "merge:conflict";
			mergeSessionId: string;
			projectId: string;
			targetChapterId: string;
			sourceChapterId: string;
			index: number;
			total: number;
			conflictFiles: string[];
			narratorId?: string;
	  }
	| {
			type: "merge:ai_resolving";
			mergeSessionId: string;
			projectId: string;
			targetChapterId: string;
			sourceChapterId: string;
			narratorId?: string;
	  }
	| {
			type: "merge:completed";
			mergeSessionId: string;
			projectId: string;
			targetChapterId: string;
			mergedCount: number;
	  }
	| {
			type: "merge:cancelled";
			mergeSessionId: string;
			projectId: string;
			targetChapterId: string;
			reason: string;
	  }
	| {
			type: "merge:error";
			mergeSessionId: string;
			projectId: string;
			targetChapterId: string;
			sourceChapterId: string;
			error: string;
	  }
	// Narrator lifecycle
	| { type: "narrator:message"; narratorId: string; role: string }
	| { type: "narrator:status_changed"; narratorId: string; status: string; substatus?: string[] }
	| { type: "narrator:error"; narratorId: string; error: string }
	| { type: "narrator:warning"; narratorId: string; message: string }
	| { type: "narrator:permission_request"; narratorId: string; requestId: string }
	// Semantic "the user should be notified" intent — emitted only when a status
	// change actually warrants alerting the user. Notification consumers (IM /
	// gateway) listen to this instead of re-deriving intent from status+substatus.
	// Reflection mid-states (danger/plan/goal) and takeover fallbacks never emit it.
	| {
			type: "narrator:attention";
			narratorId: string;
			reason: "waiting_permission" | "done" | "error";
			detail?: string;
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
	// Narrator fork
	| { type: "narrator:forked"; narratorId: string; parentNarratorId: string }
	// Narrator subagent
	| {
			type: "narrator:subagent_started";
			narratorId: string;
			parentNarratorId: string;
			toolUseId: string;
			subagentType: string;
			model?: string;
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
			type: "narrator:background_task_completed";
			narratorId: string;
			parentNarratorId: string;
			taskNarratorId: string;
			toolUseId: string;
			resultPreview: string;
	  }
	| {
			type: "narrator:background_task_failed";
			narratorId: string;
			parentNarratorId: string;
			taskNarratorId: string;
			toolUseId: string;
			error: string;
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
	// Chat group (named-narrator @mention multi-party conversations)
	| { type: "group:created"; groupId: string; originNarratorId: string | null }
	| {
			type: "group:member_joined";
			groupId: string;
			narratorId: string | null;
			userId: string | null;
	  }
	| {
			/** A group is fully set up (created + members added). Targeted to createdBy for tab/notification. */
			type: "group:ready";
			groupId: string;
			title: string;
			createdBy: string | null;
			originNarratorId: string | null;
	  }
	| {
			type: "group:message";
			groupId: string;
			messageId: string;
			senderType: "user" | "narrator" | "system";
			senderNarratorId: string | null;
			senderUserId: string | null;
	  }
	// Container lifecycle
	| { type: "container:started"; chapterId: string }
	| { type: "container:stopped"; chapterId: string }
	| { type: "container:paused"; chapterId: string }
	| { type: "container:resumed"; chapterId: string }
	| { type: "container:error"; chapterId: string; error: string }
	| { type: "container:log"; chapterId: string; line: string; phase?: "build" | "start" }
	| { type: "container:starting"; chapterId: string }
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
			chapterId: string | null;
	  }
	| {
			type: "terminal:exited";
			terminalId: string;
			narratorId: string | null;
			chapterId: string | null;
	  }
	// MCP server lifecycle
	| { type: "mcp:server_connected"; serverId: string; name: string; toolCount: number }
	| { type: "mcp:server_disconnected"; serverId: string; name: string; reason?: string }
	| { type: "mcp:server_error"; serverId: string; name: string; error: string }
	// Volume snapshots
	| { type: "volume-snapshot:creating"; projectId: string; chapterId: string }
	| { type: "volume-snapshot:created"; projectId: string; snapshotId: string }
	| { type: "volume-snapshot:applying"; snapshotId: string; targetChapterId: string }
	| { type: "volume-snapshot:applied"; snapshotId: string; targetChapterId: string }
	| { type: "volume-snapshot:deleted"; projectId: string; snapshotId: string }
	| { type: "volume-snapshot:error"; projectId: string; error: string }
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
			taskType: "bash" | "agent";
			output: string | null;
	  }
	| {
			type: "background_task:failed";
			taskId: string;
			parentNarratorId: string;
			taskType: "bash" | "agent";
			error: string | null;
	  }
	| {
			type: "background_task:cancelled";
			taskId: string;
			parentNarratorId: string;
			taskType: "bash" | "agent";
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
	| { type: "device:status"; deviceId: string; status: "online" | "offline" }
	| { type: "device:token-rotated"; deviceId: string }
	| { type: "device:revoked"; deviceId: string }
	// File transfer lifecycle
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
	| { type: "transfer:error"; transferId: string; deviceId: string; error: string };

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
