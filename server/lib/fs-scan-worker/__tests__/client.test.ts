import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectoryMeasureAbortedError, measureDirectoriesOffThread } from "../client";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "narrafork-fs-worker-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("real filesystem scan worker", () => {
	test("measures nested roots independently and forwards progress", async () => {
		mkdirSync(join(root, "nested"));
		writeFileSync(join(root, "a"), "12345");
		writeFileSync(join(root, "nested", "b"), "678");
		const progress: Array<{ entriesScanned: number; sizeBytes: number }> = [];
		expect(
			await measureDirectoriesOffThread([root, join(root, "nested")], {
				onProgress: (entry) => progress.push(entry),
			}),
		).toEqual([
			{ sizeBytes: 8, entriesScanned: 3, truncated: false },
			{ sizeBytes: 3, entriesScanned: 1, truncated: false },
		]);
		expect(progress.at(-1)).toEqual({ entriesScanned: 4, sizeBytes: 11 });
	});

	test("a missing directory is a measured zero, not a worker failure", async () => {
		expect(await measureDirectoriesOffThread([join(root, "missing")])).toEqual([
			{ sizeBytes: 0, entriesScanned: 0, truncated: false },
		]);
	});

	test("shares the entry budget between roots and reports truncation", async () => {
		writeFileSync(join(root, "a"), "12");
		writeFileSync(join(root, "b"), "34");
		expect(await measureDirectoriesOffThread([root, root], { maxEntries: 1 })).toEqual([
			{ sizeBytes: 2, entriesScanned: 1, truncated: true },
			{ sizeBytes: 0, entriesScanned: 0, truncated: true },
		]);
	});

	test("does not follow symlinks or lose shallow siblings at the depth limit", async () => {
		mkdirSync(join(root, "nested"));
		writeFileSync(join(root, "nested", "a"), "123456");
		writeFileSync(join(root, "sibling"), "12");
		symlinkSync(root, join(root, "loop"), "dir");
		expect(await measureDirectoriesOffThread([root], { maxDepth: 0 })).toEqual([
			{ sizeBytes: 2, entriesScanned: 3, truncated: true },
		]);
	});

	test("aborting during progress terminates measurement and permits a later healthy scan", async () => {
		for (let index = 0; index < 220; index++) writeFileSync(join(root, `entry-${index}`), "a");
		const controller = new AbortController();
		await expect(
			measureDirectoriesOffThread([root], {
				signal: controller.signal,
				onProgress: () => controller.abort(),
			}),
		).rejects.toBeInstanceOf(DirectoryMeasureAbortedError);
		const [result] = await measureDirectoriesOffThread([root]);
		expect(result?.sizeBytes).toBe(220);
	});

	test("empty input needs no worker, but still honors cancellation", async () => {
		expect(await measureDirectoriesOffThread([])).toEqual([]);
		const controller = new AbortController();
		controller.abort();
		await expect(
			measureDirectoriesOffThread([], { signal: controller.signal }),
		).rejects.toBeInstanceOf(DirectoryMeasureAbortedError);
	});
});
