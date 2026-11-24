import { afterEach, expect, mock, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diskSpaceMonitor } from "../lib/disk-safety";
import { DEFAULT_DISK_SAFETY } from "../lib/disk-safety-config";
import { getNarraforkPath } from "../lib/narrafork-home";
import { settings } from "../lib/settings";
import { safeSpawn } from "../lib/spawn";
import { resetHotPathCaptureStateForTests, worktreeTreeSnapshot } from "./worktree-tree-snapshot";

const originalSettings = settings.diskSafety;
const originalAssess = diskSpaceMonitor.assess;
afterEach(() => {
	settings.diskSafety = originalSettings;
	diskSpaceMonitor.assess = originalAssess;
	resetHotPathCaptureStateForTests();
});
function lowSpace() {
	settings.diskSafety = { ...DEFAULT_DISK_SAFETY };
	diskSpaceMonitor.assess = mock(async (path) => ({
		path,
		level: "warning" as const,
		space: {
			key: "home",
			mountPath: "/home",
			freeBytes: 500 * 1024 * 1024,
			totalBytes: 10000 * 1024 * 1024,
			checkedAt: Date.now(),
		},
	}));
}
async function entries(path: string): Promise<string[]> {
	try {
		return await readdir(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

test("local snapshots stay disabled before and after disk space recovers", async () => {
	const worktree = await mkdtemp(join(tmpdir(), "nf-disk-snapshot-"));
	try {
		const init = await safeSpawn({
			cmd: ["git", "init", worktree],
			timeout: 5000,
			maxOutputBytes: 64 * 1024,
		});
		expect(init.exitCode).toBe(0);
		await writeFile(join(worktree, "file"), "unchanged");
		lowSpace();
		const shadowRoot = getNarraforkPath("tree-snapshots");
		const before = await entries(shadowRoot);
		expect(await worktreeTreeSnapshot.tryCaptureHot(worktree)).toBeNull();
		expect(await entries(shadowRoot)).toEqual(before);
		expect(await readFile(join(worktree, "file"), "utf8")).toBe("unchanged");
		diskSpaceMonitor.assess = originalAssess;
		const recovered = await worktreeTreeSnapshot.tryCaptureHot(worktree);
		expect(recovered).toBeNull();
		expect(await entries(shadowRoot)).toEqual(before);
	} finally {
		await rm(worktree, { recursive: true, force: true });
	}
});
