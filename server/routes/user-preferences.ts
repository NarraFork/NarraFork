import { and, count as countFn, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db, sqlite } from "../db";
import { containerInstances, narrators, terminals, userPreferences } from "../db/schema";
import { CONTAINER_STATUS_PRIORITY } from "../lib/constants";
import { ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import {
	clearRecentTabsSchema,
	moveRecentTabSchema,
	removeRecentTabSchema,
	updateUserPreferencesSchema,
	upsertRecentTabSchema,
} from "../lib/validators";
import { broadcastToUser, getNarratorPresenceBatch } from "../websocket/narrator-ws";

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
	showOutputStats: true,
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
	sendMode: "enter" as const,
};

/** Mask a secret/webhook URL for safe display (show last 4 chars). */
function maskSecret(val?: string | null): string {
	if (!val) return "";
	if (val.length <= 4) return "*".repeat(val.length);
	return `${"*".repeat(8)}${val.slice(-4)}`;
}

/** Migrate legacy "session" tab type → "narrator" (in-place). */
function migrateTabTypes(tabs: Record<string, unknown>[]): void {
	for (const t of tabs) {
		// biome-ignore lint/suspicious/noExplicitAny: legacy data migration
		if ((t as any).type === "session") {
			// biome-ignore lint/suspicious/noExplicitAny: legacy data migration
			(t as any).type = "narrator";
		}
	}
}

/** Enrich raw tabs with live runtime data (narrator status, terminals, presence, containers). */
export async function enrichTabs(
	tabs: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
	if (tabs.length === 0) return tabs;

	migrateTabTypes(tabs);

	const narratorIds = tabs
		.filter((t) => t.type !== "project")
		.map((t) => (t.type === "narrator" ? (t.id as string) : (t.narratorId as string)))
		.filter(Boolean);

	if (narratorIds.length > 0) {
		// Narrator status
		const rows = await db
			.select({ id: narrators.id, status: narrators.status })
			.from(narrators)
			.where(inArray(narrators.id, narratorIds));
		const statusMap = new Map(rows.map((r) => [r.id, r.status]));
		for (const tab of tabs) {
			const nId = tab.type === "narrator" ? (tab.id as string) : (tab.narratorId as string);
			if (nId && statusMap.has(nId)) {
				tab.status = statusMap.get(nId);
			}
		}

		// Active terminal counts
		const termRows = await db
			.select({
				narratorId: terminals.narratorId,
				count: countFn(),
			})
			.from(terminals)
			.where(and(inArray(terminals.narratorId, narratorIds), eq(terminals.status, "running")))
			.groupBy(terminals.narratorId);
		const termCountMap = new Map(termRows.map((r) => [r.narratorId, r.count]));
		for (const tab of tabs) {
			const nId = tab.type === "narrator" ? (tab.id as string) : (tab.narratorId as string);
			if (nId && termCountMap.has(nId)) {
				tab.activeTerminalCount = termCountMap.get(nId);
			}
		}

		// Presence (from in-memory map)
		const presenceMap = getNarratorPresenceBatch(narratorIds);
		for (const tab of tabs) {
			const nId = tab.type === "narrator" ? (tab.id as string) : (tab.narratorId as string);
			if (nId) {
				const viewers = presenceMap.get(nId);
				if (viewers && viewers.length > 0) {
					tab.viewers = viewers;
				}
			}
		}
	}

	// Container status for chapter tabs
	const chapterIds = tabs.filter((t) => t.type === "chapter").map((t) => t.id as string);
	if (chapterIds.length > 0) {
		const containerRows = await db
			.select({
				chapterId: containerInstances.chapterId,
				status: containerInstances.status,
			})
			.from(containerInstances)
			.where(inArray(containerInstances.chapterId, chapterIds));

		const containerStatusMap = new Map<string, string>();
		for (const row of containerRows) {
			const existing = containerStatusMap.get(row.chapterId);
			if (
				!existing ||
				(CONTAINER_STATUS_PRIORITY[row.status] ?? 0) > (CONTAINER_STATUS_PRIORITY[existing] ?? 0)
			) {
				containerStatusMap.set(row.chapterId, row.status);
			}
		}
		for (const tab of tabs) {
			if (tab.type === "chapter" && containerStatusMap.has(tab.id as string)) {
				tab.containerStatus = containerStatusMap.get(tab.id as string);
			}
		}
	}

	return tabs;
}

/**
 * Remove a tab (chapter, narrator, or project) from every user's recent_tabs and broadcast updated snapshots.
 * Called when the corresponding entity is deleted so ghost tabs don't linger.
 */
export async function removeTabFromAllUsers(
	tabType: "chapter" | "narrator" | "project",
	tabId: string,
): Promise<void> {
	const rows = db
		.select({ userId: userPreferences.userId, recentTabs: userPreferences.recentTabs })
		.from(userPreferences)
		.all();

	const now = new Date().toISOString();

	for (const row of rows) {
		let tabs: Record<string, unknown>[];
		try {
			tabs = JSON.parse(row.recentTabs);
		} catch {
			continue;
		}
		if (!Array.isArray(tabs)) continue;

		const filtered = tabs.filter(
			(t: Record<string, unknown>) => !(t.type === tabType && t.id === tabId),
		);
		if (filtered.length === tabs.length) continue; // nothing removed

		sqlite.run(`UPDATE user_preferences SET recent_tabs = ?, updated_at = ? WHERE user_id = ?`, [
			JSON.stringify(filtered),
			now,
			row.userId,
		]);
		broadcastTabsSnapshot(row.userId, filtered);
	}
}

/** Enrich tabs and broadcast a snapshot to all of the user's WS connections. */
export async function broadcastTabsSnapshot(
	userId: string,
	tabs: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
	const enriched = await enrichTabs(tabs);
	broadcastToUser(userId, {
		type: "user:recent_tabs_snapshot",
		tabs: enriched,
		revision: Date.now(),
	});
	return enriched;
}

userPreferencesRoutes.get("/", async (c) => {
	const userId = c.get("user").sub;
	const pref = await db.query.userPreferences.findFirst({
		where: eq(userPreferences.userId, userId),
	});
	if (!pref) return c.json({ ...DEFAULTS, recentTabs: [], commands: [] });
	// Parse recentTabs JSON string to array for the response
	let recentTabs: Record<string, unknown>[] = [];
	try {
		recentTabs = JSON.parse(pref.recentTabs);
	} catch {
		// corrupted data, reset
	}

	// Parse commands JSON string to array
	let commands: unknown[] = [];
	try {
		const raw = typeof pref.commands === "string" ? JSON.parse(pref.commands) : pref.commands;
		commands = Array.isArray(raw) ? raw : [];
	} catch {
		// corrupted data, reset
	}

	// Enrich tabs with live runtime data
	recentTabs = await enrichTabs(recentTabs);

	return c.json({
		...pref,
		recentTabs,
		commands,
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
	const commandsJson = d.commands != null ? JSON.stringify(d.commands) : null;

	sqlite.run(
		`INSERT INTO user_preferences (
			id, user_id,
			auto_load_older_messages, language, word_wrap_markdown, word_wrap_code, word_wrap_diff,
			reply_in_user_language, show_token_usage, show_output_stats, terminal_theme, terminal_font_size,
			notify_on_done, notify_on_waiting, notify_pwa_enabled,
			notify_sound_enabled, notify_sound_type, notify_sound_builtin, notify_sound_file_id,
			notify_dingtalk_enabled, notify_dingtalk_webhook, notify_dingtalk_secret,
			notify_feishu_enabled, notify_feishu_webhook, notify_feishu_secret,
			commands, send_mode, setup_wizard_completed,
			created_at, updated_at
		) VALUES (${Array(30).fill("?").join(", ")})
		 ON CONFLICT (user_id) DO UPDATE SET
		   auto_load_older_messages = COALESCE(?, auto_load_older_messages),
		   language = COALESCE(?, language),
		   word_wrap_markdown = COALESCE(?, word_wrap_markdown),
		   word_wrap_code = COALESCE(?, word_wrap_code),
		   word_wrap_diff = COALESCE(?, word_wrap_diff),
		   reply_in_user_language = COALESCE(?, reply_in_user_language),
		   show_token_usage = COALESCE(?, show_token_usage),
		   show_output_stats = COALESCE(?, show_output_stats),
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
		   commands = COALESCE(?, commands),
		   send_mode = COALESCE(?, send_mode),
		   setup_wizard_completed = COALESCE(?, setup_wizard_completed),
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
			(d.showOutputStats ?? DEFAULTS.showOutputStats) ? 1 : 0,
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
			commandsJson ?? "[]",
			d.sendMode ?? DEFAULTS.sendMode,
			d.setupWizardCompleted ? 1 : 0,
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
			d.showOutputStats != null ? (d.showOutputStats ? 1 : 0) : null,
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
			commandsJson,
			d.sendMode ?? null,
			d.setupWizardCompleted != null ? (d.setupWizardCompleted ? 1 : 0) : null,
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

	const { updateOnly, ...tab } = parsed.data;
	const now = new Date().toISOString();
	const id = generateId();

	let tabs: (typeof tab)[];

	sqlite.run("BEGIN IMMEDIATE");
	try {
		// Read current tabs
		const pref = await db.query.userPreferences.findFirst({
			where: eq(userPreferences.userId, userId),
		});
		tabs = [];
		try {
			tabs = pref ? JSON.parse(pref.recentTabs) : [];
		} catch {
			// corrupted, reset
		}

		migrateTabTypes(tabs);

		// Upsert: merge into existing or prepend
		const idx = tabs.findIndex((t) => t.type === tab.type && t.id === tab.id);
		if (idx >= 0) {
			tabs[idx] = { ...tabs[idx], ...tab };
		} else if (updateOnly) {
			sqlite.run("COMMIT");
			return c.json(tabs);
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
		sqlite.run("COMMIT");
	} catch (err) {
		sqlite.run("ROLLBACK");
		throw err;
	}

	const enriched = await broadcastTabsSnapshot(userId, tabs);
	return c.json(enriched);
});

/** Remove a single recent tab */
userPreferencesRoutes.delete("/recent-tabs/:type/:id", async (c) => {
	const userId = c.get("user").sub;
	const tabType = c.req.param("type");
	const tabId = c.req.param("id");
	const parsed = removeRecentTabSchema.safeParse({ type: tabType, id: tabId });
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const now = new Date().toISOString();
	let filtered: unknown[];

	sqlite.run("BEGIN IMMEDIATE");
	try {
		const pref = await db.query.userPreferences.findFirst({
			where: eq(userPreferences.userId, userId),
		});
		if (!pref) {
			sqlite.run("COMMIT");
			return c.json([]);
		}

		let tabs: unknown[] = [];
		try {
			tabs = JSON.parse(pref.recentTabs);
		} catch {
			// corrupted
		}
		migrateTabTypes(tabs as Record<string, unknown>[]);

		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		filtered = tabs.filter((t: any) => !(t.type === tabType && t.id === tabId));

		sqlite.run(`UPDATE user_preferences SET recent_tabs = ?, updated_at = ? WHERE user_id = ?`, [
			JSON.stringify(filtered),
			now,
			userId,
		]);
		sqlite.run("COMMIT");
	} catch (err) {
		sqlite.run("ROLLBACK");
		throw err;
	}

	const enriched = await broadcastTabsSnapshot(userId, filtered as Record<string, unknown>[]);
	return c.json(enriched);
});

/** Clear recent tabs by scope — server decides which tabs to remove */
userPreferencesRoutes.post("/recent-tabs/clear", async (c) => {
	const userId = c.get("user").sub;
	const body = await c.req.json();
	const parsed = clearRecentTabsSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const { scope, keepTabKey } = parsed.data;
	const now = new Date().toISOString();

	// Helper: check if a tab matches the keepTabKey
	const isKept = (t: Record<string, unknown>) =>
		keepTabKey ? `${t.type}:${t.id}` === keepTabKey : false;

	if (scope === "all") {
		if (keepTabKey) {
			// Keep the single tab that matches keepTabKey
			let kept: Record<string, unknown>[] = [];
			const pref = await db.query.userPreferences.findFirst({
				where: eq(userPreferences.userId, userId),
			});
			if (pref) {
				try {
					const tabs: Record<string, unknown>[] = JSON.parse(pref.recentTabs);
					kept = tabs.filter(isKept);
				} catch {
					// corrupted
				}
			}
			sqlite.run(`UPDATE user_preferences SET recent_tabs = ?, updated_at = ? WHERE user_id = ?`, [
				JSON.stringify(kept),
				now,
				userId,
			]);
			const enriched = await broadcastTabsSnapshot(userId, kept);
			return c.json(enriched);
		}
		sqlite.run(`UPDATE user_preferences SET recent_tabs = '[]', updated_at = ? WHERE user_id = ?`, [
			now,
			userId,
		]);
		broadcastToUser(userId, { type: "user:recent_tabs_snapshot", tabs: [], revision: Date.now() });
		return c.json([]);
	}

	let filtered: Record<string, unknown>[];

	sqlite.run("BEGIN IMMEDIATE");
	try {
		const pref = await db.query.userPreferences.findFirst({
			where: eq(userPreferences.userId, userId),
		});
		if (!pref) {
			sqlite.run("COMMIT");
			return c.json([]);
		}

		let tabs: Record<string, unknown>[] = [];
		try {
			tabs = JSON.parse(pref.recentTabs);
		} catch {
			sqlite.run("COMMIT");
			return c.json([]);
		}
		migrateTabTypes(tabs);

		const ACTIVE_STATUSES = new Set(["thinking", "waiting", "done"]);

		if (scope === "projects") {
			filtered = tabs.filter((t) => t.type !== "project" || isKept(t));
		} else {
			// inactive_narrators: keep projects + active narrator/chapter tabs
			// Need live status from DB for accurate filtering
			const narratorIds = tabs
				.filter((t) => t.type !== "project")
				.map((t) => (t.type === "narrator" ? (t.id as string) : (t.narratorId as string)))
				.filter(Boolean);

			const statusMap = new Map<string, string>();
			if (narratorIds.length > 0) {
				const rows = await db
					.select({ id: narrators.id, status: narrators.status })
					.from(narrators)
					.where(inArray(narrators.id, narratorIds));
				for (const r of rows) statusMap.set(r.id, r.status);
			}

			filtered = tabs.filter((t) => {
				if (isKept(t)) return true;
				if (t.type === "project") return true;
				const nId = t.type === "narrator" ? (t.id as string) : (t.narratorId as string);
				const status = nId ? statusMap.get(nId) : undefined;
				return status != null && ACTIVE_STATUSES.has(status);
			});
		}

		sqlite.run(`UPDATE user_preferences SET recent_tabs = ?, updated_at = ? WHERE user_id = ?`, [
			JSON.stringify(filtered),
			now,
			userId,
		]);
		sqlite.run("COMMIT");
	} catch (err) {
		sqlite.run("ROLLBACK");
		throw err;
	}

	const enriched = await broadcastTabsSnapshot(userId, filtered);
	return c.json(enriched);
});

/** Move a single tab to a specific index or named position */
userPreferencesRoutes.patch("/recent-tabs/move", async (c) => {
	const userId = c.get("user").sub;
	const body = await c.req.json();
	const parsed = moveRecentTabSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const { key, toIndex, position } = parsed.data;
	if (toIndex == null && !position) throw new ValidationError("toIndex or position required");

	const now = new Date().toISOString();
	let result: Record<string, unknown>[];

	sqlite.run("BEGIN IMMEDIATE");
	try {
		const pref = await db.query.userPreferences.findFirst({
			where: eq(userPreferences.userId, userId),
		});
		if (!pref) {
			sqlite.run("COMMIT");
			return c.json([]);
		}

		let tabs: Record<string, unknown>[] = [];
		try {
			tabs = JSON.parse(pref.recentTabs);
		} catch {
			sqlite.run("COMMIT");
			return c.json([]);
		}
		migrateTabTypes(tabs);

		const idx = tabs.findIndex((t) => `${t.type}:${t.id}` === key);
		if (idx === -1) {
			// Tab not found — return current list unchanged
			sqlite.run("COMMIT");
			result = tabs;
		} else {
			const [moved] = tabs.splice(idx, 1);

			if (position === "top") {
				tabs.unshift(moved);
			} else if (position === "above_idle") {
				// Need live status from DB
				const narratorIds = tabs
					.filter((t) => t.type !== "project")
					.map((t) => (t.type === "narrator" ? (t.id as string) : (t.narratorId as string)))
					.filter(Boolean);
				const statusMap = new Map<string, string>();
				if (narratorIds.length > 0) {
					const rows = await db
						.select({ id: narrators.id, status: narrators.status })
						.from(narrators)
						.where(inArray(narrators.id, narratorIds));
					for (const r of rows) statusMap.set(r.id, r.status);
				}

				// Find the first idle tab and insert just above it
				const IDLE_STATUSES = new Set(["idle"]);
				let firstIdleIdx = -1;
				for (let i = 0; i < tabs.length; i++) {
					const nId =
						tabs[i].type === "narrator" ? (tabs[i].id as string) : (tabs[i].narratorId as string);
					const status = nId ? statusMap.get(nId) : undefined;
					if (status && IDLE_STATUSES.has(status)) {
						firstIdleIdx = i;
						break;
					}
				}
				if (firstIdleIdx === -1) {
					// No idle tabs — append at end
					tabs.push(moved);
				} else {
					tabs.splice(firstIdleIdx, 0, moved);
				}
			} else if (toIndex != null) {
				// toIndex — clamp to valid range
				const target = Math.min(toIndex, tabs.length);
				tabs.splice(target, 0, moved);
			}

			result = tabs;
			sqlite.run(`UPDATE user_preferences SET recent_tabs = ?, updated_at = ? WHERE user_id = ?`, [
				JSON.stringify(result),
				now,
				userId,
			]);
			sqlite.run("COMMIT");
		}
	} catch (err) {
		sqlite.run("ROLLBACK");
		throw err;
	}

	const enriched = await broadcastTabsSnapshot(userId, result);
	return c.json(enriched);
});

// --- Graph viewport persistence (per-project) ---

userPreferencesRoutes.patch("/graph-viewports", async (c) => {
	const userId = c.get("user").sub;
	const body = await c.req.json();
	const projectId = body?.projectId;
	const viewport = body?.viewport; // { x, y, zoom }
	if (
		typeof projectId !== "string" ||
		!projectId ||
		typeof viewport?.x !== "number" ||
		typeof viewport?.y !== "number" ||
		typeof viewport?.zoom !== "number"
	) {
		throw new ValidationError("Invalid viewport data");
	}

	const now = new Date().toISOString();
	const id = generateId();

	// Use BEGIN IMMEDIATE to prevent concurrent read-modify-write races
	sqlite.run("BEGIN IMMEDIATE");
	try {
		const existing = await db.query.userPreferences.findFirst({
			where: eq(userPreferences.userId, userId),
			columns: { graphViewports: true },
		});

		let viewports: Record<string, { x: number; y: number; zoom: number }> = {};
		try {
			if (existing?.graphViewports) {
				viewports = JSON.parse(existing.graphViewports);
			}
		} catch {
			// corrupted, reset
		}

		viewports[projectId] = { x: viewport.x, y: viewport.y, zoom: viewport.zoom };

		sqlite.run(
			`INSERT INTO user_preferences (id, user_id, graph_viewports, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT (user_id) DO UPDATE SET
			   graph_viewports = ?,
			   updated_at = ?`,
			[id, userId, JSON.stringify(viewports), now, now, JSON.stringify(viewports), now],
		);
		sqlite.run("COMMIT");
	} catch (err) {
		sqlite.run("ROLLBACK");
		throw err;
	}

	return c.json({ ok: true });
});
