import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, narrators, projects } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId, generateShortId } from "../lib/id";
import { logger } from "../lib/logger";
import type { Locale } from "../lib/prompt-i18n";
import { containerService } from "./container-service";
import { gitService } from "./git-service";
import { narratorContext } from "./narrator-context";

export function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "")
		.slice(0, 30);
}

export interface ForkChapterInput {
	title: string;
	description?: string;
	inheritMode?: "full" | "compressed" | "fresh";
	forkAtMessageUuid?: string;
	locale?: Locale;
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
		const slug = slugify(input.title);
		const shortId = generateShortId(6);
		const branchName = `chapter/${slug}-${shortId}`;
		const worktreePath = resolve(gitPath, ".worktrees", `${slug}-${shortId}`);
		const now = new Date().toISOString();
		const id = generateId();

		// Get current commit SHA for fork point
		const commitSha = parent.worktreePath
			? await gitService.getHeadCommit(parent.worktreePath)
			: await gitService.getHeadCommit(gitPath);

		const forkPoint: { commitSha: string; narratorMessageUuid?: string } = { commitSha };
		if (input.forkAtMessageUuid) {
			forkPoint.narratorMessageUuid = input.forkAtMessageUuid;
		}

		const rollback: Array<() => Promise<void>> = [];

		try {
			// Step 1: Create git branch + worktree
			await gitService.createBranch(gitPath, branchName, parent.branch);
			rollback.push(() => gitService.deleteBranch(gitPath, branchName));

			await gitService.createWorktree(gitPath, worktreePath, branchName);
			rollback.push(() => gitService.removeWorktree(gitPath, worktreePath));

			// Step 2: Create DB record
			const [chapter] = await db
				.insert(chapters)
				.values({
					id,
					projectId: parent.projectId,
					title: input.title,
					description: input.description,
					status: "active",
					branch: branchName,
					worktreePath,
					baseBranch: parent.branch,
					parentChapterId,
					forkPoint,
					lastAccessedAt: now,
					createdAt: now,
					updatedAt: now,
				})
				.returning();
			rollback.push(async () => {
				await db.delete(chapters).where(eq(chapters.id, id));
			});

			// Step 3: Copy project-configured files
			if (project.copyFiles && parent.worktreePath) {
				const files = JSON.parse(project.copyFiles) as string[];
				if (files.length > 0) {
					await gitService.copyFiles(parent.worktreePath, worktreePath, files);
				}
			}

			// Step 4: Fork narrators
			const parentNarrators = await db.query.narrators.findMany({
				where: eq(narrators.chapterId, parentChapterId),
			});
			for (const parentNarrator of parentNarrators) {
				const forkedNarrator = await narratorContext.forkNarrator({
					parentNarratorId: parentNarrator.id,
					newChapterId: id,
					inheritMode,
					forkAtMessageUuid: input.forkAtMessageUuid,
					type: parentNarrator.type as "primary" | "secondary",
					locale: input.locale,
				});
				rollback.push(async () => {
					await db.delete(narrators).where(eq(narrators.id, forkedNarrator.id));
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
				}
			}

			// Step 6: Execute startup script (if project has one)
			if (project.startupScript) {
				try {
					const proc = Bun.spawn(["sh", "-c", project.startupScript], {
						cwd: worktreePath,
						stdout: "pipe",
						stderr: "pipe",
						env: { ...process.env, NARRAFORK_CHAPTER_ID: id },
					});
					const timeout = setTimeout(() => {
						proc.kill();
						logger.warn("Startup script timed out during fork", { chapterId: id });
					}, 60_000);
					const exitCode = await proc.exited;
					clearTimeout(timeout);
					if (exitCode !== 0) {
						const stderr = await new Response(proc.stderr).text();
						logger.warn("Startup script failed during fork (non-fatal)", {
							chapterId: id,
							exitCode,
							stderr: stderr.trim(),
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
};
