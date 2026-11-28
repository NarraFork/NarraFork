/**
 * file-menu-target.test.ts — the two path derivations the file menu performs.
 *
 * These are pure arithmetic, and both feed requests that write to disk: paste lands in
 * `fileMenuDirectory(absolutePath)` and a rename triggers a re-read of
 * `fileMenuRelativeDirectory(relativePath)`. Getting either off by one segment would paste
 * into a sibling directory or leave the stale row on screen, and neither failure throws.
 *
 * The Windows root is the case worth pinning explicitly: the tree joins the narrator's cwd
 * (`E:\repo`) with `/` and the entry's relative path, so the composed absolute path mixes
 * separators and must not be normalized into something the server would resolve elsewhere.
 */

import { describe, expect, test } from "bun:test";
import { fileMenuDirectory, fileMenuRelativeDirectory } from "./file-menu-target";

describe("fileMenuDirectory", () => {
	test("strips one segment from a POSIX path", () => {
		expect(fileMenuDirectory("/repo/src/a.ts")).toBe("/repo/src");
	});

	test("keeps a Windows root whole", () => {
		expect(fileMenuDirectory("E:\\repo/src/a.ts")).toBe("E:\\repo/src");
		expect(fileMenuDirectory("E:\\repo/a.ts")).toBe("E:\\repo");
	});

	test("returns a path with no separator unchanged", () => {
		// No directory to name: the caller's request should fail loudly rather than paste
		// into a made-up parent.
		expect(fileMenuDirectory("a.ts")).toBe("a.ts");
		expect(fileMenuDirectory("")).toBe("");
	});
});

describe("fileMenuRelativeDirectory", () => {
	test("gives the tree-relative parent, which is the key the store reloads", () => {
		expect(fileMenuRelativeDirectory("src/deep/a.ts")).toBe("src/deep");
		expect(fileMenuRelativeDirectory("a.ts")).toBe("");
	});
});
