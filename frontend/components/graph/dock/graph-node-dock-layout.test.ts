import { describe, expect, test } from "bun:test";
import type { DockviewApi, SerializedDockview } from "dockview-react";
import { dockPanelId } from "../../narrator/dock/dock-panel-types";
import {
	applyChapterDockLayout,
	CHAPTER_DOCK_LAYOUT_MAX_BYTES,
	CHAPTER_DOCK_LAYOUT_VERSION,
	parseChapterDockLayout,
	serializeChapterDockLayout,
} from "./graph-node-dock-layout";

/** A serialized layout that `isRestorableLayout` accepts (has ≥1 panel). */
function fakeLayout(
	panelIds: string[],
	paramsById: Record<string, Record<string, unknown>> = {},
): SerializedDockview {
	const panels: Record<string, unknown> = {};
	for (const id of panelIds) panels[id] = { id, params: paramsById[id] };
	return {
		grid: { root: {}, width: 100, height: 100, orientation: "HORIZONTAL" },
		panels,
	} as unknown as SerializedDockview;
}

/**
 * Fake DockviewApi: `toJSON` returns a preset layout; `fromJSON` materializes a
 * configured panel set (so the chat-panel guard is exercised); addPanel/getPanel/
 * clear model a tiny panel registry.
 */
function makeApi(opts: {
	toJSON?: SerializedDockview;
	fromJSONThrows?: boolean;
	restoredPanelIds?: string[];
}): {
	api: DockviewApi;
	added: Array<{ id: string; tabComponent?: string; params?: Record<string, unknown> }>;
	restored: { value: SerializedDockview | null };
	clearedRef: { count: number };
} {
	const added: Array<{ id: string; tabComponent?: string; params?: Record<string, unknown> }> = [];
	const restored: { value: SerializedDockview | null } = { value: null };
	const clearedRef = { count: 0 };
	const present = new Map<string, { id: string }>();

	const api = {
		toJSON: () => opts.toJSON ?? fakeLayout(["x"]),
		fromJSON: (layout: SerializedDockview) => {
			if (opts.fromJSONThrows) throw new Error("bad layout");
			restored.value = layout;
			for (const id of opts.restoredPanelIds ?? []) present.set(id, { id });
		},
		getPanel: (id: string) => present.get(id),
		addPanel: (p: { id: string; tabComponent?: string; params?: Record<string, unknown> }) => {
			added.push(p);
			present.set(p.id, { id: p.id });
		},
		clear: () => {
			clearedRef.count++;
			present.clear();
		},
	} as unknown as DockviewApi;

	return { api, added, restored, clearedRef };
}

describe("serialize / parse round-trip", () => {
	test("serialize then parse returns the same panels", () => {
		const { api } = makeApi({ toJSON: fakeLayout(["chat", "term"]) });
		const raw = serializeChapterDockLayout(api);
		expect(raw).not.toBeNull();
		const parsed = parseChapterDockLayout(raw);
		expect(parsed).not.toBeNull();
		expect(Object.keys((parsed as SerializedDockview).panels)).toEqual(["chat", "term"]);
	});

	test("serialized payload carries the envelope version", () => {
		const { api } = makeApi({ toJSON: fakeLayout(["chat"]) });
		const raw = serializeChapterDockLayout(api) as string;
		expect(JSON.parse(raw).version).toBe(CHAPTER_DOCK_LAYOUT_VERSION);
	});

	test("host identity is stripped, resource identity is kept", () => {
		const { api } = makeApi({
			toJSON: fakeLayout(["chat", "sub", "file"], {
				chat: { panelType: "chat", narratorId: "narr_1", chapterId: "chap_1" },
				sub: { panelType: "subagent", subagentNarratorId: "narr_child", narratorId: "narr_1" },
				file: {
					panelType: "file",
					filePath: "/repo/a.ts",
					chapterId: "chap_1",
					largeFileConfirmed: true,
				},
			}),
		});
		const parsed = parseChapterDockLayout(serializeChapterDockLayout(api)) as SerializedDockview;
		const panels = parsed.panels as unknown as Record<string, { params: Record<string, unknown> }>;

		// Host identity gone everywhere.
		for (const id of ["chat", "sub", "file"]) {
			expect(panels[id].params.narratorId).toBeUndefined();
			expect(panels[id].params.chapterId).toBeUndefined();
		}
		// Resource identity survives — without it these panels point at nothing.
		expect(panels.sub.params.subagentNarratorId).toBe("narr_child");
		expect(panels.file.params.filePath).toBe("/repo/a.ts");
		expect(panels.file.params.largeFileConfirmed).toBe(true);
		// Panel kind survives too.
		expect(panels.chat.params.panelType).toBe("chat");
	});

	test("serializing does not mutate the live layout", () => {
		const live = fakeLayout(["chat"], { chat: { panelType: "chat", narratorId: "narr_1" } });
		const { api } = makeApi({ toJSON: live });
		serializeChapterDockLayout(api);
		const panels = live.panels as unknown as Record<string, { params: Record<string, unknown> }>;
		expect(panels.chat.params.narratorId).toBe("narr_1");
	});

	test("oversized layout returns null instead of a doomed request", () => {
		// One panel whose params hold a string past the byte cap.
		const huge = fakeLayout(["chat"], {
			chat: { panelType: "chat", blob: "x".repeat(CHAPTER_DOCK_LAYOUT_MAX_BYTES + 1) },
		});
		const { api } = makeApi({ toJSON: huge });
		expect(serializeChapterDockLayout(api)).toBeNull();
	});

	test("cap is measured in bytes, not UTF-16 code units", () => {
		// Each CJK char is 3 bytes in UTF-8 but 1 unit in `.length`. A payload
		// under the cap by `.length` but over it by bytes must be rejected.
		const cjkCount = Math.ceil(CHAPTER_DOCK_LAYOUT_MAX_BYTES / 3) + 10;
		expect(cjkCount).toBeLessThan(CHAPTER_DOCK_LAYOUT_MAX_BYTES);
		const { api } = makeApi({
			toJSON: fakeLayout(["chat"], { chat: { title: "叙".repeat(cjkCount) } }),
		});
		expect(serializeChapterDockLayout(api)).toBeNull();
	});
});

describe("parseChapterDockLayout", () => {
	test.each([null, undefined, ""])("empty input %p → null", (raw) => {
		expect(parseChapterDockLayout(raw as string | null | undefined)).toBeNull();
	});

	test("malformed JSON → null, never throws", () => {
		expect(parseChapterDockLayout("{not json")).toBeNull();
	});

	test("valid JSON with the wrong shape → null", () => {
		expect(parseChapterDockLayout(JSON.stringify({ nope: true }))).toBeNull();
		expect(parseChapterDockLayout(JSON.stringify({ layout: "a string" }))).toBeNull();
		expect(parseChapterDockLayout(JSON.stringify([1, 2, 3]))).toBeNull();
	});

	test("envelope with a panel-less layout → null (would restore a blank node)", () => {
		const raw = JSON.stringify({
			version: CHAPTER_DOCK_LAYOUT_VERSION,
			layout: { grid: { root: {} }, panels: {} },
		});
		expect(parseChapterDockLayout(raw)).toBeNull();
	});
});

describe("applyChapterDockLayout", () => {
	test("null layout → builds the default chat-only layout", () => {
		const { api, added, restored } = makeApi({});
		const usedPersisted = applyChapterDockLayout(api, null, "narr_1");
		expect(usedPersisted).toBe(false);
		expect(restored.value).toBeNull();
		expect(added.map((p) => p.id)).toEqual([dockPanelId("chat")]);
	});

	test("default chat panel gets the close-less tab and the live narrator id", () => {
		const { api, added } = makeApi({});
		applyChapterDockLayout(api, null, "narr_1");
		expect(added[0].tabComponent).toBe("chat");
		expect(added[0].params).toEqual({ panelType: "chat", narratorId: "narr_1" });
	});

	test("restorable layout containing chat → restored, nothing added", () => {
		const layout = fakeLayout([dockPanelId("chat"), dockPanelId("git")]);
		const { api, added, restored } = makeApi({
			restoredPanelIds: [dockPanelId("chat"), dockPanelId("git")],
		});
		expect(applyChapterDockLayout(api, layout, "narr_1")).toBe(true);
		expect(restored.value).toBe(layout);
		expect(added).toEqual([]);
	});

	test("restored layout without chat → discarded, default rebuilt", () => {
		const layout = fakeLayout([dockPanelId("git")]);
		const { api, added, clearedRef } = makeApi({ restoredPanelIds: [dockPanelId("git")] });
		expect(applyChapterDockLayout(api, layout, "narr_1")).toBe(false);
		expect(clearedRef.count).toBe(1);
		expect(added.map((p) => p.id)).toEqual([dockPanelId("chat")]);
	});

	test("fromJSON throwing → default rebuilt, partial layout cleared", () => {
		const { api, added, clearedRef } = makeApi({ fromJSONThrows: true });
		expect(applyChapterDockLayout(api, fakeLayout(["chat"]), "narr_1")).toBe(false);
		expect(clearedRef.count).toBe(1);
		expect(added.map((p) => p.id)).toEqual([dockPanelId("chat")]);
	});

	test("a layout whose narrator differs is still restored (identity is not persisted)", () => {
		// The focus page discards a foreign layout; here layouts are identity-free
		// by construction, which is what lets a node keep its panels across a
		// fork/split that changes the chapter's primary narrator.
		const layout = fakeLayout([dockPanelId("chat")]);
		const { api, added } = makeApi({ restoredPanelIds: [dockPanelId("chat")] });
		expect(applyChapterDockLayout(api, layout, "narr_DIFFERENT")).toBe(true);
		expect(added).toEqual([]);
	});
});
