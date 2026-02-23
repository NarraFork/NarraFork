import { agentGenerateWithHistory } from "../lib/agent";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import type { Locale } from "../lib/prompt-i18n";
import { settings } from "../lib/settings";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { gitService } from "./git-service";

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
 * Check for uncommitted changes and auto-commit with an AI-generated message.
 * Errors are logged and broadcast, never thrown to callers.
 */
export async function autoCommitIfNeeded(
	narratorId: string,
	chapterId: string,
	worktreePath: string,
	locale: Locale,
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

		// Get full diff for AI to analyze
		const diff = await gitService.getFullDiff(worktreePath);

		let commitMessage: string;
		if (!diff.trim()) {
			// Edge case: status shows changes but diff is empty (e.g. permission-only changes)
			commitMessage = "chore: update files";
		} else {
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

			try {
				commitMessage = await Promise.race([generatePromise, timeoutPromise]);
			} finally {
				clearTimeout(timeoutHandle);
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
		}

		const commitSha = await gitService.autoCommit(worktreePath, commitMessage);
		if (!commitSha) return; // Shouldn't happen since we checked status, but be safe

		logger.info("Auto-commit completed", { narratorId, chapterId, commitSha, commitMessage });

		broadcastToNarrator(narratorId, {
			type: "auto_commit_done",
			narratorId,
			chapterId,
			commitSha,
			message: commitMessage,
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
