import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectoryMeasureAbortedError, measureDirectoryTrees } from "../measure-tree";

let root: string | undefined;

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

test("the pure worker core does not swallow cancellation thrown inside its last nested branch", async () => {
	root = mkdtempSync(join(tmpdir(), "narrafork-measure-core-"));
	const nested = join(root, "nested");
	mkdirSync(nested);
	for (let index = 0; index < 201; index++) writeFileSync(join(nested, `entry-${index}`), "a");
	const controller = new AbortController();
	// Direct core execution is explicit test coverage, never a client failure path.
	await expect(
		measureDirectoryTrees([root], {
			signal: controller.signal,
			onProgress: () => controller.abort(),
		}),
	).rejects.toBeInstanceOf(DirectoryMeasureAbortedError);
});
