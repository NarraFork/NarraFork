import { type Locale, normalizeLocale } from "@shared/i18n-locales";
import { SESSION_START_CLAIM, SESSION_TOKEN_TTL_SECONDS } from "@shared/session-auth";
import { count, eq } from "drizzle-orm";
import { sign, verify } from "hono/jwt";
import { db } from "../db";
import { userPreferences, users } from "../db/schema";
import { authAttemptLimiter, fingerprintAuthIdentifier } from "./auth-attempt-limiter";
import { AppError, RateLimitError } from "./errors";
import { generateId } from "./id";
import { logger } from "./logger";
import { issueMfaToken } from "./mfa";
import { settings } from "./settings";

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

// Mantine-friendly avatar color palette
const AVATAR_COLORS = [
	"#4C6EF5", // indigo
	"#7950F2", // violet
	"#BE4BDB", // grape
	"#E64980", // pink
	"#FA5252", // red
	"#FD7E14", // orange
	"#FAB005", // yellow
	"#40C057", // green
	"#12B886", // teal
	"#15AABF", // cyan
	"#228BE6", // blue
	"#845EF7", // violet-light
];

function randomAvatarColor(): string {
	return AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
}

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
}

/**
 * Issue a session JWT for a *fresh login*: the absolute-session anchor starts now.
 * Renewals must use `renewToken` so the anchor is inherited instead of reset.
 */
export async function createToken(userId: string, role: string): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return signSessionToken(userId, role, now, now);
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
): Promise<string> {
	return signSessionToken(userId, role, sessionStart, Math.floor(Date.now() / 1000));
}

async function signSessionToken(
	userId: string,
	role: string,
	sessionStart: number,
	nowSeconds: number,
): Promise<string> {
	return sign(
		{
			sub: userId,
			role,
			iat: nowSeconds,
			exp: nowSeconds + TOKEN_EXPIRY_SECONDS,
			[SESSION_START_CLAIM]: sessionStart,
		},
		getJwtSecret(),
	);
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

export async function registerUser(username: string, password: string, language?: string) {
	const [{ value: userCount }] = await db.select({ value: count() }).from(users);
	const isFirstUser = userCount === 0;

	if (!isFirstUser && !settings.auth.registrationOpen) {
		throw new AppError("Registration is closed", 403, "REGISTRATION_CLOSED");
	}

	const existing = await db.query.users.findFirst({
		where: eq(users.username, username),
	});
	if (existing) {
		throw new AppError("Username already taken", 409, "USERNAME_TAKEN");
	}

	const role = isFirstUser ? "admin" : "user";
	const id = generateId();
	const passwordHash = await Bun.password.hash(password, {
		algorithm: "bcrypt",
		cost: 10,
	});
	const now = new Date().toISOString();

	const avatarColor = randomAvatarColor();
	const resolvedLang = normalizeLocale(language);

	const [user] = db.transaction((tx) => {
		const created = tx
			.insert(users)
			.values({ id, username, passwordHash, role, avatarColor, createdAt: now })
			.returning({
				id: users.id,
				username: users.username,
				role: users.role,
				avatarColor: users.avatarColor,
				avatarImageId: users.avatarImageId,
				createdAt: users.createdAt,
			})
			.all();

		tx.insert(userPreferences)
			.values({
				id: generateId(),
				userId: created[0].id,
				language: resolvedLang,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			})
			.run();

		return created;
	});

	const token = await createToken(user.id, user.role);
	return { user, token, language: resolvedLang };
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
	const user = await db.query.users.findFirst({
		where: eq(users.id, userId),
		columns: {
			id: true,
			username: true,
			role: true,
			avatarColor: true,
			avatarImageId: true,
			createdAt: true,
		},
	});
	if (!user) {
		throw new AppError("User not found", 404, "NOT_FOUND");
	}
	const pref = await db.query.userPreferences.findFirst({
		where: eq(userPreferences.userId, user.id),
		columns: { language: true },
	});
	const token = await createToken(user.id, user.role);
	return { user, token, language: normalizeLocale(pref?.language) };
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
		const user = await db.query.users.findFirst({
			where: eq(users.username, username),
			columns: { id: true, passwordHash: true, mfaEnabled: true },
		});
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
			// Lazy imports: MFA/passkey services pull in otpauth/webauthn packages,
			// which must not load for plain JWT verify/create consumers.
			const [{ mfaService }, { passkeyService }] = await Promise.all([
				import("../services/mfa-service"),
				import("../services/passkey-service"),
			]);
			const [totpActive, hasPasskey] = await Promise.all([
				mfaService.isTotpActive(user.id),
				passkeyService.hasAny(user.id),
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
