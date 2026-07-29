import { describe, expect, test } from "bun:test";
import { localPrefDefault } from "./useLocalPref";

/**
 * Default/opt-out contract for the narrator message-list preference.
 *
 * The `narrafork_narrator_virtual_list` preference selects PretextExactMessageList
 * over the legacy ChunkedMessageList. It is now DEFAULT-ON: a browser with nothing
 * stored (a "new user") must resolve to `true` so the virtual list is what they see.
 * ChunkedMessageList stays reachable only as an explicit opt-out — a stored "false"
 * must never be overridden by the default.
 */
describe("useLocalPref — narrator list default", () => {
	test("narrafork_narrator_virtual_list defaults to true (new users get the virtual list)", () => {
		expect(localPrefDefault("narrafork_narrator_virtual_list")).toBe(true);
	});

	test("opt-out keys stay opt-in", () => {
		// Pins the opt-out set so a new default-true key can't sneak in unnoticed.
		expect(localPrefDefault("narrafork_advanced_anim")).toBe(true);
		expect(localPrefDefault("narrafork_oled")).toBe(false);
		expect(localPrefDefault("narrafork_wakelock")).toBe(false);
		expect(localPrefDefault("narrafork_fullscreen")).toBe(false);
		expect(localPrefDefault("narrafork_expand_reasoning")).toBe(false);
		// The reading-width cap is opt-in: by default both message lists fill the viewport.
		expect(localPrefDefault("narrafork_narrator_centered_column")).toBe(false);
	});
});
