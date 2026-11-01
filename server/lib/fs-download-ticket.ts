/**
 * fs-download-ticket.ts — one-time tickets that let the BROWSER download a file itself.
 *
 * ## Why this exists
 *
 * `GET /api/fs/download?path=…` authenticates with a `Bearer` header, so a URL cannot simply be
 * handed to the browser: a navigation carries no such header. The alternative — `fetch()` the
 * bytes into a Blob — costs a full copy in page memory, cannot report progress, loses Range, and
 * is subject to the browser's "download not triggered by a gesture" heuristics because the click
 * gesture ends at the first `await`.
 *
 * A ticket fixes all of that by being a credential that travels IN the query string, so the native
 * download path (streamed to disk, progress, resume) stays available.
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
 * 3. **Consumption is single-use.** A ticket is spent the moment it is claimed, so a leaked URL
 *    cannot be reused after the legitimate download started.
 *
 * Spent records are kept until their expiry so a replay is reported as `already_used` rather than
 * the indistinguishable `unknown` — the first is the signature of a leaked URL, the second of a
 * guess.
 *
 * ## Known trade-off
 *
 * Single-use means a download manager that retries, or a user who resumes an interrupted GB-scale
 * transfer, needs a fresh ticket. That is the correct trade for a credential in a URL (the opposite
 * — a reusable ticket — is a longer-lived bearer token in the clear), and the client asks for a
 * ticket per click, so retrying is a second click rather than a broken state.
 *
 * Tickets are in-memory only: 60 seconds is far too short for persistence to buy anything, and a
 * restart legitimately invalidates every outstanding download URL.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { settings } from "./settings";

/**
 * One minute — a ticket only has to survive the trip from an issued response to the browser's
 * navigation, which is the next statement in the click handler. Short enough that a leaked URL is
 * usually already dead by the time anyone finds it.
 */
export const DOWNLOAD_TICKET_TTL_MS = 60_000;

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
	/** Set once claimed; kept until expiry so a replay says `already_used`. */
	consumed: boolean;
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
	if (tickets.size >= MAX_LIVE_TICKETS) {
		// Drop the oldest rather than refusing: a user clicking download should always succeed, and
		// the evicted ticket is one whose download never started.
		let oldestNonce: string | null = null;
		let oldestExpiry = Number.POSITIVE_INFINITY;
		for (const [nonce, record] of tickets) {
			if (record.expiresAt < oldestExpiry) {
				oldestExpiry = record.expiresAt;
				oldestNonce = nonce;
			}
		}
		if (oldestNonce) tickets.delete(oldestNonce);
	}

	const nonce = randomBytes(NONCE_BYTES).toString("hex");
	const expiresAt = now + DOWNLOAD_TICKET_TTL_MS;
	tickets.set(nonce, { path: absPath, expiresAt, consumed: false });

	return {
		ticket: `${expiresAt.toString(36)}.${nonce}.${sign(absPath, expiresAt, nonce)}`,
		expiresAt,
		expiresInMs: DOWNLOAD_TICKET_TTL_MS,
	};
}

/**
 * Redeem a ticket, consuming it.
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

	if (record.consumed) {
		pruneExpired(now);
		return { ok: false, reason: "already_used" };
	}
	if (record.expiresAt <= now) {
		tickets.delete(nonce);
		pruneExpired(now);
		return { ok: false, reason: "expired" };
	}

	record.consumed = true;
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
