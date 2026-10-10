import { describe, expect, test } from "bun:test";
import * as settingsModule from "../../lib/settings";

describe("Telegram adapter dependency loading", () => {
	// node-telegram-bot-api loads @cypress/request-promise. Under Bun, require.cache is the shared
	// module registry for ESM and CJS, so a dependency that empties it evicts server modules that
	// are already loaded, and the next dynamic import evaluates a second copy with its own state
	// (settings revision, caches, subscriptions). Dynamic import is the behaviour under test here.
	test("keeps already-loaded server modules as single instances", async () => {
		await import("node-telegram-bot-api");
		const reloaded = await import("../../lib/settings");
		expect(reloaded.getSettingsRevision).toBe(settingsModule.getSettingsRevision);
		expect(reloaded.settings).toBe(settingsModule.settings);
	});
});
