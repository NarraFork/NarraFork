/**
 * manifest-extra.test.ts — Contract for the hand-declared (`licenses/extra/`) entries.
 *
 * These entries cover everything distributed but unreachable from `node_modules`: the Bun
 * runtime compiled into every binary, the static `zstd`, musl, the Go executor and its
 * modules, the `@parcel/watcher` native `.node` files. They are the heaviest obligations we
 * carry AND the only ones no scanner can find, so the failure mode is silence: a stale or
 * missing entry produces a page that reads as complete.
 *
 * The version self-check exists because a `version` here is a COPY of a number that lives
 * elsewhere. It read 1.3.13 while `bun.txt` reproduced Bun 1.3.14's LICENSE.md — two
 * different lists of statically linked libraries, so the page attributed one build's
 * dependencies to another's, with nothing anywhere reporting it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildLicenseManifestFromDisk } from "../manifest";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

function manifest() {
	return buildLicenseManifestFromDisk(REPO_ROOT);
}

function extraEntriesJson(): Array<Record<string, unknown>> {
	const path = join(REPO_ROOT, "licenses", "extra", "entries.json");
	return JSON.parse(readFileSync(path, "utf8")) as Array<Record<string, unknown>>;
}

describe("hand-declared bundled entries", () => {
	test("every one of them is loaded and marked bundled", () => {
		const declared = extraEntriesJson();
		const bundled = manifest().entries.filter((entry) => entry.kind === "bundled");
		expect(bundled).toHaveLength(declared.length);
		expect(bundled.map((entry) => entry.name).sort()).toEqual(
			declared.map((entry) => String(entry.name)).sort(),
		);
	});

	test("each states how it reaches the user", () => {
		// A bundled component is invisible in package.json, so without this a reader cannot
		// tell why `musl libc` is on the page — or check whether the claim is still true.
		for (const entry of manifest().entries.filter((e) => e.kind === "bundled")) {
			expect(entry.distributedVia, `${entry.name} must say how it is distributed`).toBeTruthy();
		}
	});

	test("each carries retrievable license text", () => {
		const { entries, texts } = manifest();
		for (const entry of entries.filter((e) => e.kind === "bundled")) {
			expect(entry.textId, `${entry.name} must have license text`).toBeTruthy();
			expect(texts[entry.textId ?? ""]?.length ?? 0).toBeGreaterThan(0);
		}
	});
});

describe("version self-check", () => {
	test("purego and its runtime-derived attribution match the executor dependency", () => {
		const goMod = readFileSync(join(REPO_ROOT, "remote-executor", "go.mod"), "utf8");
		const version = goMod.match(/github\.com\/ebitengine\/purego\s+v([^\s]+)/)?.[1];
		expect(version).toBeDefined();
		const { entries, texts } = manifest();
		const purego = entries.find((entry) => entry.name === "github.com/ebitengine/purego");
		const runtime = entries.find(
			(entry) => entry.name === "github.com/ebitengine/purego (Go runtime-derived code)",
		);
		expect(purego?.version).toBe(version);
		expect(purego?.license).toBe("Apache-2.0");
		expect(runtime?.version).toBe(version);
		expect(runtime?.license).toBe("BSD-3-Clause");
		expect(texts[purego?.textId ?? ""]).toContain("Apache License");
		expect(texts[runtime?.textId ?? ""]).toContain("The Go Authors");
	});
	test("the Bun entry matches the runtime that gets compiled in", () => {
		// `bun build --compile` embeds the runtime of the bun executing it, so this — not the
		// `packageManager` pin — is what a released binary actually contains.
		const bun = manifest().entries.find((entry) => entry.name === "Bun runtime");
		expect(bun?.version).toBe(Bun.version);
	});

	test("bun.txt reproduces the license of the version the entry declares", () => {
		// The two are separate copies of the same fact; a mismatch means the reproduced list of
		// statically linked libraries belongs to a different build than the one we ship.
		const bun = manifest().entries.find((entry) => entry.name === "Bun runtime");
		const text = readFileSync(join(REPO_ROOT, "licenses", "extra", "bun.txt"), "utf8");
		expect(text).toContain(`bun-v${bun?.version}/LICENSE.md`);
	});

	test("a mismatch is reported rather than displayed as if correct", () => {
		// Drive the check through a fixture whose declared version cannot match the runtime.
		const problems = versionCheckProblems("0.0.1");
		expect(problems.some((message) => /Declares version "0\.0\.1"/.test(message))).toBe(true);
	});

	test("a same-series (patch) drift warns instead of blocking a release", () => {
		// Patch bumps essentially never change which libraries are linked, and blocking every
		// release on one nobody controls would train people to ignore the check entirely.
		const [major, minor] = Bun.version.split(".");
		const patchDrift = `${major}.${minor}.${Number(Bun.version.split(".")[2]) + 1}`;
		const errors = versionCheckProblems(patchDrift, "error");
		expect(errors).toEqual([]);
		expect(versionCheckProblems(patchDrift, "warn").length).toBeGreaterThan(0);
	});

	test("the current tree reports no blocking problem", () => {
		const errors = manifest()
			.problems.filter((problem) => problem.severity === "error")
			.map((problem) => `${problem.name ?? "-"}: ${problem.message}`);
		expect(errors).toEqual([]);
	});
});

/**
 * Run the loader against a fixture repo whose Bun entry declares `version`, and return the
 * messages of the matching severity.
 *
 * A fixture rather than mutating the real `entries.json`: the check reads the running
 * runtime, so the only way to produce a mismatch is to change the declared side.
 */
function versionCheckProblems(version: string, severity?: "error" | "warn"): string[] {
	const { mkdirSync, mkdtempSync, writeFileSync, rmSync, copyFileSync } =
		require("node:fs") as typeof import("node:fs");
	const { tmpdir } = require("node:os") as typeof import("node:os");
	const root = mkdtempSync(join(tmpdir(), "nf-extra-"));
	try {
		const extraDir = join(root, "licenses", "extra");
		mkdirSync(extraDir, { recursive: true });
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture" }));
		copyFileSync(join(REPO_ROOT, "licenses", "extra", "bun.txt"), join(extraDir, "bun.txt"));
		writeFileSync(
			join(extraDir, "entries.json"),
			JSON.stringify([
				{
					name: "Bun runtime",
					version,
					versionSource: "bun-runtime",
					license: "MIT",
					textFile: "bun.txt",
					distributedVia: "fixture",
				},
			]),
		);
		return buildLicenseManifestFromDisk(root)
			.problems.filter((problem) => problem.name === "Bun runtime")
			.filter((problem) => severity === undefined || problem.severity === severity)
			.map((problem) => problem.message);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
