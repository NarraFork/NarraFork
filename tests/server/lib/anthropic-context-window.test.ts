import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	getAnthropicEffectiveContextWindow,
	supportsAnthropic1mContext,
} from "../../../server/lib/agent/anthropic-provider";
import {
	bindModelCatalogSettings,
	getModelCatalogSnapshot,
	mutateModelCatalog,
} from "../../../server/lib/model-catalog";
import { deleteNugCachedModels, setNugCachedModels } from "../../../server/lib/nug-model-cache";
import type { AnthropicProviderConfig, NUGProviderConfig } from "../../../server/lib/settings";
import {
	getModelContextWindow,
	resolveModelContextWindow,
	saveSettings,
	settings,
} from "../../../server/lib/settings";

/**
 * Regression tests for the "custom context window has no effect" report.
 *
 * A ClaudeCode-relay provider (protocol `anthropic-messages` → officialApi=true)
 * applied a hard 1M floor for every 4.6+ model, so a per-model window typed in
 * settings (e.g. 500k on a relay that really caps there) was silently raised
 * back to 1,000,000 — the narrator footer kept showing "/ 1,000,000 tokens" and
 * auto-compact triggered far too late.
 */

const settingsKeys = Object.keys(settings) as Array<keyof typeof settings>;

function cloneSettingsSnapshot() {
	return structuredClone(settings);
}

function restoreFromSnapshot(snapshot: ReturnType<typeof cloneSettingsSnapshot>): void {
	for (const key of settingsKeys) {
		// biome-ignore lint/suspicious/noExplicitAny: generic key/value restoration in test helper
		(settings as any)[key] = snapshot[key];
	}
	bindModelCatalogSettings(settings, () => saveSettings(settings));
	saveSettings(settings);
}

function resetCatalog(): void {
	// These fixtures configure the legacy provider projection. Let saveSettings
	// derive its canonical provider list instead of overwriting it with stale data.
	delete settings.customApiProviders;
	settings.agent.modelCatalog = {
		schemaVersion: 1,
		migrationVersion: 1,
		local: { revision: 0 },
		autoApply: false,
		pinnedVersion: null,
	};
	bindModelCatalogSettings(settings, () => saveSettings(settings));
}

function saveWindow(value: number): void {
	settings.agent.modelContextWindows = { "relay:claude-opus-5": value };
	// Exercise the same legacy-editor adapter as production, rather than mutating
	// archived settings behind the catalog's back and skipping its save migration.
	saveSettings(settings);
}

function anthropicConfig(
	overrides: Partial<AnthropicProviderConfig> = {},
): AnthropicProviderConfig {
	return {
		id: "relay-id",
		name: "Relay Provider",
		prefix: "relay",
		apiKey: "relay-key",
		baseUrl: "https://relay.example.test",
		defaultModel: "claude-opus-5",
		officialApi: true,
		...overrides,
	};
}

describe("Anthropic effective context window respects explicit configuration", () => {
	let snapshot: ReturnType<typeof cloneSettingsSnapshot>;

	beforeEach(() => {
		snapshot = cloneSettingsSnapshot();
		settings.anthropicProviders = [anthropicConfig()];
		settings.agent.modelContextWindows = {};
		settings.agent.modelAggregations = [];
		resetCatalog();
	});

	afterEach(() => {
		restoreFromSnapshot(snapshot);
	});

	test("per-model user override wins over the official 1M floor", () => {
		saveWindow(500_000);
		// Sanity: this model is on the 1M capability list, so the floor would apply.
		expect(supportsAnthropic1mContext("claude-opus-5")).toBe(true);
		expect(getAnthropicEffectiveContextWindow("claude-opus-5", anthropicConfig())).toBe(500_000);
	});

	test("provider defaultContextWindow wins over the official 1M floor", () => {
		const config = anthropicConfig({ defaultContextWindow: 400_000 });
		settings.anthropicProviders = [config];
		expect(getAnthropicEffectiveContextWindow("claude-opus-5", config)).toBe(400_000);
	});

	test("local model and saved binding windows outrank provider defaults; reset never re-pins archived values", () => {
		const config = anthropicConfig({ defaultContextWindow: 400_000 });
		settings.anthropicProviders = [config];
		// Refresh the canonical provider projection before catalog mutations save it.
		delete settings.customApiProviders;
		saveSettings(settings);
		const patch = (target: "model" | "binding", targetId: string, value?: number) =>
			mutateModelCatalog({
				action: "patch",
				baseRevision: getModelCatalogSnapshot().local.revision,
				target,
				targetId,
				patch:
					value === undefined
						? { reset: ["limits.contextWindow"] }
						: { set: { "limits.contextWindow": value } },
			});
		patch("model", "claude-opus-5", 600_000);
		expect(resolveModelContextWindow("claude-opus-5", "relay")).toEqual({
			contextWindow: 600_000,
			source: "card",
		});
		saveWindow(300_000);
		expect(getAnthropicEffectiveContextWindow("claude-opus-5", config)).toBe(300_000);
		patch("binding", "legacy-window:relay:claude-opus-5");
		expect(getAnthropicEffectiveContextWindow("claude-opus-5", config)).toBe(600_000);
		patch("model", "claude-opus-5");
		saveSettings(settings);
		expect(getAnthropicEffectiveContextWindow("claude-opus-5", config)).toBe(400_000);
		expect(settings.agent.modelContextWindows["relay:claude-opus-5"]).toBe(300_000);
	});

	test("a user override larger than 1M is kept as-is", () => {
		saveWindow(2_000_000);
		expect(getAnthropicEffectiveContextWindow("claude-opus-5", anthropicConfig())).toBe(2_000_000);
	});

	test("without explicit configuration the official 1M floor still applies", () => {
		// Built-in table only knows 200k for Opus 4; officialApi lifts it to 1M.
		expect(getAnthropicEffectiveContextWindow("claude-sonnet-4-20250514", anthropicConfig())).toBe(
			1_000_000,
		);
	});

	test("non-official relays never get the floor", () => {
		const config = anthropicConfig({ officialApi: false });
		settings.anthropicProviders = [config];
		// Sonnet 4.5 is a genuine 200k model and the oldest Claude still carried, so
		// it shows the floor being withheld without depending on a retired id.
		expect(getAnthropicEffectiveContextWindow("claude-sonnet-4-5", config)).toBe(200_000);
	});

	test("prefixed override keys resolve for the provider prefix", () => {
		saveWindow(300_000);
		expect(getAnthropicEffectiveContextWindow("relay:claude-opus-5", anthropicConfig())).toBe(
			300_000,
		);
	});
});

describe("resolveModelContextWindow reports where the value came from", () => {
	let snapshot: ReturnType<typeof cloneSettingsSnapshot>;

	beforeEach(() => {
		snapshot = cloneSettingsSnapshot();
		settings.anthropicProviders = [anthropicConfig()];
		settings.openaiProviders = [];
		settings.geminiProviders = [];
		settings.nugProviders = [];
		settings.agent.modelContextWindows = {};
		settings.agent.modelAggregations = [];
		resetCatalog();
	});

	afterEach(() => {
		restoreFromSnapshot(snapshot);
	});

	test("user override is reported as user", () => {
		saveWindow(500_000);
		expect(resolveModelContextWindow("claude-opus-5", "relay")).toEqual({
			contextWindow: 500_000,
			source: "user",
		});
	});

	test("provider default is reported as provider", () => {
		settings.anthropicProviders = [anthropicConfig({ defaultContextWindow: 400_000 })];
		expect(resolveModelContextWindow("claude-opus-5", "relay")).toEqual({
			contextWindow: 400_000,
			source: "provider",
		});
	});

	test("built-in table match is reported as builtin", () => {
		expect(resolveModelContextWindow("claude-sonnet-4-5", "relay")).toEqual({
			contextWindow: 200_000,
			source: "builtin",
		});
	});

	test("unknown model falls back to the default context window and reports fallback", () => {
		expect(resolveModelContextWindow("totally-unknown-model", "relay")).toEqual({
			contextWindow: 272_000,
			source: "fallback",
		});
	});
});

/**
 * Regression tests for narrafork-issue#99: a NUG anthropic delegate receives the
 * full routed id (`<channel>:<model>`, e.g. antigravity:gemini-3.8-flash-high) as
 * its model, while `config.prefix` stays the outer NUG provider prefix ("gw").
 * getAnthropicEffectiveContextWindow used to strip the first `:` segment via
 * parseModelId, dropping the channel and querying `gw:gemini-3.8-flash-high` —
 * a key present in neither the NUG cache nor the model catalog — so everything
 * fell back to the 272k default and that wrong value overrode the correct
 * top-level one in loop.ts (`parsed.usage.contextWindow ?? ...`).
 */
describe("NUG anthropic delegate keeps the channel segment in the lookup key", () => {
	let snapshot: ReturnType<typeof cloneSettingsSnapshot>;

	const nugConfig: NUGProviderConfig = {
		id: "nug-gw",
		name: "NUG Gateway",
		prefix: "gw",
		apiKey: "nug-key",
		baseUrl: "https://nug.example.test",
		defaultModel: "antigravity:gemini-3.8-flash-high",
	};

	// Mirror buildNugDelegateBaseConfig: the delegate gets the NUG provider's
	// prefix, and the routed model id as its model/defaultModel.
	const delegateConfig: AnthropicProviderConfig = {
		id: nugConfig.id,
		name: nugConfig.name,
		prefix: nugConfig.prefix,
		apiKey: nugConfig.apiKey,
		baseUrl: nugConfig.baseUrl,
		defaultModel: nugConfig.defaultModel,
		officialApi: false,
	};

	beforeEach(() => {
		snapshot = cloneSettingsSnapshot();
		settings.nugProviders = [nugConfig];
		settings.anthropicProviders = [anthropicConfig()];
		settings.agent.modelContextWindows = {};
		settings.agent.modelAggregations = [];
		resetCatalog();
		setNugCachedModels(nugConfig.id, [
			{
				id: "antigravity:gemini-3.8-flash-high",
				channel: "antigravity",
				channelType: "anthropic",
				model: "gemini-3.8-flash-high",
				contextLength: 1_048_576,
			},
		]);
	});

	afterEach(() => {
		deleteNugCachedModels(nugConfig.id);
		restoreFromSnapshot(snapshot);
	});

	test("delegate resolves the gateway-reported window, not the 272k fallback", () => {
		// The top-level loop queries with the full prefixed id and gets it right.
		expect(getModelContextWindow("gw:antigravity:gemini-3.8-flash-high", "gw")).toBe(1_048_576);
		// The delegate must now land on the same value instead of the fallback.
		expect(
			getAnthropicEffectiveContextWindow("antigravity:gemini-3.8-flash-high", delegateConfig),
		).toBe(1_048_576);
	});

	test("delegate result matches the top-level query for the same model", () => {
		const topLevel = resolveModelContextWindow("gw:antigravity:gemini-3.8-flash-high", "gw");
		expect(
			getAnthropicEffectiveContextWindow("antigravity:gemini-3.8-flash-high", delegateConfig),
		).toBe(topLevel.contextWindow);
	});

	test("per-model user override keyed on the full id applies on the delegate path", () => {
		settings.agent.modelContextWindows = {
			"gw:antigravity:gemini-3.8-flash-high": 700_000,
		};
		saveSettings(settings);
		expect(
			getAnthropicEffectiveContextWindow("antigravity:gemini-3.8-flash-high", delegateConfig),
		).toBe(700_000);
	});

	test("direct anthropic providers with bare model ids are unaffected", () => {
		// No colon in the model id: nothing to strip before, nothing stripped now.
		expect(getAnthropicEffectiveContextWindow("totally-unknown-model", anthropicConfig())).toBe(
			272_000,
		);
	});
});
