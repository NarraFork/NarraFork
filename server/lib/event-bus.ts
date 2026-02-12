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
	// Narrator lifecycle
	| { type: "narrator:message"; narratorId: string; role: string }
	| { type: "narrator:completed"; narratorId: string }
	| { type: "narrator:error"; narratorId: string; error: string }
	| { type: "narrator:permission_request"; narratorId: string; requestId: string }
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
		this.emitter.emit(event.type, event);
		// Also emit a wildcard for catch-all subscribers (e.g. WS broadcast)
		this.emitter.emit("*", event);
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
