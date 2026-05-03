import { randomBytes } from "node:crypto";
import { logger } from "./logger";

/**
 * Server restart callback registry.
 * Decouples settings/routes/update from server/main.ts to avoid circular imports.
 */

type RestartFn = (newHost: string, newPort: number) => void;

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

type GracefulRestartSession = {
	token: string;
	url: string;
	createdAt: number;
	state: "pending" | "shutting_down" | "completed";
	shutdownPromise?: Promise<GracefulShutdownResult>;
};

let _restartFn: RestartFn | null = null;
let _runtimeAddressGetter: RuntimeAddressGetter | null = null;
let _gracefulShutdownFn: GracefulShutdownFn | null = null;
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
 * Schedule a server restart with new host/port after a short delay.
 * The delay allows the current HTTP response to be flushed before the server stops.
 */
export function scheduleServerRestart(newHost: string, newPort: number): void {
	if (!_restartFn) {
		logger.error("Server restart requested but no restart handler registered");
		return;
	}
	const fn = _restartFn;
	setTimeout(() => {
		try {
			fn(newHost, newPort);
		} catch (err) {
			logger.error("Server restart failed", { error: String(err) });
		}
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

/**
 * Mark that this server is intentionally starting a replacement process.
 * Until this is called, /api/gracefully_shutdown will always reject requests.
 */
export function beginGracefulRestartSession(): GracefulRestartSession {
	if (!_runtimeAddressGetter) {
		throw new Error("Runtime address getter is not registered");
	}
	const address = _runtimeAddressGetter();
	const session: GracefulRestartSession = {
		token: randomToken(),
		url: buildGracefulShutdownUrl(address),
		createdAt: Date.now(),
		state: "pending",
	};
	_gracefulRestartSession = session;
	logger.info("Graceful restart handoff session started", {
		url: session.url,
		createdAt: session.createdAt,
	});
	return session;
}

/** Cancel the pending restart session if spawning the replacement failed. */
export function cancelGracefulRestartSession(): void {
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
