/**
 * Guards the collapse DEFAULTS. Getting these wrong produces a list that quietly hides the
 * row the user is standing on: the tab still exists and still works, it is just invisible,
 * and Ctrl+↑/↓ scrolls to nothing.
 *
 * The pure resolvers are tested directly (no DOM, no React) plus a localStorage round-trip
 * through the reader, which is where a parse bug would surface.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
	type CollapsedDirectoryMap,
	readCollapsedDirectories,
	resolveDirectoryCollapsed,
	toggleCollapsedDirectory,
} from "./useCollapsedTabDirectories";

const STORAGE_KEY = "narrafork_recent_tab_dirs";

/** Minimal localStorage stand-in — the module only reads getItem/setItem. */
function installStorage(initial: Record<string, string> = {}) {
	const store = new Map(Object.entries(initial));
	const storage = {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => {
			store.set(key, value);
		},
		removeItem: (key: string) => {
			store.delete(key);
		},
		clear: () => store.clear(),
		key: (index: number) => [...store.keys()][index] ?? null,
		get length() {
			return store.size;
		},
	};
	(globalThis as { localStorage?: unknown }).localStorage = storage;
	return storage;
}

afterEach(() => {
	(globalThis as { localStorage?: unknown }).localStorage = undefined;
});

describe("resolveDirectoryCollapsed", () => {
	const EMPTY: CollapsedDirectoryMap = {};

	it("collapses by default — that is the point of the mode", () => {
		expect(resolveDirectoryCollapsed(EMPTY, "/w/repo")).toBe(true);
	});

	it("auto-expands the group holding the active tab", () => {
		expect(resolveDirectoryCollapsed(EMPTY, "/w/repo", { containsActive: true })).toBe(false);
	});

	it("auto-expands the group holding the keyboard-nav highlight", () => {
		// Ctrl+↑/↓ scrolls to the highlighted row; inside a folded group there is nothing
		// to scroll to.
		expect(resolveDirectoryCollapsed(EMPTY, "/w/repo", { containsPending: true })).toBe(false);
	});

	it("honours an explicit collapse even for the active group", () => {
		const map = { "/w/repo": true };
		expect(resolveDirectoryCollapsed(map, "/w/repo", { containsActive: true })).toBe(true);
	});

	it("honours an explicit expand for an inactive group", () => {
		expect(resolveDirectoryCollapsed({ "/w/repo": false }, "/w/repo")).toBe(false);
	});

	it("keeps choices per path", () => {
		const map = { "/w/a": false };
		expect(resolveDirectoryCollapsed(map, "/w/a")).toBe(false);
		expect(resolveDirectoryCollapsed(map, "/w/b")).toBe(true);
	});
});

describe("toggleCollapsedDirectory", () => {
	it("records an explicit expand when toggling a default-collapsed group", () => {
		expect(toggleCollapsedDirectory({}, "/w/repo")).toEqual({ "/w/repo": false });
	});

	it("records an explicit collapse when toggling an auto-expanded active group", () => {
		// Without persisting the choice, the auto-expand rule would immediately undo it.
		expect(toggleCollapsedDirectory({}, "/w/repo", { containsActive: true })).toEqual({
			"/w/repo": true,
		});
	});

	it("flips an existing explicit choice and leaves siblings alone", () => {
		expect(toggleCollapsedDirectory({ "/w/a": false, "/w/b": true }, "/w/a")).toEqual({
			"/w/a": true,
			"/w/b": true,
		});
	});
});

describe("readCollapsedDirectories", () => {
	it("round-trips a stored map", () => {
		installStorage({ [STORAGE_KEY]: JSON.stringify({ "/w/repo": true }) });
		expect(readCollapsedDirectories()).toEqual({ "/w/repo": true });
	});

	it("returns an empty map when nothing is stored", () => {
		installStorage();
		expect(readCollapsedDirectories()).toEqual({});
	});

	it("degrades to defaults on corrupt JSON instead of throwing", () => {
		installStorage({ [STORAGE_KEY]: "{not json" });
		expect(readCollapsedDirectories()).toEqual({});
	});

	it("ignores non-object and non-boolean payloads", () => {
		installStorage({ [STORAGE_KEY]: JSON.stringify(["/w/repo"]) });
		expect(readCollapsedDirectories()).toEqual({});
		installStorage({ [STORAGE_KEY]: JSON.stringify({ "/w/a": "yes", "/w/b": true }) });
		expect(readCollapsedDirectories()).toEqual({ "/w/b": true });
	});

	it("returns a STABLE reference for unchanged storage", () => {
		// useSyncExternalStore compares snapshots by identity; a fresh object per read
		// would re-render forever.
		installStorage({ [STORAGE_KEY]: JSON.stringify({ "/w/repo": true }) });
		expect(readCollapsedDirectories()).toBe(readCollapsedDirectories());
	});

	it("picks up a changed value on the next read", () => {
		const storage = installStorage({ [STORAGE_KEY]: JSON.stringify({ "/w/repo": true }) });
		expect(readCollapsedDirectories()).toEqual({ "/w/repo": true });
		storage.setItem(STORAGE_KEY, JSON.stringify({ "/w/repo": false }));
		expect(readCollapsedDirectories()).toEqual({ "/w/repo": false });
	});
});
