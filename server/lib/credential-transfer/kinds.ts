/** Credential families that can move between instances. */
import type { CredentialNetwork } from "@shared/credential-network";
import { getCodexManager } from "../codex-manager";
import { getProviderKeyStore, type ProviderKeyDisabledReason } from "../provider-keys";
import { saveSettings, settings } from "../settings";
import type { CustomApiProviderConfig } from "../settings/types";
import type { BundleItem } from "./bundle";

export interface TransferableCredential {
	kind: string;
	id: string;
	label: string;
	archived?: boolean;
}

export type ImportDecision = "add" | "replace" | "skip";

export interface TransferKind {
	kind: string;
	list(): TransferableCredential[];
	export(ids: readonly string[] | undefined): BundleItem[];
	/** Aligned with `data`; null marks an item this instance cannot use. */
	match(data: readonly unknown[]): Array<{ label: string; existingId?: string } | null>;
	import(
		data: readonly unknown[],
		decide: (index: number, existingId: string | undefined) => ImportDecision,
	): { added: number; replaced: number; skipped: number };
}

const codexKind: TransferKind = {
	kind: "codex",
	list: () => {
		const snapshot = getCodexManager().snapshot();
		return [...snapshot.entries, ...snapshot.archivedEntries].map((entry) => ({
			kind: "codex",
			id: entry.id,
			label: entry.displayName ?? entry.email ?? entry.id,
			...(entry.archivedAt ? { archived: true } : {}),
		}));
	},
	export: (ids) =>
		getCodexManager()
			.exportForTransfer(ids)
			.map((data) => ({
				kind: "codex",
				id: data.id,
				label: data.displayName ?? data.email ?? data.id,
				data,
			})),
	match: (data) => getCodexManager().matchForTransfer(data),
	import: (data, decide) => getCodexManager().importFromTransfer(data, decide),
};

/** One API key plus the (secret-free) config of the provider it belongs to. */
interface ApiKeyItem {
	provider: Omit<CustomApiProviderConfig, "apiKey">;
	key: {
		id: string;
		apiKey: string;
		label?: string;
		disabled?: boolean;
		disabledReason?: ProviderKeyDisabledReason;
		network?: CredentialNetwork;
	};
}

function asApiKeyItem(data: unknown): ApiKeyItem | null {
	const item = data as Partial<ApiKeyItem> | null;
	const provider = item?.provider;
	const key = item?.key;
	if (!provider || typeof provider.id !== "string" || typeof provider.baseUrl !== "string") {
		return null;
	}
	if (!key || typeof key.apiKey !== "string" || !key.apiKey.trim()) return null;
	return item as ApiKeyItem;
}

function maskedKey(apiKey: string): string {
	return apiKey.length > 8 ? `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}` : "…";
}

function keyLabel(providerName: string, key: { label?: string; apiKey: string }): string {
	return `${providerName} · ${key.label ?? maskedKey(key.apiKey)}`;
}

/** The provider here that an incoming key belongs to: same id, else same endpoint and protocol. */
function targetProvider(source: ApiKeyItem["provider"]): CustomApiProviderConfig | undefined {
	const providers = settings.customApiProviders ?? [];
	const sameUrl = (url: string) => url.replace(/\/+$/, "") === source.baseUrl.replace(/\/+$/, "");
	return (
		providers.find((p) => p.id === source.id) ??
		providers.find((p) => sameUrl(p.baseUrl) && p.protocol === source.protocol)
	);
}

function uniquePrefix(prefix: string): string {
	const taken = new Set([
		"codex",
		"tokendance",
		"CommandCode",
		...(settings.customApiProviders ?? []).map((p) => p.prefix),
		...(settings.nugProviders ?? []).map((p) => p.prefix),
	]);
	if (!taken.has(prefix)) return prefix;
	for (let n = 2; ; n++) if (!taken.has(`${prefix}-${n}`)) return `${prefix}-${n}`;
}

const apiKeyKind: TransferKind = {
	kind: "api-key",
	list: () => {
		const names = new Map((settings.customApiProviders ?? []).map((p) => [p.id, p.name]));
		return getProviderKeyStore()
			.all()
			.filter((key) => names.has(key.providerId))
			.map((key) => ({
				kind: "api-key",
				id: key.id,
				label: keyLabel(names.get(key.providerId) ?? key.providerId, key),
			}));
	},
	export: (ids) => {
		const wanted = ids ? new Set(ids) : null;
		const providers = new Map((settings.customApiProviders ?? []).map((p) => [p.id, p]));
		return getProviderKeyStore()
			.all()
			.filter((key) => providers.has(key.providerId) && (!wanted || wanted.has(key.id)))
			.map((key) => {
				const { apiKey: _secret, ...provider } = providers.get(
					key.providerId,
				) as CustomApiProviderConfig;
				const data: ApiKeyItem = {
					provider: structuredClone(provider),
					key: {
						id: key.id,
						apiKey: key.apiKey,
						...(key.label ? { label: key.label } : {}),
						...(key.disabled ? { disabled: true, disabledReason: key.disabledReason } : {}),
						...(key.network ? { network: structuredClone(key.network) } : {}),
					},
				};
				return { kind: "api-key", id: key.id, label: keyLabel(provider.name, key), data };
			});
	},
	match: (data) =>
		data.map((raw) => {
			const item = asApiKeyItem(raw);
			if (!item) return null;
			const target = targetProvider(item.provider);
			const existing = target
				? getProviderKeyStore()
						.list(target.id)
						.find((key) => key.apiKey === item.key.apiKey.trim())
				: undefined;
			return {
				label: keyLabel(target?.name ?? item.provider.name, item.key),
				existingId: existing?.id,
			};
		}),
	import: (data, decide) => {
		const store = getProviderKeyStore();
		const result = { added: 0, replaced: 0, skipped: 0 };
		const items = data.map(asApiKeyItem);
		// Providers this instance lacks are created first (without a key), once each.
		const created: CustomApiProviderConfig[] = [];
		items.forEach((item, index) => {
			if (!item || targetProvider(item.provider)) return;
			if (created.some((p) => p.id === item.provider.id)) return;
			if (decide(index, undefined) === "skip") return;
			created.push({
				...structuredClone(item.provider),
				prefix: uniquePrefix(item.provider.prefix),
				apiKey: "",
			} as CustomApiProviderConfig);
		});
		if (created.length) {
			saveSettings({
				...settings,
				customApiProviders: [...(settings.customApiProviders ?? []), ...created],
			});
		}
		items.forEach((item, index) => {
			const target = item && targetProvider(item.provider);
			if (!item || !target) {
				result.skipped++;
				return;
			}
			const apiKey = item.key.apiKey.trim();
			const existing = store.list(target.id).find((key) => key.apiKey === apiKey);
			const action = decide(index, existing?.id);
			if (action === "skip" || (action === "add" && existing)) {
				result.skipped++;
				return;
			}
			const fields = {
				label: item.key.label ?? "",
				disabled: !!item.key.disabled,
				disabledReason: item.key.disabledReason,
				network: item.key.network ?? null,
			};
			if (existing) {
				store.update(existing.id, fields);
				result.replaced++;
				return;
			}
			const key = store.add(target.id, { apiKey, id: item.key.id });
			store.update(key.id, fields);
			result.added++;
		});
		return result;
	},
};

export const KINDS: readonly TransferKind[] = [codexKind, apiKeyKind];
