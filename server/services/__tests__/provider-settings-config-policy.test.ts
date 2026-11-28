import { describe, expect, test } from "bun:test";
import { AppError } from "@server/lib/errors";
import {
	normalizeProviderSettingsRoot,
	type ProviderSettingsConfigContext,
	ProviderSettingsConfigPolicy,
	type ProviderSettingsStoredConfig,
} from "../provider-settings-config-policy";

function declaration() {
	return {
		id: "preferences",
		schemaVersion: 1,
		title: "Account preferences",
		targetKinds: ["custom-api", "nug"],
		configSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				compact: { type: "boolean", default: false },
				weight: { type: "integer", minimum: 0, maximum: 10, default: 2 },
				label: { type: "string", maxLength: 30 },
				site: { type: "string", format: "uri" },
				account: { type: "string", "x-narrafork-host-only": true },
				token: { type: "string", writeOnly: true, minLength: 3 },
			},
		},
		connections: [
			{
				id: "account",
				method: "GET",
				path: "/api/user/self",
				destination: "extension",
				baseUrlField: "site",
				whenUrlMissing: "provider-root",
				auth: { kind: "bearer", secretField: "token" },
				headers: [{ name: "new-api-user", field: "account" }],
			},
		],
	};
}
function context(): ProviderSettingsConfigContext {
	return {
		pluginId: "com.example.settings",
		installationId: "installation-1",
		target: { kind: "custom-api", id: "provider-1" },
		identityRevision: "account-binding-1",
		providerRoot: "https://provider.invalid/tenant",
	};
}
function input(
	policy: ProviderSettingsConfigPolicy,
	ctx = context(),
	previous?: ProviderSettingsStoredConfig,
	patch: Record<string, unknown> = {},
) {
	const view = policy.view(ctx, previous);
	return {
		schemaVersion: 1,
		schemaFingerprint: view.schemaFingerprint,
		expectedRevision: view.revision,
		expectedBindingRevision: view.bindingRevision,
		values: { ...view.values },
		secrets: {},
		...patch,
	};
}
function saved(policy = new ProviderSettingsConfigPolicy(declaration()), ctx = context()) {
	return policy.prepare(
		ctx,
		input(policy, ctx, undefined, {
			values: { site: "https://site.invalid/team-a", account: "alice", compact: false, weight: 2 },
			secrets: { token: { operation: "set", value: "fixture-token-123" } },
		}),
	).config;
}
function throwsCode(body: () => unknown, code: string) {
	try {
		body();
	} catch (error) {
		expect(error).toBeInstanceOf(AppError);
		expect((error as AppError).code).toBe(code);
		expect((error as Error).message).not.toContain("fixture-token");
		return;
	}
	throw new Error(`Expected ${code}`);
}

describe("provider settings value and save policy", () => {
	test("defaults are form initialization only, false/zero round-trip and absent optional values stay absent", () => {
		const p = new ProviderSettingsConfigPolicy(declaration()),
			ctx = context();
		expect(p.view(ctx).values).toEqual({ compact: false, weight: 2 });
		const first = p.prepare(
			ctx,
			input(p, ctx, undefined, { values: { compact: false, weight: 0 } }),
		);
		expect(first.config.values).toEqual({ compact: false, weight: 0 });
		const cleared = p.prepare(ctx, input(p, ctx, first.config, { values: {} }), first.config);
		expect(p.view(ctx, cleared.config).values).toEqual({});
		expect(first.config.values).toEqual({ compact: false, weight: 0 });
		expect(cleared.config.revision).toBe(2);
	});
	test("admin sees only secret presence and backend receives only its public fields", () => {
		const p = new ProviderSettingsConfigPolicy(declaration()),
			ctx = context();
		const next = p.prepare(
			ctx,
			input(p, ctx, undefined, {
				values: { site: "https://SITE.invalid:443/team/", account: "alice", label: "report" },
				secrets: { token: { operation: "set", value: "fixture-token-123" } },
			}),
		);
		expect(next.secretWrites).toEqual({ token: { operation: "set", value: "fixture-token-123" } });
		expect(next.config.values).toEqual({
			site: "https://site.invalid/team",
			account: "alice",
			label: "report",
		});
		expect(JSON.stringify(next.config)).not.toContain("fixture-token-123");
		const view = p.view(ctx, next.config);
		expect(view.secrets).toEqual({ token: { isSet: true } });
		expect(JSON.stringify(view)).not.toContain("fixture-token-123");
		expect(JSON.stringify(view)).not.toContain(next.config.secrets.token.binding);
		expect(p.publicValues(ctx, next.config)).toEqual({
			site: "https://site.invalid/team",
			label: "report",
		});
		view.values.label = "mutated";
		expect(next.config.values.label).toBe("report");
	});
	test("omitted or explicit keep retains only the same bound secret, clear never recreates it", () => {
		const p = new ProviderSettingsConfigPolicy(declaration()),
			ctx = context(),
			old = saved(p, ctx),
			before = structuredClone(old);
		for (const secrets of [{}, { token: { operation: "keep" } }]) {
			const next = p.prepare(
				ctx,
				input(p, ctx, old, {
					values: { ...old.values, site: "https://SITE.invalid:443/team-a/", label: "next" },
					secrets,
				}),
				old,
			);
			expect(next.config.secrets).toEqual(old.secrets);
			expect(next.secretWrites).toEqual({});
		}
		const cleared = p.prepare(
			ctx,
			input(p, ctx, old, { secrets: { token: { operation: "clear" } } }),
			old,
		);
		expect(p.view(ctx, cleared.config).secrets.token.isSet).toBe(false);
		expect(p.prepare(ctx, input(p, ctx, cleared.config), cleared.config).config.secrets).toEqual(
			{},
		);
		throwsCode(
			() =>
				p.prepare(
					ctx,
					input(p, ctx, cleared.config, { secrets: { token: { operation: "keep" } } }),
					cleared.config,
				),
			"PROVIDER_SETTINGS_SECRET_NOT_SET",
		);
		expect(old).toEqual(before);
	});
	test.each([
		{ site: "https://different.invalid/team-a" },
		{ site: "https://site.invalid/team-b" },
		{ account: "bob" },
		{ site: "" },
	])("changing the destination or account requires explicit replacement/clear: %j", (patch) => {
		const p = new ProviderSettingsConfigPolicy(declaration()),
			ctx = context(),
			old = saved(p, ctx),
			values = { ...old.values, ...patch };
		for (const secrets of [{}, { token: { operation: "keep" } }])
			throwsCode(
				() => p.prepare(ctx, input(p, ctx, old, { values, secrets }), old),
				"PROVIDER_SETTINGS_SECRET_REBIND_REQUIRED",
			);
		const replaced = p.prepare(
			ctx,
			input(p, ctx, old, {
				values,
				secrets: { token: { operation: "set", value: "replacement-fixture-token" } },
			}),
			old,
		);
		expect(replaced.config.secrets.token.binding).not.toBe(old.secrets.token.binding);
		expect(
			p.prepare(
				ctx,
				input(p, ctx, old, { values, secrets: { token: { operation: "clear" } } }),
				old,
			).config.secrets,
		).toEqual({});
	});
	test("core binding changes reject stale drafts, then require a fresh explicit secret edit", () => {
		const p = new ProviderSettingsConfigPolicy(declaration()),
			ctx = context(),
			old = saved(p, ctx),
			draft = input(p, ctx, old);
		const nextCtx = {
			...ctx,
			providerRoot: "https://provider.invalid/other-tenant",
			identityRevision: "account-binding-2",
		};
		expect(p.view(nextCtx, old).status).toBe("binding-changed");
		throwsCode(() => p.prepare(nextCtx, draft, old), "PROVIDER_SETTINGS_BINDING_CHANGED");
		throwsCode(
			() => p.prepare(nextCtx, input(p, nextCtx, old), old),
			"PROVIDER_SETTINGS_SECRET_REBIND_REQUIRED",
		);
		throwsCode(() => p.publicValues(nextCtx, old), "PROVIDER_SETTINGS_CONFIGURATION_UNAVAILABLE");
		expect(
			p.prepare(
				nextCtx,
				input(p, nextCtx, old, { secrets: { token: { operation: "clear" } } }),
				old,
			).config.secrets,
		).toEqual({});
	});
	test("namespaces separate plugins, installations, target IDs and target kinds", () => {
		const p = new ProviderSettingsConfigPolicy(declaration()),
			ctx = context(),
			old = saved(p, ctx);
		const contexts: ProviderSettingsConfigContext[] = [
			{ ...ctx, pluginId: "com.other.settings" },
			{ ...ctx, installationId: "installation-2" },
			{ ...ctx, target: { kind: "custom-api", id: "provider-2" } },
			{ ...ctx, target: { kind: "nug", id: "provider-1" } },
		];
		for (const other of contexts) {
			expect(p.view(other, old)).toMatchObject({ status: "dormant", values: {}, secrets: {} });
			throwsCode(
				() => p.prepare(other, input(p, other, old), old),
				"PROVIDER_SETTINGS_INSTALLATION_MISMATCH",
			);
			const own = saved(p, other);
			expect(own.owner).not.toBe(old.owner);
			expect(own.secrets.token.binding).not.toBe(old.secrets.token.binding);
		}
		throwsCode(
			() => p.prepare({ ...ctx, target: null }, input(p, ctx)),
			"PROVIDER_SETTINGS_TARGET_MISSING",
		);
	});
	test("revision conflicts and schema changes preserve old data; text-only label changes keep the schema identity", () => {
		const p = new ProviderSettingsConfigPolicy(declaration()),
			ctx = context(),
			old = saved(p, ctx);
		throwsCode(
			() => p.prepare(ctx, input(p, ctx, old, { expectedRevision: 0 }), old),
			"PROVIDER_SETTINGS_REVISION_CONFLICT",
		);
		const altered = declaration();
		altered.configSchema.properties.weight.maximum = 20;
		const next = new ProviderSettingsConfigPolicy(altered);
		expect(next.view(ctx, old)).toMatchObject({
			status: "schema-mismatch",
			values: {},
			secrets: {},
		});
		throwsCode(
			() => next.prepare(ctx, input(next, ctx, old), old),
			"PROVIDER_SETTINGS_SCHEMA_CHANGED",
		);
		const textOnly = {
			...declaration(),
			title: "Renamed display label",
			description: "New help text",
		};
		expect(new ProviderSettingsConfigPolicy(textOnly).schemaFingerprint).toBe(p.schemaFingerprint);
		expect(p.view(ctx, { ...old, schemaVersion: 2 }).status).toBe("schema-mismatch");
	});
	test("semantic fingerprints do not depend on record insertion order or presentation language", () => {
		const d = declaration();
		const same = {
			...d,
			targetKinds: [...d.targetKinds].reverse(),
			configSchema: {
				...d.configSchema,
				properties: Object.fromEntries(Object.entries(d.configSchema.properties).reverse()),
			},
		};
		const first = new ProviderSettingsConfigPolicy(d);
		const second = new ProviderSettingsConfigPolicy(same);
		expect(second.schemaFingerprint).toBe(first.schemaFingerprint);
		const old = saved(first);
		expect(second.prepare(context(), input(second, context(), old), old).config.secrets).toEqual(
			old.secrets,
		);
	});

	test("type constraints, secrets in ordinary values, mask values and header injection fail without partial updates", () => {
		const p = new ProviderSettingsConfigPolicy(declaration()),
			ctx = context();
		for (const values of [
			{ weight: 11 },
			{ weight: 0.5 },
			{ compact: "true" },
			{ unknown: 1 },
			{ token: "fixture-token-123" },
			{ label: "a".repeat(31) },
		])
			throwsCode(
				() => p.prepare(ctx, input(p, ctx, undefined, { values })),
				"PROVIDER_SETTINGS_INVALID_VALUES",
			);
		for (const value of ["__narrafork_secret_set__", "********", "\u2022".repeat(8)])
			throwsCode(
				() =>
					p.prepare(
						ctx,
						input(p, ctx, undefined, { secrets: { token: { operation: "set", value } } }),
					),
				"PROVIDER_SETTINGS_INVALID_SECRET_VALUE",
			);
		throwsCode(
			() =>
				p.prepare(
					ctx,
					input(p, ctx, undefined, {
						secrets: { label: { operation: "set", value: "fixture-token-123" } },
					}),
				),
			"PROVIDER_SETTINGS_INVALID_SECRET_FIELD",
		);
		throwsCode(
			() =>
				p.prepare(ctx, input(p, ctx, undefined, { values: { account: "alice\r\nInjected: yes" } })),
			"PROVIDER_SETTINGS_INVALID_IDENTITY_HEADER",
		);
		throwsCode(
			() =>
				p.prepare(
					ctx,
					input(p, ctx, undefined, {
						secrets: { token: { operation: "set", value: "fixture token" } },
					}),
				),
			"PROVIDER_SETTINGS_INVALID_CREDENTIAL_HEADER",
		);
	});
	test("Unicode field lengths and normalized Unicode roots round-trip without weakening path checks", () => {
		const value = "\u{20000}";
		const d = declaration();
		const p = new ProviderSettingsConfigPolicy({
			...d,
			configSchema: {
				...d.configSchema,
				properties: {
					...d.configSchema.properties,
					label: { type: "string", minLength: 1, maxLength: 1, default: value },
				},
			},
		});
		const ctx = context();
		expect(p.view(ctx).values.label).toBe(value);
		const state = p.prepare(
			ctx,
			input(p, ctx, undefined, { values: { site: "https://site.invalid/团队", label: value } }),
		).config;
		expect(p.view(ctx, state).values).toEqual(state.values);
		const savedRoot = state.values.site;
		if (typeof savedRoot !== "string") throw new Error("Expected a saved URI string");
		expect(normalizeProviderSettingsRoot(savedRoot)).toBe(savedRoot);
		throwsCode(
			() => p.prepare(ctx, input(p, ctx, undefined, { values: { label: value + value } })),
			"PROVIDER_SETTINGS_INVALID_VALUES",
		);
		for (const root of [
			"https:///site.invalid/a",
			"https://site.invalid/%252f",
			"https://site.invalid/%C2%85",
			"https://site.invalid/%GG",
		])
			throwsCode(
				() => normalizeProviderSettingsRoot(root),
				"PROVIDER_SETTINGS_INVALID_DESTINATION",
			);
	});

	test("URI normalization cannot persist an overlong or newly escaped-ASCII value", () => {
		const d = declaration();
		const p = new ProviderSettingsConfigPolicy({
			...d,
			configSchema: {
				...d.configSchema,
				properties: {
					...d.configSchema.properties,
					site: { type: "string", format: "uri", maxLength: 30 },
				},
			},
		});
		const ctx = context();
		throwsCode(
			() =>
				p.prepare(ctx, input(p, ctx, undefined, { values: { site: "https://site.invalid/团队" } })),
			"PROVIDER_SETTINGS_INVALID_VALUES",
		);
		for (const root of [
			`https://site.invalid/${"配".repeat(300)}`,
			'https://site.invalid/a"b',
			"https://site.invalid/%E2%80%A8",
		])
			throwsCode(
				() => normalizeProviderSettingsRoot(root),
				"PROVIDER_SETTINGS_INVALID_DESTINATION",
			);
	});

	test("required values are enforced, and an incomplete initial form cannot claim to be configured", () => {
		const d = declaration();
		const p = new ProviderSettingsConfigPolicy({
				...d,
				configSchema: { ...d.configSchema, required: ["account", "token"] },
			}),
			ctx = context();
		expect(p.view(ctx).status).toBe("incomplete");
		throwsCode(() => p.prepare(ctx, input(p, ctx)), "PROVIDER_SETTINGS_REQUIRED_VALUE_MISSING");
		const old = saved(p, ctx);
		expect(p.view(ctx, old).status).toBe("ready");
		throwsCode(
			() => p.prepare(ctx, input(p, ctx, old, { secrets: { token: { operation: "clear" } } }), old),
			"PROVIDER_SETTINGS_REQUIRED_VALUE_MISSING",
		);
	});
	test("combined byte limits include retained secrets, and malformed stored data is never an empty success", () => {
		const properties = Object.fromEntries(
			Array.from({ length: 7 }, (_, i) => [`token${i}`, { type: "string", writeOnly: true }]),
		);
		const p = new ProviderSettingsConfigPolicy({
				id: "budget",
				schemaVersion: 1,
				title: "Budget",
				targetKinds: ["custom-api"],
				configSchema: {
					type: "object",
					additionalProperties: false,
					properties: { ...properties, a: { type: "string" }, b: { type: "string" } },
				},
			}),
			ctx = context();
		const secrets = Object.fromEntries(
			Array.from({ length: 7 }, (_, i) => [
				`token${i}`,
				{ operation: "set", value: "x".repeat(4096) },
			]),
		);
		const old = p.prepare(ctx, input(p, ctx, undefined, { values: {}, secrets })).config;
		throwsCode(
			() =>
				p.prepare(
					ctx,
					input(p, ctx, old, { values: { a: "a".repeat(3000), b: "b".repeat(3000) } }),
					old,
				),
			"PROVIDER_SETTINGS_VALUES_TOO_LARGE",
		);
		const q = new ProviderSettingsConfigPolicy(declaration()),
			state = saved(q, ctx);
		throwsCode(
			() => q.view(ctx, { ...state, secrets: { unknown: state.secrets.token } }),
			"PROVIDER_SETTINGS_DATA_UNAVAILABLE",
		);
		throwsCode(
			() => q.view(ctx, { ...state, secrets: { token: { ...state.secrets.token, bytes: 0 } } }),
			"PROVIDER_SETTINGS_DATA_UNAVAILABLE",
		);
		expect(q.view(ctx, state).secrets.token.isSet).toBe(true);
	});
});

describe("saved destination roots", () => {
	test("normalizes host case/default port/trailing slash while retaining tenant and API path", () => {
		expect(normalizeProviderSettingsRoot("HTTPS://EXAMPLE.invalid:443/tenant/v1/")).toBe(
			"https://example.invalid/tenant/v1",
		);
	});
	test.each([
		"https://user:pass@site.invalid/",
		"https://site.invalid/tenant/../other",
		"https://site.invalid/./other",
		"https://site.invalid/%2e%2e/other",
		"https://site.invalid/a%2fb",
		"https://site.invalid/?token=fixture-token",
		"https://site.invalid/#x",
		"https://site.invalid/a\\b",
		"file:///fixture",
		"javascript:alert(1)",
		" https://site.invalid",
		"//site.invalid",
	])("rejects nonliteral or credential-bearing roots: %s", (value) => {
		throwsCode(() => normalizeProviderSettingsRoot(value), "PROVIDER_SETTINGS_INVALID_DESTINATION");
	});
});
