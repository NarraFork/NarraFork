/**
 * Provider keys inside a data export (docs/DATA_PORTABILITY.md).
 *
 * `providers.json` carries provider configuration with every key blanked. The keys travel
 * in `provider-keys.sealed.json`, sealed with a passphrase the admin chooses at export
 * (same format as a credential bundle, credential-transfer/bundle.ts). Exporting them needs
 * a step-up check; importing needs the passphrase.
 *
 * Keys are grouped by the exporting instance's owner id: a custom API provider by its id
 * (all its keys, in priority order), NUG providers, TokenDance and Command Code by their
 * namespaced owner ids (one key each). Search providers are not part of a data export.
 */
import type { CredentialNetwork } from "@shared/credential-network";
import { type BundleContents, openBundle, sealBundle } from "../lib/credential-transfer/bundle";
import { logger } from "../lib/logger";
import { getProviderKeyStore, type ProviderKeyDisabledReason } from "../lib/provider-keys";
import {
	COMMAND_CODE_KEY_OWNER,
	nugKeyOwner,
	platformInstanceKeyOwner,
	TOKENDANCE_KEY_OWNER,
} from "../lib/settings/provider-keys-projection";

export const SEALED_KEYS_ENTRY = "provider-keys.sealed.json";
/** Bundle item kind for a provider's keys; one item per owner. */
const ITEM_KIND = "provider-keys";

export interface ExportedKey {
	apiKey: string;
	label?: string;
	disabled?: boolean;
	disabledReason?: ProviderKeyDisabledReason;
	network?: CredentialNetwork;
}

/** Owner id on the exporting instance → its keys, first one first. */
export type ExportedKeys = Map<string, ExportedKey[]>;

type ProviderSection = Record<string, unknown>;

function ownersOf(providers: ProviderSection): string[] {
	const ids = (list: unknown, owner: (id: string) => string) =>
		Array.isArray(list)
			? list
					.map((entry) => (entry as { id?: unknown })?.id)
					.filter((id): id is string => typeof id === "string" && !!id)
					.map(owner)
			: [];
	return [
		...ids(providers.customApiProviders, (id) => id),
		...ids(providers.nugProviders, nugKeyOwner),
		...(providers.tokendance ? [TOKENDANCE_KEY_OWNER] : []),
		...(providers.commandCode ? [COMMAND_CODE_KEY_OWNER] : []),
		// 平台实例各持一份密钥，owner 是实例 id。
		...ids(providers.platformInstances, platformInstanceKeyOwner),
	];
}

/** Every stored key of the exported providers. Only in-memory reads. */
export function collectProviderKeys(providers: ProviderSection): ExportedKeys {
	const store = getProviderKeyStore();
	const out: ExportedKeys = new Map();
	for (const owner of ownersOf(providers)) {
		const keys = store.list(owner).map(
			(key): ExportedKey => ({
				apiKey: key.apiKey,
				...(key.label ? { label: key.label } : {}),
				...(key.disabled
					? {
							disabled: true,
							...(key.disabledReason ? { disabledReason: key.disabledReason } : {}),
						}
					: {}),
				...(key.network ? { network: structuredClone(key.network) } : {}),
			}),
		);
		if (keys.length) out.set(owner, keys);
	}
	return out;
}

/** The provider section as `providers.json` stores it: same structure, no key anywhere. */
export function withoutKeys(providers: ProviderSection): ProviderSection {
	const blank = (list: unknown) =>
		Array.isArray(list)
			? list.map((entry) => ({ ...(entry as Record<string, unknown>), apiKey: "" }))
			: list;
	const out: ProviderSection = { ...providers };
	if ("customApiProviders" in out) out.customApiProviders = blank(out.customApiProviders);
	if ("nugProviders" in out) out.nugProviders = blank(out.nugProviders);
	if (out.tokendance && typeof out.tokendance === "object") {
		out.tokendance = { ...(out.tokendance as Record<string, unknown>), apiKey: "" };
	}
	if (out.commandCode && typeof out.commandCode === "object") {
		const { apiKey: _secret, ...rest } = out.commandCode as Record<string, unknown>;
		out.commandCode = rest;
	}
	if (Array.isArray(out.platformInstances)) {
		out.platformInstances = (out.platformInstances as Array<Record<string, unknown>>).map(
			(instance) => {
				const config = instance.config;
				if (!config || typeof config !== "object") return instance;
				const { apiKey: _secret, ...rest } = config as Record<string, unknown>;
				return { ...instance, config: rest };
			},
		);
	}
	return out;
}

export async function sealProviderKeys(keys: ExportedKeys, passphrase: string): Promise<string> {
	const contents: BundleContents = {
		exportedAt: Date.now(),
		items: [...keys].map(([owner, list]) => ({
			kind: ITEM_KIND,
			id: owner,
			label: owner,
			data: list,
		})),
	};
	return sealBundle(contents, passphrase);
}

function asExportedKey(raw: unknown): ExportedKey | null {
	if (!raw || typeof raw !== "object") return null;
	const key = raw as Partial<ExportedKey>;
	if (typeof key.apiKey !== "string" || !key.apiKey.trim()) return null;
	return {
		apiKey: key.apiKey.trim(),
		...(typeof key.label === "string" && key.label ? { label: key.label } : {}),
		...(key.disabled === true ? { disabled: true } : {}),
		...(key.disabledReason === "manual" || key.disabledReason === "invalid"
			? { disabledReason: key.disabledReason }
			: {}),
		...(key.network && typeof key.network === "object" ? { network: key.network } : {}),
	};
}

/** Open the sealed keys. Throws BundleError (wrong passphrase, altered file). */
export async function openProviderKeys(text: string, passphrase: string): Promise<ExportedKeys> {
	const contents = await openBundle(text, passphrase);
	const out: ExportedKeys = new Map();
	for (const item of contents.items) {
		if (item.kind !== ITEM_KIND || !Array.isArray(item.data)) continue;
		const keys = item.data.map(asExportedKey).filter((key): key is ExportedKey => key !== null);
		if (keys.length) out.set(item.id, keys);
	}
	return out;
}

/**
 * The provider section with each provider's first key put back where `providers.json`
 * had it blank. The merge's "same key + same base URL is the same provider" check and the
 * settings projection (first key → key store) then work as for an old plain export.
 */
export function withFirstKeys(providers: ProviderSection, keys: ExportedKeys): ProviderSection {
	const out = structuredClone(providers);
	const first = (owner: string) => keys.get(owner)?.[0]?.apiKey;
	const fill = (list: unknown, owner: (id: string) => string) => {
		if (!Array.isArray(list)) return;
		for (const entry of list as Array<Record<string, unknown>>) {
			const key = typeof entry.id === "string" ? first(owner(entry.id)) : undefined;
			if (key) entry.apiKey = key;
		}
	};
	fill(out.customApiProviders, (id) => id);
	fill(out.nugProviders, nugKeyOwner);
	const tokendance = first(TOKENDANCE_KEY_OWNER);
	if (tokendance && out.tokendance && typeof out.tokendance === "object") {
		(out.tokendance as Record<string, unknown>).apiKey = tokendance;
	}
	const commandCode = first(COMMAND_CODE_KEY_OWNER);
	if (commandCode && out.commandCode && typeof out.commandCode === "object") {
		(out.commandCode as Record<string, unknown>).apiKey = commandCode;
	}
	if (Array.isArray(out.platformInstances)) {
		for (const instance of out.platformInstances as Array<Record<string, unknown>>) {
			const key =
				typeof instance.id === "string" ? first(platformInstanceKeyOwner(instance.id)) : undefined;
			if (!key) continue;
			const config = instance.config;
			instance.config = { ...(config as Record<string, unknown> | undefined), apiKey: key };
		}
	}
	return out;
}

/**
 * After the import transaction committed: the custom API providers that were added get
 * the rest of their keys, and the first key (already stored by the settings save) gets its
 * label, switch and network. Providers merged into a local one, or skipped, keep their
 * local keys. One key failing does not stop the others.
 */
export function restoreExtraKeys(
	keys: ExportedKeys,
	added: ReadonlyMap<string, string>,
): { imported: number; failed: number } {
	const store = getProviderKeyStore();
	const result = { imported: 0, failed: 0 };
	for (const [incomingId, localId] of added) {
		const list = keys.get(incomingId);
		if (!list?.length) continue;
		const stored = store.list(localId);
		list.forEach((key, index) => {
			try {
				const fields = {
					...(key.label ? { label: key.label } : {}),
					disabled: !!key.disabled,
					...(key.disabledReason ? { disabledReason: key.disabledReason } : {}),
					...(key.network ? { network: key.network } : {}),
				};
				const existing = stored.find((item) => item.apiKey === key.apiKey);
				const target = existing ?? store.add(localId, { apiKey: key.apiKey });
				store.update(target.id, fields);
				// The first key was stored by the settings save; count it all the same.
				if (index === 0 || !existing) result.imported += 1;
			} catch (error) {
				result.failed += 1;
				logger.warn("Import could not restore a provider key", {
					providerId: localId,
					position: index,
					error: String(error),
				});
			}
		});
	}
	return result;
}

/** Keys of single-key providers (NUG, TokenDance, Command Code) are restored by settings. */
export function countSingleKeys(keys: ExportedKeys, owners: ReadonlySet<string>): number {
	let total = 0;
	for (const owner of owners) if (keys.get(owner)?.length) total += 1;
	return total;
}
