import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
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
import { commitSyncService } from "./commit-sync-service";
import { containerService } from "./container-service";
import { FileHistoryError, rebuildFileStatesAtMessage } from "./file-state-rebuild";
import { gitService } from "./git-service";
import { narratorService } from "./narrator-service";
import { portAllocator } from "./port-allocator";
import {
	SNAPSHOT_BASE_REF,
	SNAPSHOT_HEAD_REF,
	snapshotIncomingRef,
	treeSnapshotKey,
	worktreeTreeSnapshot,
} from "./worktree-tree-snapshot";

export interface ForkChapterInput {
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
	/** Explicit commit SHA to fork from (ruler mode). Overrides the fork point. */
	startCommitSha?: string;
	/** Chapter role: branch or exploration (trunk is reserved for the root chapter). */
	role?: "branch" | "exploration";
	locale?: Locale;
	/** Explicit graph position — if provided, skip auto-layout calculation. */
	anchorCommitSha?: string;
	axisOffset?: number;
	crossOffset?: number;
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
 */
async function resolveForkPointMessage(
	input: Pick<ForkChapterInput, "forkAtMessageId" | "forkAtMessageUuid">,
): Promise<{ id: string; messageUuid: string | null } | null> {
	if (input.forkAtMessageId) {
		const byId = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, input.forkAtMessageId),
			columns: { id: true, messageUuid: true },
		});
		if (!byId) throw new ValidationError("Fork message not found");
		return byId;
	}
	if (input.forkAtMessageUuid) {
		const byUuid = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.messageUuid, input.forkAtMessageUuid),
			columns: { id: true, messageUuid: true },
		});
		if (byUuid) return byUuid;
		const byId = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, input.forkAtMessageUuid),
			columns: { id: true, messageUuid: true },
		});
		if (!byId) throw new ValidationError("Fork message not found");
		return byId;
	}
	return null;
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
		if (parent.status !== "active") {
			throw new ValidationError("Can only fork active chapters");
		}

		const project = await db.query.projects.findFirst({
			where: eq(projects.id, parent.projectId),
		});
		if (!project?.gitPath) throw new ValidationError("Project has no git repository configured");
		const gitPath = project.gitPath;

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
		const forkMessage = await resolveForkPointMessage(input);

		// Resolve the commit SHA for the fork point.
		// Priority: startCommitSha (ruler mode) > fork point message > parent HEAD
		let commitSha: string;
		if (input.startCommitSha) {
			commitSha = input.startCommitSha;
		} else if (forkMessage) {
			commitSha = await this.resolveCommitForMessage(
				parentChapterId,
				forkMessage.id,
				gitPath,
				parent.worktreePath,
			);
		} else {
			commitSha = parent.worktreePath
				? await gitService.getHeadCommit(parent.worktreePath)
				: await gitService.getHeadCommit(gitPath);
		}

		const forkPoint: {
			commitSha: string;
			narratorMessageUuid?: string;
			narratorMessageId?: string;
		} = { commitSha };
		if (forkMessage) {
			forkPoint.narratorMessageId = forkMessage.id;
			if (forkMessage.messageUuid) forkPoint.narratorMessageUuid = forkMessage.messageUuid;
		}

		const rollback: Array<() => Promise<void>> = [];

		try {
			// Step 1: Create git branch at the resolved commit + worktree
			await gitService.createBranch(gitPath, branchName, commitSha);
			rollback.push(() => gitService.deleteBranch(gitPath, branchName));

			await gitService.createWorktree(gitPath, worktreePath, branchName);
			rollback.push(() => gitService.removeWorktree(gitPath, worktreePath));

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
			if (parent.worktreePath) {
				const snapshot = forkMessage
					? await this.resolveSnapshotForMessage(parentChapterId, forkMessage.id)
					: await this.resolveCurrentSnapshot(parent.worktreePath);
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
							? await this.adoptParentLineage(parent.worktreePath, worktreePath, snapshot.commitSha)
							: null;
						logger.info("Restored forked worktree from tree snapshot", {
							parentChapterId,
							childChapterId: id,
							treeHash: snapshot.treeHash,
							baseSnapshotCommit,
							forkedFromMessage: forkMessage != null,
						});
					} catch (err) {
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

			if (forkMessage && !restoredFromTree) {
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

			// A fork with no named fork point has no replay path to fall back on: replay
			// reconstructs state from recorded Write/Edit inputs, and without a message
			// there is no point in the timeline to replay up to. So if the snapshot could
			// not be applied, the worktree is sitting at a commit and any uncommitted
			// parent work is absent. Say so — this case used to pass silently, which is
			// how uncommitted work went missing without the user ever being told.
			if (!forkMessage && !restoredFromTree && parent.worktreePath) {
				const dirty = await gitService.getStatus(parent.worktreePath).catch(() => "");
				if (dirty.trim().length > 0) {
					logger.warn("Forked without the parent's uncommitted state", {
						parentChapterId,
						childChapterId: id,
					});
					warnings.push(
						"The parent's uncommitted changes could not be captured, so this fork starts from " +
							`its last commit (${commitSha.slice(0, 7)}) instead. Check the parent worktree ` +
							"before continuing.",
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
				input.anchorCommitSha != null || input.axisOffset != null || input.crossOffset != null;
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
			const [chapter] = await db
				.insert(chapters)
				.values({
					id,
					projectId: parent.projectId,
					title,
					description: input.description,
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
					snapshotShadowKey: treeSnapshotKey(LOCAL_DEVICE_ID, worktreePath),
					anchorCommitSha,
					axisOffset,
					crossOffset,
					lastAccessedAt: now,
					createdAt: now,
					updatedAt: now,
				})
				.returning();
			rollback.push(async () => {
				await db.delete(chapters).where(eq(chapters.id, id));
			});

			// Create fork edge in chapter_edges
			await chapterEdgeService.createForkEdge(parent.projectId, parentChapterId, chapter.id, {
				commitSha: forkPoint.commitSha,
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

			// Step 3: Copy project-configured files
			if (project.copyFiles && parent.worktreePath) {
				const files = JSON.parse(project.copyFiles) as string[];
				if (files.length > 0) {
					await gitService.copyFiles(parent.worktreePath, worktreePath, files);
				}
			}

			// Step 4: Fork the chapter's primary narrator
			const primaryNarrator = await db.query.narrators.findFirst({
				where: and(eq(narrators.chapterId, parentChapterId), eq(narrators.variant, "primary")),
			});
			if (primaryNarrator) {
				const forked = await narratorService.forkNarrator(primaryNarrator.id, null, {
					title,
					newChapterId: id,
					inheritMode,
					locale: input.locale,
					forkMessageId: forkMessage?.id,
				});
				rollback.push(async () => {
					await narratorService.remove(forked.id);
				});
			}

			// Step 5: Start containers (if parent has containerConfig)
			if (parent.containerConfig) {
				await db
					.update(chapters)
					.set({ containerConfig: parent.containerConfig, updatedAt: now })
					.where(eq(chapters.id, id));
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

			eventBus.emit({ type: "chapter:forked", chapterId: id, parentId: parentChapterId });
			return warnings.length > 0 ? { ...chapter, warnings } : chapter;
		} catch (err) {
			logger.error("Chapter fork failed, rolling back", { error: String(err) });
			for (const fn of rollback.reverse()) {
				try {
					await fn();
				} catch (rollbackErr) {
					logger.error("Rollback step failed", { error: String(rollbackErr) });
				}
			}
			throw err;
		}
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
	): Promise<string> {
		// Find the primary narrator for this chapter
		const primaryNarrator = await db.query.narrators.findFirst({
			where: and(eq(narrators.chapterId, chapterId), eq(narrators.variant, "primary")),
		});
		if (!primaryNarrator) {
			logger.warn("No primary narrator found for commit resolution, using HEAD", { chapterId });
			return worktreePath
				? await gitService.getHeadCommit(worktreePath)
				: await gitService.getHeadCommit(gitPath);
		}

		const targetMsg = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, messageId),
			columns: { id: true, commitSha: true },
		});
		if (!targetMsg) {
			logger.warn("Fork message not found, using HEAD", { messageId });
			return worktreePath
				? await gitService.getHeadCommit(worktreePath)
				: await gitService.getHeadCommit(gitPath);
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
			return worktreePath
				? await gitService.getHeadCommit(worktreePath)
				: await gitService.getHeadCommit(gitPath);
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

		// No commit found in message history, fall back to HEAD
		logger.warn("No commitSha found in message history before fork point, using HEAD", {
			chapterId,
			messageId,
		});
		return worktreePath
			? await gitService.getHeadCommit(worktreePath)
			: await gitService.getHeadCommit(gitPath);
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
	): Promise<string | null> {
		try {
			// Point a temporary ref at the exact fork commit: the parent's head may have
			// moved past it (forking from an earlier message), and fetching the head would
			// import a state the fork never observed.
			const forkRef = snapshotIncomingRef(`fork-${generateShortId(8)}`);
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
