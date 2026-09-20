import { describe, expect, test } from "bun:test";
import { assertSpecPath, normalizeSpecPath, toolSpecPathError } from "../spec-uri";

export const malformedSpecPaths = [
	"/spec://tasks.json",
	"spec:/tasks.json",
	"\\spec://tasks.json",
	"spec:\\tasks.json",
	"spec:\\\\tasks.json",
	"spec:/\\tasks.json",
	" spec://tasks.json",
	"spec://tasks.json ",
	"spec ://tasks.json",
	"spec: //tasks.json",
	"spec:\n//tasks.json",
	"./spec://tasks.json",
	"../spec://tasks.json",
	"foo/spec://tasks.json",
	"C:/spec://tasks.json",
	"C:\\spec://tasks.json",
	"C:spec://tasks.json",
	"SPEC://tasks.json",
	'"spec://tasks.json"',
	"'spec://tasks.json'",
	"[spec://tasks.json]",
	"`spec://tasks.json`",
	"spec://notes\\tasks.json",
	"spec://notes/%5Ctasks.json",
	"spec://notes/../tasks.json",
	"spec://./tasks.json",
	"spec://notes/%2e%2e/tasks.json",
	"spec://notes//tasks.json",
	"spec://notes/",
	"spec://%00tasks.json",
];

describe("pure Spec URI boundary", () => {
	test.each(malformedSpecPaths)("rejects raw spelling %j without normalizing it", (path) => {
		expect(() => assertSpecPath(path, { supported: true })).toThrow(/spec:\/\//);
		expect(() => normalizeSpecPath(path)).toThrow(/spec:\/\//);
	});

	test.each([
		"spec:notes.txt",
		"notes:2026.txt",
		"/work/spec:notes",
		"./aspect:/notes",
		"specification:/notes",
		"C:\\work\\notes.txt",
	])("does not reserve ordinary filesystem spelling %j", (path) =>
		expect(() => assertSpecPath(path)).not.toThrow());

	test("keeps valid URI and namespace-relative normalization", () => {
		for (const path of ["tasks.json", "behavior_fence", "notes/draft.md", "notes_v2/a-1.json"]) {
			expect(normalizeSpecPath(`spec://${path}`)).toBe(path);
			expect(normalizeSpecPath(path)).toBe(path);
			for (const name of ["Read", "Write", "Edit"]) {
				expect(toolSpecPathError(name, { file_path: `spec://${path}` })).toBeUndefined();
			}
		}
		expect(normalizeSpecPath("spec://%74asks.json")).toBe("tasks.json");
		expect(toolSpecPathError("Grep", { path: "spec://" })).toBeUndefined();
		expect(toolSpecPathError("Read", { file_path: "spec://" })).toContain("empty");
	});

	test("unsupported tools reject Spec, and content fields are not paths", () => {
		for (const name of ["StructView", "StructSed"]) {
			expect(toolSpecPathError(name, { file_path: "spec://tasks.json" })).toContain("not support");
		}
		expect(toolSpecPathError("Glob", { path: "spec://", pattern: "*" })).toContain("not support");
		expect(toolSpecPathError("Glob", { pattern: "/spec://*" })).toContain("Invalid");
		expect(toolSpecPathError("Grep", { pattern: "/spec://" })).toBeUndefined();
		expect(
			toolSpecPathError("Write", { file_path: "/file.txt", content: "/spec://" }),
		).toBeUndefined();
	});
});
