/**
 * One-time tickets for unauthenticated executor binary downloads.
 *
 * A machine being enrolled has no NarraFork session yet, so the install script
 * needs some credential to fetch the binary. Using the device token for this was
 * rejected deliberately: that token only ever participates in the /ws/device
 * nonce/HMAC handshake and never crosses the wire in plaintext, and downloading a
 * public binary is not worth weakening that property.
 *
 * A ticket therefore authorizes exactly one action — "download the executor
 * binary for this platform, once" — and nothing else. Tickets live in memory
 * only: they expire in minutes, and a server restart simply means the admin
 * regenerates the script, so persisting them would add a table for no benefit.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { ExecutorPlatform } from "@shared/remote-executor";
import { logger } from "./logger";

export const EXECUTOR_TICKET_TTL_MS = 15 * 60 * 1000;
/** Bound on live tickets, so repeated script generation cannot grow memory. */
const MAX_LIVE_TICKETS = 200;
/** Ticket strings are compared in constant time; 32 bytes is far beyond guessable. */
const TICKET_BYTES = 32;

interface TicketRecord {
	/** Hex ticket value. Stored so lookups can compare in constant time. */
	value: string;
	platform: ExecutorPlatform;
	deviceId: string | null;
	expiresAt: number;
	consumedAt: number | null;
}

const tickets = new Map<string, TicketRecord>();

export interface IssuedExecutorTicket {
	ticket: string;
	platform: ExecutorPlatform;
	expiresAt: number;
}

export type ExecutorTicketRejection = "unknown" | "expired" | "already_used" | "platform_mismatch";

export interface ExecutorTicketRedemption {
	ok: boolean;
	reason?: ExecutorTicketRejection;
	deviceId?: string | null;
}

function pruneExpired(now: number): void {
	for (const [key, record] of tickets) {
		// Consumed tickets are kept until expiry so a replay reports "already used"
		// rather than the indistinguishable "unknown".
		if (record.expiresAt <= now) tickets.delete(key);
	}
}

/** Issue a single-use download ticket bound to one platform. */
export function issueExecutorTicket(
	platform: ExecutorPlatform,
	options: { deviceId?: string | null; now?: number } = {},
): IssuedExecutorTicket {
	const now = options.now ?? Date.now();
	pruneExpired(now);
	if (tickets.size >= MAX_LIVE_TICKETS) {
		// Drop the oldest live ticket rather than refusing to issue: an admin
		// generating a fresh script should always succeed.
		let oldestKey: string | null = null;
		let oldestExpiry = Number.POSITIVE_INFINITY;
		for (const [key, record] of tickets) {
			if (record.expiresAt < oldestExpiry) {
				oldestExpiry = record.expiresAt;
				oldestKey = key;
			}
		}
		if (oldestKey) tickets.delete(oldestKey);
	}

	const value = randomBytes(TICKET_BYTES).toString("hex");
	const record: TicketRecord = {
		value,
		platform,
		deviceId: options.deviceId ?? null,
		expiresAt: now + EXECUTOR_TICKET_TTL_MS,
		consumedAt: null,
	};
	tickets.set(value, record);
	return { ticket: value, platform, expiresAt: record.expiresAt };
}

function findRecord(ticket: string): TicketRecord | null {
	// Map lookup would leak length/prefix information through timing, so scan and
	// compare every candidate in constant time.
	const presented = Buffer.from(ticket, "utf-8");
	let match: TicketRecord | null = null;
	for (const record of tickets.values()) {
		const stored = Buffer.from(record.value, "utf-8");
		if (stored.length !== presented.length) continue;
		if (timingSafeEqual(stored, presented)) match = record;
	}
	return match;
}

/**
 * Redeem a ticket for one platform's binary. A ticket is valid at most once, and
 * only for the platform it was issued against.
 */
export function redeemExecutorTicket(
	ticket: string | undefined | null,
	platform: ExecutorPlatform,
	options: { now?: number } = {},
): ExecutorTicketRedemption {
	const now = options.now ?? Date.now();
	const value = ticket?.trim();
	if (!value || !/^[0-9a-f]{2,256}$/.test(value)) {
		pruneExpired(now);
		return { ok: false, reason: "unknown" };
	}

	// Look the record up before pruning so an expired ticket is reported as such
	// rather than as an indistinguishable "unknown".
	const record = findRecord(value);
	if (!record) {
		pruneExpired(now);
		return { ok: false, reason: "unknown" };
	}
	if (record.expiresAt <= now) {
		tickets.delete(record.value);
		pruneExpired(now);
		return { ok: false, reason: "expired" };
	}
	pruneExpired(now);
	if (record.consumedAt !== null) return { ok: false, reason: "already_used" };
	if (record.platform !== platform) {
		// Do not consume: the ticket may still be used correctly, and a mismatch is
		// more likely a copy/paste of the wrong script than an attack.
		return { ok: false, reason: "platform_mismatch" };
	}

	record.consumedAt = now;
	logger.debug("Executor download ticket redeemed", {
		platform,
		deviceId: record.deviceId ?? undefined,
	});
	return { ok: true, deviceId: record.deviceId };
}

/** Live (unexpired) ticket count. Test and diagnostics helper. */
export function countLiveExecutorTickets(now = Date.now()): number {
	pruneExpired(now);
	return tickets.size;
}

/** Clear all tickets. Test-only seam. */
export function resetExecutorTickets(): void {
	tickets.clear();
}
