import type { ServerWebSocket } from "bun";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";
import { terminalWsMessageSchema } from "../lib/validators";
import type { NarratorPrincipal } from "../services/narrator-acl";
import { assertChapterProjectAccess } from "../services/project-acl";
import { terminalService } from "../services/terminal-service";
import type { WSData } from "./ws-handler";

export interface TerminalWSData {
	connectedAt: number;
	lastPongAt: number;
	subscribedTerminals: Set<string>;
}
export type TerminalServerMessage =
	| { type: "output"; terminalId: string; data: string }
	| { type: "exit"; terminalId: string; code: number }
	| { type: "error"; terminalId: string; message: string; code?: string }
	| { type: "requestResize"; terminalId: string }
	| { type: "scrollback"; terminalId: string; data: string; cols: number; rows: number }
	| { type: "bufferState"; terminalId: string; mouseTracking: boolean; cursorVisible: boolean }
	| { type: "created"; requestId: string; terminal: unknown }
	| { type: "killed"; terminalId: string }
	| { type: "renamed"; terminalId: string; name: string };
export type TerminalClientMessage =
	| { type: "subscribe"; terminalIds: string[] }
	| { type: "unsubscribe"; terminalIds: string[] }
	| { type: "input"; terminalId: string; data: string }
	| { type: "resize"; terminalId: string; cols: number; rows: number }
	| {
			type: "create";
			requestId: string;
			chapterId?: string;
			narratorId?: string;
			deviceId?: string;
			expectedRevision?: number;
			contextKey?: string;
			name?: string;
			cols?: number;
			rows?: number;
	  }
	| { type: "kill"; terminalId: string }
	| { type: "rename"; terminalId: string; name: string };
type TerminalWS = ServerWebSocket<WSData & { channel: "terminal" }>;
const connections = new Set<TerminalWS>();
const closedSockets = new WeakSet<TerminalWS>();
const lastActiveClient = new Map<string, TerminalWS>();
const intents = new WeakMap<TerminalWS, Map<string, object>>();
export const TERMINAL_WS_MAX_SUBSCRIPTIONS = 64;
export const TERMINAL_WS_QUEUE_MAX_BYTES = 256 * 1024;
export const TERMINAL_WS_BACKPRESSURE_BYTES = 1024 * 1024;
const OUTPUT_BATCH_MS = 50;
interface OutputQueue {
	messages: Map<string, TerminalServerMessage[]>;
	bytes: number;
	running: boolean;
	timer?: ReturnType<typeof setTimeout>;
}
const queues = new WeakMap<TerminalWS, OutputQueue>();
export function getTerminalConnections(): Set<TerminalWS> {
	return connections;
}

function send(ws: TerminalWS, message: TerminalServerMessage): void {
	if (closedSockets.has(ws)) return;
	if ((ws.getBufferedAmount?.() ?? 0) >= TERMINAL_WS_BACKPRESSURE_BYTES) {
		handleTerminalWS.close(ws);
		ws.close?.(1013, "Terminal backpressure limit");
		return;
	}
	try {
		ws.send(JSON.stringify(message));
	} catch {
		handleTerminalWS.close(ws);
	}
}
function error(ws: TerminalWS, terminalId: string, cause: unknown): void {
	send(ws, {
		type: "error",
		terminalId,
		message: cause instanceof AppError ? cause.message.slice(0, 1024) : "Terminal operation failed",
		code: cause instanceof AppError ? cause.code : "TERMINAL_OPERATION_FAILED",
	});
}
/** The session identity comes from authenticated upgrade; role is refreshed for every operation. */
async function principalFor(ws: TerminalWS): Promise<NarratorPrincipal> {
	const userId = ws.data.sessionUserId;
	if (!userId)
		throw new AppError("Authenticated terminal principal required", 403, "TERMINAL_ACTOR_REQUIRED");
	const user = await db.query.users.findFirst({
		where: eq(users.id, userId),
		columns: { role: true },
	});
	if (!user)
		throw new AppError("Terminal principal is unavailable", 403, "TERMINAL_ACTOR_REQUIRED");
	return { userId, isAdmin: user.role === "admin" };
}
async function authorize(ws: TerminalWS, terminalId: string, need: "read" | "write") {
	return terminalService.authorizeTargetAccess(terminalId, await principalFor(ws), need);
}
function intentMap(ws: TerminalWS): Map<string, object> {
	let value = intents.get(ws);
	if (!value) {
		value = new Map();
		intents.set(ws, value);
	}
	return value;
}
function removeSubscription(ws: TerminalWS, id: string): void {
	ws.data.subscribedTerminals.delete(id);
	intents.get(ws)?.delete(id);
	queues.get(ws)?.messages.delete(id);
	if (lastActiveClient.get(id) === ws) lastActiveClient.delete(id);
}
/** Batches output, then reauthorizes before sending; no stale long-lived reader grants. */
async function flush(ws: TerminalWS, queue: OutputQueue): Promise<void> {
	if (queue.running || closedSockets.has(ws)) return;
	queue.running = true;
	const pending = queue.messages;
	queue.messages = new Map();
	queue.bytes = 0;
	try {
		for (const [id, messages] of pending) {
			const token = intents.get(ws)?.get(id);
			if (!token || !ws.data.subscribedTerminals.has(id)) continue;
			try {
				await authorize(ws, id, "read");
				if (
					closedSockets.has(ws) ||
					intents.get(ws)?.get(id) !== token ||
					!ws.data.subscribedTerminals.has(id)
				)
					continue;
				for (const message of messages) send(ws, message);
			} catch (cause) {
				removeSubscription(ws, id);
				error(ws, id, cause);
			}
		}
	} finally {
		queue.running = false;
		if (queue.messages.size && !closedSockets.has(ws)) scheduleFlush(ws, queue);
	}
}
function scheduleFlush(ws: TerminalWS, queue: OutputQueue): void {
	if (queue.timer || queue.running) return;
	queue.timer = setTimeout(() => {
		queue.timer = undefined;
		void flush(ws, queue);
	}, OUTPUT_BATCH_MS);
	queue.timer.unref?.();
}
export function sendToTerminal(terminalId: string, message: TerminalServerMessage): void {
	for (const ws of connections) {
		if (!ws.data.subscribedTerminals.has(terminalId)) continue;
		let queue = queues.get(ws);
		if (!queue) {
			queue = { messages: new Map(), bytes: 0, running: false };
			queues.set(ws, queue);
		}
		const bytes = Buffer.byteLength(JSON.stringify(message));
		if (bytes > TERMINAL_WS_QUEUE_MAX_BYTES || queue.bytes + bytes > TERMINAL_WS_QUEUE_MAX_BYTES) {
			handleTerminalWS.close(ws);
			ws.close?.(1013, "Terminal output queue limit");
			continue;
		}
		queue.bytes += bytes;
		const messages = queue.messages.get(terminalId) ?? [];
		const last = messages.at(-1);
		if (message.type === "output" && last?.type === "output") last.data += message.data;
		else messages.push(message);
		queue.messages.set(terminalId, messages);
		scheduleFlush(ws, queue);
	}
}
async function subscribeToTerminal(ws: TerminalWS, terminalId: string): Promise<void> {
	const map = intentMap(ws);
	if (!map.has(terminalId) && map.size >= TERMINAL_WS_MAX_SUBSCRIPTIONS)
		throw new AppError("Terminal subscription limit reached", 429, "TERMINAL_SUBSCRIPTION_LIMIT");
	const token = {};
	map.set(terminalId, token);
	const current = () => !closedSockets.has(ws) && map.get(terminalId) === token;
	try {
		const terminal = await authorize(ws, terminalId, "read");
		if (!current()) return;
		// Reattachment may launch a PTY. Read-only observers can view already-live terminals,
		// but must never cause a shell side effect through a subscribe/read request.
		if (terminal.status === "running" && !terminalService.isAttached(terminalId)) {
			await authorize(ws, terminalId, "write");
			if (!current()) return;
			await terminalService.ensureAttached(terminalId);
		}
		if (!current()) return;
		const scrollback = await terminalService.getScrollback(terminalId);
		await authorize(ws, terminalId, "read");
		if (!current()) return;
		ws.data.subscribedTerminals.add(terminalId);
		if (scrollback) send(ws, { type: "scrollback", terminalId, ...scrollback });
		const state = terminalService.getBufferState(terminalId);
		if (state) send(ws, { type: "bufferState", terminalId, ...state });
	} catch (cause) {
		if (map.get(terminalId) === token) removeSubscription(ws, terminalId);
		throw cause;
	}
}
export const handleTerminalWS = {
	open(ws: TerminalWS) {
		closedSockets.delete(ws);
		ws.data.lastPongAt = Date.now();
		connections.add(ws);
	},
	async message(ws: TerminalWS, parsed: unknown) {
		const result = terminalWsMessageSchema.safeParse(parsed);
		if (!result.success) {
			logger.warn("Invalid terminal WS message", { error: result.error.message.slice(0, 2048) });
			error(ws, "", new AppError("Invalid terminal request", 400, "VALIDATION_ERROR"));
			return;
		}
		const msg = result.data;
		ws.data.lastPongAt = Date.now();
		if (closedSockets.has(ws)) return;
		try {
			switch (msg.type) {
				case "pong":
					break;
				case "unsubscribe":
					for (const id of msg.terminalIds) removeSubscription(ws, id);
					break;
				case "subscribe": {
					if (msg.terminalIds.length > TERMINAL_WS_MAX_SUBSCRIPTIONS)
						throw new AppError(
							"Terminal subscription limit reached",
							429,
							"TERMINAL_SUBSCRIPTION_LIMIT",
						);
					for (const id of msg.terminalIds) {
						try {
							await subscribeToTerminal(ws, id);
						} catch (cause) {
							error(ws, id, cause);
						}
					}
					break;
				}
				case "input": {
					if (!ws.data.subscribedTerminals.has(msg.terminalId)) break;
					await authorize(ws, msg.terminalId, "write");
					if (closedSockets.has(ws) || !ws.data.subscribedTerminals.has(msg.terminalId)) break;
					if (lastActiveClient.get(msg.terminalId) !== ws) {
						lastActiveClient.set(msg.terminalId, ws);
						send(ws, { type: "requestResize", terminalId: msg.terminalId });
					}
					terminalService.write(msg.terminalId, msg.data);
					break;
				}
				case "resize": {
					if (!ws.data.subscribedTerminals.has(msg.terminalId)) break;
					await authorize(ws, msg.terminalId, "write");
					if (closedSockets.has(ws) || !ws.data.subscribedTerminals.has(msg.terminalId)) break;
					const active = lastActiveClient.get(msg.terminalId);
					if (!active || active === ws) terminalService.resize(msg.terminalId, msg.cols, msg.rows);
					break;
				}
				case "create": {
					const { requestId, ...opts } = msg;
					const principal = await principalFor(ws);
					if (opts.chapterId) await assertChapterProjectAccess(opts.chapterId, principal, "write");
					const terminal = await terminalService.create({ ...opts, principal });
					send(ws, { type: "created", requestId, terminal });
					await subscribeToTerminal(ws, terminal.id);
					break;
				}
				case "kill": {
					await authorize(ws, msg.terminalId, "write");
					if (closedSockets.has(ws)) break;
					await terminalService.kill(msg.terminalId);
					sendToTerminal(msg.terminalId, { type: "killed", terminalId: msg.terminalId });
					break;
				}
				case "rename": {
					await authorize(ws, msg.terminalId, "write");
					if (closedSockets.has(ws)) break;
					await terminalService.rename(msg.terminalId, msg.name);
					sendToTerminal(msg.terminalId, {
						type: "renamed",
						terminalId: msg.terminalId,
						name: msg.name,
					});
					break;
				}
			}
		} catch (cause) {
			const id = "terminalId" in msg ? msg.terminalId : "";
			if (id && cause instanceof AppError && cause.statusCode === 403) removeSubscription(ws, id);
			error(ws, id, cause);
		}
	},
	close(ws: TerminalWS) {
		closedSockets.add(ws);
		connections.delete(ws);
		const queue = queues.get(ws);
		if (queue?.timer) clearTimeout(queue.timer);
		queues.delete(ws);
		for (const id of ws.data.subscribedTerminals) removeSubscription(ws, id);
		intents.get(ws)?.clear();
	},
};
