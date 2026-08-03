import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { NarraForkSettings, SearchChannelConfig } from "../../settings/types";
import {
	areExtraSearchChannelsReady,
	clearExtraSearchChannelSources,
	type ExtraSearchChannel,
	type ExtraSearchChannelSource,
	executeExtraSearchChannel,
	findExtraSearchChannel,
	listExtraSearchChannels,
	markExtraSearchChannelsReady,
	registerExtraSearchChannelSource,
} from "../plugin-source";
import {
	normalizeSearchSettings,
	pluginSearchChannelId,
	SEARCH_NATIVE_CHANNEL_ID,
	SEARCH_SUBAGENT_CHANNEL_ID,
} from "../settings";
import type { SearchChannelResult, SearchRequest } from "../types";

const PLUGIN_ID = "com.example.searcher";
const CONTRIBUTION_ID = "web-search";
const CHANNEL_ID = pluginSearchChannelId(PLUGIN_ID, CONTRIBUTION_ID);

function makeSettings(channels: SearchChannelConfig[] = []): NarraForkSettings {
	// `normalizeSearchSettings` only reads `nugProviders`/`codex` and writes `search`.
	return {
		nugProviders: [],
		search: { channels, customProviders: [] },
	} as unknown as NarraForkSettings;
}

function stubSource(
	channels: ExtraSearchChannel[],
	execute?: ExtraSearchChannelSource["execute"],
): ExtraSearchChannelSource {
	return {
		listChannels: () => channels,
		execute:
			execute ??
			(async (channelId) => ({
				channelId,
				channelLabel: "stub",
				text: "stub result",
			})),
	};
}

function pluginChannel(overrides: Partial<ExtraSearchChannel> = {}): ExtraSearchChannel {
	return { id: CHANNEL_ID, label: "Example search", available: true, ...overrides };
}

// The source registry and its readiness flag are module-level state shared across every suite in
// the process, so reset before as well as after: another file may have flipped readiness before
// this one runs, and these tests distinguish "not loaded yet" from "loaded and absent".
beforeEach(() => {
	clearExtraSearchChannelSources();
});

afterEach(() => {
	clearExtraSearchChannelSources();
});

describe("extra search channel registry", () => {
	test("registering a source does not by itself make enumeration authoritative", () => {
		// A source is wired up when the platform graph is constructed, but its registry stays
		// empty until the contribution catalog is reconciled. Treating registration as "loaded"
		// would reopen the startup window this flag exists to close.
		//
		expect(areExtraSearchChannelsReady()).toBe(false);
		registerExtraSearchChannelSource("plugins", stubSource([]));
		expect(areExtraSearchChannelsReady()).toBe(false);
		markExtraSearchChannelsReady();
		expect(areExtraSearchChannelsReady()).toBe(true);
	});

	test("enumerates channels from every registered source", () => {
		registerExtraSearchChannelSource("a", stubSource([pluginChannel()]));
		registerExtraSearchChannelSource(
			"b",
			stubSource([pluginChannel({ id: "plugin:other:s", label: "Other" })]),
		);
		expect(listExtraSearchChannels().map((channel) => channel.id)).toEqual([
			CHANNEL_ID,
			"plugin:other:s",
		]);
	});

	test("registering the same name replaces rather than stacks", () => {
		registerExtraSearchChannelSource("a", stubSource([pluginChannel()]));
		registerExtraSearchChannelSource("a", stubSource([pluginChannel({ label: "Renamed" })]));
		const channels = listExtraSearchChannels();
		expect(channels).toHaveLength(1);
		expect(channels[0].label).toBe("Renamed");
	});

	test("the disposer withdraws only its own source", () => {
		const dispose = registerExtraSearchChannelSource("a", stubSource([pluginChannel()]));
		registerExtraSearchChannelSource(
			"b",
			stubSource([pluginChannel({ id: "plugin:other:s", label: "Other" })]),
		);
		dispose();
		expect(listExtraSearchChannels().map((channel) => channel.id)).toEqual(["plugin:other:s"]);
	});

	test("a source that throws does not hide the others", () => {
		// This is the whole point of the try/catch: enumeration feeds the catalog that
		// decides whether web search is available at all, so one broken plugin must not
		// blank the list.
		registerExtraSearchChannelSource("broken", {
			listChannels: () => {
				throw new Error("registry exploded");
			},
			execute: async () => {
				throw new Error("unreachable");
			},
		});
		registerExtraSearchChannelSource("healthy", stubSource([pluginChannel()]));
		expect(listExtraSearchChannels().map((channel) => channel.id)).toEqual([CHANNEL_ID]);
	});

	test("dispatches to the source that owns the channel", async () => {
		let seen: SearchRequest | undefined;
		registerExtraSearchChannelSource("a", stubSource([pluginChannel({ id: "plugin:a:s" })]));
		registerExtraSearchChannelSource(
			"b",
			stubSource([pluginChannel()], async (channelId, request): Promise<SearchChannelResult> => {
				seen = request;
				return { channelId, channelLabel: "b", text: "from b" };
			}),
		);
		const result = await executeExtraSearchChannel(
			CHANNEL_ID,
			{ query: "hello" },
			new AbortController().signal,
		);
		expect(result.text).toBe("from b");
		expect(seen?.query).toBe("hello");
	});

	test("an unowned channel id fails loudly", async () => {
		registerExtraSearchChannelSource("a", stubSource([pluginChannel()]));
		await expect(
			executeExtraSearchChannel("plugin:ghost:s", { query: "x" }, new AbortController().signal),
		).rejects.toThrow(/No registered source owns/);
	});

	test("finds a channel by id", () => {
		registerExtraSearchChannelSource("a", stubSource([pluginChannel({ available: false })]));
		expect(findExtraSearchChannel(CHANNEL_ID)?.available).toBe(false);
		expect(findExtraSearchChannel("plugin:missing:s")).toBeUndefined();
	});
});

describe("plugin channels in the settings catalog", () => {
	test("a registered plugin channel joins the catalog before the subagent", () => {
		registerExtraSearchChannelSource("plugins", stubSource([pluginChannel()]));
		const settings = makeSettings();
		normalizeSearchSettings(settings);
		const ids = (settings.search?.channels ?? []).map((channel) => channel.id);
		expect(ids).toContain(CHANNEL_ID);
		expect(ids.indexOf(CHANNEL_ID)).toBeLessThan(ids.indexOf(SEARCH_SUBAGENT_CHANNEL_ID));
		const channel = settings.search?.channels?.find((item) => item.id === CHANNEL_ID);
		expect(channel?.kind).toBe("plugin");
	});

	test("an uninstalled plugin's saved channel is dropped once enumeration is authoritative", () => {
		// No source registered AND enumeration declared complete, so the absence is real.
		markExtraSearchChannelsReady();
		const settings = makeSettings([
			{ id: SEARCH_NATIVE_CHANNEL_ID, kind: "native", enabled: true },
			{ id: CHANNEL_ID, kind: "plugin", enabled: true },
		]);
		normalizeSearchSettings(settings);
		expect((settings.search?.channels ?? []).map((channel) => channel.id)).not.toContain(
			CHANNEL_ID,
		);
	});

	test("a saved plugin channel survives normalization before the registry has loaded", () => {
		// The startup window: `settings` is built during module load, and the plugin registry is
		// filled asynchronously afterwards. Dropping the entry here would discard the user's
		// enabled flag and fallback position, and normalizeSearchSettings reporting a change
		// would persist that loss to disk.
		//
		const settings = makeSettings([
			{ id: CHANNEL_ID, kind: "plugin", enabled: false },
			{ id: SEARCH_NATIVE_CHANNEL_ID, kind: "native", enabled: true },
			{ id: SEARCH_SUBAGENT_CHANNEL_ID, kind: "subagent", enabled: false, maxTurns: 4 },
		]);
		normalizeSearchSettings(settings);
		const channels = settings.search?.channels ?? [];
		expect(channels[0]?.id).toBe(CHANNEL_ID);
		expect(channels[0]?.enabled).toBe(false);
		// Idempotent: the preserved entry never provokes a settings write of its own. (The first
		// pass does report a change, because it fills in the default timeout/output fields.)
		expect(normalizeSearchSettings(settings)).toBe(false);
	});

	test("a disabled plugin channel is still disabled after the registry loads late", () => {
		// End-to-end of the restart bug: user turns the channel off, the server restarts, and the
		// plugin platform registers only after settings are already in memory.
		const settings = makeSettings([
			{ id: SEARCH_NATIVE_CHANNEL_ID, kind: "native", enabled: true },
			{ id: CHANNEL_ID, kind: "plugin", enabled: false },
		]);
		normalizeSearchSettings(settings);
		registerExtraSearchChannelSource("plugins", stubSource([pluginChannel()]));
		markExtraSearchChannelsReady();
		normalizeSearchSettings(settings);
		const channel = settings.search?.channels?.find((item) => item.id === CHANNEL_ID);
		expect(channel?.enabled).toBe(false);
	});

	test("a channel preserved before readiness is reported unavailable, never dispatched", () => {
		// Preserving the row must not make it look usable: with no source registered there is
		// nothing to dispatch to, so the router has to skip it.
		const settings = makeSettings([{ id: CHANNEL_ID, kind: "plugin", enabled: true }]);
		normalizeSearchSettings(settings);
		const channel = settings.search?.channels?.find((item) => item.id === CHANNEL_ID);
		expect(channel).toBeDefined();
		expect(findExtraSearchChannel(CHANNEL_ID)).toBeUndefined();
	});

	test("a saved plugin channel keeps its user-chosen position and enabled flag", () => {
		registerExtraSearchChannelSource("plugins", stubSource([pluginChannel()]));
		const settings = makeSettings([
			{ id: CHANNEL_ID, kind: "plugin", enabled: false },
			{ id: SEARCH_NATIVE_CHANNEL_ID, kind: "native", enabled: true },
		]);
		normalizeSearchSettings(settings);
		const channels = settings.search?.channels ?? [];
		expect(channels[0]?.id).toBe(CHANNEL_ID);
		expect(channels[0]?.enabled).toBe(false);
	});

	test("an unavailable plugin channel still appears, so the user can see it", () => {
		// Availability is a runtime property, not a reason to hide the row: a channel whose
		// credential is missing must remain visible and reorderable.
		registerExtraSearchChannelSource("plugins", stubSource([pluginChannel({ available: false })]));
		const settings = makeSettings();
		normalizeSearchSettings(settings);
		expect((settings.search?.channels ?? []).map((channel) => channel.id)).toContain(CHANNEL_ID);
	});

	test("catalog construction never dispatches a search", () => {
		// The hard constraint from `plugin-source.ts`: `getNormalizedSearchChannels()` runs on
		// every tool execution, so building the catalog must not reach a plugin.
		registerExtraSearchChannelSource(
			"plugins",
			stubSource([pluginChannel()], async () => {
				throw new Error("execute must not run during enumeration");
			}),
		);
		const settings = makeSettings();
		expect(() => normalizeSearchSettings(settings)).not.toThrow();
	});
});
