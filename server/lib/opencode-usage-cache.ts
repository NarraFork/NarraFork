import { isOpencodeGoBaseUrl } from "@shared/opencode-go-endpoint";
import type { ProviderQuotaSnapshot, ProviderQuotaWindow } from "@shared/provider-quota";
import type { QuotaSnapshot } from "@shared/quota-snapshot";
import { providerQuotaService, toQuotaSnapshot } from "../services/provider-quota-service";
import { shownSubjectId, usageSubjects } from "./provider-key-subjects";
import { type CustomApiProviderConfig, settings } from "./settings";
import { quotaNetworkIdentity } from "./sourcing/quota-identity";

/** Compatibility DTOs; normalization and fetching live in quota-source plugins. */
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

export interface OpencodeUsageCache extends OpencodeUsagePayload {
	generation: string;
	fetchedAt: number;
	error: string | null;
}

export const OPENCODE_USAGES_STALE_MS = 60_000;

export function isOpencodeCustomApiProvider(config: {
	baseUrl?: string;
	disabled?: boolean;
}): boolean {
	return !config.disabled && !!config.baseUrl && isOpencodeGoBaseUrl(config.baseUrl);
}

export function opencodeQuotaIdentity(config: CustomApiProviderConfig): string {
	return JSON.stringify([
		config.baseUrl,
		config.apiKey,
		quotaNetworkIdentity(config, settings.proxy),
	]);
}

function legacyWindow(window: ProviderQuotaWindow | undefined): OpencodeUsageWindow | null {
	return window
		? {
				status: window.status ?? null,
				percent: window.usedPercent ?? null,
				resetsAt: window.resetAt,
				...(window.used !== null ? { used: window.used } : {}),
				...(window.limit !== null ? { limit: window.limit } : {}),
			}
		: null;
}

export function toOpencodeUsageCache(snapshot: ProviderQuotaSnapshot): OpencodeUsageCache {
	const data =
		snapshot.status === "unavailable" || snapshot.status === "unsupported" ? null : snapshot.data;
	const windows = data?.windows ?? [];
	const balance = data?.amounts.find((amount) => amount.id.startsWith("balance:"))?.remaining;
	return {
		generation: snapshot.generation,
		rolling: legacyWindow(windows.find((window) => window.id === "rolling")),
		weekly: legacyWindow(windows.find((window) => window.id === "weekly")),
		monthly: legacyWindow(windows.find((window) => window.id === "monthly")),
		...(balance != null ? { balance } : {}),
		fetchedAt: snapshot.fetchedAt,
		error:
			snapshot.error || snapshot.status === "unavailable" || snapshot.status === "unsupported"
				? "OpenCode usage unavailable"
				: null,
	};
}

const opencodeSubjects = () => usageSubjects(isOpencodeCustomApiProvider);
export function syncOpencodeUsageCache(): void {
	providerQuotaService.sync();
}
export function getOpencodeQuotaSnapshot(keyId: string): QuotaSnapshot | undefined {
	return toQuotaSnapshot(providerQuotaService.peekKey(keyId));
}
export const isOpencodeQuotaRefreshing = (keyId: string): boolean =>
	providerQuotaService.peekKey(keyId)?.status === "probing";
export const peekOpencodeUsageGeneration = (providerId: string): string | undefined =>
	providerQuotaService.peekGeneration(providerId);

export function getOpencodeCachedUsage(providerId: string): OpencodeUsageCache | null {
	const id = shownSubjectId(opencodeSubjects(), providerId);
	const snapshot = id ? providerQuotaService.peekKey(id) : null;
	return snapshot ? toOpencodeUsageCache(snapshot) : null;
}
/** Decision readers exclude display-only pre-plugin observations and retired identities. */
export function getOpencodeUsageForSelection(providerId: string): OpencodeUsageCache | null {
	const id = shownSubjectId(opencodeSubjects(), providerId);
	const snapshot = id ? providerQuotaService.peekKeyForSelection(id) : null;
	return snapshot ? toOpencodeUsageCache(snapshot) : null;
}
export function getOpencodeKeyUsages(): Record<string, OpencodeUsageCache> {
	const snapshots = providerQuotaService.keySnapshots();
	return Object.fromEntries(
		opencodeSubjects().flatMap((subject) => {
			const snapshot = snapshots[subject.id];
			return snapshot ? [[subject.id, toOpencodeUsageCache(snapshot)]] : [];
		}),
	);
}
export function getAllOpencodeCachedUsages(): Record<string, OpencodeUsageCache> {
	const subjects = opencodeSubjects();
	const snapshots = providerQuotaService.keySnapshots();
	return Object.fromEntries(
		[...new Set(subjects.map((subject) => subject.providerId))].flatMap((id) => {
			const key = shownSubjectId(subjects, id);
			const snapshot = key ? snapshots[key] : undefined;
			return snapshot ? [[id, toOpencodeUsageCache(snapshot)]] : [];
		}),
	);
}
export function getOpencodeUsageGenerations(): Record<string, string> {
	const subjects = opencodeSubjects();
	const snapshots = providerQuotaService.keySnapshots();
	return Object.fromEntries(
		[...new Set(subjects.map((subject) => subject.providerId))].flatMap((id) => {
			const key = shownSubjectId(subjects, id);
			const snapshot = key ? snapshots[key] : undefined;
			return snapshot ? [[id, snapshot.generation]] : [];
		}),
	);
}
export async function refreshOpencodeKeyUsage(
	keyId: string,
	options?: { manual?: boolean },
): Promise<OpencodeUsageCache | null> {
	if (!opencodeSubjects().some((subject) => subject.id === keyId)) return null;
	const snapshot = await providerQuotaService.refreshKey(keyId, options);
	return snapshot ? toOpencodeUsageCache(snapshot) : null;
}
export async function refreshOpencodeUsage(providerId: string): Promise<OpencodeUsageCache | null> {
	const id = shownSubjectId(opencodeSubjects(), providerId);
	return id ? refreshOpencodeKeyUsage(id) : null;
}
export async function refreshAllOpencodeUsages(options?: { manual?: boolean }): Promise<void> {
	for (const subject of opencodeSubjects()) {
		const snapshot = await providerQuotaService.refreshKey(subject.id, options);
		if (!snapshot && providerQuotaService.peekKey(subject.id))
			throw new Error("Quota refresh did not complete");
	}
}
export function refreshStaleOpencodeUsages(_maxAgeMs = OPENCODE_USAGES_STALE_MS): Promise<void> {
	return providerQuotaService.refreshStale(opencodeSubjects().map((subject) => subject.id));
}
export function noteOpencodeUsageActivity(providerRef: string): void {
	providerQuotaService.noteActivity(providerRef);
}
