import { EventEmitter } from "node:events";
import { logger } from "./logger";

// === Event type definitions ===

export type NarraForkEvent =
	// Chapter lifecycle
	| { type: "chapter:created"; chapterId: string; projectId: string }
	| { type: "chapter:forked"; chapterId: string; parentId: string }
	| { type: "chapter:merged"; sourceId: string; targetId: string }
	| { type: "chapter:conflict"; sourceId: string; targetId: string; files: string[] }
	| { type: "chapter:dormant"; chapterId: string }
	| { type: "chapter:woken"; chapterId: string }
	| { type: "chapter:abandoned"; chapterId: string }
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
	| { type: "narrator:permission_request"; narratorId: string; requestId: string }
	| { type: "narrator:title_updated"; narratorId: string; title: string }
	// Conversation branches
	| { type: "narrator:branch_created"; narratorId: string; branchId: string }
	| { type: "narrator:branch_switched"; narratorId: string; activeBranchId: string }
	| { type: "narrator:branch_updated"; narratorId: string; branchId: string }
	| { type: "narrator:branch_deleted"; narratorId: string; branchId: string }
	// Container lifecycle
	| { type: "container:started"; chapterId: string }
	| { type: "container:stopped"; chapterId: string }
	| { type: "container:error"; chapterId: string; error: string };

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

	emit(event: NarraForkEvent): void {
		logger.debug("Event emitted", { eventType: event.type, ...event });
		// Manually iterate listeners with try-catch so one failure doesn't break others
		for (const eventName of [event.type, "*"]) {
			const listeners = this.emitter.rawListeners(eventName);
			for (const listener of listeners) {
				try {
					(listener as (e: NarraForkEvent) => void)(event);
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
