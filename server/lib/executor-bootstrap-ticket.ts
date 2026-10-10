/**
 * Short-lived enrollment tickets for unauthenticated executor bootstrap.
 *
 * A machine being enrolled has no NarraFork session yet, so the install flow
 * needs *some* credential. One ticket authorizes up to three narrowly scoped
 * actions, each counted separately:
 *
 * - `script` — fetch the generated install script body. This is what makes a
 *   copy-paste one-liner possible at all.
 * - `binary` — download the executor binary for one platform.
 * - `token`  — exchange for the device registration token, at most **once**.
 *
 * `script` and `binary` allow a handful of attempts because a half-finished
 * download is ordinary; `token` does not, because a second successful exchange
 * would mean two parties hold the credential.
 *
 * ## The security trade this represents
 *
 * The earlier design deliberately kept the token out of the install script so the
 * script itself carried nothing: it could be forwarded, pasted into chat, or left
 * in a scrollback with no consequence. The cost was that a human had to carry the
 * token by hand, which is the workflow this replaces.
 *
 * Once `token` delivery exists, the ticket *is* the credential. Three properties
 * are what make that acceptable, and removing any one of them silently weakens
 * enrollment rather than breaking it:
 *
 * 1. **Minutes, not hours.** The TTL is short enough that a leaked ticket is
 *    usually already dead.
 * 2. **Exchange rotates the device token** (the caller does this — see
 *    `rotateDeviceTokenInTransaction`), and invalidates the whole ticket. So a
 *    stolen ticket redeemed first makes the legitimate run *fail loudly* instead
 *    of quietly sharing a credential.
 * 3. **Only over https or a private network** (enforced by the route layer, which
 *    is where the request origin is known).
 *
 * `allowTokenDelivery: false` exists so the old prompt-based script can keep
 * using tickets for `script`/`binary` while being structurally unable to hand out
 * a token — the guarantee is in the ticket, not in the script text.
 *
 * Tickets live in memory only: they expire in minutes, and a server restart just
 * means the operator regenerates the script, so persisting them would add a table
 * for no benefit.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { ExecutorPlatform } from "@shared/remote-executor";
import { helperSourceIdentity } from "../../shared/helper-distribution";
import { ValidationError } from "./errors";
import type { ExecutorArtifactBinding } from "./executor-binaries";
import { captureHelperSource } from "./helper-distribution-runtime";
import { logger } from "./logger";

/**
 * 10 minutes. Shorter than the original 15 because a ticket can now yield the
 * device token, so its lifetime is a credential lifetime rather than a
 * convenience window.
 */
export const EXECUTOR_TICKET_TTL_MS = 10 * 60 * 1000;
/** Bound on live tickets, so repeated script generation cannot grow memory. */
const MAX_LIVE_TICKETS = 200;
/** Ticket strings are compared in constant time; 32 bytes is far beyond guessable. */
const TICKET_BYTES = 32;

export type ExecutorTicketPurpose = "script" | "binary" | "token";

/**
 * Per-purpose attempt budget.
 *
 * `script`/`binary` tolerate retries: a dropped connection on a multi-megabyte
 * download is routine and re-running the one-liner is the obvious human response.
 * `token` is 1 because two successful exchanges mean two holders of the
 * credential — there is no benign reading of that.
 */
const PURPOSE_LIMITS: Record<ExecutorTicketPurpose, number> = {
	script: 5,
	binary: 5,
	token: 1,
};

/** Bound on the recorded user agent, which is untrusted request input. */
const MAX_RECORDED_USER_AGENT_CHARS = 256;

export interface ExecutorTicketUse {
	ip: string;
	at: number;
	userAgent: string | null;
}

interface TicketRecord {
	artifact: ExecutorArtifactBinding | null;
	/** Hex ticket value. Stored so lookups can compare in constant time. */
	value: string;
	platform: ExecutorPlatform;
	deviceId: string | null;
	deviceSlug: string | null;
	/** False for prompt-mode scripts: such a ticket can never yield a token. */
	allowTokenDelivery: boolean;
	/** Pre-rendered script body, so the public endpoint never touches the DB. */
	script: string | null;
	scriptFilename: string | null;
	scriptShell: "sh" | "powershell" | null;
	expiresAt: number;
	usesByPurpose: Record<ExecutorTicketPurpose, number>;
	/** Set once the token has been handed out: the ticket is spent entirely. */
	invalidated: boolean;
	/** First observed redemption, for after-the-fact attribution. */
	firstUse: ExecutorTicketUse | null;
	lastUse: ExecutorTicketUse | null;
}

const tickets = new Map<string, TicketRecord>();

export interface IssueExecutorTicketOptions {
	artifact?: ExecutorArtifactBinding;
	/** Cancel only new issuance, never redemption of an already frozen ticket. */
	signal?: AbortSignal;
	deviceId?: string | null;
	deviceSlug?: string | null;
	/** Defaults to false: a ticket only yields a token when asked to. */
	allowTokenDelivery?: boolean;
	/** Script body served by the public `script` endpoint. */
	script?: { body: string; filename: string; shell: "sh" | "powershell" } | null;
	now?: number;
}

export interface IssuedExecutorTicket {
	ticket: string;
	platform: ExecutorPlatform;
	expiresAt: number;
	allowTokenDelivery: boolean;
}

export type ExecutorTicketRejection =
	| "unknown"
	| "expired"
	| "already_used"
	| "platform_mismatch"
	| "purpose_not_allowed"
	| "purpose_exhausted";

export interface ExecutorTicketRedemption {
	artifact?: ExecutorArtifactBinding | null;
	ok: boolean;
	reason?: ExecutorTicketRejection;
	deviceId?: string | null;
	deviceSlug?: string | null;
	/**
	 * The FIRST redemption of this ticket, on a rejection caused by the ticket
	 * already being spent (`already_used` / `purpose_exhausted`).
	 *
	 * This is the one signal that separates "the operator re-ran their own command"
	 * from "someone else redeemed it first". Without it the rejection log shows only
	 * the loser's address, which is exactly the party that is not interesting.
	 * Populated on rejection rather than success because that is when it is
	 * actionable, and omitted entirely for an unknown or expired ticket, where there
	 * is nothing to attribute.
	 */
	firstUse?: ExecutorTicketUse | null;
	/** Present for a successful `script` redemption. */
	script?: { body: string; filename: string; shell: "sh" | "powershell" } | null;
}

function emptyUses(): Record<ExecutorTicketPurpose, number> {
	return { script: 0, binary: 0, token: 0 };
}

function pruneExpired(now: number): void {
	for (const [key, record] of tickets) {
		// Spent tickets are kept until expiry so a replay reports "already used"
		// rather than the indistinguishable "unknown".
		if (record.expiresAt <= now) tickets.delete(key);
	}
}

/** Issue an enrollment ticket bound to one platform. */
export function issueExecutorTicket(
	platform: ExecutorPlatform,
	options: IssueExecutorTicketOptions = {},
): IssuedExecutorTicket {
	options.signal?.throwIfAborted();
	if (
		options.artifact &&
		helperSourceIdentity(options.artifact.source) !== helperSourceIdentity(captureHelperSource())
	) {
		throw new ValidationError(
			"Executor distribution source changed; generate a new install command",
		);
	}
	const now = options.now ?? Date.now();
	pruneExpired(now);
	if (tickets.size >= MAX_LIVE_TICKETS) {
		// Drop the oldest live ticket rather than refusing to issue: an operator
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
	if (options.artifact && options.artifact.platform !== platform)
		throw new Error("Executor ticket artifact platform mismatch");
	const record: TicketRecord = {
		artifact: options.artifact
			? Object.freeze({
					...options.artifact,
					source: Object.freeze({ ...options.artifact.source }),
				})
			: null,
		value,
		platform,
		deviceId: options.deviceId ?? null,
		deviceSlug: options.deviceSlug ?? null,
		allowTokenDelivery: options.allowTokenDelivery ?? false,
		script: options.script?.body ?? null,
		scriptFilename: options.script?.filename ?? null,
		scriptShell: options.script?.shell ?? null,
		expiresAt: now + EXECUTOR_TICKET_TTL_MS,
		usesByPurpose: emptyUses(),
		invalidated: false,
		firstUse: null,
		lastUse: null,
	};
	tickets.set(value, record);
	return {
		ticket: value,
		platform,
		expiresAt: record.expiresAt,
		allowTokenDelivery: record.allowTokenDelivery,
	};
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

function recordUse(record: TicketRecord, context: RedeemContext, now: number): void {
	const use: ExecutorTicketUse = {
		ip: context.ip ?? "unknown",
		at: now,
		userAgent: context.userAgent?.slice(0, MAX_RECORDED_USER_AGENT_CHARS) ?? null,
	};
	record.firstUse ??= use;
	record.lastUse = use;
}

export interface RedeemContext {
	ip?: string | null;
	userAgent?: string | null;
	now?: number;
}

/**
 * Redeem a ticket for one purpose.
 *
 * A `token` redemption consumes the entire ticket: the caller is expected to
 * rotate the device token, so any later use of the same ticket would refer to a
 * secret that no longer exists.
 */
export function redeemExecutorTicket(
	ticket: string | undefined | null,
	platform: ExecutorPlatform,
	purpose: ExecutorTicketPurpose,
	context: RedeemContext = {},
): ExecutorTicketRedemption {
	const now = context.now ?? Date.now();
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

	/*
	 * From here on the ticket is known and live, so a rejection can safely say which
	 * device it belonged to and who redeemed it first: the caller already proved it
	 * holds the ticket, and the route only puts this in the server log — the HTTP body
	 * stays generic.
	 *
	 * Distinct from the `unknown`/`expired` exits above, which reveal nothing on
	 * purpose.
	 */
	const attribution = {
		deviceId: record.deviceId,
		deviceSlug: record.deviceSlug,
		firstUse: record.firstUse,
	};

	// A spent ticket carries who spent it: on this rejection the caller is the party
	// that LOST the race, so its own address explains nothing.
	if (record.invalidated) {
		return { ok: false, reason: "already_used", ...attribution };
	}
	if (purpose === "token" && !record.allowTokenDelivery) {
		return { ok: false, reason: "purpose_not_allowed", ...attribution };
	}
	if (purpose === "script" && !record.script) {
		return { ok: false, reason: "purpose_not_allowed", ...attribution };
	}
	if (record.usesByPurpose[purpose] >= PURPOSE_LIMITS[purpose]) {
		return { ok: false, reason: "purpose_exhausted", ...attribution };
	}
	if (record.platform !== platform) {
		// Do not consume: the ticket may still be used correctly, and a mismatch is
		// more likely a copy/paste of the wrong script than an attack.
		return { ok: false, reason: "platform_mismatch", ...attribution };
	}

	record.usesByPurpose[purpose] += 1;
	recordUse(record, context, now);
	// The token is the whole point of the ticket; handing it out ends the ticket's
	// life so a replay is a visible failure rather than a silent second holder.
	if (purpose === "token") record.invalidated = true;

	logger.debug("Executor ticket redeemed", {
		platform,
		purpose,
		deviceId: record.deviceId ?? undefined,
	});
	return {
		ok: true,
		artifact: purpose === "binary" ? record.artifact : null,
		deviceId: record.deviceId,
		deviceSlug: record.deviceSlug,
		script:
			purpose === "script" && record.script
				? {
						body: record.script,
						filename: record.scriptFilename ?? "install-narrafork-executor",
						shell: record.scriptShell ?? "sh",
					}
				: null,
	};
}

/**
 * Attach the rendered script body to an already-issued ticket.
 *
 * Exists because the script and the ticket refer to each other: the script embeds
 * its ticket in the download/enroll URLs, and the ticket must hold the script so
 * the public fetch endpoint can serve it without a database read. The ticket is
 * therefore minted first and the body attached once rendered.
 *
 * Ignores an unknown ticket rather than throwing: the only way to get here is with
 * a value this module just issued, and the caller has nothing useful to do about a
 * ticket that expired in between.
 */
export function attachExecutorTicketScript(
	ticket: string,
	script: { body: string; filename: string; shell: "sh" | "powershell" },
): void {
	const record = findRecord(ticket);
	if (!record) return;
	record.script = script.body;
	record.scriptFilename = script.filename;
	record.scriptShell = script.shell;
}

/**
 * First/last redemption of a ticket. Test and diagnostics helper — the routes
 * surface this only through a rejection's `firstUse` attribution; `lastUse` has
 * no production reader, so this accessor is the only way to observe it. Returns
 * null if the ticket is unknown.
 */
export function peekExecutorTicketUse(
	ticket: string,
): { firstUse: ExecutorTicketUse | null; lastUse: ExecutorTicketUse | null } | null {
	const record = findRecord(ticket);
	if (!record) return null;
	return { firstUse: record.firstUse, lastUse: record.lastUse };
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
