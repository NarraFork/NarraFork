/**
 * Outline panels' params: what they keep, which panel a request opens in (one per space and
 * page), and that every place a layout is written and read back (the session dock, the
 * workspace, the outline page's dock, a detached window) keeps the panel's identity and its
 * focus, view and time, and never a page title (a layout can outlive its author in a shared
 * browser).
 */
import { describe, expect, test } from "bun:test";
import type { SerializedDockview } from "dockview-react";
import {
	isSameOutlinePanel,
	normalizeOutlinePanelState,
	type OutlinePanelState,
	outlinePanelIdentity,
	outlinePanelStateFor,
	outlinePanelTarget,
	outlinePanelTitle,
} from "../../../lib/outline-panel";
import {
	OUTLINE_PAGE_MAIN_ID,
	parseOutlinePageDock,
	serializeOutlinePageDock,
} from "../../outline-dock/outline-page-layout";
import {
	normalizePanelWindowDescriptor,
	parsePanelWindowDescriptor,
} from "../../window/panel-window";
import { stripIdentityFromLayout, stripNavigationFromLayout } from "../panels/layout-envelope";
import { outlineParamsPatch } from "./outline-dock";

const STORED: OutlinePanelState = {
	spaceId: "space_A1",
	blockId: "block-B2",
	pageId: "page-P1",
	view: "all",
	asOf: 7,
};
/** A panel's state as an older build stored it: with the page's title. */
const TITLE = "Design · 设计";
const PLACE: OutlinePanelState = { ...STORED, title: TITLE };

function layoutWith(panels: Record<string, Record<string, unknown>>): SerializedDockview {
	return {
		grid: {
			root: {
				type: "branch",
				data: [
					{
						type: "leaf",
						data: { views: Object.keys(panels), activeView: Object.keys(panels)[0], id: "g1" },
						size: 800,
					},
				],
				size: 600,
			},
			width: 800,
			height: 600,
			orientation: "HORIZONTAL",
		},
		panels: Object.fromEntries(
			Object.entries(panels).map(([id, params]) => [
				id,
				{
					id,
					contentComponent: String(params.panelType),
					params,
					// Tabs carry what they show (an outline panel: its page's title).
					title: typeof params.title === "string" ? params.title : id,
				},
			]),
		),
	} as unknown as SerializedDockview;
}

function paramsOf(layout: SerializedDockview, id: string): Record<string, unknown> {
	return (layout.panels as Record<string, { params: Record<string, unknown> }>)[id]?.params ?? {};
}

function titleOf(layout: SerializedDockview, id: string): string | undefined {
	return (layout.panels as Record<string, { title?: string }>)[id]?.title;
}

describe("outline panel state", () => {
	test("keeps well-formed fields and drops the rest, the title included", () => {
		expect(
			normalizeOutlinePanelState({
				panelType: "outline",
				...PLACE,
				hostNarratorId: "n1",
				extra: "x",
			}),
		).toEqual(STORED);
		expect(normalizeOutlinePanelState({ spaceId: "bad id/x", blockId: "b" })).toEqual({});
		expect(
			normalizeOutlinePanelState({ spaceId: "s", blockId: "b", asOf: -1, view: "weird" }),
		).toEqual({ spaceId: "s", blockId: "b" });
		// Time and view belong to a page, not to a space's list.
		expect(normalizeOutlinePanelState({ spaceId: "s", asOf: 3, view: "all", pageId: "p" })).toEqual(
			{ spaceId: "s" },
		);
		expect(normalizeOutlinePanelState({ title: "Outline" })).toEqual({});
		expect(normalizeOutlinePanelState({ spaceId: "s", title: "Secret page" })).toEqual({
			spaceId: "s",
		});
		// A title shown on a tab is trimmed and bounded.
		expect(outlinePanelTitle("x".repeat(500))).toHaveLength(200);
		expect(outlinePanelTitle("  ")).toBeUndefined();
	});

	test("what the view shows for a state", () => {
		expect(outlinePanelTarget({})).toEqual({ kind: "home" });
		expect(outlinePanelTarget({ spaceId: "s" })).toEqual({ kind: "space", spaceId: "s" });
		expect(outlinePanelTarget(PLACE)).toEqual({
			kind: "block",
			spaceId: "space_A1",
			blockId: "block-B2",
			view: "all",
			asOf: 7,
		});
	});

	test("navigating keeps the page while the focus moves to it", () => {
		expect(
			outlinePanelStateFor({ kind: "block", spaceId: "space_A1", blockId: "page-P1" }, PLACE),
		).toEqual({ spaceId: "space_A1", blockId: "page-P1", pageId: "page-P1" });
		// A view or time change keeps the focus, and so the page.
		expect(
			outlinePanelStateFor({ kind: "block", spaceId: "space_A1", blockId: "block-B2" }, PLACE),
		).toEqual({ spaceId: "space_A1", blockId: "block-B2", pageId: "page-P1" });
		expect(
			outlinePanelStateFor({ kind: "block", spaceId: "space_A1", blockId: "other" }, PLACE),
		).toEqual({ spaceId: "space_A1", blockId: "other" });
		expect(
			outlinePanelStateFor({ kind: "block", spaceId: "other", blockId: "x", asOf: 2 }, PLACE),
		).toEqual({ spaceId: "other", blockId: "x", asOf: 2 });
		expect(outlinePanelStateFor({ kind: "space", spaceId: "s" }, PLACE)).toEqual({ spaceId: "s" });
		expect(outlinePanelStateFor({ kind: "home" }, PLACE)).toEqual({});
	});
});

describe("which panel a request opens in", () => {
	test("one per space and page: a block of an open page reuses its panel", () => {
		const panel = { spaceId: "s", blockId: "b1", pageId: "p" };
		expect(outlinePanelIdentity(panel)).toBe("page:s/p");
		expect(isSameOutlinePanel(panel, { spaceId: "s", blockId: "b9", pageId: "p" })).toBe(true);
		expect(isSameOutlinePanel(panel, { spaceId: "s", blockId: "p" })).toBe(true);
		expect(isSameOutlinePanel(panel, { spaceId: "s", blockId: "b1" })).toBe(true);
		expect(isSameOutlinePanel(panel, { spaceId: "s", blockId: "q", pageId: "q" })).toBe(false);
		expect(isSameOutlinePanel(panel, { spaceId: "t", blockId: "b1", pageId: "p" })).toBe(false);
		// A panel whose page is not known yet matches by its block.
		expect(
			isSameOutlinePanel(
				{ spaceId: "s", blockId: "p" },
				{ spaceId: "s", blockId: "x", pageId: "p" },
			),
		).toBe(true);
	});

	test("a space's list and the home are their own panels", () => {
		expect(outlinePanelIdentity({ spaceId: "s" })).toBe("space:s");
		expect(outlinePanelIdentity({})).toBe("home");
		expect(isSameOutlinePanel({ spaceId: "s" }, { spaceId: "s" })).toBe(true);
		expect(isSameOutlinePanel({ spaceId: "s" }, { spaceId: "s", blockId: "p" })).toBe(false);
		expect(isSameOutlinePanel({}, {})).toBe(true);
	});

	test("the params patch replaces the whole outline state and nothing else", () => {
		expect(outlineParamsPatch({ spaceId: "s" })).toEqual({
			spaceId: "s",
			blockId: undefined,
			pageId: undefined,
			view: undefined,
			asOf: undefined,
			title: undefined,
		});
		expect(Object.keys(outlineParamsPatch(PLACE)).sort()).toEqual(
			["asOf", "blockId", "pageId", "spaceId", "title", "view"].sort(),
		);
		// A title is never written, and one an older build stored is removed.
		expect(outlineParamsPatch(PLACE).title).toBeUndefined();
	});
});

describe("layouts keep an outline panel's identity, never its title", () => {
	const focusPanel = { panelType: "outline", ...PLACE };

	test("the session dock (kept per session and device, whoever is signed in)", () => {
		const saved = stripIdentityFromLayout(
			layoutWith({ chat: { panelType: "chat", narratorId: "n1" }, o: focusPanel }),
		);
		const restored = JSON.parse(JSON.stringify(saved)) as SerializedDockview;
		expect(normalizeOutlinePanelState(paramsOf(restored, "o"))).toEqual(STORED);
		expect(paramsOf(restored, "o").title).toBeUndefined();
		expect(titleOf(restored, "o")).toBeUndefined();
		expect(JSON.stringify(saved)).not.toContain(TITLE);
		expect(paramsOf(restored, "chat").narratorId).toBeUndefined();
	});

	test("the workspace (member rows and resource hosts survive)", () => {
		const saved = stripNavigationFromLayout(
			layoutWith({
				wsp_row1: { panelType: "outline", ...PLACE, panelRowId: "row1" },
				woutline_n1_x: { panelType: "outline", ...PLACE, hostNarratorId: "n1" },
			}),
		);
		const restored = JSON.parse(JSON.stringify(saved)) as SerializedDockview;
		expect(paramsOf(restored, "wsp_row1")).toEqual({
			panelType: "outline",
			...STORED,
			panelRowId: "row1",
		});
		expect(paramsOf(restored, "woutline_n1_x").hostNarratorId).toBe("n1");
		expect(normalizeOutlinePanelState(paramsOf(restored, "woutline_n1_x"))).toEqual(STORED);
		expect(JSON.stringify(saved)).not.toContain(TITLE);
	});

	test("the outline page's dock (sessions and side panels kept, the main panel follows the URL)", () => {
		const text = serializeOutlinePageDock(
			layoutWith({
				[OUTLINE_PAGE_MAIN_ID]: { panelType: "outline-main", spaceId: "leaked", title: "Main" },
				"onarrator-n1": { panelType: "narrator", narratorId: "n1", highlightMessageId: "m" },
				o: focusPanel,
			}),
		);
		expect(text).not.toBeNull();
		const restored = parseOutlinePageDock(text);
		if (!restored) throw new Error("not restored");
		expect(paramsOf(restored, OUTLINE_PAGE_MAIN_ID)).toEqual({ panelType: "outline-main" });
		expect(titleOf(restored, OUTLINE_PAGE_MAIN_ID)).toBeUndefined();
		expect(paramsOf(restored, "onarrator-n1")).toEqual({ panelType: "narrator", narratorId: "n1" });
		expect(normalizeOutlinePanelState(paramsOf(restored, "o"))).toEqual(STORED);
		expect(text).not.toContain(TITLE);
		// Not this version, not JSON, or no main panel: nothing to restore.
		expect(parseOutlinePageDock(text?.replace('"version":1', '"version":2') ?? null)).toBeNull();
		expect(parseOutlinePageDock("{")).toBeNull();
		expect(
			parseOutlinePageDock(serializeOutlinePageDock(layoutWith({ o: focusPanel }))),
		).toBeNull();
	});

	test("a detached window (host and row stay behind)", () => {
		const descriptor = normalizePanelWindowDescriptor({
			panelType: "outline",
			...PLACE,
			hostNarratorId: "n1",
			panelRowId: "row1",
		});
		expect(descriptor).toEqual({ panelType: "outline", ...STORED });
		expect(parsePanelWindowDescriptor(JSON.stringify(descriptor))).toEqual(descriptor);
	});
});
