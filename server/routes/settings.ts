import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { Hono } from "hono";
import { z } from "zod";
import { agentGenerateWithMeta } from "../lib/agent";
import { resolveProviderAndModel } from "../lib/agent/provider";
import { getCodexManager } from "../lib/codex-manager";
import { ValidationError } from "../lib/errors";
import { logger } from "../lib/logger";
import { scheduleServerRestart } from "../lib/server-restart";
import {
	getBuiltinCodexModels,
	getContextThresholds,
	type NarraForkSettings,
	purgeStaleAgentModelRefs,
	saveSettings,
	settings,
} from "../lib/settings";
import {
	blacklistDirEntrySchema,
	commandBlacklistEntrySchema,
	commandWhitelistEntrySchema,
	whitelistDirEntrySchema,
} from "../lib/validators";
import { ensureContainerProxyRuntime } from "../services/container-proxy";
import { getAnthropicCachedModelsGrouped, purgeAnthropicProviderCache } from "./anthropic";
import { getClineEnabledModelsGrouped, purgeClineProviderCache } from "./cline";
import {
	getOpenaiCachedModels,
	getOpenaiCachedModelsGrouped,
	purgeOpenaiProviderCache,
} from "./openai";

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
	officialApi: z.boolean().optional(),
});

	id: z.string().min(1),
	name: z.string(),
	prefix: z.string().min(1),
	apiKey: z.string(),
	baseUrl: z.string(),
	defaultModel: z.string(),
});

const clineProviderSchema = z.object({
	id: z.string().min(1),
	name: z.string(),
	prefix: z.string().min(1),
	baseUrl: z.string(),
	accessToken: z.string().optional(),
	defaultModel: z.string(),
	defaultContextWindow: z.number().int().min(1).optional(),
});

/** Only non-sensitive, user-editable fields are allowed. auth.jwtSecret is excluded. */
const updateSettingsSchema = z
	.object({
		server: z
			.object({
				port: z.number().int().min(1).max(65535),
				host: z.string().min(1).max(255),
				openBrowser: z.enum(["off", "browser", "app"]),
				tls: z
					.object({
						enabled: z.boolean(),
						certFile: z.string(),
						keyFile: z.string(),
						passphrase: z.string().optional(),
						caFile: z.string().optional(),
					})
					.optional(),
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
				subagentAllowedModels: z
					.object({
						explore: z.array(z.string()),
						plan: z.array(z.string()),
						general: z.array(z.string()),
					})
					.partial(),
				legacyEncoding: z.boolean(),
				translateReasoning: z.boolean(),
				defaultRelaxedPlan: z.boolean(),
				smartInterruptionCheck: z.boolean(),
				maxTransientRetries: z.number().int().min(-1).max(100),
				modelContextWindows: z.record(z.string(), z.number().int().min(1)),
				whitelistDirs: z.array(whitelistDirEntrySchema).max(50),
				blacklistDirs: z.array(blacklistDirEntrySchema).max(50),
				commandWhitelist: z.array(commandWhitelistEntrySchema).max(50),
				commandBlacklist: z.array(commandBlacklistEntrySchema).max(50),
				contextThresholds: z
					.object({
						standard: z.object({
							pruneStart: z.number().min(50).max(100),
							compactStart: z.number().min(50).max(100),
						}),
						large: z.object({
							pruneStart: z.number().min(10).max(100),
							compactStart: z.number().min(10).max(100),
						}),
					})
					.optional(),
				webFetchPolicy: z
					.object({
						allowAll: z.boolean().optional(),
						whitelist: z
							.array(
								z.object({
									pattern: z.string(),
									enabled: z.boolean().optional(),
								}),
							)
							.optional(),
						blacklist: z
							.array(
								z.object({
									pattern: z.string(),
									enabled: z.boolean().optional(),
								}),
							)
							.optional(),
						proxy: z
							.object({
								mode: z.enum(["direct", "system", "custom"]),
								url: z
									.string()
									.regex(/^(https?|socks[45]?):\/\//)
									.optional(),
							})
							.optional(),
					})
					.optional(),
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
		clineProviders: z.array(clineProviderSchema).optional(),
		codex: z
			.object({
				proxy: z.string().optional(),
				loadBalancingMode: z.enum(["priority", "balanced"]).optional(),
				defaultReasoningEffort: z
					.enum(["none", "low", "medium", "high", "xhigh"])
					.nullable()
					.optional(),
			})
			.partial()
			.optional(),
		routines: z
			.object({
				disabledRoutines: z.array(z.string()),
			})
			.partial()
			.optional(),
		update: z
			.object({
				serverUrl: z.string().url().optional(),
				product: z.string().min(1).optional(),
				channel: z.enum(["stable", "beta"]).optional(),
				checkIntervalMinutes: z.number().int().min(0).optional(),
				autoDownload: z.boolean().optional(),
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

/** Return IDs present in `oldList` but absent from `newList`. */
function getRemovedProviderIds(
	oldList: { id: string }[] | undefined,
	newList: { id: string }[] | undefined,
): string[] {
	const newIds = new Set((newList ?? []).map((p) => p.id));
	return (oldList ?? []).filter((p) => !newIds.has(p.id)).map((p) => p.id);
}

/**
 * After settings are saved, detect providers that were removed and purge their
 * in-memory + on-disk model caches so no stale data lingers.
 */
function purgeRemovedProviderCaches(prev: NarraForkSettings, next: NarraForkSettings): void {
	const purges: Array<{ type: string; ids: string[]; fn: (ids: string[]) => void }> = [
		{
			type: "openai",
			ids: getRemovedProviderIds(prev.openaiProviders, next.openaiProviders),
			fn: purgeOpenaiProviderCache,
		},
		{
			type: "anthropic",
			ids: getRemovedProviderIds(prev.anthropicProviders, next.anthropicProviders),
			fn: purgeAnthropicProviderCache,
		},
		{
		},
		{
			type: "cline",
			ids: getRemovedProviderIds(prev.clineProviders, next.clineProviders),
			fn: purgeClineProviderCache,
		},
	];

	for (const { type, ids, fn } of purges) {
		if (ids.length) {
			fn(ids);
			logger.info("Purged provider model cache", { type, removedIds: ids });
		}
	}

	// Collect prefixes of removed providers — needed to purge agent-level fields
	// (summaryModel, hiddenModels, modelContextWindows) that reference stale models.
	const removedPrefixes = new Set<string>();
	for (const { ids } of purges) {
		if (!ids.length) continue;
		const idSet = new Set(ids);
		for (const prov of [
			prev.openaiProviders,
			prev.anthropicProviders,
			prev.clineProviders,
		]) {
			for (const p of prov ?? []) {
				if (idSet.has(p.id)) removedPrefixes.add(p.prefix ?? "");
			}
		}
	}
	// Don't purge empty-prefix entries (would match everything)
	removedPrefixes.delete("");
	if (removedPrefixes.size === 0) return;

	if (purgeStaleAgentModelRefs(next, (prefix) => removedPrefixes.has(prefix))) {
		saveSettings(next);
		logger.info("Purged stale agent references to removed providers", {
			prefixes: [...removedPrefixes],
		});
	}
}

settingsRoutes.get("/", (c) => {
	const s = settings;
	const codexManager = getCodexManager();
	const codexSnapshot = codexManager.snapshot();
	const result = {
		...s,
		// Mask TLS passphrase
		server: {
			...s.server,
			tls: s.server.tls
				? { ...s.server.tls, passphrase: s.server.tls.passphrase ? "********" : undefined }
				: undefined,
		},
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
		clineProviders: (s.clineProviders ?? []).map((p) => ({
			...p,
			accessToken: p.accessToken ? maskApiKey(p.accessToken) : "",
		})),
		openaiModels: getOpenaiCachedModels(),
		openaiModelsGrouped: getOpenaiCachedModelsGrouped(),
		anthropicModelsGrouped: getAnthropicCachedModelsGrouped(),
		clineModelsGrouped: getClineEnabledModelsGrouped(),
		codexAvailable: codexSnapshot.available > 0,
		codexModels: getBuiltinCodexModels(),
		lanAddresses: getLanAddresses(),
		summaryModelAvailable: checkSummaryModelAvailable(s.agent.summaryModel),
	};
	return c.json(result);
});

settingsRoutes.get("/context-thresholds", (c) => {
	const model = c.req.query("model") ?? "";
	const provider = c.req.query("provider") ?? "";
	const thresholds = getContextThresholds(model, provider);
	return c.json(thresholds);
});

// --- Test model endpoint ---

const testModelSchema = z.object({
	model: z.string().min(1),
	prompt: z.string().min(1).max(10000),
});

settingsRoutes.post("/test-model", async (c) => {
	const body = await c.req.json();
	const parsed = testModelSchema.safeParse(body);
	if (!parsed.success) {
		throw new ValidationError(parsed.error.issues.map((i) => i.message).join(", "));
	}
	const { model, prompt } = parsed.data;

	// Validate that the provider/model can be resolved
	try {
		resolveProviderAndModel(model);
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : "Unknown provider or model" }, 400);
	}

	try {
		const result = await agentGenerateWithMeta(prompt, model);
		return c.json({ text: result.text });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.warn("Model test failed", { model, error: message });
		return c.json({ error: message }, 502);
	}
});

settingsRoutes.patch("/", async (c) => {
	const body = await c.req.json();
	const parsed = updateSettingsSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const current = settings;
	const validated = parsed.data;

	// Validate provider prefix conflicts — reserved prefixes and cross-provider duplicates
	{
		const allPrefixes: Array<{ prefix: string; source: string }> = [];
		for (const p of validated.openaiProviders ?? current.openaiProviders ?? []) {
			if (p.prefix) allPrefixes.push({ prefix: p.prefix, source: `OpenAI "${p.name || p.id}"` });
		}
		for (const p of validated.anthropicProviders ?? current.anthropicProviders ?? []) {
			if (p.prefix) allPrefixes.push({ prefix: p.prefix, source: `Anthropic "${p.name || p.id}"` });
		}
		}
		for (const p of validated.clineProviders ?? current.clineProviders ?? []) {
			if (p.prefix) allPrefixes.push({ prefix: p.prefix, source: `Cline "${p.name || p.id}"` });
		}
		// Check reserved prefix conflicts
		for (const { prefix, source } of allPrefixes) {
			if (RESERVED_PREFIXES.has(prefix)) {
				throw new ValidationError(
					`Provider prefix "${prefix}" is reserved (built-in provider). ` +
						`Please choose a different prefix for ${source}.`,
				);
			}
		}
		// Check cross-provider duplicate prefixes
		const seen = new Map<string, string>();
		for (const { prefix, source } of allPrefixes) {
			const existing = seen.get(prefix);
			if (existing) {
				throw new ValidationError(
					`Duplicate provider prefix "${prefix}" found in ${existing} and ${source}. ` +
						`Each provider must have a unique prefix.`,
				);
			}
			seen.set(prefix, source);
		}
	}

	const oldProxyEnabled = current.containers.proxy.enabled;
	const oldProxyPort = current.containers.proxy.port;
	const oldHost = current.server.host;
	const oldPort = current.server.port;
	const oldTls = current.server.tls;

	// Normalize nullable codex defaultReasoningEffort to undefined for settings storage.
	if (validated.codex?.defaultReasoningEffort === null) {
		validated.codex.defaultReasoningEffort = undefined;
	}

	// Preserve TLS passphrase if masked or empty (don't overwrite with placeholder)
	if (validated.server?.tls) {
		if (!validated.server.tls.passphrase || validated.server.tls.passphrase === "********") {
			validated.server.tls.passphrase = oldTls?.passphrase;
		}
	}

	// Validate TLS cert/key files exist when enabling TLS
	if (validated.server?.tls?.enabled) {
		const { certFile, keyFile } = validated.server.tls;
		if (!certFile || !existsSync(certFile)) {
			throw new ValidationError(`TLS certificate file not found: ${certFile || "(empty)"}`);
		}
		if (!keyFile || !existsSync(keyFile)) {
			throw new ValidationError(`TLS private key file not found: ${keyFile || "(empty)"}`);
		}
		if (validated.server.tls.caFile && !existsSync(validated.server.tls.caFile)) {
			throw new ValidationError(
				`TLS CA certificate file not found: ${validated.server.tls.caFile}`,
			);
		}
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

	// Preserve real access tokens for Cline providers
	if (validated.clineProviders) {
		const currentProviders = current.clineProviders ?? [];
		for (const p of validated.clineProviders) {
			if (p.accessToken?.startsWith("*")) {
				const existing = currentProviders.find((cp) => cp.id === p.id);
				p.accessToken = existing?.accessToken ?? "";
			}
		}
	}

	// Deep merge: iterate top-level keys
	const merged = { ...current } as NarraForkSettings;
	for (const key of Object.keys(validated) as Array<keyof typeof validated>) {
		const val = validated[key];
		if (
			key === "openaiProviders" ||
			key === "anthropicProviders" ||
			key === "clineProviders"
		) {
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

	// Purge model caches for removed providers BEFORE saving,
	// because saveSettings() mutates `settings` in-place (via _cache.current),
	// which would make `current` and `merged` identical and prevent detection.
	purgeRemovedProviderCaches(current, merged);

	saveSettings(merged);

	// Detect host/port/TLS changes and schedule a server restart
	const newHost = merged.server.host;
	const newPort = merged.server.port;
	const newTls = merged.server.tls;
	const serverAddressChanged = newHost !== oldHost || newPort !== oldPort;
	const tlsChanged = JSON.stringify(oldTls) !== JSON.stringify(newTls);
	const needsRestart = serverAddressChanged || tlsChanged;

	if (needsRestart) {
		scheduleServerRestart(newHost, newPort);
	}

	const newProtocol = newTls?.enabled ? "https" : "http";

	// Mask sensitive fields before returning (same logic as GET)
	const result = {
		...merged,
		// Mask TLS passphrase
		server: {
			...merged.server,
			tls: merged.server.tls
				? {
						...merged.server.tls,
						passphrase: merged.server.tls.passphrase ? "********" : undefined,
					}
				: undefined,
		},
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
		clineProviders: (merged.clineProviders ?? []).map((p) => ({
			...p,
			accessToken: p.accessToken ? maskApiKey(p.accessToken) : "",
		})),
		// Signal to the frontend that the server is restarting at a new address
		...(needsRestart && {
			serverRestarting: true,
			newUrl: `${newProtocol}://${newHost === "0.0.0.0" ? "localhost" : newHost}:${newPort}`,
		}),
	};
	return c.json(result);
});
