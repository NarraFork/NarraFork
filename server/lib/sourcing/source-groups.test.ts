import { afterEach, describe, expect, test } from "bun:test";
import { pluginProviderRegistry } from "../../services/plugin-provider-registry";
import {
	type CustomApiProviderConfig,
	type NUGProviderConfig,
	saveSettings,
	settings,
} from "../settings";
import { getSourceGroup, getSourceGroupByPrefix, listSourceGroups } from "./source-groups";

const saved = structuredClone(settings);
const pluginId = "com.example.sourcing";

afterEach(() => {
	pluginProviderRegistry.removePlugin(pluginId);
	saveSettings(structuredClone(saved));
});

function custom(
	id: string,
	prefix: string,
	baseUrl: string,
	protocol: CustomApiProviderConfig["protocol"],
	extra: Partial<CustomApiProviderConfig> = {},
): CustomApiProviderConfig {
	return {
		id,
		name: `Name ${id}`,
		prefix,
		apiKey: `sk-${id}`,
		baseUrl,
		defaultModel: "m",
		protocol,
		...extra,
	};
}

function nug(
	id: string,
	prefix: string,
	extra: Partial<NUGProviderConfig> = {},
): NUGProviderConfig {
	return {
		id,
		name: `NUG ${id}`,
		prefix,
		apiKey: `nug-${id}`,
		baseUrl: "http://127.0.0.1:7790",
		defaultModel: "m",
		...extra,
	};
}

function registerPlugin(localId: string, prefix: string) {
	pluginProviderRegistry.register({
		kind: "executable-plugin",
		pluginId,
		localId,
		providerInstanceId: `${pluginId}/${localId}`,
		providerPrefix: prefix,
		displayName: `Plugin ${localId}`,
		createAdapter: () => {
			throw new Error("not used");
		},
	});
}

describe("source groups", () => {
	test("one group per existing source, with template, prefix and disabled", () => {
		saveSettings({
			...settings,
			customApiProviders: [
				custom("kimiCn", "kimi", "https://api.kimi.com/coding/v1", "completions-compatible"),
				custom("kimiIntl", "kimi2", "https://api.kimi.ai/coding/v1", "anthropic-messages"),
				custom("go", "opencode", "https://opencode.ai/zen/go/v1", "openai-responses"),
				custom("ds", "deepseek", "https://api.deepseek.com/v1", "completions-compatible"),
				custom("oai", "openai", "https://api.openai.com/v1", "openai-responses"),
				custom("ant", "claude", "https://api.anthropic.com/v1", "anthropic-messages"),
				custom(
					"gem",
					"gemini",
					"https://generativelanguage.googleapis.com/v1beta",
					"gemini-compatible",
				),
				custom("relay", "relay", "https://relay.example/v1", "openai-responses", {
					disabled: true,
				}),
				custom("moon", "moonshot", "https://api.moonshot.cn/anthropic/v1", "anthropic-messages"),
				custom("relayGem", "relaygem", "https://relay.example/v1beta", "gemini-compatible"),
			],
			nugProviders: [nug("nugA", "nug"), nug("nugB", "nug2", { disabled: true })],
			tokendance: { apiKey: "", generation: 0, disabled: true },
			commandCode: { baseUrl: "https://cc.example" },
		});
		registerPlugin("demo", "demo");

		const rows = listSourceGroups().map((g) => [g.id, g.templateId, g.kind, g.prefix, g.disabled]);
		expect(rows).toEqual([
			["codex", "codex", "known", "codex", false],
			["tokendance", "tokendance", "known", "tokendance", true],
			["CommandCode", "command-code", "known", "CommandCode", false],
			["kimiCn", "kimi-code", "known", "kimi", false],
			["kimiIntl", "kimi-code", "known", "kimi2", false],
			["go", "opencode-go", "known", "opencode", false],
			["ds", "deepseek", "known", "deepseek", false],
			["oai", "openai", "known", "openai", false],
			["ant", "anthropic", "known", "claude", false],
			["gem", "gemini", "known", "gemini", false],
			["relay", "openai-compatible", "api", "relay", true],
			["moon", "anthropic-compatible", "api", "moonshot", false],
			["relayGem", "gemini-compatible", "api", "relaygem", false],
			["nugA", "nug", "api", "nug", false],
			["nugB", "nug", "api", "nug2", true],
			[`${pluginId}/demo`, "plugin", "api", "demo", false],
		]);

		expect(getSourceGroup("kimiCn")).toEqual({
			id: "kimiCn",
			templateId: "kimi-code",
			kind: "known",
			prefix: "kimi",
			name: "Name kimiCn",
			disabled: false,
			endpoint: {
				baseUrl: "https://api.kimi.com/coding/v1",
				protocol: "completions-compatible",
				region: "china",
			},
		});
		expect(getSourceGroup("kimiIntl")?.endpoint.region).toBe("international");
		expect(getSourceGroup("relay")?.endpoint).toEqual({
			baseUrl: "https://relay.example/v1",
			protocol: "openai-responses",
		});
		expect(getSourceGroup("nugA")?.endpoint).toEqual({ baseUrl: "http://127.0.0.1:7790" });
		expect(getSourceGroup("CommandCode")).toMatchObject({
			name: "Command Code",
			endpoint: { baseUrl: "https://cc.example" },
		});
		expect(getSourceGroupByPrefix("demo")?.name).toBe("Plugin demo");
		expect(getSourceGroupByPrefix("opencode")?.id).toBe("go");
		expect(getSourceGroup("missing")).toBeUndefined();
		expect(getSourceGroupByPrefix("missing")).toBeUndefined();
	});

	test("the view is cached until settings or the plugin registry change", () => {
		saveSettings({
			...settings,
			customApiProviders: [custom("a", "a", "https://relay.example/v1", "openai-responses")],
		});
		const first = listSourceGroups();
		expect(listSourceGroups()).toBe(first);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(getSourceGroup("a"))).toBe(true);

		saveSettings({
			...settings,
			customApiProviders: [
				custom("a", "a", "https://api.deepseek.com", "completions-compatible", { name: "Renamed" }),
			],
		});
		const afterSave = listSourceGroups();
		expect(afterSave).not.toBe(first);
		expect(getSourceGroup("a")).toMatchObject({ templateId: "deepseek", name: "Renamed" });

		registerPlugin("late", "late");
		expect(listSourceGroups()).not.toBe(afterSave);
		expect(getSourceGroupByPrefix("late")?.disabled).toBe(false);

		pluginProviderRegistry.disablePlugin(pluginId);
		expect(getSourceGroupByPrefix("late")?.disabled).toBe(true);

		pluginProviderRegistry.setProviderPrefix(`${pluginId}/late`, "later");
		expect(getSourceGroupByPrefix("late")).toBeUndefined();
		expect(getSourceGroupByPrefix("later")?.id).toBe(`${pluginId}/late`);

		pluginProviderRegistry.removePlugin(pluginId);
		expect(getSourceGroup(`${pluginId}/late`)).toBeUndefined();
	});
});
