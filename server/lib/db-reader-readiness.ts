/**
 * Readiness gate for the SQLite read Workers.
 *
 * Authentication reads run only on the short-read Worker pool and never fall back to the main
 * thread, so a process whose Workers cannot start would answer every request with an opaque
 * failure. Instead, startup probes the pool once (bounded), API/WS requests wait for that verdict,
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
const DB_READ_UNAVAILABLE_CODES = new Set([
	"DB_READ_UNAVAILABLE",
	"DB_READ_OVERLOADED",
	"DB_READ_BUSY",
	"DB_READ_DATABASE_CLOSED",
	"DB_READ_WORKER_EXITED",
	"DB_READ_READER_EXIT_UNCONFIRMED",
	"DB_READ_TASK_TIMEOUT",
]);

/** Short-read pool full, timed out or disabled. Names and codes survive duplicated module copies. */
export function isDatabaseReadUnavailable(error: unknown): boolean {
	return (
		error instanceof Error &&
		(DB_READ_UNAVAILABLE_ERROR_NAMES.has(error.name) ||
			("code" in error &&
				typeof error.code === "string" &&
				DB_READ_UNAVAILABLE_CODES.has(error.code)))
	);
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

	const liveState = (): DatabaseReaderState => {
		if (state.status !== "ready" && state.status !== "waiting") return state;
		try {
			const pool = options.availability?.();
			const database = state.status === "ready" ? options.databaseAvailability?.() : undefined;
			if ((pool && !pool.available) || (database && !database.available)) {
				return {
					status: "failed",
					code: "DB_READERS_UNAVAILABLE",
					reason: pool?.reason ?? database?.reason ?? "unavailable",
				};
			}
		} catch {
			return { status: "failed", code: "DB_READERS_UNAVAILABLE", reason: "unavailable" };
		}
		return state;
	};

	const probe = (): Promise<DatabaseReaderResult> => {
		if (inFlight) return inFlight;
		lastProbeAt = now();
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let timedOut = false;
		const attempt = Promise.resolve()
			.then(() => options.probe({ signal: controller.signal, timeoutMs }))
			.then(
				() => ({ ok: true }) as const,
				(error: unknown) => {
					const failed: DatabaseReaderState = {
						status: "failed",
						code: timedOut ? "DB_READERS_TIMEOUT" : "DB_READERS_UNAVAILABLE",
						reason: error instanceof Error ? error.message : String(error),
					};
					state = failed;
					return { ok: false, code: failed.code } as const;
				},
			);
		const timeout = new Promise<DatabaseReaderResult>((resolve) => {
			timer = setTimeout(() => {
				timedOut = true;
				controller.abort();
				state = {
					status: "failed",
					code: "DB_READERS_TIMEOUT",
					reason: `probe exceeded ${timeoutMs}ms`,
				};
				resolve({ ok: false, code: "DB_READERS_TIMEOUT" });
			}, timeoutMs);
		});
		inFlight = Promise.race([attempt, timeout]).then((result) => {
			clearTimeout(timer);
			if (result.ok) {
				const live = options.availability?.();
				const database = options.databaseAvailability?.();
				if ((live && !live.available) || (database && !database.available)) {
					state = {
						status: "failed",
						code: "DB_READERS_UNAVAILABLE",
						reason: live?.reason ?? database?.reason ?? "unavailable",
					};
					return { ok: false, code: "DB_READERS_UNAVAILABLE" };
				}
				state = { status: "ready" };
			}
			inFlight = null;
			return result;
		});
		return inFlight;
	};

	if (options.backend === "sqlite") void probe();

	return {
		get state() {
			const current = liveState();
			if (current.status === "failed" && state.status !== "failed") state = current;
			return current;
		},
		async wait() {
			if (options.backend === "postgres") return { ok: true };
			const current = liveState();
			if (current.status === "failed" && state.status !== "failed") state = current;
			if (state.status === "ready") return { ok: true };
			if (inFlight) return inFlight;
			if (state.status === "failed" && now() - lastProbeAt < retryIntervalMs)
				return { ok: false, code: state.code };
			return probe();
		},
	};
}
