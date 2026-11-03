import { normalizeEndpointUrl } from "@shared/provider-endpoints";
import {
	type ImportCheckResponse,
	type ImportCommitResponse,
	type ProviderImportEntry,
	type ProviderImportPayload,
	validateImportPayload,
} from "@shared/provider-import";
import { Hono } from "hono";
import { getDomainWithoutSuffix } from "tldts";
import { listProviderReadiness } from "../lib/agent/provider";
import { purgeCustomApiQuotaCache } from "../lib/custom-api-quota-cache";
import {
	refreshAllDeepSeekBalances,
	syncDeepSeekBalanceCache,
} from "../lib/deepseek-balance-cache";
import { ValidationError } from "../lib/errors";
import { generateShortId } from "../lib/id";
import { refreshAllKimiUsages } from "../lib/kimi-usage-cache";
import { logger } from "../lib/logger";
import { refreshAllOpencodeUsages, syncOpencodeUsageCache } from "../lib/opencode-usage-cache";
import {
	discoverPendingProviderBalances,
	syncProviderBalanceCache,
} from "../lib/provider-balance-cache";
import { fetchRemoteImportConfig } from "../lib/provider-import-fetch";
import {
	customApiProvidersToAnthropic,
	customApiProvidersToGemini,
	customApiProvidersToOpenAI,
	type NarraForkSettings,
	normalizeCustomApiProvider,
	saveSettings,
	settings,
} from "../lib/settings";
import { currentCustomApiProviders } from "../lib/settings/current-custom-api-providers";
import {
	customApiProviderToAnthropic,
	customApiProviderToGemini,
	customApiProviderToOpenAI,
} from "../lib/settings/custom-api-providers";
import { settingsUpdateLock } from "../lib/settings/write-lock";
import {
	providerImportCheckSchema,
	providerImportCommitSchema,
	providerImportFetchSchema,
	providerImportPreviewSchema,
} from "../lib/validators/provider-import";
import { requireAdmin } from "../middleware/auth";
import { fetchAnthropicModels } from "./anthropic";
import { fetchGeminiModels } from "./gemini";
import { fetchOpenaiModels } from "./openai";

/**
 * Provider import (docs/PROVIDER_IMPORT.md). Mounted at `/api/settings/provider-import`.
 *
 * Every entrance ends here: the browser recognizes the input, the server fetches
 * remote configs, re-validates the payload against the shared whitelist, reports
 * conflicts, and commits only what an admin confirmed. Existing API keys never
 * leave the server; the preview only says whether an incoming key is the same.
 */

/** Prefixes owned by built-in adapters or the retired tutorial provider. */
const RESERVED_PREFIXES = ["codex", "tokendance", "tutorial"];

async function usedPrefixes(): Promise<Set<string>> {
	const used = new Set(RESERVED_PREFIXES);
	for (const provider of currentCustomApiProviders()) {
		if (provider.prefix) used.add(provider.prefix);
	}
	for (const provider of settings.nugProviders ?? [])
		if (provider.prefix) used.add(provider.prefix);
	// Plugin and built-in sources reserve prefixes too.
	for (const entry of await listProviderReadiness()) used.add(entry.prefix);
	return used;
}

/** Same rules as the add-provider flow: no ASCII colon; `name-2`, `name-3`… on conflict. */
function uniquePrefix(
	requested: string | undefined,
	entry: ProviderImportEntry,
	used: Set<string>,
) {
	let seed = (requested ?? "").replace(/:/g, "").trim();
	if (!seed) {
		let host = "";
		try {
			host = new URL(entry.baseUrl).hostname;
		} catch {}
		seed =
			getDomainWithoutSuffix(host) ||
			entry.name
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-+|-+$/g, "") ||
			"provider";
	}
	let prefix = seed;
	for (let suffix = 2; used.has(prefix); suffix++) prefix = `${seed}-${suffix}`;
	used.add(prefix);
	return prefix;
}

function validatedPayload(raw: unknown): {
	payload: ProviderImportPayload;
	ignoredFields: string[];
} {
	// Keys reach this point only from codes, full links, short links or manual entry.
	const result = validateImportPayload(raw, { allowApiKey: true });
	if (!result.ok) throw new ValidationError(`Invalid provider import payload: ${result.detail}`);
	return { payload: result.payload, ignoredFields: result.ignoredFields };
}

const MAX_CHECK_TARGETS = 40;
const CHECK_CONCURRENCY = 4;
const CHECK_TIMEOUT_MS = 15_000;
const MAX_CHECK_ERROR_CHARS = 200;

/**
 * List models with an unsaved connection, exactly as a saved provider would: the
 * entry is projected through the same converters the settings use, then handed to
 * each family's existing `/models` fetcher.
 */
async function listModelsForImport(
	entry: ProviderImportEntry,
	protocol: ProviderImportEntry["protocol"],
	apiKey: string,
	geminiTransport: ProviderImportEntry["geminiTransport"],
): Promise<number> {
	const site = normalizeCustomApiProvider({
		id: "import-check",
		name: entry.name,
		prefix: "import-check",
		apiKey,
		baseUrl: entry.baseUrl,
		defaultModel: "",
		protocol,
		geminiTransport,
		userAgentMode: entry.userAgentMode,
	});
	const anthropic = customApiProviderToAnthropic(site);
	if (anthropic) return (await fetchAnthropicModels(anthropic)).models.length;
	const gemini = customApiProviderToGemini(site);
	if (gemini) return (await fetchGeminiModels(gemini)).length;
	const openai = customApiProviderToOpenAI(site);
	if (openai) return (await fetchOpenaiModels(openai)).models.length;
	throw new Error(`Unsupported protocol "${protocol}"`);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<T>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`No answer within ${ms / 1000} s`)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

export const gatewayProviderImportRoutes = new Hono();

/** Fetch `/.well-known/narrafork-provider.json` for a typed domain or a short link. */
gatewayProviderImportRoutes.post("/fetch", requireAdmin, async (c) => {
	const parsed = providerImportFetchSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const result = await fetchRemoteImportConfig(parsed.data.input, {
		exact: parsed.data.exact ?? false,
	});
	logger.info("Provider import config fetched", {
		ok: result.ok,
		attempts: result.attempts.map((attempt) => `${attempt.url} ${attempt.outcome}`),
	});
	return c.json(result);
});

/** Suggested prefixes and same-address conflicts, without revealing stored keys. */
gatewayProviderImportRoutes.post("/preview", requireAdmin, async (c) => {
	const parsed = providerImportPreviewSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const { payload, ignoredFields } = validatedPayload(parsed.data.payload);
	const existing = currentCustomApiProviders();
	const used = await usedPrefixes();
	const entries = payload.providers.map((entry) => {
		const baseUrl = normalizeEndpointUrl(entry.baseUrl);
		return {
			suggestedPrefix: uniquePrefix(entry.prefix, entry, used),
			duplicates: existing
				.filter((provider) => normalizeEndpointUrl(provider.baseUrl) === baseUrl)
				.map((provider) => ({
					id: provider.id,
					name: provider.name,
					prefix: provider.prefix,
					sameKey: !!entry.apiKey && provider.apiKey === entry.apiKey,
				})),
		};
	});
	return c.json({ entries, ignoredFields });
});

/**
 * Verify every key in the payload before anything is saved, by listing its models.
 * A failure is reported, not enforced: some gateways block `/models` but still chat.
 */
gatewayProviderImportRoutes.post("/check", requireAdmin, async (c) => {
	const parsed = providerImportCheckSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const { payload } = validatedPayload(parsed.data.payload);

	const targets: Array<{ entry: number; run: () => Promise<number> }> = [];
	payload.providers.forEach((entry, index) => {
		if (!entry.apiKey) return;
		const apiKey = entry.apiKey;
		targets.push({
			entry: index,
			run: () => listModelsForImport(entry, entry.protocol, apiKey, entry.geminiTransport),
		});
	});

	const checked = targets.slice(0, MAX_CHECK_TARGETS);
	const results: ImportCheckResponse["results"] = new Array(checked.length);
	let nextIndex = 0;
	const worker = async () => {
		while (nextIndex < checked.length) {
			const index = nextIndex++;
			const target = checked[index];
			try {
				const count = await withTimeout(target.run(), CHECK_TIMEOUT_MS);
				results[index] = { entry: target.entry, ok: true, count };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				results[index] = {
					entry: target.entry,
					ok: false,
					error: message.slice(0, MAX_CHECK_ERROR_CHARS),
				};
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, checked.length) }, worker));
	return c.json({
		results,
		truncated: targets.length > checked.length,
	} satisfies ImportCheckResponse);
});

/** Apply the confirmed entries atomically under the settings write lock. */
gatewayProviderImportRoutes.post("/commit", requireAdmin, async (c) => {
	const parsed = providerImportCommitSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const { payload } = validatedPayload(parsed.data.payload);
	const decisions = parsed.data.entries;
	if (decisions.length !== payload.providers.length) {
		throw new ValidationError("Each imported provider needs exactly one decision.");
	}

	return settingsUpdateLock.acquire("settings", async () => {
		const used = await usedPrefixes();
		let next = currentCustomApiProviders().map((provider) => ({ ...provider }));
		const changedQuotaProviders = new Set<string>();
		const results: ImportCommitResponse["results"] = [];
		const refresh: ImportCommitResponse["refresh"] = [];

		payload.providers.forEach((entry, index) => {
			const decision = decisions[index];
			if (decision.action === "skip") {
				results.push({ status: "skipped" });
				return;
			}
			if (decision.action === "replace-key") {
				const target = next.find((provider) => provider.id === decision.targetId);
				if (!target) throw new ValidationError(`Provider "${decision.targetId}" not found.`);
				if (!entry.apiKey) throw new ValidationError("Replacing a key requires a key.");
				if (target.apiKey !== entry.apiKey) changedQuotaProviders.add(target.id);
				next = next.map((provider) =>
					provider.id === target.id ? { ...provider, apiKey: entry.apiKey ?? "" } : provider,
				);
				results.push({
					status: "updated",
					providerId: target.id,
					prefix: target.prefix,
					protocol: target.protocol,
				});
				refresh.push({ providerId: target.id });
				return;
			}
			const provider = normalizeCustomApiProvider({
				id: generateShortId(),
				name: (decision.name?.trim() || entry.name).slice(0, 100),
				prefix: uniquePrefix(decision.prefix, entry, used),
				apiKey: entry.apiKey ?? "",
				baseUrl: entry.baseUrl,
				baseUrls: entry.baseUrls,
				endpointPolicy: entry.endpointPolicy,
				defaultModel: entry.defaultModel ?? "",
				protocol: entry.protocol,
				geminiTransport: entry.geminiTransport,
				userAgentMode: entry.userAgentMode,
				disabled: decision.disabled || undefined,
			});
			next.push(provider);
			results.push({
				status: "added",
				providerId: provider.id,
				prefix: provider.prefix,
				protocol: provider.protocol,
			});
			if (provider.apiKey) refresh.push({ providerId: provider.id });
		});

		const merged: NarraForkSettings = {
			...settings,
			customApiProviders: next,
			openaiProviders: customApiProvidersToOpenAI(next),
			anthropicProviders: customApiProvidersToAnthropic(next),
			geminiProviders: customApiProvidersToGemini(next),
		};
		saveSettings(merged);
		// Keep the settings PATCH cache effects for imported or replaced credentials.
		if (changedQuotaProviders.size) purgeCustomApiQuotaCache([...changedQuotaProviders]);
		syncDeepSeekBalanceCache();
		syncProviderBalanceCache();
		void refreshAllDeepSeekBalances().catch(() => {});
		discoverPendingProviderBalances();
		void refreshAllKimiUsages().catch(() => {});
		syncOpencodeUsageCache();
		void refreshAllOpencodeUsages().catch(() => {});

		logger.info("Providers imported", {
			results: results.map((result) => `${result.status} ${result.prefix ?? ""}`.trim()),
		});
		return c.json({ results, refresh } satisfies ImportCommitResponse);
	});
});
