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

export interface WorkerErrorMessage {
	type: "error";
	requestId?: string;
	id?: string;
	error: string;
	fatal?: boolean;
}

export type WatcherWorkerMessage =
	| ReadyMessage
	| AckMessage
	| EventsMessage
	| WorkerLogMessage
	| WorkerErrorMessage;
