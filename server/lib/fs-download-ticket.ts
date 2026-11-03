/**
 * fs-download-ticket.ts — short-lived tickets that let the BROWSER download a file itself.
 *
 * ## Why this exists
 *
 * `GET /api/fs/download?path=…` authenticates with a `Bearer` header, so a URL cannot simply be
 * handed to the browser: a navigation carries no such header. Fetching the bytes into a Blob
 * copies the whole file into page memory, cannot report progress, and loses Range.
 *
 * A ticket is a credential that travels in the query string. The click handler opens a tab
 * synchronously, then points that tab at the ticket URL once this module has minted one. The
 * file itself is saved because the response carries `Content-Disposition: attachment`. A rejected
 * claim is an HTML page in that same tab, not a file saved under the real name.
 *
 * ## What each layer contributes
 *
 * The ticket is `<expiresAt>.<nonce>.<signature>`, and neither layer alone is the design:
 *
 * 1. **The nonce indexes an in-memory record that holds the path.** The path deliberately never
 *    appears in the URL: a download URL lands in browser history, in `Referer`, and in proxy access
 *    logs, and an absolute path there leaks the workspace layout for no benefit.
 * 2. **The HMAC binds `path|expiresAt|nonce`** under `auth.jwtSecret`, so the expiry cannot be
 *    extended by editing the token, and a record that somehow disagreed with its token is rejected
 *    rather than trusted. `SIGNING_CONTEXT` domain-separates these signatures from the other uses
 *    of the same secret (MFA challenges, auth-attempt fingerprints) — sharing a key across
 *    protocols without separation is how a signature made for one purpose gets replayed at another.
 * 3. **A ticket may be claimed a few times, then it is spent.** Browsers and download managers
 *    often probe the URL and then request it again. One claim would make that second request
 *    fail the download the user just clicked. The cap stays small so a leaked URL is not a
 *    reusable bearer. Past the cap, the replay is `already_used`, distinct from `unknown`.
 *
 * Records are kept until their expiry so a replay inside the window is reported as `already_used`
 * rather than the indistinguishable `unknown` — the first is the signature of a leaked URL, the
 * second of a guess.
 *
 * ## Known trade-off
 *
 * A download manager that resumes an interrupted transfer after the window, or after the claim
 * cap, needs a fresh ticket. That is a second click. The opposite — an unbounded reusable ticket —
 * would be a longer-lived bearer token sitting in the clear.
 *
 * Tickets are in-memory only: 60 seconds is far too short for persistence to buy anything, and a
 * restart legitimately invalidates every outstanding download URL.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { settings } from "./settings";

/**
 * One minute. Long enough for the click handler to mint a ticket and navigate the tab it already
 * opened, short enough that a leaked URL is usually dead by the time anyone finds it.
 */
export const DOWNLOAD_TICKET_TTL_MS = 60_000;

/**
 * How many times one ticket may be redeemed.
 *
 * Two is the browser probe plus the real GET. The third covers a download manager that retries
 * once inside the same click. It is not a resume token.
 */
export const DOWNLOAD_TICKET_MAX_CLAIMS = 3;

/** Bound on live tickets, so clicking download repeatedly cannot grow memory without limit. */
const MAX_LIVE_TICKETS = 200;

/** 16 random bytes: far beyond guessable, and short enough to keep the URL tidy. */
const NONCE_BYTES = 16;

/**
 * Domain separator mixed into every signature.
 *
 * `auth.jwtSecret` also signs MFA challenges and auth-attempt fingerprints; prefixing the transcript
 * means a signature minted for one of those can never be presented here (or the reverse) even though
 * the key is the same.
 */
const SIGNING_CONTEXT = "narrafork/fs-download-ticket/v1";

interface TicketRecord {
	/** Absolute path, already validated when the ticket was issued. */
	path: string;
	expiresAt: number;
	/** Successful claims so far. Kept until expiry so an over-cap replay says `already_used`. */
	claims: number;
}

/** Keyed by nonce. */
const tickets = new Map<string, TicketRecord>();

export type DownloadTicketRejection = "unknown" | "expired" | "already_used" | "forged";

export interface IssuedDownloadTicket {
	/** The opaque `<expiresAt>.<nonce>.<signature>` string to put in the download URL. */
	ticket: string;
	/** Absolute epoch ms the ticket dies. */
	expiresAt: number;
	/** Convenience for the client, which only needs to know how long it has. */
	expiresInMs: number;
}

export type DownloadTicketClaim =
	| { ok: true; path: string }
	| { ok: false; reason: DownloadTicketRejection };

function pruneExpired(now: number): void {
	for (const [nonce, record] of tickets) {
		if (record.expiresAt <= now) tickets.delete(nonce);
	}
}

/**
 * Free one slot. A ticket the browser already fetched is dropped before one that has not been
 * claimed yet, so a burst of finished downloads does not cancel a click that is still in flight.
 */
function evictOneTicket(): void {
	const entries = [...tickets.entries()];
	const claimed = entries.filter(([, record]) => record.claims > 0);
	const pool = claimed.length > 0 ? claimed : entries;
	let oldestNonce: string | null = null;
	let oldestExpiry = Number.POSITIVE_INFINITY;
	for (const [nonce, record] of pool) {
		if (record.expiresAt < oldestExpiry) {
			oldestExpiry = record.expiresAt;
			oldestNonce = nonce;
		}
	}
	if (oldestNonce) tickets.delete(oldestNonce);
}

/**
 * `base64url` so the token survives a query string untouched: no `+`, `/` or `=` to escape, and no
 * `.` that would confuse the separator.
 */
function sign(path: string, expiresAt: number, nonce: string): string {
	return createHmac("sha256", settings.auth.jwtSecret)
		.update(`${SIGNING_CONTEXT}|${path}|${expiresAt}|${nonce}`, "utf8")
		.digest("base64url");
}

/** Constant-time compare of two base64url signatures of possibly different lengths. */
function signaturesMatch(presented: string, expected: string): boolean {
	const a = Buffer.from(presented, "utf-8");
	const b = Buffer.from(expected, "utf-8");
	// `timingSafeEqual` throws on a length mismatch, which would itself be a timing signal.
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/**
 * Mint a ticket for an already-validated absolute path.
 *
 * Validation is the caller's job and must happen first: this module stores whatever it is given, and
 * the whole point of issuing from the authenticated route is that the path was checked while a
 * session was present.
 */
export function issueDownloadTicket(absPath: string, now = Date.now()): IssuedDownloadTicket {
	pruneExpired(now);
	if (tickets.size >= MAX_LIVE_TICKETS) evictOneTicket();

	const nonce = randomBytes(NONCE_BYTES).toString("hex");
	const expiresAt = now + DOWNLOAD_TICKET_TTL_MS;
	tickets.set(nonce, { path: absPath, expiresAt, claims: 0 });

	return {
		ticket: `${expiresAt.toString(36)}.${nonce}.${sign(absPath, expiresAt, nonce)}`,
		expiresAt,
		expiresInMs: DOWNLOAD_TICKET_TTL_MS,
	};
}

/**
 * Redeem a ticket, counting one claim.
 *
 * Rejections are ordered so the message is the most specific true statement: a forged token is named
 * as forged (not "unknown"), and a spent one as spent (not "unknown"), because those two cases are
 * what an operator has to tell apart when a leaked URL is suspected.
 */
export function claimDownloadTicket(
	ticket: string | null | undefined,
	now = Date.now(),
): DownloadTicketClaim {
	const value = ticket?.trim();
	if (!value) return { ok: false, reason: "unknown" };

	const parts = value.split(".");
	if (parts.length !== 3) return { ok: false, reason: "unknown" };
	const [expiryPart = "", nonce, signature = ""] = parts;
	if (!expiryPart || !nonce || !signature) return { ok: false, reason: "unknown" };

	const expiresAt = Number.parseInt(expiryPart, 36);
	if (!Number.isFinite(expiresAt)) return { ok: false, reason: "unknown" };

	// Look up before pruning so an expired ticket reports `expired` rather than `unknown`.
	const record = tickets.get(nonce);
	if (!record) {
		pruneExpired(now);
		return { ok: false, reason: "unknown" };
	}

	// The token must agree with the record it indexes: editing the expiry, or pointing a signature
	// at another record's nonce, fails here.
	if (record.expiresAt !== expiresAt) return { ok: false, reason: "forged" };
	if (!signaturesMatch(signature, sign(record.path, record.expiresAt, nonce))) {
		return { ok: false, reason: "forged" };
	}

	if (record.expiresAt <= now) {
		tickets.delete(nonce);
		pruneExpired(now);
		return { ok: false, reason: "expired" };
	}
	if (record.claims >= DOWNLOAD_TICKET_MAX_CLAIMS) {
		pruneExpired(now);
		return { ok: false, reason: "already_used" };
	}

	record.claims += 1;
	pruneExpired(now);
	return { ok: true, path: record.path };
}

/** Live (unexpired) ticket count. Test and diagnostics helper. */
export function countLiveDownloadTickets(now = Date.now()): number {
	pruneExpired(now);
	return tickets.size;
}

/** Clear all tickets. Test-only seam. */
export function resetDownloadTickets(): void {
	tickets.clear();
}
