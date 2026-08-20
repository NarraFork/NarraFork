/**
 * scan.test.ts — Contract for the license manifest scanner.
 *
 * Every property pinned here is one whose failure is SILENT: the page still
 * renders, just with fewer packages, a wrong license, or missing text. That is
 * what made the previous implementation ship 97 of 864 distributed packages
 * without anyone noticing, so the tests are written against the failure modes
 * rather than the happy path.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	licenseTextId,
	normalizeRepositoryUrl,
	readDeclaredLicense,
	scanLicenseManifest,
} from "../scan";
import type { LicenseManifest } from "../types";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "nf-licenses-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Write a fixture package into the temp tree. */
function pkg(
	name: string,
	manifest: Record<string, unknown>,
	files: Record<string, string> = {},
): void {
	const dir = join(root, "node_modules", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", ...manifest }));
	for (const [file, content] of Object.entries(files)) {
		writeFileSync(join(dir, file), content);
	}
}

function rootManifest(manifest: Record<string, unknown>): void {
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", ...manifest }));
}

function scan(): LicenseManifest {
	return scanLicenseManifest({ root });
}

function entry(manifest: LicenseManifest, name: string) {
	const found = manifest.entries.find((candidate) => candidate.name === name);
	if (!found)
		throw new Error(`no entry for ${name}; got ${manifest.entries.map((e) => e.name).join(", ")}`);
	return found;
}

describe("dependency graph traversal", () => {
	test("includes transitive dependencies, not just direct ones", () => {
		// The whole point of the rewrite: 785 packages were missing because only the
		// root manifest's own keys were listed.
		rootManifest({ dependencies: { direct: "^1" } });
		pkg("direct", { license: "MIT", dependencies: { deep: "^1" } }, { LICENSE: "MIT direct" });
		pkg("deep", { license: "MIT", dependencies: { deeper: "^1" } }, { LICENSE: "MIT deep" });
		pkg("deeper", { license: "MIT" }, { LICENSE: "MIT deeper" });

		const manifest = scan();
		expect(manifest.entries.map((e) => e.name).sort()).toEqual(["deep", "deeper", "direct"]);
		expect(entry(manifest, "deeper").kind).toBe("runtime");
	});

	test("classifies by reachability, not by which field the name appeared in", () => {
		// `isDev` from the root manifest was the old signal. It says nothing about
		// whether a package ships.
		rootManifest({ dependencies: { ships: "^1" }, devDependencies: { tool: "^1" } });
		pkg("ships", { license: "MIT" }, { LICENSE: "a" });
		pkg("tool", { license: "MIT", dependencies: { "tool-dep": "^1" } }, { LICENSE: "b" });
		pkg("tool-dep", { license: "MIT" }, { LICENSE: "c" });

		const manifest = scan();
		expect(entry(manifest, "ships").kind).toBe("runtime");
		expect(entry(manifest, "tool").kind).toBe("development");
		expect(entry(manifest, "tool-dep").kind).toBe("development");
	});

	test("a package reachable from both trees counts as runtime", () => {
		// Being wrong the other way would under-report obligations for something we
		// actually distribute.
		rootManifest({ dependencies: { app: "^1" }, devDependencies: { tool: "^1" } });
		pkg("app", { license: "MIT", dependencies: { shared: "^1" } }, { LICENSE: "a" });
		pkg("tool", { license: "MIT", dependencies: { shared: "^1" } }, { LICENSE: "b" });
		pkg("shared", { license: "MIT" }, { LICENSE: "c" });

		expect(entry(scan(), "shared").kind).toBe("runtime");
	});

	test("follows optionalDependencies, since the release targets every platform", () => {
		rootManifest({ dependencies: { host: "^1" } });
		pkg("host", { license: "MIT", optionalDependencies: { "native-x64": "^1" } }, { LICENSE: "a" });
		pkg("native-x64", { license: "MIT" }, { LICENSE: "b" });

		expect(entry(scan(), "native-x64").kind).toBe("runtime");
	});

	test("reports a declared dependency that is not installed instead of dropping it", () => {
		rootManifest({ dependencies: { "native-darwin": "^1" } });

		const manifest = scan();
		expect(manifest.entries).toHaveLength(0);
		expect(
			manifest.problems.some(
				(p) => p.name === "native-darwin" && /not installed locally/.test(p.message),
			),
		).toBe(true);
	});

	test("attributes installed-but-unreachable packages rather than omitting them", () => {
		rootManifest({ dependencies: {} });
		pkg("orphan", { license: "MIT" }, { LICENSE: "orphan text" });

		expect(entry(scan(), "orphan").kind).toBe("development");
	});

	test("survives a dependency cycle", () => {
		rootManifest({ dependencies: { a: "^1" } });
		pkg("a", { license: "MIT", dependencies: { b: "^1" } }, { LICENSE: "a" });
		pkg("b", { license: "MIT", dependencies: { a: "^1" } }, { LICENSE: "b" });

		expect(scan().entries).toHaveLength(2);
	});

	test("handles scoped package names", () => {
		rootManifest({ dependencies: { "@scope/thing": "^1" } });
		pkg("@scope/thing", { license: "MIT" }, { LICENSE: "scoped" });

		expect(entry(scan(), "@scope/thing").license).toBe("MIT");
	});
});

/**
 * Nested `node_modules` copies.
 *
 * Resolving dependencies by NAME against the root `node_modules` — which is what this
 * scanner did — attributes the hoisted copy's license to a dependent that actually links a
 * nested one. In this repo that mislabelled seven packages outright (`d3-sankey` links
 * `d3-array@2`, BSD-3-Clause, while the hoisted `d3-array@3` is ISC) and reported the wrong
 * version for 130 more. Nothing about it was visible: the page rendered a plausible row for
 * every name, just describing a copy we do not ship.
 */
describe("nested node_modules resolution", () => {
	/** Write a package into an arbitrary nested location. */
	function nestedPkg(
		parentPath: string[],
		name: string,
		manifest: Record<string, unknown>,
		files: Record<string, string> = {},
	): void {
		const dir = join(
			root,
			"node_modules",
			...parentPath.flatMap((segment) => [segment, "node_modules"]),
			name,
		);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ name, version: "1.0.0", ...manifest }),
		);
		for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
	}

	test("attributes the nested copy's own license, not the hoisted one's", () => {
		// The d3-sankey/d3-array shape: same name, different version, DIFFERENT license.
		rootManifest({ dependencies: { host: "^1", dep: "^3" } });
		pkg("host", { license: "MIT", dependencies: { dep: "^2" } }, { LICENSE: "host" });
		pkg("dep", { version: "3.0.0", license: "ISC" }, { LICENSE: "isc text" });
		nestedPkg(
			["host"],
			"dep",
			{ version: "2.0.0", license: "BSD-3-Clause" },
			{
				LICENSE: "bsd text",
			},
		);

		const manifest = scan();
		const deps = manifest.entries.filter((e) => e.name === "dep");
		expect(deps.map((e) => `${e.version} ${e.license}`)).toEqual([
			"2.0.0 BSD-3-Clause",
			"3.0.0 ISC",
		]);
		// Both are runtime-reachable, so both licenses are obligations we carry.
		expect(deps.every((e) => e.kind === "runtime")).toBe(true);
		// And each shows its OWN text, not the other's.
		expect(manifest.texts[deps[0].textId ?? ""]).toBe("bsd text");
		expect(manifest.texts[deps[1].textId ?? ""]).toBe("isc text");
	});

	test("a nested copy shadows the hoisted one for that subtree", () => {
		// Only the nested version ships here: nothing depends on a hoisted `dep` directly.
		rootManifest({ dependencies: { host: "^1" } });
		pkg("host", { license: "MIT", dependencies: { dep: "^2" } }, { LICENSE: "host" });
		pkg("dep", { version: "3.0.0", license: "ISC" }, { LICENSE: "isc" });
		nestedPkg(["host"], "dep", { version: "2.0.0", license: "BSD-3-Clause" }, { LICENSE: "bsd" });

		const manifest = scan();
		const nested = manifest.entries.find((e) => e.name === "dep" && e.version === "2.0.0");
		const hoisted = manifest.entries.find((e) => e.name === "dep" && e.version === "3.0.0");
		expect(nested?.kind).toBe("runtime");
		// The hoisted copy is still listed (it is installed) but only as development: nothing
		// in the runtime graph reaches it.
		expect(hoisted?.kind).toBe("development");
	});

	test("resolution walks up through ancestors, not just the nearest directory", () => {
		// `deep` is satisfied from the ROOT node_modules even though it is requested three
		// levels down — Node's algorithm, and the common layout after hoisting.
		rootManifest({ dependencies: { a: "^1" } });
		pkg("a", { license: "MIT", dependencies: { b: "^1" } }, { LICENSE: "a" });
		nestedPkg(["a"], "b", { license: "MIT", dependencies: { deep: "^1" } }, { LICENSE: "b" });
		pkg("deep", { license: "MIT" }, { LICENSE: "deep" });

		expect(entry(scan(), "deep").kind).toBe("runtime");
	});

	test("the same version installed at several paths collapses to one entry", () => {
		// Duplicate paths are one artifact with one license; listing it per path would make
		// the page look like it has hundreds of duplicates.
		rootManifest({ dependencies: { one: "^1", two: "^1" } });
		pkg("one", { license: "MIT", dependencies: { shared: "^1" } }, { LICENSE: "one" });
		pkg("two", { license: "MIT", dependencies: { shared: "^1" } }, { LICENSE: "two" });
		nestedPkg(["one"], "shared", { version: "1.0.0", license: "MIT" }, { LICENSE: "shared" });
		nestedPkg(["two"], "shared", { version: "1.0.0", license: "MIT" }, { LICENSE: "shared" });

		expect(scan().entries.filter((e) => e.name === "shared")).toHaveLength(1);
	});

	test("an installed-but-unreachable nested copy is still attributed", () => {
		rootManifest({ dependencies: { host: "^1" } });
		pkg("host", { license: "MIT" }, { LICENSE: "host" });
		nestedPkg(["host"], "stale", { license: "MIT" }, { LICENSE: "stale text" });

		expect(entry(scan(), "stale").kind).toBe("development");
	});

	test("survives a cycle that recurses through nested directories", () => {
		rootManifest({ dependencies: { a: "^1" } });
		pkg("a", { license: "MIT", dependencies: { b: "^1" } }, { LICENSE: "a" });
		nestedPkg(["a"], "b", { license: "MIT", dependencies: { a: "^1" } }, { LICENSE: "b" });

		expect(() => scan()).not.toThrow();
		expect(
			scan()
				.entries.map((e) => e.name)
				.sort(),
		).toEqual(["a", "b"]);
	});
});

describe("license file discovery", () => {
	test.each([
		["LICENSE"],
		["LICENCE"],
		["license"],
		["License.md"],
		["LICENSE.txt"],
		["COPYING"],
		["copying.md"],
		["LICENSE-MIT"],
	])("finds %s", (fileName) => {
		// A fixed candidate list missed 23 packages in the real tree. Each of these
		// variants exists somewhere in node_modules.
		rootManifest({ dependencies: { p: "^1" } });
		pkg("p", { license: "MIT" }, { [fileName]: "the license text" });

		const manifest = scan();
		const found = entry(manifest, "p");
		expect(found.textSource).toBe("package");
		expect(manifest.texts[found.textId ?? ""]).toBe("the license text");
	});

	test("does not mistake unrelated files for licenses", () => {
		rootManifest({ dependencies: { p: "^1" } });
		pkg("p", { license: "MIT" }, { "licensing-guide.md": "not a license", README: "no" });

		// `licensing-guide.md` must not match: it would show marketing copy where the
		// license belongs.
		expect(entry(scan(), "p").textSource).toBe("spdx-template");
	});

	test("concatenates multiple license files instead of showing only the first", () => {
		rootManifest({ dependencies: { p: "^1" } });
		pkg(
			"p",
			{ license: "MIT OR Apache-2.0" },
			{ "LICENSE-APACHE": "apache body", "LICENSE-MIT": "mit body" },
		);

		const manifest = scan();
		const text = manifest.texts[entry(manifest, "p").textId ?? ""];
		expect(text).toContain("apache body");
		expect(text).toContain("mit body");
	});

	test("captures NOTICE separately from the license", () => {
		// Apache-2.0 §4(d) requires redistributing NOTICE contents in addition to the
		// license, so folding them together would lose the distinction.
		rootManifest({ dependencies: { p: "^1" } });
		pkg("p", { license: "Apache-2.0" }, { LICENSE: "apache text", NOTICE: "notice text" });

		const manifest = scan();
		const found = entry(manifest, "p");
		expect(manifest.texts[found.textId ?? ""]).toBe("apache text");
		expect(found.noticeTextId).toBeDefined();
		expect(manifest.texts[found.noticeTextId ?? ""]).toBe("notice text");
	});

	test("ignores a directory named like a license file", () => {
		rootManifest({ dependencies: { p: "^1" } });
		pkg("p", { license: "MIT" });
		mkdirSync(join(root, "node_modules", "p", "licenses"), { recursive: true });

		expect(() => scan()).not.toThrow();
		expect(entry(scan(), "p").textSource).toBe("spdx-template");
	});
});

describe("text deduplication", () => {
	test("identical texts share one id and one stored copy", () => {
		// 1052 packages ship text but only 488 texts are distinct; without this the
		// embedded payload would be ~2x larger for no benefit.
		rootManifest({ dependencies: { a: "^1", b: "^1" } });
		pkg("a", { license: "MIT" }, { LICENSE: "same boilerplate" });
		pkg("b", { license: "MIT" }, { LICENSE: "same boilerplate" });

		const manifest = scan();
		expect(entry(manifest, "a").textId).toBe(entry(manifest, "b").textId);
		expect(Object.keys(manifest.texts)).toHaveLength(1);
	});

	test("differing texts get different ids", () => {
		rootManifest({ dependencies: { a: "^1", b: "^1" } });
		pkg("a", { license: "MIT" }, { LICENSE: "text one" });
		pkg("b", { license: "MIT" }, { LICENSE: "text two" });

		const manifest = scan();
		expect(entry(manifest, "a").textId).not.toBe(entry(manifest, "b").textId);
	});

	test("ids are content-addressed and stable across runs", () => {
		expect(licenseTextId("hello")).toBe(licenseTextId("hello"));
		expect(licenseTextId("hello")).toMatch(/^[0-9a-f]{16}$/);
	});

	test("drops texts nothing references", () => {
		rootManifest({ dependencies: {} });
		const manifest = scanLicenseManifest({
			root,
			extraTexts: { "0123456789abcdef": "orphaned text" },
		});
		expect(manifest.texts["0123456789abcdef"]).toBeUndefined();
	});
});

describe("license identifier resolution", () => {
	test("reads the deprecated `licenses` array form", () => {
		// `format` uses this and rendered as UNKNOWN before.
		rootManifest({ dependencies: { p: "^1" } });
		pkg("p", { licenses: [{ type: "MIT", url: "http://example.com" }] }, { LICENSE: "t" });

		expect(entry(scan(), "p").license).toBe("MIT");
	});

	test("reads the object form `license: { type }`", () => {
		rootManifest({ dependencies: { p: "^1" } });
		pkg("p", { license: { type: "ISC", url: "http://example.com" } }, { LICENSE: "t" });

		expect(entry(scan(), "p").license).toBe("ISC");
	});

	test("treats a multi-entry legacy array as a disjunction", () => {
		rootManifest({ dependencies: { p: "^1" } });
		pkg("p", { licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] }, { LICENSE: "t" });

		expect(entry(scan(), "p").license).toBe("MIT OR Apache-2.0");
	});

	test("applies the hand-verified override for a package declaring nothing", () => {
		// khroma ships an MIT `license` file but no `license` field.
		rootManifest({ dependencies: { khroma: "^1" } });
		pkg("khroma", {}, { license: "MIT text" });

		const manifest = scan();
		expect(entry(manifest, "khroma").license).toBe("MIT");
		expect(manifest.problems.some((p) => p.name === "khroma")).toBe(false);
	});

	test("reports an undeclared license as an error for a distributed package", () => {
		rootManifest({ dependencies: { mystery: "^1" } });
		pkg("mystery", {}, { LICENSE: "some text" });

		const manifest = scan();
		expect(entry(manifest, "mystery").license).toBe("UNKNOWN");
		expect(manifest.problems.some((p) => p.name === "mystery" && p.severity === "error")).toBe(
			true,
		);
	});

	test("the same defect in a dev-only package is a warning, not a release blocker", () => {
		rootManifest({ devDependencies: { mystery: "^1" } });
		pkg("mystery", {}, { LICENSE: "some text" });

		const manifest = scan();
		expect(manifest.problems.some((p) => p.name === "mystery" && p.severity === "warn")).toBe(true);
		expect(manifest.problems.some((p) => p.severity === "error")).toBe(false);
	});
});

describe("dual-license selection", () => {
	test("records the selected branch and what it was selected from", () => {
		rootManifest({ dependencies: { dompurify: "^3" } });
		pkg("dompurify", { license: "(MPL-2.0 OR Apache-2.0)" }, { LICENSE: "text" });

		const found = entry(scan(), "dompurify");
		expect(found.license).toBe("Apache-2.0");
		expect(found.declaredLicense).toBe("(MPL-2.0 OR Apache-2.0)");
		expect(found.selectionReason).toBeTruthy();
	});

	test("an undocumented disjunction blocks the build rather than displaying silently", () => {
		// Showing "MPL-2.0 OR Apache-2.0" verbatim looks like an answer while hiding
		// that nobody chose a branch — and MPL carries source-disclosure duties.
		rootManifest({ dependencies: { newcomer: "^1" } });
		pkg("newcomer", { license: "MPL-2.0 OR Apache-2.0" }, { LICENSE: "text" });

		const manifest = scan();
		expect(manifest.problems.some((p) => p.name === "newcomer" && p.severity === "error")).toBe(
			true,
		);
	});

	test("detects the selection table drifting from upstream's offer", () => {
		// If upstream drops the branch we picked, our stated license would be one they
		// never granted.
		rootManifest({ dependencies: { dompurify: "^3" } });
		pkg("dompurify", { license: "MPL-2.0 OR GPL-2.0" }, { LICENSE: "text" });

		const manifest = scan();
		expect(
			manifest.problems.some((p) => p.name === "dompurify" && /not among upstream/.test(p.message)),
		).toBe(true);
	});

	test("a single license is passed through untouched", () => {
		rootManifest({ dependencies: { p: "^1" } });
		pkg("p", { license: "MIT" }, { LICENSE: "t" });

		const found = entry(scan(), "p");
		expect(found.license).toBe("MIT");
		expect(found.declaredLicense).toBeUndefined();
	});
});

describe("missing license text fallback", () => {
	test("renders the SPDX template and marks it as such", () => {
		rootManifest({ dependencies: { "remark-math": "^6" } });
		pkg("remark-math", { license: "MIT", author: "Junyoung Choi" });

		const manifest = scan();
		const found = entry(manifest, "remark-math");
		expect(found.textSource).toBe("spdx-template");
		const text = manifest.texts[found.textId ?? ""];
		expect(text).toContain("Junyoung Choi");
		expect(text).toContain("Permission is hereby granted");
	});

	test("falls back to a truthful holder when the author is unknown", () => {
		// Inventing a person or a year would put a false claim in a license notice.
		rootManifest({ dependencies: { anon: "^1" } });
		pkg("anon", { license: "MIT" });

		const manifest = scan();
		expect(manifest.texts[entry(manifest, "anon").textId ?? ""]).toContain("The anon authors");
	});

	test("reports when no template exists rather than inventing text", () => {
		rootManifest({ dependencies: { exotic: "^1" } });
		pkg("exotic", { license: "EUPL-1.2" });

		const manifest = scan();
		const found = entry(manifest, "exotic");
		expect(found.textSource).toBe("missing");
		expect(found.textId).toBeUndefined();
		expect(manifest.problems.some((p) => p.name === "exotic" && p.severity === "error")).toBe(true);
	});

	test("covers every license present in the real tree", () => {
		// Apache-2.0 and CC0-1.0 both appear with no upstream file; neither may be left
		// textless, and CC0 in particular must not be paraphrased.
		for (const license of [
			"MIT",
			"ISC",
			"Apache-2.0",
			"BSD-2-Clause",
			"BSD-3-Clause",
			"0BSD",
			"Unlicense",
			"CC0-1.0",
		]) {
			rmSync(join(root, "node_modules"), { recursive: true, force: true });
			rootManifest({ dependencies: { p: "^1" } });
			pkg("p", { license });
			const found = entry(scan(), "p");
			expect(found.textSource, `${license} must have a template`).toBe("spdx-template");
		}
	});
});

describe("extra (hand-declared) entries", () => {
	test("merges them and sorts bundled components first", () => {
		rootManifest({ dependencies: { alib: "^1" } });
		pkg("alib", { license: "MIT" }, { LICENSE: "lib text" });

		const manifest = scanLicenseManifest({
			root,
			extraEntries: [
				{
					name: "zstd",
					version: "1.5.7",
					license: "BSD-3-Clause",
					author: "Meta",
					repository: "https://github.com/facebook/zstd",
					kind: "bundled",
					textSource: "package",
					textId: licenseTextId("zstd license"),
				},
			],
			extraTexts: { [licenseTextId("zstd license")]: "zstd license" },
		});

		expect(manifest.entries[0].name).toBe("zstd");
		expect(manifest.entries[0].kind).toBe("bundled");
	});
});

describe("ordering", () => {
	test("groups by kind then sorts alphabetically", () => {
		rootManifest({ dependencies: { zeta: "^1", alpha: "^1" }, devDependencies: { tool: "^1" } });
		pkg("zeta", { license: "MIT" }, { LICENSE: "z" });
		pkg("alpha", { license: "MIT" }, { LICENSE: "a" });
		pkg("tool", { license: "MIT" }, { LICENSE: "t" });

		expect(scan().entries.map((e) => e.name)).toEqual(["alpha", "zeta", "tool"]);
	});
});

describe("repository url normalization", () => {
	test.each([
		[{ repository: "git+https://github.com/a/b.git" }, "https://github.com/a/b"],
		[
			{ repository: { type: "git", url: "git+https://github.com/a/b.git" } },
			"https://github.com/a/b",
		],
		[{ repository: "git://github.com/a/b.git" }, "https://github.com/a/b"],
		[{ repository: "a/b" }, "https://github.com/a/b"],
		[{ repository: "github:a/b" }, "https://github.com/a/b"],
		[{ repository: "gitlab:a/b" }, "https://gitlab.com/a/b"],
		[{ homepage: "https://example.com" }, "https://example.com"],
		[{}, ""],
	])("normalizes %o", (input, expected) => {
		expect(normalizeRepositoryUrl(input)).toBe(expected);
	});

	test("rejects a shorthand it cannot interpret rather than emitting a broken link", () => {
		expect(normalizeRepositoryUrl({ repository: "not a repo reference" })).toBe("");
	});
});

describe("robustness", () => {
	test("reports a missing root package.json instead of returning an empty page", () => {
		const manifest = scan();
		expect(manifest.problems.some((p) => p.severity === "error")).toBe(true);
	});

	test("a malformed package.json is reported, not silently skipped", () => {
		// The old implementation had a bare `catch {}` here, so a layout change could
		// quietly shrink the page.
		rootManifest({ dependencies: { broken: "^1" } });
		mkdirSync(join(root, "node_modules", "broken"), { recursive: true });
		writeFileSync(join(root, "node_modules", "broken", "package.json"), "{ not json");

		const manifest = scan();
		expect(manifest.problems.some((p) => p.name === "broken")).toBe(true);
	});

	test("readDeclaredLicense trims whitespace", () => {
		expect(readDeclaredLicense({ license: "  MIT  " }, "p")).toBe("MIT");
	});
});
