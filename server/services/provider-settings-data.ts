import { createHash } from "node:crypto";
import { AppError } from "@server/lib/errors";
import { openSecretRecord, sealSecretRecord, secretRecordKeyId } from "@server/lib/secret-store";
import { providerSettingsContributionSchema } from "@shared/provider-settings";
import {
	isBoundedProviderSettingsData,
	PROVIDER_SETTINGS_VALUE_LIMITS,
	type ProviderSettingsConfigView,
} from "@shared/provider-settings-values";
import {
	type PluginResourceMutation,
	type PluginSettingAddress,
	type PluginSettingMutation,
	type PluginSettingRecord,
	type PluginSettingsStore,
	type PluginStoreOperation,
	settingRowId,
} from "./plugin-settings-store";
import {
	type ProviderSettingsConfigContext,
	ProviderSettingsConfigPolicy,
	type ProviderSettingsStoredConfig,
	providerSettingsStoredConfigSchema,
} from "./provider-settings-config-policy";

function fail(): never {
	throw new AppError(
		"Provider settings data is unavailable",
		409,
		"PROVIDER_SETTINGS_DATA_UNAVAILABLE",
	);
}
export function providerSettingRecordBinding(
	row: Pick<
		PluginSettingRecord,
		"id" | "installationId" | "revision" | "schemaFingerprint" | "bindingFingerprint" | "configText"
	>,
): string {
	return JSON.stringify([
		"plugin-provider-settings.v1",
		row.id,
		row.installationId,
		row.revision,
		row.schemaFingerprint,
		row.bindingFingerprint,
		createHash("sha256").update(row.configText).digest("hex"),
	]);
}
interface OpenSetting {
	config: ProviderSettingsStoredConfig;
	secrets: Record<string, string>;
}
/** Host-private decrypt; it authenticates the record metadata before reading any secret. */
export function openProviderSetting(row: PluginSettingRecord): OpenSetting {
	if (row.state === "deleted") return fail();
	let raw: unknown;
	try {
		raw = JSON.parse(row.configText);
	} catch {
		return fail();
	}
	if (!isBoundedProviderSettingsData(raw, PROVIDER_SETTINGS_VALUE_LIMITS.requestBytes))
		return fail();
	const parsed = providerSettingsStoredConfigSchema.safeParse(raw);
	if (!parsed.success) return fail();
	const config = parsed.data;
	if (
		!config ||
		config.revision !== row.revision ||
		config.schemaVersion !== row.schemaVersion ||
		config.schemaFingerprint !== row.schemaFingerprint ||
		!config.secrets ||
		typeof config.secrets !== "object" ||
		Array.isArray(config.secrets)
	)
		return fail();
	let secrets: Record<string, string> = {};
	if (row.secretsEnvelope !== null) {
		const plain = openSecretRecord(row.secretsEnvelope, providerSettingRecordBinding(row));
		try {
			const values: unknown = JSON.parse(plain.toString("utf8"));
			if (
				!values ||
				typeof values !== "object" ||
				!isBoundedProviderSettingsData(values, PROVIDER_SETTINGS_VALUE_LIMITS.combinedBytes)
			)
				return fail();
			secrets = values as Record<string, string>;
		} finally {
			plain.fill(0);
		}
	}
	if (Object.keys(config.secrets).sort().join("\0") !== Object.keys(secrets).sort().join("\0"))
		return fail();
	for (const [key, value] of Object.entries(secrets)) {
		const metadata = config.secrets[key];
		if (
			typeof value !== "string" ||
			!metadata ||
			metadata.bytes !== Buffer.byteLength(value) ||
			metadata.characters !== [...value].length
		)
			return fail();
	}
	return { config, secrets };
}
/** No HTTP/RPC exposure. Caller supplies an already authorized, saved-target context. */
export class ProviderSettingsData {
	constructor(private readonly store: PluginSettingsStore) {}
	private resolve(
		context: ProviderSettingsConfigContext,
		declaration: unknown,
	): { address: PluginSettingAddress; policy: ProviderSettingsConfigPolicy } {
		const parsed = providerSettingsContributionSchema.safeParse(declaration);
		if (!parsed.success) return fail();
		const policy = new ProviderSettingsConfigPolicy(parsed.data);
		policy.view(context);
		if (!context.target) return fail();
		return {
			address: {
				pluginId: context.pluginId,
				contributionId: parsed.data.id,
				targetKind: context.target.kind,
				targetId: context.target.id,
			},
			policy,
		};
	}
	async read(
		context: ProviderSettingsConfigContext,
		declaration: unknown,
		options?: PluginStoreOperation,
	): Promise<ProviderSettingsConfigView> {
		const { address, policy } = this.resolve(context, declaration),
			row = await this.store.getSetting(address, options);
		if (!row) return policy.view(context);
		if (row.state === "deleted") return { ...policy.view(context), revision: row.revision };
		if (row.state === "blocked") return fail();
		const opened = openProviderSetting(row);
		if (row.installationId !== context.installationId || row.state === "dormant") {
			// The manager may inspect its own retained data. No plaintext secret is returned;
			// the persisted owner is untouched until a dedicated, confirmed rebind succeeds.
			const compatible =
				opened.config.schemaVersion === 1 &&
				opened.config.schemaFingerprint === policy.schemaFingerprint;
			return {
				...policy.view(context),
				revision: row.revision,
				status: compatible ? "dormant" : "schema-mismatch",
				values: compatible ? structuredClone(opened.config.values) : {},
				secrets: compatible
					? Object.fromEntries(
							Object.keys(opened.config.secrets).map((key) => [key, { isSet: true }]),
						)
					: {},
			};
		}
		return policy.view(context, opened.config);
	}
	async readPublic(
		context: ProviderSettingsConfigContext,
		declaration: unknown,
		options?: PluginStoreOperation,
	) {
		const { address, policy } = this.resolve(context, declaration),
			row = await this.store.getSetting(address, options);
		if (!row || row.state !== "active" || row.installationId !== context.installationId)
			return fail();
		return {
			revision: row.revision,
			values: policy.publicValues(context, openProviderSetting(row).config),
		};
	}
	/** Host-only snapshot for a signed operation; never send values/secrets together to a plugin. */
	async readBound(
		context: ProviderSettingsConfigContext,
		declaration: unknown,
		options?: PluginStoreOperation,
	) {
		const { address, policy } = this.resolve(context, declaration),
			row = await this.store.getSetting(address, options);
		if (!row || row.state !== "active" || row.installationId !== context.installationId)
			return fail();
		const opened = openProviderSetting(row),
			view = policy.view(context, opened.config);
		if (view.status !== "ready") return fail();
		return {
			revision: row.revision,
			bindingRevision: view.bindingRevision,
			publicValues: policy.publicValues(context, opened.config),
			values: opened.config.values,
			secrets: opened.secrets,
		};
	}
	async save(
		context: ProviderSettingsConfigContext,
		declaration: unknown,
		input: unknown,
		options: PluginStoreOperation & { receipt?: PluginResourceMutation } = {},
	): Promise<ProviderSettingsConfigView> {
		const { address, policy } = this.resolve(context, declaration),
			row = await this.store.getSetting(address, options);
		if (
			row &&
			row.state !== "deleted" &&
			(row.state === "blocked" ||
				row.state === "dormant" ||
				row.installationId !== context.installationId)
		)
			return fail();
		// Always decrypt an existing live row BEFORE accepting a replacement, even when all
		// secrets are being replaced. Unknown keys cannot be overwritten as an empty config.
		const existing = row && row.state !== "deleted" ? openProviderSetting(row) : undefined;
		let request = input;
		if (row?.state === "deleted") {
			// Explicit recreate is still compared against the durable tombstone's revision.
			if (
				!isBoundedProviderSettingsData(input, PROVIDER_SETTINGS_VALUE_LIMITS.requestBytes) ||
				(input as { expectedRevision?: unknown }).expectedRevision !== row.revision
			)
				throw new AppError(
					"Provider settings revision changed",
					409,
					"PROVIDER_SETTINGS_REVISION_CONFLICT",
				);
			request = { ...(input as Record<string, unknown>), expectedRevision: 0 };
		}
		const prepared = policy.prepare(context, request, existing?.config);
		const revision = (row?.revision ?? 0) + 1;
		prepared.config.revision = revision;
		const secrets = { ...existing?.secrets };
		for (const [key, edit] of Object.entries(prepared.secretWrites)) {
			if (edit.operation === "clear") delete secrets[key];
			else secrets[key] = edit.value;
		}
		const configText = JSON.stringify(prepared.config),
			bindingFingerprint = policy.view(context).bindingRevision;
		const identity = {
			id: settingRowId(address),
			installationId: context.installationId,
			revision,
			schemaFingerprint: policy.schemaFingerprint,
			bindingFingerprint,
			configText,
		};
		let secretsEnvelope: string | null = null,
			keyId: string | null = null;
		if (Object.keys(secrets).length) {
			const plain = Buffer.from(JSON.stringify(secrets));
			try {
				secretsEnvelope = sealSecretRecord(plain, providerSettingRecordBinding(identity));
				keyId = secretRecordKeyId(secretsEnvelope);
			} finally {
				plain.fill(0);
			}
		}
		const mutation: PluginSettingMutation = {
			address,
			expectedRevision: row?.revision ?? 0,
			value: {
				installationId: context.installationId,
				state: "active",
				schemaVersion: 1,
				schemaFingerprint: policy.schemaFingerprint,
				bindingFingerprint,
				configText,
				secretsEnvelope,
				keyId,
			},
		};
		const committed = await this.store.commit(
			{ setting: mutation, resource: options.receipt },
			options,
		);
		if (!committed.setting) return fail();
		return policy.view(context, prepared.config);
	}
	/** Explicit user deletion; a tombstone prevents stale create/migration from reviving it. */
	/** Explicit administrator consent to attach retained values to this saved target/installation.
	 * No grant mutation. Schema or target changes after confirmation fail without replacing data.
	 */
	async rebind(
		context: ProviderSettingsConfigContext,
		declaration: unknown,
		confirmation: {
			expectedRevision: number;
			schemaFingerprint: string;
			expectedBindingRevision: string;
			source?: { targetId: string; expectedRevision: number };
		},
		options?: PluginStoreOperation,
	): Promise<ProviderSettingsConfigView> {
		const { address, policy } = this.resolve(context, declaration);
		const sourceAddress = confirmation.source
			? { ...address, targetId: confirmation.source.targetId }
			: address;
		if (confirmation.source && sourceAddress.targetId === address.targetId) return fail();
		const row = await this.store.getSetting(sourceAddress, options);
		const destination = confirmation.source ? await this.store.getSetting(address, options) : row;
		if (
			!row ||
			row.state === "deleted" ||
			row.state === "blocked" ||
			(!confirmation.source &&
				row.state === "active" &&
				row.installationId === context.installationId) ||
			(confirmation.source && destination && destination.state !== "deleted")
		)
			return fail();
		if (
			(destination?.revision ?? 0) !== confirmation.expectedRevision ||
			(confirmation.source && row.revision !== confirmation.source.expectedRevision)
		)
			throw new AppError(
				"Provider settings revision changed",
				409,
				"PROVIDER_SETTINGS_REVISION_CONFLICT",
			);
		const previous = openProviderSetting(row);
		if (
			previous.config.schemaVersion !== 1 ||
			previous.config.schemaFingerprint !== policy.schemaFingerprint ||
			confirmation.schemaFingerprint !== policy.schemaFingerprint
		)
			throw new AppError(
				"Provider settings schema changed",
				409,
				"PROVIDER_SETTINGS_SCHEMA_CHANGED",
			);
		const view = policy.view(context);
		if (view.bindingRevision !== confirmation.expectedBindingRevision)
			throw new AppError("Saved provider changed", 409, "PROVIDER_SETTINGS_BINDING_CHANGED");
		const prepared = policy.prepare(context, {
			schemaVersion: 1,
			schemaFingerprint: policy.schemaFingerprint,
			expectedRevision: 0,
			expectedBindingRevision: confirmation.expectedBindingRevision,
			values: previous.config.values,
			secrets: Object.fromEntries(
				Object.entries(previous.secrets).map(([key, value]) => [key, { operation: "set", value }]),
			),
		});
		prepared.config.revision = (destination?.revision ?? 0) + 1;
		const configText = JSON.stringify(prepared.config),
			identity = {
				id: settingRowId(address),
				installationId: context.installationId,
				revision: prepared.config.revision,
				schemaFingerprint: policy.schemaFingerprint,
				bindingFingerprint: view.bindingRevision,
				configText,
			};
		let secretsEnvelope: string | null = null,
			keyId: string | null = null;
		if (Object.keys(previous.secrets).length) {
			const plain = Buffer.from(JSON.stringify(previous.secrets));
			try {
				secretsEnvelope = sealSecretRecord(plain, providerSettingRecordBinding(identity));
				keyId = secretRecordKeyId(secretsEnvelope);
			} finally {
				plain.fill(0);
			}
		}
		await this.store.commit(
			{
				...(confirmation.source
					? {
							retiredSetting: {
								address: sourceAddress,
								expectedRevision: row.revision,
								value: {
									installationId: row.installationId,
									state: "deleted" as const,
									schemaVersion: row.schemaVersion,
									schemaFingerprint: row.schemaFingerprint,
									bindingFingerprint: row.bindingFingerprint,
									configText: "",
									secretsEnvelope: null,
									keyId: null,
								},
							},
						}
					: {}),
				setting: {
					address,
					expectedRevision: destination?.revision ?? 0,
					value: {
						installationId: context.installationId,
						state: "active",
						schemaVersion: 1,
						schemaFingerprint: policy.schemaFingerprint,
						bindingFingerprint: view.bindingRevision,
						configText,
						secretsEnvelope,
						keyId,
					},
				},
			},
			options,
		);
		return policy.view(context, prepared.config);
	}
	async remove(
		context: ProviderSettingsConfigContext,
		declaration: unknown,
		expectedRevision: number,
		options?: PluginStoreOperation,
	): Promise<void> {
		const { address, policy } = this.resolve(context, declaration),
			row = await this.store.getSetting(address, options);
		if ((row?.revision ?? 0) !== expectedRevision)
			throw new AppError(
				"Provider settings revision changed",
				409,
				"PROVIDER_SETTINGS_REVISION_CONFLICT",
			);
		await this.store.commit(
			{
				setting: {
					address,
					expectedRevision,
					value: {
						installationId: row?.installationId ?? context.installationId,
						state: "deleted",
						schemaVersion: row?.schemaVersion ?? 1,
						schemaFingerprint: row?.schemaFingerprint ?? policy.schemaFingerprint,
						bindingFingerprint: row?.bindingFingerprint ?? policy.view(context).bindingRevision,
						configText: "",
						secretsEnvelope: null,
						keyId: null,
					},
				},
			},
			options,
		);
	}
}
