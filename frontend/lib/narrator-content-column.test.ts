import { describe, expect, it } from "bun:test";
import {
	NARRATOR_CENTERED_COLUMN_MAX_WIDTH,
	resolveNarratorColumnMaxWidth,
	resolveNarratorColumnWidth,
} from "./narrator-content-column";

describe("resolveNarratorColumnWidth", () => {
	it("fills the viewport (minus gutters) when the cap is off", () => {
		// Default behaviour: parity with the chunked path, which has never capped.
		expect(resolveNarratorColumnWidth(1600, 16, false)).toBe(1568);
		expect(resolveNarratorColumnWidth(600, 16, false)).toBe(568);
	});

	it("caps at the reading width when the option is on", () => {
		expect(resolveNarratorColumnWidth(1600, 16, true)).toBe(NARRATOR_CENTERED_COLUMN_MAX_WIDTH);
		// Narrower than the cap → the viewport still wins (no overflow).
		expect(resolveNarratorColumnWidth(600, 16, true)).toBe(568);
	});

	it("never returns a non-positive width for an unmeasured viewport", () => {
		// clientWidth 0 before first layout must not produce a 0/negative measure width.
		expect(resolveNarratorColumnWidth(0, 16, false)).toBe(1);
		expect(resolveNarratorColumnWidth(0, 16, true)).toBe(1);
		expect(resolveNarratorColumnWidth(20, 16, false)).toBe(1);
	});
});

describe("resolveNarratorColumnMaxWidth", () => {
	it("is undefined when off so the wrapper keeps filling the viewport", () => {
		expect(resolveNarratorColumnMaxWidth(false, "var(--mantine-spacing-md)")).toBeUndefined();
	});

	it("adds both gutters back so the inner column measures the reading width", () => {
		expect(resolveNarratorColumnMaxWidth(true, "var(--mantine-spacing-md)")).toBe(
			`calc(${NARRATOR_CENTERED_COLUMN_MAX_WIDTH}px + var(--mantine-spacing-md) * 2)`,
		);
	});
});
