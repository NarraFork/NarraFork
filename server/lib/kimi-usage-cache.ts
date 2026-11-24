import type { ProviderQuotaSnapshot, ProviderQuotaWindow } from "@shared/provider-quota";
import { providerQuotaService } from "../services/provider-quota-service";
import { shownSubjectId, usageSubjects } from "./provider-key-subjects";

/** Legacy DTOs used by the Kimi wait policy and older HTTP clients. */
export interface KimiUsageWindow {
	used: number | null;
	limit: number | null;
	remaining: number | null;
	resetTime: string | null;
}

export interface KimiUsagePayload {
	fiveHour: KimiUsageWindow | null;
	weekly: KimiUsageWindow | null;
	monthly: KimiUsageWindow | null;
	extraWindows: Array<{ label: string } & KimiUsageWindow>;
}

export interface KimiUsageCache extends KimiUsagePayload {
	fetchedAt: number;
	error: string | null;
}

/** Retained for the wait algorithm; scheduling belongs to providerQuotaService. */
export const KIMI_USAGES_STALE_MS = 60_000;

export function isKimiCustomApiProvider(config: { baseUrl?: string; disabled?: boolean }): boolean {
	if (config.disabled || !config.baseUrl) return false;
	try {
		const host = new URL(config.baseUrl).hostname.toLowerCase();
		return (
			host === "kimi.com" ||
			host === "kimi.ai" ||
			host.endsWith(".kimi.com") ||
			host.endsWith(".kimi.ai")
		);
	} catch {
		return false;
	}
}

function legacyWindow(window: ProviderQuotaWindow | undefined): KimiUsageWindow | null {
	return window
		? {
				used: window.used,
				limit: window.limit,
				remaining: window.remaining,
				resetTime: window.resetAt,
			}
		: null;
}

export function toKimiUsageCache(snapshot: ProviderQuotaSnapshot): KimiUsageCache {
	// Disabled/unavailable sources must not provide apparently recovered allowance
	// or a reset inferred from an account whose source is no longer active.
	const data =
		snapshot.status === "unavailable" || snapshot.status === "unsupported" ? null : snapshot.data;
	const windows = data?.windows ?? [];
	return {
		fiveHour: legacyWindow(windows.find((window) => window.id === "fiveHour")),
		weekly: legacyWindow(windows.find((window) => window.id === "weekly")),
		monthly: legacyWindow(windows.find((window) => window.id === "monthly")),
		extraWindows: windows
			.filter((window) => window.id.startsWith("extra:"))
			.map((window) => ({
				label: window.label ?? window.id,
				used: window.used,
				limit: window.limit,
				remaining: window.remaining,
				resetTime: window.resetAt,
			})),
		fetchedAt: snapshot.fetchedAt,
		error:
			snapshot.error || snapshot.status === "unavailable" || snapshot.status === "unsupported"
				? "Kimi usage unavailable"
				: null,
	};
}

const kimiSubjects = () => usageSubjects(isKimiCustomApiProvider);

/** Provider reads keep the upstream's first non-disabled subject view. */
export function getKimiCachedUsage(providerId: string): KimiUsageCache | undefined {
	const id = shownSubjectId(kimiSubjects(), providerId);
	const snapshot = id ? providerQuotaService.peekKey(id) : null;
	return snapshot ? toKimiUsageCache(snapshot) : undefined;
}
export function getKimiKeyUsages(): Record<string, KimiUsageCache> {
	const snapshots = providerQuotaService.keySnapshots();
	return Object.fromEntries(
		kimiSubjects().flatMap((subject) => {
			const snapshot = snapshots[subject.id];
			return snapshot ? [[subject.id, toKimiUsageCache(snapshot)]] : [];
		}),
	);
}
export function getAllKimiCachedUsages(): Record<string, KimiUsageCache> {
	const subjects = kimiSubjects();
	const snapshots = providerQuotaService.keySnapshots();
	return Object.fromEntries(
		[...new Set(subjects.map((subject) => subject.providerId))].flatMap((id) => {
			const key = shownSubjectId(subjects, id);
			const snapshot = key ? snapshots[key] : undefined;
			return snapshot ? [[id, toKimiUsageCache(snapshot)]] : [];
		}),
	);
}
export async function refreshKimiKeyUsage(
	keyId: string,
	options?: { manual?: boolean },
): Promise<KimiUsageCache | null> {
	if (!kimiSubjects().some((subject) => subject.id === keyId)) return null;
	const snapshot = await providerQuotaService.refreshKey(keyId, options);
	return snapshot ? toKimiUsageCache(snapshot) : null;
}
export async function refreshKimiUsage(providerId: string): Promise<KimiUsageCache | null> {
	const id = shownSubjectId(kimiSubjects(), providerId);
	return id ? refreshKimiKeyUsage(id) : null;
}
export async function refreshAllKimiUsages(options?: { manual?: boolean }): Promise<void> {
	for (const subject of kimiSubjects()) {
		const snapshot = await providerQuotaService.refreshKey(subject.id, options);
		if (!snapshot && providerQuotaService.peekKey(subject.id))
			throw new Error("Quota refresh did not complete");
	}
}
export function refreshStaleKimiUsages(_maxAgeMs = KIMI_USAGES_STALE_MS): Promise<void> {
	return providerQuotaService.refreshStale(kimiSubjects().map((subject) => subject.id));
}
export function purgeKimiUsageCache(_ids: string[]): void {
	providerQuotaService.sync();
}
