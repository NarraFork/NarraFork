import { describe, expect, test } from "bun:test";
import { CUSTOMIZABLE_NAV_ITEMS } from "@frontend/components/nav/nav-items";
import { mergeNavLayout, toPersistedNavLayout } from "@frontend/hooks/nav-layout";
import { CUSTOMIZABLE_NAV_IDS, NAV_DIVIDER_ID } from "@shared/nav-layout";
import { updateUserPreferencesSchema } from "../settings";

/**
 * The server validator and the frontend nav registry used to hold independent
 * copies of the id list. When "messages" was added to the sidebar, the validator
 * still listed a stale "groups" id, so dragging the nav order produced a 400
 * (`invalid_value` on `navLayout.items[].id`) and the layout could not be saved.
 *
 * Both now derive from @shared/nav-layout; these tests fail if either side is
 * wired to its own list again.
 */
describe("navLayout id whitelist", () => {
	test("accepts every id the sidebar can actually render, plus the divider", () => {
		const items = [
			...CUSTOMIZABLE_NAV_ITEMS.map((def) => ({ id: def.id })),
			{ id: NAV_DIVIDER_ID },
		];
		const parsed = updateUserPreferencesSchema.parse({ navLayout: { items } });
		expect(parsed.navLayout?.items.map((item) => item.id as string)).toEqual(
			items.map((item) => item.id as string),
		);
	});

	test("the frontend registry covers exactly the shared id set", () => {
		expect(CUSTOMIZABLE_NAV_ITEMS.map((def) => def.id)).toEqual([...CUSTOMIZABLE_NAV_IDS]);
	});

	test("accepts a normalized legacy tutorial layout and preserves the learning guide", () => {
		const navLayout = toPersistedNavLayout(
			mergeNavLayout({ items: [{ id: "tutorial" }, { id: "learn" }, { id: NAV_DIVIDER_ID }] }),
		);
		const parsed = updateUserPreferencesSchema.parse({ navLayout });
		const ids = parsed.navLayout?.items.map((item) => item.id);
		expect(ids).not.toContain("tutorial");
		expect(ids).toContain("learn");
	});

	test("still rejects ids that no longer exist in the registry", () => {
		// Stale persisted ids are dropped client-side by useNavLayout, so the server
		// never needs to accept them — keeping this strict is what surfaces drift.
		const result = updateUserPreferencesSchema.safeParse({
			navLayout: { items: [{ id: "groups" }] },
		});
		expect(result.success).toBe(false);
	});
});
