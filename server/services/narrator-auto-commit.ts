import { agentGenerateWithHistory } from "../lib/agent";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { getAutoCommitMessage, type Locale } from "../lib/prompt-i18n";
import { settings } from "../lib/settings";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { commitSyncService } from "./commit-sync-service";
import { gitService } from "./git-service";
import { narratorService } from "./narrator-service";

const COMMIT_MSG_TIMEOUT_MS = 30_000;

const SYSTEM_PROMPT: Record<Locale, string> = {
	en: `You are a git commit message generator. Given a git diff, generate a concise commit message following the Conventional Commits format.

Rules:
- Use format: <type>(<optional scope>): <description>
- Types: feat, fix, refactor, style, docs, test, chore, perf, ci, build
- Description should be lowercase, imperative mood, no period at end
- If the diff covers multiple changes, summarize the primary change
- Keep the message under 72 characters
- Reply with ONLY the commit message, nothing else`,
	"zh-CN": `你是一个 git 提交消息生成器。根据给定的 git diff，生成一条遵循 Conventional Commits 格式的简洁提交消息。

规则：
- 格式：<type>(<可选 scope>): <描述>
- 类型：feat, fix, refactor, style, docs, test, chore, perf, ci, build
- 描述使用小写字母，祈使语气，末尾不加句号
- 如果 diff 涉及多个变更，总结主要变更
- 消息长度不超过 72 个字符
- 只回复提交消息本身，不要其他内容`,
};

/**
 * Per-narrator tracking to avoid spamming reminders.
 * Stores the total lines (added+removed) at which the last reminder was sent.
 * Reset when a commit happens (auto or manual).
 */
const lastReminderAt = new Map<string, number>();

/** Per-narrator lock to prevent concurrent force-commit operations. */
const forceCommitInProgress = new Set<string>();

/**
 * Generate a commit message via AI with timeout protection.
 * Shared by both autoCommitIfNeeded and forceCommitUncommitted.
 */
async function generateCommitMessage(diff: string, locale: Locale): Promise<string> {
	if (!diff.trim()) return "chore: update files";

	const systemPrompt = SYSTEM_PROMPT[locale] ?? SYSTEM_PROMPT.en;

	const generatePromise = agentGenerateWithHistory(
		systemPrompt,
		`<diff>\n${diff}\n</diff>`,
		settings.agent.summaryModel,
		locale,
	);

	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutHandle = setTimeout(
			() => reject(new Error("Commit message generation timed out")),
			COMMIT_MSG_TIMEOUT_MS,
		);
	});

	let commitMessage: string;
	try {
		commitMessage = await Promise.race([generatePromise, timeoutPromise]);
	} finally {
		clearTimeout(timeoutHandle);
		// The losing promise (generatePromise on timeout) continues running in the background.
		// Attach a no-op catch to prevent unhandled rejection if it fails after timeout.
		generatePromise.catch(() => {});
	}

	// Clean up: remove surrounding quotes, backticks, newlines
	commitMessage = commitMessage
		.trim()
		.replace(/^["'`""]+|["'`""]+$/g, "")
		.split("\n")[0]
		.trim();

	// Fallback if AI returned something unusable
	if (!commitMessage || commitMessage.length > 200) {
		commitMessage = "chore: auto-commit changes";
	}

	return commitMessage;
}

/**
 * Check for uncommitted changes and auto-commit with an AI-generated message.
 * Errors are logged and broadcast, never thrown to callers.
 */
export async function autoCommitIfNeeded(
	narratorId: string,
	chapterId: string,
	worktreePath: string,
	locale: Locale,
	lastAssistantMessageId?: string,
): Promise<void> {
	// Lightweight check — avoid the heavier getStatusSummary just to see if changes exist
	const status = await gitService.getStatus(worktreePath);
	if (!status) return;

	let started = false;
	try {
		broadcastToNarrator(narratorId, {
			type: "auto_commit_started",
			narratorId,
			chapterId,
		});
		started = true;

		const diff = await gitService.getFullDiff(worktreePath);
		const commitMessage = await generateCommitMessage(diff, locale);

		const commitSha = await gitService.autoCommit(worktreePath, commitMessage);
		if (!commitSha) return; // Shouldn't happen since we checked status, but be safe

		// Clear reminder tracking on successful commit
		lastReminderAt.delete(narratorId);

		logger.info("Auto-commit completed", { narratorId, chapterId, commitSha, commitMessage });

		// Record commit as a first-class entity
		try {
			await commitSyncService.recordCommit({
				chapterId,
				sha: commitSha,
				message: commitMessage,
				source: "auto",
				narratorId,
				narratorMessageId: lastAssistantMessageId,
			});
		} catch (err) {
			logger.warn("Failed to record auto-commit in chapter_commits", {
				chapterId,
				commitSha,
				error: String(err),
			});
		}

		// Inject system message into chat history so the narrator sees it next turn
		const text = getAutoCommitMessage("turnEndCommitted", locale, {
			commitSha: commitSha.slice(0, 8),
			commitMessage,
		});
		const msg = await narratorService.persistSystemMessage(narratorId, text, [
			{
				type: "auto_commit_notice",
				commitSha,
				commitMessage,
				trigger: "turn_end",
			},
		]);

		broadcastToNarrator(narratorId, {
			type: "auto_commit_done",
			narratorId,
			chapterId,
			commitSha,
			message: commitMessage,
		});

		// Broadcast the system message so the chat UI picks it up
		broadcastToNarrator(narratorId, {
			type: "message",
			narratorId,
			message: msg,
		});

		eventBus.emit({
			type: "narrator:auto_commit",
			narratorId,
			chapterId,
			commitSha,
			message: commitMessage,
		});

		// Broadcast updated git status (should be clean now after commit)
		const updatedStatus = await gitService.getStatusSummary(worktreePath);
		broadcastToNarrator(narratorId, {
			type: "git_status",
			narratorId,
			chapterId,
			toolUseId: "",
			status: updatedStatus,
		});
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		logger.error("Auto-commit failed", { narratorId, chapterId, error: errorMsg });

		// Only broadcast failure if we already told the frontend we started
		if (started) {
			broadcastToNarrator(narratorId, {
				type: "auto_commit_failed",
				narratorId,
				chapterId,
				error: errorMsg,
			});
		}
	}
}

// === Threshold-based commit reminder & forced commit ===

export interface UncommittedStats {
	linesAdded: number;
	linesRemoved: number;
	filesChanged: number;
}

/**
 * Check uncommitted change stats against configured thresholds.
 * Called from the onGitTrack hook after each file-mutating tool.
 *
 * - Soft threshold (reminder): injects a system message into chat urging the narrator to commit.
 * - Hard threshold (force commit): generates a commit message via AI and commits directly,
 *   then injects a system message recording what happened.
 *
 * Both thresholds check lines (added+removed) OR file count — whichever is exceeded first.
 */
export async function checkCommitThresholds(
	narratorId: string,
	chapterId: string,
	worktreePath: string,
	locale: Locale,
	stats: UncommittedStats,
): Promise<void> {
	const {
		autoCommitReminderLines,
		autoCommitReminderFiles,
		autoCommitForceLines,
		autoCommitForceFiles,
	} = settings.chapters;

	const totalLines = stats.linesAdded + stats.linesRemoved;

	// --- Hard threshold: force commit ---
	const forceByLines = autoCommitForceLines > 0 && totalLines >= autoCommitForceLines;
	const forceByFiles = autoCommitForceFiles > 0 && stats.filesChanged >= autoCommitForceFiles;

	if (forceByLines || forceByFiles) {
		await forceCommitUncommitted(narratorId, chapterId, worktreePath, locale, stats);
		return;
	}

	// --- Soft threshold: reminder ---
	const remindByLines = autoCommitReminderLines > 0 && totalLines >= autoCommitReminderLines;
	const remindByFiles =
		autoCommitReminderFiles > 0 && stats.filesChanged >= autoCommitReminderFiles;

	if (remindByLines || remindByFiles) {
		await sendCommitReminder(narratorId, chapterId, locale, stats);
	}
}

/**
 * Send a commit reminder to the narrator.
 * Avoids spamming: only sends if total lines have grown significantly since last reminder.
 */
async function sendCommitReminder(
	narratorId: string,
	chapterId: string,
	locale: Locale,
	stats: UncommittedStats,
): Promise<void> {
	const totalLines = stats.linesAdded + stats.linesRemoved;
	const lastTotal = lastReminderAt.get(narratorId) ?? 0;

	// Only re-remind if lines grew by at least 50% since last reminder
	if (lastTotal > 0 && totalLines < lastTotal * 1.5) return;

	lastReminderAt.set(narratorId, totalLines);

	const text = getAutoCommitMessage("commitReminder", locale, {
		linesAdded: stats.linesAdded,
		linesRemoved: stats.linesRemoved,
		filesChanged: stats.filesChanged,
	});

	try {
		// Persist reminder as a system message in chat history
		const msg = await narratorService.persistSystemMessage(narratorId, text, [
			{
				type: "auto_commit_reminder",
				linesAdded: stats.linesAdded,
				linesRemoved: stats.linesRemoved,
				filesChanged: stats.filesChanged,
			},
		]);

		broadcastToNarrator(narratorId, {
			type: "commit_reminder",
			narratorId,
			chapterId,
			linesAdded: stats.linesAdded,
			linesRemoved: stats.linesRemoved,
			filesChanged: stats.filesChanged,
		});

		// Also broadcast the message so the chat UI picks it up
		broadcastToNarrator(narratorId, {
			type: "message",
			narratorId,
			message: msg,
		});

		eventBus.emit({
			type: "narrator:commit_reminder",
			narratorId,
			chapterId,
			linesAdded: stats.linesAdded,
			linesRemoved: stats.linesRemoved,
			filesChanged: stats.filesChanged,
		});

		logger.info("Commit reminder sent", {
			narratorId,
			chapterId,
			totalLines,
			filesChanged: stats.filesChanged,
		});
	} catch (err) {
		logger.warn("Failed to send commit reminder", {
			narratorId,
			error: String(err),
		});
	}
}

/**
 * Force-commit all uncommitted changes with an AI-generated message.
 * Injects a system message into chat history recording the forced commit.
 */
async function forceCommitUncommitted(
	narratorId: string,
	chapterId: string,
	worktreePath: string,
	locale: Locale,
	stats: UncommittedStats,
): Promise<void> {
	// Prevent concurrent force-commits for the same narrator
	if (forceCommitInProgress.has(narratorId)) return;
	forceCommitInProgress.add(narratorId);

	try {
		logger.info("Force-committing due to threshold exceeded", {
			narratorId,
			chapterId,
			linesAdded: stats.linesAdded,
			linesRemoved: stats.linesRemoved,
			filesChanged: stats.filesChanged,
		});

		broadcastToNarrator(narratorId, {
			type: "auto_commit_started",
			narratorId,
			chapterId,
		});

		const diff = await gitService.getFullDiff(worktreePath);
		const commitMessage = await generateCommitMessage(diff, locale);
		const commitSha = await gitService.autoCommit(worktreePath, commitMessage);

		if (!commitSha) {
			logger.warn("Force-commit produced no SHA", { narratorId, chapterId });
			return;
		}

		// Clear reminder tracking
		lastReminderAt.delete(narratorId);

		// Record commit
		try {
			await commitSyncService.recordCommit({
				chapterId,
				sha: commitSha,
				message: commitMessage,
				source: "auto",
				narratorId,
			});
		} catch (err) {
			logger.warn("Failed to record force-commit in chapter_commits", {
				chapterId,
				commitSha,
				error: String(err),
			});
		}

		// Inject system message into chat history
		const text = getAutoCommitMessage("forceCommitted", locale, {
			linesAdded: stats.linesAdded,
			linesRemoved: stats.linesRemoved,
			filesChanged: stats.filesChanged,
			commitSha: commitSha.slice(0, 8),
			commitMessage,
		});

		const msg = await narratorService.persistSystemMessage(narratorId, text, [
			{
				type: "auto_commit_notice",
				commitSha,
				commitMessage,
				linesAdded: stats.linesAdded,
				linesRemoved: stats.linesRemoved,
				filesChanged: stats.filesChanged,
			},
		]);

		// Broadcast to frontend
		broadcastToNarrator(narratorId, {
			type: "force_commit_done",
			narratorId,
			chapterId,
			commitSha,
			message: commitMessage,
			linesAdded: stats.linesAdded,
			linesRemoved: stats.linesRemoved,
			filesChanged: stats.filesChanged,
		});

		broadcastToNarrator(narratorId, {
			type: "message",
			narratorId,
			message: msg,
		});

		eventBus.emit({
			type: "narrator:force_commit",
			narratorId,
			chapterId,
			commitSha,
			message: commitMessage,
		});

		// Broadcast updated git status
		const updatedStatus = await gitService.getStatusSummary(worktreePath);
		broadcastToNarrator(narratorId, {
			type: "git_status",
			narratorId,
			chapterId,
			toolUseId: "",
			status: updatedStatus,
		});

		logger.info("Force-commit completed", {
			narratorId,
			chapterId,
			commitSha,
			commitMessage,
		});
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		logger.error("Force-commit failed", { narratorId, chapterId, error: errorMsg });

		broadcastToNarrator(narratorId, {
			type: "auto_commit_failed",
			narratorId,
			chapterId,
			error: errorMsg,
		});
	} finally {
		forceCommitInProgress.delete(narratorId);
	}
}

/** Clear reminder tracking for a narrator (call on manual commit or session end). */
export function clearCommitReminderTracking(narratorId: string): void {
	lastReminderAt.delete(narratorId);
}
