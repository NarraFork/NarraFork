import { extractPrimaryDomainLabel } from "../../lib/url";
import {
	type AddProviderDraft,
	customProviderFromDraft,
	isValidProviderDraft,
	nugProviderFromDraft,
	sanitizeProviderPrefix,
} from "./provider-add-draft";
import type { AddProviderType } from "./provider-presets";
import { type ProvidersState, providersStateFromSettings } from "./providers-reducer";

export interface ProviderCreateDependencies {
	getSettings(): Promise<Record<string, unknown>>;
	updateSettings(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
	refreshModels(id: string, protocol: AddProviderType): Promise<unknown>;
	onSaved(settings: Record<string, unknown>): void;
	onRefreshed(settings: Record<string, unknown>): void;
	messages: {
		invalidDraft: string;
		prefixConflict: (prefix: string) => string;
		unconfirmedSave: string;
	};
}

function savedProvider(settings: Record<string, unknown>, id: string) {
	const state = providersStateFromSettings(settings);
	const custom = state.customApiProviders.find((provider) => provider.id === id);
	if (custom) return { providerId: custom.id, protocol: custom.protocol };
	const nug = state.nugProviders.find((provider) => provider.id === id);
	return nug ? { providerId: nug.id, protocol: "nug" as const } : undefined;
}

type ProviderArrayField = "customApiProviders" | "nugProviders";

function persistedRecords(
	latest: Record<string, unknown>,
	server: ProvidersState,
	field: ProviderArrayField,
): Record<string, unknown>[] {
	// Raw modern records retain masked credentials and fields unknown to the UI.
	const raw = latest[field];
	if (Array.isArray(raw) && (field === "nugProviders" || raw.length > 0)) {
		return raw as Record<string, unknown>[];
	}
	// An empty/missing unified array may still represent legacy providers.
	const legacyById = new Map<unknown, Record<string, unknown>>();
	if (field === "customApiProviders") {
		for (const legacyField of ["openaiProviders", "anthropicProviders", "geminiProviders"]) {
			const legacy = latest[legacyField];
			if (!Array.isArray(legacy)) continue;
			for (const provider of legacy as Record<string, unknown>[]) {
				legacyById.set(provider.id, { ...legacyById.get(provider.id), ...provider });
			}
		}
	}
	return server[field].map((provider) => ({ ...legacyById.get(provider.id), ...provider }));
}

let pendingSave: Promise<unknown> = Promise.resolve();

function serializeSave<T>(save: () => Promise<T>): Promise<T> {
	const result = pendingSave.then(save, save);
	pendingSave = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

async function saveProvider(
	id: string,
	draft: AddProviderDraft,
	local: ProvidersState,
	deps: ProviderCreateDependencies,
) {
	if (!isValidProviderDraft(draft)) throw new Error(deps.messages.invalidDraft);
	const latest = await deps.getSettings();
	const server = providersStateFromSettings(latest);
	const usedPrefixes = new Set([
		"codex",
		...[
			...server.customApiProviders,
			...server.nugProviders,
			...local.customApiProviders,
			...local.nugProviders,
		]
			.filter((provider) => provider.id !== id)
			.map((provider) => sanitizeProviderPrefix(provider.prefix).trim()),
	]);
	let prefix = sanitizeProviderPrefix(draft.prefix).trim();
	if (prefix && usedPrefixes.has(prefix)) {
		throw new Error(deps.messages.prefixConflict(prefix));
	}
	if (!prefix) {
		const seed =
			extractPrimaryDomainLabel(draft.baseUrl) ||
			sanitizeProviderPrefix(draft.name)
				.trim()
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-+|-+$/g, "") ||
			"provider";
		prefix = seed;
		for (let suffix = 2; usedPrefixes.has(prefix); suffix++) prefix = `${seed}-${suffix}`;
	}
	const prepared = { ...draft, prefix };
	const field = draft.protocol === "nug" ? "nugProviders" : "customApiProviders";
	const created =
		prepared.protocol === "nug"
			? nugProviderFromDraft(id, prepared)
			: customProviderFromDraft(id, { ...prepared, protocol: prepared.protocol });
	const records = persistedRecords(latest, server, field);
	const existing = records.find((provider) => provider.id === id);
	const replacement = { ...existing, ...created };
	const providers = records.some((provider) => provider.id === id)
		? records.map((provider) => (provider.id === id ? replacement : { ...provider }))
		: [...records.map((provider) => ({ ...provider })), replacement];
	const payload: Record<string, unknown> = { [field]: providers };
	const otherField = field === "nugProviders" ? "customApiProviders" : "nugProviders";
	const otherRecords = persistedRecords(latest, server, otherField);
	// A retry can switch families after a lost response. This is the sole two-array
	// PATCH exception: atomically move this creation intent, preserving every other ID.
	if (otherRecords.some((provider) => provider.id === id)) {
		payload[otherField] = otherRecords
			.filter((provider) => provider.id !== id)
			.map((provider) => ({ ...provider }));
	}
	let confirmed = await deps.updateSettings(payload);
	let saved = savedProvider(confirmed, id);
	if (!saved) {
		confirmed = await deps.getSettings();
		saved = savedProvider(confirmed, id);
	}
	if (!saved) throw new Error(deps.messages.unconfirmedSave);
	deps.onSaved(confirmed);
	return saved;
}

/** Save only the new provider against persisted settings, then refresh its confirmed identity. */
export async function createProviderAndRefresh(
	id: string,
	draft: AddProviderDraft,
	local: ProvidersState,
	deps: ProviderCreateDependencies,
): Promise<{ providerId: string; refreshError?: unknown }> {
	// Serialize read/merge/save only; slow model refreshes must not hold the save queue.
	const saved = await serializeSave(() => saveProvider(id, draft, local, deps));
	try {
		await deps.refreshModels(saved.providerId, saved.protocol);
		deps.onRefreshed(await deps.getSettings());
		return { providerId: saved.providerId };
	} catch (refreshError) {
		return { providerId: saved.providerId, refreshError };
	}
}
