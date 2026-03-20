// Codex Credential Manager — multi-account support with failover and load balancing
// Manages ChatGPT Pro/Plus OAuth tokens for the codex provider

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
	type CodexTokens,
	pollDeviceCodeFlow,
	refreshCodexToken,
	startBrowserOAuth,
	startDeviceCodeFlow,
} from "./codex-auth";
import { type CodexUsageResult, fetchCodexUsage } from "./codex-usage";
import { generateShortId } from "./id";
import { logger } from "./logger";

// === Constants ===

const MAX_FAILURES_PER_CREDENTIAL = 3;
const USAGE_TTL_MS = 5 * 60_000;
const CREDENTIALS_FILE = "codex-credentials.json";
const STATS_FILE = "codex-stats.json";
const SESSION_AFFINITY_TTL_MS = 6 * 60 * 60_000; // 6h
const MAX_SESSION_AFFINITY_ENTRIES = 2_000;

// === Types ===

export type DisabledReason = "manual" | "too_many_failures" | "quota_exhausted";
export type LoadBalancingMode = "priority" | "balanced";

export interface CodexCredential {
	id: string;
	displayName?: string;
	refreshToken: string;
	accessToken?: string;
	expiresAt?: number;
	accountId?: string;
	email?: string;
	priority: number;
	disabled: boolean;
	disabledReason?: DisabledReason;
	/** Epoch milliseconds when quota resets (from API error.resets_at). */
	quotaResetsAt?: number;
	/** Cached usage snapshot persisted with credential. */
	usage?: CodexUsageResult;
}

export interface CredentialStats {
	successCount: number;
	failureCount: number;
	lastUsedAt?: string;
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

export interface ManagerSnapshot {
	entries: CredentialSnapshot[];
	currentId: string;
	loadBalancingMode: LoadBalancingMode;
	total: number;
	available: number;
	stickySessionCount: number;
	usageCache: Record<string, CodexUsageResult>;
	/** Last browser OAuth error message (cleared on success). */
	lastBrowserAuthError?: string;
}

export interface CallContext {
	id: string;
	credential: CodexCredential;
	token: string;
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

// === CodexManager ===

export class CodexManager {
	private entries: CodexCredential[];
	private stats: Map<string, CredentialStats>;
	private currentId: string;
	private loadBalancingMode: LoadBalancingMode;
	private refreshPromises = new Map<string, Promise<CodexCredential>>();
	private pendingDeviceFlow: PendingDeviceFlow | undefined;
	private usageRefreshPromises = new Map<string, Promise<CodexUsageResult>>();
	private sessionAffinity = new Map<string, SessionAffinityEntry>();
	private readonly beforeExitHandler: () => void;
	/** Exposed via snapshot so the frontend can show browser-auth errors. */
	private _lastBrowserAuthError?: string;

	constructor(private readonly options?: { homeDir?: string; registerProcessHooks?: boolean }) {
		this.entries = [];
		this.stats = new Map();
		this.currentId = "";
		this.loadBalancingMode = "priority";

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
		process.off("beforeExit", this.beforeExitHandler);
	}

	// ==================== Credential Selection ====================

	async acquireContext(sessionKey?: string): Promise<CallContext> {
		this.reviveQuotaResetCredentials();
		this.pruneSessionAffinity();
		const total = this.entries.length;
		const triedIds = new Set<string>();
		const stickyEnabled = this.loadBalancingMode === "balanced" && !!sessionKey;

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
			// Balanced mode: random pick among currently available credentials.
			const randomIndex = Math.floor(Math.random() * available.length);
			return available[randomIndex] ?? available[0];
		}

		// Priority mode: lowest priority number first
		return available.reduce((best, e) => (e.priority < best.priority ? e : best));
	}

	private async tryEnsureToken(entry: CodexCredential): Promise<CallContext | null> {
		const needsRefresh = isExpired(entry) || isExpiringSoon(entry);

		if (!needsRefresh && entry.accessToken) {
			this.currentId = entry.id;
			return { id: entry.id, credential: entry, token: entry.accessToken };
		}

		try {
			const refreshed = await this.deduplicatedRefresh(entry.id, entry);
			Object.assign(entry, {
				accessToken: refreshed.accessToken,
				refreshToken: refreshed.refreshToken,
				expiresAt: refreshed.expiresAt,
				accountId: refreshed.accountId,
				email: refreshed.email,
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

		const promise = (async () => {
			const { settings } = await import("./settings");
			const proxy = settings.codex?.proxy;
			const tokens = await refreshCodexToken(cred.refreshToken, proxy);
			return {
				...cred,
				accessToken: tokens.accessToken,
				refreshToken: tokens.refreshToken,
				expiresAt: tokens.expiresAt,
				accountId: tokens.accountId ?? cred.accountId,
				email: tokens.email ?? cred.email,
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
		}

		this.saveStatsDebounced();
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
		}

		this.saveStatsDebounced();
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
		}
		return changed;
	}

	// ==================== Admin API ====================

	snapshot(): ManagerSnapshot {
		this.pruneSessionAffinity();
		const available = this.entries.filter((e) => !e.disabled).length;
		const usageCacheObj: Record<string, CodexUsageResult> = {};
		for (const e of this.entries) {
			if (e.usage) usageCacheObj[e.id] = e.usage;
		}
		return {
			entries: this.entries.map((e) => {
				const stats = this.stats.get(e.id);
				const usage = e.usage;
				return {
					id: e.id,
					displayName: e.displayName,
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
					usage,
				};
			}),
			currentId: this.currentId,
			loadBalancingMode: this.loadBalancingMode,
			total: this.entries.length,
			available,
			stickySessionCount: this.sessionAffinity.size,
			usageCache: usageCacheObj,
			lastBrowserAuthError: this._lastBrowserAuthError,
		};
	}

	setLoadBalancingMode(mode: LoadBalancingMode): void {
		if (this.loadBalancingMode !== mode) {
			this.sessionAffinity.clear();
		}
		this.loadBalancingMode = mode;
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
	}

	removeCredential(id: string): void {
		const idx = this.entries.findIndex((e) => e.id === id);
		if (idx === -1) throw new Error(`Credential not found: ${id}`);
		this.entries.splice(idx, 1);
		this.stats.delete(id);
		this.usageRefreshPromises.delete(id);
		this.evictSessionsByCredential(id);
		if (this.currentId === id && this.entries.length > 0) {
			this.currentId = this.entries[0].id;
		}
		this.saveCredentials();
		this.saveStats();
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
			this.evictSessionsByCredential(id);
			removed.push(id);
		}
		if (
			this.currentId &&
			!this.entries.find((e) => e.id === this.currentId) &&
			this.entries.length > 0
		) {
			this.currentId = this.entries[0].id;
		}
		if (removed.length > 0) {
			this.saveCredentials();
			this.saveStats();
		}
		return { removed, notFound };
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
		const { settings } = await import("./settings");
		const proxy = settings.codex?.proxy;
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

		const { settings } = await import("./settings");
		const proxy = settings.codex?.proxy;
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

	private evaluateQuotaFromUsage(usage: CodexUsageResult): {
		exhausted: boolean;
		resetsAt?: number;
	} {
		const exhaustedWindows = [usage.primary_window, usage.secondary_window].filter(
			(window): window is NonNullable<CodexUsageResult["primary_window"]> =>
				!!window && window.remaining_percent <= 0,
		);
		if (exhaustedWindows.length === 0) return { exhausted: false };

		const resetAtCandidates = exhaustedWindows
			.map((window) => window.reset_at * 1000)
			.filter((resetAt) => Number.isFinite(resetAt));
		const resetsAt = resetAtCandidates.length > 0 ? Math.max(...resetAtCandidates) : undefined;
		return { exhausted: true, resetsAt };
	}

	private async refreshUsage(id: string): Promise<CodexUsageResult> {
		const entry = this.entries.find((e) => e.id === id);
		if (!entry) throw new Error(`Credential not found: ${id}`);

		// Ensure we have a valid access token
		if (!entry.accessToken || isExpired(entry)) {
			const refreshed = await this.deduplicatedRefresh(id, entry);
			Object.assign(entry, {
				accessToken: refreshed.accessToken,
				refreshToken: refreshed.refreshToken,
				expiresAt: refreshed.expiresAt,
				accountId: refreshed.accountId,
				email: refreshed.email,
			});
			this.saveCredentials();
		}

		if (!entry.accountId) {
			throw new Error("Account ID not available for this credential");
		}

		const { settings } = await import("./settings");
		const proxy = settings.codex?.proxy;

		if (!entry.accessToken) {
			throw new Error("Access token not available");
		}

		const usage = await fetchCodexUsage(entry.accessToken, entry.accountId, proxy);
		entry.usage = usage;
		this.saveCredentials();

		const quotaState = this.evaluateQuotaFromUsage(usage);
		if (quotaState.exhausted) {
			this.reportQuotaExhausted(id, quotaState.resetsAt);
		}

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

	private scheduleInitialUsageFetch(id: string): void {
		void this.refreshUsageDeduplicated(id).catch((err) => {
			logger.warn("Failed to fetch initial Codex usage for credential", {
				credentialId: id,
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}

	// ==================== Credential Management ====================

	private addCredentialFromTokens(tokens: CodexTokens): CodexCredential {
		// Check for duplicates based on accountId or refreshToken hash
		const refreshTokenHash = sha256Hex(tokens.refreshToken);
		const existing = this.entries.find(
			(e) =>
				(e.accountId && e.accountId === tokens.accountId) ||
				sha256Hex(e.refreshToken) === refreshTokenHash,
		);

		if (existing) {
			// Update existing credential
			existing.refreshToken = tokens.refreshToken;
			existing.accessToken = tokens.accessToken;
			existing.expiresAt = tokens.expiresAt;
			if (tokens.accountId) existing.accountId = tokens.accountId;
			if (tokens.email) existing.email = tokens.email;
			if (existing.disabled && existing.disabledReason !== "manual") {
				existing.disabled = false;
				existing.disabledReason = undefined;
			}
			this.saveCredentials();
			return existing;
		}

		// Add new credential
		const cred: CodexCredential = {
			id: generateShortId(),
			refreshToken: tokens.refreshToken,
			accessToken: tokens.accessToken,
			expiresAt: tokens.expiresAt,
			accountId: tokens.accountId,
			email: tokens.email,
			priority: this.entries.length,
			disabled: false,
		};

		this.entries.push(cred);
		this.stats.set(cred.id, { successCount: 0, failureCount: 0 });

		if (this.entries.length === 1) {
			this.currentId = cred.id;
		}

		this.saveCredentials();
		this.scheduleInitialUsageFetch(cred.id);
		return cred;
	}

	importCredentials(
		creds: Array<{
			refreshToken: string;
			displayName?: string;
			priority?: number;
		}>,
	): { added: number; duplicates: number } {
		const existingHashes = new Set(this.entries.map((e) => sha256Hex(e.refreshToken)));
		let added = 0;
		let duplicates = 0;

		for (const c of creds) {
			const hash = sha256Hex(c.refreshToken);
			if (existingHashes.has(hash)) {
				duplicates++;
				continue;
			}
			existingHashes.add(hash);

			const cred: CodexCredential = {
				id: generateShortId(),
				refreshToken: c.refreshToken,
				displayName: c.displayName,
				priority: c.priority ?? this.entries.length,
				disabled: false,
			};

			this.entries.push(cred);
			this.stats.set(cred.id, { successCount: 0, failureCount: 0 });
			added++;
		}

		if (added > 0) {
			this.saveCredentials();
			for (const e of this.entries) {
				if (!e.usage) this.scheduleInitialUsageFetch(e.id);
			}
		}

		return { added, duplicates };
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
				if (!c.refreshToken) continue;
				const hash = sha256Hex(c.refreshToken);
				if (seen.has(hash)) continue;
				seen.add(hash);

				if (!c.id) c.id = generateShortId();
				if (c.priority === undefined) c.priority = this.entries.length;
				if (c.disabled === undefined) c.disabled = false;

				this.entries.push(c as CodexCredential);
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
			refreshToken: string;
			accessToken?: string;
			expiresAt?: number;
			accountId?: string;
		};
	}>,
): void {
	const manager = getCodexManager();
	for (const p of providers) {
		if (p.codexOAuth?.refreshToken) {
			manager.importCredentials([
				{
					refreshToken: p.codexOAuth.refreshToken,
				},
			]);
		}
	}
}
