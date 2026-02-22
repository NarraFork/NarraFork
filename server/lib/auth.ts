import { count, eq } from "drizzle-orm";
import { sign, verify } from "hono/jwt";
import { db } from "../db";
import { userPreferences, users } from "../db/schema";
import { AppError } from "./errors";
import { generateId } from "./id";
import { settings } from "./settings";

const JWT_SECRET = settings.auth.jwtSecret;
const TOKEN_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 days

export interface JwtPayload {
	sub: string;
	role: "admin" | "user";
	iat: number;
	exp: number;
}

export async function createToken(userId: string, role: string): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return sign({ sub: userId, role, iat: now, exp: now + TOKEN_EXPIRY_SECONDS }, JWT_SECRET);
}

export async function verifyToken(token: string): Promise<JwtPayload> {
	return verify(token, JWT_SECRET, "HS256") as unknown as Promise<JwtPayload>;
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

	const [user] = await db.transaction(async (tx) => {
		const [created] = await tx
			.insert(users)
			.values({ id, username, passwordHash, role, createdAt: now })
			.returning({
				id: users.id,
				username: users.username,
				role: users.role,
				createdAt: users.createdAt,
			});

		const resolvedLang = language || "en";
		await tx.insert(userPreferences).values({
			id: generateId(),
			userId: created.id,
			language: resolvedLang,
		});

		return [created];
	});

	const resolvedLang = language || "en";
	const token = await createToken(user.id, user.role);
	return { user, token, language: resolvedLang };
}

export async function loginUser(username: string, password: string) {
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

	const pref = await db.query.userPreferences.findFirst({
		where: eq(userPreferences.userId, user.id),
		columns: { language: true },
	});

	const token = await createToken(user.id, user.role);
	return {
		user: {
			id: user.id,
			username: user.username,
			role: user.role,
			createdAt: user.createdAt,
		},
		token,
		language: pref?.language ?? "en",
	};
}
