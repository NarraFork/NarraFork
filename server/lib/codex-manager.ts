// Codex Credential Manager — multi-account support with failover and load balancing
// Manages ChatGPT Pro/Plus OAuth tokens for the codex provider

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
	type CodexTokens,
	extractCodexTokenInfo,
	pollDeviceCodeFlow,
	refreshCodexToken,
	startBrowserOAuth,
	startDeviceCodeFlow,
} from "./codex-auth";
import { type CodexUsageResult, fetchCodexUsage } from "./codex-usage";
import { codexUsageQueue, type UsageQueueSnapshot } from "./codex-usage-queue";
import {
	buildCodexUsageForecast,
	buildCodexUsageSummary,
	CODEX_USAGE_FORECAST_HISTORY_MS,
	type CodexPlanTier,
	type CodexUsageForecast,
	type CodexUsageHistoryEntry,
	type CodexUsageSummary,
	createCodexUsageHistoryEntry,
	getScheduledUsageResetAt,
	normalizeCodexPlanTier,
} from "./codex-usage-summary";
import { eventBus } from "./event-bus";
import { generateShortId } from "./id";
import { logger } from "./logger";

// === Constants ===

const MAX_FAILURES_PER_CREDENTIAL = 3;
const USAGE_TTL_MS = 5 * 60_000;
const CREDENTIALS_FILE = "codex-credentials.json";
const STATS_FILE = "codex-stats.json";
const SESSION_AFFINITY_TTL_MS = 6 * 60 * 60_000; // 6h
const MAX_SESSION_AFFINITY_ENTRIES = 2_000;
const USAGE_RESET_REFRESH_GRACE_MS = 1_000;
const USAGE_RESET_RETRY_DELAY_MS = 5 * 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const QUOTA_OVERVIEW_BROADCAST_DEBOUNCE_MS = 100;
const USAGE_HISTORY_RETENTION_MS = CODEX_USAGE_FORECAST_HISTORY_MS * 2;
const MAX_USAGE_HISTORY_ENTRIES_PER_CREDENTIAL = 240;
const USAGE_HISTORY_DEDUPE_WINDOW_MS = 60_000;

// === Types ===

export type DisabledReason = "manual" | "too_many_failures" | "quota_exhausted" | "banned";
export type LoadBalancingMode = "priority" | "balanced" | "tier-balanced";

const UNHEALTHY_DISABLED_REASONS: readonly DisabledReason[] = ["too_many_failures", "banned"];
const UNHEALTHY_DISABLED_REASON_SET = new Set<DisabledReason>(UNHEALTHY_DISABLED_REASONS);

export const DEFAULT_CODEX_TIER_ORDER: CodexPlanTier[] = [
	"pro",
	"prolite",
	"plus",
	"team",
	"k12",
	"free",
];
const ALL_CODEX_TIER_ORDER: CodexPlanTier[] = [...DEFAULT_CODEX_TIER_ORDER, "other"];

export function normalizeCodexTierOrder(order?: readonly string[] | null): CodexPlanTier[] {
	const validTiers = new Set<CodexPlanTier>(ALL_CODEX_TIER_ORDER);
	const result: CodexPlanTier[] = [];
	for (const tier of order ?? []) {
		if (!validTiers.has(tier as CodexPlanTier)) continue;
		if (!result.includes(tier as CodexPlanTier)) result.push(tier as CodexPlanTier);
	}
	return result.length > 0 ? result : [...DEFAULT_CODEX_TIER_ORDER];
}

export interface CodexCredential {
	id: string;
	displayName?: string;
	refreshToken?: string;
	accessToken?: string;
	expiresAt?: number;
	accountId?: string;
	email?: string;
	/** JWT subject claim — unique per user, used for deduplication. */
	sub?: string;
	priority: number;
	disabled: boolean;
	disabledReason?: DisabledReason;
	/** Epoch milliseconds when quota resets (from API error.resets_at). */
	quotaResetsAt?: number;
	/** Cached usage snapshot persisted with credential. */
	usage?: CodexUsageResult;
	/** Rolling usage snapshots used to extend quota forecasts into the recent past. */
	usageHistory?: CodexUsageHistoryEntry[];
}

export interface CredentialStats {
	successCount: number;
	failureCount: number;
	lastUsedAt?: string;
}

function isUnhealthyDisabledCredential(entry: {
	disabled?: boolean;
	disabledReason?: DisabledReason;
}): boolean {
	return (
		!!entry.disabled &&
		!!entry.disabledReason &&
		UNHEALTHY_DISABLED_REASON_SET.has(entry.disabledReason)
	);
}

export interface CredentialSnapshot {
	id: string;
	displayName?: string;
	accountId?: string;
	email?: string;
	priority: number;
	disabled: boolean;
	disabledReason?: DisabledReason;
	successCount: number;
	failureCount: number;
	lastUsedAt?: string;
	expiresAt?: number;
	quotaResetsAt?: number;
	usage?: CodexUsageResult;
}

export interface UsageSchedulerSnapshot {
	nextRunAt?: number;
	scheduledCredentialCount: number;
	dueCredentialCount: number;
	started: boolean;
}

export interface ManagerSnapshot {
	entries: CredentialSnapshot[];
	availableEntries: CredentialSnapshot[];
	unavailableEntries: CredentialSnapshot[];
	availableTotal: number;
	unavailableTotal: number;
	unhealthyTotal: number;
	currentId: string;
	loadBalancingMode: LoadBalancingMode;
	tierOrder: CodexPlanTier[];
	effectiveTierOrder: CodexPlanTier[];
	total: number;
	available: number;
	stickySessionCount: number;
	usageCache: Record<string, CodexUsageResult>;
	usageSummary: CodexUsageSummary;
	usageForecast: CodexUsageForecast;
	usageScheduler: UsageSchedulerSnapshot;
	usageQueue?: UsageQueueSnapshot;
	/** Last browser OAuth error message (cleared on success). */
	lastBrowserAuthError?: string;
}

export type PublicCodexPlanTier = Exclude<CodexPlanTier, "other">;

export interface PublicCodexQuotaSegment {
	type: PublicCodexPlanTier;
	remainingAccountEquivalents: number;
	totalAccountEquivalents: number;
	averageRemainingPercent: number | null;
	nextResetAt: number | null;
}

export interface PublicCodexQuotaTrendPoint {
	timestamp: number;
	byType: Partial<Record<PublicCodexPlanTier, number>>;
}

export interface PublicCodexQuotaOverview {
	generatedAt: string;
	unit: "account_equivalent";
	totalRemainingAccountEquivalents: number;
	totalAccountEquivalents: number;
	segments: PublicCodexQuotaSegment[];
	trend: {
		generatedAt: string;
		points: PublicCodexQuotaTrendPoint[];
		types: PublicCodexPlanTier[];
	};
	nextResetAt: number | null;
	usageQueueRunning: boolean;
	schedulerStarted: boolean;
}

export interface SnapshotOptions {
	availablePage?: number;
	unavailablePage?: number;
	pageSize?: number;
}

export interface CallContext {
	id: string;
	credential: CodexCredential;
	token: string;
}

export interface CodexImportCredentialInput {
	refreshToken?: string;
	refresh_token?: string;
	accessToken?: string;
	access_token?: string;
	expiresAt?: number | string;
	expires_at?: number | string;
	accountId?: string;
	account_id?: string;
	email?: string;
	sub?: string;
	displayName?: string;
	display_name?: string;
	name?: string;
	priority?: number;
	/** Optional user metadata object used by account exports. */
	user?: Record<string, unknown>;
	/** Nested credential object used by sub2api-style account exports. */
	credentials?: Record<string, unknown>;
	/** Optional metadata object used by sub2api-style account exports. */
	extra?: Record<string, unknown>;
}

interface PendingDeviceFlow {
	deviceAuthId: string;
	userCode: string;
	abortController: AbortController;
	resolve: (tokens: CodexTokens) => void;
	reject: (error: Error) => void;
}

interface SessionAffinityEntry {
	credentialId: string;
	lastUsedAt: number;
}

// === File paths ===

function getCredentialsPath(baseDir = homedir()): string {
	return resolve(baseDir, ".narrafork", CREDENTIALS_FILE);
}

function getStatsPath(baseDir = homedir()): string {
	return resolve(baseDir, ".narrafork", STATS_FILE);
}

// === Helpers ===

function sha256Hex(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

const EMAIL_SEARCH_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const AT_MARKER_DISPLAY_PATTERN = /(?:^|-{4,})\s*at\s*(?:-{4,}|$)/i;
const REFRESH_TOKEN_DISPLAY_PATTERN = /rt_[A-Za-z0-9._-]+/;

function normalizeOptionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function extractEmailFromString(value: unknown): string | undefined {
	const text = normalizeOptionalString(value);
	return text?.match(EMAIL_SEARCH_PATTERN)?.[0];
}

function isSerializedCodexCredentialLabel(value: unknown): boolean {
	const text = normalizeOptionalString(value);
	if (!text?.includes("----")) return false;
	return AT_MARKER_DISPLAY_PATTERN.test(text) || REFRESH_TOKEN_DISPLAY_PATTERN.test(text);
}

function safeCredentialDisplayName(value: unknown): string | undefined {
	const text = normalizeOptionalString(value);
	if (!text || isSerializedCodexCredentialLabel(text)) return undefined;
	return text;
}

function firstSafeCredentialDisplayName(...values: unknown[]): string | undefined {
	for (const value of values) {
		const normalized = safeCredentialDisplayName(value);
		if (normalized) return normalized;
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function optionalRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function firstOptionalString(...values: unknown[]): string | undefined {
	for (const value of values) {
		const normalized = normalizeOptionalString(value);
		if (normalized) return normalized;
	}
	return undefined;
}

function firstOptionalNumber(...values: unknown[]): number | undefined {
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

function getRefreshToken(cred: Pick<CodexCredential, "refreshToken">): string | undefined {
	return normalizeOptionalString(cred.refreshToken);
}

function getAccessToken(cred: Pick<CodexCredential, "accessToken">): string | undefined {
	return normalizeOptionalString(cred.accessToken);
}

function hasRefreshToken(cred: Pick<CodexCredential, "refreshToken">): boolean {
	return !!getRefreshToken(cred);
}

function normalizeExpiresAt(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		// OAuth-style imports sometimes use Unix seconds; internal storage uses milliseconds.
		return value > 0 && value < 100_000_000_000 ? value * 1000 : value;
	}
	if (typeof value !== "string" || !value.trim()) return undefined;
	const numeric = Number(value);
	if (Number.isFinite(numeric)) return normalizeExpiresAt(numeric);
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function getCredentialDedupeKeys(
	cred: Pick<CodexCredential, "refreshToken" | "accessToken" | "accountId" | "email" | "sub">,
): string[] {
	const keys: string[] = [];
	const refreshToken = getRefreshToken(cred);
	const accessToken = getAccessToken(cred);
	if (refreshToken) keys.push(`rt:${sha256Hex(refreshToken)}`);
	if (cred.sub) keys.push(`sub:${cred.sub}`);
	if (cred.accountId && cred.email) keys.push(`account-email:${cred.accountId}:${cred.email}`);
	if (accessToken) keys.push(`at:${sha256Hex(accessToken)}`);
	return keys;
}

function isExpired(cred: CodexCredential): boolean {
	return isExpiringWithin(cred, 5) ?? true;
}

function isExpiringSoon(cred: CodexCredential): boolean {
	return isExpiringWithin(cred, 10) ?? false;
}

function isExpiringWithin(cred: CodexCredential, minutes: number): boolean | null {
	if (!cred.expiresAt) return null;
	return cred.expiresAt <= Date.now() + minutes * 60_000;
}

function createCredentialFromImport(
	input: CodexImportCredentialInput,
	defaultPriority: number,
): CodexCredential | null {
	const user = optionalRecord(input.user);
	const nestedCredentials = optionalRecord(input.credentials);
	const extra = optionalRecord(input.extra);
	const refreshToken = firstOptionalString(
		input.refreshToken,
		input.refresh_token,
		nestedCredentials.refreshToken,
		nestedCredentials.refresh_token,
	);
	const accessToken = firstOptionalString(
		input.accessToken,
		input.access_token,
		nestedCredentials.accessToken,
		nestedCredentials.access_token,
	);
	if (!refreshToken && !accessToken) return null;

	const tokenInfo = extractCodexTokenInfo({ accessToken });
	const accountId = firstOptionalString(
		input.accountId,
		input.account_id,
		nestedCredentials.accountId,
		nestedCredentials.account_id,
		nestedCredentials.chatgptAccountId,
		nestedCredentials.chatgpt_account_id,
		tokenInfo.accountId,
	);
	const email = firstOptionalString(
		input.email,
		user.email,
		nestedCredentials.email,
		extra.email,
		tokenInfo.email,
		extractEmailFromString(input.displayName),
		extractEmailFromString(input.display_name),
		extractEmailFromString(input.name),
		extractEmailFromString(nestedCredentials.displayName),
		extractEmailFromString(nestedCredentials.display_name),
	);
	const sub = firstOptionalString(
		input.sub,
		nestedCredentials.sub,
		nestedCredentials.chatgptUserId,
		nestedCredentials.chatgpt_user_id,
		tokenInfo.sub,
	);
	const displayName = firstOptionalString(
		firstSafeCredentialDisplayName(
			input.displayName,
			input.display_name,
			input.name,
			nestedCredentials.displayName,
			nestedCredentials.display_name,
		),
		email,
		accountId,
	);
	const expiresAt = normalizeExpiresAt(
		input.expiresAt ??
			input.expires_at ??
			nestedCredentials.expiresAt ??
			nestedCredentials.expires_at,
	);
	const priority =
		firstOptionalNumber(input.priority, nestedCredentials.priority) ?? defaultPriority;

	return {
		id: generateShortId(),
		...(refreshToken ? { refreshToken } : {}),
		...(accessToken ? { accessToken } : {}),
		...(expiresAt !== undefined ? { expiresAt } : {}),
		...(accountId ? { accountId } : {}),
		...(email ? { email } : {}),
		...(sub ? { sub } : {}),
		...(displayName ? { displayName } : {}),
		priority,
		disabled: false,
	};
}

// === CodexManager ===

export class CodexManager {
	private entries: CodexCredential[];
	private stats: Map<string, CredentialStats>;
	private currentId: string;
	private loadBalancingMode: LoadBalancingMode;
	private tierOrder: CodexPlanTier[];
	private refreshPromises = new Map<string, Promise<CodexCredential>>();
	private pendingDeviceFlow: PendingDeviceFlow | undefined;
	private usageRefreshPromises = new Map<string, Promise<CodexUsageResult>>();
	private sessionAffinity = new Map<string, SessionAffinityEntry>();
	private readonly beforeExitHandler: () => void;
	/** Exposed via snapshot so the frontend can show browser-auth errors. */
	private _lastBrowserAuthError?: string;
	private usageSchedulerTimer?: ReturnType<typeof setTimeout>;
	private usageSchedulerStarted = false;
	private usageSchedulerNextRunAt?: number;
	private usageSchedulerRetryAfter = new Map<string, number>();
	private quotaOverviewBroadcastTimer?: ReturnType<typeof setTimeout>;

	constructor(private readonly options?: { homeDir?: string; registerProcessHooks?: boolean }) {
		this.entries = [];
		this.stats = new Map();
		this.currentId = "";
		this.loadBalancingMode = "tier-balanced";
		this.tierOrder = [...DEFAULT_CODEX_TIER_ORDER];

		this.loadCredentials();
		this.loadStats();

		this.beforeExitHandler = () => {
			this.saveStats();
		};
		if (this.options?.registerProcessHooks ?? true) {
			process.on("beforeExit", this.beforeExitHandler);
		}
	}

	dispose(): void {
		this.stopUsageRefreshScheduler();
		if (this.quotaOverviewBroadcastTimer) {
			clearTimeout(this.quotaOverviewBroadcastTimer);
			this.quotaOverviewBroadcastTimer = undefined;
		}
		process.off("beforeExit", this.beforeExitHandler);
	}

	// ==================== Credential Selection ====================

	async acquireContext(sessionKey?: string): Promise<CallContext> {
		this.reviveQuotaResetCredentials();
		this.applyCachedQuotaStates();
		this.pruneSessionAffinity();
		const total = this.entries.length;
		const triedIds = new Set<string>();
		const stickyEnabled =
			(this.loadBalancingMode === "balanced" || this.loadBalancingMode === "tier-balanced") &&
			!!sessionKey;

		if (stickyEnabled && sessionKey) {
			const sticky = this.sessionAffinity.get(sessionKey);
			if (sticky) {
				const stickyEntry = this.entries.find((e) => e.id === sticky.credentialId);
				if (!stickyEntry || stickyEntry.disabled) {
					this.unbindSession(sessionKey);
				} else {
					const ctx = await this.tryEnsureToken(stickyEntry);
					if (ctx) {
						this.bindSession(sessionKey, ctx.id);
						return ctx;
					}
					triedIds.add(stickyEntry.id);
					this.unbindSession(sessionKey);
				}
			}
		}

		while (triedIds.size < total) {
			const entry = this.selectEntry(triedIds);

			if (!entry) {
				// Try self-healing
				if (this.trySelfHeal()) {
					const healed = this.selectEntry(triedIds);
					if (healed) {
						const ctx = await this.tryEnsureToken(healed);
						if (ctx) {
							if (stickyEnabled && sessionKey) this.bindSession(sessionKey, ctx.id);
							return ctx;
						}
						triedIds.add(healed.id);
					}
				}
				break;
			}

			const ctx = await this.tryEnsureToken(entry);
			if (ctx) {
				if (stickyEnabled && sessionKey) this.bindSession(sessionKey, ctx.id);
				return ctx;
			}

			triedIds.add(entry.id);
		}

		if (stickyEnabled && sessionKey) {
			this.unbindSession(sessionKey);
		}
		throw new Error(`All Codex credentials exhausted (available: ${this.availableCount}/${total})`);
	}

	private selectEntry(excludeIds?: Set<string>): CodexCredential | null {
		const available = this.entries.filter((e) => {
			if (e.disabled) return false;
			if (excludeIds?.has(e.id)) return false;
			return true;
		});

		if (available.length === 0) return null;

		if (this.loadBalancingMode === "balanced") {
			return this.selectRandomEntry(available);
		}

		if (this.loadBalancingMode === "tier-balanced") {
			const effectiveTierOrder = this.getEffectiveTierOrder();
			let bestTierRank = Number.POSITIVE_INFINITY;
			let bestTierEntries: CodexCredential[] = [];

			for (const entry of available) {
				const tier = normalizeCodexPlanTier(entry.usage?.plan_type);
				const tierRank = effectiveTierOrder.indexOf(tier);
				const rank = tierRank >= 0 ? tierRank : effectiveTierOrder.length;
				if (rank < bestTierRank) {
					bestTierRank = rank;
					bestTierEntries = [entry];
				} else if (rank === bestTierRank) {
					bestTierEntries.push(entry);
				}
			}

			return this.selectRandomEntry(bestTierEntries);
		}

		// Priority mode: lowest priority number first
		return available.reduce((best, e) => (e.priority < best.priority ? e : best));
	}

	private selectRandomEntry(entries: CodexCredential[]): CodexCredential | null {
		if (entries.length === 0) return null;
		const randomIndex = Math.floor(Math.random() * entries.length);
		return entries[randomIndex] ?? entries[0];
	}

	private getEffectiveTierOrder(): CodexPlanTier[] {
		const order = normalizeCodexTierOrder(this.tierOrder);
		for (const tier of ALL_CODEX_TIER_ORDER) {
			if (!order.includes(tier)) order.push(tier);
		}
		return order;
	}

	private async tryEnsureToken(entry: CodexCredential): Promise<CallContext | null> {
		const accessToken = getAccessToken(entry);
		const needsRefresh = isExpired(entry) || isExpiringSoon(entry);

		if (!needsRefresh && accessToken) {
			this.currentId = entry.id;
			return { id: entry.id, credential: entry, token: accessToken };
		}

		if (!hasRefreshToken(entry)) {
			// Access-token-only imports cannot refresh. Use the token when expiry is unknown;
			// skip it only when we explicitly know it is already expired/near expiry.
			if (accessToken && !entry.expiresAt) {
				this.currentId = entry.id;
				return { id: entry.id, credential: entry, token: accessToken };
			}
			return null;
		}

		try {
			const refreshed = await this.deduplicatedRefresh(entry.id, entry);
			Object.assign(entry, {
				accessToken: refreshed.accessToken,
				refreshToken: refreshed.refreshToken,
				expiresAt: refreshed.expiresAt,
				accountId: refreshed.accountId,
				email: refreshed.email,
				sub: refreshed.sub,
			});

			this.saveCredentials();

			this.currentId = entry.id;
			return { id: entry.id, credential: entry, token: entry.accessToken ?? "" };
		} catch {
			return null;
		}
	}

	private async deduplicatedRefresh(id: string, cred: CodexCredential): Promise<CodexCredential> {
		const existing = this.refreshPromises.get(id);
		if (existing) return existing;

		const refreshToken = getRefreshToken(cred);
		if (!refreshToken) {
			throw new Error(
				"Credential has no refresh token; access-token-only credentials cannot refresh",
			);
		}

		const promise = (async () => {
			const { resolveOverride } = await import("./net/proxy");
			const { settings } = await import("./settings");
			const proxy = resolveOverride(settings.codex?.proxy);
			const tokens = await refreshCodexToken(refreshToken, proxy);
			return {
				...cred,
				accessToken: tokens.accessToken,
				refreshToken: tokens.refreshToken,
				expiresAt: tokens.expiresAt,
				accountId: tokens.accountId ?? cred.accountId,
				email: tokens.email ?? cred.email,
				sub: tokens.sub ?? cred.sub,
			};
		})().finally(() => {
			this.refreshPromises.delete(id);
		});

		this.refreshPromises.set(id, promise);
		return promise;
	}

	private bindSession(sessionKey: string, credentialId: string): void {
		this.sessionAffinity.set(sessionKey, { credentialId, lastUsedAt: Date.now() });
		this.pruneSessionAffinity();
	}

	private unbindSession(sessionKey: string): void {
		this.sessionAffinity.delete(sessionKey);
	}

	private evictSessionsByCredential(credentialId: string): void {
		for (const [sessionKey, binding] of this.sessionAffinity) {
			if (binding.credentialId === credentialId) {
				this.sessionAffinity.delete(sessionKey);
			}
		}
	}

	private pruneSessionAffinity(now = Date.now()): void {
		for (const [sessionKey, binding] of this.sessionAffinity) {
			if (now - binding.lastUsedAt > SESSION_AFFINITY_TTL_MS) {
				this.sessionAffinity.delete(sessionKey);
			}
		}
		if (this.sessionAffinity.size <= MAX_SESSION_AFFINITY_ENTRIES) return;
		const sorted = [...this.sessionAffinity.entries()].sort(
			(a, b) => a[1].lastUsedAt - b[1].lastUsedAt,
		);
		const overflow = this.sessionAffinity.size - MAX_SESSION_AFFINITY_ENTRIES;
		for (let i = 0; i < overflow; i++) {
			const item = sorted[i];
			if (item) this.sessionAffinity.delete(item[0]);
		}
	}

	// ==================== Reporting ====================

	reportSuccess(id: string): void {
		const stats = this.stats.get(id) ?? { successCount: 0, failureCount: 0 };
		stats.failureCount = 0;
		stats.successCount++;
		stats.lastUsedAt = new Date().toISOString();
		this.stats.set(id, stats);
		this.saveStatsDebounced();
	}

	reportFailure(id: string): boolean {
		const stats = this.stats.get(id) ?? { successCount: 0, failureCount: 0 };
		stats.failureCount++;
		stats.lastUsedAt = new Date().toISOString();
		this.stats.set(id, stats);

		const entry = this.entries.find((e) => e.id === id);
		if (entry && stats.failureCount >= MAX_FAILURES_PER_CREDENTIAL) {
			entry.disabled = true;
			entry.disabledReason = "too_many_failures";
			this.evictSessionsByCredential(id);
			this.saveCredentials();
			this.schedulePublicQuotaOverviewBroadcast();
		}

		this.saveStatsDebounced();
		this.rescheduleUsageRefresh();
		return this.entries.some((e) => !e.disabled);
	}

	reportQuotaExhausted(id: string, resetsAt?: number): boolean {
		const stats = this.stats.get(id) ?? { successCount: 0, failureCount: 0 };
		stats.failureCount = MAX_FAILURES_PER_CREDENTIAL;
		stats.lastUsedAt = new Date().toISOString();
		this.stats.set(id, stats);

		const entry = this.entries.find((e) => e.id === id);
		if (entry) {
			entry.disabled = true;
			entry.disabledReason = "quota_exhausted";
			entry.quotaResetsAt = resetsAt ?? entry.quotaResetsAt;
			this.evictSessionsByCredential(id);
			this.saveCredentials();
			this.schedulePublicQuotaOverviewBroadcast();
		}

		this.saveStatsDebounced();
		this.rescheduleUsageRefresh();
		return this.entries.some((e) => !e.disabled);
	}

	async reportQuotaExhaustedAndRefreshUsage(id: string, resetsAt?: number): Promise<boolean> {
		this.reportQuotaExhausted(id, resetsAt);
		try {
			await this.refreshUsageDeduplicated(id);
		} catch (err) {
			logger.warn("Codex usage refresh after quota error failed", {
				credentialId: id,
				error: err instanceof Error ? err.message : String(err),
			});
		}

		const entry = this.entries.find((e) => e.id === id);
		if (entry?.disabledReason !== "quota_exhausted") {
			const refreshedQuotaState = entry?.usage
				? this.evaluateQuotaFromUsage(entry.usage)
				: undefined;
			this.reportQuotaExhausted(
				id,
				refreshedQuotaState?.exhausted ? refreshedQuotaState.resetsAt : resetsAt,
			);
		}
		return this.entries.some((e) => !e.disabled);
	}

	markBanned(id: string): boolean {
		const stats = this.stats.get(id) ?? { successCount: 0, failureCount: 0 };
		stats.failureCount = MAX_FAILURES_PER_CREDENTIAL;
		stats.lastUsedAt = new Date().toISOString();
		this.stats.set(id, stats);

		const entry = this.entries.find((e) => e.id === id);
		if (entry) {
			entry.disabled = true;
			entry.disabledReason = "banned";
			entry.quotaResetsAt = undefined;
			this.evictSessionsByCredential(id);
			this.saveCredentials();
			this.schedulePublicQuotaOverviewBroadcast();
		}

		this.saveStatsDebounced();
		this.rescheduleUsageRefresh();
		return this.entries.some((e) => !e.disabled);
	}

	// ==================== Self-healing ====================

	private trySelfHeal(): boolean {
		const revivedQuota = this.reviveQuotaResetCredentials();
		const hasTooManyFailures = this.entries.some(
			(e) => e.disabled && e.disabledReason === "too_many_failures",
		);
		if (!hasTooManyFailures) return revivedQuota;

		for (const e of this.entries) {
			if (e.disabledReason === "too_many_failures") {
				e.disabled = false;
				e.disabledReason = undefined;
				const stats = this.stats.get(e.id);
				if (stats) stats.failureCount = 0;
			}
		}
		this.saveCredentials();
		this.schedulePublicQuotaOverviewBroadcast();
		return true;
	}

	private reviveQuotaResetCredentials(now = Date.now()): boolean {
		let changed = false;
		for (const e of this.entries) {
			if (e.disabledReason !== "quota_exhausted") continue;
			if (!e.quotaResetsAt || e.quotaResetsAt > now) continue;
			e.disabled = false;
			e.disabledReason = undefined;
			e.quotaResetsAt = undefined;
			const stats = this.stats.get(e.id);
			if (stats) stats.failureCount = 0;
			changed = true;
		}
		if (changed) {
			this.saveCredentials();
			this.saveStatsDebounced();
			this.rescheduleUsageRefresh();
			this.schedulePublicQuotaOverviewBroadcast();
		}
		return changed;
	}

	// ==================== Usage Reset Scheduler ====================

	startUsageRefreshScheduler(): void {
		if (this.usageSchedulerStarted) return;
		this.usageSchedulerStarted = true;
		this.rescheduleUsageRefresh();
		this.schedulePublicQuotaOverviewBroadcast();
	}

	stopUsageRefreshScheduler(): void {
		const wasStarted = this.usageSchedulerStarted;
		this.usageSchedulerStarted = false;
		if (this.usageSchedulerTimer) {
			clearTimeout(this.usageSchedulerTimer);
			this.usageSchedulerTimer = undefined;
		}
		this.usageSchedulerNextRunAt = undefined;
		if (wasStarted) this.schedulePublicQuotaOverviewBroadcast();
	}

	private shouldTrackUsageReset(entry: CodexCredential): boolean {
		if (
			entry.disabledReason === "manual" ||
			entry.disabledReason === "too_many_failures" ||
			entry.disabledReason === "banned"
		) {
			return false;
		}
		return !entry.disabled || entry.disabledReason === "quota_exhausted";
	}

	private getCredentialUsageResetAt(entry: CodexCredential): number | undefined {
		if (entry.disabledReason === "quota_exhausted" && entry.quotaResetsAt) {
			return entry.quotaResetsAt;
		}
		return getScheduledUsageResetAt(entry.usage);
	}

	private getUsageRefreshSchedule(now = Date.now()): {
		nextRunAt?: number;
		scheduledCredentialCount: number;
		dueCredentialIds: string[];
	} {
		let nextRunAt: number | undefined;
		let scheduledCredentialCount = 0;
		const dueCredentialIds: string[] = [];

		for (const entry of this.entries) {
			if (!this.shouldTrackUsageReset(entry)) continue;
			const resetAt = this.getCredentialUsageResetAt(entry);
			if (!resetAt) continue;

			scheduledCredentialCount++;
			if (resetAt > now) {
				this.usageSchedulerRetryAfter.delete(entry.id);
				nextRunAt = Math.min(nextRunAt ?? resetAt, resetAt);
				continue;
			}

			const retryAfter = this.usageSchedulerRetryAfter.get(entry.id);
			if (retryAfter && retryAfter > now) {
				nextRunAt = Math.min(nextRunAt ?? retryAfter, retryAfter);
				continue;
			}

			dueCredentialIds.push(entry.id);
		}

		return { nextRunAt, scheduledCredentialCount, dueCredentialIds };
	}

	private rescheduleUsageRefresh(): void {
		if (!this.usageSchedulerStarted) return;
		if (this.usageSchedulerTimer) {
			clearTimeout(this.usageSchedulerTimer);
			this.usageSchedulerTimer = undefined;
		}

		const now = Date.now();
		const schedule = this.getUsageRefreshSchedule(now + USAGE_RESET_REFRESH_GRACE_MS);
		const nextRunAt = schedule.dueCredentialIds.length > 0 ? now : schedule.nextRunAt;
		this.usageSchedulerNextRunAt = nextRunAt;

		if (!nextRunAt) return;

		const delay =
			schedule.dueCredentialIds.length > 0
				? 0
				: Math.max(0, nextRunAt - now + USAGE_RESET_REFRESH_GRACE_MS);
		this.usageSchedulerTimer = setTimeout(
			() => this.handleScheduledUsageRefresh(),
			Math.min(delay, MAX_TIMER_DELAY_MS),
		);
		(this.usageSchedulerTimer as { unref?: () => void }).unref?.();
	}

	private handleScheduledUsageRefresh(): void {
		this.usageSchedulerTimer = undefined;
		const now = Date.now();
		const schedule = this.getUsageRefreshSchedule(now + USAGE_RESET_REFRESH_GRACE_MS);
		const dueCredentialIds = schedule.dueCredentialIds;

		if (dueCredentialIds.length > 0) {
			for (const id of dueCredentialIds) {
				this.usageSchedulerRetryAfter.set(id, now + USAGE_RESET_RETRY_DELAY_MS);
			}
			codexUsageQueue.enqueueMany(dueCredentialIds);
			logger.info("Scheduled Codex usage refresh for reset credentials", {
				count: dueCredentialIds.length,
			});
		}

		this.rescheduleUsageRefresh();
	}

	private getUsageSchedulerSnapshot(): UsageSchedulerSnapshot {
		const schedule = this.getUsageRefreshSchedule();
		return {
			nextRunAt: this.usageSchedulerNextRunAt ?? schedule.nextRunAt,
			scheduledCredentialCount: schedule.scheduledCredentialCount,
			dueCredentialCount: schedule.dueCredentialIds.length,
			started: this.usageSchedulerStarted,
		};
	}

	getPublicQuotaOverview(): PublicCodexQuotaOverview {
		this.reviveQuotaResetCredentials();
		this.applyCachedQuotaStates();
		this.pruneSessionAffinity();

		const now = Date.now();
		const summary = buildCodexUsageSummary(this.entries, now);
		const trend = buildCodexUsageForecast(this.entries, now);
		const visibleTiers = this.getEffectiveTierOrder().filter(
			(tier): tier is PublicCodexPlanTier =>
				tier !== "other" && (summary.byTier[tier]?.accountCount ?? 0) > 0,
		);
		const segments = visibleTiers.map((tier) => {
			const stats = summary.byTier[tier];
			return {
				type: tier,
				remainingAccountEquivalents: stats.remainingAccountEquivalents,
				totalAccountEquivalents: stats.accountCount,
				averageRemainingPercent: stats.averageRemainingPercent,
				nextResetAt: stats.nextResetAt ?? null,
			};
		});
		const totalRemainingAccountEquivalents = Number(
			segments.reduce((sum, segment) => sum + segment.remainingAccountEquivalents, 0).toFixed(4),
		);
		const totalAccountEquivalents = segments.reduce(
			(sum, segment) => sum + segment.totalAccountEquivalents,
			0,
		);
		const points = trend.points.map((point) => {
			const byType = Object.fromEntries(
				visibleTiers.map((tier) => [tier, point.byTier[tier] ?? 0]),
			) as Partial<Record<PublicCodexPlanTier, number>>;
			return { timestamp: point.timestamp, byType };
		});

		return {
			generatedAt: summary.generatedAt,
			unit: trend.unit,
			totalRemainingAccountEquivalents,
			totalAccountEquivalents,
			segments,
			trend: {
				generatedAt: trend.generatedAt,
				points,
				types: visibleTiers,
			},
			nextResetAt: summary.nextResetAt ?? null,
			usageQueueRunning: codexUsageQueue.getSnapshot().isRunning,
			schedulerStarted: this.usageSchedulerStarted,
		};
	}

	private broadcastPublicQuotaOverview(): void {
		eventBus.emit({
			type: "codex:quota_overview_updated",
			overview: this.getPublicQuotaOverview(),
		});
	}

	private schedulePublicQuotaOverviewBroadcast(): void {
		if (this.quotaOverviewBroadcastTimer) return;
		this.quotaOverviewBroadcastTimer = setTimeout(() => {
			this.quotaOverviewBroadcastTimer = undefined;
			this.broadcastPublicQuotaOverview();
		}, QUOTA_OVERVIEW_BROADCAST_DEBOUNCE_MS);
		(this.quotaOverviewBroadcastTimer as { unref?: () => void }).unref?.();
	}

	// ==================== Admin API ====================

	snapshot(opts?: SnapshotOptions): ManagerSnapshot {
		this.reviveQuotaResetCredentials();
		this.applyCachedQuotaStates();
		this.pruneSessionAffinity();

		const mapEntry = (e: CodexCredential): CredentialSnapshot => {
			const stats = this.stats.get(e.id);
			const displayName = isSerializedCodexCredentialLabel(e.displayName)
				? firstOptionalString(e.email, e.accountId)
				: e.displayName;
			return {
				id: e.id,
				displayName,
				accountId: e.accountId,
				email: e.email,
				priority: e.priority,
				disabled: e.disabled,
				disabledReason: e.disabledReason,
				successCount: stats?.successCount ?? 0,
				failureCount: stats?.failureCount ?? 0,
				lastUsedAt: stats?.lastUsedAt,
				expiresAt: e.expiresAt,
				quotaResetsAt: e.quotaResetsAt,
				usage: e.usage,
			};
		};

		const allAvailable = this.entries.filter((e) => !e.disabled);
		const allUnavailable = this.entries.filter((e) => e.disabled);
		const unhealthyTotal = this.entries.filter(isUnhealthyDisabledCredential).length;

		const pageSize = opts?.pageSize ?? 0; // 0 = no pagination
		const isPaged = pageSize > 0;

		const slicePage = (arr: CodexCredential[], page?: number): CodexCredential[] => {
			if (!isPaged || !page || page < 1) return arr;
			const maxPage = Math.max(1, Math.ceil(arr.length / pageSize));
			const safePage = Math.min(page, maxPage);
			const start = (safePage - 1) * pageSize;
			return arr.slice(start, start + pageSize);
		};

		const pagedAvailable = slicePage(allAvailable, opts?.availablePage);
		const pagedUnavailable = slicePage(allUnavailable, opts?.unavailablePage);

		const availableSnapshots = pagedAvailable.map(mapEntry);
		const unavailableSnapshots = pagedUnavailable.map(mapEntry);
		const allPagedEntries = [...availableSnapshots, ...unavailableSnapshots];

		// Only include usage for paged entries to reduce payload
		const usageCacheObj: Record<string, CodexUsageResult> = {};
		for (const snap of allPagedEntries) {
			if (snap.usage) usageCacheObj[snap.id] = snap.usage;
		}

		const now = Date.now();

		return {
			entries: allPagedEntries,
			availableEntries: availableSnapshots,
			unavailableEntries: unavailableSnapshots,
			availableTotal: allAvailable.length,
			unavailableTotal: allUnavailable.length,
			unhealthyTotal,
			currentId: this.currentId,
			loadBalancingMode: this.loadBalancingMode,
			tierOrder: [...this.tierOrder],
			effectiveTierOrder: this.getEffectiveTierOrder(),
			total: this.entries.length,
			available: allAvailable.length,
			stickySessionCount: this.sessionAffinity.size,
			usageCache: usageCacheObj,
			usageSummary: buildCodexUsageSummary(this.entries, now),
			usageForecast: buildCodexUsageForecast(this.entries, now),
			usageScheduler: this.getUsageSchedulerSnapshot(),
			usageQueue: codexUsageQueue.getSnapshot(),
			lastBrowserAuthError: this._lastBrowserAuthError,
		};
	}

	setLoadBalancingMode(mode: LoadBalancingMode): void {
		if (this.loadBalancingMode !== mode) {
			this.sessionAffinity.clear();
		}
		this.loadBalancingMode = mode;
	}

	setTierOrder(order?: readonly string[] | null): void {
		const next = normalizeCodexTierOrder(order);
		if (next.join(",") !== this.tierOrder.join(",")) {
			this.sessionAffinity.clear();
			this.tierOrder = next;
			this.schedulePublicQuotaOverviewBroadcast();
			return;
		}
		this.tierOrder = next;
	}

	setDisabled(id: string, disabled: boolean): void {
		const entry = this.entries.find((e) => e.id === id);
		if (!entry) throw new Error(`Credential not found: ${id}`);
		entry.disabled = disabled;
		if (!disabled) {
			const stats = this.stats.get(id);
			if (stats) stats.failureCount = 0;
			entry.disabledReason = undefined;
			entry.quotaResetsAt = undefined;
		} else {
			entry.disabledReason = "manual";
			this.evictSessionsByCredential(id);
		}
		this.saveCredentials();
		this.rescheduleUsageRefresh();
		this.schedulePublicQuotaOverviewBroadcast();
	}

	setPriority(id: string, priority: number): void {
		const entry = this.entries.find((e) => e.id === id);
		if (!entry) throw new Error(`Credential not found: ${id}`);
		entry.priority = priority;
		this.saveCredentials();
	}

	resetAndEnable(id: string): void {
		const entry = this.entries.find((e) => e.id === id);
		if (!entry) throw new Error(`Credential not found: ${id}`);
		entry.disabled = false;
		entry.disabledReason = undefined;
		entry.quotaResetsAt = undefined;
		const stats = this.stats.get(id);
		if (stats) stats.failureCount = 0;
		this.saveCredentials();
		this.rescheduleUsageRefresh();
		this.schedulePublicQuotaOverviewBroadcast();
	}

	removeCredential(id: string): void {
		const idx = this.entries.findIndex((e) => e.id === id);
		if (idx === -1) throw new Error(`Credential not found: ${id}`);
		this.entries.splice(idx, 1);
		this.stats.delete(id);
		this.usageRefreshPromises.delete(id);
		this.usageSchedulerRetryAfter.delete(id);
		this.evictSessionsByCredential(id);
		if (this.currentId === id) {
			this.currentId = this.entries[0]?.id ?? "";
		}
		this.saveCredentials();
		this.saveStats();
		this.rescheduleUsageRefresh();
		this.schedulePublicQuotaOverviewBroadcast();
	}

	removeCredentials(ids: string[]): { removed: string[]; notFound: string[] } {
		const removed: string[] = [];
		const notFound: string[] = [];
		for (const id of ids) {
			const idx = this.entries.findIndex((e) => e.id === id);
			if (idx === -1) {
				notFound.push(id);
				continue;
			}
			this.entries.splice(idx, 1);
			this.stats.delete(id);
			this.usageRefreshPromises.delete(id);
			this.usageSchedulerRetryAfter.delete(id);
			this.evictSessionsByCredential(id);
			removed.push(id);
		}
		if (this.currentId && !this.entries.find((e) => e.id === this.currentId)) {
			this.currentId = this.entries[0]?.id ?? "";
		}
		if (removed.length > 0) {
			this.saveCredentials();
			this.saveStats();
			this.rescheduleUsageRefresh();
			this.schedulePublicQuotaOverviewBroadcast();
		}
		return { removed, notFound };
	}

	removeUnhealthyCredentials(): { removed: string[]; reasons: DisabledReason[] } {
		const ids = this.entries.filter(isUnhealthyDisabledCredential).map((entry) => entry.id);
		const result = this.removeCredentials(ids);
		return { removed: result.removed, reasons: [...UNHEALTHY_DISABLED_REASONS] };
	}

	updateCredential(id: string, fields: { displayName?: string; priority?: number }): void {
		const entry = this.entries.find((e) => e.id === id);
		if (!entry) throw new Error(`Credential not found: ${id}`);
		if (fields.displayName !== undefined) entry.displayName = fields.displayName;
		if (fields.priority !== undefined) entry.priority = fields.priority;
		this.saveCredentials();
	}

	// ==================== OAuth Flows ====================

	async startBrowserAuth(): Promise<{ authorizeUrl: string }> {
		const { resolveOverride } = await import("./net/proxy");
		const { settings } = await import("./settings");
		const proxy = resolveOverride(settings.codex?.proxy);
		const { authorizeUrl, tokenPromise } = await startBrowserOAuth(proxy);

		// Clear previous error when a new flow starts
		this._lastBrowserAuthError = undefined;

		// Handle the result in background
		tokenPromise
			.then((tokens) => {
				this._lastBrowserAuthError = undefined;
				this.addCredentialFromTokens(tokens);
				logger.info("Codex browser auth completed", { accountId: tokens.accountId });
			})
			.catch((err) => {
				this._lastBrowserAuthError = err instanceof Error ? err.message : String(err);
				logger.warn("Codex browser auth failed", { error: this._lastBrowserAuthError });
			});

		return { authorizeUrl };
	}

	async startDeviceAuth(): Promise<{
		deviceAuthId: string;
		userCode: string;
		verificationUrl: string;
	}> {
		// Cancel any existing flow
		this.cancelDeviceAuth();

		const { resolveOverride } = await import("./net/proxy");
		const { settings } = await import("./settings");
		const proxy = resolveOverride(settings.codex?.proxy);
		const { deviceAuthId, userCode, verificationUrl, interval } = await startDeviceCodeFlow(proxy);

		const abortController = new AbortController();

		const tokenPromise = new Promise<CodexTokens>((resolve, reject) => {
			this.pendingDeviceFlow = {
				deviceAuthId,
				userCode,
				abortController,
				resolve,
				reject,
			};

			pollDeviceCodeFlow(deviceAuthId, userCode, interval, abortController.signal, proxy)
				.then(resolve)
				.catch(reject);
		});

		// Handle the result in background
		tokenPromise
			.then((tokens) => {
				this.addCredentialFromTokens(tokens);
				logger.info("Codex device auth completed", { accountId: tokens.accountId });
			})
			.catch((err) => {
				logger.warn("Codex device auth failed", { error: err.message });
			})
			.finally(() => {
				this.pendingDeviceFlow = undefined;
			});

		return { deviceAuthId, userCode, verificationUrl };
	}

	cancelDeviceAuth(): void {
		if (this.pendingDeviceFlow) {
			this.pendingDeviceFlow.abortController.abort();
			this.pendingDeviceFlow.reject(new Error("Device auth cancelled"));
			this.pendingDeviceFlow = undefined;
		}
	}

	getPendingDeviceFlow(): { userCode: string; verificationUrl: string } | null {
		if (!this.pendingDeviceFlow) return null;
		return {
			userCode: this.pendingDeviceFlow.userCode,
			verificationUrl: "https://auth.openai.com/codex/device",
		};
	}

	// ==================== Manual Refresh ====================

	async manualRefresh(id: string): Promise<void> {
		const entry = this.entries.find((e) => e.id === id);
		if (!entry) throw new Error(`Credential not found: ${id}`);
		const refreshed = await this.deduplicatedRefresh(id, entry);
		Object.assign(entry, {
			accessToken: refreshed.accessToken,
			refreshToken: refreshed.refreshToken,
			expiresAt: refreshed.expiresAt,
			accountId: refreshed.accountId,
			email: refreshed.email,
			sub: refreshed.sub,
		});
		this.saveCredentials();
	}

	// ==================== Usage Query ====================

	private isUsageStaleForUse(usage: CodexUsageResult, now = Date.now()): boolean {
		const queriedAtMs = new Date(usage.queriedAt).getTime();
		if (!Number.isFinite(queriedAtMs)) return true;
		const queriedDeadline = queriedAtMs + USAGE_TTL_MS;
		const primaryResetSec = usage.primary_window?.reset_at;
		const effectiveDeadline =
			typeof primaryResetSec === "number"
				? Math.min(queriedDeadline, primaryResetSec * 1000)
				: queriedDeadline;
		return now >= effectiveDeadline;
	}

	private evaluateQuotaFromUsage(
		usage: CodexUsageResult,
		now = Date.now(),
	): {
		exhausted: boolean;
		resetsAt?: number;
		windowType?: "5h" | "weekly" | "unknown";
	} {
		const exhaustedWindows = [usage.primary_window, usage.secondary_window].filter(
			(window): window is NonNullable<CodexUsageResult["primary_window"]> => {
				if (!window) return false;
				const resetAt = window.reset_at * 1000;
				return window.remaining_percent <= 0 && Number.isFinite(resetAt) && resetAt > now;
			},
		);
		if (exhaustedWindows.length === 0) return { exhausted: false };

		const weeklyWindow = exhaustedWindows.find((window) => window.window_type === "weekly");
		const blockingWindow = weeklyWindow ?? exhaustedWindows[0];
		const resetAtCandidates = exhaustedWindows
			.map((window) => window.reset_at * 1000)
			.filter((resetAt) => Number.isFinite(resetAt));
		const resetsAt = resetAtCandidates.length > 0 ? Math.max(...resetAtCandidates) : undefined;
		return { exhausted: true, resetsAt, windowType: blockingWindow?.window_type };
	}

	private applyCachedQuotaStates(now = Date.now()): boolean {
		let changed = false;
		for (const entry of this.entries) {
			if (entry.disabled || !entry.usage) continue;
			const quotaState = this.evaluateQuotaFromUsage(entry.usage, now);
			if (!quotaState.exhausted) continue;
			entry.disabled = true;
			entry.disabledReason = "quota_exhausted";
			entry.quotaResetsAt = quotaState.resetsAt ?? entry.quotaResetsAt;
			this.evictSessionsByCredential(entry.id);
			changed = true;
			logger.warn("Codex credential skipped due to cached exhausted quota", {
				credentialId: entry.id,
				accountId: entry.accountId,
				resetsAt: quotaState.resetsAt,
				windowType: quotaState.windowType,
			});
		}
		if (changed) {
			this.saveCredentials();
			this.rescheduleUsageRefresh();
			this.schedulePublicQuotaOverviewBroadcast();
		}
		return changed;
	}

	private clearQuotaExhaustedIfRecovered(id: string, entry: CodexCredential): boolean {
		if (entry.disabledReason !== "quota_exhausted") return false;
		entry.disabled = false;
		entry.disabledReason = undefined;
		entry.quotaResetsAt = undefined;
		const stats = this.stats.get(id);
		if (stats) stats.failureCount = 0;
		this.saveCredentials();
		this.saveStatsDebounced();
		this.schedulePublicQuotaOverviewBroadcast();
		return true;
	}

	private recordUsageHistory(
		entry: CodexCredential,
		usage: CodexUsageResult,
		now = Date.now(),
	): void {
		const snapshot = createCodexUsageHistoryEntry(usage);
		if (!snapshot) return;

		const minTimestamp = now - USAGE_HISTORY_RETENTION_MS;
		const history = (entry.usageHistory ?? [])
			.filter(
				(item): item is CodexUsageHistoryEntry =>
					!!item &&
					Number.isFinite(item.timestamp) &&
					Number.isFinite(item.remainingPercent) &&
					item.timestamp >= minTimestamp,
			)
			.sort((a, b) => a.timestamp - b.timestamp);
		const last = history[history.length - 1];
		if (last && Math.abs(last.timestamp - snapshot.timestamp) <= USAGE_HISTORY_DEDUPE_WINDOW_MS) {
			history[history.length - 1] = snapshot;
		} else {
			history.push(snapshot);
		}

		while (history.length > MAX_USAGE_HISTORY_ENTRIES_PER_CREDENTIAL) {
			history.shift();
		}
		entry.usageHistory = history;
	}

	private async refreshUsage(id: string): Promise<CodexUsageResult> {
		const entry = this.entries.find((e) => e.id === id);
		if (!entry) throw new Error(`Credential not found: ${id}`);

		// Ensure we have a valid access token. Access-token-only imports never refresh;
		// if expiry is unknown, try the token and let the usage/API call decide validity.
		const accessToken = getAccessToken(entry);
		if (!accessToken || isExpired(entry)) {
			if (!hasRefreshToken(entry)) {
				if (!accessToken || entry.expiresAt) {
					throw new Error(
						"Access token is expired or unavailable and no refresh token is available",
					);
				}
			} else {
				const refreshed = await this.deduplicatedRefresh(id, entry);
				Object.assign(entry, {
					accessToken: refreshed.accessToken,
					refreshToken: refreshed.refreshToken,
					expiresAt: refreshed.expiresAt,
					accountId: refreshed.accountId,
					email: refreshed.email,
					sub: refreshed.sub,
				});
				this.saveCredentials();
			}
		}

		if (!entry.accountId) {
			throw new Error("Account ID not available for this credential");
		}

		const { resolveOverride } = await import("./net/proxy");
		const { settings } = await import("./settings");
		const proxy = resolveOverride(settings.codex?.proxy);

		if (!entry.accessToken) {
			throw new Error("Access token not available");
		}

		const usage = await fetchCodexUsage(entry.accessToken, entry.accountId, proxy);
		entry.usage = usage;
		this.recordUsageHistory(entry, usage);
		this.saveCredentials();

		const quotaState = this.evaluateQuotaFromUsage(usage);
		if (quotaState.exhausted) {
			this.reportQuotaExhausted(id, quotaState.resetsAt);
		} else {
			this.clearQuotaExhaustedIfRecovered(id, entry);
		}
		this.usageSchedulerRetryAfter.delete(id);
		this.rescheduleUsageRefresh();
		this.schedulePublicQuotaOverviewBroadcast();

		return usage;
	}

	private async refreshUsageDeduplicated(id: string): Promise<CodexUsageResult> {
		const existing = this.usageRefreshPromises.get(id);
		if (existing) return existing;
		const promise = this.refreshUsage(id).finally(() => {
			this.usageRefreshPromises.delete(id);
		});
		this.usageRefreshPromises.set(id, promise);
		return promise;
	}

	async getUsage(id: string): Promise<CodexUsageResult> {
		return this.refreshUsageDeduplicated(id);
	}

	/**
	 * Refresh usage only when the credential is actually used and the cached value is stale.
	 */
	async refreshUsageOnUseIfNeeded(id: string): Promise<void> {
		const entry = this.entries.find((e) => e.id === id);
		if (!entry) throw new Error(`Credential not found: ${id}`);
		if (entry.usage && !this.isUsageStaleForUse(entry.usage)) return;
		await this.refreshUsageDeduplicated(id);
	}

	// ==================== Credential Management ====================

	private addCredentialFromTokens(tokens: CodexTokens): CodexCredential {
		// Check for duplicates: refreshToken hash > sub > (accountId + email) > accessToken hash
		const tokenKeys = new Set(getCredentialDedupeKeys(tokens));
		const existing = this.entries.find((e) =>
			getCredentialDedupeKeys(e).some((key) => tokenKeys.has(key)),
		);

		if (existing) {
			// Update existing credential
			existing.refreshToken = tokens.refreshToken;
			existing.accessToken = tokens.accessToken;
			existing.expiresAt = tokens.expiresAt;
			if (tokens.accountId) existing.accountId = tokens.accountId;
			if (tokens.email) existing.email = tokens.email;
			if (tokens.sub) existing.sub = tokens.sub;
			if (!existing.displayName) {
				existing.displayName = existing.email || existing.accountId || `Codex ${existing.id}`;
			}
			if (existing.disabled && existing.disabledReason !== "manual") {
				existing.disabled = false;
				existing.disabledReason = undefined;
			}
			this.saveCredentials();
			this.rescheduleUsageRefresh();
			this.schedulePublicQuotaOverviewBroadcast();
			return existing;
		}

		// Add new credential
		const id = generateShortId();
		const cred: CodexCredential = {
			id,
			displayName: tokens.email || tokens.accountId || `Codex ${id}`,
			refreshToken: tokens.refreshToken,
			accessToken: tokens.accessToken,
			expiresAt: tokens.expiresAt,
			accountId: tokens.accountId,
			email: tokens.email,
			sub: tokens.sub,
			priority: this.entries.length,
			disabled: false,
		};

		this.entries.push(cred);
		this.stats.set(cred.id, { successCount: 0, failureCount: 0 });

		if (this.entries.length === 1) {
			this.currentId = cred.id;
		}

		this.saveCredentials();
		codexUsageQueue.enqueue(cred.id);
		this.rescheduleUsageRefresh();
		this.schedulePublicQuotaOverviewBroadcast();
		return cred;
	}

	importCredentials(creds: CodexImportCredentialInput[]): {
		added: number;
		duplicates: number;
		skipped: number;
	} {
		const existingKeys = new Set(this.entries.flatMap((e) => getCredentialDedupeKeys(e)));
		const addedIds: string[] = [];
		let added = 0;
		let duplicates = 0;
		let skipped = 0;

		for (const c of creds) {
			const cred = createCredentialFromImport(c, this.entries.length);
			if (!cred) {
				skipped++;
				continue;
			}

			const keys = getCredentialDedupeKeys(cred);
			if (keys.length === 0) {
				skipped++;
				continue;
			}
			if (keys.some((key) => existingKeys.has(key))) {
				duplicates++;
				continue;
			}
			for (const key of keys) existingKeys.add(key);

			this.entries.push(cred);
			this.stats.set(cred.id, { successCount: 0, failureCount: 0 });
			addedIds.push(cred.id);
			added++;
		}

		if (added > 0) {
			if (!this.currentId || !this.entries.find((e) => e.id === this.currentId)) {
				this.currentId = this.entries[0]?.id ?? "";
			}
			this.saveCredentials();
			// Enqueue usage fetch for newly added credentials via serial queue.
			codexUsageQueue.enqueueMany(addedIds);
			this.rescheduleUsageRefresh();
			this.schedulePublicQuotaOverviewBroadcast();
		}

		return { added, duplicates, skipped };
	}

	// ==================== Persistence ====================

	private loadCredentials(): void {
		try {
			const baseDir = this.options?.homeDir ?? homedir();
			const path = getCredentialsPath(baseDir);
			if (!existsSync(path)) return;

			const raw = JSON.parse(readFileSync(path, "utf-8"));
			if (!Array.isArray(raw)) return;

			const seen = new Set<string>();
			for (const c of raw) {
				if (!c || typeof c !== "object") continue;
				const credential = c as CodexCredential;
				credential.refreshToken = getRefreshToken(credential);
				credential.accessToken = getAccessToken(credential);

				if (!credential.refreshToken && !credential.accessToken) continue;
				if (
					credential.accessToken &&
					(!credential.accountId || !credential.sub || !credential.email)
				) {
					const info = extractCodexTokenInfo({ accessToken: credential.accessToken });
					credential.accountId ??= info.accountId;
					credential.email ??= info.email;
					credential.sub ??= info.sub;
				}
				credential.email ??= extractEmailFromString(credential.displayName);
				if (isSerializedCodexCredentialLabel(credential.displayName)) {
					credential.displayName = firstOptionalString(credential.email, credential.accountId);
				}

				const keys = getCredentialDedupeKeys(credential);
				if (keys.length === 0 || keys.some((key) => seen.has(key))) continue;
				for (const key of keys) seen.add(key);

				if (!credential.id) credential.id = generateShortId();
				if (credential.priority === undefined) credential.priority = this.entries.length;
				if (credential.disabled === undefined) credential.disabled = false;

				this.entries.push(credential);
			}

			if (this.entries.length > 0) {
				this.currentId = this.entries[0].id;
			}
		} catch (err) {
			logger.warn("Failed to load Codex credentials", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private saveCredentials(): void {
		try {
			const baseDir = this.options?.homeDir ?? homedir();
			const path = getCredentialsPath(baseDir);
			mkdirSync(resolve(baseDir, ".narrafork"), { recursive: true });
			writeFileSync(path, JSON.stringify(this.entries, null, 2));
		} catch (err) {
			logger.warn("Failed to save Codex credentials", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private loadStats(): void {
		try {
			const baseDir = this.options?.homeDir ?? homedir();
			const path = getStatsPath(baseDir);
			if (!existsSync(path)) return;

			const raw = JSON.parse(readFileSync(path, "utf-8"));
			if (typeof raw !== "object" || raw === null) return;

			for (const [id, stats] of Object.entries(raw)) {
				if (typeof stats === "object" && stats !== null) {
					this.stats.set(id, stats as CredentialStats);
				}
			}
		} catch {
			// Ignore
		}
	}

	private saveStatsDebounced(): void {
		this.saveStats();
	}

	private saveStats(): void {
		try {
			const baseDir = this.options?.homeDir ?? homedir();
			const path = getStatsPath(baseDir);
			mkdirSync(resolve(baseDir, ".narrafork"), { recursive: true });
			const obj: Record<string, CredentialStats> = {};
			for (const [id, stats] of this.stats) {
				obj[id] = stats;
			}
			writeFileSync(path, JSON.stringify(obj, null, 2));
		} catch {
			// Ignore
		}
	}

	// ==================== Accessors ====================

	get availableCount(): number {
		return this.entries.filter((e) => !e.disabled).length;
	}

	get hasCredentials(): boolean {
		return this.entries.length > 0;
	}
}

// === Singleton ===

let _instance: CodexManager | undefined;

export function getCodexManager(): CodexManager {
	if (!_instance) {
		_instance = new CodexManager();
		// Register the usage queue executor so it can fetch usage serially
		const mgr = _instance;
		codexUsageQueue.setExecutor((credentialId) => mgr.getUsage(credentialId));
	}
	return _instance;
}

/** Test helper: replace singleton instance to avoid touching real home dir in tests. */
export function __setCodexManagerForTests(instance?: CodexManager): void {
	_instance?.dispose();
	_instance = instance;
}

// === Migration helper ===

/**
 * Migrate old per-provider codexOAuth to the new centralized credential pool.
 * Called once during settings load.
 */
export function migrateLegacyCodexOAuth(
	providers: Array<{
		codexOAuth?: {
			refreshToken?: string;
			accessToken?: string;
			expiresAt?: number;
			accountId?: string;
		};
	}>,
): void {
	const manager = getCodexManager();
	for (const p of providers) {
		if (p.codexOAuth?.refreshToken || p.codexOAuth?.accessToken) {
			manager.importCredentials([
				{
					refreshToken: p.codexOAuth.refreshToken,
					accessToken: p.codexOAuth.accessToken,
					expiresAt: p.codexOAuth.expiresAt,
					accountId: p.codexOAuth.accountId,
				},
			]);
		}
	}
}
