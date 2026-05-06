/**
 * Gateway configuration loader.
 *
 * Reads from the database (user_preferences.gateway_config of the admin user)
 * and merges with environment variables. Environment variables take precedence.
 */

import { eq } from "drizzle-orm";
import { db } from "../db";
import { userPreferences, users } from "../db/schema";
import { logger } from "../lib/logger";
import { normalizeLegacyPermissionMode } from "../lib/permission-modes";
import type {
	DiscordConfig,
	FeishuConfig,
	GatewayConfig,
	PlatformConfigUnion,
	QQBotConfig,
	SlackConfig,
	TelegramConfig,
	WebhookConfig,
	WeixinConfig,
} from "./types";

function parseCommaSeparated(value: string | undefined): string[] | undefined {
	if (!value) return undefined;
	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * Load gateway config from the database.
 * Uses the admin user's preferences (or the first user if no admin).
 */
async function loadDbConfig(): Promise<Partial<GatewayConfig>> {
	try {
		// Find admin user (or first user)
		const allUsers = await db
			.select({ id: users.id, role: users.role })
			.from(users)
			.orderBy(users.createdAt)
			.limit(5);
		if (allUsers.length === 0) return {};

		const admin = allUsers.find((u) => u.role === "admin");
		const userId = admin?.id ?? allUsers[0].id;

		const pref = await db.query.userPreferences.findFirst({
			where: eq(userPreferences.userId, userId),
			columns: { gatewayConfig: true },
		});
		if (!pref?.gatewayConfig) return {};

		const parsed = JSON.parse(typeof pref.gatewayConfig === "string" ? pref.gatewayConfig : "{}");
		return parsed as Partial<GatewayConfig>;
	} catch (err) {
		logger.warn("[gateway] Failed to load config from database", {
			error: err instanceof Error ? err.message : String(err),
		});
		return {};
	}
}

function buildTelegramConfig(): TelegramConfig | null {
	const token = process.env.TELEGRAM_BOT_TOKEN;
	if (!token) return null;
	return {
		platform: "telegram",
		enabled: true,
		token,
		allowedUsers: parseCommaSeparated(process.env.TELEGRAM_ALLOWED_USERS),
	};
}

function buildDiscordConfig(): DiscordConfig | null {
	const token = process.env.DISCORD_BOT_TOKEN;
	if (!token) return null;
	return {
		platform: "discord",
		enabled: true,
		token,
		allowedUsers: parseCommaSeparated(process.env.DISCORD_ALLOWED_USERS),
	};
}

function buildSlackConfig(): SlackConfig | null {
	const botToken = process.env.SLACK_BOT_TOKEN;
	const appToken = process.env.SLACK_APP_TOKEN;
	if (!botToken || !appToken) return null;
	return {
		platform: "slack",
		enabled: true,
		botToken,
		appToken,
		allowedUsers: parseCommaSeparated(process.env.SLACK_ALLOWED_USERS),
	};
}

function buildFeishuConfig(): FeishuConfig | null {
	const appId = process.env.FEISHU_APP_ID;
	const appSecret = process.env.FEISHU_APP_SECRET;
	if (!appId || !appSecret) return null;
	return {
		platform: "feishu",
		enabled: true,
		appId,
		appSecret,
		allowedUsers: parseCommaSeparated(process.env.FEISHU_ALLOWED_USERS),
	};
}

function buildWebhookConfig(): WebhookConfig | null {
	const secret = process.env.GATEWAY_WEBHOOK_SECRET;
	if (!secret) return null;
	return {
		platform: "webhook",
		enabled: true,
		secret,
		port: process.env.GATEWAY_WEBHOOK_PORT ? Number(process.env.GATEWAY_WEBHOOK_PORT) : undefined,
	};
}

function buildWeixinConfig(): WeixinConfig | null {
	const token = process.env.WEIXIN_TOKEN;
	const accountId = process.env.WEIXIN_ACCOUNT_ID;
	if (!token || !accountId) return null;
	return {
		platform: "weixin",
		enabled: true,
		token,
		accountId,
		baseUrl: process.env.WEIXIN_BASE_URL,
		cdnBaseUrl: process.env.WEIXIN_CDN_BASE_URL,
		allowedUsers: parseCommaSeparated(process.env.WEIXIN_ALLOWED_USERS),
		sendChunkDelay: process.env.WEIXIN_SEND_CHUNK_DELAY
			? Number(process.env.WEIXIN_SEND_CHUNK_DELAY)
			: undefined,
		sendChunkRetries: process.env.WEIXIN_SEND_CHUNK_RETRIES
			? Number(process.env.WEIXIN_SEND_CHUNK_RETRIES)
			: undefined,
	};
}

function buildQQBotConfig(): QQBotConfig | null {
	const appId = process.env.QQ_APP_ID;
	const clientSecret = process.env.QQ_CLIENT_SECRET;
	if (!appId || !clientSecret) return null;

	const sttApiKey = process.env.QQ_STT_API_KEY;
	return {
		platform: "qqbot",
		enabled: true,
		appId,
		clientSecret,
		allowedUsers: parseCommaSeparated(process.env.QQ_ALLOWED_USERS),
		allowedGroups: parseCommaSeparated(process.env.QQ_ALLOWED_GROUPS),
		dmPolicy: process.env.QQ_DM_POLICY,
		groupPolicy: process.env.QQ_GROUP_POLICY,
		markdownSupport: process.env.QQ_MARKDOWN_SUPPORT === "true",
		sandbox: process.env.QQ_SANDBOX === "true",
		stt: sttApiKey
			? {
					apiKey: sttApiKey,
					baseUrl: process.env.QQ_STT_BASE_URL,
					model: process.env.QQ_STT_MODEL,
				}
			: undefined,
	};
}

/**
 * Load the full gateway configuration by merging database config with env vars.
 * Env vars always win.
 */
export async function loadGatewayConfig(): Promise<GatewayConfig> {
	const dbCfg = await loadDbConfig();

	// Build platform configs from env vars
	const envPlatforms: PlatformConfigUnion[] = [];
	const tg = buildTelegramConfig();
	if (tg) envPlatforms.push(tg);
	const dc = buildDiscordConfig();
	if (dc) envPlatforms.push(dc);
	const sl = buildSlackConfig();
	if (sl) envPlatforms.push(sl);
	const fs = buildFeishuConfig();
	if (fs) envPlatforms.push(fs);
	const wh = buildWebhookConfig();
	if (wh) envPlatforms.push(wh);
	const wx = buildWeixinConfig();
	if (wx) envPlatforms.push(wx);
	const qq = buildQQBotConfig();
	if (qq) envPlatforms.push(qq);

	// Merge: env platforms override db platforms by platform key
	const dbPlatforms = (dbCfg.platforms ?? []) as PlatformConfigUnion[];
	const envKeys = new Set(envPlatforms.map((p) => p.platform));
	const merged = [...envPlatforms, ...dbPlatforms.filter((p) => !envKeys.has(p.platform))];

	const enabled =
		process.env.GATEWAY_ENABLED !== undefined
			? process.env.GATEWAY_ENABLED === "true"
			: (dbCfg.enabled ?? merged.some((p) => p.enabled));

	const sessionIdleMinutesEnv = process.env.GATEWAY_SESSION_IDLE_MINUTES;
	const rateLimitEnv = process.env.GATEWAY_RATE_LIMIT_PER_MINUTE;
	const streamingEnv = process.env.GATEWAY_STREAMING;

	const rawDefaultPermissionMode =
		process.env.GATEWAY_DEFAULT_PERMISSION_MODE ?? dbCfg.defaultPermissionMode;
	const defaultPermissionMode: GatewayConfig["defaultPermissionMode"] =
		normalizeLegacyPermissionMode(rawDefaultPermissionMode, "bypassPermissions");

	return {
		enabled,
		defaultProjectId: process.env.GATEWAY_DEFAULT_PROJECT_ID ?? dbCfg.defaultProjectId,
		defaultChapterId: process.env.GATEWAY_DEFAULT_CHAPTER_ID ?? dbCfg.defaultChapterId,
		defaultPermissionMode,
		sessionIdleMinutes: sessionIdleMinutesEnv
			? Number(sessionIdleMinutesEnv)
			: (dbCfg.sessionIdleMinutes ?? 0),
		rateLimitPerMinute: rateLimitEnv ? Number(rateLimitEnv) : (dbCfg.rateLimitPerMinute ?? 20),
		streaming: streamingEnv !== undefined ? streamingEnv === "true" : (dbCfg.streaming ?? true),
		platforms: merged,
	};
}
