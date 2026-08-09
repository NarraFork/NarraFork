/**
 * Reproducing an author's working state in a review worktree.
 *
 * A review that shows only committed code is misleading in a specific way: the author is
 * looking at uncommitted work, the reviewer is not, and neither of them can tell. The
 * old transfer walked `git status --porcelain` and copied entries one by one, which has
 * a silent hole — porcelain reports a wholly new directory as a single `?? dir/` entry,
 * so reading it as a file fails and the entire subtree never reaches the review.
 *
 * These cases pin the transfer to the properties the snapshot path provides and the
 * copy path does not: whole untracked trees, deletions, and a lineage of its own.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { safeSpawn } from "../lib/spawn";
import { reviewService } from "./review-service";
import { SNAPSHOT_HEAD_REF, worktreeTreeSnapshot } from "./worktree-tree-snapshot";

const tempDirs: string[] = [];

const FILE = "app.txt";
const BASE = "l1\nl2\nl3\n";

async function git(args: string[], cwd: string): Promise<string> {
	const result = await safeSpawn({ cmd: ["git", ...args], cwd, timeout: 15_000 });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

/** A source worktree with one commit, and an empty review worktree branched from it. */
async function createSourceAndReview(): Promise<{ source: string; review: string }> {
	const root = mkdtempSync(join(tmpdir(), "nf-review-"));
	tempDirs.push(root);
	await git(["init", "-b", "main"], root);
	await git(["config", "user.email", "test@example.com"], root);
	await git(["config", "user.name", "Test"], root);
	writeFileSync(join(root, FILE), BASE);
	await git(["add", "-A"], root);
	await git(["commit", "-m", "seed"], root);

	const source = resolve(root, ".worktrees", "source");
	await git(["worktree", "add", source, "-b", "feat"], root);
	tempDirs.push(source);
	const review = resolve(root, ".worktrees", "review");
	await git(["worktree", "add", review, "-b", "review/x"], root);
	tempDirs.push(review);
	return { source, review };
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		worktreeTreeSnapshot.destroy(dir, undefined, { force: true }).catch(() => {});
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("transferring an author's working state into a review", () => {
	test("a wholly new untracked directory arrives complete", async () => {
		// The case the porcelain-copy path lost entirely: `?? newdir/` is one entry naming a
		// directory, so copying it as a file fails and every file under it is missing.
		const { source, review } = await createSourceAndReview();
		mkdirSync(join(source, "newdir", "sub"), { recursive: true });
		writeFileSync(join(source, "newdir", "a.txt"), "a\n");
		writeFileSync(join(source, "newdir", "sub", "b.txt"), "b\n");

		const result = await reviewService.transferWorkingState(source, review);
		expect(result.viaSnapshot).toBe(true);
		expect(readFileSync(join(review, "newdir", "a.txt"), "utf-8")).toBe("a\n");
		expect(readFileSync(join(review, "newdir", "sub", "b.txt"), "utf-8")).toBe("b\n");
	});

	test("uncommitted edits and deletions both carry over", async () => {
		const { source, review } = await createSourceAndReview();
		writeFileSync(join(source, FILE), "EDITED\n");
		writeFileSync(join(source, "extra.txt"), "e\n");
		await git(["add", "extra.txt"], source);
		await git(["commit", "-m", "add extra"], source);
		// Committed in the source but deleted without committing — the reviewer should see
		// it gone, which a copy-only transfer cannot express.
		rmSync(join(source, "extra.txt"));

		await reviewService.transferWorkingState(source, review);
		expect(readFileSync(join(review, FILE), "utf-8")).toBe("EDITED\n");
		expect(existsSync(join(review, "extra.txt"))).toBe(false);
	});

	test("the review workspace gets a lineage, so it can be forked and merged later", async () => {
		const { source, review } = await createSourceAndReview();
		writeFileSync(join(source, FILE), "EDITED\n");

		const result = await reviewService.transferWorkingState(source, review);
		expect(result.snapshotCommitSha).toBeTruthy();

		// Recorded as the review's own head, not merely fetched: without this the review
		// has no DAG position and cannot take part in a snapshot merge.
		const head = await worktreeTreeSnapshot.getRef(review, SNAPSHOT_HEAD_REF);
		expect(head).toBe(result.snapshotCommitSha);
	});

	test("a clean source still leaves the review with a position", async () => {
		const { source, review } = await createSourceAndReview();
		const result = await reviewService.transferWorkingState(source, review);
		expect(result.viaSnapshot).toBe(true);
		expect(result.snapshotCommitSha).toBeTruthy();
		expect(readFileSync(join(review, FILE), "utf-8")).toBe(BASE);
	});

	test("ignored files are not dragged into the review", async () => {
		const { source, review } = await createSourceAndReview();
		writeFileSync(join(source, ".gitignore"), "secrets/\n");
		mkdirSync(join(source, "secrets"), { recursive: true });
		writeFileSync(join(source, "secrets", "key.txt"), "top secret\n");

		await reviewService.transferWorkingState(source, review);
		expect(existsSync(join(review, "secrets", "key.txt"))).toBe(false);
	});
});
