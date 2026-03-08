import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
	chapters,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	projects,
	users,
} from "../db/schema";
import { agentGenerateWithMeta } from "../lib/agent";
import { logger } from "../lib/logger";
import { getPrompt, getUserLanguage, type Locale } from "../lib/prompt-i18n";
import { settings } from "../lib/settings";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { narratorService } from "./narrator-service";

/** Maximum number of commits to include in the summary input. */
const MAX_COMMITS_FOR_SUMMARY = 50;

/**
 * Get commit log for a branch relative to its base branch.
 * Returns formatted commit messages for summarization.
 */
async function getCommitMessages(
	gitPath: string,
	branch: string,
	baseBranch: string,
): Promise<string[]> {
	const proc = Bun.spawn(
		[
			"git",
			"log",
			`--format=%s`,
			`--max-count=${MAX_COMMITS_FOR_SUMMARY}`,
			`${baseBranch}..${branch}`,
			"--",
		],
		{ cwd: gitPath, stdout: "pipe", stderr: "pipe" },
	);
	const stdout = await new Response(proc.stdout).text();
	await proc.exited;
	return stdout
		.trim()
		.split("\n")
		.filter((l) => l.trim());
}

/**
 * Get diff stat summary for a branch relative to its base.
 */
async function getDiffStat(gitPath: string, branch: string, baseBranch: string): Promise<string> {
	const proc = Bun.spawn(["git", "diff", "--stat", `${baseBranch}...${branch}`], {
		cwd: gitPath,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	await proc.exited;
	// Take only the summary line (last line) + up to 30 file lines
	const lines = stdout.trim().split("\n");
	if (lines.length <= 31) return stdout.trim();
	return [...lines.slice(0, 30), "...", lines[lines.length - 1]].join("\n");
}

interface MergeSummaryInput {
	sourceChapterId: string;
	targetChapterId: string;
	userId?: string;
	strategy: string;
	commitSha?: string;
	/** Pre-collected commit messages (collected before merge to avoid empty range). */
	preCollectedCommits?: string[];
	/** Pre-collected diff stat (collected before merge). */
	preCollectedDiffStat?: string;
}

/**
 * Collect commit messages and diff stat for a branch before merge.
 * Must be called BEFORE the git merge — after merge, the commit range
 * `baseBranch..branch` may be empty (especially for fast-forward merges).
 */
export async function collectMergeContext(
	gitPath: string,
	branch: string,
	baseBranch: string,
): Promise<{ commits: string[]; diffStat: string }> {
	const [commits, diffStat] = await Promise.all([
		getCommitMessages(gitPath, branch, baseBranch),
		getDiffStat(gitPath, branch, baseBranch),
	]);
	return { commits, diffStat };
}

export const mergeSummaryService = {
	/**
	 * Asynchronously generate a merge summary and inject it as a message
	 * into the target chapter's primary narrator. Uses role="user" so the
	 * SDK includes it in conversation history (role="system" is filtered
	 * out by buildHistory). Fire-and-forget — errors are logged but never
	 * propagated to the caller.
	 */
	async generateAndInject(input: MergeSummaryInput): Promise<void> {
		const { sourceChapterId, targetChapterId, userId, strategy, commitSha } = input;

		try {
			// Fetch source and target chapters
			const [source, target] = await Promise.all([
				db.query.chapters.findFirst({ where: eq(chapters.id, sourceChapterId) }),
				db.query.chapters.findFirst({ where: eq(chapters.id, targetChapterId) }),
			]);
			if (!source || !target) {
				logger.warn("Merge summary: chapter not found", { sourceChapterId, targetChapterId });
				return;
			}

			// Find target chapter's primary narrator
			const primaryNarrator = await db.query.narrators.findFirst({
				where: and(eq(narrators.chapterId, targetChapterId), eq(narrators.type, "primary")),
			});
			if (!primaryNarrator) {
				logger.debug("Merge summary: no primary narrator on target, skipping", {
					targetChapterId,
				});
				return;
			}

			// Get project git path
			const project = await db.query.projects.findFirst({
				where: eq(projects.id, source.projectId),
			});
			if (!project?.gitPath) {
				logger.warn("Merge summary: project has no git path", {
					projectId: source.projectId,
				});
				return;
			}

			// Resolve user info
			let username: string | undefined;
			let locale: Locale = "en";
			if (userId) {
				const [user, userLocale] = await Promise.all([
					db.query.users.findFirst({
						where: eq(users.id, userId),
						columns: { username: true },
					}),
					getUserLanguage(userId),
				]);
				username = user?.username;
				locale = userLocale;
			}

			// Use pre-collected data when available (collected before merge).
			// Fall back to git queries (may return empty for fast-forward merges).
			let commitMessages: string[];
			let diffStat: string;
			if (input.preCollectedCommits && input.preCollectedCommits.length > 0) {
				commitMessages = input.preCollectedCommits;
				diffStat = input.preCollectedDiffStat ?? "";
			} else {
				[commitMessages, diffStat] = await Promise.all([
					getCommitMessages(project.gitPath, source.branch, source.baseBranch),
					getDiffStat(project.gitPath, source.branch, source.baseBranch),
				]);
			}

			if (commitMessages.length === 0) {
				logger.debug("Merge summary: no commits to summarize", { sourceChapterId });
				return;
			}

			// Build the input for the summary model
			const commitList = commitMessages.map((m, i) => `${i + 1}. ${m}`).join("\n");
			const userText = [
				`Branch: ${source.branch}`,
				`Merged into: ${target.branch}`,
				`Strategy: ${strategy}`,
				commitSha ? `Merge commit: ${commitSha}` : null,
				username ? `Merged by: ${username}` : null,
				source.title ? `Chapter title: ${source.title}` : null,
				source.description ? `Description: ${source.description}` : null,
				``,
				`Commits (${commitMessages.length}):`,
				commitList,
				``,
				`Diff summary:`,
				diffStat,
			]
				.filter((l) => l !== null)
				.join("\n");

			const systemPrompt = getPrompt("mergeSummary", locale);

			// Call the summary model (Haiku)
			const result = await agentGenerateWithMeta(
				userText,
				settings.agent.summaryModel,
				systemPrompt,
			);

			const summary = result.text?.trim();
			if (!summary) {
				logger.warn("Merge summary: model returned empty output", { sourceChapterId });
				return;
			}

			// Build the system message content
			const mergedByText = username ? ` by ${username}` : "";
			const headerEn = `[Branch Merged] "${source.branch}" → "${target.branch}"${mergedByText} (${strategy})`;
			const headerZh = `[分支已合并] "${source.branch}" → "${target.branch}"${mergedByText} (${strategy})`;
			const header = locale === "zh-CN" ? headerZh : headerEn;
			const fullContent = `${header}\n\n${summary}`;

			// Insert via persistSystemMessage (role="user" + text block) so the
			// SDK includes it in conversation history. Append a structured
			// merge_summary block for the UI to render as a card.
			const msg = await narratorService.persistSystemMessage(primaryNarrator.id, fullContent, [
				{
					type: "merge_summary",
					sourceBranch: source.branch,
					sourceChapterId,
					targetBranch: target.branch,
					strategy,
					commitSha: commitSha ?? null,
					mergedBy: username ?? null,
					summary,
				},
			]);

			logger.info("Merge summary injected", {
				sourceChapterId,
				targetChapterId,
				narratorId: primaryNarrator.id,
				summaryLength: summary.length,
			});

			// Broadcast as a standard "message" event so the chat UI picks it up
			// in real-time (same pattern as auto-commit messages).
			broadcastToNarrator(primaryNarrator.id, {
				type: "message",
				narratorId: primaryNarrator.id,
				message: msg,
			});
		} catch (err) {
			logger.error("Merge summary generation failed (non-fatal)", {
				sourceChapterId,
				targetChapterId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	},

	/**
	 * Remove merge_summary messages for a given source chapter from all narrators.
	 * Called during unmerge to clean up stale summary cards.
	 *
	 * Uses a JSON content search to find messages containing the sourceChapterId
	 * in a merge_summary block, then deletes the message and its refs.
	 */
	async cleanupForSource(sourceChapterId: string): Promise<number> {
		// Find messages whose contentJson contains a merge_summary block
		// referencing this source chapter. SQLite JSON: content_json is stored
		// as text, so we use LIKE for a simple substring match.
		const rows = await db
			.select({ id: narratorMessages.id })
			.from(narratorMessages)
			.where(
				and(
					sql`${narratorMessages.contentJson} LIKE '%"type":"merge_summary"%'`,
					sql`${narratorMessages.contentJson} LIKE ${`%${sourceChapterId}%`}`,
				),
			);

		if (rows.length === 0) return 0;

		const ids = rows.map((r) => r.id);

		// Delete refs first (FK), then messages
		await db.transaction(async (tx) => {
			for (const id of ids) {
				await tx.delete(narratorMessageRefs).where(eq(narratorMessageRefs.messageId, id));
				await tx.delete(narratorMessages).where(eq(narratorMessages.id, id));
			}
		});

		logger.info("Cleaned up merge summary messages", {
			sourceChapterId,
			deletedCount: ids.length,
		});

		return ids.length;
	},
};
