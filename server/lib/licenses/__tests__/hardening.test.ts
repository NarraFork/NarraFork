/**
 * hardening.test.ts — The scanner's defensive checks, tested with the inputs that
 * defeated them.
 *
 * Each case below sits where the code *claims* a guarantee that it did not
 * actually provide, which is the worst place for a gap: a reader (and a reviewer)
 * takes the comment at face value. So the assertions use the concrete hostile
 * value rather than a generic "invalid input", because the generic case already
 * passed before the fix.
 *
 * All three inputs are upstream-controlled in production: `textFile` comes from a
 * committed file that a bad merge can edit, and a dependency's `license` field is
 * whatever its publisher wrote.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSelectedLicense } from "../dual-license";
import { buildLicenseManifestFromDisk } from "../manifest";
import { scanLicenseManifest } from "../scan";
import { hasSpdxTemplate, renderSpdxTemplate } from "../spdx-templates";
import type { LicenseProblem } from "../types";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "nf-licenses-hardening-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Write an `entries.json` with a single hand-declared entry into the fixture root. */
function writeExtraEntries(entries: Array<Record<string, unknown>>): void {
	const extraDir = join(root, "licenses", "extra");
	mkdirSync(extraDir, { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture" }));
	writeFileSync(join(extraDir, "entries.json"), JSON.stringify(entries));
}

function problemsFor(name: string): LicenseProblem[] {
	return buildLicenseManifestFromDisk(root).problems.filter(
		(problem) => problem.name === name || problem.name === undefined,
	);
}

describe("extra-entry file paths cannot escape licenses/extra/", () => {
	test("a sibling whose name merely extends the directory's is rejected", () => {
		// The bug: `resolve(textPath).startsWith(resolve(extraDir))` is a *string*
		// prefix test. "../extra-evil.txt" resolves to `<root>/licenses/extra-evil.txt`,
		// which begins with `<root>/licenses/extra` — so the escape passed the check
		// that :235's comment promises "can never read outside the directory".
		writeFileSync(join(root, "secret.txt"), "SHOULD NOT BE READ");
		mkdirSync(join(root, "licenses"), { recursive: true });
		writeFileSync(join(root, "licenses", "extra-evil.txt"), "ESCAPED CONTENT");
		writeExtraEntries([
			{
				name: "escapee",
				version: "1.0.0",
				license: "MIT",
				textFile: "../extra-evil.txt",
				distributedVia: "fixture",
			},
		]);

		const manifest = buildLicenseManifestFromDisk(root);
		expect(
			manifest.problems.some((problem) =>
				/resolves outside licenses\/extra\//.test(problem.message),
			),
		).toBe(true);
		// The point is not just the report: the file must not have been read.
		expect(Object.values(manifest.texts).join("\n")).not.toContain("ESCAPED CONTENT");
	});

	test("a traversal out of the tree entirely is rejected", () => {
		writeExtraEntries([
			{
				name: "traverser",
				version: "1.0.0",
				license: "MIT",
				textFile: "../../../../etc/passwd",
				distributedVia: "fixture",
			},
		]);
		expect(
			problemsFor("traverser").some((problem) =>
				/resolves outside licenses\/extra\//.test(problem.message),
			),
		).toBe(true);
	});

	test("noticeFile is held to the same boundary", () => {
		// The notice path had an identical prefix check, and a NOTICE is rendered on the
		// page too — so an escape there leaks file contents just as effectively.
		mkdirSync(join(root, "licenses"), { recursive: true });
		writeFileSync(join(root, "licenses", "extra-notice.txt"), "ESCAPED NOTICE");
		const extraDir = join(root, "licenses", "extra");
		mkdirSync(extraDir, { recursive: true });
		writeFileSync(join(extraDir, "ok.txt"), "MIT text");
		writeExtraEntries([
			{
				name: "notice-escapee",
				version: "1.0.0",
				license: "MIT",
				textFile: "ok.txt",
				noticeFile: "../extra-notice.txt",
				distributedVia: "fixture",
			},
		]);
		// `writeExtraEntries` rewrote entries.json but left ok.txt in place.
		writeFileSync(join(extraDir, "ok.txt"), "MIT text");

		const manifest = buildLicenseManifestFromDisk(root);
		expect(
			manifest.problems.some((problem) =>
				/noticeFile .* is missing or outside licenses\/extra\//.test(problem.message),
			),
		).toBe(true);
		expect(Object.values(manifest.texts).join("\n")).not.toContain("ESCAPED NOTICE");
	});

	test("an ordinary nested file is still accepted", () => {
		// The fix must not be a blanket rejection: subdirectories are legitimate.
		const extraDir = join(root, "licenses", "extra");
		mkdirSync(join(extraDir, "nested"), { recursive: true });
		writeExtraEntries([
			{
				name: "nested-ok",
				version: "1.0.0",
				license: "MIT",
				textFile: "nested/license.txt",
				distributedVia: "fixture",
			},
		]);
		mkdirSync(join(extraDir, "nested"), { recursive: true });
		writeFileSync(join(extraDir, "nested", "license.txt"), "NESTED MIT TEXT");

		const manifest = buildLicenseManifestFromDisk(root);
		const entry = manifest.entries.find((candidate) => candidate.name === "nested-ok");
		expect(entry?.textId).toBeTruthy();
		expect(manifest.texts[entry?.textId ?? ""]).toBe("NESTED MIT TEXT");
	});
});

describe("license identifiers cannot reach Object.prototype", () => {
	test.each([
		["constructor"],
		["toString"],
		["hasOwnProperty"],
		["__proto__"],
		["valueOf"],
	])("%s is not a template", (license) => {
		// `TEMPLATES[license]` used to resolve through the prototype chain: for
		// "constructor" it returned a *function*, which is truthy, so the code went on
		// to call `template.replaceAll` and threw a TypeError. That escaped
		// `scanLicenseManifest` entirely — a 500 on /api/licenses in development, and
		// an uncaught exception aborting the cross-platform build.
		expect(hasSpdxTemplate(license)).toBe(false);
		expect(renderSpdxTemplate(license, "X")).toBeNull();
	});

	test('a dependency declaring license "constructor" does not abort the scan', () => {
		// The end-to-end shape: the field is whatever a third-party publisher wrote, so
		// this arrives through normal package metadata with no attacker access needed
		// beyond publishing to the registry.
		const dir = join(root, "node_modules", "hostile");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ name: "hostile", version: "1.0.0", license: "constructor" }),
		);
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ name: "fixture", dependencies: { hostile: "^1" } }),
		);

		// Must not throw: that is the whole regression.
		const manifest = scanLicenseManifest({ root });
		const entry = manifest.entries.find((candidate) => candidate.name === "hostile");
		expect(entry).toBeDefined();
		// No template exists, so it is honestly marked as having no text rather than
		// showing something invented.
		expect(entry?.textSource).toBe("missing");
	});

	test("real identifiers still render", () => {
		expect(hasSpdxTemplate("MIT")).toBe(true);
		expect(renderSpdxTemplate("MIT", "Acme")).toContain("Copyright (c) Acme");
	});
});

describe("dual-license drift detection compares whole identifiers", () => {
	test("a selection absent from upstream's offer is reported", () => {
		// type-fest's table entry selects MIT. If upstream moved to "MIT-0 OR CC0-1.0",
		// a substring test finds "MIT" inside "MIT-0" and the guard passes — the page
		// would then claim MIT, a branch upstream never granted. MIT-0 differs
		// materially: it drops the attribution requirement, so the two are not
		// interchangeable even though one contains the other's name.
		const problems: LicenseProblem[] = [];
		const resolved = resolveSelectedLicense("type-fest", "MIT-0 OR CC0-1.0", problems, "runtime");
		expect(problems.some((problem) => /is not among upstream's/.test(problem.message))).toBe(true);
		// Falls back to displaying the raw disjunction rather than asserting a branch.
		expect(resolved.license).toBe("MIT-0 OR CC0-1.0");
		expect(resolved.selectionReason).toBeUndefined();
	});

	test("a longer-suffixed near-identifier does not satisfy the selection", () => {
		// The same trap with BSD: "BSD-3-Clause-Clear" contains "BSD-3-Clause".
		const problems: LicenseProblem[] = [];
		resolveSelectedLicense("json-schema", "BSD-3-Clause-Clear OR AFL-2.1", problems, "runtime");
		expect(problems.some((problem) => /is not among upstream's/.test(problem.message))).toBe(true);
	});

	test("an exact match still resolves, including inside parentheses", () => {
		// npm metadata writes disjunctions both ways, so tokenizing must handle both or
		// the guard flips into a false positive that blocks every release.
		for (const declared of ["MIT OR CC0-1.0", "(MIT OR CC0-1.0)"]) {
			const problems: LicenseProblem[] = [];
			const resolved = resolveSelectedLicense("type-fest", declared, problems, "runtime");
			expect(problems, declared).toEqual([]);
			expect(resolved.license, declared).toBe("MIT");
			expect(resolved.declaredLicense, declared).toBe(declared);
			expect(resolved.selectionReason, declared).toBeTruthy();
		}
	});

	test("drift in a dev-only package warns instead of blocking", () => {
		// Unchanged behaviour, pinned so the tokenizing fix cannot quietly promote a
		// dev-only untidiness into a release blocker.
		const problems: LicenseProblem[] = [];
		resolveSelectedLicense("@biomejs/biome", "MIT-0 OR Apache-2.0", problems, "development");
		expect(problems.map((problem) => problem.severity)).toEqual(["warn"]);
	});
});
