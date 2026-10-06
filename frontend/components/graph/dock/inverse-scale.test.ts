import { describe, expect, test } from "bun:test";
import { isInteractiveZoom, MIN_EFFECTIVE_ZOOM } from "./inverse-scale";

/**
 * The inverse-scale box these tests used to cover is gone — counter-scaling the
 * host made Dockview's fixed-pixel chrome occupy a zoom-dependent fraction of the
 * node, which is the proportion bug. What remains is the low-zoom cutoff.
 */
describe("isInteractiveZoom", () => {
	test("at or above the threshold → true", () => {
		expect(isInteractiveZoom(MIN_EFFECTIVE_ZOOM)).toBe(true);
		expect(isInteractiveZoom(1)).toBe(true);
		expect(isInteractiveZoom(4)).toBe(true);
	});

	test("below the threshold → false", () => {
		expect(isInteractiveZoom(0.39)).toBe(false);
		expect(isInteractiveZoom(0.1)).toBe(false);
	});

	// Unmounting every dock for one startup frame would tear down live sessions to
	// avoid a paint that never happens, so an unknown zoom must stay mounted.
	test.each([
		0,
		-1,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])("unknown/unusable zoom %p → true (never blanks a node before first layout)", (zoom) => {
		expect(isInteractiveZoom(zoom as number)).toBe(true);
	});
});
