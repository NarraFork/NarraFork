import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, narrators, repositories } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId, generateShortId } from "../lib/id";
import { logger } from "../lib/logger";
import { gitService } from "./git-service";
import { narratorContext } from "./narrator-context";

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "")
		.slice(0, 30);
}

export interface ForkChapterInput {
	title: string;
	description?: string;
	type?: "meanwhile" | "whatif";
	inheritMode?: "full" | "compressed" | "fresh";
	forkAtMessageUuid?: string;
}

export const chapterFork = {
	/**
	 * Fork a chapter with atomic operations and rollback stack.
	 * 6-step process: DB record → worktree → copy files → fork narrators → (container) → (startup script)
	 */
	async fork(parentChapterId: string, input: ForkChapterInput) {
		const parent = await db.query.chapters.findFirst({
			where: eq(chapters.id, parentChapterId),
		});
		if (!parent) throw new NotFoundError("Chapter", parentChapterId);
		if (parent.status !== "active") {
			throw new ValidationError("Can only fork active chapters");
		}

		const repo = await db.query.repositories.findFirst({
			where: eq(repositories.id, parent.repositoryId),
		});
		if (!repo) throw new NotFoundError("Repository", parent.repositoryId);

		const type = input.type ?? parent.type;
		const inheritMode = input.inheritMode ?? "full";
		const slug = slugify(input.title);
		const shortId = generateShortId(6);
		const branchName = `${type}/${slug}-${shortId}`;
		const worktreePath = resolve(repo.path, ".worktrees", `${slug}-${shortId}`);
		const now = new Date().toISOString();
		const id = generateId();

		// Get current commit SHA for fork point
		const commitSha = parent.worktreePath
			? await gitService.getHeadCommit(parent.worktreePath)
			: await gitService.getHeadCommit(repo.path);

		// Build fork point metadata
		const forkPoint: { commitSha: string; narratorMessageUuid?: string } = { commitSha };
		if (input.forkAtMessageUuid) {
			forkPoint.narratorMessageUuid = input.forkAtMessageUuid;
		}

		const rollback: Array<() => Promise<void>> = [];

		try {
			// Step 1: Create DB record
			const [chapter] = await db
				.insert(chapters)
				.values({
					id,
					projectId: parent.projectId,
					repositoryId: parent.repositoryId,
					title: input.title,
					description: input.description,
					type,
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

			// Step 2: Create git branch + worktree
			await gitService.createBranch(repo.path, branchName, parent.branch);
			rollback.push(() => gitService.deleteBranch(repo.path, branchName));

			await gitService.createWorktree(repo.path, worktreePath, branchName);
			rollback.push(() => gitService.removeWorktree(repo.path, worktreePath));

			// Step 3: Copy repo-configured copyFiles
			if (repo.copyFiles) {
				const files = JSON.parse(repo.copyFiles) as string[];
				if (files.length > 0 && parent.worktreePath) {
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
				});
				rollback.push(async () => {
					await db.delete(narrators).where(eq(narrators.id, forkedNarrator.id));
				});
			}

			// Steps 5-6: Container startup and startup script are Phase 4 concerns

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
