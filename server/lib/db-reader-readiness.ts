import { renderErrorMessage } from "../../shared/error-catalog";

export type DatabaseReaderFailureCode = "DB_READERS_UNAVAILABLE" | "DB_READERS_TIMEOUT";
export type DatabaseReaderState =
	| { status: "waiting" | "ready" | "not-required" }
	| { status: "failed"; code: DatabaseReaderFailureCode };
export type DatabaseReaderResult = { ok: true } | { ok: false; code: DatabaseReaderFailureCode };

export interface DatabaseReaderReadiness {
	readonly state: DatabaseReaderState;
	/** Bounded startup probe, followed by a fresh, non-spawning availability check. */
	wait(): Promise<DatabaseReaderResult>;
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
	return Response.json(
		{
			error: renderErrorMessage("DATABASE_READ_UNAVAILABLE"),
			messageCode: "DATABASE_READ_UNAVAILABLE",
			code: state.status === "failed" ? state.code : "DB_READERS_UNAVAILABLE",
			databaseReaders: state,
		},
		{ status: 503, headers: { "Retry-After": "5" } },
	);
}

/** Dependencies are injected so readiness can be tested without bootstrapping a database. */
export function createDatabaseReaderReadiness(options: {
	backend: "sqlite" | "postgres";
	probe: (options: { signal: AbortSignal; timeoutMs: number }) => Promise<void>;
	availability: () => { available: boolean };
	/** Only consult registered database identity after the initial probe succeeded. */
	databaseAvailability?: () => { available: boolean };
	timeoutMs?: number;
}): DatabaseReaderReadiness {
	let state: DatabaseReaderState =
		options.backend === "postgres" ? { status: "not-required" } : { status: "waiting" };
	const snapshot = (): DatabaseReaderState => {
		if (state.status === "ready" || state.status === "waiting") {
			try {
				if (
					!options.availability().available ||
					(state.status === "ready" &&
						options.databaseAvailability &&
						!options.databaseAvailability().available)
				) {
					return { status: "failed", code: "DB_READERS_UNAVAILABLE" };
				}
			} catch {
				return { status: "failed", code: "DB_READERS_UNAVAILABLE" };
			}
		}
		return state;
	};
	const initial = (async () => {
		if (options.backend === "postgres") return;
		if (snapshot().status === "failed") {
			state = { status: "failed", code: "DB_READERS_UNAVAILABLE" };
			return;
		}
		const controller = new AbortController();
		const timeoutMs = options.timeoutMs ?? 30_000;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let timedOut = false;
		try {
			await Promise.race([
				Promise.resolve().then(() => options.probe({ signal: controller.signal, timeoutMs })),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						timedOut = true;
						controller.abort();
						reject(new Error("Database reader readiness deadline elapsed"));
					}, timeoutMs);
				}),
			]);
			state = { status: "ready" };
		} catch {
			state = {
				status: "failed",
				code: timedOut ? "DB_READERS_TIMEOUT" : "DB_READERS_UNAVAILABLE",
			};
		} finally {
			if (timer) clearTimeout(timer);
		}
	})();
	return {
		get state() {
			return snapshot();
		},
		async wait() {
			await initial;
			const current = snapshot();
			return databaseReadersAvailable(current)
				? { ok: true }
				: {
						ok: false,
						code: current.status === "failed" ? current.code : "DB_READERS_UNAVAILABLE",
					};
		},
	};
}
