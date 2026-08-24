import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "./logger";
import { getNarraforkPath } from "./narrafork-home";

/**
 * Server restart callback registry.
 * Decouples settings/routes/update from server/main.ts to avoid circular imports.
 */

type RestartFn = (newHost: string, newPort: number) => void | Promise<void>;

type RuntimeAddress = {
	protocol: "http" | "https";
	host: string;
	port: number;
};

type RuntimeAddressGetter = () => RuntimeAddress;

type GracefulShutdownRequest = {
	token: string;
	pid?: number;
	version?: string;
};

type GracefulShutdownResult = {
	success: boolean;
	reason: string;
	pid: number;
	durationMs: number;
};

type GracefulShutdownFn = (request: GracefulShutdownRequest) => Promise<GracefulShutdownResult>;

/**
 * Shut this process down on an administrator's request, with no replacement taking over.
 *
 * Distinct from `GracefulShutdownFn`, which only ever runs because a replacement process asked
 * for the port. Here nobody is coming: the user intends to start the new binary themselves, so
 * the handler must not open a restart-handoff session or leave a recovery manifest behind
 * claiming a spawned successor.
 */
type OperatorShutdownFn = (options: { reason: string }) => Promise<GracefulShutdownResult>;

type GracefulRestartSession = {
	token: string;
	url: string;
	markerPath: string;
	markerNonce: string;
	createdAt: number;
	state: "pending" | "shutting_down" | "completed";
	shutdownPromise?: Promise<GracefulShutdownResult>;
};

const RESTART_HANDOFF_DIR = getNarraforkPath("restart-handoff");

let _restartFn: RestartFn | null = null;
let _runtimeAddressGetter: RuntimeAddressGetter | null = null;
let _gracefulShutdownFn: GracefulShutdownFn | null = null;
let _operatorShutdownFn: OperatorShutdownFn | null = null;
let _gracefulRestartSession: GracefulRestartSession | null = null;

/** Called by server/main.ts to register the in-process restart implementation. */
export function registerServerRestart(fn: RestartFn): void {
	_restartFn = fn;
}

/** Called by server/main.ts to expose the currently bound address for update handoff. */
export function registerRuntimeAddressGetter(fn: RuntimeAddressGetter): void {
	_runtimeAddressGetter = fn;
}

/** Called by server/main.ts to register the graceful shutdown implementation. */
export function registerGracefulShutdownHandler(fn: GracefulShutdownFn): void {
	_gracefulShutdownFn = fn;
}

/**
 * Called by server/main.ts to register the administrator-initiated shutdown implementation.
 *
 * Accepts null so tests can restore the unregistered state they found the module in; this is
 * shared module-level state, and a fake left behind would let a later test shut something down.
 */
export function registerOperatorShutdownHandler(fn: OperatorShutdownFn | null): void {
	_operatorShutdownFn = fn;
}

/**
 * Whether an administrator-initiated shutdown can be performed in this process.
 *
 * False in environments that never registered the handler (tests, embedded harnesses), so the
 * route can answer with a real reason instead of reporting a shutdown that never happens.
 */
export function canOperatorShutdown(): boolean {
	return _operatorShutdownFn !== null;
}

/**
 * Delay between answering the shutdown request and beginning teardown.
 *
 * Teardown calls `closeAllConnections()`, which terminates in-flight HTTP requests — including
 * the one that asked for the shutdown. Running it inline would drop the response, leaving the
 * caller unable to distinguish "shutting down" from "request failed". The replacement-process
 * handoff tolerates that because its marker file is authoritative; an administrator clicking a
 * button has no such fallback, so the response is flushed first.
 */
const OPERATOR_SHUTDOWN_RESPONSE_GRACE_MS = 300;

/**
 * Stop this server at an administrator's request, shortly after the current response is flushed.
 *
 * Returns false when no handler is registered, which the caller must surface rather than treat as
 * success: a silent no-op here looks exactly like a completed shutdown to the UI, and the user
 * would go start the new binary while the old one still holds the port.
 */
export function scheduleOperatorShutdown(options: { reason: string }): boolean {
	const fn = _operatorShutdownFn;
	if (!fn) {
		logger.error("Operator shutdown requested but no handler registered", {
			reason: options.reason,
		});
		return false;
	}
	logger.info("Operator shutdown scheduled", {
		reason: options.reason,
		graceMs: OPERATOR_SHUTDOWN_RESPONSE_GRACE_MS,
	});
	const timer = setTimeout(() => {
		void fn(options).catch((err) => {
			logger.error("Operator shutdown failed", {
				reason: options.reason,
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}, OPERATOR_SHUTDOWN_RESPONSE_GRACE_MS);
	// Never let the grace timer be the reason the process lingers if it exits another way first.
	(timer as { unref?: () => void }).unref?.();
	return true;
}

/**
 * Schedule a server restart with new host/port after a short delay.
 * The delay allows the current HTTP response to be flushed before the server stops.
 */
export function scheduleServerRestart(newHost: string, newPort: number): void {
	if (process.env.NARRAFORK_CONTRACT_SUPPRESS_RESTART === "1") {
		logger.warn("Server restart suppressed for contract harness", { newHost, newPort });
		return;
	}
	if (!_restartFn) {
		logger.error("Server restart requested but no restart handler registered");
		return;
	}
	const fn = _restartFn;
	setTimeout(() => {
		void (async () => {
			try {
				await fn(newHost, newPort);
			} catch (err) {
				logger.error("Server restart failed", { error: String(err) });
			}
		})();
	}, 200);
}

function randomToken(): string {
	return randomBytes(32).toString("base64url");
}

function hostForLocalHandoff(host: string): string {
	if (host === "0.0.0.0" || host === "::" || host === "[::]") return "127.0.0.1";
	if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
	return host;
}

function buildGracefulShutdownUrl(address: RuntimeAddress): string {
	const host = hostForLocalHandoff(address.host);
	return `${address.protocol}://${host}:${address.port}/api/gracefully_shutdown`;
}

function markerPathForNonce(nonce: string): string {
	return resolve(RESTART_HANDOFF_DIR, `${Date.now()}-${nonce.slice(0, 12)}.json`);
}

function writeGracefulRestartMarker(
	session: GracefulRestartSession,
	result: GracefulShutdownResult,
): void {
	try {
		mkdirSync(RESTART_HANDOFF_DIR, { recursive: true });
		const tempPath = `${session.markerPath}.tmp`;
		writeFileSync(
			tempPath,
			JSON.stringify({
				nonce: session.markerNonce,
				pid: result.pid,
				reason: result.reason,
				durationMs: result.durationMs,
				ts: new Date().toISOString(),
			}),
		);
		renameSync(tempPath, session.markerPath);
		logger.info("Graceful restart marker written", { markerPath: session.markerPath });
	} catch (err) {
		logger.error("Failed to write graceful restart marker", {
			markerPath: session.markerPath,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Mark that this server is intentionally starting a replacement process.
 * Until this is called, /api/gracefully_shutdown will always reject requests.
 */
export function beginGracefulRestartSession(): GracefulRestartSession {
	if (!_runtimeAddressGetter) {
		throw new Error("Runtime address getter is not registered");
	}
	mkdirSync(RESTART_HANDOFF_DIR, { recursive: true });
	const address = _runtimeAddressGetter();
	const markerNonce = randomToken();
	const session: GracefulRestartSession = {
		token: randomToken(),
		url: buildGracefulShutdownUrl(address),
		markerPath: markerPathForNonce(markerNonce),
		markerNonce,
		createdAt: Date.now(),
		state: "pending",
	};
	_gracefulRestartSession = session;
	logger.info("Graceful restart handoff session started", {
		url: session.url,
		markerPath: session.markerPath,
		createdAt: session.createdAt,
	});
	return session;
}

/** Cancel the pending restart session if spawning the replacement failed. */
export function cancelGracefulRestartSession(): void {
	const session = _gracefulRestartSession;
	if (session) {
		try {
			unlinkSync(session.markerPath);
		} catch {}
	}
	_gracefulRestartSession = null;
}

export async function handleGracefullyShutdownRequest(
	request: GracefulShutdownRequest,
): Promise<
	| { ok: true; status: 200; body: GracefulShutdownResult }
	| { ok: false; status: 403 | 409 | 500; body: { success: false; error: string } }
> {
	const session = _gracefulRestartSession;
	if (!session) {
		return {
			ok: false,
			status: 409,
			body: { success: false, error: "No graceful restart pending" },
		};
	}
	if (request.token !== session.token) {
		return {
			ok: false,
			status: 403,
			body: { success: false, error: "Invalid graceful restart token" },
		};
	}
	if (!_gracefulShutdownFn) {
		return {
			ok: false,
			status: 500,
			body: { success: false, error: "Graceful shutdown handler is not registered" },
		};
	}

	try {
		if (!session.shutdownPromise) {
			session.state = "shutting_down";
			session.shutdownPromise = _gracefulShutdownFn(request).then((result) => {
				session.state = "completed";
				writeGracefulRestartMarker(session, result);
				return result;
			});
		}
		const result = await session.shutdownPromise;
		return { ok: true, status: 200, body: result };
	} catch (err) {
		return {
			ok: false,
			status: 500,
			body: { success: false, error: err instanceof Error ? err.message : String(err) },
		};
	}
}
