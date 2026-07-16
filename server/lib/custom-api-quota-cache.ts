import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getNarraforkHome } from "./narrafork-home";
import { settings } from "./settings";

export interface CustomApiQuotaCache {
	quotaBalance: string | null;
	detailedQuotaBalance: string | null;
	fetchedAt: number;
}

const cacheDir = getNarraforkHome();
const cachePath = resolve(cacheDir, "custom-api-quotas.json");
const SAVE_DEBOUNCE_MS = 250;

const cachedQuotaByProvider = new Map<string, CustomApiQuotaCache>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveInFlight = false;
let saveRequested = false;

loadAllCachedQuotas();

function normalizeQuotaBalance(value: unknown): string | null {
	if (value == null) return null;
	const balance = String(value).trim();
	return balance.length > 0 ? balance : null;
}

function normalizeDetailedQuotaBalance(value: unknown): string | null {
	if (value == null) return null;
	const balance = String(value).trim();
	return balance.length > 0 ? balance : null;
}

function loadAllCachedQuotas(): void {
	try {
		if (!existsSync(cachePath)) return;
		const data = JSON.parse(readFileSync(cachePath, "utf-8")) as Record<
			string,
			Partial<CustomApiQuotaCache>
		>;
		for (const [providerId, cache] of Object.entries(data)) {
			cachedQuotaByProvider.set(providerId, {
				quotaBalance: normalizeQuotaBalance(cache.quotaBalance),
				detailedQuotaBalance: normalizeDetailedQuotaBalance(cache.detailedQuotaBalance),
				fetchedAt: typeof cache.fetchedAt === "number" ? cache.fetchedAt : 0,
			});
		}
	} catch {
		// Corrupt or unreadable cache — ignore; quota will be refreshed by future stream events.
	}
}

function serializeCachedQuotas(): string {
	const data: Record<string, CustomApiQuotaCache> = {};
	for (const [providerId, cache] of cachedQuotaByProvider) {
		data[providerId] = cache;
	}
	return JSON.stringify(data);
}

async function flushCachedQuotas(): Promise<void> {
	if (saveInFlight) return;
	saveInFlight = true;
	try {
		while (saveRequested) {
			saveRequested = false;
			try {
				await mkdir(cacheDir, { recursive: true });
				await writeFile(cachePath, serializeCachedQuotas());
			} catch {
				// Non-critical: failing to persist quota must not break an active narrator run.
			}
		}
	} finally {
		saveInFlight = false;
	}
}

function scheduleSaveAllCachedQuotas(): void {
	saveRequested = true;
	if (saveTimer || saveInFlight) return;
	saveTimer = setTimeout(() => {
		saveTimer = null;
		void flushCachedQuotas();
	}, SAVE_DEBOUNCE_MS);
	saveTimer.unref?.();
}

export function updateCustomApiQuotaByPrefix(
	prefix: string,
	quotaBalance: string | null,
	detailedQuotaBalance?: string | null,
): void {
	const config = (settings.customApiProviders ?? []).find((provider) => provider.prefix === prefix);
	if (!config) return;
	cachedQuotaByProvider.set(config.id, {
		quotaBalance: normalizeQuotaBalance(quotaBalance),
		detailedQuotaBalance: normalizeDetailedQuotaBalance(detailedQuotaBalance),
		fetchedAt: Date.now(),
	});
	scheduleSaveAllCachedQuotas();
}

export function getCustomApiCachedQuota(providerId: string): CustomApiQuotaCache | undefined {
	return cachedQuotaByProvider.get(providerId);
}

export function getAllCustomApiCachedQuotas(): Record<
	string,
	{ quotaBalance: string | null; detailedQuotaBalance: string | null; fetchedAt: number }
> {
	const result: Record<
		string,
		{ quotaBalance: string | null; detailedQuotaBalance: string | null; fetchedAt: number }
	> = {};
	for (const [providerId, cache] of cachedQuotaByProvider) {
		result[providerId] = {
			quotaBalance: cache.quotaBalance,
			detailedQuotaBalance: cache.detailedQuotaBalance,
			fetchedAt: cache.fetchedAt,
		};
	}
	return result;
}

export function purgeCustomApiQuotaCache(removedIds: string[]): void {
	let changed = false;
	for (const id of removedIds) {
		if (cachedQuotaByProvider.delete(id)) changed = true;
	}
	if (changed) scheduleSaveAllCachedQuotas();
}
