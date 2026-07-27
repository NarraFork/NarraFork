import { describe, expect, test } from "bun:test";
import { localPrefDefault } from "./useLocalPref";

/**
 * OFF-path protection for the narrator virtual list feature flag.
 *
 * The `narrafork_narrator_virtual_list` preference gates the new PretextMessageList
 * against the legacy ChunkedMessageList. The behavior guarantee is: when the user
 * has NOT explicitly opted in (nothing stored in localStorage), the flag MUST be
 * `false` so the legacy path stays active. If someone ever adds this key to the
 * `DEFAULT_TRUE` set, every user would silently be switched to the new list —
 * exactly the regression this test exists to catch.
 */
describe("useLocalPref — OFF-path defaults", () => {
	test("narrafork_narrator_virtual_list defaults to false (legacy list stays active)", () => {
		expect(localPrefDefault("narrafork_narrator_virtual_list")).toBe(false);
	});

	test("only narrafork_advanced_anim opts in by default", () => {
		// Every other known key must default to false. This pins the opt-out set so
		// a new default-true key can't sneak the virtual list (or others) on.
		expect(localPrefDefault("narrafork_advanced_anim")).toBe(true);
		expect(localPrefDefault("narrafork_oled")).toBe(false);
		expect(localPrefDefault("narrafork_wakelock")).toBe(false);
		expect(localPrefDefault("narrafork_fullscreen")).toBe(false);
		expect(localPrefDefault("narrafork_expand_reasoning")).toBe(false);
		// The reading-width cap is opt-in: by default both message lists fill the viewport.
		expect(localPrefDefault("narrafork_narrator_centered_column")).toBe(false);
	});
});
