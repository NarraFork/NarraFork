import { networkInterfaces } from "node:os";
import { Hono } from "hono";
import { z } from "zod";
import { resolveProviderAndModel } from "../lib/agent/provider";
import { getCodexManager } from "../lib/codex-manager";
import { ValidationError } from "../lib/errors";
import {
	getBuiltinCodexModels,
	loadSettings,
	type NarraForkSettings,
	saveSettings,
} from "../lib/settings";
import {
	blacklistDirEntrySchema,
	commandBlacklistEntrySchema,
	commandWhitelistEntrySchema,
	whitelistDirEntrySchema,
} from "../lib/validators";
import { ensureContainerProxyRuntime } from "../services/container-proxy";
import { getAnthropicCachedModelsGrouped } from "./anthropic";
import { getOpenaiCachedModels, getOpenaiCachedModelsGrouped } from "./openai";

const modelOptionSchema = z.object({
	value: z.string().min(1),
	label: z.string().min(1),
	provider: z.string().optional(),
});

const openaiProviderSchema = z.object({
	id: z.string().min(1),
	name: z.string(),
	prefix: z.string().min(1),
	apiKey: z.string(),
	baseUrl: z.string(),
	defaultModel: z.string(),
	responsesApi: z.boolean().optional(),
	apiMode: z.enum(["responses", "completions", "codex"]).optional(),
	codexAccountId: z.string().optional(),
});

const anthropicProviderSchema = z.object({
	id: z.string().min(1),
	name: z.string(),
	prefix: z.string().min(1),
	apiKey: z.string(),
	baseUrl: z.string(),
	defaultModel: z.string(),
	defaultReasoningEffort: z.enum(["none", "low", "medium", "high"]).nullable().optional(),
	proxy: z.string().optional(),
	tlsRejectUnauthorized: z.boolean().optional(),
});

	id: z.string().min(1),
	name: z.string(),
	prefix: z.string().min(1),
	apiKey: z.string(),
	baseUrl: z.string(),
	defaultModel: z.string(),
});

/** Only non-sensitive, user-editable fields are allowed. auth.jwtSecret is excluded. */
const updateSettingsSchema = z
	.object({
		server: z
			.object({
				port: z.number().int().min(1).max(65535),
				host: z.string().min(1).max(255),
				openBrowser: z.enum(["off", "browser", "app"]),
			})
			.partial()
			.optional(),
		paths: z
			.object({ defaultProjectDir: z.string().min(1) })
			.partial()
			.optional(),
		agent: z
			.object({
				defaultModel: z.string().min(1),
				defaultPermissionMode: z.string().min(1),
				summaryModel: z.string().min(1),
				customModels: z.array(modelOptionSchema),
				hiddenModels: z.array(z.string()),
				maxTurns: z.number().int().min(1).max(1000),
				subagentModels: z
					.object({
						explore: z.string(),
						plan: z.string(),
					})
					.partial(),
				legacyEncoding: z.boolean(),
				translateReasoning: z.boolean(),
				defaultRelaxedPlan: z.boolean(),
				smartInterruptionCheck: z.boolean(),
				modelContextWindows: z.record(z.string(), z.number().int().min(1)),
				whitelistDirs: z.array(whitelistDirEntrySchema).max(50),
				blacklistDirs: z.array(blacklistDirEntrySchema).max(50),
				commandWhitelist: z.array(commandWhitelistEntrySchema).max(50),
				commandBlacklist: z.array(commandBlacklistEntrySchema).max(50),
			})
			.partial()
			.optional(),
		chapters: z
			.object({
				maxActiveWorktrees: z.number().int().min(1),
				maxActiveContainers: z.number().int().min(0),
				worktreeSizeWarningMb: z.number().int().min(0),
				autoSaveOnDormant: z.boolean(),
				dormantAfterMinutes: z.number().int().min(0),
			})
			.partial()
			.optional(),
		containers: z
			.object({
				portRangeStart: z.number().int().min(1).max(65535),
				portRangeEnd: z.number().int().min(1).max(65535),
				proxy: z
					.object({
						enabled: z.boolean(),
						port: z.number().int().min(1).max(65535),
					})
					.partial()
					.optional(),
			})
			.partial()
			.optional(),
		editor: z
			.object({
				type: z.enum(["vscode", "cursor", "windsurf", "zed"]),
			})
			.partial()
			.optional(),
		auth: z
			.object({
				registrationOpen: z.boolean(),
			})
			.partial()
			.optional(),
		openaiProviders: z.array(openaiProviderSchema).optional(),
		anthropicProviders: z.array(anthropicProviderSchema).optional(),
		codex: z
			.object({
				proxy: z.string().optional(),
				loadBalancingMode: z.enum(["priority", "balanced"]).optional(),
				defaultReasoningEffort: z.enum(["none", "low", "medium", "high"]).nullable().optional(),
			})
			.partial()
			.optional(),
		routines: z
			.object({
				disabledRoutines: z.array(z.string()),
			})
			.partial()
			.optional(),
	})
	.strict();

export const settingsRoutes = new Hono();

/** Mask an API key for safe display (show last 4 chars). */
function maskApiKey(key?: string): string {
	if (!key) return "";
	if (key.length <= 4) return "*".repeat(key.length);
	return `${"*".repeat(8)}${key.slice(-4)}`;
}

/** Get RFC 1918 private IPv4 addresses from network interfaces. */
function getLanAddresses(): string[] {
	const nets = networkInterfaces();
	const result: string[] = [];
	for (const ifaces of Object.values(nets)) {
		for (const iface of ifaces ?? []) {
			if (iface.internal || iface.family !== "IPv4") continue;
			const a = iface.address;
			// RFC 1918: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
			if (a.startsWith("10.") || a.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(a)) {
				result.push(a);
			}
		}
	}
	return result;
}

/**
 * Check whether the configured summary model's provider is available.
 * Uses a lightweight check (no actual API call) — just verifies the provider
 * can be resolved and instantiated.
 */
function checkSummaryModelAvailable(summaryModel: string): boolean {
	if (!summaryModel) return false;
	try {
		resolveProviderAndModel(summaryModel);
		return true;
	} catch {
		return false;
	}
}

settingsRoutes.get("/", (c) => {
	const s = loadSettings();
	const codexManager = getCodexManager();
	const codexSnapshot = codexManager.snapshot();
	const result = {
		...s,
		auth: { ...s.auth, jwtSecret: undefined },
		// Multi-provider — mask all keys
		openaiProviders: (s.openaiProviders ?? []).map((p) => ({
			...p,
			apiKey: p.apiKey ? maskApiKey(p.apiKey) : "",
		})),
		anthropicProviders: (s.anthropicProviders ?? []).map((p) => ({
			...p,
			apiKey: p.apiKey ? maskApiKey(p.apiKey) : "",
		})),
			...p,
			apiKey: p.apiKey ? maskApiKey(p.apiKey) : "",
		})),
		openaiModels: getOpenaiCachedModels(),
		openaiModelsGrouped: getOpenaiCachedModelsGrouped(),
		anthropicModelsGrouped: getAnthropicCachedModelsGrouped(),
		codexAvailable: codexSnapshot.available > 0,
		codexModels: getBuiltinCodexModels(),
		lanAddresses: getLanAddresses(),
		summaryModelAvailable: checkSummaryModelAvailable(s.agent.summaryModel),
	};
	return c.json(result);
});

settingsRoutes.patch("/", async (c) => {
	const body = await c.req.json();
	const parsed = updateSettingsSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const current = loadSettings();
	const validated = parsed.data;
	const oldProxyEnabled = current.containers.proxy.enabled;
	const oldProxyPort = current.containers.proxy.port;

	// Normalize nullable codex defaultReasoningEffort to undefined for settings storage.
	if (validated.codex?.defaultReasoningEffort === null) {
		validated.codex.defaultReasoningEffort = undefined;
	}

	// Preserve real API keys for multi-provider
	if (validated.openaiProviders) {
		const currentProviders = current.openaiProviders ?? [];
		for (const p of validated.openaiProviders) {
			if (p.apiKey?.startsWith("*")) {
				const existing = currentProviders.find((cp) => cp.id === p.id);
				p.apiKey = existing?.apiKey ?? "";
			}
		}
	}

	// Preserve real API keys for Anthropic providers
	if (validated.anthropicProviders) {
		const currentProviders = current.anthropicProviders ?? [];
		for (const p of validated.anthropicProviders) {
			if (p.apiKey?.startsWith("*")) {
				const existing = currentProviders.find((cp) => cp.id === p.id);
				p.apiKey = existing?.apiKey ?? "";
			}
		}
	}

			if (p.apiKey?.startsWith("*")) {
				const existing = currentProviders.find((cp) => cp.id === p.id);
				p.apiKey = existing?.apiKey ?? "";
			}
		}
	}

	// Deep merge: iterate top-level keys
	const merged = { ...current } as NarraForkSettings;
	for (const key of Object.keys(validated) as Array<keyof typeof validated>) {
		const val = validated[key];
			// Array — replace entirely, don't merge
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			(merged as any)[key] = val;
		} else if (val && typeof val === "object" && !Array.isArray(val)) {
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			(merged as any)[key] = { ...(current as any)[key], ...val };
		} else {
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			(merged as any)[key] = val;
		}
	}

	// Apply container proxy runtime changes first, then persist settings.
	// This keeps persisted config and runtime state consistent if start/restart fails.
	const newProxyEnabled = merged.containers.proxy.enabled;
	const newProxyPort = merged.containers.proxy.port;
	if (oldProxyEnabled !== newProxyEnabled || oldProxyPort !== newProxyPort) {
		try {
			await ensureContainerProxyRuntime({
				enabled: newProxyEnabled,
				port: newProxyPort,
			});
		} catch (err) {
			throw new ValidationError(`Container proxy runtime update failed: ${String(err)}`);
		}
	}

	saveSettings(merged);

	// Mask sensitive fields before returning (same logic as GET)
	const result = {
		...merged,
		auth: { ...merged.auth, jwtSecret: undefined },
		openaiProviders: (merged.openaiProviders ?? []).map((p) => ({
			...p,
			apiKey: p.apiKey ? maskApiKey(p.apiKey) : "",
		})),
		anthropicProviders: (merged.anthropicProviders ?? []).map((p) => ({
			...p,
			apiKey: p.apiKey ? maskApiKey(p.apiKey) : "",
		})),
			...p,
			apiKey: p.apiKey ? maskApiKey(p.apiKey) : "",
		})),
	};
	return c.json(result);
});
