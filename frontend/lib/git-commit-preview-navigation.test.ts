import { afterEach, describe, expect, test } from "bun:test";
import { defaultParseSearch } from "@tanstack/react-router";
import { resetAppBaseForTest } from "./base-path";
import {
	buildCommitPreviewBrowserHref,
	buildCommitPreviewHref,
	COMMIT_PREVIEW_FILE_MAX_LENGTH,
	validateCommitPreviewSearch,
} from "./git-commit-preview-navigation";

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
afterEach(() => {
	for (const [key, descriptor] of [
		["document", originalDocument],
		["location", originalLocation],
	] as const) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	resetAppBaseForTest();
});

const SHA = "a".repeat(40);
const TARGET = {
	narratorId: "narrator /#+",
	workspaceKey: "device:/repo 中文 +#?%",
	canWrite: false,
	rootPath: "/not-from-the-url",
};

describe("commit preview navigation", () => {
	test.each([
		"/",
		"/nf/",
		"/proxy/7778/",
	])("browser links add mount %s once without changing Router addresses or search", (base) => {
		Object.defineProperty(globalThis, "document", {
			configurable: true,
			value: { baseURI: `https://example.test${base}` },
		});
		Object.defineProperty(globalThis, "location", {
			configurable: true,
			value: { href: `https://example.test${base}git/chapters/chapter/commits/${SHA}` },
		});
		resetAppBaseForTest();
		for (const target of ["chapter /#", TARGET]) {
			for (const file of [undefined, "目录/new +#?% name.ts", "123", "[ 1, 2 ]"]) {
				const internal = buildCommitPreviewHref(target, SHA, file);
				const browser = buildCommitPreviewBrowserHref(target, SHA, file);
				expect(internal.startsWith("/git/")).toBe(true);
				expect(browser).toBe(`${base}windows${internal}`);
				expect(buildCommitPreviewBrowserHref(target, SHA, file, "page")).toBe(
					`${base}${internal.slice(1)}`,
				);
				expect(buildCommitPreviewBrowserHref(target, SHA, file, "window")).toBe(browser);
				const url = new URL(browser, "https://example.test");
				expect(validateCommitPreviewSearch(defaultParseSearch(url.search))).toEqual({
					file,
					workspaceKey: typeof target === "string" ? undefined : target.workspaceKey,
				});
			}
		}
	});
	test("explicit window URLs retain their owner, exact search and parent workspace pin", () => {
		for (const target of ["chapter /#", TARGET]) {
			for (const file of [undefined, "123", "目录/new +#?% name.ts"]) {
				const legacy = buildCommitPreviewHref(target, SHA, file, "page");
				const windowHref = buildCommitPreviewHref(target, SHA, file, "window");
				expect(windowHref).toBe(`/windows${legacy}`);
				expect(windowHref).not.toContain(TARGET.rootPath);
				expect(
					validateCommitPreviewSearch(
						defaultParseSearch(new URL(windowHref, "https://example.test").search),
					),
				).toEqual({
					file,
					workspaceKey: typeof target === "string" ? undefined : target.workspaceKey,
				});
			}
		}
	});

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
