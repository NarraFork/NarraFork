/** Readers for the pre-S2 credential bundles and v1/v2 data exports. */
import type { CredentialNetwork } from "@shared/credential-network";
import { identifyService } from "@shared/sourcing/identify";
import { type CodexCredential, codexToCredential } from "../codex-manager";
import type { Credential, GroupSecrets } from "../credential-store";
import type { BundleItem } from "../credential-transfer/bundle";
import {
	type CredentialTransferData,
	publicGroup,
	singletonGroup,
	type TransferGroup,
} from "../credential-transfer/kinds";
import { logger } from "../logger";
import { getProviderKeyStore } from "../provider-keys";
import {
	COMMAND_CODE_KEY_OWNER,
	nugKeyOwner,
	nugOAuthKeyOwner,
	quotaKeyOwner,
	TOKENDANCE_KEY_OWNER,
} from "../settings/provider-keys-projection";
import type { ServiceTemplateId } from "./templates";

export interface ExportedKey {
	apiKey: string;
	label?: string;
	disabled?: boolean;
	disabledReason?: "manual" | "invalid";
	network?: CredentialNetwork;
}

/** Owner id on the exporting instance → its keys, first one first (v2 only). */
export type ExportedKeys = Map<string, ExportedKey[]>;

type ProviderSection = Record<string, unknown>;

const secretOwners = [
	[quotaKeyOwner, "quotaAccessToken"],
	[nugOAuthKeyOwner, "oauthClientSecret"],
] as const;

function keyCredential(
	groupId: string,
	key: ExportedKey,
	priority: number,
): Omit<Credential, "id"> {
	return {
		target: { groupId },
		ownerUserId: null,
		...(key.label ? { label: key.label } : {}),
		priority,
		createdAt: 0,
		...(key.disabled
			? { disabled: true, ...(key.disabledReason ? { disabledReason: key.disabledReason } : {}) }
			: {}),
		...(key.network ? { network: structuredClone(key.network) } : {}),
		auth: { kind: "api_key", apiKey: key.apiKey },
	};
}

function data(
	group: TransferGroup,
	templateId: ServiceTemplateId,
	credential?: Omit<Credential, "id">,
	groupSecrets?: GroupSecrets,
): CredentialTransferData {
	return {
		group,
		templateId,
		...(credential ? { credential } : {}),
		...(groupSecrets ? { groupSecrets } : {}),
	};
}

function groupSecretsOf(config: Record<string, unknown>): GroupSecrets {
	return {
		...(typeof config.quotaAccessToken === "string" && config.quotaAccessToken
			? { quotaAccessToken: config.quotaAccessToken }
			: {}),
		...(typeof config.oauthClientSecret === "string" && config.oauthClientSecret
			? { oauthClientSecret: config.oauthClientSecret }
			: {}),
	};
}

function legacyCodex(raw: unknown): CredentialTransferData | null {
	if (!raw || typeof raw !== "object") return null;
	try {
		const { id: _id, ...credential } = codexToCredential(raw as CodexCredential);
		return data(singletonGroup("codex"), "codex", credential);
	} catch {
		return null;
	}
}

function legacyApiKey(raw: unknown): CredentialTransferData | null {
	const item = raw as {
		provider?: Record<string, unknown>;
		key?: ExportedKey;
	} | null;
	const provider = item?.provider;
	if (!provider || typeof provider.id !== "string" || typeof item.key?.apiKey !== "string") {
		return null;
	}
	const group = publicGroup(provider);
	const { templateId } = identifyService(provider as never);
	return data(group, templateId, keyCredential(group.id, item.key, 0));
}

/** Old codex/api-key items become the one new item shape before preview or import. */
export function normalizeLegacyBundle(items: readonly BundleItem[]): BundleItem[] {
	return items.map((item) => {
		if (item.kind === "credential") return item;
		if (item.kind === "group-secrets") return { ...item, kind: "credential" };
		const converted =
			item.kind === "codex"
				? legacyCodex(item.data)
				: item.kind === "api-key"
					? legacyApiKey(item.data)
					: null;
		return converted ? { ...item, kind: "credential", data: converted } : item;
	});
}

function providerLists(providers: ProviderSection) {
	return {
		custom: Array.isArray(providers.customApiProviders)
			? (providers.customApiProviders as Array<Record<string, unknown>>)
			: [],
		nug: Array.isArray(providers.nugProviders)
			? (providers.nugProviders as Array<Record<string, unknown>>)
			: [],
	};
}

function groupForLegacyConfig(config: Record<string, unknown>, templateId: ServiceTemplateId) {
	if (templateId === "tokendance" || templateId === "command-code") {
		return singletonGroup(templateId, config);
	}
	return publicGroup(config);
}

/**
 * Convert v1 inline secrets and v2 owner-namespaced sealed keys. This is the only import path
 * that needs to know those owner spellings; callers receive ordinary credential entries.
 */
export function legacyProviderTransferItems(
	providers: ProviderSection,
	sealed?: readonly BundleItem[],
): CredentialTransferData[] {
	const { custom, nug } = providerLists(providers);
	const keyed = new Map<string, ExportedKey[]>();
	for (const item of sealed ?? []) {
		if (item.kind !== "provider-keys" || !Array.isArray(item.data)) continue;
		keyed.set(item.id, item.data as ExportedKey[]);
	}
	const out: CredentialTransferData[] = [];
	const append = (
		config: Record<string, unknown>,
		templateId: ServiceTemplateId,
		owner: string,
		inline: boolean,
	) => {
		const group = groupForLegacyConfig(config, templateId);
		const keys = keyed.get(owner) ?? [];
		if (inline && typeof config.apiKey === "string" && config.apiKey.trim()) {
			keys.unshift({ apiKey: config.apiKey });
		}
		keys.forEach((key, priority) => {
			if (typeof key.apiKey === "string" && key.apiKey.trim()) {
				out.push(data(group, templateId, keyCredential(group.id, key, priority)));
			}
		});
		const secrets = groupSecretsOf(config);
		for (const [ownerOf, field] of secretOwners) {
			const secret = keyed.get(ownerOf(group.id))?.[0]?.apiKey;
			if (secret) secrets[field] = secret;
		}
		if (Object.values(secrets).some(Boolean)) out.push(data(group, templateId, undefined, secrets));
	};

	for (const config of custom) {
		if (typeof config.id !== "string") continue;
		append(config, identifyService(config as never).templateId, config.id, !sealed);
	}
	for (const config of nug) {
		if (typeof config.id !== "string") continue;
		append(config, "nug", nugKeyOwner(config.id), !sealed);
	}
	for (const [field, templateId, owner] of [
		["tokendance", "tokendance", TOKENDANCE_KEY_OWNER],
		["commandCode", "command-code", COMMAND_CODE_KEY_OWNER],
	] as const) {
		const config = providers[field];
		if (config && typeof config === "object") {
			append(config as Record<string, unknown>, templateId, owner, !sealed);
		}
	}

	return out;
}

/** The pre-v3 merge helpers, retained for old-package tests and migrations only. */
export function withFirstKeys(providers: ProviderSection, keys: ExportedKeys): ProviderSection {
	const out = structuredClone(providers);
	const first = (owner: string) => keys.get(owner)?.[0]?.apiKey;
	const fill = (list: unknown, owner: (id: string) => string, field = "apiKey") => {
		if (!Array.isArray(list)) return;
		for (const entry of list as Array<Record<string, unknown>>) {
			const key = typeof entry.id === "string" ? first(owner(entry.id)) : undefined;
			if (key) entry[field] = key;
		}
	};
	fill(out.customApiProviders, (id) => id);
	fill(out.customApiProviders, quotaKeyOwner, "quotaAccessToken");
	fill(out.nugProviders, nugKeyOwner);
	fill(out.nugProviders, nugOAuthKeyOwner, "oauthClientSecret");
	const tokendance = first(TOKENDANCE_KEY_OWNER);
	if (tokendance && out.tokendance && typeof out.tokendance === "object") {
		(out.tokendance as Record<string, unknown>).apiKey = tokendance;
	}
	const commandCode = first(COMMAND_CODE_KEY_OWNER);
	if (commandCode && out.commandCode && typeof out.commandCode === "object") {
		(out.commandCode as Record<string, unknown>).apiKey = commandCode;
	}
	return out;
}

export function restoreExtraKeys(
	keys: ExportedKeys,
	added: ReadonlyMap<string, string>,
): { imported: number; failed: number } {
	const store = getProviderKeyStore();
	const result = { imported: 0, failed: 0 };
	for (const [incomingId, localId] of added) {
		if (keys.get(quotaKeyOwner(incomingId))?.length) result.imported += 1;
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
				if (index === 0 || !existing) result.imported += 1;
			} catch (error) {
				result.failed += 1;
				logger.warn("Import could not restore a legacy provider key", {
					providerId: localId,
					position: index,
					error: String(error),
				});
			}
		});
	}
	return result;
}

export function countSingleKeys(keys: ExportedKeys, owners: ReadonlySet<string>): number {
	let total = 0;
	for (const owner of owners) if (keys.get(owner)?.length) total += 1;
	return total;
}
