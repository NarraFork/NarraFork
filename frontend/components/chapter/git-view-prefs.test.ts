import { describe, expect, test } from "bun:test";
import { parseGitViewPrefs, readGitViewMode, setGitViewMode } from "./git-view-prefs";

describe("git view preferences", () => {
	test("defaults to tree and ignores malformed values", () => {
		expect(readGitViewMode({}, "local:/repo")).toBe("tree");
		expect(parseGitViewPrefs("not json")).toEqual({});
		expect(parseGitViewPrefs(JSON.stringify({ a: "unknown", b: "flat" }))).toEqual({ b: "flat" });
	});

	test("stores modes independently per workspace key", () => {
		const next = setGitViewMode({}, "local:/repo", "flat");
		expect(readGitViewMode(next, "local:/repo")).toBe("flat");
		expect(readGitViewMode(next, "remote:/repo")).toBe("tree");
		expect(setGitViewMode(next, "local:/repo", "flat")).toBe(next);
	});
});
