import { PERSISTED_NARRATOR_TOOLBAR_IDS } from "@shared/narrator-toolbar";
import { PERSISTED_NAV_IDS } from "@shared/nav-layout";
import { TYPOGRAPHY_RANGE } from "@shared/pretext-layout/typography";
import {
	RECENT_TABS_LIVE_LIMIT,
	RECENT_TABS_PAGE_SIZE,
	RECENT_TABS_STORAGE_LIMIT,
	RECENT_TABS_WS_BATCH_SIZE,
} from "@shared/recent-tabs";
import { z } from "zod";
import { legacyPermissionModeSchema } from "../permission-modes";
import { commandSchema, localeSchema } from "./common";

/** Repair only the configured directory, after explicit administrator confirmation. */
export const dataDirectoryRepairSchema = z.object({ confirmed: z.literal(true) }).strict();

export const diskSafetySettingsSchema = z
	.object({
		mode: z.enum(["enforce", "warn", "off"]),
		warningFreeMb: z.number().min(0).max(1_000_000),
		warningFreePercent: z.number().min(0).max(100),
		blockFreeMb: z.number().min(0).max(1_000_000),
		criticalFreeMb: z.number().min(0).max(1_000_000),
		reserveMb: z.number().min(0).max(1_000_000),
		checkIntervalMs: z.number().int().min(1000).max(300_000),
		pathCacheTtlMs: z.number().int().min(1000).max(600_000),
		probeTimeoutMs: z.number().int().min(50).max(2000),
	})
	.partial();

export const defaultNarratorVisibilitySchema = z.enum(["auto", "private", "public"]);
export const defaultNarratorWriteAudienceSchema = z.enum(["auto", "owner", "project", "public"]);

/**
 * One model card delta, as persisted in `agent.modelCards`.
 *
 * Every field except `modelKey` is optional, because a stored entry is the
 * DIFFERENCE from the builtin card, not a whole card: absence means "inherit".
 *
 * `effortLevels` excludes `none` at the schema level rather than silently
 * dropping it later. `none` means "reasoning off", and storing it would make it
 * a clamp target — a requested `low` on a model whose lowest real tier is
 * `medium` could then clamp to thinking being switched off, with nothing said.
 * Rejecting it tells the caller instead of quietly changing behaviour.
 *
 * Prices are capped well above any published rate: the bound exists to reject
 * a stray unit error (a per-1k price typed into a per-1M field), not to predict
 * vendor pricing.
 */
const modelCardPricingSchema = z.object({
	input: z.number().min(0).max(100_000).optional(),
	output: z.number().min(0).max(100_000).optional(),
	cacheRead: z.number().min(0).max(100_000).optional(),
	cacheWrite: z.number().min(0).max(100_000).optional(),
});

export const modelCardSchema = z.object({
	modelKey: z.string().min(1).max(200),
	displayName: z.string().max(200).optional(),
	family: z.string().max(100).optional(),
	notes: z.string().max(2000).optional(),
	aliases: z.array(z.string().min(1).max(200)).max(50).optional(),
	matchPrefixes: z.array(z.string().min(1).max(200)).max(50).optional(),
	// 0 is accepted and means "not set" — the card editor's default for a field
	// the user is not filling in.
	contextWindow: z.number().int().min(0).max(100_000_000).optional(),
	maxCompletionTokens: z.number().int().min(0).max(100_000_000).optional(),
	effortLevels: z
		.array(z.enum(["low", "medium", "high", "xhigh", "max"]))
		.max(10)
		.optional(),
	officialPricing: modelCardPricingSchema.optional(),
	/** Tombstone marking a builtin card the user deleted. */
	deleted: z.boolean().optional(),
});

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
				// Sourced from @shared/nav-layout so this list cannot drift behind the
				// frontend registry (a missing id makes the layout unsavable).
				id: z.enum(PERSISTED_NAV_IDS),
				// Legacy optional flag — position relative to the divider is authoritative.
				hidden: z.boolean().optional(),
			}),
		)
		.max(20),
});

/**
 * Narrator header toolbar layout: same flat-list-plus-divider shape as
 * `navLayoutSchema`, and sourced from @shared/narrator-toolbar for the same
 * anti-drift reason — an id the frontend renders but this enum rejects makes the
 * whole layout unsavable, and the failure surfaces only as "my customization did
 * not stick".
 */
const narratorToolbarLayoutSchema = z.object({
	items: z
		.array(
			z.object({
				// Accept only this retired id from older clients, then remove it.
				id: z.enum([...PERSISTED_NARRATOR_TOOLBAR_IDS, "filemod"]),
			}),
		)
		.max(30)
		.transform((items) => items.filter((item) => item.id !== "filemod")),
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
	// Narrator transcript typography (percentages). Bounds are taken FROM the shared
	// range table rather than restated, so the validator and the clamp that protects
	// the height model cannot drift apart — a mismatch here would let the API accept a
	// value the renderer then silently clamps, so the saved setting and the visible
	// result would disagree with no error.
	narratorFontScalePercent: z
		.number()
		.int()
		.min(TYPOGRAPHY_RANGE.fontScalePercent.min)
		.max(TYPOGRAPHY_RANGE.fontScalePercent.max)
		.optional(),
	narratorLetterSpacingPercent: z
		.number()
		.int()
		.min(TYPOGRAPHY_RANGE.letterSpacingPercent.min)
		.max(TYPOGRAPHY_RANGE.letterSpacingPercent.max)
		.optional(),
	narratorLineHeightScalePercent: z
		.number()
		.int()
		.min(TYPOGRAPHY_RANGE.lineHeightScalePercent.min)
		.max(TYPOGRAPHY_RANGE.lineHeightScalePercent.max)
		.optional(),
	narratorParagraphScalePercent: z
		.number()
		.int()
		.min(TYPOGRAPHY_RANGE.paragraphScalePercent.min)
		.max(TYPOGRAPHY_RANGE.paragraphScalePercent.max)
		.optional(),
	treatAsLocalAccess: z.boolean().optional(),
	addSubagentToRecentTabs: z.boolean().optional(),
	recentTabsGroupMode: z.enum(["flat", "directory"]).optional(),
	// Notification preferences
	notifyOnDone: z.boolean().optional(),
	notifyOnWaiting: z.boolean().optional(),
	notifyPwaEnabled: z.boolean().optional(),
	notifySoundEnabled: z.boolean().optional(),
	notifySoundType: z.enum(["builtin", "custom"]).optional(),
	notifySoundBuiltin: z.string().max(50).optional(),
	notifySoundFileId: z.string().max(50).nullable().optional(),
	notifySoundVolume: z.number().int().min(0).max(100).optional(),
	notifySoundMaxConcurrent: z.number().int().min(1).max(10).optional(),
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
	// Narrator header toolbar layout: order = priority, position vs divider = surfaced or tucked
	narratorToolbarLayout: narratorToolbarLayoutSchema.optional(),
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
	/**
	 * Hand-arranged position inside a directory group.
	 *
	 * Accepted so an undo-restore can carry it back: the client already sends it
	 * (`toPersistedRecentTab`) and the service already honours it
	 * (`dirSortOrderFor`), but Zod strips unknown keys — so the snapshot path
	 * silently flattened every hand-arranged group back to recency order, which is
	 * exactly what the client-side comment promised it would not do.
	 *
	 * Bounded by the same limit as the reorder endpoint's key list: a position is an
	 * index into one group's members, which cannot exceed the stored tab count.
	 */
	dirSortOrder: z.number().int().min(0).max(RECENT_TABS_STORAGE_LIMIT).optional(),
});

export const upsertRecentTabSchema = recentTabSchema
	.extend({
		/** When true, only update an existing tab — skip if not already present. */
		updateOnly: z.boolean().optional(),
		/**
		 * Where to place the tab, for a drop that both creates and positions it.
		 *
		 * Without these, "drag a narrator into the sidebar at this spot" needs an upsert
		 * followed by a move: two revisions, and between them the tab is visible at the
		 * default insertion point before jumping to where it was aimed. The delta's upsert
		 * operation already carries these anchors and clients already honour them, so the
		 * whole gesture fits in one revision.
		 *
		 * An anchor that no longer exists is ignored rather than rejected (the client's
		 * view can lag a removal); see `applyRecentTabUpsert`.
		 */
		beforeKey: z.string().min(1).max(100).optional(),
		afterKey: z.string().min(1).max(100).optional(),
	})
	.superRefine((value, ctx) => {
		if (value.beforeKey !== undefined && value.afterKey !== undefined) {
			ctx.addIssue({
				code: "custom",
				message: "Only one of beforeKey or afterKey may be given",
			});
		}
	});

export const batchUpsertRecentTabsSchema = z.object({
	tabs: z.array(upsertRecentTabSchema).min(1).max(RECENT_TABS_WS_BATCH_SIZE),
});

export const removeRecentTabSchema = z.object({
	type: z.enum(["chapter", "narrator", "session", "project", "workspace", "subagent", "group"]),
	id: z.string().min(1).max(50),
	/**
	 * Entity-teardown cleanup (chapter deleted, narrator archived). When set, no undo
	 * token is minted — a cascade must not overwrite the user's pending undo slot with
	 * a snapshot that points at entities that are already gone.
	 */
	cascade: z.boolean().optional(),
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

/**
 * Member order for ONE directory group in the sidebar's aggregated view.
 *
 * Only `dir_sort_order` is written; the flat order is untouched (see
 * `setRecentTabDirectoryOrder`). Bounded by the storage limit because a group cannot
 * contain more members than the user has tabs.
 */
export const setRecentTabDirectoryOrderSchema = z.object({
	/** Tab keys ("type:id") in the desired top-to-bottom order. */
	keys: z.array(z.string().min(1).max(100)).min(1).max(RECENT_TABS_STORAGE_LIMIT),
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
