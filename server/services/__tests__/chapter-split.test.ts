/**
 * Splitting a chapter at one of its own commits.
 *
 * The cases are organised around the ways this operation can produce a *wrong*
 * result rather than around its API surface, because most of them fail silently:
 *
 *   - the conversation cut landing at the wrong message (the reason the boundary
 *     is resolved by `seq` and not by comparing commit timestamps),
 *   - the continuation losing history that only it should keep,
 *   - the parent→child edge still pointing at the continuation, which leaves the
 *     graph claiming two different parents for the same chapter,
 *   - a split at a commit that is not in this chapter's history at all, and
 *   - a mid-way failure leaving a half-split project behind.
 *
 * Everything runs against a real temporary git repository and real chapter rows,
 * because the question in most cases is whether the git-level and DB-level halves
 * agree with each other. The database is the in-memory schema replay from
 * `tests/setup`, so the developer's live NarraFork database is never touched.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	chapterCommits,
	chapterEdges,
	chapters,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	projects,
} from "../../db/schema";
import { generateId } from "../../lib/id";
import { safeSpawn } from "../../lib/spawn";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const { chapterSplit, resolveTruncationSeqForCommit } = await import("../chapter-split");
const { chapterEdgeService } = await import("../chapter-edge-service");
const { chapterFork } = await import("../chapter-fork");
const { worktreeTreeSnapshot } = await import("../worktree-tree-snapshot");

const tempDirs: string[] = [];

async function git(args: string[], cwd: string): Promise<string> {
	const result = await safeSpawn({ cmd: ["git", ...args], cwd, timeout: 15_000 });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

function present<T>(value: T | null | undefined, what: string): T {
	if (value === null || value === undefined) throw new Error(`expected ${what} to be present`);
	return value;
}

interface SplitFixture {
	projectId: string;
	gitPath: string;
	chapterId: string;
	worktree: string;
	narratorId: string;
	/** Commit shas in creation order: c0 (seed) … c3 (tip). */
	commits: string[];
	/** Message ids in `seq` order. */
	messages: string[];
}

/**
 * A chapter with four commits and a conversation whose messages are linked to
 * three of them, i.e. the shape every split has to reason about: some messages
 * carry a commit, most do not.
 *
 * Layout (seq → message → commit):
 *   0 user   "start"
 *   1 assist "did c1"     → c1
 *   2 user   "next"
 *   3 assist "did c2"     → c2   ← the split point in most cases
 *   4 user   "and more"
 *   5 assist "did c3"     → c3
 */
async function createSplittableChapter(): Promise<SplitFixture> {
	const gitPath = mkdtempSync(join(tmpdir(), "nf-split-"));
	tempDirs.push(gitPath);
	await git(["init", "--initial-branch=main"], gitPath);
	await git(["config", "user.email", "test@example.com"], gitPath);
	await git(["config", "user.name", "Test"], gitPath);

	const now = new Date().toISOString();
	const projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "Split project",
		gitPath,
		defaultBranch: "main",
		createdAt: now,
		updatedAt: now,
	});

	writeFileSync(join(gitPath, "seed.txt"), "seed\n");
	await git(["add", "-A"], gitPath);
	await git(["commit", "-m", "seed"], gitPath);
	const c0 = await git(["rev-parse", "HEAD"], gitPath);

	const suffix = `split-${generateId().slice(0, 6)}`;
	const branch = `chapter/${suffix}`;
	const worktree = resolve(gitPath, ".worktrees", suffix);
	await git(["worktree", "add", worktree, "-b", branch], gitPath);
	tempDirs.push(worktree);

	const commits = [c0];
	for (const n of [1, 2, 3]) {
		writeFileSync(join(worktree, `f${n}.txt`), `content ${n}\n`);
		await git(["add", "-A"], worktree);
		await git(["commit", "-m", `commit ${n}`], worktree);
		commits.push(await git(["rev-parse", "HEAD"], worktree));
	}

	const chapterId = generateId();
	await db.insert(chapters).values({
		id: chapterId,
		projectId,
		title: "Original chapter",
		description: "the chapter being split",
		status: "active",
		role: "branch",
		branch,
		baseBranch: "main",
		worktreePath: worktree,
		startCommitSha: c0,
		headCommitSha: commits[3],
		commitCount: 4,
		anchorCommitSha: commits[3],
		crossOffset: 100,
		createdAt: now,
		updatedAt: now,
	});

	const narratorId = generateId();
	await db.insert(narrators).values({
		id: narratorId,
		chapterId,
		type: "primary",
		variant: "primary",
		traits: [],
		model: "test-model",
		permissionMode: "default",
		inheritMode: "fresh",
		status: "idle",
		createdAt: now,
		updatedAt: now,
	});

	const messages: string[] = [];
	const plan: Array<{ role: "user" | "assistant"; text: string; commitSha?: string }> = [
		{ role: "user", text: "start" },
		{ role: "assistant", text: "did c1", commitSha: commits[1] },
		{ role: "user", text: "next" },
		{ role: "assistant", text: "did c2", commitSha: commits[2] },
		{ role: "user", text: "and more" },
		{ role: "assistant", text: "did c3", commitSha: commits[3] },
	];
	for (const [seq, entry] of plan.entries()) {
		const messageId = generateId();
		messages.push(messageId);
		await db.insert(narratorMessages).values({
			id: messageId,
			narratorId,
			role: entry.role,
			contentJson: [{ type: "text", text: entry.text }],
			contentText: entry.text,
			commitSha: entry.commitSha ?? null,
			createdAt: new Date(Date.now() + seq * 1000).toISOString(),
		});
		await db.insert(narratorMessageRefs).values({
			id: generateId(),
			narratorId,
			messageId,
			seq,
			isCompact: 0,
		});
	}

	// Commit records, with the narrator-message link `recordCommit` would have
	// written. c0 is the repository seed and deliberately has no message.
	for (const [index, sha] of commits.entries()) {
		await db.insert(chapterCommits).values({
			id: generateId(),
			chapterId,
			sha,
			message: index === 0 ? "seed" : `commit ${index}`,
			authoredAt: new Date(Date.now() + index * 1000).toISOString(),
			source: "manual",
			narratorMessageId: index === 0 ? null : messages[index * 2 - 1],
			createdAt: now,
		});
	}

	return { projectId, gitPath, chapterId, worktree, narratorId, commits, messages };
}

async function chapterRow(id: string) {
	return present(
		await db.query.chapters.findFirst({ where: eq(chapters.id, id) }),
		`chapter ${id}`,
	);
}

/** Message ids visible to a narrator, in `seq` order. */
async function messagesOf(narratorId: string): Promise<string[]> {
	const rows = await db
		.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
		.from(narratorMessageRefs)
		.where(eq(narratorMessageRefs.narratorId, narratorId));
	return rows.sort((a, b) => a.seq - b.seq).map((r) => r.messageId);
}

async function primaryNarratorOf(chapterId: string): Promise<string> {
	const row = await db.query.narrators.findFirst({
		where: and(eq(narrators.chapterId, chapterId), eq(narrators.variant, "primary")),
		columns: { id: true },
	});
	return present(row, `primary narrator of ${chapterId}`).id;
}

const newForkInput = {
	title: "Alternative approach",
	description: "branching off the old commit",
	inheritMode: "full" as const,
};

beforeEach(() => {
	cleanDb(sqlite);
});

afterEach(async () => {
	// Shadow repositories live outside the temp directories and are keyed by
	// worktree path, so they have to be dropped explicitly or they accumulate in
	// ~/.narrafork/tree-snapshots for paths that no longer exist.
	for (const dir of tempDirs.splice(0)) {
		await worktreeTreeSnapshot.destroy(dir, undefined, { force: true }).catch(() => {});
		rmSync(dir, { recursive: true, force: true });
	}
});

afterAll(() => {
	mock.module("../../db", () => realDbModule);
});

describe("resolveTruncationSeqForCommit", () => {
	test("maps a commit to the seq of the message that produced it", async () => {
		const env = await createSplittableChapter();

		const point = present(
			await resolveTruncationSeqForCommit(env.chapterId, env.commits[2], {
				repoPath: env.worktree,
			}),
			"truncation point",
		);

		expect(point.messageId).toBe(env.messages[3]);
		expect(point.seq).toBe(3);
		expect(point.approximate).toBe(false);
		expect(point.resolvedFromCommitSha).toBe(env.commits[2]);
	});

	test("does not let a rewritten commit date move the boundary", async () => {
		const env = await createSplittableChapter();
		// A rebase or `--date` override can leave an earlier commit with a later
		// authored date than the split point. A timestamp-based cut would then pick
		// the wrong message; a seq-based one is unaffected.
		await db
			.update(chapterCommits)
			.set({ authoredAt: new Date(Date.now() + 10 * 60_000).toISOString() })
			.where(
				and(eq(chapterCommits.chapterId, env.chapterId), eq(chapterCommits.sha, env.commits[1])),
			);
		await db
			.update(narratorMessages)
			.set({ createdAt: new Date(Date.now() + 10 * 60_000).toISOString() })
			.where(eq(narratorMessages.id, env.messages[1]));

		const point = present(
			await resolveTruncationSeqForCommit(env.chapterId, env.commits[2], {
				repoPath: env.worktree,
			}),
			"truncation point",
		);

		expect(point.seq).toBe(3);
		expect(point.messageId).toBe(env.messages[3]);
	});

	test("falls back to the newest ancestor commit that has a message", async () => {
		const env = await createSplittableChapter();
		// A hand-made commit: recorded in the chapter's history, but with no
		// conversation message behind it.
		await db
			.update(chapterCommits)
			.set({ narratorMessageId: null })
			.where(
				and(eq(chapterCommits.chapterId, env.chapterId), eq(chapterCommits.sha, env.commits[2])),
			);

		const point = present(
			await resolveTruncationSeqForCommit(env.chapterId, env.commits[2], {
				repoPath: env.worktree,
			}),
			"truncation point",
		);

		// c3's message is *newer* by seq but its commit is not an ancestor of c2, so
		// the boundary has to come from c1.
		expect(point.approximate).toBe(true);
		expect(point.resolvedFromCommitSha).toBe(env.commits[1]);
		expect(point.messageId).toBe(env.messages[1]);
		expect(point.seq).toBe(1);
	});

	test("returns null when no commit at or before the split point has a message", async () => {
		const env = await createSplittableChapter();
		await db
			.update(chapterCommits)
			.set({ narratorMessageId: null })
			.where(eq(chapterCommits.chapterId, env.chapterId));

		expect(
			await resolveTruncationSeqForCommit(env.chapterId, env.commits[2], {
				repoPath: env.worktree,
			}),
		).toBeNull();
	});
});

describe("splitting a chapter", () => {
	test("distributes fields across prefix, continuation and new fork", async () => {
		const env = await createSplittableChapter();
		const before = await chapterRow(env.chapterId);

		const result = await chapterSplit.split(env.chapterId, {
			commitSha: env.commits[2],
			newFork: newForkInput,
		});

		expect(result.commitSha).toBe(env.commits[2]);

		// The prefix is the historical anchor: dormant (so it is still forkable and
		// wakeable, which `frozen` would not be), pinned at the split commit, and it
		// takes over the original's upstream relationship.
		const prefix = await chapterRow(result.prefixChapter.id);
		expect(prefix.status).toBe("dormant");
		expect(prefix.worktreePath).toBeNull();
		expect(prefix.role).toBe(before.role);
		expect(prefix.headCommitSha).toBe(env.commits[2]);
		expect(prefix.anchorCommitSha).toBe(env.commits[2]);
		expect(prefix.startCommitSha).toBe(before.startCommitSha);
		expect(prefix.parentChapterId).toBe(before.parentChapterId);
		expect(prefix.snapshotShadowKey).toBeTruthy();
		// Attachments stay with the chapter that keeps evolving.
		expect(prefix.explorationGroupId).toBeNull();
		expect(prefix.reviewSourceChapterId).toBeNull();
		expect(prefix.mergedIntoChapterId).toBeNull();
		expect(prefix.containerConfig).toBeNull();
		// Its branch really is at the split commit.
		expect(await git(["rev-parse", prefix.branch], env.gitPath)).toBe(env.commits[2]);

		// The continuation is the original row, in place: same id, branch, worktree
		// and status, only its lineage moved.
		const continuation = await chapterRow(env.chapterId);
		expect(continuation.id).toBe(before.id);
		expect(continuation.branch).toBe(before.branch);
		expect(continuation.worktreePath).toBe(before.worktreePath);
		expect(continuation.headCommitSha).toBe(before.headCommitSha);
		expect(continuation.status).toBe("active");
		expect(continuation.role).toBe(before.role);
		expect(continuation.parentChapterId).toBe(prefix.id);
		expect(continuation.startCommitSha).toBe(env.commits[2]);
		expect((continuation.forkPoint as { commitSha?: string })?.commitSha).toBe(env.commits[2]);

		// Its commit records are recounted, never deleted — the UI lists them and
		// they are the only local record of the chapter's own history.
		const continuationCommits = await db
			.select({ sha: chapterCommits.sha })
			.from(chapterCommits)
			.where(eq(chapterCommits.chapterId, env.chapterId));
		expect(continuationCommits.map((c) => c.sha).sort()).toEqual([...env.commits].sort());
		expect(continuation.commitCount).toBe(env.commits.length);

		// And the fork the user actually asked for, hanging off the prefix at C.
		const newFork = await chapterRow(String(result.newForkChapter.id));
		expect(newFork.parentChapterId).toBe(prefix.id);
		expect(newFork.startCommitSha).toBe(env.commits[2]);
		expect(newFork.title).toBe(newForkInput.title);
		expect(await git(["rev-parse", newFork.branch], env.gitPath)).toBe(env.commits[2]);
	});

	test("gives the prefix history up to the cut and leaves the continuation whole", async () => {
		const env = await createSplittableChapter();

		const result = await chapterSplit.split(env.chapterId, {
			commitSha: env.commits[2],
			newFork: newForkInput,
		});

		// The refs are copied, not moved: the continuation is the chapter that keeps
		// going, so losing its tail would be losing the work being split away from.
		expect(await messagesOf(env.narratorId)).toEqual(env.messages);

		const prefixNarratorId = await primaryNarratorOf(result.prefixChapter.id);
		expect(await messagesOf(prefixNarratorId)).toEqual(env.messages.slice(0, 4));
	});

	test("hands the original's incoming fork edge to the prefix", async () => {
		const env = await createSplittableChapter();
		const now = new Date().toISOString();
		// An upstream chapter that O was forked from, with the edge the graph draws.
		const upstreamId = generateId();
		await db.insert(chapters).values({
			id: upstreamId,
			projectId: env.projectId,
			title: "Upstream",
			status: "active",
			role: "trunk",
			branch: "main",
			baseBranch: "main",
			worktreePath: env.gitPath,
			isRoot: 1,
			createdAt: now,
			updatedAt: now,
		});
		await db
			.update(chapters)
			.set({ parentChapterId: upstreamId })
			.where(eq(chapters.id, env.chapterId));
		const edgeId = generateId();
		await db.insert(chapterEdges).values({
			id: edgeId,
			projectId: env.projectId,
			sourceId: upstreamId,
			targetId: env.chapterId,
			type: "fork",
			metadata: { commitSha: env.commits[0], inheritMode: "full" },
			createdAt: now,
		});

		const result = await chapterSplit.split(env.chapterId, {
			commitSha: env.commits[2],
			newFork: newForkInput,
		});

		const edge = present(
			await db.query.chapterEdges.findFirst({ where: eq(chapterEdges.id, edgeId) }),
			"inbound fork edge",
		);
		expect(edge.sourceId).toBe(upstreamId);
		expect(edge.targetId).toBe(result.prefixChapter.id);

		// And the prefix→continuation edge now carries the split point.
		const chainEdge = present(
			await db.query.chapterEdges.findFirst({
				where: and(
					eq(chapterEdges.sourceId, result.prefixChapter.id),
					eq(chapterEdges.targetId, env.chapterId),
				),
			}),
			"prefix→continuation edge",
		);
		expect(chainEdge.type).toBe("fork");
		expect((chainEdge.metadata as { commitSha?: string })?.commitSha).toBe(env.commits[2]);
		// The prefix inherited the upstream parent pointer too, so the redundant
		// column and the edge table agree.
		expect((await chapterRow(result.prefixChapter.id)).parentChapterId).toBe(upstreamId);
	});

	test("leaves the prefix forkable rather than a dead end", async () => {
		const env = await createSplittableChapter();
		const result = await chapterSplit.split(env.chapterId, {
			commitSha: env.commits[2],
			newFork: newForkInput,
		});

		// The whole reason the prefix is dormant and not frozen: a historical anchor
		// has to keep accepting new branches after the split.
		const second = await chapterFork.fork(result.prefixChapter.id, {
			title: "Second attempt",
			inheritMode: "fresh",
		});
		tempDirs.push(String(second.worktreePath));

		expect(second.parentChapterId).toBe(result.prefixChapter.id);
		expect(await git(["rev-parse", second.branch], env.gitPath)).toBe(env.commits[2]);
	});

	test("warns instead of guessing when the split commit has no message", async () => {
		const env = await createSplittableChapter();
		await db
			.update(chapterCommits)
			.set({ narratorMessageId: null })
			.where(
				and(eq(chapterCommits.chapterId, env.chapterId), eq(chapterCommits.sha, env.commits[2])),
			);

		const result = await chapterSplit.split(env.chapterId, {
			commitSha: env.commits[2],
			newFork: newForkInput,
		});

		expect(result.warnings?.join(" ")).toContain("not made by the narrator");
		expect(result.fallbacks?.[0]).toMatchObject({
			step: "truncationPoint",
			mode: "approximate",
			resolvedFromCommitSha: env.commits[1],
		});
		// The cut follows the approximation, so the prefix ends at c1's message.
		const prefixNarratorId = await primaryNarratorOf(result.prefixChapter.id);
		expect(await messagesOf(prefixNarratorId)).toEqual(env.messages.slice(0, 2));
	});
});

describe("rejecting splits that cannot produce two halves", () => {
	test("rejects a commit that is not in this chapter's history", async () => {
		const env = await createSplittableChapter();
		// A commit on a sibling branch: reachable in the repository, but not from
		// this chapter's branch, so there is nothing here to cut.
		await git(["checkout", "-b", "sibling", env.commits[0]], env.gitPath);
		writeFileSync(join(env.gitPath, "sibling.txt"), "elsewhere\n");
		await git(["add", "-A"], env.gitPath);
		await git(["commit", "-m", "sibling work"], env.gitPath);
		const foreign = await git(["rev-parse", "HEAD"], env.gitPath);
		await git(["checkout", "main"], env.gitPath);

		await expect(
			chapterSplit.split(env.chapterId, { commitSha: foreign, newFork: newForkInput }),
		).rejects.toThrow(/not part of this chapter's history/);
	});

	test("rejects a split at the chapter's own tip", async () => {
		const env = await createSplittableChapter();

		await expect(
			chapterSplit.split(env.chapterId, { commitSha: env.commits[3], newFork: newForkInput }),
		).rejects.toThrow(/latest commit/);
	});

	test("rejects a split at the chapter's first commit", async () => {
		const env = await createSplittableChapter();

		await expect(
			chapterSplit.split(env.chapterId, { commitSha: env.commits[0], newFork: newForkInput }),
		).rejects.toThrow(/first commit/);
	});

	test("rejects splitting the root chapter", async () => {
		const env = await createSplittableChapter();
		await db.update(chapters).set({ isRoot: 1 }).where(eq(chapters.id, env.chapterId));

		await expect(
			chapterSplit.split(env.chapterId, { commitSha: env.commits[2], newFork: newForkInput }),
		).rejects.toThrow(/root chapter cannot be split/);
	});

	test("rejects a chapter with no primary narrator", async () => {
		const env = await createSplittableChapter();
		await db.update(narrators).set({ chapterId: null }).where(eq(narrators.id, env.narratorId));

		await expect(
			chapterSplit.split(env.chapterId, { commitSha: env.commits[2], newFork: newForkInput }),
		).rejects.toThrow(/no primary narrator/);
	});

	test("refuses while the conversation is being compacted", async () => {
		const env = await createSplittableChapter();
		const pendingId = generateId();
		await db.insert(narratorMessages).values({
			id: pendingId,
			narratorId: env.narratorId,
			role: "system",
			contentJson: [{ type: "compact", status: "compacting", summary: "" }],
			contentText: "compacting",
			createdAt: new Date().toISOString(),
		});
		await db.insert(narratorMessageRefs).values({
			id: generateId(),
			narratorId: env.narratorId,
			messageId: pendingId,
			seq: 6,
			isCompact: 0,
		});

		await expect(
			chapterSplit.split(env.chapterId, { commitSha: env.commits[2], newFork: newForkInput }),
		).rejects.toThrow(/being compacted/);
	});
});

describe("rolling back a failed split", () => {
	test("undoes the prefix, the new fork and the edge retarget", async () => {
		const env = await createSplittableChapter();
		const now = new Date().toISOString();
		const upstreamId = generateId();
		await db.insert(chapters).values({
			id: upstreamId,
			projectId: env.projectId,
			title: "Upstream",
			status: "active",
			role: "trunk",
			branch: "main",
			baseBranch: "main",
			worktreePath: env.gitPath,
			isRoot: 1,
			createdAt: now,
			updatedAt: now,
		});
		const edgeId = generateId();
		await db.insert(chapterEdges).values({
			id: edgeId,
			projectId: env.projectId,
			sourceId: upstreamId,
			targetId: env.chapterId,
			type: "fork",
			metadata: { commitSha: env.commits[0], inheritMode: "full" },
			createdAt: now,
		});
		const before = await chapterRow(env.chapterId);
		const chaptersBefore = (
			await db
				.select({ id: chapters.id })
				.from(chapters)
				.where(eq(chapters.projectId, env.projectId))
		).length;

		// Fail at the last compensable step — after the prefix, its narrator, the new
		// fork and the edge retarget have all succeeded — which is the widest rollback
		// the operation can be asked to perform.
		const realCreateForkEdge = chapterEdgeService.createForkEdge.bind(chapterEdgeService);
		chapterEdgeService.createForkEdge = (async (
			projectId: string,
			sourceId: string,
			targetId: string,
			metadata: Parameters<typeof realCreateForkEdge>[3],
		) => {
			// Only the prefix→continuation edge: `chapterFork.fork` uses this same
			// method for its own edge and must be left working.
			if (targetId === env.chapterId) throw new Error("injected failure");
			return realCreateForkEdge(projectId, sourceId, targetId, metadata);
		}) as typeof chapterEdgeService.createForkEdge;

		try {
			await expect(
				chapterSplit.split(env.chapterId, { commitSha: env.commits[2], newFork: newForkInput }),
			).rejects.toThrow(/injected failure/);
		} finally {
			chapterEdgeService.createForkEdge = realCreateForkEdge;
		}

		// No chapter rows survive the failure, so the prefix and the new fork are
		// both gone.
		const after = await db
			.select({ id: chapters.id, branch: chapters.branch, worktreePath: chapters.worktreePath })
			.from(chapters)
			.where(eq(chapters.projectId, env.projectId));
		expect(after.length).toBe(chaptersBefore);

		// The original is untouched: still its own parent's child, still starting
		// where it started.
		const original = await chapterRow(env.chapterId);
		expect(original.parentChapterId).toBe(before.parentChapterId);
		expect(original.startCommitSha).toBe(before.startCommitSha);
		expect(original.commitCount).toBe(before.commitCount);
		expect(await messagesOf(env.narratorId)).toEqual(env.messages);

		// The retargeted edge points back at the original, or the graph would claim
		// the upstream forked into a chapter that no longer exists.
		const edge = present(
			await db.query.chapterEdges.findFirst({ where: eq(chapterEdges.id, edgeId) }),
			"inbound fork edge",
		);
		expect(edge.targetId).toBe(env.chapterId);

		// And no orphan branches or worktrees are left in the repository.
		const branches = await git(["branch", "--format=%(refname:short)"], env.gitPath);
		expect(branches.split("\n").filter((b) => b.includes("upto-"))).toEqual([]);
		expect(existsSync(resolve(env.gitPath, ".worktrees", "alternative-approach"))).toBe(false);
	});
});
