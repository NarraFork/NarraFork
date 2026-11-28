/**
 * Readiness gate for the SQLite read Workers.
 *
 * Authentication reads run only on the short-read Worker pool and never fall back to the main
 * thread, so a process whose Workers cannot start would answer every request with an opaque
 * failure. Instead, startup probes the pool once (bounded), API/WS requests gate on that verdict,
 * and an unavailable pool is a clear 503 with `Retry-After`.
 */
import { catalogError } from "./errors";

export const DATABASE_READ_RETRY_AFTER_SECONDS = 5;

export type DatabaseReaderFailureCode = "DB_READERS_UNAVAILABLE" | "DB_READERS_TIMEOUT";
export type DatabaseReaderState =
	| { status: "waiting" | "ready" | "not-required" }
	| { status: "failed"; code: DatabaseReaderFailureCode; reason?: string };
export type DatabaseReaderResult = { ok: true } | { ok: false; code: DatabaseReaderFailureCode };

export interface DatabaseReaderReadiness {
	readonly state: DatabaseReaderState;
	/** Bounded startup probe, followed by a fresh, non-spawning availability check. */
	wait(): Promise<DatabaseReaderResult>;
}

const DB_READ_UNAVAILABLE_ERROR_NAMES = new Set([
	"DbReadTaskOverloadedError",
	"DbReadTaskTimeoutError",
	"WorkersUnavailableError",
]);
/** Short-read pool full, timed out or disabled. Names survive duplicated module copies. */
export function isDatabaseReadUnavailable(error: unknown): boolean {
	return error instanceof Error && DB_READ_UNAVAILABLE_ERROR_NAMES.has(error.name);
}

export function databaseReadersAvailable(state: DatabaseReaderState): boolean {
	return state.status === "ready" || state.status === "not-required";
}

const PUBLIC_READ_ONLY_PATHS = new Set([
	"/api/branding",
	"/api/branding/favicon.svg",
	"/api/branding/icon-192.png",
	"/api/branding/icon-512.png",
	"/api/branding/apple-touch-icon.png",
	"/api/licenses",
	"/api/changelog",
]);

/** Preserve verified build/settings-only GET surfaces, not arbitrary API prefixes. */
export function requiresDatabaseReaders(pathname: string, method = "GET"): boolean {
	if (pathname === "/api/health" || pathname === "/api/gracefully_shutdown") return false;
	if (
		(method === "GET" || method === "HEAD") &&
		(PUBLIC_READ_ONLY_PATHS.has(pathname) || /^\/api\/licenses\/text\/[^/]+$/.test(pathname))
	)
		return false;
	return pathname === "/api" || pathname.startsWith("/api/") || pathname.startsWith("/ws");
}

export function databaseReaderUnavailableResponse(state: DatabaseReaderState): Response {
	const error = catalogError("DATABASE_READ_UNAVAILABLE");
	return Response.json(
		{
			error: error.message,
			code: error.code,
			messageCode: error.messageCode,
			details: { databaseReaders: state },
			databaseReaders: state,
		},
		{ status: 503, headers: { "Retry-After": String(DATABASE_READ_RETRY_AFTER_SECONDS) } },
	);
}

/** Dependencies are injected so readiness can be tested without bootstrapping a database. */
export function createDatabaseReaderReadiness(options: {
	backend: "sqlite" | "postgres";
	probe: (options: { signal: AbortSignal; timeoutMs: number }) => Promise<unknown>;
	/** Live check after a successful probe, e.g. the pool being disabled later on. */
	availability?: () => { available: boolean; reason?: string | null };
	/** Alias used by the database-identity lifecycle gate. */
	databaseAvailability?: () => { available: boolean; reason?: string | null };
	timeoutMs?: number;
	retryIntervalMs?: number;
	now?: () => number;
}): DatabaseReaderReadiness {
	const timeoutMs = options.timeoutMs ?? 30_000;
	const retryIntervalMs = options.retryIntervalMs ?? DATABASE_READ_RETRY_AFTER_SECONDS * 1000;
	const now = options.now ?? Date.now;
	let state: DatabaseReaderState =
		options.backend === "postgres" ? { status: "not-required" } : { status: "waiting" };
	let inFlight: Promise<DatabaseReaderResult> | null = null;
	let lastProbeAt = Number.NEGATIVE_INFINITY;

	const available = (includeDatabase: boolean): boolean => {
		try {
			const pool = options.availability?.();
			const database = includeDatabase ? options.databaseAvailability?.() : undefined;
			return (
				(!pool || pool.available || (!includeDatabase && pool.reason === "worker_unavailable")) &&
				(!database || database.available)
			);
		} catch {
			return false;
		}
	};
	const unavailable = (): DatabaseReaderState => ({
		status: "failed",
		code: "DB_READERS_UNAVAILABLE",
	});
	const liveState = (): DatabaseReaderState =>
		(state.status === "ready" || state.status === "waiting") && !available(state.status === "ready")
			? unavailable()
			: state;

	const probe = (): Promise<DatabaseReaderResult> => {
		if (inFlight) return inFlight;
		lastProbeAt = now();
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const attempt = Promise.resolve()
			.then(() => {
				if (!available(false)) throw new Error("Database readers unavailable");
				return options.probe({ signal: controller.signal, timeoutMs });
			})
			.then(
				() => ({ ok: true }) as const,
				() => ({ ok: false, code: "DB_READERS_UNAVAILABLE" }) as const,
			);
		const timeout = new Promise<DatabaseReaderResult>((resolve) => {
			timer = setTimeout(() => {
				resolve({ ok: false, code: "DB_READERS_TIMEOUT" });
				controller.abort();
			}, timeoutMs);
		});
		inFlight = Promise.race([attempt, timeout]).then((result): DatabaseReaderResult => {
			clearTimeout(timer);
			inFlight = null;
			if (result.ok && !available(true)) {
				result = { ok: false, code: "DB_READERS_UNAVAILABLE" };
			}
			state = result.ok ? { status: "ready" } : { status: "failed", code: result.code };
			return result;
		});
		return inFlight;
	};

	if (options.backend === "sqlite") void probe();

	return {
		get state() {
			return liveState();
		},
		async wait() {
			if (options.backend === "postgres") return { ok: true };
			const current = liveState();
			if (current.status === "ready") return { ok: true };
			if (state.status === "ready" && current.status === "failed") {
				if (!available(false)) return { ok: false, code: current.code };
				state = current;
			}
			if (inFlight) return inFlight;
			if (state.status === "failed" && now() - lastProbeAt < retryIntervalMs)
				return { ok: false, code: state.code };
			return probe();
		},
	};
}
