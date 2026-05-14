import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { Hono } from "hono";
import { z } from "zod";
import { agentGenerateWithMeta } from "../lib/agent";
import { resolveProviderAndModel } from "../lib/agent/provider";
import { getCodexManager } from "../lib/codex-manager";
import { ValidationError } from "../lib/errors";
import { generateShortId } from "../lib/id";
import { logger } from "../lib/logger";
import { getNugCachedModelsGrouped } from "../lib/nug-model-cache";
import { legacyPermissionModeSchema } from "../lib/permission-modes";
import { scheduleServerRestart } from "../lib/server-restart";
import {
	customApiProvidersToAnthropic,
	customApiProvidersToOpenAI,
	deriveCustomApiProvidersFromLegacy,
	getBuiltinCodexModels,
	getBuiltinModelContextWindows,
	getContextThresholds,
	isAnthropicCustomApiProtocol,
	isOpenAICustomApiProtocol,
	type NarraForkSettings,
	normalizeCustomApiProviderSettings,
	normalizeProxyUrl,
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
import { startVNetUdpRendezvous } from "../lib/vnet/udp-rendezvous";
import { ensureContainerProxyRuntime } from "../services/container-proxy";
import { closeVNetConnections } from "../websocket/vnet-ws";
import { getAnthropicCachedModelsGrouped, purgeAnthropicProviderCache } from "./anthropic";
import { getClineEnabledModelsGrouped, purgeClineProviderCache } from "./cline";
import { purgeNugProviderCache } from "./nug";
import {
	getOpenaiCachedModels,
	getOpenaiCachedModelsGrouped,
	purgeOpenaiProviderCache,
} from "./openai";

const modelOptionSchema = z.object({
	value: z.string().min(1),
	label: z.string().min(1),
	provider: z.string().optional(),
	channel: z.string().optional(),
	channelType: z.string().optional(),
});

const proxyUrlSchema = z.preprocess(
	(value) => (typeof value === "string" ? normalizeProxyUrl(value) : value),
	z.string().optional(),
);

const webFetchProxyUrlSchema = z.preprocess(
	(value) => (typeof value === "string" ? normalizeProxyUrl(value) : value),
	z
		.string()
		.regex(/^(https?|socks4|socks5h?):\/\//)
		.optional(),
);

const customApiProtocolSchema = z.enum([
	"anthropic-official",
	"anthropic-compatible",
	"codex-native",
	"responses-compatible",
	"completions-compatible",
]);

const customApiProviderSchema = z.object({
	id: z.string().min(1),
	name: z.string(),
	prefix: z.string().min(1),
	apiKey: z.string(),
	baseUrl: z.string(),
	defaultModel: z.string(),
	protocol: customApiProtocolSchema,
	defaultContextWindow: z.number().int().min(1).optional(),
	defaultReasoningEffort: z.enum(["none", "low", "medium", "high"]).nullable().optional(),
	proxy: proxyUrlSchema,
	tlsRejectUnauthorized: z.boolean().optional(),
	codexAccountId: z.string().optional(),
	codexWebSocket: z.boolean().optional(),
	disabled: z.boolean().optional(),
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
	codexWebSocket: z.boolean().optional(),
	defaultContextWindow: z.number().int().min(1).optional(),
	disabled: z.boolean().optional(),
});

const anthropicProviderSchema = z.object({
	id: z.string().min(1),
	name: z.string(),
	prefix: z.string().min(1),
	apiKey: z.string(),
	baseUrl: z.string(),
	defaultModel: z.string(),
	defaultReasoningEffort: z.enum(["none", "low", "medium", "high"]).nullable().optional(),
	proxy: proxyUrlSchema,
	tlsRejectUnauthorized: z.boolean().optional(),
	officialApi: z.boolean().optional(),
	disabled: z.boolean().optional(),
});

	id: z.string().min(1),
	name: z.string(),
	prefix: z.string().min(1),
	apiKey: z.string(),
	baseUrl: z.string(),
	defaultModel: z.string(),
	disabled: z.boolean().optional(),
});

const nugProviderSchema = z.object({
	id: z.string().min(1),
	name: z.string(),
	prefix: z.string().min(1),
	apiKey: z.string(),
	baseUrl: z.string(),
	defaultModel: z.string(),
	nugUsername: z.string().optional(),
	nugUserId: z.string().optional(),
	oauthClientId: z.string().optional(),
	oauthClientSecret: z.string().optional(),
	oauthDeviceId: z.string().optional(),
	oauthCallbackUrl: z.string().optional(),
	disabled: z.boolean().optional(),
});

const clineProviderSchema = z.object({
	id: z.string().min(1),
	name: z.string(),
	prefix: z.string().min(1),
	baseUrl: z.string(),
	accessToken: z.string().optional(),
	defaultModel: z.string(),
	defaultContextWindow: z.number().int().min(1).optional(),
	enabledModels: z.array(z.string()).optional(),
	disabled: z.boolean().optional(),
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
				defaultPermissionMode: legacyPermissionModeSchema,
				defaultStartInPlanMode: z.boolean(),
				summaryModel: z.string(),
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
				freshShellEnv: z.boolean(),
				translateReasoning: z.boolean(),
				requestDumpEnabled: z.boolean(),
				requestDumpErrorsOnly: z.boolean(),
				defaultRelaxedPlan: z.boolean(),
				planReflectionAutoApprove: z.boolean(),
				dangerReflectionEnabled: z.boolean(),
				dangerSkipReadOnlyConfirmations: z.boolean(),
				defaultReasoningEffort: z.enum(["none", "low", "medium", "high", "xhigh"]).optional(),
				maxTransientRetries: z.number().int().min(-1).max(100),
				silentToolCallThreshold: z.number().int().min(-1).max(1000),
				retryBackoffCeilMs: z.number().int().min(1000).max(300000),
				firstTokenTimeoutMs: z.number().int().min(0).max(600000),
				customRetryRules: z
					.array(
						z.object({
							id: z.string().min(1),
							domain: z.string().optional(),
							statusCode: z.number().int().min(100).max(599).optional(),
							keyword: z.string().optional(),
							enabled: z.boolean().optional(),
							note: z.string().max(200).optional(),
						}),
					)
					.max(100)
					.optional(),
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
				autoCompactKeepPairs: z.number().int().min(1).max(25).optional(),
				autoCompactPruneThreshold: z.number().int().min(0).max(100).optional(),
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
								url: webFetchProxyUrlSchema,
							})
							.optional(),
					})
					.optional(),
				defaultSystemPrompt: z.string().max(50000).optional(),
				modelAggregations: z
					.array(
						z.object({
							id: z.string().min(1).max(20),
							name: z.string().min(1).max(100),
							models: z.array(z.string().min(1)).min(1).max(20),
							routingMode: z.enum(["priority", "balanced"]),
						}),
					)
					.max(50)
					.optional(),
				providerOrder: z.array(z.string()).max(50).optional(),
				disabledProviders: z.array(z.string()).max(200).optional(),
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
		customApiProviders: z.array(customApiProviderSchema).optional(),
		openaiProviders: z.array(openaiProviderSchema).optional(),
		anthropicProviders: z.array(anthropicProviderSchema).optional(),
		nugProviders: z.array(nugProviderSchema).optional(),
		clineProviders: z.array(clineProviderSchema).optional(),
		codex: z
			.object({
				proxy: proxyUrlSchema,
				loadBalancingMode: z.enum(["priority", "balanced", "tier-balanced"]).optional(),
				tierOrder: z
					.array(z.enum(["free", "plus", "team", "prolite", "pro", "other"]))
					.max(6)
					.optional(),
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
				enabledRoutines: z.array(z.string()),
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
		vnet: z
			.object({
				enabled: z.boolean(),
				relayToken: z.string().optional(),
				allowAnonymousRelay: z.boolean(),
				maxPeersPerNetwork: z.number().int().min(1).max(1024),
				maxMessageBytes: z
					.number()
					.int()
					.min(1024)
					.max(64 * 1024 * 1024),
				udp: z
					.object({
						enabled: z.boolean(),
						host: z.string().min(1).max(255),
						port: z.number().int().min(0).max(65535),
					})
					.partial()
					.optional(),
			})
			.partial()
			.optional(),
		shares: z
			.object({
				defaultExpiryHours: z.number().int().min(1),
				maxFileSizeMb: z.number().int().min(1),
			})
			.partial()
			.optional(),
	})
	.strict();

function normalizeLegacySettingsPatch(body: unknown): unknown {
	if (!body || typeof body !== "object" || Array.isArray(body)) return body;
	const draft = { ...(body as Record<string, unknown>) };
	const rawAgent = draft.agent;
	if (rawAgent && typeof rawAgent === "object" && !Array.isArray(rawAgent)) {
		const agent = { ...(rawAgent as Record<string, unknown>) };
		if (agent.defaultPermissionMode === "plan") {
			agent.defaultPermissionMode = "default";
			agent.defaultStartInPlanMode = true;
		}
		if (!("dangerSkipReadOnlyConfirmations" in agent) && "yoloSkipReadOnlyConfirmations" in agent) {
			agent.dangerSkipReadOnlyConfirmations = agent.yoloSkipReadOnlyConfirmations;
		}
		draft.agent = agent;
	}
	return draft;
}

export const settingsRoutes = new Hono();

/** Mask an API key for safe display (show last 4 chars). */
function maskApiKey(key?: string): string {
	if (!key) return "";
	if (key.length <= 4) return "*".repeat(key.length);
	return `${"*".repeat(8)}${key.slice(-4)}`;
}

function maskVNetSettings(vnet: NarraForkSettings["vnet"]): NarraForkSettings["vnet"] {
	if (!vnet) return undefined;
	return {
		...vnet,
		relayToken: vnet.relayToken ? maskApiKey(vnet.relayToken) : "",
	};
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

function uniqueIds(ids: string[]): string[] {
	return [...new Set(ids.filter(Boolean))];
}

function getCustomApiProviderIdsLeavingFamily(
	prev: NarraForkSettings["customApiProviders"],
	next: NarraForkSettings["customApiProviders"],
	family: "openai" | "anthropic",
): string[] {
	const nextById = new Map((next ?? []).map((provider) => [provider.id, provider]));
	return (prev ?? [])
		.filter((provider) => {
			const nextProvider = nextById.get(provider.id);
			if (!nextProvider) return false;
			if (family === "openai") {
				return (
					isOpenAICustomApiProtocol(provider.protocol) &&
					!isOpenAICustomApiProtocol(nextProvider.protocol)
				);
			}
			return (
				isAnthropicCustomApiProtocol(provider.protocol) &&
				!isAnthropicCustomApiProtocol(nextProvider.protocol)
			);
		})
		.map((provider) => provider.id);
}

/**
 * After settings are saved, detect providers that were removed and purge their
 * in-memory + on-disk model caches so no stale data lingers.
 */
function purgeRemovedProviderCaches(prev: NarraForkSettings, next: NarraForkSettings): void {
	const removedCustomApiIds = getRemovedProviderIds(
		prev.customApiProviders,
		next.customApiProviders,
	);
	const staleOpenaiCustomApiIds = uniqueIds([
		...removedCustomApiIds,
		...getCustomApiProviderIdsLeavingFamily(
			prev.customApiProviders,
			next.customApiProviders,
			"openai",
		),
	]);
	const staleAnthropicCustomApiIds = uniqueIds([
		...removedCustomApiIds,
		...getCustomApiProviderIdsLeavingFamily(
			prev.customApiProviders,
			next.customApiProviders,
			"anthropic",
		),
	]);
	const purges: Array<{ type: string; ids: string[]; fn: (ids: string[]) => void }> = [
		{
			type: "openai",
			ids: staleOpenaiCustomApiIds,
			fn: purgeOpenaiProviderCache,
		},
		{
			type: "anthropic",
			ids: staleAnthropicCustomApiIds,
			fn: purgeAnthropicProviderCache,
		},
		{
		},
		{
			type: "nug",
			ids: getRemovedProviderIds(prev.nugProviders, next.nugProviders),
			fn: purgeNugProviderCache,
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
	// (summaryModel, hiddenModels, modelContextWindows, customModels) that reference stale models.
	const removedPrefixes = new Set<string>();
	const removedProviderGroups = [
		{ ids: removedCustomApiIds, providers: prev.customApiProviders },
		{
		},
		{
			ids: getRemovedProviderIds(prev.nugProviders, next.nugProviders),
			providers: prev.nugProviders,
		},
		{
			ids: getRemovedProviderIds(prev.clineProviders, next.clineProviders),
			providers: prev.clineProviders,
		},
	];
	for (const { ids, providers } of removedProviderGroups) {
		if (!ids.length) continue;
		const idSet = new Set(ids);
		for (const p of providers ?? []) {
			if (idSet.has(p.id)) removedPrefixes.add(p.prefix ?? "");
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
		customApiProviders: (s.customApiProviders ?? []).map((p) => ({
			...p,
			apiKey: p.apiKey ? maskApiKey(p.apiKey) : "",
		})),
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
		nugProviders: (s.nugProviders ?? []).map((p) => ({
			...p,
			apiKey: p.apiKey ? maskApiKey(p.apiKey) : "",
			oauthClientSecret: p.oauthClientSecret ? maskApiKey(p.oauthClientSecret) : "",
		})),
		clineProviders: (s.clineProviders ?? []).map((p) => ({
			...p,
			accessToken: p.accessToken ? maskApiKey(p.accessToken) : "",
		})),
		vnet: maskVNetSettings(s.vnet),
		openaiModels: getOpenaiCachedModels(),
		openaiModelsGrouped: getOpenaiCachedModelsGrouped(),
		anthropicModelsGrouped: getAnthropicCachedModelsGrouped(),
		nugModelsGrouped: getNugCachedModelsGrouped(s.nugProviders ?? []),
		clineModelsGrouped: getClineEnabledModelsGrouped(),
		codexAvailable: codexManager.snapshot().available > 0,
		codexModels: getBuiltinCodexModels(),
		builtinModelContextWindows: getBuiltinModelContextWindows(getBuiltinCodexModels(), "codex"),
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
		const result = await agentGenerateWithMeta(prompt, model, undefined, undefined, {
			kind: "settings_test",
		});
		return c.json({ text: result.text });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.warn("Model test failed", { model, error: message });
		return c.json({ error: message }, 502);
	}
});

settingsRoutes.patch("/", async (c) => {
	const body = normalizeLegacySettingsPatch(await c.req.json());
	const parsed = updateSettingsSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const current = settings;
	const validated = parsed.data;

	const effectiveCustomApiProviders =
		validated.customApiProviders ??
		deriveCustomApiProvidersFromLegacy(
			validated.openaiProviders ?? current.openaiProviders,
			validated.anthropicProviders ?? current.anthropicProviders,
		);

	// Validate provider prefix conflicts — reserved prefixes and cross-provider duplicates
	{
		const allPrefixes: Array<{ prefix: string; source: string }> = [];
		for (const p of effectiveCustomApiProviders) {
			if (p.prefix) {
				allPrefixes.push({ prefix: p.prefix, source: `Custom API "${p.name || p.id}"` });
			}
		}
		}
		for (const p of validated.nugProviders ?? current.nugProviders ?? []) {
			if (p.prefix) allPrefixes.push({ prefix: p.prefix, source: `NUG "${p.name || p.id}"` });
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
	const oldVNet = current.vnet;

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

	// Preserve real VNet relay token when the client sends a masked display value.
	if (validated.vnet?.relayToken?.startsWith("*")) {
		validated.vnet.relayToken = current.vnet?.relayToken;
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

	const currentCustomApiProviders =
		current.customApiProviders ??
		deriveCustomApiProvidersFromLegacy(current.openaiProviders, current.anthropicProviders);
	const findExistingCustomApiKey = (id: string): string =>
		currentCustomApiProviders.find((p) => p.id === id)?.apiKey ??
		current.openaiProviders?.find((p) => p.id === id)?.apiKey ??
		current.anthropicProviders?.find((p) => p.id === id)?.apiKey ??
		"";

	// Preserve real API keys for unified custom API providers.
	if (validated.customApiProviders) {
		for (const p of validated.customApiProviders) {
			if (p.apiKey?.startsWith("*")) {
				p.apiKey = findExistingCustomApiKey(p.id);
			}
		}
		validated.openaiProviders = customApiProvidersToOpenAI(validated.customApiProviders);
		validated.anthropicProviders = customApiProvidersToAnthropic(validated.customApiProviders);
	}

	// Preserve real API keys for OpenAI-compatible providers.
	if (validated.openaiProviders) {
		for (const p of validated.openaiProviders) {
			if (p.apiKey?.startsWith("*")) {
				p.apiKey = findExistingCustomApiKey(p.id);
			}
		}
	}

	// Preserve real API keys for Anthropic providers.
	if (validated.anthropicProviders) {
		for (const p of validated.anthropicProviders) {
			if (p.apiKey?.startsWith("*")) {
				p.apiKey = findExistingCustomApiKey(p.id);
			}
		}
	}

	if (
		!validated.customApiProviders &&
		(validated.openaiProviders || validated.anthropicProviders)
	) {
		// Backward compatibility for older frontends that still submit the split arrays.
		validated.customApiProviders = deriveCustomApiProvidersFromLegacy(
			validated.openaiProviders ?? current.openaiProviders,
			validated.anthropicProviders ?? current.anthropicProviders,
		);
	}

			if (p.apiKey?.startsWith("*")) {
				const existing = currentProviders.find((cp) => cp.id === p.id);
				p.apiKey = existing?.apiKey ?? "";
			}
		}
	}

	// Preserve real API keys and OAuth secrets for NUG providers
	if (validated.nugProviders) {
		const currentProviders = current.nugProviders ?? [];
		for (const p of validated.nugProviders) {
			if (p.apiKey?.startsWith("*")) {
				const existing = currentProviders.find((cp) => cp.id === p.id);
				p.apiKey = existing?.apiKey ?? "";
			}
			// Preserve OAuth client secret when masked
			if (p.oauthClientSecret?.startsWith("*")) {
				const existing = currentProviders.find((cp) => cp.id === p.id);
				p.oauthClientSecret = existing?.oauthClientSecret ?? "";
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
			key === "customApiProviders" ||
			key === "openaiProviders" ||
			key === "anthropicProviders" ||
			key === "nugProviders" ||
			key === "clineProviders"
		) {
			// Array — replace entirely, don't merge
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			(merged as any)[key] = val;
		} else if (key === "vnet" && val && typeof val === "object" && !Array.isArray(val)) {
			const vnetPatch = val as NonNullable<NarraForkSettings["vnet"]>;
			merged.vnet = {
				...current.vnet,
				...vnetPatch,
				udp: vnetPatch.udp ? { ...current.vnet?.udp, ...vnetPatch.udp } : current.vnet?.udp,
			} as NarraForkSettings["vnet"];
		} else if (val && typeof val === "object" && !Array.isArray(val)) {
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			(merged as any)[key] = { ...(current as any)[key], ...val };
		} else {
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			(merged as any)[key] = val;
		}
	}

	normalizeCustomApiProviderSettings(merged);

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

	const vnetChanged = JSON.stringify(oldVNet ?? null) !== JSON.stringify(merged.vnet ?? null);

	saveSettings(merged);

	if (vnetChanged) {
		const closedConnections = closeVNetConnections("vnet settings changed");
		const status = await startVNetUdpRendezvous(merged.vnet);
		logger.info("Applied VNet runtime settings", { status, closedConnections });
	}

	// Detect host/port/TLS changes and schedule a server restart
	const newHost = merged.server.host;
	const newPort = merged.server.port;
	const newTls = merged.server.tls;
	const serverAddressChanged = newHost !== oldHost || newPort !== oldPort;
	// Compare TLS configs — treat undefined and {enabled:false} as equivalent (both mean "no TLS")
	const oldTlsEffective = oldTls?.enabled ? oldTls : undefined;
	const newTlsEffective = newTls?.enabled ? newTls : undefined;
	const tlsChanged = JSON.stringify(oldTlsEffective) !== JSON.stringify(newTlsEffective);
	const needsRestart = serverAddressChanged || tlsChanged;

	if (needsRestart) {
		scheduleServerRestart(newHost, newPort);
	}

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
		customApiProviders: (merged.customApiProviders ?? []).map((p) => ({
			...p,
			apiKey: p.apiKey ? maskApiKey(p.apiKey) : "",
		})),
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
		nugProviders: (merged.nugProviders ?? []).map((p) => ({
			...p,
			apiKey: p.apiKey ? maskApiKey(p.apiKey) : "",
			oauthClientSecret: p.oauthClientSecret ? maskApiKey(p.oauthClientSecret) : "",
		})),
		clineProviders: (merged.clineProviders ?? []).map((p) => ({
			...p,
			accessToken: p.accessToken ? maskApiKey(p.accessToken) : "",
		})),
		vnet: maskVNetSettings(merged.vnet),
		// Signal to the frontend that the server is restarting at a new address
		...(needsRestart && {
			serverRestarting: true,
			newUrl: `${newTls?.enabled ? "https" : "http"}://${newHost === "0.0.0.0" ? "localhost" : newHost}:${newPort}`,
		}),
	};
	return c.json(result);
});

// Generate a self-signed TLS certificate and enable HTTPS
settingsRoutes.post("/generate-tls", async (c) => {
	const { generateSelfSignedCert } = await import("../lib/tls");
	const result = await generateSelfSignedCert();

	// Update settings to enable TLS with generated cert paths
	const current = settings;
	const merged = {
		...current,
		server: {
			...current.server,
			tls: {
				enabled: true,
				certFile: result.certPath,
				keyFile: result.keyPath,
			},
		},
	};
	saveSettings(merged);

	// Schedule server restart to apply TLS
	const host = merged.server.host;
	const port = merged.server.port;
	scheduleServerRestart(host, port);

	const newUrl = `https://${host === "0.0.0.0" ? "localhost" : host}:${port}`;
	return c.json({
		certPath: result.certPath,
		keyPath: result.keyPath,
		expiresAt: result.expiresAt,
		newUrl,
		serverRestarting: true,
	});
});

const addRetryRuleSchema = z
	.object({
		domain: z.string().min(1).optional(),
		statusCode: z.number().int().min(100).max(599).optional(),
		keyword: z.string().min(1).optional(),
		note: z.string().max(200).optional(),
	})
	.refine((d) => d.domain || d.statusCode || d.keyword, {
		message: "At least one of domain, statusCode, or keyword is required",
	});

settingsRoutes.post("/retry-rules", async (c) => {
	const body = await c.req.json();
	const parsed = addRetryRuleSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const rule = {
		id: generateShortId(),
		...parsed.data,
		enabled: true,
	};

	const current = settings;
	const rules = [...(current.agent.customRetryRules ?? []), rule];
	const merged = {
		...current,
		agent: { ...current.agent, customRetryRules: rules },
	};
	saveSettings(merged);

	return c.json(rule, 201);
});
