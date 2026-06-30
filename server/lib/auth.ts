import { count, eq } from "drizzle-orm";
import { sign, verify } from "hono/jwt";
import { db } from "../db";
import { userPreferences, users } from "../db/schema";
import { mfaService } from "../services/mfa-service";
import { passkeyService } from "../services/passkey-service";
import { AppError } from "./errors";
import { generateId } from "./id";
import { issueMfaToken } from "./mfa";
import { settings } from "./settings";

/** Read JWT secret lazily so it picks up the auto-generated value even when
 *  the module is imported before settings finishes initialization. */
function getJwtSecret(): string {
	return settings.auth.jwtSecret;
}

const TOKEN_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 days

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
}

export async function createToken(userId: string, role: string): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return sign({ sub: userId, role, iat: now, exp: now + TOKEN_EXPIRY_SECONDS }, getJwtSecret());
}

export async function verifyToken(token: string): Promise<JwtPayload> {
	const payload = (await verify(token, getJwtSecret(), "HS256")) as unknown as JwtPayload & {
		stage?: string;
	};
	// Reject intermediate tokens (e.g. MFA challenge tokens carry `stage`).
	// Only fully-authenticated session tokens are accepted as credentials.
	if (payload.stage) {
		throw new AppError("Invalid token", 401, "UNAUTHORIZED");
	}
	return payload;
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

	const [user] = await db.transaction(async (tx) => {
		const [created] = await tx
			.insert(users)
			.values({ id, username, passwordHash, role, avatarColor, createdAt: now })
			.returning({
				id: users.id,
				username: users.username,
				role: users.role,
				avatarColor: users.avatarColor,
				avatarImageId: users.avatarImageId,
				createdAt: users.createdAt,
			});

		const resolvedLang = language || "en";
		await tx.insert(userPreferences).values({
			id: generateId(),
			userId: created.id,
			language: resolvedLang,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});

		return [created];
	});

	const resolvedLang = language || "en";
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
	language: string;
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
	return { user, token, language: pref?.language ?? "en" };
}

/**
 * Verify username + password. When the account has an active second factor,
 * return an MFA challenge (no session token yet) instead of a session result.
 */
export async function loginUser(
	username: string,
	password: string,
): Promise<LoginSuccess | MfaChallenge> {
	const user = await db.query.users.findFirst({
		where: eq(users.username, username),
	});
	if (!user) {
		throw new AppError("Invalid credentials", 401, "INVALID_CREDENTIALS");
	}

	const valid = await Bun.password.verify(password, user.passwordHash);
	if (!valid) {
		throw new AppError("Invalid credentials", 401, "INVALID_CREDENTIALS");
	}

	// Gate on a second factor when one is enrolled. The real session token is
	// only minted after the second factor is proven via /auth/mfa/verify.
	const [totpActive, hasPasskey] = await Promise.all([
		mfaService.isTotpActive(user.id),
		passkeyService.hasAny(user.id),
	]);
	if (totpActive || hasPasskey) {
		const methods: MfaChallenge["methods"] = [];
		if (totpActive) methods.push("totp", "backup_code");
		if (hasPasskey) methods.push("passkey");
		const mfaToken = await issueMfaToken(user.id);
		return { mfaRequired: true, mfaToken, methods };
	}

	return buildSessionResult(user.id);
}
