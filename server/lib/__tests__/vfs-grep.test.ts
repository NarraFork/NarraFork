import { describe, expect, test } from "bun:test";
import { matchesSimpleGlob, type VfsGrepFile, vfsGrep } from "../vfs-grep";

function file(path: string, content: string): VfsGrepFile {
	return { path, uri: `spec://${path}`, content };
}

const FILES: VfsGrepFile[] = [
	file("index.md", "# Work Spec\n\nNeedle here\nand AGAIN needle\n"),
	file("notes.md", "just some notes\nNeedle in notes\n"),
	file("sub/deep.md", "deep needle content\n"),
	file("tasks.json", '{\n\t"tasks": []\n}\n'),
];

describe("matchesSimpleGlob", () => {
	test("undefined/empty pattern matches everything", () => {
		expect(matchesSimpleGlob("a/b.md")).toBe(true);
		expect(matchesSimpleGlob("a/b.md", "")).toBe(true);
	});

	test("`*` matches within a path segment only", () => {
		expect(matchesSimpleGlob("notes.md", "*.md")).toBe(true);
		expect(matchesSimpleGlob("sub/deep.md", "*.md")).toBe(false); // slash not crossed
	});

	test("`**` crosses slashes", () => {
		expect(matchesSimpleGlob("sub/deep.md", "**/*.md")).toBe(true);
		expect(matchesSimpleGlob("sub/deep.md", "**.md")).toBe(true);
	});

	test("literal dots are escaped (not regex any-char)", () => {
		expect(matchesSimpleGlob("tasksXjson", "tasks.json")).toBe(false);
		expect(matchesSimpleGlob("tasks.json", "tasks.json")).toBe(true);
	});
});

describe("vfsGrep — output modes", () => {
	test("files_with_matches (default) lists distinct file URIs", () => {
		const r = vfsGrep(FILES, { pattern: "[Nn]eedle" });
		expect(r.metadata.matches).toBe(3);
		expect(r.output.split("\n").sort()).toEqual([
			"spec://index.md",
			"spec://notes.md",
			"spec://sub/deep.md",
		]);
	});

	test("content mode shows uri:line:text with line numbers by default", () => {
		const r = vfsGrep(FILES, { pattern: "Needle", outputMode: "content" });
		expect(r.output).toContain("spec://index.md:3:Needle here");
		expect(r.output).toContain("spec://notes.md:2:Needle in notes");
	});

	test("content mode without line numbers", () => {
		const r = vfsGrep(FILES, {
			pattern: "Needle here",
			outputMode: "content",
			showLineNumbers: false,
		});
		expect(r.output).toBe("spec://index.md:Needle here");
	});

	test("count mode reports per-file match counts", () => {
		const r = vfsGrep(FILES, { pattern: "[Nn]eedle", outputMode: "count" });
		// index.md has two matching lines; others one each.
		expect(r.output).toContain("spec://index.md:2");
		expect(r.output).toContain("spec://notes.md:1");
		expect(r.output).toContain("spec://sub/deep.md:1");
	});
});

describe("vfsGrep — flags", () => {
	test("case-insensitive flag", () => {
		const insensitive = vfsGrep(FILES, { pattern: "needle", caseInsensitive: true });
		expect(insensitive.metadata.matches).toBe(3);
		const sensitive = vfsGrep(FILES, { pattern: "needle" });
		// Lowercased occurrences only: index.md ("AGAIN needle") and deep.md
		// ("deep needle content"). notes.md only has capitalized "Needle".
		expect(sensitive.output.split("\n").sort()).toEqual(["spec://index.md", "spec://sub/deep.md"]);
	});

	test("multiline treats each file as one unit and matches across newlines", () => {
		const r = vfsGrep(FILES, {
			pattern: "Work Spec[\\s\\S]*Needle",
			outputMode: "content",
			multiline: true,
		});
		expect(r.metadata.matches).toBe(1);
		expect(r.output).toBe("spec://index.md:1:# Work Spec");
	});

	test("invalid regex returns an error result, not a throw", () => {
		const r = vfsGrep(FILES, { pattern: "(" });
		expect(r.isError).toBe(true);
		expect(r.output).toContain("Invalid regex");
	});
});

describe("vfsGrep — filtering", () => {
	test("pathPrefix restricts to a subtree (exact or nested)", () => {
		const r = vfsGrep(FILES, { pattern: "needle", caseInsensitive: true, pathPrefix: "sub" });
		expect(r.output).toBe("spec://sub/deep.md");
	});

	test("pathPrefix matching a single file", () => {
		const r = vfsGrep(FILES, {
			pattern: "needle",
			caseInsensitive: true,
			pathPrefix: "index.md",
		});
		expect(r.output).toBe("spec://index.md");
	});

	test("glob filters candidate files", () => {
		const r = vfsGrep(FILES, {
			pattern: "needle",
			caseInsensitive: true,
			glob: "*.md", // excludes sub/deep.md (slash) and tasks.json
		});
		expect(r.output.split("\n").sort()).toEqual(["spec://index.md", "spec://notes.md"]);
	});
});

describe("vfsGrep — pagination", () => {
	const many: VfsGrepFile[] = Array.from({ length: 5 }, (_, i) => file(`f${i}.md`, "hit\n"));

	test("headLimit truncates and reports remaining", () => {
		const r = vfsGrep(many, { pattern: "hit", headLimit: 2 });
		expect(r.output.split("\n").filter((l) => l.startsWith("spec://"))).toHaveLength(2);
		expect(r.metadata.truncated).toBe(true);
		expect(r.output).toContain("3 more available");
	});

	test("offset skips leading results", () => {
		const r = vfsGrep(many, { pattern: "hit", offset: 4 });
		expect(r.output).toBe("spec://f4.md");
		expect(r.metadata.truncated).toBe(false);
	});

	test("offset + headLimit combine", () => {
		const r = vfsGrep(many, { pattern: "hit", offset: 1, headLimit: 2 });
		const hits = r.output.split("\n").filter((l) => l.startsWith("spec://"));
		expect(hits).toEqual(["spec://f1.md", "spec://f2.md"]);
		expect(r.metadata.truncated).toBe(true);
	});
});

describe("vfsGrep — no matches", () => {
	test("returns the standard no-match result", () => {
		const r = vfsGrep(FILES, { pattern: "zzzznotpresent" });
		expect(r.output).toBe("No matches found");
		expect(r.metadata).toEqual({ matches: 0, truncated: false });
	});
});
