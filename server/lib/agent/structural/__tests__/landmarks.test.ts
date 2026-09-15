/**
 * Landmark scanning.
 *
 * The risk in a heuristic like this is not missing a banner — it is matching too much. A
 * landmark list that includes every comment containing a dash is noise, and noise is why
 * the caller goes back to writing their own regex. So most of these tests are about what
 * must NOT be reported.
 */
import { describe, expect, test } from "bun:test";
import { countByTag, scanLandmarks } from "../landmarks";

describe("section banners", () => {
	test("finds the repo's own `// --- name ---` form", () => {
		const marks = scanLandmarks("const a = 1;\n// --- Scroll state ---\nconst b = 2;\n");
		expect(marks).toHaveLength(1);
		expect(marks[0]).toMatchObject({ line: 2, kind: "section", label: "Scroll state" });
	});

	test("finds box-drawing rules used in this codebase", () => {
		const marks = scanLandmarks("// ── rendering helpers ────────────\n");
		expect(marks[0]).toMatchObject({ kind: "section", label: "rendering helpers" });
	});

	test("finds `# ===` in shell and config files", () => {
		const marks = scanLandmarks("#!/bin/sh\n# ===== setup =====\necho hi\n");
		expect(marks[0]).toMatchObject({ line: 2, kind: "section", label: "setup" });
	});

	test("a bare rule with no text is still a boundary", () => {
		const marks = scanLandmarks("// ────────────────────────\n");
		expect(marks[0]).toMatchObject({ kind: "section", label: "" });
	});

	test("keeps SQL, Lisp and Erlang comment styles", () => {
		const marks = scanLandmarks("-- === schema ===\n;; --- init ---\n% == header ==\n");
		expect(marks.map((m) => m.label)).toEqual(["schema", "init", "header"]);
	});

	test("handles an HTML comment banner", () => {
		const marks = scanLandmarks("<!-- ===== layout ===== -->\n");
		expect(marks[0]).toMatchObject({ kind: "section", label: "layout" });
	});

	test("reports the line, and lines are 1-based", () => {
		const marks = scanLandmarks("a\nb\n// --- here ---\n");
		expect(marks[0]?.line).toBe(3);
	});
});

describe("what must NOT be reported", () => {
	test("an ordinary comment containing a dash", () => {
		expect(scanLandmarks("// a-b is fine\n")).toHaveLength(0);
	});

	test("an ordinary comment containing an equals sign", () => {
		expect(scanLandmarks("// x = 1 by default\n")).toHaveLength(0);
	});

	test("code, even when it contains rule characters", () => {
		// `---` inside an expression or a string is not a comment at all.
		expect(scanLandmarks("const x = a - - -b;\nconst s = '=====';\n")).toHaveLength(0);
	});

	test("an arrow function body", () => {
		expect(scanLandmarks("const f = () => x;\n")).toHaveLength(0);
	});

	test("blank lines", () => {
		expect(scanLandmarks("\n\n\n")).toHaveLength(0);
	});

	test("prose mentioning a tag without it being a marker", () => {
		// The tag must be followed by a colon or whitespace boundary AND be a known tag;
		// `NOTES` is not `NOTE`.
		expect(scanLandmarks("// NOTES_FILE holds the path\n")).toHaveLength(0);
	});

	test("a region end marker is not itself a landmark", () => {
		const marks = scanLandmarks("// #region setup\n// #endregion\n");
		expect(marks).toHaveLength(1);
		expect(marks[0]?.kind).toBe("region");
	});
});

describe("markers", () => {
	test("finds TODO with its tag", () => {
		const marks = scanLandmarks("// TODO: extract this\n");
		expect(marks[0]).toMatchObject({ kind: "marker", tag: "TODO" });
	});

	test("recognises the whole tag set", () => {
		const source = [
			"// TODO: a",
			"// FIXME: b",
			"// XXX: c",
			"// HACK: d",
			"// NOTE: e",
			"// WARNING: f",
			"// BUG: g",
			"// DEPRECATED: h",
		].join("\n");
		expect(scanLandmarks(source).map((m) => m.tag)).toEqual([
			"TODO",
			"FIXME",
			"XXX",
			"HACK",
			"NOTE",
			"WARNING",
			"BUG",
			"DEPRECATED",
		]);
	});

	test("normalises a lowercase tag", () => {
		expect(scanLandmarks("// todo: later\n")[0]?.tag).toBe("TODO");
	});

	test("a marker wins over a banner on the same line", () => {
		// Filed as the TODO it is, rather than as a section called "TODO: fix this".
		const marks = scanLandmarks("// --- TODO: fix this ---\n");
		expect(marks[0]).toMatchObject({ kind: "marker", tag: "TODO" });
	});

	test("countByTag groups them", () => {
		const marks = scanLandmarks("// TODO: a\n// TODO: b\n// FIXME: c\n");
		const counts = countByTag(marks);
		expect(counts.get("TODO")).toBe(2);
		expect(counts.get("FIXME")).toBe(1);
	});

	test("countByTag ignores sections, which have no tag", () => {
		expect(countByTag(scanLandmarks("// --- x ---\n")).size).toBe(0);
	});
});

describe("regions", () => {
	test("finds `#region` with its name", () => {
		const marks = scanLandmarks("// #region Scroll handling\n");
		expect(marks[0]).toMatchObject({ kind: "region", label: "Scroll handling" });
	});

	test("finds a C/C++ `#pragma region`", () => {
		expect(scanLandmarks("// #pragma region Internals\n")[0]).toMatchObject({
			kind: "region",
			label: "Internals",
		});
	});

	test("finds a bare `#region` in a C# file", () => {
		expect(scanLandmarks("#region Helpers\n")[0]).toMatchObject({ kind: "region" });
	});
});

describe("bounds and filtering", () => {
	test("respects the limit", () => {
		const source = Array.from({ length: 50 }, (_, i) => `// --- s${i} ---`).join("\n");
		expect(scanLandmarks(source, { limit: 10 })).toHaveLength(10);
	});

	test("filters by kind", () => {
		const source = "// --- section ---\n// TODO: a\n// #region r\n";
		expect(scanLandmarks(source, { kinds: ["marker"] }).map((m) => m.kind)).toEqual(["marker"]);
	});

	test("multiple kinds can be requested", () => {
		const source = "// --- section ---\n// TODO: a\n// #region r\n";
		const kinds = scanLandmarks(source, { kinds: ["section", "region"] }).map((m) => m.kind);
		expect(kinds).toEqual(["section", "region"]);
	});

	test("results come back in file order", () => {
		const marks = scanLandmarks("// TODO: a\n// --- s ---\n// FIXME: b\n");
		expect(marks.map((m) => m.line)).toEqual([1, 2, 3]);
	});

	test("an empty file yields nothing", () => {
		expect(scanLandmarks("")).toHaveLength(0);
	});

	test("CRLF text scans the same", () => {
		const marks = scanLandmarks("a\r\n// --- s ---\r\n");
		expect(marks[0]).toMatchObject({ line: 2, kind: "section", label: "s" });
	});
});
