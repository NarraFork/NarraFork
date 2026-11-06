import { describe, expect, test } from "bun:test";
import {
	isAbsoluteForFlavor,
	normalizeWorkspacePathFlavor,
	parseWorkspaceDirectoryMap,
	readDeviceDirectory,
	withDeviceDirectory,
	withoutDeviceDirectory,
} from "../workspace-directories";

describe("parseWorkspaceDirectoryMap", () => {
	test("treats missing and malformed sources as an empty map", () => {
		expect(parseWorkspaceDirectoryMap(null)).toEqual({});
		expect(parseWorkspaceDirectoryMap(undefined)).toEqual({});
		expect(parseWorkspaceDirectoryMap("not json")).toEqual({});
		expect(parseWorkspaceDirectoryMap([])).toEqual({});
		expect(parseWorkspaceDirectoryMap(42)).toEqual({});
	});

	test("accepts both a JSON string and an already-parsed object", () => {
		const raw = { local: { cwd: "/work", pathFlavor: "posix" } };
		expect(parseWorkspaceDirectoryMap(JSON.stringify(raw))).toEqual(raw);
		expect(parseWorkspaceDirectoryMap(raw)).toEqual(raw);
	});

	test("drops entries without a usable cwd and trims ids", () => {
		const parsed = parseWorkspaceDirectoryMap({
			"  dev-1  ": { cwd: "/srv/app", pathFlavor: "posix" },
			dev2: { cwd: "   ", pathFlavor: "posix" },
			dev3: { pathFlavor: "windows" },
			dev4: "C:\\work",
			"": { cwd: "/ignored", pathFlavor: "posix" },
		});
		expect(parsed).toEqual({ "dev-1": { cwd: "/srv/app", pathFlavor: "posix" } });
	});

	test("infers the flavor when it is missing or unknown", () => {
		const parsed = parseWorkspaceDirectoryMap({
			win: { cwd: "C:\\Users\\me" },
			posix: { cwd: "/home/me" },
			unknown: { cwd: "/home/me", pathFlavor: "spec" },
		});
		expect(parsed.win).toEqual({ cwd: "C:\\Users\\me", pathFlavor: "windows" });
		expect(parsed.posix).toEqual({ cwd: "/home/me", pathFlavor: "posix" });
		expect(parsed.unknown).toEqual({ cwd: "/home/me", pathFlavor: "posix" });
	});
});

describe("readDeviceDirectory", () => {
	test("returns null for a device with no entry", () => {
		expect(readDeviceDirectory({}, "local")).toBeNull();
		expect(readDeviceDirectory(null, "local")).toBeNull();
		expect(readDeviceDirectory({ local: { cwd: "/a", pathFlavor: "posix" } }, "other")).toBeNull();
	});

	test("returns the recorded entry, canonicalizing the flavor", () => {
		const entry = readDeviceDirectory(
			{ "dev-1": { cwd: "C:\\work", pathFlavor: "windows" } },
			"dev-1",
		);
		expect(entry).toEqual({ cwd: "C:\\work", pathFlavor: "windows" });
	});
});

describe("withDeviceDirectory / withoutDeviceDirectory", () => {
	test("upserts immutably", () => {
		const before = { local: { cwd: "/a", pathFlavor: "posix" as const } };
		const after = withDeviceDirectory(before, "dev-1", {
			cwd: "C:\\work",
			pathFlavor: "windows",
		});
		expect(before).toEqual({ local: { cwd: "/a", pathFlavor: "posix" } });
		expect(after).toEqual({
			local: { cwd: "/a", pathFlavor: "posix" },
			"dev-1": { cwd: "C:\\work", pathFlavor: "windows" },
		});
	});

	test("replaces an existing entry without dropping the others", () => {
		const after = withDeviceDirectory({ "dev-1": { cwd: "/old", pathFlavor: "posix" } }, "dev-1", {
			cwd: "/new",
			pathFlavor: "posix",
		});
		expect(after).toEqual({ "dev-1": { cwd: "/new", pathFlavor: "posix" } });
	});

	test("deletes immutably and is a no-op for an unknown device", () => {
		const before = {
			local: { cwd: "/a", pathFlavor: "posix" as const },
			"dev-1": { cwd: "/b", pathFlavor: "posix" as const },
		};
		expect(withoutDeviceDirectory(before, "dev-1")).toEqual({
			local: { cwd: "/a", pathFlavor: "posix" },
		});
		expect(withoutDeviceDirectory(before, "missing")).toEqual(before);
		expect(before["dev-1"]).toEqual({ cwd: "/b", pathFlavor: "posix" });
	});
});

describe("isAbsoluteForFlavor", () => {
	test("posix grammar", () => {
		expect(isAbsoluteForFlavor("/home/me", "posix")).toBe(true);
		expect(isAbsoluteForFlavor("/", "posix")).toBe(true);
		expect(isAbsoluteForFlavor("home/me", "posix")).toBe(false);
		expect(isAbsoluteForFlavor("", "posix")).toBe(false);
		// A Windows path is never absolute in POSIX grammar — the classic trap.
		expect(isAbsoluteForFlavor("C:\\Users\\me", "posix")).toBe(false);
	});

	test("windows grammar", () => {
		expect(isAbsoluteForFlavor("C:\\Users\\me", "windows")).toBe(true);
		expect(isAbsoluteForFlavor("D:/work", "windows")).toBe(true);
		expect(isAbsoluteForFlavor("\\\\server\\share", "windows")).toBe(true);
		expect(isAbsoluteForFlavor("\\rooted", "windows")).toBe(true);
		expect(isAbsoluteForFlavor("C:", "windows")).toBe(false);
		expect(isAbsoluteForFlavor("Users\\me", "windows")).toBe(false);
		expect(isAbsoluteForFlavor("", "windows")).toBe(false);
	});
});

describe("normalizeWorkspacePathFlavor", () => {
	test("maps anything that is not windows to posix", () => {
		expect(normalizeWorkspacePathFlavor("windows")).toBe("windows");
		expect(normalizeWorkspacePathFlavor("posix")).toBe("posix");
		expect(normalizeWorkspacePathFlavor(undefined)).toBe("posix");
		expect(normalizeWorkspacePathFlavor("WINDOWS")).toBe("posix");
	});
});
