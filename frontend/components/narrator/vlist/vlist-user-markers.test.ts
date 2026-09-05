import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
	collectVListCompactMarkers,
	collectVListUserMarkers,
	resolveVListUserMarkerPreview,
	resolveVListUserMarkerScrollTop,
	resolveVListUserMarkerTop,
	shouldShowVListUserMarkers,
	type VListUserMarkerItem,
} from "./vlist-user-markers";

function bubble(key: string, data: Record<string, unknown>): VListUserMarkerItem {
	return { spec: { kind: "message-bubble", key, data } };
}

function row(kind: string, key: string, data: Record<string, unknown> = {}): VListUserMarkerItem {
	return { spec: { kind, key, data } };
}

describe("collectVListUserMarkers", () => {
	it("marks user bubbles at their real document offsets, in order", () => {
		const items = [
			bubble("m1-bubble", { role: "user", text: "first question" }),
			row("markdown", "m2-b0"),
			row("tool-call", "tool-abc"),
			bubble("m3-bubble", { role: "user", text: "second question" }),
		];
		const layout = [{ top: 16 }, { top: 60 }, { top: 900 }, { top: 1000 }];
		const markers = collectVListUserMarkers(items, layout, 2000);
		expect(markers).toEqual([
			{
				key: "m1-bubble",
				itemIndex: 0,
				top: 16,
				fraction: 16 / 2000,
				ordinal: 1,
				preview: "first question",
				createdAt: null,
			},
			{
				key: "m3-bubble",
				itemIndex: 3,
				top: 1000,
				fraction: 0.5,
				ordinal: 2,
				preview: "second question",
				createdAt: null,
			},
		]);
	});

	it("carries the bubble's timestamp so the tooltip can show the send time", () => {
		const items = [
			bubble("m1-bubble", { role: "user", text: "a", createdAt: "2026-07-18T10:20:30.000Z" }),
			bubble("m2-bubble", { role: "user", text: "b", createdAt: null }),
			bubble("m3-bubble", { role: "user", text: "c" }),
		];
		const layout = [{ top: 0 }, { top: 100 }, { top: 200 }];
		const markers = collectVListUserMarkers(items, layout, 1000);
		expect(markers.map((marker) => marker.createdAt)).toEqual([
			"2026-07-18T10:20:30.000Z",
			null,
			null,
		]);
	});

	it("ignores assistant bubbles and every non-bubble kind", () => {
		const items = [
			bubble("a1-bubble", { role: "assistant", text: "reply" }),
			row("markdown", "a1-b0", { text: "reply" }),
			row("system-text", "s1-origin", { role: "user" }),
			row("subagent-card", "sa-1"),
		];
		const layout = items.map((_, index) => ({ top: index * 100 }));
		expect(collectVListUserMarkers(items, layout, 1000)).toEqual([]);
	});

	it("skips protocol turns stored as role=user (bash notices, auto-continuation)", () => {
		// The adapter routes these to system / origin cards, never to a bubble — so
		// the marker index must not gain entries the reader never typed.
		const items = [
			row("system-text", "bash-1", { kind: "bash_command", text: "ls" }),
			row("system-text", "cont-1", { kind: "origin_notice", origin: "system" }),
			bubble("m9-bubble", { role: "user", text: "real turn" }),
		];
		const layout = [{ top: 0 }, { top: 40 }, { top: 80 }];
		const markers = collectVListUserMarkers(items, layout, 500);
		expect(markers.map((marker) => marker.key)).toEqual(["m9-bubble"]);
		expect(markers[0]?.ordinal).toBe(1);
	});

	it("skips rows without geometry instead of guessing a position", () => {
		const items = [
			bubble("m1-bubble", { role: "user", text: "a" }),
			bubble("m2-bubble", { role: "user", text: "b" }),
			bubble("m3-bubble", { role: "user", text: "c" }),
		];
		// Middle row has no geometry (input arrays out of sync mid-rebuild).
		const layout = [{ top: 10 }, undefined, { top: 300 }];
		const markers = collectVListUserMarkers(items, layout, 600);
		expect(markers.map((marker) => marker.key)).toEqual(["m1-bubble", "m3-bubble"]);
		// Ordinals stay contiguous over what is actually shown.
		expect(markers.map((marker) => marker.ordinal)).toEqual([1, 2]);
	});

	it("clamps fractions into 0..1 and tolerates a degenerate document height", () => {
		const items = [bubble("m1-bubble", { role: "user", text: "a" })];
		// A row past the reported height (stale footer term) must not overflow.
		expect(collectVListUserMarkers(items, [{ top: 5000 }], 1000)[0]?.fraction).toBe(1);
		// Zero / non-finite height → fraction 0 rather than NaN or Infinity.
		expect(collectVListUserMarkers(items, [{ top: 500 }], 0)[0]?.fraction).toBe(0);
		expect(collectVListUserMarkers(items, [{ top: 500 }], Number.NaN)[0]?.fraction).toBe(0);
		// A negative offset cannot produce a negative jump target.
		expect(collectVListUserMarkers(items, [{ top: -20 }], 1000)[0]?.top).toBe(0);
	});
});

describe("resolveVListUserMarkerPreview", () => {
	it("prefers the slash command over its expanded prompt", () => {
		// The folded bubble shows the command, so the marker tooltip must match what
		// the reader will actually land on.
		expect(
			resolveVListUserMarkerPreview({
				role: "user",
				commandText: "/review",
				text: "You are reviewing a diff… (very long expansion)",
			}),
		).toBe("/review");
	});

	it("flattens whitespace and truncates long text", () => {
		expect(resolveVListUserMarkerPreview({ text: "  line one\n\n\tline two  " })).toBe(
			"line one line two",
		);
		const long = "x".repeat(200);
		const preview = resolveVListUserMarkerPreview({ text: long });
		expect(preview.endsWith("…")).toBe(true);
		expect(preview.length).toBeLessThanOrEqual(81);
	});

	it("returns an empty preview for attachment-only / malformed data", () => {
		expect(resolveVListUserMarkerPreview({ role: "user", text: "" })).toBe("");
		expect(resolveVListUserMarkerPreview({ role: "user" })).toBe("");
		expect(resolveVListUserMarkerPreview(null)).toBe("");
		expect(resolveVListUserMarkerPreview("not an object")).toBe("");
	});
});

describe("collectVListCompactMarkers", () => {
	it("marks context and segment compact indicators with their live status", () => {
		const items = [
			row("system-simple", "c1-sys", {
				kind: "compact",
				status: "compacted",
				text: "Context compacted",
			}),
			row("markdown", "m2-b0"),
			row("system-simple", "c3-sys", {
				kind: "segment_compact",
				status: "compacting",
				text: "Segment compacting… · retry #2",
			}),
		];
		const layout = [{ top: 100 }, { top: 200 }, { top: 800 }];
		expect(collectVListCompactMarkers(items, layout, 1000)).toEqual([
			{
				key: "c1-sys",
				itemIndex: 0,
				top: 100,
				fraction: 0.1,
				flavor: "context",
				status: "compacted",
				tooltip: "Context compacted",
			},
			{
				key: "c3-sys",
				itemIndex: 2,
				top: 800,
				fraction: 0.8,
				flavor: "segment",
				status: "compacting",
				tooltip: "Segment compacting… · retry #2",
			},
		]);
	});

	it("marks a failed context compact as failed", () => {
		const items = [
			row("system-simple", "c1-sys", { kind: "compact", status: "failed", text: "Compact failed" }),
		];
		const markers = collectVListCompactMarkers(items, [{ top: 50 }], 500);
		expect(markers[0]).toMatchObject({ flavor: "context", status: "failed" });
	});

	it("marks the failed SEGMENT card (system-text) by its title, not the error body", () => {
		const items = [
			row("system-text", "s2-sys", {
				kind: "segment_compact_failed",
				title: "Segment compact failed",
				text: "a very long provider error body that must not become a tooltip",
			}),
		];
		const markers = collectVListCompactMarkers(items, [{ top: 50 }], 500);
		expect(markers[0]).toMatchObject({
			flavor: "segment",
			status: "failed",
			tooltip: "Segment compact failed",
		});
	});

	it("normalizes an unknown status to compacted and skips non-compact rows", () => {
		const items = [
			row("system-simple", "x1-sys", { kind: "merge_summary", text: "merged" }),
			row("system-simple", "x2-sys", { kind: "compact", status: "weird", text: "?" }),
			row("system-text", "x3-sys", { kind: "info", text: "note" }),
			row("system-simple", "x4-sys", { kind: "spec_continuation" }),
			bubble("m1-bubble", { role: "user", text: "hi" }),
		];
		const layout = items.map((_, index) => ({ top: index * 100 }));
		const markers = collectVListCompactMarkers(items, layout, 1000);
		expect(markers).toHaveLength(1);
		expect(markers[0]).toMatchObject({ key: "x2-sys", status: "compacted", fraction: 0.1 });
	});

	it("skips rows without geometry instead of guessing a position", () => {
		const items = [
			row("system-simple", "c1-sys", { kind: "compact", status: "compacted", text: "a" }),
			row("system-simple", "c2-sys", { kind: "compact", status: "compacted", text: "b" }),
		];
		const markers = collectVListCompactMarkers(items, [{ top: 10 }, undefined], 600);
		expect(markers.map((marker) => marker.key)).toEqual(["c1-sys"]);
	});

	it("clamps fractions into 0..1 and tolerates a degenerate document height", () => {
		const items = [
			row("system-simple", "c1-sys", { kind: "compact", status: "compacted", text: "a" }),
		];
		expect(collectVListCompactMarkers(items, [{ top: 5000 }], 1000)[0]?.fraction).toBe(1);
		expect(collectVListCompactMarkers(items, [{ top: 500 }], 0)[0]?.fraction).toBe(0);
		expect(collectVListCompactMarkers(items, [{ top: -20 }], 1000)[0]?.top).toBe(0);
	});
});

describe("resolveVListUserMarkerTop", () => {
	it("keeps the last mark fully inside the track", () => {
		// Percentage placement (the chunked path's `top: 100%`) would hang the newest
		// turn's mark half outside the viewport; travel excludes the mark's height.
		expect(resolveVListUserMarkerTop(1, 600, 6)).toBe(594);
		expect(resolveVListUserMarkerTop(0, 600, 6)).toBe(0);
		expect(resolveVListUserMarkerTop(0.5, 600, 6)).toBe(297);
	});

	it("degrades to 0 for a track shorter than one mark or bad input", () => {
		expect(resolveVListUserMarkerTop(1, 4, 6)).toBe(0);
		expect(resolveVListUserMarkerTop(Number.NaN, 600, 6)).toBe(0);
		expect(resolveVListUserMarkerTop(0.5, Number.NaN, 6)).toBe(0);
		// Out-of-range fractions clamp rather than escaping the track.
		expect(resolveVListUserMarkerTop(2, 600, 6)).toBe(594);
		expect(resolveVListUserMarkerTop(-1, 600, 6)).toBe(0);
	});
});

describe("resolveVListUserMarkerScrollTop", () => {
	it("top-aligns the turn with a small lead, never below zero", () => {
		expect(resolveVListUserMarkerScrollTop(1000, 16)).toBe(984);
		// The first turn sits within the lead: clamp instead of a negative write.
		expect(resolveVListUserMarkerScrollTop(8, 16)).toBe(0);
		expect(resolveVListUserMarkerScrollTop(Number.NaN, 16)).toBe(0);
		expect(resolveVListUserMarkerScrollTop(100, Number.NaN)).toBe(100);
		expect(resolveVListUserMarkerScrollTop(100, -50)).toBe(100);
	});
});

describe("shouldShowVListUserMarkers", () => {
	it("shows the index only when scrolling can help", () => {
		expect(shouldShowVListUserMarkers(3, 4000, 600)).toBe(true);
		// No user turns → nothing to index.
		expect(shouldShowVListUserMarkers(0, 4000, 600)).toBe(false);
		// Document fits the viewport → the index would point at what is already visible.
		expect(shouldShowVListUserMarkers(3, 500, 600)).toBe(false);
		expect(shouldShowVListUserMarkers(3, 600, 600)).toBe(false);
		// Not measured yet.
		expect(shouldShowVListUserMarkers(3, 4000, 0)).toBe(false);
		expect(shouldShowVListUserMarkers(3, Number.NaN, 600)).toBe(false);
	});
});

describe("exact list wiring", () => {
	const source = readFileSync(`${import.meta.dir}/PretextExactMessageList.tsx`, "utf8");

	it("mounts the marker index inside the scroll viewport", () => {
		// Inside the viewport (not the canvas): a sticky overlay pinned to the
		// viewport top cannot work from within the absolutely-positioned canvas.
		expect(source).toContain("<VListUserMarkers");
		expect(source).toContain("viewportRef={viewportRef}");
		expect(source).toContain("onJump={handleUserMarkerJump}");
	});

	it("derives marker fractions from the full scrollable height", () => {
		// canvas total + tail footer — the same range the scrollbar spans.
		expect(source).toContain(
			"const scrollableHeight = (exactLayout?.totalHeight ?? 0) + footerHeight",
		);
		expect(source).toContain(
			"collectVListUserMarkers(renderItems, exactLayout?.items ?? [], scrollableHeight)",
		);
		expect(source).toContain(
			"collectVListCompactMarkers(renderItems, exactLayout?.items ?? [], scrollableHeight)",
		);
	});

	it("passes the compact marks and their jump handler to the track", () => {
		expect(source).toContain("compactMarkers={compactMarkers}");
		expect(source).toContain("onJumpCompact={handleCompactMarkerJump}");
		expect(source).toContain("resolveCompactLabel={resolveCompactMarkerLabel}");
	});

	it("unpins from the bottom when jumping so streaming cannot yank the reader back", () => {
		const handler = source.slice(
			source.indexOf("const handleUserMarkerJump"),
			source.indexOf("const resolveUserMarkerLabel"),
		);
		expect(handler).toContain("pinnedToBottomRef.current = false");
		expect(handler).toContain("setPinnedToBottom(false)");
		expect(handler).toContain("writeScrollTop(resolveVListUserMarkerScrollTop(");
	});

	it("keeps the overlay out of the measured height model", () => {
		const overlay = readFileSync(`${import.meta.dir}/VListUserMarkers.tsx`, "utf8");
		// Zero-height sticky box: it must never contribute scrollable height to the
		// document it indexes (CONTRACT.md §0 iron law 2).
		expect(overlay).toContain('position: "sticky"');
		expect(overlay).toContain("height: 0");
		// Marks are absolutely positioned inside the zero-height box.
		expect(overlay).toContain('position: "absolute"');
	});
});
