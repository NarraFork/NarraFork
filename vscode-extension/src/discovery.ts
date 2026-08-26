/**
 * discovery.ts — Find the NarraFork backend this window should talk to.
 *
 * The extension deliberately does NOT start or manage a backend. It attaches to one the
 * user is already running, which means the only hard problem here is "which URL", and
 * the only honest answer is "the one that responds".
 *
 * `/api/health` is the probe because it is the single endpoint that is public (no
 * session) AND identifies the software (it returns `version`/`commit`). A TCP connect
 * would prove only that something is listening — and on a developer machine something
 * usually is.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Default listen port, matching `DEFAULTS.server.port` in the backend settings. */
export const DEFAULT_BACKEND_PORT = 7778;

const PROBE_TIMEOUT_MS = 3_000;

export interface BackendEndpoint {
	/** Origin with no trailing slash, e.g. `http://127.0.0.1:7778`. */
	origin: string;
	version?: string;
	/** How this endpoint was chosen, for the status bar and error messages. */
	source: "configured" | "settings-file" | "default";
}

export interface DiscoveryFailure {
	/** Every candidate tried, so the message can say what was attempted. */
	attempted: string[];
	/** True when the user pinned a URL — the message must not suggest a fallback. */
	configured: boolean;
}

export type DiscoveryResult =
	| { ok: true; endpoint: BackendEndpoint }
	| { ok: false; failure: DiscoveryFailure };

interface HealthPayload {
	status?: unknown;
	version?: unknown;
}

/** Normalize a user-supplied base URL to a bare origin, or null when unusable. */
export function normalizeOrigin(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	// A bare `host:port` is what a user most naturally types; assume http, which is the
	// default the backend actually listens with.
	const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
	try {
		const url = new URL(withScheme);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		return url.origin;
	} catch {
		return null;
	}
}

/**
 * Read `server.port` / `server.tls.enabled` from the backend's settings file.
 *
 * Reads the file rather than asking the user because in every supported topology the
 * extension host runs on the SAME machine as the backend — that is the premise of the
 * whole feature. Returns null on any failure (absent file, unreadable, malformed); this
 * is a hint, and a bad hint must degrade to the default rather than to an error.
 */
export async function readConfiguredPortFromSettings(
	settingsPath = join(
		process.env.NARRAFORK_HOME?.trim() || join(homedir(), ".narrafork"),
		"settings.json",
	),
): Promise<{ origin: string } | null> {
	let raw: string;
	try {
		raw = await readFile(settingsPath, "utf8");
	} catch {
		return null;
	}

	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return null;
		const server = (parsed as { server?: unknown }).server;
		if (!server || typeof server !== "object") return null;
		const port = (server as { port?: unknown }).port;
		if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
			return null;
		}
		const tls = (server as { tls?: unknown }).tls;
		const tlsEnabled =
			!!tls && typeof tls === "object" && (tls as { enabled?: unknown }).enabled === true;
		// 127.0.0.1 rather than the configured `host`: that field is a BIND address
		// ("0.0.0.0" is common) and is not necessarily a reachable name. Loopback always
		// reaches a local listener, whatever it bound to.
		return { origin: `${tlsEnabled ? "https" : "http"}://127.0.0.1:${port}` };
	} catch {
		return null;
	}
}

/** Probe one origin. Returns its version on success, null otherwise. */
export async function probeBackend(
	origin: string,
	fetchImpl: typeof fetch = fetch,
	timeoutMs = PROBE_TIMEOUT_MS,
): Promise<{ version?: string } | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetchImpl(`${origin}/api/health`, {
			signal: controller.signal,
			// The probe must reflect the CURRENT state; a cached 200 from a backend that has
			// since stopped would make the status bar claim a connection that is gone.
			//
			// Expressed as a header rather than `cache: "no-store"`: the extension host runs
			// on Node, whose `RequestInit` has no `cache` field, so that option would be a
			// type error here and a silent no-op if forced through.
			headers: { "Cache-Control": "no-cache" },
		});
		// A 503 is a real NarraFork answering while startup recovery failed — the UI is
		// still reachable and is in fact where the user repairs that state, so it counts
		// as found. Anything else (404 from an unrelated server, 502 from a proxy) does not.
		if (!response.ok && response.status !== 503) return null;
		const payload = (await response.json()) as HealthPayload;
		if (typeof payload.status !== "string") return null;
		return { version: typeof payload.version === "string" ? payload.version : undefined };
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

export interface DiscoverOptions {
	/** `narrafork.serverUrl`; when set, it is the ONLY candidate. */
	configuredUrl?: string;
	fetchImpl?: typeof fetch;
	readSettings?: typeof readConfiguredPortFromSettings;
	timeoutMs?: number;
}

/**
 * Resolve the backend endpoint, trying candidates in order of authority.
 *
 * ⚠️ A configured URL short-circuits every other candidate, including the default. That
 * is the point: silently falling back after the user pinned an address would connect
 * them to a DIFFERENT backend than the one they named — with the status bar reporting
 * success. A wrong pin has to fail visibly.
 */
export async function discoverBackend(options: DiscoverOptions = {}): Promise<DiscoveryResult> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const readSettings = options.readSettings ?? readConfiguredPortFromSettings;
	const attempted: string[] = [];

	const configured = options.configuredUrl ? normalizeOrigin(options.configuredUrl) : null;
	if (options.configuredUrl?.trim()) {
		if (!configured) {
			return {
				ok: false,
				failure: { attempted: [options.configuredUrl.trim()], configured: true },
			};
		}
		attempted.push(configured);
		const health = await probeBackend(configured, fetchImpl, options.timeoutMs);
		if (health) {
			return {
				ok: true,
				endpoint: { origin: configured, version: health.version, source: "configured" },
			};
		}
		return { ok: false, failure: { attempted, configured: true } };
	}

	const candidates: Array<{ origin: string; source: BackendEndpoint["source"] }> = [];
	const fromSettings = await readSettings();
	if (fromSettings) candidates.push({ origin: fromSettings.origin, source: "settings-file" });
	const fallback = `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`;
	if (!candidates.some((candidate) => candidate.origin === fallback)) {
		candidates.push({ origin: fallback, source: "default" });
	}

	for (const candidate of candidates) {
		attempted.push(candidate.origin);
		const health = await probeBackend(candidate.origin, fetchImpl, options.timeoutMs);
		if (health) {
			return {
				ok: true,
				endpoint: { origin: candidate.origin, version: health.version, source: candidate.source },
			};
		}
	}

	return { ok: false, failure: { attempted, configured: false } };
}
