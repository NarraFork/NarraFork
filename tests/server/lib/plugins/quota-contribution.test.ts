import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
	adaptPluginCapability,
	PLUGIN_CAPABILITY_ADAPTER,
} from "@server/lib/integrations/capability-adapters";
import {
	getContributionIds,
	parseActivationEvent,
	parseManifest,
	safeParseManifest,
} from "@server/lib/plugins/manifest";
import { CAPABILITIES } from "@server/lib/plugins/permissions";
import {
	PLUGIN_BACKEND_HOST_REQUEST_METHODS,
	PLUGIN_SHARED_HOST_REQUEST_METHODS,
	PLUGIN_TO_HOST_METHOD_REQUIRED_FEATURES,
	PLUGIN_TO_HOST_REQUEST_METHODS,
} from "@server/lib/plugins/protocol";
import { providerQuotaSourceSchema } from "@shared/provider-quota";
import { z } from "zod";

const declaration = {
	id: "quota",
	title: "Quota",
	match: { hosts: ["example.test"] },
	requests: [{ path: "/v1/quota", auth: "bearer" }],
};
const input = {
	schemaVersion: 1,
	pluginId: "com.example.quota",
	version: "1.0.0",
	displayName: "Quota source",
	engine: {
		runtime: "bun",
		hostApi: ">=1.0 <2",
		rpc: "narrafork.rpc/1",
		features: ["host_api.requests", "host_api.provider_connection", "rpc.cancel"],
	},
	server: { entry: "server/index.js", protocol: "narrafork.rpc/1" },
	activationEvents: ["onQuota:quota"],
	contributes: { quotaSources: [declaration] },
	permissions: { host: ["quota.provide", "provider.connection.request"] },
};

describe("quota contribution contract", () => {
	test("accepts independent quota sources, canonical defaults and onQuota", () => {
		const manifest = parseManifest(input);
		expect(manifest.contributes.providers).toEqual([]);
		expect(manifest.contributes.quotaSources).toEqual([
			providerQuotaSourceSchema.parse(declaration),
		]);
		expect(getContributionIds(manifest)).toEqual(["quota"]);
		expect(parseActivationEvent("onQuota:quota")).toEqual({ kind: "onQuota", reference: "quota" });
		expect(
			safeParseManifest({ ...input, activationEvents: ["onQuota:com.example.quota/quota"] })
				.success,
		).toBe(true);
	});

	test("legacy manifests default absent quota contributions to empty", () => {
		const { contributes: _contributes, activationEvents: _activationEvents, ...legacy } = input;
		expect(parseManifest(legacy).contributes.quotaSources).toEqual([]);
		expect(parseManifest({ ...legacy, contributes: {} }).contributes.quotaSources).toEqual([]);
	});

	test("rejects a provider binding, bad quota activation target and duplicate contribution ids", () => {
		for (const candidate of [
			{
				...input,
				contributes: { quotaSources: [{ ...declaration, providerId: "bound-provider" }] },
			},
			{ ...input, activationEvents: ["onQuota:missing"] },
			{ ...input, activationEvents: ["onQuota:com.other.plugin/quota"] },
			{ ...input, contributes: { quotaSources: [declaration, declaration] } },
			{ ...input, contributes: { quotaSources: [declaration], providers: [{ id: "quota" }] } },
			{ ...input, server: undefined },
		])
			expect(safeParseManifest(candidate).success).toBe(false);
	});

	test("reuses the shared path, auth, text and budget validation", () => {
		for (const changes of [
			{ requests: [{ path: "https://other.test/quota", auth: "bearer" }] },
			{ requests: [{ path: "/../quota", auth: "bearer" }] },
			{ requests: [{ path: "/quota", auth: "password" }] },
			{ limits: { timeoutMs: 30_001 } },
			{ limits: { maxResponseBytes: 262_145 } },
			{ limits: { maxRequests: 17 } },
			{ title: "<script>quota</script>" },
		])
			expect(
				safeParseManifest({
					...input,
					contributes: { quotaSources: [{ ...declaration, ...changes }] },
				}).success,
			).toBe(false);
	});

	test("maps both new capabilities canonically and reversibly, without provider.use", () => {
		for (const capability of ["quota.provide", "provider.connection.request"] as const) {
			expect(CAPABILITIES).toContain(capability);
			expect(adaptPluginCapability(capability)?.id).toBe(capability);
			expect(
				Object.values(PLUGIN_CAPABILITY_ADAPTER).filter(
					(entry) => entry.descriptorId === capability,
				),
			).toHaveLength(1);
		}
	});

	test("strictly separates the backend extension from shared iframe methods", () => {
		expect(PLUGIN_BACKEND_HOST_REQUEST_METHODS).toEqual([
			"provider.connection.request",
			"provider.settings.get",
			"provider.settings.connection.request",
		]);
		for (const method of PLUGIN_BACKEND_HOST_REQUEST_METHODS)
			expect(PLUGIN_SHARED_HOST_REQUEST_METHODS as readonly string[]).not.toContain(method);
		expect(PLUGIN_SHARED_HOST_REQUEST_METHODS).not.toContain("provider.connection.request");
		expect(PLUGIN_TO_HOST_REQUEST_METHODS).toEqual([
			...PLUGIN_SHARED_HOST_REQUEST_METHODS,
			...PLUGIN_BACKEND_HOST_REQUEST_METHODS,
		]);
		expect(Object.keys(PLUGIN_TO_HOST_METHOD_REQUIRED_FEATURES).sort()).toEqual(
			[...PLUGIN_TO_HOST_REQUEST_METHODS].sort(),
		);
		expect(PLUGIN_TO_HOST_METHOD_REQUIRED_FEATURES["provider.connection.request"]).toEqual([
			"host_api.requests",
			"host_api.provider_connection",
		]);
	});

	test("JSON schema companion retains exact quota shape, defaults and numeric ceilings", async () => {
		const companion = JSON.parse(
			await readFile("docs/plugin-system/contracts/manifest-v1.schema.json", "utf8"),
		);
		const generated = z.toJSONSchema(providerQuotaSourceSchema, {
			io: "input",
			unrepresentable: "any",
		});
		const quota = companion.$defs.quotaSourceContribution;
		expect(quota.required).toEqual(generated.required);
		expect(Object.keys(quota.properties).sort()).toEqual(
			Object.keys(generated.properties ?? {}).sort(),
		);
		expect(quota.properties.limits).toEqual(generated.properties?.limits);
		expect(quota.properties.refresh).toEqual(generated.properties?.refresh);
		expect(quota.additionalProperties).toBe(false);
		expect(companion.$defs.contributes.properties.quotaSources.items.$ref).toBe(
			"#/$defs/quotaSourceContribution",
		);
	});
});
