import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	getAnthropicEffectiveContextWindow,
	supportsAnthropic1mContext,
} from "../../../server/lib/agent/anthropic-provider";
import type { AnthropicProviderConfig } from "../../../server/lib/settings";
import { resolveModelContextWindow, settings } from "../../../server/lib/settings";

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
	});

	afterEach(() => {
		restoreFromSnapshot(snapshot);
	});

	test("per-model user override wins over the official 1M floor", () => {
		settings.agent.modelContextWindows = { "relay:claude-opus-5": 500_000 };
		// Sanity: this model is on the 1M capability list, so the floor would apply.
		expect(supportsAnthropic1mContext("claude-opus-5")).toBe(true);
		expect(getAnthropicEffectiveContextWindow("claude-opus-5", anthropicConfig())).toBe(500_000);
	});

	test("provider defaultContextWindow wins over the official 1M floor", () => {
		const config = anthropicConfig({ defaultContextWindow: 400_000 });
		settings.anthropicProviders = [config];
		expect(getAnthropicEffectiveContextWindow("claude-opus-5", config)).toBe(400_000);
	});

	test("a user override larger than 1M is kept as-is", () => {
		settings.agent.modelContextWindows = { "relay:claude-opus-5": 2_000_000 };
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
		settings.agent.modelContextWindows = { "relay:claude-opus-5": 300_000 };
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
	});

	afterEach(() => {
		restoreFromSnapshot(snapshot);
	});

	test("user override is reported as user", () => {
		settings.agent.modelContextWindows = { "relay:claude-opus-5": 500_000 };
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
