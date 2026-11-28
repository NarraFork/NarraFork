import { z } from "zod";
import { BalanceProbeRequestError } from "./errors";
import type { QuotaData } from "./protocol";
import { refreshSiteQuota } from "./site";

export { BalanceProbeRequestError } from "./errors";

export {
	NEW_API_USER_ADAPTER,
	NEW_API_USER_QUOTA_DIVISOR,
	parseNewApiUserQuota,
	probeSiteQuota,
	refreshSiteQuota,
} from "./site";
export type ProviderBalanceAdapter = "sub2api" | "new-api" | "new-api-user";
export interface ProviderBalanceAmount {
	unit: string;
	remaining: number | null;
	used?: number;
	total?: number;
	window?: string;
	windowStart?: string;
}
export interface ProviderBalanceData {
	scope: "wallet" | "key" | "subscription";
	unlimited: boolean;
	amounts: ProviderBalanceAmount[];
	planName?: string;
	expiresAt?: string;
}
export type BalanceAuth = "none" | "provider-key" | "site-token" | "settings-account";
export type BalanceRequest = (url: string, auth?: BalanceAuth | boolean) => Promise<unknown>;
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

export function bounded(value: unknown, depth = 0, budget = { left: 4096 }): boolean {
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
	if (!record(status) || status.success !== true || !record(status.data) || !bounded(status))
		return RAW;
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
				? { unit: symbol, divisor: data.quota_per_unit, rate: data.custom_currency_exchange_rate }
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
export function normalizeBalanceRoot(baseUrl: string): string {
	if (typeof baseUrl !== "string" || baseUrl.length > 2048 || /[?#\\\s]/u.test(baseUrl))
		throw new Error("Invalid balance URL");
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		throw new Error("Invalid balance URL");
	}
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
		throw new Error("Invalid balance URL");
	return url.origin + url.pathname.replace(/\/+$/, "");
}
export function buildBalanceRoots(baseUrl: string): string[] {
	const original = normalizeBalanceRoot(baseUrl);
	const stripped = original.replace(/\/(?:v1|v1beta|anthropic)$/, "");
	return stripped === original ? [original] : [stripped, original];
}
async function readNewApi(root: string, body: unknown, request: BalanceRequest) {
	let status: unknown;
	try {
		status = await request(`${root}/api/status`, "none");
	} catch {
		/* Optional public metadata. */
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
				if (!(error instanceof BalanceProbeRequestError) || error.kind === "transient")
					transient = true;
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
	if (adapter === "new-api-user") return refreshSiteQuota(root, request);
	const normalized = normalizeBalanceRoot(root);
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

export function relayQuotaData(
	balance: ProviderBalanceData,
	adapter: ProviderBalanceAdapter,
): QuotaData {
	const windows: QuotaData["windows"] = [];
	const labels: Record<string, string> = {
		"5h": "5-hour limit",
		"1d": "Daily limit",
		"7d": "Weekly limit",
		daily: "Daily limit",
		weekly: "Weekly limit",
		monthly: "Monthly limit",
	};
	const durations: Record<string, number> = {
		"5h": 5 * 3_600_000,
		"1d": 86_400_000,
		"7d": 7 * 86_400_000,
		daily: 86_400_000,
		weekly: 7 * 86_400_000,
	};
	const amounts = balance.amounts.map((amount, index): QuotaData["amounts"][number] => {
		// Keep the old amount fields for legacy DTOs; normalized windows own their constraint.
		if (adapter !== "sub2api" || !amount.window) return { id: `amount:${index}`, ...amount };
		// Subscription zero limits are unconfigured periods, not a zero-dollar spendable balance.
		if (!balance.unlimited && (balance.scope !== "subscription" || positive(amount.total))) {
			const durationMs = durations[amount.window];
			windows.push({
				id: amount.window,
				label: labels[amount.window] ?? amount.window,
				unit: amount.unit,
				used: amount.used ?? null,
				limit: amount.total ?? null,
				remaining: amount.remaining,
				// A reported window start does not guarantee the next reset; do not derive one.
				resetAt: null,
				...(durationMs ? { durationMs } : {}),
			});
		}
		return { id: `amount:${index}`, ...amount, display: "detail", quota: "none" };
	});
	return { ...balance, format: adapter, amounts, windows };
}
