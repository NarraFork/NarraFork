import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, narrators, projects } from "../db/schema";
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
		const source = await db.query.chapters.findFirst({ where: eq(chapters.id, sourceChapterId) });
		if (!source) throw new NotFoundError("Chapter", sourceChapterId);
		const target = await db.query.chapters.findFirst({ where: eq(chapters.id, targetChapterId) });
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
		const source = await db.query.chapters.findFirst({ where: eq(chapters.id, sourceChapterId) });
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

		let result: MergeResult;
		if (strategy === "cherry-pick") {
			const baseSha = await gitService.getMergeBase(gitPath, target.branch, source.branch);
			result = await gitService.cherryPick(target.worktreePath, gitPath, source.branch, baseSha);
		} else {
			result = await gitService.merge(target.worktreePath, source.branch, strategy, message);
		}

		if (result.success) {
			await this.markMerged(sourceChapterId, input.targetChapterId, strategy, result.commitSha);
		} else if (result.conflictFiles) {
			eventBus.emit({
				type: "chapter:conflict",
				sourceId: sourceChapterId,
				targetId: input.targetChapterId,
				files: result.conflictFiles,
			});
			if (strategy !== "cherry-pick") {
				try {
					await gitService.mergeAbort(target.worktreePath);
				} catch {
					// merge-abort may fail if no merge in progress
				}
			}
		}

		return result;
	},

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
		let conflictFiles: string[];

		if (strategy === "cherry-pick") {
			const baseSha = await gitService.getMergeBase(gitPath, target.branch, source.branch);
			const cpResult = await gitService.cherryPick(
				target.worktreePath,
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
			const mergeResult = await gitService.mergeNoCommit(
				target.worktreePath,
				source.branch,
				strategy,
			);
			if (!mergeResult.hasConflicts) {
				const commitSha = await gitService.autoCommit(target.worktreePath, message);
				return this.markMergedResult(
					sourceChapterId,
					input.targetChapterId,
					strategy,
					commitSha ?? undefined,
				);
			}
			conflictFiles = mergeResult.conflictFiles;
		}

		const prompt = buildConflictResolutionPrompt(conflictFiles, source.branch, target.branch);
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

			const remainingConflicts = await gitService.getConflictFiles(target.worktreePath);
			if (remainingConflicts.length > 0) {
				await gitService.mergeAbort(target.worktreePath);
				return {
					resolved: false,
					error: `Narrator could not resolve all conflicts. Remaining: ${remainingConflicts.join(", ")}`,
				};
			}

			const commitSha = await gitService.autoCommit(target.worktreePath, message);
			return this.markMergedResult(
				sourceChapterId,
				input.targetChapterId,
				strategy,
				commitSha ?? undefined,
			);
		} catch (err) {
			logger.error("AI conflict resolution failed", { error: String(err) });
			try {
				await gitService.mergeAbort(target.worktreePath);
			} catch {
				// best effort
			}
			return { resolved: false, error: String(err) };
		}
	},

	async markMerged(
		sourceChapterId: string,
		targetChapterId: string,
		strategy: string,
		commitSha?: string,
	): Promise<void> {
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

		logger.info("Chapter merged", {
			sourceId: sourceChapterId,
			targetId: targetChapterId,
			strategy,
			commitSha,
		});
		eventBus.emit({ type: "chapter:merged", sourceId: sourceChapterId, targetId: targetChapterId });
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
