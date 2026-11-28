import { createHash } from "node:crypto";
import { AppError } from "@server/lib/errors";
import { getProviderKeyStore } from "@server/lib/provider-keys";
import { openSecretRecord, sealSecretRecord } from "@server/lib/secret-store";
import {
	type CustomApiProviderConfig,
	type NarraForkSettings,
	saveSettings,
	settings,
} from "@server/lib/settings";
import { quotaKeyOwner } from "@server/lib/settings/provider-keys-projection";
import { PROVIDER_QUOTA_BUILTIN_ID } from "./builtin-plugin-catalog";
import type {
	PluginResourceAddress,
	PluginResourceRecord,
	PluginSettingsStore,
} from "./plugin-settings-store";
import { getPluginSettingsStore } from "./plugin-settings-store-provider";
import {
	LEGACY_QUOTA_SETTINGS_DECLARATION,
	QUOTA_SETTINGS_CONTRIBUTION_ID,
} from "./provider-quota-settings-compat";
import {
	blockQuotaSettings,
	projectQuotaSettings,
	publishQuotaSettings,
	quotaSettingsRowSnapshot,
	quotaSettingsSnapshot,
} from "./provider-quota-settings-projection";
import { hasSiteQuotaConfig } from "./provider-quota-sites";
import {
	normalizeProviderSettingsRoot,
	type ProviderSettingsConfigContext,
	ProviderSettingsConfigPolicy,
} from "./provider-settings-config-policy";
import {
	readProviderSettingsCoreContext,
	settingsConfigContext,
} from "./provider-settings-context";
import { openProviderSetting, ProviderSettingsData } from "./provider-settings-data";

const KEY = "quota-settings-compat-save-v1";
const inFlight = new Set<string>();
export function assertQuotaCompatibilityIdle(id: string): void {
	if (inFlight.has(id)) pendingError();
}
function operationAddress(id: string): PluginResourceAddress {
	return {
		pluginId: PROVIDER_QUOTA_BUILTIN_ID,
		ownerKind: "host-operation",
		scopeType: "provider",
		scopeId: JSON.stringify(["custom-api", id]),
		key: KEY,
	};
}
const address = (id: string) => ({
	pluginId: PROVIDER_QUOTA_BUILTIN_ID,
	contributionId: QUOTA_SETTINGS_CONTRIBUTION_ID,
	targetKind: "custom-api" as const,
	targetId: id,
});
function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function inputOf(provider: CustomApiProviderConfig) {
	return {
		baseUrl: provider.baseUrl,
		apiKey: provider.apiKey,
		protocol: provider.protocol,
		quotaSiteUrl: provider.quotaSiteUrl ?? "",
		quotaUserId: provider.quotaUserId ?? "",
		quotaAccessToken: provider.quotaAccessToken ?? "",
		codexAccountId: provider.codexAccountId,
		proxy: provider.proxy,
		tlsRejectUnauthorized: provider.tlsRejectUnauthorized,
	};
}
function coreInput(provider: ReturnType<typeof inputOf>) {
	const { quotaSiteUrl: _site, quotaUserId: _user, quotaAccessToken: _token, ...core } = provider;
	return core;
}
function currentInput(id: string) {
	const p = settings.customApiProviders?.find((p) => p.id === id);
	if (!p) return undefined;
	const store = getProviderKeyStore();
	if (!store.readable)
		throw new AppError(
			"Existing provider credentials are unreadable",
			409,
			"PROVIDER_SETTINGS_MIGRATION_REQUIRED",
		);
	return inputOf({
		...p,
		quotaAccessToken: store.list(quotaKeyOwner(id))[0]?.apiKey ?? p.quotaAccessToken,
	});
}
function pendingError(): never {
	throw new AppError(
		"Provider settings save is incomplete; repeat the same save to recover",
		409,
		"PROVIDER_SETTINGS_SAVE_PENDING",
	);
}
function conflict(): never {
	throw new AppError(
		"Provider settings revision changed",
		409,
		"PROVIDER_SETTINGS_REVISION_CONFLICT",
	);
}
type TokenIntent =
	| { operation: "keep" }
	| { operation: "clear" }
	| { operation: "set"; value: string };
/** Capture BEFORE legacy masking/omitted-field restoration mutates the request. */
export function quotaCompatibilityTokenIntents(
	providers: readonly { id: string; quotaAccessToken?: string }[] = [],
): ReadonlyMap<string, TokenIntent> {
	return new Map<string, TokenIntent>(
		providers.map((provider) => {
			const token = provider.quotaAccessToken;
			return [
				provider.id,
				token === undefined || token.startsWith("*")
					? { operation: "keep" }
					: token === ""
						? { operation: "clear" }
						: { operation: "set", value: token },
			];
		}),
	);
}
interface Journal {
	version: 1 | 2;
	providerId: string;
	installationId: string;
	expectedSettingsRevision: number;
	before: string;
	after: string;
	next: ReturnType<typeof inputOf>;
	previous: ReturnType<typeof inputOf>;
	tokenIntent?: TokenIntent;
}
function envelope(journal: Journal, target: PluginResourceAddress): string {
	const payload = Buffer.from(JSON.stringify(journal));
	try {
		return sealSecretRecord(payload, JSON.stringify(target));
	} finally {
		payload.fill(0);
	}
}
function saveInput(journal: Journal, context: ProviderSettingsConfigContext) {
	const policy = new ProviderSettingsConfigPolicy(LEGACY_QUOTA_SETTINGS_DECLARATION),
		view = policy.view(context),
		enabled = hasSiteQuotaConfig(journal.next);
	return {
		schemaVersion: 1,
		schemaFingerprint: view.schemaFingerprint,
		expectedRevision: journal.expectedSettingsRevision,
		expectedBindingRevision: view.bindingRevision,
		values: {
			useSiteAccount: enabled,
			// Legacy suffix stripping belongs only to the initial migration. SQL roots are exact.
			...(enabled
				? {
						siteUrl: normalizeProviderSettingsRoot(
							journal.next.quotaSiteUrl.trim() || journal.next.baseUrl,
						),
					}
				: {}),
			...(journal.next.quotaUserId.trim() ? { userId: journal.next.quotaUserId.trim() } : {}),
		},
		secrets:
			journal.tokenIntent && journal.tokenIntent.operation !== "keep"
				? { token: journal.tokenIntent }
				: {},
	};
}
/** Populate legacy HTTP response/patch baseline from SQL, never the other way around. */
export async function projectQuotaSettingsInto(
	source: NarraForkSettings,
	repairFiles = false,
): Promise<void> {
	const store = await getPluginSettingsStore();
	for (const provider of source.customApiProviders ?? []) {
		const original = settings.customApiProviders?.find((p) => p.id === provider.id);
		await recoverQuotaCompatibilitySave(provider.id, store, repairFiles);
		// Admin recovery may have repaired core files after the caller cloned its baseline.
		if (repairFiles) {
			const saved = settings.customApiProviders?.find((p) => p.id === provider.id);
			if (saved && saved !== original) Object.assign(provider, saved);
		}
		const row = await store.getSetting(address(provider.id));
		if (!row) continue;
		if (row.state !== "deleted") openProviderSetting(row);
		publishQuotaSettings(provider, row);
		Object.assign(provider, projectQuotaSettings(provider));
	}
}
/** Reserve the original projection before any await; both APIs recheck this reservation at SQL commit. */
export async function beginQuotaCompatibilitySave(
	before: NarraForkSettings,
	next: NarraForkSettings,
	tokenIntents: ReadonlyMap<string, TokenIntent> = new Map(),
): Promise<(() => Promise<void>) & { abort: () => void }> {
	const ids: string[] = [],
		journalIds: string[] = [];
	let held = true;
	const abort = () => {
		if (!held) return;
		held = false;
		for (const id of ids) inFlight.delete(id);
	};
	let store: PluginSettingsStore;
	try {
		for (const id of new Set(
			[...(before.customApiProviders ?? []), ...(next.customApiProviders ?? [])].map((p) => p.id),
		)) {
			assertQuotaCompatibilityIdle(id);
			inFlight.add(id);
			ids.push(id);
		}
		store = await getPluginSettingsStore();
		for (const provider of next.customApiProviders ?? []) {
			const previous = before.customApiProviders?.find((p) => p.id === provider.id);
			await recover(provider.id, store);
			const row = await store.getSetting(address(provider.id));
			if (!row) {
				if (previous && quotaSettingsSnapshot(previous)) conflict();
				continue;
			}
			if (row.state !== "active" && row.state !== "deleted") {
				const fields = ["quotaSiteUrl", "quotaUserId", "quotaAccessToken"] as const;
				if (!previous || fields.some((field) => previous[field] !== provider[field]))
					throw new AppError(
						"Retained quota settings need an explicit rebind",
						409,
						"PROVIDER_SETTINGS_REBIND_REQUIRED",
					);
				// A blocked projection hides secrets. Do not persist that redaction over retained backups.
				const saved = currentInput(provider.id);
				if (saved) for (const field of fields) provider[field] = saved[field];
				continue;
			}
			if (!previous || quotaSettingsSnapshot(previous) !== quotaSettingsRowSnapshot(row))
				conflict();
			if (row.state === "deleted" || digest(inputOf(previous)) === digest(inputOf(provider)))
				continue;
			const existing = openProviderSetting(row),
				current = currentInput(provider.id);
			if (!current || digest(coreInput(inputOf(previous))) !== digest(coreInput(current)))
				conflict();
			const tokenIntent = tokenIntents.get(provider.id) ?? { operation: "keep" as const };
			if (
				tokenIntent.operation === "keep" &&
				existing.secrets.token &&
				digest(coreInput(inputOf(previous))) !== digest(coreInput(inputOf(provider)))
			)
				throw new AppError(
					"Site credential needs an explicit rebind",
					409,
					"PROVIDER_SETTINGS_SECRET_REBIND_REQUIRED",
				);
			const journal: Journal = {
				version: 2,
				providerId: provider.id,
				installationId: row.installationId,
				expectedSettingsRevision: row.revision,
				before: digest(current),
				previous: current,
				after: digest(inputOf(provider)),
				next: inputOf(provider),
				tokenIntent,
			};
			const context = {
				...settingsConfigContext(
					PROVIDER_QUOTA_BUILTIN_ID,
					row.installationId,
					readProviderSettingsCoreContext("custom-api", provider.id),
				),
				providerRoot: normalizeProviderSettingsRoot(provider.baseUrl),
			};
			// Validate the complete request and all existing secret bindings BEFORE touching core files.
			new ProviderSettingsConfigPolicy(LEGACY_QUOTA_SETTINGS_DECLARATION).prepare(
				context,
				saveInput(journal, context),
				existing.config,
			);
			const expectedToken =
				tokenIntent.operation === "set"
					? tokenIntent.value
					: tokenIntent.operation === "clear"
						? ""
						: hasSiteQuotaConfig(journal.next)
							? (existing.secrets.token ?? "")
							: "";
			if (journal.next.quotaAccessToken !== expectedToken) conflict();
			const opAddress = operationAddress(provider.id),
				old = await store.getResource(opAddress);
			if (old?.state === "active") pendingError();
			await store.commit({
				resource: {
					address: opAddress,
					expectedRevision: old?.revision ?? 0,
					value: {
						installationId: row.installationId,
						bindingFingerprint: journal.after,
						state: "active",
						valueText: envelope(journal, opAddress),
					},
				},
			});
			journalIds.push(provider.id);
			blockQuotaSettings(provider.id);
		}
	} catch (error) {
		abort();
		throw error;
	}
	return Object.assign(
		async () => {
			if (!held) {
				for (const id of journalIds) await recoverQuotaCompatibilitySave(id, store);
				return;
			}
			try {
				for (const id of journalIds) await recover(id, store);
			} finally {
				abort();
			}
		},
		{ abort },
	);
}
/** Keep rejected/superseded credentials in a separate encrypted receipt before retiring the WAL. */
async function retire(
	store: PluginSettingsStore,
	operation: PluginResourceRecord,
	journal: Journal,
	reason?: "superseded" | "retained" | "legacy-intent-unknown",
): Promise<void> {
	const opAddress = operationAddress(journal.providerId);
	if (reason) {
		const archiveAddress = { ...opAddress, key: `${KEY}-retained-${operation.revision}` },
			archive = await store.getResource(archiveAddress),
			retained = { ...journal, terminalReason: reason };
		if (archive) {
			const plain = openSecretRecord(archive.valueText, JSON.stringify(archiveAddress));
			try {
				if (digest(JSON.parse(plain.toString("utf8"))) !== digest(retained)) pendingError();
			} finally {
				plain.fill(0);
			}
		} else
			await store.commit({
				resource: {
					address: archiveAddress,
					expectedRevision: 0,
					value: {
						installationId: operation.installationId,
						bindingFingerprint: journal.after,
						state: "active",
						valueText: envelope(retained, archiveAddress),
					},
				},
			});
	}
	await store.commit({
		resource: {
			address: opAddress,
			expectedRevision: operation.revision,
			value: {
				installationId: operation.installationId,
				bindingFingerprint: operation.bindingFingerprint,
				state: "deleted",
				valueText: "",
			},
		},
	});
}
/** Recovery shares the reservation with new API writes, including the final SQL transaction. */
export async function recoverQuotaCompatibilitySave(
	providerId: string,
	store?: PluginSettingsStore,
	repairFiles = false,
): Promise<void> {
	assertQuotaCompatibilityIdle(providerId);
	store ??= await getPluginSettingsStore();
	const operation = await store.getResource(operationAddress(providerId));
	assertQuotaCompatibilityIdle(providerId);
	if (!operation || operation.state === "deleted") return;
	inFlight.add(providerId);
	try {
		await recover(providerId, store, repairFiles);
	} finally {
		inFlight.delete(providerId);
	}
}
async function recover(
	providerId: string,
	store: PluginSettingsStore,
	repairFiles = false,
): Promise<void> {
	const opAddress = operationAddress(providerId),
		operation = await store.getResource(opAddress);
	if (!operation || operation.state === "deleted") return;
	blockQuotaSettings(providerId);
	const plain = openSecretRecord(operation.valueText, JSON.stringify(opAddress));
	let journal: Journal;
	try {
		journal = JSON.parse(plain.toString("utf8"));
	} finally {
		plain.fill(0);
	}
	if (
		(journal.version !== 1 && journal.version !== 2) ||
		journal.providerId !== providerId ||
		journal.after !== operation.bindingFingerprint
	)
		pendingError();
	const row = await store.getSetting(address(providerId));
	if (!row) return pendingError();
	if (row.state !== "deleted") openProviderSetting(row);
	const publish = () => {
		const provider = settings.customApiProviders?.find((p) => p.id === providerId);
		if (provider) publishQuotaSettings(provider, row);
	};
	if (
		row.revision > journal.expectedSettingsRevision ||
		row.state !== "active" ||
		row.installationId !== journal.installationId
	) {
		await retire(
			store,
			operation,
			journal,
			row.revision > journal.expectedSettingsRevision ? "superseded" : "retained",
		);
		publish();
		return;
	}
	if (row.revision !== journal.expectedSettingsRevision) return pendingError();
	let current = currentInput(providerId);
	if (!current) return pendingError();
	let fingerprint = digest(current);
	if (fingerprint === journal.before && fingerprint !== journal.after) {
		await retire(store, operation, journal);
		publish();
		return;
	}
	// Old journals never captured the caller's secret operation. Preserve the evidence, not an invented set.
	if (!journal.tokenIntent) {
		await retire(store, operation, journal, "legacy-intent-unknown");
		publish();
		return;
	}
	if (fingerprint !== journal.after) {
		if (
			!repairFiles ||
			!current ||
			!journal.previous ||
			Object.keys(journal.next).some((key) => {
				const k = key as keyof typeof current;
				return current?.[k] !== journal.previous[k] && current?.[k] !== journal.next[k];
			})
		)
			return pendingError();
		const next = structuredClone(settings),
			provider = next.customApiProviders?.find((p) => p.id === providerId);
		if (!provider) return pendingError();
		Object.assign(provider, journal.next);
		saveSettings(next);
		current = currentInput(providerId);
		if (!current) return pendingError();
		fingerprint = digest(current);
		if (fingerprint !== journal.after) return pendingError();
	}
	const context = settingsConfigContext(
		PROVIDER_QUOTA_BUILTIN_ID,
		journal.installationId,
		readProviderSettingsCoreContext("custom-api", providerId),
	);
	await new ProviderSettingsData(store).save(
		context,
		LEGACY_QUOTA_SETTINGS_DECLARATION,
		saveInput(journal, context),
		{
			receipt: {
				address: opAddress,
				expectedRevision: operation.revision,
				value: {
					installationId: operation.installationId,
					bindingFingerprint: operation.bindingFingerprint,
					state: "deleted",
					valueText: "",
				},
			},
			assertCurrent: () => {
				const current = currentInput(providerId);
				if (!current || digest(current) !== journal.after) pendingError();
			},
		},
	);
	const verified = await store.getSetting(address(providerId)),
		provider = settings.customApiProviders?.find((p) => p.id === providerId);
	if (!verified || !provider) return pendingError();
	openProviderSetting(verified);
	publishQuotaSettings(provider, verified);
}
