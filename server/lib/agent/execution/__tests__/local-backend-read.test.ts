import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	truncateSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathsEqualForOS } from "../../../platform-path";
import { LocalBackend } from "../local-backend";

const roots: string[] = [];

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "narrafork-local-read-"));
	roots.push(root);
	return root;
}

function createSymlink(target: string, link: string, type?: "dir" | "file"): boolean {
	try {
		symlinkSync(target, link, process.platform === "win32" ? type : undefined);
		return true;
	} catch (error) {
		if (process.platform === "win32") return false;
		throw error;
	}
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("LocalBackend atomic bounded reads", () => {
	test("keeps POSIX backslashes as filename characters in canonical identity", async () => {
		if (process.platform === "win32") return;
		const root = tempRoot();
		const literalBackslashPath = join(root, "a\\b");
		const slashPath = join(root, "a", "b");
		writeFileSync(literalBackslashPath, "literal backslash");

		const backend = new LocalBackend();
		const fileStat = await backend.statFile(literalBackslashPath);
		expect(fileStat?.resolvedPath).toBe(literalBackslashPath);
		if (!fileStat?.resolvedPath) throw new Error("missing canonical path");
		const result = await backend.readFileBytes(literalBackslashPath, {
			maxBytes: 1024,
			expectedResolvedPath: fileStat.resolvedPath,
		});
		expect(new TextDecoder().decode(result.bytes)).toBe("literal backslash");
		await expect(
			backend.readFileBytes(literalBackslashPath, {
				maxBytes: 1024,
				expectedResolvedPath: slashPath,
			}),
		).rejects.toThrow(/resolved path identity mismatch/i);
	});

	test("uses backend OS separator and case semantics independently of the host OS", () => {
		expect(pathsEqualForOS("/tmp/a\\b", "/tmp/a/b", "linux")).toBe(false);
		expect(pathsEqualForOS("C:\\Work\\Plan.md", "c:/work/plan.md", "windows")).toBe(true);
		expect(pathsEqualForOS("C:\\Work\\Plan.md", "c:/work/plan.md", "linux")).toBe(false);
	});

	test("rejects a final symlink replaced after stat", async () => {
		const root = tempRoot();
		const first = join(root, "first.md");
		const second = join(root, "second.md");
		const link = join(root, "plan.md");
		writeFileSync(first, "# first plan");
		writeFileSync(second, "# second plan");
		if (!createSymlink(first, link, "file")) return;

		const backend = new LocalBackend();
		const fileStat = await backend.statFile(link);
		expect(fileStat?.isFile).toBe(true);
		expect(fileStat?.resolvedPath).toBe(first);
		if (!fileStat?.resolvedPath) throw new Error("missing canonical path");

		unlinkSync(link);
		if (!createSymlink(second, link, "file")) return;
		await expect(
			backend.readFileBytes(link, {
				maxBytes: 1024,
				expectedResolvedPath: fileStat?.resolvedPath,
			}),
		).rejects.toThrow(/resolved path identity mismatch/i);
	});

	test("rejects a parent symlink replaced after stat", async () => {
		const root = tempRoot();
		const firstDir = join(root, "first");
		const secondDir = join(root, "second");
		const currentDir = join(root, "current");
		mkdirSync(firstDir);
		mkdirSync(secondDir);
		writeFileSync(join(firstDir, "plan.md"), "# first plan");
		writeFileSync(join(secondDir, "plan.md"), "# second plan");
		if (!createSymlink(firstDir, currentDir, "dir")) return;
		const requestedPath = join(currentDir, "plan.md");

		const backend = new LocalBackend();
		const fileStat = await backend.statFile(requestedPath);
		expect(fileStat?.resolvedPath).toBe(join(firstDir, "plan.md"));
		if (!fileStat?.resolvedPath) throw new Error("missing canonical path");

		unlinkSync(currentDir);
		if (!createSymlink(secondDir, currentDir, "dir")) return;
		await expect(
			backend.readFileBytes(requestedPath, {
				maxBytes: 1024,
				expectedResolvedPath: fileStat?.resolvedPath,
			}),
		).rejects.toThrow(/resolved path identity mismatch/i);
	});

	test("reads only maxBytes plus one probe byte from a huge sparse file", async () => {
		const root = tempRoot();
		const filePath = join(root, "huge-plan.md");
		const totalSize = 256 * 1024 * 1024 + 17;
		const maxBytes = 64 * 1024;
		writeFileSync(filePath, "");
		truncateSync(filePath, totalSize);

		const backend = new LocalBackend();
		const fileStat = await backend.statFile(filePath);
		if (!fileStat?.resolvedPath) throw new Error("missing canonical path");
		const beforeArrayBuffers = process.memoryUsage().arrayBuffers;
		const result = await backend.readFileBytes(filePath, {
			maxBytes,
			expectedResolvedPath: fileStat.resolvedPath,
		});
		const retainedArrayBuffers = process.memoryUsage().arrayBuffers - beforeArrayBuffers;

		expect(result.bytes.byteLength).toBe(maxBytes);
		expect(result.truncated).toBe(true);
		expect(result.totalSize).toBe(totalSize);
		expect(result.resolvedPath).toBe(fileStat.resolvedPath);
		// The returned prefix keeps its backing buffer alive. A whole-file read would
		// retain roughly 256 MiB here; the bounded implementation stays near the cap.
		expect(retainedArrayBuffers).toBeLessThan(32 * 1024 * 1024);
	});
});
