/**
 * Splitting a chapter at one of its own commits.
 *
 * The operation turns one chapter O into three:
 *
 *   - **prefix** — a new chapter owning O's history *up to and including* commit C.
 *     It is the frozen anchor the other two hang off.
 *   - **continuation** — O itself, still on its own branch and worktree, now
 *     described as starting *at* C and parented by prefix.
 *   - **newFork** — an ordinary fork of prefix at C, which is what the user was
 *     actually asking for when they said "branch off from this old commit".
 *
 * Two decisions here deviate from DESIGN.md, both deliberately:
 *
 * 1. The narrator history is cut by `narrator_message_refs.seq`, never by
 *    comparing the commit's timestamp against message `createdAt`. Commit dates
 *    are rewritable (`--date`, rebase, cherry-pick), collide within a
 *    millisecond, and say nothing at all about messages that produced no commit;
 *    `seq` is the only total order the conversation actually has, and it is what
 *    every existing fork path already uses.
 * 2. The prefix is left `dormant` (or `active` when it inherits a trunk role),
 *    not `frozen`. `frozen` is a status no business logic accepts: forking
 *    requires active/dormant, and `wake` only accepts dormant — so a frozen
 *    prefix could neither receive the fork this operation must create nor ever
 *    be revived. `dormant` already means exactly what a historical anchor needs:
 *    branch kept, worktree absent, forkable, wakeable.
 */
import { resolve } from "node:path";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../db";
import {
	chapterCommits,
	chapterEdges,
	chapters,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	projects,
} from "../db/schema";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { chapterLock } from "../lib/async-mutex";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId, generateShortId } from "../lib/id";
import { logger } from "../lib/logger";
import type { Locale } from "../lib/prompt-i18n";
import { slugify } from "../lib/slug";
import { chapterEdgeService } from "./chapter-edge-service";
import { chapterFork } from "./chapter-fork";
import { chapterService } from "./chapter-service";
import { chapterWriteStore } from "./chapter-write/store";
import type { ChapterRow } from "./chapter-write/write-store";
import { commitSyncService } from "./commit-sync-service";
import { gitService } from "./git-service";
import { ensureRefsCoverMessage } from "./narrator-refs-backfill";
import { narratorService } from "./narrator-service";
import {
	compensateLegacyCreation,
	recordChapterCreated,
	recordChapterNarratorCreated,
	withChapterCreation,
} from "./worktree-lifecycle-guard";
import { treeSnapshotKey, worktreeTreeSnapshot } from "./worktree-tree-snapshot";

export interface SplitChapterInput {
	commitSha: string;
	newFork: {
		title: string;
		description?: string;
		inheritMode: "full" | "compressed" | "fresh";
	};
	locale?: Locale;
}

/** Structured record of a step that degraded, alongside the human-readable warning. */
export type SplitFallback = Record<string, unknown>;

export interface SplitChapterResult {
	prefixChapter: ChapterRow;
	continuationChapter: ChapterRow;
	newForkChapter: ChapterRow | (ChapterRow & { warnings: string[] });
	commitSha: string;
	warnings?: string[];
	fallbacks?: SplitFallback[];
}

/**
 * How many commit records may be probed with `merge-base --is-ancestor` when the
 * split commit has no narrator message of its own.
 *
 * Each probe is a git subprocess, so this is a latency budget rather than a
 * correctness one — candidates are tried in descending `seq` order and the first
 * ancestor wins, which in practice resolves on the first or second probe (the
 * commit immediately preceding C).
 */
const MAX_ANCESTOR_PROBES = 25;

/**
 * How many of the chapter's commit records are considered as approximation
 * candidates. Ordered by `authoredAt` only to bound the window; the *choice*
 * among them is made by `seq`, because authored dates can be rewritten.
 */
const MAX_APPROXIMATION_CANDIDATES = 200;

export interface TruncationPoint {
	/** `narrator_message_refs.seq` of the last message that belongs to the prefix. */
	seq: number;
	/** `narrator_messages.id` at that seq — the fork point handed to the narrator fork. */
	messageId: string;
	/**
	 * True when no message is recorded against C itself and the boundary was
	 * inferred from the newest ancestor commit that does have one. The prefix then
	 * ends slightly before C in conversation terms, which the caller surfaces.
	 */
	approximate: boolean;
	/** The commit the boundary was actually taken from (equals C unless approximate). */
	resolvedFromCommitSha: string;
}

/**
 * The `seq` at which the prefix's conversation ends, for a split at `commitSha`.
 *
 * Resolution order, cheapest and most exact first:
 *
 *  1. `chapter_commits` (unique index on chapterId+sha) → `narratorMessageId`.
 *     This is the authoritative mapping: `recordCommit` writes that column and
 *     `narrator_messages.commit_sha` in the same call, so a commit made by the
 *     narrator always lands here.
 *  2. The same row's message may not be materialized in a lazily-forked
 *     narrator's refs, so the ref is backfilled on demand before concluding it
 *     is absent.
 *  3. When the commit has no message at all — a hand-made `git commit`, or an
 *     import — the newest *ancestor* commit that does have one is used and the
 *     result is flagged approximate.
 *
 * Returns null when the narrator has no message at or before C, i.e. the prefix
 * has no conversation to inherit.
 *
 * Deliberately does not query `narrator_messages.commit_sha` directly: that
 * column has no index, so matching on it would be a full scan of the largest
 * table in the database (message bodies and all) on the main thread — for a
 * lookup `chapter_commits` answers from an index.
 */
export async function resolveTruncationSeqForCommit(
	chapterId: string,
	commitSha: string,
	opts: {
		/** Repository to run ancestry probes in (a worktree or the project's gitPath). */
		repoPath?: string | null;
	} = {},
): Promise<TruncationPoint | null> {
	const primaryNarrator = await db.query.narrators.findFirst({
		where: and(eq(narrators.chapterId, chapterId), eq(narrators.variant, "primary")),
		columns: { id: true },
	});
	if (!primaryNarrator) return null;
	const narratorId = primaryNarrator.id;

	/** seq of a message, materializing the ref first if this narrator forked lazily. */
	const seqOf = async (messageId: string): Promise<number | null> => {
		await ensureRefsCoverMessage(narratorId, messageId).catch(() => {
			// A backfill failure is indistinguishable here from "the message is not
			// this narrator's"; the ref lookup below decides either way.
		});
		const ref = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, messageId),
			),
			columns: { seq: true },
		});
		return ref?.seq ?? null;
	};

	const exact = await db.query.chapterCommits.findFirst({
		where: and(eq(chapterCommits.chapterId, chapterId), eq(chapterCommits.sha, commitSha)),
		columns: { narratorMessageId: true },
	});
	if (exact?.narratorMessageId) {
		const seq = await seqOf(exact.narratorMessageId);
		if (seq != null) {
			return {
				seq,
				messageId: exact.narratorMessageId,
				approximate: false,
				resolvedFromCommitSha: commitSha,
			};
		}
	}

	// Approximation path. Candidates are every commit record of this chapter that
	// names a message; they are ranked by `seq` and probed for ancestry in that
	// order, so the answer is "the latest conversation point whose commit is
	// contained in C" rather than "the latest by wall clock".
	const candidates = await db
		.select({ sha: chapterCommits.sha, messageId: chapterCommits.narratorMessageId })
		.from(chapterCommits)
		.where(
			and(
				eq(chapterCommits.chapterId, chapterId),
				isNotNull(chapterCommits.narratorMessageId),
				sql`${chapterCommits.sha} <> ${commitSha}`,
			),
		)
		.orderBy(desc(chapterCommits.authoredAt))
		.limit(MAX_APPROXIMATION_CANDIDATES);
	if (candidates.length === 0) return null;

	const messageIds = candidates.map((c) => c.messageId).filter((id): id is string => id !== null);
	if (messageIds.length === 0) return null;

	const refs = await db
		.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
		.from(narratorMessageRefs)
		.where(
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				inArray(narratorMessageRefs.messageId, messageIds),
			),
		);
	const seqByMessage = new Map(refs.map((r) => [r.messageId, r.seq]));

	const ranked = candidates
		.flatMap((c) => {
			if (!c.messageId) return [];
			const seq = seqByMessage.get(c.messageId);
			return seq == null ? [] : [{ sha: c.sha, messageId: c.messageId, seq }];
		})
		.sort((a, b) => b.seq - a.seq);

	const repoPath = opts.repoPath;
	if (!repoPath) return null;

	let probes = 0;
	for (const candidate of ranked) {
		if (probes >= MAX_ANCESTOR_PROBES) break;
		probes++;
		const contained = await gitService
			.isAncestor(repoPath, candidate.sha, commitSha)
			.catch(() => false);
		if (!contained) continue;
		return {
			seq: candidate.seq,
			messageId: candidate.messageId,
			approximate: true,
			resolvedFromCommitSha: candidate.sha,
		};
	}
	return null;
}

/** Whether this chapter's primary narrator has a compact still in flight. */
async function hasPendingCompact(narratorId: string): Promise<boolean> {
	// Read through the partial index on `compact_pending` (normally zero rows),
	// then check ref membership by message id. Joining refs to message bodies
	// would instead drag the whole conversation off disk to answer "is anything
	// compacting", which is almost always "no".
	const pending = await db
		.select({ id: narratorMessages.id })
		.from(narratorMessages)
		.where(eq(narratorMessages.compactPending, 1))
		.limit(50);
	if (pending.length === 0) return false;
	const owned = await db
		.select({ id: narratorMessageRefs.id })
		.from(narratorMessageRefs)
		.where(
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				inArray(
					narratorMessageRefs.messageId,
					pending.map((p) => p.id),
				),
			),
		)
		.limit(1);
	return owned.length > 0;
}

export const chapterSplit = {
	/**
	 * Split `chapterId` at `input.commitSha`.
	 *
	 * Held under the chapter lock for its whole duration, because the operation
	 * reads the chapter's git tip and conversation tail and then rewrites its
	 * lineage — a concurrent fork, merge or dormant would invalidate both.
	 */
	async split(chapterId: string, input: SplitChapterInput): Promise<SplitChapterResult> {
		return chapterLock.acquire(chapterId, async () => {
			const warnings: string[] = [];
			const fallbacks: SplitFallback[] = [];

			const original = await db.query.chapters.findFirst({ where: eq(chapters.id, chapterId) });
			if (!original) throw new NotFoundError("Chapter", chapterId);
			// Same admissible set as fork: a dormant chapter is fine (its branch tip is
			// all the git-level work needs), while merged/abandoned/frozen chapters may
			// have no branch left to split.
			if (original.status !== "active" && original.status !== "dormant") {
				throw new ValidationError("Can only split active or dormant chapters");
			}
			if (original.isRoot) {
				// The root chapter *is* the project's repository checkout. Splitting it
				// would require reparenting the whole project under a synthetic chapter
				// and moving the repository's own history into it.
				throw new ValidationError(
					"The root chapter cannot be split — it represents the project's own repository. " +
						"Fork from the commit instead.",
				);
			}

			const project = await db.query.projects.findFirst({
				where: eq(projects.id, original.projectId),
			});
			if (!project?.gitPath) throw new ValidationError("Project has no git repository configured");
			const gitPath = project.gitPath;
			return withChapterCreation(project.id, gitPath, async () => {
				const repoPath = original.worktreePath ?? gitPath;

				// Resolve the commit through git so a short sha from the UI becomes the full
				// one everything downstream stores and compares against.
				const commitSha = await gitService
					.getRefCommit(repoPath, `${input.commitSha}^{commit}`)
					.catch(() => {
						throw new ValidationError(`Commit not found in this repository: ${input.commitSha}`);
					});

				// The chapter's own tip, by branch name when it has no worktree (the
				// repository's HEAD is the main checkout and unrelated to this chapter).
				const tip = original.worktreePath
					? await gitService.getHeadCommit(original.worktreePath)
					: await gitService.getRefCommit(gitPath, original.branch);

				if (!(await gitService.isAncestor(repoPath, commitSha, original.branch))) {
					throw new ValidationError(
						`Commit ${commitSha.slice(0, 7)} is not part of this chapter's history, so there is ` +
							"nothing to split at it.",
					);
				}
				if (commitSha === tip) {
					throw new ValidationError(
						"Cannot split at the chapter's latest commit — the continuation would be empty. " +
							"Fork the chapter instead.",
					);
				}
				if (original.startCommitSha && commitSha === original.startCommitSha) {
					throw new ValidationError(
						"Cannot split at the chapter's first commit — the prefix would be empty. " +
							"Fork from that commit instead.",
					);
				}

				const primaryNarrator = await db.query.narrators.findFirst({
					where: and(eq(narrators.chapterId, chapterId), eq(narrators.variant, "primary")),
					columns: { id: true },
				});
				if (!primaryNarrator) {
					throw new ValidationError(
						"This chapter has no primary narrator, so its conversation cannot be split.",
					);
				}
				if (await hasPendingCompact(primaryNarrator.id)) {
					// A compact in flight rewrites the very refs the prefix would copy, and the
					// parent's finalizer would then copy-on-write a row the prefix shares —
					// leaving the prefix with a marker it can never finish.
					throw new ValidationError(
						"This chapter's conversation is being compacted. Wait for it to finish, then split.",
					);
				}

				const truncation = await resolveTruncationSeqForCommit(chapterId, commitSha, { repoPath });
				if (!truncation) {
					warnings.push(
						`No conversation message is associated with commit ${commitSha.slice(0, 7)} or any ` +
							"earlier commit, so the prefix chapter starts with an empty conversation. The full " +
							"history stays with the original chapter.",
					);
					fallbacks.push({ step: "truncationPoint", mode: "empty", commitSha });
				} else if (truncation.approximate) {
					warnings.push(
						`Commit ${commitSha.slice(0, 7)} was not made by the narrator, so the conversation ` +
							`was cut at the last message belonging to commit ` +
							`${truncation.resolvedFromCommitSha.slice(0, 7)} instead. Messages written between ` +
							"those two commits stay with the original chapter.",
					);
					fallbacks.push({
						step: "truncationPoint",
						mode: "approximate",
						commitSha,
						resolvedFromCommitSha: truncation.resolvedFromCommitSha,
						seq: truncation.seq,
					});
				}

				const now = new Date().toISOString();
				const prefixId = generateId();
				const prefixTitle = `${original.title.slice(0, 180)}-upto-${commitSha.slice(0, 7)}`;
				const prefixSlug = slugify(prefixTitle);
				const prefixShortId = generateShortId(6);
				const prefixBranch = `chapter/${prefixSlug}-${prefixShortId}`;
				const prefixWorktreePath = resolve(gitPath, ".worktrees", `${prefixSlug}-${prefixShortId}`);
				/**
				 * A prefix that inherits a trunk role stays `active` (trunk is where merges
				 * land, and a merge target needs a checkout); anything else becomes the
				 * dormant anchor described at the top of this file, which by definition has
				 * no worktree on disk.
				 *
				 * Not materializing a worktree for the dormant case is not just an
				 * optimization: creating one only to delete it again would check the whole
				 * repository out twice per split, and every intermediate state would be one
				 * more thing rollback has to undo. `chapterFork.fork` explicitly supports a
				 * worktree-less parent, so the fork below is unaffected.
				 */
				const prefixStatus = original.role === "trunk" ? "active" : "dormant";

				return withChapterCreation(
					project.id,
					gitPath,
					async () => {
						const rollback: Array<() => Promise<void>> = [];

						try {
							// Step 1: the prefix's branch, pinned at the split commit.
							await gitService.createBranch(gitPath, prefixBranch, commitSha);
							rollback.push(() => gitService.deleteBranch(gitPath, prefixBranch));

							if (prefixStatus === "active") {
								await gitService.createWorktree(gitPath, prefixWorktreePath, prefixBranch);
								rollback.push(() => gitService.removeWorktree(gitPath, prefixWorktreePath));
							}
							// Registered even when no worktree was created, and before anything can
							// write into the shadow repository: neither automatic cleanup path can
							// reach a shadow repo left behind by a rollback (`gcAll` skips
							// directories that have a HEAD, and the orphan sweep only walks
							// `.worktrees` entries that still exist). `destroy` on a path that never
							// had one is a no-op, and `force` is required because the prefix row
							// claims this key.
							rollback.push(async () => {
								await worktreeTreeSnapshot.destroy(prefixWorktreePath, undefined, { force: true });
							});

							// Step 2: the prefix chapter row.
							const prefixChapter = await chapterWriteStore.insertChapter({
								id: prefixId,
								projectId: original.projectId,
								title: prefixTitle,
								description: original.description,
								status: prefixStatus,
								role: original.role,
								branch: prefixBranch,
								// Dormant means "no worktree on disk", and the column is what every
								// reader consults to decide whether one exists.
								worktreePath: prefixStatus === "active" ? prefixWorktreePath : null,
								baseBranch: original.baseBranch,
								// The prefix takes over the original's place in the graph: whatever O
								// descended from, the prefix now descends from.
								parentChapterId: original.parentChapterId,
								forkPoint: original.forkPoint,
								// The prefix owns the window [O's original start, C]; the continuation
								// takes over from C.
								startCommitSha: original.startCommitSha,
								headCommitSha: commitSha,
								anchorCommitSha: commitSha,
								// Same lane as the original so the split reads as one timeline cut in
								// two rather than a branch off to the side.
								axisOffset: 0,
								crossOffset: original.crossOffset ?? 0,
								// Recorded at insert rather than left to the first tool call so the
								// shadow-repo ownership guard protects this lineage immediately —
								// a chapter with no worktree would otherwise have its snapshots swept
								// as an orphan (see chapter-fork.ts for the same reasoning).
								snapshotShadowKey: treeSnapshotKey(LOCAL_DEVICE_ID, prefixWorktreePath),
								// Deliberately not carried over: exploration membership, review
								// coordinates, merge coordinates and container config all describe the
								// chapter that keeps evolving, which is the continuation.
								lastAccessedAt: now,
								createdAt: now,
								updatedAt: now,
							});
							recordChapterCreated(prefixId);
							rollback.push(async () => {
								await chapterWriteStore.deleteChapter(prefixId);
							});

							// Step 3: the prefix's narrator — the original's conversation cut at the
							// truncation point.
							//
							// `forkNarrator` is used rather than a hand-rolled ref copy because the
							// hard parts are all already solved there: the compact boundary, excluding
							// in-flight compact markers, registering the lazy-backfill cursor so older
							// history stays reachable, copying the four permission rule sets, and
							// forking the Dynamic Spec namespace.
							if (truncation) {
								await ensureRefsCoverMessage(primaryNarrator.id, truncation.messageId).catch(() => {
									// Reported by forkNarrator if the ref genuinely cannot be resolved.
								});
							}
							const prefixNarrator = await narratorService.forkNarrator(primaryNarrator.id, null, {
								title: prefixTitle,
								newChapterId: prefixId,
								// With a truncation point this copies the history up to it. Without one
								// there is nothing to inherit, and `fresh` is the only mode that does not
								// silently fall back to copying the whole conversation.
								inheritMode: truncation ? "full" : "fresh",
								locale: input.locale,
								forkMessageId: truncation?.messageId,
							});
							recordChapterNarratorCreated(prefixNarrator.id);
							rollback.push(async () => {
								await narratorService.remove(prefixNarrator.id);
							});

							// Step 4: commit records up to C.
							//
							// `copyCommitsForFork` already means "copy through this commit", so it is
							// reused verbatim — but it also sets `startCommitSha` to the fork point,
							// which is right for a fork and wrong here: the prefix starts where the
							// original started. The window is restored immediately afterwards.
							try {
								await commitSyncService.syncChapterCommits(chapterId);
								await commitSyncService.copyCommitsForFork(chapterId, prefixId, commitSha);
							} catch (err) {
								logger.warn("Failed to copy commit history during split (non-fatal)", {
									chapterId,
									prefixId,
									error: String(err),
								});
								warnings.push(
									`The prefix chapter's commit list could not be built (${String(err)}). Its git ` +
										"branch is correct; the list rebuilds on the next sync.",
								);
								fallbacks.push({ step: "commitHistoryCopy", mode: "skipped", error: String(err) });
							}
							await chapterWriteStore.updateSplitPrefixHead({
								prefixId,
								startCommitSha: original.startCommitSha,
								headCommitSha: commitSha,
								now,
							});

							if (project.copyFiles && prefixStatus !== "active") {
								// `chapterFork.fork` copies these from the parent's worktree, and the
								// dormant prefix has none. Said out loud because the files are typically
								// local config the new fork needs and git does not track.
								const configured = (() => {
									try {
										return (JSON.parse(project.copyFiles) as string[]).length;
									} catch {
										return 0;
									}
								})();
								if (configured > 0) {
									warnings.push(
										`${configured} project-configured file(s) were not copied into the new fork: the ` +
											"prefix chapter it forks from has no worktree. Copy them manually if the new " +
											"branch needs them.",
									);
									fallbacks.push({
										step: "copyFiles",
										mode: "skipped",
										reason: "prefix has no worktree",
									});
								}
							}

							// Step 5: the fork the user actually asked for.
							//
							// Delegated to `chapterFork.fork` rather than reimplemented: it owns
							// branch/worktree creation, snapshot lineage adoption, the graph slot
							// search, the narrator fork and the container/startup-script handling.
							// It rolls only *itself* back on failure and takes no external rollback
							// stack, so undoing a successful fork is this function's job.
							const newForkChapter = await chapterFork.fork(prefixId, {
								title: input.newFork.title,
								description: input.newFork.description,
								inheritMode: input.newFork.inheritMode,
								worktreeSource: "commit",
								startCommitSha: commitSha,
								anchorCommitSha: commitSha,
								locale: input.locale,
							});
							rollback.push(async () => {
								// `chapterService.remove` is the only teardown that also stops containers,
								// releases ports, kills terminals and drops the shadow repository — all of
								// which `fork` may have created.
								await chapterService.remove(newForkChapter.id);
							});
							const forkWarnings = (newForkChapter as { warnings?: string[] }).warnings;
							if (forkWarnings?.length) warnings.push(...forkWarnings);

							// Step 6: hand the original's incoming fork edges to the prefix.
							//
							// Ordered after everything that can fail on its own, and compensated
							// first on rollback: `chapter_edges` cascades on both endpoints, so
							// deleting the prefix row while these point at it would destroy the
							// project's parent→O edges outright.
							const inboundForkEdges = await db
								.select({ id: chapterEdges.id })
								.from(chapterEdges)
								.where(and(eq(chapterEdges.targetId, chapterId), eq(chapterEdges.type, "fork")));
							for (const edge of inboundForkEdges) {
								const previousTargetId = await chapterEdgeService.redirectForkEdgeTarget(
									edge.id,
									prefixId,
								);
								rollback.push(async () => {
									await chapterEdgeService.redirectForkEdgeTarget(edge.id, previousTargetId);
								});
							}

							// The prefix→continuation edge. No compensation is registered: both
							// endpoints cascade, so deleting the prefix row removes it.
							await chapterEdgeService.createForkEdge(original.projectId, prefixId, chapterId, {
								commitSha,
								worktreeSource: "commit",
								inheritMode: "full",
								narratorMessageId: truncation?.messageId,
							});

							// Step 7: rewrite the original into the continuation.
							//
							// Last, and in one atomic section of the chapter write store, so the
							// window in which the original claims a lineage that may still be
							// rolled back is as small as it can be. `parentChapterId` is
							// `ON DELETE SET NULL`, so even a crash between this commit and a later
							// prefix deletion degrades to "no parent" rather than a dangling
							// pointer.
							//
							// The commit records are recomputed, never deleted: the UI lists them and
							// they are the chapter's only local record of its own history.
							const continuationChapter = await chapterWriteStore.rewriteSplitContinuation({
								chapterId,
								prefixId,
								commitSha,
								...(truncation ? { narratorMessageId: truncation.messageId } : {}),
								fallbackCommitCount: original.commitCount ?? null,
								now,
							});

							logger.info("Chapter split", {
								chapterId,
								prefixId,
								newForkId: newForkChapter.id,
								commitSha,
								truncationSeq: truncation?.seq ?? null,
								truncationApproximate: truncation?.approximate ?? null,
							});

							// Emitted only once every compensable step has succeeded: subscribers
							// (project-db sync, WebSocket fan-out) treat it as fact.
							eventBus.emit({
								type: "chapter:split",
								prefixChapterId: prefixId,
								continuationChapterId: chapterId,
								newForkChapterId: newForkChapter.id,
								commitSha,
								projectId: original.projectId,
							});

							return {
								prefixChapter,
								continuationChapter,
								newForkChapter,
								commitSha,
								...(warnings.length > 0 ? { warnings } : {}),
								...(fallbacks.length > 0 ? { fallbacks } : {}),
							};
						} catch (err) {
							logger.error("Chapter split failed, rolling back", {
								chapterId,
								prefixId,
								error: String(err),
							});
							await compensateLegacyCreation(prefixId, prefixWorktreePath, rollback);
							throw err;
						}
					},
					prefixWorktreePath,
				);
			});
		});
	},
};
