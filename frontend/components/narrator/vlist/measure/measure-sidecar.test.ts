/**
 * measure-sidecar.test.ts — Height model for one side-car FOOTNOTE.
 *
 * Four geometries come out of `form` × `expanded`, and the distinctions matter:
 *   - a `folded` collapsed footnote is a CONSTANT height (its headline is one clamped
 *     line, so content length cannot reach the model);
 *   - an `open` one draws its body unasked but capped, because "worth reading without
 *     a click" must not mean "may take the viewport";
 *   - `expanded` passes the inline cap but never the hard measurement ceiling.
 *
 * Canvas stub required for every branch that measures body text.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import type { SidecarSpecData } from "@shared/pretext-layout/segment-adapter";
import { SIDECAR_INLINE_MAX_LINES } from "@shared/pretext-layout/sidecar";
import type { SideCarLine } from "@shared/sidecar-body";
import { installCanvasStub } from "./test-canvas-stub";

let mod: typeof import("./measure-sidecar");

beforeAll(async () => {
	installCanvasStub();
	mod = await import("./measure-sidecar");
});

const WIDTH = 600;

function data(over: Partial<SidecarSpecData> = {}): SidecarSpecData {
	return {
		payloadKind: "sidecar",
		source: "silent_progress",
		sourceLabel: "Progress reminder",
		tone: "neutral",
		form: "folded",
		headline: "20 tool calls without a visible reply",
		lines: [{ kind: "text", text: "one" }],
		fullText: "full text",
		isRaw: false,
		truncatedLabel: "[Preview truncated…]",
		showAllLabel: "Show all",
		...over,
	};
}

function textLines(count: number): SideCarLine[] {
	return Array.from({ length: count }, (_, i) => ({ kind: "text" as const, text: `line ${i}` }));
}

// ── folded / collapsed: a constant ───────────────────────────────────────────

describe("measureSidecar — folded, collapsed", () => {
	it("is exactly the bare header row, whatever the content or width", () => {
		// The whole point of the footnote form: a routine injection costs one row, the
		// same row a folded trace item costs.
		expect(mod.SIDECAR_COLLAPSED_HEIGHT).toBe(mod.SIDECAR_HEADER_ROW);
		const short = mod.measureSidecar(data(), WIDTH);
		const long = mod.measureSidecar(data({ lines: textLines(50) }), 320);
		expect(short.expanded).toBe(false);
		expect(short.height).toBe(mod.SIDECAR_COLLAPSED_HEIGHT);
		expect(long.height).toBe(mod.SIDECAR_COLLAPSED_HEIGHT);
		expect(long.bodyHeight).toBe(0);
		expect(long.lines).toEqual([]);
	});

	it("matches the folded trace row height (they are the same row)", async () => {
		const { TRACE_ROW_HEIGHT } = await import("./measure-tool-run");
		expect(mod.SIDECAR_HEADER_ROW).toBeCloseTo(TRACE_ROW_HEIGHT, 5);
	});

	it("reserves nothing extra when there is no body at all", () => {
		const r = mod.measureSidecar(data({ lines: [] }), WIDTH);
		expect(r.height).toBe(mod.SIDECAR_COLLAPSED_HEIGHT);
		expect(r.extraRow).toBe("none");
	});
});

// ── folded / expanded: header + every line ───────────────────────────────────

describe("measureSidecar — folded, expanded", () => {
	it("adds the gap plus one row per body line", () => {
		const r = mod.measureSidecar(data({ lines: textLines(3) }), WIDTH, 5, { expanded: true });
		expect(r.expanded).toBe(true);
		expect(r.bodyHeight).toBe(3 * mod.SIDECAR_LINE_HEIGHT);
		expect(r.height).toBe(
			mod.SIDECAR_HEADER_ROW + mod.SIDECAR_HEADER_BODY_GAP + 3 * mod.SIDECAR_LINE_HEIGHT,
		);
	});

	it("is taller than collapsed, and shows every line (no inline cap when asked)", () => {
		const lines = textLines(SIDECAR_INLINE_MAX_LINES + 5);
		const collapsed = mod.measureSidecar(data({ lines }), WIDTH);
		const open = mod.measureSidecar(data({ lines }), WIDTH, 5, { expanded: true });
		expect(open.height).toBeGreaterThan(collapsed.height);
		expect(open.lines).toHaveLength(lines.length);
		expect(open.extraRow).toBe("none");
	});

	it("stacks lines with no gaps between them (tops are contiguous)", () => {
		const r = mod.measureSidecar(data({ lines: textLines(3) }), WIDTH, 5, { expanded: true });
		expect(r.lines[0]?.top).toBe(r.bodyTop);
		expect(r.lines[1]?.top).toBe((r.lines[0]?.top ?? 0) + (r.lines[0]?.height ?? 0));
		expect(r.lines[2]?.top).toBe((r.lines[1]?.top ?? 0) + (r.lines[1]?.height ?? 0));
	});
});

// ── bullets wrap narrower than text ──────────────────────────────────────────

describe("measureSidecar — per-line widths", () => {
	it("insets a bullet's text by its marker lane", () => {
		const r = mod.measureSidecar(
			data({
				lines: [
					{ kind: "text", text: "plain" },
					{ kind: "bullet", text: "bulleted" },
				],
			}),
			WIDTH,
			5,
			{ expanded: true },
		);
		expect(r.lines[0]?.left).toBe(mod.SIDECAR_BODY_LEFT);
		expect(r.lines[1]?.left).toBe(mod.SIDECAR_BODY_LEFT + mod.SIDECAR_BULLET_INSET);
		expect(r.lines[1]?.width).toBeLessThan(r.lines[0]?.width ?? 0);
	});

	it("wraps a bullet EARLIER than the same text unbulleted (why lines measure alone)", () => {
		// One block for the whole body could only be measured at one width, so a mixed
		// body would mispredict. This is the observable consequence.
		const long = "word ".repeat(60).trim();
		const asText = mod.measureSidecar(data({ lines: [{ kind: "text", text: long }] }), 260, 5, {
			expanded: true,
		});
		const asBullet = mod.measureSidecar(data({ lines: [{ kind: "bullet", text: long }] }), 260, 5, {
			expanded: true,
		});
		expect(asBullet.lines[0]?.lineCount).toBeGreaterThanOrEqual(asText.lines[0]?.lineCount ?? 0);
		expect(asBullet.bodyHeight).toBeGreaterThanOrEqual(asText.bodyHeight);
	});

	it("counts a wrapped line's rows toward the body height", () => {
		const long = "word ".repeat(80).trim();
		const wide = mod.measureSidecar(data({ lines: [{ kind: "text", text: long }] }), 800, 5, {
			expanded: true,
		});
		const narrow = mod.measureSidecar(data({ lines: [{ kind: "text", text: long }] }), 240, 5, {
			expanded: true,
		});
		expect(narrow.bodyHeight).toBeGreaterThan(wide.bodyHeight);
	});
});

// ── open / collapsed: drawn unasked, but capped ──────────────────────────────

describe("measureSidecar — open, collapsed", () => {
	const openData = (lines: SideCarLine[]) =>
		data({ form: "open", tone: "peer", source: "subagent_message", lines });

	it("draws the body without being asked", () => {
		const r = mod.measureSidecar(openData(textLines(3)), WIDTH);
		expect(r.expanded).toBe(false);
		expect(r.lines).toHaveLength(3);
		expect(r.height).toBeGreaterThan(mod.SIDECAR_COLLAPSED_HEIGHT);
	});

	it("caps at SIDECAR_INLINE_MAX_LINES and reserves a 'show all' row", () => {
		const r = mod.measureSidecar(openData(textLines(SIDECAR_INLINE_MAX_LINES + 6)), WIDTH);
		expect(r.lines).toHaveLength(SIDECAR_INLINE_MAX_LINES);
		expect(r.extraRow).toBe("showAll");
		expect(r.extraRowText).toBe("Show all");
		expect(r.height).toBe(
			mod.SIDECAR_HEADER_ROW +
				mod.SIDECAR_HEADER_BODY_GAP +
				SIDECAR_INLINE_MAX_LINES * mod.SIDECAR_LINE_HEIGHT +
				mod.SIDECAR_EXTRA_ROW_GAP +
				mod.SIDECAR_EXTRA_ROW_HEIGHT,
		);
		expect(r.extraRowTop).toBe(r.bodyTop + r.bodyHeight + mod.SIDECAR_EXTRA_ROW_GAP);
	});

	it("reserves NO row when the body fits (nothing to show)", () => {
		const r = mod.measureSidecar(openData(textLines(SIDECAR_INLINE_MAX_LINES)), WIDTH);
		expect(r.extraRow).toBe("none");
		expect(r.extraRowHeight).toBe(0);
		expect(r.extraRowTop).toBe(-1);
	});

	it("expanding an open footnote passes the inline cap", () => {
		const lines = textLines(SIDECAR_INLINE_MAX_LINES + 6);
		const capped = mod.measureSidecar(openData(lines), WIDTH);
		const full = mod.measureSidecar(openData(lines), WIDTH, 5, { expanded: true });
		expect(full.lines).toHaveLength(lines.length);
		expect(full.height).toBeGreaterThan(capped.height);
		expect(full.extraRow).toBe("none");
	});
});

// ── the hard ceiling is a different kind of limit ────────────────────────────

describe("measureSidecar — the measurement ceiling", () => {
	it("clamps an expanded body at SIDECAR_DETAIL_MAX_LINES and says so", () => {
		// Unlike the inline cap, this one cannot be passed: it bounds measure cost for a
		// pathological record, and the full text stays behind the copy button.
		const r = mod.measureSidecar(
			data({ lines: textLines(mod.SIDECAR_DETAIL_MAX_LINES + 20) }),
			WIDTH,
			5,
			{ expanded: true },
		);
		expect(r.lines).toHaveLength(mod.SIDECAR_DETAIL_MAX_LINES);
		expect(r.bodyHeight).toBe(mod.SIDECAR_DETAIL_MAX_LINES * mod.SIDECAR_LINE_HEIGHT);
		expect(r.extraRow).toBe("truncated");
		expect(r.extraRowText).toBe("[Preview truncated…]");
	});

	it("clamps ONE pathologically long line rather than overshooting the ceiling", () => {
		const monster = "word ".repeat(4000).trim();
		const r = mod.measureSidecar(data({ lines: [{ kind: "text", text: monster }] }), 200, 5, {
			expanded: true,
		});
		expect(r.lines[0]?.lineCount).toBeLessThanOrEqual(mod.SIDECAR_DETAIL_MAX_LINES);
		expect(r.bodyHeight).toBeLessThanOrEqual(
			mod.SIDECAR_DETAIL_MAX_LINES * mod.SIDECAR_LINE_HEIGHT,
		);
		expect(r.extraRow).toBe("truncated");
	});

	it("prefers the truncation notice over 'show all' when the ceiling is what bit", () => {
		// An open footnote past the CEILING cannot offer to show more — there is no more
		// to show without re-measuring past the bound.
		const r = mod.measureSidecar(
			data({
				form: "open",
				tone: "peer",
				lines: textLines(mod.SIDECAR_DETAIL_MAX_LINES + 5),
			}),
			WIDTH,
			5,
			{ expanded: true },
		);
		expect(r.extraRow).toBe("truncated");
	});

	it("reserves nothing when there is no label to paint (height == painted rows)", () => {
		// CONTRACT §0 rule 2: an unreserved row would be clipped or push a line out.
		const r = mod.measureSidecar(
			data({
				lines: textLines(mod.SIDECAR_DETAIL_MAX_LINES + 5),
				truncatedLabel: "",
			}),
			WIDTH,
			5,
			{ expanded: true },
		);
		expect(r.extraRow).toBe("none");
		expect(r.extraRowHeight).toBe(0);
		expect(r.height).toBe(
			mod.SIDECAR_HEADER_ROW +
				mod.SIDECAR_HEADER_BODY_GAP +
				mod.SIDECAR_DETAIL_MAX_LINES * mod.SIDECAR_LINE_HEIGHT,
		);
	});

	it("reserves no 'show all' row without its label either", () => {
		const r = mod.measureSidecar(
			data({ form: "open", tone: "peer", lines: textLines(30), showAllLabel: "" }),
			WIDTH,
		);
		expect(r.extraRow).toBe("none");
	});
});

// ── the raw (unstructured) fallback still measures ───────────────────────────

describe("measureSidecar — raw fallback rows", () => {
	it("measures a verbatim body exactly like a structured one", () => {
		// A pre-structured row arrives as `isRaw` with its content split into text
		// lines; nothing about the height model differs.
		const raw = data({
			isRaw: true,
			lines: [
				{ kind: "text", text: "<progress_update_request>" },
				{ kind: "text", text: "You have completed 20 tool calls." },
				{ kind: "text", text: "</progress_update_request>" },
			],
		});
		const r = mod.measureSidecar(raw, WIDTH, 5, { expanded: true });
		expect(r.lines).toHaveLength(3);
		expect(r.bodyHeight).toBe(3 * mod.SIDECAR_LINE_HEIGHT);
	});
});

// ── LOD independence ─────────────────────────────────────────────────────────

describe("measureSidecar — LOD", () => {
	it("measures the same at every level", () => {
		// A side-car is the evidence of what the model was shown; hiding it at a low
		// level would let the reader believe it never happened.
		const heights = ([1, 2, 3, 4, 5, 6] as const).map(
			(lod) =>
				mod.measureSidecar(data({ lines: textLines(4) }), WIDTH, lod, { expanded: true }).height,
		);
		expect(new Set(heights).size).toBe(1);
	});
});
