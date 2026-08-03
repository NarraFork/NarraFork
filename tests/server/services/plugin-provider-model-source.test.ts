import { describe, expect, test } from "bun:test";
import {
	findPluginProviderForModel,
	listPluginProviderModelGroups,
	listPluginProviderModelValues,
} from "@server/services/plugin-provider-model-source";
import { PluginProviderRegistry } from "@server/services/plugin-provider-registry";

/**
 * The host has two model surfaces — `getVisibleModels()` for the Agent and the
 * settings response for the picker — and they want different things from the same
 * registry:
 *
 * - the Agent must only ever see models it can actually route to, otherwise an
 *   unroutable model can enter a subagent model pool;
 * - the picker wants registered-but-unavailable providers to stay visible, so a
 *   plugin the user just installed does not silently vanish.
 */

const pluginId = "com.example.models";

function model(id: string, extra: Record<string, unknown> = {}) {
	return {
		id,
		displayName: `Model ${id}`,
		capabilities: {
			chat: true,
			generate: true,
			streaming: true,
			tools: false,
			sessionMode: "stateless" as const,
		},
		...extra,
	};
}

function registryWith(options: { models?: ReturnType<typeof model>[] } = {}) {
	const registry = new PluginProviderRegistry();
	registry.register({
		kind: "executable-plugin",
		pluginId,
		localId: "demo",
		providerInstanceId: `${pluginId}/demo`,
		providerPrefix: "demo",
		displayName: "Demo Provider",
		models: options.models ?? [model("demo/base"), model("demo/fast")],
	});
	return registry;
}

describe("plugin provider model source", () => {
	test("lists fully-prefixed model values", () => {
		const registry = registryWith();

		expect(listPluginProviderModelValues(registry)).toEqual(["demo:demo/base", "demo:demo/fast"]);
	});

	test("ignores builtin and compatible-API providers", () => {
		const registry = registryWith();
		registry.register({
			kind: "builtin",
			localId: "builtin-demo",
			providerInstanceId: "builtin/demo",
			providerPrefix: "bi",
			displayName: "Builtin",
			models: [model("bi/one")],
		});

		// The host already surfaces builtins through their own listers; duplicating them
		// here would show every builtin model twice.
		expect(listPluginProviderModelValues(registry)).toEqual(["demo:demo/base", "demo:demo/fast"]);
	});

	test("omits models from a disabled plugin", () => {
		const registry = registryWith();
		registry.disablePlugin(pluginId, "Plugin is disabled");

		// An unroutable model must not reach the Agent's model pools.
		expect(listPluginProviderModelValues(registry)).toEqual([]);
	});

	test("does not list aliases as separate models", () => {
		const registry = registryWith({
			models: [model("demo/base", { aliases: ["demo/latest", "demo/v1"] })],
		});

		// Aliases resolve at routing time; listing them would show one model three times.
		expect(listPluginProviderModelValues(registry)).toEqual(["demo:demo/base"]);
	});

	test("resolves a bare model id back to its provider prefix", () => {
		const registry = registryWith();

		expect(findPluginProviderForModel(registry, "demo/fast")).toBe("demo");
		expect(findPluginProviderForModel(registry, "nope/none")).toBeUndefined();
	});

	test("resolves through an alias", () => {
		const registry = registryWith({
			models: [model("demo/base", { aliases: ["demo/latest"] })],
		});

		// `getModel()` honours aliases, so a stored alias still routes correctly.
		expect(findPluginProviderForModel(registry, "demo/latest")).toBe("demo");
	});

	test("does not resolve a model from a disabled plugin", () => {
		const registry = registryWith();
		registry.disablePlugin(pluginId, "Plugin is disabled");

		expect(findPluginProviderForModel(registry, "demo/base")).toBeUndefined();
	});

	test("groups models per provider for the picker", () => {
		const registry = registryWith({
			models: [
				model("demo/base", {
					contextWindow: 8192,
					capabilities: {
						chat: true,
						generate: true,
						streaming: true,
						tools: false,
						sessionMode: "stateless" as const,
						reasoningEfforts: ["low", "high"],
					},
				}),
			],
		});

		const [group] = listPluginProviderModelGroups(registry);

		expect(group.prefix).toBe("demo");
		expect(group.name).toBe("Demo Provider");
		expect(group.pluginId).toBe(pluginId);
		// The prefix is user-overridable, so a settings UI that wants to load this
		// provider's config or its `provider-settings` view must address it by the stable
		// contribution id instead.
		expect(group.contributionId).toBe("demo");
		expect(group.models).toHaveLength(1);
		expect(group.models[0]).toMatchObject({
			value: "demo:demo/base",
			label: "Model demo/base",
			provider: "demo",
			bareModel: "demo/base",
			contextWindow: 8192,
			effortLevels: ["low", "high"],
			available: true,
		});
	});

	test("keeps a disabled provider visible but marks its models unavailable", () => {
		const registry = registryWith();
		registry.disablePlugin(pluginId, "Plugin is disabled");

		const [group] = listPluginProviderModelGroups(registry);

		// Hiding the group entirely would make a freshly installed plugin look broken.
		expect(group.prefix).toBe("demo");
		expect(group.models.every((entry) => entry.available === false)).toBe(true);
	});

	test("surfaces a provider whose catalog has not been discovered yet", () => {
		const registry = new PluginProviderRegistry();
		registry.register({
			kind: "executable-plugin",
			pluginId,
			localId: "pending",
			providerInstanceId: `${pluginId}/pending`,
			providerPrefix: "pending",
			displayName: "Pending Provider",
		});

		const [group] = listPluginProviderModelGroups(registry);

		expect(group.models).toEqual([]);
		// The stale flag is how the UI tells "discovery pending" from "no models".
		expect(group.catalogStale).toBe(true);
	});
});
