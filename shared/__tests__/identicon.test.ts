import { describe, expect, it } from "bun:test";
import {
	IDENTICON_COLS,
	IDENTICON_ROWS,
	identiconDataUri,
	identiconFromId,
	identiconToSvg,
} from "../identicon";

describe("identiconFromId", () => {
	it("is deterministic: the same id always yields the same glyph", () => {
		const a = identiconFromId("narrator-abc123");
		const b = identiconFromId("narrator-abc123");
		expect(a).toEqual(b);
	});

	it("different ids produce different glyphs (cells or hue differ)", () => {
		const ids = ["narr-1", "narr-2", "narr-3", "narr-4", "narr-5", "narr-6"];
		const sigs = new Set(ids.map((id) => JSON.stringify(identiconFromId(id))));
		// 6 distinct ids must not all collapse to one glyph.
		expect(sigs.size).toBeGreaterThan(1);
	});

	it("produces a full 5×5 grid", () => {
		const icon = identiconFromId("anything");
		expect(icon.cells).toHaveLength(IDENTICON_COLS * IDENTICON_ROWS);
	});

	it("is horizontally mirrored", () => {
		const icon = identiconFromId("mirror-check");
		for (let row = 0; row < IDENTICON_ROWS; row++) {
			for (let col = 0; col < 3; col++) {
				const left = icon.cells[row * IDENTICON_COLS + col];
				const right = icon.cells[row * IDENTICON_COLS + (IDENTICON_COLS - 1 - col)];
				expect(left).toBe(right);
			}
		}
	});

	it("never paints a blank glyph, even for a hash that fills nothing", () => {
		// Scan a range of ids; every glyph must light at least one cell.
		for (let i = 0; i < 500; i++) {
			const icon = identiconFromId(`probe-${i}`);
			expect(icon.cells.some(Boolean)).toBe(true);
		}
	});

	it("hue stays within [0, 360) and saturation/lightness are pinned", () => {
		const icon = identiconFromId("colour-check");
		expect(icon.hue).toBeGreaterThanOrEqual(0);
		expect(icon.hue).toBeLessThan(360);
		expect(icon.saturation).toBe(65);
		expect(icon.lightness).toBe(50);
	});

	it("handles empty and unicode ids without throwing", () => {
		expect(() => identiconFromId("")).not.toThrow();
		expect(() => identiconFromId("叙述者-子代理-🔀")).not.toThrow();
	});
});

describe("identiconToSvg / identiconDataUri", () => {
	it("emits a valid svg with crispEdges and one rect per filled cell", () => {
		const icon = identiconFromId("svg-check");
		const svg = identiconToSvg(icon);
		expect(svg).toContain('shape-rendering="crispEdges"');
		expect(svg).toContain(`hsl(${icon.hue} 65% 50%)`);
		const rectCount = (svg.match(/<rect /g) ?? []).length;
		expect(rectCount).toBe(icon.cells.filter(Boolean).length);
	});

	it("data URI is url-encoded and self-contained", () => {
		const uri = identiconDataUri("narrator-xyz");
		expect(uri.startsWith("data:image/svg+xml;utf8,")).toBe(true);
		expect(uri).toContain(encodeURIComponent("<svg"));
		// Round-trips to the same glyph for the same id.
		expect(identiconDataUri("narrator-xyz")).toBe(uri);
	});
});
