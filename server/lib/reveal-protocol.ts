/**
 * "Reveal in Explorer" via `narrafork://` protocol activation (Windows).
 *
 * The server is a background process, so an Explorer window it opens is usually denied the
 * foreground. Instead the browser — the foreground process, acting on the user's click — opens
 * `narrafork://reveal/<token>`; Windows starts this same exe as a short-lived protocol client,
 * which claims the path from the running server and opens Explorer with foreground rights.
 *
 * The URI never carries a path: any web page can navigate to `narrafork://`, so it only carries a
 * one-time token the server issued for a path it already validated. Where to reach the server is
 * baked into the registered command line (see reveal-protocol-registration.ts), not the URI, so a
 * page cannot point the client at a server of its choosing.
 *
 * Kept light: the protocol client imports it before anything else loads.
 */

import { generateId } from "./id";

export const REVEAL_PROTOCOL_SCHEME = "narrafork";
/** argv flag carrying the origin of the server that registered the handler. */
export const REVEAL_SERVER_FLAG = "--reveal-server=";
/** Public endpoint (no session auth: the token is the credential) the client claims a path from. */
export const REVEAL_CLAIM_PATH = "/api/reveal-protocol";

const URI_PREFIX = `${REVEAL_PROTOCOL_SCHEME}://reveal/`;
const TOKEN_TTL_MS = 10_000;

export function buildRevealUri(token: string): string {
	return `${URI_PREFIX}${token}`;
}

/** The protocol activation in argv, if this process was started by one. */
export function parseRevealActivation(argv: string[]): { token: string; server: string } | null {
	const uri = argv.find((arg) => arg.toLowerCase().startsWith(`${REVEAL_PROTOCOL_SCHEME}://`));
	if (!uri) return null;
	const token = uri.startsWith(URI_PREFIX) ? uri.slice(URI_PREFIX.length).replace(/\/$/, "") : "";
	const flag = argv.find((arg) => arg.startsWith(REVEAL_SERVER_FLAG));
	return { token, server: flag?.slice(REVEAL_SERVER_FLAG.length) ?? "" };
}

export interface RevealTarget {
	path: string;
	selectFile: boolean;
}

const pending = new Map<string, RevealTarget & { expiresAt: number }>();

/** Authorize one reveal of a file or directory within a few seconds. */
export function issueRevealToken(target: RevealTarget, now = Date.now()): string {
	for (const [token, entry] of pending) {
		if (entry.expiresAt <= now) pending.delete(token);
	}
	const token = generateId();
	pending.set(token, { ...target, expiresAt: now + TOKEN_TTL_MS });
	return token;
}

/** Consume a token: its path and file-selection flag, or null if unknown or expired. */
export function claimRevealToken(token: string, now = Date.now()): RevealTarget | null {
	const entry = pending.get(token);
	pending.delete(token);
	return entry && entry.expiresAt > now ? { path: entry.path, selectFile: entry.selectFile } : null;
}
