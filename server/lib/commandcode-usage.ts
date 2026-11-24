/**
 * Command Code 额度查询。
 *
 * 端点与响应结构均来自实测（在 Studio 生成 API key 后请求真实接口）：
 * - GET /alpha/billing/credits → `{ credits: {...}, windowLimits: {...}, sandboxAccess }`
 *   其中 `credits.monthlyCredits` 是月度余额，`windowLimits` 是 5 小时 / 周滚动窗口的用量与上限。
 * - GET /alpha/usage/summary   → 计费周期内的累计用量（请求数、token、成功率等）。
 * 两者都用 CLI 登录后的凭据鉴权（`Authorization: Bearer <auth.json 的 apiKey>`）。
 */

import type { QuotaSnapshot, QuotaWindow } from "@shared/quota-snapshot";
import type { CommandCodeProviderSettings } from "./agent/commandcode-provider";
import { COMMAND_CODE_PREFIX, commandCodeApiOrigin } from "./commandcode-protocol";
import type { UsageSubject } from "./provider-key-subjects";
import { COMMAND_CODE_KEY_OWNER, getProviderKeyStore, withProviderKey } from "./provider-keys";
import { settings } from "./settings";
import { quotaStore } from "./sourcing/quota-store";

const REQUEST_TIMEOUT_MS = 15_000;
export const COMMAND_CODE_USAGE_STALE_MS = 60_000;
/** 额度接口不该有巨大响应；超过这个字节数就取消读取。 */
const MAX_BODY_BYTES = 256 * 1024;

export interface CommandCodeCredits {
	/** 月度额度余额。 */
	monthlyCredits: number;
	purchasedCredits: number;
	freeCredits: number;
	creditThreshold: number;
	belowThreshold: boolean;
}

export interface CommandCodeWindow {
	used: number;
	cap: number;
	exceeded: boolean;
	/** 窗口重置时间（毫秒时间戳）。 */
	resetAt?: number;
}

export interface CommandCodeWindowLimits {
	limited: boolean;
	fiveHour?: CommandCodeWindow;
	weekly?: CommandCodeWindow;
}

export interface CommandCodeUsageSummary {
	totalCount: number;
	totalTokens: number;
	totalTokensIn: number;
	totalTokensOut: number;
	successRate: number;
	completedCount: number;
	failedCount: number;
	/** 计费周期内已消耗的月度额度；与 credits.monthlyCredits（余额）相加即总配额。 */
	totalMonthlyCredits: number;
	/** 计费周期起始（ISO 时间字符串）。 */
	periodStart?: string;
}

export interface CommandCodeUsage {
	credits: CommandCodeCredits;
	windowLimits?: CommandCodeWindowLimits;
	sandboxAccess?: boolean;
	summary?: CommandCodeUsageSummary;
}

export class CommandCodeUsageError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "CommandCodeUsageError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalNum(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalStr(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function bool(value: unknown): boolean {
	return value === true;
}

/**
 * 按块读取响应体，超过 `maxBytes` 就取消，不再把剩余内容读进内存。
 * 超限或非法 JSON 都按额度接口异常处理，message 是稳定错误码。
 */
export async function readResponseJsonLimited(
	response: Response,
	maxBytes = MAX_BODY_BYTES,
): Promise<unknown> {
	const reader = response.body?.getReader();
	if (!reader) throw new CommandCodeUsageError(response.status, "invalid_json");
	const chunks: Uint8Array[] = [];
	let received = 0;
	let cancelled = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value?.byteLength) continue;
			if (received + value.byteLength > maxBytes) {
				cancelled = true;
				await reader.cancel();
				throw new CommandCodeUsageError(response.status, "response_too_large");
			}
			received += value.byteLength;
			chunks.push(value);
		}
	} finally {
		if (!cancelled) {
			try {
				reader.releaseLock();
			} catch {
				// 读取结束时锁可能已经放开。
			}
		}
	}
	const bytes = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
	} catch {
		throw new CommandCodeUsageError(response.status, "invalid_json");
	}
}

async function getJson(
	path: string,
	token: string,
	origin: string,
	signal?: AbortSignal,
): Promise<unknown> {
	const response = await fetch(`${origin}${path}`, {
		headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
		signal: signal
			? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
			: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new CommandCodeUsageError(
			response.status,
			response.status === 401 ? "unauthorized" : "upstream_error",
		);
	}
	return readResponseJsonLimited(response);
}

/** 解析 credits 响应；字段缺失一律降级为 0/false，避免上游改动让整个额度卡报错。 */
export function parseCommandCodeCredits(value: unknown): {
	credits: CommandCodeCredits;
	windowLimits?: CommandCodeWindowLimits;
	sandboxAccess?: boolean;
} {
	const root = isRecord(value) ? value : {};
	const raw = isRecord(root.credits) ? root.credits : {};
	const credits: CommandCodeCredits = {
		monthlyCredits: num(raw.monthlyCredits),
		purchasedCredits: num(raw.purchasedCredits),
		freeCredits: num(raw.freeCredits),
		creditThreshold: num(raw.creditThreshold),
		belowThreshold: bool(raw.belowThreshold),
	};

	let windowLimits: CommandCodeWindowLimits | undefined;
	const rawLimits = root.windowLimits;
	if (isRecord(rawLimits)) {
		windowLimits = {
			limited: bool(rawLimits.limited),
			fiveHour: parseWindow(rawLimits.fiveHour),
			weekly: parseWindow(rawLimits.weekly),
		};
	}

	return { credits, windowLimits, sandboxAccess: optionalBool(root.sandboxAccess) };
}

function parseWindow(value: unknown): CommandCodeWindow | undefined {
	if (!isRecord(value)) return undefined;
	return {
		used: num(value.used),
		cap: num(value.cap),
		exceeded: bool(value.exceeded),
		resetAt: optionalNum(value.resetAt),
	};
}

function optionalBool(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

/** 解析 usage summary；缺失字段按 0 处理。 */
export function parseCommandCodeSummary(value: unknown): CommandCodeUsageSummary | undefined {
	if (!isRecord(value)) return undefined;
	return {
		totalCount: num(value.totalCount),
		totalTokens: num(value.totalTokens),
		totalTokensIn: num(value.totalTokensIn),
		totalTokensOut: num(value.totalTokensOut),
		successRate: num(value.successRate),
		completedCount: num(value.completedCount),
		failedCount: num(value.failedCount),
		totalMonthlyCredits: num(value.totalMonthlyCredits),
		periodStart: optionalStr(value.periodStart),
	};
}

/** 查询额度：credits 必取；usage summary 失败不影响整体结果。 */
export async function fetchCommandCodeUsage(
	token: string,
	baseUrl?: string,
	signal?: AbortSignal,
): Promise<CommandCodeUsage> {
	const origin = commandCodeApiOrigin(baseUrl);
	const { credits, windowLimits, sandboxAccess } = parseCommandCodeCredits(
		await getJson("/alpha/billing/credits", token, origin, signal),
	);
	let summary: CommandCodeUsageSummary | undefined;
	try {
		summary = parseCommandCodeSummary(await getJson("/alpha/usage/summary", token, origin, signal));
	} catch (error) {
		if (signal?.aborted) throw error;
		// 用量摘要失败不阻塞额度展示。
	}
	return { credits, windowLimits, sandboxAccess, summary };
}

function quotaWindow(kind: "5h" | "weekly", window: CommandCodeWindow | undefined): QuotaWindow[] {
	if (!window) return [];
	return [
		{
			kind,
			usedRatio:
				window.exceeded || (window.cap > 0 && window.used >= window.cap)
					? 1
					: window.cap > 0
						? window.used / window.cap
						: null,
			resetsAt: window.resetAt ?? null,
		},
	];
}

/** The shared projection; the legacy route reads the original usage back from detail. */
export function commandCodeUsageSnapshot(
	usage: CommandCodeUsage,
	fetchedAt = Date.now(),
): QuotaSnapshot {
	return {
		fetchedAt,
		scope: "subscription",
		windows: [
			...quotaWindow("5h", usage.windowLimits?.fiveHour),
			...quotaWindow("weekly", usage.windowLimits?.weekly),
		],
		balances: [
			{
				unit: "credits",
				remaining: usage.credits.monthlyCredits,
				...(usage.summary
					? { total: usage.credits.monthlyCredits + usage.summary.totalMonthlyCredits }
					: {}),
			},
		],
		detail: usage,
	};
}

export type CommandCodeUsageSubject = UsageSubject<
	CommandCodeProviderSettings & { apiKey: string }
>;

/** One settings-key probe. CLI auth has no corresponding credential and stays uncached. */
export async function probeCommandCodeQuota(
	credential: CommandCodeUsageSubject,
	signal: AbortSignal,
): Promise<QuotaSnapshot> {
	return commandCodeUsageSnapshot(
		await fetchCommandCodeUsage(credential.config.apiKey, credential.config.baseUrl, signal),
	);
}

const identity = (config: CommandCodeUsageSubject["config"]) =>
	JSON.stringify([commandCodeApiOrigin(config.baseUrl), config.apiKey]);

function settingsSubject(): CommandCodeUsageSubject | undefined {
	const configured = settings.commandCode;
	if (!configured?.apiKey) return undefined;
	const config = { ...configured, apiKey: configured.apiKey };
	const key = getProviderKeyStore().list(COMMAND_CODE_KEY_OWNER)[0];
	return key
		? { id: key.id, providerId: COMMAND_CODE_PREFIX, config: withProviderKey(config, key) }
		: { id: COMMAND_CODE_PREFIX, providerId: COMMAND_CODE_PREFIX, config };
}

function restoreSnapshot(snapshot: QuotaSnapshot): QuotaSnapshot {
	const detail = (snapshot.detail ?? {}) as Partial<CommandCodeUsage>;
	const parsed = parseCommandCodeCredits(detail);
	return commandCodeUsageSnapshot(
		{ ...parsed, summary: parseCommandCodeSummary(detail.summary) },
		snapshot.fetchedAt,
	);
}

function cachedSnapshot(subject: CommandCodeUsageSubject): QuotaSnapshot | undefined {
	return quotaStore.get(subject.id, identity(subject.config), restoreSnapshot);
}

const refreshes = new Map<string, Promise<CommandCodeUsage>>();

async function refreshUsage(subject: CommandCodeUsageSubject): Promise<CommandCodeUsage> {
	const key = identity(subject.config);
	const existing = refreshes.get(key);
	if (existing) return existing;
	const task = probeCommandCodeQuota(subject, new AbortController().signal)
		.then((snapshot) => {
			const current = settingsSubject();
			if (current?.id === subject.id && identity(current.config) === key) {
				quotaStore.set(subject.id, key, snapshot);
			}
			return snapshot.detail as CommandCodeUsage;
		})
		.finally(() => refreshes.delete(key));
	refreshes.set(key, task);
	return task;
}

/** Request-driven 60-second cache for a settings key; there is no polling timer. */
export async function getCommandCodeUsageFromSettings(): Promise<CommandCodeUsage | undefined> {
	const subject = settingsSubject();
	if (!subject) return undefined;
	const cached = cachedSnapshot(subject);
	if (cached && Date.now() - cached.fetchedAt < COMMAND_CODE_USAGE_STALE_MS) {
		return cached.detail as CommandCodeUsage;
	}
	return refreshUsage(subject);
}
