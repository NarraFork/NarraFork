import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DockviewApi, SerializedDockview } from "dockview-react";
import { dockPanelId, subagentDockPanelId } from "./dock-panel-types";
import {
	applyNarratorDockLayout,
	cleanupStaleNarratorDockLayouts,
	clearNarratorDockLayout,
	DOCK_LAYOUT_MAX_AGE_MS,
	loadNarratorDockLayout,
	NARRATOR_DOCK_LAYOUT_VERSION,
	saveNarratorDockLayout,
} from "./narrator-dock-layout";

// ── localStorage stub (bun test has no DOM) ──
class MemoryStorage {
	private store = new Map<string, string>();
	getItem(k: string) {
		return this.store.get(k) ?? null;
	}
	setItem(k: string, v: string) {
		this.store.set(k, String(v));
	}
	removeItem(k: string) {
		this.store.delete(k);
	}
	clear() {
		this.store.clear();
	}
	get length() {
		return this.store.size;
	}
	key(index: number) {
		return [...this.store.keys()][index] ?? null;
	}
	get size() {
		return this.store.size;
	}
}

let mem: MemoryStorage;
beforeEach(() => {
	mem = new MemoryStorage();
	(globalThis as unknown as { localStorage: Storage }).localStorage = mem as unknown as Storage;
});
afterEach(() => {
	(globalThis as unknown as { localStorage?: Storage }).localStorage = undefined;
});

/**
 * A serialized layout that `isRestorableLayout` accepts (has ≥1 panel).
 * Panels may carry params (e.g. narratorId) to exercise the identity guard.
 */
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
 * Fake DockviewApi: toJSON returns a preset layout; fromJSON records what was
 * restored (and materializes panels with their params); addPanel/getPanel/clear
 * model a tiny panel set so the chat-panel + identity guards are exercised.
 */
function makeApi(opts: {
	toJSON?: SerializedDockview;
	fromJSONThrows?: boolean;
	// Panels that "exist" after fromJSON restores (drives the chat guard).
	restoredPanelIds?: string[];
	// Params attached to restored panels (drives the identity guard).
	restoredParamsById?: Record<string, Record<string, unknown>>;
}): {
	api: DockviewApi;
	added: string[];
	restored: SerializedDockview | null;
	clearedRef: { count: number };
} {
	const added: string[] = [];
	let restored: SerializedDockview | null = null;
	// Object holder (not a bare primitive) so callers observe increments after
	// destructuring — a destructured `number` would capture only the value at
	// return time and never see later `clear()` calls.
	const clearedRef = { count: 0 };
	const present = new Map<string, { id: string; params?: Record<string, unknown> }>();

	const api = {
		toJSON: () => opts.toJSON ?? fakeLayout(["x"]),
		fromJSON: (layout: SerializedDockview) => {
			if (opts.fromJSONThrows) throw new Error("bad layout");
			restored = layout;
			for (const id of opts.restoredPanelIds ?? []) {
				present.set(id, { id, params: opts.restoredParamsById?.[id] });
			}
		},
		getPanel: (id: string) => present.get(id),
		addPanel: (p: { id: string; params?: Record<string, unknown> }) => {
			added.push(p.id);
			present.set(p.id, { id: p.id, params: p.params });
		},
		clear: () => {
			clearedRef.count++;
			present.clear();
		},
	} as unknown as DockviewApi;

	return { api, added, restored, clearedRef };
}

/** Load a persisted layout and return its panel-id keys (asserting presence). */
function panelKeys(narratorId: string, device: "desktop" | "mobile"): string[] {
	const loaded = loadNarratorDockLayout(narratorId, device);
	if (!loaded) throw new Error(`expected a persisted layout for ${narratorId}/${device}`);
	return Object.keys(loaded.panels);
}

describe("save / load round-trip", () => {
	test("save then load returns the same layout", () => {
		const { api } = makeApi({ toJSON: fakeLayout(["chat", "term"]) });
		saveNarratorDockLayout(api, "narr_1", "desktop");
		const loaded = loadNarratorDockLayout("narr_1", "desktop");
		expect(loaded).not.toBeNull();
		expect(Object.keys((loaded as SerializedDockview).panels)).toEqual(["chat", "term"]);
	});

	test("desktop and mobile layouts are stored under independent keys", () => {
		const desk = makeApi({ toJSON: fakeLayout(["chat"]) });
		const mob = makeApi({ toJSON: fakeLayout(["chat", "spec"]) });
		saveNarratorDockLayout(desk.api, "narr_1", "desktop");
		saveNarratorDockLayout(mob.api, "narr_1", "mobile");
		expect(panelKeys("narr_1", "desktop")).toEqual(["chat"]);
		expect(panelKeys("narr_1", "mobile")).toEqual(["chat", "spec"]);
	});

	test("layouts are keyed per narrator", () => {
		const a = makeApi({ toJSON: fakeLayout(["chat"]) });
		saveNarratorDockLayout(a.api, "narr_A", "desktop");
		expect(loadNarratorDockLayout("narr_A", "desktop")).not.toBeNull();
		expect(loadNarratorDockLayout("narr_B", "desktop")).toBeNull();
	});

	test("clear removes a persisted layout", () => {
		const { api } = makeApi({ toJSON: fakeLayout(["chat"]) });
		saveNarratorDockLayout(api, "narr_1", "desktop");
		clearNarratorDockLayout("narr_1", "desktop");
		expect(loadNarratorDockLayout("narr_1", "desktop")).toBeNull();
	});
});

describe("loadNarratorDockLayout — validation", () => {
	test("missing key → null", () => {
		expect(loadNarratorDockLayout("nope", "desktop")).toBeNull();
	});

	test("malformed JSON → null (no throw)", () => {
		mem.setItem("narrafork_ndock_narr_1_desktop", "{not json");
		expect(loadNarratorDockLayout("narr_1", "desktop")).toBeNull();
	});

	test("envelope without panels → null (unrestorable)", () => {
		mem.setItem(
			"narrafork_ndock_narr_1_desktop",
			JSON.stringify({
				version: NARRATOR_DOCK_LAYOUT_VERSION,
				layout: { grid: {}, panels: {} },
			}),
		);
		expect(loadNarratorDockLayout("narr_1", "desktop")).toBeNull();
	});
});

describe("applyNarratorDockLayout", () => {
	test("no saved layout → builds default chat-only layout, returns false", () => {
		const { api, added } = makeApi({});
		const restored = applyNarratorDockLayout(api, "narr_1", "desktop");
		expect(restored).toBe(false);
		expect(added).toEqual([dockPanelId("chat")]);
	});

	test("valid saved layout containing chat → restores it, returns true", () => {
		// Seed a saved layout that includes the chat panel.
		const seed = makeApi({ toJSON: fakeLayout([dockPanelId("chat"), dockPanelId("git")]) });
		saveNarratorDockLayout(seed.api, "narr_1", "desktop");

		const { api, added } = makeApi({
			restoredPanelIds: [dockPanelId("chat"), dockPanelId("git")],
		});
		const restored = applyNarratorDockLayout(api, "narr_1", "desktop");
		expect(restored).toBe(true);
		// Did not fall back to creating a default chat panel.
		expect(added).toHaveLength(0);
	});

	test("restored layout missing chat panel → falls back to default", () => {
		const seed = makeApi({ toJSON: fakeLayout([dockPanelId("git")]) });
		saveNarratorDockLayout(seed.api, "narr_1", "desktop");

		// fromJSON "succeeds" but no chat panel is present afterwards.
		const { api, added } = makeApi({ restoredPanelIds: [dockPanelId("git")] });
		const restored = applyNarratorDockLayout(api, "narr_1", "desktop");
		expect(restored).toBe(false);
		expect(added).toEqual([dockPanelId("chat")]);
	});

	test("fromJSON throwing → falls back to default chat layout", () => {
		const seed = makeApi({ toJSON: fakeLayout([dockPanelId("chat")]) });
		saveNarratorDockLayout(seed.api, "narr_1", "desktop");

		const { api, added } = makeApi({ fromJSONThrows: true });
		const restored = applyNarratorDockLayout(api, "narr_1", "desktop");
		expect(restored).toBe(false);
		expect(added).toEqual([dockPanelId("chat")]);
	});

	test("restored layout with a FOREIGN narrator id → discarded, rebuilt default", () => {
		// Simulate a corrupted/legacy layout whose chat panel was serialized for a
		// different narrator. Restoring it verbatim would render the wrong narrator.
		mem.setItem(
			"narrafork_ndock_narr_1_desktop",
			JSON.stringify({
				version: NARRATOR_DOCK_LAYOUT_VERSION,
				layout: fakeLayout([dockPanelId("chat"), dockPanelId("git")], {
					[dockPanelId("chat")]: { panelType: "chat", narratorId: "narr_OTHER" },
				}),
			}),
		);
		const { api, added, clearedRef } = makeApi({
			restoredPanelIds: [dockPanelId("chat"), dockPanelId("git")],
			restoredParamsById: {
				[dockPanelId("chat")]: { panelType: "chat", narratorId: "narr_OTHER" },
			},
		});
		const restored = applyNarratorDockLayout(api, "narr_1", "desktop");
		expect(restored).toBe(false);
		expect(clearedRef.count).toBe(1); // foreign layout was cleared
		expect(added).toEqual([dockPanelId("chat")]); // default rebuilt
	});

	test("restored chat panel matching the current narrator → accepted", () => {
		mem.setItem(
			"narrafork_ndock_narr_1_desktop",
			JSON.stringify({
				version: NARRATOR_DOCK_LAYOUT_VERSION,
				layout: fakeLayout([dockPanelId("chat")], {
					[dockPanelId("chat")]: { panelType: "chat", narratorId: "narr_1" },
				}),
			}),
		);
		const { api, added } = makeApi({
			restoredPanelIds: [dockPanelId("chat")],
			restoredParamsById: { [dockPanelId("chat")]: { panelType: "chat", narratorId: "narr_1" } },
		});
		const restored = applyNarratorDockLayout(api, "narr_1", "desktop");
		expect(restored).toBe(true);
		expect(added).toHaveLength(0);
	});
});

describe("saveNarratorDockLayout — identity stripping", () => {
	test("host identity is stripped while subagent resource identity is preserved", () => {
		const subagentPanelId = subagentDockPanelId("subagent_1");
		const { api } = makeApi({
			toJSON: fakeLayout([dockPanelId("chat"), dockPanelId("git"), subagentPanelId], {
				[dockPanelId("chat")]: { panelType: "chat", narratorId: "narr_1" },
				[dockPanelId("git")]: { panelType: "git", narratorId: "narr_1", chapterId: "chap_1" },
				[subagentPanelId]: {
					panelType: "subagent",
					subagentNarratorId: "subagent_1",
				},
			}),
		});
		saveNarratorDockLayout(api, "narr_1", "desktop");

		const loaded = loadNarratorDockLayout("narr_1", "desktop");
		expect(loaded).not.toBeNull();
		const panels = (
			loaded as unknown as { panels: Record<string, { params?: Record<string, unknown> }> }
		).panels;
		expect(panels[dockPanelId("chat")].params).toEqual({ panelType: "chat" });
		expect(panels[dockPanelId("git")].params).toEqual({ panelType: "git" });
		expect(panels[subagentPanelId].params).toEqual({
			panelType: "subagent",
			subagentNarratorId: "subagent_1",
		});
	});
});

describe("cleanupStaleNarratorDockLayouts", () => {
	const NOW = 1_000_000_000_000;

	function seed(narratorId: string, device: "desktop" | "mobile", lastOpenedAt?: number) {
		const envelope = {
			version: NARRATOR_DOCK_LAYOUT_VERSION,
			layout: fakeLayout([dockPanelId("chat")]),
			...(lastOpenedAt !== undefined ? { lastOpenedAt } : {}),
		};
		mem.setItem(`narrafork_ndock_${narratorId}_${device}`, JSON.stringify(envelope));
	}

	test("removes layouts older than the max age, keeps fresh ones", () => {
		seed("stale", "desktop", NOW - DOCK_LAYOUT_MAX_AGE_MS - 1);
		seed("fresh", "desktop", NOW - 1000);
		const removed = cleanupStaleNarratorDockLayouts(NOW, DOCK_LAYOUT_MAX_AGE_MS, mem);
		expect(removed).toBe(1);
		expect(loadNarratorDockLayout("stale", "desktop")).toBeNull();
		expect(loadNarratorDockLayout("fresh", "desktop")).not.toBeNull();
	});

	test("keeps age-unknown entries (no lastOpenedAt)", () => {
		seed("legacy", "desktop"); // no lastOpenedAt
		const removed = cleanupStaleNarratorDockLayouts(NOW, DOCK_LAYOUT_MAX_AGE_MS, mem);
		expect(removed).toBe(0);
		expect(loadNarratorDockLayout("legacy", "desktop")).not.toBeNull();
	});

	test("removes unparseable entries under the prefix", () => {
		mem.setItem("narrafork_ndock_broken_desktop", "{not json");
		const removed = cleanupStaleNarratorDockLayouts(NOW, DOCK_LAYOUT_MAX_AGE_MS, mem);
		expect(removed).toBe(1);
		expect(mem.getItem("narrafork_ndock_broken_desktop")).toBeNull();
	});

	test("ignores unrelated localStorage keys", () => {
		mem.setItem("some_other_key", "value");
		seed("stale", "desktop", NOW - DOCK_LAYOUT_MAX_AGE_MS - 1);
		cleanupStaleNarratorDockLayouts(NOW, DOCK_LAYOUT_MAX_AGE_MS, mem);
		expect(mem.getItem("some_other_key")).toBe("value");
	});
});
