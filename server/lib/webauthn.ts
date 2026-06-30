/**
 * WebAuthn / passkey challenge storage. Relying-party resolution lives in
 * lib/webauthn-rp.ts (pure logic) and is re-exported here for convenience.
 */
import { and, eq, lt } from "drizzle-orm";
import { db } from "../db";
import { webauthnChallenges } from "../db/schema";
import { hotTimer } from "./hot-safe";
import { generateId } from "./id";
import { logger } from "./logger";
import { type ResolvedRp, resolveRp } from "./webauthn-rp";

export { type ResolvedRp, resolveRp };

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CHALLENGE_CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const CHALLENGE_CLEANUP_TIMER_KEY = "narrafork.webauthnChallengeCleanupTimer";

/** Persist a freshly generated challenge for later verification. Single-use. */
export async function saveChallenge(
	challenge: string,
	type: "registration" | "authentication",
	userId: string | null,
): Promise<void> {
	const now = Date.now();
	await db.insert(webauthnChallenges).values({
		id: generateId(),
		challenge,
		type,
		userId: userId ?? null,
		expiresAt: now + CHALLENGE_TTL_MS,
		createdAt: new Date(now).toISOString(),
	});
}

/**
 * Atomically fetch and delete a pending challenge (single-use). Returns the
 * row's userId association when valid and unexpired, or null otherwise.
 */
export async function consumeChallenge(
	challenge: string,
	type: "registration" | "authentication",
): Promise<{ ok: boolean; userId: string | null }> {
	const row = await db.query.webauthnChallenges.findFirst({
		where: and(eq(webauthnChallenges.challenge, challenge), eq(webauthnChallenges.type, type)),
	});
	if (!row) return { ok: false, userId: null };
	// Always delete — whether valid or expired — so it cannot be reused.
	await db.delete(webauthnChallenges).where(eq(webauthnChallenges.id, row.id));
	if (row.expiresAt < Date.now()) return { ok: false, userId: null };
	return { ok: true, userId: row.userId };
}

/** Best-effort cleanup of expired challenge rows. */
export async function pruneExpiredChallenges(): Promise<void> {
	try {
		await db.delete(webauthnChallenges).where(lt(webauthnChallenges.expiresAt, Date.now()));
	} catch (err) {
		logger.warn("Failed to prune expired WebAuthn challenges", { error: String(err) });
	}
}

/**
 * Start the periodic cleanup of expired/abandoned WebAuthn challenge rows.
 *
 * `consumeChallenge` only deletes the single row it resolves; challenges from
 * ceremonies the user abandoned (closed the prompt, navigated away) would
 * otherwise accumulate forever. Runs an immediate sweep on startup to clear any
 * rows left over from before a restart, then on a fixed interval. Uses hotTimer
 * so Bun --hot reloads don't stack duplicate intervals.
 */
export function startChallengeCleanupTimer(): ReturnType<typeof setInterval> {
	void pruneExpiredChallenges();
	return hotTimer(CHALLENGE_CLEANUP_TIMER_KEY, () =>
		setInterval(() => {
			void pruneExpiredChallenges();
		}, CHALLENGE_CLEANUP_INTERVAL_MS),
	);
}
