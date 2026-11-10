import { z } from "zod";
import type {
	ProviderBalanceAdapter,
	ProviderBalanceAmount,
	ProviderBalanceData,
	ProviderBalanceError,
} from "../../shared/provider-balance";

/**
 * Why a balance round failed.
 *
 * `unsupported` and `transient` are the original two; `auth`, `invalid_response` and
 * `invalid_configuration` are the deterministic outcomes the site-account credit query needs.
 * `plugin_disabled` is the deterministic outcome of an administrator disabling the
 * `apikey-quota` plugin that owns this capability.
 * A deterministic kind must never be folded into `transient`: that would let a rejected token
 * be retried and hidden behind the last good value.
 */
export type BalanceFailureKind =
	| "unsupported"
	| "transient"
	| "auth"
	| "invalid_response"
	| "invalid_configuration"
	| "plugin_disabled";

const FAILURE_MESSAGES: Record<BalanceFailureKind, string> = {
	unsupported: "Balance protocol unsupported",
	transient: "Balance request failed",
	auth: "Balance credentials rejected",
	invalid_response: "Balance response was not recognised",
	invalid_configuration: "Balance configuration is incomplete",
	plugin_disabled: "Balance query plugin is not enabled",
};

export class BalanceProbeRequestError extends Error {
	constructor(readonly kind: BalanceFailureKind) {
		super(FAILURE_MESSAGES[kind]);
		this.name = "BalanceProbeRequestError";
	}

	/** Transient failures are retryable and may keep the last good value for a short window. */
	get isTransient(): boolean {
		return this.kind === "transient";
	}
}

/** Snapshot error code for a failure kind; `unsupported` has no error code of its own. */
export function balanceErrorCode(kind: BalanceFailureKind): ProviderBalanceError {
	switch (kind) {
		case "transient":
			return "request_failed";
		case "auth":
			return "auth_failed";
		case "invalid_configuration":
			return "invalid_configuration";
		case "plugin_disabled":
			return "plugin_not_enabled";
		default:
			return "invalid_response";
	}
}

/**
 * Which credential a balance request carries.
 *
 * `provider-key` is the inference key the relay was configured with; `site-token` is the
 * site's system access token plus `New-Api-User`, which is what `/api/user/self` requires (an
 * `sk-` inference key answers 401 there).
 */
export type BalanceAuth = "none" | "provider-key" | "site-token";

export type BalanceRequest = (url: string, auth?: BalanceAuth) => Promise<unknown>;

export interface BalanceProbeResult {
	adapter: ProviderBalanceAdapter;
	root: string;
	balance: ProviderBalanceData;
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
const positive = (value: unknown): value is number => finite(value) && value > 0;
const shortString = (value: unknown, max = 128): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= max;

// Independent of the transport's byte limit; do not walk unbounded mock or decoded input.
function bounded(value: unknown, depth = 0, budget = { left: 4096 }): boolean {
	if (--budget.left < 0 || depth > 12) return false;
	if (typeof value === "string") return value.length <= 4096;
	if (typeof value === "number") return finite(value);
	if (Array.isArray(value)) {
		return value.length <= 256 && value.every((entry) => bounded(entry, depth + 1, budget));
	}
	if (record(value)) {
		const entries = Object.entries(value);
		return (
			entries.length <= 256 &&
			entries.every(([key, entry]) => key.length <= 128 && bounded(entry, depth + 1, budget))
		);
	}
	return value === null || typeof value === "boolean";
}

function quotaAmount(value: unknown, window?: string): ProviderBalanceAmount | null {
	if (
		!record(value) ||
		!finite(value.remaining) ||
		!finite(value.used) ||
		!finite(value.limit) ||
		value.used < 0 ||
		value.limit < 0
	)
		return null;
	return {
		unit: "USD",
		remaining: value.remaining,
		used: value.used,
		total: value.limit,
		...(window ? { window } : {}),
	};
}

const subscriptionTimestamp = z.iso.datetime({ offset: true });

/** Optional metadata must not invalidate a supported allowance or invent local time. */
function normalizedSubscriptionTimestamp(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > 128) return undefined;
	const parsed = subscriptionTimestamp.safeParse(value);
	if (!parsed.success) return undefined;
	const timestamp = Date.parse(parsed.data);
	return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

export function parseSub2ApiBalance(body: unknown): ProviderBalanceData | null {
	if (!record(body) || !bounded(body) || typeof body.isValid !== "boolean") return null;
	if (body.success === false || body.error !== undefined) return null;
	if (body.mode === "quota_limited") {
		const amounts: ProviderBalanceAmount[] = [];
		if (body.quota !== undefined) {
			const amount = quotaAmount(body.quota);
			if (!amount || !record(body.quota) || body.quota.unit !== "USD") return null;
			amounts.push(amount);
		}
		if (body.rate_limits !== undefined) {
			if (!Array.isArray(body.rate_limits) || body.rate_limits.length > 10) return null;
			const windows = new Set<string>();
			for (const entry of body.rate_limits) {
				if (!record(entry) || !["5h", "1d", "7d"].includes(String(entry.window))) return null;
				const window = entry.window as string;
				const amount = quotaAmount(entry, window);
				if (!amount || windows.has(window)) return null;
				windows.add(window);
				amounts.push(amount);
			}
		}
		return amounts.length ? { scope: "key", unlimited: false, amounts } : null;
	}
	if (body.mode !== "unrestricted" || body.unit !== "USD") return null;
	if (body.balance !== undefined) {
		if (!finite(body.balance)) return null;
		return {
			scope: "wallet",
			unlimited: false,
			amounts: [{ unit: "USD", remaining: body.balance }],
		};
	}
	if (!shortString(body.planName) || !body.planName.trim()) return null;
	const amounts: ProviderBalanceAmount[] = [];
	let expiresAt: string | undefined;
	if (body.subscription !== undefined && body.subscription !== null) {
		if (!record(body.subscription)) return null;
		expiresAt = normalizedSubscriptionTimestamp(body.subscription.expires_at);
		const weeklyStart = normalizedSubscriptionTimestamp(body.subscription.weekly_window_start);
		for (const window of ["daily", "weekly", "monthly"]) {
			const total = body.subscription[`${window}_limit_usd`];
			const used = body.subscription[`${window}_usage_usd`];
			if (total === undefined || total === null) continue;
			if (!finite(total) || total < 0 || !finite(used) || used < 0) return null;
			const remaining = total - used;
			if (!finite(remaining)) return null;
			amounts.push({
				unit: "USD",
				remaining,
				used,
				total,
				window,
				...(window === "weekly" && weeklyStart ? { windowStart: weeklyStart } : {}),
			});
		}
	}
	return {
		scope: "subscription",
		// The gateway explicitly reports -1 when no positive period limit is configured.
		unlimited: body.remaining === -1,
		amounts,
		planName: body.planName.trim(),
		...(expiresAt ? { expiresAt } : {}),
	};
}

interface Conversion {
	unit: string;
	divisor: number;
	rate: number;
}
const RAW: Conversion = { unit: "QUOTA", divisor: 1, rate: 1 };

function newApiConversion(status: unknown): Conversion {
	if (!record(status) || status.success !== true || !record(status.data) || !bounded(status)) {
		return RAW;
	}
	const data = status.data;
	if (!positive(data.quota_per_unit)) return RAW;
	switch (data.quota_display_type) {
		case "USD":
			return { unit: "USD", divisor: data.quota_per_unit, rate: 1 };
		case "CNY":
			return positive(data.usd_exchange_rate)
				? { unit: "CNY", divisor: data.quota_per_unit, rate: data.usd_exchange_rate }
				: RAW;
		case "TOKENS":
			return { unit: "TOKENS", divisor: 1, rate: 1 };
		case "CUSTOM": {
			const symbol = data.custom_currency_symbol;
			return typeof symbol === "string" &&
				/^(?:[A-Za-z]{1,8}|\p{Sc})$/u.test(symbol) &&
				positive(data.custom_currency_exchange_rate)
				? {
						unit: symbol,
						divisor: data.quota_per_unit,
						rate: data.custom_currency_exchange_rate,
					}
				: RAW;
		}
		default:
			return RAW;
	}
}

export function parseNewApiBalance(body: unknown, status?: unknown): ProviderBalanceData | null {
	if (!record(body) || !bounded(body) || body.code !== true || body.success === false) return null;
	const data = body.data;
	if (
		!record(data) ||
		data.object !== "token_usage" ||
		typeof data.unlimited_quota !== "boolean" ||
		!finite(data.total_available) ||
		!finite(data.total_used) ||
		data.total_used < 0 ||
		!finite(data.total_granted)
	)
		return null;
	if (data.unlimited_quota) return { scope: "key", unlimited: true, amounts: [] };
	let conversion = newApiConversion(status);
	const raw = [data.total_available, data.total_used, data.total_granted];
	let values = raw.map((value) => (value / conversion.divisor) * conversion.rate);
	if (!values.every(finite)) {
		conversion = RAW;
		values = raw;
	}
	return {
		scope: "key",
		unlimited: false,
		amounts: [{ unit: conversion.unit, remaining: values[0], used: values[1], total: values[2] }],
	};
}

function normalizeRoot(baseUrl: string): string {
	if (typeof baseUrl !== "string" || baseUrl.length > 2048 || /[?#\\\s]/u.test(baseUrl))
		throw new Error("Invalid balance URL");
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		throw new Error("Invalid balance URL");
	}
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
		throw new Error("Invalid balance URL");
	}
	return url.origin + url.pathname.replace(/\/+$/, "");
}

export function buildBalanceRoots(baseUrl: string): string[] {
	const original = normalizeRoot(baseUrl);
	const stripped = original.replace(/\/(?:v1|v1beta|anthropic)$/, "");
	return stripped === original ? [original] : [stripped, original];
}

// --- Site-account credit query (`/api/user/self`) ---
//
// New API sites report an account's credit in internal quota units where
// 500000 units are one US dollar. The endpoint is under the *site* root, not the inference
// base URL: several presets keep `/v1` in the base URL of the OpenAI-compatible endpoints, and
// `{base}/api/user/self` then resolves to `/v1/api/user/self` and 404s.

/** New API stores credit in internal quota units; this is the documented USD divisor. */
export const NEW_API_USER_QUOTA_DIVISOR = 500_000;
export const NEW_API_USER_ADAPTER: ProviderBalanceAdapter = "new-api-user";

/**
 * The site-account credentials for the credit query.
 *
 * `hasSiteQuotaConfig` is true as soon as any one of the three fields is set: that is the user
 * saying this relay's credit lives on their site account. A half-filled configuration is
 * therefore a deterministic error rather than a silent fallback to the inference-key endpoint,
 * because falling back would quietly answer a different question than the one asked.
 */
export function hasSiteQuotaConfig(config: {
	quotaSiteUrl?: string;
	quotaAccessToken?: string;
	quotaUserId?: string;
}): boolean {
	return !!(
		config.quotaSiteUrl?.trim() ||
		config.quotaAccessToken?.trim() ||
		config.quotaUserId?.trim()
	);
}

export interface SiteQuotaConfig {
	/** Normalized site root the `/api/user/self` path is appended to. */
	root: string;
	accessToken: string;
	userId: string;
}

/**
 * Resolve (or reject) the site-account credentials.
 *
 * The root defaults to the provider's base URL, whose own trailing `/v1`-style suffix and
 * trailing slashes are stripped by `normalizeRoot`/`buildBalanceRoots`. A configured
 * `quotaSiteUrl` wins, which is the documented way to point the query at the site root when the
 * inference base URL carries `/v1`.
 */
export function resolveSiteQuotaConfig(config: {
	baseUrl: string;
	quotaSiteUrl?: string;
	quotaAccessToken?: string;
	quotaUserId?: string;
}): SiteQuotaConfig {
	const accessToken = config.quotaAccessToken?.trim() ?? "";
	const userId = config.quotaUserId?.trim() ?? "";
	if (!accessToken || !userId) {
		throw new BalanceProbeRequestError("invalid_configuration");
	}
	// Bounded: the fields live in settings and a huge value is a configuration bug, not a URL.
	if (accessToken.length > 4096 || userId.length > 128) {
		throw new BalanceProbeRequestError("invalid_configuration");
	}
	let roots: string[];
	try {
		roots = buildBalanceRoots(config.quotaSiteUrl?.trim() || config.baseUrl);
	} catch {
		throw new BalanceProbeRequestError("invalid_configuration");
	}
	// The stripped root is the site root; the unstripped one only exists when a `/v1` suffix was
	// present, and the site API never lives under it.
	const root = roots[0];
	if (!root) throw new BalanceProbeRequestError("invalid_configuration");
	return { root, accessToken, userId };
}

/** Roots this provider can address a quota endpoint at, given its site-account configuration. */
export function balanceRootCandidates(config: {
	baseUrl: string;
	quotaSiteUrl?: string;
	quotaAccessToken?: string;
	quotaUserId?: string;
}): string[] {
	if (!hasSiteQuotaConfig(config)) return buildBalanceRoots(config.baseUrl);
	return [resolveSiteQuotaConfig(config).root];
}

/** Accepts the numeric-string form some New API builds emit for quota fields. */
function quotaNumber(value: unknown): number | null {
	if (typeof value === "number") return finite(value) ? value : null;
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!/^-?\d{1,18}(?:\.\d{1,9})?$/u.test(trimmed)) return null;
	const parsed = Number(trimmed);
	return finite(parsed) ? parsed : null;
}

/**
 * Read one account credit answer.
 *
 * `quota` is the remaining credit and `used_quota` the consumed part; both are internal quota
 * units, so the total granted is their sum. `success !== true` or a missing `data` object is an
 * invalid answer, not an empty one — reporting zero would look like a genuinely spent account.
 */
export function parseNewApiUserQuota(body: unknown): ProviderBalanceData | null {
	if (!record(body) || !bounded(body)) return null;
	// Read both fields through the un-narrowed record: comparing `body.success` narrows the
	// original binding, and `body.data` would then be read off that narrowed type.
	const wrapper: Record<string, unknown> = body;
	if (wrapper.success !== true) return null;
	// Bind before guarding: `record(wrapper.data)` yields a boolean, while guarding a binding
	// narrows it to the record type.
	const data = wrapper.data;
	if (!record(data)) return null;
	const quota = quotaNumber(data.quota);
	const used = quotaNumber(data.used_quota);
	if (quota === null || used === null || quota < -1 || used < 0) return null;
	const group = typeof data.group === "string" ? data.group.trim() : "";
	// New API reports -1 when the account has no positive credit limit; mirror the convention
	// the sub2api adapter already uses for its own unlimited case.
	if (quota === -1) {
		return {
			scope: "wallet",
			unlimited: true,
			amounts: [],
			...(group && group.length <= 128 ? { planName: group } : {}),
		};
	}
	const remaining = quota / NEW_API_USER_QUOTA_DIVISOR;
	const usedUsd = used / NEW_API_USER_QUOTA_DIVISOR;
	const total = (quota + used) / NEW_API_USER_QUOTA_DIVISOR;
	if (![remaining, usedUsd, total].every(finite)) return null;
	return {
		scope: "wallet",
		unlimited: false,
		amounts: [{ unit: "USD", remaining, used: usedUsd, total }],
		...(group && group.length <= 128 ? { planName: group } : {}),
	};
}

async function readSiteQuota(root: string, request: BalanceRequest) {
	const body = await request(`${root}/api/user/self`, "site-token");
	const balance = parseNewApiUserQuota(body);
	if (!balance) throw new BalanceProbeRequestError("invalid_response");
	return balance;
}

/** Site-account credit has no discovery step: the configured credentials decide the answer. */
export async function probeSiteQuota(
	config: {
		baseUrl: string;
		quotaSiteUrl?: string;
		quotaAccessToken?: string;
		quotaUserId?: string;
	},
	request: BalanceRequest,
): Promise<BalanceProbeResult> {
	const site = resolveSiteQuotaConfig(config);
	return {
		adapter: NEW_API_USER_ADAPTER,
		root: site.root,
		balance: await readSiteQuota(site.root, request),
	};
}

export async function refreshSiteQuota(
	config: {
		baseUrl: string;
		quotaSiteUrl?: string;
		quotaAccessToken?: string;
		quotaUserId?: string;
	},
	root: string,
	request: BalanceRequest,
): Promise<ProviderBalanceData> {
	const site = resolveSiteQuotaConfig(config);
	let normalized: string;
	try {
		normalized = normalizeRoot(root);
	} catch {
		throw new BalanceProbeRequestError("invalid_configuration");
	}
	return readSiteQuota(normalized || site.root, request);
}

async function readNewApi(root: string, body: unknown, request: BalanceRequest) {
	let status: unknown;
	try {
		status = await request(`${root}/api/status`, "none");
	} catch {
		// Metadata is public and optional; a known key allowance remains supported.
	}
	return parseNewApiBalance(body, status);
}

export async function probeProviderBalance(
	baseUrl: string,
	request: BalanceRequest,
): Promise<BalanceProbeResult | null> {
	let transient = false;
	for (const root of buildBalanceRoots(baseUrl)) {
		for (const adapter of ["sub2api", "new-api"] as const) {
			try {
				const path = adapter === "sub2api" ? "/v1/usage" : "/api/usage/token/";
				const body = await request(root + path, "provider-key");
				let balance = adapter === "sub2api" ? parseSub2ApiBalance(body) : parseNewApiBalance(body);
				if (!balance) continue;
				if (adapter === "new-api") balance = (await readNewApi(root, body, request)) ?? balance;
				return { adapter, root, balance };
			} catch (error) {
				if (!(error instanceof BalanceProbeRequestError) || error.kind === "transient") {
					transient = true;
				}
			}
		}
	}
	if (transient) throw new BalanceProbeRequestError("transient");
	return null;
}

export async function refreshProviderBalance(
	adapter: ProviderBalanceAdapter,
	root: string,
	request: BalanceRequest,
): Promise<ProviderBalanceData> {
	const normalized = normalizeRoot(root);
	try {
		const path = adapter === "sub2api" ? "/v1/usage" : "/api/usage/token/";
		const body = await request(normalized + path, "provider-key");
		const balance = adapter === "sub2api" ? parseSub2ApiBalance(body) : parseNewApiBalance(body);
		if (!balance) throw new BalanceProbeRequestError("unsupported");
		return adapter === "new-api"
			? ((await readNewApi(normalized, body, request)) ?? balance)
			: balance;
	} catch (error) {
		if (error instanceof BalanceProbeRequestError) throw error;
		throw new BalanceProbeRequestError("transient");
	}
}
