/**
 * settings.json ↔ the provider key store (provider-keys.ts).
 *
 * On disk, provider entries carry no API key; the keys live in the provider key store.
 * In memory each entry's `apiKey` is its first stored key, so every reader of a single
 * key keeps working and every writer of that field edits the first key. If the key file
 * cannot be read, nothing moves and settings.json keeps its keys as before.
 *
 * Covered fields: the `apiKey` of custom API providers, NUG providers, TokenDance, Command
 * Code and custom search providers, custom API providers' `quotaAccessToken`, and NUG's
 * `oauthClientSecret`. Model providers project only their first inference key; extra keys
 * stay in the pool. NUG and built-ins retain namespaced facade owners until S5, mapped to
 * group ids by the unified store. Site tokens and OAuth secrets never join that pool.
 * Search headers live separately in search-header-secrets.ts.
 */
import {
	COMMAND_CODE_KEY_OWNER,
	getProviderKeyStore,
	nugKeyOwner,
	nugOAuthKeyOwner,
	quotaKeyOwner,
	searchKeyOwner,
	TOKENDANCE_KEY_OWNER,
	tokenDanceLoginAccount,
} from "../provider-keys";
import { normalizeCustomApiProviderSettings } from "./custom-api-providers";
import type { NarraForkSettings } from "./types";

export {
	COMMAND_CODE_KEY_OWNER,
	nugKeyOwner,
	nugOAuthKeyOwner,
	quotaKeyOwner,
	searchKeyOwner,
	TOKENDANCE_KEY_OWNER,
};

/** One settings field whose secret lives in the key store. */
interface KeySlot {
	/** Store owner id. */
	owner: string;
	/** Whether deleting the entire holder removes its owner; unrelated to pool size. */
	pruneOnDelete: boolean;
	holder: { apiKey?: string; quotaAccessToken?: string; oauthClientSecret?: string };
	field: "apiKey" | "quotaAccessToken" | "oauthClientSecret";
	/** The field is required on this holder, so "no key" is "" rather than absent. */
	required: boolean;
}

function keySlots(settings: NarraForkSettings): KeySlot[] {
	const slots: KeySlot[] = [];
	for (const holder of settings.customApiProviders ?? []) {
		slots.push({ owner: holder.id, pruneOnDelete: false, holder, field: "apiKey", required: true });
		slots.push({
			owner: quotaKeyOwner(holder.id),
			pruneOnDelete: true,
			holder,
			field: "quotaAccessToken",
			required: false,
		});
	}
	for (const holder of settings.nugProviders ?? []) {
		slots.push({
			owner: nugKeyOwner(holder.id),
			pruneOnDelete: true,
			holder,
			field: "apiKey",
			required: true,
		});
		slots.push({
			owner: nugOAuthKeyOwner(holder.id),
			pruneOnDelete: true,
			holder,
			field: "oauthClientSecret",
			required: false,
		});
	}
	if (settings.tokendance) {
		const holder = settings.tokendance;
		slots.push({
			owner: TOKENDANCE_KEY_OWNER,
			pruneOnDelete: true,
			holder,
			field: "apiKey",
			required: true,
		});
	}
	if (settings.commandCode) {
		const holder = settings.commandCode;
		slots.push({
			owner: COMMAND_CODE_KEY_OWNER,
			pruneOnDelete: true,
			holder,
			field: "apiKey",
			required: false,
		});
	}
	for (const holder of settings.search?.customProviders ?? []) {
		slots.push({
			owner: searchKeyOwner(holder.id),
			pruneOnDelete: true,
			holder,
			field: "apiKey",
			required: false,
		});
	}
	return slots;
}

const asStoreEntries = (slots: KeySlot[]) =>
	slots.map((slot) => ({ id: slot.owner, apiKey: slot.holder[slot.field] }));

/** In memory only: each credential field becomes its owner's first stored key. */
export function hydrateProviderKeys(settings: NarraForkSettings): void {
	const store = getProviderKeyStore();
	if (!store.readable) return;
	for (const slot of keySlots(settings)) {
		const key = store.firstKey(slot.owner);
		if (key !== undefined) slot.holder[slot.field] = key;
		else if (slot.required) slot.holder[slot.field] = "";
		else delete slot.holder[slot.field];
	}
	normalizeCustomApiProviderSettings(settings);
}

/**
 * Loading: keys still written in settings.json move into the store. Returns true when
 * settings.json held keys, so the caller rewrites it without them.
 */
export function absorbProviderKeys(settings: NarraForkSettings): boolean {
	const store = getProviderKeyStore();
	const slots = keySlots(settings);
	const hadKeys = slots.some((slot) => !!slot.holder[slot.field]?.trim());
	// Only the pre-pool settings secret identifies a legacy browser-login credential.
	// Never infer login identity from a projected first key in a multi-key pool.
	const legacyLoginKey = settings.tokendance?.apiKey?.trim();
	const canIdentifyLegacyLogin = !!legacyLoginKey && store.list(TOKENDANCE_KEY_OWNER).length <= 1;
	store.syncFirstKeys(asStoreEntries(slots), { clearOnEmpty: false });
	if (canIdentifyLegacyLogin && store.readable) {
		const key = store.list(TOKENDANCE_KEY_OWNER).find((key) => key.apiKey === legacyLoginKey);
		if (key && !key.account) store.update(key.id, { account: tokenDanceLoginAccount(key.apiKey) });
	}
	hydrateProviderKeys(settings);
	return hadKeys && store.readable;
}

/** Saving: the first keys settings now hold are written to the store. */
export function syncProviderKeys(settings: NarraForkSettings): void {
	getProviderKeyStore().syncFirstKeys(asStoreEntries(keySlots(settings)), { clearOnEmpty: true });
}

/**
 * After a successful save, remove an owner's keys only when its entire settings holder
 * disappeared. Clearing/removing/reordering the projected first key must never prune the
 * surviving pool. Deleting a NUG/built-in/search connection removes its whole pool; custom
 * API inference pools remain owned by the settings route's provider-deletion handling.
 */
export function pruneProviderKeys(previous: NarraForkSettings, next: NarraForkSettings): void {
	const store = getProviderKeyStore();
	if (!store.readable || previous === next) return;
	const kept = new Set(keySlots(next).map((slot) => slot.owner));
	for (const slot of keySlots(previous)) {
		if (slot.pruneOnDelete && !kept.has(slot.owner)) store.removeProvider(slot.owner);
	}
}

/** The object written to settings.json: provider entries with their keys blanked. */
export function withoutProviderKeys(settings: NarraForkSettings): NarraForkSettings {
	if (!getProviderKeyStore().readable) return settings;
	const blank = <T extends { apiKey: string }>(list: T[] | undefined) =>
		list?.map((entry) => ({ ...entry, apiKey: "" }));
	const omit = <T extends { apiKey?: string }>({ apiKey: _secret, ...rest }: T) => rest;
	return {
		...settings,
		customApiProviders: settings.customApiProviders?.map(
			({ quotaAccessToken: _token, ...entry }) => ({ ...entry, apiKey: "" }),
		),
		openaiProviders: blank(settings.openaiProviders),
		anthropicProviders: blank(settings.anthropicProviders),
		geminiProviders: blank(settings.geminiProviders),
		nugProviders: settings.nugProviders?.map(({ oauthClientSecret: _secret, ...entry }) => ({
			...entry,
			apiKey: "",
		})),
		...(settings.tokendance ? { tokendance: { ...settings.tokendance, apiKey: "" } } : {}),
		...(settings.commandCode ? { commandCode: omit(settings.commandCode) } : {}),
		...(settings.search
			? {
					search: {
						...settings.search,
						// Typed as required, but older or hand-edited files can lack it.
						customProviders: (settings.search.customProviders ?? []).map(omit),
					},
				}
			: {}),
	};
}
