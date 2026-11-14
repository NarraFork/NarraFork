import { describe, expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, parse, resolve, win32 } from "node:path";
import { normalizeRealpathResult } from "./platform-path";

describe("filesystem realpath root normalization", () => {
	test("restores Windows drive roots before any relative resolution", () => {
		for (const drive of ["C:", "d:", "Z:"]) {
			const root = normalizeRealpathResult(drive, "win32");
			expect(root).toBe(`${drive}\\`);
			expect(win32.isAbsolute(root)).toBe(true);
			expect(win32.resolve(root, "fixture", "missing")).toBe(`${drive}\\fixture\\missing`);
			expect(win32.relative(root, `${drive}\\fixture`)).toBe("fixture");
		}
	});

	test("does not reinterpret POSIX names or complete Windows paths", () => {
		for (const platform of ["linux", "darwin"] as const)
			for (const path of ["C:", "D:", "/tmp/C:", "/work/a\\b", "/"])
				expect(normalizeRealpathResult(path, platform)).toBe(path);
		for (const path of ["C:\\", "C:\\work\\file", "\\\\server\\share", "\\\\?\\C:\\"])
			expect(normalizeRealpathResult(path, "win32")).toBe(path);
	});

	test("native working and temporary volume roots remain absolute after realpath", async () => {
		for (const root of new Set([parse(process.cwd()).root, parse(tmpdir()).root])) {
			const actual = normalizeRealpathResult(await realpath(root));
			expect(isAbsolute(actual)).toBe(true);
			expect(resolve(actual).toLowerCase()).toBe(resolve(root).toLowerCase());
		}
	});
});
