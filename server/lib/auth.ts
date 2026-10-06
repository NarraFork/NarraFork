import { type Locale, normalizeLocale } from "@shared/i18n-locales";
import {
	SESSION_START_CLAIM,
	SESSION_TOKEN_TTL_SECONDS,
	SESSION_VERSION_CLAIM,
} from "@shared/session-auth";
import { sign, verify } from "hono/jwt";
import { authSessionStore } from "../services/auth/store";
import { registrationAccountStore as accountStore } from "../services/registration/store";
import { authAttemptLimiter, fingerprintAuthIdentifier } from "./auth-attempt-limiter";
import { randomAvatarColor } from "./avatar-colors";
import { AppError, RateLimitError } from "./errors";
import { generateId } from "./id";
import { logger } from "./logger";
import { issueMfaToken } from "./mfa";
import { saveSettings, settings } from "./settings";

/** Read JWT secret lazily so it picks up the auto-generated value even when
 *  the module is imported before settings finishes initialization. */
function getJwtSecret(): string {
	return settings.auth.jwtSecret;
}

const TOKEN_EXPIRY_SECONDS = SESSION_TOKEN_TTL_SECONDS;

// A fixed cost-10 bcrypt hash used only to equalize the unknown-user path with
// a normal password failure. The plaintext is intentionally public and is not
// an account credential.
const INVALID_LOGIN_PADDING_HASH = "$2b$10$aF/evsAjCJZn2KANblVddeLsw19IUoALQbTSxTaCJeNxztOQHrWWm";

export interface JwtPayload {
	sub: string;
	role: "admin" | "user";
	iat: number;
	exp: number;
	/**
	 * Session start (unix seconds) of the original login. Optional because tokens
	 * issued before the absolute session ceiling existed do not carry it; see
	 * `resolveSessionStart` for how those are anchored.
	 */
	[SESSION_START_CLAIM]?: number;
	/**
	 * `users.token_version` at signing time. Optional for the same reason as the
	 * anchor above: tokens predating the column do not carry it. A missing value
	 * reads as 0 (see `isSessionTokenVersionCurrent`), so those tokens keep working
	 * until the user's counter is bumped for the first time.
	 */
	[SESSION_VERSION_CLAIM]?: number;
}

/**
 * Issue a session JWT for a *fresh login*: the absolute-session anchor starts now.
 * Renewals must use `renewToken` so the anchor is inherited instead of reset.
 */
export async function createToken(userId: string, role: string, tokenVersion = 0): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return signSessionToken(userId, role, now, now, tokenVersion);
}

/**
 * Re-sign a session JWT for sliding renewal, carrying the original session-start
 * anchor forward untouched. Callers must check the absolute ceiling before
 * calling this — the anchor alone does not stop an over-age chain.
 */
export async function renewToken(
	userId: string,
	role: string,
	sessionStart: number,
	tokenVersion = 0,
): Promise<string> {
	return signSessionToken(userId, role, sessionStart, Math.floor(Date.now() / 1000), tokenVersion);
}

async function signSessionToken(
	userId: string,
	role: string,
	sessionStart: number,
	nowSeconds: number,
	tokenVersion: number,
): Promise<string> {
	return sign(
		{
			sub: userId,
			role,
			iat: nowSeconds,
			exp: nowSeconds + TOKEN_EXPIRY_SECONDS,
			[SESSION_START_CLAIM]: sessionStart,
			[SESSION_VERSION_CLAIM]: tokenVersion,
		},
		getJwtSecret(),
	);
}

/**
 * Bump a user's token generation, invalidating every session token they hold.
 *
 * Returns the new value so a caller that is also issuing a replacement token
 * (a self-service password change, say) can sign it against the bumped counter
 * instead of locking itself out. The increment itself is one atomic statement
 * owned by the session store — this layer holds no transaction handle and
 * names no table, so a second backend implements the same capability.
 */
export async function revokeUserSessions(userId: string): Promise<number> {
	return await authSessionStore.bumpTokenVersion(userId);
}

/**
 * Reject payloads that are signed correctly but are not usable session
 * credentials. `hono/jwt` skips `exp`/`sub` when they are absent, so a token
 * without them would otherwise be an unexpiring credential that never even
 * enters the renewal (and therefore ceiling) logic.
 */
function assertSessionPayload(payload: JwtPayload & { stage?: string }): void {
	// Reject intermediate tokens (e.g. MFA challenge tokens carry `stage`).
	// Only fully-authenticated session tokens are accepted as credentials.
	if (payload.stage) {
		throw new AppError("Invalid token", 401, "UNAUTHORIZED");
	}
	if (typeof payload.sub !== "string" || !payload.sub.trim()) {
		throw new AppError("Invalid token", 401, "UNAUTHORIZED");
	}
	if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
		throw new AppError("Invalid token", 401, "UNAUTHORIZED");
	}
}

export async function verifyToken(token: string): Promise<JwtPayload> {
	const payload = (await verify(token, getJwtSecret(), "HS256")) as unknown as JwtPayload & {
		stage?: string;
	};
	assertSessionPayload(payload);
	return payload;
}

/**
 * Verify signature and shape while ignoring `exp`.
 *
 * `hono/jwt` checks `exp` *before* the signature, so an arbitrarily forged token
 * with a past `exp` raises `JwtTokenExpired`. Reporting that as "your session
 * expired" would confirm to an unauthenticated caller that the token was once
 * ours and would make the client drop its stored token. This re-verification
 * tells a genuinely expired session apart from a forgery.
 */
export async function isAuthenticSessionTokenIgnoringExpiry(token: string): Promise<boolean> {
	try {
		const payload = (await verify(token, getJwtSecret(), {
			alg: "HS256",
			exp: false,
		})) as unknown as JwtPayload & { stage?: string };
		assertSessionPayload(payload);
		return true;
	} catch {
		return false;
	}
}

export interface RegisterUserInput {
	username: string;
	password: string;
	language?: string;
	/**
	 * A single-use registration code. When present it authorizes the signup on its
	 * own, independently of `auth.registrationOpen`, and decides the new account's
	 * role. That is the whole point of issuing one: an administrator can keep public
	 * registration closed and still let a specific person create their own account.
	 */
	code?: string;
}

export async function registerUser(input: RegisterUserInput) {
	const { username, password, language } = input;
	const code = input.code?.trim() || undefined;
	const isFirstUser = (await accountStore.countAccounts()) === 0;

	if (!isFirstUser && !code && !settings.auth.registrationOpen) {
		throw new AppError("Registration is closed", 403, "REGISTRATION_CLOSED");
	}

	if (await accountStore.isUsernameTaken(username)) {
		throw new AppError("Username already taken", 409, "USERNAME_TAKEN");
	}

	// Hashing is deliberately outside the atomic section: it is ~100ms of CPU, and holding a
	// transaction open across it would serialize unrelated writes for no benefit.
	const passwordHash = await Bun.password.hash(password, {
		algorithm: "bcrypt",
		cost: 10,
	});
	const resolvedLang = normalizeLocale(language);

	// One indivisible business fact: validate the invitation, create the account, burn the
	// invitation. Split across writes it would either spend an invitation on a signup that
	// then failed, or create the account while leaving the code reusable. `accountStore`
	// guarantees the all-or-nothing property and owns how — this layer holds no transaction
	// handle and names no table, so a second backend implements the same capability rather
	// than reproducing SQLite's transaction shape.
	//
	// The first user is always an administrator regardless of any code (the bootstrap account
	// must be able to administer the instance), which is why `invitationCode` is dropped in
	// that case instead of being resolved and overridden.
	let user: RegisteredAccountShape;
	try {
		const created = await accountStore.createAccount({
			userId: generateId(),
			username,
			passwordHash,
			avatarColor: randomAvatarColor(),
			language: resolvedLang,
			defaultRole: isFirstUser ? "admin" : "user",
			invitationCode: isFirstUser ? undefined : code,
			nowIso: new Date().toISOString(),
		});
		user = created.account;
	} catch (error) {
		throw await mapAccountCreationFailure(error, username);
	}

	// The first account is the instance administrator, created through an
	// unauthenticated endpoint that has to stay open while no user exists. Once it
	// does exist that endpoint is a standing signup hole, so close registration
	// immediately instead of relying on the admin to flip the switch later. An
	// admin can reopen it from settings.
	if (isFirstUser) {
		closeRegistrationAfterFirstAdmin();
	}

	const token = await createToken(user.id, user.role);
	return { user, token, language: resolvedLang };
}

/** The account shape `registerUser` returns, taken from the store contract. */
type RegisteredAccountShape = Awaited<ReturnType<typeof accountStore.createAccount>>["account"];

/**
 * Give a failed account creation its domain error identity.
 *
 * The pre-check above (`isUsernameTaken`) and the account insert are not one atomic
 * observation: two concurrent registrations of the SAME username can both pass the
 * check, and then exactly one of them wins the insert — on PostgreSQL the loser
 * surfaces as a uniqueness conflict from inside the atomic section (a
 * `WriteConflictError` in port vocabulary), on SQLite as the engine's own constraint
 * error. Either way the domain fact is the same one the pre-check reports, so it gets
 * the same answer: `USERNAME_TAKEN` (409), on both backends, never a raw 500.
 *
 * The decision is made by RE-READING the domain state (`isUsernameTaken`) rather than
 * by recognizing driver error text — this layer holds no dialect. A failure whose
 * cause is not a lost username race (the invitation rejection codes, storage faults)
 * propagates unchanged, which is what keeps a storage failure from being reshaped
 * into a policy error. If the re-read itself fails, the original error wins: it is
 * the better evidence.
 */
async function mapAccountCreationFailure(error: unknown, username: string): Promise<unknown> {
	if (error instanceof AppError) return error;
	try {
		if (await accountStore.isUsernameTaken(username)) {
			return new AppError("Username already taken", 409, "USERNAME_TAKEN");
		}
	} catch {
		// The re-read failed too; the original rejection is the one to surface.
	}
	return error;
}

/**
 * Persist `auth.registrationOpen = false` right after the bootstrap admin exists.
 *
 * Failures are logged, not thrown: the account is already committed, and failing
 * the request would leave the caller without the token for an account that does
 * exist. The in-memory flag is flipped first so a failed write still denies
 * registration for the life of the process (it reverts on restart).
 */
function closeRegistrationAfterFirstAdmin(): void {
	if (!settings.auth.registrationOpen) return;
	try {
		settings.auth.registrationOpen = false;
		saveSettings(settings);
		logger.info("Registration closed automatically after the first administrator was created");
	} catch (error) {
		logger.error("Failed to close registration after first administrator", { error });
	}
}

export interface LoginSuccess {
	user: {
		id: string;
		username: string;
		role: string;
		avatarColor: string | null;
		avatarImageId: string | null;
		createdAt: string;
	};
	token: string;
	language: Locale;
}

export interface MfaChallenge {
	mfaRequired: true;
	mfaToken: string;
	methods: Array<"totp" | "backup_code" | "passkey">;
}

/**
 * Build a fully-authenticated session result (real JWT + profile + language)
 * for a user id. Shared by password login (no second factor) and the MFA
 * verify step (after the second factor is proven).
 */
export async function buildSessionResult(userId: string): Promise<LoginSuccess> {
	const profile = await authSessionStore.findSessionProfile(userId);
	if (!profile) {
		throw new AppError("User not found", 404, "NOT_FOUND");
	}
	// tokenVersion stays out of the returned user object: it is an internal revocation
	// counter, not profile data the frontend has any use for.
	const { tokenVersion, language: preferredLanguage, gitUsername, gitEmail, ...user } = profile;
	const token = await createToken(user.id, user.role, tokenVersion);
	return { user, token, language: normalizeLocale(preferredLanguage) };
}

/**
 * Verify username + password. When the account has an active second factor,
 * return an MFA challenge (no session token yet) instead of a session result.
 */
export async function loginUser(
	username: string,
	password: string,
	sourceIp: string,
): Promise<LoginSuccess | MfaChallenge> {
	const attempt = authAttemptLimiter.beginPassword(username, sourceIp);
	if (!attempt.allowed) {
		throw new RateLimitError(
			attempt.reason === "busy" ? "AUTH_BUSY" : "LOGIN_THROTTLED",
			attempt.retryAfterMs,
		);
	}

	let attemptCompleted = false;
	try {
		const user = await authSessionStore.findLoginCredential(username);
		const valid = await Bun.password.verify(
			password,
			user?.passwordHash ?? INVALID_LOGIN_PADDING_HASH,
		);
		if (!valid || !user) {
			const after = attempt.failure();
			attemptCompleted = true;
			logger.warn("Failed password login attempt", {
				userId: user?.id,
				accountFingerprint: fingerprintAuthIdentifier(username),
				sourceIp,
				remaining: after.remaining,
				locked: after.locked,
			});
			if (after.locked) {
				throw new RateLimitError("LOGIN_THROTTLED", after.retryAfterMs);
			}
			throw new AppError("Invalid credentials", 401, "INVALID_CREDENTIALS");
		}

		attempt.success();
		attemptCompleted = true;

		// Gate on a second factor only when the user has opted into MFA. Merely
		// having a passkey (a passwordless login method) or a dormant TOTP secret
		// does NOT force a second step — `users.mfaEnabled` is the explicit switch.
		// The available methods still depend on which factors are actually enrolled.
		if (user.mfaEnabled) {
			// Lazy import: the MFA service pulls in otpauth, which must not load for
			// plain JWT verify/create consumers.
			const { mfaService } = await import("../services/mfa-service");
			const [totpActive, hasPasskey] = await Promise.all([
				mfaService.isTotpActive(user.id),
				mfaService.hasAnyPasskey(user.id),
			]);
			const methods: MfaChallenge["methods"] = [];
			if (totpActive) methods.push("totp", "backup_code");
			if (hasPasskey) methods.push("passkey");
			// Defensive: if MFA is flagged on but no usable factor remains, fall
			// through to a normal session rather than locking the user out.
			if (methods.length > 0) {
				const mfaToken = await issueMfaToken(user.id);
				return { mfaRequired: true, mfaToken, methods };
			}
		}

		return buildSessionResult(user.id);
	} catch (error) {
		if (!attemptCompleted) attempt.cancel();
		throw error;
	}
}
