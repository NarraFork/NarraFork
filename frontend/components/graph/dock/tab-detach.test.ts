/**
 * tab-detach — resolving what a dockview tab drag is carrying.
 *
 * Both functions here exist to avoid a specific silent failure, so the tests are
 * written against those failures rather than the happy path alone:
 *
 *  - `readPanelSubject` must read `params`, never parse the `ndock-<kind>` panel
 *    id. That prefix is an implementation detail of `dockPanelId()`; a test that
 *    only checked "terminal panel resolves to terminal" would pass with either
 *    implementation, so there is an explicit case where the id and the params
 *    disagree.
 *  - `resolveTabDetachSubject` must find the chapter through the DOM + registry.
 *    Neither the drag's `viewId` nor the panel's params can supply it (params
 *    carry `chapterId` only for some kinds), and returning the wrong chapter
 *    would persist the detached panel under a chapter that does not own it.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
	__resetChapterDockRegistry,
	registerChapterDock,
	registerDetachedDock,
} from "./dock-registry";
import { readPanelSubject, resolveTabDetachSubject } from "./tab-detach";

afterEach(() => {
	__resetChapterDockRegistry();
});

/** A stand-in for the slice of NarratorDockContextValue this module touches. */
function fakeDock(panels: Record<string, unknown>, viewId = "source-view") {
	return {
		apiRef: {
			current: {
				id: viewId,
				getPanel: (id: string) => (id in panels ? { id, params: panels[id] } : undefined),
			},
		},
		// biome-ignore lint/suspicious/noExplicitAny: only apiRef.getPanel is read here
	} as any;
}

describe("readPanelSubject", () => {
	it("carries loading consent separately without changing the resource identity", () => {
		const file = { panelType: "file", filePath: "/large.ts", deviceId: "Remote" };
		const original = readPanelSubject(file);
		if (!original) throw new Error("file subject missing");
		expect(readPanelSubject({ ...file, largeFileConfirmed: true })).toEqual({
			...original,
			largeFileConfirmed: true,
		});
		for (const largeFileConfirmed of [false, "true", 1]) {
			expect(readPanelSubject({ ...file, largeFileConfirmed })).toEqual(original);
		}
		expect(readPanelSubject({ panelType: "spec", largeFileConfirmed: true })).toEqual({
			kind: "spec",
		});
	});

	it("reads the kind from params", () => {
		expect(readPanelSubject({ panelType: "terminal" })).toEqual({ kind: "terminal" });
	});

	it("reads params even when the panel id suggests another kind", () => {
		// The load-bearing case: an implementation that parsed `ndock-<kind>` would
		// disagree with params here. Only params are authoritative.
		const subject = readPanelSubject({ panelType: "git" });
		expect(subject).toEqual({ kind: "git" });
	});

	it("carries resourceId for multi-instance kinds", () => {
		expect(readPanelSubject({ panelType: "subagent", subagentNarratorId: "nar_1" })).toEqual({
			kind: "subagent",
			resourceId: "nar_1",
		});
		expect(readPanelSubject({ panelType: "file", filePath: "/tmp/a.ts" })).toEqual({
			kind: "file",
			resourceId: "/tmp/a.ts",
		});
	});

	it("preserves remote file identity when a native tab is detached", () => {
		expect(
			readPanelSubject({ panelType: "file", filePath: "/tmp/a.ts", deviceId: "DeviceA" }),
		).toEqual({
			kind: "file",
			resourceId: JSON.stringify(["DeviceA", "/tmp/a.ts"]),
		});
	});

	it("retains the scoped reader requirement for local reference tabs", () => {
		expect(
			readPanelSubject({ panelType: "file", filePath: "/tmp/a.png", referenceOrigin: true }),
		).toEqual({
			kind: "file",
			resourceId: JSON.stringify(["local", "/tmp/a.png", true]),
		});
	});

	it("retains historical tool identity in tab drags and rejects malformed references", () => {
		const toolEdit = {
			narratorId: "origin",
			toolUseId: "sdk-id",
			messageId: "message",
			executionAttempt: 2,
		};
		expect(readPanelSubject({ panelType: "file", filePath: "/a.ts", toolEdit })).toEqual({
			kind: "file",
			resourceId: JSON.stringify(["local", "/a.ts", false, toolEdit]),
		});
		expect(readPanelSubject({ panelType: "file", filePath: "/a.ts", toolEdit: {} })).toBeNull();
	});

	it("retains file-operation authority instead of the layout host in native tab drags", () => {
		expect(
			readPanelSubject({
				panelType: "file",
				filePath: "/work/b/a.ts",
				hostNarratorId: "parent",
				fileNarratorId: "child",
				referenceOrigin: true,
			}),
		).toEqual({
			kind: "file",
			resourceId: JSON.stringify(["local", "/work/b/a.ts", true, null, "child"]),
		});
	});

	it("leaves resourceId unset for singleton kinds even if extra fields exist", () => {
		// A stray field must not become a resource identity: singletons are keyed by
		// kind alone, and a spurious resourceId would defeat the duplicate check.
		expect(readPanelSubject({ panelType: "spec", filePath: "/tmp/a.ts" })).toEqual({
			kind: "spec",
		});
	});

	it("rejects non-detachable kinds and malformed params", () => {
		expect(readPanelSubject({ panelType: "chat" })).toBeNull();
		expect(readPanelSubject({ panelType: "details" })).toBeNull();
		expect(readPanelSubject({})).toBeNull();
		expect(readPanelSubject(null)).toBeNull();
		expect(readPanelSubject("terminal")).toBeNull();
	});
});

describe("resolveTabDetachSubject", () => {
	it("finds the surface that actually holds the panel", () => {
		registerChapterDock("ch_a", fakeDock({ "ndock-git": { panelType: "git" } }, "other-view"));
		registerChapterDock("ch_b", fakeDock({ "ndock-terminal": { panelType: "terminal" } }));

		expect(resolveTabDetachSubject("ndock-terminal", "source-view")).toEqual({
			chapterId: "ch_b",
			surfaceId: "ch_b",
			panelId: "ndock-terminal",
			kind: "terminal",
		});
	});

	it("also finds panels inside a DETACHED node, reporting both ids", () => {
		// A tab can be dragged out of a detached surface too. `surfaceId` is the node
		// (that is where the panel must be closed) while `chapterId` owns persistence;
		// conflating them would close a panel on the wrong surface.
		registerDetachedDock("dp_a", "ch_a", fakeDock({ "ndock-spec": { panelType: "spec" } }));
		expect(resolveTabDetachSubject("ndock-spec", "source-view")).toEqual({
			chapterId: "ch_a",
			surfaceId: "dp_a",
			panelId: "ndock-spec",
			kind: "spec",
		});
	});

	it("returns null when no mounted surface holds the panel", () => {
		registerChapterDock("ch_a", fakeDock({ "ndock-git": { panelType: "git" } }));
		expect(resolveTabDetachSubject("ndock-terminal", "source-view")).toBeNull();
	});

	it("returns null for a panel that is found but not detachable", () => {
		registerChapterDock("ch_a", fakeDock({ "ndock-chat": { panelType: "chat" } }));
		expect(resolveTabDetachSubject("ndock-chat", "source-view")).toBeNull();
	});

	it("ignores surfaces that have been unregistered", () => {
		// A collapsing node removes its registry entry. Treating a stale id as a hit
		// would try to close a panel on a disposed api.
		const off = registerChapterDock(
			"ch_gone",
			fakeDock({ "ndock-terminal": { panelType: "terminal" } }),
		);
		off();
		expect(resolveTabDetachSubject("ndock-terminal", "source-view")).toBeNull();
	});

	it("returns null without a panel id", () => {
		expect(resolveTabDetachSubject(null, "source-view")).toBeNull();
	});

	it("selects the native source view instead of the first surface with the same panel id", () => {
		registerChapterDock(
			"wrong",
			fakeDock({ shared: { panelType: "file", filePath: "/wrong.ts" } }, "wrong-view"),
		);
		registerDetachedDock(
			"requested",
			"chapter",
			fakeDock({ shared: { panelType: "file", filePath: "/requested.ts" } }),
		);
		expect(resolveTabDetachSubject("shared", "source-view")).toMatchObject({
			surfaceId: "requested",
			chapterId: "chapter",
			resourceId: "/requested.ts",
		});
	});

	it.each([undefined, "missing-view"])("refuses absent or unknown native viewId %s", (viewId) => {
		registerChapterDock("chapter", fakeDock({ shared: { panelType: "terminal" } }));
		expect(resolveTabDetachSubject("shared", viewId)).toBeNull();
	});

	it("refuses an ambiguous viewId rather than selecting a source by registration order", () => {
		registerChapterDock("first", fakeDock({ shared: { panelType: "terminal" } }));
		registerDetachedDock("second", "chapter", fakeDock({ shared: { panelType: "terminal" } }));
		expect(resolveTabDetachSubject("shared", "source-view")).toBeNull();
	});
});
