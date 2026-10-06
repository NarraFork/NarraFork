/**
 * The storage scan walks user-controlled directories (uploads, shares, snapshot
 * repos, worktrees), so it must be bounded and must not follow symlinks.
 *
 * Two properties are pinned here:
 *  - a self-referential directory symlink cannot make the walk recurse forever;
 *  - hitting a scan limit is reported as `truncated`, never silently swallowed —
 *    an understated size would mislead an operator deciding whether to clean up.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setUploadsDirForTests } from "../../../server/lib/uploads";
import { scanUploads } from "../../../server/services/storage-service";

let testDir: string | null = null;

function makeUploadsDir(): string {
	testDir = mkdtempSync(resolve(tmpdir(), "narrafork-storage-dir-scan-"));
	setUploadsDirForTests(testDir);
	return testDir;
}

async function writeFileOfSize(filePath: string, size: number): Promise<void> {
	await Bun.write(filePath, new Uint8Array(size));
}

afterEach(() => {
	setUploadsDirForTests(null);
	if (testDir) rmSync(testDir, { recursive: true, force: true });
	testDir = null;
});

describe("bounded directory measurement", () => {
	test("a self-referential directory symlink does not recurse forever", async () => {
		const uploadsDir = makeUploadsDir();
		const narratorDir = resolve(uploadsDir, "narrator-a");
		mkdirSync(narratorDir, { recursive: true });
		await writeFileOfSize(resolve(narratorDir, "img.png"), 120);
		// A directory link pointing back at its own parent: readdir's Dirent reports
		// it as a directory, so a stat-based walk would descend into it endlessly.
		symlinkSync(narratorDir, resolve(narratorDir, "loop"), "dir");

		const result = await scanUploads();

		// Completing at all is the assertion (an unbounded walk would hang or blow
		// the stack); the link's target must be counted exactly once.
		expect(result.sizeBytes).toBe(120);
		expect(result.truncated).toBeUndefined();
	});

	test("mutually referential directory symlinks do not recurse forever", async () => {
		const uploadsDir = makeUploadsDir();
		const first = resolve(uploadsDir, "narrator-a");
		const second = resolve(uploadsDir, "narrator-b");
		mkdirSync(first, { recursive: true });
		mkdirSync(second, { recursive: true });
		await writeFileOfSize(resolve(first, "a.bin"), 10);
		await writeFileOfSize(resolve(second, "b.bin"), 20);
		symlinkSync(second, resolve(first, "to-b"), "dir");
		symlinkSync(first, resolve(second, "to-a"), "dir");

		const result = await scanUploads();

		expect(result.sizeBytes).toBe(30);
	});

	test("does not count a symlinked file, whose bytes belong to its target", async () => {
		const uploadsDir = makeUploadsDir();
		const narratorDir = resolve(uploadsDir, "narrator-a");
		mkdirSync(narratorDir, { recursive: true });
		await writeFileOfSize(resolve(narratorDir, "real.bin"), 64);
		symlinkSync(resolve(narratorDir, "real.bin"), resolve(narratorDir, "alias.bin"), "file");

		const result = await scanUploads();

		expect(result.sizeBytes).toBe(64);
	});

	test("reports truncated when the depth limit stops the walk", async () => {
		const uploadsDir = makeUploadsDir();
		// DIR_SCAN_MAX_DEPTH is 64; nest past it so the limit is provably reached.
		const segments = Array.from({ length: 70 }, (_, index) => `level-${index}`);
		const deepest = resolve(uploadsDir, "narrator-a", ...segments);
		mkdirSync(deepest, { recursive: true });
		await writeFileOfSize(resolve(deepest, "buried.bin"), 999);
		// A shallow file proves the walk still reports what it did measure.
		await writeFileOfSize(resolve(uploadsDir, "narrator-a", "shallow.bin"), 7);

		const result = await scanUploads();

		expect(result.truncated).toBe(true);
		// The buried file is beyond the depth cap, so the size is a lower bound
		// rather than silently-complete-looking.
		expect(result.sizeBytes).toBe(7);
	});
});
