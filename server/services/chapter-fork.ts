import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ForkWorktreeSource } from "@shared/chapter-fork";
import { and, desc, eq, isNotNull, lte, sql } from "drizzle-orm";
import { db } from "../db";
import { chapters, narratorMessageRefs, narratorMessages, narrators, projects } from "../db/schema";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId, generateShortId } from "../lib/id";
import { logger } from "../lib/logger";
import { envWithAmbientProxy } from "../lib/net/proxy-env";
import { isInsidePath } from "../lib/platform-path";
import type { Locale } from "../lib/prompt-i18n";
import { slugify } from "../lib/slug";
import { safeSpawn } from "../lib/spawn";
import { chapterEdgeService } from "./chapter-edge-service";
import { ensureChapterSnapshot } from "./chapter-snapshot-ref";
import { chapterWriteStore } from "./chapter-write/store";
import { commitSyncService } from "./commit-sync-service";
import { containerService } from "./container-service";
import { FileHistoryError, rebuildFileStatesAtMessage } from "./file-state-rebuild";
import { gitService } from "./git-service";
import { ensureRefsCoverMessage } from "./narrator-refs-backfill";
import { narratorService } from "./narrator-service";
import { portAllocator } from "./port-allocator";
import {
	compensateLegacyCreation,
	recordChapterCreated,
	recordChapterNarratorCreated,
	withChapterCreation,
} from "./worktree-lifecycle-guard";
import {
	SNAPSHOT_BASE_REF,
	SNAPSHOT_HEAD_REF,
	snapshotIncomingRef,
	treeSnapshotKey,
	worktreeTreeSnapshot,
} from "./worktree-tree-snapshot";

export interface ForkChapterInput {
	userId?: string | null;
	title?: string;
	description?: string;
	inheritMode?: "full" | "compressed" | "fresh";
	/**
	 * Fork point identified by the SDK message uuid. Only assistant messages
	 * carry one, so prefer `forkAtMessageId` for UI-driven forks.
	 */
	forkAtMessageUuid?: string;
	/** Fork point identified by the local `narrator_messages.id` (any role). */
	forkAtMessageId?: string;
	/** Whether files come from workspace state or committed history. */
	worktreeSource?: ForkWorktreeSource;
	/** Explicit commit SHA to fork from. Only valid with commit source. */
	startCommitSha?: string;
	/** Chapter role: branch or exploration (trunk is reserved for the root chapter). */
	role?: "branch" | "exploration";
	locale?: Locale;
	/**
	 * Explicit RULER position — if provided, skip auto-layout calculation.
	 * `axisOffset`/`crossOffset` are offsets relative to `anchorCommitSha`'s tick.
	 */
	anchorCommitSha?: string;
	axisOffset?: number;
	crossOffset?: number;
	/**
	 * Explicit CLASSIC canvas position (absolute React Flow world coordinates).
	 *
	 * Separate from the ruler triple above because the two coordinate systems are
	 * not interchangeable: classic clients used to send their world coordinates as
	 * `axisOffset`/`crossOffset`, which made the new chapter's stored position
	 * meaningless to ruler (it reads them as offsets from a commit tick) and vice
	 * versa. Supplying these places the chapter on the classic canvas only; its
	 * ruler position stays auto-assigned.
	 */
	graphX?: number;
	graphY?: number;
}

function summarizeStartupScript(script: string): string {
	const oneLine = script.replace(/\s+/g, " ").trim();
	return oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine;
}

function isRiskyNarraforkStartupScript(script: string, worktreePath: string): boolean {
	const normalized = script.toLowerCase();
	const looksLikeDevServer = /\b(bun|npm|pnpm|yarn)\s+(run\s+)?dev\b/.test(normalized);
	const mentionsNarrafork = normalized.includes("narrafork");
	return mentionsNarrafork || (looksLikeDevServer && /narrafork/i.test(worktreePath));
}

/**
 * Resolve the fork-point message from whichever coordinate the caller supplied.
 *
 * Only assistant messages carry an SDK `messageUuid`, so UI-driven forks (which
 * may target a user message) pass `forkAtMessageId`. A `forkAtMessageUuid` that
 * does not match any uuid is also tried as a row id, since older callers passed
 * the id through that field. An unresolvable coordinate is a client error rather
 * than a silent fall back to HEAD, which would fork from the wrong point.
 *
 * The resolved message is then checked for *membership* in the chapter being
 * forked, because "this row exists" and "this row is a fork point for this
 * chapter" are different questions. Lookups are by global id, so a subagent
 * message resolves fine here and then fails every downstream resolution: subagent
 * messages carry a `parentToolUseId` and are never referenced by the primary
 * narrator, so commit resolution, snapshot resolution and file-state rebuild all
 * returned nothing and the fork silently fell back to the parent's HEAD. Worse,
 * that combination (`forkMessage` set, no restore error) skipped both warning
 * paths, so the parent's entire uncommitted workspace was dropped with no output
 * at all. Rejecting is correct rather than conservative: forking "at" a subagent
 * message has no defined workspace state, since the subagent's writes are recorded
 * against its own timeline.
 */
async function resolveForkPointMessage(
	chapterId: string,
	input: Pick<ForkChapterInput, "forkAtMessageId" | "forkAtMessageUuid">,
): Promise<{ id: string; messageUuid: string | null } | null> {
	const resolved = await (async () => {
		if (input.forkAtMessageId) {
			const byId = await db.query.narratorMessages.findFirst({
				where: eq(narratorMessages.id, input.forkAtMessageId),
				columns: { id: true, messageUuid: true, parentToolUseId: true },
			});
			if (!byId) throw new ValidationError("Fork message not found");
			return byId;
		}
		if (input.forkAtMessageUuid) {
			const byUuid = await db.query.narratorMessages.findFirst({
				where: eq(narratorMessages.messageUuid, input.forkAtMessageUuid),
				columns: { id: true, messageUuid: true, parentToolUseId: true },
			});
			if (byUuid) return byUuid;
			const byId = await db.query.narratorMessages.findFirst({
				where: eq(narratorMessages.id, input.forkAtMessageUuid),
				columns: { id: true, messageUuid: true, parentToolUseId: true },
			});
			if (!byId) throw new ValidationError("Fork message not found");
			return byId;
		}
		return null;
	})();
	if (!resolved) return null;

	if (resolved.parentToolUseId) {
		throw new ValidationError(
			"Cannot fork at a subagent message. Subagent work is recorded on its own timeline, " +
				"so there is no chapter-level state to fork from — pick a message from the " +
				"chapter's main conversation instead.",
		);
	}

	const primaryNarrator = await db.query.narrators.findFirst({
		where: and(eq(narrators.chapterId, chapterId), eq(narrators.variant, "primary")),
		columns: { id: true },
	});
	if (!primaryNarrator) {
		throw new ValidationError(
			"This chapter has no primary narrator, so a message cannot be used as a fork point.",
		);
	}
	// Lazily-forked narrators keep older refs in an ancestor rather than their own
	// table, so a legitimate fork point may not be materialized yet. Materialize it
	// before concluding the message does not belong here.
	await ensureRefsCoverMessage(primaryNarrator.id, resolved.id).catch(() => {
		// A backfill failure is reported by the membership check below.
	});
	const ref = await db.query.narratorMessageRefs.findFirst({
		where: and(
			eq(narratorMessageRefs.narratorId, primaryNarrator.id),
			eq(narratorMessageRefs.messageId, resolved.id),
		),
		columns: { seq: true },
	});
	if (!ref) {
		throw new ValidationError(
			"That message does not belong to this chapter's conversation, so it cannot be used " +
				"as a fork point.",
		);
	}

	return { id: resolved.id, messageUuid: resolved.messageUuid };
}

export const chapterFork = {
	/**
	 * Fork a chapter with atomic operations and rollback stack.
	 * Creates a new branch + worktree from the parent's current state.
	 */
	async fork(parentChapterId: string, input: ForkChapterInput) {
		const parent = await db.query.chapters.findFirst({
			where: eq(chapters.id, parentChapterId),
		});
		if (!parent) throw new NotFoundError("Chapter", parentChapterId);
		// A dormant parent is forkable; a merged or abandoned one is not.
		//
		// Dormant means "worktree removed, branch kept", and a branch tip is all this
		// function needs — every worktree-dependent step below already has a null-path
		// branch (commit resolution falls back to the repository HEAD, the snapshot copy
		// and copyFiles are skipped, the dirty check does not apply). Refusing it was a
		// pure limitation, and a costly one: `maxActiveWorktrees` defaults to 10, so
		// auto-dormant silently made older chapters unforkable until the user waked one,
		// which rebuilds a worktree and mutates the parent's state just to read its tip.
		//
		// Merged and abandoned stay rejected because their branches may already be
		// deleted, so there is no guarantee of anything to fork from.
		if (parent.status !== "active" && parent.status !== "dormant") {
			throw new ValidationError("Can only fork active or dormant chapters");
		}
		if (input.forkAtMessageId && input.forkAtMessageUuid) {
			throw new ValidationError("forkAtMessageId and forkAtMessageUuid are mutually exclusive");
		}
		if (input.startCommitSha && (input.forkAtMessageId || input.forkAtMessageUuid)) {
			throw new ValidationError(
				"Message fork coordinates and startCommitSha are mutually exclusive",
			);
		}
		if (input.startCommitSha && input.worktreeSource === "workspace") {
			throw new ValidationError("startCommitSha requires worktreeSource=commit");
		}

		const worktreeSource: ForkWorktreeSource =
			input.worktreeSource ??
			(input.startCommitSha || parent.status === "dormant" ? "commit" : "workspace");
		const explicitCurrentWorkspace =
			input.worktreeSource === "workspace" && !input.forkAtMessageId && !input.forkAtMessageUuid;
		if (parent.status === "dormant" && input.worktreeSource === "workspace") {
			throw new ValidationError(
				"Cannot fork a dormant chapter from workspace state because it has no worktree. " +
					'Use worktreeSource="commit" or wake the chapter first.',
			);
		}

		const project = await db.query.projects.findFirst({
			where: eq(projects.id, parent.projectId),
		});
		if (!project?.gitPath) throw new ValidationError("Project has no git repository configured");
		const gitPath = project.gitPath;
		return withChapterCreation(project.id, gitPath, async () => {
			const warnings: string[] = [];
			const inheritMode = input.inheritMode ?? "full";
			const autoTitle = `${parent.title.slice(0, 180)}-fork-${generateShortId(6)}`;
			const title = input.title || autoTitle;
			const slug = slugify(title);
			const shortId = generateShortId(6);
			const branchName = `chapter/${slug}-${shortId}`;
			const worktreePath = resolve(gitPath, ".worktrees", `${slug}-${shortId}`);
			const now = new Date().toISOString();
			const id = generateId();

			// Resolve the fork point message once, from whichever coordinate the caller
			// supplied. Everything downstream (commit resolution, file-state rebuild,
			// narrator fork) works off the local row id.
			const forkMessage = await resolveForkPointMessage(parentChapterId, input);

			// Resolve the commit SHA for the fork point. Message coordinates select the
			// nearest preceding commit in both modes; workspace mode may then restore the
			// message's recorded filesystem state on top of it.
			let commitSha: string;
			if (input.startCommitSha) {
				try {
					commitSha = await gitService.getRefCommit(gitPath, `${input.startCommitSha}^{commit}`);
				} catch {
					throw new ValidationError(
						`startCommitSha is not a resolvable commit: ${input.startCommitSha}`,
					);
				}
				const parentTip = await gitService.getRefCommit(gitPath, parent.branch);
				if (!(await gitService.isAncestor(gitPath, commitSha, parentTip))) {
					throw new ValidationError(
						"startCommitSha must belong to the parent chapter branch history",
					);
				}
			} else if (forkMessage) {
				commitSha = await this.resolveCommitForMessage(
					parentChapterId,
					forkMessage.id,
					gitPath,
					parent.worktreePath,
					parent.branch,
				);
			} else {
				commitSha = parent.worktreePath
					? await gitService.getHeadCommit(parent.worktreePath)
					: await gitService.getRefCommit(gitPath, parent.branch);
			}

			const forkPoint: {
				commitSha: string;
				worktreeSource: ForkWorktreeSource;
				narratorMessageUuid?: string;
				narratorMessageId?: string;
			} = { commitSha, worktreeSource };
			if (forkMessage) {
				forkPoint.narratorMessageId = forkMessage.id;
				if (forkMessage.messageUuid) forkPoint.narratorMessageUuid = forkMessage.messageUuid;
			}

			return withChapterCreation(
				project.id,
				gitPath,
				async () => {
					const rollback: Array<() => Promise<void>> = [];

					try {
						// Step 1: Create git branch at the resolved commit + worktree
						await gitService.createBranch(gitPath, branchName, commitSha);
						rollback.push(() => gitService.deleteBranch(gitPath, branchName));

						await gitService.createWorktree(gitPath, worktreePath, branchName);
						rollback.push(() => gitService.removeWorktree(gitPath, worktreePath));
						// The snapshot steps below create a shadow repository for this worktree (and
						// write `refs/nf/head` into it), and neither automatic cleanup path can reach
						// one that a rollback leaves behind: `gcAll` only removes directories missing a
						// HEAD, and the orphan sweep only walks `.worktrees` directories that still
						// exist on disk — which rollback has just deleted. Registered here, before the
						// repo exists, so it covers every later step regardless of where the failure
						// happens; `destroy` on a non-existent directory is a no-op. `force` is required
						// because the chapter row (if it got as far as being inserted) claims this key.
						if (worktreeSource === "workspace") {
							rollback.push(async () => {
								await worktreeTreeSnapshot.destroy(worktreePath, undefined, { force: true });
							});
						}

						// Step 1.5: Put the new worktree into the state the fork point actually
						// describes.
						//
						// The worktree currently sits at a commit, and a commit is almost never the
						// state anyone means by "fork from here": the parent's real state includes
						// everything written since that commit. Copying the workspace snapshot is what
						// closes that gap — byte-exact, and inclusive of writes no tool input
						// describes (Bash, build scripts, the user's own editor).
						//
						// This runs whether or not a fork-point message was named. When none was, the
						// intent is "fork from the parent as it is now", and the previous behaviour —
						// silently starting from HEAD — discarded every uncommitted change the parent
						// had. That was a real loss of work with no warning, and it is the main defect
						// this step exists to remove.
						let restoredFromTree = false;
						let baseSnapshotCommit: string | null = null;
						/**
						 * Why the byte-exact restore did not happen, when a snapshot existed for the
						 * fork point but could not be applied.
						 *
						 * Distinct from "no snapshot was available at all": here the exact state was
						 * on record and the fork still ended up with a reconstruction, so the user
						 * has to be told that what they got is an approximation.
						 */
						let snapshotRestoreError: string | null = null;
						if (worktreeSource === "workspace" && parent.worktreePath) {
							const snapshot = forkMessage
								? await this.resolveSnapshotForMessage(parentChapterId, forkMessage.id)
								: await this.resolveCurrentSnapshot(parent.worktreePath);
							if (!snapshot && explicitCurrentWorkspace) {
								throw new ValidationError(
									"Could not capture the parent workspace for this fork. Retry after checking that " +
										"the worktree and git repository are accessible, or use worktreeSource=commit.",
								);
							}
							if (snapshot) {
								try {
									await worktreeTreeSnapshot.restoreInto(
										parent.worktreePath,
										worktreePath,
										snapshot.treeHash,
									);
									restoredFromTree = true;
									// Carry the parent's lineage over so the fork keeps a computable
									// relationship to it. Without this the two workspaces share no
									// ancestry, and a later merge would have no merge base to reason from —
									// every overlapping edit would surface as a conflict.
									baseSnapshotCommit = snapshot.commitSha
										? await this.adoptParentLineage(
												parent.worktreePath,
												worktreePath,
												snapshot.commitSha,
												id,
											)
										: null;
									logger.info("Restored forked worktree from tree snapshot", {
										parentChapterId,
										childChapterId: id,
										treeHash: snapshot.treeHash,
										baseSnapshotCommit,
										forkedFromMessage: forkMessage != null,
									});
								} catch (err) {
									if (explicitCurrentWorkspace) {
										throw new ValidationError(
											"The parent workspace was captured but could not be restored into the fork. " +
												`Retry, or use worktreeSource=commit. Details: ${String(err)}`,
										);
									}
									// Remembered so the fallback below can say the state it produces is
									// weaker than the one that was available. Replay reconstructs files from
									// recorded Write/Edit inputs, so anything written by Bash, a build step
									// or an external editor is absent from it — silently, which is how a
									// fork could look complete while missing work the snapshot had captured
									// byte-for-byte.
									snapshotRestoreError = String(err);
									logger.warn("Tree snapshot restore failed during fork; falling back to replay", {
										parentChapterId,
										childChapterId: id,
										treeHash: snapshot.treeHash,
										error: snapshotRestoreError,
									});
								}
							}
						}

						if (worktreeSource === "workspace" && forkMessage && !restoredFromTree) {
							// A snapshot existed for this fork point but could not be applied, so what
							// follows is a reconstruction from recorded tool inputs rather than the exact
							// state. Said once here, before the replay's own outcome is known, because
							// the loss is caused by the failed restore either way: a replay that applies
							// nothing (no recorded Write/Edit) leaves the worktree at the commit, and one
							// that applies everything it has still cannot cover Bash or external writes.
							if (snapshotRestoreError) {
								warnings.push(
									"The parent's exact workspace state could not be copied " +
										`(${snapshotRestoreError}), so this fork was rebuilt from recorded file ` +
										"edits instead. Changes made by shell commands or outside the narrator " +
										"are not part of that record — check the worktree before continuing.",
								);
							}
							try {
								const fileStates = await this.resolveFileStatesForMessage(
									parentChapterId,
									forkMessage.id,
								);
								if (fileStates.size > 0) {
									// Parent cwd used to convert absolute paths to relative
									const parentCwd = parent.worktreePath ?? gitPath;
									let applied = 0;

									for (const [rawFilePath, content] of fileStates) {
										if (content === null) continue; // Skip files that didn't exist

										// Normalize first to collapse any ".." segments before
										// path-containment checks (resolve handles this).
										const filePath = resolve(rawFilePath);

										// file_path in tool inputs is typically absolute (e.g.
										// /home/user/project/.worktrees/branch/src/foo.ts).
										// We must convert it to a path relative to the parent
										// worktree, then resolve against the NEW worktree.
										let targetPath: string;
										if (isAbsolute(filePath)) {
											if (!isInsidePath(parentCwd, filePath)) {
												// File is outside the worktree (e.g. /tmp/...) — skip
												continue;
											}
											targetPath = resolve(worktreePath, relative(parentCwd, filePath));
										} else {
											targetPath = resolve(worktreePath, filePath);
										}

										// Safety: ensure we never write outside the new worktree
										if (!isInsidePath(worktreePath, targetPath)) continue;

										mkdirSync(dirname(targetPath), { recursive: true });
										await Bun.write(targetPath, content);
										applied++;
									}
									if (applied > 0) {
										logger.info("Applied file snapshots to forked worktree", {
											parentChapterId,
											childChapterId: id,
											fileCount: applied,
											skipped: fileStates.size - applied,
										});
									}
								}
							} catch (err) {
								// Non-fatal: degrade to commit-only state rather than failing the fork.
								// The rebuild resolves every file before the first write, so a failure
								// here leaves the worktree at the resolved commit rather than in a
								// half-applied state.
								const diverged = err instanceof FileHistoryError && err.code === "REPLAY_DIVERGED";
								logger.warn("Failed to apply file snapshots during fork (non-fatal)", {
									parentChapterId,
									childChapterId: id,
									diverged,
									error: String(err),
								});
								warnings.push(
									diverged
										? `Uncommitted parent changes could not be reconstructed (${String(err)}). ` +
												"The forked worktree is at the resolved commit instead; verify it before continuing."
										: `File snapshot restore failed: ${String(err)}. The forked worktree may be missing uncommitted changes from the parent.`,
								);
							}
						}

						// Whenever the byte-exact copy did not happen, report the uncommitted parent
						// state this fork is missing.
						//
						// Gated on `!restoredFromTree` alone, deliberately decoupled from whether a fork
						// point was named. The old `!forkMessage` condition left the most damaging case
						// silent: a named fork point that resolves to no usable snapshot (a message
						// whose narrator recorded none, or one that is not the chapter's at all) sets
						// `forkMessage` without restoring anything, so this guard was skipped, and the
						// replay path's own warning only fires when a restore was *attempted and
						// failed*. The parent's whole uncommitted workspace could therefore be absent
						// from the fork with no output whatsoever.
						if (worktreeSource === "workspace" && !restoredFromTree && parent.worktreePath) {
							const status = await gitService
								.getStatus(parent.worktreePath)
								.then((out) => ({ ok: true as const, out }))
								.catch((err) => ({ ok: false as const, error: String(err) }));
							if (!status.ok) {
								// "Could not check" is not "clean", and conflating the two is what the
								// previous `.catch(() => "")` did: the single case where the code cannot
								// tell whether work is being lost was also the case where it said nothing.
								logger.warn("Could not check the parent for uncommitted work during fork", {
									parentChapterId,
									childChapterId: id,
									error: status.error,
								});
								warnings.push(
									`Could not check the parent worktree for uncommitted changes (${status.error}), ` +
										`so this fork starts from commit ${commitSha.slice(0, 7)}. If the parent had ` +
										"uncommitted work, it is not part of this fork.",
								);
							} else if (status.out.trim().length > 0) {
								logger.warn("Forked without the parent's uncommitted state", {
									parentChapterId,
									childChapterId: id,
									forkedFromMessage: forkMessage != null,
								});
								warnings.push(
									"The parent's uncommitted changes could not be captured, so this fork starts from " +
										`its last commit (${commitSha.slice(0, 7)})${
											forkMessage ? " plus whatever recorded file edits could be replayed" : ""
										}. Check the parent worktree before continuing.`,
								);
							}
						}

						// Step 2: Compute initial graph position
						// Place close to the ruler (small crossOffset) and avoid overlapping existing chapters.
						const NODE_CROSS_SIZE = 100; // approximate height of a chapter card + gap

						let anchorCommitSha: string | null;
						let axisOffset: number;
						let crossOffset: number;

						const hasExplicitPosition =
							input.anchorCommitSha != null ||
							input.axisOffset != null ||
							input.crossOffset != null;
						if (hasExplicitPosition) {
							// Use explicit position from the client. Classic graph clients may only
							// send offsets; anchor those to the fork commit rather than ignoring them.
							anchorCommitSha = input.anchorCommitSha ?? commitSha;
							axisOffset = input.axisOffset ?? 0;
							crossOffset = Math.max(0, input.crossOffset ?? 0);
						} else {
							// Default: anchor to the fork commit
							anchorCommitSha = commitSha;
							axisOffset = 40; // slight main-axis offset so the fork line isn't perfectly straight

							// NOTE: the slot search below is a read-then-write sequence with no lock, so two
							// forks that reach it concurrently can pick the same slot and stack their cards
							// on top of each other in the graph. Left unguarded deliberately, for now:
							//
							//   - It is cosmetic. Both chapters, worktrees and branches are correct; only the
							//     initial `crossOffset` collides, and dragging either card fixes it.
							//   - It could not be reproduced. Six concurrent forks of one parent still came
							//     out with distinct, contiguous slots, because each fork does seconds of
							//     subprocess git work (branch, worktree add, snapshot restore) before reaching
							//     this query, which staggers them past each other. See the concurrency case in
							//     `chapter-fork-snapshot.test.ts`.
							//   - `chapterLock` on the parent is the wrong key, not merely a coarse one. The
							//     collision is between rows sharing an `anchorCommitSha`, and the query below
							//     spans the whole table — two forks of *different* parents anchored to the
							//     same commit contend, and holding each parent's lock excludes neither from
							//     the other. It would serialize forks that cannot collide while still
							//     admitting the ones that can.
							//   - A lock keyed on the anchor commit would cover it, but slot uniqueness is a
							//     property of the stored rows, so the fix that actually holds is a unique
							//     constraint on (anchorCommitSha, crossOffset) plus retry on violation. That
							//     needs a schema change; an in-process mutex added first would hide the
							//     symptom on one server while leaving the invariant unenforced.
							//
							// If it becomes worth fixing, do it with the constraint.
							//
							// Find all chapters already anchored to this commit to avoid overlap
							const existing = await db
								.select({ crossOffset: chapters.crossOffset })
								.from(chapters)
								.where(eq(chapters.anchorCommitSha, commitSha));
							const occupied = new Set(
								existing.map((r) => Math.round((r.crossOffset ?? 0) / NODE_CROSS_SIZE)),
							);

							// Find the first free slot starting from 0 (closest to ruler)
							let slot = 0;
							while (occupied.has(slot)) slot++;
							crossOffset = slot * NODE_CROSS_SIZE;
						}

						// Create DB record
						const chapter = await chapterWriteStore.insertChapter({
							id,
							projectId: parent.projectId,
							title,
							description: input.description ?? null,
							status: "active",
							role: input.role ?? "branch",
							branch: branchName,
							worktreePath,
							baseBranch: parent.branch,
							parentChapterId,
							forkPoint,
							startCommitSha: commitSha,
							// The narrative state this chapter starts from, independent of commits.
							// `snapshotShadowKey` is recorded here rather than left to the first tool
							// call so the ownership guard protects this worktree's lineage immediately —
							// a chapter made dormant before running anything would otherwise have its
							// shadow repository swept as an orphan.
							snapshotCommitSha: baseSnapshotCommit,
							snapshotShadowKey:
								worktreeSource === "workspace"
									? treeSnapshotKey(LOCAL_DEVICE_ID, worktreePath)
									: null,
							anchorCommitSha,
							axisOffset,
							crossOffset,
							// Classic coordinates are stored only when the caller supplied them.
							// Left null the chapter is simply unplaced on that canvas and gets
							// auto-laid-out, which is the right default — there is no meaningful
							// way to derive a React Flow position from a ruler tick offset.
							graphX: input.graphX ?? null,
							graphY: input.graphY ?? null,
							lastAccessedAt: now,
							createdAt: now,
							updatedAt: now,
						});
						recordChapterCreated(id);
						rollback.push(async () => {
							await chapterWriteStore.deleteChapter(id);
						});

						// Create fork edge in chapter_edges
						await chapterEdgeService.createForkEdge(parent.projectId, parentChapterId, chapter.id, {
							commitSha: forkPoint.commitSha,
							worktreeSource,
							inheritMode: inheritMode,
							narratorMessageUuid: forkPoint.narratorMessageUuid,
							narratorMessageId: forkPoint.narratorMessageId,
						});

						// Copy parent's commit history to the forked chapter
						try {
							await commitSyncService.syncChapterCommits(parentChapterId);
							await commitSyncService.copyCommitsForFork(
								parentChapterId,
								chapter.id,
								forkPoint.commitSha,
							);
						} catch (err) {
							logger.warn("Failed to copy commit history during fork (non-fatal)", {
								parentChapterId,
								childChapterId: chapter.id,
								error: String(err),
							});
						}

						// Step 3: Copy project-configured files only for the parent's current workspace.
						if (
							worktreeSource === "workspace" &&
							!forkMessage &&
							project.copyFiles &&
							parent.worktreePath
						) {
							const files = JSON.parse(project.copyFiles) as string[];
							if (files.length > 0) {
								await gitService.copyFiles(parent.worktreePath, worktreePath, files);
							}
						}

						// Step 4: Fork the chapter's primary narrator
						const primaryNarrator = await db.query.narrators.findFirst({
							where: and(
								eq(narrators.chapterId, parentChapterId),
								eq(narrators.variant, "primary"),
							),
						});
						if (primaryNarrator) {
							const forked = await narratorService.forkNarrator(primaryNarrator.id, null, {
								title,
								newChapterId: id,
								inheritMode,
								userId: input.userId,
								locale: input.locale,
								forkMessageId: forkMessage?.id,
							});
							recordChapterNarratorCreated(forked.id);
							rollback.push(async () => {
								await narratorService.remove(forked.id);
							});
						}

						// Step 5: Start containers (if parent has containerConfig)
						if (parent.containerConfig) {
							await chapterWriteStore.updateChapterContainerConfig({
								chapterId: id,
								containerConfig: parent.containerConfig,
								now,
							});
							try {
								await containerService.startChapterContainers(id);
								rollback.push(async () => {
									try {
										await containerService.removeChapterContainers(id, {
											deleteVolumes: true,
										});
									} catch {
										// best effort
									}
								});
							} catch (err) {
								logger.warn("Container startup failed during fork (non-fatal)", {
									chapterId: id,
									error: String(err),
								});
								warnings.push(
									`Container startup failed: ${String(err)}. The container config is preserved — you can retry from the chapter detail page.`,
								);
								// Ensure ports are released (startChapterContainers releases on
								// failure internally, but double-check to prevent leaks)
								try {
									await portAllocator.release(id);
								} catch {
									// ignore
								}
								// Keep containerConfig so the user can retry manually
							}
						}

						// Step 6: Execute startup script (if project has one)
						if (project.startupScript) {
							const scriptSummary = summarizeStartupScript(project.startupScript);
							if (isRiskyNarraforkStartupScript(project.startupScript, worktreePath)) {
								const warning =
									"Startup script appears to start a NarraFork/dev server from the forked worktree; " +
									"a second server process can lock the shared NarraFork database.";
								warnings.push(warning);
								logger.warn("Potentially unsafe startup script during fork", {
									chapterId: id,
									worktreePath,
									script: scriptSummary,
								});
							}

							try {
								const result = await safeSpawn({
									cmd: ["sh", "-c", project.startupScript],
									cwd: worktreePath,
									// A user-authored startup script commonly installs dependencies, so it
									// keeps the user's ambient proxy rather than the blanked values
									// NarraFork uses for its own outbound fetch.
									env: envWithAmbientProxy({
										NARRAFORK_CHAPTER_ID: id,
										NARRAFORK_STARTUP_SCRIPT: "1",
									}),
									timeout: 60_000,
									killProcessTree: true,
								});
								if (result.exitCode !== 0) {
									logger.warn("Startup script failed during fork (non-fatal)", {
										chapterId: id,
										worktreePath,
										script: scriptSummary,
										exitCode: result.exitCode,
										stderr: result.stderr.trim(),
									});
								}
							} catch (err) {
								logger.warn("Startup script error during fork (non-fatal)", {
									chapterId: id,
									worktreePath,
									script: scriptSummary,
									error: String(err),
								});
							}
						}

						logger.info("Chapter forked", {
							id,
							parentId: parentChapterId,
							branch: branchName,
							inheritMode,
							forkCommit: commitSha,
						});

						eventBus.emit({
							type: "chapter:forked",
							chapterId: id,
							parentId: parentChapterId,
							projectId: parent.projectId,
						});
						return warnings.length > 0 ? { ...chapter, warnings } : chapter;
					} catch (err) {
						logger.error("Chapter fork failed, rolling back", { error: String(err) });
						await compensateLegacyCreation(id, worktreePath, rollback);
						throw err;
					}
				},
				worktreePath,
			);
		});
	},

	/**
	 * Resolve the git commit SHA for a fork-at-message operation.
	 *
	 * Looks up the message by its local row id, then walks backwards through the
	 * narrator's message sequence to find the nearest message that has an
	 * associated `commitSha`. Falls back to HEAD if none found.
	 */
	async resolveCommitForMessage(
		chapterId: string,
		messageId: string,
		gitPath: string,
		worktreePath: string | null,
		branch?: string,
	): Promise<string> {
		/**
		 * The chapter's own tip.
		 *
		 * With a worktree that is its HEAD; without one it has to be resolved by branch
		 * name, because `gitPath`'s HEAD is the main repository's checkout (usually trunk)
		 * and has no relationship to this chapter. `branch` is optional only for older
		 * callers; when it is absent the previous, weaker fallback is kept.
		 */
		const chapterTip = async (): Promise<string> => {
			if (worktreePath) return gitService.getHeadCommit(worktreePath);
			if (branch) return gitService.getRefCommit(gitPath, branch);
			return gitService.getHeadCommit(gitPath);
		};

		// Find the primary narrator for this chapter
		const primaryNarrator = await db.query.narrators.findFirst({
			where: and(eq(narrators.chapterId, chapterId), eq(narrators.variant, "primary")),
		});
		if (!primaryNarrator) {
			logger.warn("No primary narrator found for commit resolution, using HEAD", { chapterId });
			return chapterTip();
		}

		const targetMsg = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, messageId),
			columns: { id: true, commitSha: true },
		});
		if (!targetMsg) {
			logger.warn("Fork message not found, using HEAD", { messageId });
			return chapterTip();
		}

		// If the target message itself has a commitSha, use it directly
		if (targetMsg.commitSha) {
			return targetMsg.commitSha;
		}

		// Find the target message's seq in the narrator's refs
		const targetRef = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, primaryNarrator.id),
				eq(narratorMessageRefs.messageId, targetMsg.id),
			),
		});
		if (!targetRef) {
			logger.warn("Fork message not in narrator refs, using HEAD", { messageId });
			return chapterTip();
		}

		// Walk backwards from the target message to find the nearest commitSha
		const rows = await db
			.select({
				commitSha: narratorMessages.commitSha,
			})
			.from(narratorMessageRefs)
			.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
			.where(
				and(
					eq(narratorMessageRefs.narratorId, primaryNarrator.id),
					sql`${narratorMessageRefs.seq} <= ${targetRef.seq}`,
					isNotNull(narratorMessages.commitSha),
				),
			)
			.orderBy(desc(narratorMessageRefs.seq))
			.limit(1);

		if (rows.length > 0 && rows[0].commitSha) {
			return rows[0].commitSha;
		}

		// No commit found in message history, fall back to the chapter's tip
		logger.warn("No commitSha found in message history before fork point, using HEAD", {
			chapterId,
			messageId,
		});
		return chapterTip();
	},

	/**
	 * Find the workspace tree snapshot to fork from.
	 *
	 * Prefers the boundary recorded on the fork message itself, then walks backwards
	 * through the narrator's timeline for the nearest earlier boundary — the same
	 * shape as `resolveCommitForMessage`, because a message without tool calls has no
	 * snapshot of its own but inherits the state left by the previous one.
	 *
	 * Returns null when no boundary exists at or before the fork point, so the caller
	 * falls back to replaying recorded edits.
	 */
	async resolveTreeHashForMessage(chapterId: string, messageId: string): Promise<string | null> {
		return (await this.resolveSnapshotForMessage(chapterId, messageId))?.treeHash ?? null;
	},

	/**
	 * The parent workspace's current state, for a fork with no named fork point.
	 *
	 * Captures on demand rather than trusting the stored pointer, because "fork from
	 * the parent as it is now" has to mean *now*: the user may have edited since the
	 * last tool call, and starting from a stale boundary would drop exactly the
	 * changes they expect to carry over.
	 */
	async resolveCurrentSnapshot(
		parentWorktreePath: string,
	): Promise<{ treeHash: string; commitSha: string | null } | null> {
		const advanced = await ensureChapterSnapshot(parentWorktreePath, "fork point");
		if (advanced) return { treeHash: advanced.treeHash, commitSha: advanced.commitSha };
		// The DAG could not be extended (a non-git directory, a git failure). A bare
		// capture still yields a forkable state, just without lineage.
		const treeHash = await worktreeTreeSnapshot.tryCapture(parentWorktreePath);
		return treeHash ? { treeHash, commitSha: null } : null;
	},

	/**
	 * Copy the parent's snapshot lineage into the fork's shadow repository.
	 *
	 * Shadow repositories share no objects, so the fork cannot see the parent's
	 * history until it is fetched across. Doing so is what preserves a merge base
	 * between the two: afterwards both descend from the same snapshot commit inside
	 * the fork's own repository, and it stays valid even if the parent chapter is
	 * later deleted, because `fetch` copies objects rather than referencing them.
	 *
	 * Returns the adopted commit, or null when the lineage could not be transferred —
	 * the fork still has correct bytes in that case, it just starts fresh ancestry.
	 */
	async adoptParentLineage(
		parentWorktreePath: string,
		worktreePath: string,
		parentSnapshotCommit: string,
		childChapterId: string,
	): Promise<string | null> {
		try {
			// Point a ref at the exact fork commit: the parent's head may have moved past it
			// (forking from an earlier message), and fetching the head would import a state
			// the fork never observed.
			//
			// The key is the child chapter id rather than a random one. A random key left a
			// ref behind on every fork with no deleter anywhere, and each of those refs kept
			// its snapshot commit and the whole tree under it reachable — permanently, since
			// `gcAll` runs `gc --no-prune`. A deterministic key is overwritten by a repeat
			// call for the same child, so the parent's shadow repo accumulates at most one
			// ref per fork instead of one per attempt, and the ref that remains names
			// something meaningful (which child adopted which commit).
			const forkRef = snapshotIncomingRef(`fork-${childChapterId}`);
			await worktreeTreeSnapshot.setRef(parentWorktreePath, forkRef, parentSnapshotCommit);
			const adopted = await worktreeTreeSnapshot.fetchSnapshotFrom(
				worktreePath,
				parentWorktreePath,
				forkRef,
				SNAPSHOT_BASE_REF,
			);
			if (!adopted) return null;
			// The fork continues from where the parent left off, so its head starts there
			// too; subsequent captures chain onto it.
			await worktreeTreeSnapshot.setRef(worktreePath, SNAPSHOT_HEAD_REF, adopted);
			return adopted;
		} catch (err) {
			logger.warn("Could not carry the parent's snapshot lineage into the fork", {
				parentWorktreePath,
				worktreePath,
				parentSnapshotCommit,
				error: String(err),
			});
			return null;
		}
	},

	/**
	 * Find the snapshot boundary to fork from, with its DAG position when it has one.
	 *
	 * The tree is what the new worktree is built from; the commit is what lets the
	 * fork keep a computable relationship to its parent afterwards. A boundary
	 * recorded before the DAG existed has only the tree, which still forks correctly —
	 * it just starts a lineage of its own.
	 *
	 * Walks backwards from the fork point for the same reason commit resolution does:
	 * a message with no tool calls took no snapshot of its own, but the state it
	 * observed is the one the previous tool left behind.
	 */
	async resolveSnapshotForMessage(
		chapterId: string,
		messageId: string,
	): Promise<{ treeHash: string; commitSha: string | null } | null> {
		const primaryNarrator = await db.query.narrators.findFirst({
			where: and(eq(narrators.chapterId, chapterId), eq(narrators.variant, "primary")),
			columns: { id: true },
		});
		if (!primaryNarrator) return null;

		const targetRef = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, primaryNarrator.id),
				eq(narratorMessageRefs.messageId, messageId),
			),
			columns: { seq: true },
		});
		if (!targetRef) return null;

		const [row] = await db
			.select({
				treeHashAfter: narratorMessages.treeHashAfter,
				snapshotCommitSha: narratorMessages.snapshotCommitSha,
			})
			.from(narratorMessageRefs)
			.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
			.where(
				and(
					eq(narratorMessageRefs.narratorId, primaryNarrator.id),
					lte(narratorMessageRefs.seq, targetRef.seq),
					isNotNull(narratorMessages.treeHashAfter),
				),
			)
			.orderBy(desc(narratorMessageRefs.seq))
			.limit(1);

		if (!row?.treeHashAfter) return null;
		return { treeHash: row.treeHashAfter, commitSha: row.snapshotCommitSha ?? null };
	},

	/**
	 * Rebuild the file state at a specific message by replaying Write/Edit
	 * tool calls from narrator_file_snapshots + narrator_tool_calls.
	 *
	 * Returns a Map of filePath → content for all files the narrator touched
	 * up to (and including) the fork message.
	 */
	async resolveFileStatesForMessage(
		chapterId: string,
		messageId: string,
	): Promise<Map<string, string | null>> {
		const primaryNarrator = await db.query.narrators.findFirst({
			where: and(eq(narrators.chapterId, chapterId), eq(narrators.variant, "primary")),
		});
		if (!primaryNarrator) return new Map();

		const targetMsg = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, messageId),
			columns: { id: true },
		});
		if (!targetMsg) return new Map();

		const targetRef = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, primaryNarrator.id),
				eq(narratorMessageRefs.messageId, targetMsg.id),
			),
		});
		if (!targetRef) return new Map();

		return rebuildFileStatesAtMessage(primaryNarrator.id, targetMsg.id);
	},
};
