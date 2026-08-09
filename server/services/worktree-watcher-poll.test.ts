/**
 * Polling-tick cost control in the worktree watcher.
 *
 * The native watcher is opt-in (`NARRAFORK_ENABLE_NATIVE_WATCHER`), so *polling is
 * the default path* for every attached narrator. Each tick used to run a whole-tree
 * `git add -A` capture plus a snapshot-DAG advance plus a `chapters` UPDATE that has
 * no index to use — unconditionally, every interval, per chapter, on a workspace
 * nobody had touched.
 *
 * These cases pin the two halves of the fix that matter: an idle polled tick does no
 * snapshot work, and a tick where anything actually changed still does. The capture is
 * observed by counting attempts rather than by inspecting the resulting DAG, because
 * `linkSnapshot` deduplicates an unchanged tree — so the DAG looks identical whether
 * the expensive work ran or was skipped, which is exactly the bug being fixed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { worktreeTreeSnapshots } from "../db/schema";
import { normalizePathForComparison } from "../lib/platform-path";
import { safeSpawn } from "../lib/spawn";
import { clearStatusCache } from "./git-status-cache";
import { worktreeTreeSnapshot } from "./worktree-tree-snapshot";
import { MAX_SKIPPED_POLLS, worktreeWatcher } from "./worktree-watcher";

const tempDirs: string[] = [];
const snapshotPaths: string[] = [];

async function createRepo(prefix: string): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	snapshotPaths.push(normalizePathForComparison(dir));
	await safeSpawn({ cmd: ["git", "init"], cwd: dir, timeout: 15_000 });
	await safeSpawn({ cmd: ["git", "config", "user.email", "test@example.com"], cwd: dir });
	await safeSpawn({ cmd: ["git", "config", "user.name", "Test"], cwd: dir });
	writeFileSync(join(dir, "seed.txt"), "seed\n");
	await safeSpawn({ cmd: ["git", "add", "-A"], cwd: dir, timeout: 15_000 });
	await safeSpawn({ cmd: ["git", "commit", "-m", "seed"], cwd: dir, timeout: 15_000 });
	return dir;
}

/**
 * Register a watcher entry without starting a timer or a native subscription.
 *
 * `watch()` would install a real 5 s interval, and the test would then be racing it.
 * Ticks are driven explicitly instead, which is also what makes the polled/event
 * distinction observable at all.
 */
function registerEntry(worktreePath: string): void {
	worktreeWatcher._entries.set(worktreePath, {
		chapterId: `chapter-${Math.random().toString(36).slice(2, 8)}`,
		narratorIds: new Set(["narrator-test"]),
		locale: "en",
		processing: false,
		pendingProcess: false,
		rateLimit: { windowStart: Date.now(), count: 0, warned: false },
	});
}

/** Count `tryCapture` calls for the duration of `run`, keeping the real behaviour. */
async function countCaptures(run: () => Promise<void>): Promise<number> {
	const original = worktreeTreeSnapshot.tryCapture;
	let calls = 0;
	worktreeTreeSnapshot.tryCapture = async function (...args) {
		calls += 1;
		return original.apply(this, args);
	};
	try {
		await run();
	} finally {
		worktreeTreeSnapshot.tryCapture = original;
	}
	return calls;
}

afterEach(async () => {
	clearStatusCache();
	for (const dir of tempDirs.splice(0)) {
		worktreeWatcher.unwatchAll(dir);
		await worktreeTreeSnapshot.destroy(dir, undefined, { force: true }).catch(() => {});
		rmSync(dir, { recursive: true, force: true });
	}
	for (const path of snapshotPaths.splice(0)) {
		await db.delete(worktreeTreeSnapshots).where(eq(worktreeTreeSnapshots.worktreePath, path));
	}
});

describe("watcher polling ticks", () => {
	test("an idle polled tick takes no snapshot", async () => {
		const repo = await createRepo("nf-watch-idle-");
		registerEntry(repo);
		const registered = worktreeWatcher._entries.get(repo);
		if (!registered) throw new Error("entry was not registered");

		// The first tick has no previous signature to compare against, so it must still
		// capture — otherwise a workspace would never get an initial boundary.
		const first = await countCaptures(async () => {
			await worktreeWatcher._processChange(repo, registered, true);
		});
		expect(first).toBe(1);

		// Nothing was written between the ticks, which is the state a polled watcher is in
		// essentially all the time.
		const idle = await countCaptures(async () => {
			await worktreeWatcher._processChange(repo, registered, true);
			await worktreeWatcher._processChange(repo, registered, true);
			await worktreeWatcher._processChange(repo, registered, true);
		});
		expect(idle).toBe(0);
	});

	test("a polled tick after a real edit still captures", async () => {
		const repo = await createRepo("nf-watch-changed-");
		registerEntry(repo);
		const entry = worktreeWatcher._entries.get(repo);
		if (!entry) throw new Error("entry was not registered");
		await worktreeWatcher._processChange(repo, entry, true);

		// A write by anything outside the tool path — a terminal command, the user's
		// editor, a build script — is precisely what the boundary exists to make
		// revertable, so skipping here would be a data-safety regression rather than a
		// saving.
		writeFileSync(join(repo, "seed.txt"), "edited outside the tool path\n");
		const captures = await countCaptures(async () => {
			await worktreeWatcher._processChange(repo, entry, true);
		});
		expect(captures).toBe(1);
	});

	test("a watcher event captures even when git status is unchanged", async () => {
		const repo = await createRepo("nf-watch-event-");
		registerEntry(repo);
		const entry = worktreeWatcher._entries.get(repo);
		if (!entry) throw new Error("entry was not registered");
		await worktreeWatcher._processChange(repo, entry, true);

		// `polled = false` means the native watcher reported an actual filesystem event,
		// which is evidence of a write. The skip is only ever applied to a speculative
		// timer tick, so this path stays unconditional.
		const captures = await countCaptures(async () => {
			await worktreeWatcher._processChange(repo, entry, false);
		});
		expect(captures).toBe(1);
	});

	test("a change to a tracked-but-ignored file is not mistaken for an idle tick", async () => {
		const repo = await createRepo("nf-watch-tracked-ignored-");
		writeFileSync(join(repo, ".gitignore"), ".env\n");
		writeFileSync(join(repo, ".env"), "SECRET=1\n");
		await safeSpawn({
			cmd: ["git", "add", "-f", ".env", ".gitignore"],
			cwd: repo,
			timeout: 15_000,
		});
		await safeSpawn({ cmd: ["git", "commit", "-m", "track"], cwd: repo, timeout: 15_000 });
		registerEntry(repo);
		const entry = worktreeWatcher._entries.get(repo);
		if (!entry) throw new Error("entry was not registered");
		await worktreeWatcher._processChange(repo, entry, true);

		// The one case where "ignored files are invisible to git status" could have been a
		// hole in the skip reasoning: a tracked-but-ignored file *is* in the snapshot tree,
		// so a missed change would be unrevertable. git reports it as ` M`, so the
		// signature moves and the tick is not treated as idle.
		writeFileSync(join(repo, ".env"), "SECRET=rotated\n");
		const captures = await countCaptures(async () => {
			await worktreeWatcher._processChange(repo, entry, true);
		});
		expect(captures).toBe(1);
	});

	test("an equal-sized in-place edit is eventually captured by the tick sweep", async () => {
		// The failure mode the signature reasoning did not actually cover. The signature
		// folds in `git diff --numstat` counts, the status code and the path — not content —
		// so replacing one line with another of the same line count on an *already dirty*
		// file leaves all three identical (verified: `1 1`, ` M f.txt`, same path) while the
		// bytes on disk differ. Every such tick was skipped, so an external editor doing
		// exactly that produced no boundary at all and the edit was unrevertable.
		//
		// The existing "after a real edit" case does not reach this: it goes clean → dirty,
		// which moves the counts from nothing to `1 1`.
		//
		// What is asserted is convergence, not per-tick capture. Intermediate states between
		// forced captures genuinely have no boundary; the guarantee is that a run of skips
		// terminates in one, so the latest bytes become revertable.
		const repo = await createRepo("nf-watch-equal-size-");
		registerEntry(repo);
		const entry = worktreeWatcher._entries.get(repo);
		if (!entry) throw new Error("entry was not registered");
		// Get to the dirty state first, so the next edit is dirty → dirty rather than
		// clean → dirty.
		writeFileSync(join(repo, "seed.txt"), "aaaa\n");
		await worktreeWatcher._processChange(repo, entry, true);

		writeFileSync(join(repo, "seed.txt"), "bbbb\n");
		// The signature is unchanged, so the immediate tick is a skip — that part is the
		// documented trade-off rather than the bug.
		const immediate = await countCaptures(async () => {
			await worktreeWatcher._processChange(repo, entry, true);
		});
		expect(immediate).toBe(0);

		// Left alone, this would never capture again. The sweep is what bounds it.
		const eventual = await countCaptures(async () => {
			for (let tick = 0; tick < MAX_SKIPPED_POLLS + 2; tick++) {
				await worktreeWatcher._processChange(repo, entry, true);
			}
		});
		expect(eventual).toBeGreaterThan(0);
		// And the captured tree holds the new bytes, which is the property the boundary
		// exists for — a capture of stale content would satisfy the count and nothing else.
		const tree = await worktreeTreeSnapshot.capture(repo);
		expect(await worktreeTreeSnapshot.readFileAtTree(repo, tree, "seed.txt")).toBe("bbbb\n");
	});

	test("the sweep does not fire again until another run of skips accumulates", async () => {
		// The counter has to reset on a capture, not merely stop growing: leaving it at the
		// threshold would make every subsequent idle tick a forced capture, which is the
		// unconditional behaviour the skip exists to avoid.
		const repo = await createRepo("nf-watch-sweep-reset-");
		registerEntry(repo);
		const entry = worktreeWatcher._entries.get(repo);
		if (!entry) throw new Error("entry was not registered");
		await worktreeWatcher._processChange(repo, entry, true);

		// Drive one full run so the sweep fires and the counter goes back to zero.
		for (let tick = 0; tick <= MAX_SKIPPED_POLLS; tick++) {
			await worktreeWatcher._processChange(repo, entry, true);
		}

		const afterSweep = await countCaptures(async () => {
			for (let tick = 0; tick < MAX_SKIPPED_POLLS - 1; tick++) {
				await worktreeWatcher._processChange(repo, entry, true);
			}
		});
		expect(afterSweep).toBe(0);
	});

	test("a purely ignored file changing does leave a polled tick idle", async () => {
		const repo = await createRepo("nf-watch-ignored-");
		writeFileSync(join(repo, ".gitignore"), "build/\n");
		await safeSpawn({ cmd: ["git", "add", "-A"], cwd: repo, timeout: 15_000 });
		await safeSpawn({ cmd: ["git", "commit", "-m", "ignore"], cwd: repo, timeout: 15_000 });
		registerEntry(repo);
		const entry = worktreeWatcher._entries.get(repo);
		if (!entry) throw new Error("entry was not registered");
		await worktreeWatcher._processChange(repo, entry, true);

		// Skipping is correct rather than merely acceptable: the file is excluded from
		// snapshots, so a capture would have produced the identical tree and recorded
		// nothing. Losing no information is what makes the git-status signature a
		// sufficient judgement and not just a cheap heuristic.
		writeFileSync(join(repo, "build-artifact-ignored.tmp"), "x\n");
		rmSync(join(repo, "build-artifact-ignored.tmp"));
		const captures = await countCaptures(async () => {
			await worktreeWatcher._processChange(repo, entry, true);
		});
		expect(captures).toBe(0);
	});
});
