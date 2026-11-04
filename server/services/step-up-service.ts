/**
 * Step-up verification: before a high-risk action (exporting credentials), the signed-in
 * user proves again who they are with their password AND a second factor (TOTP, backup
 * code or passkey). Success yields a short-lived, single-use grant bound to that user,
 * that session and one purpose; the action consumes it.
 *
 * A second factor is required whether or not the user turned on MFA for login: an
 * account without any factor cannot step up and must enroll one first.
 *
 * Grants live in memory only. A restart drops them, which just means verifying again.
 */
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { authAttemptLimiter } from "../lib/auth-attempt-limiter";
import { AppError, RateLimitError } from "../lib/errors";
import { hotSafe } from "../lib/hot-safe";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { authSessionStore } from "./auth/store";
import { mfaService } from "./mfa-service";
import { passkeyService } from "./passkey-service";

export const STEP_UP_PURPOSES = ["credentials.export"] as const;
export type StepUpPurpose = (typeof STEP_UP_PURPOSES)[number];
export type StepUpMethod = "totp" | "backup_code" | "passkey";

const GRANT_TTL_MS = 5 * 60_000;

interface Grant {
	userId: string;
	sessionId: string;
	purpose: StepUpPurpose;
	expiresAt: number;
}

const grants = hotSafe("narrafork.stepUpGrants", () => new Map<string, Grant>());

function prune(now: number): void {
	for (const [token, grant] of grants) if (grant.expiresAt <= now) grants.delete(token);
}

/** Second factors the user can step up with. Empty → they must enroll one first. */
export async function stepUpMethods(userId: string): Promise<StepUpMethod[]> {
	const [totp, passkey] = await Promise.all([
		mfaService.isTotpActive(userId),
		mfaService.hasAnyPasskey(userId),
	]);
	const methods: StepUpMethod[] = [];
	if (totp) methods.push("totp", "backup_code");
	if (passkey) methods.push("passkey");
	return methods;
}

export function stepUpPasskeyOptions(userId: string, originHeader: string | undefined) {
	return passkeyService.authenticationOptions({ userId, originHeader });
}

export interface StepUpInput {
	userId: string;
	sessionId: string;
	sourceIp: string;
	purpose: StepUpPurpose;
	password: string;
	method: StepUpMethod;
	/** TOTP or backup code. */
	code?: string;
	/** WebAuthn assertion for `passkey`. */
	response?: Record<string, unknown>;
	originHeader?: string;
}

async function verifySecondFactor(input: StepUpInput): Promise<boolean> {
	if (input.method === "passkey") {
		if (!input.response) return false;
		const result = await passkeyService.verifyAuthentication({
			response: input.response as unknown as AuthenticationResponseJSON,
			expectedUserId: input.userId,
			originHeader: input.originHeader,
		});
		return result.ok;
	}
	if (!input.code) return false;
	return input.method === "backup_code"
		? mfaService.consumeBackupCode(input.userId, input.code)
		: mfaService.verifyTotp(input.userId, input.code);
}

/**
 * Check password + second factor and issue a grant. Failures share the login MFA
 * attempt budget, so step-up cannot be used to brute-force a code.
 */
export async function verifyStepUp(
	input: StepUpInput,
): Promise<{ token: string; expiresAt: number }> {
	const methods = await stepUpMethods(input.userId);
	if (methods.length === 0) {
		throw new AppError("Set up two-factor authentication first", 403, "STEP_UP_MFA_REQUIRED");
	}
	if (!methods.includes(input.method)) {
		throw new AppError("This verification method is not set up", 400, "STEP_UP_METHOD_UNAVAILABLE");
	}

	const attempt = authAttemptLimiter.beginMfa(
		input.userId,
		input.sourceIp,
		input.method === "backup_code",
	);
	if (!attempt.allowed) {
		throw new RateLimitError(
			attempt.reason === "busy" ? "AUTH_BUSY" : "MFA_THROTTLED",
			attempt.retryAfterMs,
		);
	}
	let settled = false;
	try {
		const passwordHash = await authSessionStore.findPasswordHash(input.userId);
		const passwordOk = !!passwordHash && (await Bun.password.verify(input.password, passwordHash));
		// Only spend a backup code once the password is known to be right.
		const ok = passwordOk && (await verifySecondFactor(input));
		if (!ok) {
			const after = attempt.failure();
			settled = true;
			logger.warn("Step-up verification failed", {
				userId: input.userId,
				purpose: input.purpose,
				method: input.method,
				sourceIp: input.sourceIp,
				remaining: after.remaining,
			});
			if (after.locked) throw new RateLimitError("MFA_THROTTLED", after.retryAfterMs);
			throw new AppError("Password or verification code is incorrect", 401, "STEP_UP_FAILED");
		}
		attempt.success();
		settled = true;
	} finally {
		if (!settled) attempt.cancel();
	}

	const now = Date.now();
	prune(now);
	const token = `nfsu_${generateId()}${generateId()}`;
	const expiresAt = now + GRANT_TTL_MS;
	grants.set(token, {
		userId: input.userId,
		sessionId: input.sessionId,
		purpose: input.purpose,
		expiresAt,
	});
	logger.info("Step-up verification passed", {
		userId: input.userId,
		purpose: input.purpose,
		method: input.method,
	});
	return { token, expiresAt };
}

/** Redeem a grant for one action. Throws unless it matches user, session and purpose. */
export function consumeStepUp(
	token: string | undefined,
	expected: { userId: string; sessionId: string | undefined; purpose: StepUpPurpose },
): void {
	const now = Date.now();
	prune(now);
	const grant = token ? grants.get(token) : undefined;
	if (
		!token ||
		!grant ||
		grant.userId !== expected.userId ||
		grant.sessionId !== expected.sessionId ||
		grant.purpose !== expected.purpose
	) {
		throw new AppError("Verify your identity again to continue", 401, "STEP_UP_REQUIRED");
	}
	grants.delete(token);
}

/** Tests only. */
export function resetStepUpForTests(): void {
	grants.clear();
}
