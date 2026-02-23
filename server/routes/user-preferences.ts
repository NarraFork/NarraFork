import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db, sqlite } from "../db";
import { userPreferences } from "../db/schema";
import { ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import {
	removeRecentTabSchema,
	updateUserPreferencesSchema,
	upsertRecentTabSchema,
} from "../lib/validators";

export const userPreferencesRoutes = new Hono();

const MAX_RECENT_TABS = 20;

const DEFAULTS = {
	autoLoadOlderMessages: true,
	language: "en",
	wordWrapMarkdown: true,
	wordWrapCode: true,
	wordWrapDiff: true,
	replyInUserLanguage: true,
	showTokenUsage: false,
	terminalTheme: "auto",
	terminalFontSize: 14,
	recentTabs: "[]",
};

userPreferencesRoutes.get("/", async (c) => {
	const userId = c.get("user").sub;
	const pref = await db.query.userPreferences.findFirst({
		where: eq(userPreferences.userId, userId),
	});
	if (!pref) return c.json({ ...DEFAULTS, recentTabs: [] });
	// Parse recentTabs JSON string to array for the response
	let recentTabs: unknown[] = [];
	try {
		recentTabs = JSON.parse(pref.recentTabs);
	} catch {
		// corrupted data, reset
	}
	return c.json({ ...pref, recentTabs });
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
		`INSERT INTO user_preferences (id, user_id, auto_load_older_messages, language, word_wrap_markdown, word_wrap_code, word_wrap_diff, reply_in_user_language, show_token_usage, terminal_theme, terminal_font_size, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (user_id) DO UPDATE SET
		   auto_load_older_messages = COALESCE(?, auto_load_older_messages),
		   language = COALESCE(?, language),
		   word_wrap_markdown = COALESCE(?, word_wrap_markdown),
		   word_wrap_code = COALESCE(?, word_wrap_code),
		   word_wrap_diff = COALESCE(?, word_wrap_diff),
		   reply_in_user_language = COALESCE(?, reply_in_user_language),
		   show_token_usage = COALESCE(?, show_token_usage),
		   terminal_theme = COALESCE(?, terminal_theme),
		   terminal_font_size = COALESCE(?, terminal_font_size),
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
			(parsed.data.showTokenUsage ?? DEFAULTS.showTokenUsage) ? 1 : 0,
			parsed.data.terminalTheme ?? DEFAULTS.terminalTheme,
			parsed.data.terminalFontSize ?? DEFAULTS.terminalFontSize,
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
			parsed.data.showTokenUsage != null ? (parsed.data.showTokenUsage ? 1 : 0) : null,
			parsed.data.terminalTheme ?? null,
			parsed.data.terminalFontSize ?? null,
			now,
		],
	);

	const updated = await db.query.userPreferences.findFirst({
		where: eq(userPreferences.userId, userId),
	});
	return c.json(updated);
});

// === Recent Tabs endpoints ===

/** Upsert a recent tab — add or update in place */
userPreferencesRoutes.put("/recent-tabs", async (c) => {
	const userId = c.get("user").sub;
	const body = await c.req.json();
	const parsed = upsertRecentTabSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const tab = parsed.data;
	const now = new Date().toISOString();
	const id = generateId();

	// Read current tabs
	const pref = await db.query.userPreferences.findFirst({
		where: eq(userPreferences.userId, userId),
	});
	let tabs: (typeof tab)[] = [];
	try {
		tabs = pref ? JSON.parse(pref.recentTabs) : [];
	} catch {
		// corrupted, reset
	}

	// Upsert: update in place or prepend
	const idx = tabs.findIndex((t) => t.type === tab.type && t.id === tab.id);
	if (idx >= 0) {
		tabs[idx] = tab;
	} else {
		tabs.unshift(tab);
	}
	tabs = tabs.slice(0, MAX_RECENT_TABS);

	const tabsJson = JSON.stringify(tabs);

	// Atomic upsert for the row itself
	sqlite.run(
		`INSERT INTO user_preferences (id, user_id, recent_tabs, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (user_id) DO UPDATE SET
		   recent_tabs = ?,
		   updated_at = ?`,
		[id, userId, tabsJson, now, now, tabsJson, now],
	);

	eventBus.emit({ type: "user:recent_tabs_changed", userId });
	return c.json(tabs);
});

/** Remove a single recent tab */
userPreferencesRoutes.delete("/recent-tabs/:type/:id", async (c) => {
	const userId = c.get("user").sub;
	const tabType = c.req.param("type");
	const tabId = c.req.param("id");
	const parsed = removeRecentTabSchema.safeParse({ type: tabType, id: tabId });
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const now = new Date().toISOString();
	const pref = await db.query.userPreferences.findFirst({
		where: eq(userPreferences.userId, userId),
	});
	if (!pref) return c.json([]);

	let tabs: unknown[] = [];
	try {
		tabs = JSON.parse(pref.recentTabs);
	} catch {
		// corrupted
	}

	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const filtered = tabs.filter((t: any) => !(t.type === tabType && t.id === tabId));

	sqlite.run(`UPDATE user_preferences SET recent_tabs = ?, updated_at = ? WHERE user_id = ?`, [
		JSON.stringify(filtered),
		now,
		userId,
	]);

	eventBus.emit({ type: "user:recent_tabs_changed", userId });
	return c.json(filtered);
});

/** Clear all recent tabs */
userPreferencesRoutes.delete("/recent-tabs", async (c) => {
	const userId = c.get("user").sub;
	const now = new Date().toISOString();

	sqlite.run(`UPDATE user_preferences SET recent_tabs = '[]', updated_at = ? WHERE user_id = ?`, [
		now,
		userId,
	]);

	eventBus.emit({ type: "user:recent_tabs_changed", userId });
	return c.json([]);
});

/** Reorder recent tabs — receives full ordered array of {type, id} keys */
userPreferencesRoutes.patch("/recent-tabs/reorder", async (c) => {
	const userId = c.get("user").sub;
	const body = await c.req.json();
	const order = body?.order;
	if (!Array.isArray(order)) throw new ValidationError("order must be an array");

	const now = new Date().toISOString();
	const pref = await db.query.userPreferences.findFirst({
		where: eq(userPreferences.userId, userId),
	});
	if (!pref) return c.json([]);

	let tabs: Record<string, unknown>[] = [];
	try {
		tabs = JSON.parse(pref.recentTabs);
	} catch {
		return c.json([]);
	}

	// Build lookup and reorder
	const lookup = new Map<string, (typeof tabs)[number]>();
	for (const t of tabs) lookup.set(`${t.type}:${t.id}`, t);

	const reordered: typeof tabs = [];
	for (const key of order) {
		if (typeof key !== "string") continue;
		const found = lookup.get(key);
		if (found) {
			reordered.push(found);
			lookup.delete(key);
		}
	}
	// Append any tabs not in the order list (shouldn't happen, but safe)
	for (const remaining of lookup.values()) reordered.push(remaining);

	const tabsJson = JSON.stringify(reordered);
	sqlite.run(`UPDATE user_preferences SET recent_tabs = ?, updated_at = ? WHERE user_id = ?`, [
		tabsJson,
		now,
		userId,
	]);

	eventBus.emit({ type: "user:recent_tabs_changed", userId });
	return c.json(reordered);
});
