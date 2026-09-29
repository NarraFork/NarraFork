import { describe, expect, test } from "bun:test";
import { defaultParseSearch } from "@tanstack/react-router";
import {
	buildCommitPreviewHref,
	COMMIT_PREVIEW_FILE_MAX_LENGTH,
	validateCommitPreviewSearch,
} from "./git-commit-preview-navigation";

const SHA = "a".repeat(40);
const TARGET = {
	narratorId: "narrator /#+",
	workspaceKey: "device:/repo 中文 +#?%",
	canWrite: false,
	rootPath: "/not-from-the-url",
};

describe("commit preview navigation", () => {
	test("chapter links retain the legacy target and do not leak host paths or capabilities", () => {
		const href = buildCommitPreviewHref("chapter /#", SHA);
		expect(href).toBe(`/git/chapters/chapter%20%2F%23/commits/${SHA}`);
	});

	test("narrator links pin the resolved workspace and round-trip exact file names", () => {
		const file = "目录/new +#?% name.ts";
		const href = buildCommitPreviewHref(TARGET, SHA, file);
		const url = new URL(href, "https://example.test");
		expect(url.pathname).toBe(`/git/narrators/narrator%20%2F%23%2B/commits/${SHA}`);
		expect(url.searchParams.get("file")).toBe(file);
		expect(url.searchParams.get("workspaceKey")).toBe(TARGET.workspaceKey);
		expect([...url.searchParams.keys()]).toEqual(["file", "workspaceKey"]);
		expect(href).not.toContain(TARGET.rootPath);
	});

	test("parent links omit the previous selection and support SHA-256", () => {
		const sha = "B".repeat(64);
		for (const file of [undefined, null]) {
			const url = new URL(buildCommitPreviewHref(TARGET, sha, file), "https://example.test");
			expect(url.pathname.endsWith(sha.toLowerCase())).toBe(true);
			expect(url.searchParams.has("file")).toBe(false);
			expect(url.searchParams.get("workspaceKey")).toBe(TARGET.workspaceKey);
		}
	});

	test.each([
		"HEAD",
		"--help",
		"a".repeat(39),
		"a".repeat(41),
		"g".repeat(40),
		"a".repeat(65),
	])("rejects non-full commit names: %s", (sha) =>
		expect(() => buildCommitPreviewHref("chapter", sha)).toThrow("full commit SHA"));

	test("search parsing is bounded and never accepts URL-supplied authority", () => {
		expect(
			validateCommitPreviewSearch({
				file: "a.ts",
				workspaceKey: "key",
				rootPath: "/secret",
				canWrite: true,
			}),
		).toEqual({ file: "a.ts", workspaceKey: "key" });
		expect(validateCommitPreviewSearch({})).toEqual({ file: undefined, workspaceKey: undefined });
		expect(
			validateCommitPreviewSearch({ file: "a".repeat(COMMIT_PREVIEW_FILE_MAX_LENGTH) }).invalid,
		).toBeUndefined();
	});

	test("generated URLs preserve JSON-looking strings through the default Router parser", () => {
		for (const file of ["123", "null", "true", "[ 1, 2 ]", '"quoted"']) {
			const href = buildCommitPreviewHref(TARGET, SHA, file);
			expect(
				validateCommitPreviewSearch(defaultParseSearch(href.slice(href.indexOf("?")))),
			).toEqual({
				file,
				workspaceKey: TARGET.workspaceKey,
			});
		}
		expect(validateCommitPreviewSearch(defaultParseSearch("?file=a&file=b"))).toEqual({
			invalid: true,
		});
		expect(
			validateCommitPreviewSearch(defaultParseSearch("?workspaceKey=a&workspaceKey=b")),
		).toEqual({ invalid: true });
		expect(validateCommitPreviewSearch({ invalid: true })).toEqual({ invalid: true });
	});

	test("rejects malformed or excessive file/workspace parameters", () => {
		for (const value of [
			null,
			4,
			true,
			[],
			{},
			"",
			"a".repeat(COMMIT_PREVIEW_FILE_MAX_LENGTH + 1),
		]) {
			expect(validateCommitPreviewSearch({ file: value })).toEqual({ invalid: true });
			expect(validateCommitPreviewSearch({ workspaceKey: value })).toEqual({ invalid: true });
		}
	});
});
