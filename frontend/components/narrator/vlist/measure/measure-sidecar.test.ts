/**
 * measure-sidecar.test.ts — Height model for the per-record sidecar card.
 *
 * The collapsed card is a constant height (its preview is a single clamped line);
 * the expanded card adds a pretext-measured pre-wrap body capped at
 * SIDECAR_DETAIL_MAX_LINES. Canvas stub required for the expanded branch.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import type { SidecarSpecData } from "@shared/pretext-layout/segment-adapter";
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
		color: "indigo",
		target: "user_message",
		previewText: "preview",
		fullText: "full text",
		truncatedLabel: "[Preview truncated…]",
		...over,
	};
}

/** A body guaranteed to exceed the line cap. */
function overCapText(): string {
	return Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
}

describe("measureSidecar — collapsed", () => {
	it("is a constant height regardless of content or width", () => {
		expect(mod.SIDECAR_COLLAPSED_HEIGHT).toBe(
			mod.SIDECAR_CARD_PADDING * 2 + mod.SIDECAR_HEADER_ROW,
		);
		const a = mod.measureSidecar(data(), WIDTH);
		const b = mod.measureSidecar(data({ fullText: "much\nlonger\nbody\nhere" }), 400);
		expect(a.expanded).toBe(false);
		expect(a.height).toBe(mod.SIDECAR_COLLAPSED_HEIGHT);
		expect(b.height).toBe(mod.SIDECAR_COLLAPSED_HEIGHT);
	});

	it("explicit expanded=false equals the default collapsed geometry", () => {
		const plain = mod.measureSidecar(data(), WIDTH);
		const explicit = mod.measureSidecar(data(), WIDTH, 5, { expanded: false });
		expect(explicit.height).toBe(plain.height);
		expect(explicit.bodyHeight).toBe(0);
	});
});

describe("measureSidecar — expanded", () => {
	it("adds the gap + one body line for a short text", () => {
		const r = mod.measureSidecar(data({ fullText: "short" }), WIDTH, 5, { expanded: true });
		expect(r.expanded).toBe(true);
		expect(r.bodyHeight).toBe(mod.SIDECAR_LINE_HEIGHT);
		expect(r.height).toBe(
			mod.SIDECAR_CARD_PADDING * 2 +
				mod.SIDECAR_HEADER_ROW +
				mod.SIDECAR_HEADER_BODY_GAP +
				mod.SIDECAR_LINE_HEIGHT,
		);
	});

	it("counts hard newlines as separate body lines", () => {
		const r = mod.measureSidecar(data({ fullText: "one\ntwo\nthree" }), WIDTH, 5, {
			expanded: true,
		});
		expect(r.bodyHeight).toBe(3 * mod.SIDECAR_LINE_HEIGHT);
	});

	it("wraps long single-line text at narrower widths (more lines)", () => {
		const long = "word ".repeat(80).trim();
		const wide = mod.measureSidecar(data({ fullText: long }), 800, 5, { expanded: true });
		const narrow = mod.measureSidecar(data({ fullText: long }), 240, 5, { expanded: true });
		expect(narrow.bodyHeight).toBeGreaterThan(wide.bodyHeight);
	});

	it("caps the body at SIDECAR_DETAIL_MAX_LINES", () => {
		const r = mod.measureSidecar(data({ fullText: overCapText() }), WIDTH, 5, { expanded: true });
		expect(r.bodyHeight).toBe(mod.SIDECAR_DETAIL_MAX_LINES * mod.SIDECAR_LINE_HEIGHT);
	});

	it("expanded > collapsed for any non-empty body", () => {
		const base = mod.measureSidecar(data(), WIDTH);
		const open = mod.measureSidecar(data(), WIDTH, 5, { expanded: true });
		expect(open.height).toBeGreaterThan(base.height);
	});
});

// ── Truncation notice (the LINE cap must be visible, not silent) ──────────────
describe("measureSidecar — truncation notice", () => {
	it("reports no truncation while the body fits the cap", () => {
		const r = mod.measureSidecar(data({ fullText: "one\ntwo" }), WIDTH, 5, { expanded: true });
		expect(r.bodyTruncated).toBe(false);
		expect(r.noticeHeight).toBe(0);
		expect(r.noticeTop).toBe(-1);
		expect(r.noticeText).toBe("");
	});

	it("reserves the notice row IN THE HEIGHT when the cap clipped the body", () => {
		// CONTRACT §0: the notice cannot be a render-layer decision — the body lane is
		// a fixed-height clipped box, so an unreserved row would be cut off or would
		// push a body line out of it.
		const clipped = mod.measureSidecar(data({ fullText: overCapText() }), WIDTH, 5, {
			expanded: true,
		});
		expect(clipped.bodyTruncated).toBe(true);
		expect(clipped.noticeHeight).toBe(mod.SIDECAR_TRUNCATION_NOTICE_HEIGHT);
		expect(clipped.noticeText).toBe("[Preview truncated…]");
		// Exactly gap + row taller than the same geometry without a notice.
		const capBodyHeight = mod.SIDECAR_DETAIL_MAX_LINES * mod.SIDECAR_LINE_HEIGHT;
		expect(clipped.height).toBe(
			mod.SIDECAR_CARD_PADDING * 2 +
				mod.SIDECAR_HEADER_ROW +
				mod.SIDECAR_HEADER_BODY_GAP +
				capBodyHeight +
				mod.SIDECAR_TRUNCATION_NOTICE_GAP +
				mod.SIDECAR_TRUNCATION_NOTICE_HEIGHT,
		);
	});

	it("places the notice below the clipped body, clear of it", () => {
		const r = mod.measureSidecar(data({ fullText: overCapText() }), WIDTH, 5, { expanded: true });
		expect(r.noticeTop).toBe(r.bodyTop + r.bodyHeight + mod.SIDECAR_TRUNCATION_NOTICE_GAP);
	});

	it("never reserves a notice on a COLLAPSED card (no body to clip)", () => {
		const r = mod.measureSidecar(data({ fullText: overCapText() }), WIDTH, 5, {
			expanded: false,
		});
		expect(r.bodyTruncated).toBe(false);
		expect(r.height).toBe(mod.SIDECAR_COLLAPSED_HEIGHT);
	});

	it("reserves nothing when there is no label to paint (height == painted row)", () => {
		// A payload without the adapter-composed label would otherwise reserve an
		// empty gap the renderer draws nothing into.
		const r = mod.measureSidecar(data({ fullText: overCapText(), truncatedLabel: "" }), WIDTH, 5, {
			expanded: true,
		});
		expect(r.bodyTruncated).toBe(true);
		expect(r.noticeHeight).toBe(0);
		expect(r.height).toBe(
			mod.SIDECAR_CARD_PADDING * 2 +
				mod.SIDECAR_HEADER_ROW +
				mod.SIDECAR_HEADER_BODY_GAP +
				mod.SIDECAR_DETAIL_MAX_LINES * mod.SIDECAR_LINE_HEIGHT,
		);
	});
});
