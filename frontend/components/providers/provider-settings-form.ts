import type { ProviderSettingsContribution } from "@shared/provider-settings";
import { providerSettingsFieldVisibility } from "@shared/provider-settings";
import type {
	ProviderSettingsConfigView,
	ProviderSettingsSave,
	ProviderSettingsSecretEdit,
	ProviderSettingsValue,
} from "@shared/provider-settings-values";
import type { ConfigViewInput } from "../plugins-admin/config-form-state";
import { SECRET_PLACEHOLDER } from "../plugins-admin/config-form-state";
import type { JsonValue, SchemaNode } from "../plugins-admin/config-schema";

export interface ProviderSettingsCaptions {
	title?: string;
	description?: string;
}

export type ProviderSettingsLocale = "en" | "zh-CN";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function localizedCaptions(
	base: ProviderSettingsCaptions,
	translations: unknown,
	locale: ProviderSettingsLocale,
): ProviderSettingsCaptions {
	if (!isRecord(translations)) return base;
	const preferred = translations[locale];
	const fallback = translations.en;
	const selected = isRecord(preferred) ? preferred : isRecord(fallback) ? fallback : undefined;
	if (!selected) return base;
	return {
		title: typeof selected.title === "string" ? selected.title : base.title,
		description: typeof selected.description === "string" ? selected.description : base.description,
	};
}

/** Apply manifest i18n captions without changing the persisted schema contract. */
export function localizeProviderSettingsSchema(
	declaration: ProviderSettingsContribution,
	locale: ProviderSettingsLocale,
): SchemaNode {
	const schema = declaration.configSchema as unknown as Record<string, unknown>;
	const properties = isRecord(schema.properties) ? schema.properties : {};
	const localizedProperties = Object.fromEntries(
		Object.entries(properties).map(([name, rawField]) => {
			if (!isRecord(rawField)) return [name, rawField];
			// The host view already initializes defaults. Do not refill intentionally absent saved fields.
			const { default: _default, ...fieldWithoutDefault } = rawField;
			const captions = localizedCaptions(
				{
					title: typeof rawField.title === "string" ? rawField.title : undefined,
					description: typeof rawField.description === "string" ? rawField.description : undefined,
				},
				rawField["x-narrafork-i18n"],
				locale,
			);
			return [
				name,
				{
					...fieldWithoutDefault,
					...(captions.title ? { title: captions.title } : {}),
					...(captions.description ? { description: captions.description } : {}),
				},
			];
		}),
	);
	return { ...schema, properties: localizedProperties } as SchemaNode;
}

export function localizedContributionCaptions(
	declaration: ProviderSettingsContribution,
	locale: ProviderSettingsLocale,
): ProviderSettingsCaptions {
	return localizedCaptions(
		{ title: declaration.title, description: declaration.description },
		declaration.i18n,
		locale,
	);
}

export function providerSettingsSecretFields(declaration: ProviderSettingsContribution): string[] {
	return Object.entries(declaration.configSchema.properties)
		.filter(([, field]) => providerSettingsFieldVisibility(field) === "secret")
		.map(([name]) => name);
}

/** Adapt the host's scalar/secret view to the existing plugin form without exposing secrets. */
export function providerSettingsConfigViewForForm(
	declaration: ProviderSettingsContribution,
	config: ProviderSettingsConfigView,
): ConfigViewInput {
	const secretFields = providerSettingsSecretFields(declaration);
	const values: Record<string, JsonValue> = { ...config.values };
	const secretsSet: string[] = [];
	for (const name of secretFields) {
		if (config.secrets[name]?.isSet) {
			values[name] = SECRET_PLACEHOLDER;
			secretsSet.push(name);
		}
	}
	return { config: values, secretFields, secretsSet };
}

function scalar(value: JsonValue | undefined): ProviderSettingsValue | undefined {
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
		return value;
	return undefined;
}

/** Convert the plugin form's placeholder/empty-string contract to provider-settings edits. */
export function buildProviderSettingsSave(
	declaration: ProviderSettingsContribution,
	config: ProviderSettingsConfigView,
	submitted: Record<string, JsonValue>,
): ProviderSettingsSave {
	const secretFields = new Set(providerSettingsSecretFields(declaration));
	const values: Record<string, ProviderSettingsValue> = {};
	const secrets: Record<string, ProviderSettingsSecretEdit> = {};

	for (const [name, value] of Object.entries(submitted)) {
		if (secretFields.has(name)) {
			if (value === SECRET_PLACEHOLDER) {
				if (config.secrets[name]?.isSet) secrets[name] = { operation: "keep" };
				continue;
			}
			if (value === "") {
				secrets[name] = { operation: "clear" };
				continue;
			}
			if (typeof value === "string" && value.length > 0) {
				secrets[name] = { operation: "set", value };
			}
			continue;
		}
		const next = scalar(value);
		if (next !== undefined) values[name] = next;
	}

	return {
		schemaVersion: 1,
		schemaFingerprint: config.schemaFingerprint,
		expectedRevision: config.revision,
		expectedBindingRevision: config.bindingRevision,
		values,
		secrets,
	};
}

export function providerSettingsLocale(language: string | undefined): ProviderSettingsLocale {
	return language?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function formatProviderSettingsValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
