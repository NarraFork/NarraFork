import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { type NugBillingOrderResponse, NugProvider } from "../lib/agent/nug-provider";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";
import {
	deleteNugCachedModels,
	getNugCachedModelsByProvider,
	type NugModelInfo,
	saveAllCachedNugModels,
} from "../lib/nug-model-cache";
import {
	NUG_MODEL_REFRESH_COOLDOWN_MS,
	nugModelRefreshCoordinator,
} from "../lib/nug-model-refresh-coordinator";
import { applyNugModelCatalogUpdate } from "../lib/nug-model-sync";
import {
	buildNugQuotaCache,
	type CapturedNugQuotaSubject,
	captureNugQuotaSubject,
	fetchNugQuota,
	getAllNugCachedQuotas,
	getNugCachedQuota,
	getNugQuotaSnapshot,
	type NugQuotaCache,
	normalizeNugQuotaResponse,
	nugQuotaIdentity,
	purgeNugQuotaCache,
	setNugCachedQuota,
	updateNugQuotaByPrefix,
} from "../lib/nug-quota-cache";
import { getNugRelayStatus } from "../lib/nug-relay/manager";
import { getProviderKeyStore, nugKeyOwner, withProviderKey } from "../lib/provider-keys";
import {
	type NUGProviderConfig,
	nugProviderPrefix,
	registerNugModelChecker,
	registerNugModelLister,
	saveSettings,
	settings,
} from "../lib/settings";
import { registerModelListReader } from "../lib/sourcing/model-list-readers";
import { sourceGroupForConnection } from "../lib/sourcing/source-groups";
import { getServiceTemplate } from "../lib/sourcing/templates";
import { spaRedirectLocation } from "../lib/spa-base-href";
import { requireSessionAuth } from "../middleware/auth";

export const nugRoutes = new Hono();
export { getAllNugCachedQuotas, getNugCachedQuota, updateNugQuotaByPrefix };

registerModelListReader("nug", (group) => getNugCachedModelsByProvider(group.id));

function normalizeNugBaseUrl(baseUrl: string | undefined): string {
	return (baseUrl ?? "")
		.trim()
		.replace(/\/+$/, "")
		.replace(/\/(?:api\/v1|api|v1)$/i, "");
}

function getNugProvider(id: string): {
	config: NUGProviderConfig;
	provider: NugProvider;
	quotaSubject: CapturedNugQuotaSubject;
} | null {
	const configured = (settings.nugProviders ?? []).find((p) => p.id === id);
	if (!configured) return null;
	const quotaSubject = captureNugQuotaSubject(configured);
	return {
		config: quotaSubject.config,
		provider: new NugProvider(quotaSubject.config),
		quotaSubject,
	};
}

const NUG_BILLING_BINDING_TTL = 24 * 60 * 60_000;
const MAX_NUG_BILLING_BINDINGS = 500;
const MAX_NUG_BILLING_BINDINGS_PER_USER = 50;
interface NugBillingBinding {
	owner: string;
	providerId: string;
	credentialId: string;
	storedCredential: boolean;
	/** Hash only: never retain another long-lived copy of a secret or config. */
	identityHash: string;
	orderId?: string;
	expiresAt: number;
}
const nugBillingBindings = new Map<string, NugBillingBinding>();

function nugBillingSubject(providerId: string, binding?: NugBillingBinding) {
	const connection = (settings.nugProviders ?? []).find((provider) => provider.id === providerId);
	if (!connection)
		throw new AppError(
			"NUG payment connection is unavailable",
			binding ? 409 : 404,
			"NUG_PAYMENT_CONTEXT",
		);
	if (connection.disabled)
		throw new AppError("NUG payment connection is disabled", 409, "NUG_PAYMENT_CONTEXT");
	const keys = getProviderKeyStore().list(nugKeyOwner(providerId));
	const key = binding
		? binding.storedCredential
			? keys.find((entry) => entry.id === binding.credentialId)
			: undefined
		: keys.find((entry) => !entry.disabled);
	if (
		(binding?.storedCredential && !key) ||
		(binding && !binding.storedCredential && keys.length) ||
		key?.disabled ||
		(!key && keys.length)
	) {
		throw new AppError(
			"NUG payment credential changed or is unavailable",
			409,
			"NUG_PAYMENT_CONTEXT",
		);
	}
	const config = structuredClone(key ? withProviderKey(connection, key) : connection);
	if (!config.apiKey?.trim())
		throw new AppError("NUG payment credential is unavailable", 409, "NUG_PAYMENT_CONTEXT");
	return {
		config,
		connection,
		credentialId: key?.id ?? providerId,
		storedCredential: !!key,
		identityHash: createHash("sha256").update(nugQuotaIdentity(config)).digest("hex"),
	};
}

function pruneNugBillingBindings(): void {
	const now = Date.now();
	for (const [token, binding] of nugBillingBindings) {
		if (binding.expiresAt <= now) nugBillingBindings.delete(token);
	}
}

function reserveNugBillingBinding(
	owner: string,
	providerId: string,
	subject: ReturnType<typeof nugBillingSubject>,
) {
	pruneNugBillingBindings();
	if (
		nugBillingBindings.size >= MAX_NUG_BILLING_BINDINGS ||
		[...nugBillingBindings.values()].filter((binding) => binding.owner === owner).length >=
			MAX_NUG_BILLING_BINDINGS_PER_USER
	) {
		throw new AppError(
			"Too many NUG payment sessions; try again after older sessions expire",
			429,
			"NUG_PAYMENT_LIMIT",
		);
	}
	let token = randomBytes(32).toString("base64url");
	while (nugBillingBindings.has(token)) token = randomBytes(32).toString("base64url");
	const binding: NugBillingBinding = {
		owner,
		providerId,
		credentialId: subject.credentialId,
		storedCredential: subject.storedCredential,
		identityHash: subject.identityHash,
		expiresAt: Date.now() + NUG_BILLING_BINDING_TTL,
	};
	nugBillingBindings.set(token, binding);
	return { token, binding };
}

function currentNugBillingSubject(token: string, binding: NugBillingBinding) {
	if (nugBillingBindings.get(token) !== binding || binding.expiresAt <= Date.now()) {
		nugBillingBindings.delete(token);
		throw new AppError(
			"NUG payment session expired or is unavailable; create a new order",
			409,
			"NUG_PAYMENT_CONTEXT",
		);
	}
	try {
		const subject = nugBillingSubject(binding.providerId, binding);
		if (subject.identityHash !== binding.identityHash) throw new Error("changed");
		return subject;
	} catch {
		nugBillingBindings.delete(token);
		throw new AppError(
			"NUG payment credential or connection changed; create a new order",
			409,
			"NUG_PAYMENT_CONTEXT",
		);
	}
}

function ownedNugBillingBinding(
	owner: string,
	providerId: string,
	orderId: string,
	token: string | undefined,
) {
	if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
		throw new AppError(
			"NUG payment binding is required; create a new order",
			409,
			"NUG_PAYMENT_CONTEXT",
		);
	pruneNugBillingBindings();
	const binding = nugBillingBindings.get(token);
	if (
		!binding ||
		binding.owner !== owner ||
		binding.providerId !== providerId ||
		binding.orderId !== orderId
	) {
		throw new AppError("NUG payment session not found or expired", 404, "NUG_PAYMENT_CONTEXT");
	}
	return { binding, token, subject: currentNugBillingSubject(token, binding) };
}

function boundNugBillingResponse(
	data: NugBillingOrderResponse,
	token: string,
	expectedOrderId?: string,
) {
	if (
		!data?.order ||
		typeof data.order.id !== "string" ||
		!data.order.id ||
		data.order.id.length > 300 ||
		(expectedOrderId !== undefined && data.order.id !== expectedOrderId)
	) {
		throw new AppError("Invalid NUG billing order response", 502, "NUG_PAYMENT_RESPONSE");
	}
	return { ...data, order: { ...data.order, binding: token } };
}

type NugUsageRecord = Record<string, unknown>;

const USAGE_RESPONSE_STANDARD_KEYS = new Set([
	"id",
	"requestId",
	"request_id",
	"channelType",
	"channel_type",
	"channel",
	"provider",
	"providerType",
	"model",
	"model_id",
	"modelId",
	"modelName",
	"inputTokens",
	"input_tokens",
	"promptTokens",
	"prompt_tokens",
	"tokensIn",
	"tokens_in",
	"outputTokens",
	"output_tokens",
	"completionTokens",
	"completion_tokens",
	"cacheCreationInputTokens",
	"cache_creation_input_tokens",
	"cacheCreationTokens",
	"cache_creation_tokens",
	"cacheWriteInputTokens",
	"cache_write_input_tokens",
	"cacheWriteTokens",
	"cache_write_tokens",
	"cacheReadInputTokens",
	"cache_read_input_tokens",
	"cachedInputTokens",
	"cached_input_tokens",
	"cacheReadTokens",
	"cache_read_tokens",
	"reasoningTokens",
	"reasoning_tokens",
	"quotaCost",
	"quota_cost",
	"cost",
	"quota",
	"meterUsage",
	"meter_usage",
	"meter",
	"usageAmount",
	"status",
	"state",
	"durationMs",
	"duration_ms",
	"latencyMs",
	"latency_ms",
	"createdAt",
	"created_at",
	"timestamp",
	"time",
	"extra",
	"metadata",
	"usage",
	"usageData",
]);

const USAGE_EXTRA_MAX_FIELDS = 12;
const USAGE_EXTRA_VALUE_MAX_CHARS = 300;
const USAGE_EXTRA_KEY_MAX_CHARS = 80;

function optionalRecord(value: unknown): NugUsageRecord | null {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as NugUsageRecord;
	}
	if (typeof value === "string" && value.trim().startsWith("{")) {
		try {
			const parsed = JSON.parse(value) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as NugUsageRecord;
			}
		} catch {
			return null;
		}
	}
	return null;
}

function toRecord(value: unknown): NugUsageRecord {
	return optionalRecord(value) ?? {};
}

function usageRecordSources(record: NugUsageRecord): NugUsageRecord[] {
	const sources: NugUsageRecord[] = [record];
	const append = (value: unknown) => {
		const parsed = optionalRecord(value);
		if (parsed) sources.push(parsed);
		return parsed;
	};
	const extra = append(record.extra);
	const metadata = append(record.metadata);
	const usage = append(record.usage);
	append(record.usageData);
	append(extra?.usage);
	append(extra?.metadata);
	append(metadata?.usage);
	append(metadata?.extra);
	append(usage?.extra);
	return sources;
}

function numericField(
	records: NugUsageRecord | NugUsageRecord[],
	keys: string[],
	fallback = 0,
): number {
	const sources = Array.isArray(records) ? records : [records];
	for (const record of sources) {
		for (const key of keys) {
			const value = record[key];
			const numberValue =
				typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
			if (Number.isFinite(numberValue)) return numberValue;
		}
	}
	return fallback;
}

function stringField(
	records: NugUsageRecord | NugUsageRecord[],
	keys: string[],
	fallback = "",
): string {
	const sources = Array.isArray(records) ? records : [records];
	for (const record of sources) {
		for (const key of keys) {
			const value = record[key];
			if (typeof value === "string" && value.length > 0) return value;
			if (typeof value === "number" && Number.isFinite(value)) return String(value);
		}
	}
	return fallback;
}

function isSensitiveUsageExtraKey(key: string): boolean {
	const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
	return [
		"apikey",
		"authorization",
		"token",
		"secret",
		"password",
		"credential",
		"cookie",
		"session",
		"raw",
		"dump",
		"body",
		"headers",
		"prompt",
		"completion",
		"content",
	].some((needle) => normalized.includes(needle));
}

function sanitizeUsageExtraValue(value: unknown): string | number | boolean | null {
	if (value == null) return null;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "boolean") return value;
	let text: string;
	if (typeof value === "string") {
		text = value.trim();
	} else {
		try {
			text = JSON.stringify(value);
		} catch {
			return null;
		}
	}
	if (!text) return null;
	return text.length > USAGE_EXTRA_VALUE_MAX_CHARS
		? `${text.slice(0, USAGE_EXTRA_VALUE_MAX_CHARS)}…`
		: text;
}

function collectSafeUsageExtra(
	record: NugUsageRecord,
): Record<string, string | number | boolean> | null {
	const extra: Record<string, string | number | boolean> = {};
	const addRecord = (source: NugUsageRecord | null, prefix = "") => {
		if (!source || Object.keys(extra).length >= USAGE_EXTRA_MAX_FIELDS) return;
		for (const [key, value] of Object.entries(source)) {
			if (Object.keys(extra).length >= USAGE_EXTRA_MAX_FIELDS) break;
			if (value == null || USAGE_RESPONSE_STANDARD_KEYS.has(key) || isSensitiveUsageExtraKey(key)) {
				continue;
			}
			const label = (prefix ? `${prefix}.${key}` : key).slice(0, USAGE_EXTRA_KEY_MAX_CHARS);
			if (extra[label] !== undefined) continue;
			const sanitized = sanitizeUsageExtraValue(value);
			if (sanitized != null) extra[label] = sanitized;
		}
	};
	const parsedExtra = optionalRecord(record.extra);
	const parsedMetadata = optionalRecord(record.metadata);
	const parsedUsage = optionalRecord(record.usage);
	addRecord(record);
	addRecord(parsedExtra);
	addRecord(optionalRecord(parsedExtra?.usage), "usage");
	addRecord(optionalRecord(parsedExtra?.metadata), "metadata");
	addRecord(parsedMetadata, "metadata");
	addRecord(optionalRecord(parsedMetadata?.usage), "metadata.usage");
	addRecord(parsedUsage, "usage");
	addRecord(optionalRecord(record.usageData), "usageData");
	return Object.keys(extra).length > 0 ? extra : null;
}

function normalizeNugUsageEvent(value: unknown, index: number): NugUsageRecord {
	const record = toRecord(value);
	const sources = usageRecordSources(record);
	const safeExtra = collectSafeUsageExtra(record);
	return {
		id: stringField(sources, ["id", "requestId", "request_id"], `usage-${index}`),
		channelType: stringField(
			sources,
			["channelType", "channel_type", "channel", "provider", "providerType"],
			"unknown",
		),
		model: stringField(sources, ["model", "model_id", "modelId", "modelName"]),
		inputTokens: numericField(sources, [
			"inputTokens",
			"input_tokens",
			"promptTokens",
			"prompt_tokens",
			"tokensIn",
			"tokens_in",
		]),
		outputTokens: numericField(sources, [
			"outputTokens",
			"output_tokens",
			"completionTokens",
			"completion_tokens",
		]),
		cacheCreationInputTokens: numericField(sources, [
			"cacheCreationInputTokens",
			"cache_creation_input_tokens",
			"cacheCreationTokens",
			"cache_creation_tokens",
			"cacheWriteInputTokens",
			"cache_write_input_tokens",
			"cacheWriteTokens",
			"cache_write_tokens",
		]),
		cacheReadInputTokens: numericField(sources, [
			"cacheReadInputTokens",
			"cache_read_input_tokens",
			"cachedInputTokens",
			"cached_input_tokens",
			"cacheReadTokens",
			"cache_read_tokens",
		]),
		reasoningTokens: numericField(sources, ["reasoningTokens", "reasoning_tokens"]),
		quotaCost: numericField(sources, ["quotaCost", "quota_cost", "cost", "quota"]),
		meterUsage: numericField(sources, ["meterUsage", "meter_usage", "meter", "usageAmount"]),
		status: stringField(sources, ["status", "state"], "unknown"),
		durationMs: numericField(sources, ["durationMs", "duration_ms", "latencyMs", "latency_ms"]),
		createdAt: stringField(sources, ["createdAt", "created_at", "timestamp", "time"]),
		...(safeExtra ? { extra: safeExtra } : {}),
	};
}

function normalizeNugUsageResponse(value: unknown): NugUsageRecord {
	const record = toRecord(value);
	const rawEvents = Array.isArray(record.events)
		? record.events
		: Array.isArray(record.data)
			? record.data
			: [];
	const events = rawEvents.map((event, index) => normalizeNugUsageEvent(event, index));
	return {
		events,
		total: numericField(record, ["total", "count"], events.length),
	};
}

/** Fetch quota for all configured NUG providers (called on startup). */
export async function fetchAllNugQuotas(): Promise<void> {
	const providers = settings.nugProviders ?? [];
	await Promise.allSettled(
		providers.map(async (p) => {
			const quotaSubject = captureNugQuotaSubject(p);
			const data = await fetchNugQuota(quotaSubject.config);
			if (data) {
				setNugCachedQuota(p.id, buildNugQuotaCache(data, getNugCachedQuota(p.id)), quotaSubject);
				logger.debug("NUG quota fetched on startup", {
					provider: p.name,
					balance: data.balance,
				});
			}
		}),
	);
}

/** Remove cached models and quotas for providers that no longer exist in settings. */
export function purgeNugProviderCache(removedIds: string[]): void {
	let changed = false;
	for (const id of removedIds) {
		if (deleteNugCachedModels(id)) changed = true;
	}
	purgeNugQuotaCache(removedIds);
	if (changed) saveAllCachedNugModels();
}

function getActiveNugCachedModels(): NugModelInfo[] {
	const seen = new Set<string>();
	const result: NugModelInfo[] = [];
	for (const provider of settings.nugProviders ?? []) {
		if (provider.disabled) continue;
		for (const model of getNugCachedModelsByProvider(provider.id)) {
			const id = String(model.id ?? "");
			if (!id || seen.has(id)) continue;
			seen.add(id);
			result.push(model);
		}
	}
	return result;
}

// Register model checker and lister
registerNugModelChecker((model) => {
	return getActiveNugCachedModels().some((m) => String(m.id ?? "") === model);
});

registerNugModelLister(() => {
	const result: string[] = [];
	const providers = settings.nugProviders ?? [];
	for (const p of providers) {
		if (p.disabled) continue;
		const prefix = nugProviderPrefix(p);
		const models = getNugCachedModelsByProvider(p.id);
		for (const m of models) {
			result.push(`${prefix}:${String(m.id ?? "")}`);
		}
	}
	return result;
});

/** Fetch models from NUG service (/v1/models endpoint). */
async function fetchNugModels(
	config: NUGProviderConfig,
): Promise<{ models: NugModelInfo[]; modelHash?: string; usdRate?: number }> {
	const baseUrl = normalizeNugBaseUrl(config.baseUrl);
	if (!baseUrl) {
		throw new Error(`NUG base URL not configured for provider "${config.name}"`);
	}
	if (!config.apiKey) {
		throw new Error(`NUG API key not configured for provider "${config.name}"`);
	}

	const provider = new NugProvider(config);
	const json = await provider.getModels();
	const models = (json.models ?? []) as NugModelInfo[];
	const modelHash =
		typeof json.modelHash === "string"
			? json.modelHash
			: typeof json.hash === "string"
				? json.hash
				: undefined;
	const usdRate = typeof json.usdRate === "number" ? json.usdRate : undefined;

	const seen = new Set<string>();
	const unique = models.filter((m) => {
		const id = String(m.id ?? "");
		if (!id || seen.has(id)) return false;
		seen.add(id);
		return true;
	});
	unique.sort((a, b) => {
		const aId = String(a.id ?? "");
		const bId = String(b.id ?? "");
		return aId.localeCompare(bId);
	});
	return { models: unique, modelHash, usdRate };
}

function nugUsagePeriod(range: string | undefined): string {
	const periodMap: Record<string, string> = {
		today: "today",
		"7days": "7days",
		"30days": "month",
		month: "month",
		all: "all",
	};
	return periodMap[range ?? ""] ?? "month";
}

// === Routes ===

nugRoutes.get("/models", (c) => {
	return c.json({ models: getActiveNugCachedModels(), fromCache: true });
});

// Client-egress relay status per provider (docs/CODEX_CLIENT_RELAY.md). The
// settings page polls this to show whether a provider's local egress channel
// is actually online; "disabled" means the provider uses NUG-direct egress.
nugRoutes.get("/relay-status", (c) => {
	const providers = settings.nugProviders ?? [];
	const result: Record<
		string,
		{ status: "disabled" | "offline" | "connecting" | "online"; egressMode: string }
	> = {};
	for (const p of providers) {
		const egressMode = p.egressMode ?? "nug";
		result[p.id] = {
			egressMode,
			status: egressMode === "nug" ? "disabled" : getNugRelayStatus(p.id),
		};
	}
	return c.json(result);
});

nugRoutes.post("/models/refresh", async (c) => {
	const providers = settings.nugProviders ?? [];
	const results: Array<{
		providerId: string;
		name: string;
		count: number;
		modelHash?: string;
		error?: string;
	}> = [];
	let changedContextWindows = false;
	for (const p of providers) {
		try {
			const { models, modelHash, usdRate } = await fetchNugModels(p);
			const applied = applyNugModelCatalogUpdate(p, models, modelHash, {
				saveCache: false,
				saveSettingsOnContextChange: false,
				usdRate,
			});
			changedContextWindows = applied.changedContextWindows || changedContextWindows;
			results.push({ providerId: p.id, name: p.name, count: applied.models.length, modelHash });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : "Unknown error";
			logger.error("NUG listModels refresh failed", { error: msg, provider: p.name });
			results.push({ providerId: p.id, name: p.name, count: 0, error: msg });
		}
	}
	saveAllCachedNugModels();
	if (changedContextWindows) saveSettings(settings);
	return c.json({
		results,
		models: getActiveNugCachedModels(),
		fromCache: false,
	});
});

/**
 * Opportunistic refresh used when a model picker opens.
 *
 * Unlike `/models/refresh` (an explicit user action that always hits upstream),
 * this is rate-limited by a process-wide cooldown so every tab, panel and user
 * opening a picker cannot multiply into upstream traffic. The response carries
 * only status/counters — clients re-read the catalog from `/api/settings`, which
 * keeps this endpoint off the "list APIs must not return big fields" path.
 */
nugRoutes.post("/models/refresh-if-stale", async (c) => {
	const results = await nugModelRefreshCoordinator.refreshAllIfStale(settings.nugProviders ?? []);
	return c.json({
		results,
		refreshed: results.some((r) => r.attempted && !r.error),
		cooldownMs: NUG_MODEL_REFRESH_COOLDOWN_MS,
	});
});

nugRoutes.get("/providers/:id/models", async (c) => {
	const id = c.req.param("id");
	const config = (settings.nugProviders ?? []).find((provider) => provider.id === id);
	const group = sourceGroupForConnection(
		{ id, name: config?.name ?? id, ...config, prefix: config ? nugProviderPrefix(config) : id },
		"nug",
	);
	return c.json({
		models: await getServiceTemplate(group.templateId).listModels(
			group,
			undefined,
			c.req.raw.signal,
		),
		fromCache: true,
	});
});

nugRoutes.post("/providers/:id/models/refresh", async (c) => {
	const id = c.req.param("id");
	const providers = settings.nugProviders ?? [];
	const config = providers.find((p) => p.id === id);
	if (!config) {
		return c.json({ error: `Provider "${id}" not found` }, 404);
	}
	try {
		const { models, modelHash, usdRate } = await fetchNugModels(config);
		const applied = applyNugModelCatalogUpdate(config, models, modelHash, { usdRate });
		return c.json({
			models: applied.models,
			fromCache: false,
			modelHash: applied.modelHash,
		});
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : "Unknown error";
		logger.error("NUG listModels refresh failed", { error: msg, provider: config.name });
		return c.json({ error: msg }, 500);
	}
});

/** Proxy channel health status from NUG service. */
nugRoutes.get("/providers/:id/channels/health", async (c) => {
	const entry = getNugProvider(c.req.param("id"));
	if (!entry) return c.json({ error: `Provider "${c.req.param("id")}" not found` }, 404);
	try {
		const data = await entry.provider.getChannelsHealth();
		return c.json(data);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : "Unknown error";
		logger.error("NUG channels/health fetch failed", { error: msg, provider: entry.config.name });
		return c.json({ error: msg }, 502);
	}
});

/**
 * Payment confirmation only: NugRechargeDialog re-reads this after an order becomes paid,
 * then resumes the paused narrator. It must remain available to ordinary session users,
 * like the billing/order endpoints; ordinary quota displays use /api/quota-snapshots.
 */
nugRoutes.get("/providers/:id/quota", async (c) => {
	const id = c.req.param("id");
	if (c.req.query("binding") !== undefined || c.req.query("orderId") !== undefined) {
		await requireSessionAuth(c, async () => {});
		try {
			const bound = ownedNugBillingBinding(
				c.get("user").sub,
				id,
				c.req.query("orderId") ?? "",
				c.req.query("binding"),
			);
			const provider = new NugProvider(bound.subject.config, bound.subject.connection);
			const data = (await provider.getQuota()) as unknown as Record<string, unknown>;
			const current = currentNugBillingSubject(bound.token, bound.binding);
			const primary = captureNugQuotaSubject(current.connection);
			const paymentCredentialIsPrimary =
				primary.id === bound.binding.credentialId &&
				createHash("sha256").update(primary.identity).digest("hex") === bound.binding.identityHash;
			// Route through the source owner with A's captured CID even when B is now primary.
			// Never merge B's previous balance or legacy-normalized zeroes into A's probe.
			setNugCachedQuota(
				id,
				buildNugQuotaCache(data, paymentCredentialIsPrimary ? getNugCachedQuota(id) : undefined),
				{
					id: bound.binding.credentialId,
					providerId: id,
					config: bound.subject.config,
					identity: nugQuotaIdentity(bound.subject.config),
				},
			);
			return c.json({ ...normalizeNugQuotaResponse(data), paymentCredentialIsPrimary });
		} catch (err) {
			if (err instanceof AppError) throw err;
			logger.error("NUG payment balance fetch failed", { providerId: id });
			return c.json({ error: "NUG payment balance fetch failed" }, 502);
		}
	}
	const entry = getNugProvider(id);
	if (!entry) return c.json({ error: "quota_subject_not_found" }, 404);
	try {
		const data = (await entry.provider.getQuota(AbortSignal.timeout(15_000))) as unknown as Record<
			string,
			unknown
		>;
		const previous = getNugQuotaSnapshot(id, entry.quotaSubject.id)?.snapshot?.detail as
			| NugQuotaCache
			| undefined;
		setNugCachedQuota(id, buildNugQuotaCache(data, previous), entry.quotaSubject);
		const response = normalizeNugQuotaResponse(data);
		// Keep the payment consumer's contract, not the template-private upstream payload.
		return c.json({
			balance: response.balance,
			totalGranted: response.totalGranted,
			detailedQuotaBalance: response.detailedQuotaBalance,
		});
	} catch {
		return c.json({ error: "quota_unavailable" }, 502);
	}
});

// Match the application's first-party gate even when this router is mounted alone.
// Keep ordinary session users' existing payment access; do not add an admin-only gate.
nugRoutes.use("/providers/:id/billing/orders", requireSessionAuth);
nugRoutes.use("/providers/:id/billing/orders/*", requireSessionAuth);

/** Proxy billing config from NUG service. */
nugRoutes.get("/providers/:id/billing/config", async (c) => {
	const id = c.req.param("id");
	try {
		// The config and a new order must speak for the same first enabled credential.
		const subject = nugBillingSubject(id);
		const identity = nugQuotaIdentity(subject.config);
		const provider = new NugProvider(subject.config, subject.connection);
		const data = (await provider.getBillingConfig()) as unknown as Record<string, unknown>;
		const primary = captureNugQuotaSubject(subject.connection);
		const existing =
			primary.id === subject.credentialId && primary.identity === identity
				? getNugCachedQuota(id)
				: undefined;
		setNugCachedQuota(id, buildNugQuotaCache(data, existing), {
			id: subject.credentialId,
			providerId: id,
			config: subject.config,
			identity,
		});
		return c.json(normalizeNugQuotaResponse(data));
	} catch (err: unknown) {
		if (err instanceof AppError) throw err;
		logger.error("NUG billing config fetch failed", { providerId: id });
		return c.json({ error: "NUG billing config fetch failed" }, 502);
	}
});

/** Create under one captured CID; only the random binding leaves this server. */
nugRoutes.post("/providers/:id/billing/orders", async (c) => {
	const id = c.req.param("id");
	let token: string | undefined;
	try {
		const body = (await c.req.json()) as { amount?: number; provider?: string; channel?: string };
		const amount = Number(body.amount);
		if (!Number.isFinite(amount) || amount <= 0)
			return c.json({ error: "amount must be greater than 0" }, 400);
		if (typeof body.provider !== "string" || !body.provider.trim())
			return c.json({ error: "provider is required" }, 400);
		if (body.channel !== undefined && typeof body.channel !== "string")
			return c.json({ error: "invalid channel" }, 400);
		const subject = nugBillingSubject(id);
		const reserved = reserveNugBillingBinding(c.get("user").sub, id, subject);
		token = reserved.token;
		const provider = new NugProvider(subject.config, subject.connection);
		const data = await provider.createBillingOrder({
			amount,
			provider: body.provider,
			channel: body.channel,
		});
		// Never publish a QR/URL for a subject that changed during the gateway call.
		currentNugBillingSubject(token, reserved.binding);
		const response = boundNugBillingResponse(data, token);
		reserved.binding.orderId = response.order.id;
		return c.json(response, 201);
	} catch (err: unknown) {
		if (token) nugBillingBindings.delete(token);
		if (err instanceof AppError) throw err;
		logger.error("NUG billing order create failed", { providerId: id });
		return c.json({ error: "NUG billing order create failed" }, 502);
	}
});

/** Poll only the creating user's live CID, never today's first key. */
nugRoutes.get("/providers/:id/billing/orders/:orderId", async (c) => {
	const id = c.req.param("id");
	const orderId = c.req.param("orderId");
	try {
		const bound = ownedNugBillingBinding(c.get("user").sub, id, orderId, c.req.query("binding"));
		const provider = new NugProvider(bound.subject.config, bound.subject.connection);
		const data = await provider.getBillingOrder(orderId);
		currentNugBillingSubject(bound.token, bound.binding);
		return c.json(boundNugBillingResponse(data, bound.token, orderId));
	} catch (err: unknown) {
		if (err instanceof AppError) throw err;
		logger.error("NUG billing order fetch failed", { providerId: id });
		return c.json({ error: "NUG billing order fetch failed" }, 502);
	}
});

/** Refresh a pay URL under the same creating subject and local session owner. */
nugRoutes.post("/providers/:id/billing/orders/:orderId/repay", async (c) => {
	const id = c.req.param("id");
	const orderId = c.req.param("orderId");
	try {
		const bound = ownedNugBillingBinding(c.get("user").sub, id, orderId, c.req.query("binding"));
		const provider = new NugProvider(bound.subject.config, bound.subject.connection);
		const data = await provider.repayBillingOrder(orderId);
		currentNugBillingSubject(bound.token, bound.binding);
		return c.json(boundNugBillingResponse(data, bound.token, orderId));
	} catch (err: unknown) {
		if (err instanceof AppError) throw err;
		logger.error("NUG billing order repay failed", { providerId: id });
		return c.json({ error: "NUG billing order repay failed" }, 502);
	}
});

/** Proxy usage records from NUG service. */
nugRoutes.get("/providers/:id/usage", async (c) => {
	const entry = getNugProvider(c.req.param("id"));
	if (!entry) return c.json({ error: `Provider "${c.req.param("id")}" not found` }, 404);
	const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
	const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
	const period = nugUsagePeriod(c.req.query("range"));
	try {
		const data = await entry.provider.getUsage(limit, offset, period);
		return c.json(normalizeNugUsageResponse(data));
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : "Unknown error";
		logger.error("NUG usage fetch failed", { error: msg, provider: entry.config.name });
		return c.json({ error: msg }, 502);
	}
});

/** Proxy usage summary from NUG service. */
nugRoutes.get("/providers/:id/usage/summary", async (c) => {
	const entry = getNugProvider(c.req.param("id"));
	if (!entry) return c.json({ error: `Provider "${c.req.param("id")}" not found` }, 404);
	// Frontend sends `range` (today/7days/30days/all), NUG expects `period` (today/7days/month/all)
	const range = c.req.query("range") ?? "month";
	const periodMap: Record<string, string> = {
		today: "today",
		"7days": "7days",
		"30days": "month",
		month: "month",
		all: "all",
	};
	const period = periodMap[range] ?? "month";
	try {
		const raw = (await entry.provider.getUsageSummary(period)) as Record<string, unknown>;
		// NUG returns snake_case fields with string numeric values; convert to camelCase numbers
		const data = {
			requestCount: Number(raw.request_count ?? raw.requestCount ?? 0),
			totalMeterUsage: Number(raw.total_meter_usage ?? raw.totalMeterUsage ?? 0),
			totalQuotaCost: Number(raw.total_quota_cost ?? raw.totalQuotaCost ?? 0),
			totalInputTokens: Number(raw.total_input_tokens ?? raw.totalInputTokens ?? 0),
			totalOutputTokens: Number(raw.total_output_tokens ?? raw.totalOutputTokens ?? 0),
			totalCacheWriteTokens: Number(raw.total_cache_write_tokens ?? raw.totalCacheWriteTokens ?? 0),
			totalCacheReadTokens: Number(raw.total_cache_read_tokens ?? raw.totalCacheReadTokens ?? 0),
		};
		return c.json(data);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : "Unknown error";
		logger.error("NUG usage/summary fetch failed", { error: msg, provider: entry.config.name });
		return c.json({ error: msg }, 502);
	}
});

/** Proxy NUG login — authenticate with NUG, then create an API key in one step. */
nugRoutes.post("/providers/:id/login", async (c) => {
	const id = c.req.param("id");
	const providers = settings.nugProviders ?? [];
	const config = providers.find((p) => p.id === id);
	if (!config) return c.json({ error: `Provider "${id}" not found` }, 404);

	const baseUrl = normalizeNugBaseUrl(config.baseUrl);
	if (!baseUrl) return c.json({ error: "Provider base URL not configured" }, 400);

	const body = await c.req.json();
	const { username, password } = body as { username?: string; password?: string };
	if (!username || !password) {
		return c.json({ error: "Missing username or password" }, 400);
	}

	try {
		// Step 1: Login to get session cookie
		const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username, password }),
		});
		if (!loginResponse.ok) {
			const errText = await loginResponse.text().catch(() => "");
			return c.json({ error: `NUG login failed: ${errText}` }, 502);
		}

		// Extract session cookie from Set-Cookie header
		const setCookieHeader = loginResponse.headers.get("set-cookie") ?? "";
		const sessionMatch = setCookieHeader.match(/nug_session=([^;]+)/);
		const sessionToken = sessionMatch?.[1];
		if (!sessionToken) {
			return c.json({ error: "NUG login succeeded but no session cookie received" }, 502);
		}

		const loginData = (await loginResponse.json()) as { user?: Record<string, unknown> };

		// Step 2: Create API key using the session cookie
		const apiKeyResponse = await fetch(`${baseUrl}/api/api-keys`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Cookie: `nug_session=${sessionToken}`,
			},
			body: JSON.stringify({ name: `narrafork-${Date.now()}` }),
		});
		if (!apiKeyResponse.ok) {
			const errText = await apiKeyResponse.text().catch(() => "");
			return c.json({ error: `NUG API key creation failed: ${errText}` }, 502);
		}

		const apiKeyData = (await apiKeyResponse.json()) as { apiKey?: string };
		return c.json({ apiKey: apiKeyData.apiKey, user: loginData.user });
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : "Unknown error";
		logger.error("NUG login failed", { error: msg, provider: config.name });
		return c.json({ error: msg }, 502);
	}
});

/** Proxy NUG API key creation. */
nugRoutes.post("/providers/:id/api-key", async (c) => {
	const id = c.req.param("id");
	const providers = settings.nugProviders ?? [];
	const config = providers.find((p) => p.id === id);
	if (!config) return c.json({ error: `Provider "${id}" not found` }, 404);

	const baseUrl = normalizeNugBaseUrl(config.baseUrl);
	if (!baseUrl) return c.json({ error: "Provider base URL not configured" }, 400);

	const body = await c.req.json();
	const { sessionToken, name } = body as { sessionToken?: string; name?: string };
	if (!sessionToken) {
		return c.json({ error: "Missing sessionToken" }, 400);
	}

	try {
		const response = await fetch(`${baseUrl}/api/api-keys`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Cookie: `nug_session=${sessionToken}`,
			},
			body: JSON.stringify({ name: name ?? `narrafork-${Date.now()}` }),
		});
		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			return c.json({ error: `NUG API key creation failed: ${errText}` }, 502);
		}
		const data = await response.json();
		return c.json(data);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : "Unknown error";
		logger.error("NUG API key creation failed", { error: msg, provider: config.name });
		return c.json({ error: msg }, 502);
	}
});

// ─── OAuth Flow ───

/** In-memory store for pending OAuth states (TTL: 10 minutes). */
const pendingOAuthStates = new Map<
	string,
	{ providerId: string; callbackUrl: string; expiresAt: number }
>();
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function cleanExpiredOAuthStates() {
	const now = Date.now();
	for (const [key, val] of pendingOAuthStates) {
		if (val.expiresAt <= now) pendingOAuthStates.delete(key);
	}
}

/** Generate OAuth authorization URL for a NUG provider. */
nugRoutes.get("/providers/:id/oauth/start", (c) => {
	const id = c.req.param("id");
	const providers = settings.nugProviders ?? [];
	const config = providers.find((p) => p.id === id);
	if (!config) return c.json({ error: `Provider "${id}" not found` }, 404);

	const baseUrl = normalizeNugBaseUrl(config.baseUrl);
	if (!baseUrl) return c.json({ error: "Provider base URL not configured" }, 400);
	if (!config.oauthClientId) return c.json({ error: "OAuth client ID not configured" }, 400);

	// Build the callback URL for this narrafork instance.
	// Priority: manual config > x-forwarded-host > host header > fallback
	let callbackUrl: string;
	if (config.oauthCallbackUrl) {
		callbackUrl = config.oauthCallbackUrl;
	} else {
		const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "localhost:7779";
		const proto = c.req.header("x-forwarded-proto") ?? "http";
		callbackUrl = `${proto}://${host}/api/nug/oauth/callback`;
	}

	// Generate a random state parameter and store it server-side
	const state = `${id}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
	cleanExpiredOAuthStates();
	pendingOAuthStates.set(state, {
		providerId: id,
		callbackUrl,
		expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
	});

	// Build NUG authorization URL
	const authorizeUrl = new URL(`${baseUrl}/oauth/authorize`);
	authorizeUrl.searchParams.set("client_id", config.oauthClientId);
	authorizeUrl.searchParams.set("redirect_uri", callbackUrl);
	authorizeUrl.searchParams.set("state", state);

	return c.json({
		authorizeUrl: authorizeUrl.toString(),
		state,
	});
});

/**
 * Redirect the browser to an in-app route, correct under any mount prefix.
 *
 * ⚠️ A rooted `c.redirect("/settings/providers")` addresses the PROXY's own path when
 * NarraFork is served from a subpath, so the user lands outside the app at the end of an
 * OAuth ceremony that actually succeeded — with the credential already stored and nothing
 * explaining the wrong page. See `lib/spa-base-href.ts` for the arithmetic.
 */
function redirectToApp(c: import("hono").Context, target: string): Response {
	return c.redirect(spaRedirectLocation(new URL(c.req.url).pathname, target));
}

/** OAuth callback handler — exported so app.ts can mount it before requireAuth. */
export async function handleNugOAuthCallback(c: import("hono").Context) {
	const code = c.req.query("code");
	const state = c.req.query("state");
	const error = c.req.query("error");

	if (error) {
		// User denied or error occurred — redirect to settings with error
		return redirectToApp(c, `/settings/providers?oauth_error=${encodeURIComponent(error)}`);
	}

	if (!code || !state) {
		return redirectToApp(c, "/settings/providers?oauth_error=missing_params");
	}

	// Validate state against server-side store (consume on use)
	const pending = pendingOAuthStates.get(state);
	if (!pending || pending.expiresAt <= Date.now()) {
		pendingOAuthStates.delete(state ?? "");
		return redirectToApp(c, "/settings/providers?oauth_error=state_expired");
	}
	pendingOAuthStates.delete(state);

	const providerId = pending.providerId;
	const providers = settings.nugProviders ?? [];
	const config = providers.find((p) => p.id === providerId);
	if (!config) {
		return redirectToApp(c, `/settings/providers?oauth_error=invalid_provider`);
	}

	const baseUrl = normalizeNugBaseUrl(config.baseUrl);
	if (!config.oauthClientId || !config.oauthClientSecret) {
		return redirectToApp(c, `/settings/providers?oauth_error=oauth_not_configured`);
	}

	// Reuse the exact callbackUrl that was sent in /oauth/start to guarantee
	// redirect_uri matches, even if host/proto headers differ between requests.
	const callbackUrl = pending.callbackUrl;

	try {
		// Exchange code for API key
		const tokenResponse = await fetch(`${baseUrl}/api/oauth/token`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				code,
				client_id: config.oauthClientId,
				client_secret: config.oauthClientSecret,
				redirect_uri: callbackUrl,
			}),
		});

		if (!tokenResponse.ok) {
			const errText = await tokenResponse.text().catch(() => "");
			logger.error("NUG OAuth token exchange failed", { error: errText, provider: config.name });
			return redirectToApp(c, `/settings/providers?oauth_error=${encodeURIComponent(errText)}`);
		}

		const tokenData = (await tokenResponse.json()) as {
			api_key: string;
			device_id: string;
			device_name: string;
			username?: string;
			user_id?: string;
		};

		// Update provider config with the new API key and device info
		config.apiKey = tokenData.api_key;
		config.oauthDeviceId = tokenData.device_id;
		if (tokenData.username) config.nugUsername = tokenData.username;
		if (tokenData.user_id) config.nugUserId = tokenData.user_id;

		// Persist settings
		saveSettings(settings);

		// Redirect to settings page with success
		return redirectToApp(c, `/settings/providers?oauth_success=${providerId}`);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : "Unknown error";
		logger.error("NUG OAuth callback failed", { error: msg, provider: config.name });
		return redirectToApp(c, `/settings/providers?oauth_error=${encodeURIComponent(msg)}`);
	}
}
