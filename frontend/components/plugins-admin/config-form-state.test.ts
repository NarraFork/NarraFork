import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	PluginProviderConfigService,
	SECRET_PLACEHOLDER as SERVER_SECRET_PLACEHOLDER,
} from "@server/services/plugin-provider-config-service";
import { PluginProviderRegistry } from "@server/services/plugin-provider-registry";
import { PluginSecretVault } from "@server/services/plugin-secret-vault";
import { PluginStateStore } from "@server/services/plugin-state-store";
import {
	buildConfigPayload,
	type ConfigViewInput,
	draftFromView,
	isDraftDirty,
	SECRET_PLACEHOLDER,
	secretDisplayValue,
	setFieldValue,
	setRawText,
	setSecretValue,
} from "./config-form-state";
import { buildConfigFormModel, type ConfigField, type JsonValue } from "./config-schema";

/**
 * The dangerous case here is the secret three-way: keep / replace / clear. Treating an
 * empty masked field as "clear" when the user merely did not touch it destroys a working
 * credential, and treating a genuine clear as "keep" leaves a secret the user asked to
 * remove. These tests pin the distinction and check the wire format against the real
 * server service rather than a restatement of it.
 */

const schema = {
	type: "object",
	properties: {
		apiMode: { type: "string", enum: ["balanced", "fast"] },
		apiKey: { type: "string", format: "password" },
		retries: { type: "integer", minimum: 0, maximum: 5, default: 2 },
		extra: { type: "object", properties: { deep: { type: "string" } } },
	},
} as const;

function fields(): ConfigField[] {
	return buildConfigFormModel(schema as never).fields;
}

function view(overrides: Partial<ConfigViewInput> = {}): ConfigViewInput {
	return {
		config: {},
		secretFields: ["apiKey"],
		secretsSet: [],
		...overrides,
	};
}

describe("plugin config draft seeding", () => {
	test("keeps the stored value and only applies a default when absent", () => {
		const seeded = draftFromView(fields(), view({ config: { retries: 5 } }));
		expect(seeded.values.retries).toBe(5);

		const empty = draftFromView(fields(), view());
		// The schema default fills an unset field, so the form matches what the server
		// would use, but never overwrites an explicit choice.
		expect(empty.values.retries).toBe(2);
	});

	test("never seeds a secret field into the draft", () => {
		const seeded = draftFromView(
			fields(),
			view({ config: { apiKey: SECRET_PLACEHOLDER }, secretsSet: ["apiKey"] }),
		);
		expect(seeded.values.apiKey).toBeUndefined();
		expect(seeded.secretValues.apiKey).toBeUndefined();
	});

	test("routes an unsupported field into the raw JSON editor", () => {
		const seeded = draftFromView(fields(), view({ config: { extra: { deep: "x" } } }));
		expect(seeded.values.extra).toBeUndefined();
		expect(JSON.parse(seeded.rawText.extra)).toEqual({ deep: "x" });
	});
});

describe("plugin config secret intents", () => {
	test("shows a placeholder for a stored secret and nothing for an unset one", () => {
		const [apiKey] = fields().filter((field) => field.name === "apiKey");
		const stored = view({ secretsSet: ["apiKey"] });
		expect(secretDisplayValue(apiKey, draftFromView(fields(), stored), stored)).toBe(
			SECRET_PLACEHOLDER,
		);
		const unset = view();
		expect(secretDisplayValue(apiKey, draftFromView(fields(), unset), unset)).toBe("");
	});

	test("an untouched masked field keeps the stored secret", () => {
		const current = view({ secretsSet: ["apiKey"] });
		const draft = draftFromView(fields(), current);
		const result = buildConfigPayload(fields(), draft, current);
		// The placeholder is the documented "keep it" signal.
		expect(result.payload?.apiKey).toBe(SECRET_PLACEHOLDER);
		expect(isDraftDirty(fields(), draft, current)).toBe(false);
	});

	test("re-typing the placeholder is still treated as keep, not replace", () => {
		const current = view({ secretsSet: ["apiKey"] });
		const draft = setSecretValue(draftFromView(fields(), current), "apiKey", SECRET_PLACEHOLDER);
		expect(draft.secretIntents.apiKey).toBe("keep");
		expect(buildConfigPayload(fields(), draft, current).payload?.apiKey).toBe(SECRET_PLACEHOLDER);
	});

	test("a new value replaces the secret", () => {
		const current = view({ secretsSet: ["apiKey"] });
		const draft = setSecretValue(draftFromView(fields(), current), "apiKey", "sk-new");
		expect(draft.secretIntents.apiKey).toBe("replace");
		expect(buildConfigPayload(fields(), draft, current).payload?.apiKey).toBe("sk-new");
		expect(isDraftDirty(fields(), draft, current)).toBe(true);
	});

	test("emptying the field clears the secret", () => {
		const current = view({ secretsSet: ["apiKey"] });
		const draft = setSecretValue(draftFromView(fields(), current), "apiKey", "");
		expect(draft.secretIntents.apiKey).toBe("clear");
		// Empty string is the delete signal the config service documents.
		expect(buildConfigPayload(fields(), draft, current).payload?.apiKey).toBe("");
		expect(isDraftDirty(fields(), draft, current)).toBe(true);
	});

	test("omits the placeholder when no secret is stored", () => {
		const current = view();
		const result = buildConfigPayload(fields(), draftFromView(fields(), current), current);
		// Asking the server to keep a secret that does not exist is meaningless.
		expect("apiKey" in (result.payload ?? {})).toBe(false);
	});

	test("uses the same placeholder constant as the server", () => {
		expect(SECRET_PLACEHOLDER).toBe(SERVER_SECRET_PLACEHOLDER);
	});
});

describe("plugin config dirty tracking", () => {
	test("a freshly seeded draft is clean even when a default filled a field", () => {
		const current = view();
		const draft = draftFromView(fields(), current);
		// `retries` shows its schema default of 2 with nothing stored. Reporting that as
		// dirty would make the Save button always look active.
		expect(draft.values.retries).toBe(2);
		expect(isDraftDirty(fields(), draft, current)).toBe(false);
	});

	test("editing away from the default is dirty", () => {
		const current = view();
		const draft = setFieldValue(draftFromView(fields(), current), "retries", 4);
		expect(isDraftDirty(fields(), draft, current)).toBe(true);
	});

	test("editing a raw JSON field is dirty", () => {
		const current = view({ config: { extra: { deep: "x" } } });
		const draft = setRawText(draftFromView(fields(), current), "extra", '{"deep":"y"}');
		expect(isDraftDirty(fields(), draft, current)).toBe(true);
	});

	test("reformatting raw JSON without changing it is not dirty", () => {
		const current = view({ config: { extra: { deep: "x" } } });
		const draft = setRawText(
			draftFromView(fields(), current),
			"extra",
			`  ${JSON.stringify({ deep: "x" }, null, 2)}  `,
		);
		expect(isDraftDirty(fields(), draft, current)).toBe(false);
	});
});

describe("plugin config payload assembly", () => {
	test("omits absent optional values instead of sending null", () => {
		const current = view();
		const draft = setFieldValue(draftFromView(fields(), current), "apiMode", "fast");
		const result = buildConfigPayload(fields(), draft, current);
		expect(result.payload).toEqual({ apiMode: "fast", retries: 2 });
	});

	test("blocks malformed JSON in a raw field", () => {
		const current = view();
		const draft = setRawText(draftFromView(fields(), current), "extra", "{oops");
		const result = buildConfigPayload(fields(), draft, current);
		expect(result.payload).toBeUndefined();
		expect(result.issues.map((issue) => issue.name)).toContain("extra");
	});

	test("reports an advisory issue for an out-of-range value", () => {
		const current = view();
		const draft = setFieldValue(draftFromView(fields(), current), "retries", 99);
		const result = buildConfigPayload(fields(), draft, current);
		expect(result.payload).toBeUndefined();
		expect(result.issues[0]?.name).toBe("retries");
	});

	test("sends a const field verbatim regardless of edits", () => {
		const constFields = buildConfigFormModel({
			type: "object",
			properties: { version: { const: 1 } },
		}).fields;
		const current = view({ secretFields: [] });
		const draft = setRawText(draftFromView(constFields, current), "version", "999");
		expect(buildConfigPayload(constFields, draft, current).payload).toEqual({ version: 1 });
	});
});

describe("plugin config payload is accepted by the real server service", () => {
	async function withService(
		run: (input: {
			service: PluginProviderConfigService;
			vault: PluginSecretVault;
			pluginId: string;
			instanceId: string;
		}) => Promise<void>,
	) {
		const root = await mkdtemp(join(tmpdir(), "nf-config-form-"));
		try {
			const pluginId = "com.example.form";
			const instanceId = "com.example.form/demo@1.0.0:hash";
			const registry = new PluginProviderRegistry();
			registry.register({
				kind: "executable-plugin",
				pluginId,
				localId: "demo",
				providerInstanceId: instanceId,
				providerPrefix: "demo",
				displayName: "Demo",
				capabilities: { chat: true },
				configSchema: schema as never,
			});
			const vault = new PluginSecretVault({ root });
			const service = new PluginProviderConfigService({
				registry,
				stateStore: new PluginStateStore({ root }),
				secretStore: vault,
			});
			await run({ service, vault, pluginId, instanceId });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}

	test("a form-built payload round-trips through update()", async () => {
		await withService(async ({ service, vault, pluginId, instanceId }) => {
			const current = view();
			let draft = draftFromView(fields(), current);
			draft = setFieldValue(draft, "apiMode", "fast");
			draft = setSecretValue(draft, "apiKey", "sk-from-form");
			const built = buildConfigPayload(fields(), draft, current);
			expect(built.payload).toBeDefined();

			const updated = await service.update(
				pluginId,
				instanceId,
				built.payload as Record<string, JsonValue>,
			);

			expect(updated.config.apiMode).toBe("fast");
			expect(updated.secretsSet).toEqual(["apiKey"]);
			// The secret reached the vault, and the view never carries its value.
			expect(await vault.getSecret({ pluginId, key: "provider.demo.apiKey" })).toBe("sk-from-form");
			expect(JSON.stringify(updated.config)).not.toContain("sk-from-form");
		});
	});

	test("keep preserves the stored secret across a second save", async () => {
		await withService(async ({ service, vault, pluginId, instanceId }) => {
			await service.update(pluginId, instanceId, { apiMode: "fast", apiKey: "sk-original" });

			// Reload as the UI would, then change only a non-secret field.
			const [reloaded] = await service.list(pluginId);
			const current: ConfigViewInput = {
				config: reloaded.config,
				secretFields: reloaded.secretFields,
				secretsSet: reloaded.secretsSet,
			};
			let draft = draftFromView(fields(), current);
			draft = setFieldValue(draft, "apiMode", "balanced");
			const built = buildConfigPayload(fields(), draft, current);

			const updated = await service.update(
				pluginId,
				instanceId,
				built.payload as Record<string, JsonValue>,
			);
			expect(updated.config.apiMode).toBe("balanced");
			expect(await vault.getSecret({ pluginId, key: "provider.demo.apiKey" })).toBe("sk-original");
		});
	});

	test("clear removes the stored secret", async () => {
		await withService(async ({ service, vault, pluginId, instanceId }) => {
			await service.update(pluginId, instanceId, { apiMode: "fast", apiKey: "sk-original" });
			const [reloaded] = await service.list(pluginId);
			const current: ConfigViewInput = {
				config: reloaded.config,
				secretFields: reloaded.secretFields,
				secretsSet: reloaded.secretsSet,
			};
			const draft = setSecretValue(draftFromView(fields(), current), "apiKey", "");
			const built = buildConfigPayload(fields(), draft, current);

			const updated = await service.update(
				pluginId,
				instanceId,
				built.payload as Record<string, JsonValue>,
			);
			expect(updated.secretsSet).toEqual([]);
			expect(await vault.hasSecret({ pluginId, key: "provider.demo.apiKey" })).toBe(false);
		});
	});
});
