import { EventEmitter } from "node:events";
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
	| { type: "chapter:abandoned"; chapterId: string }
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
			targetChapterId: string;
			sourceChapterIds: string[];
	  }
	| {
			type: "merge:step_ok";
			mergeSessionId: string;
			sourceChapterId: string;
			index: number;
			total: number;
			commitSha?: string;
	  }
	| {
			type: "merge:conflict";
			mergeSessionId: string;
			sourceChapterId: string;
			index: number;
			total: number;
			conflictFiles: string[];
	  }
	| {
			type: "merge:ai_resolving";
			mergeSessionId: string;
			sourceChapterId: string;
	  }
	| {
			type: "merge:completed";
			mergeSessionId: string;
			targetChapterId: string;
			mergedCount: number;
	  }
	| {
			type: "merge:cancelled";
			mergeSessionId: string;
			reason: string;
	  }
	| {
			type: "merge:error";
			mergeSessionId: string;
			sourceChapterId: string;
			error: string;
	  }
	// Narrator lifecycle
	| { type: "narrator:message"; narratorId: string; role: string }
	| { type: "narrator:status_changed"; narratorId: string; status: string }
	| { type: "narrator:error"; narratorId: string; error: string }
	| { type: "narrator:warning"; narratorId: string; message: string }
	| { type: "narrator:permission_request"; narratorId: string; requestId: string }
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
	// Container lifecycle
	| { type: "container:started"; chapterId: string }
	| { type: "container:stopped"; chapterId: string }
	| { type: "container:paused"; chapterId: string }
	| { type: "container:resumed"; chapterId: string }
	| { type: "container:error"; chapterId: string; error: string }
	| { type: "container:log"; chapterId: string; line: string }
	| { type: "container:starting"; chapterId: string }
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
	// Overseer lifecycle
	| {
			type: "overseer:event_routed";
			overseerId: string;
			narratorId: string;
			eventType: string;
	  }
	| {
			type: "overseer:decision_made";
			overseerId: string;
			narratorId: string;
			requestId: string;
			decision: "allow" | "deny";
	  }
	| { type: "overseer:created"; overseerId: string; scope: string; projectId?: string }
	| { type: "overseer:deleted"; overseerId: string }
	| { type: "overseer:enabled"; overseerId: string }
	| { type: "overseer:disabled"; overseerId: string };

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

	private static SILENT_EVENTS: Set<string> = new Set([]);

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
