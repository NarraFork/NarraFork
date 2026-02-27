import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db, sqlite } from "../db";
import { narrators, userPreferences } from "../db/schema";
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
	// Notification defaults
	notifyOnDone: true,
	notifyOnWaiting: true,
	notifyPwaEnabled: false,
	notifySoundEnabled: true,
	notifySoundType: "builtin" as const,
	notifySoundBuiltin: "gentle",
	notifySoundFileId: null as string | null,
	notifyDingtalkEnabled: false,
	notifyDingtalkWebhook: "",
	notifyDingtalkSecret: "",
	notifyFeishuEnabled: false,
	notifyFeishuWebhook: "",
	notifyFeishuSecret: "",
};

/** Mask a secret/webhook URL for safe display (show last 4 chars). */
function maskSecret(val?: string | null): string {
	if (!val) return "";
	if (val.length <= 4) return "*".repeat(val.length);
	return `${"*".repeat(8)}${val.slice(-4)}`;
}

userPreferencesRoutes.get("/", async (c) => {
	const userId = c.get("user").sub;
	const pref = await db.query.userPreferences.findFirst({
		where: eq(userPreferences.userId, userId),
	});
	if (!pref) return c.json({ ...DEFAULTS, recentTabs: [] });
	// Parse recentTabs JSON string to array for the response
	let recentTabs: Record<string, unknown>[] = [];
	try {
		recentTabs = JSON.parse(pref.recentTabs);
	} catch {
		// corrupted data, reset
	}

	// Enrich tabs with live narrator status from DB (skip project tabs)
	if (recentTabs.length > 0) {
		const narratorIds = recentTabs
			.filter((t) => t.type !== "project")
			.map((t) => (t.type === "session" ? (t.id as string) : (t.narratorId as string)))
			.filter(Boolean);
		if (narratorIds.length > 0) {
			const rows = await db
				.select({ id: narrators.id, status: narrators.status })
				.from(narrators)
				.where(inArray(narrators.id, narratorIds));
			const statusMap = new Map(rows.map((r) => [r.id, r.status]));
			for (const tab of recentTabs) {
				const nId = tab.type === "session" ? (tab.id as string) : (tab.narratorId as string);
				if (nId && statusMap.has(nId)) {
					tab.status = statusMap.get(nId);
				}
			}
		}
	}

	return c.json({
		...pref,
		recentTabs,
		// Mask sensitive webhook fields
		notifyDingtalkWebhook: maskSecret(pref.notifyDingtalkWebhook),
		notifyDingtalkSecret: maskSecret(pref.notifyDingtalkSecret),
		notifyFeishuWebhook: maskSecret(pref.notifyFeishuWebhook),
		notifyFeishuSecret: maskSecret(pref.notifyFeishuSecret),
	});
});

userPreferencesRoutes.patch("/", async (c) => {
	const userId = c.get("user").sub;
	const body = await c.req.json();
	const parsed = updateUserPreferencesSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const now = new Date().toISOString();
	const id = generateId();
	const d = parsed.data;

	// Preserve existing secrets when masked values are sent back
	let dingtalkWebhook = d.notifyDingtalkWebhook ?? null;
	let dingtalkSecret = d.notifyDingtalkSecret ?? null;
	let feishuWebhook = d.notifyFeishuWebhook ?? null;
	let feishuSecret = d.notifyFeishuSecret ?? null;

	if (
		dingtalkWebhook?.startsWith("*") ||
		dingtalkSecret?.startsWith("*") ||
		feishuWebhook?.startsWith("*") ||
		feishuSecret?.startsWith("*")
	) {
		const existing = await db.query.userPreferences.findFirst({
			where: eq(userPreferences.userId, userId),
		});
		if (existing) {
			if (dingtalkWebhook?.startsWith("*")) dingtalkWebhook = existing.notifyDingtalkWebhook;
			if (dingtalkSecret?.startsWith("*")) dingtalkSecret = existing.notifyDingtalkSecret;
			if (feishuWebhook?.startsWith("*")) feishuWebhook = existing.notifyFeishuWebhook;
			if (feishuSecret?.startsWith("*")) feishuSecret = existing.notifyFeishuSecret;
		}
	}

	// Atomic upsert — avoids read-then-write race condition
	sqlite.run(
		`INSERT INTO user_preferences (
			id, user_id,
			auto_load_older_messages, language, word_wrap_markdown, word_wrap_code, word_wrap_diff,
			reply_in_user_language, show_token_usage, terminal_theme, terminal_font_size,
			notify_on_done, notify_on_waiting, notify_pwa_enabled,
			notify_sound_enabled, notify_sound_type, notify_sound_builtin, notify_sound_file_id,
			notify_dingtalk_enabled, notify_dingtalk_webhook, notify_dingtalk_secret,
			notify_feishu_enabled, notify_feishu_webhook, notify_feishu_secret,
			created_at, updated_at
		) VALUES (${Array(26).fill("?").join(", ")})
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
		   notify_on_done = COALESCE(?, notify_on_done),
		   notify_on_waiting = COALESCE(?, notify_on_waiting),
		   notify_pwa_enabled = COALESCE(?, notify_pwa_enabled),
		   notify_sound_enabled = COALESCE(?, notify_sound_enabled),
		   notify_sound_type = COALESCE(?, notify_sound_type),
		   notify_sound_builtin = COALESCE(?, notify_sound_builtin),
		   notify_sound_file_id = COALESCE(?, notify_sound_file_id),
		   notify_dingtalk_enabled = COALESCE(?, notify_dingtalk_enabled),
		   notify_dingtalk_webhook = COALESCE(?, notify_dingtalk_webhook),
		   notify_dingtalk_secret = COALESCE(?, notify_dingtalk_secret),
		   notify_feishu_enabled = COALESCE(?, notify_feishu_enabled),
		   notify_feishu_webhook = COALESCE(?, notify_feishu_webhook),
		   notify_feishu_secret = COALESCE(?, notify_feishu_secret),
		   updated_at = ?`,
		[
			// INSERT values
			id,
			userId,
			(d.autoLoadOlderMessages ?? DEFAULTS.autoLoadOlderMessages) ? 1 : 0,
			d.language ?? DEFAULTS.language,
			(d.wordWrapMarkdown ?? DEFAULTS.wordWrapMarkdown) ? 1 : 0,
			(d.wordWrapCode ?? DEFAULTS.wordWrapCode) ? 1 : 0,
			(d.wordWrapDiff ?? DEFAULTS.wordWrapDiff) ? 1 : 0,
			(d.replyInUserLanguage ?? DEFAULTS.replyInUserLanguage) ? 1 : 0,
			(d.showTokenUsage ?? DEFAULTS.showTokenUsage) ? 1 : 0,
			d.terminalTheme ?? DEFAULTS.terminalTheme,
			d.terminalFontSize ?? DEFAULTS.terminalFontSize,
			(d.notifyOnDone ?? DEFAULTS.notifyOnDone) ? 1 : 0,
			(d.notifyOnWaiting ?? DEFAULTS.notifyOnWaiting) ? 1 : 0,
			(d.notifyPwaEnabled ?? DEFAULTS.notifyPwaEnabled) ? 1 : 0,
			(d.notifySoundEnabled ?? DEFAULTS.notifySoundEnabled) ? 1 : 0,
			d.notifySoundType ?? DEFAULTS.notifySoundType,
			d.notifySoundBuiltin ?? DEFAULTS.notifySoundBuiltin,
			d.notifySoundFileId ?? DEFAULTS.notifySoundFileId,
			(d.notifyDingtalkEnabled ?? DEFAULTS.notifyDingtalkEnabled) ? 1 : 0,
			dingtalkWebhook ?? DEFAULTS.notifyDingtalkWebhook,
			dingtalkSecret ?? DEFAULTS.notifyDingtalkSecret,
			(d.notifyFeishuEnabled ?? DEFAULTS.notifyFeishuEnabled) ? 1 : 0,
			feishuWebhook ?? DEFAULTS.notifyFeishuWebhook,
			feishuSecret ?? DEFAULTS.notifyFeishuSecret,
			now,
			now,
			// ON CONFLICT UPDATE values (null = keep existing)
			d.autoLoadOlderMessages != null ? (d.autoLoadOlderMessages ? 1 : 0) : null,
			d.language ?? null,
			d.wordWrapMarkdown != null ? (d.wordWrapMarkdown ? 1 : 0) : null,
			d.wordWrapCode != null ? (d.wordWrapCode ? 1 : 0) : null,
			d.wordWrapDiff != null ? (d.wordWrapDiff ? 1 : 0) : null,
			d.replyInUserLanguage != null ? (d.replyInUserLanguage ? 1 : 0) : null,
			d.showTokenUsage != null ? (d.showTokenUsage ? 1 : 0) : null,
			d.terminalTheme ?? null,
			d.terminalFontSize ?? null,
			d.notifyOnDone != null ? (d.notifyOnDone ? 1 : 0) : null,
			d.notifyOnWaiting != null ? (d.notifyOnWaiting ? 1 : 0) : null,
			d.notifyPwaEnabled != null ? (d.notifyPwaEnabled ? 1 : 0) : null,
			d.notifySoundEnabled != null ? (d.notifySoundEnabled ? 1 : 0) : null,
			d.notifySoundType ?? null,
			d.notifySoundBuiltin ?? null,
			d.notifySoundFileId !== undefined ? d.notifySoundFileId : null,
			d.notifyDingtalkEnabled != null ? (d.notifyDingtalkEnabled ? 1 : 0) : null,
			dingtalkWebhook,
			dingtalkSecret,
			d.notifyFeishuEnabled != null ? (d.notifyFeishuEnabled ? 1 : 0) : null,
			feishuWebhook,
			feishuSecret,
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
