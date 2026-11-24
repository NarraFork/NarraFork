import { boundedJson, isoTimestamp, type QuotaData, type QuotaWindow, record } from "./protocol";

export interface OpencodeUsageWindow {
	status: "ok" | "rate-limited" | null;
	percent: number | null;
	resetsAt: string | null;
	used?: number | null;
	limit?: number | null;
}
export interface OpencodeUsagePayload {
	rolling: OpencodeUsageWindow | null;
	weekly: OpencodeUsageWindow | null;
	monthly: OpencodeUsageWindow | null;
	balance?: number | null;
}
const GO_PATHS: ReadonlyArray<[string, "zen" | "inference"]> = [
	["/zen/go/v1", "zen"],
	["/inference/go/v1", "inference"],
	["/inference/go/openai/v1", "inference"],
	["/inference/go/anthropic/v1", "inference"],
	["/inference/go/google/v1beta", "inference"],
];
function parseGoEndpoint(baseUrl?: string): string | null {
	if (!baseUrl) return null;
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		return null;
	}
	const host = url.hostname.toLowerCase();
	if (
		url.protocol !== "https:" ||
		!(host === "opencode.ai" || host.endsWith(".opencode.ai")) ||
		url.port ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		return null;
	const path = url.pathname.replace(/\/+$/, "");
	for (const [root, route] of GO_PATHS) {
		if (root === path) return `${url.origin}/${route}/go/v1/usage`;
	}
	return null;
}
export function isOpencodeCustomApiProvider(config: {
	baseUrl?: string;
	disabled?: boolean;
}): boolean {
	return !config.disabled && parseGoEndpoint(config.baseUrl) !== null;
}
export function opencodeUsageUrl(baseUrl: string): string {
	const endpoint = parseGoEndpoint(baseUrl);
	if (!endpoint) throw new Error("Not an OpenCode Go endpoint");
	return endpoint;
}
function normalizePercent(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(0, Math.min(100, value))
		: null;
}
function normalizeResetsAt(value: unknown): string | null {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		const ms = value < 1e12 ? value * 1000 : value;
		return ms <= 8.64e15 ? new Date(ms).toISOString() : null;
	}
	if (typeof value !== "string" || !value.trim()) return null;
	const raw = value.trim();
	return Number.isNaN(Date.parse(raw)) ? null : raw;
}
function normalizeAmount(value: unknown): number | null {
	if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim()))
		return normalizeAmount(Number(value));
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function pick(value: Record<string, unknown>, keys: string[]): unknown {
	for (const key of keys) if (value[key] !== undefined && value[key] !== null) return value[key];
	return undefined;
}
const USED_KEYS = ["used", "usage", "spent", "usedAmount", "used_amount", "cost"];
const LIMIT_KEYS = ["limit", "quota", "total", "max", "limitAmount", "limit_amount"];
const RESETS_KEYS = ["resetsAt", "resetAt", "resets_at", "reset_at", "resetTime"];
const BALANCE_KEYS = ["balance", "credits", "creditBalance", "credit_balance"];
function normalizeWindow(value: unknown): OpencodeUsageWindow | null {
	if (!record(value)) return null;
	const status = value.status === "ok" || value.status === "rate-limited" ? value.status : null;
	const resetsAt = normalizeResetsAt(pick(value, RESETS_KEYS));
	const used = normalizeAmount(pick(value, USED_KEYS));
	const limit = normalizeAmount(pick(value, LIMIT_KEYS));
	const usableLimit = limit != null && limit > 0 ? limit : null;
	const percent =
		normalizePercent(value.percent) ??
		(used != null && usableLimit != null ? normalizePercent((used / usableLimit) * 100) : null);
	if (status == null && percent == null && resetsAt == null) return null;
	return {
		status,
		percent,
		resetsAt,
		...(used != null && usableLimit != null ? { used, limit: usableLimit } : {}),
	};
}
function normalizeBalance(...sources: Record<string, unknown>[]): number | null {
	for (const source of sources) {
		const raw = pick(source, BALANCE_KEYS);
		if (record(raw)) {
			const nested = normalizeAmount(pick(raw, ["amount", "value", "total"]));
			if (nested != null) return nested;
			continue;
		}
		const amount = normalizeAmount(raw);
		if (amount != null) return amount;
	}
	return null;
}
export function parseOpencodeUsageResponse(body: unknown): OpencodeUsagePayload {
	if (!record(body) || !boundedJson(body) || !record(body.usage))
		throw new Error("Invalid usage response");
	const value = body.usage;
	const balance = normalizeBalance(value, body);
	return {
		rolling: normalizeWindow(value.rolling ?? value.fiveHour ?? value.five_hour),
		weekly: normalizeWindow(value.weekly ?? value.week),
		monthly: normalizeWindow(value.monthly ?? value.month),
		...(balance != null ? { balance } : {}),
	};
}
export function opencodeQuotaData(payload: OpencodeUsagePayload): QuotaData | null {
	const windows: QuotaWindow[] = [];
	for (const id of ["rolling", "weekly", "monthly"] as const) {
		const value = payload[id];
		if (!value) continue;
		const used = value.used ?? null;
		const limit = value.limit ?? null;
		const remaining = used !== null && limit !== null ? limit - used : null;
		const resetAt = isoTimestamp(value.resetsAt);
		if (
			used === null &&
			limit === null &&
			value.percent === null &&
			value.status === null &&
			resetAt === null
		)
			continue;
		windows.push({
			id,
			used,
			limit,
			remaining,
			usedPercent: value.percent,
			resetAt,
			status: value.status,
		});
	}
	const amounts: QuotaData["amounts"] =
		payload.balance == null ? [] : [{ id: "balance:USD", unit: "USD", remaining: payload.balance }];
	return windows.length || amounts.length ? { amounts, windows } : null;
}
