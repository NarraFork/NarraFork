/**
 * Running a commit-requiring git operation over a dirty workspace.
 *
 * Rebase and cherry-pick are the two chapter operations with *no* snapshot-space
 * equivalent, and that is not an implementation gap. Both are defined as replaying a
 * commit sequence, so commits are their entire output. Merging could drop the commit
 * because "combine two states" is expressible as a tree operation; "put my commits on
 * top of yours" cannot be.
 *
 * What actually blocked users is narrower and fixable: git refuses both operations
 * outright while the workspace is dirty, so a chapter with uncommitted work could not
 * be rebased at all — and the uncommitted state is precisely what the snapshot DAG
 * already records. So: park the dirty state in the DAG, hand git a clean workspace,
 * then three-way reapply the parked work onto the rewritten history.
 *
 * The reapply is a three-way merge rather than a restore, and the difference is the
 * whole point: restoring the parked tree would undo everything the operation just
 * brought in. With `base` = the clean state git was handed, `ours` = the workspace
 * after the operation and `theirs` = the parked work, git keeps both sides and reports
 * only genuine overlaps.
 *
 * Every tree involved is a *snapshot* tree, including the base. Reading the base from
 * git's own HEAD instead would be the obvious shortcut and is wrong: a shadow
 * repository builds its index from scratch under its own exclude rules, so a file that
 * git tracks despite matching an ignore rule appears in HEAD's tree and not in any
 * snapshot. Mixed into a three-way merge that difference reads as "theirs deleted it",
 * and the reapply would delete a tracked file.
 *
 * Once the work is parked, nothing here is lossy on failure: the snapshot stays in the
 * DAG and its commit id is reported, so even a caller that cannot reapply can tell the
 * user exactly where their work is. Getting *to* that point is the dangerous part, and
 * it is not automatically safe. `reset --hard` destroys the only other copy, so parking
 * is sound only while the snapshot provably covers everything the reset will touch —
 * and "the snapshot commit resolves to a tree", which is all that used to be checked,
 * does not establish that. A shadow repository builds its index under its own mirrored
 * exclude rules, so a path the user's repository tracks despite an ignore rule
 * (`git add -f dist/out.txt` with `dist/` in `.gitignore`) can be dirty in git's view
 * and absent from the tree; the capture succeeds, the tree hash verifies, and the reset
 * rewrites the file from HEAD with the edit held nowhere. So the check is now on the
 * *paths*: every path `git status` reports is confirmed present in the parked tree, and
 * a shortfall refuses the park.
 *
 * Refusing is the whole design, not a fallback. There is no honest alternative — the
 * bytes exist in one place and the next step overwrites it — and a rebase that declines
 * to start costs the user a commit or a stash, while one that runs costs them work they
 * cannot get back. The capture layer force-adds tracked-but-ignored paths, so in
 * practice most such workspaces park successfully; this check is what makes that a
 * verified property rather than an assumption about another module's behaviour, and it
 * still catches the residue (a tracked path that has become a git repository of its own,
 * which no exclude rule can rescue).
 *
 * The other two refusals have the same shape — cheaper to decline than to corrupt:
 *
 *   - An operation already in progress (a conflicted merge, cherry-pick, revert or
 *     rebase). `reset --hard` silently removes `MERGE_HEAD`/`CHERRY_PICK_HEAD`, which
 *     is the only record of what was being combined, and leaves `rebase-merge/` behind
 *     so the *next* rebase dies with exit 128 demanding a manual `rm -fr`.
 *   - A workspace that is dirty only in ways git does not actually mind. Untracked
 *     files do not block a rebase — git replays over them and leaves them alone — so
 *     parking them buys nothing and spends a reset+clean round trip to buy it.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ValidationError } from "../lib/errors";
import { requireCompleteMergeTree } from "../lib/git-tree-merge";
import { logger } from "../lib/logger";
import { safeSpawn } from "../lib/spawn";
import { advanceChapterSnapshot, ensureChapterSnapshot } from "./chapter-snapshot-ref";
import { gitService } from "./git-service";
import { SNAPSHOT_HEAD_REF, worktreeTreeSnapshot } from "./worktree-tree-snapshot";

/** Ceiling for the git invocations this module makes directly. */
const GIT_TIMEOUT_MS = 15_000;
/**
 * Capture ceiling for a `status --porcelain -z` listing.
 *
 * Generous because the listing is *parsed* for a safety decision: a truncated one
 * cannot be validated, so exceeding this refuses the park rather than proceeding on
 * a partial view of what is dirty.
 */
const MAX_STATUS_BYTES = 8 * 1024 * 1024;
/** How many offending paths an error message names before summarising the rest. */
const MAX_REPORTED_PATHS = 10;

/** Uncommitted work moved aside so a commit-requiring git operation can run. */
export interface ParkedWork {
	/** Snapshot commit holding the dirty state. Report this if reapplying fails. */
	commitSha: string;
	/** Tree of the dirty state — the incoming side of the reapply. */
	treeHash: string;
	/**
	 * Tree of the clean workspace handed to git — the merge base of the reapply.
	 *
	 * Captured as a snapshot after the reset rather than derived from HEAD, so all
	 * three sides of the reapply come from the same index-building rules. See the
	 * module comment for what goes wrong otherwise.
	 */
	baseTree: string;
}

/** Outcome of putting parked work back after the operation rewrote history. */
export interface ReapplyResult {
	/** Paths git could not reconcile. Non-empty means nothing was written. */
	conflicts: string[];
	/** Paths that changed on disk. Empty when `conflicts` is non-empty. */
	changedFiles: string[];
}

/** One path `git status --porcelain` reports, with the part of its code that matters. */
interface DirtyPath {
	/** Path relative to the worktree root, unescaped and unquoted. */
	path: string;
	/**
	 * Whether the path is untracked (`??`) rather than a change to a tracked file.
	 *
	 * The distinction decides whether parking is needed at all: git replays commits
	 * over untracked files happily.
	 */
	untracked: boolean;
	/**
	 * Whether the path is expected to be *absent* from a snapshot of this workspace.
	 *
	 * True for a deletion, whose correct representation in a captured tree is "no such
	 * entry". Without this the coverage check would flag every deleted file as
	 * uncovered and refuse every park that includes one.
	 */
	expectedAbsent: boolean;
	/** Whether git reports the path as unmerged (`U`), i.e. mid-operation. */
	unmerged: boolean;
}

/**
 * Parse `git status --porcelain -z` into paths.
 *
 * `-z` rather than the line-oriented form, and the reason is a correctness one rather
 * than a stylistic one: the default `core.quotePath` renders a non-ASCII name as an
 * escaped, quoted C string (`"\344\270\255..."`), which is not a real path — comparing
 * it against a tree listing would report every CJK-named file as uncovered and refuse
 * every park in a repository that has one. `-z` emits raw bytes and no quoting.
 *
 * Renames are the other trap: `XY <new>\0<old>\0` puts *two* NUL-separated fields in
 * one record, so a naive split treats the old name as a status record and misparses
 * everything after it. Both halves matter here — the new path must be in the snapshot
 * and the old one must be gone from it — so both are emitted.
 */
function parsePorcelainZ(stdout: string): DirtyPath[] {
	const fields = stdout.split("\0");
	const entries: DirtyPath[] = [];
	for (let i = 0; i < fields.length; i++) {
		const record = fields[i];
		// The trailing NUL leaves an empty tail; a record shorter than "XY " is not one.
		if (record.length < 4) continue;
		const index = record[0];
		const worktree = record[1];
		const path = record.slice(3);
		const isRename = index === "R" || index === "C" || worktree === "R" || worktree === "C";
		if (isRename) {
			// The source path follows in its own field and is consumed here so the loop
			// does not read it as a status record.
			const from = fields[++i];
			if (from) {
				entries.push({ path: from, untracked: false, expectedAbsent: true, unmerged: false });
			}
			entries.push({ path, untracked: false, expectedAbsent: false, unmerged: false });
			continue;
		}
		const untracked = index === "?" && worktree === "?";
		const unmerged =
			index === "U" ||
			worktree === "U" ||
			(index === "A" && worktree === "A") ||
			(index === "D" && worktree === "D");
		// A deletion staged *and* still deleted on disk is absent from the workspace, so
		// a capture legitimately omits it. `D ` with the file restored on disk (`DM`… is
		// not expressible, but `D` in the index with content back is) still has bytes to
		// cover, so only the worktree column deciding "gone" counts as expected-absent.
		const expectedAbsent = worktree === "D" || (index === "D" && worktree === " ");
		entries.push({ path, untracked, expectedAbsent, unmerged });
	}
	return entries;
}

/** Paths git reports as dirty in a worktree. */
async function listDirtyPaths(worktreePath: string): Promise<DirtyPath[]> {
	// `-uall` rather than the default: an untracked *directory* is reported as a single
	// `?? dir/` record, which names nothing that can be looked up in a tree. Expanding
	// to files makes every entry a real path, which is what the coverage check compares.
	const result = await safeSpawn({
		cmd: ["git", "--no-optional-locks", "status", "--porcelain", "-z", "-uall"],
		cwd: worktreePath,
		timeout: GIT_TIMEOUT_MS,
		maxOutputBytes: MAX_STATUS_BYTES,
	});
	if (result.exitCode !== 0) {
		throw new ValidationError(`Could not read the workspace's status: ${result.stderr.trim()}`);
	}
	if (result.stdoutTruncated) {
		throw new ValidationError(
			"The workspace has more uncommitted changes than can be checked safely; commit or stash them first",
		);
	}
	return parsePorcelainZ(result.stdout);
}

/**
 * Whether a worktree holds anything git would refuse to rebase or cherry-pick over.
 *
 * The index counts as much as the working tree: git rejects a staged-only change just
 * as firmly as an unstaged one, and porcelain reports both.
 *
 * Untracked files deliberately do *not* count. git replays commits straight over them
 * and leaves them byte-identical, so treating them as an obstacle sent a workspace
 * through a reset + `clean -fd` + snapshot round trip to achieve nothing — while taking
 * on every risk that round trip carries. The one case where an untracked file really
 * does block the operation is a collision: the incoming history creates a path that
 * already exists untracked, and git refuses with "untracked working tree files would be
 * overwritten". That is reported by git *before* it changes anything (verified: HEAD,
 * the file and the status are all unchanged after the failure), so the caller can park
 * and retry — see {@link untrackedCollisions}.
 */
export async function hasUncommittedWork(worktreePath: string): Promise<boolean> {
	const dirty = await listDirtyPaths(worktreePath);
	return dirty.some((entry) => !entry.untracked);
}

/**
 * Untracked paths that `ref` also contains, i.e. the ones that will block a checkout.
 *
 * The reason {@link hasUncommittedWork} can ignore untracked files at all. They are
 * harmless right up until the incoming history creates the same path, at which point
 * git refuses the whole operation with "untracked working tree files would be
 * overwritten" — before changing anything, so this is a decision the caller can make
 * either up front (call this) or on retry (park with `force: true` and try again).
 *
 * Answered by comparing trees rather than by matching git's error text, deliberately:
 * that message is localised, so a `git` running under a non-English locale prints it
 * translated and any regex over it silently stops recognising the one case parking is
 * still needed for. Comparing paths against `ref` is locale-independent.
 *
 * Returns an empty list when `ref` does not resolve — an unknown ref is the caller's
 * problem to report, not a reason to claim a collision.
 */
export async function untrackedCollisions(worktreePath: string, ref: string): Promise<string[]> {
	const untracked = (await listDirtyPaths(worktreePath))
		.filter((entry) => entry.untracked)
		.map((entry) => entry.path);
	if (untracked.length === 0) return [];
	const result = await safeSpawn({
		// `:(literal)` disables pathspec globbing, so a name containing `*`, `?` or `[`
		// is looked up as itself instead of as a pattern that matches other files.
		cmd: [
			"git",
			"--no-optional-locks",
			"ls-tree",
			"-r",
			"--name-only",
			"-z",
			ref,
			"--",
			...untracked.map((path) => `:(literal)${path}`),
		],
		cwd: worktreePath,
		timeout: GIT_TIMEOUT_MS,
		maxOutputBytes: MAX_STATUS_BYTES,
	});
	if (result.exitCode !== 0 || result.stdoutTruncated) return [];
	const present = new Set(result.stdout.split("\0").filter(Boolean));
	return untracked.filter((path) => present.has(path));
}

/**
 * State files whose presence means a multi-step git operation is mid-flight.
 *
 * Probed by path rather than by `rev-parse --verify`, and the difference is
 * load-bearing: `REBASE_HEAD` still resolves *after* a rebase finishes (verified — it
 * survives both `rebase --continue` and a clean rebase), so verifying a ref would
 * report a long-finished rebase as in progress and refuse forever. The `rebase-merge/`
 * and `rebase-apply/` directories are removed when the rebase ends, so they are the
 * honest signal.
 *
 * `BISECT_LOG` is deliberately absent: a bisect does not hold an uncommitted
 * combination, and resetting during one loses nothing the user cannot redo with
 * `bisect replay`.
 */
const IN_PROGRESS_STATE_FILES = [
	"MERGE_HEAD",
	"CHERRY_PICK_HEAD",
	"REVERT_HEAD",
	"rebase-merge",
	"rebase-apply",
	"sequencer",
] as const;

/**
 * Names of git operations currently in progress in a worktree.
 *
 * Resolved through `rev-parse --git-path` rather than by joining `.git/…` onto the
 * worktree, because a NarraFork chapter is a *linked* worktree: its `.git` is a file
 * and these files live in `<main>/.git/worktrees/<name>/` (verified). Building the
 * path by hand would look at a directory that never contains them, so every check
 * would pass and the guard would be decorative.
 */
async function inProgressOperations(worktreePath: string): Promise<string[]> {
	const args: string[] = ["rev-parse"];
	for (const name of IN_PROGRESS_STATE_FILES) args.push("--git-path", name);
	const result = await safeSpawn({
		cmd: ["git", "--no-optional-locks", ...args],
		cwd: worktreePath,
		timeout: GIT_TIMEOUT_MS,
		maxOutputBytes: 64 * 1024,
	});
	if (result.exitCode !== 0) return [];
	const paths = result.stdout.split("\n").map((line) => line.trim());
	const found: string[] = [];
	for (let i = 0; i < IN_PROGRESS_STATE_FILES.length; i++) {
		const candidate = paths[i];
		if (!candidate) continue;
		// `--git-path` returns a path relative to the repository when git was invoked
		// from its root, so it is resolved against the worktree before being tested.
		if (existsSync(resolve(worktreePath, candidate))) found.push(IN_PROGRESS_STATE_FILES[i]);
	}
	return found;
}

/** `n` paths for a message, with the tail summarised rather than dumped. */
function describePaths(paths: string[]): string {
	const shown = paths.slice(0, MAX_REPORTED_PATHS).join(", ");
	if (paths.length <= MAX_REPORTED_PATHS) return shown;
	return `${shown} (and ${paths.length - MAX_REPORTED_PATHS} more)`;
}

/**
 * Dirty paths that a snapshot of this workspace does not hold.
 *
 * The check the whole module hinges on. A snapshot tree is built by the shadow
 * repository under *its* exclude rules, and those are a mirror of the user's ignore
 * sources — not the user's index. So a path git tracks despite matching an ignore rule
 * (`git add -f dist/out.txt` with `dist/` ignored) is reported dirty by `git status`
 * and is absent from every snapshot. `reset --hard` would then rewrite it from HEAD
 * with no copy of the uncommitted bytes anywhere.
 *
 * Deletions are excluded by construction rather than by probing: "not in the tree" is
 * the *correct* representation of a deleted file, so treating absence as a miss would
 * refuse every park involving one.
 *
 * Untracked paths are excluded too. They are not what makes a workspace unoperable, and
 * `clean -fd` (which is what removes them) only ever removes non-ignored ones — exactly
 * the set a snapshot does hold. Any that a snapshot happens to miss is by definition
 * ignored, and therefore also survives the clean.
 */
async function uncoveredDirtyPaths(
	worktreePath: string,
	treeHash: string,
	dirty: DirtyPath[],
): Promise<string[]> {
	const mustBePresent = dirty
		.filter((entry) => !entry.expectedAbsent && !entry.untracked)
		.map((entry) => entry.path);
	if (mustBePresent.length === 0) return [];
	// `listPathsIn` is the bounded query: it costs the size of the requested set rather
	// than a full tree listing, which on a large repository is megabytes of path names.
	const present = new Set(
		await worktreeTreeSnapshot.listPathsIn(worktreePath, treeHash, mustBePresent),
	);
	// A directory-shaped entry (an unregistered nested repository is recorded as a
	// gitlink at its own path) reports back as the path itself, so a plain set test is
	// enough; only a path with no match at all is genuinely missing.
	return mustBePresent.filter((path) => !present.has(path));
}

/**
 * Record the workspace in the DAG, then reset git to HEAD so it is operable.
 *
 * Three preconditions are checked before a single file is touched, because the reset is
 * `--hard` and destroys the only other copy of whatever it rewrites:
 *
 *   1. No git operation is already in progress. Resetting through one erases the state
 *      that describes it and can leave residue that breaks the *next* operation.
 *   2. The snapshot resolves to a tree in the shadow repository — a capture that
 *      silently failed must not be mistaken for a safe one.
 *   3. That tree contains every dirty path git reported. This is what "resolves to a
 *      tree" does not establish: a workspace whose dirty paths the shadow index cannot
 *      hold still produces a perfectly valid tree of everything else.
 *
 * Any of them failing throws. Refusing is the right outcome rather than a limitation:
 * the alternative is a rebase that runs and silently eats uncommitted work, and a
 * user who is told to commit or stash first loses nothing.
 *
 * Returns null when there is nothing git would refuse to operate over. Pass
 * `force: true` to park an untracked-only workspace as well, which is worth its cost
 * only after git has actually reported an untracked collision.
 *
 * **The caller must already hold `worktreeLock` for `worktreePath`.** Both production
 * callers (`routes/ruler`'s rebase endpoint and `chapter-merge`'s cherry-pick) do, and
 * they have to: the capture → verify → `reset --hard` → re-capture sequence is only sound
 * while nothing else writes the workspace between steps, and the reset destroys the only
 * other copy of what the capture recorded. Hence the `*Unlocked` git calls below and no
 * acquire of its own — taking the lock here would queue behind its own caller forever.
 *
 * A "callerHoldsLock" boolean parameter was the alternative and was rejected: it makes
 * the dangerous value (`false`, meaning "acquire") the one a caller gets by omitting the
 * argument, so a new lock-holding caller that forgets it deadlocks. A hard precondition
 * fails the other way — a caller that does *not* hold the lock gets weaker mutual
 * exclusion, which the existing preconditions (in-progress-operation check, snapshot
 * verification, dirty-path coverage check) already refuse to proceed through. It also
 * keeps one code path instead of two, so the locked and unlocked behaviours cannot
 * diverge.
 */
export async function parkUncommittedWork(
	worktreePath: string,
	message: string,
	options?: { force?: boolean },
): Promise<ParkedWork | null> {
	const dirty = await listDirtyPaths(worktreePath);
	const blocking = dirty.filter((entry) => !entry.untracked);
	if (blocking.length === 0 && !(options?.force && dirty.length > 0)) return null;

	// Checked before the snapshot, not after: capturing is the expensive step and there
	// is no point paying for it when the answer is going to be a refusal either way.
	const inProgress = await inProgressOperations(worktreePath);
	if (inProgress.length > 0) {
		throw new ValidationError(
			`This workspace is in the middle of a git operation (${inProgress.join(", ")}). ` +
				"Finish or abort it first — resetting the worktree now would discard the operation's state and leave residue that breaks the next one.",
		);
	}
	// Unmerged paths only occur mid-operation, so reaching here with one means the state
	// files were removed without the index being cleaned up. Resetting would look like it
	// worked and quietly drop one side of a conflict.
	const unmerged = dirty.filter((entry) => entry.unmerged).map((entry) => entry.path);
	if (unmerged.length > 0) {
		throw new ValidationError(
			`This workspace has unmerged paths (${describePaths(unmerged)}). Resolve them and commit, or reset the merge, before running this operation.`,
		);
	}

	const parked = await ensureChapterSnapshot(worktreePath, message);
	if (!parked) {
		throw new ValidationError(
			"Could not capture the workspace's uncommitted changes; commit or stash them first",
		);
	}
	// Verified rather than assumed: the next step destroys the only other copy.
	const verified = await worktreeTreeSnapshot
		.treeOfSnapshot(worktreePath, parked.commitSha)
		.catch(() => null);
	if (!verified) {
		throw new ValidationError(
			"The workspace snapshot could not be verified, so it is not safe to reset the worktree",
		);
	}
	// And verified to be *about the right files*. `verified` is the tree the commit
	// resolves to; comparing against `parked.treeHash` alone would only confirm the two
	// agree, not that either covers the workspace.
	const uncovered = await uncoveredDirtyPaths(worktreePath, verified, blocking);
	if (uncovered.length > 0) {
		// Deliberately does not assert *why* each path is missing. The common cause is an
		// ignore rule over a tracked path, but a nested git repository at a tracked path
		// produces the same absence, and naming only one cause would send the user looking
		// for a `.gitignore` entry that is not there.
		throw new ValidationError(
			`Cannot safely set aside uncommitted changes to ${describePaths(uncovered)}: ` +
				"the workspace snapshot does not contain these paths (typically because they are tracked by git but match an ignore rule), " +
				"so resetting the worktree would destroy the changes with no copy anywhere. " +
				"Commit or stash them first, or stop ignoring them.",
		);
	}

	const head = (await gitService.getHeadCommit(worktreePath)).trim();
	// Unlocked: the caller owns `worktreeLock` for this worktree (see the doc comment).
	// These two must also be adjacent under one holder — a write landing between the reset
	// and the clean would be deleted by the clean without ever having been snapshotted.
	await gitService.resetHardUnlocked(worktreePath, head);
	// `reset --hard` leaves untracked files in place, and git refuses to check out over
	// one that the incoming history also creates. They are in the snapshot, so removing
	// them costs nothing and is what lets the operation proceed.
	await gitService.cleanUntrackedUnlocked(worktreePath);

	// The clean state, in the same terms as the other two sides of the reapply.
	const base = await worktreeTreeSnapshot.tryCapture(worktreePath);
	if (!base) {
		// Nothing has been lost — put the work back rather than leaving a reset worktree.
		await worktreeTreeSnapshot.materializeTree(worktreePath, parked.treeHash).catch((err) =>
			logger.error("Could not restore parked work after failing to capture a base", {
				worktreePath,
				snapshotCommitSha: parked.commitSha,
				error: String(err),
			}),
		);
		throw new ValidationError(
			`Could not record the workspace's clean state. Your uncommitted work is in snapshot ${parked.commitSha.slice(0, 12)}.`,
		);
	}

	logger.info("Parked uncommitted work in the snapshot DAG", {
		worktreePath,
		snapshotCommitSha: parked.commitSha,
		baseTree: base,
	});
	return { commitSha: parked.commitSha, treeHash: parked.treeHash, baseTree: base };
}

/**
 * Three-way reapply parked work onto the workspace as it now stands.
 *
 * On conflict nothing is written and the paths are returned: writing a conflicted tree
 * would put markers into files the user never asked to merge, and the parked snapshot
 * is intact for them to recover from.
 */
export async function reapplyParkedWork(
	worktreePath: string,
	parked: ParkedWork,
): Promise<ReapplyResult> {
	const current = await worktreeTreeSnapshot.tryCapture(worktreePath);
	if (!current) {
		throw new ValidationError(
			`Could not capture the workspace after the operation. Your uncommitted work is preserved in snapshot ${parked.commitSha.slice(0, 12)}.`,
		);
	}

	// Nothing to reapply when the operation happened to land on the parked state — but
	// the lineage still has to move. Parking advanced the chapter's pointer twice (to
	// the dirty state, then to the clean base captured after the reset), so returning
	// here without advancing leaves the chapter recorded at the *reset* state while the
	// parked work is back on disk. A fork taken afterwards would then start from a state
	// the user has already edited past. Linking an unchanged tree is cheap: the DAG
	// reuses the existing head when the tree matches.
	if (current === parked.treeHash) {
		await advanceChapterSnapshot(worktreePath, current, "reapplied uncommitted work");
		return { conflicts: [], changedFiles: [] };
	}

	const merged = await worktreeTreeSnapshot.mergeTreesWithBase(
		worktreePath,
		parked.baseTree,
		current,
		parked.treeHash,
	);
	const tree = requireCompleteMergeTree(merged);
	if (merged.hasConflicts) {
		return { conflicts: merged.conflicts, changedFiles: [] };
	}

	const changedFiles = await worktreeTreeSnapshot.materializeTree(worktreePath, tree);
	await advanceChapterSnapshot(worktreePath, tree, "reapplied uncommitted work");
	return { conflicts: [], changedFiles };
}

/**
 * Reapply work parked by an earlier operation, given only its stored coordinates.
 *
 * Exists because the conflict path cannot settle itself. A conflicted rebase stops with
 * the worktree mid-rebase on purpose, and the narrator is then told to finish it with
 * `rebase --continue` — so no NarraFork request runs at the moment the rebase actually
 * ends, and there is nowhere to hook the reapply onto. The coordinates therefore stay
 * in the database and are settled at the next operation that touches the chapter.
 *
 * Safe to run late because the reapply is a three-way merge, not a restore: work done
 * between the rebase and the settle is the `ours` side and survives. Returns null when
 * the parked snapshot no longer resolves, which the caller should report rather than
 * treat as success.
 */
export async function settleParkedWork(
	worktreePath: string,
	commitSha: string,
	baseTree: string,
): Promise<ReapplyResult | null> {
	const treeHash = await worktreeTreeSnapshot
		.treeOfSnapshot(worktreePath, commitSha)
		.catch(() => null);
	if (!treeHash) return null;
	return reapplyParkedWork(worktreePath, { commitSha, treeHash, baseTree });
}

/**
 * Put the workspace back exactly as it was before parking.
 *
 * For when the operation itself failed: the caller wants no trace of the attempt, and
 * the parked tree is the pre-operation state by construction.
 */
export async function restoreParkedWork(worktreePath: string, parked: ParkedWork): Promise<void> {
	await worktreeTreeSnapshot.materializeTree(worktreePath, parked.treeHash);
	// Pointed back at the parked commit rather than left wherever the failed attempt
	// took it, so the lineage names the state actually on disk.
	await worktreeTreeSnapshot
		.setRef(worktreePath, SNAPSHOT_HEAD_REF, parked.commitSha)
		.catch((err) =>
			logger.debug("Could not rewind the snapshot head after restoring parked work", {
				worktreePath,
				error: String(err),
			}),
		);
	await advanceChapterSnapshot(worktreePath, parked.treeHash, "restored after a failed operation");
}
