import { describe, expect, test } from "bun:test";
import type { SerializedDockview } from "dockview-react";
import { DETACHABLE_PANEL_KINDS, isDetachablePanelKind, isMultiInstanceKind } from "./detachable";
import {
	addDetachedNode,
	countPendingPanels,
	DETACHED_PANELS_MAX_BYTES,
	DETACHED_PANELS_VERSION,
	type DetachedNode,
	generateDetachedPanelId,
	hasPendingPanel,
	MAX_DETACHED_PANELS,
	makePanelEntry,
	panelIdFor,
	parseDetachedNodes,
	removeDetachedNode,
	resourceIdOf,
	serializeDetachedNodes,
	setDetachedLayout,
	updateDetachedNodeGeometry,
} from "./detached-panels";

/** A minimal but restorable-looking dockview layout. */
function layout(panelIds: string[] = ["ndock-terminal"]): SerializedDockview {
	return {
		grid: {
			root: { type: "leaf", data: { views: panelIds, id: "g1" } },
			height: 100,
			width: 100,
			orientation: "HORIZONTAL",
		},
		panels: Object.fromEntries(panelIds.map((id) => [id, { id, contentComponent: "tool" }])),
		// biome-ignore lint/suspicious/noExplicitAny: a hand-built fixture, not dockview output
	} as any;
}

/** A node awaiting first mount (a fresh tear-out, or upgraded from v1/v2). */
function pending(over: Partial<DetachedNode> = {}): DetachedNode {
	return {
		id: "n1",
		x: 10,
		y: 20,
		w: 480,
		h: 360,
		pendingPanels: [makePanelEntry("terminal")],
		...over,
	};
}

/** A node that already owns a dockview layout. */
function mounted(over: Partial<DetachedNode> = {}): DetachedNode {
	return { id: "n1", x: 10, y: 20, w: 480, h: 360, layout: layout(), ...over };
}

describe("device-scoped pending file panels", () => {
	test("historical pending panels survive persistence and remain distinct from live files", () => {
		const toolEdit = { narratorId: "origin", toolUseId: "sdk-id", executionAttempt: 2 };
		const resourceId = JSON.stringify(["DeviceA", "/repo/a.ts", true, toolEdit]);
		const entry = makePanelEntry("file", resourceId);
		const live = makePanelEntry("file", JSON.stringify(["DeviceA", "/repo/a.ts"]));
		expect(entry.toolEdit).toEqual(toolEdit);
		expect(entry.panelId).not.toBe(live.panelId);
		expect(
			panelIdFor(
				"file",
				JSON.stringify([
					"DeviceA",
					"/repo/a.ts",
					false,
					{ executionAttempt: 2, toolUseId: "sdk-id", narratorId: "origin" },
				]),
			),
		).toBe(entry.panelId);
		const parsed = parseDetachedNodes(
			serializeDetachedNodes([pending({ pendingPanels: [entry, live] })]),
		);
		expect(parsed[0].pendingPanels).toEqual([entry, live]);
		expect(resourceIdOf(parsed[0].pendingPanels?.[0] as typeof entry)).toBe(resourceId);
		const invalid = { ...entry, toolEdit: { ...toolEdit, executionAttempt: -1 } };
		const bad = JSON.stringify({ nodes: [pending({ pendingPanels: [invalid] })] });
		expect(parseDetachedNodes(bad)).toEqual([]);
	});

	test("scoped local references remain scoped after a detached layout round-trip", () => {
		const entry = makePanelEntry("file", JSON.stringify(["local", "/repo/a.png", true]));
		expect(entry).toMatchObject({
			filePath: "/repo/a.png",
			deviceId: "local",
			referenceOrigin: true,
		});
		const nodes = parseDetachedNodes(serializeDetachedNodes([pending({ pendingPanels: [entry] })]));
		expect(nodes[0].pendingPanels?.[0].referenceOrigin).toBe(true);
	});
	test("retains device identity through detach and layout round-trip", () => {
		const entry = makePanelEntry("file", JSON.stringify(["DeviceA", "/repo/a.ts"]));
		expect(entry).toMatchObject({ filePath: "/repo/a.ts", deviceId: "DeviceA" });
		const nodes = parseDetachedNodes(serializeDetachedNodes([pending({ pendingPanels: [entry] })]));
		expect(nodes[0].pendingPanels?.[0]).toEqual(entry);
	});
});

describe("detachable kinds", () => {
	test("the panels that depend on chat-published props are NOT detachable", () => {
		// details/filemod read dock.detailsProps / dock.fileModProps, which only the
		// chat panel publishes; detached they would load forever.
		expect(isDetachablePanelKind("details")).toBe(false);
		expect(isDetachablePanelKind("filemod")).toBe(false);
	});

	test("chat, webview, plugin and mock are not detachable", () => {
		for (const kind of ["chat", "webview", "plugin", "mock"]) {
			expect(isDetachablePanelKind(kind)).toBe(false);
		}
	});

	test("the self-contained panels are detachable", () => {
		for (const kind of ["terminal", "browser", "userchat", "tasks", "git", "spec", "search"]) {
			expect(isDetachablePanelKind(kind)).toBe(true);
		}
	});

	test("rejects non-string and unknown values", () => {
		for (const v of [undefined, null, 42, {}, "", "Terminal"]) {
			expect(isDetachablePanelKind(v)).toBe(false);
		}
	});

	test("only subagent and file are multi-instance", () => {
		for (const kind of DETACHABLE_PANEL_KINDS) {
			expect(isMultiInstanceKind(kind)).toBe(kind === "subagent" || kind === "file");
		}
	});
});

describe("panelIdFor", () => {
	test("singleton kinds are identified by kind alone (one per chapter)", () => {
		expect(panelIdFor("terminal")).toBe("terminal");
		// A stray resourceId must not create a second identity for a singleton, or the
		// duplicate check would let the same panel open twice.
		expect(panelIdFor("spec", "/tmp/a.ts")).toBe("spec");
	});

	test("multi-instance kinds fold the resource into the id", () => {
		expect(panelIdFor("file", "/a.ts")).not.toBe(panelIdFor("file", "/b.ts"));
		expect(panelIdFor("subagent", "narr_1")).not.toBe(panelIdFor("subagent", "narr_2"));
	});
});

describe("serialize / parse round-trip", () => {
	test("round-trips a node that owns a layout", () => {
		const list = [mounted()];
		expect(parseDetachedNodes(serializeDetachedNodes(list))).toEqual(list);
	});

	test("round-trips a node still awaiting first mount", () => {
		const list = [pending()];
		expect(parseDetachedNodes(serializeDetachedNodes(list))).toEqual(list);
	});

	test("keeps resource identity for multi-instance pending panels", () => {
		const list = [
			pending({
				pendingPanels: [makePanelEntry("file", "/repo/a.ts"), makePanelEntry("subagent", "narr_x")],
			}),
		];
		const parsed = parseDetachedNodes(serializeDetachedNodes(list));
		expect(parsed[0].pendingPanels?.[0].filePath).toBe("/repo/a.ts");
		expect(parsed[0].pendingPanels?.[1].subagentNarratorId).toBe("narr_x");
	});

	test("carries the envelope version", () => {
		const raw = serializeDetachedNodes([mounted()]) as string;
		expect(JSON.parse(raw).version).toBe(DETACHED_PANELS_VERSION);
	});

	test("oversized payload returns null instead of a doomed request", () => {
		const huge = [
			pending({ pendingPanels: [makePanelEntry("file", "x".repeat(DETACHED_PANELS_MAX_BYTES))] }),
		];
		expect(serializeDetachedNodes(huge)).toBeNull();
	});

	test("cap is measured in bytes, not UTF-16 code units", () => {
		const cjkCount = Math.ceil(DETACHED_PANELS_MAX_BYTES / 3) + 10;
		expect(cjkCount).toBeLessThan(DETACHED_PANELS_MAX_BYTES);
		expect(
			serializeDetachedNodes([
				pending({ pendingPanels: [makePanelEntry("file", "叙".repeat(cjkCount))] }),
			]),
		).toBeNull();
	});

	test("the cap leaves room for real dockview layouts", () => {
		// The column used to be 16KB on the assumption of a short flat list. Several
		// nodes each carrying a layout must still fit.
		const many = Array.from({ length: 6 }, (_, i) =>
			mounted({ id: `n${i}`, layout: layout(["ndock-terminal", "ndock-spec", "ndock-git"]) }),
		);
		expect(serializeDetachedNodes(many)).not.toBeNull();
	});
});

describe("parseDetachedNodes — upgrading older shapes", () => {
	// Real v1 data: one entry per panel, kind and geometry inline, under `panels`.
	const v1 = (over: Record<string, unknown> = {}) => ({
		id: "p1",
		kind: "terminal",
		x: 10,
		y: 20,
		w: 480,
		h: 360,
		...over,
	});

	test("v1 flat entry → a node awaiting mount with that one panel", () => {
		const parsed = parseDetachedNodes(JSON.stringify({ version: 1, panels: [v1()] }));
		expect(parsed).toEqual([
			{ id: "p1", x: 10, y: 20, w: 480, h: 360, pendingPanels: [makePanelEntry("terminal")] },
		]);
		// Crucially NOT a layout: this module is pure and cannot build one.
		expect(parsed[0].layout).toBeUndefined();
	});

	test("v1 multi-instance entry keeps its resource", () => {
		const raw = JSON.stringify({
			version: 1,
			panels: [v1({ kind: "file", filePath: "/a.ts" })],
		});
		expect(parseDetachedNodes(raw)[0].pendingPanels?.[0]).toEqual(makePanelEntry("file", "/a.ts"));
	});

	test("v2 panels[] → the same panels, awaiting mount", () => {
		const raw = JSON.stringify({
			version: 2,
			nodes: [
				{
					id: "n1",
					x: 0,
					y: 0,
					w: 480,
					h: 360,
					activePanelId: "spec",
					panels: [{ kind: "terminal" }, { kind: "spec" }],
				},
			],
		});
		const parsed = parseDetachedNodes(raw);
		expect(parsed[0].pendingPanels?.map((p) => p.kind)).toEqual(["terminal", "spec"]);
		// `activePanelId` has no v3 equivalent: dockview's layout owns tab activation.
		expect(parsed[0]).not.toHaveProperty("activePanelId");
	});

	test("dispatches on entry SHAPE, not the declared version", () => {
		// A v3-shaped entry mislabelled version 1 must still parse as a layout.
		const asV1 = JSON.stringify({
			version: 1,
			nodes: [{ id: "n1", x: 0, y: 0, w: 480, h: 360, layout: layout() }],
		});
		expect(parseDetachedNodes(asV1)[0].layout).toBeDefined();

		// And the reverse: a v1-shaped entry mislabelled version 3.
		const asV3 = JSON.stringify({ version: 3, nodes: [v1({ kind: "git" })] });
		expect(parseDetachedNodes(asV3)[0].pendingPanels?.[0].kind).toBe("git");
	});

	test("a layout with no panels is not a layout (falls through, then drops)", () => {
		// An empty grid restores to a blank surface, which is the same as having
		// nothing to render — and there is no pending list to fall back on.
		const raw = JSON.stringify({
			version: 3,
			nodes: [{ id: "n1", x: 0, y: 0, w: 480, h: 360, layout: { grid: {}, panels: {} } }],
		});
		expect(parseDetachedNodes(raw)).toEqual([]);
	});
});

describe("parseDetachedNodes", () => {
	test.each([
		null,
		undefined,
		"",
		"{not json",
		"[]",
		'{"nodes":"nope"}',
	])("unusable input %p → empty list, never throws", (raw) => {
		expect(parseDetachedNodes(raw as string | null | undefined)).toEqual([]);
	});

	test("drops pending panels with an unknown kind but keeps the node", () => {
		const raw = JSON.stringify({
			version: 3,
			nodes: [{ ...pending(), pendingPanels: [{ kind: "terminal" }, { kind: "details" }] }],
		});
		expect(parseDetachedNodes(raw)[0].pendingPanels?.map((p) => p.kind)).toEqual(["terminal"]);
	});

	test("drops a node with neither a layout nor a usable panel", () => {
		const noneUsable = JSON.stringify({
			version: 3,
			nodes: [{ ...pending(), pendingPanels: [{ kind: "details" }] }],
		});
		expect(parseDetachedNodes(noneUsable)).toEqual([]);

		const empty = JSON.stringify({
			version: 3,
			nodes: [{ id: "n1", x: 0, y: 0, w: 480, h: 360, pendingPanels: [] }],
		});
		expect(parseDetachedNodes(empty)).toEqual([]);
	});

	test("drops entries with non-finite or non-positive geometry", () => {
		const bad = [
			{ ...mounted({ id: "a" }), x: Number.NaN },
			{ ...mounted({ id: "b" }), y: "5" },
			{ ...mounted({ id: "c" }), w: 0 },
			{ ...mounted({ id: "d" }), h: -10 },
		];
		expect(parseDetachedNodes(JSON.stringify({ version: 3, nodes: bad }))).toEqual([]);
	});

	test("drops entries missing an id", () => {
		const raw = JSON.stringify({ version: 3, nodes: [{ ...mounted(), id: "" }] });
		expect(parseDetachedNodes(raw)).toEqual([]);
	});

	test("drops duplicate node ids (two React Flow nodes would share a key)", () => {
		const raw = JSON.stringify({ version: 3, nodes: [mounted(), mounted()] });
		expect(parseDetachedNodes(raw)).toHaveLength(1);
	});

	test("drops duplicate pending panels within one node", () => {
		const raw = JSON.stringify({
			version: 3,
			nodes: [{ ...pending(), pendingPanels: [{ kind: "terminal" }, { kind: "terminal" }] }],
		});
		expect(parseDetachedNodes(raw)[0].pendingPanels).toHaveLength(1);
	});

	test("truncates PENDING panels at the cap, counting across nodes", () => {
		const many = Array.from({ length: MAX_DETACHED_PANELS + 5 }, (_, i) =>
			pending({ id: `n${i}`, pendingPanels: [makePanelEntry("file", `/f${i}`)] }),
		);
		const parsed = parseDetachedNodes(JSON.stringify({ version: 3, nodes: many }));
		expect(countPendingPanels(parsed)).toBe(MAX_DETACHED_PANELS);
	});

	test("does NOT cap nodes that already own layouts", () => {
		// Panels inside a dockview layout are not enumerable here, and moving a panel
		// between nodes creates no new session — so there is nothing for the cap to
		// protect. Capping them would silently discard restored nodes.
		const many = Array.from({ length: MAX_DETACHED_PANELS + 5 }, (_, i) =>
			mounted({ id: `n${i}` }),
		);
		const parsed = parseDetachedNodes(JSON.stringify({ version: 3, nodes: many }));
		expect(parsed).toHaveLength(MAX_DETACHED_PANELS + 5);
	});
});

describe("addDetachedNode", () => {
	test("adds to an empty list", () => {
		expect(addDetachedNode([], pending())).toEqual({ ok: true, nodes: [pending()] });
	});

	test("refuses at the pending-panel cap, reporting the limit", () => {
		const full = Array.from({ length: MAX_DETACHED_PANELS }, (_, i) =>
			pending({ id: `n${i}`, pendingPanels: [makePanelEntry("file", `/f${i}`)] }),
		);
		expect(
			addDetachedNode(full, pending({ id: "new", pendingPanels: [makePanelEntry("spec")] })),
		).toEqual({ ok: false, reason: "limit", limit: MAX_DETACHED_PANELS });
	});

	test("refuses a singleton kind already pending in ANOTHER node", () => {
		expect(addDetachedNode([pending()], pending({ id: "other" }))).toEqual({
			ok: false,
			reason: "duplicate",
		});
	});

	test("allows distinct resources of a multi-instance kind", () => {
		const first = addDetachedNode(
			[],
			pending({ id: "a", pendingPanels: [makePanelEntry("file", "/a.ts")] }),
		);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(
			addDetachedNode(
				first.nodes,
				pending({ id: "b", pendingPanels: [makePanelEntry("file", "/b.ts")] }),
			).ok,
		).toBe(true);
	});

	test("refuses the same resource twice", () => {
		const list = [pending({ id: "a", pendingPanels: [makePanelEntry("file", "/a.ts")] })];
		expect(
			addDetachedNode(list, pending({ id: "b", pendingPanels: [makePanelEntry("file", "/a.ts")] })),
		).toEqual({ ok: false, reason: "duplicate" });
	});

	test("refuses a duplicate node id", () => {
		expect(addDetachedNode([pending({ id: "same" })], mounted({ id: "same" }))).toEqual({
			ok: false,
			reason: "duplicate",
		});
	});

	test("mounted nodes do not consume the cap", () => {
		// The cap counts pending panels only, so a chapter full of live surfaces must
		// still allow a fresh tear-out.
		const live = Array.from({ length: MAX_DETACHED_PANELS }, (_, i) => mounted({ id: `n${i}` }));
		expect(addDetachedNode(live, pending({ id: "new" })).ok).toBe(true);
	});

	test("does not mutate the input list", () => {
		const list = [pending()];
		addDetachedNode(list, pending({ id: "n2", pendingPanels: [makePanelEntry("spec")] }));
		expect(list).toHaveLength(1);
	});
});

describe("setDetachedLayout", () => {
	test("stores the layout and clears the pending list (upgrade is one-shot)", () => {
		const next = setDetachedLayout([pending()], "n1", layout(["ndock-spec"]));
		expect(next[0].layout).toBeDefined();
		expect(next[0]).not.toHaveProperty("pendingPanels");
	});

	test("replaces an existing layout", () => {
		const next = setDetachedLayout([mounted()], "n1", layout(["ndock-git"]));
		expect(Object.keys((next[0].layout as { panels: object }).panels)).toEqual(["ndock-git"]);
	});

	test("same reference for an unknown id (no needless write)", () => {
		const list = [mounted()];
		expect(setDetachedLayout(list, "absent", layout())).toBe(list);
	});
});

describe("hasPendingPanel / countPendingPanels", () => {
	test("hasPendingPanel scans every node", () => {
		const list = [
			pending({ id: "a" }),
			pending({ id: "b", pendingPanels: [makePanelEntry("spec")] }),
		];
		expect(hasPendingPanel(list, "spec")).toBe(true);
		expect(hasPendingPanel(list, "git")).toBe(false);
	});

	test("neither counts panels hidden inside a layout", () => {
		expect(hasPendingPanel([mounted()], "terminal")).toBe(false);
		expect(countPendingPanels([mounted()])).toBe(0);
	});

	test("countPendingPanels sums across nodes", () => {
		const list = [
			pending({ id: "a", pendingPanels: [makePanelEntry("terminal"), makePanelEntry("spec")] }),
			pending({ id: "b", pendingPanels: [makePanelEntry("git")] }),
		];
		expect(countPendingPanels(list)).toBe(3);
	});
});

describe("removeDetachedNode", () => {
	test("removes by id", () => {
		const list = [mounted(), mounted({ id: "n2" })];
		expect(removeDetachedNode(list, "n1").map((n) => n.id)).toEqual(["n2"]);
	});

	test("returns the same reference when nothing matched (no needless write)", () => {
		const list = [mounted()];
		expect(removeDetachedNode(list, "absent")).toBe(list);
	});
});

describe("generateDetachedPanelId", () => {
	test("produces distinct prefixed ids", () => {
		const ids = new Set(Array.from({ length: 50 }, () => generateDetachedPanelId()));
		expect(ids.size).toBe(50);
		for (const id of ids) expect(id.startsWith("dp_")).toBe(true);
	});
});

describe("updateDetachedNodeGeometry", () => {
	test("applies a moved position", () => {
		expect(updateDetachedNodeGeometry([mounted()], "n1", { x: 100, y: 200 })[0]).toMatchObject({
			x: 100,
			y: 200,
			w: 480,
			h: 360,
		});
	});

	test("applies a resize", () => {
		expect(updateDetachedNodeGeometry([mounted()], "n1", { w: 600, h: 400 })[0]).toMatchObject({
			w: 600,
			h: 400,
		});
	});

	test("same reference when the geometry is unchanged (avoids a write loop)", () => {
		const list = [mounted()];
		expect(updateDetachedNodeGeometry(list, "n1", { x: 10, y: 20 })).toBe(list);
	});

	test("same reference for an unknown id", () => {
		const list = [mounted()];
		expect(updateDetachedNodeGeometry(list, "absent", { x: 1 })).toBe(list);
	});

	test("ignores non-finite and non-positive values", () => {
		const list = [mounted()];
		expect(updateDetachedNodeGeometry(list, "n1", { x: Number.NaN, w: 0, h: -5 })).toBe(list);
	});

	test("preserves the layout while moving", () => {
		const next = updateDetachedNodeGeometry([mounted()], "n1", { x: 1, y: 2 });
		expect(next[0].layout).toBeDefined();
	});
});
