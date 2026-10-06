/**
 * The uploads category must report exactly what its cleanup button can reclaim.
 *
 * `cleanupOrphanedUploads` skips `uploads/avatars` because avatars belong to user
 * accounts, not narrator sessions. Counting avatars in `sizeBytes` would show a
 * figure that no cleanup can ever bring down, so these tests pin the split.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setUploadsDirForTests } from "../../lib/uploads";
import { scanUploads } from "../storage-service";

let testDir: string | null = null;

function makeUploadsDir(): string {
	testDir = mkdtempSync(resolve(tmpdir(), "narrafork-uploads-scan-"));
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

describe("scanUploads", () => {
	test("excludes avatars from the reported size and reports them separately", async () => {
		const uploadsDir = makeUploadsDir();
		mkdirSync(resolve(uploadsDir, "narrator-a"), { recursive: true });
		mkdirSync(resolve(uploadsDir, "narrator-b"), { recursive: true });
		mkdirSync(resolve(uploadsDir, "avatars", "user-1"), { recursive: true });
		await writeFileOfSize(resolve(uploadsDir, "narrator-a", "img.png"), 100);
		await writeFileOfSize(resolve(uploadsDir, "narrator-b", "img.png"), 200);
		await writeFileOfSize(resolve(uploadsDir, "avatars", "user-1", "avatar.png"), 500);

		const result = await scanUploads();

		expect(result.key).toBe("uploads");
		expect(result.sizeBytes).toBe(300);
		expect(result.details?.narratorDirs).toBe(2);
		expect(result.details?.avatarBytes).toBe(500);
	});

	test("counts stray files at the uploads root so the size never understates the directory", async () => {
		const uploadsDir = makeUploadsDir();
		mkdirSync(resolve(uploadsDir, "narrator-a"), { recursive: true });
		await writeFileOfSize(resolve(uploadsDir, "narrator-a", "img.png"), 40);
		await writeFileOfSize(resolve(uploadsDir, "orphan.png"), 60);

		const result = await scanUploads();

		expect(result.sizeBytes).toBe(100);
		expect(result.details?.narratorDirs).toBe(1);
	});

	test("reports zero avatar bytes when no avatars exist", async () => {
		const uploadsDir = makeUploadsDir();
		mkdirSync(resolve(uploadsDir, "narrator-a"), { recursive: true });
		await writeFileOfSize(resolve(uploadsDir, "narrator-a", "img.png"), 10);

		const result = await scanUploads();

		expect(result.sizeBytes).toBe(10);
		expect(result.details?.avatarBytes).toBe(0);
	});

	test("returns an empty result when the uploads directory does not exist", async () => {
		const uploadsDir = makeUploadsDir();
		rmSync(uploadsDir, { recursive: true, force: true });

		const result = await scanUploads();

		expect(result.sizeBytes).toBe(0);
		expect(result.details?.narratorDirs).toBe(0);
		expect(result.details?.avatarBytes).toBe(0);
	});
});
