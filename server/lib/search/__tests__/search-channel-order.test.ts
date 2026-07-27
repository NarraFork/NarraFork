import { describe, expect, test } from "bun:test";
import type {
	CustomSearchProviderConfig,
	NarraForkSettings,
	NUGProviderConfig,
	SearchChannelConfig,
} from "../../settings/types";
import {
	customSearchChannelId,
	normalizeSearchSettings,
	nugSearchChannelId,
	SEARCH_NATIVE_CHANNEL_ID,
	SEARCH_SUBAGENT_CHANNEL_ID,
} from "../settings";

function makeSettings(options: {
	channels?: SearchChannelConfig[];
	customProviders?: CustomSearchProviderConfig[];
	nugProviders?: NUGProviderConfig[];
}): NarraForkSettings {
	// normalizeSearchSettings only reads `nugProviders` / `codex` and writes
	// `search`, so a partial object is enough for these tests.
	return {
		nugProviders: options.nugProviders ?? [],
		search: {
			channels: options.channels ?? [],
			customProviders: options.customProviders ?? [],
		},
	} as unknown as NarraForkSettings;
}

function customProvider(id: string): CustomSearchProviderConfig {
	return {
		id,
		name: `Provider ${id}`,
		protocol: "zhipu-web-search-v1",
		baseUrl: "https://example.test/search",
		apiKey: "key",
	};
}

function channelIds(settings: NarraForkSettings): string[] {
	return (settings.search?.channels ?? []).map((channel) => channel.id);
}

describe("normalizeSearchSettings channel order", () => {
	test("keeps the saved channel order instead of the catalog order", () => {
		const providerId = "abc123";
		const settings = makeSettings({
			customProviders: [customProvider(providerId)],
			channels: [
				{ id: customSearchChannelId(providerId), kind: "custom-api", enabled: true, providerId },
				{ id: SEARCH_SUBAGENT_CHANNEL_ID, kind: "subagent", enabled: false },
				{ id: SEARCH_NATIVE_CHANNEL_ID, kind: "native", enabled: true },
			],
		});

		normalizeSearchSettings(settings);

		expect(channelIds(settings)).toEqual([
			customSearchChannelId(providerId),
			SEARCH_SUBAGENT_CHANNEL_ID,
			SEARCH_NATIVE_CHANNEL_ID,
		]);
	});

	test("order survives a save/reload round trip", () => {
		const settings = makeSettings({
			channels: [
				{ id: SEARCH_NATIVE_CHANNEL_ID, kind: "native", enabled: false },
				{ id: SEARCH_SUBAGENT_CHANNEL_ID, kind: "subagent", enabled: false },
			],
		});

		normalizeSearchSettings(settings);
		const first = channelIds(settings);
		// Second pass simulates saveSettings() → loadSettings() normalizing again.
		const changedOnSecondPass = normalizeSearchSettings(settings);

		expect(changedOnSecondPass).toBe(false);
		expect(channelIds(settings)).toEqual(first);
	});

	test("appends newly available channels without disturbing saved order", () => {
		const settings = makeSettings({
			nugProviders: [
				{ id: "nug1", name: "NUG One", baseUrl: "https://nug.test", apiKey: "k" },
			] as NUGProviderConfig[],
			channels: [
				{ id: SEARCH_SUBAGENT_CHANNEL_ID, kind: "subagent", enabled: false },
				{ id: SEARCH_NATIVE_CHANNEL_ID, kind: "native", enabled: true },
			],
		});

		normalizeSearchSettings(settings);

		expect(channelIds(settings)).toEqual([
			SEARCH_SUBAGENT_CHANNEL_ID,
			SEARCH_NATIVE_CHANNEL_ID,
			nugSearchChannelId("nug1"),
		]);
	});

	test("drops saved channels whose provider no longer exists", () => {
		const settings = makeSettings({
			channels: [
				{
					id: customSearchChannelId("gone"),
					kind: "custom-api",
					enabled: true,
					providerId: "gone",
				},
				{ id: SEARCH_NATIVE_CHANNEL_ID, kind: "native", enabled: true },
			],
		});

		normalizeSearchSettings(settings);

		expect(channelIds(settings)).not.toContain(customSearchChannelId("gone"));
		expect(channelIds(settings)[0]).toBe(SEARCH_NATIVE_CHANNEL_ID);
	});

	test("preserves per-channel settings while reordering", () => {
		const settings = makeSettings({
			channels: [
				{
					id: SEARCH_SUBAGENT_CHANNEL_ID,
					kind: "subagent",
					enabled: true,
					model: "provider:model",
					maxTurns: 7,
					timeoutMs: 90_000,
				},
				{ id: SEARCH_NATIVE_CHANNEL_ID, kind: "native", enabled: false },
			],
		});

		normalizeSearchSettings(settings);

		const subagent = settings.search?.channels.find((c) => c.id === SEARCH_SUBAGENT_CHANNEL_ID);
		expect(subagent).toMatchObject({
			enabled: true,
			model: "provider:model",
			maxTurns: 7,
			timeoutMs: 90_000,
		});
	});

	test("legacy codex.useWebSearch=false only applies when native was never saved", () => {
		const withoutSaved = makeSettings({ channels: [] });
		normalizeSearchSettings(withoutSaved, { codex: { useWebSearch: false } });
		expect(
			withoutSaved.search?.channels.find((c) => c.id === SEARCH_NATIVE_CHANNEL_ID)?.enabled,
		).toBe(false);

		const withSaved = makeSettings({
			channels: [{ id: SEARCH_NATIVE_CHANNEL_ID, kind: "native", enabled: true }],
		});
		normalizeSearchSettings(withSaved, { codex: { useWebSearch: false } });
		expect(withSaved.search?.channels.find((c) => c.id === SEARCH_NATIVE_CHANNEL_ID)?.enabled).toBe(
			true,
		);
	});
});
