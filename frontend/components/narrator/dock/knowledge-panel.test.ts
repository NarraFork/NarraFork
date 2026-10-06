import { describe, expect, test } from "bun:test";
import type { SerializedDockview } from "dockview-react";
import { stripIdentityFromLayout } from "../panels/layout-envelope";
import { knowledgeDockPanelId } from "./dock-panel-types";

describe("knowledgeDockPanelId", () => {
	test("produces stable id from entryId", () => {
		const id = knowledgeDockPanelId("abc123xyz");
		expect(id).toBe("ndock-knowledge-abc123xyz");
	});

	test("different entryIds produce different panel ids", () => {
		const a = knowledgeDockPanelId("entryA");
		const b = knowledgeDockPanelId("entryB");
		expect(a).not.toBe(b);
	});

	test("same entryId always produces same id (idempotent)", () => {
		const id1 = knowledgeDockPanelId("test123");
		const id2 = knowledgeDockPanelId("test123");
		expect(id1).toBe(id2);
	});
});

describe("stripIdentityFromLayout preserves knowledge panel resource identity", () => {
	test("entryId and scope survive strip", () => {
		const layout: SerializedDockview = {
			grid: {
				root: { type: "branch", data: [] },
				width: 800,
				height: 600,
				orientation: "HORIZONTAL",
			},
			panels: {
				"ndock-knowledge-entry1": {
					id: "ndock-knowledge-entry1",
					contentComponent: "knowledge",
					params: {
						panelType: "knowledge",
						entryId: "entry1",
						scope: "global",
						narratorId: "narrator-should-be-stripped",
						chapterId: "chapter-should-be-stripped",
					},
				},
			},
		} as unknown as SerializedDockview;

		const stripped = stripIdentityFromLayout(layout);
		const panels = (
			stripped as unknown as { panels: Record<string, { params: Record<string, unknown> }> }
		).panels;
		const params = panels["ndock-knowledge-entry1"].params;

		// Resource identity preserved
		expect(params.entryId).toBe("entry1");
		expect(params.scope).toBe("global");
		// Host identity stripped
		expect(params.narratorId).toBeUndefined();
		expect(params.chapterId).toBeUndefined();
	});

	test("personal scope preserved", () => {
		const layout: SerializedDockview = {
			grid: {
				root: { type: "branch", data: [] },
				width: 800,
				height: 600,
				orientation: "HORIZONTAL",
			},
			panels: {
				"ndock-knowledge-personal1": {
					id: "ndock-knowledge-personal1",
					contentComponent: "knowledge",
					params: {
						panelType: "knowledge",
						entryId: "personal1",
						scope: "personal",
					},
				},
			},
		} as unknown as SerializedDockview;

		const stripped = stripIdentityFromLayout(layout);
		const panels = (
			stripped as unknown as { panels: Record<string, { params: Record<string, unknown> }> }
		).panels;
		const params = panels["ndock-knowledge-personal1"].params;

		expect(params.entryId).toBe("personal1");
		expect(params.scope).toBe("personal");
	});
});
