import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { count, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import QRCode from "qrcode";
import { db } from "../db";
import { users } from "../db/schema";
import { buildSessionResult, loginUser, registerUser } from "../lib/auth";
import { type AuthAttemptBlocked, authAttemptLimiter } from "../lib/auth-attempt-limiter";
import { getClientIp } from "../lib/client-ip";
import { AppError, formatZodError, RateLimitError, ValidationError } from "../lib/errors";
import { logger } from "../lib/logger";
import {
	consumeMfaToken,
	invalidateMfaToken,
	type MfaChallengePayload,
	verifyMfaToken,
} from "../lib/mfa";
import { buildTotpUri } from "../lib/totp";
import { deleteAvatarImage, saveAvatarImage } from "../lib/uploads";
import {
	loginSchema,
	mfaToggleSchema,
	mfaVerifySchema,
	passkeyLoginOptionsSchema,
	passkeyLoginVerifySchema,
	passkeyMfaVerifySchema,
	passkeyRegisterSchema,
	passkeyRenameSchema,
	registerSchema,
	totpActivateSchema,
	totpDisableSchema,
	updateProfileSchema,
} from "../lib/validators";
import { requireSessionAuth } from "../middleware/auth";
import { mfaService } from "../services/mfa-service";
import { passkeyService } from "../services/passkey-service";
import { ssoService } from "../services/sso-service";

export const authRoutes = new Hono();

function throwAuthThrottle(
	blocked: AuthAttemptBlocked,
	lockedCode: "LOGIN_THROTTLED" | "MFA_LOCKED",
): never {
	const code =
		blocked.reason === "busy"
			? "AUTH_BUSY"
			: lockedCode === "MFA_LOCKED" && !blocked.subjectLocked
				? "MFA_THROTTLED"
				: lockedCode;
	throw new RateLimitError(code, blocked.retryAfterMs);
}

async function verifyRateLimitedMfaToken(
	c: Context,
	token: string,
): Promise<{ challenge: MfaChallengePayload; sourceIp: string }> {
	const sourceIp = getClientIp(c);
	const probe = authAttemptLimiter.beginMfaSource(sourceIp);
	if (!probe.allowed) throwAuthThrottle(probe, "MFA_LOCKED");

	const challenge = await verifyMfaToken(token);
	if (!challenge) {
		const after = probe.failure();
		if (after.locked) {
			throw new RateLimitError("MFA_THROTTLED", after.retryAfterMs);
		}
		throw new AppError("Invalid or expired verification session", 401, "MFA_TOKEN_INVALID");
	}
	probe.cancel();
	return { challenge, sourceIp };
}

authRoutes.post("/register", async (c) => {
	// Validate before taking a lease so malformed bodies don't consume the
	// instance's registration budget or the shared bcrypt slot.
	const parsed = registerSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(formatZodError(parsed.error));

	// An instance with no users yet is exempt from the instance-wide interval: the
	// bootstrap admin is often created after a couple of validation failures, and
	// there is no account to attack (and no code to guess) before it exists.
	const [{ value: userCount }] = await db.select({ value: count() }).from(users);
	const lease = authAttemptLimiter.beginRegistration(getClientIp(c), {
		skipGlobalInterval: userCount === 0,
	});
	if (!lease.allowed) {
		throw new RateLimitError(
			lease.reason === "busy" ? "AUTH_BUSY" : "REGISTRATION_THROTTLED",
			lease.retryAfterMs,
		);
	}

	try {
		const { user, token, language } = await registerUser(parsed.data);
		lease.success();
		return c.json({ user, token, language }, 201);
	} catch (error) {
		// Every rejection here — taken username, closed registration, a bad or spent
		// code — counts as a failed attempt. Only guessing a code is an attack, but
		// the endpoint cannot tell attacks from mistakes, and pacing both is cheap.
		lease.failure();
		throw error;
	}
});

authRoutes.post("/login", async (c) => {
	const parsed = loginSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(formatZodError(parsed.error));
	// Result is either a full session ({ user, token, language }) or an MFA
	// challenge ({ mfaRequired, mfaToken, methods }) when a second factor is
	// enrolled — in the latter case no session token is issued yet and the
	// client must complete /auth/mfa/verify.
	const result = await loginUser(parsed.data.username, parsed.data.password, getClientIp(c));
	return c.json(result);
});

/**
 * Step 2 of login: redeem the MFA challenge token by proving the second factor.
 * Rate-limited per user to defeat brute-forcing the 6-digit TOTP space.
 */
authRoutes.post("/mfa/verify", async (c) => {
	const parsed = mfaVerifySchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(formatZodError(parsed.error));
	const { mfaToken, method, code } = parsed.data;
	const { challenge, sourceIp } = await verifyRateLimitedMfaToken(c, mfaToken);
	const userId = challenge.sub;

	const attempt = authAttemptLimiter.beginMfa(userId, sourceIp, method === "backup_code");
	if (!attempt.allowed) {
		if (attempt.subjectLocked) invalidateMfaToken(challenge);
		throwAuthThrottle(attempt, "MFA_LOCKED");
	}

	let attemptCompleted = false;
	try {
		const ok =
			method === "backup_code"
				? await mfaService.consumeBackupCode(userId, code)
				: await mfaService.verifyTotp(userId, code);

		if (!ok) {
			const after = attempt.failure();
			attemptCompleted = true;
			logger.warn("Failed MFA verification attempt", {
				userId,
				method,
				sourceIp,
				remaining: after.remaining,
				userLocked: after.subjectLocked,
				sourceLocked: after.sourceLocked,
			});
			if (after.subjectLocked) invalidateMfaToken(challenge);
			if (after.locked) {
				throw new RateLimitError(
					after.subjectLocked ? "MFA_LOCKED" : "MFA_THROTTLED",
					after.retryAfterMs,
				);
			}
			throw new AppError("Invalid verification code", 401, "MFA_CODE_INVALID");
		}

		// Consume the challenge before releasing the per-user reservation so a
		// concurrent request cannot redeem the same token in the success window.
		consumeMfaToken(challenge);
		attempt.success();
		attemptCompleted = true;
		const session = await buildSessionResult(userId);
		return c.json(session);
	} catch (error) {
		if (!attemptCompleted) attempt.cancel();
		throw error;
	}
});

// === Passkey login (usernameless / passwordless) ===

/** Issue authentication options for a discoverable-credential (usernameless) login. */
authRoutes.post("/passkey/login/options", async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const parsed = passkeyLoginOptionsSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(formatZodError(parsed.error));
	// Usernameless: no allowCredentials, the authenticator picks the credential.
	const options = await passkeyService.authenticationOptions({
		userId: null,
		originHeader: c.req.header("origin"),
	});
	return c.json(options);
});

/** Complete a passwordless passkey login and establish a session. */
authRoutes.post("/passkey/login/verify", async (c) => {
	const parsed = passkeyLoginVerifySchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(formatZodError(parsed.error));
	const result = await passkeyService.verifyAuthentication({
		response: parsed.data.response as unknown as AuthenticationResponseJSON,
		expectedUserId: null,
		originHeader: c.req.header("origin"),
	});
	if (!result.ok || !result.userId) {
		throw new AppError("Passkey authentication failed", 401, "PASSKEY_AUTH_FAILED");
	}
	const session = await buildSessionResult(result.userId);
	return c.json(session);
});

// === Passkey as a second factor (after password) ===

/** Issue authentication options for the passkey second-factor step. */
authRoutes.post("/mfa/passkey/options", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { mfaToken?: string };
	if (!body.mfaToken) throw new ValidationError("mfaToken is required");
	const { challenge, sourceIp } = await verifyRateLimitedMfaToken(c, body.mfaToken);
	const blocked = authAttemptLimiter.checkMfa(challenge.sub, sourceIp);
	if (blocked) {
		if (blocked.subjectLocked) invalidateMfaToken(challenge);
		throwAuthThrottle(blocked, "MFA_LOCKED");
	}
	const options = await passkeyService.authenticationOptions({
		userId: challenge.sub,
		originHeader: c.req.header("origin"),
	});
	return c.json(options);
});

/** Verify the passkey second factor and establish a session. */
authRoutes.post("/mfa/passkey/verify", async (c) => {
	const parsed = passkeyMfaVerifySchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(formatZodError(parsed.error));
	const { challenge, sourceIp } = await verifyRateLimitedMfaToken(c, parsed.data.mfaToken);
	const userId = challenge.sub;
	const attempt = authAttemptLimiter.beginMfa(userId, sourceIp, false);
	if (!attempt.allowed) {
		if (attempt.subjectLocked) invalidateMfaToken(challenge);
		throwAuthThrottle(attempt, "MFA_LOCKED");
	}

	let attemptCompleted = false;
	try {
		const result = await passkeyService.verifyAuthentication({
			response: parsed.data.response as unknown as AuthenticationResponseJSON,
			expectedUserId: userId,
			originHeader: c.req.header("origin"),
		});
		if (!result.ok) {
			const after = attempt.failure();
			attemptCompleted = true;
			logger.warn("Failed passkey MFA verification attempt", {
				userId,
				sourceIp,
				remaining: after.remaining,
				userLocked: after.subjectLocked,
				sourceLocked: after.sourceLocked,
			});
			if (after.subjectLocked) invalidateMfaToken(challenge);
			if (after.locked) {
				throw new RateLimitError(
					after.subjectLocked ? "MFA_LOCKED" : "MFA_THROTTLED",
					after.retryAfterMs,
				);
			}
			throw new AppError("Passkey authentication failed", 401, "PASSKEY_AUTH_FAILED");
		}

		consumeMfaToken(challenge);
		attempt.success();
		attemptCompleted = true;
		const session = await buildSessionResult(userId);
		return c.json(session);
	} catch (error) {
		if (!attemptCompleted) attempt.cancel();
		throw error;
	}
});

authRoutes.get("/me", requireSessionAuth, async (c) => {
	const payload = c.get("user");
	const user = await db.query.users.findFirst({
		where: eq(users.id, payload.sub),
		columns: {
			id: true,
			username: true,
			role: true,
			avatarColor: true,
			avatarImageId: true,
			gitUsername: true,
			gitEmail: true,
			createdAt: true,
		},
	});
	if (!user) return c.json({ error: "User not found" }, 404);
	return c.json(user);
});

authRoutes.patch("/me", requireSessionAuth, async (c) => {
	const payload = c.get("user");
	const parsed = updateProfileSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(formatZodError(parsed.error));
	const update: Record<string, string | null> = {};
	if (parsed.data.gitUsername !== undefined) {
		update.gitUsername = parsed.data.gitUsername || null;
	}
	if (parsed.data.gitEmail !== undefined) {
		update.gitEmail = parsed.data.gitEmail || null;
	}
	if (Object.keys(update).length > 0) {
		await db.update(users).set(update).where(eq(users.id, payload.sub));
	}
	return c.json({ ok: true });
});

authRoutes.patch("/me/avatar", requireSessionAuth, async (c) => {
	const payload = c.get("user");
	const formData = await c.req.formData();
	const file = formData.get("file");
	if (!file || !(file instanceof File)) {
		throw new ValidationError("No file provided");
	}

	const { imageId } = await saveAvatarImage(payload.sub, file);
	await db.update(users).set({ avatarImageId: imageId }).where(eq(users.id, payload.sub));

	return c.json({ ok: true, avatarImageId: imageId });
});

authRoutes.delete("/me/avatar", requireSessionAuth, async (c) => {
	const payload = c.get("user");
	deleteAvatarImage(payload.sub);
	await db.update(users).set({ avatarImageId: null }).where(eq(users.id, payload.sub));
	return c.json({ ok: true });
});

// === Multi-factor (TOTP) management ===

/** Current MFA status for the security settings page. */
authRoutes.get("/me/security", requireSessionAuth, async (c) => {
	const payload = c.get("user");
	const [status, passkeys] = await Promise.all([
		mfaService.getStatus(payload.sub),
		passkeyService.list(payload.sub),
	]);
	return c.json({ ...status, passkeyCount: passkeys.length });
});

/**
 * Toggle the login-time second-factor requirement. Enabling requires at least
 * one usable factor (an active TOTP authenticator or a passkey), otherwise the
 * user would lock themselves out. Disabling is always allowed from within an
 * authenticated session.
 */
authRoutes.patch("/me/mfa", requireSessionAuth, async (c) => {
	const payload = c.get("user");
	const parsed = mfaToggleSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(formatZodError(parsed.error));

	if (parsed.data.enabled) {
		const hasFactor = await mfaService.hasAnyFactor(payload.sub);
		if (!hasFactor) {
			throw new AppError(
				"Add a second factor (an authenticator app or a passkey) before requiring two-factor sign-in",
				400,
				"MFA_NO_FACTOR",
			);
		}
	}

	await mfaService.setMfaEnabled(payload.sub, parsed.data.enabled);
	logger.info("MFA requirement toggled", { userId: payload.sub, enabled: parsed.data.enabled });
	return c.json({ ok: true, mfaEnabled: parsed.data.enabled });
});

/**
 * Begin TOTP enrollment. Returns the otpauth URI, a QR-code data URL and the
 * plaintext secret (for manual entry). Idempotent: re-calling regenerates the
 * pending secret. Fails if TOTP is already active.
 */
authRoutes.post("/me/totp/setup", requireSessionAuth, async (c) => {
	const payload = c.get("user");
	const user = await db.query.users.findFirst({
		where: eq(users.id, payload.sub),
		columns: { username: true },
	});
	if (!user) throw new AppError("User not found", 404, "NOT_FOUND");

	const result = await mfaService.beginSetup(payload.sub);
	if ("alreadyActive" in result) {
		throw new AppError("Two-factor authentication is already enabled", 409, "TOTP_ALREADY_ACTIVE");
	}

	const uri = buildTotpUri(result.secret, user.username);
	const qrDataUrl = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
	return c.json({ secret: result.secret, uri, qrDataUrl });
});

/**
 * Confirm enrollment with the first valid code. Returns the one-time backup
 * codes — shown to the user exactly once and never retrievable again.
 */
authRoutes.post("/me/totp/activate", requireSessionAuth, async (c) => {
	const payload = c.get("user");
	const parsed = totpActivateSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(formatZodError(parsed.error));

	const result = await mfaService.activate(payload.sub, parsed.data.code);
	if (!result.ok) {
		throw new AppError("Invalid verification code", 400, "TOTP_CODE_INVALID");
	}
	return c.json({ ok: true, backupCodes: result.backupCodes });
});

/**
 * Disable TOTP. Requires proof of identity: a current TOTP code, an unused
 * backup code, or the account password.
 */
authRoutes.delete("/me/totp", requireSessionAuth, async (c) => {
	const payload = c.get("user");
	const parsed = totpDisableSchema.safeParse(await c.req.json().catch(() => ({})));
	if (!parsed.success) throw new ValidationError(formatZodError(parsed.error));

	const active = await mfaService.isTotpActive(payload.sub);
	if (!active) {
		throw new AppError("Two-factor authentication is not enabled", 400, "TOTP_NOT_ACTIVE");
	}

	let verified = false;
	if (parsed.data.code) {
		verified =
			(await mfaService.verifyTotp(payload.sub, parsed.data.code)) ||
			(await mfaService.consumeBackupCode(payload.sub, parsed.data.code));
	}
	if (!verified && parsed.data.password) {
		const user = await db.query.users.findFirst({
			where: eq(users.id, payload.sub),
			columns: { passwordHash: true },
		});
		if (user) {
			verified = await Bun.password.verify(parsed.data.password, user.passwordHash);
		}
	}

	if (!verified) {
		throw new AppError("Verification failed", 401, "TOTP_DISABLE_UNVERIFIED");
	}

	await mfaService.disable(payload.sub);
	// If this was the user's only factor, drop the MFA requirement so they
	// aren't left with "MFA required" but nothing to satisfy it with.
	const mfaDisabled = await mfaService.syncMfaEnabledAfterFactorChange(payload.sub);
	logger.info("TOTP disabled", { userId: payload.sub, mfaRequirementCleared: mfaDisabled });
	return c.json({ ok: true });
});

// === Passkey management (authenticated) ===

/** List the current user's registered passkeys. */
authRoutes.get("/me/passkeys", requireSessionAuth, async (c) => {
	const payload = c.get("user");
	const passkeys = await passkeyService.list(payload.sub);
	return c.json({ passkeys });
});

/** Issue registration options for adding a new passkey. */
authRoutes.post("/me/passkeys/register/options", requireSessionAuth, async (c) => {
	const payload = c.get("user");
	const user = await db.query.users.findFirst({
		where: eq(users.id, payload.sub),
		columns: { username: true },
	});
	if (!user) throw new AppError("User not found", 404, "NOT_FOUND");
	const options = await passkeyService.registrationOptions({
		userId: payload.sub,
		username: user.username,
		originHeader: c.req.header("origin"),
	});
	return c.json(options);
});

/** Verify a registration response and store the new passkey. */
authRoutes.post("/me/passkeys/register/verify", requireSessionAuth, async (c) => {
	const payload = c.get("user");
	const parsed = passkeyRegisterSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(formatZodError(parsed.error));
	const result = await passkeyService.verifyRegistration({
		userId: payload.sub,
		response: parsed.data.response as unknown as RegistrationResponseJSON,
		name: parsed.data.name,
		originHeader: c.req.header("origin"),
	});
	if (!result.ok) {
		throw new AppError("Passkey registration failed", 400, "PASSKEY_REGISTER_FAILED");
	}
	return c.json({ ok: true });
});

/** Rename a passkey. */
authRoutes.patch("/me/passkeys/:id", requireSessionAuth, async (c) => {
	const payload = c.get("user");
	const id = c.req.param("id");
	if (!id) throw new ValidationError("Passkey id is required");
	const parsed = passkeyRenameSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(formatZodError(parsed.error));
	const ok = await passkeyService.rename(payload.sub, id, parsed.data.name);
	if (!ok) throw new AppError("Passkey not found", 404, "NOT_FOUND");
	return c.json({ ok: true });
});

/** Delete a passkey. */
authRoutes.delete("/me/passkeys/:id", requireSessionAuth, async (c) => {
	const payload = c.get("user");
	const id = c.req.param("id");
	if (!id) throw new ValidationError("Passkey id is required");
	const ok = await passkeyService.remove(payload.sub, id);
	if (!ok) throw new AppError("Passkey not found", 404, "NOT_FOUND");
	// Clearing the last remaining factor should also drop the MFA requirement.
	const mfaDisabled = await mfaService.syncMfaEnabledAfterFactorChange(payload.sub);
	logger.info("Passkey removed", { userId: payload.sub, mfaRequirementCleared: mfaDisabled });
	return c.json({ ok: true });
});

// === Linked SSO identities (authenticated) ===

/** List the current user's linked SSO identities. */
authRoutes.get("/me/identities", requireSessionAuth, async (c) => {
	const payload = c.get("user");
	const identities = await ssoService.listIdentities(payload.sub);
	return c.json({ identities });
});

/** Unlink an SSO identity from the current user. */
authRoutes.delete("/me/identities/:id", requireSessionAuth, async (c) => {
	const payload = c.get("user");
	const id = c.req.param("id");
	if (!id) throw new ValidationError("Identity id is required");
	const ok = await ssoService.unlink(payload.sub, id);
	if (!ok) throw new AppError("Identity not found", 404, "NOT_FOUND");
	logger.info("SSO identity unlinked", { userId: payload.sub });
	return c.json({ ok: true });
});
