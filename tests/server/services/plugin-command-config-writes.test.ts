/**
 * `configWrites` is a write channel a plugin controls, so its boundary is what these tests are
 * about: which keys are refused, and that a refusal happens before anything is persisted.
 *
 * The interesting case is the merge. `PluginProviderConfigService.update()` replaces the entire
 * config object, so applying a single-key write without merging would silently delete every
 * other setting the user had configured — a data-loss bug that no type would catch.
 */

import { describe, expect, it } from "bun:test";
import type { JsonValue } from "@server/lib/plugins/protocol";
import { applyCommandConfigWrites } from "@server/services/plugin-command-config-writes";

const CONFIG_SCHEMA = {
	type: "object",
	properties: {
		loadBalancingMode: { type: "string", enum: ["priority", "balanced"] },
		region: { type: "string" },
		apiKey: { type: "string", writeOnly: true, "x-narrafork-secret": true },
	},
} as unknown as Record<string, unknown>;

interface RecordedUpdate {
	pluginId: string;
	providerInstanceId: string;
	config: Record<string, JsonValue>;
}

function harness(options?: { storedConfig?: Record<string, JsonValue> }) {
	const updates: RecordedUpdate[] = [];
	const registry = {
		list: () => [
			{
				kind: "executable-plugin",
				pluginId: "com.example.demo",
				localId: "acme",
				providerInstanceId: "com.example.demo/acme",
				configSchema: CONFIG_SCHEMA,
			},
			// A second plugin's contribution, to prove the namespace check is real.
			{
				kind: "executable-plugin",
				pluginId: "com.example.other",
				localId: "other",
				providerInstanceId: "com.example.other/other",
				configSchema: CONFIG_SCHEMA,
			},
		],
		getConfig: () => options?.storedConfig ?? {},
	} as never;
	const sink = {
		update: async (
			pluginId: string,
			providerInstanceId: string,
			config: Record<string, JsonValue>,
		) => {
			updates.push({ pluginId, providerInstanceId, config });
			return config;
		},
	};
	return { registry, sink, updates };
}

describe("applyCommandConfigWrites", () => {
	it("persists a declared non-secret field", async () => {
		const { registry, sink, updates } = harness();
		const result = await applyCommandConfigWrites({
			pluginId: "com.example.demo",
			writes: [{ key: "provider.acme.loadBalancingMode", value: "balanced" }],
			registry,
			sink,
		});
		expect(result.written).toEqual(["provider.acme.loadBalancingMode"]);
		expect(updates).toHaveLength(1);
		expect(updates[0]?.providerInstanceId).toBe("com.example.demo/acme");
		expect(updates[0]?.config.loadBalancingMode).toBe("balanced");
	});

	it("merges over the stored config instead of replacing it", async () => {
		// `update()` takes the whole object, so an unmerged write would drop `region`.
		const { registry, sink, updates } = harness({
			storedConfig: { region: "eu-west-1", loadBalancingMode: "priority" },
		});
		await applyCommandConfigWrites({
			pluginId: "com.example.demo",
			writes: [{ key: "provider.acme.loadBalancingMode", value: "balanced" }],
			registry,
			sink,
		});
		expect(updates[0]?.config).toEqual({ region: "eu-west-1", loadBalancingMode: "balanced" });
	});

	it("clears a field when the value is null", async () => {
		const { registry, sink, updates } = harness({
			storedConfig: { region: "eu-west-1", loadBalancingMode: "priority" },
		});
		const result = await applyCommandConfigWrites({
			pluginId: "com.example.demo",
			writes: [{ key: "provider.acme.region", value: null }],
			registry,
			sink,
		});
		expect(result.cleared).toEqual(["provider.acme.region"]);
		expect(updates[0]?.config).toEqual({ loadBalancingMode: "priority" });
	});

	it("collapses several keys for one provider into a single update", async () => {
		const { registry, sink, updates } = harness();
		await applyCommandConfigWrites({
			pluginId: "com.example.demo",
			writes: [
				{ key: "provider.acme.loadBalancingMode", value: "balanced" },
				{ key: "provider.acme.region", value: "us-east-1" },
			],
			registry,
			sink,
		});
		expect(updates).toHaveLength(1);
		expect(updates[0]?.config).toEqual({
			loadBalancingMode: "balanced",
			region: "us-east-1",
		});
	});

	it("refuses a key belonging to another plugin's contribution", async () => {
		const { registry, sink, updates } = harness();
		await expect(
			applyCommandConfigWrites({
				pluginId: "com.example.demo",
				writes: [{ key: "provider.other.region", value: "us-east-1" }],
				registry,
				sink,
			}),
		).rejects.toThrow(/may not write config key/);
		expect(updates).toHaveLength(0);
	});

	it("refuses a key outside the provider namespace", async () => {
		const { registry, sink } = harness();
		await expect(
			applyCommandConfigWrites({
				pluginId: "com.example.demo",
				writes: [{ key: "settings.proxy", value: "http://localhost:1" }],
				registry,
				sink,
			}),
		).rejects.toThrow(/may not write config key/);
	});

	it("refuses a secret field, which belongs in secretWrites", async () => {
		// Accepting it would persist a credential as plaintext config, where `config.get`
		// can read it back.
		const { registry, sink, updates } = harness();
		await expect(
			applyCommandConfigWrites({
				pluginId: "com.example.demo",
				writes: [{ key: "provider.acme.apiKey", value: "ksk_secret" }],
				registry,
				sink,
			}),
		).rejects.toThrow(/names a secret field/);
		expect(updates).toHaveLength(0);
	});

	it("refuses a field the configSchema does not declare", async () => {
		const { registry, sink } = harness();
		await expect(
			applyCommandConfigWrites({
				pluginId: "com.example.demo",
				writes: [{ key: "provider.acme.undeclared", value: 1 }],
				registry,
				sink,
			}),
		).rejects.toThrow(/not declared in the provider's configSchema/);
	});

	it("refuses an oversized value", async () => {
		const { registry, sink } = harness();
		await expect(
			applyCommandConfigWrites({
				pluginId: "com.example.demo",
				writes: [{ key: "provider.acme.region", value: "x".repeat(17 * 1024) }],
				registry,
				sink,
			}),
		).rejects.toThrow(/too large/);
	});

	it("validates the whole batch before applying any of it", async () => {
		// A valid key followed by an invalid one must leave nothing persisted; otherwise a
		// partially-applied batch would be indistinguishable from a successful one.
		const { registry, sink, updates } = harness();
		await expect(
			applyCommandConfigWrites({
				pluginId: "com.example.demo",
				writes: [
					{ key: "provider.acme.loadBalancingMode", value: "balanced" },
					{ key: "provider.acme.apiKey", value: "ksk_secret" },
				],
				registry,
				sink,
			}),
		).rejects.toThrow(/names a secret field/);
		expect(updates).toHaveLength(0);
	});

	it("does nothing for an empty batch", async () => {
		const { registry, sink, updates } = harness();
		const result = await applyCommandConfigWrites({
			pluginId: "com.example.demo",
			writes: [],
			registry,
			sink,
		});
		expect(result).toEqual({ written: [], cleared: [] });
		expect(updates).toHaveLength(0);
	});
});
