/**
 * The review workspace guard: telling the reviewer's edits apart from the code under
 * review.
 *
 * This is the harder half of "reviewers must not modify files", and the earlier
 * implementation got it backwards. It asked `git status` whether anything was
 * uncommitted — but `createReview` deliberately transfers the AUTHOR's uncommitted work
 * into the review worktree, so the reviewed changes are themselves uncommitted and
 * untracked. Every turn therefore read as dirty, and the repair (`reset --hard` plus
 * `checkout HEAD -- .` and `clean -fd`) deleted the very code under review. The reviewer
 * then reported that the files no longer existed, and the check fired again on the next
 * turn — a loop with no exit while the source had any uncommitted work.
 *
 * So these cases pin the property the fix rests on: the baseline is the state the
 * reviewer was HANDED (`refs/nf/base`), not the last commit. A workspace that still
 * matches it is clean no matter how much uncommitted work it contains, and a restore
 * brings that work back rather than removing it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { chapters, projects } from "../../db/schema";
import { generateId } from "../../lib/id";
import { safeSpawn } from "../../lib/spawn";
import { advanceChapterSnapshot } from "../chapter-snapshot-ref";
import { reviewService } from "../review-service";
import { SNAPSHOT_BASE_REF, worktreeTreeSnapshot } from "../worktree-tree-snapshot";

const tempDirs: string[] = [];
const chapterIds: string[] = [];
const projectIds: string[] = [];

const FILE = "app.txt";
const COMMITTED = "committed line\n";
const AUTHOR_EDIT = "the author's uncommitted edit\n";

async function git(args: string[], cwd: string): Promise<string> {
	const result = await safeSpawn({ cmd: ["git", ...args], cwd, timeout: 15_000 });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

interface Fixture {
	/** The author's workspace, holding uncommitted work. */
	source: string;
	/** The reviewer's workspace. */
	review: string;
	/** The review chapter row `checkAndResetGitState` reads. */
	reviewChapterId: string;
	/** HEAD both worktrees start at. */
	headSha: string;
}

/**
 * A source worktree with uncommitted work (an edit AND a wholly new untracked
 * directory), transferred into a review worktree exactly as `createReview` does it.
 *
 * The untracked directory matters: it is the case the old porcelain-copy transfer lost
 * entirely, and it is also the case a `clean -fd` repair destroys most visibly.
 */
async function createReviewFixture(options?: { skipTransfer?: boolean }): Promise<Fixture> {
	const root = mkdtempSync(join(tmpdir(), "nf-review-dirty-"));
	tempDirs.push(root);
	await git(["init", "-b", "main"], root);
	await git(["config", "user.email", "test@example.com"], root);
	await git(["config", "user.name", "Test"], root);
	writeFileSync(join(root, FILE), COMMITTED);
	await git(["add", "-A"], root);
	await git(["commit", "-m", "seed"], root);
	const headSha = await git(["rev-parse", "HEAD"], root);

	const source = resolve(root, ".worktrees", "source");
	await git(["worktree", "add", source, "-b", "feat"], root);
	tempDirs.push(source);
	const review = resolve(root, ".worktrees", "review");
	await git(["worktree", "add", review, "-b", "review/x"], root);
	tempDirs.push(review);

	// The author's uncommitted work: an edit plus a new subtree.
	writeFileSync(join(source, FILE), AUTHOR_EDIT);
	mkdirSync(join(source, "feature", "deep"), { recursive: true });
	writeFileSync(join(source, "feature", "new.ts"), "export const added = 1;\n");
	writeFileSync(join(source, "feature", "deep", "nested.ts"), "export const nested = 2;\n");

	if (!options?.skipTransfer) {
		await reviewService.transferWorkingState(source, review);
	}

	const projectId = generateId();
	projectIds.push(projectId);
	const now = new Date().toISOString();
	await db.insert(projects).values({
		id: projectId,
		name: "review-dirty-test",
		gitPath: root,
		createdAt: now,
		updatedAt: now,
	});

	const reviewChapterId = generateId();
	chapterIds.push(reviewChapterId);
	await db.insert(chapters).values({
		id: reviewChapterId,
		projectId,
		title: "Review: dirty detection",
		status: "active",
		role: "review",
		branch: "review/x",
		baseBranch: "feat",
		worktreePath: review,
		reviewStatus: "reviewing",
		startCommitSha: headSha,
		headCommitSha: headSha,
		createdAt: now,
		updatedAt: now,
	});

	return { source, review, reviewChapterId, headSha };
}

afterEach(async () => {
	for (const id of chapterIds.splice(0)) {
		await db.delete(chapters).where(eq(chapters.id, id));
	}
	for (const id of projectIds.splice(0)) {
		await db.delete(projects).where(eq(projects.id, id));
	}
	for (const dir of tempDirs.splice(0)) {
		await worktreeTreeSnapshot.destroy(dir, undefined, { force: true }).catch(() => {});
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("a review workspace the reviewer has not touched", () => {
	test("is clean even though the reviewed work is uncommitted and untracked", async () => {
		// THE regression this whole change exists for. `git status` reports three kinds of
		// dirt here (a modified file, an untracked directory), all of it transferred in on
		// purpose, and the old check read that as "the reviewer wrote something".
		const fixture = await createReviewFixture();
		const result = await reviewService.checkAndResetGitState(fixture.reviewChapterId);
		expect(result.clean).toBe(true);
		expect(result.message).toBeUndefined();
	});

	test("leaves the reviewed work on disk", async () => {
		// A clean verdict must also be a no-op. The failure mode being pinned is not just a
		// wrong boolean: the old path acted on it and deleted these files.
		const fixture = await createReviewFixture();
		await reviewService.checkAndResetGitState(fixture.reviewChapterId);
		expect(readFileSync(join(fixture.review, FILE), "utf-8")).toBe(AUTHOR_EDIT);
		expect(existsSync(join(fixture.review, "feature", "new.ts"))).toBe(true);
		expect(existsSync(join(fixture.review, "feature", "deep", "nested.ts"))).toBe(true);
	});

	test("stays clean across repeated turn-end checks", async () => {
		// The observable symptom was an endless continuation: each turn ended dirty, injected
		// a reset notice, and continued. Two consecutive clean checks are what proves the
		// loop terminates.
		const fixture = await createReviewFixture();
		expect((await reviewService.checkAndResetGitState(fixture.reviewChapterId)).clean).toBe(true);
		expect((await reviewService.checkAndResetGitState(fixture.reviewChapterId)).clean).toBe(true);
	});
});

describe("a review workspace the reviewer wrote to", () => {
	test("is reported dirty and restored, with the author's work intact", async () => {
		const fixture = await createReviewFixture();
		writeFileSync(join(fixture.review, "reviewer-scratch.txt"), "notes to self\n");
		writeFileSync(join(fixture.review, FILE), "the reviewer rewrote this\n");

		const result = await reviewService.checkAndResetGitState(fixture.reviewChapterId);
		expect(result.clean).toBe(false);
		expect(result.message).toContain("restored");

		// The reviewer's own file is gone…
		expect(existsSync(join(fixture.review, "reviewer-scratch.txt"))).toBe(false);
		// …and everything that was under review is back, including the untracked subtree.
		expect(readFileSync(join(fixture.review, FILE), "utf-8")).toBe(AUTHOR_EDIT);
		expect(existsSync(join(fixture.review, "feature", "deep", "nested.ts"))).toBe(true);
	});

	test("survives a commit: HEAD is reset AND the uncommitted work is written back", async () => {
		// `reset --hard` alone would satisfy the HEAD half and destroy the review, since the
		// work under review is uncommitted. The restore has to run after it, unconditionally.
		const fixture = await createReviewFixture();
		await git(["add", "-A"], fixture.review);
		await git(["commit", "-m", "reviewer committed the work under review"], fixture.review);

		const result = await reviewService.checkAndResetGitState(fixture.reviewChapterId);
		expect(result.clean).toBe(false);
		expect(await git(["rev-parse", "HEAD"], fixture.review)).toBe(fixture.headSha);
		expect(readFileSync(join(fixture.review, FILE), "utf-8")).toBe(AUTHOR_EDIT);
		expect(existsSync(join(fixture.review, "feature", "new.ts"))).toBe(true);
	});

	test("a second check after the restore is clean again", async () => {
		const fixture = await createReviewFixture();
		writeFileSync(join(fixture.review, "scratch.txt"), "x\n");
		await reviewService.checkAndResetGitState(fixture.reviewChapterId);
		expect((await reviewService.checkAndResetGitState(fixture.reviewChapterId)).clean).toBe(true);
	});
});

describe("a review workspace with no baseline", () => {
	test("reports clean and destroys nothing", async () => {
		// Declining to check is the deliberate choice: the alternative fallback IS the bug
		// (`git status` in a worktree whose reviewed work is uncommitted), and a missed stray
		// edit in a throwaway worktree costs far less than deleting the code under review.
		const fixture = await createReviewFixture({ skipTransfer: true });
		writeFileSync(join(fixture.review, "reviewer-scratch.txt"), "notes\n");

		const result = await reviewService.checkAndResetGitState(fixture.reviewChapterId);
		expect(result.clean).toBe(true);
		expect(existsSync(join(fixture.review, "reviewer-scratch.txt"))).toBe(true);
	});
});

describe("establishing the baseline", () => {
	test("the snapshot transfer records refs/nf/base", async () => {
		const fixture = await createReviewFixture();
		const baseline = await reviewService.resolveReviewBaselineTree(fixture.review);
		expect(baseline).toBeTruthy();
		// And it describes the workspace as handed over, which is what makes the untouched
		// case clean.
		expect(await worktreeTreeSnapshot.capture(fixture.review)).toBe(baseline as string);
	});

	test("the copy fallback records one too, so the guard still works without a lineage", async () => {
		// `transferWorkingState` falls back to `copyDirtyFiles` when the source has no
		// shadow repository, and that path touches no refs. Without an explicit baseline
		// here every later check would take the "no baseline" exit and stop guarding.
		const fixture = await createReviewFixture({ skipTransfer: true });
		await reviewService.copyDirtyFiles(fixture.source, fixture.review);
		expect(await worktreeTreeSnapshot.getRef(fixture.review, SNAPSHOT_BASE_REF)).toBeNull();

		await reviewService.recordReviewBaseline(fixture.review);
		const baseline = await reviewService.resolveReviewBaselineTree(fixture.review);
		expect(baseline).toBeTruthy();
		expect((await reviewService.checkAndResetGitState(fixture.reviewChapterId)).clean).toBe(true);

		writeFileSync(join(fixture.review, "scratch.txt"), "x\n");
		expect((await reviewService.checkAndResetGitState(fixture.reviewChapterId)).clean).toBe(false);
		expect(existsSync(join(fixture.review, "scratch.txt"))).toBe(false);
	});
});

/**
 * `refs/nf/base` must not move after the transfer wrote it.
 *
 * The whole guard is a comparison against it, so a base that follows the workspace
 * would make every check trivially clean — the reviewer could rewrite anything and the
 * comparison would agree with itself. Nothing raises an error in that state; the guard
 * simply stops guarding, which is indistinguishable from "the reviewer behaved".
 *
 * `advanceChapterSnapshot` is documented to touch only `refs/nf/head`, and these cases
 * pin that claim against the operations that actually run on a review workspace, so a
 * later change that starts advancing base is caught here rather than by a reviewer
 * whose edits stopped being reverted.
 */
describe("the baseline does not move", () => {
	test("a reviewer's tool call advances head but not base", async () => {
		const fixture = await createReviewFixture();
		const baseBefore = await worktreeTreeSnapshot.getRef(fixture.review, SNAPSHOT_BASE_REF);
		expect(baseBefore).toBeTruthy();

		// What the snapshot hooks do around each file-modifying tool call.
		writeFileSync(join(fixture.review, "reviewer-note.txt"), "thinking out loud\n");
		await advanceChapterSnapshot(fixture.review, null, "reviewer tool call");

		expect(await worktreeTreeSnapshot.getRef(fixture.review, SNAPSHOT_BASE_REF)).toBe(
			baseBefore as string,
		);
		// And the guard still sees the write, which is the point of base holding still.
		expect((await reviewService.checkAndResetGitState(fixture.reviewChapterId)).clean).toBe(false);
	});

	test("the baseline TREE is unchanged by a restore, so checks stay stable", async () => {
		const fixture = await createReviewFixture();
		const treeBefore = await reviewService.resolveReviewBaselineTree(fixture.review);

		writeFileSync(join(fixture.review, FILE), "reviewer rewrote it\n");
		await reviewService.checkAndResetGitState(fixture.reviewChapterId);

		expect(await reviewService.resolveReviewBaselineTree(fixture.review)).toBe(
			treeBefore as string,
		);
	});

	test("recording a baseline twice is refused as a lineage overwrite", async () => {
		// `recordReviewBaseline` is only for the transfer paths that produced no lineage.
		// Calling it on a workspace that already has one would rebase the guard onto
		// whatever the reviewer has since written, so it must not silently succeed.
		const fixture = await createReviewFixture();
		const baseBefore = await worktreeTreeSnapshot.getRef(fixture.review, SNAPSHOT_BASE_REF);

		writeFileSync(join(fixture.review, "reviewer-note.txt"), "notes\n");
		await reviewService.recordReviewBaseline(fixture.review);

		expect(await worktreeTreeSnapshot.getRef(fixture.review, SNAPSHOT_BASE_REF)).toBe(
			baseBefore as string,
		);
		expect((await reviewService.checkAndResetGitState(fixture.reviewChapterId)).clean).toBe(false);
	});
});
