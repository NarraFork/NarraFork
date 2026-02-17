import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db, sqlite } from "../db";
import { userPreferences } from "../db/schema";
import { ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import { updateUserPreferencesSchema } from "../lib/validators";

export const userPreferencesRoutes = new Hono();

const DEFAULTS = {
	autoLoadOlderMessages: true,
	language: "en",
	wordWrapMarkdown: true,
	wordWrapCode: true,
	wordWrapDiff: true,
	replyInUserLanguage: false,
};

userPreferencesRoutes.get("/", async (c) => {
	const userId = c.get("user").sub;
	const pref = await db.query.userPreferences.findFirst({
		where: eq(userPreferences.userId, userId),
	});
	return c.json(pref ?? { ...DEFAULTS });
});

userPreferencesRoutes.patch("/", async (c) => {
	const userId = c.get("user").sub;
	const body = await c.req.json();
	const parsed = updateUserPreferencesSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const now = new Date().toISOString();
	const id = generateId();

	// Atomic upsert — avoids read-then-write race condition
	sqlite.run(
		`INSERT INTO user_preferences (id, user_id, auto_load_older_messages, language, word_wrap_markdown, word_wrap_code, word_wrap_diff, reply_in_user_language, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (user_id) DO UPDATE SET
		   auto_load_older_messages = COALESCE(?, auto_load_older_messages),
		   language = COALESCE(?, language),
		   word_wrap_markdown = COALESCE(?, word_wrap_markdown),
		   word_wrap_code = COALESCE(?, word_wrap_code),
		   word_wrap_diff = COALESCE(?, word_wrap_diff),
		   reply_in_user_language = COALESCE(?, reply_in_user_language),
		   updated_at = ?`,
		[
			id,
			userId,
			(parsed.data.autoLoadOlderMessages ?? DEFAULTS.autoLoadOlderMessages) ? 1 : 0,
			parsed.data.language ?? DEFAULTS.language,
			(parsed.data.wordWrapMarkdown ?? DEFAULTS.wordWrapMarkdown) ? 1 : 0,
			(parsed.data.wordWrapCode ?? DEFAULTS.wordWrapCode) ? 1 : 0,
			(parsed.data.wordWrapDiff ?? DEFAULTS.wordWrapDiff) ? 1 : 0,
			(parsed.data.replyInUserLanguage ?? DEFAULTS.replyInUserLanguage) ? 1 : 0,
			now,
			now,
			parsed.data.autoLoadOlderMessages != null
				? parsed.data.autoLoadOlderMessages
					? 1
					: 0
				: null,
			parsed.data.language ?? null,
			parsed.data.wordWrapMarkdown != null ? (parsed.data.wordWrapMarkdown ? 1 : 0) : null,
			parsed.data.wordWrapCode != null ? (parsed.data.wordWrapCode ? 1 : 0) : null,
			parsed.data.wordWrapDiff != null ? (parsed.data.wordWrapDiff ? 1 : 0) : null,
			parsed.data.replyInUserLanguage != null ? (parsed.data.replyInUserLanguage ? 1 : 0) : null,
			now,
		],
	);

	const updated = await db.query.userPreferences.findFirst({
		where: eq(userPreferences.userId, userId),
	});
	return c.json(updated);
});
