import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, narrators, repositories } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { gitService } from "./git-service";
import { startSession } from "./narrator-session";

export interface MergeCheckResult {
	canMerge: boolean;
	hasConflicts: boolean;
	conflictFiles: string[];
	sourceBranch: string;
	targetBranch: string;
}

export interface MergeChapterInput {
	targetChapterId: string;
	strategy?: "merge" | "squash" | "cherry-pick";
	message?: string;
}

export interface MergeResult {
	success: boolean;
	commitSha?: string;
	conflictFiles?: string[];
}

export interface AiResolveResult {
	resolved: boolean;
	mergeResult?: MergeResult;
	error?: string;
}

export const chapterMerge = {
	/**
	 * Pre-check merge conflicts using git merge-tree simulation.
	 * Does not modify any worktree.
	 */
	async checkConflicts(
		sourceChapterId: string,
		targetChapterId: string,
	): Promise<MergeCheckResult> {
		const source = await db.query.chapters.findFirst({ where: eq(chapters.id, sourceChapterId) });
		if (!source) throw new NotFoundError("Chapter", sourceChapterId);

		const target = await db.query.chapters.findFirst({ where: eq(chapters.id, targetChapterId) });
		if (!target) throw new NotFoundError("Chapter", targetChapterId);

		if (source.status !== "active") throw new ValidationError("Source chapter must be active");
		if (target.status !== "active") throw new ValidationError("Target chapter must be active");

		const repo = await db.query.repositories.findFirst({
			where: eq(repositories.id, source.repositoryId),
		});
		if (!repo) throw new NotFoundError("Repository", source.repositoryId);

		const baseSha = await gitService.getMergeBase(repo.path, target.branch, source.branch);
		const { hasConflicts, conflictFiles } = await gitService.mergeTree(
			repo.path,
			baseSha,
			target.branch,
			source.branch,
		);

		return {
			canMerge: !hasConflicts,
			hasConflicts,
			conflictFiles,
			sourceBranch: source.branch,
			targetBranch: target.branch,
		};
	},

	/**
	 * Execute merge of source chapter into target chapter.
	 * Supports merge, squash, and cherry-pick strategies.
	 */
	async merge(sourceChapterId: string, input: MergeChapterInput): Promise<MergeResult> {
		const source = await db.query.chapters.findFirst({ where: eq(chapters.id, sourceChapterId) });
		if (!source) throw new NotFoundError("Chapter", sourceChapterId);

		const target = await db.query.chapters.findFirst({
			where: eq(chapters.id, input.targetChapterId),
		});
		if (!target) throw new NotFoundError("Chapter", input.targetChapterId);

		if (source.status !== "active" && source.status !== "dormant") {
			throw new ValidationError("Source chapter must be active or dormant");
		}
		if (target.status !== "active") {
			throw new ValidationError("Target chapter must be active");
		}
		if (!target.worktreePath) {
			throw new ValidationError("Target chapter has no worktree");
		}

		const repo = await db.query.repositories.findFirst({
			where: eq(repositories.id, source.repositoryId),
		});
		if (!repo) throw new NotFoundError("Repository", source.repositoryId);

		const strategy = input.strategy ?? "merge";
		const message = input.message ?? `Merge ${source.branch} into ${target.branch}`;

		let result: MergeResult;

		if (strategy === "cherry-pick") {
			const baseSha = await gitService.getMergeBase(repo.path, target.branch, source.branch);
			result = await gitService.cherryPick(target.worktreePath, repo.path, source.branch, baseSha);
		} else {
			result = await gitService.merge(target.worktreePath, source.branch, strategy, message);
		}

		if (result.success) {
			const now = new Date().toISOString();
			await db
				.update(chapters)
				.set({
					status: "merged",
					mergedIntoChapterId: input.targetChapterId,
					mergeCommitSha: result.commitSha,
					mergeStrategy: strategy,
					updatedAt: now,
				})
				.where(eq(chapters.id, sourceChapterId));

			logger.info("Chapter merged", {
				sourceId: sourceChapterId,
				targetId: input.targetChapterId,
				strategy,
				commitSha: result.commitSha,
			});

			eventBus.emit({
				type: "chapter:merged",
				sourceId: sourceChapterId,
				targetId: input.targetChapterId,
			});
		} else if (result.conflictFiles) {
			eventBus.emit({
				type: "chapter:conflict",
				sourceId: sourceChapterId,
				targetId: input.targetChapterId,
				files: result.conflictFiles,
			});

			// Abort the failed merge to clean up
			if (strategy !== "cherry-pick" && target.worktreePath) {
				try {
					await gitService.mergeAbort(target.worktreePath);
				} catch {
					// merge-abort may fail if no merge in progress
				}
			}
		}

		return result;
	},

	/**
	 * AI-assisted conflict resolution.
	 * Performs the merge (leaving conflicts in worktree), then sends the target chapter's
	 * primary narrator a prompt to resolve them. After the narrator finishes, stages and
	 * commits the resolution, completing the merge.
	 *
	 * Flow: git merge (with conflicts) → narrator resolves files → git add -A && commit → done
	 */
	async aiResolveConflicts(
		sourceChapterId: string,
		input: MergeChapterInput,
	): Promise<AiResolveResult> {
		const source = await db.query.chapters.findFirst({ where: eq(chapters.id, sourceChapterId) });
		if (!source) throw new NotFoundError("Chapter", sourceChapterId);

		const target = await db.query.chapters.findFirst({
			where: eq(chapters.id, input.targetChapterId),
		});
		if (!target) throw new NotFoundError("Chapter", input.targetChapterId);
		if (!target.worktreePath) throw new ValidationError("Target chapter has no worktree");

		// Find target chapter's primary narrator
		const primaryNarrator = await db.query.narrators.findFirst({
			where: and(eq(narrators.chapterId, input.targetChapterId), eq(narrators.type, "primary")),
		});
		if (!primaryNarrator) {
			return { resolved: false, error: "Target chapter has no primary narrator" };
		}

		const strategy = input.strategy ?? "merge";
		const message = input.message ?? `Merge ${source.branch} into ${target.branch}`;

		// Perform the merge, leaving conflict markers in the worktree
		// For merge/squash: git merge --no-commit so conflicts stay
		// For cherry-pick: conflicts are already left in place
		const repo = await db.query.repositories.findFirst({
			where: eq(repositories.id, source.repositoryId),
		});
		if (!repo) throw new NotFoundError("Repository", source.repositoryId);

		let conflictFiles: string[];

		if (strategy === "cherry-pick") {
			const baseSha = await gitService.getMergeBase(repo.path, target.branch, source.branch);
			const cpResult = await gitService.cherryPick(
				target.worktreePath,
				repo.path,
				source.branch,
				baseSha,
			);
			if (cpResult.success) {
				// No conflicts after all — just mark as merged
				return this.markMerged(
					sourceChapterId,
					input.targetChapterId,
					strategy,
					cpResult.commitSha,
				);
			}
			conflictFiles = cpResult.conflictFiles ?? [];
		} else {
			// Use --no-commit variant so conflicts stay in worktree for resolution
			const mergeResult = await gitService.mergeNoCommit(
				target.worktreePath,
				source.branch,
				strategy,
			);
			if (!mergeResult.hasConflicts) {
				// Clean merge — commit it
				const commitSha = await gitService.autoCommit(target.worktreePath, message);
				return this.markMerged(
					sourceChapterId,
					input.targetChapterId,
					strategy,
					commitSha ?? undefined,
				);
			}
			conflictFiles = mergeResult.conflictFiles;
		}

		// Send conflict resolution prompt to the narrator
		const prompt = buildConflictResolutionPrompt(conflictFiles, source.branch, target.branch);

		logger.info("Starting AI conflict resolution", {
			sourceId: sourceChapterId,
			targetId: input.targetChapterId,
			conflictFiles,
			narratorId: primaryNarrator.id,
		});

		try {
			// Consume the entire narrator session (it will edit files to resolve conflicts)
			for await (const _event of startSession(primaryNarrator.id, prompt)) {
				// We just drain the session — the narrator does its work in the worktree
			}

			// After narrator finishes, check if conflicts are resolved
			const remainingConflicts = await gitService.getConflictFiles(target.worktreePath);
			if (remainingConflicts.length > 0) {
				// Narrator didn't fully resolve — abort
				await gitService.mergeAbort(target.worktreePath);
				return {
					resolved: false,
					error: `Narrator could not resolve all conflicts. Remaining: ${remainingConflicts.join(", ")}`,
				};
			}

			// All resolved — commit
			const commitSha = await gitService.autoCommit(target.worktreePath, message);
			return this.markMerged(
				sourceChapterId,
				input.targetChapterId,
				strategy,
				commitSha ?? undefined,
			);
		} catch (err) {
			logger.error("AI conflict resolution failed", { error: String(err) });
			// Abort the in-progress merge
			try {
				await gitService.mergeAbort(target.worktreePath);
			} catch {
				// best effort
			}
			return { resolved: false, error: String(err) };
		}
	},

	/** Internal helper: mark source chapter as merged and emit events */
	async markMerged(
		sourceChapterId: string,
		targetChapterId: string,
		strategy: string,
		commitSha?: string,
	): Promise<AiResolveResult> {
		const now = new Date().toISOString();
		await db
			.update(chapters)
			.set({
				status: "merged",
				mergedIntoChapterId: targetChapterId,
				mergeCommitSha: commitSha,
				mergeStrategy: strategy as "merge" | "squash" | "cherry-pick",
				updatedAt: now,
			})
			.where(eq(chapters.id, sourceChapterId));

		eventBus.emit({ type: "chapter:merged", sourceId: sourceChapterId, targetId: targetChapterId });
		return { resolved: true, mergeResult: { success: true, commitSha } };
	},
};

function buildConflictResolutionPrompt(
	conflictFiles: string[],
	sourceBranch: string,
	targetBranch: string,
): string {
	const fileList = conflictFiles.map((f) => `  - ${f}`).join("\n");
	return `A git merge from branch "${sourceBranch}" into "${targetBranch}" has produced conflicts in the following files:

${fileList}

Please resolve all merge conflicts in these files. The conflict markers (<<<<<<< HEAD, =======, >>>>>>>) are already present in the working directory. For each file:
1. Read the file to understand both sides of the conflict
2. Edit the file to produce the correct merged result, removing all conflict markers
3. Make sure the resolved code compiles and makes sense

Do NOT run git add or git commit — just resolve the conflicts in the files.`;
}
