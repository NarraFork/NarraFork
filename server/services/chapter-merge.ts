import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, narrators, projects } from "../db/schema";
import { worktreeLock } from "../lib/async-mutex";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { getPrompt, type Locale } from "../lib/prompt-i18n";
import { chapterEdgeService } from "./chapter-edge-service";
import { gitService } from "./git-service";
import { startSession } from "./narrator-session";
import { terminalService } from "./terminal-service";

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

async function getProjectGitPath(projectId: string): Promise<string> {
	const project = await db.query.projects.findFirst({
		where: eq(projects.id, projectId),
	});
	if (!project?.gitPath) throw new ValidationError("Project has no git repository configured");
	return project.gitPath;
}

export const chapterMerge = {
	async checkConflicts(
		sourceChapterId: string,
		targetChapterId: string,
	): Promise<MergeCheckResult> {
		const source = await db.query.chapters.findFirst({
			where: eq(chapters.id, sourceChapterId),
		});
		if (!source) throw new NotFoundError("Chapter", sourceChapterId);
		const target = await db.query.chapters.findFirst({
			where: eq(chapters.id, targetChapterId),
		});
		if (!target) throw new NotFoundError("Chapter", targetChapterId);
		if (source.status !== "active") throw new ValidationError("Source chapter must be active");
		if (target.status !== "active") throw new ValidationError("Target chapter must be active");
		if (source.projectId !== target.projectId) {
			throw new ValidationError("Cannot merge chapters from different projects");
		}

		const gitPath = await getProjectGitPath(source.projectId);

		const baseSha = await gitService.getMergeBase(gitPath, target.branch, source.branch);
		const { hasConflicts, conflictFiles } = await gitService.mergeTree(
			gitPath,
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

	async merge(sourceChapterId: string, input: MergeChapterInput): Promise<MergeResult> {
		const source = await db.query.chapters.findFirst({
			where: eq(chapters.id, sourceChapterId),
		});
		if (!source) throw new NotFoundError("Chapter", sourceChapterId);
		const target = await db.query.chapters.findFirst({
			where: eq(chapters.id, input.targetChapterId),
		});
		if (!target) throw new NotFoundError("Chapter", input.targetChapterId);
		if (source.status !== "active" && source.status !== "dormant") {
			throw new ValidationError("Source chapter must be active or dormant");
		}
		if (target.status !== "active") throw new ValidationError("Target chapter must be active");
		if (!target.worktreePath) throw new ValidationError("Target chapter has no worktree");
		if (source.projectId !== target.projectId) {
			throw new ValidationError("Cannot merge chapters from different projects");
		}

		const gitPath = await getProjectGitPath(source.projectId);
		const strategy = input.strategy ?? "merge";
		const message = input.message ?? `Merge ${source.branch} into ${target.branch}`;
		const targetWorktree = target.worktreePath;

		// Lock the target worktree to prevent concurrent git operations
		return worktreeLock.acquire(targetWorktree, async () => {
			let result: MergeResult;
			if (strategy === "cherry-pick") {
				const baseSha = await gitService.getMergeBase(gitPath, target.branch, source.branch);
				result = await gitService.cherryPick(targetWorktree, gitPath, source.branch, baseSha);
			} else {
				result = await gitService.merge(targetWorktree, source.branch, strategy, message);
			}

			if (result.success) {
				// Git succeeded — persist to DB with retry on failure
				try {
					await this.markMerged(sourceChapterId, input.targetChapterId, strategy, result.commitSha);
				} catch (dbErr) {
					logger.error("Failed to mark chapter as merged after successful git merge, retrying", {
						sourceChapterId,
						targetChapterId: input.targetChapterId,
						commitSha: result.commitSha,
						error: String(dbErr),
					});
					try {
						await this.markMerged(
							sourceChapterId,
							input.targetChapterId,
							strategy,
							result.commitSha,
						);
					} catch (retryErr) {
						// DB is inconsistent but git merge succeeded — log and
						// return success so the caller doesn't retry the git op.
						logger.error("Retry also failed, DB state may be inconsistent", {
							sourceChapterId,
							error: String(retryErr),
						});
					}
				}
			} else if (result.conflictFiles) {
				eventBus.emit({
					type: "chapter:conflict",
					sourceId: sourceChapterId,
					targetId: input.targetChapterId,
					files: result.conflictFiles,
				});
				if (strategy !== "cherry-pick") {
					try {
						await gitService.mergeAbort(targetWorktree);
					} catch {
						// merge-abort may fail if no merge in progress
					}
				}
			}

			return result;
		});
	},

	async aiResolveConflicts(
		sourceChapterId: string,
		input: MergeChapterInput,
		locale: Locale = "en",
	): Promise<AiResolveResult> {
		const source = await db.query.chapters.findFirst({
			where: eq(chapters.id, sourceChapterId),
		});
		if (!source) throw new NotFoundError("Chapter", sourceChapterId);
		const target = await db.query.chapters.findFirst({
			where: eq(chapters.id, input.targetChapterId),
		});
		if (!target) throw new NotFoundError("Chapter", input.targetChapterId);
		if (!target.worktreePath) throw new ValidationError("Target chapter has no worktree");
		if (source.projectId !== target.projectId) {
			throw new ValidationError("Cannot merge chapters from different projects");
		}

		const primaryNarrator = await db.query.narrators.findFirst({
			where: and(eq(narrators.chapterId, input.targetChapterId), eq(narrators.type, "primary")),
		});
		if (!primaryNarrator) {
			return { resolved: false, error: "Target chapter has no primary narrator" };
		}

		const gitPath = await getProjectGitPath(source.projectId);

		const strategy = input.strategy ?? "merge";
		const message = input.message ?? `Merge ${source.branch} into ${target.branch}`;
		const targetWorktree = target.worktreePath;

		// Lock the target worktree for the entire AI resolution
		return worktreeLock.acquire(targetWorktree, async () => {
			let conflictFiles: string[];

			if (strategy === "cherry-pick") {
				const baseSha = await gitService.getMergeBase(gitPath, target.branch, source.branch);
				const cpResult = await gitService.cherryPick(
					targetWorktree,
					gitPath,
					source.branch,
					baseSha,
				);
				if (cpResult.success) {
					return this.markMergedResult(
						sourceChapterId,
						input.targetChapterId,
						strategy,
						cpResult.commitSha,
					);
				}
				conflictFiles = cpResult.conflictFiles ?? [];
			} else {
				const mergeResult = await gitService.mergeNoCommit(targetWorktree, source.branch, strategy);
				if (!mergeResult.hasConflicts) {
					const commitSha = await gitService.autoCommit(targetWorktree, message);
					return this.markMergedResult(
						sourceChapterId,
						input.targetChapterId,
						strategy,
						commitSha ?? undefined,
					);
				}
				conflictFiles = mergeResult.conflictFiles;
			}

			const prompt = buildConflictResolutionPrompt(
				conflictFiles,
				source.branch,
				target.branch,
				locale,
			);
			logger.info("Starting AI conflict resolution", {
				sourceId: sourceChapterId,
				targetId: input.targetChapterId,
				conflictFiles,
				narratorId: primaryNarrator.id,
			});

			try {
				for await (const _event of startSession(primaryNarrator.id, prompt)) {
					// drain the session — the narrator resolves conflicts in the worktree
				}

				const remainingConflicts = await gitService.getConflictFiles(targetWorktree);
				if (remainingConflicts.length > 0) {
					await gitService.mergeAbort(targetWorktree);
					return {
						resolved: false,
						error: `Narrator could not resolve all conflicts. Remaining: ${remainingConflicts.join(", ")}`,
					};
				}

				const commitSha = await gitService.autoCommit(targetWorktree, message);
				return this.markMergedResult(
					sourceChapterId,
					input.targetChapterId,
					strategy,
					commitSha ?? undefined,
				);
			} catch (err) {
				logger.error("AI conflict resolution failed", { error: String(err) });
				try {
					await gitService.mergeAbort(targetWorktree);
				} catch {
					// best effort
				}
				return { resolved: false, error: String(err) };
			}
		});
	},

	async markMerged(
		sourceChapterId: string,
		targetChapterId: string,
		strategy: string,
		commitSha?: string,
	): Promise<void> {
		const source = await db.query.chapters.findFirst({
			where: eq(chapters.id, sourceChapterId),
		});
		const now = new Date().toISOString();

		// Clean up source chapter's worktree — merged chapters don't need one
		if (source?.worktreePath) {
			try {
				const gitPath = await getProjectGitPath(source.projectId);
				await terminalService.cleanupForChapter(sourceChapterId);
				await gitService.removeWorktree(gitPath, source.worktreePath);
			} catch (err) {
				logger.warn("Failed to clean up source worktree after merge", {
					sourceChapterId,
					error: String(err),
				});
			}
		}

		await db
			.update(chapters)
			.set({
				status: "merged",
				worktreePath: null,
				mergedIntoChapterId: targetChapterId,
				mergeCommitSha: commitSha,
				mergeStrategy: strategy as "merge" | "squash" | "cherry-pick",
				updatedAt: now,
			})
			.where(eq(chapters.id, sourceChapterId));

		// Create merge edge in chapter_edges
		if (source) {
			try {
				await chapterEdgeService.createMergeEdge(
					source.projectId,
					sourceChapterId,
					targetChapterId,
					{
						mergeCommitSha: commitSha,
						strategy: strategy as string,
					},
				);
			} catch (err) {
				console.error("Failed to create merge edge:", err);
			}
		}

		logger.info("Chapter merged", {
			sourceId: sourceChapterId,
			targetId: targetChapterId,
			strategy,
			commitSha,
		});
		eventBus.emit({
			type: "chapter:merged",
			sourceId: sourceChapterId,
			targetId: targetChapterId,
		});
	},

	async markMergedResult(
		sourceChapterId: string,
		targetChapterId: string,
		strategy: string,
		commitSha?: string,
	): Promise<AiResolveResult> {
		await this.markMerged(sourceChapterId, targetChapterId, strategy, commitSha);
		return { resolved: true, mergeResult: { success: true, commitSha } };
	},
};

function buildConflictResolutionPrompt(
	conflictFiles: string[],
	sourceBranch: string,
	targetBranch: string,
	locale: Locale = "en",
): string {
	const fileList = conflictFiles.map((f) => `  - ${f}`).join("\n");
	return getPrompt("conflictResolution", locale)
		.replace("{sourceBranch}", sourceBranch)
		.replace("{targetBranch}", targetBranch)
		.replace("{fileList}", fileList);
}
