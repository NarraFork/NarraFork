/**
 * settings.json ↔ provider-keys.json.
 *
 * On disk, provider entries carry no API key; the keys live in the provider key store.
 * In memory each entry's `apiKey` is its first stored key, so every reader of a single
 * key keeps working and every writer of that field edits the first key. If the key file
 * cannot be read, nothing moves and settings.json keeps its keys as before.
 *
 * Covered fields: the `apiKey` of custom API providers, NUG providers, TokenDance, Command
 * Code and custom search providers. Custom API providers own their keys under their own id
 * (they can hold several, see agent/pooled-provider.ts); the others hold one key each, under
 * a namespaced owner id. NUG OAuth client secrets and search provider headers stay in
 * settings.json for now.
 */
import { getProviderKeyStore } from "../provider-keys";
import { normalizeCustomApiProviderSettings } from "./custom-api-providers";
import type { NarraForkSettings } from "./types";

// Custom API provider ids are nanoids, which never contain ":", so these cannot collide.
export const TOKENDANCE_KEY_OWNER = "builtin:tokendance";
export const COMMAND_CODE_KEY_OWNER = "builtin:CommandCode";
export const nugKeyOwner = (providerId: string) => `nug:${providerId}`;
export const searchKeyOwner = (providerId: string) => `search:${providerId}`;
/** 每个平台实例一份密钥，删掉实例时由 pruneProviderKeys 一并清掉。 */
export const platformInstanceKeyOwner = (instanceId: string) => `platform:${instanceId}`;

/** One settings field whose secret lives in the key store. */
interface KeySlot {
	/** Store owner id. */
	owner: string;
	/** Custom API providers keep their extra keys when the slot goes away (see the route). */
	pooled: boolean;
	holder: { apiKey?: string };
	/** `apiKey` is a required string on this holder, so "no key" is "" rather than absent. */
	required: boolean;
}

function keySlots(settings: NarraForkSettings): KeySlot[] {
	const slots: KeySlot[] = [];
	for (const holder of settings.customApiProviders ?? []) {
		slots.push({ owner: holder.id, pooled: true, holder, required: true });
	}
	for (const holder of settings.nugProviders ?? []) {
		slots.push({ owner: nugKeyOwner(holder.id), pooled: false, holder, required: true });
	}
	if (settings.tokendance) {
		const holder = settings.tokendance;
		slots.push({ owner: TOKENDANCE_KEY_OWNER, pooled: false, holder, required: true });
	}
	if (settings.commandCode) {
		const holder = settings.commandCode;
		slots.push({ owner: COMMAND_CODE_KEY_OWNER, pooled: false, holder, required: false });
	}
	for (const holder of settings.search?.customProviders ?? []) {
		slots.push({ owner: searchKeyOwner(holder.id), pooled: false, holder, required: false });
	}
	// 平台实例的密钥写在实例自己的 config 里；投影把它挪进 key store，删实例即删密钥。
	for (const instance of settings.agent?.platformInstances ?? []) {
		slots.push({
			owner: platformInstanceKeyOwner(instance.id),
			pooled: false,
			holder: instance.config,
			required: false,
		});
	}
	return slots;
}

const asStoreEntries = (slots: KeySlot[]) =>
	slots.map((slot) => ({ id: slot.owner, apiKey: slot.holder.apiKey }));

/** In memory only: each entry's `apiKey` becomes its first stored key. */
export function hydrateProviderKeys(settings: NarraForkSettings): void {
	const store = getProviderKeyStore();
	if (!store.readable) return;
	for (const slot of keySlots(settings)) {
		const key = store.firstKey(slot.owner);
		if (key !== undefined) slot.holder.apiKey = key;
		else if (slot.required) slot.holder.apiKey = "";
		else delete slot.holder.apiKey;
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
	const hadKeys = slots.some((slot) => !!slot.holder.apiKey?.trim());
	store.syncFirstKeys(asStoreEntries(slots), { clearOnEmpty: false });
	hydrateProviderKeys(settings);
	return hadKeys && store.readable;
}

/** Saving: the first keys settings now hold are written to the store. */
export function syncProviderKeys(settings: NarraForkSettings): void {
	getProviderKeyStore().syncFirstKeys(asStoreEntries(keySlots(settings)), { clearOnEmpty: true });
}

/**
 * After a successful save: keys of single-key entries that `previous` had and `next` no
 * longer has (a deleted NUG or search provider, a cleared TokenDance connection) are
 * removed, so the next load cannot bring them back. Custom API providers are left to the
 * settings route, which removes all of a deleted provider's keys explicitly.
 */
export function pruneProviderKeys(previous: NarraForkSettings, next: NarraForkSettings): void {
	const store = getProviderKeyStore();
	if (!store.readable || previous === next) return;
	const kept = new Set(keySlots(next).map((slot) => slot.owner));
	for (const slot of keySlots(previous)) {
		if (!slot.pooled && !kept.has(slot.owner)) store.removeProvider(slot.owner);
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
		customApiProviders: blank(settings.customApiProviders),
		openaiProviders: blank(settings.openaiProviders),
		anthropicProviders: blank(settings.anthropicProviders),
		geminiProviders: blank(settings.geminiProviders),
		nugProviders: blank(settings.nugProviders),
		...(settings.tokendance ? { tokendance: { ...settings.tokendance, apiKey: "" } } : {}),
		...(settings.commandCode ? { commandCode: omit(settings.commandCode) } : {}),
		...(settings.agent?.platformInstances
			? {
					agent: {
						...settings.agent,
						platformInstances: settings.agent.platformInstances.map((instance) => ({
							...instance,
							config: omit(instance.config),
						})),
					},
				}
			: {}),
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
