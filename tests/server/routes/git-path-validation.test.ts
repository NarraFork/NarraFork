/**
 * git-path-validation.test.ts — the guard on every mutating git route's file list.
 *
 * `stage`, `unstage` and `discard` take repo-relative paths straight from the request and
 * hand them to git. The check that stands between the two is the only thing stopping a
 * caller from naming a file outside the worktree, so it is tested directly rather than
 * through a route's happy path.
 *
 * Two failure directions matter equally, and the original substring test got the second
 * one wrong:
 *   - too permissive: a path that escapes must be refused;
 *   - too strict: an ordinary filename that merely LOOKS like a traversal must not be,
 *     because refusing it makes a real file impossible to stage or discard.
 */
import { describe, expect, test } from "bun:test";
import { gitRef, gitResetSchema } from "@server/lib/validators/git";
import { validateFilePaths } from "@server/routes/git";

/** Whether the guard accepted the whole list. */
function accepts(...files: string[]): boolean {
	try {
		validateFilePaths(files);
		return true;
	} catch {
		return false;
	}
}

describe("validateFilePaths — escapes are refused", () => {
	test("refuses a parent-directory segment anywhere in the path", () => {
		expect(accepts("../outside.ts")).toBe(false);
		expect(accepts("src/../../outside.ts")).toBe(false);
		expect(accepts("src/sub/..")).toBe(false);
		expect(accepts("..")).toBe(false);
	});

	test("refuses a parent-directory segment written with a backslash separator", () => {
		// A Windows client may send `\`. git accepts `/` everywhere, so both separators are
		// treated as separators regardless of the server's platform.
		expect(accepts("..\\outside.ts")).toBe(false);
		expect(accepts("src\\..\\..\\outside.ts")).toBe(false);
	});

	test("refuses absolute and UNC paths, which escape without any traversal", () => {
		expect(accepts("/etc/passwd")).toBe(false);
		expect(accepts("\\\\server\\share\\file.ts")).toBe(false);
		expect(accepts("\\absolute.ts")).toBe(false);
	});

	test("refuses an embedded NUL", () => {
		// NUL terminates a C string, so what git or the filesystem acts on could be a prefix
		// of what was validated — a different path than the one that passed the check.
		expect(accepts("src/app.ts\0../../etc/passwd")).toBe(false);
	});

	test("refuses the whole list when any single entry is bad", () => {
		// The routes pass the list to git as one invocation, so one bad entry taints it.
		expect(accepts("src/ok.ts", "../escape.ts")).toBe(false);
	});
});

describe("validateFilePaths — ordinary paths are accepted", () => {
	test("accepts a filename containing two consecutive dots", () => {
		// The regression the substring check caused: `..` inside a segment does not name a
		// parent directory, and these are legal filenames that a user could not stage.
		expect(accepts("some..file.ts")).toBe(true);
		expect(accepts("v1..v2/notes.md")).toBe(true);
		expect(accepts("dir..name/file.ts")).toBe(true);
		expect(accepts("archive..tar.gz")).toBe(true);
	});

	test("accepts a single leading dot, which is a dotfile and not a traversal", () => {
		expect(accepts(".gitignore")).toBe(true);
		expect(accepts(".github/workflows/ci.yml")).toBe(true);
	});

	test("accepts nested, spaced and non-ASCII paths", () => {
		expect(accepts("server/services/git-service.ts")).toBe(true);
		expect(accepts("docs/design notes.md")).toBe(true);
		expect(accepts("文档/说明.md")).toBe(true);
		expect(accepts("assets/emoji-🎉.png")).toBe(true);
	});

	test("accepts an empty list", () => {
		// Callers reach the guard with whatever the request held; nothing to check is fine.
		expect(accepts()).toBe(true);
	});
});

// ── gitRef / gitResetSchema — flag injection & illegal character defense ───────

describe("gitRef — flag injection and illegal characters are refused", () => {
	function refOk(value: string): boolean {
		return gitRef.safeParse(value).success;
	}

	test("refuses values starting with '-' (flag injection: --hard, -f, etc.)", () => {
		expect(refOk("--hard")).toBe(false);
		expect(refOk("-f")).toBe(false);
		expect(refOk("--soft")).toBe(false);
		expect(refOk("-")).toBe(false);
	});

	test("refuses values containing spaces", () => {
		expect(refOk("main branch")).toBe(false);
		expect(refOk("HEAD ~1")).toBe(false);
	});

	test("refuses values containing newlines or control characters", () => {
		expect(refOk("main\ninjection")).toBe(false);
		expect(refOk("main\x00tail")).toBe(false);
		expect(refOk("main\ttab")).toBe(false);
	});

	test("refuses '..' (path traversal in refspecs)", () => {
		expect(refOk("main..HEAD")).toBe(false);
		expect(refOk("a..b")).toBe(false);
	});

	test("accepts normal SHA hashes", () => {
		expect(refOk("abc123def456")).toBe(true);
		expect(refOk("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2")).toBe(true);
	});

	test("accepts branch names with slashes (feature/x, origin/main)", () => {
		expect(refOk("feature/new-thing")).toBe(true);
		expect(refOk("origin/main")).toBe(true);
		expect(refOk("refs/heads/main")).toBe(true);
	});

	test("accepts tags (v1.0.0)", () => {
		expect(refOk("v1.0.0")).toBe(true);
		expect(refOk("release_2.3")).toBe(true);
	});

	test("accepts relative refs (HEAD~1, main^2, @{1})", () => {
		expect(refOk("HEAD~1")).toBe(true);
		expect(refOk("main^2")).toBe(true);
		expect(refOk("HEAD@{1}")).toBe(true);
	});

	test("accepts single-dot paths (used in some ref syntax)", () => {
		expect(refOk("v1.2.3")).toBe(true);
	});
});

describe("gitResetSchema — integration with gitRef", () => {
	test("rejects a reset target that is a flag", () => {
		const result = gitResetSchema.safeParse({ target: "--hard", mode: "soft" });
		expect(result.success).toBe(false);
	});

	test("accepts a valid reset target", () => {
		const result = gitResetSchema.safeParse({ target: "HEAD~1", mode: "soft" });
		expect(result.success).toBe(true);
	});
});
