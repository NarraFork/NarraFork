import {
	RECENT_TABS_LIVE_LIMIT,
	RECENT_TABS_PAGE_SIZE,
	RECENT_TABS_STORAGE_LIMIT,
	RECENT_TABS_WS_BATCH_SIZE,
} from "@shared/recent-tabs";
import { z } from "zod";
import { legacyPermissionModeSchema } from "../permission-modes";
import { commandSchema, localeSchema } from "./common";

/** Per-location proxy override: default (inherit global) / direct / system / custom. */
const proxyOverrideSchema = z
	.object({
		mode: z.enum(["default", "direct", "system", "custom"]),
		url: z.string().max(500).optional(),
	})
	.optional();

// === Gateway per-user configuration ===

const gatewayPlatformConfigSchema = z.object({
	platform: z.enum(["telegram", "discord", "slack", "feishu", "webhook", "weixin", "qqbot"]),
	enabled: z.boolean(),
	proxy: proxyOverrideSchema,
	// Telegram / Discord
	token: z.string().max(500).optional(),
	// Slack
	botToken: z.string().max(500).optional(),
	appToken: z.string().max(500).optional(),
	// Feishu / QQ Bot
	appId: z.string().max(200).optional(),
	appSecret: z.string().max(500).optional(),
	// Webhook
	secret: z.string().max(500).optional(),
	// Weixin
	accountId: z.string().max(200).optional(),
	baseUrl: z.string().max(500).optional(),
	// QQ Bot
	clientSecret: z.string().max(500).optional(),
	allowedGroups: z.array(z.string().max(100)).max(50).optional(),
	dmPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),
	groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),
	markdownSupport: z.boolean().optional(),
	sandbox: z.boolean().optional(),
	stt: z
		.object({
			apiKey: z.string().max(500),
			baseUrl: z.string().max(500).optional(),
			model: z.string().max(100).optional(),
		})
		.optional(),
	// Common
	allowedUsers: z.array(z.string().max(100)).max(50).optional(),
});

const gatewayConfigSchema = z.object({
	enabled: z.boolean().optional(),
	defaultProjectId: z.string().max(50).optional(),
	defaultChapterId: z.string().max(50).optional(),
	defaultPermissionMode: legacyPermissionModeSchema.optional(),
	sessionIdleMinutes: z.number().int().min(0).max(43200).optional(),
	rateLimitPerMinute: z.number().int().min(0).max(1000).optional(),
	streaming: z.boolean().optional(),
	platforms: z.array(gatewayPlatformConfigSchema).max(10).optional(),
});

const navLayoutSchema = z.object({
	items: z
		.array(
			z.object({
				// Customizable nav ids, plus the "__divider__" boundary marker: every
				// id after the divider is tucked into the "More" overflow menu.
				id: z.enum([
					"projects",
					"groups",
					"routines",
					"scheduled-tasks",
					"learn",
					"knowledge",
					"__divider__",
				]),
				// Legacy optional flag — position relative to the divider is authoritative.
				hidden: z.boolean().optional(),
			}),
		)
		.max(20),
});

export const updateUserPreferencesSchema = z.object({
	autoLoadOlderMessages: z.boolean().optional(),
	fastModeDefault: z.boolean().optional(),
	language: localeSchema.optional(),
	wordWrapMarkdown: z.boolean().optional(),
	wordWrapCode: z.boolean().optional(),
	wordWrapDiff: z.boolean().optional(),
	replyInUserLanguage: z.boolean().optional(),
	showTokenUsage: z.boolean().optional(),
	showOutputStats: z.boolean().optional(),
	terminalTheme: z.string().min(1).max(50).optional(),
	terminalFontSize: z.number().int().min(8).max(32).optional(),
	addSubagentToRecentTabs: z.boolean().optional(),
	// Notification preferences
	notifyOnDone: z.boolean().optional(),
	notifyOnWaiting: z.boolean().optional(),
	notifyPwaEnabled: z.boolean().optional(),
	notifySoundEnabled: z.boolean().optional(),
	notifySoundType: z.enum(["builtin", "custom"]).optional(),
	notifySoundBuiltin: z.string().max(50).optional(),
	notifySoundFileId: z.string().max(50).nullable().optional(),
	notifyDingtalkEnabled: z.boolean().optional(),
	notifyDingtalkWebhook: z
		.string()
		.max(500)
		.refine((v) => !v || v.startsWith("https://"), {
			message: "Webhook URL must start with https://",
		})
		.optional(),
	notifyDingtalkSecret: z.string().max(500).optional(),
	notifyFeishuEnabled: z.boolean().optional(),
	notifyFeishuWebhook: z
		.string()
		.max(500)
		.refine((v) => !v || v.startsWith("https://"), {
			message: "Webhook URL must start with https://",
		})
		.optional(),
	notifyFeishuSecret: z.string().max(500).optional(),
	// Slash commands
	commands: z.array(commandSchema).max(100).optional(),
	// Queue behavior bound to the Enter key / send button
	enterQueueMode: z.enum(["turn", "tool", "interrupt"]).optional(),
	// Queue behavior bound to the Ctrl/Cmd+Enter key
	ctrlEnterQueueMode: z.enum(["turn", "tool", "interrupt"]).optional(),
	// Setup wizard
	setupWizardCompleted: z.boolean().optional(),
	// Gateway configuration (per-user IM gateway settings)
	gatewayConfig: gatewayConfigSchema.optional(),
	// Sidebar navigation layout: order = display order, hidden:true = tucked into "More" menu
	navLayout: navLayoutSchema.optional(),
});

const RECENT_TAB_TEXT_MAX_CHARS = 1_000;

export const recentTabSchema = z.object({
	type: z.enum(["chapter", "narrator", "project", "workspace", "subagent", "group"]),
	id: z.string().min(1).max(50),
	narratorId: z.string().min(1).max(50).optional(),
	parentNarratorId: z.string().min(1).max(50).optional(),
	workspaceId: z.string().min(1).max(50).nullish(),
	title: z.string().max(RECENT_TAB_TEXT_MAX_CHARS),
	subtitle: z.string().max(RECENT_TAB_TEXT_MAX_CHARS).optional(),
	status: z.string().max(50).optional(),
	lastVisitedAt: z.number(),
	pinned: z.boolean().optional(),
	isScheduled: z.boolean().optional(),
});

export const upsertRecentTabSchema = recentTabSchema.extend({
	/** When true, only update an existing tab — skip if not already present. */
	updateOnly: z.boolean().optional(),
});

export const batchUpsertRecentTabsSchema = z.object({
	tabs: z.array(upsertRecentTabSchema).min(1).max(RECENT_TABS_WS_BATCH_SIZE),
});

export const removeRecentTabSchema = z.object({
	type: z.enum(["chapter", "narrator", "session", "project", "workspace", "subagent", "group"]),
	id: z.string().min(1).max(50),
});

export const moveRecentTabSchema = z
	.object({
		/** Tab key in "type:id" format */
		key: z.string().min(1).max(100),
		/** Target index (0-based), or a named/key-relative position */
		toIndex: z
			.number()
			.int()
			.min(0)
			.max(RECENT_TABS_STORAGE_LIMIT - 1)
			.optional(),
		position: z.enum(["top", "above_idle"]).optional(),
		beforeKey: z.string().min(1).max(100).optional(),
		afterKey: z.string().min(1).max(100).optional(),
	})
	.superRefine((value, ctx) => {
		const targets = [value.toIndex, value.position, value.beforeKey, value.afterKey].filter(
			(target) => target !== undefined,
		);
		if (targets.length !== 1) {
			ctx.addIssue({
				code: "custom",
				message: "Exactly one move target is required",
			});
		}
	});

export const pinRecentTabSchema = z.object({
	/** Tab key in "type:id" format */
	key: z.string().min(1).max(100),
	/** Whether to pin or unpin */
	pinned: z.boolean(),
});

export const clearRecentTabsSchema = z.object({
	scope: z.enum(["all", "projects", "inactive_narrators"]),
	/** Optional tab key ("type:id") to keep even if it would otherwise be cleared */
	keepTabKey: z.string().optional(),
});

export const recentTabsPageQuerySchema = z.object({
	section: z.enum(["projects", "work"]),
	cursor: z.string().min(1).max(500).optional(),
	limit: z.coerce.number().int().min(1).max(RECENT_TABS_PAGE_SIZE).default(RECENT_TABS_PAGE_SIZE),
});

export const recentTabsRuntimeSchema = z.object({
	keys: z.array(z.string().min(1).max(100)).max(RECENT_TABS_LIVE_LIMIT),
});

export const restoreRecentTabsSchema = z
	.object({
		/** Full list compatibility path; token is preferred for a recent clear undo. */
		tabs: z.array(recentTabSchema).max(RECENT_TABS_STORAGE_LIMIT).optional(),
		token: z.string().min(1).max(100).optional(),
	})
	.superRefine((value, ctx) => {
		if ((value.tabs === undefined) === (value.token === undefined)) {
			ctx.addIssue({ code: "custom", message: "Exactly one of tabs or token is required" });
		}
	});

// === Favorite Directories ===

export const createFavoriteDirectorySchema = z.object({
	path: z.string().min(1).max(4096),
	label: z.string().max(200).optional(),
});

export const updateFavoriteDirectorySchema = z.object({
	path: z.string().min(1).max(4096).optional(),
	label: z.string().max(200).nullable().optional(),
	sortOrder: z.number().int().min(0).optional(),
});

export const reorderFavoriteDirectoriesSchema = z.object({
	ids: z.array(z.string().min(1)).min(1),
});
