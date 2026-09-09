import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeAutoContinuationMode } from "../../../server/lib/boolean-override";
import { getNarraforkHome } from "../../../server/lib/narrafork-home";
import {
	deepMerge,
	getDefaults,
	settings as liveSettings,
	type McpServerConfig,
	normalizeMcpServerIds,
	reloadSettings,
	saveSettings,
	stripObsoleteSettingsKeys,
} from "../../../server/lib/settings";

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
			expect(server).toEqual({ ...raw[index], id: ids[index] });
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

describe("auto-continuation defaults", () => {
	it("uses protected-only mode when no value has been configured", () => {
		expect(getDefaults().agent.autoContinuationMode).toBe("protectedOnly");
		expect(normalizeAutoContinuationMode(undefined)).toBe("protectedOnly");
	});
});

describe("stripObsoleteSettingsKeys", () => {
		const value: Record<string, unknown> = {
			customApiProviders: [],
			nugProviders: [],
		};

		expect(stripObsoleteSettingsKeys(value)).toBe(true);
		expect(value).toEqual({ customApiProviders: [], nugProviders: [] });
	});

		const value: Record<string, unknown> = { customApiProviders: [] };

		expect(stripObsoleteSettingsKeys(value)).toBe(false);
		expect(value).toEqual({ customApiProviders: [] });
	});
});
