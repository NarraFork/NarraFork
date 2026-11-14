import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend } from "../local-backend";
import { backendDirname, resolveBackendPath } from "../path-resolve";
import { posixPathSemantics, specPathSemantics, windowsPathSemantics } from "../path-semantics";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("target path semantics", () => {
	test("keeps POSIX backslashes literal", () => {
		expect(posixPathSemantics.resolve("/work/project", "a\\b")).toBe("/work/project/a\\b");
		expect(posixPathSemantics.equals("/work/a\\b", "/work/a/b")).toBe(false);
		expect(posixPathSemantics.dirname("/work/project/file.ts")).toBe("/work/project");
		expect(posixPathSemantics.contains("/work", "/work/project/file.ts")).toBe(true);
		expect(posixPathSemantics.contains("/work", "/workspace/file.ts")).toBe(false);
		expect(posixPathSemantics.basename("/work/project/file.ts")).toBe("file.ts");
		expect(posixPathSemantics.extname("/work/project/file.ts")).toBe(".ts");
	});

	test("uses Windows drive, separator, and case rules on any host", () => {
		expect(windowsPathSemantics.resolve("C:\\Work\\Project", "..\\Plan.md")).toBe(
			"C:\\Work\\Plan.md",
		);
		expect(windowsPathSemantics.equals("C:\\Work\\Plan.md", "c:/work/plan.md")).toBe(true);
		expect(windowsPathSemantics.dirname("C:\\Work\\Plan.md")).toBe("C:\\Work");
		expect(windowsPathSemantics.contains("C:\\Work", "c:/work/src/file.ts")).toBe(true);
		expect(windowsPathSemantics.contains("C:\\Work", "C:\\Workspace\\file.ts")).toBe(false);
		expect(windowsPathSemantics.identityKey("C:\\Work\\Plan.md")).toBe(
			windowsPathSemantics.identityKey("c:/work/plan.md"),
		);
	});

	test("POSIX contains() distinguishes dot-prefixed names from parent components", () => {
		expect(posixPathSemantics.contains("/work", "/work")).toBe(true);
		expect(posixPathSemantics.contains("/work", "/work/..cache/file.ts")).toBe(true);
		expect(posixPathSemantics.contains("/work", "/work/.../file.ts")).toBe(true);
		expect(posixPathSemantics.contains("/work", "/work/..\\outside")).toBe(true);
		expect(posixPathSemantics.contains("/work", "/work/..")).toBe(false);
		expect(posixPathSemantics.contains("/work", "/work/../outside/file.ts")).toBe(false);
		expect(posixPathSemantics.contains("/work", "/work/..cache/../../outside")).toBe(false);
	});

	test("Windows contains() checks parent components, drives, and UNC shares", () => {
		expect(windowsPathSemantics.contains("C:\\Work", "c:/work/..cache/file.ts")).toBe(true);
		expect(windowsPathSemantics.contains("C:\\Work", "C:\\Work\\...\\file.ts")).toBe(true);
		expect(windowsPathSemantics.contains("C:\\Work", "C:\\Work\\..")).toBe(false);
		expect(windowsPathSemantics.contains("C:\\Work", "C:\\Work\\..\\outside")).toBe(false);
		expect(windowsPathSemantics.contains("C:\\Work", "D:\\Work\\file.ts")).toBe(false);
		expect(
			windowsPathSemantics.contains(
				"\\\\Server\\Share\\Work",
				"//server/share/work/..cache/file.ts",
			),
		).toBe(true);
		expect(windowsPathSemantics.contains("\\\\Server\\Share", "\\\\Server\\Other\\file.ts")).toBe(
			false,
		);
		expect(windowsPathSemantics.contains("\\\\Server\\Share", "\\\\Other\\Share\\file.ts")).toBe(
			false,
		);
	});

	test("Windows contains() is case-insensitive", () => {
		// Parent and child differ only in case — must return true
		expect(windowsPathSemantics.contains("C:\\Data", "c:\\data\\file.ts")).toBe(true);
		expect(windowsPathSemantics.contains("c:\\users\\admin", "C:\\Users\\Admin\\doc.md")).toBe(
			true,
		);
		// Mixed separators with case differences
		expect(windowsPathSemantics.contains("D:/Projects", "d:\\projects\\src\\main.ts")).toBe(true);
		// Not contained despite shared prefix
		expect(windowsPathSemantics.contains("C:\\Data", "C:\\DataStore\\file.ts")).toBe(false);
		// POSIX must remain case-sensitive
		expect(posixPathSemantics.contains("/Data", "/data/file.ts")).toBe(false);
	});

	test("normalizes Dynamic Spec URIs without host filesystem semantics", () => {
		expect(specPathSemantics.resolve("spec://plans", "../tasks.json")).toBe("spec://tasks.json");
		expect(specPathSemantics.resolve("spec://", "notes/draft.md")).toBe("spec://notes/draft.md");
		expect(specPathSemantics.dirname("spec://notes/draft.md")).toBe("spec://notes");
		expect(specPathSemantics.dirname("spec://tasks.json")).toBe("spec://");
		expect(specPathSemantics.contains("spec://notes", "spec://notes/draft.md")).toBe(true);
		expect(specPathSemantics.contains("spec://notes", "spec://notebook/draft.md")).toBe(false);
		expect(specPathSemantics.contains("spec://notes", "spec://notes/..cache/draft.md")).toBe(true);
		expect(specPathSemantics.contains("spec://notes", "spec://notes/../draft.md")).toBe(false);
		expect(specPathSemantics.contains("spec://notes", "spec://notes/..")).toBe(false);
		expect(specPathSemantics.relative("spec://notes", "spec://notes/draft.md")).toBe("draft.md");
	});

	test("compatibility helpers delegate to backend.paths", () => {
		const backend = {
			paths: windowsPathSemantics,
		} as unknown as import("../backend").ExecutionBackend;
		expect(resolveBackendPath(backend, "C:\\Work", "src\\index.ts")).toBe(
			"C:\\Work\\src\\index.ts",
		);
		expect(backendDirname(backend, "C:\\Work\\src\\index.ts")).toBe("C:\\Work\\src");
	});
});

describe("LocalBackend path identity", () => {
	test("resolves existing and missing create paths through canonical ancestors", async () => {
		const created = mkdtempSync(join(tmpdir(), "narrafork-path-identity-"));
		roots.push(created);
		// Compare canonical identities, not macOS /var or Windows 8.3 temp aliases.
		// Match the backend's async realpath API; realpathSync can retain those aliases.
		const base = await realpath(created);
		const realRoot = join(base, "real");
		const linkedRoot = join(base, "linked");
		mkdirSync(realRoot);
		symlinkSync(realRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");

		const backend = new LocalBackend();
		const existing = await backend.resolvePathIdentity(linkedRoot);
		expect(existing.exists).toBe(true);
		expect(backend.paths.equals(existing.canonicalPath, realRoot)).toBe(true);
		expect(existing.runtimeGeneration).toBe(backend.runtimeGeneration);

		const requested = join(linkedRoot, "new", "plan.md");
		const missing = await backend.resolvePathIdentity(requested);
		expect(missing.exists).toBe(false);
		expect(backend.paths.equals(missing.lexicalPath, requested)).toBe(true);
		expect(backend.paths.equals(missing.canonicalPath, join(realRoot, "new", "plan.md"))).toBe(
			true,
		);
	});
});
