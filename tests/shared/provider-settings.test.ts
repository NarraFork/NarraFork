import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
	PROVIDER_SETTINGS_LIMITS,
	providerSettingsConfigSchema,
	providerSettingsConnectionSchema,
	providerSettingsContributionSchema,
	providerSettingsFieldVisibility,
} from "../../shared/provider-settings";

const schema = (properties: Record<string, unknown>) => ({
	type: "object",
	properties,
	additionalProperties: false,
});
const contribution = (extra: Record<string, unknown> = {}) => ({
	id: "site",
	schemaVersion: 1,
	title: "Account details",
	targetKinds: ["custom-api"],
	configSchema: schema({
		siteUrl: { type: "string", format: "uri" },
		token: { type: "string", writeOnly: true },
		account: { type: "string", "x-narrafork-host-only": true },
	}),
	...extra,
});
const extension = () => ({
	id: "wallet",
	destination: "extension",
	method: "GET",
	path: "/api/user/self",
	baseUrlField: "siteUrl",
	whenUrlMissing: "provider-root",
	auth: { kind: "bearer", secretField: "token" },
	headers: [{ name: "new-api-user", field: "account" }],
});
const provider = () => ({
	id: "usage",
	destination: "provider",
	method: "GET",
	path: "/v1/usage",
	auth: "provider-key",
});

describe("saved provider settings declaration", () => {
	test("accepts a credential-free generic form and independent action, with no implied defaults", () => {
		const input = contribution({
			configSchema: schema({
				enabled: { type: "boolean", default: false },
				weight: { type: "integer", minimum: 0, maximum: 10, default: 2 },
				ratio: { type: "number", minimum: 0, default: 0.5 },
				label: { type: "string", enum: ["compact", "full"], default: "compact" },
			}),
			action: { title: "Inspect", i18n: { "zh-CN": { title: "检查" } } },
		});
		const parsed = providerSettingsContributionSchema.parse(input);
		expect(input).toEqual(parsed);
		expect(parsed.connections).toBeUndefined();
		expect(providerSettingsContributionSchema.shape.id.safeParse("sample.action").success).toBe(
			true,
		);
	});
	test("enforces four independent target kinds without target ids, core fields or scope overrides", () => {
		expect(
			providerSettingsContributionSchema.parse(
				contribution({ targetKinds: ["custom-api", "nug", "platform", "executable-plugin"] }),
			).targetKinds,
		).toHaveLength(4);
		for (const change of [
			{ targetKinds: [] },
			{ targetKinds: ["custom-api", "custom-api"] },
			{ targetKinds: ["credential"] },
			{ schemaVersion: 2 },
			{ providerId: "other" },
			{ pluginId: "another.plugin" },
			{ installationId: "forged" },
			{ permissions: ["admin"] },
			{ action: { title: "Inspect", handler: "ui" } },
		])
			expect(providerSettingsContributionSchema.safeParse(contribution(change)).success).toBe(
				false,
			);
	});
	test("keeps plaintext, host-only account identity and secret fields distinct", () => {
		for (const marker of [
			{ format: "password" },
			{ writeOnly: true },
			{ "x-narrafork-secret": true },
		]) {
			const s = providerSettingsConfigSchema.parse(
				schema({ value: { type: "string", ...marker } }),
			);
			expect(providerSettingsFieldVisibility(s.properties.value)).toBe("secret");
			for (const addition of [
				{ default: "fixture-token" },
				{ default: "" },
				{ enum: ["fixture-token"] },
			])
				expect(
					providerSettingsConfigSchema.safeParse(
						schema({ value: { type: "string", ...marker, ...addition } }),
					).success,
				).toBe(false);
		}
		const s = providerSettingsConfigSchema.parse(contribution().configSchema);
		expect(providerSettingsFieldVisibility(s.properties.account)).toBe("host");
		expect(providerSettingsFieldVisibility(s.properties.siteUrl)).toBe("public");
		expect(
			providerSettingsConfigSchema.safeParse(
				schema({
					account: { type: "string", "x-narrafork-host-only": true, default: "other-account" },
				}),
			).success,
		).toBe(false);
	});
	test("rejects reference execution, unimplemented schema keywords, secret objects and contradictory constraints", () => {
		for (const bad of [
			{ type: "object", properties: {}, additionalProperties: true },
			{ ...schema({}), $ref: "https://remote.invalid/schema" },
			{ ...schema({}), $ref: "#" },
			{ ...schema({}), required: ["missing"] },
			{ ...schema({ one: { type: "string" } }), required: ["one", "one"] },
			schema({
				value: { type: "object", properties: { password: { type: "string", writeOnly: true } } },
			}),
			schema({ value: { type: "string", pattern: "(a+)+$" } }),
			schema({ value: { type: "string", format: "script" } }),
			schema({ value: { type: "string", minLength: 4, maxLength: 2 } }),
			schema({ value: { type: "string", enum: ["a", "a"] } }),
			schema({ value: { type: "string", enum: ["a"], default: "b" } }),
			schema({ value: { type: "integer", default: 0.5 } }),
			schema({ value: { type: "number", minimum: 2, maximum: 1 } }),
			schema({ value: { type: "number", maximum: 2, default: 3 } }),
			schema({ value: { type: "number", default: Number.POSITIVE_INFINITY } }),
			schema({ value: { type: "string", format: "uri", writeOnly: true } }),
		])
			expect(providerSettingsConfigSchema.safeParse(bad).success).toBe(false);
	});
	test("bounds raw nodes, depth and UTF-8 bytes before projected schema validation", () => {
		const fields = Object.fromEntries(
			Array.from({ length: 32 }, (_, i) => [`f${i}`, { type: "boolean" }]),
		);
		expect(providerSettingsConfigSchema.safeParse(schema(fields)).success).toBe(true);
		expect(
			providerSettingsConfigSchema.safeParse(schema({ ...fields, extra: { type: "boolean" } }))
				.success,
		).toBe(false);
		const manyNodes = Object.fromEntries(
			Array.from({ length: 10 }, (_, i) => [
				`f${i}`,
				{ type: "string", enum: Array.from({ length: 32 }, (_, n) => String(n)) },
			]),
		);
		expect(providerSettingsConfigSchema.safeParse(schema(manyNodes)).success).toBe(false);
		const manyBytes = schema(
			Object.fromEntries(
				Array.from({ length: 14 }, (_, i) => [
					`f${i}`,
					{ type: "string", description: "配".repeat(1000) },
				]),
			),
		);
		expect(JSON.stringify(manyBytes).length).toBeLessThan(PROVIDER_SETTINGS_LIMITS.schemaBytes);
		expect(new TextEncoder().encode(JSON.stringify(manyBytes)).length).toBeGreaterThan(
			PROVIDER_SETTINGS_LIMITS.schemaBytes,
		);
		expect(providerSettingsConfigSchema.safeParse(manyBytes).success).toBe(false);
		const cyclic: Record<string, unknown> = schema({});
		cyclic.cycle = cyclic;
		expect(providerSettingsConfigSchema.safeParse(cyclic).success).toBe(false);
	});
	test("does not silently strip prototype keys or execute accessors/toJSON in config schemas", () => {
		for (const key of ["__proto__", "constructor", "prototype", "toString"]) {
			const bad = JSON.parse(
				`{"type":"object","additionalProperties":false,"properties":{"${key}":{"type":"string"}}}`,
			);
			expect(providerSettingsConfigSchema.safeParse(bad).success).toBe(false);
		}
		let invoked = 0;
		const bad = schema({});
		Object.defineProperty(bad, "properties", {
			get() {
				invoked++;
				throw Error("must not execute");
			},
			enumerable: true,
		});
		expect(providerSettingsConfigSchema.safeParse(bad).success).toBe(false);
		const json = schema({});
		Object.defineProperty(json, "toJSON", {
			value() {
				invoked++;
				return {};
			},
		});
		expect(providerSettingsConfigSchema.safeParse(json).success).toBe(false);
		expect(invoked).toBe(0);
	});
});

describe("provider settings connection declarations", () => {
	test("accepts two disjoint credential destinations; fields never identify arbitrary core owners", () => {
		const parsed = providerSettingsContributionSchema.parse(
			contribution({ connections: [provider(), extension()] }),
		);
		expect(parsed.connections?.map((c) => c.destination)).toEqual(["provider", "extension"]);
		expect(parsed.connections?.[1]).not.toHaveProperty("providerId");
	});
	test("rejects inference credentials at extension destinations and extension credentials at provider destinations", () => {
		for (const v of [
			{ ...extension(), auth: "provider-key" },
			{ ...extension(), apiKey: "core-key" },
			{ ...extension(), auth: { kind: "provider-key" } },
			{ ...provider(), baseUrlField: "siteUrl" },
			{ ...provider(), auth: { kind: "bearer", secretField: "token" } },
			{ ...provider(), headers: [{ name: "new-api-user", field: "account" }] },
		])
			expect(providerSettingsConnectionSchema.safeParse(v).success).toBe(false);
	});
	test.each([
		"https://other.invalid/api",
		"//other.invalid/api",
		"/a/../api",
		"/./api",
		"/a%2fb",
		"/%2e%2e/api",
		"/a?token=x",
		"/a#fragment",
		"/a\\b",
		"/**/api",
		"/a//api",
		"/\r\nHeader",
	])("path suffix cannot escape its saved tenant root: %s", (path) => {
		expect(providerSettingsConnectionSchema.safeParse({ ...provider(), path }).success).toBe(false);
	});
	test("requires locally declared field types for root, credentials and headers", () => {
		for (const change of [
			{ baseUrlField: "unknown" },
			{ baseUrlField: "token" },
			{ auth: { kind: "bearer", secretField: "account" } },
			{ auth: { kind: "bearer", secretField: "provider.another.token" } },
			{ headers: [{ name: "new-api-user", field: "token" }] },
			{ headers: [{ name: "new-api-user", field: "siteUrl" }] },
			{
				headers: [
					{ name: "new-api-user", field: "account" },
					{ name: "new-api-user", field: "account" },
				],
			},
		])
			expect(
				providerSettingsContributionSchema.safeParse(
					contribution({ connections: [{ ...extension(), ...change }] }),
				).success,
			).toBe(false);
		for (const patch of [
			{ default: "https://other.invalid" },
			{ enum: ["https://other.invalid"] },
			{ format: "password" },
		])
			expect(
				providerSettingsContributionSchema.safeParse(
					contribution({
						configSchema: schema({
							siteUrl: { type: "string", format: "uri", ...patch },
							token: { type: "string", writeOnly: true },
							account: { type: "string" },
						}),
						connections: [extension()],
					}),
				).success,
			).toBe(false);
	});
	test.each([
		"authorization",
		"cookie",
		"host",
		"proxy-authorization",
		"x-forwarded-user",
		"x-original-user",
		"sec-tenant",
		"cf-account",
		"new-api-user\r\n",
		"New-Api-User",
	])("identity fields cannot override credential/routing headers: %s", (name) => {
		expect(
			providerSettingsConnectionSchema.safeParse({
				...extension(),
				headers: [{ name, field: "account" }],
			}).success,
		).toBe(false);
	});
	test("rejects duplicate ids, methods and arbitrary request/redirect/size policy", () => {
		for (const connections of [
			[provider(), provider()],
			Array.from({ length: 9 }, (_, i) => ({ ...provider(), id: `c${i}` })),
		])
			expect(
				providerSettingsContributionSchema.safeParse(contribution({ connections })).success,
			).toBe(false);
		for (const change of [
			{ method: "POST" },
			{ redirect: "follow" },
			{ query: { token: "x" } },
			{ maxResponseBytes: 2 ** 30 },
		])
			expect(
				providerSettingsConnectionSchema.safeParse({ ...extension(), ...change }).success,
			).toBe(false);
	});
});

test("published providerSettings companion matches the whole shared shape without erasing preprocessing", async () => {
	const doc = JSON.parse(
		await readFile("docs/plugin-system/contracts/manifest-v1.schema.json", "utf8"),
	);
	const { $schema: _dialect, ...generated } = z.toJSONSchema(providerSettingsContributionSchema, {
		io: "input",
		unrepresentable: "any",
	});
	const { $comment: _note, ...companion } = doc.$defs.providerSettingsContribution;
	expect(companion).toEqual(generated);
	expect(companion.properties.configSchema.type).toBe("object");
	expect(companion.properties.configSchema.additionalProperties).toBe(false);
	expect(doc.$defs.contributes.properties.providerSettings).toEqual({
		type: "array",
		maxItems: 32,
		items: { $ref: "#/$defs/providerSettingsContribution" },
	});
	expect(doc.properties.contributes.default).not.toHaveProperty("providerSettings");
	expect(doc.allOf[0].if.properties.contributes.anyOf).toContainEqual({
		required: ["providerSettings"],
		properties: {
			providerSettings: {
				contains: {
					anyOf: [
						{ required: ["action"] },
						{ required: ["connections"], properties: { connections: { minItems: 1 } } },
					],
				},
			},
		},
	});
});
