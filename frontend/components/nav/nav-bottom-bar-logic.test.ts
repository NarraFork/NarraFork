import { describe, expect, test } from "bun:test";
import {
	NAV_BOTTOM_GAP_PX,
	NAV_BOTTOM_ICON_PX,
	navBottomFitCount,
	splitNavBottomItems,
} from "./nav-bottom-bar-logic";

const slot = NAV_BOTTOM_ICON_PX + NAV_BOTTOM_GAP_PX;

describe("bottom bar icon split", () => {
	test("fits whole icons into the room left after the avatar and the more button", () => {
		expect(
			navBottomFitCount({ width: 70 + 3 * slot - NAV_BOTTOM_GAP_PX, reservedPx: 70, itemCount: 9 }),
		).toBe(3);
		expect(
			navBottomFitCount({
				width: 70 + 3 * slot - NAV_BOTTOM_GAP_PX - 1,
				reservedPx: 70,
				itemCount: 9,
			}),
		).toBe(2);
	});

	test("never more than there are items, never negative", () => {
		expect(navBottomFitCount({ width: 2000, reservedPx: 70, itemCount: 4 })).toBe(4);
		expect(navBottomFitCount({ width: 40, reservedPx: 70, itemCount: 4 })).toBe(0);
	});

	test("overflow keeps the order", () => {
		expect(splitNavBottomItems(["a", "b", "c", "d"], 2)).toEqual({
			shown: ["a", "b"],
			overflow: ["c", "d"],
		});
	});
});
