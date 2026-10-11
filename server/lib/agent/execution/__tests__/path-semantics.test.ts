import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
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
	test("freezes Windows drive-relative paths without borrowing the controller cwd", () => {
		expect(() => windowsPathSemantics.resolve("D:\\work", "C:foo")).toThrow(
			"AMBIGUOUS_DRIVE_RELATIVE",
		);
		expect(windowsPathSemantics.resolve("D:\\work", "D:foo")).toBe("D:\\work\\foo");
		expect(windowsPathSemantics.resolve("D:\\work", "\\foo")).toBe("D:\\foo");
		expect(windowsPathSemantics.resolve("D:\\work", "Unicode 空格\\文件.txt")).toBe(
			"D:\\work\\Unicode 空格\\文件.txt",
		);
	});

	test("requires fully qualified Windows bases and rejects unsafe namespaces", () => {
		expect(windowsPathSemantics.isAbsolute("\\foo")).toBe(false);
		for (const path of [
			"C:\\file:stream",
			"C:\\NUL.txt",
			"\\\\.\\pipe\\x",
			"\\\\?\\GLOBALROOT\\Device\\x",
		]) {
			expect(() => windowsPathSemantics.resolve("D:\\work", path)).toThrow();
		}
		expect(() => windowsPathSemantics.resolve("D:work", "foo")).toThrow();
	});
	test("keeps POSIX backslashes literal", () => {
		expect(posixPathSemantics.resolve("/work/project", "a\\b")).toBe("/work/project/a\\b");
		expect(posixPathSemantics.equals("/work/a\\b", "/work/a/b")).toBe(false);
		expect(posixPathSemantics.dirname("/work/project/file.ts")).toBe("/work/project");
		expect(posixPathSemantics.contains("/work", "/work/project/file.ts")).toBe(true);
		expect(posixPathSemantics.contains("/work", "/workspace/file.ts")).toBe(false);
		expect(posixPathSemantics.basename("/work/project/file.ts")).toBe("file.ts");
		expect(posixPathSemantics.extname("/work/project/file.ts")).toBe(".ts");
	});

	test("uses Windows drive and separator grammar without inventing native case rules", () => {
		expect(windowsPathSemantics.resolve("C:\\Work\\Project", "..\\Plan.md")).toBe(
			"C:\\Work\\Plan.md",
		);
		expect(windowsPathSemantics.equals("C:\\Work\\Plan.md", "c:/work/plan.md")).toBe(false);
		expect(windowsPathSemantics.equals("C:\\Work\\Plan.md", "c:/Work/Plan.md")).toBe(true);
		expect(windowsPathSemantics.dirname("C:\\Work\\Plan.md")).toBe("C:\\Work");
		expect(windowsPathSemantics.contains("C:\\Work", "c:/work/src/file.ts")).toBe(false);
		expect(windowsPathSemantics.contains("C:\\Work", "C:\\Workspace\\file.ts")).toBe(false);
		expect(windowsPathSemantics.identityKey("C:\\Work\\Plan.md")).not.toBe(
			windowsPathSemantics.identityKey("c:/work/plan.md"),
		);
	});

	test("Windows lexical contains() does not grant unproven case aliases", () => {
		expect(windowsPathSemantics.contains("C:\\Data", "c:\\data\\file.ts")).toBe(false);
		expect(windowsPathSemantics.contains("c:\\users\\admin", "C:\\Users\\Admin\\doc.md")).toBe(
			false,
		);
		// Mixed separators with case differences
		expect(windowsPathSemantics.contains("D:/Projects", "d:\\projects\\src\\main.ts")).toBe(false);
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
		const base = mkdtempSync(join(tmpdir(), "narrafork-path-identity-"));
		roots.push(base);
		const realRoot = join(base, "real");
		const linkedRoot = join(base, "linked");
		mkdirSync(realRoot);
		try {
			symlinkSync(realRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
		} catch (error) {
			if (process.platform === "win32") return;
			throw error;
		}

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
