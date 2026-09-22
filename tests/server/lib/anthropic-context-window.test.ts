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
import type { AnthropicProviderConfig } from "../../../server/lib/settings";
import { resolveModelContextWindow, saveSettings, settings } from "../../../server/lib/settings";

/**
 * Regression tests for the "custom context window has no effect" report.
 *
 * A ClaudeCode-relay provider (protocol `anthropic-official` → officialApi=true)
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

	test("unknown model falls back to 128k and reports fallback", () => {
		expect(resolveModelContextWindow("totally-unknown-model", "relay")).toEqual({
			contextWindow: 128_000,
			source: "fallback",
		});
	});
});
