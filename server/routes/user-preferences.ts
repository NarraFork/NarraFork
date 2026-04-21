import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db, sqlite } from "../db";
import { narrators, userPreferences, workspaces } from "../db/schema";
import { ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import {
	clearRecentTabsSchema,
	moveRecentTabSchema,
	pinRecentTabSchema,
	removeRecentTabSchema,
	updateUserPreferencesSchema,
	upsertRecentTabSchema,
} from "../lib/validators";
import {
	broadcastTabsSnapshot,
	enrichTabs,
	migrateTabTypes,
} from "../services/user-preferences-service";
import { broadcastToUser } from "../websocket/narrator-ws";

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

/**
 * Enforce workspace grouping invariant: workspace header is immediately followed
 * by all its children (tabs with matching workspaceId), with no other tabs in between.
 * Orphan children (workspaceId points to a missing header) get their workspaceId cleared.
 * Operates in-place.
 */
function regroupWorkspaces(tabs: Record<string, unknown>[]): void {
	// 1. Collect workspace children grouped by workspaceId, preserving relative order
	const childrenByWs = new Map<string, Record<string, unknown>[]>();
	for (const t of tabs) {
		const wsId = t.workspaceId as string | undefined;
		if (wsId) {
			const arr = childrenByWs.get(wsId);
			if (arr) arr.push(t);
			else childrenByWs.set(wsId, [t]);
		}
	}
	if (childrenByWs.size === 0) return;

	// 2. Remove all workspace children from the array
	let i = 0;
	while (i < tabs.length) {
		if (tabs[i].workspaceId) tabs.splice(i, 1);
		else i++;
	}

	// 3. Re-insert children right after their workspace header
	const headerIds = new Set<string>();
	for (let j = 0; j < tabs.length; j++) {
		if (tabs[j].type === "workspace") {
			const wsId = tabs[j].id as string;
			headerIds.add(wsId);
			const children = childrenByWs.get(wsId);
			if (children && children.length > 0) {
				tabs.splice(j + 1, 0, ...children);
				j += children.length;
			}
		}
	}

	// 4. Orphan children (header was removed) — clear workspaceId so they become top-level
	for (const [wsId, children] of childrenByWs) {
		if (!headerIds.has(wsId)) {
			for (const c of children) {
				delete c.workspaceId;
			}
			// Append orphans at the end
			tabs.push(...children);
		}
	}
}

/**
 * Return the array index immediately after the pinned top-level section.
 * Workspace children ride along with their header, so they do not break the pinned zone.
 */
function getPinnedSectionEndIndex(tabs: Record<string, unknown>[]): number {
	let idx = 0;
	while (idx < tabs.length) {
		const tab = tabs[idx];
		if (tab.workspaceId) {
			idx++;
			continue;
		}
		if (!tab.pinned) break;
		idx++;
		if (tab.type === "workspace") {
			while (idx < tabs.length && tabs[idx].workspaceId === tab.id) idx++;
		}
	}
	return idx;
}

/**
 * Move an existing top-level tab (or workspace group) to the front of the unpinned section.
 * Pinned tabs keep their manual order, and workspace children stay attached to their header.
 */
function promoteTopLevelTabRespectingPins(tabs: Record<string, unknown>[], idx: number): void {
	const tab = tabs[idx];
	if (!tab || tab.workspaceId || tab.pinned) return;

	let movedGroup: Record<string, unknown>[];
	if (tab.type === "workspace") {
		let end = idx + 1;
		while (end < tabs.length && tabs[end].workspaceId === tab.id) end++;
		movedGroup = tabs.splice(idx, end - idx);
	} else {
		movedGroup = tabs.splice(idx, 1);
	}

	tabs.splice(getPinnedSectionEndIndex(tabs), 0, ...movedGroup);
}

/** Insert a new top-level tab at the front of the unpinned section. */
function insertTopLevelTabRespectingPins(
	tabs: Record<string, unknown>[],
	tab: Record<string, unknown>,
): void {
	tabs.splice(getPinnedSectionEndIndex(tabs), 0, tab);
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

		// Upsert: merge into existing or insert into the recent order while preserving the pinned zone
		const idx = tabs.findIndex((t) => t.type === tab.type && t.id === tab.id);
		if (idx >= 0) {
			if (updateOnly) {
				// Only merge non-empty fields to avoid overwriting with placeholder values
				const patch: Record<string, unknown> = {};
				for (const [k, v] of Object.entries(tab)) {
					if (k === "type" || k === "id") continue;
					if (v !== "" && v !== undefined) patch[k] = v;
				}
				tabs[idx] = { ...tabs[idx], ...patch };
			} else {
				tabs[idx] = { ...tabs[idx], ...tab };
				promoteTopLevelTabRespectingPins(tabs as Record<string, unknown>[], idx);
			}
		} else if (updateOnly) {
			sqlite.run("COMMIT");
			return c.json(tabs);
		} else {
			// New tab: if it belongs to a workspace, insert after the workspace header's
			// last child instead of prepending to the top.
			const wsId = tab.workspaceId as string | undefined;
			if (wsId) {
				const headerIdx = tabs.findIndex((t) => t.type === "workspace" && t.id === wsId);
				if (headerIdx >= 0) {
					// Find the end of the workspace group
					let insertIdx = headerIdx + 1;
					while (insertIdx < tabs.length && tabs[insertIdx].workspaceId === wsId) {
						insertIdx++;
					}
					tabs.splice(insertIdx, 0, tab);
				} else {
					// Header not found — clear workspaceId and insert as a top-level tab.
					delete (tab as Record<string, unknown>).workspaceId;
					insertTopLevelTabRespectingPins(tabs as Record<string, unknown>[], tab);
				}
			} else {
				insertTopLevelTabRespectingPins(tabs as Record<string, unknown>[], tab);
			}
		}
		tabs = tabs.slice(0, MAX_RECENT_TABS);
		regroupWorkspaces(tabs);

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

		// When removing a workspace header, release all children (clear workspaceId)
		// and delete the workspace DB record.
		if (tabType === "workspace") {
			for (const t of tabs as Record<string, unknown>[]) {
				if (t.workspaceId === tabId) delete t.workspaceId;
			}
			db.delete(workspaces)
				.where(eq(workspaces.id, tabId))
				.catch(() => {});
		}

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
			// Workspace-aware: if ANY child in a workspace is active, keep the
			// entire workspace (header + all children). If ALL children are idle,
			// remove the workspace + children and dissolve the workspace DB record.
			const narratorIds = tabs
				.filter((t) => t.type !== "project" && t.type !== "workspace")
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

			// Group children by workspaceId
			const childrenByWs = new Map<string, Record<string, unknown>[]>();
			for (const t of tabs) {
				const wsId = t.workspaceId as string | undefined;
				if (wsId) {
					const arr = childrenByWs.get(wsId);
					if (arr) arr.push(t);
					else childrenByWs.set(wsId, [t]);
				}
			}

			// Determine which workspaces have at least one active child
			const activeWorkspaces = new Set<string>();
			const allWorkspaceIds = new Set<string>();
			for (const t of tabs) {
				if (t.type === "workspace") allWorkspaceIds.add(t.id as string);
			}
			for (const wsId of allWorkspaceIds) {
				const children = childrenByWs.get(wsId) ?? [];
				const hasActive = children.some((child) => {
					const nId =
						child.type === "narrator" ? (child.id as string) : (child.narratorId as string);
					const status = nId ? statusMap.get(nId) : undefined;
					return status != null && ACTIVE_STATUSES.has(status);
				});
				if (hasActive) activeWorkspaces.add(wsId);
			}

			// Workspaces to dissolve (all children idle)
			const dissolveWsIds: string[] = [];
			for (const wsId of allWorkspaceIds) {
				if (!activeWorkspaces.has(wsId) && !isKept({ type: "workspace", id: wsId })) {
					dissolveWsIds.push(wsId);
				}
			}

			filtered = tabs.filter((t) => {
				if (isKept(t)) return true;
				if (t.type === "project") return true;
				// Workspace header
				if (t.type === "workspace") {
					return activeWorkspaces.has(t.id as string);
				}
				// Workspace child — follow workspace decision
				const wsId = t.workspaceId as string | undefined;
				if (wsId) {
					return activeWorkspaces.has(wsId);
				}
				// Non-workspace tab — keep if active
				const nId = t.type === "narrator" ? (t.id as string) : (t.narratorId as string);
				const status = nId ? statusMap.get(nId) : undefined;
				return status != null && ACTIVE_STATUSES.has(status);
			});

			// Dissolve workspace DB records for fully-idle workspaces
			for (const wsId of dissolveWsIds) {
				await db.delete(workspaces).where(eq(workspaces.id, wsId));
			}
		}

		regroupWorkspaces(filtered);

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
			const tab = tabs[idx];

			// Extract the item (or workspace group) from the array
			let movedGroup: Record<string, unknown>[];
			if (tab.type === "workspace") {
				// Workspace header: extract header + all contiguous children
				let end = idx + 1;
				while (end < tabs.length && tabs[end].workspaceId === tab.id) end++;
				movedGroup = tabs.splice(idx, end - idx);
			} else {
				movedGroup = tabs.splice(idx, 1);
			}

			if (position === "top") {
				tabs.unshift(...movedGroup);
			} else if (position === "above_idle") {
				// If the moved tab is a workspace child, promote the whole workspace instead.
				// The movedGroup is already extracted; find the workspace header and re-extract.
				const wsId = movedGroup[0].workspaceId as string | undefined;
				if (wsId && movedGroup.length === 1) {
					// Put the child back first, then re-extract the whole workspace group
					tabs.splice(idx, 0, ...movedGroup);
					const headerIdx = tabs.findIndex((t) => t.type === "workspace" && t.id === wsId);
					if (headerIdx >= 0) {
						let end = headerIdx + 1;
						while (end < tabs.length && tabs[end].workspaceId === wsId) end++;
						movedGroup = tabs.splice(headerIdx, end - headerIdx);
					}
				}

				// Need live status from DB
				const narratorIds = tabs
					.filter((t) => t.type !== "project" && t.type !== "workspace" && !t.workspaceId)
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

				// Find the first idle top-level tab (skip workspace children and pinned tabs)
				const IDLE_STATUSES = new Set(["idle"]);
				let firstIdleIdx = -1;
				for (let i = 0; i < tabs.length; i++) {
					// Skip pinned tabs — they stay at the top
					if (tabs[i].pinned) continue;
					// Skip workspace children — they move with their header
					if (tabs[i].workspaceId) continue;
					// Skip workspace headers — check their children's status
					if (tabs[i].type === "workspace") {
						const wsChildren: Record<string, unknown>[] = [];
						for (let k = i + 1; k < tabs.length && tabs[k].workspaceId === tabs[i].id; k++) {
							wsChildren.push(tabs[k]);
						}
						const allIdle = wsChildren.every((c) => {
							const nId = c.type === "narrator" ? (c.id as string) : (c.narratorId as string);
							const st = nId ? statusMap.get(nId) : undefined;
							return st != null && IDLE_STATUSES.has(st);
						});
						if (wsChildren.length > 0 && allIdle) {
							firstIdleIdx = i;
							break;
						}
						continue;
					}
					const nId =
						tabs[i].type === "narrator" ? (tabs[i].id as string) : (tabs[i].narratorId as string);
					const status = nId ? statusMap.get(nId) : undefined;
					if (status && IDLE_STATUSES.has(status)) {
						firstIdleIdx = i;
						break;
					}
				}
				if (firstIdleIdx === -1) {
					tabs.push(...movedGroup);
				} else {
					tabs.splice(firstIdleIdx, 0, ...movedGroup);
				}
			} else if (toIndex != null) {
				// toIndex — clamp to valid range
				const target = Math.min(toIndex, tabs.length);
				tabs.splice(target, 0, ...movedGroup);
			}

			// Ensure workspace grouping invariant after any move
			regroupWorkspaces(tabs);

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

/** Toggle pin/unpin on a recent tab */
userPreferencesRoutes.patch("/recent-tabs/pin", async (c) => {
	const userId = c.get("user").sub;
	const body = await c.req.json();
	const parsed = pinRecentTabSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const { key, pinned } = parsed.data;
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
			sqlite.run("COMMIT");
			result = tabs;
		} else {
			if (pinned) {
				tabs[idx].pinned = true;
				// Move to end of pinned section (before first non-pinned tab)
				const tab = tabs.splice(idx, 1)[0];
				let insertIdx = 0;
				while (insertIdx < tabs.length && tabs[insertIdx].pinned) insertIdx++;
				tabs.splice(insertIdx, 0, tab);
			} else {
				delete tabs[idx].pinned;
				// Move to start of non-pinned section (after last pinned tab)
				const tab = tabs.splice(idx, 1)[0];
				let insertIdx = 0;
				while (insertIdx < tabs.length && tabs[insertIdx].pinned) insertIdx++;
				tabs.splice(insertIdx, 0, tab);
			}

			regroupWorkspaces(tabs);
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

		const existingVp = viewports[projectId];
		viewports[projectId] = {
			// Preserve existing ruler fields when classic mode saves (only x/y/zoom)
			...existingVp,
			x: viewport.x,
			y: viewport.y,
			zoom: viewport.zoom,
			...(viewport.rulerOrientation && { rulerOrientation: viewport.rulerOrientation }),
			...(viewport.rulerEdge && { rulerEdge: viewport.rulerEdge }),
			...(viewport.rulerMainPan != null && { rulerMainPan: viewport.rulerMainPan }),
			...(viewport.rulerCrossPan != null && { rulerCrossPan: viewport.rulerCrossPan }),
		};

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
