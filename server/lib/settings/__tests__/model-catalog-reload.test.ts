import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getEffectiveModelProfile, getModelOverride, setModelOverride } from "../../model-catalog";
import {
	narraforkDir,
	reloadSettings,
	reloadSettingsIfChanged,
	saveSettings,
	settings,
} from "../index";

/**
 * Regression for "provider context window has no effect" after editing settings: every
 * save is followed by a hot reload (the settings-file watcher sees the write). Overrides
 * now live in the catalog's own file, so a reload must neither drop them nor resurrect an
 * inline copy, and an older file's inline layer is imported on reload as on startup.
 */
const path = join(narraforkDir, "settings.json");
const model = "anthropic:claude-sonnet-4-5";
let original: string;

beforeEach(() => {
	original = readFileSync(path, "utf8");
});
afterEach(() => {
	writeFileSync(path, original);
	reloadSettings();
	setModelOverride("connection", model, null);
	setModelOverride("model", "claude-sonnet-4-5", null);
});

function saveWindow(value: number | undefined) {
	setModelOverride("connection", model, value === undefined ? null : { contextWindow: value });
}
const ownWindow = () => getModelOverride("connection", model)?.contextWindow;

/** An older build's settings.json: overrides inline in `agent.modelCatalog.local`. */
function writeLegacyInlineLayer(window: number, extra: Record<string, unknown> = {}) {
	const stored = JSON.parse(readFileSync(path, "utf8"));
	stored.agent.modelCatalog = {
		schemaVersion: 2,
		migrationVersion: 2,
		autoApply: true,
		pinnedVersion: null,
		local: { revision: 3, connections: { [model]: { working_context_tokens: window } } },
	};
	Object.assign(stored.agent, extra);
	writeFileSync(path, JSON.stringify(stored, null, 2));
}

describe("model catalog survives hot reload", () => {
	test("provider-page windows apply, reload and re-apply; model-wide edits keep working", () => {
		const preset = getEffectiveModelProfile(model).contextWindow;
		saveWindow(77_777);
		expect(getEffectiveModelProfile(model).contextWindow).toBe(77_777);

		// What the watcher does ~300 ms after every save.
		reloadSettings();
		expect(Object.keys(settings.agent.modelCatalog ?? {})).toEqual(["autoUpdate"]);
		expect(getEffectiveModelProfile(model).contextWindow).toBe(77_777);
		expect(getEffectiveModelProfile(model).contextWindowSource?.layer).toBe("local-connection");
		expect(ownWindow()).toBe(77_777);

		// A second page edit after the reload must land, not be silently dropped.
		saveWindow(55_555);
		reloadSettings();
		expect(getEffectiveModelProfile(model).contextWindow).toBe(55_555);
		saveSettings(settings);
		const disk = JSON.parse(readFileSync(path, "utf8"));
		expect(disk.agent.modelContextWindows).toBeUndefined();
		expect(Object.keys(disk.agent.modelCatalog)).toEqual(["autoUpdate"]);

		// A model-wide override coexists with the entry's own window.
		setModelOverride("model", "claude-sonnet-4-5", { maxOutputTokens: 32_000 });
		reloadSettings();
		expect(getEffectiveModelProfile(model).maxOutputTokens).toBe(32_000);
		expect(getEffectiveModelProfile(model).contextWindow).toBe(55_555);

		saveWindow(undefined);
		reloadSettings();
		expect(getEffectiveModelProfile(model).contextWindow).toBe(preset);
	});

	test("the file watcher skips this process's own writes but not external edits", () => {
		saveWindow(44_444);
		saveSettings(settings);
		expect(reloadSettingsIfChanged()).toBe(false);
		const stored = JSON.parse(readFileSync(path, "utf8"));
		stored.agent.defaultReasoningEffort = "low";
		writeFileSync(path, JSON.stringify(stored, null, 2));
		expect(reloadSettingsIfChanged()).toBe(true);
		expect(settings.agent.defaultReasoningEffort).toBe("low");
		expect(getEffectiveModelProfile(model).contextWindow).toBe(44_444);
		expect(reloadSettingsIfChanged()).toBe(false);
	});

	test("an unreadable file keeps the running configuration instead of half-applying", () => {
		saveWindow(66_666);
		const before = structuredClone(settings.agent.modelCatalog);
		writeFileSync(path, "{ not json");
		expect(() => reloadSettings()).not.toThrow();
		expect(settings.agent.modelCatalog).toEqual(before);
		expect(getEffectiveModelProfile(model).contextWindow).toBe(66_666);
	});

	test("an older inline layer is imported on reload and only the preference stays", () => {
		writeLegacyInlineLayer(99_999);
		reloadSettings();
		expect(settings.agent.modelCatalog).toEqual({ autoUpdate: true });
		expect(ownWindow()).toBe(99_999);
		expect(getEffectiveModelProfile(model).contextWindow).toBe(99_999);
		// The rewritten file carries the preference, not the layer.
		const disk = JSON.parse(readFileSync(path, "utf8"));
		expect(disk.agent.modelCatalog).toEqual({ autoUpdate: true });
	});

	test("a pinned older catalog turns auto update off on reload as on startup", () => {
		// A pinned catalog was a request not to move.
		const stored = JSON.parse(readFileSync(path, "utf8"));
		stored.agent.modelCatalog = { schemaVersion: 2, autoApply: true, pinnedVersion: "v-old" };
		writeFileSync(path, JSON.stringify(stored, null, 2));
		reloadSettings();
		expect(settings.agent.modelCatalog).toEqual({ autoUpdate: false });
	});

	test("a window map kept beside an older catalog is imported, not discarded", () => {
		// Builds before per-entry windows kept `agent.modelContextWindows` next to the
		// catalog; where the two disagree the map is what the provider page showed.
		writeLegacyInlineLayer(88_888, { modelContextWindows: { [model]: 99_999 } });
		reloadSettings();
		expect(
			(settings.agent as { modelContextWindows?: unknown }).modelContextWindows,
		).toBeUndefined();
		expect(ownWindow()).toBe(99_999);
	});

	test("hot reload holds exactly what a cold start holds for the same file", async () => {
		writeLegacyInlineLayer(88_888);
		const fileBefore = readFileSync(path, "utf8");

		const settingsModule = pathToFileURL(join(import.meta.dir, "..", "index.ts")).href;
		const catalogModule = pathToFileURL(
			join(import.meta.dir, "..", "..", "model-catalog", "index.ts"),
		).href;
		const home = process.env.NARRAFORK_HOME;
		const child = Bun.spawn(
			[
				process.execPath,
				"--eval",
				`const { settings } = await import(${JSON.stringify(settingsModule)});
				const { getModelOverride } = await import(${JSON.stringify(catalogModule)});
				console.log("COLD=" + JSON.stringify({ catalog: settings.agent.modelCatalog, windows: settings.agent.modelContextWindows ?? null, own: getModelOverride("connection", ${JSON.stringify(model)}) ?? null }));`,
			],
			{ env: { ...process.env, NARRAFORK_HOME: home }, stdout: "pipe", stderr: "pipe" },
		);
		const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
		expect(code).toBe(0);
		const cold = JSON.parse(
			stdout
				.split("\n")
				.find((line) => line.startsWith("COLD="))!
				.slice(5),
		);

		// The cold start rewrote the file; hot reload reads the same pre-import file.
		writeFileSync(path, fileBefore);
		reloadSettings();
		expect({
			catalog: settings.agent.modelCatalog,
			windows: (settings.agent as { modelContextWindows?: unknown }).modelContextWindows ?? null,
			own: getModelOverride("connection", model) ?? null,
		}).toEqual(cold);
		expect(cold).toEqual({
			catalog: { autoUpdate: true },
			windows: null,
			own: { contextWindow: 88_888 },
		});
	}, 30_000);
});
