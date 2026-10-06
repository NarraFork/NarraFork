import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { db } from "../db";
import { chapters, projects } from "../db/schema";
import { chapterLock, worktreeLock } from "../lib/async-mutex";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { resolveUserGitIdentityEnv } from "../lib/git-identity";
import { logger } from "../lib/logger";
import { getNarraforkPath } from "../lib/narrafork-home";
import { settings } from "../lib/settings";
import { safeSpawn } from "../lib/spawn";
import { restoreSourceSnapshot } from "./chapter-merge-snapshot";
import { ensureChapterSnapshot } from "./chapter-snapshot-ref";
import { commitSyncService } from "./commit-sync-service";
import { containerService } from "./container-service";
import { gitService } from "./git-service";
import { terminalService } from "./terminal-service";
import {
	assertLifecycleProtectionCurrent,
	confirmLifecyclePathRemoved,
	isResourceProtectionError,
	revalidateLifecycleTarget,
	withLegacyRetirement,
} from "./worktree-lifecycle-guard";
import { worktreeWatcher } from "./worktree-watcher";

export interface CleanupReport {
	cleaned: string[];
	skipped: string[];
	errors: Array<{ chapterId: string; error: string }>;
}

/** What happened to a chapter's git-ignored files while it went dormant. */
export interface IgnoredArchiveReport {
	/** Worktree-relative entries copied out before the worktree was deleted. */
	archived: string[];
	/** Entries left to be deleted with the worktree because they blew the budget. */
	skipped: string[];
	/** Absolute archive directory, or null when nothing was archived. */
	path: string | null;
}

/**
 * What a wake could not fully do, for a caller to surface.
 *
 * Additive on purpose: `wake` used to return `void`, so existing call sites that
 * ignore the value keep compiling and behaving identically, while a caller that
 * wants to tell the user "your local `secret.env` was not restored" now can.
 */
export interface WakeReport {
	warnings: string[];
}

export interface DormantReport {
	ignored: IgnoredArchiveReport;
	/**
	 * True when the branch tip does NOT carry this chapter's work and the recorded
	 * snapshot is the only copy, i.e. wake has to restore it.
	 */
	snapshotOnly: boolean;
}

/**
 * Per-entry and total budget for the ignored-file archive.
 *
 * A budget is what makes archiving viable at all: the interesting ignored files are
 * secrets and local config (bytes), while the bulk is `node_modules/` and build
 * output (gigabytes) which is reproducible and must never be copied. Enumeration is
 * done with `--directory`, so `node_modules/` is measured and rejected as one entry
 * rather than walked file by file.
 */
const IGNORED_ARCHIVE_MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const IGNORED_ARCHIVE_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/**
 * Cap on how many filesystem entries one entry's measurement may visit.
 *
 * A byte budget alone does not bound the *cost* of deciding: a `.venv/` or a
 * `.next/cache` with tens of thousands of tiny files can sit well inside 8MB while
 * costing that many synchronous `lstat`/`readdir` calls on the one thread that also
 * serves HTTP, WebSocket and SQLite. Dormant runs unattended (auto-dormant), so the
 * stall had no user to correlate it with. Blowing this cap is treated exactly like
 * blowing the byte budget: the entry is reported as skipped rather than copied.
 */
const IGNORED_ARCHIVE_MAX_ENTRIES = 5_000;

/** Where a dormant chapter's ignored files wait for its next wake. */
function ignoredArchiveDir(chapterId: string): string {
	return getNarraforkPath("dormant-ignored", chapterId);
}

async function getProjectGitPath(projectId: string): Promise<string | null> {
	const project = await db.query.projects.findFirst({
		where: eq(projects.id, projectId),
	});
	return project?.gitPath ?? null;
}

/**
 * Ignored-but-present entries in a worktree, collapsed to their topmost directory.
 *
 * `--directory` is what keeps this affordable: it reports `node_modules/` as a
 * single entry instead of a hundred thousand paths, so the size check below can
 * reject a dependency tree without walking it.
 */
async function listIgnoredEntries(worktreePath: string): Promise<string[]> {
	const result = await safeSpawn({
		cmd: ["git", "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
		cwd: worktreePath,
		timeout: 30_000,
		maxOutputBytes: 4 * 1024 * 1024,
	});
	if (result.exitCode !== 0) {
		throw new Error(`git ls-files --ignored failed: ${result.stderr.trim()}`);
	}
	return result.stdout.split("\0").filter((entry) => entry.length > 0);
}

/**
 * Bytes under `path`, giving up as soon as `limit` or the entry cap is exceeded.
 *
 * Bailing out early is the point: the caller only needs to know whether an entry
 * fits, and a `node_modules/` tree would otherwise cost a full recursive stat walk
 * just to reach a conclusion that was decided after the first few megabytes.
 *
 * The entry cap exists because the byte budget bounds the wrong quantity. A deeply
 * fragmented tree — a virtualenv, a build cache, thousands of empty marker files —
 * stays under 8MB while still forcing tens of thousands of synchronous syscalls onto
 * the main thread, where they show up as the whole server going unresponsive.
 */
function measureUpTo(path: string, limit: number): number | null {
	let total = 0;
	let visited = 0;
	const stack = [path];
	while (stack.length > 0) {
		const current = stack.pop() as string;
		// Counted before the stat, so an unreadable or vanished entry still costs its
		// syscall against the cap — the budget is about work done, not bytes found.
		if (++visited > IGNORED_ARCHIVE_MAX_ENTRIES) return null;
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(current);
		} catch {
			// Vanished mid-walk (a build still running, a temp file): nothing to archive.
			continue;
		}
		// Symlinks are copied as links rather than followed, so their target's size is
		// irrelevant — and following them could leave the worktree entirely.
		if (stat.isSymbolicLink()) continue;
		if (stat.isDirectory()) {
			try {
				for (const child of readdirSync(current)) stack.push(join(current, child));
			} catch {
				// Unreadable directory — treat as empty rather than failing the dormant.
			}
			continue;
		}
		total += stat.size;
		if (total > limit) return null;
	}
	return total;
}

/**
 * Copy a worktree's git-ignored files somewhere they survive the worktree removal.
 *
 * `git worktree remove --force` deletes ignored content outright, and none of the
 * three things that normally preserve a chapter's state cover it: tree snapshots
 * mirror the repository's ignore rules, so ignored paths are excluded by
 * construction, and the pre-dormant `git add -A` skips them for the same reason.
 * A `secret.env` or a local `config.local.json` therefore had no copy anywhere and
 * was destroyed by going dormant — which auto-dormant can do unattended.
 *
 * Archiving rather than refusing was chosen because the destructive case is
 * indistinguishable from the harmless one until the sizes are known: nearly every
 * repository has ignored content, and blocking dormant on its mere presence would
 * disable auto-dormant for everyone. Oversized entries are reported, not copied.
 *
 * Never throws: dormant must still work on a non-git directory or a git that
 * refuses to enumerate.
 */
async function archiveIgnoredFiles(
	chapterId: string,
	worktreePath: string,
): Promise<IgnoredArchiveReport> {
	const report: IgnoredArchiveReport = { archived: [], skipped: [], path: null };
	let entries: string[];
	try {
		entries = await listIgnoredEntries(worktreePath);
	} catch (err) {
		if (isResourceProtectionError(err)) throw err;
		logger.warn("Could not enumerate ignored files before making a chapter dormant", {
			chapterId,
			worktreePath,
			error: String(err),
		});
		return report;
	}
	if (entries.length === 0) return report;

	const dir = ignoredArchiveDir(chapterId);
	// A previous cycle's archive would otherwise be restored on top of this one's,
	// resurrecting files the user has since deleted.
	rmSync(dir, { recursive: true, force: true });

	let budget = IGNORED_ARCHIVE_MAX_TOTAL_BYTES;
	for (const entry of entries) {
		const relative = entry.endsWith("/") ? entry.slice(0, -1) : entry;
		const source = resolve(worktreePath, relative);
		const size = measureUpTo(source, Math.min(IGNORED_ARCHIVE_MAX_ENTRY_BYTES, budget));
		if (size === null) {
			report.skipped.push(relative);
			continue;
		}
		try {
			cpSync(source, resolve(dir, relative), {
				recursive: true,
				// The archive was just cleared, so nothing here is a real conflict; not
				// forcing keeps a surprising collision from silently overwriting.
				force: false,
				errorOnExist: false,
				dereference: false,
			});
			report.archived.push(relative);
			budget -= size;
		} catch (err) {
			if (isResourceProtectionError(err)) throw err;
			report.skipped.push(relative);
			logger.warn("Failed to archive an ignored file before making a chapter dormant", {
				chapterId,
				entry: relative,
				error: String(err),
			});
		}
	}

	if (report.archived.length > 0) {
		report.path = dir;
		logger.info("Archived a dormant chapter's ignored files", {
			chapterId,
			archived: report.archived.length,
			skipped: report.skipped.length,
			path: dir,
		});
	} else {
		rmSync(dir, { recursive: true, force: true });
	}
	if (report.skipped.length > 0) {
		// Named rather than silently dropped: for `node_modules/` this is expected, and
		// for anything else it is the user's only notice that the bytes are gone.
		logger.warn("Some ignored files were too large to archive and will be deleted", {
			chapterId,
			skipped: report.skipped.slice(0, 20),
			skippedCount: report.skipped.length,
		});
	}
	return report;
}

/**
 * Delete a chapter's ignored-file archive.
 *
 * Wake is NOT the only way a dormant chapter ends. It can be deleted, its project
 * can be deleted, or batch cleanup can mark it abandoned — and none of those used to
 * touch this directory, so the archive outlived the chapter it belonged to with no
 * reader, no UI and no sweeper. Since what it holds is precisely the content git
 * refuses to track (`secret.env`, `config.local.json`, tokens), that residue is a
 * plaintext credential copy the user believes they deleted. Every terminal
 * transition therefore has to come through here.
 *
 * Never throws: this runs inside deletion paths that must not be aborted by a
 * leftover file handle.
 */
export function discardIgnoredArchive(chapterId: string): void {
	const dir = ignoredArchiveDir(chapterId);
	if (!existsSync(dir)) return;
	try {
		rmSync(dir, { recursive: true, force: true });
		logger.info("Discarded a chapter's archived ignored files", { chapterId, path: dir });
	} catch (err) {
		if (isResourceProtectionError(err)) throw err;
		logger.warn("Failed to discard a chapter's archived ignored files", {
			chapterId,
			path: dir,
			error: String(err),
		});
	}
}

/** Outcome of putting a dormant chapter's archived ignored files back. */
export interface IgnoredRestoreReport {
	/** Worktree-relative entries written back into the worktree. */
	restored: string[];
	/**
	 * Entries NOT written back because the worktree already had that path. Their
	 * archived copies are deliberately kept, so `archivePath` still resolves.
	 */
	skipped: string[];
	/** Absolute archive directory when anything is still held there, else null. */
	archivePath: string | null;
}

/**
 * Files (and symlinks) under `dir`, as paths relative to it.
 *
 * Flattening to files rather than copying the tree wholesale is what makes a
 * per-entry decision possible: a directory-level copy cannot report which
 * individual paths it declined.
 */
function listArchiveFiles(dir: string): string[] {
	const found: string[] = [];
	const stack = [dir];
	let visited = 0;
	while (stack.length > 0) {
		const current = stack.pop() as string;
		if (++visited > IGNORED_ARCHIVE_MAX_ENTRIES) break;
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(current);
		} catch {
			continue;
		}
		if (stat.isDirectory()) {
			try {
				for (const child of readdirSync(current)) stack.push(join(current, child));
			} catch {
				// Unreadable directory — nothing to restore from it.
			}
			continue;
		}
		if (current !== dir) found.push(relative(dir, current));
	}
	return found;
}

/** Drop directories left empty after the restored files were removed. */
function pruneEmptyDirs(dir: string): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		const child = join(dir, entry);
		try {
			if (lstatSync(child).isDirectory()) pruneEmptyDirs(child);
		} catch {
			// Vanished between listing and stat — nothing to prune.
		}
	}
	try {
		if (readdirSync(dir).length === 0) rmSync(dir, { recursive: false, force: true });
	} catch {
		// Non-empty or unreadable: keeping it is the safe outcome.
	}
}

/**
 * Put a dormant chapter's archived ignored files back into its new worktree.
 *
 * Restoring per file rather than with one recursive copy, and reporting what was
 * declined, is the whole point. The previous version handed the entire directory to
 * `cpSync({ force: false, errorOnExist: false })` and then deleted the archive
 * unconditionally: when a path had meanwhile become tracked and git checked its own
 * version out, the copy silently declined that file and the following `rmSync` threw
 * the user's only copy away. The function returned `void`, so nothing anywhere could
 * even mention it.
 *
 * Declining to overwrite is still correct — what git just checked out is the branch's
 * content and must win — but the archived bytes are then still the only copy of what
 * the user had, so they stay on disk and are named in the report.
 */
function restoreIgnoredFiles(chapterId: string, worktreePath: string): IgnoredRestoreReport {
	const report: IgnoredRestoreReport = { restored: [], skipped: [], archivePath: null };
	const dir = ignoredArchiveDir(chapterId);
	if (!existsSync(dir)) return report;

	for (const rel of listArchiveFiles(dir)) {
		const source = resolve(dir, rel);
		const target = resolve(worktreePath, rel);
		// Refuse to leave the worktree: an archived symlink or a `..` component must not
		// turn a restore into a write elsewhere on the filesystem.
		const inside = relative(worktreePath, target);
		if (inside.startsWith(`..${sep}`) || inside === ".." || inside.length === 0) {
			report.skipped.push(rel);
			continue;
		}
		let exists = false;
		try {
			lstatSync(target);
			exists = true;
		} catch {
			// Absent, which is the normal case: the path is ignored, so git left no copy.
		}
		if (exists) {
			report.skipped.push(rel);
			continue;
		}
		try {
			mkdirSync(dirname(target), { recursive: true });
			cpSync(source, target, { force: false, errorOnExist: false, dereference: false });
			report.restored.push(rel);
			// Removed as it succeeds, so a later failure cannot leave a half-consumed
			// archive whose remaining entries look like collisions on the next wake.
			rmSync(source, { force: true });
		} catch (err) {
			if (isResourceProtectionError(err)) throw err;
			report.skipped.push(rel);
			logger.warn("Failed to restore one archived ignored file during wake (copy kept)", {
				chapterId,
				entry: rel,
				error: String(err),
			});
		}
	}

	if (report.skipped.length === 0) {
		rmSync(dir, { recursive: true, force: true });
	} else {
		pruneEmptyDirs(dir);
		report.archivePath = dir;
		logger.warn("Some archived ignored files were not restored; their copies are kept", {
			chapterId,
			worktreePath,
			archive: dir,
			skipped: report.skipped.slice(0, 20),
			skippedCount: report.skipped.length,
		});
	}
	if (report.restored.length > 0) {
		logger.info("Restored a woken chapter's archived ignored files", {
			chapterId,
			worktreePath,
			restored: report.restored.length,
		});
	}
	return report;
}

export const chapterCleanup = {
	/**
	 * Put a chapter to sleep, auto-committing whatever is still uncommitted.
	 *
	 * `userId` attributes that auto-save to the person who asked for the chapter to
	 * sleep. The scheduled sweep (`dormantInactiveChapters`) deliberately passes
	 * nothing: an unattended timer is not anyone's authored change, so those commits
	 * keep falling back to the host identity.
	 */
	async dormant(chapterId: string, userId?: string): Promise<DormantReport> {
		return chapterLock.acquire(chapterId, async () => {
			const chapter = await db.query.chapters.findFirst({
				where: eq(chapters.id, chapterId),
			});
			if (!chapter) throw new NotFoundError("Chapter", chapterId);
			if (chapter.isRoot) throw new ValidationError("Cannot make root chapter dormant");
			if (chapter.status !== "active")
				throw new ValidationError("Can only make active chapters dormant");
			if (!chapter.worktreePath) throw new ValidationError("Chapter has no worktree");
			const worktreePath = chapter.worktreePath;

			const gitPath = await getProjectGitPath(chapter.projectId);
			if (!gitPath) throw new ValidationError("Project has no git repository configured");

			return withLegacyRetirement([chapterId], "chapter dormant", async () => {
				// Step 1: Clean up terminals
				await terminalService.cleanupForChapter(chapterId);

				// Step 2: Stop containers.
				//
				// Ordered before `worktreePath` is nulled because every compose command is
				// resolved from the worktree: `removeChapterContainers` skips `compose down`
				// entirely when the path is null, deletes the DB rows and releases the ports
				// anyway, and leaves the actual Podman containers running on the host holding
				// those ports — which the allocator then hands to another chapter, whose
				// `compose up` fails on a port conflict nothing in NarraFork can explain.
				//
				// `pause` rather than `down` so wake can resume the same containers, matching
				// what wake already expects (`unpauseChapterContainers`).
				if (chapter.containerConfig) {
					try {
						await containerService.pauseChapterContainers(chapterId);
					} catch (err) {
						if (isResourceProtectionError(err)) throw err;
						logger.warn("Failed to pause containers during dormant", {
							chapterId,
							error: String(err),
						});
						// Still proceed — containers may have been removed externally
					}
				}

				// Step 2.5: Record the workspace in the snapshot DAG before anything removes
				// it. The auto-commit below may fail, so without a snapshot taken here a
				// chapter that goes dormant with a failing commit would have no record of its
				// uncommitted bytes anywhere.
				//
				// Taken BEFORE the commit rather than after so it captures the workspace as the
				// user left it, including files the commit would not pick up.
				const dormantSnapshot = await ensureChapterSnapshot(
					worktreePath,
					"state before going dormant",
				);
				if (!dormantSnapshot) {
					logger.warn("Could not snapshot a chapter's workspace before making it dormant", {
						chapterId,
						worktreePath,
					});
				}

				// Step 2.6: Copy out the files no other mechanism protects.
				//
				// Snapshots and the auto-commit both honour the repository's ignore rules, and
				// `worktree remove --force` deletes ignored content — so ignored files have
				// exactly zero copies unless they are archived here.
				const ignored = await archiveIgnoredFiles(chapterId, worktreePath);

				// Step 3: Auto-commit with conflict recovery
				//
				// `commitFailed` decides whether the snapshot above is still needed on wake. When
				// the commit succeeds the branch tip carries the work, and restoring a snapshot
				// on top would be a pointless (and slightly risky) rewrite of a clean worktree.
				// When it fails, that snapshot is the ONLY copy.
				let commitFailed = false;
				let commitError: unknown = null;
				// `worktreeLock` in addition to the `chapterLock` this method already holds. The two
				// guard different things and neither implies the other: `chapterLock` keeps another
				// *chapter* transition out, while a narrator's Bash tool or a merge targeting this
				// worktree is keyed on the path, not the chapter. The commit and the merge-abort
				// retry have to be one unit — an abort followed by someone else's write, then this
				// auto-commit, would commit that write under this chapter's "auto-save" message.
				//
				// Ordering is chapter → worktree, matching the hierarchy in `lib/async-mutex`; the
				// reverse nesting anywhere would make a cycle out of two locks that are each safe.
				const identity = await resolveUserGitIdentityEnv(userId);
				try {
					await worktreeLock.acquire(worktreePath, () =>
						gitService.autoCommitUnlocked(worktreePath, "auto-save before dormant", identity),
					);
				} catch (commitErr) {
					if (isResourceProtectionError(commitErr)) throw commitErr;
					// If worktree has merge conflicts, abort merge and retry
					logger.warn("Auto-commit failed, attempting conflict recovery", {
						chapterId,
						error: String(commitErr),
					});
					try {
						await worktreeLock.acquire(worktreePath, async () => {
							await gitService.mergeAbort(worktreePath);
							await gitService.autoCommitUnlocked(
								worktreePath,
								"auto-save before dormant (after merge abort)",
								identity,
							);
						});
					} catch (recoveryErr) {
						if (isResourceProtectionError(recoveryErr)) throw recoveryErr;
						logger.error("Conflict recovery failed during dormant", {
							chapterId,
							error: String(recoveryErr),
						});
						commitFailed = true;
						commitError = recoveryErr;
					}
				}

				// Step 3.5: Refuse to continue when NOTHING holds this chapter's work.
				//
				// The worktree is deleted a few lines below, so the two mechanisms that can
				// carry uncommitted state past that point are the commit and the snapshot. If
				// both failed there is no third copy, and proceeding would destroy the
				// workspace — which is exactly what the previous code did: the snapshot failure
				// was a `warn`, the commit failure only set a flag, and the removal ran
				// unconditionally. Failing here leaves the chapter active and the worktree
				// intact, so the user (or a retry after the underlying git problem is fixed)
				// still has the bytes.
				if (commitFailed && !dormantSnapshot) {
					throw new ValidationError(
						"Refusing to make this chapter dormant: its uncommitted work could neither be " +
							`committed (${String(commitError)}) nor snapshotted, so removing the worktree ` +
							"would destroy it. Resolve the git problem in the worktree (or commit manually) " +
							"and try again.",
					);
				}

				// Step 4: Stop file watcher before removing worktree
				worktreeWatcher.unwatchAll(worktreePath);

				// Step 5: Remove worktree BEFORE updating DB
				// This ensures we don't lose the worktreePath reference if removal fails
				try {
					await gitService.removeWorktree(gitPath, worktreePath);
				} catch (err) {
					if (isResourceProtectionError(err)) throw err;
					// Removal failed, so the directory on disk is still this chapter's workspace
					// — and when the commit failed it is also still the live copy of work the
					// branch does not have.
					//
					// The chapter therefore stays active with its `worktreePath` intact. Nulling
					// it (the previous behaviour) was unrecoverable in both directions: wake
					// would try `worktree add` at a path that already exists and fail forever,
					// while the orphan sweep — which deletes `.worktrees` directories no active
					// chapter claims — would eventually delete that same directory.
					logger.error("Worktree removal failed during dormant; chapter stays active", {
						chapterId,
						worktreePath,
						error: String(err),
					});
					throw new ValidationError(
						`Could not make this chapter dormant: removing its worktree failed (${String(err)}). ` +
							"The chapter is still active and its worktree is untouched — close anything " +
							"holding files open in it and try again.",
					);
				}

				// Step 6: Update DB — external resources already cleaned
				const now = new Date().toISOString();
				await db
					.update(chapters)
					.set({
						status: "dormant",
						worktreePath: null,
						// Recorded only when the commit failed, so it means exactly one thing:
						// "the branch does not carry this chapter's work, the snapshot does".
						// Waking reads it to decide whether a restore is needed at all, and a
						// value written after a SUCCESSFUL commit would make every wake rewrite
						// a worktree that git had already restored correctly.
						...(commitFailed && dormantSnapshot
							? { dormantSnapshotCommitSha: dormantSnapshot.commitSha }
							: {}),
						updatedAt: now,
					})
					.where(eq(chapters.id, chapterId));

				logger.info("Chapter made dormant", {
					chapterId,
					archivedIgnored: ignored.archived.length,
					skippedIgnored: ignored.skipped.length,
				});
				eventBus.emit({ type: "chapter:dormant", chapterId });
				return { ignored, snapshotOnly: commitFailed };
			});
		});
	},

	async wake(chapterId: string): Promise<WakeReport> {
		return chapterLock.acquire(chapterId, async () => {
			const warnings: string[] = [];
			const chapter = await db.query.chapters.findFirst({
				where: eq(chapters.id, chapterId),
			});
			if (!chapter) throw new NotFoundError("Chapter", chapterId);
			// A merged chapter is deliberately NOT wakeable.
			//
			// Waking one used to clear every merge coordinate (target, commit, strategy,
			// snapshot shas) while leaving the target's content exactly as the merge left
			// it. The result was a chapter that looked independent but whose changes were
			// still applied downstream: `unmerge` could no longer run (it requires
			// `status === "merged"` and the coordinates that were just erased), and
			// re-merging applied the same diff a second time.
			//
			// `unmerge` already does what waking a merged chapter is meant to do — it
			// reverses the contribution out of the target AND returns the source to active
			// with its uncommitted work restored. Reimplementing the rollback here would
			// duplicate that logic (including its conflict reporting), so this refuses and
			// points at it instead.
			if (chapter.status === "merged") {
				throw new ValidationError(
					"This chapter was merged — use unmerge instead of wake. Unmerge rolls the change " +
						"back out of the target and returns this chapter to active; waking it would " +
						"leave its work applied in the target with no way to undo it.",
				);
			}
			if (chapter.status !== "dormant") throw new ValidationError("Can only wake dormant chapters");

			const gitPath = await getProjectGitPath(chapter.projectId);
			if (!gitPath) throw new ValidationError("Project has no git repository configured");

			const branchSuffix = chapter.branch.split("/").slice(1).join("/");
			const worktreePath = resolve(gitPath, ".worktrees", branchSuffix);

			return withLegacyRetirement(
				[chapterId],
				"chapter wake/reclaim",
				async () => {
					// Step 1: Create worktree, tolerating leftovers from a failed teardown.
					//
					// `git worktree add` fails outright in two states this code can genuinely be
					// in, and both used to make the chapter permanently unwakeable:
					//   - the path exists on disk ("already exists"), because a previous removal
					//     failed or was interrupted;
					//   - the path is gone but git still has the registration ("missing but already
					//     registered"), which `prune` clears.
					// Neither is `--force`-able for the first case, so the directory has to be
					// reclaimed explicitly.
					await this._createWorktreeReclaiming(gitPath, worktreePath, chapter.branch, chapterId);

					// Step 1.5: Put back the uncommitted work the branch does not carry.
					//
					// A dormant chapter holds state its branch tip does not when the pre-dormant
					// auto-commit failed: `dormantSnapshotCommitSha` is then the only copy, and
					// dormant records it for exactly this restore.
					//
					// `mergedSourceSnapshotSha` is still consulted for chapters that were merged and
					// later made dormant again, where it names uncommitted state the branch never
					// received. `restoreSourceSnapshot` verifies the commit against the shadow
					// repository and reports rather than throws, so a pruned or missing snapshot
					// degrades to "you got the last commit" instead of failing the wake.
					const restoreTarget = chapter.dormantSnapshotCommitSha ?? chapter.mergedSourceSnapshotSha;
					if (restoreTarget) {
						const restored = await restoreSourceSnapshot(worktreePath, restoreTarget);
						if (!restored.restored) {
							logger.warn("Wake could not restore the chapter's uncommitted work", {
								chapterId,
								snapshot: restoreTarget,
								reason: restored.reason,
							});
						}
					}

					// Step 1.6: Put back the ignored files dormant copied out. Ordered after the
					// snapshot restore because that rewrites tracked content, while these are by
					// definition outside it.
					//
					// Anything it declined is reported rather than dropped: those archived bytes are
					// still the user's only copy, and a silent skip followed by deleting the archive
					// is how they used to disappear for good.
					const restoredIgnored = restoreIgnoredFiles(chapterId, worktreePath);
					if (restoredIgnored.skipped.length > 0) {
						warnings.push(
							`${restoredIgnored.skipped.length} archived git-ignored file(s) were not restored ` +
								`because the worktree already has those paths (${restoredIgnored.skipped
									.slice(0, 5)
									.join(
										", ",
									)}). Their archived copies were kept at ${restoredIgnored.archivePath}.`,
						);
					}

					// Step 2: Update DB — if this fails, clean up the orphan worktree
					const now = new Date().toISOString();
					try {
						await db
							.update(chapters)
							.set({
								status: "active",
								worktreePath,
								lastAccessedAt: now,
								updatedAt: now,
								// The dormant snapshot has been consumed (or was found unrestorable), and
								// the chapter now has a live worktree whose state is tracked by
								// `snapshotCommitSha`. Cleared so it keeps meaning "the branch is missing
								// this chapter's work": left behind, a LATER dormant cycle whose commit
								// succeeded would still find this stale value and restore an old workspace
								// over the one git had just restored correctly.
								dormantSnapshotCommitSha: null,
								// No merge coordinates are cleared here: only dormant chapters reach this
								// point, and a dormant chapter's merge fields (if any) describe a merge
								// that is still applied in the target. Clearing them is `unmerge`'s job,
								// which also rolls the target back.
							})
							.where(eq(chapters.id, chapterId));
					} catch (dbErr) {
						logger.error("DB update failed during wake, removing orphan worktree", {
							chapterId,
							error: String(dbErr),
						});
						try {
							await gitService.removeWorktree(gitPath, worktreePath);
						} catch (cleanupErr) {
							if (isResourceProtectionError(cleanupErr)) throw cleanupErr;
							logger.error("Failed to clean up orphan worktree", {
								chapterId,
								worktreePath,
								error: String(cleanupErr),
							});
						}
						throw dbErr;
					}

					// Step 3: Restore containers (non-fatal — chapter is already usable)
					if (chapter.containerConfig) {
						try {
							await containerService.unpauseChapterContainers(chapterId);
						} catch (err) {
							if (isResourceProtectionError(err)) throw err;
							logger.warn("Failed to unpause containers during wake", {
								chapterId,
								error: String(err),
							});
						}
					}

					logger.info("Chapter woken", { chapterId, worktreePath });
					eventBus.emit({ type: "chapter:woken", chapterId });

					// Sync commits that may have been added externally while dormant
					try {
						await commitSyncService.syncChapterCommits(chapterId);
					} catch (err) {
						if (isResourceProtectionError(err)) throw err;
						logger.warn("Failed to sync commits after wake (non-fatal)", {
							chapterId,
							error: String(err),
						});
					}

					return { warnings };
				},
				[{ path: worktreePath }],
			);
		});
	},

	/**
	 * `git worktree add`, recovering from the leftovers a failed teardown leaves.
	 *
	 * Three states are possible at the target path, and plain `add` only handles the
	 * first:
	 *   - nothing there — the normal case;
	 *   - git still has a registration for a path that no longer exists ("missing but
	 *     already registered"), cleared by `prune`;
	 *   - the directory exists ("already exists"), which no flag overrides — `--force`
	 *     covers the stale-registration case only.
	 *
	 * The existing directory is removed rather than reused, and only after `prune`
	 * has been tried, so the branch is checked out cleanly instead of being merged
	 * into whatever partial state was left behind. That is safe here because the
	 * caller is waking a chapter whose content lives in the branch plus its snapshot:
	 * a directory left by a failed `worktree remove` was already going to be deleted,
	 * and `remove --force` (which had also just failed on it) would have done the same.
	 */
	async _createWorktreeReclaiming(
		gitPath: string,
		worktreePath: string,
		branch: string,
		chapterId: string,
	): Promise<void> {
		return withLegacyRetirement(
			[chapterId],
			"chapter reclaim",
			async () => {
				try {
					await gitService.createWorktree(gitPath, worktreePath, branch);
					return;
				} catch (firstErr) {
					if (isResourceProtectionError(firstErr)) throw firstErr;
					logger.warn("Worktree creation failed; attempting to reclaim the path", {
						chapterId,
						worktreePath,
						error: String(firstErr),
					});
				}

				// Cheapest recovery first: drops registrations whose directories are gone.
				await gitService.pruneWorktrees(gitPath).catch((err) => {
					logger.debug("worktree prune failed during reclaim", {
						chapterId,
						error: String(err),
					});
				});
				try {
					await gitService.createWorktree(gitPath, worktreePath, branch);
					return;
				} catch (afterPruneErr) {
					if (isResourceProtectionError(afterPruneErr)) throw afterPruneErr;
					logger.debug("Worktree creation still failing after prune", {
						chapterId,
						error: String(afterPruneErr),
					});
				}

				// A directory is in the way. `worktree remove --force` first, so git also drops
				// its administrative files; a bare `rm` would leave the registration behind and
				// the next `add` would report "missing but already registered".
				const frozenPath = await revalidateLifecycleTarget(worktreePath);
				if (existsSync(frozenPath)) {
					// But first: is that directory actually ours?
					//
					// `worktreePath` is derived, not stored — `resolve(gitPath, ".worktrees",
					// branch.split("/").slice(1).join("/"))` — so two chapters whose branches differ
					// only in their prefix (`chapter/foo` and `review/foo`) resolve to the SAME path.
					// Waking one of them would then hit the other's live worktree, and the recovery
					// below (`remove --force` plus `rmSync`) would delete an active chapter's
					// workspace including everything uncommitted in it. Refusing is the only safe
					// answer: the destructive branch exists to reclaim *this* chapter's leftovers,
					// and it cannot tell those from another chapter's working state.
					const claimant = await db.query.chapters.findFirst({
						columns: { id: true, title: true, branch: true, status: true },
						where: and(
							ne(chapters.id, chapterId),
							eq(chapters.worktreePath, worktreePath),
							inArray(chapters.status, ["active", "dormant"]),
						),
					});
					if (claimant) {
						throw new ValidationError(
							`Cannot wake this chapter: the worktree path it derives from its branch ` +
								`(${worktreePath}) is already in use by chapter "${claimant.title}" ` +
								`(${claimant.id}, branch ${claimant.branch}). Their branch names collide after ` +
								"the prefix, so reclaiming the directory would delete that chapter's workspace. " +
								"Rename one of the branches, or delete the other chapter first.",
						);
					}
					await gitService.removeWorktree(gitPath, worktreePath).catch((err) => {
						if (isResourceProtectionError(err)) throw err;
						logger.debug("worktree remove failed during reclaim; deleting the directory", {
							chapterId,
							error: String(err),
						});
					});
					await assertLifecycleProtectionCurrent([{ path: worktreePath }], "reclaim rm fallback");
					const removalPath = await revalidateLifecycleTarget(worktreePath);
					if (existsSync(removalPath)) {
						rmSync(removalPath, { recursive: true, force: true });
						await confirmLifecyclePathRemoved(removalPath);
					}
					await gitService.pruneWorktrees(gitPath).catch(() => {});
				}
				await gitService.createWorktree(gitPath, worktreePath, branch);
			},
			[{ path: worktreePath }],
		);
	},

	async batchCleanup(
		chapterIds: string[],
		options: { force?: boolean; deleteBranch?: boolean } = {},
	): Promise<CleanupReport> {
		const report: CleanupReport = { cleaned: [], skipped: [], errors: [] };

		for (const chapterId of chapterIds) {
			try {
				// One `chapterLock` per chapter, taken inside the loop rather than around it.
				//
				// Locking here at all is what `dormant` and `wake` already do, and this path
				// makes the same class of transition: read the row, decide from its status and
				// git state, then delete the worktree and rewrite the row. Without the lock a
				// concurrent `dormant` on the same chapter interleaves — both observe `active`,
				// `dormant` snapshots and auto-commits into a worktree this loop is deleting,
				// and the two `UPDATE`s race to set contradictory statuses. The clean-status
				// check at the top is the sharpest case: it gates an irreversible removal on an
				// observation that nothing kept true.
				//
				// Around the loop would be wrong, not merely coarser: it would hold a lock keyed
				// on one chapterId while operating on others, which protects none of them and
				// blocks unrelated single-chapter operations for the duration of the batch.
				await chapterLock.acquire(chapterId, async () => {
					const chapter = await db.query.chapters.findFirst({
						where: eq(chapters.id, chapterId),
					});
					if (!chapter) {
						report.errors.push({ chapterId, error: "Not found" });
						return;
					}
					if (chapter.isRoot) {
						report.skipped.push(chapterId);
						return;
					}
					if (chapter.status === "merged" || chapter.status === "abandoned") {
						report.skipped.push(chapterId);
						return;
					}

					return withLegacyRetirement([chapterId], "chapter batch cleanup", async () => {
						if (chapter.worktreePath && !options.force) {
							const status = await gitService.getStatus(chapter.worktreePath);
							if (status) {
								report.skipped.push(chapterId);
								return;
							}
						}

						await terminalService.cleanupForChapter(chapterId);

						if (chapter.containerConfig) {
							try {
								await containerService.removeChapterContainers(chapterId, {
									deleteVolumes: options.deleteBranch,
								});
							} catch (err) {
								if (isResourceProtectionError(err)) throw err;
								logger.warn("Failed to remove containers during cleanup", {
									chapterId,
									error: String(err),
								});
							}
						}

						const gitPath = await getProjectGitPath(chapter.projectId);

						if (chapter.worktreePath && gitPath) {
							try {
								await gitService.removeWorktree(gitPath, chapter.worktreePath);
							} catch (err) {
								if (isResourceProtectionError(err)) throw err;
								logger.warn("Failed to remove worktree during cleanup", {
									chapterId,
									error: String(err),
								});
							}
						}

						if (options.deleteBranch && gitPath) {
							try {
								await gitService.deleteBranch(gitPath, chapter.branch);
							} catch (err) {
								if (isResourceProtectionError(err)) throw err;
								logger.warn("Failed to delete branch during cleanup", {
									chapterId,
									error: String(err),
								});
							}
						}

						// Abandoned is terminal: `wake` only accepts `dormant`, so nothing will ever
						// consume this chapter's ignored-file archive again. Leaving it behind kept a
						// plaintext copy of exactly the files git refuses to track (`secret.env` and
						// friends) on disk forever, with no reader and no sweeper — for a chapter the
						// user just cleaned up.
						discardIgnoredArchive(chapterId);

						const now = new Date().toISOString();
						await db
							.update(chapters)
							.set({ status: "abandoned", worktreePath: null, updatedAt: now })
							.where(eq(chapters.id, chapterId));

						eventBus.emit({ type: "chapter:abandoned", chapterId, projectId: chapter.projectId });
						report.cleaned.push(chapterId);
					});
				});
			} catch (err) {
				if (isResourceProtectionError(err)) throw err;
				report.errors.push({ chapterId, error: String(err) });
			}
		}

		logger.info("Batch cleanup completed", report as unknown as Record<string, unknown>);
		return report;
	},

	async dormantInactiveChapters(projectId: string): Promise<string[]> {
		const maxActive = settings.chapters.maxActiveWorktrees;

		const activeChapters = await db.query.chapters.findMany({
			where: eq(chapters.projectId, projectId),
			// Scans every chapter in the project, so skip the per-node UI blobs.
			columns: { dockLayoutJson: false, detachedPanelsJson: false },
			orderBy: [asc(chapters.lastAccessedAt)],
		});

		const active = activeChapters.filter(
			(c) => c.status === "active" && c.worktreePath && !c.isRoot,
		);
		if (active.length <= maxActive) return [];

		const toDormant = active.slice(0, active.length - maxActive);
		const dormanted: string[] = [];

		for (const chapter of toDormant) {
			try {
				await this.dormant(chapter.id);
				dormanted.push(chapter.id);
			} catch (err) {
				if (isResourceProtectionError(err)) throw err;
				logger.warn("Failed to auto-dormant chapter", {
					chapterId: chapter.id,
					error: String(err),
				});
			}
		}

		if (dormanted.length > 0) {
			logger.info("Auto-dormanted inactive chapters", { projectId, count: dormanted.length });
		}
		return dormanted;
	},

	_dormantTimers: new Map<string, ReturnType<typeof setTimeout>>(),

	scheduleAutoDormant(projectId: string): void {
		const existing = this._dormantTimers.get(projectId);
		if (existing) clearTimeout(existing);

		// When disabled, clean up any existing timer and return
		if (settings.chapters.maxActiveWorktrees <= 0) {
			this._dormantTimers.delete(projectId);
			return;
		}

		const timer = setTimeout(async () => {
			this._dormantTimers.delete(projectId);
			try {
				await this.dormantInactiveChapters(projectId);
			} catch (err) {
				if (isResourceProtectionError(err)) throw err;
				logger.warn("Scheduled auto-dormant failed", {
					projectId,
					error: String(err),
				});
			}
		}, 30_000);

		this._dormantTimers.set(projectId, timer);
	},

	/** Clear all pending timers (for graceful shutdown). */
	clearAllTimers(): void {
		for (const timer of this._dormantTimers.values()) {
			clearTimeout(timer);
		}
		this._dormantTimers.clear();
	},
};
