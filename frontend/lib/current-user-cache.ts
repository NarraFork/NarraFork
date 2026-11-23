const CURRENT_USER_KEY = "narrafork_current_user_v1";
const MAX_CACHE_CHARS = 16_384;

interface CachedCurrentUser {
	id: string;
	username: string;
	role: string;
	avatarColor?: string | null;
	avatarImageId?: string | null;
	gitUsername?: string | null;
	gitEmail?: string | null;
	createdAt?: string | null;
}

function sanitizeUser(value: unknown): CachedCurrentUser | undefined {
	if (!value || typeof value !== "object") return;
	const user = value as Record<string, unknown>;
	if (
		typeof user.id !== "string" ||
		!user.id ||
		typeof user.username !== "string" ||
		!user.username ||
		typeof user.role !== "string" ||
		!user.role
	)
		return;
	const result: CachedCurrentUser = { id: user.id, username: user.username, role: user.role };
	for (const key of [
		"avatarColor",
		"avatarImageId",
		"gitUsername",
		"gitEmail",
		"createdAt",
	] as const) {
		if (user[key] === null || typeof user[key] === "string") result[key] = user[key];
	}
	return result;
}

export function clearCurrentUserCache(): void {
	try {
		localStorage.removeItem(CURRENT_USER_KEY);
	} catch {}
}

export function readCurrentUserCache(): CachedCurrentUser | undefined {
	try {
		const raw = localStorage.getItem(CURRENT_USER_KEY);
		if (!raw) return;
		if (raw.length <= MAX_CACHE_CHARS) {
			const user = sanitizeUser(JSON.parse(raw));
			if (user) return user;
		}
	} catch {}
	clearCurrentUserCache();
}

export function writeCurrentUserCache(value: unknown): void {
	try {
		const user = sanitizeUser(value);
		const raw = user && JSON.stringify(user);
		if (raw && raw.length <= MAX_CACHE_CHARS) localStorage.setItem(CURRENT_USER_KEY, raw);
		else clearCurrentUserCache();
	} catch {}
}
