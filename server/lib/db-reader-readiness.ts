/**
 * Readiness gate for the SQLite read Workers.
 *
 * Authentication reads run only on the short-read Worker pool and never fall back to the main
 * thread, so a process whose Workers cannot start would answer every request with an opaque
 * failure. Instead, startup probes the pool once (bounded), `/api/*` and `/ws/*` wait for that
 * verdict, and an unavailable pool is a clear 503 with `Retry-After`. A failed verdict is
 * re-probed at most once per retry interval, so a transient spawn failure heals on its own.
 */
import { catalogError } from "./errors";

export const DATABASE_READ_RETRY_AFTER_SECONDS = 5;

export type DatabaseReaderFailureCode = "DB_READERS_UNAVAILABLE" | "DB_READERS_TIMEOUT";

export type DatabaseReaderState =
	| { status: "waiting" }
	| { status: "ready" }
	| { status: "not-required" }
	| { status: "failed"; code: DatabaseReaderFailureCode; reason: string };

export interface DatabaseReaderReadiness {
	readonly state: DatabaseReaderState;
	/** Resolves to the current verdict, probing first when none is usable yet. Never rejects. */
	wait(): Promise<DatabaseReaderState>;
}

const DB_READ_UNAVAILABLE_ERROR_NAMES = new Set([
	"DbReadTaskOverloadedError",
	"DbReadTaskTimeoutError",
	"WorkersUnavailableError",
]);

/** Short-read pool full, timed out or disabled. Names, to survive duplicated module instances. */
export function isDatabaseReadUnavailable(error: unknown): boolean {
	return error instanceof Error && DB_READ_UNAVAILABLE_ERROR_NAMES.has(error.name);
}

export function databaseReadersAvailable(state: DatabaseReaderState): boolean {
	return state.status === "ready" || state.status === "not-required";
}

/** Everything that reaches the backend except liveness needs the readers to authenticate. */
export function requiresDatabaseReaders(pathname: string): boolean {
	if (pathname === "/api/health") return false;
	return pathname.startsWith("/api/") || pathname.startsWith("/ws/");
}

export function databaseReaderUnavailableResponse(state: DatabaseReaderState): Response {
	const error = catalogError("DATABASE_READ_UNAVAILABLE");
	return Response.json(
		{
			error: error.message,
			code: error.code,
			messageCode: error.messageCode,
			details: { databaseReaders: state },
		},
		{ status: 503, headers: { "Retry-After": String(DATABASE_READ_RETRY_AFTER_SECONDS) } },
	);
}

export function createDatabaseReaderReadiness(options: {
	backend: "sqlite" | "postgres";
	probe: (options: { signal: AbortSignal; timeoutMs: number }) => Promise<unknown>;
	/** Live check after a successful probe, e.g. the pool being disabled later on. */
	availability?: () => { available: boolean; reason: string | null };
	timeoutMs?: number;
	retryIntervalMs?: number;
	now?: () => number;
}): DatabaseReaderReadiness {
	const timeoutMs = options.timeoutMs ?? 10_000;
	const retryIntervalMs = options.retryIntervalMs ?? DATABASE_READ_RETRY_AFTER_SECONDS * 1000;
	const now = options.now ?? Date.now;
	let state: DatabaseReaderState =
		options.backend === "sqlite" ? { status: "waiting" } : { status: "not-required" };
	let inFlight: Promise<DatabaseReaderState> | null = null;
	let lastProbeAt = Number.NEGATIVE_INFINITY;

	const probe = (): Promise<DatabaseReaderState> => {
		if (inFlight) return inFlight;
		lastProbeAt = now();
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<DatabaseReaderState>((resolve) => {
			timer = setTimeout(() => {
				controller.abort();
				resolve({
					status: "failed",
					code: "DB_READERS_TIMEOUT",
					reason: `probe exceeded ${timeoutMs}ms`,
				});
			}, timeoutMs);
		});
		const attempt = Promise.resolve()
			.then(() => options.probe({ signal: controller.signal, timeoutMs }))
			.then(
				(): DatabaseReaderState => ({ status: "ready" }),
				(error: unknown): DatabaseReaderState => ({
					status: "failed",
					code: "DB_READERS_UNAVAILABLE",
					reason: error instanceof Error ? error.message : String(error),
				}),
			);
		inFlight = Promise.race([attempt, timeout]).then((verdict) => {
			clearTimeout(timer);
			state = verdict;
			inFlight = null;
			return verdict;
		});
		return inFlight;
	};

	if (options.backend === "sqlite") void probe();

	return {
		get state() {
			return state;
		},
		async wait() {
			if (state.status === "not-required") return state;
			if (state.status === "ready") {
				const live = options.availability?.();
				if (!live || live.available) return state;
				state = {
					status: "failed",
					code: "DB_READERS_UNAVAILABLE",
					reason: live.reason ?? "unavailable",
				};
			}
			if (inFlight) return inFlight;
			if (state.status === "failed" && now() - lastProbeAt < retryIntervalMs) return state;
			return probe();
		},
	};
}
