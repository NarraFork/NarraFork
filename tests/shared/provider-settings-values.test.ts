import { describe, expect, test } from "bun:test";
import {
	isBoundedProviderSettingsData,
	type ProviderSettingsSave,
	providerSettingsSaveSchema,
} from "../../shared/provider-settings-values";

function request(): ProviderSettingsSave {
	return {
		schemaVersion: 1,
		schemaFingerprint: "a".repeat(64),
		expectedRevision: 0,
		expectedBindingRevision: "b".repeat(64),
		values: { enabled: false, weight: 2, title: "fixture" },
		secrets: { token: { operation: "set", value: "fictional-token" } },
	};
}
describe("independent provider settings save contract", () => {
	test("accepts complete ordinary values with explicit secret operations", () => {
		const input = request();
		expect(providerSettingsSaveSchema.parse(input)).toEqual(input);
		for (const operation of ["keep", "clear"])
			expect(
				providerSettingsSaveSchema.safeParse({ ...input, secrets: { token: { operation } } })
					.success,
			).toBe(true);
	});
	test("rejects target/owner overrides, missing revisions and secret masks", () => {
		for (const patch of [
			{ pluginId: "other.plugin" },
			{ providerId: "provider-2" },
			{ installationId: "forged" },
			{ expectedRevision: -1 },
			{ expectedRevision: 0.5 },
			{ expectedRevision: Number.MAX_SAFE_INTEGER },
			{ expectedRevision: undefined },
			{ expectedBindingRevision: "draft" },
			{ schemaVersion: 2 },
			{ schemaFingerprint: "old" },
			{ secrets: { token: "__narrafork_secret_set__" } },
			{ secrets: { token: { operation: "set", value: "" } } },
			{ secrets: { token: { operation: "keep", value: "fictional-token" } } },
			{ values: { weight: Infinity } },
			{ values: { nested: { a: 1 } } },
			{ values: { nested: [1] } },
			{ values: { empty: null } },
		])
			expect(providerSettingsSaveSchema.safeParse({ ...request(), ...patch }).success).toBe(false);
	});
	test("bounds field count and UTF-8 payloads without calling accessors or serialization hooks", () => {
		const excessive = {
			...request(),
			values: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`f${i}`, true])),
		};
		expect(providerSettingsSaveSchema.safeParse(excessive).success).toBe(false);
		expect(
			providerSettingsSaveSchema.safeParse({
				...request(),
				values: Object.fromEntries(
					Array.from({ length: 13 }, (_, i) => [`f${i}`, "配".repeat(2000)]),
				),
			}).success,
		).toBe(false);
		let reads = 0;
		const accessor = request();
		Object.defineProperty(accessor, "values", {
			enumerable: true,
			get() {
				reads++;
				throw Error("must not run");
			},
		});
		expect(providerSettingsSaveSchema.safeParse(accessor).success).toBe(false);
		const hooks = {
			...request(),
			toJSON() {
				reads++;
				return {};
			},
		};
		expect(providerSettingsSaveSchema.safeParse(hooks).success).toBe(false);
		expect(reads).toBe(0);
		for (const key of ["__proto__", "prototype", "constructor", "toString"]) {
			const input = request();
			input.values = JSON.parse(`{"${key}":"bad"}`);
			expect(providerSettingsSaveSchema.safeParse(input).success).toBe(false);
		}
		const cyclic: Record<string, unknown> = {};
		cyclic.loop = cyclic;
		expect(isBoundedProviderSettingsData(cyclic, 1024)).toBe(false);
	});
});
