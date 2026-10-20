import type { IFileChange } from "./types";

export const WATCHER_WORKER_FLAG = "--narrafork-watcher-worker";

export type WatcherBackend = "inotify" | "fs-events" | "windows";

export interface WatchCommand {
	type: "watch";
	requestId: string;
	id: string;
	path: string;
	ignore: string[];
}

export interface UnwatchCommand {
	type: "unwatch";
	requestId: string;
	id: string;
}

export interface ShutdownCommand {
	type: "shutdown";
}

export interface PingCommand {
	type: "ping";
	requestId: string;
}

export type WatcherParentMessage = WatchCommand | UnwatchCommand | ShutdownCommand | PingCommand;

export interface ReadyMessage {
	type: "ready";
	pid: number;
	backend: WatcherBackend;
}

export interface AckMessage {
	type: "watch_ack" | "unwatch_ack" | "pong";
	requestId: string;
	id?: string;
}

export interface EventsMessage {
	type: "events";
	id: string;
	path: string;
	events: IFileChange[];
}

export interface WorkerLogMessage {
	type: "log";
	level: "trace" | "warn" | "error" | "info" | "debug";
	message: string;
	data?: Record<string, unknown>;
}

export const WATCHER_STAGES = [
	"received",
	"canonicalize_end",
	"binding_start",
	"binding_end",
	"subscribe_start",
	"subscribe_end",
	"unsubscribe_start",
	"unsubscribe_end",
	"unsubscribe_error",
	// Emitted immediately before the ACK write; not proof of pipe flush or parent receipt.
	"ack_send",
] as const;

export interface WorkerStageMessage {
	type: "stage";
	requestId: string;
	watchId: string;
	stage: (typeof WATCHER_STAGES)[number];
	workerElapsedMs: number;
	workerStageDurationMs: number;
	activeWatches: number;
	starting: number;
	stopping: number;
	errorName?: string;
	errorMessage?: string;
}

export interface WorkerErrorMessage {
	type: "error";
	requestId?: string;
	id?: string;
	error: string;
	errorName?: string;
	fatal?: boolean;
}

export type WatcherWorkerMessage =
	| ReadyMessage
	| WorkerStageMessage
	| AckMessage
	| EventsMessage
	| WorkerLogMessage
	| WorkerErrorMessage;
