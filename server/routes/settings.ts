import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { BRAND_ICON_COLOR_PATTERN, BRAND_NAME_MAX_LENGTH } from "@shared/branding";
import { stripErrorDisplayPrefix } from "@shared/retry-rule-keyword";
import { Hono } from "hono";
import { z } from "zod";
import { agentGenerateWithMetaResolved } from "../lib/agent";
import { serializeDiagnosticError } from "../lib/agent/diagnostic-fetch";
import { resolveProviderAndModel } from "../lib/agent/provider";
import { type CapturedRequest, createUrlCapture } from "../lib/agent/request-url-tracker";
import { AsyncMutex } from "../lib/async-mutex";
import { maskAuthSettings, maskSecret } from "../lib/auth-settings";
import { normalizeBrandingSettings } from "../lib/branding";
import { isValidTrustedProxyCidr } from "../lib/client-ip";
import { getCodexManager } from "../lib/codex-manager";
import {
	getAllCustomApiCachedQuotas,
	purgeCustomApiQuotaCache,
} from "../lib/custom-api-quota-cache";
import { ValidationError } from "../lib/errors";
import { generateShortId } from "../lib/id";
import {
	getAllKimiCachedUsages,
	purgeKimiUsageCache,
	refreshAllKimiUsages,
} from "../lib/kimi-usage-cache";
import { logger } from "../lib/logger";
import { redactDiagnosticText } from "../lib/net/diagnostic-redaction";
import { getLanAddresses } from "../lib/net/lan-addresses";
import { getNugCachedModelsGrouped } from "../lib/nug-model-cache";
import { reconcileNugRelayClients } from "../lib/nug-relay/manager";
import { legacyPermissionModeSchema } from "../lib/permission-modes";
import { PROTOCOL_REGISTRY } from "../lib/search/adapters/index";
import { listSearchChannels, testSearchChannel } from "../lib/search/router";
import { normalizeSearchSettings } from "../lib/search/settings";
import { restartServerForResponse } from "../lib/server-restart";
import {
	customApiProvidersToAnthropic,
	customApiProvidersToGemini,
	customApiProvidersToOpenAI,
	deriveCustomApiProvidersFromLegacy,
	getBuiltinCodexModels,
	getBuiltinModelContextWindows,
	getContextThresholds,
	getProviderPrefixChanges,
	isAnthropicCustomApiProtocol,
	isGeminiCustomApiProtocol,
	isOpenAICustomApiProtocol,
	migrateProviderPrefixReferences,
	type NarraForkSettings,
	normalizeCustomApiProvider,
	normalizeCustomApiProviderSettings,
	normalizeProxyUrl,
	purgeStaleAgentModelRefs,
	saveSettings,
	settings,
	stripObsoleteSettingsKeys,
} from "../lib/settings";
import { updateSourceSettingsSchema } from "../lib/settings/update-source";
import {
	blacklistDirEntrySchema,
	codexTierOrderSchema,
	commandBlacklistEntrySchema,
	commandWhitelistEntrySchema,
	modelCardSchema,
	whitelistDirEntrySchema,
} from "../lib/validators";
import {
	defaultNarratorVisibilitySchema,
	defaultNarratorWriteAudienceSchema,
	diskSafetySettingsSchema,
} from "../lib/validators/settings";
import { subagentModelReasoningEffortsSchema } from "../lib/validators/subagent-models";
import { startVNetUdpRendezvous } from "../lib/vnet/udp-rendezvous";
import { requireAdmin } from "../middleware/auth";
import {
	CodexImageGenerationFixError,
	disableCodexImageGenerationForPrefix,
} from "../services/codex-image-generation-fix";
import { ensureContainerProxyRuntime } from "../services/container-proxy";
import { clearOAuthWsTickets } from "../services/oauth-ws-ticket-service";
import { listPluginProviderModelGroups } from "../services/plugin-provider-model-source";
import { pluginProviderRegistry } from "../services/plugin-provider-registry";
import {
	commitProviderPrefixMigration,
	planProviderPrefixNarratorMigration,
} from "../services/provider-prefix-migration-service";
import { closeAllExternalNarratorConnections } from "../websocket/oauth-connection-registry";
import { closeVNetConnections } from "../websocket/vnet-ws";
import { getAnthropicCachedModelsGrouped, purgeAnthropicProviderCache } from "./anthropic";
import { dataDirectorySecurityRoutes } from "./data-directory-security";
import { getGeminiCachedModelsGrouped, purgeGeminiProviderCache } from "./gemini";
import { purgeNugProviderCache } from "./nug";
import {
	getOpenaiCachedModels,
	getOpenaiCachedModelsGrouped,
	purgeOpenaiProviderCache,
} from "./openai";

const settingsUpdateLock = new AsyncMutex();

const modelOptionSchema = z.object({
	value: z.string().min(1),
	label: z.string().min(1),
	provider: z.string().optional(),
	channel: z.string().optional(),
	channelType: z.string().optional(),
});

const dangerReflectionLevelSchema = z.enum(["off", "light", "standard", "strict"]);

const webFetchProxyUrlSchema = z.preprocess(
	(value) => {
		if (typeof value !== "string") return value;
		const trimmed = value.trim();
		if (!trimmed) return undefined;
		return normalizeProxyUrl(trimmed) ?? trimmed;
	},
	z
		.string()
		.regex(/^https?:\/\//)
		.optional(),
);

/** Per-location proxy override: default (inherit global) / direct / system / custom. */
const proxyOverrideSchema = z
	.object({
		mode: z.enum(["default", "direct", "system", "custom"]),
		url: webFetchProxyUrlSchema,
	})
	.superRefine((value, ctx) => {
		if (value.mode === "custom" && !value.url) {
			ctx.addIssue({
				code: "custom",
				path: ["url"],
				message: "Custom proxy mode requires a valid HTTP or HTTPS URL",
			});
		}
	})
	.optional();

// Accepts the current 4 protocols plus the 4 removed legacy values; inbound
// payloads are normalized (legacy → current) before persistence/derivation.
const customApiProtocolSchema = z.enum([
	"anthropic-messages",
	"openai-responses",
	"completions-compatible",
	"gemini-compatible",
	// Legacy values, migrated by normalizeCustomApiProvider.
	"anthropic-official",
	"anthropic-compatible",
	"codex-native",
	"responses-compatible",
]);

const userAgentModeSchema = z.enum(["narrafork", "claude-code", "codex", "custom"]).optional();
const customUserAgentSchema = z.string().max(500).optional();
const extraHeadersSchema = z.record(z.string(), z.string().max(2048)).optional();

const customApiProviderSchema = z.object({
	id: z.string().min(1),
	name: z.string(),
	prefix: z.string().min(1),
	apiKey: z.string(),
	baseUrl: z.string(),
	defaultModel: z.string(),
	protocol: customApiProtocolSchema,
	geminiTransport: z.enum(["generate-content", "interactions"]).optional(),
	defaultContextWindow: z.number().int().min(1).optional(),
	defaultReasoningEffort: z
		.enum(["none", "low", "medium", "high", "xhigh", "max"])
		.nullable()
		.optional(),
	proxy: proxyOverrideSchema,
	tlsRejectUnauthorized: z.boolean().optional(),
	nativeSearch: z.boolean().optional(),
	codexAccountId: z.string().optional(),
	codexWebSocket: z.boolean().optional(),
	codexWebSearch: z.boolean().optional(),
	codexImageGeneration: z.boolean().optional(),
	userAgentMode: userAgentModeSchema,
	customUserAgent: customUserAgentSchema,
	extraHeaders: extraHeadersSchema,
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
	codexWebSearch: z.boolean().optional(),
	codexImageGeneration: z.boolean().optional(),
	defaultContextWindow: z.number().int().min(1).optional(),
	proxy: proxyOverrideSchema,
	userAgentMode: userAgentModeSchema,
	customUserAgent: customUserAgentSchema,
	extraHeaders: extraHeadersSchema,
	disabled: z.boolean().optional(),
});

const anthropicProviderSchema = z.object({
	id: z.string().min(1),
	name: z.string(),
	prefix: z.string().min(1),
	apiKey: z.string(),
	baseUrl: z.string(),
	defaultModel: z.string(),
	defaultReasoningEffort: z
		.enum(["none", "low", "medium", "high", "xhigh", "max"])
		.nullable()
		.optional(),
	proxy: proxyOverrideSchema,
	tlsRejectUnauthorized: z.boolean().optional(),
	officialApi: z.boolean().optional(),
	nativeSearch: z.boolean().optional(),
	userAgentMode: userAgentModeSchema,
	customUserAgent: customUserAgentSchema,
	extraHeaders: extraHeadersSchema,
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
	proxy: proxyOverrideSchema,
	egressMode: z.enum(["nug", "local-direct", "local-proxy"]).optional(),
	egressProxyUrl: z.string().optional(),
	egressAllowDirectFallback: z.boolean().optional(),
	disabled: z.boolean().optional(),
});

const geminiProviderSchema = z.object({
	id: z.string().min(1),
	name: z.string(),
	prefix: z.string().min(1),
	apiKey: z.string(),
	baseUrl: z.string(),
	defaultModel: z.string(),
	geminiTransport: z.enum(["generate-content", "interactions"]).optional(),
	defaultContextWindow: z.number().int().min(1).optional(),
	defaultReasoningEffort: z
		.enum(["none", "low", "medium", "high", "xhigh", "max"])
		.nullable()
		.optional(),
	enabledModels: z.array(z.string()).optional(),
	proxy: proxyOverrideSchema,
	disabled: z.boolean().optional(),
});

const searchChannelSchema = z.object({
	id: z.string().min(1),
	kind: z.enum(["native", "nug-mcp", "custom-api", "subagent", "plugin"]),
	enabled: z.boolean(),
	providerId: z.string().optional(),
	model: z.string().optional(),
	reasoningEffort: z.enum(["none", "low", "medium", "high", "xhigh"]).optional(),
	maxTurns: z.number().int().min(1).max(10).optional(),
	timeoutMs: z.number().int().min(1000).max(300000).optional(),
});

const customSearchProviderProtocolSchema = z.string().min(1);

const customSearchProviderSchema = z.object({
	id: z.string().min(1),
	name: z.string(),
	disabled: z.boolean().optional(),
	protocol: customSearchProviderProtocolSchema,
	baseUrl: z.string(),
	apiKey: z.string().optional(),
	headers: z.record(z.string(), z.string()).optional(),
	options: z.record(z.string(), z.unknown()).optional(),
	timeoutMs: z.number().int().min(1000).max(300000).optional(),
});

const searchSettingsSchema = z
	.object({
		channels: z.array(searchChannelSchema).max(100).optional(),
		customProviders: z.array(customSearchProviderSchema).max(50).optional(),
		defaultTimeoutMs: z.number().int().min(1000).max(300000).optional(),
		maxOutputChars: z.number().int().min(1000).max(100000).optional(),
	})
	.partial();

const externalWebSocketOriginSchema = z
	.string()
	.trim()
	.min(1)
	.max(2048)
	.refine((value) => {
		try {
			const url = new URL(value);
			return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
		} catch {
			return false;
		}
	}, "Origin must be an exact HTTP(S) origin without a path");

/**
 * Instance-wide settings that only admins may change (enforced by `requireAdmin`
 * on the PATCH route). Per-user preferences live in `/api/user-preferences`, so
 * every field here is shared state. `auth.jwtSecret` stays excluded regardless.
 *
 * Exported for tests: `update.serverUrl` is a code-delivery origin, so its https gate
 * is a security boundary rather than input hygiene and is asserted directly.
 */
export const updateSettingsSchema = z
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
		proxy: z
			.object({
				mode: z.enum(["system", "direct", "custom"]),
				url: webFetchProxyUrlSchema,
			})
			.superRefine((value, ctx) => {
				if (value.mode === "custom" && !value.url) {
					ctx.addIssue({
						code: "custom",
						path: ["url"],
						message: "Custom proxy mode requires a valid HTTP or HTTPS URL",
					});
				}
			})
			.optional(),
		diskSafety: diskSafetySettingsSchema.optional(),
		paths: z
			.object({
				defaultProjectDir: z.string().min(1),
				/**
				 * Extra roots the in-browser editor may write to.
				 *
				 * Absolute paths only, and rejected otherwise rather than resolved against
				 * the server's cwd: a relative entry would name a directory the admin cannot
				 * predict, and this list is a write allow-list. Bounded in length because it
				 * is consulted on every save (each entry costs a `realpath` walk).
				 *
				 * Containment, symlink resolution and the credential deny-list are enforced
				 * at write time by `checkWriteBoundary`, not here — an entry that looks
				 * reasonable can still stop being safe once a link inside it changes.
				 */
				extraWritableDirs: z
					.array(z.string().min(1).refine(isAbsolute, "must be an absolute path"))
					.max(32),
			})
			.partial()
			.optional(),
		/**
		 * Per-instance branding. Validated STRICTLY here even though every read path
		 * falls back to defaults: an admin who typed a malformed colour should be told
		 * so, rather than saving a value that silently renders as NarraFork indigo.
		 *
		 * Both fields accept "" to mean "clear it" — the UI must send the empty string
		 * rather than omitting the key, since `.partial()` reads an absent key as
		 * "leave unchanged".
		 */
		branding: z
			.object({
				name: z.string().trim().max(BRAND_NAME_MAX_LENGTH),
				iconColor: z.union([z.literal(""), z.string().trim().regex(BRAND_ICON_COLOR_PATTERN)]),
			})
			.partial()
			.optional(),
		agent: z
			.object({
				defaultModel: z.string().min(1),
				defaultPermissionMode: legacyPermissionModeSchema,
				defaultNarratorVisibility: defaultNarratorVisibilitySchema,
				defaultNarratorWriteAudience: defaultNarratorWriteAudienceSchema,
				defaultStartInPlanMode: z.boolean(),
				summaryModel: z.string(),
				translationModel: z.string(),
				promptOptimizeModel: z.string(),
				promptOptimizeContextMaxMessages: z.number().int().min(1).max(50),
				customModels: z.array(modelOptionSchema),
				hiddenModels: z.array(z.string()),
				maxTurns: z.number().int().min(1).max(1000),
				subagentModels: z
					.object({
						explore: z.string(),
						plan: z.string(),
						search: z.string(),
						review: z.string(),
					})
					.partial(),
				subagentModelReasoningEfforts: subagentModelReasoningEffortsSchema,
				subagentAllowedModels: z
					.object({
						explore: z.array(z.string()),
						plan: z.array(z.string()),
						general: z.array(z.string()),
						search: z.array(z.string()),
						review: z.array(z.string()),
					})
					.partial(),
				legacyEncoding: z.boolean(),
				freshShellEnv: z.boolean(),
				translateReasoning: z.boolean(),
				requestDumpEnabled: z.boolean(),
				requestDumpErrorsOnly: z.boolean(),
				defaultRelaxedPlan: z.boolean(),
				planModeAllowInlinePlan: z.boolean(),
				planReflectionAutoApprove: z.boolean(),
				planReflectionAllowAutoCompact: z.boolean(),
				questionReflectionEnabled: z.boolean(),
				permissionRuleAutoApprove: z.boolean(),
				questionReflectionTimeoutMs: z.number().int().min(10000).max(3600000),
				dangerReflectionLevel: dangerReflectionLevelSchema,
				dangerReflectionEnabled: z.boolean(),
				dangerSkipReadOnlyConfirmations: z.boolean(),
				autoContinuationMode: z.enum(["always", "blockStop", "protectedOnly", "off"]),
				// "" means "auto" (fall back to the built-in default). Accepting the
				// empty string lets the UI clear an explicitly configured tier.
				defaultReasoningEffort: z
					.enum(["none", "low", "medium", "high", "xhigh", "max", ""])
					.optional(),
				// Models that must NOT receive an effort hint. Effort is sent by
				// default, so this list is the only user-facing escape hatch for an
				// upstream that rejects the parameter.
				reasoningEffortBlocklist: z
					.array(
						z.object({
							pattern: z.string().max(200),
							enabled: z.boolean().optional(),
						}),
					)
					.max(100)
					.optional(),
				maxTransientRetries: z.number().int().min(-1).max(100),
				maxToolCallsPerResponse: z.number().int().min(1).max(128),
				silentToolCallThreshold: z.number().int().min(-1).max(1000),
				pipelineUnusedToolCallThreshold: z
					.number()
					.int()
					.min(-1)
					.max(1000)
					.refine((v) => v === -1 || v >= 1, {
						message: "Pipeline threshold must be -1 or at least 1",
					}),
				behaviorFenceInterval: z
					.number()
					.int()
					.min(-1)
					.max(1000)
					.refine((v) => v === -1 || v >= 5, {
						message: "Interval must be -1 or at least 5",
					}),
				tasksReminderInterval: z
					.number()
					.int()
					.min(-1)
					.max(1000)
					.refine((v) => v === -1 || v >= 5, {
						message: "Interval must be -1 or at least 5",
					}),
				behaviorFenceAttachTasks: z.boolean(),
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
				modelCards: z.array(modelCardSchema).max(500).optional(),
				whitelistDirs: z.array(whitelistDirEntrySchema).max(50),
				blacklistDirs: z.array(blacklistDirEntrySchema).max(50),
				commandWhitelist: z.array(commandWhitelistEntrySchema).max(50),
				commandBlacklist: z.array(commandBlacklistEntrySchema).max(50),
				contextThresholds: z
					.object({
						standard: z.object({
							compactStart: z.number().min(50).max(100),
						}),
						large: z.object({
							compactStart: z.number().min(10).max(100),
						}),
					})
					.optional(),
				autoCompactKeepPairs: z.number().int().min(1).max(25).optional(),
				queueDuringCompaction: z.boolean().optional(),
				browserProxy: proxyOverrideSchema,
				notificationPolicy: z.object({ allowSend: z.boolean().optional() }).optional(),
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
						proxy: proxyOverrideSchema,
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
				treeSnapshotsEnabled: z.boolean(),
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
				trustedProxyCidrs: z
					.array(
						z
							.string()
							.trim()
							.min(1)
							.max(64)
							.refine(isValidTrustedProxyCidr, "Must be an IP address or CIDR"),
					)
					.max(32),
			})
			.partial()
			.optional(),
		oauth: z
			.object({
				externalWebSocket: z
					.object({
						ticketTtlMs: z.number().int().min(30_000).max(60_000),
						maxTickets: z.number().int().min(1).max(10_000),
						maxFrameBytes: z.number().int().min(4_096).max(262_144),
						allowedOrigins: z.array(externalWebSocketOriginSchema).max(32),
						maxSubscriptionsPerFrame: z.number().int().min(1).max(100),
						maxSubscriptionsPerConnection: z.number().int().min(1).max(200),
						maxGlobalConnections: z.number().int().min(1).max(5_000),
						maxConnectionsPerToken: z.number().int().min(1).max(32),
						maxConnectionsPerGrant: z.number().int().min(1).max(128),
						maxConnectionsPerClient: z.number().int().min(1).max(1_000),
						maxConnectionsPerUser: z.number().int().min(1).max(128),
						maxBufferedAmount: z.number().int().min(65_536).max(8_388_608),
					})
					.partial(),
			})
			.partial()
			.optional(),
		customApiProviders: z.array(customApiProviderSchema).optional(),
		openaiProviders: z.array(openaiProviderSchema).optional(),
		anthropicProviders: z.array(anthropicProviderSchema).optional(),
		nugProviders: z.array(nugProviderSchema).optional(),
		geminiProviders: z.array(geminiProviderSchema).optional(),
		codex: z
			.object({
				proxy: proxyOverrideSchema,
				loadBalancingMode: z.enum(["priority", "balanced", "tier-balanced"]).optional(),
				tierOrder: codexTierOrderSchema.shape.tierOrder.optional(),
				defaultReasoningEffort: z
					.enum(["none", "low", "medium", "high", "xhigh", "max"])
					.nullable()
					.optional(),
				useWebSearch: z.boolean().optional(),
				useImageGeneration: z.boolean().optional(),
				userAgentMode: userAgentModeSchema,
				customUserAgent: customUserAgentSchema,
				extraHeaders: extraHeadersSchema,
			})
			.partial()
			.optional(),
		clientFingerprint: z
			.object({
				installationId: z.string().uuid().optional(),
			})
			.partial()
			.optional(),
		search: searchSettingsSchema.optional(),
		routines: z
			.object({
				disabledRoutines: z.array(z.string()),
				enabledRoutines: z.array(z.string()),
				toolModes: z.record(z.string(), z.enum(["manual", "auto", "resident"])),
			})
			.partial()
			.optional(),
		update: updateSourceSettingsSchema,
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
		/*
		 * Only the enrollment opt-in is patchable here. The rest of `devices` (transfer
		 * concurrency, verify mode, transfers dir) has no UI and is left to the config
		 * file rather than exposed speculatively.
		 *
		 * This one has to be reachable over the API because the UI names it in the
		 * refusal it shows when automatic key delivery is unavailable — and this schema
		 * is `.strict()`, so before being listed the whole PATCH was rejected, making
		 * that instruction impossible to follow without hand-editing settings.json.
		 */
		devices: z
			.object({ allowPlaintextEnrollmentOnPrivateNetwork: z.boolean() })
			.partial()
			.optional(),
	})
	.strict();

function normalizeLegacySettingsPatch(body: unknown): unknown {
	if (!body || typeof body !== "object" || Array.isArray(body)) return body;
	const draft = { ...(body as Record<string, unknown>) };
	stripObsoleteSettingsKeys(draft);
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
		if ("dangerReflectionLevel" in agent) {
			agent.dangerReflectionEnabled = agent.dangerReflectionLevel !== "off";
		} else if ("dangerReflectionEnabled" in agent) {
			agent.dangerReflectionLevel = agent.dangerReflectionEnabled === false ? "off" : "standard";
		}
		draft.agent = agent;
	}
	return draft;
}

export const settingsRoutes = new Hono();
settingsRoutes.route("/data-directory-security", dataDirectorySecurityRoutes);

/** Mask an API key for safe display (show last 4 chars). */
function maskApiKey(key?: string): string {
	return maskSecret(key);
}

function maskVNetSettings(vnet: NarraForkSettings["vnet"]): NarraForkSettings["vnet"] {
	if (!vnet) return undefined;
	return {
		...vnet,
		relayToken: vnet.relayToken ? maskApiKey(vnet.relayToken) : "",
	};
}

function isSensitiveHeaderName(name: string): boolean {
	return /^(authorization|x-api-key|api-key|x-auth-token|cookie|set-cookie)$/i.test(name.trim());
}

function maskSearchProviderBaseUrl(
	provider: NonNullable<NarraForkSettings["search"]>["customProviders"][number],
): string {
	if (provider.protocol !== "tavily-mcp" || !provider.baseUrl) return provider.baseUrl;
	try {
		const url = new URL(provider.baseUrl);
		const key = url.searchParams.get("tavilyApiKey");
		if (key) url.searchParams.set("tavilyApiKey", maskApiKey(key));
		return url.toString();
	} catch {
		return provider.baseUrl;
	}
}

function restoreMaskedSearchProviderBaseUrl(
	provider: NonNullable<NarraForkSettings["search"]>["customProviders"][number],
	existing: NonNullable<NarraForkSettings["search"]>["customProviders"][number] | undefined,
): void {
	if (provider.protocol !== "tavily-mcp" || !provider.baseUrl || !existing?.baseUrl) return;
	try {
		const nextUrl = new URL(provider.baseUrl);
		const nextKey = nextUrl.searchParams.get("tavilyApiKey");
		if (!nextKey?.startsWith("*")) return;
		const existingUrl = new URL(existing.baseUrl);
		const existingKey = existingUrl.searchParams.get("tavilyApiKey");
		if (!existingKey) return;
		nextUrl.searchParams.set("tavilyApiKey", existingKey);
		provider.baseUrl = nextUrl.toString();
	} catch {
		// Leave malformed URLs untouched; validation/normalization handles them later.
	}
}

function restoreMaskedSearchProvider(
	provider: NonNullable<NarraForkSettings["search"]>["customProviders"][number],
	existing: NonNullable<NarraForkSettings["search"]>["customProviders"][number] | undefined,
): void {
	if (provider.apiKey?.startsWith("*")) provider.apiKey = existing?.apiKey ?? "";
	const headers = provider.headers;
	if (headers) {
		for (const [key, value] of Object.entries(headers)) {
			if (isSensitiveHeaderName(key) && value.startsWith("*")) {
				headers[key] = existing?.headers?.[key] ?? "";
			}
		}
	}
	restoreMaskedSearchProviderBaseUrl(provider, existing);
}

function maskSearchSettings(search: NarraForkSettings["search"]): NarraForkSettings["search"] {
	if (!search) return undefined;
	return {
		...search,
		customProviders: (search.customProviders ?? []).map((provider) => ({
			...provider,
			baseUrl: maskSearchProviderBaseUrl(provider),
			apiKey: provider.apiKey ? maskApiKey(provider.apiKey) : "",
			headers: Object.fromEntries(
				Object.entries(provider.headers ?? {}).map(([key, value]) => [
					key,
					isSensitiveHeaderName(key) && value ? maskApiKey(value) : value,
				]),
			),
		})),
	};
}

function isWildcardListenHost(host: string): boolean {
	return host === "0.0.0.0" || host === "::" || host === "[::]";
}

function formatUrlHost(host: string): string {
	const normalized = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	return normalized.includes(":") ? `[${normalized}]` : normalized;
}

export function buildServerRestartUrl(
	requestUrl: string,
	host: string,
	port: number,
	tlsEnabled: boolean,
): string {
	// host/port/protocol must come from the actual listener, never from configured auto-lan intent.
	const redirectHost = isWildcardListenHost(host) ? new URL(requestUrl).hostname : host;
	return `${tlsEnabled ? "https" : "http"}://${formatUrlHost(redirectHost)}:${port}`;
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

function buildSettingsResponse(
	source: NarraForkSettings,
	extra?: { serverRestarting?: boolean; newUrl?: string },
) {
	const codexManager = getCodexManager();
	const safeSource = { ...source } as NarraForkSettings & Record<string, unknown>;
	stripObsoleteSettingsKeys(safeSource);
	return {
		...safeSource,
		// Mask TLS passphrase
		server: {
			...source.server,
			tls: source.server.tls
				? {
						...source.server.tls,
						passphrase: source.server.tls.passphrase ? "********" : undefined,
					}
				: undefined,
		},
		auth: maskAuthSettings(source.auth),
		// Multi-provider — mask all keys
		customApiProviders: (source.customApiProviders ?? []).map((p) => ({
			...p,
			apiKey: p.apiKey ? maskApiKey(p.apiKey) : "",
		})),
		openaiProviders: (source.openaiProviders ?? []).map((p) => ({
			...p,
			apiKey: p.apiKey ? maskApiKey(p.apiKey) : "",
		})),
		anthropicProviders: (source.anthropicProviders ?? []).map((p) => ({
			...p,
			apiKey: p.apiKey ? maskApiKey(p.apiKey) : "",
		})),
		nugProviders: (source.nugProviders ?? []).map((p) => ({
			...p,
			apiKey: p.apiKey ? maskApiKey(p.apiKey) : "",
			oauthClientSecret: p.oauthClientSecret ? maskApiKey(p.oauthClientSecret) : "",
		})),
		geminiProviders: (source.geminiProviders ?? []).map((p) => ({
			...p,
			apiKey: p.apiKey ? maskApiKey(p.apiKey) : "",
		})),
		vnet: maskVNetSettings(source.vnet),
		search: maskSearchSettings(source.search),
		// Executable-plugin providers, grouped per provider prefix. Read straight from
		// the in-memory registry; no plugin process is started to build this.
		pluginProviderModelsGrouped: listPluginProviderModelGroups(pluginProviderRegistry),
		// Label and availability for every channel, including plugin-contributed ones whose
		// names the frontend cannot derive from settings alone. Synchronous registry reads.
		searchChannelInfo: listSearchChannels().map((channel) => ({
			id: channel.id,
			kind: channel.kind,
			label: channel.label,
			available: channel.available,
		})),
		openaiModels: getOpenaiCachedModels(),
		openaiModelsGrouped: getOpenaiCachedModelsGrouped(),
		anthropicModelsGrouped: getAnthropicCachedModelsGrouped(),
		nugModelsGrouped: getNugCachedModelsGrouped(source.nugProviders ?? []),
		geminiModelsGrouped: getGeminiCachedModelsGrouped(),
		customApiQuotas: getAllCustomApiCachedQuotas(),
		kimiUsages: getAllKimiCachedUsages(),
		codexAvailable: codexManager.snapshot().available > 0,
		codexModels: getBuiltinCodexModels(),
		builtinModelContextWindows: getBuiltinModelContextWindows(getBuiltinCodexModels(), "codex"),
		lanAddresses: getLanAddresses(),
		summaryModelAvailable: checkSummaryModelAvailable(source.agent.summaryModel),
		...(extra?.serverRestarting && {
			serverRestarting: true,
			newUrl: extra.newUrl,
		}),
	};
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
	family: "openai" | "anthropic" | "gemini",
): string[] {
	const inFamily = (
		protocol: NonNullable<NarraForkSettings["customApiProviders"]>[number]["protocol"],
	) => {
		if (family === "openai") return isOpenAICustomApiProtocol(protocol);
		if (family === "anthropic") return isAnthropicCustomApiProtocol(protocol);
		return isGeminiCustomApiProtocol(protocol);
	};
	const nextById = new Map((next ?? []).map((provider) => [provider.id, provider]));
	return (prev ?? [])
		.filter((provider) => {
			const nextProvider = nextById.get(provider.id);
			if (!nextProvider) return false;
			return inFamily(provider.protocol) && !inFamily(nextProvider.protocol);
		})
		.map((provider) => provider.id);
}

function getGeminiTransportChangedProviderIds(
	prev: NarraForkSettings["customApiProviders"],
	next: NarraForkSettings["customApiProviders"],
): string[] {
	const nextById = new Map((next ?? []).map((provider) => [provider.id, provider]));
	return (prev ?? [])
		.filter((provider) => {
			if (!isGeminiCustomApiProtocol(provider.protocol)) return false;
			const nextProvider = nextById.get(provider.id);
			if (!nextProvider || !isGeminiCustomApiProtocol(nextProvider.protocol)) return false;
			return (
				(provider.geminiTransport ?? "generate-content") !==
				(nextProvider.geminiTransport ?? "generate-content")
			);
		})
		.map((provider) => provider.id);
}

/**
 * Custom API providers whose KIMI USAGE identity changed.
 *
 * Narrower than the quota test: the usage endpoint is addressed by `baseUrl` and
 * authenticated by `apiKey`, and nothing else affects what it returns. `disabled`
 * counts too — a disabled provider stops being refreshed, so leaving its numbers
 * cached would show a quota that is no longer being updated.
 */
function getCustomApiProviderIdsWithKimiIdentityChanges(
	prev: NarraForkSettings["customApiProviders"],
	next: NarraForkSettings["customApiProviders"],
): string[] {
	const nextById = new Map((next ?? []).map((provider) => [provider.id, provider]));
	return (prev ?? [])
		.filter((provider) => {
			const nextProvider = nextById.get(provider.id);
			if (!nextProvider) return false;
			return (
				provider.baseUrl !== nextProvider.baseUrl ||
				provider.apiKey !== nextProvider.apiKey ||
				Boolean(provider.disabled) !== Boolean(nextProvider.disabled)
			);
		})
		.map((provider) => provider.id);
}

function getCustomApiProviderIdsWithQuotaIdentityChanges(
	prev: NarraForkSettings["customApiProviders"],
	next: NarraForkSettings["customApiProviders"],
): string[] {
	const nextById = new Map((next ?? []).map((provider) => [provider.id, provider]));
	return (prev ?? [])
		.filter((provider) => {
			const nextProvider = nextById.get(provider.id);
			if (!nextProvider) return false;
			return (
				provider.prefix !== nextProvider.prefix ||
				provider.baseUrl !== nextProvider.baseUrl ||
				provider.apiKey !== nextProvider.apiKey ||
				provider.protocol !== nextProvider.protocol ||
				provider.geminiTransport !== nextProvider.geminiTransport ||
				provider.codexAccountId !== nextProvider.codexAccountId
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
	const staleGeminiCustomApiIds = uniqueIds([
		...removedCustomApiIds,
		...getCustomApiProviderIdsLeavingFamily(
			prev.customApiProviders,
			next.customApiProviders,
			"gemini",
		),
		...getGeminiTransportChangedProviderIds(prev.customApiProviders, next.customApiProviders),
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
			type: "nug",
			ids: getRemovedProviderIds(prev.nugProviders, next.nugProviders),
			fn: purgeNugProviderCache,
		},
		{
			type: "gemini",
			ids: staleGeminiCustomApiIds,
			fn: purgeGeminiProviderCache,
		},
	];

	for (const { type, ids, fn } of purges) {
		if (ids.length) {
			fn(ids);
			logger.info("Purged provider model cache", { type, removedIds: ids });
		}
	}
	const staleCustomApiQuotaIds = uniqueIds([
		...removedCustomApiIds,
		...getCustomApiProviderIdsWithQuotaIdentityChanges(
			prev.customApiProviders,
			next.customApiProviders,
		),
	]);
	if (staleCustomApiQuotaIds.length) {
		purgeCustomApiQuotaCache(staleCustomApiQuotaIds);
		logger.info("Purged custom API quota cache", { providerIds: staleCustomApiQuotaIds });
	}
	// Kimi usage keys off (baseUrl, apiKey) only, so it uses its OWN staleness test
	// rather than the quota one: that set also fires on `protocol`,
	// `geminiTransport` and `codexAccountId`, none of which changes what the usage
	// endpoint returns — throwing the cache away for them just forces a needless
	// upstream refetch.
	const staleKimiUsageIds = uniqueIds([
		...removedCustomApiIds,
		...getCustomApiProviderIdsWithKimiIdentityChanges(
			prev.customApiProviders,
			next.customApiProviders,
		),
	]);
	if (staleKimiUsageIds.length) {
		purgeKimiUsageCache(staleKimiUsageIds);
	}

	// Collect prefixes of removed providers — needed to purge agent-level fields
	// (summaryModel, hiddenModels, modelContextWindows, customModels) that reference stale models.
	const removedPrefixes = new Set<string>();
	const removedProviderGroups = [
		{ ids: removedCustomApiIds, providers: prev.customApiProviders },
		{
			ids: getRemovedProviderIds(prev.nugProviders, next.nugProviders),
			providers: prev.nugProviders,
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
		logger.info("Purged stale agent references to removed providers", {
			prefixes: [...removedPrefixes],
		});
	}
}

settingsRoutes.get("/", (c) => {
	return c.json(buildSettingsResponse(settings));
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

function buildModelTestDiagnostics(options: {
	diagnosticId: string;
	model: string;
	resolvedProvider: string;
	resolvedModel: string;
	startedAt: number;
	requests: CapturedRequest[];
	verbose: boolean;
	error?: unknown;
}) {
	return {
		id: options.diagnosticId,
		model: options.model,
		resolvedProvider: options.resolvedProvider,
		resolvedModel: options.resolvedModel,
		createdAt: new Date().toISOString(),
		durationMs: Math.max(0, Date.now() - options.startedAt),
		runtime: {
			name: "Bun",
			version: Bun.version,
			platform: process.platform,
			arch: process.arch,
		},
		verbose: {
			enabled: options.verbose,
			destination: "server_stdout",
			includesSensitiveHeaders: false,
			redaction: "safe_allowlist",
		},
		requests: options.requests,
		error: options.error === undefined ? undefined : serializeDiagnosticError(options.error),
	};
}

settingsRoutes.post("/test-model", requireAdmin, async (c) => {
	const body = await c.req.json();
	const parsed = testModelSchema.safeParse(body);
	if (!parsed.success) {
		throw new ValidationError(parsed.error.issues.map((i) => i.message).join(", "));
	}
	const { model, prompt } = parsed.data;

	let resolved: ReturnType<typeof resolveProviderAndModel>;
	try {
		resolved = resolveProviderAndModel(model);
	} catch (err) {
		return c.json(
			{
				error: redactDiagnosticText(
					err instanceof Error ? err.message : "Unknown provider or model",
				),
			},
			400,
		);
	}

	const capture = createUrlCapture({ verbose: true });
	const diagnosticId = generateShortId();
	const startedAt = Date.now();
	logger.info("Model test verbose trace starting", {
		diagnosticId,
		model,
		resolvedProvider: resolved.provider,
		resolvedModel: resolved.model,
		userId: c.get("user").sub,
		verbose: capture.verbose,
	});
	try {
		const result = await capture.run(() =>
			agentGenerateWithMetaResolved(prompt, resolved, undefined, undefined, {
				kind: "settings_test",
				userId: c.get("user").sub,
			}),
		);
		const diagnostics = buildModelTestDiagnostics({
			diagnosticId,
			model,
			resolvedProvider: resolved.provider,
			resolvedModel: resolved.model,
			startedAt,
			requests: capture.requests,
			verbose: capture.verbose,
		});
		logger.info("Model test verbose trace completed", {
			diagnosticId,
			model,
			resolvedProvider: resolved.provider,
			resolvedModel: resolved.model,
			durationMs: diagnostics.durationMs,
			requestCount: diagnostics.requests.length,
		});
		return c.json({
			text: result.text,
			requestUrls: capture.requests.map(({ url, method }) => ({ url, method })),
			diagnostics,
		});
	} catch (err) {
		const message = redactDiagnosticText(err instanceof Error ? err.message : String(err));
		const diagnostics = buildModelTestDiagnostics({
			diagnosticId,
			model,
			resolvedProvider: resolved.provider,
			resolvedModel: resolved.model,
			startedAt,
			requests: capture.requests,
			verbose: capture.verbose,
			error: err,
		});
		logger.warn("Model test failed", {
			diagnosticId,
			model,
			resolvedProvider: resolved.provider,
			resolvedModel: resolved.model,
			durationMs: diagnostics.durationMs,
			error: diagnostics.error,
			requests: diagnostics.requests,
		});
		return c.json(
			{
				error: message,
				requestUrls: capture.requests.map(({ url, method }) => ({ url, method })),
				diagnostics,
			},
			502,
		);
	}
});

const testSearchSchema = z.object({
	query: z.string().min(2).max(1000),
	purpose: z.string().max(1000).optional(),
	channelId: z.string().optional(),
	channel: searchChannelSchema.optional(),
	customProvider: customSearchProviderSchema.optional(),
});

settingsRoutes.post("/search/test", requireAdmin, async (c) => {
	const body = await c.req.json();
	const parsed = testSearchSchema.safeParse(body);
	if (!parsed.success) {
		throw new ValidationError(parsed.error.issues.map((i) => i.message).join(", "));
	}
	const customProvider = parsed.data.customProvider;
	if (customProvider) {
		restoreMaskedSearchProvider(
			customProvider,
			settings.search?.customProviders.find((item) => item.id === customProvider.id),
		);
	}
	try {
		const result = await testSearchChannel(
			{
				query: parsed.data.query,
				purpose: parsed.data.purpose,
				channelId: parsed.data.channelId,
				locale: "zh-CN",
				signal: c.req.raw.signal,
				userId: c.get("user").sub,
			},
			{ channel: parsed.data.channel, customProvider: parsed.data.customProvider },
		);
		return c.json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.warn("Search channel test failed", { error: message, channelId: parsed.data.channelId });
		return c.json({ error: message }, 502);
	}
});

settingsRoutes.get("/search/protocols", (c) => {
	return c.json(PROTOCOL_REGISTRY);
});

settingsRoutes.patch("/", requireAdmin, async (c) =>
	settingsUpdateLock.acquire("settings", async () => {
		const body = normalizeLegacySettingsPatch(await c.req.json());
		const parsed = updateSettingsSchema.safeParse(body);
		if (!parsed.success) throw new ValidationError(parsed.error.message);

		const current = structuredClone(settings);
		const validated = parsed.data;

		const effectiveCustomApiProviders =
			validated.customApiProviders ??
			deriveCustomApiProvidersFromLegacy(
				validated.openaiProviders ?? current.openaiProviders,
				validated.anthropicProviders ?? current.anthropicProviders,
				validated.geminiProviders ?? current.geminiProviders,
			);

		// Validate provider prefix conflicts — reserved prefixes and cross-provider duplicates
		{
			const RESERVED_PREFIXES = new Set(["codex"]);
			const allPrefixes: Array<{ prefix: string; source: string }> = [];
			for (const p of effectiveCustomApiProviders) {
				if (p.prefix) {
					allPrefixes.push({ prefix: p.prefix, source: `Custom API "${p.name || p.id}"` });
				}
			}
			for (const p of validated.nugProviders ?? current.nugProviders ?? []) {
				if (p.prefix) allPrefixes.push({ prefix: p.prefix, source: `NUG "${p.name || p.id}"` });
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

		// An explicit "" from the UI means "auto" — drop the stored tier instead of
		// persisting an invalid empty value.
		if (validated.agent && "defaultReasoningEffort" in validated.agent) {
			if (validated.agent.defaultReasoningEffort === "") {
				validated.agent.defaultReasoningEffort = undefined;
				delete current.agent.defaultReasoningEffort;
			}
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
			deriveCustomApiProvidersFromLegacy(
				current.openaiProviders,
				current.anthropicProviders,
				current.geminiProviders,
			);
		const findExistingCustomApiKey = (id: string): string =>
			currentCustomApiProviders.find((p) => p.id === id)?.apiKey ??
			current.openaiProviders?.find((p) => p.id === id)?.apiKey ??
			current.anthropicProviders?.find((p) => p.id === id)?.apiKey ??
			current.geminiProviders?.find((p) => p.id === id)?.apiKey ??
			"";

		// Preserve real API keys for unified custom API providers. Inbound protocols
		// are normalized first so legacy values migrate before storage/derivation.
		if (validated.customApiProviders) {
			const normalizedCustomApiProviders = validated.customApiProviders.map((p) =>
				normalizeCustomApiProvider(p),
			);
			for (const p of normalizedCustomApiProviders) {
				if (p.apiKey?.startsWith("*")) {
					p.apiKey = findExistingCustomApiKey(p.id);
				}
			}
			validated.customApiProviders = normalizedCustomApiProviders;
			validated.openaiProviders = customApiProvidersToOpenAI(normalizedCustomApiProviders);
			validated.anthropicProviders = customApiProvidersToAnthropic(normalizedCustomApiProviders);
			validated.geminiProviders = customApiProvidersToGemini(normalizedCustomApiProviders);
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

		// Preserve real API keys for Gemini providers before deriving the unified array.
		if (validated.geminiProviders) {
			const currentProviders = current.geminiProviders ?? [];
			for (const provider of validated.geminiProviders) {
				if (provider.apiKey?.startsWith("*")) {
					const existing = currentProviders.find((candidate) => candidate.id === provider.id);
					provider.apiKey = existing?.apiKey ?? findExistingCustomApiKey(provider.id);
				}
			}
		}

		if (
			!validated.customApiProviders &&
			(validated.openaiProviders || validated.anthropicProviders || validated.geminiProviders)
		) {
			// Backward compatibility for older frontends that still submit split arrays.
			// Preserve families omitted by the old client, including Gemini providers and their real keys.
			validated.customApiProviders = deriveCustomApiProvidersFromLegacy(
				validated.openaiProviders ?? current.openaiProviders,
				validated.anthropicProviders ?? current.anthropicProviders,
				validated.geminiProviders ?? current.geminiProviders,
			);
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

		// Preserve real API keys and sensitive headers for custom search providers.
		if (validated.search?.customProviders) {
			const currentProviders = current.search?.customProviders ?? [];
			for (const p of validated.search.customProviders) {
				const existing = currentProviders.find((cp) => cp.id === p.id);
				restoreMaskedSearchProvider(p, existing);
			}
		}

		// Deep merge from an isolated snapshot so validation/migration cannot mutate the singleton.
		const merged = structuredClone(current) as NarraForkSettings;
		for (const key of Object.keys(validated) as Array<keyof typeof validated>) {
			const val = validated[key];
			if (
				key === "customApiProviders" ||
				key === "openaiProviders" ||
				key === "anthropicProviders" ||
				key === "nugProviders" ||
				key === "geminiProviders"
			) {
				// Array — replace entirely, don't merge
				// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
				(merged as any)[key] = val;
			} else if (key === "proxy") {
				// Replace entirely so switching modes drops the stale custom url.
				// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
				(merged as any).proxy = val;
			} else if (key === "vnet" && val && typeof val === "object" && !Array.isArray(val)) {
				const vnetPatch = val as NonNullable<NarraForkSettings["vnet"]>;
				merged.vnet = {
					...current.vnet,
					...vnetPatch,
					udp: vnetPatch.udp ? { ...current.vnet?.udp, ...vnetPatch.udp } : current.vnet?.udp,
				} as NarraForkSettings["vnet"];
			} else if (key === "oauth" && val && typeof val === "object" && !Array.isArray(val)) {
				const oauthPatch = val as NonNullable<NarraForkSettings["oauth"]>;
				merged.oauth = {
					...current.oauth,
					...oauthPatch,
					externalWebSocket: oauthPatch.externalWebSocket
						? {
								...current.oauth?.externalWebSocket,
								...oauthPatch.externalWebSocket,
							}
						: current.oauth?.externalWebSocket,
				};
			} else if (val && typeof val === "object" && !Array.isArray(val)) {
				// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
				(merged as any)[key] = { ...(current as any)[key], ...val };
			} else {
				// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
				(merged as any)[key] = val;
			}
		}

		const oauthExternalWebSocketChanged =
			JSON.stringify(current.oauth?.externalWebSocket ?? {}) !==
			JSON.stringify(merged.oauth?.externalWebSocket ?? {});

		normalizeCustomApiProviderSettings(merged);
		normalizeSearchSettings(merged);
		normalizeBrandingSettings(merged);

		const prefixChanges = getProviderPrefixChanges(
			[currentCustomApiProviders, current.nugProviders],
			[merged.customApiProviders, merged.nugProviders],
		);
		if (migrateProviderPrefixReferences(merged, prefixChanges)) {
			logger.info("Migrated model references after provider prefix changes", {
				changes: prefixChanges,
			});
		}
		// This also removes stale settings references; the final save below persists them.
		purgeRemovedProviderCaches(current, merged);
		const prefixPlan = await planProviderPrefixNarratorMigration(prefixChanges);

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

		const vnetChanged = JSON.stringify(oldVNet ?? null) !== JSON.stringify(merged.vnet ?? null);

		let migratedNarrators: Awaited<
			ReturnType<typeof planProviderPrefixNarratorMigration>
		>["narrators"] = [];
		if (prefixChanges.length > 0) {
			migratedNarrators = commitProviderPrefixMigration(current, merged, prefixPlan);
		} else {
			saveSettings(merged);
		}
		// Reconcile client-egress relay channels with the saved NUG provider
		// configs: new local-egress providers connect immediately, removed or
		// reverted providers are torn down (docs/CODEX_CLIENT_RELAY.md).
		reconcileNugRelayClients(merged.nugProviders ?? []);
		if (oauthExternalWebSocketChanged) {
			clearOAuthWsTickets();
			closeAllExternalNarratorConnections(1001, "external WebSocket settings changed");
		}
		if (migratedNarrators.length > 0) {
			const { updateNarratorModel } = await import("../services/narrator-session");
			for (const row of migratedNarrators) {
				if (row.beforeModel !== row.afterModel && row.afterModel) {
					updateNarratorModel(row.id, row.afterModel);
				}
			}
		}

		// Refresh Kimi usage caches when the provider list changed, so a newly
		// added kimi.com/kimi.ai provider shows its quota without waiting for the
		// periodic scheduler. Fire-and-forget: a slow upstream must not delay the
		// settings response.
		if (validated.customApiProviders) {
			void refreshAllKimiUsages().catch(() => {});
		}

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

		const address = needsRestart ? await restartServerForResponse(newHost, newPort) : undefined;
		const newUrl = address
			? buildServerRestartUrl(c.req.url, address.host, address.port, address.protocol === "https")
			: undefined;

		// Observability: record who changed the instance-wide summary model and to
		// what. This setting has been silently rewritten in the field (provider
		// purge, prefix migration, or an admin picker), so log every transition
		// against the admin that triggered the PATCH. `current.agent.summaryModel`
		// is the pre-merge snapshot; `merged.agent.summaryModel` is what landed.
		if (current.agent.summaryModel !== merged.agent.summaryModel) {
			logger.info("Summary model changed via settings PATCH", {
				from: current.agent.summaryModel,
				to: merged.agent.summaryModel,
				userId: c.get("user").sub,
			});
		}

		return c.json(
			buildSettingsResponse(merged, {
				serverRestarting: needsRestart,
				newUrl,
			}),
		);
	}),
);

// Generate a TLS certificate and enable HTTPS.
//
// Compatibility shim over the CA flow in routes/tls.ts: existing clients (and
// the setup wizard) still call this endpoint, so it now issues a CA-signed
// certificate exactly like POST /api/settings/tls/generate, keeping the
// original response shape plus the new SAN fields.
settingsRoutes.post("/generate-tls", requireAdmin, async (c) => {
	const { ensureCa, issueServerCert } = await import("../lib/tls");
	const ca = await ensureCa();
	const result = await issueServerCert();

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

	const address = await restartServerForResponse(merged.server.host, merged.server.port);
	const newUrl = address
		? buildServerRestartUrl(c.req.url, address.host, address.port, address.protocol === "https")
		: undefined;
	return c.json({
		certPath: result.certPath,
		keyPath: result.keyPath,
		expiresAt: result.expiresAt,
		effectiveSans: result.effectiveSans,
		customSans: result.customSans,
		autoSans: result.autoSans,
		caCreated: ca.created,
		caExpiresAt: ca.expiresAt,
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

settingsRoutes.post("/retry-rules", requireAdmin, async (c) => {
	const body = await c.req.json();
	const parsed = addRetryRuleSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	// Store the form the matcher compares against: the raw provider message has no
	// `Error: ` / `[Error] ` display prefix, so a keyword lifted from a rendered
	// error card must be normalized (see shared/retry-rule-keyword.ts).
	const normalizedDomain = parsed.data.domain
		? stripErrorDisplayPrefix(parsed.data.domain) || undefined
		: undefined;
	const normalizedKeyword = parsed.data.keyword
		? stripErrorDisplayPrefix(parsed.data.keyword) || undefined
		: undefined;
	if (!normalizedDomain && !parsed.data.statusCode && !normalizedKeyword) {
		throw new ValidationError("At least one of domain, statusCode, or keyword is required");
	}

	const rule = {
		id: generateShortId(),
		...parsed.data,
		domain: normalizedDomain,
		keyword: normalizedKeyword,
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

const fixProviderBaseUrlSchema = z.object({
	providerId: z.string().min(1),
});

/**
 * Append a `/v1` suffix to a custom API provider's base URL.
 *
 * Triggered from the frontend when a `/v1` fallback succeeded at runtime
 * (broadcast `provider_baseurl_fix_suggested`). The provider is located by its
 * stable `providerId`; the suggested URL is recomputed server-side from the
 * provider's CURRENT base URL (we never trust a client-supplied URL). Persists
 * to `customApiProviders` and re-derives the legacy openai/anthropic arrays so
 * all three stay consistent.
 */
settingsRoutes.post("/fix-provider-baseurl", requireAdmin, async (c) => {
	const body = await c.req.json();
	const parsed = fixProviderBaseUrlSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const current = settings;
	const customApiProviders =
		current.customApiProviders ??
		deriveCustomApiProvidersFromLegacy(
			current.openaiProviders,
			current.anthropicProviders,
			current.geminiProviders,
		);

	const target = customApiProviders.find((p) => p.id === parsed.data.providerId);
	if (!target) {
		throw new ValidationError(`Provider "${parsed.data.providerId}" not found.`);
	}

	const normalized = (target.baseUrl || "").replace(/\/+$/, "");
	if (/\/v1\/?$/i.test(normalized)) {
		// Already has /v1 — nothing to fix (idempotent).
		return c.json({ ok: true, providerId: target.id, baseUrl: target.baseUrl });
	}
	const newBaseUrl = `${normalized}/v1`;

	const nextCustomApiProviders = customApiProviders.map((p) =>
		p.id === target.id ? { ...p, baseUrl: newBaseUrl } : p,
	);

	const merged: NarraForkSettings = {
		...current,
		customApiProviders: nextCustomApiProviders,
		openaiProviders: customApiProvidersToOpenAI(nextCustomApiProviders),
		anthropicProviders: customApiProvidersToAnthropic(nextCustomApiProviders),
		geminiProviders: customApiProvidersToGemini(nextCustomApiProviders),
	};
	saveSettings(merged);

	logger.info("Provider base URL fixed with /v1 suffix", {
		providerId: target.id,
		prefix: target.prefix,
		oldBaseUrl: target.baseUrl,
		newBaseUrl,
	});

	return c.json({ ok: true, providerId: target.id, baseUrl: newBaseUrl });
});

const disableCodexImageGenerationSchema = z.object({
	/**
	 * The provider prefix, or a full `prefix:model` reference (the failing
	 * narrator's runtime model). Never the flag value: the target is resolved and
	 * the write decided server-side.
	 */
	model: z.string().min(1).max(200),
});

/**
 * Turn off the native `image_generation` tool for the provider that just failed
 * with "Image generation is not enabled".
 *
 * Offered as a one-click fix on the narrator error card: NarraFork injects that
 * server-side tool by default, so on an upstream that does not license it every
 * turn dies before producing a token, and the setting that fixes it is buried in
 * provider settings. See `services/codex-image-generation-fix.ts` for why the
 * target cannot simply be a settings path.
 */
settingsRoutes.post("/disable-codex-image-generation", requireAdmin, async (c) => {
	const body = await c.req.json();
	const parsed = disableCodexImageGenerationSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	try {
		const result = disableCodexImageGenerationForPrefix(parsed.data.model);
		return c.json({ ok: true, ...result });
	} catch (err) {
		if (err instanceof CodexImageGenerationFixError) {
			throw new ValidationError(err.message);
		}
		throw err;
	}
});
