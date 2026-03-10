import { resolve } from "node:path";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../db";
import {
	chapters,
	narratorMessageRefs,
	narratorMessages,
	narratorPatches,
	narrators,
	projects,
} from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId, generateShortId } from "../lib/id";
import { logger } from "../lib/logger";
import type { Locale } from "../lib/prompt-i18n";
import { slugify } from "../lib/slug";
import { safeSpawn } from "../lib/spawn";
import { chapterEdgeService } from "./chapter-edge-service";
import { commitSyncService } from "./commit-sync-service";
import { containerService } from "./container-service";
import { gitService } from "./git-service";
import { narratorService } from "./narrator-service";
import { portAllocator } from "./port-allocator";
import { snapshot } from "./snapshot";

export interface ForkChapterInput {
	title?: string;
	description?: string;
	inheritMode?: "full" | "compressed" | "fresh";
	forkAtMessageUuid?: string;
	/** Chapter role: trunk, branch, or exploration. */
	role?: "trunk" | "branch" | "exploration";
	locale?: Locale;
	/** Explicit graph position — if provided, skip auto-layout calculation. */
	positionX?: number;
	positionY?: number;
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

		const inheritMode = input.inheritMode ?? "full";
		const autoTitle = `${parent.title.slice(0, 180)}-fork-${generateShortId(6)}`;
		const title = input.title || autoTitle;
		const slug = slugify(title);
		const shortId = generateShortId(6);
		const branchName = `chapter/${slug}-${shortId}`;
		const worktreePath = resolve(gitPath, ".worktrees", `${slug}-${shortId}`);
		const now = new Date().toISOString();
		const id = generateId();

		// Resolve the commit SHA for the fork point.
		// When forkAtMessageUuid is provided, find the commit associated with that
		// message (or the nearest earlier message that has a commitSha).
		let commitSha: string;
		if (input.forkAtMessageUuid) {
			commitSha = await this.resolveCommitForMessage(
				parentChapterId,
				input.forkAtMessageUuid,
				gitPath,
				parent.worktreePath,
			);
		} else {
			commitSha = parent.worktreePath
				? await gitService.getHeadCommit(parent.worktreePath)
				: await gitService.getHeadCommit(gitPath);
		}

		const forkPoint: { commitSha: string; narratorMessageUuid?: string } = { commitSha };
		if (input.forkAtMessageUuid) {
			forkPoint.narratorMessageUuid = input.forkAtMessageUuid;
		}

		const rollback: Array<() => Promise<void>> = [];

		try {
			// Step 1: Create git branch at the resolved commit + worktree
			await gitService.createBranch(gitPath, branchName, commitSha);
			rollback.push(() => gitService.deleteBranch(gitPath, branchName));

			await gitService.createWorktree(gitPath, worktreePath, branchName);
			rollback.push(() => gitService.removeWorktree(gitPath, worktreePath));

			// Step 1.5: Restore file state to match what the model saw at the fork message.
			// The worktree is at the resolved commit, but the model may have made file
			// changes (via Write/Edit/Bash) that weren't committed yet at that point.
			// Those changes are tracked in narrator_patches as snapshot tree hashes.
			if (input.forkAtMessageUuid) {
				try {
					const snapshotHash = await this.resolveSnapshotHashForMessage(
						parentChapterId,
						input.forkAtMessageUuid,
					);
					if (snapshotHash) {
						await snapshot.applyTreeToWorktree(parentChapterId, worktreePath, snapshotHash);
						logger.info("Applied snapshot to forked worktree", {
							parentChapterId,
							childChapterId: id,
							snapshotHash,
						});
					}
				} catch (err) {
					// Non-fatal: degrade to commit-only state rather than failing the fork
					logger.warn("Failed to apply snapshot during fork (non-fatal)", {
						parentChapterId,
						childChapterId: id,
						error: String(err),
					});
				}
			}

			// Step 2: Compute initial graph position below the parent node
			const NODE_WIDTH = 280;
			const DEFAULT_NODE_HEIGHT = 120;
			const DEFAULT_PANEL_HEIGHT = 640;
			const VERTICAL_GAP = 60;
			const HORIZONTAL_SPACING = NODE_WIDTH + 80;

			let positionX: number;
			let positionY: number;

			if (input.positionX != null && input.positionY != null) {
				// Use explicit position from the client (e.g. inline fork draft node)
				positionX = input.positionX;
				positionY = input.positionY;
			} else {
				const parentX = parent.positionX ?? 0;
				const parentY = parent.positionY ?? 0;
				const parentHeight =
					parent.panelExpanded && parent.panelHeight
						? parent.panelHeight
						: parent.panelExpanded
							? DEFAULT_PANEL_HEIGHT
							: DEFAULT_NODE_HEIGHT;

				// Count existing children to offset horizontally and avoid overlap
				const existingSiblings = await db
					.select({ id: chapters.id })
					.from(chapters)
					.where(eq(chapters.parentChapterId, parentChapterId));
				const siblingIndex = existingSiblings.length; // 0-based: this will be the Nth child

				positionX = parentX + siblingIndex * HORIZONTAL_SPACING;
				positionY = parentY + parentHeight + VERTICAL_GAP;
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
					positionX,
					positionY,
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
				narratorMessageUuid: input.forkAtMessageUuid,
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
				where: and(eq(narrators.chapterId, parentChapterId), eq(narrators.type, "primary")),
			});
			if (primaryNarrator) {
				const forked = await narratorService.forkNarrator(
					primaryNarrator.id,
					input.forkAtMessageUuid ?? null,
					{
						title,
						newChapterId: id,
						inheritMode,
						locale: input.locale,
					},
				);
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
					// Ensure ports are released (startChapterContainers releases on
					// failure internally, but double-check to prevent leaks)
					try {
						await portAllocator.release(id);
					} catch {
						// ignore
					}
					// Clear containerConfig so dormant/wake won't try to manage
					// containers that were never started
					await db
						.update(chapters)
						.set({ containerConfig: null, updatedAt: now })
						.where(eq(chapters.id, id));
				}
			}

			// Step 6: Execute startup script (if project has one)
			if (project.startupScript) {
				try {
					const result = await safeSpawn({
						cmd: ["sh", "-c", project.startupScript],
						cwd: worktreePath,
						env: { ...process.env, NARRAFORK_CHAPTER_ID: id },
						timeout: 60_000,
					});
					if (result.exitCode !== 0) {
						logger.warn("Startup script failed during fork (non-fatal)", {
							chapterId: id,
							exitCode: result.exitCode,
							stderr: result.stderr.trim(),
						});
					}
				} catch (err) {
					logger.warn("Startup script error during fork (non-fatal)", {
						chapterId: id,
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
			return chapter;
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
	 * Looks up the message identified by `forkAtMessageUuid`, then walks backwards
	 * through the narrator's message sequence to find the nearest message that has
	 * an associated `commitSha`. Falls back to HEAD if none found.
	 */
	async resolveCommitForMessage(
		chapterId: string,
		messageUuid: string,
		gitPath: string,
		worktreePath: string | null,
	): Promise<string> {
		// Find the primary narrator for this chapter
		const primaryNarrator = await db.query.narrators.findFirst({
			where: and(eq(narrators.chapterId, chapterId), eq(narrators.type, "primary")),
		});
		if (!primaryNarrator) {
			logger.warn("No primary narrator found for commit resolution, using HEAD", { chapterId });
			return worktreePath
				? await gitService.getHeadCommit(worktreePath)
				: await gitService.getHeadCommit(gitPath);
		}

		// Find the target message's seq in the narrator's refs
		const targetMsg = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.messageUuid, messageUuid),
		});
		if (!targetMsg) {
			logger.warn("Fork message not found, using HEAD", { messageUuid });
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
			logger.warn("Fork message not in narrator refs, using HEAD", { messageUuid });
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
			messageUuid,
		});
		return worktreePath
			? await gitService.getHeadCommit(worktreePath)
			: await gitService.getHeadCommit(gitPath);
	},

	/**
	 * Find the snapshot tree hash representing the file state at a specific message.
	 *
	 * Walks the narrator_patches table (joined via narrator_message_refs) to find
	 * the last patch whose associated message seq <= the fork message's seq.
	 * Returns the patch's afterHash, or null if no patches exist before that point.
	 */
	async resolveSnapshotHashForMessage(
		chapterId: string,
		messageUuid: string,
	): Promise<string | null> {
		const primaryNarrator = await db.query.narrators.findFirst({
			where: and(eq(narrators.chapterId, chapterId), eq(narrators.type, "primary")),
		});
		if (!primaryNarrator) return null;

		const targetMsg = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.messageUuid, messageUuid),
		});
		if (!targetMsg) return null;

		const targetRef = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, primaryNarrator.id),
				eq(narratorMessageRefs.messageId, targetMsg.id),
			),
		});
		if (!targetRef) return null;

		// Find the last patch whose message is at or before the fork point
		const rows = await db
			.select({ afterHash: narratorPatches.afterHash })
			.from(narratorPatches)
			.innerJoin(
				narratorMessageRefs,
				and(
					eq(narratorMessageRefs.narratorId, primaryNarrator.id),
					eq(narratorMessageRefs.messageId, narratorPatches.messageId),
				),
			)
			.where(sql`${narratorMessageRefs.seq} <= ${targetRef.seq}`)
			.orderBy(desc(narratorPatches.createdAt), desc(narratorPatches.id))
			.limit(1);

		return rows.length > 0 ? rows[0].afterHash : null;
	},
};
