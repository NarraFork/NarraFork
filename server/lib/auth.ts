import { count, eq } from "drizzle-orm";
import { sign, verify } from "hono/jwt";
import { db } from "../db";
import { users } from "../db/schema";
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
	return verify(token, JWT_SECRET) as Promise<JwtPayload>;
}

export async function registerUser(username: string, password: string) {
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

	const [user] = await db
		.insert(users)
		.values({ id, username, passwordHash, role, createdAt: now })
		.returning({
			id: users.id,
			username: users.username,
			role: users.role,
			createdAt: users.createdAt,
		});

	const token = await createToken(user.id, user.role);
	return { user, token };
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

	const token = await createToken(user.id, user.role);
	return {
		user: {
			id: user.id,
			username: user.username,
			role: user.role,
			createdAt: user.createdAt,
		},
		token,
	};
}
