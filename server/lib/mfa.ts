/**
 * MFA challenge tokens — the short-lived bridge between password verification
 * and the second factor.
 *
 * After a password check succeeds for a user who has a second factor enabled,
 * we do NOT issue the real session JWT. Instead we issue an MFA challenge token
 * (`stage: "mfa_pending"`) that only authorizes calling `/auth/mfa/verify`.
 * Once the second factor is proven, the real JWT is minted.
 *
 * This module is shared infrastructure: TOTP is the first consumer, but passkey
 * (phase 2) second-factor verification reuses the exact same challenge token.
 *
 * Security properties:
 * - Signed with the same secret as session JWTs, but carries a distinct
 *   `stage` claim so it can never be used as a session token (the main
 *   `verifyToken` rejects any token carrying a `stage` claim).
 * - Short TTL (5 minutes).
 * - Single-use: a `jti` is recorded as consumed on successful verify so the
 *   token cannot be replayed.
 */
import { sign, verify } from "hono/jwt";
import { hotSafe } from "./hot-safe";
import { generateId } from "./id";
import { settings } from "./settings";

const MFA_TOKEN_TTL_SECONDS = 5 * 60; // 5 minutes
export const MFA_STAGE = "mfa_pending" as const;

export interface MfaChallengePayload {
	sub: string;
	stage: typeof MFA_STAGE;
	jti: string;
	iat: number;
	exp: number;
	[key: string]: unknown;
}

function getJwtSecret(): string {
	return settings.auth.jwtSecret;
}

/**
 * Tracks consumed / invalidated MFA challenge jtis so a token can be used at
 * most once and can be force-invalidated (e.g. after too many failed attempts).
 * Pinned to globalThis so it survives Bun --hot reloads. Entries are pruned
 * lazily once their original expiry passes.
 */
const consumedJtis = hotSafe(
	"narrafork.mfaConsumedJtis",
	() => new Map<string, number>(), // jti -> expiry epoch seconds
);

function pruneExpired(now: number): void {
	for (const [jti, exp] of consumedJtis) {
		if (exp <= now) consumedJtis.delete(jti);
	}
}

/** Issue a new single-use MFA challenge token for a user. */
export async function issueMfaToken(userId: string): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const payload: MfaChallengePayload = {
		sub: userId,
		stage: MFA_STAGE,
		jti: generateId(),
		iat: now,
		exp: now + MFA_TOKEN_TTL_SECONDS,
	};
	return sign(payload, getJwtSecret());
}

/**
 * Verify an MFA challenge token's signature, stage, expiry and single-use
 * status. Returns the payload when valid, or null otherwise. Does NOT consume
 * the token — call `consumeMfaToken` only after the second factor succeeds.
 */
export async function verifyMfaToken(token: string): Promise<MfaChallengePayload | null> {
	let payload: MfaChallengePayload;
	try {
		payload = (await verify(token, getJwtSecret(), "HS256")) as unknown as MfaChallengePayload;
	} catch {
		return null;
	}
	if (payload.stage !== MFA_STAGE || !payload.sub || !payload.jti) return null;
	const now = Math.floor(Date.now() / 1000);
	pruneExpired(now);
	if (consumedJtis.has(payload.jti)) return null; // already used or invalidated
	return payload;
}

/** Mark an MFA challenge token as consumed so it cannot be replayed. */
export function consumeMfaToken(payload: MfaChallengePayload): void {
	consumedJtis.set(payload.jti, payload.exp);
}

/**
 * Invalidate a specific MFA challenge token without it having been used
 * successfully — e.g. after the failed-attempt budget is exhausted, so the
 * attacker must restart from the password step.
 */
export function invalidateMfaToken(payload: MfaChallengePayload): void {
	consumedJtis.set(payload.jti, payload.exp);
}
