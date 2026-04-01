import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../db";
import { chapters, narratorMessageRefs, narratorMessages, narrators, projects } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId, generateShortId } from "../lib/id";
import { logger } from "../lib/logger";
import { isInsidePath } from "../lib/platform-path";
import type { Locale } from "../lib/prompt-i18n";
import { slugify } from "../lib/slug";
import { safeSpawn } from "../lib/spawn";
import { chapterEdgeService } from "./chapter-edge-service";
import { commitSyncService } from "./commit-sync-service";
import { containerService } from "./container-service";
import { rebuildFileStatesAtMessage } from "./file-state-rebuild";
import { gitService } from "./git-service";
import { narratorService } from "./narrator-service";
import { portAllocator } from "./port-allocator";

export interface ForkChapterInput {
	title?: string;
	description?: string;
	inheritMode?: "full" | "compressed" | "fresh";
	forkAtMessageUuid?: string;
	/** Explicit commit SHA to fork from (ruler mode). Overrides forkAtMessageUuid. */
	startCommitSha?: string;
	/** Chapter role: branch or exploration (trunk is reserved for the root chapter). */
	role?: "branch" | "exploration";
	locale?: Locale;
	/** Explicit graph position — if provided, skip auto-layout calculation. */
	anchorCommitSha?: string;
	axisOffset?: number;
	crossOffset?: number;
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
		// Priority: startCommitSha (ruler mode) > forkAtMessageUuid > parent HEAD
		let commitSha: string;
		if (input.startCommitSha) {
			commitSha = input.startCommitSha;
		} else if (input.forkAtMessageUuid) {
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
			// Those changes are tracked in narrator_file_snapshots + narrator_tool_calls.
			if (input.forkAtMessageUuid) {
				try {
					const fileStates = await this.resolveFileStatesForMessage(
						parentChapterId,
						input.forkAtMessageUuid,
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
					// Non-fatal: degrade to commit-only state rather than failing the fork
					logger.warn("Failed to apply file snapshots during fork (non-fatal)", {
						parentChapterId,
						childChapterId: id,
						error: String(err),
					});
				}
			}

			// Step 2: Compute initial graph position
			// Place close to the ruler (small crossOffset) and avoid overlapping existing chapters.
			const NODE_CROSS_SIZE = 100; // approximate height of a chapter card + gap

			let anchorCommitSha: string | null;
			let axisOffset: number;
			let crossOffset: number;

			if (input.anchorCommitSha != null) {
				// Use explicit position from the client
				anchorCommitSha = input.anchorCommitSha;
				axisOffset = input.axisOffset ?? 0;
				crossOffset = input.crossOffset ?? 0;
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
	 * Rebuild the file state at a specific message by replaying Write/Edit
	 * tool calls from narrator_file_snapshots + narrator_tool_calls.
	 *
	 * Returns a Map of filePath → content for all files the narrator touched
	 * up to (and including) the fork message.
	 */
	async resolveFileStatesForMessage(
		chapterId: string,
		messageUuid: string,
	): Promise<Map<string, string | null>> {
		const primaryNarrator = await db.query.narrators.findFirst({
			where: and(eq(narrators.chapterId, chapterId), eq(narrators.type, "primary")),
		});
		if (!primaryNarrator) return new Map();

		const targetMsg = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.messageUuid, messageUuid),
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
