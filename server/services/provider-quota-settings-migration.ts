import { createHash } from "node:crypto";
import { AppError } from "@server/lib/errors";
import { getProviderKeyStore } from "@server/lib/provider-keys";
import { settings } from "@server/lib/settings";
import { quotaKeyOwner } from "@server/lib/settings/provider-keys-projection";
import type { ProviderSettingsContribution } from "@shared/provider-settings";
import type { PluginResourceMutation, PluginSettingsStore } from "./plugin-settings-store";
import { getPluginSettingsStore } from "./plugin-settings-store-provider";
import {
	isTrustedQuotaSettingsPackage,
	QUOTA_SETTINGS_CONTRIBUTION_ID,
} from "./provider-quota-settings-compat";
import { recoverQuotaCompatibilitySave } from "./provider-quota-settings-compat-save";
import { blockQuotaSettings, publishQuotaSettings } from "./provider-quota-settings-projection";
import { hasSiteQuotaConfig, siteQuotaRoot } from "./provider-quota-sites";
import { ProviderSettingsConfigPolicy } from "./provider-settings-config-policy";
import {
	readProviderSettingsCoreContext,
	settingsConfigContext,
} from "./provider-settings-context";
import { openProviderSetting } from "./provider-settings-data";
import { prepareProviderSettingsMigration } from "./provider-settings-migration-client";

export interface QuotaSettingsMigrationInput {
	pluginId: string;
	version: string;
	hash: string;
	installationId: string;
	providerId: string;
	declaration: ProviderSettingsContribution;
	signal?: AbortSignal;
}
const pending = new Map<string, Promise<void>>();
function fail(): never {
	throw new AppError(
		"Existing site settings could not be migrated; source data was retained",
		409,
		"PROVIDER_SETTINGS_MIGRATION_REQUIRED",
	);
}
export function quotaSettingsReceiptAddress(pluginId: string, providerId: string) {
	return {
		pluginId,
		ownerKind: "host-migration" as const,
		scopeType: "provider" as const,
		scopeId: JSON.stringify(["custom-api", providerId]),
		key: "quota-site-settings-v1",
	};
}
/** One bounded target at a time. No legacy file is removed or rewritten, and no permission is granted. */
export async function ensureQuotaSettingsMigration(
	input: QuotaSettingsMigrationInput,
	store?: PluginSettingsStore,
): Promise<void> {
	if (input.declaration.id !== QUOTA_SETTINGS_CONTRIBUTION_ID) return;
	const id = JSON.stringify([input.pluginId, input.providerId, input.installationId]);
	const active = pending.get(id);
	if (active) return active;
	if (pending.size >= 32)
		throw new AppError("Provider settings migration is busy", 429, "PROVIDER_SETTINGS_BUSY");
	const operation = migrate(input, store ?? (await getPluginSettingsStore()));
	pending.set(id, operation);
	try {
		await operation;
	} catch (error) {
		blockQuotaSettings(input.providerId);
		throw error;
	} finally {
		if (pending.get(id) === operation) pending.delete(id);
	}
}
async function migrate(
	input: QuotaSettingsMigrationInput,
	store: PluginSettingsStore,
): Promise<void> {
	input.signal?.throwIfAborted();
	await recoverQuotaCompatibilitySave(input.providerId, store);
	const address = {
		pluginId: input.pluginId,
		contributionId: input.declaration.id,
		targetKind: "custom-api" as const,
		targetId: input.providerId,
	};
	const receiptAddress = quotaSettingsReceiptAddress(input.pluginId, input.providerId);
	const [existing, receipt] = await Promise.all([
		store.getSetting(address, { signal: input.signal }),
		store.getResource(receiptAddress, { signal: input.signal }),
	]);
	if (existing) {
		// An explicit save/import/deletion is newer user intent. Never overwrite it from backup.
		if (existing.state !== "deleted") openProviderSetting(existing);
		const provider = settings.customApiProviders.find((item) => item.id === input.providerId);
		if (!provider) return fail();
		publishQuotaSettings(provider, existing);
		return;
	}
	if (
		!(await isTrustedQuotaSettingsPackage(input.pluginId, input.version, input.hash, input.signal))
	)
		return fail();
	if (receipt) return fail(); // Missing data with a durable receipt is not a fresh installation.
	const provider = settings.customApiProviders.find((value) => value.id === input.providerId);
	const keys = getProviderKeyStore();
	if (!provider || !keys.readable) return fail();
	const tokens = keys.list(quotaKeyOwner(input.providerId));
	if (tokens.length > 1) return fail();
	const token = tokens[0]?.apiKey ?? provider.quotaAccessToken;
	const source = {
		baseUrl: provider.baseUrl,
		quotaSiteUrl: provider.quotaSiteUrl,
		quotaUserId: provider.quotaUserId,
		quotaAccessToken: token,
	};
	const text = JSON.stringify(source);
	if (Buffer.byteLength(text) > 32768) return fail();
	const sourceFingerprint = createHash("sha256").update(text).digest("hex");
	const enabled = hasSiteQuotaConfig(source),
		root = siteQuotaRoot(source);
	if (enabled && !root) return fail();
	const values = {
		useSiteAccount: enabled,
		...(enabled && root ? { siteUrl: root } : {}),
		...(source.quotaUserId?.trim() ? { userId: source.quotaUserId.trim() } : {}),
	};
	const core = readProviderSettingsCoreContext("custom-api", input.providerId),
		context = settingsConfigContext(input.pluginId, input.installationId, core),
		policy = new ProviderSettingsConfigPolicy(input.declaration),
		view = policy.view(context);
	const receiptMutation: PluginResourceMutation = {
		address: receiptAddress,
		expectedRevision: 0,
		value: {
			installationId: input.installationId,
			bindingFingerprint: sourceFingerprint,
			state: "active",
			valueText: JSON.stringify({
				version: 1,
				sourceFingerprint,
				packageHash: input.hash,
				packageVersion: input.version,
				settingsRevision: 1,
				verified: true,
			}),
		},
	};
	try {
		const prepared = await prepareProviderSettingsMigration(
			context,
			input.declaration,
			{
				schemaVersion: 1,
				schemaFingerprint: view.schemaFingerprint,
				expectedRevision: 0,
				expectedBindingRevision: view.bindingRevision,
				values,
				secrets: token?.trim() ? { token: { operation: "set", value: token.trim() } } : {},
			},
			input.signal,
		);
		await store.commit(
			{ setting: prepared, resource: receiptMutation },
			{
				signal: input.signal,
				assertCurrent: () => {
					const current = settings.customApiProviders.find(
						(value) => value.id === input.providerId,
					);
					if (!current || !keys.readable) return fail();
					const actualToken =
						keys.list(quotaKeyOwner(input.providerId))[0]?.apiKey ?? current.quotaAccessToken;
					if (
						JSON.stringify({
							baseUrl: current.baseUrl,
							quotaSiteUrl: current.quotaSiteUrl,
							quotaUserId: current.quotaUserId,
							quotaAccessToken: actualToken,
						}) !== text
					)
						return fail();
				},
			},
		);
	} catch (error) {
		if (error instanceof AppError && error.code === "PLUGIN_SETTINGS_REVISION_CONFLICT") {
			const raced = await store.getSetting(address, { signal: input.signal });
			if (raced) {
				if (raced.state !== "deleted") openProviderSetting(raced);
				return;
			}
		}
		throw error;
	}
	const verify = await store.getSetting(address, { signal: input.signal });
	if (!verify || verify.revision !== 1) return fail();
	openProviderSetting(verify);
	publishQuotaSettings(provider, verify);
}
