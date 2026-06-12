import { z } from "zod";
import { legacyPermissionModeSchema } from "../permission-modes";
import { commandSchema } from "./common";

// === Gateway per-user configuration ===

const gatewayPlatformConfigSchema = z.object({
	platform: z.enum(["telegram", "discord", "slack", "feishu", "webhook", "weixin", "qqbot"]),
	enabled: z.boolean(),
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

export const updateUserPreferencesSchema = z.object({
	autoLoadOlderMessages: z.boolean().optional(),
	fastModeDefault: z.boolean().optional(),
	language: z.enum(["en", "zh-CN"]).optional(),
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
	// Send mode
	sendMode: z.enum(["enter", "ctrl+enter"]).optional(),
	// Setup wizard
	setupWizardCompleted: z.boolean().optional(),
	// Gateway configuration (per-user IM gateway settings)
	gatewayConfig: gatewayConfigSchema.optional(),
});

const RECENT_TAB_TEXT_MAX_CHARS = 1_000;

export const recentTabSchema = z.object({
	type: z.enum(["chapter", "narrator", "project", "workspace", "subagent"]),
	id: z.string().min(1).max(50),
	narratorId: z.string().min(1).max(50).optional(),
	parentNarratorId: z.string().min(1).max(50).optional(),
	workspaceId: z.string().min(1).max(50).nullish(),
	title: z.string().max(RECENT_TAB_TEXT_MAX_CHARS),
	subtitle: z.string().max(RECENT_TAB_TEXT_MAX_CHARS).optional(),
	status: z.string().max(50).optional(),
	lastVisitedAt: z.number(),
	pinned: z.boolean().optional(),
});

export const upsertRecentTabSchema = recentTabSchema.extend({
	/** When true, only update an existing tab — skip if not already present. */
	updateOnly: z.boolean().optional(),
});

export const removeRecentTabSchema = z.object({
	type: z.enum(["chapter", "narrator", "session", "project", "workspace", "subagent"]),
	id: z.string().min(1).max(50),
});

export const moveRecentTabSchema = z.object({
	/** Tab key in "type:id" format */
	key: z.string().min(1).max(100),
	/** Target index (0-based), or a named position */
	toIndex: z.number().int().min(0).max(20).optional(),
	/** Named position — mutually exclusive with toIndex */
	position: z.enum(["top", "above_idle"]).optional(),
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
