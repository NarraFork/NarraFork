/**
 * Guards the frontend registry ↔ server enum agreement for the narrator toolbar
 * layout.
 *
 * The nav layout hit this exact trap: an id the frontend rendered but the server
 * enum did not list made `PATCH /api/user-preferences` reject the whole layout
 * with a Zod `invalid_value`, and the only symptom a user saw was "my
 * customization does not stick". Both sides now derive from
 * @shared/narrator-toolbar; these tests fail if that sourcing is ever replaced
 * by a hand-maintained copy.
 */

import { describe, expect, it } from "bun:test";
import {
	NARRATOR_TOOLBAR_BOTTOM_DIVIDER_ID,
	NARRATOR_TOOLBAR_DIVIDER_ID,
	NARRATOR_TOOLBAR_IDS,
} from "@shared/narrator-toolbar";
import { updateUserPreferencesSchema } from "../settings";

describe("narratorToolbarLayout id whitelist", () => {
	it("accepts every registry id plus the divider marker", () => {
		const items = [
			...NARRATOR_TOOLBAR_IDS.map((id) => ({ id })),
			{ id: NARRATOR_TOOLBAR_DIVIDER_ID },
			{ id: NARRATOR_TOOLBAR_BOTTOM_DIVIDER_ID },
		];
		const parsed = updateUserPreferencesSchema.parse({
			narratorToolbarLayout: { items },
		});
		expect(parsed.narratorToolbarLayout?.items.map((item) => item.id as string)).toEqual(
			items.map((item) => item.id),
		);
	});

	it("rejects an id absent from the shared registry", () => {
		expect(() =>
			updateUserPreferencesSchema.parse({
				narratorToolbarLayout: { items: [{ id: "mock-stream-debug" }] },
			}),
		).toThrow();
	});

	it("leaves the layout untouched when the field is omitted", () => {
		const parsed = updateUserPreferencesSchema.parse({ fastModeDefault: true });
		expect(parsed.narratorToolbarLayout).toBeUndefined();
	});
});
