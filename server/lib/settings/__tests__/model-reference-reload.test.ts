import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getModelOverride, setModelOverride } from "../../model-catalog";
import { narraforkDir, reloadSettings, saveSettings, settings } from "../index";

const path = join(narraforkDir, "settings.json");
let original: string;
let overridden: string | undefined;

beforeEach(() => {
	original = readFileSync(path, "utf8");
});
afterEach(() => {
	writeFileSync(path, original);
	reloadSettings();
	if (overridden) setModelOverride("connection", overridden, null);
	overridden = undefined;
});

describe("model references survive settings reload", () => {
	for (const model of [
		"custom:mimo-v2.6-flash",
		"tokendance:mimo-v2.6-flash",
		"__agg__:summary-pool",
		"plugin-provider:summary-model",
		"temporarily-unavailable:summary-model",
	]) {
		test(`preserves ${model} through save and repeated disk reloads`, () => {
			const draft = structuredClone(settings);
			draft.agent.summaryModel = model;
			draft.agent.translationModel = model;
			draft.agent.promptOptimizeModel = model;
			draft.agent.subagentModels.explore = model;
			draft.agent.hiddenModels = [model];
			saveSettings(draft);
			// The entry's own override must survive the stale-reference cleanup on load.
			overridden = model;
			setModelOverride("connection", model, { contextWindow: 128000 });

			// Force a migration write on the first load, so both returned settings
			// and the re-persisted JSON must retain the operator's references.
			const saved = JSON.parse(readFileSync(path, "utf8"));
			delete saved.agent.browserProxy;
			writeFileSync(path, JSON.stringify(saved));

			for (let attempt = 0; attempt < 2; attempt++) {
				const loaded = reloadSettings();
				expect(loaded.agent.summaryModel).toBe(model);
				expect(loaded.agent.translationModel).toBe(model);
				expect(loaded.agent.promptOptimizeModel).toBe(model);
				expect(loaded.agent.subagentModels.explore).toBe(model);
				expect(loaded.agent.hiddenModels).toContain(model);
				expect(getModelOverride("connection", model)?.contextWindow).toBe(128000);
				expect(JSON.parse(readFileSync(path, "utf8")).agent.summaryModel).toBe(model);
			}
		});
	}
});
