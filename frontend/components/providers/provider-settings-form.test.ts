import { describe, expect, test } from "bun:test";
import type { ProviderSettingsContribution } from "@shared/provider-settings";
import type { ProviderSettingsConfigView } from "@shared/provider-settings-values";
import { SECRET_PLACEHOLDER, setSecretValue } from "../plugins-admin/config-form-state";
import {
	buildProviderSettingsSave,
	localizeProviderSettingsSchema,
	providerSettingsConfigViewForForm,
} from "./provider-settings-form";

const declaration = {
	id: "quota",
	schemaVersion: 1,
	title: "Quota",
	targetKinds: ["custom-api"],
	configSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			baseUrl: {
				type: "string",
				format: "uri",
				title: "Base URL",
				"x-narrafork-i18n": { "zh-CN": { title: "基础地址" } },
			},
			apiKey: { type: "string", writeOnly: true, "x-narrafork-secret": true, title: "API key" },
			enabled: { type: "boolean", title: "Enabled" },
		},
	},
} satisfies ProviderSettingsContribution;

const config: ProviderSettingsConfigView = {
	schemaVersion: 1,
	schemaFingerprint: "a".repeat(64),
	revision: 4,
	bindingRevision: "b".repeat(64),
	status: "ready",
	values: { baseUrl: "https://example.test", enabled: true },
	secrets: { apiKey: { isSet: true } },
};

describe("provider settings form adapter", () => {
	test("keeps masked secrets and sends complete scalar replacement", () => {
		const view = providerSettingsConfigViewForForm(declaration, config);
		const payload = buildProviderSettingsSave(declaration, config, {
			baseUrl: "https://changed.test",
			apiKey: SECRET_PLACEHOLDER,
			enabled: false,
		});
		expect(view.config.apiKey).toBe(SECRET_PLACEHOLDER);
		expect(payload.values).toEqual({ baseUrl: "https://changed.test", enabled: false });
		expect(payload.secrets).toEqual({ apiKey: { operation: "keep" } });
		expect(payload.expectedRevision).toBe(4);
		expect(payload.expectedBindingRevision).toBe("b".repeat(64));
	});

	test("clears a secret explicitly instead of sending the placeholder", () => {
		const payload = buildProviderSettingsSave(declaration, config, {
			baseUrl: "https://example.test",
			apiKey: "",
			enabled: true,
		});
		expect(payload.secrets).toEqual({ apiKey: { operation: "clear" } });
	});

	test("localizes schema captions without changing field names", () => {
		const schema = localizeProviderSettingsSchema(declaration, "zh-CN") as Record<string, unknown>;
		const properties = schema.properties as Record<string, Record<string, unknown>>;
		expect(properties.baseUrl.title).toBe("基础地址");
		expect(Object.keys(properties)).toEqual(["baseUrl", "apiKey", "enabled"]);
	});

	test("keeps secret intent isolated from ordinary values", () => {
		const draft = setSecretValue(
			{ values: {}, rawText: {}, secretIntents: {}, secretValues: {} },
			"apiKey",
			"new-secret",
		);
		expect(draft.values).toEqual({});
		expect(draft.secretValues.apiKey).toBe("new-secret");
	});
});

test("the generic form cannot reinsert a default into a saved absent extension field", () => {
	const withDefault = {
		...declaration,
		configSchema: {
			...declaration.configSchema,
			properties: {
				...declaration.configSchema.properties,
				enabled: { type: "boolean" as const, default: true },
			},
		},
	};
	const schema = localizeProviderSettingsSchema(withDefault, "en") as {
		properties: Record<string, Record<string, unknown>>;
	};
	expect(schema.properties.enabled).not.toHaveProperty("default");
	const view = providerSettingsConfigViewForForm(withDefault, { ...config, values: {} });
	expect(view.config).not.toHaveProperty("enabled");
});
