import { createHash } from "node:crypto";
import { hotSafe } from "@server/lib/hot-safe";
import type { CustomApiProviderConfig } from "@server/lib/settings/types";
import type { PluginSettingRecord } from "./plugin-settings-store";
import { openProviderSetting } from "./provider-settings-data";

interface Projection {
	root: string;
	revision: number;
	blocked: boolean;
	values: { useSiteAccount?: boolean; siteUrl?: string; userId?: string };
	token?: string;
}
const { entries, listeners } = hotSafe("narrafork.quotaSettingsProjection.owner", () => ({
	entries: new Map<string, Projection>(),
	listeners: new Set<(providerId: string) => void>(),
}));
// Object identity keeps this host observation out of HTTP payloads and structured clones.
const snapshots = new WeakMap<CustomApiProviderConfig, string>();
export function quotaSettingsSnapshot(provider: CustomApiProviderConfig): string | undefined {
	return snapshots.get(provider);
}
export function quotaSettingsRowSnapshot(row: PluginSettingRecord): string {
	return JSON.stringify([row.revision, row.installationId, row.state, row.bindingFingerprint]);
}
/** Cache only after an authenticated SQL read. Legacy settings remain backup inputs only. */
export function publishQuotaSettings(
	provider: CustomApiProviderConfig,
	row: PluginSettingRecord,
): void {
	if (entries.size >= 1024 && !entries.has(provider.id))
		throw Error("Quota settings projection capacity exceeded");
	const old = entries.get(provider.id);
	const opened = row.state === "deleted" ? undefined : openProviderSetting(row);
	const values = opened?.config.values ?? {};
	const projection: Projection = {
		root: provider.baseUrl,
		revision: row.revision,
		blocked: row.state === "blocked" || row.state === "dormant",
		values: {
			useSiteAccount: values.useSiteAccount === true,
			siteUrl: typeof values.siteUrl === "string" ? values.siteUrl : undefined,
			userId: typeof values.userId === "string" ? values.userId : undefined,
		},
		token: opened?.secrets.token,
	};
	entries.set(provider.id, projection);
	snapshots.set(provider, quotaSettingsRowSnapshot(row));
	if (!old || JSON.stringify(old) !== JSON.stringify(projection))
		for (const listener of listeners) listener(provider.id);
}
export function blockQuotaSettings(providerId: string): void {
	const old = entries.get(providerId);
	if (old) {
		entries.set(providerId, { ...old, blocked: true });
		for (const listener of listeners) listener(providerId);
	}
}
export function beginQuotaSettingsProjection(provider: CustomApiProviderConfig): void {
	if (entries.has(provider.id)) return;
	if (entries.size >= 1024) throw Error("Quota settings projection capacity exceeded");
	entries.set(provider.id, {
		root: provider.baseUrl,
		revision: 0,
		blocked: true,
		values: { useSiteAccount: true },
	});
}
export function projectQuotaSettings(provider: CustomApiProviderConfig): CustomApiProviderConfig {
	const entry = entries.get(provider.id);
	if (!entry) return provider;
	if (entry.blocked || entry.root !== provider.baseUrl)
		return {
			...provider,
			quotaSiteUrl: entry.values.siteUrl ?? provider.baseUrl,
			quotaUserId: "",
			quotaAccessToken: "",
		};
	return {
		...provider,
		quotaSiteUrl: entry.values.useSiteAccount
			? (entry.values.siteUrl ?? provider.baseUrl)
			: undefined,
		quotaUserId: entry.values.useSiteAccount ? entry.values.userId : undefined,
		quotaAccessToken: entry.values.useSiteAccount ? entry.token : undefined,
	};
}
export function quotaSettingsGeneration(providerId: string): string {
	const entry = entries.get(providerId);
	return entry
		? createHash("sha256")
				.update(JSON.stringify([entry.revision, entry.blocked, entry.root]))
				.digest("hex")
		: "legacy";
}
export function onQuotaSettingsProjectionChanged(
	listener: (providerId: string) => void,
): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
export function forgetQuotaSettingsProjection(providerId: string): void {
	entries.delete(providerId);
}
