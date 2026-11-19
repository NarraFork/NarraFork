import type { ServerWebSocket } from "bun";
import { AppError, NotFoundError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { hotOnce } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { terminalWsMessageSchema } from "../lib/validators";
import {
	narratorTerminalAccessAllowed,
	rememberStandaloneTerminalCreator,
	terminalAccessAllowed,
} from "../services/terminal-access";
import { terminalService } from "../services/terminal-service";
import type { WSData } from "./ws-handler";

// === Types ===

export interface TerminalWSData {
	connectedAt: number;
	lastPongAt: number;
	subscribedTerminals: Set<string>;
	/** The authenticated user, for subagent terminals' ACL (`subagent-terminals.ts`). */
	userId?: string;
	/** Live role at upgrade; `admin` passes every narrator ACL. */
	userRole?: string;
}

// Server → Client messages
export type TerminalServerMessage =
	| { type: "output"; terminalId: string; data: string }
	| { type: "exit"; terminalId: string; code: number }
	| { type: "error"; terminalId: string; message: string; code?: string }
	| { type: "requestResize"; terminalId: string }
	| { type: "scrollback"; terminalId: string; data: string; cols: number; rows: number }
	| {
			type: "bufferState";
			terminalId: string;
			mouseTracking: boolean;
			cursorVisible: boolean;
	  }
	| { type: "created"; requestId: string; terminal: unknown }
	| { type: "killed"; terminalId: string }
	| { type: "renamed"; terminalId: string; name: string };

// Client → Server messages (JSON)
export type TerminalClientMessage =
	| { type: "subscribe"; terminalIds: string[] }
	| { type: "unsubscribe"; terminalIds: string[] }
	| { type: "input"; terminalId: string; data: string }
	| { type: "resize"; terminalId: string; cols: number; rows: number }
	| {
			type: "create";
			requestId: string;
			narratorId?: string;
			deviceId?: string;
			name?: string;
			cols?: number;
			rows?: number;
	  }
	| { type: "kill"; terminalId: string }
	| { type: "rename"; terminalId: string; name: string };

type TerminalWS = ServerWebSocket<WSData & { channel: "terminal" }>;

// === Connection registry ===

const connections = new Set<TerminalWS>();

/** Expose connections for heartbeat iteration. */
export function getTerminalConnections(): Set<TerminalWS> {
	return connections;
}

/** Track the last client that sent input per terminal — only this client's resize is honored */
const lastActiveClient = new Map<string, TerminalWS>();

/** Send a message to all WS clients subscribed to a terminal */
export function sendToTerminal(terminalId: string, message: TerminalServerMessage): void {
	const payload = JSON.stringify(message);
	for (const ws of connections) {
		if (ws.data.subscribedTerminals.has(terminalId)) {
			try {
				ws.send(payload);
			} catch {
				connections.delete(ws);
			}
		}
	}
}

function subscribeToTerminal(ws: TerminalWS, terminalId: string) {
	ws.data.subscribedTerminals.add(terminalId);

	// If the terminal is a dtach session that's not currently attached,
	// auto-reattach so new output flows through WebSocket.
	terminalService
		.ensureAttached(terminalId)
		.then(() => {
			// Replay scrollback buffer so the client sees previous output
			return terminalService.getScrollback(terminalId);
		})
		.then((scrollback) => {
			// Dropped meanwhile (access re-check): no scrollback for it.
			if (!ws.data.subscribedTerminals.has(terminalId)) return;
			if (scrollback) {
				try {
					ws.send(
						JSON.stringify({
							type: "scrollback",
							terminalId,
							data: scrollback.data,
							cols: scrollback.cols,
							rows: scrollback.rows,
						}),
					);
				} catch {
					// connection may be dead
				}
			}

			// Send current buffer state after scrollback
			const bufferState = terminalService.getBufferState(terminalId);
			if (bufferState) {
				try {
					ws.send(JSON.stringify({ type: "bufferState", terminalId, ...bufferState }));
				} catch {
					// noop
				}
			}
		});
}

function principalOf(ws: TerminalWS) {
	return {
		userId: ws.data.userId ?? ws.data.sessionUserId ?? "",
		isAdmin: ws.data.userRole === "admin",
	};
}

/** The one answer for a terminal that does not exist and one this user may not open. */
function sendTerminalNotFound(ws: TerminalWS, terminalId: string): void {
	try {
		ws.send(
			JSON.stringify({
				type: "error",
				terminalId,
				code: "TERMINAL_NOT_FOUND",
				message: "Terminal not found",
			}),
		);
	} catch {
		// connection may be dead
	}
}

/**
 * Opening a terminal (watching its output and scrollback, typing, renaming, closing) needs
 * write access to its narrator, a subagent's judged on its ACL root; a standalone terminal is
 * its creator's and admins' (`terminal-access.ts`). Checked on subscribe and again on every
 * input, kill and rename, so a revoked grant stops the next keystroke. A refusal drops the
 * subscription and answers exactly like an unknown id.
 */
async function mayOpenTerminal(ws: TerminalWS, terminalId: string): Promise<boolean> {
	if (await terminalAccessAllowed(terminalId, principalOf(ws), "write")) return true;
	ws.data.subscribedTerminals.delete(terminalId);
	if (lastActiveClient.get(terminalId) === ws) lastActiveClient.delete(terminalId);
	sendTerminalNotFound(ws, terminalId);
	return false;
}

/**
 * Keystrokes are written in the order they arrived although each waits for its access check:
 * one chain per connection and terminal.
 */
const inputChains = new WeakMap<TerminalWS, Map<string, Promise<void>>>();

function enqueueInput(
	ws: TerminalWS,
	terminalId: string,
	work: () => Promise<void>,
): Promise<void> {
	let chains = inputChains.get(ws);
	if (!chains) {
		chains = new Map();
		inputChains.set(ws, chains);
	}
	const next = (chains.get(terminalId) ?? Promise.resolve()).then(work, work);
	chains.set(terminalId, next);
	void next.finally(() => {
		if (chains?.get(terminalId) === next) chains.delete(terminalId);
	});
	return next;
}

/**
 * Re-check every terminal subscription (or those of `sockets`) and drop the ones whose user
 * may no longer open the terminal, so a revoked share stops the output stream at once rather
 * than at that user's next keystroke. Called on every access change. One check per
 * user, role and terminal per sweep; the set is small (one socket per open terminal panel).
 */
export async function dropUnauthorizedTerminalSubscriptions(
	sockets: Iterable<TerminalWS> = connections,
	isCurrent: (ws: TerminalWS) => boolean = () => true,
): Promise<number> {
	const verdicts = new Map<string, Promise<boolean>>();
	let dropped = 0;
	for (const ws of [...sockets]) {
		const data = ws.data;
		const { userId, sessionUserId, sessionId, userRole, subscribedTerminals } = data;
		const current = () =>
			ws.readyState === 1 &&
			ws.data === data &&
			data.userId === userId &&
			data.sessionUserId === sessionUserId &&
			data.sessionId === sessionId &&
			data.userRole === userRole &&
			data.subscribedTerminals === subscribedTerminals &&
			isCurrent(ws);
		for (const terminalId of [...subscribedTerminals]) {
			if (!current()) break;
			const principal = principalOf(ws);
			const key = `${principal.userId}:${principal.isAdmin}:${terminalId}`;
			let verdict = verdicts.get(key);
			if (!verdict) {
				verdict = terminalAccessAllowed(terminalId, principal, "write").catch(() => false);
				verdicts.set(key, verdict);
			}
			const allowed = await verdict;
			if (!current()) break;
			if (allowed) continue;
			if (!subscribedTerminals.delete(terminalId)) continue;
			if (lastActiveClient.get(terminalId) === ws) lastActiveClient.delete(terminalId);
			sendTerminalNotFound(ws, terminalId);
			dropped++;
		}
	}
	return dropped;
}

let accessSweep: Promise<unknown> | null = null;
let accessSweepAgain = false;

/** Coalesce bursts of access changes into sweeps that never overlap. */
function scheduleTerminalAccessSweep(): void {
	if (accessSweep) {
		accessSweepAgain = true;
		return;
	}
	accessSweep = dropUnauthorizedTerminalSubscriptions()
		.catch((error) =>
			logger.warn("Terminal subscription re-check failed", { error: String(error) }),
		)
		.finally(() => {
			accessSweep = null;
			if (accessSweepAgain) {
				accessSweepAgain = false;
				scheduleTerminalAccessSweep();
			}
		});
}

/** Tests only: wait for the sweep in flight, if any. */
export async function settleTerminalAccessSweep(): Promise<void> {
	while (accessSweep) await accessSweep;
}

if (hotOnce("narrafork.terminalWs.accessListeners")) {
	eventBus.on("narrator:access_changed", scheduleTerminalAccessSweep);
	eventBus.on("project:access_changed", scheduleTerminalAccessSweep);
	eventBus.on("auth:changed", scheduleTerminalAccessSweep);
}

// === WebSocket handlers ===

export const handleTerminalWS = {
	open(ws: TerminalWS) {
		ws.data.lastPongAt = Date.now();
		connections.add(ws);
	},

	async message(ws: TerminalWS, parsed: unknown) {
		const result = terminalWsMessageSchema.safeParse(parsed);
		if (!result.success) {
			logger.warn("Invalid terminal WS message", {
				error: result.error.message,
			});
			if (parsed && typeof parsed === "object" && "type" in parsed && parsed.type === "create") {
				try {
					ws.send(
						JSON.stringify({
							type: "error",
							terminalId: "",
							code: "VALIDATION_ERROR",
							message: result.error.message,
						}),
					);
				} catch {
					// connection may be dead
				}
			}
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
				for (const id of msg.terminalIds) {
					if (!(await mayOpenTerminal(ws, id))) continue;
					subscribeToTerminal(ws, id);
					// An access sweep that ran between the check and the subscription missed it:
					// check once more now that it is in place.
					await mayOpenTerminal(ws, id);
				}
				logger.debug("Terminal WS subscribed", { count: msg.terminalIds.length });
				break;
			}
			case "unsubscribe": {
				for (const id of msg.terminalIds) {
					ws.data.subscribedTerminals.delete(id);
					if (lastActiveClient.get(id) === ws) {
						lastActiveClient.delete(id);
					}
				}
				break;
			}
			case "input": {
				const { terminalId, data } = msg;
				if (!ws.data.subscribedTerminals.has(terminalId)) break;
				await enqueueInput(ws, terminalId, async () => {
					if (!ws.data.subscribedTerminals.has(terminalId)) return;
					if (!(await mayOpenTerminal(ws, terminalId))) return;
					const prev = lastActiveClient.get(terminalId);
					if (prev !== ws) {
						lastActiveClient.set(terminalId, ws);
						// Active client changed — ask the new client to re-send its dimensions
						try {
							ws.send(JSON.stringify({ type: "requestResize", terminalId }));
						} catch {
							// noop
						}
					}
					terminalService.write(terminalId, data);
				});
				break;
			}
			case "resize": {
				const { terminalId, cols, rows } = msg;
				if (!ws.data.subscribedTerminals.has(terminalId)) break;
				if (!(await mayOpenTerminal(ws, terminalId))) break;
				// Only honor resize from the last client that sent input
				const active = lastActiveClient.get(terminalId);
				if (!active || active === ws) {
					terminalService.resize(terminalId, cols, rows);
				}
				break;
			}
			case "create": {
				const { requestId, ...opts } = msg;
				try {
					// A shell on a narrator is its workspace: write access, as for REST create.
					if (
						opts.narratorId &&
						!(await narratorTerminalAccessAllowed(opts.narratorId, principalOf(ws), "write"))
					)
						throw new NotFoundError("Narrator", opts.narratorId);
					const terminal = await terminalService.create(opts);
					if (!opts.narratorId)
						rememberStandaloneTerminalCreator(terminal.id, principalOf(ws).userId);
					try {
						ws.send(JSON.stringify({ type: "created", requestId, terminal }));
					} catch {
						// noop
					}
					subscribeToTerminal(ws, terminal.id);
				} catch (err) {
					try {
						ws.send(
							JSON.stringify({
								type: "error",
								terminalId: "",
								message: String(err instanceof Error ? err.message : err),
								...(err instanceof AppError ? { code: err.code } : {}),
							}),
						);
					} catch {
						// noop
					}
				}
				break;
			}
			case "kill": {
				if (!(await mayOpenTerminal(ws, msg.terminalId))) break;
				try {
					await terminalService.kill(msg.terminalId);
					sendToTerminal(msg.terminalId, { type: "killed", terminalId: msg.terminalId });
				} catch (err) {
					logger.error("Failed to kill terminal via WS", { error: String(err) });
					try {
						ws.send(
							JSON.stringify({
								type: "error",
								terminalId: msg.terminalId,
								message: String(err instanceof Error ? err.message : err),
								...(err instanceof AppError ? { code: err.code } : {}),
							}),
						);
					} catch {
						// connection may be dead
					}
				}
				break;
			}
			case "rename": {
				if (!(await mayOpenTerminal(ws, msg.terminalId))) break;
				try {
					await terminalService.rename(msg.terminalId, msg.name);
					sendToTerminal(msg.terminalId, {
						type: "renamed",
						terminalId: msg.terminalId,
						name: msg.name,
					});
				} catch (err) {
					logger.error("Failed to rename terminal via WS", { error: String(err) });
					try {
						ws.send(
							JSON.stringify({
								type: "error",
								terminalId: msg.terminalId,
								message: String(err instanceof Error ? err.message : err),
								...(err instanceof AppError ? { code: err.code } : {}),
							}),
						);
					} catch {
						// connection may be dead
					}
				}
				break;
			}
		}
	},

	close(ws: TerminalWS) {
		connections.delete(ws);
		// Clean up lastActiveClient references
		for (const terminalId of ws.data.subscribedTerminals) {
			if (lastActiveClient.get(terminalId) === ws) {
				lastActiveClient.delete(terminalId);
			}
		}
	},
};
