import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeAutoContinuationMode } from "../../../server/lib/boolean-override";
import { getModelOverride, replaceModelOverridesForTests } from "../../../server/lib/model-catalog";
import { getNarraforkHome } from "../../../server/lib/narrafork-home";
import {
	deepMerge,
	getDefaults,
	settings as liveSettings,
	type McpServerConfig,
	normalizeMcpServerIds,
	parseSettingsText,
	reloadSettings,
	saveSettings,
	stripObsoleteSettingsKeys,
} from "../../../server/lib/settings";
import { StartupError } from "../../../server/lib/startup-status/startup-error";

/** A provider entry's own window, held in the catalog's overrides file. */
const ownWindow = (model: string) => getModelOverride("connection", model)?.contextWindow;

/** TokenDance 的连接记录现在存在平台实例自己的 config 上。 */
function tokenDanceInstance(config: Record<string, unknown>) {
	return {
		id: "platform-tokendance",
		platform: "tokendance" as const,
		suffix: "",
		prefix: "tokendance",
		disabled: false,
		config,
	};
}

const tokenDanceConfig = (value: typeof liveSettings) =>
	value.agent.platformInstances?.find((instance) => instance.platform === "tokendance")?.config as
		| { modelCollectionInitialized?: boolean; models?: unknown }
		| undefined;

describe("TokenDance collection persistence", () => {
	it("initializes legacy connections once and preserves manual choices across save and reload", () => {
		const path = resolve(getNarraforkHome(), "settings.json");
		const original = readFileSync(path, "utf8");
		const snapshot = structuredClone(liveSettings);
		const restoreOverrides = replaceModelOverridesForTests({});
		try {
			const raw = getDefaults();
			(raw.agent as Record<string, unknown>).platformInstances = [
				tokenDanceInstance({ apiKey: "collection-test-key", disabled: false, generation: 4 }),
			];
			raw.agent.hiddenModels = [];
			// A pre-catalog file: its window map is imported as the entry's own window.
			(raw.agent as Record<string, unknown>).modelContextWindows = { "tokendance:glm-5": 64000 };
			writeFileSync(path, JSON.stringify(raw));
			const loaded = reloadSettings();
			expect(tokenDanceConfig(loaded)?.modelCollectionInitialized).toBe(true);
			expect(loaded.agent.hiddenModels).toHaveLength(66);
			expect(loaded.agent.hiddenModels).not.toContain("tokendance:kimi-k3");
			expect(loaded.agent.hiddenModels).toContain("tokendance:glm-5");
			expect(ownWindow("tokendance:glm-5")).toBe(64000);
			expect(loaded.agent.modelCatalog).toEqual({ autoUpdate: true });
			const edited = structuredClone(loaded);
			edited.agent.hiddenModels = edited.agent.hiddenModels?.filter(
				(id) => id !== "tokendance:glm-5",
			);
			edited.agent.hiddenModels?.push("tokendance:kimi-k3");
			edited.agent.platformInstances = [
				tokenDanceInstance({
					apiKey: "collection-test-key",
					disabled: false,
					generation: 4,
					modelCollectionInitialized: true,
					models: [
						{
							id: "future-new-model",
							name: "Future",
							context_length: 64000,
							supported_protocols: ["openai:responses"],
						},
					],
				}),
			];
			saveSettings(edited);
			const again = reloadSettings();
			expect(again.agent.hiddenModels).not.toContain("tokendance:glm-5");
			expect(again.agent.hiddenModels).toContain("tokendance:kimi-k3");
			expect(again.agent.hiddenModels).not.toContain("tokendance:future-new-model");
			expect(ownWindow("tokendance:glm-5")).toBe(64000);
			// 实例化之后，模型采集标记属于实例自己的 config，不再是全局 tokendance 字段。
			const persisted = JSON.parse(readFileSync(path, "utf8")) as {
				agent: { platformInstances: Array<{ config: { modelCollectionInitialized?: boolean } }> };
			};
			expect(persisted.agent.platformInstances[0]?.config.modelCollectionInitialized).toBe(true);
		} finally {
			saveSettings(snapshot);
			writeFileSync(path, original);
			restoreOverrides();
		}
	});

	it("first connection save initializes visibility without waiting for a catalog refresh", () => {
		const snapshot = structuredClone(liveSettings);
		try {
			const fresh = getDefaults();
			fresh.agent.platformInstances = [
				tokenDanceInstance({ apiKey: "collection-test-key", disabled: false, generation: 1 }),
			];
			saveSettings(fresh);
			expect(tokenDanceConfig(liveSettings)?.modelCollectionInitialized).toBe(true);
			expect(liveSettings.agent.hiddenModels).toContain("tokendance:glm-5");
			expect(liveSettings.agent.hiddenModels).not.toContain("tokendance:glm-5.3");
		} finally {
			saveSettings(snapshot);
		}
	});
});

describe("MCP server IDs from raw settings", () => {
	it("repairs missing, non-string, empty and duplicate IDs without losing configurations", () => {
		const settings = getDefaults();
		const raw = [undefined, 42, "", "   ", "existing", "existing"].map((id, index) => ({
			...(id !== undefined && { id }),
			name: `server-${index}`,
			transport: "stdio" as const,
			command: "demo",
			env: { TOKEN: "keep-secret" },
			enabled: false,
		}));
		settings.mcpServers = structuredClone(raw) as McpServerConfig[];
		expect(normalizeMcpServerIds(settings)).toBe(true);
		const ids = settings.mcpServers.map((server) => server.id);
		expect(ids.every((id) => typeof id === "string" && id.trim().length > 0)).toBe(true);
		expect(new Set(ids).size).toBe(raw.length);
		expect(ids[4]).toBe("existing");
		for (const [index, server] of settings.mcpServers.entries()) {
			expect(server).toEqual({ ...raw[index], id: ids[index], mode: "disabled" });
		}
		expect(normalizeMcpServerIds(settings)).toBe(false);
		expect(settings.mcpServers.map((server) => server.id)).toEqual(ids);
	});

	it("repairs legacy files on load and raw edits on save, persisting stable IDs", () => {
		// tests/preload.ts points this directory at an isolated test home.
		const path = resolve(getNarraforkHome(), "settings.json");
		const original = readFileSync(path, "utf8");
		const snapshot = structuredClone(liveSettings);
		try {
			const raw = {
				...getDefaults(),
				mcpServers: [{ name: "intellij-index", transport: "stdio", enabled: false }],
			};
			writeFileSync(path, JSON.stringify(raw));
			const loaded = reloadSettings();
			const id = loaded.mcpServers?.[0].id;
			expect(typeof id).toBe("string");
			expect(id?.length).toBeGreaterThan(0);
			expect(JSON.parse(readFileSync(path, "utf8")).mcpServers[0].id).toBe(id);
			expect(reloadSettings().mcpServers?.[0].id).toBe(id);

			const edited = { ...raw, mcpServers: [{ ...raw.mcpServers[0], id: 123 }] };
			saveSettings(edited as unknown as typeof loaded);
			const savedId = liveSettings.mcpServers?.[0].id;
			expect(typeof savedId).toBe("string");
			expect(savedId?.length).toBeGreaterThan(0);
			expect(JSON.parse(readFileSync(path, "utf8")).mcpServers[0].id).toBe(savedId);
			expect(reloadSettings().mcpServers?.[0].id).toBe(savedId);
		} finally {
			saveSettings(snapshot);
			writeFileSync(path, original);
		}
	});

	it("leaves absent MCP settings untouched", () => {
		const settings = getDefaults();
		delete settings.mcpServers;
		expect(normalizeMcpServerIds(settings)).toBe(false);
		expect(settings.mcpServers).toBeUndefined();
	});
});

describe("settings deepMerge", () => {
	it("merges nested objects", () => {
		const defaults = { server: { port: 7778 }, agent: { model: "claude" } };
		const overrides = { server: { port: 9000 } };
		const result = deepMerge(defaults, overrides);
		expect(result.server.port).toBe(9000);
		expect(result.agent.model).toBe("claude");
	});

	it("does not merge arrays", () => {
		const defaults = { items: [1, 2] };
		const overrides = { items: [3] };
		const result = deepMerge(defaults, overrides);
		expect(result.items).toEqual([3]);
	});

	it("preserves defaults for missing keys", () => {
		const defaults = { a: { x: 1, y: 2 }, b: "hello" };
		const overrides = { a: { x: 10 } };
		const result = deepMerge(defaults, overrides);
		expect(result.a.x).toBe(10);
		expect(result.a.y).toBe(2);
		expect(result.b).toBe("hello");
	});

	it("ignores unknown top-level keys", () => {
		const defaults = { a: 1 };
		const overrides = { a: 2, unknown: "foo" };
		const result = deepMerge(defaults, overrides);
		expect(result.a).toBe(2);
		// biome-ignore lint/suspicious/noExplicitAny: test utility cast
		expect((result as any).unknown).toBe("foo");
	});
});

describe("stable single-copy block defaults migration", () => {
	it("defaults to block reads/writes and one body copy", () => {
		expect(getDefaults().narratorBlocks).toEqual({
			write: true,
			read: true,
			compactJson: true,
			singleCopyDefaultsVersion: 1,
			singleCopyBackfillResumeVersion: 0,
		});
	});

	it("upgrades persisted rollout switches once without a UI visit and preserves later rollbacks", () => {
		const path = resolve(getNarraforkHome(), "settings.json");
		const original = readFileSync(path, "utf8");
		const snapshot = structuredClone(liveSettings);
		try {
			for (const narratorBlocks of [
				undefined,
				{ write: true, read: true, compactJson: false },
				{ write: false, read: false, compactJson: false, singleCopyDefaultsVersion: 0 },
			]) {
				writeFileSync(path, JSON.stringify({ ...getDefaults(), narratorBlocks }));
				expect(reloadSettings().narratorBlocks).toEqual(getDefaults().narratorBlocks);
				expect(JSON.parse(readFileSync(path, "utf8")).narratorBlocks).toEqual(
					getDefaults().narratorBlocks,
				);
				const migrated = readFileSync(path, "utf8");
				reloadSettings();
				expect(readFileSync(path, "utf8")).toBe(migrated);
			}
			const rollback = structuredClone(liveSettings);
			rollback.narratorBlocks.write = false;
			rollback.narratorBlocks.read = false;
			rollback.narratorBlocks.compactJson = false;
			saveSettings(rollback);
			expect(reloadSettings().narratorBlocks).toEqual({
				write: false,
				read: false,
				compactJson: false,
				singleCopyDefaultsVersion: 1,
				singleCopyBackfillResumeVersion: 0,
			});
		} finally {
			saveSettings(snapshot);
			writeFileSync(path, original);
		}
	});
});

describe("auto-continuation defaults", () => {
	it("uses protected-only mode when no value has been configured", () => {
		expect(getDefaults().agent.autoContinuationMode).toBe("protectedOnly");
		expect(normalizeAutoContinuationMode(undefined)).toBe("protectedOnly");
	});
});

describe("stripObsoleteSettingsKeys", () => {
	it("removes pruning settings while preserving custom compaction thresholds", () => {
		const value: Record<string, unknown> = {
			agent: {
				defaultPruneEnabled: true,
				minPruneRatio: 50,
				autoCompactPruneThreshold: 80,
				contextThresholds: {
					standard: { pruneStart: 90, compactStart: 92 },
					large: { pruneStart: 70, compactStart: 82 },
				},
			},
		};
		expect(stripObsoleteSettingsKeys(value)).toBe(true);
		expect(value.agent).toEqual({
			contextThresholds: { standard: { compactStart: 92 }, large: { compactStart: 82 } },
		});
		expect(stripObsoleteSettingsKeys(value)).toBe(false);
	});

	it("loads and saves old files without reviving pruning settings", () => {
		const path = resolve(getNarraforkHome(), "settings.json");
		const original = readFileSync(path, "utf8");
		const snapshot = structuredClone(liveSettings);
		const raw = getDefaults();
		const legacyAgent = {
			...raw.agent,
			defaultPruneEnabled: true,
			minPruneRatio: 50,
			autoCompactPruneThreshold: 80,
			contextThresholds: {
				standard: { pruneStart: 90, compactStart: 91 },
				large: { pruneStart: 70, compactStart: 81 },
			},
		};
		try {
			writeFileSync(path, JSON.stringify({ ...raw, agent: legacyAgent }));
			for (const save of [false, true]) {
				if (save) saveSettings({ ...raw, agent: structuredClone(legacyAgent) });
				const loaded = reloadSettings();
				expect(loaded.agent.contextThresholds).toEqual({
					standard: { compactStart: 91 },
					large: { compactStart: 81 },
				});
				const persisted = JSON.parse(readFileSync(path, "utf8"));
				for (const agent of [loaded.agent, persisted.agent]) {
					expect(agent).not.toHaveProperty("defaultPruneEnabled");
					expect(agent).not.toHaveProperty("minPruneRatio");
					expect(agent).not.toHaveProperty("autoCompactPruneThreshold");
					expect(agent.contextThresholds.standard).not.toHaveProperty("pruneStart");
					expect(agent.contextThresholds.large).not.toHaveProperty("pruneStart");
				}
			}
		} finally {
			saveSettings(snapshot);
			writeFileSync(path, original);
		}
	});

	it("removes the retired message protocol switch and keeps the other block settings", () => {
		const value: Record<string, unknown> = {
			narratorBlocks: { write: true, read: true, wsV2: false, compactJson: true },
		};
		expect(stripObsoleteSettingsKeys(value)).toBe(true);
		expect(value.narratorBlocks).toEqual({ write: true, read: true, compactJson: true });
		expect(stripObsoleteSettingsKeys(value)).toBe(false);
		expect(getDefaults().narratorBlocks).not.toHaveProperty("wsV2");
	});

	it("defaults expose compaction thresholds only", () => {
		expect(getDefaults().agent.contextThresholds).toEqual({
			standard: { compactStart: 95 },
			large: { compactStart: 75 },
		});
	});

	it("reports unchanged when no obsolete keys are present", () => {
		const value: Record<string, unknown> = { customApiProviders: [] };

		expect(stripObsoleteSettingsKeys(value)).toBe(false);
		expect(value).toEqual({ customApiProviders: [] });
	});
});

describe("parseSettingsText", () => {
	it("accepts the comments and trailing commas of a hand-edited file", () => {
		const text = '{\n\t// moved to 7780\n\t"server": { "port": 7780, },\n\t/* old */\n}';
		expect(parseSettingsText(text)).toEqual({ server: { port: 7780 } });
	});

	it("names the file and the reason when it cannot be read", () => {
		let error: unknown;
		try {
			parseSettingsText('{ "server": { "port": 7780 ');
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(StartupError);
		const { message, command } = (error as StartupError).problem;
		expect(message.en).toContain("settings.json is not valid JSON");
		expect(message.en).not.toContain("JSONC Parse error");
		expect(command).toContain("settings.json");
	});

	it("rejects a file whose top level is not an object", () => {
		for (const text of ["[]", "null", "42"]) {
			expect(() => parseSettingsText(text)).toThrow(/top level must be an object/);
		}
	});
});
