/**
 * Commit-free chapter merging.
 *
 * Merging used to require a commit for a mechanical reason: `git merge` reads branch
 * tips, so anything not yet committed was invisible to it. The existing path
 * therefore either refused a dirty chapter or silently committed on the user's
 * behalf — both write to the user's history to satisfy NarraFork's bookkeeping.
 *
 * Here the unit of state is a snapshot commit in the shadow DAG instead. Because
 * those snapshots have ancestry, git can compute a merge base between two workspaces
 * that never committed anything, and the whole merge happens without touching the
 * user's history at all.
 *
 * What this module deliberately does *not* do:
 *   - It never writes a conflicted tree to disk without being asked. A conflicted
 *     tree contains conflict markers; checking it out silently would corrupt the very
 *     files it claims to merge.
 *   - It never removes a source worktree before that worktree's bytes are provably in
 *     the DAG. In commit-free mode the branch tip does not contain them, so the
 *     snapshot is the only copy.
 *
 * `cherry-pick` is not handled here: it replays a commit sequence, which has no
 * snapshot equivalent. Callers keep routing it to the commit path.
 */
import { eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, projects } from "../db/schema";
import { catalogError, NotFoundError, ValidationError } from "../lib/errors";
import {
	type GitTreeMergeResult,
	requireCompleteMergeTree,
	requireMarkerResolvableTree,
} from "../lib/git-tree-merge";
import { logger } from "../lib/logger";
import { advanceChapterSnapshot, ensureChapterSnapshot } from "./chapter-snapshot-ref";
import { gitService } from "./git-service";
import {
	SNAPSHOT_HEAD_REF,
	snapshotIncomingRef,
	TreeSnapshotError,
	worktreeTreeSnapshot,
} from "./worktree-tree-snapshot";

type ChapterRow = typeof chapters.$inferSelect;

/** Conflict-marker lines git writes into a merged blob. */
const CONFLICT_START = "<<<<<<< ";
const CONFLICT_END = ">>>>>>> ";

/** Largest file this module will read when scanning for conflict markers. */
const MAX_MARKER_SCAN_BYTES = 8 * 1024 * 1024;

/** A merge computed in snapshot space, not yet applied to any worktree. */
export interface SnapshotMergePlan extends GitTreeMergeResult {
	/** Snapshot the target was at before anything was applied. */
	preMergeTree: string;
	/** Target's snapshot commit, one side of the merge. */
	targetSnapshot: string;
	/** Source's snapshot commit as present in the target's shadow repo. */
	sourceSnapshot: string;
}

async function getProjectGitPath(projectId: string): Promise<string> {
	const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
	if (!project?.gitPath) throw new ValidationError("Project has no git repository configured");
	return project.gitPath;
}

/**
 * The chapters' shared git commit, imported into the target's shadow repository.
 *
 * Serves as the merge base when the two snapshot lineages are unrelated. Returns null
 * when the branches share no history either, or when the import fails — the caller
 * then lets the merge report that it has no base rather than inventing one.
 */
async function resolveBranchMergeBase(
	source: ChapterRow,
	target: ChapterRow,
	targetWorktree: string,
): Promise<string | null> {
	try {
		const gitPath = await getProjectGitPath(source.projectId);
		const baseSha = (await gitService.getMergeBase(gitPath, target.branch, source.branch)).trim();
		if (!/^[0-9a-f]{40}$/.test(baseSha)) return null;
		return await worktreeTreeSnapshot.importCommitFromRepo(
			targetWorktree,
			gitPath,
			baseSha,
			snapshotIncomingRef(`base-${source.id}`),
		);
	} catch (err) {
		logger.debug("Could not resolve a branch merge base for the snapshot merge", {
			sourceChapterId: source.id,
			targetChapterId: target.id,
			error: String(err),
		});
		return null;
	}
}

/**
 * Bring both chapters' current workspaces into the DAG and compute the merge.
 *
 * Both sides are re-captured first, and that is load-bearing rather than tidy. The
 * merge result is adopted wholesale by the caller, so any file present on disk but
 * absent from the snapshots would fall outside it — a file the user created in the
 * target while the merge was being prepared would simply not be in the merged tree.
 * Capturing first puts those files into the three-way merge, where they survive.
 *
 * Nothing is written to a worktree here.
 */
export async function planSnapshotMerge(
	source: ChapterRow,
	target: ChapterRow,
): Promise<SnapshotMergePlan> {
	const sourceWorktree = source.worktreePath;
	const targetWorktree = target.worktreePath;
	if (!sourceWorktree) {
		throw new ValidationError(
			"Source chapter has no worktree, so its current state cannot be captured for a snapshot merge",
		);
	}
	if (!targetWorktree) throw new ValidationError("Target chapter has no worktree");

	const sourceAdvance = await ensureChapterSnapshot(sourceWorktree, "pre-merge source state");
	if (!sourceAdvance) {
		throw new ValidationError(
			"Could not capture the source chapter's workspace; a snapshot merge needs it",
		);
	}
	const targetAdvance = await ensureChapterSnapshot(targetWorktree, "pre-merge target state");
	if (!targetAdvance) {
		throw new ValidationError(
			"Could not capture the target chapter's workspace; a snapshot merge needs it",
		);
	}

	// Copy the source lineage into the target's shadow repo. Shadow repos share no
	// objects, so without this the two commits are mutually invisible and no merge
	// base exists. `fetch` copies rather than references, so the result stays valid if
	// the source repo is later removed.
	const incoming = await worktreeTreeSnapshot.fetchSnapshotFrom(
		targetWorktree,
		sourceWorktree,
		SNAPSHOT_HEAD_REF,
		snapshotIncomingRef(source.id),
	);
	if (!incoming) {
		throw new ValidationError("Could not transfer the source chapter's snapshot lineage");
	}

	// Two chapters only share a snapshot ancestor when one was forked from the other.
	// Independently created chapters each start their own lineage, so their real
	// branches' merge base has to stand in — otherwise git refuses to merge what it
	// sees as unrelated histories. Imported into the shadow repo because the two object
	// stores are separate by design.
	const fallbackBase = await resolveBranchMergeBase(source, target, targetWorktree);

	const merged = await worktreeTreeSnapshot.mergeSnapshots(
		targetWorktree,
		targetAdvance.commitSha,
		incoming,
		undefined,
		fallbackBase ?? undefined,
	);

	return {
		preMergeTree: targetAdvance.treeHash,
		targetSnapshot: targetAdvance.commitSha,
		sourceSnapshot: incoming,
		...merged,
	};
}

/**
 * Apply a clean merge result and record it in the DAG.
 *
 * The snapshot commit gets *two* parents. That is not decoration: with a single
 * parent the next merge recomputes a base that predates this combination and reports
 * conflicts that were already resolved here.
 */
export async function applySnapshotMerge(
	targetWorktree: string,
	plan: SnapshotMergePlan,
	message: string,
): Promise<{ commitSha: string; changedFiles: string[] }> {
	const tree = requireCompleteMergeTree(plan);
	if (plan.hasConflicts || plan.conflicts.length > 0) {
		throw new ValidationError("Refusing to apply a conflicted merge tree");
	}
	// Guarded on the state the plan was computed from. `planSnapshotMerge` captures the
	// target precisely so files present only on disk take part in the three-way merge,
	// but that makes the result specific to that capture: anything written afterwards is
	// outside the merged tree, and materialising it would delete the file rather than
	// merge it. Aborting instead lets the caller retry against the newer state, which is
	// cheap; the alternative is silent loss.
	const changedFiles = await worktreeTreeSnapshot.materializeTree(
		targetWorktree,
		tree,
		undefined,
		plan.preMergeTree,
	);
	const commitSha = await worktreeTreeSnapshot.commitSnapshot(
		targetWorktree,
		tree,
		[plan.targetSnapshot, plan.sourceSnapshot],
		message,
	);
	await worktreeTreeSnapshot.setRef(targetWorktree, SNAPSHOT_HEAD_REF, commitSha);
	await advanceChapterSnapshot(targetWorktree, tree, message);
	return { commitSha, changedFiles };
}

/**
 * Write a conflicted tree into the worktree so a narrator or the user can resolve it.
 *
 * The conflicted tree is what git's own merge would have left on disk, markers
 * included, which is why the existing conflict-resolution prompt needs no change.
 */
export async function materializeConflicts(
	targetWorktree: string,
	result: GitTreeMergeResult,
): Promise<string[]> {
	return worktreeTreeSnapshot.materializeTree(targetWorktree, requireMarkerResolvableTree(result));
}

/** Recheck persisted conflict coverage before a marker-only session may complete. */
export async function revalidateSnapshotConflictPlan(
	source: ChapterRow,
	target: ChapterRow,
	expected: Pick<SnapshotMergePlan, "targetSnapshot" | "sourceSnapshot" | "tree" | "conflicts">,
): Promise<void> {
	if (!target.worktreePath) throw new ValidationError("Target chapter has no worktree");
	const fallbackBase = await resolveBranchMergeBase(source, target, target.worktreePath);
	const result = await worktreeTreeSnapshot.mergeSnapshots(
		target.worktreePath,
		expected.targetSnapshot,
		expected.sourceSnapshot,
		undefined,
		fallbackBase ?? undefined,
	);
	const tree = requireMarkerResolvableTree(result);
	const declared = new Set(expected.conflicts);
	if (
		!result.hasConflicts ||
		tree !== expected.tree ||
		declared.size !== expected.conflicts.length ||
		declared.size !== result.conflicts.length ||
		result.conflicts.some((path) => !declared.has(path))
	) {
		throw catalogError("GIT_TREE_MERGE_CONFLICTS_UNLISTED");
	}
}

/**
 * Which of the declared conflict paths still contain conflict markers.
 *
 * The git-based path asks `git diff --diff-filter=U`, which reads the index's
 * unmerged stages. There is no such state here — the tree was simply written to disk —
 * so that query returns nothing and would report "all conflicts resolved" no matter
 * what. Scanning the file content is the only honest answer available.
 *
 * Scoped to the paths the merge declared conflicted, so the cost tracks the conflict
 * set rather than the repository. A file that grew beyond the scan cap, or cannot be
 * read, is reported as still conflicted: refusing to finish is the safe direction,
 * since finishing would commit conflict markers into the merge result.
 */
export async function detectRemainingConflicts(
	targetWorktree: string,
	declaredPaths: string[],
): Promise<string[]> {
	const remaining: string[] = [];
	for (const relPath of declaredPaths) {
		const file = Bun.file(`${targetWorktree}/${relPath}`);
		try {
			if (!(await file.exists())) continue;
			// A resolution may legitimately delete the file; that counts as resolved.
			if (file.size > MAX_MARKER_SCAN_BYTES) {
				logger.warn("Conflict file too large to verify; treating it as unresolved", {
					targetWorktree,
					relPath,
					size: file.size,
				});
				remaining.push(relPath);
				continue;
			}
			const text = await file.text();
			// Both sentinels are required: a file may legitimately contain one of these
			// strings (documentation about conflicts, a diff fixture), but a real
			// unresolved conflict always has an opening and a closing marker.
			if (hasConflictMarkers(text)) remaining.push(relPath);
		} catch (err) {
			logger.warn("Could not read a conflict file; treating it as unresolved", {
				targetWorktree,
				relPath,
				error: String(err),
			});
			remaining.push(relPath);
		}
	}
	return remaining;
}

/** Whether text carries both an opening and a closing conflict marker at line start. */
function hasConflictMarkers(text: string): boolean {
	let sawStart = false;
	let sawEnd = false;
	for (const line of text.split("\n")) {
		if (!sawStart && line.startsWith(CONFLICT_START)) sawStart = true;
		else if (!sawEnd && line.startsWith(CONFLICT_END)) sawEnd = true;
		if (sawStart && sawEnd) return true;
	}
	return false;
}

/**
 * Undo an in-flight snapshot merge, returning the worktree to its pre-merge bytes.
 *
 * Stronger than `git merge --abort`, which can only restore what git was tracking:
 * this restores the recorded workspace, so files the user had not staged — including
 * untracked ones present when the merge began — come back as they were.
 *
 * Deliberately *not* guarded with `expectedCurrentTree`, unlike {@link applySnapshotMerge}
 * and {@link applySnapshotUnmerge}. The two cases differ in what the caller knows:
 *
 *   - An apply writes a tree computed from a specific state, so a state that moved
 *     invalidates the tree and the write must be refused.
 *   - An abort writes a tree that is correct by definition — the recorded pre-merge
 *     bytes — and runs precisely when the worktree has been edited past the conflicted
 *     tree, because a narrator or the user was part-way through resolving. Guarding it
 *     on the conflicted tree would make abort fail in exactly the situation it exists
 *     for and leave conflict markers on disk with nothing left to clean them up.
 *
 * The hazard an abort does have — replaying a stale restore over work done after an
 * earlier abort — is addressed where the coordinate lives rather than here: the
 * `merge_sessions` row's snapshot fields are cleared once consumed, so there is no
 * second abort to issue. See `chapter-batch-merge.resolveDecision`.
 */
export async function abortSnapshotMerge(
	targetWorktree: string,
	preMergeTree: string,
): Promise<string[]> {
	const restored = await worktreeTreeSnapshot.materializeTree(targetWorktree, preMergeTree);
	await advanceChapterSnapshot(targetWorktree, preMergeTree, "merge aborted");
	return restored;
}

/**
 * Make sure a source worktree's bytes are in the DAG before it is destroyed.
 *
 * `gitService.removeWorktree` always passes `--force`, so it will delete modified and
 * untracked files without complaint. After a commit-free merge the source branch tip
 * does *not* contain the merged work, which makes the snapshot the only remaining
 * copy — destroying the worktree without one is unrecoverable data loss.
 *
 * Returns the snapshot commit, or null when it could not be taken. A null answer must
 * be read as "do not delete this worktree".
 */
export async function preserveSourceBeforeRemoval(
	sourceWorktree: string,
): Promise<{ commitSha: string; treeHash: string } | null> {
	const advanced = await ensureChapterSnapshot(sourceWorktree, "source state at merge");
	if (!advanced) return null;
	// Verify the object really exists rather than trusting the write: this is the last
	// checkpoint before the bytes are deleted from disk.
	const tree = await worktreeTreeSnapshot
		.treeOfSnapshot(sourceWorktree, advanced.commitSha)
		.catch(() => null);
	if (!tree) return null;
	return { commitSha: advanced.commitSha, treeHash: tree };
}

/**
 * Put a source chapter's merged-away work back into a freshly recreated worktree.
 *
 * Recreating the worktree from the branch only restores the last commit, and a
 * commit-free merge never advanced the branch — so without this step unmerging or
 * waking the chapter hands the user back a directory missing everything they had not
 * committed.
 *
 * Never throws. The caller has already changed other state by this point (the target
 * has been reverted, the worktree exists), and failing here should surface as a
 * warning naming the snapshot rather than aborting a half-finished operation.
 */
export async function restoreSourceSnapshot(
	sourceWorktree: string,
	snapshotCommitSha: string,
): Promise<{ restored: boolean; reason?: string }> {
	try {
		const tree = await worktreeTreeSnapshot.treeOfSnapshot(sourceWorktree, snapshotCommitSha);
		if (!tree) {
			return {
				restored: false,
				reason: `snapshot ${snapshotCommitSha.slice(0, 12)} is no longer present in the shadow repository`,
			};
		}
		await worktreeTreeSnapshot.materializeTree(sourceWorktree, tree);
		await advanceChapterSnapshot(sourceWorktree, tree, "restored after unmerge");
		return { restored: true };
	} catch (err) {
		const reason = err instanceof TreeSnapshotError ? err.message : String(err);
		logger.warn("Could not restore a source chapter's snapshot", {
			sourceWorktree,
			snapshotCommitSha,
			error: reason,
		});
		return { restored: false, reason };
	}
}

/** Outcome of reversing a snapshot merge out of the target. */
export interface SnapshotUnmergePlan extends GitTreeMergeResult {
	/** Target snapshot the reversal was computed from. */
	targetSnapshot: string;
	/** Tree of that snapshot, for the drift guard when the plan is applied. */
	preUnmergeTree: string;
}

/**
 * Compute the reversal of a snapshot merge, without writing anything.
 *
 * A three-way merge whose base is **the merge result**: `base = the tree the merge
 * produced`, `ours = the target as it stands now`, `theirs = the target's state
 * immediately before the merge`. git keeps `ours` wherever base and theirs agree, so
 * base→theirs contributes exactly the inverse of what the source added, and
 * base→ours contributes everything the target did afterwards. One operation therefore
 * covers both cases the commit path needs two branches for (reset when the target has
 * not moved, revert when it has).
 *
 * The base is emphatically *not* the source snapshot that was merged in, which is the
 * obvious-looking choice and is wrong in two ways that both show up in practice:
 *
 *   - For a path the source never touched, source→theirs still differs by whatever
 *     the target had edited *before* the merge. git reads that as a theirs-side
 *     change and reintroduces it — so an edit the target made pre-merge and then
 *     deliberately undid post-merge comes back from the dead, silently.
 *   - When the source only *added* files, source→theirs and source→ours disagree
 *     about every pre-existing file, so a merge that touched nothing in common
 *     reports conflicts and the unmerge refuses to run at all.
 *
 * Both disappear with base = merge result, because the merge result agrees with the
 * pre-merge target on precisely the paths the source did not contribute to.
 *
 * All three sides are passed as trees through {@link worktreeTreeSnapshot.mergeTreesWithBase}
 * rather than as snapshot commits. The base has to be stated explicitly — deriving it
 * from ancestry would find the common ancestor of the two sides, which is a different
 * question — and trees make it impossible to mistake this for an ordinary merge.
 *
 * A conflict now means what it says: the target has since edited the very lines being
 * reversed, which is a genuine question for a human — the same situation where the
 * commit path reports that revert conflicts.
 */
export async function planSnapshotUnmerge(
	targetWorktree: string,
	mergeSnapshotCommitSha: string,
	preMergeTargetSnapshotSha: string,
): Promise<SnapshotUnmergePlan> {
	const current = await ensureChapterSnapshot(targetWorktree, "pre-unmerge target state");
	if (!current) {
		throw new ValidationError("Could not capture the target chapter's workspace before unmerging");
	}
	// Resolved rather than assumed, and a failure refuses the unmerge instead of
	// falling back to another base: every other candidate produces a *plausible but
	// wrong* tree, and writing that out is worse than declining. The merge result stays
	// reachable through `refs/nf/head` in the normal case, so this is the abnormal one
	// (a swept shadow repository, a hand-edited row).
	//
	// `mergedSourceSnapshotSha` is the obvious-looking fallback and is deliberately NOT
	// used, for two independent reasons:
	//
	//   - It is not a *source-side* coordinate despite the name. It is
	//     `planSnapshotMerge`'s `plan.sourceSnapshot`, i.e. the sha the source lineage
	//     received after being fetched INTO the target's shadow repository, and every
	//     lookup here goes through that same repository. So in the case this branch
	//     actually fires — the target's shadow repo swept or rebuilt, which
	//     `chapterService.remove` / `dismissReview` / `convertToSubagent` all do via
	//     `destroy(..., { force: true })` — it has gone with the merge result and
	//     resolves no better.
	//   - Even where it does resolve, it is the wrong base. See this function's own
	//     doc comment: with the source snapshot as base, a pre-merge target edit that
	//     was later undone is resurrected, and a source that only added files reports
	//     conflicts on paths the merge never touched. Both are silent wrong answers,
	//     which is worse than a refusal the user can act on.
	//
	// So the refusal is kept and made actionable instead: it names what is missing and
	// the coordinate in the user's *real* git history to aim at, which is the one thing
	// here that does not live in a shadow repository.
	const mergeResultTree = await worktreeTreeSnapshot
		.treeOfSnapshot(targetWorktree, mergeSnapshotCommitSha)
		.catch(() => null);
	if (!mergeResultTree) {
		throw new ValidationError(
			`This merge cannot be reversed automatically: the snapshot recording its result ` +
				`(${mergeSnapshotCommitSha.slice(0, 12)}) is no longer in the target chapter's ` +
				`snapshot store, which usually means that chapter's worktree was deleted and ` +
				`recreated. Reversing it from any other recorded state would produce a ` +
				`plausible-looking but wrong result, so nothing has been changed. ` +
				`To undo it by hand, compare the target worktree against its pre-merge commit; ` +
				`the source chapter's own work is restored separately and is unaffected by this.`,
		);
	}
	const reversed = await worktreeTreeSnapshot.mergeTreesWithBase(
		targetWorktree,
		mergeResultTree,
		current.treeHash,
		preMergeTargetSnapshotSha,
	);
	return {
		...reversed,
		targetSnapshot: current.commitSha,
		preUnmergeTree: current.treeHash,
	};
}

/** Apply a computed unmerge to the target worktree and record it in the DAG. */
export async function applySnapshotUnmerge(
	targetWorktree: string,
	plan: SnapshotUnmergePlan,
	message: string,
): Promise<string[]> {
	const tree = requireCompleteMergeTree(plan);
	if (plan.hasConflicts || plan.conflicts.length > 0) {
		throw new ValidationError("Refusing to apply a conflicted unmerge tree");
	}
	// Guarded on the state the plan was computed from: the reversal is only the correct
	// answer for that exact workspace, so a write landing in between must abort the
	// apply rather than have its work overwritten by a tree that never saw it.
	const changed = await worktreeTreeSnapshot.materializeTree(
		targetWorktree,
		tree,
		undefined,
		plan.preUnmergeTree,
	);
	const commitSha = await worktreeTreeSnapshot.commitSnapshot(
		targetWorktree,
		tree,
		[plan.targetSnapshot],
		message,
	);
	await worktreeTreeSnapshot.setRef(targetWorktree, SNAPSHOT_HEAD_REF, commitSha);
	await advanceChapterSnapshot(targetWorktree, tree, message);
	return changed;
}

/**
 * Whether both chapters can take part in a snapshot merge.
 *
 * Used to decide routing rather than to reject: a chapter with no worktree (dormant)
 * or a cherry-pick strategy has no snapshot equivalent, so those keep going through
 * the commit path instead of failing.
 */
export async function canMergeViaSnapshot(
	source: ChapterRow,
	target: ChapterRow,
	strategy: string,
): Promise<boolean> {
	if (strategy === "cherry-pick") return false;
	if (!source.worktreePath || !target.worktreePath) return false;
	// Both worktrees must actually be git workspaces on this machine; a remote or
	// missing directory has no shadow repository.
	return (
		(await gitService.isGitRepo(source.worktreePath).catch(() => false)) &&
		(await gitService.isGitRepo(target.worktreePath).catch(() => false))
	);
}

/** Conflict preview for a snapshot merge, mirroring the commit path's check. */
export async function checkSnapshotConflicts(
	sourceChapterId: string,
	targetChapterId: string,
): Promise<{ conflictFiles: string[]; hasConflicts: boolean }> {
	const source = await db.query.chapters.findFirst({ where: eq(chapters.id, sourceChapterId) });
	if (!source) throw new NotFoundError("Chapter", sourceChapterId);
	const target = await db.query.chapters.findFirst({ where: eq(chapters.id, targetChapterId) });
	if (!target) throw new NotFoundError("Chapter", targetChapterId);
	await getProjectGitPath(source.projectId);

	// Computed through the same code path the real merge uses, so the preview cannot
	// disagree with the outcome. The commit-based check compared branch tips while the
	// merge itself auto-committed first, which is exactly how it could promise a clean
	// merge and then conflict.
	const plan = await planSnapshotMerge(source, target);
	requireCompleteMergeTree(plan);
	return { conflictFiles: plan.conflicts, hasConflicts: plan.hasConflicts };
}
