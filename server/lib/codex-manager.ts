// Codex Credential Manager — multi-account support with failover and load balancing
// Manages ChatGPT Pro/Plus OAuth tokens for the codex provider

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	type AgentIdentityKey,
	buildAgentAssertion,
	isAgentTaskInvalidResponse,
	parseAgentPrivateKey,
	registerAgentIdentityTask,
	validateAgentPrivateKey,
} from "./codex-agent-identity";
import {
	type CodexTokens,
	extractCodexTokenInfo,
	pollDeviceCodeFlow,
	refreshCodexToken,
	startBrowserOAuth,
	startDeviceCodeFlow,
} from "./codex-auth";
import { isCodexPersonalAccessToken } from "./codex-pat";
import {
	type CodexUsageResult,
	fetchCodexUsage,
	isUnauthorizedCodexUsageError,
} from "./codex-usage";
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
	resolveCodexQuotaModel,
} from "./codex-usage-summary";
import { eventBus } from "./event-bus";
import { generateShortId } from "./id";
import { logger } from "./logger";
import { getNarraforkHome } from "./narrafork-home";

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

/**
 * Authentication mode for a Codex credential:
 *   - "oauth"                — ChatGPT OAuth (refresh_token + access_token), default.
 *   - "personal_access_token" — static `at-` bearer token, cannot refresh.
 *   - "agent_identity"       — Ed25519 keypair + runtime/task ids, AgentAssertion header.
 * Absent is treated as "oauth" for backward compatibility.
 */
export type CodexAuthMode = "oauth" | "personal_access_token" | "agent_identity";

export interface CodexCredential {
	id: string;
	displayName?: string;
	/** Authentication mode. Absent = "oauth". */
	authMode?: CodexAuthMode;
	refreshToken?: string;
	accessToken?: string;
	expiresAt?: number;
	accountId?: string;
	email?: string;
	/** JWT subject claim — unique per user, used for deduplication. */
	sub?: string;
	/** Agent Identity: agent runtime id. */
	agentRuntimeId?: string;
	/** Agent Identity: PKCS#8 base64 Ed25519 private key (stored locally, never logged). */
	agentPrivateKey?: string;
	/** Agent Identity: current task id (registered on demand when absent). */
	taskId?: string;
	/** Agent Identity / PAT: whether the ChatGPT account is FedRAMP. */
	fedramp?: boolean;
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

/** Resolve the effective auth mode for a credential (absent = oauth). */
export function getCodexAuthMode(cred: Pick<CodexCredential, "authMode">): CodexAuthMode {
	return cred.authMode ?? "oauth";
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
	authMode: CodexAuthMode;
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
	trackedAccountCount: number;
	modeledAccountCount: number;
	unmodeledAccountCount: number;
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
	trackedAccountCount: number;
	modeledAccountCount: number;
	unmodeledAccountCount: number;
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
	/** Bearer access token (oauth/PAT). Empty string for agent_identity. */
	token: string;
	/**
	 * Full Authorization header value to send upstream:
	 *   - oauth/PAT      → "Bearer <accessToken>"
	 *   - agent_identity → "AgentAssertion <base64url>"
	 */
	authorization: string;
}

export interface CodexImportCredentialInput {
	authMode?: string;
	auth_mode?: string;
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
	/** Agent Identity fields (top-level or nested under `agent_identity`). */
	agentRuntimeId?: string;
	agent_runtime_id?: string;
	agentPrivateKey?: string;
	agent_private_key?: string;
	taskId?: string;
	task_id?: string;
	fedramp?: boolean;
	/** Nested Agent Identity object used by codex/sub2api-style exports. */
	agent_identity?: Record<string, unknown>;
	agentIdentity?: Record<string, unknown>;
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

function getCodexDataDir(baseDir?: string): string {
	return baseDir ? resolve(baseDir, ".narrafork") : getNarraforkHome();
}

function getCredentialsPath(baseDir?: string): string {
	return resolve(getCodexDataDir(baseDir), CREDENTIALS_FILE);
}

function getStatsPath(baseDir?: string): string {
	return resolve(getCodexDataDir(baseDir), STATS_FILE);
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
	cred: Pick<
		CodexCredential,
		"refreshToken" | "accessToken" | "accountId" | "email" | "sub" | "agentRuntimeId"
	>,
): string[] {
	const keys: string[] = [];
	const refreshToken = getRefreshToken(cred);
	const accessToken = getAccessToken(cred);
	const agentRuntimeId = normalizeOptionalString(cred.agentRuntimeId);
	if (agentRuntimeId) keys.push(`agent:${agentRuntimeId}`);
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

function normalizeImportAuthMode(value: unknown): CodexAuthMode | undefined {
	const text = normalizeOptionalString(value)?.toLowerCase();
	if (!text) return undefined;
	if (text === "agentidentity" || text === "agent_identity") return "agent_identity";
	if (text === "personal_access_token" || text === "personalaccesstoken" || text === "pat") {
		return "personal_access_token";
	}
	if (text === "oauth") return "oauth";
	return undefined;
}

function createAgentIdentityCredentialFromImport(
	input: CodexImportCredentialInput,
	agentSource: Record<string, unknown>,
	defaultPriority: number,
): CodexCredential | null {
	const runtimeId = firstOptionalString(
		agentSource.agent_runtime_id,
		agentSource.agentRuntimeId,
		input.agentRuntimeId,
		input.agent_runtime_id,
	);
	const privateKey = firstOptionalString(
		agentSource.agent_private_key,
		agentSource.agentPrivateKey,
		input.agentPrivateKey,
		input.agent_private_key,
	);
	const accountId = firstOptionalString(
		agentSource.account_id,
		agentSource.accountId,
		agentSource.chatgpt_account_id,
		agentSource.chatgptAccountId,
		input.accountId,
		input.account_id,
	);
	const userId = firstOptionalString(
		agentSource.chatgpt_user_id,
		agentSource.chatgptUserId,
		agentSource.sub,
		input.sub,
	);
	if (!runtimeId || !privateKey || !accountId) return null;
	// Validate the private key format without keeping/logging the raw material.
	if (validateAgentPrivateKey(privateKey)) return null;

	const email = firstOptionalString(
		agentSource.email,
		input.email,
		extractEmailFromString(input.displayName),
		extractEmailFromString(input.display_name),
		extractEmailFromString(input.name),
	);
	const taskId = firstOptionalString(
		agentSource.task_id,
		agentSource.taskId,
		input.taskId,
		input.task_id,
	);
	const fedramp =
		agentSource.chatgpt_account_is_fedramp === true ||
		agentSource.chatgptAccountIsFedramp === true ||
		input.fedramp === true;
	const displayName = firstOptionalString(
		firstSafeCredentialDisplayName(input.displayName, input.display_name, input.name),
		email,
		accountId,
	);
	const priority = firstOptionalNumber(input.priority) ?? defaultPriority;

	return {
		id: generateShortId(),
		authMode: "agent_identity",
		agentRuntimeId: runtimeId,
		agentPrivateKey: privateKey,
		...(taskId ? { taskId } : {}),
		accountId,
		...(userId ? { sub: userId } : {}),
		...(email ? { email } : {}),
		...(displayName ? { displayName } : {}),
		fedramp,
		priority,
		disabled: false,
	};
}

function createCredentialFromImport(
	input: CodexImportCredentialInput,
	defaultPriority: number,
): CodexCredential | null {
	const user = optionalRecord(input.user);
	const nestedCredentials = optionalRecord(input.credentials);
	const extra = optionalRecord(input.extra);

	// ── Agent Identity ──
	const declaredAuthMode = normalizeImportAuthMode(
		input.authMode ?? input.auth_mode ?? nestedCredentials.auth_mode ?? nestedCredentials.authMode,
	);
	const agentSource = isRecord(input.agent_identity)
		? input.agent_identity
		: isRecord(input.agentIdentity)
			? input.agentIdentity
			: isRecord(nestedCredentials.agent_identity)
				? (nestedCredentials.agent_identity as Record<string, unknown>)
				: undefined;
	const hasAgentFields =
		!!agentSource ||
		declaredAuthMode === "agent_identity" ||
		!!firstOptionalString(input.agentRuntimeId, input.agent_runtime_id);
	if (hasAgentFields) {
		return createAgentIdentityCredentialFromImport(
			input,
			agentSource ?? (input as unknown as Record<string, unknown>),
			defaultPriority,
		);
	}

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

	// ── Personal Access Token: `at-` access token with no refresh token ──
	const isPat =
		declaredAuthMode === "personal_access_token" ||
		(!refreshToken && isCodexPersonalAccessToken(accessToken));

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
		...(isPat ? { authMode: "personal_access_token" as const } : {}),
		// PAT tokens are static and never carry a refresh token.
		...(refreshToken && !isPat ? { refreshToken } : {}),
		...(accessToken ? { accessToken } : {}),
		...(expiresAt !== undefined && !isPat ? { expiresAt } : {}),
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
	private agentTaskPromises = new Map<string, Promise<void>>();
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
		const initialRetryAt = Date.now() + USAGE_RESET_RETRY_DELAY_MS;
		for (const entry of this.entries) {
			if (entry.disabledReason === "quota_exhausted" && !entry.quotaResetsAt) {
				this.usageSchedulerRetryAfter.set(entry.id, initialRetryAt);
			}
		}

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

	private bearerContext(entry: CodexCredential, token: string): CallContext {
		this.currentId = entry.id;
		return {
			id: entry.id,
			credential: entry,
			token,
			authorization: `Bearer ${token}`,
		};
	}

	private async tryEnsureToken(entry: CodexCredential): Promise<CallContext | null> {
		if (getCodexAuthMode(entry) === "agent_identity") {
			return this.tryEnsureAgentIdentityContext(entry);
		}

		const accessToken = getAccessToken(entry);
		const needsRefresh = isExpired(entry) || isExpiringSoon(entry);

		if (!needsRefresh && accessToken) {
			return this.bearerContext(entry, accessToken);
		}

		if (!hasRefreshToken(entry)) {
			// Access-token-only imports (incl. PAT) cannot refresh. Use the token when
			// expiry is unknown; skip it only when we explicitly know it is expired.
			if (accessToken && !entry.expiresAt) {
				return this.bearerContext(entry, accessToken);
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

			return this.bearerContext(entry, entry.accessToken ?? "");
		} catch {
			return null;
		}
	}

	/**
	 * Build an Agent Identity call context: ensure a task id (registering one on
	 * demand) then build a fresh signed AgentAssertion header. The assertion is
	 * time-stamped so it is rebuilt on every acquisition.
	 */
	private async tryEnsureAgentIdentityContext(entry: CodexCredential): Promise<CallContext | null> {
		const runtimeId = normalizeOptionalString(entry.agentRuntimeId);
		const rawPrivateKey = normalizeOptionalString(entry.agentPrivateKey);
		if (!runtimeId || !rawPrivateKey) return null;

		let privateKey: import("node:crypto").KeyObject;
		try {
			privateKey = parseAgentPrivateKey(rawPrivateKey);
		} catch (err) {
			logger.warn("Codex agent identity private key is invalid", {
				credentialId: entry.id,
				error: err instanceof Error ? err.message : String(err),
			});
			return null;
		}

		try {
			await this.ensureAgentIdentityTask(entry, runtimeId, privateKey);
		} catch (err) {
			logger.warn("Codex agent identity task registration failed", {
				credentialId: entry.id,
				error: err instanceof Error ? err.message : String(err),
			});
			return null;
		}

		const taskId = normalizeOptionalString(entry.taskId);
		if (!taskId) return null;

		try {
			const authorization = buildAgentAssertion({ runtimeId, privateKey, taskId });
			this.currentId = entry.id;
			return { id: entry.id, credential: entry, token: "", authorization };
		} catch (err) {
			logger.warn("Codex agent identity assertion build failed", {
				credentialId: entry.id,
				error: err instanceof Error ? err.message : String(err),
			});
			return null;
		}
	}

	/** Register a new Agent Identity task when the credential has none. */
	private async ensureAgentIdentityTask(
		entry: CodexCredential,
		runtimeId: string,
		privateKey: import("node:crypto").KeyObject,
	): Promise<void> {
		if (normalizeOptionalString(entry.taskId)) return;

		const existing = this.agentTaskPromises.get(entry.id);
		if (existing) {
			await existing;
			return;
		}

		const promise = (async () => {
			const { resolveOverride } = await import("./net/proxy");
			const { settings } = await import("./settings");
			const proxy = resolveOverride(settings.codex?.proxy);
			const key: AgentIdentityKey = { runtimeId, privateKey };
			const taskId = await registerAgentIdentityTask(key, proxy);
			entry.taskId = taskId;
			this.saveCredentials();
		})().finally(() => {
			this.agentTaskPromises.delete(entry.id);
		});

		this.agentTaskPromises.set(entry.id, promise);
		await promise;
	}

	/**
	 * Handle an upstream 401 for an Agent Identity credential: clear the stale
	 * task id and re-register so the next acquisition builds a fresh assertion.
	 * Returns true when a re-registration path is available.
	 */
	async recoverAgentIdentityTask(id: string, status: number, body: string): Promise<boolean> {
		const entry = this.entries.find((e) => e.id === id);
		if (!entry || getCodexAuthMode(entry) !== "agent_identity") return false;
		if (!isAgentTaskInvalidResponse(status, body)) return false;
		entry.taskId = undefined;
		this.saveCredentials();
		const runtimeId = normalizeOptionalString(entry.agentRuntimeId);
		const rawPrivateKey = normalizeOptionalString(entry.agentPrivateKey);
		if (!runtimeId || !rawPrivateKey) return false;
		try {
			const privateKey = parseAgentPrivateKey(rawPrivateKey);
			await this.ensureAgentIdentityTask(entry, runtimeId, privateKey);
			return !!normalizeOptionalString(entry.taskId);
		} catch (err) {
			logger.warn("Codex agent identity task recovery failed", {
				credentialId: id,
				error: err instanceof Error ? err.message : String(err),
			});
			return false;
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
			entry.quotaResetsAt = resetsAt;
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
			const entry = this.entries.find((candidate) => candidate.id === id);
			if (entry?.disabledReason === "quota_exhausted" && !entry.quotaResetsAt) {
				this.usageSchedulerRetryAfter.set(id, Date.now() + USAGE_RESET_RETRY_DELAY_MS);
				this.rescheduleUsageRefresh();
			}
			logger.warn("Codex usage refresh after quota error failed", {
				credentialId: id,
				error: err instanceof Error ? err.message : String(err),
			});
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
			const retryAfter = this.usageSchedulerRetryAfter.get(entry.id);
			if (!resetAt && !retryAfter) continue;

			scheduledCredentialCount++;
			if (resetAt && resetAt > now) {
				this.usageSchedulerRetryAfter.delete(entry.id);
				nextRunAt = Math.min(nextRunAt ?? resetAt, resetAt);
				continue;
			}

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
				trackedAccountCount: stats.accountCount,
				modeledAccountCount: stats.modeledUsageCount,
				unmodeledAccountCount: Math.max(0, stats.accountCount - stats.modeledUsageCount),
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
		const trackedAccountCount =
			segments.reduce((sum, segment) => sum + segment.trackedAccountCount, 0) +
			summary.missingUsageAccounts;
		const modeledAccountCount = segments.reduce(
			(sum, segment) => sum + segment.modeledAccountCount,
			0,
		);
		const unmodeledAccountCount =
			segments.reduce((sum, segment) => sum + segment.unmodeledAccountCount, 0) +
			summary.missingUsageAccounts;
		const trendTiers = visibleTiers.filter((tier) => trend.tiers.includes(tier));
		const points = trend.points.map((point) => {
			const byType = Object.fromEntries(
				trendTiers.flatMap((tier) => {
					const value = point.byTier[tier];
					return value === undefined ? [] : [[tier, value]];
				}),
			) as Partial<Record<PublicCodexPlanTier, number>>;
			return { timestamp: point.timestamp, byType };
		});

		return {
			generatedAt: summary.generatedAt,
			unit: trend.unit,
			totalRemainingAccountEquivalents,
			totalAccountEquivalents,
			trackedAccountCount,
			modeledAccountCount,
			unmodeledAccountCount,
			segments,
			trend: {
				generatedAt: trend.generatedAt,
				points,
				types: trendTiers,
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
				authMode: getCodexAuthMode(e),
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
		const authMode = getCodexAuthMode(entry);
		if (authMode === "agent_identity") {
			throw new Error("Agent Identity credentials do not use refreshable tokens");
		}
		if (authMode === "personal_access_token" || !hasRefreshToken(entry)) {
			throw new Error("Personal access token credentials cannot be refreshed");
		}
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
		const quotaModel = resolveCodexQuotaModel(usage, now);
		const effectiveDeadline = Math.min(
			queriedAtMs + USAGE_TTL_MS,
			quotaModel.refreshAt ?? Number.POSITIVE_INFINITY,
		);
		return now >= effectiveDeadline;
	}

	private evaluateQuotaFromUsage(
		usage: CodexUsageResult,
		now = Date.now(),
	): {
		exhausted: boolean;
		resetsAt?: number;
		windowType?: NonNullable<CodexUsageResult["primary_window"]>["window_type"];
	} {
		const quotaModel = resolveCodexQuotaModel(usage, now);
		return {
			exhausted: quotaModel.isExhausted,
			resetsAt: quotaModel.blockedUntil,
			windowType: quotaModel.exhaustedWindows[0]?.window_type,
		};
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

		// Agent Identity credentials authenticate with a signed AgentAssertion header
		// instead of a bearer token. sub2api queries the same usage endpoint for
		// these accounts by swapping in the assertion, so we mirror that here
		// rather than skipping usage tracking for them.
		if (getCodexAuthMode(entry) === "agent_identity") {
			return this.refreshAgentIdentityUsage(id, entry);
		}

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
		return this.applyUsageResult(id, entry, usage);
	}

	/**
	 * Fetch usage for an Agent Identity credential, authenticating with a
	 * freshly signed AgentAssertion header instead of a bearer token (mirrors
	 * sub2api's buildCodexQuotaHeaders, which swaps the Authorization header
	 * for the same wham/usage endpoint rather than skipping the query).
	 */
	private async refreshAgentIdentityUsage(
		id: string,
		entry: CodexCredential,
	): Promise<CodexUsageResult> {
		const runtimeId = normalizeOptionalString(entry.agentRuntimeId);
		const rawPrivateKey = normalizeOptionalString(entry.agentPrivateKey);
		if (!runtimeId || !rawPrivateKey) {
			throw new Error("Agent identity runtime id or private key is missing");
		}
		if (!entry.accountId) {
			throw new Error("Account ID not available for this credential");
		}

		const privateKey = parseAgentPrivateKey(rawPrivateKey);
		await this.ensureAgentIdentityTask(entry, runtimeId, privateKey);
		const taskId = normalizeOptionalString(entry.taskId);
		if (!taskId) {
			throw new Error("Agent identity task id is unavailable");
		}
		const authorization = buildAgentAssertion({ runtimeId, privateKey, taskId });

		const { resolveOverride } = await import("./net/proxy");
		const { settings } = await import("./settings");
		const proxy = resolveOverride(settings.codex?.proxy);

		try {
			// `authorization` overrides the Authorization header entirely, so the
			// accessToken positional arg is unused for Agent Identity — pass "".
			const usage = await fetchCodexUsage(
				/* accessToken */ "",
				entry.accountId,
				proxy,
				authorization,
			);
			return this.applyUsageResult(id, entry, usage);
		} catch (err) {
			// If the task id was invalidated between acquisition and this call,
			// clear it so the next attempt re-registers instead of retrying the
			// same stale assertion forever.
			const message = err instanceof Error ? err.message : String(err);
			if (isUnauthorizedCodexUsageError(err)) {
				await this.recoverAgentIdentityTask(id, 401, message);
			}
			throw err;
		}
	}

	/** Persist a fetched usage snapshot and update quota/scheduler state. */
	private applyUsageResult(
		id: string,
		entry: CodexCredential,
		usage: CodexUsageResult,
	): CodexUsageResult {
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
			if (addedIds.length > 0) codexUsageQueue.enqueueMany(addedIds);
			this.rescheduleUsageRefresh();
			this.schedulePublicQuotaOverviewBroadcast();
		}

		return { added, duplicates, skipped };
	}

	// ==================== Persistence ====================

	private loadCredentials(): void {
		try {
			const baseDir = this.options?.homeDir;
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

				const isAgentIdentity =
					getCodexAuthMode(credential) === "agent_identity" &&
					!!normalizeOptionalString(credential.agentRuntimeId) &&
					!!normalizeOptionalString(credential.agentPrivateKey);
				if (isAgentIdentity) {
					// Agent Identity credentials carry no refresh/access token; keep them as-is.
				} else if (!credential.refreshToken && !credential.accessToken) {
					continue;
				}
				if (
					!isAgentIdentity &&
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
			const baseDir = this.options?.homeDir;
			const path = getCredentialsPath(baseDir);
			mkdirSync(getCodexDataDir(baseDir), { recursive: true });
			writeFileSync(path, JSON.stringify(this.entries, null, 2));
		} catch (err) {
			logger.warn("Failed to save Codex credentials", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private loadStats(): void {
		try {
			const baseDir = this.options?.homeDir;
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
			const baseDir = this.options?.homeDir;
			const path = getStatsPath(baseDir);
			mkdirSync(getCodexDataDir(baseDir), { recursive: true });
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
