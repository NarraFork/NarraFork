/**
 * Gateway configuration loader.
 *
 * Reads from ~/.narrafork/gateway.json and merges with environment variables.
 * Environment variables take precedence.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { logger } from "../lib/logger";
import type {
	DiscordConfig,
	FeishuConfig,
	GatewayConfig,
	PlatformConfigUnion,
	SlackConfig,
	TelegramConfig,
	WebhookConfig,
} from "./types";

const NARRAFORK_HOME = process.env.NARRAFORK_HOME ?? join(homedir(), ".narrafork");
const CONFIG_PATH = join(NARRAFORK_HOME, "gateway.json");

function parseCommaSeparated(value: string | undefined): string[] | undefined {
	if (!value) return undefined;
	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

function loadFileConfig(): Partial<GatewayConfig> {
	if (!existsSync(CONFIG_PATH)) return {};
	try {
		const raw = readFileSync(CONFIG_PATH, "utf-8");
		return JSON.parse(raw) as Partial<GatewayConfig>;
	} catch (err) {
		logger.warn("Failed to parse gateway.json", {
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

/**
 * Load the full gateway configuration by merging file config with env vars.
 * Env vars always win.
 */
export function loadGatewayConfig(): GatewayConfig {
	const file = loadFileConfig();

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

	// Merge: env platforms override file platforms by platform key
	const filePlatforms = (file.platforms ?? []) as PlatformConfigUnion[];
	const envKeys = new Set(envPlatforms.map((p) => p.platform));
	const merged = [
		...envPlatforms,
		...filePlatforms.filter((p) => !envKeys.has(p.platform)),
	];

	const enabled =
		process.env.GATEWAY_ENABLED !== undefined
			? process.env.GATEWAY_ENABLED === "true"
			: file.enabled ?? merged.some((p) => p.enabled);

	return {
		enabled,
		defaultProjectId: process.env.GATEWAY_DEFAULT_PROJECT_ID ?? file.defaultProjectId,
		defaultChapterId: process.env.GATEWAY_DEFAULT_CHAPTER_ID ?? file.defaultChapterId,
		defaultPermissionMode:
			process.env.GATEWAY_DEFAULT_PERMISSION_MODE ?? file.defaultPermissionMode ?? "bypassPermissions",
		platforms: merged,
	};
}
