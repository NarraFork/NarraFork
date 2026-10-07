import { DEFAULT_TYPOGRAPHY } from "@shared/pretext-layout/typography";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db, sqlite } from "../db";
import { userPreferences } from "../db/schema";
import { userPreferencesLock } from "../lib/async-mutex";
import { ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import { saveSettings, settings } from "../lib/settings";
import {
	batchUpsertRecentTabsSchema,
	clearRecentTabsSchema,
	moveRecentTabSchema,
	pinRecentTabSchema,
	recentTabsPageQuerySchema,
	recentTabsRuntimeSchema,
	removeRecentTabSchema,
	restoreRecentTabsSchema,
	setRecentTabDirectoryOrderSchema,
	updateUserPreferencesSchema,
	upsertRecentTabSchema,
} from "../lib/validators";
import {
	clearRecentTabs,
	getRuntimePatches,
	listLegacyTabs,
	listPage,
	moveRecentTab,
	pinRecentTab,
	removeRecentTab,
	restoreRecentTabs,
	setRecentTabDirectoryOrder,
	upsertRecentTab,
	upsertRecentTabsBatch,
} from "../services/recent-tabs-service";
import { enrichTabs } from "../services/user-preferences-service";

export const userPreferencesRoutes = new Hono();

const DEFAULTS = {
	autoLoadOlderMessages: true,
	fastModeDefault: false,
	treatAsLocalAccess: false,
	language: "en",
	wordWrapMarkdown: true,
	wordWrapCode: true,
	wordWrapDiff: true,
	replyInUserLanguage: true,
	showTokenUsage: false,
	showOutputStats: true,
	terminalTheme: "auto",
	terminalFontSize: 14,
	// Narrator transcript typography. Sourced from the shared neutral setting rather
	// than literals so "no preference" always means the same thing the height model
	// treats as unscaled (see shared/pretext-layout/typography.ts).
	narratorFontScalePercent: DEFAULT_TYPOGRAPHY.fontScalePercent,
	narratorLetterSpacingPercent: DEFAULT_TYPOGRAPHY.letterSpacingPercent,
	narratorLineHeightScalePercent: DEFAULT_TYPOGRAPHY.lineHeightScalePercent,
	narratorParagraphScalePercent: DEFAULT_TYPOGRAPHY.paragraphScalePercent,
	recentTabs: "[]",
	addSubagentToRecentTabs: true,
	recentTabsGroupMode: "flat" as const,
	// Notification defaults
	notifyOnDone: true,
	notifyOnWaiting: true,
	notifyPwaEnabled: false,
	notifySoundEnabled: true,
	notifySoundType: "builtin" as const,
	notifySoundBuiltin: "gentle",
	notifySoundFileId: null as string | null,
	notifySoundVolume: 100,
	notifySoundMaxConcurrent: 2,
	notifyDingtalkEnabled: false,
	notifyDingtalkWebhook: "",
	notifyDingtalkSecret: "",
	notifyFeishuEnabled: false,
	notifyFeishuWebhook: "",
	notifyFeishuSecret: "",
	// Queue behavior bound to the Enter key / send button
	enterQueueMode: "turn" as const,
	// Queue behavior bound to the Ctrl/Cmd+Enter key
	ctrlEnterQueueMode: "tool" as const,
	// Gateway
	gatewayConfig: "{}",
	// Sidebar navigation layout
	navLayout: "{}",
	// Narrator header toolbar layout
	narratorToolbarLayout: "{}",
};

/** Mask a secret/webhook URL for safe display (show last 4 chars). */
function maskSecret(val?: string | null): string {
	if (!val) return "";
	if (val.length <= 4) return "*".repeat(val.length);
	return `${"*".repeat(8)}${val.slice(-4)}`;
}

const TOP_LEVEL_SECRET_FIELDS = [
	"notifyDingtalkWebhook",
	"notifyDingtalkSecret",
	"notifyFeishuWebhook",
	"notifyFeishuSecret",
] as const;
const GATEWAY_SECRET_FIELDS = [
	"token",
	"botToken",
	"appToken",
	"appSecret",
	"secret",
	"clientSecret",
] as const;
const GATEWAY_STT_SECRET_FIELDS = ["apiKey"] as const;

/**
 * Columns written by the INSERT half of the PATCH upsert, in positional order.
 *
 * The placeholder count is DERIVED from this array rather than written as a literal.
 * It used to be a hand-maintained `Array(39)`, and adding the four typography columns
 * without touching it produced `SQLiteError: 39 values for 43 columns` — every first
 * write of any preference failed, because the INSERT half is the path taken whenever
 * the user has no row yet.
 *
 * This array is therefore the single source of truth for that half. The value array
 * passed to `sqlite.run` must stay in this exact order, and the ON CONFLICT SET clause
 * that follows keeps its own separate parameter list — a new column still has to be
 * added in all of: this array, the INSERT values, the SET clause, and the UPDATE values.
 */
const INSERT_COLUMNS = [
	"id",
	"user_id",
	"auto_load_older_messages",
	"fast_mode_default",
	"treat_as_local_access",
	"language",
	"word_wrap_markdown",
	"word_wrap_code",
	"word_wrap_diff",
	"reply_in_user_language",
	"show_token_usage",
	"show_output_stats",
	"terminal_theme",
	"terminal_font_size",
	"narrator_font_scale_percent",
	"narrator_letter_spacing_percent",
	"narrator_paragraph_scale_percent",
	"narrator_line_height_scale_percent",
	"add_subagent_to_recent_tabs",
	"recent_tabs_group_mode",
	"notify_on_done",
	"notify_on_waiting",
	"notify_pwa_enabled",
	"notify_sound_enabled",
	"notify_sound_type",
	"notify_sound_builtin",
	"notify_sound_file_id",
	"notify_sound_volume",
	"notify_sound_max_concurrent",
	"notify_dingtalk_enabled",
	"notify_dingtalk_webhook",
	"notify_dingtalk_secret",
	"notify_feishu_enabled",
	"notify_feishu_webhook",
	"notify_feishu_secret",
	"commands",
	"queue_mode",
	"ctrl_enter_queue_mode",
	"setup_wizard_completed",
	"gateway_config",
	"nav_layout",
	"narrator_toolbar_layout",
	"created_at",
	"updated_at",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMaskedSecret(value: unknown): value is string {
	return typeof value === "string" && value.startsWith("*");
}

function parseJsonArray(value: unknown): unknown[] {
	try {
		const parsed = typeof value === "string" ? JSON.parse(value) : value;
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function parseJsonObject(value: unknown): Record<string, unknown> {
	try {
		const parsed = typeof value === "string" ? JSON.parse(value) : value;
		return isRecord(parsed) ? { ...parsed } : {};
	} catch {
		return {};
	}
}

function maskRecordFields(
	record: Record<string, unknown>,
	fields: readonly string[],
): Record<string, unknown> {
	const masked = { ...record };
	for (const field of fields) {
		if (typeof masked[field] === "string") {
			masked[field] = maskSecret(masked[field]);
		}
	}
	return masked;
}

function serializeGatewayConfig(value: unknown): Record<string, unknown> {
	const gatewayConfig = parseJsonObject(value);
	if (!Array.isArray(gatewayConfig.platforms)) return gatewayConfig;

	return {
		...gatewayConfig,
		platforms: gatewayConfig.platforms.map((platform) => {
			if (!isRecord(platform)) return platform;
			const masked = maskRecordFields(platform, GATEWAY_SECRET_FIELDS);
			if (isRecord(masked.stt)) {
				masked.stt = maskRecordFields(masked.stt, GATEWAY_STT_SECRET_FIELDS);
			}
			return masked;
		}),
	};
}

function hasMaskedGatewaySecret(gatewayConfig: Record<string, unknown>): boolean {
	if (!Array.isArray(gatewayConfig.platforms)) return false;
	return gatewayConfig.platforms.some((platform) => {
		if (!isRecord(platform)) return false;
		if (GATEWAY_SECRET_FIELDS.some((field) => isMaskedSecret(platform[field]))) return true;
		const stt = platform.stt;
		return isRecord(stt) && GATEWAY_STT_SECRET_FIELDS.some((field) => isMaskedSecret(stt[field]));
	});
}

function restoreMaskedGatewaySecrets(
	gatewayConfig: Record<string, unknown>,
	storedValue: unknown,
): Record<string, unknown> {
	if (!Array.isArray(gatewayConfig.platforms)) return gatewayConfig;
	const storedGatewayConfig = parseJsonObject(storedValue);
	const storedPlatforms = Array.isArray(storedGatewayConfig.platforms)
		? storedGatewayConfig.platforms.filter(isRecord)
		: [];
	const storedByPlatform = new Map(
		storedPlatforms.map((platform) => [platform.platform, platform]),
	);

	return {
		...gatewayConfig,
		platforms: gatewayConfig.platforms.map((platform) => {
			if (!isRecord(platform)) return platform;
			const storedPlatform = storedByPlatform.get(platform.platform) ?? {};
			const restored = { ...platform };
			for (const field of GATEWAY_SECRET_FIELDS) {
				if (isMaskedSecret(restored[field])) {
					restored[field] = storedPlatform[field] ?? "";
				}
			}
			if (isRecord(restored.stt)) {
				const storedStt = isRecord(storedPlatform.stt) ? storedPlatform.stt : {};
				const restoredStt = { ...restored.stt };
				for (const field of GATEWAY_STT_SECRET_FIELDS) {
					if (isMaskedSecret(restoredStt[field])) {
						restoredStt[field] = storedStt[field] ?? "";
					}
				}
				restored.stt = restoredStt;
			}
			return restored;
		}),
	};
}

/** Migrate once, persisting even false so ordinary requests never rescan all users. */
function instanceSetupWizardCompleted(): boolean {
	if (settings.setupWizardCompleted === undefined) {
		const completed = !!sqlite
			.query("SELECT 1 FROM user_preferences WHERE setup_wizard_completed = 1 LIMIT 1")
			.get();
		saveSettings({ ...settings, setupWizardCompleted: completed });
	}
	return settings.setupWizardCompleted === true;
}

function serializeUserPreferences(
	pref: typeof userPreferences.$inferSelect,
	recentTabs?: Record<string, unknown>[],
): Record<string, unknown> {
	return {
		...pref,
		setupWizardCompleted: instanceSetupWizardCompleted(),
		...(recentTabs === undefined ? {} : { recentTabs }),
		commands: parseJsonArray(pref.commands),
		notifyDingtalkWebhook: maskSecret(pref.notifyDingtalkWebhook),
		notifyDingtalkSecret: maskSecret(pref.notifyDingtalkSecret),
		notifyFeishuWebhook: maskSecret(pref.notifyFeishuWebhook),
		notifyFeishuSecret: maskSecret(pref.notifyFeishuSecret),
		gatewayConfig: serializeGatewayConfig(pref.gatewayConfig),
		navLayout: parseJsonObject(pref.navLayout),
		narratorToolbarLayout: parseJsonObject(pref.narratorToolbarLayout),
	};
}

userPreferencesRoutes.get("/", async (c) => {
	const userId = c.get("user").sub;
	const legacyTabs = await listLegacyTabs(userId);
	const recentTabs = await enrichTabs(
		legacyTabs.map((tab) => ({ ...tab })) as Record<string, unknown>[],
		userId,
	);
	const pref = await db.query.userPreferences.findFirst({
		where: eq(userPreferences.userId, userId),
	});
	if (!pref) {
		return c.json({
			...DEFAULTS,
			setupWizardCompleted: instanceSetupWizardCompleted(),
			recentTabs,
			commands: [],
			gatewayConfig: {},
			navLayout: {},
			narratorToolbarLayout: {},
		});
	}

	return c.json(serializeUserPreferences(pref, recentTabs));
});

userPreferencesRoutes.patch("/", async (c) => {
	const userId = c.get("user").sub;
	const body = await c.req.json();

	const updated = await userPreferencesLock.acquire(userId, async () => {
		const existing = await db.query.userPreferences.findFirst({
			where: eq(userPreferences.userId, userId),
		});
		const mergedBody = isRecord(body) ? { ...body } : body;
		if (isRecord(mergedBody)) {
			for (const field of TOP_LEVEL_SECRET_FIELDS) {
				if (isMaskedSecret(mergedBody[field])) {
					mergedBody[field] = existing?.[field] ?? "";
				}
			}
			if (isRecord(mergedBody.gatewayConfig) && hasMaskedGatewaySecret(mergedBody.gatewayConfig)) {
				mergedBody.gatewayConfig = restoreMaskedGatewaySecrets(
					mergedBody.gatewayConfig,
					existing?.gatewayConfig,
				);
			}
		}
		const parsed = updateUserPreferencesSchema.safeParse(mergedBody);
		if (!parsed.success) throw new ValidationError(parsed.error.message);

		const now = new Date().toISOString();
		const id = generateId();
		const d = parsed.data;
		// Resolve legacy completion before any write can erase its last evidence.
		const setupCompleted = instanceSetupWizardCompleted();
		if (d.setupWizardCompleted === true && c.get("user").role === "admin" && !setupCompleted) {
			saveSettings({ ...settings, setupWizardCompleted: true });
		}
		// Never let personal preferences reset completion or seed a non-admin legacy bypass.
		d.setupWizardCompleted = settings.setupWizardCompleted === true;
		const dingtalkWebhook = d.notifyDingtalkWebhook ?? null;
		const dingtalkSecret = d.notifyDingtalkSecret ?? null;
		const feishuWebhook = d.notifyFeishuWebhook ?? null;
		const feishuSecret = d.notifyFeishuSecret ?? null;

		// Atomic upsert — avoids read-then-write race condition
		const commandsJson = d.commands != null ? JSON.stringify(d.commands) : null;
		const navLayoutJson = d.navLayout != null ? JSON.stringify(d.navLayout) : null;
		const narratorToolbarLayoutJson =
			d.narratorToolbarLayout != null ? JSON.stringify(d.narratorToolbarLayout) : null;

		// Resolve masked placeholders from the latest row while holding the per-user lock.
		let gatewayConfigJson: string | null = null;
		if (d.gatewayConfig != null) {
			const gatewayConfig = { ...d.gatewayConfig } as Record<string, unknown>;
			const restoredGatewayConfig = hasMaskedGatewaySecret(gatewayConfig)
				? restoreMaskedGatewaySecrets(gatewayConfig, existing?.gatewayConfig)
				: gatewayConfig;
			gatewayConfigJson = JSON.stringify(restoredGatewayConfig);
		}

		sqlite.run(
			`INSERT INTO user_preferences (${INSERT_COLUMNS.join(", ")})
		 VALUES (${INSERT_COLUMNS.map(() => "?").join(", ")})
		 ON CONFLICT (user_id) DO UPDATE SET
		   auto_load_older_messages = COALESCE(?, auto_load_older_messages),
		   fast_mode_default = COALESCE(?, fast_mode_default),
		   treat_as_local_access = COALESCE(?, treat_as_local_access),
		   language = COALESCE(?, language),
		   word_wrap_markdown = COALESCE(?, word_wrap_markdown),
		   word_wrap_code = COALESCE(?, word_wrap_code),
		   word_wrap_diff = COALESCE(?, word_wrap_diff),
		   reply_in_user_language = COALESCE(?, reply_in_user_language),
		   show_token_usage = COALESCE(?, show_token_usage),
		   show_output_stats = COALESCE(?, show_output_stats),
		   terminal_theme = COALESCE(?, terminal_theme),
		   terminal_font_size = COALESCE(?, terminal_font_size),
		   narrator_font_scale_percent = COALESCE(?, narrator_font_scale_percent),
		   narrator_letter_spacing_percent = COALESCE(?, narrator_letter_spacing_percent),
		   narrator_paragraph_scale_percent = COALESCE(?, narrator_paragraph_scale_percent),
		   narrator_line_height_scale_percent = COALESCE(?, narrator_line_height_scale_percent),
		   add_subagent_to_recent_tabs = COALESCE(?, add_subagent_to_recent_tabs),
		   recent_tabs_group_mode = COALESCE(?, recent_tabs_group_mode),
		   notify_on_done = COALESCE(?, notify_on_done),
		   notify_on_waiting = COALESCE(?, notify_on_waiting),
		   notify_pwa_enabled = COALESCE(?, notify_pwa_enabled),
		   notify_sound_enabled = COALESCE(?, notify_sound_enabled),
		   notify_sound_type = COALESCE(?, notify_sound_type),
		   notify_sound_builtin = COALESCE(?, notify_sound_builtin),
		   notify_sound_file_id = COALESCE(?, notify_sound_file_id),
		   notify_sound_volume = COALESCE(?, notify_sound_volume),
		   notify_sound_max_concurrent = COALESCE(?, notify_sound_max_concurrent),
		   notify_dingtalk_enabled = COALESCE(?, notify_dingtalk_enabled),
		   notify_dingtalk_webhook = COALESCE(?, notify_dingtalk_webhook),
		   notify_dingtalk_secret = COALESCE(?, notify_dingtalk_secret),
		   notify_feishu_enabled = COALESCE(?, notify_feishu_enabled),
		   notify_feishu_webhook = COALESCE(?, notify_feishu_webhook),
		   notify_feishu_secret = COALESCE(?, notify_feishu_secret),
		   commands = COALESCE(?, commands),
		   queue_mode = COALESCE(?, queue_mode),
		   ctrl_enter_queue_mode = COALESCE(?, ctrl_enter_queue_mode),
		   setup_wizard_completed = COALESCE(?, setup_wizard_completed),
		   gateway_config = COALESCE(?, gateway_config),
		   nav_layout = COALESCE(?, nav_layout),
		   narrator_toolbar_layout = COALESCE(?, narrator_toolbar_layout),
		   updated_at = ?`,
			[
				// INSERT values
				id,
				userId,
				(d.autoLoadOlderMessages ?? DEFAULTS.autoLoadOlderMessages) ? 1 : 0,
				(d.fastModeDefault ?? DEFAULTS.fastModeDefault) ? 1 : 0,
				(d.treatAsLocalAccess ?? DEFAULTS.treatAsLocalAccess) ? 1 : 0,
				d.language ?? DEFAULTS.language,
				(d.wordWrapMarkdown ?? DEFAULTS.wordWrapMarkdown) ? 1 : 0,
				(d.wordWrapCode ?? DEFAULTS.wordWrapCode) ? 1 : 0,
				(d.wordWrapDiff ?? DEFAULTS.wordWrapDiff) ? 1 : 0,
				(d.replyInUserLanguage ?? DEFAULTS.replyInUserLanguage) ? 1 : 0,
				(d.showTokenUsage ?? DEFAULTS.showTokenUsage) ? 1 : 0,
				(d.showOutputStats ?? DEFAULTS.showOutputStats) ? 1 : 0,
				d.terminalTheme ?? DEFAULTS.terminalTheme,
				d.terminalFontSize ?? DEFAULTS.terminalFontSize,
				d.narratorFontScalePercent ?? DEFAULTS.narratorFontScalePercent,
				d.narratorLetterSpacingPercent ?? DEFAULTS.narratorLetterSpacingPercent,
				d.narratorParagraphScalePercent ?? DEFAULTS.narratorParagraphScalePercent,
				d.narratorLineHeightScalePercent ?? DEFAULTS.narratorLineHeightScalePercent,
				(d.addSubagentToRecentTabs ?? DEFAULTS.addSubagentToRecentTabs) ? 1 : 0,
				d.recentTabsGroupMode ?? DEFAULTS.recentTabsGroupMode,
				(d.notifyOnDone ?? DEFAULTS.notifyOnDone) ? 1 : 0,
				(d.notifyOnWaiting ?? DEFAULTS.notifyOnWaiting) ? 1 : 0,
				(d.notifyPwaEnabled ?? DEFAULTS.notifyPwaEnabled) ? 1 : 0,
				(d.notifySoundEnabled ?? DEFAULTS.notifySoundEnabled) ? 1 : 0,
				d.notifySoundType ?? DEFAULTS.notifySoundType,
				d.notifySoundBuiltin ?? DEFAULTS.notifySoundBuiltin,
				d.notifySoundFileId ?? DEFAULTS.notifySoundFileId,
				d.notifySoundVolume ?? DEFAULTS.notifySoundVolume,
				d.notifySoundMaxConcurrent ?? DEFAULTS.notifySoundMaxConcurrent,
				(d.notifyDingtalkEnabled ?? DEFAULTS.notifyDingtalkEnabled) ? 1 : 0,
				dingtalkWebhook ?? DEFAULTS.notifyDingtalkWebhook,
				dingtalkSecret ?? DEFAULTS.notifyDingtalkSecret,
				(d.notifyFeishuEnabled ?? DEFAULTS.notifyFeishuEnabled) ? 1 : 0,
				feishuWebhook ?? DEFAULTS.notifyFeishuWebhook,
				feishuSecret ?? DEFAULTS.notifyFeishuSecret,
				commandsJson ?? "[]",
				d.enterQueueMode ?? DEFAULTS.enterQueueMode,
				d.ctrlEnterQueueMode ?? DEFAULTS.ctrlEnterQueueMode,
				d.setupWizardCompleted ? 1 : 0,
				gatewayConfigJson ?? DEFAULTS.gatewayConfig,
				navLayoutJson ?? DEFAULTS.navLayout,
				narratorToolbarLayoutJson ?? DEFAULTS.narratorToolbarLayout,
				now,
				now,
				// ON CONFLICT UPDATE values (null = keep existing)
				d.autoLoadOlderMessages != null ? (d.autoLoadOlderMessages ? 1 : 0) : null,
				d.fastModeDefault != null ? (d.fastModeDefault ? 1 : 0) : null,
				d.treatAsLocalAccess != null ? (d.treatAsLocalAccess ? 1 : 0) : null,
				d.language ?? null,
				d.wordWrapMarkdown != null ? (d.wordWrapMarkdown ? 1 : 0) : null,
				d.wordWrapCode != null ? (d.wordWrapCode ? 1 : 0) : null,
				d.wordWrapDiff != null ? (d.wordWrapDiff ? 1 : 0) : null,
				d.replyInUserLanguage != null ? (d.replyInUserLanguage ? 1 : 0) : null,
				d.showTokenUsage != null ? (d.showTokenUsage ? 1 : 0) : null,
				d.showOutputStats != null ? (d.showOutputStats ? 1 : 0) : null,
				d.terminalTheme ?? null,
				d.terminalFontSize ?? null,
				d.narratorFontScalePercent ?? null,
				d.narratorLetterSpacingPercent ?? null,
				d.narratorParagraphScalePercent ?? null,
				d.narratorLineHeightScalePercent ?? null,
				d.addSubagentToRecentTabs != null ? (d.addSubagentToRecentTabs ? 1 : 0) : null,
				d.recentTabsGroupMode ?? null,
				d.notifyOnDone != null ? (d.notifyOnDone ? 1 : 0) : null,
				d.notifyOnWaiting != null ? (d.notifyOnWaiting ? 1 : 0) : null,
				d.notifyPwaEnabled != null ? (d.notifyPwaEnabled ? 1 : 0) : null,
				d.notifySoundEnabled != null ? (d.notifySoundEnabled ? 1 : 0) : null,
				d.notifySoundType ?? null,
				d.notifySoundBuiltin ?? null,
				d.notifySoundFileId !== undefined ? d.notifySoundFileId : null,
				d.notifySoundVolume ?? null,
				d.notifySoundMaxConcurrent ?? null,
				d.notifyDingtalkEnabled != null ? (d.notifyDingtalkEnabled ? 1 : 0) : null,
				dingtalkWebhook,
				dingtalkSecret,
				d.notifyFeishuEnabled != null ? (d.notifyFeishuEnabled ? 1 : 0) : null,
				feishuWebhook,
				feishuSecret,
				commandsJson,
				d.enterQueueMode ?? null,
				d.ctrlEnterQueueMode ?? null,
				d.setupWizardCompleted != null ? (d.setupWizardCompleted ? 1 : 0) : null,
				gatewayConfigJson,
				navLayoutJson,
				narratorToolbarLayoutJson,
				now,
			],
		);

		return db.query.userPreferences.findFirst({
			where: eq(userPreferences.userId, userId),
		});
	});
	return c.json(updated ? serializeUserPreferences(updated) : updated);
});

// === Recent Tabs endpoints ===

/** Cursor-paginated authoritative recent tabs, split into project/work sections. */
userPreferencesRoutes.get("/recent-tabs", async (c) => {
	const userId = c.get("user").sub;
	const parsed = recentTabsPageQuerySchema.safeParse({
		section: c.req.query("section"),
		cursor: c.req.query("cursor"),
		limit: c.req.query("limit"),
	});
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(await listPage(userId, parsed.data.section, parsed.data.cursor, parsed.data.limit));
});

/** Fetch bounded live-only patches for currently rendered tabs. */
userPreferencesRoutes.post("/recent-tabs/runtime", async (c) => {
	const userId = c.get("user").sub;
	const parsed = recentTabsRuntimeSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(await getRuntimePatches(userId, parsed.data.keys));
});

/** Upsert a durable recent tab without returning the full collection. */
userPreferencesRoutes.put("/recent-tabs", async (c) => {
	const userId = c.get("user").sub;
	const parsed = upsertRecentTabSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const { updateOnly, beforeKey, afterKey, ...tab } = parsed.data;
	return c.json(await upsertRecentTab(userId, tab, { updateOnly, beforeKey, afterKey }));
});

/** Atomically upsert a workspace header and its children with one revision. */
userPreferencesRoutes.post("/recent-tabs/batch", async (c) => {
	const userId = c.get("user").sub;
	const parsed = batchUpsertRecentTabsSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(await upsertRecentTabsBatch(userId, parsed.data.tabs));
});

userPreferencesRoutes.delete("/recent-tabs/:type/:id", async (c) => {
	const userId = c.get("user").sub;
	const parsed = removeRecentTabSchema.safeParse({
		type: c.req.param("type"),
		id: c.req.param("id"),
		// `?cascade=1` marks entity-teardown cleanups (chapter deleted, narrator archived).
		cascade: c.req.query("cascade") === "1" ? true : undefined,
	});
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const type = parsed.data.type === "session" ? "narrator" : parsed.data.type;
	// User-initiated close (swipe / context menu / middle-click) mints an undo token;
	// cascade cleanups must not (they would clobber a pending user undo).
	return c.json(
		await removeRecentTab(userId, type, parsed.data.id, { storeUndo: !parsed.data.cascade }),
	);
});

userPreferencesRoutes.post("/recent-tabs/clear", async (c) => {
	const userId = c.get("user").sub;
	const parsed = clearRecentTabsSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(await clearRecentTabs(userId, parsed.data.scope, parsed.data.keepTabKey));
});

userPreferencesRoutes.post("/recent-tabs/restore", async (c) => {
	const userId = c.get("user").sub;
	const parsed = restoreRecentTabsSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(await restoreRecentTabs(userId, parsed.data));
});

userPreferencesRoutes.patch("/recent-tabs/move", async (c) => {
	const userId = c.get("user").sub;
	const parsed = moveRecentTabSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(await moveRecentTab(userId, parsed.data));
});

userPreferencesRoutes.patch("/recent-tabs/pin", async (c) => {
	const userId = c.get("user").sub;
	const parsed = pinRecentTabSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(await pinRecentTab(userId, parsed.data.key, parsed.data.pinned));
});

/**
 * Member order inside one directory group. Separate from `/recent-tabs/move` because it
 * writes a different column with different semantics: move rewrites the flat recency
 * order (and has to expand workspace groups), this only records a hand-made arrangement.
 */
userPreferencesRoutes.patch("/recent-tabs/dir-order", async (c) => {
	const userId = c.get("user").sub;
	const parsed = setRecentTabDirectoryOrderSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(await setRecentTabDirectoryOrder(userId, parsed.data.keys));
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

	await userPreferencesLock.acquire(userId, async () => {
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
	});

	return c.json({ ok: true });
});
