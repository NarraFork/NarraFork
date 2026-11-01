import { describe, expect, test } from "bun:test";
import type { DockviewApi } from "dockview-react";
import {
	fitWidePanelHeight,
	resolveFileBrowserPosition,
	resolveToolPlacement,
	WIDE_TOOL_PANEL_MIN_HEIGHT,
} from "./tool-placement";

describe("resolveFileBrowserPosition", () => {
	const browser = { id: "tree", group: { id: "left" }, params: { panelType: "filetree" } };
	const sibling = { id: "sibling", group: { id: "left" }, params: { panelType: "file" } };
	const chat = { id: "chat", group: { id: "middle" }, params: { panelType: "chat" } };
	const file = { id: "file", group: { id: "right" }, params: { panelType: "file" } };
	function api(panels: (typeof browser)[]) {
		return {
			panels,
			getPanel: (id: string) => panels.find((panel) => panel.id === id),
		} as unknown as DockviewApi;
	}
	test("prefers another file group, never a sibling tab of the browser", () => {
		expect(
			resolveFileBrowserPosition(api([browser, sibling, chat, file]), "tree")?.referenceGroup?.id,
		).toBe(file.group.id);
	});
	test("uses another window even when it only contains chat", () => {
		expect(
			resolveFileBrowserPosition(api([browser, sibling, chat]), "tree")?.referenceGroup?.id,
		).toBe(chat.group.id);
	});
	test("splits right when no other group exists", () => {
		expect(resolveFileBrowserPosition(api([browser, sibling]), "tree")).toEqual({
			referencePanel: "tree",
			direction: "right",
		});
	});
	test("retains default placement without a source on this surface", () => {
		expect(resolveFileBrowserPosition(api([browser]))).toBeUndefined();
		expect(resolveFileBrowserPosition(api([browser]), "detached")).toBeUndefined();
	});
});

describe("resolveToolPlacement", () => {
	test("first tool with chat present → split right at ~1/3 width", () => {
		const p = resolveToolPlacement({
			hasSecondaryGroup: false,
			hasChatPanel: true,
			surfaceWidth: 900,
		});
		expect(p).toEqual({ mode: "split-right", initialWidth: 300 });
	});

	test("subsequent tool → stacks within the existing secondary group", () => {
		const p = resolveToolPlacement({
			hasSecondaryGroup: true,
			hasChatPanel: true,
			surfaceWidth: 900,
		});
		expect(p).toEqual({ mode: "within-secondary" });
	});

	test("secondary group takes precedence even if width is unknown", () => {
		const p = resolveToolPlacement({
			hasSecondaryGroup: true,
			hasChatPanel: true,
			surfaceWidth: 0,
		});
		expect(p.mode).toBe("within-secondary");
	});

	test("unknown surface width → split right with undefined initialWidth", () => {
		const p = resolveToolPlacement({
			hasSecondaryGroup: false,
			hasChatPanel: true,
			surfaceWidth: 0,
		});
		expect(p).toEqual({ mode: "split-right", initialWidth: undefined });
	});

	test("no chat panel (defensive) → standalone", () => {
		const p = resolveToolPlacement({
			hasSecondaryGroup: false,
			hasChatPanel: false,
			surfaceWidth: 900,
		});
		expect(p).toEqual({ mode: "standalone" });
	});
});

describe("resolveToolPlacement wide panels", () => {
	test("a wide panel splits above chat even when a secondary group exists", () => {
		expect(
			resolveToolPlacement({
				hasSecondaryGroup: true,
				hasChatPanel: true,
				surfaceWidth: 1200,
				surfaceHeight: 900,
				wide: true,
			}),
		).toEqual({ mode: "split-above", initialHeight: 380 });
		expect(
			resolveToolPlacement({
				hasSecondaryGroup: false,
				hasChatPanel: true,
				surfaceWidth: 1200,
				surfaceHeight: 400,
				wide: true,
			}),
		).toEqual({ mode: "split-above", initialHeight: 220 });
	});

	test("without chat a wide panel falls back to the normal rules", () => {
		expect(
			resolveToolPlacement({
				hasSecondaryGroup: false,
				hasChatPanel: false,
				surfaceWidth: 0,
				wide: true,
			}),
		).toEqual({ mode: "standalone" });
	});
});

describe("fitWidePanelHeight", () => {
	test("fits content plus chrome", () => {
		expect(fitWidePanelHeight(150, 70, 900)).toBe(220);
	});
	test("never shrinks below the minimum or grows past the surface share", () => {
		expect(fitWidePanelHeight(10, 20, 900)).toBe(WIDE_TOOL_PANEL_MIN_HEIGHT);
		expect(fitWidePanelHeight(2000, 70, 900)).toBe(495);
		expect(fitWidePanelHeight(2000, 70, 100)).toBe(WIDE_TOOL_PANEL_MIN_HEIGHT);
	});
});
