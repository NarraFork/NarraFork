import { describe, expect, test } from "bun:test";
import {
	needsStableBaselinePatch,
	planStableBaselinePatches,
	RELEASE_PLATFORM_SUFFIXES,
	resolvePlatformSuffixes,
	selectPreviousStableRelease,
} from "../../scripts/lib/stable-baseline-patch";

const releases = [
	{ version: "0.5.0", channel: "stable", platforms: ["linux-x64", "win-x64"] },
	{ version: "0.5.1", channel: "stable", platforms: ["linux-x64", "win-x64"] },
	{ version: "0.5.20", channel: "beta", platforms: ["linux-x64", "win-x64"] },
	{ version: "0.5.21", channel: "beta", platforms: ["linux-x64", "win-x64"] },
];

describe("previous stable baseline selection", () => {
	test("picks the highest stable release below the target, ignoring betas", () => {
		expect(selectPreviousStableRelease("0.5.22", releases)?.version).toBe("0.5.1");
	});

	test("ignores the target itself so promotion works after the channel flip", () => {
		const promoted = [...releases, { version: "0.5.22", channel: "stable" }];
		expect(selectPreviousStableRelease("0.5.22", promoted)?.version).toBe("0.5.1");
	});

	test("respects the platform when the stable release lacks it", () => {
		const partial = [
			{ version: "0.5.0", channel: "stable", platforms: ["linux-x64"] },
			{ version: "0.5.1", channel: "stable", platforms: ["linux-x64"] },
		];
		expect(selectPreviousStableRelease("0.6.0", partial, "linux-x64")?.version).toBe("0.5.1");
		expect(selectPreviousStableRelease("0.6.0", partial, "win-x64")).toBeNull();
	});

	test("returns null when no stable predecessor exists", () => {
		expect(selectPreviousStableRelease("0.5.22", [releases[2], releases[3]])).toBeNull();
		expect(selectPreviousStableRelease("0.5.0", releases)).toBeNull();
	});

	test("skips unparseable versions instead of throwing", () => {
		const messy = [
			{ version: "not-a-version", channel: "stable" },
			{ version: "0.5.1", channel: "stable" },
		];
		expect(selectPreviousStableRelease("0.5.22", messy)?.version).toBe("0.5.1");
	});

	test("reports the unparseable version rather than dropping it silently", () => {
		// "no patch was produced" and "the release list contains junk" are different
		// problems; the second one has to be visible to be fixable.
		const seen: string[] = [];
		const messy = [
			{ version: "not-a-version", channel: "stable" },
			{ version: "0.5.1", channel: "stable" },
		];
		selectPreviousStableRelease("0.5.22", messy, undefined, (version) => seen.push(version));
		expect(seen).toEqual(["not-a-version"]);
	});

	test("a clean release list reports nothing", () => {
		const seen: string[] = [];
		selectPreviousStableRelease("0.5.22", releases, undefined, (version) => seen.push(version));
		expect(seen).toEqual([]);
	});

	test("treats an already published base as satisfied", () => {
		expect(needsStableBaselinePatch("0.5.1", ["0.5.21"])).toBe(true);
		expect(needsStableBaselinePatch("0.5.1", ["0.5.1", "0.5.21"])).toBe(false);
	});
});

describe("stable baseline patch planning", () => {
	const suffixes = new Map([
		["linux-x64", "linux-x64"],
		["win-x64", "windows-x64.exe"],
	]);

	test("plans a patch per platform when both binaries are present locally", () => {
		const plan = planStableBaselinePatches({
			targetVersion: "0.5.22",
			platformSuffixes: suffixes,
			baselineVersions: new Map([
				["linux-x64", "0.5.1"],
				["win-x64", "0.5.1"],
			]),
			existingPatchFromVersions: new Map([
				["linux-x64", ["0.5.21"]],
				["win-x64", ["0.5.21"]],
			]),
			availableFilenames: [
				"narrafork-0.5.22-linux-x64",
				"narrafork-0.5.1-linux-x64",
				"narrafork-0.5.22-windows-x64.exe",
				"narrafork-0.5.1-windows-x64.exe",
			],
		});

		expect(plan.skips).toEqual([]);
		expect(plan.plans).toEqual([
			{
				platform: "linux-x64",
				targetFilename: "narrafork-0.5.22-linux-x64",
				baselineFilename: "narrafork-0.5.1-linux-x64",
				baselineVersion: "0.5.1",
			},
			{
				platform: "win-x64",
				targetFilename: "narrafork-0.5.22-windows-x64.exe",
				baselineFilename: "narrafork-0.5.1-windows-x64.exe",
				baselineVersion: "0.5.1",
			},
		]);
	});

	test("skips platforms whose local binaries are missing, naming them", () => {
		const plan = planStableBaselinePatches({
			targetVersion: "0.5.22",
			platformSuffixes: suffixes,
			baselineVersions: new Map([
				["linux-x64", "0.5.1"],
				["win-x64", "0.5.1"],
			]),
			existingPatchFromVersions: new Map(),
			availableFilenames: ["narrafork-0.5.22-linux-x64"],
		});

		expect(plan.plans).toEqual([]);
		expect(plan.skips).toHaveLength(2);
		expect(plan.skips[0].reason).toContain("narrafork-0.5.1-linux-x64");
		expect(plan.skips[1].reason).toContain("narrafork-0.5.22-windows-x64.exe");
		expect(plan.skips[1].reason).toContain("narrafork-0.5.1-windows-x64.exe");
	});

	test("does not plan or warn when the base patch already exists", () => {
		const plan = planStableBaselinePatches({
			targetVersion: "0.6.0",
			platformSuffixes: new Map([["linux-x64", "linux-x64"]]),
			baselineVersions: new Map([["linux-x64", "0.5.1"]]),
			existingPatchFromVersions: new Map([["linux-x64", ["0.5.1"]]]),
			availableFilenames: [],
		});
		expect(plan.plans).toEqual([]);
		expect(plan.skips).toEqual([]);
	});

	test("reports platforms without a stable predecessor", () => {
		const plan = planStableBaselinePatches({
			targetVersion: "0.5.22",
			platformSuffixes: new Map([["linux-arm64", "linux-arm64"]]),
			baselineVersions: new Map(),
			existingPatchFromVersions: new Map(),
			availableFilenames: [],
		});
		expect(plan.plans).toEqual([]);
		expect(plan.skips[0]).toEqual({
			platform: "linux-arm64",
			reason: "no previous stable release for this platform",
		});
	});
});

describe("platform suffix resolution", () => {
	test("covers every published platform by default", () => {
		expect([...resolvePlatformSuffixes().keys()].sort()).toEqual(
			Object.keys(RELEASE_PLATFORM_SUFFIXES).sort(),
		);
	});

	test("matches build-script platform names with and without .exe", () => {
		expect([...resolvePlatformSuffixes("windows-x64").keys()]).toEqual(["win-x64"]);
		expect([...resolvePlatformSuffixes("windows-x64.exe").keys()]).toEqual(["win-x64"]);
		expect([...resolvePlatformSuffixes("windows-arm64").keys()]).toEqual(["win-arm64"]);
		expect([...resolvePlatformSuffixes("windows-arm64.exe").keys()]).toEqual(["win-arm64"]);
		expect([...resolvePlatformSuffixes("linux-x64").keys()]).toEqual(["linux-x64"]);
		expect([...resolvePlatformSuffixes("nope").keys()]).toEqual([]);
	});
});
