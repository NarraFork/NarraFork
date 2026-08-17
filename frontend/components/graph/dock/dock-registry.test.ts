import { afterEach, describe, expect, test } from "bun:test";
import type { NarratorDockContextValue } from "../../narrator/dock/NarratorDockContext";
import {
	__resetChapterDockRegistry,
	getChapterDock,
	getSurfaceChapterId,
	hasChapterDock,
	isDetachedSurface,
	listSurfaceIds,
	registerChapterDock,
	registerDetachedDock,
	subscribeChapterDocks,
} from "./dock-registry";

/** Only the identity fields matter here; the rest of the context is unused. */
function dockValue(narratorId: string): NarratorDockContextValue {
	return { narratorId } as unknown as NarratorDockContextValue;
}

afterEach(() => {
	__resetChapterDockRegistry();
});

describe("registerChapterDock", () => {
	test("a registered dock is retrievable by chapter id", () => {
		const value = dockValue("narr_1");
		registerChapterDock("chap_1", value);
		expect(getChapterDock("chap_1")).toBe(value);
		expect(hasChapterDock("chap_1")).toBe(true);
	});

	test("unregistering removes it", () => {
		const off = registerChapterDock("chap_1", dockValue("narr_1"));
		off();
		expect(getChapterDock("chap_1")).toBeUndefined();
		expect(hasChapterDock("chap_1")).toBe(false);
	});

	test("an unknown chapter has no dock", () => {
		expect(getChapterDock("absent")).toBeUndefined();
		expect(hasChapterDock("absent")).toBe(false);
	});

	test("an undefined chapter id is handled without throwing", () => {
		expect(getChapterDock(undefined)).toBeUndefined();
		expect(hasChapterDock(undefined)).toBe(false);
	});

	test("docks are isolated per chapter", () => {
		const a = dockValue("narr_a");
		const b = dockValue("narr_b");
		registerChapterDock("chap_a", a);
		registerChapterDock("chap_b", b);
		expect(getChapterDock("chap_a")).toBe(a);
		expect(getChapterDock("chap_b")).toBe(b);
	});

	test("a remount's stale cleanup does not evict the live dock", () => {
		// React runs the new effect's registration before the old effect's cleanup on
		// a remount. An unconditional delete there would drop the dock that is
		// actually mounted, and a later tear-out would silently find nothing.
		const oldValue = dockValue("narr_old");
		const offOld = registerChapterDock("chap_1", oldValue);
		const newValue = dockValue("narr_new");
		registerChapterDock("chap_1", newValue);

		offOld(); // stale cleanup arrives late

		expect(getChapterDock("chap_1")).toBe(newValue);
	});

	test("re-registering the same chapter replaces the entry", () => {
		registerChapterDock("chap_1", dockValue("narr_old"));
		const newValue = dockValue("narr_new");
		registerChapterDock("chap_1", newValue);
		expect(getChapterDock("chap_1")).toBe(newValue);
	});
});

describe("subscribeChapterDocks", () => {
	test("notifies on register and on unregister", () => {
		let calls = 0;
		const off = subscribeChapterDocks(() => {
			calls++;
		});
		const offDock = registerChapterDock("chap_1", dockValue("narr_1"));
		expect(calls).toBe(1);
		offDock();
		expect(calls).toBe(2);
		off();
	});

	test("does not notify after unsubscribing", () => {
		let calls = 0;
		const off = subscribeChapterDocks(() => {
			calls++;
		});
		off();
		registerChapterDock("chap_1", dockValue("narr_1"));
		expect(calls).toBe(0);
	});

	test("a no-op stale cleanup does not notify", () => {
		const offOld = registerChapterDock("chap_1", dockValue("narr_old"));
		registerChapterDock("chap_1", dockValue("narr_new"));
		let calls = 0;
		const off = subscribeChapterDocks(() => {
			calls++;
		});
		offOld();
		expect(calls).toBe(0);
		off();
	});
});

describe("detached surfaces", () => {
	test("a detached node registers under its NODE id, not its chapter", () => {
		// Panel ids are global, so a lookup must name the surface it means. Keying a
		// detached node by chapter would collide with that chapter's own dock.
		const value = dockValue("narr_1");
		registerDetachedDock("dp_a", "chap_1", value);
		expect(getChapterDock("dp_a")).toBe(value);
		expect(getChapterDock("chap_1")).toBeUndefined();
	});

	test("one chapter can own its dock plus several detached surfaces at once", () => {
		registerChapterDock("chap_1", dockValue("narr_1"));
		registerDetachedDock("dp_a", "chap_1", dockValue("narr_1"));
		registerDetachedDock("dp_b", "chap_1", dockValue("narr_1"));
		expect(listSurfaceIds().sort()).toEqual(["chap_1", "dp_a", "dp_b"]);
		for (const id of ["chap_1", "dp_a", "dp_b"]) {
			expect(getSurfaceChapterId(id)).toBe("chap_1");
		}
	});

	test("isDetachedSurface separates the two kinds", () => {
		// This is what lets a chapter dock accept a panel dragged from a detached node
		// (the canvas owns that surface, so closing it is safe) while still refusing
		// one dragged from another chapter's dock.
		registerChapterDock("chap_1", dockValue("narr_1"));
		registerDetachedDock("dp_a", "chap_1", dockValue("narr_1"));
		expect(isDetachedSurface("dp_a")).toBe(true);
		expect(isDetachedSurface("chap_1")).toBe(false);
	});

	test("unknown and undefined ids report as neither detached nor owned", () => {
		expect(isDetachedSurface("absent")).toBe(false);
		expect(isDetachedSurface(undefined)).toBe(false);
		expect(getSurfaceChapterId("absent")).toBeUndefined();
		expect(getSurfaceChapterId(undefined)).toBeUndefined();
	});

	test("unregistering a detached surface leaves the chapter dock intact", () => {
		const dock = dockValue("narr_1");
		registerChapterDock("chap_1", dock);
		const off = registerDetachedDock("dp_a", "chap_1", dockValue("narr_1"));
		off();
		expect(getChapterDock("dp_a")).toBeUndefined();
		expect(getChapterDock("chap_1")).toBe(dock);
	});
});
