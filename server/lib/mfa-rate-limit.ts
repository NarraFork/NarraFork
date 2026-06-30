/**
 * In-memory failed-attempt limiter for MFA verification.
 *
 * A 6-digit TOTP code has only ~1,000,000 possibilities, so the
 * `/auth/mfa/verify` endpoint must throttle guesses. NarraFork is a
 * single-instance, self-hosted deployment, so a process-local counter is
 * sufficient (same approach as the `verifiedUsers` cache in middleware/auth.ts).
 *
 * Policy (per user):
 * - Up to MAX_FAILURES failed attempts within a rolling window.
 * - On the MAX_FAILURES-th failure the user is locked out for LOCKOUT_MS; the
 *   caller is expected to also invalidate the active MFA challenge token so the
 *   attacker must restart from the password step.
 * - Any success clears the counter immediately.
 *
 * Both TOTP codes and backup codes count against the same budget.
 */
import { hotSafe } from "./hot-safe";

const MAX_FAILURES = 5;
const WINDOW_MS = 5 * 60 * 1000; // failures older than this are forgotten
const LOCKOUT_MS = 5 * 60 * 1000; // lock duration once the budget is exhausted

interface AttemptState {
	failures: number;
	firstFailAt: number;
	lockedUntil: number;
}

const attempts = hotSafe("narrafork.mfaAttemptState", () => new Map<string, AttemptState>());

function getFreshState(now: number, prev?: AttemptState): AttemptState {
	// Reset the window if it has fully elapsed since the first failure.
	if (!prev || now - prev.firstFailAt > WINDOW_MS) {
		return { failures: 0, firstFailAt: now, lockedUntil: 0 };
	}
	return prev;
}

export interface MfaLockStatus {
	locked: boolean;
	/** Epoch ms until which the user is locked (0 when not locked). */
	lockedUntil: number;
	/** Remaining attempts before lockout (0 when locked). */
	remaining: number;
}

/** Check whether a user is currently locked out from MFA verification. */
export function checkMfaLock(userId: string): MfaLockStatus {
	const now = Date.now();
	const state = attempts.get(userId);
	if (state && state.lockedUntil > now) {
		return { locked: true, lockedUntil: state.lockedUntil, remaining: 0 };
	}
	const fresh = getFreshState(now, state);
	return {
		locked: false,
		lockedUntil: 0,
		remaining: Math.max(0, MAX_FAILURES - fresh.failures),
	};
}

/**
 * Record a failed MFA attempt. Returns the resulting lock status. When the
 * failure budget is exhausted the user is locked for LOCKOUT_MS.
 */
export function recordMfaFailure(userId: string): MfaLockStatus {
	const now = Date.now();
	const state = getFreshState(now, attempts.get(userId));
	state.failures += 1;
	if (state.failures === 1) state.firstFailAt = now;
	if (state.failures >= MAX_FAILURES) {
		state.lockedUntil = now + LOCKOUT_MS;
	}
	attempts.set(userId, state);
	const locked = state.lockedUntil > now;
	return {
		locked,
		lockedUntil: locked ? state.lockedUntil : 0,
		remaining: Math.max(0, MAX_FAILURES - state.failures),
	};
}

/** Clear all failed-attempt state for a user after a successful verification. */
export function clearMfaFailures(userId: string): void {
	attempts.delete(userId);
}
