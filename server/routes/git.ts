import { Hono } from "hono";
import { ValidationError } from "../lib/errors";
import {
	gitCommitSchema,
	gitDiffQuerySchema,
	gitDiscardSchema,
	gitLogQuerySchema,
	gitResetSchema,
	gitStageSchema,
	gitStashSchema,
	gitUnstageSchema,
} from "../lib/validators";
import { commitSyncService } from "../services/commit-sync-service";
import { getAttributions } from "../services/file-attribution-service";
import { gitService } from "../services/git-service";
import { getStatusSummaryCached, invalidateStatus } from "../services/git-status-cache";
import { resolveWorkspaceFromChapter } from "../services/git-workspace";

export const gitRoutes = new Hono();

/** Resolve chapter → worktreePath, throwing if not available. */
async function resolveWorktree(chapterId: string) {
	const ws = await resolveWorkspaceFromChapter(chapterId);
	return { chapter: { id: chapterId }, worktreePath: ws.rawPath };
}

/**
 * Fetch a status summary through the shared cache.
 * After write operations, callers should `invalidateStatus(worktreePath)`
 * first so the next read reflects the mutation.
 */
function statusSummary(worktreePath: string) {
	return getStatusSummaryCached(worktreePath);
}

/** Validate file paths to prevent path traversal attacks. */
function validateFilePaths(files: string[]): void {
	for (const f of files) {
		if (f.includes("..") || f.startsWith("/") || f.startsWith("\\")) {
			throw new ValidationError(`Invalid file path: ${f}`);
		}
	}
}

// --- Status ---

gitRoutes.get("/:chapterId/git/status", async (c) => {
	const { worktreePath } = await resolveWorktree(c.req.param("chapterId"));
	const summary = await statusSummary(worktreePath);
	return c.json(summary);
});

// --- Attributions: who/which session changed each file ---

gitRoutes.get("/:chapterId/git/attributions", async (c) => {
	const { worktreePath } = await resolveWorktree(c.req.param("chapterId"));
	const file = c.req.query("file");
	const attributions = await getAttributions(worktreePath, file || undefined);
	return c.json(attributions);
});

// --- Stage ---

gitRoutes.post("/:chapterId/git/stage", async (c) => {
	const { worktreePath } = await resolveWorktree(c.req.param("chapterId"));
	const body = gitStageSchema.parse(await c.req.json());
	if (body.all) {
		await gitService.stageAll(worktreePath);
	} else if (body.files) {
		validateFilePaths(body.files);
		await gitService.stageFiles(worktreePath, body.files);
	}
	invalidateStatus(worktreePath);
	const summary = await statusSummary(worktreePath);
	return c.json(summary);
});

// --- Unstage ---

gitRoutes.post("/:chapterId/git/unstage", async (c) => {
	const { worktreePath } = await resolveWorktree(c.req.param("chapterId"));
	const body = gitUnstageSchema.parse(await c.req.json());
	if (body.all) {
		await gitService.unstageAll(worktreePath);
	} else if (body.files) {
		validateFilePaths(body.files);
		await gitService.unstageFiles(worktreePath, body.files);
	}
	invalidateStatus(worktreePath);
	const summary = await statusSummary(worktreePath);
	return c.json(summary);
});

// --- Commit ---

gitRoutes.post("/:chapterId/git/commit", async (c) => {
	const chapterId = c.req.param("chapterId");
	const { worktreePath } = await resolveWorktree(chapterId);
	const { message } = gitCommitSchema.parse(await c.req.json());

	const sha = await gitService.commit(worktreePath, message);

	// Record commit
	try {
		await commitSyncService.recordCommit({
			chapterId,
			sha,
			message,
			source: "manual",
		});
	} catch {
		// Non-fatal — commit already happened
	}

	invalidateStatus(worktreePath);
	const summary = await statusSummary(worktreePath);
	return c.json({ commitSha: sha, status: summary });
});

// --- Discard ---

gitRoutes.post("/:chapterId/git/discard", async (c) => {
	const { worktreePath } = await resolveWorktree(c.req.param("chapterId"));
	const body = gitDiscardSchema.parse(await c.req.json());
	if (body.all) {
		await gitService.discardAll(worktreePath);
	} else if (body.files) {
		validateFilePaths(body.files);
		await gitService.discardFiles(worktreePath, body.files);
	}
	invalidateStatus(worktreePath);
	const summary = await statusSummary(worktreePath);
	return c.json(summary);
});

// --- Diff ---

gitRoutes.get("/:chapterId/git/diff", async (c) => {
	const { worktreePath } = await resolveWorktree(c.req.param("chapterId"));
	const { file, staged } = gitDiffQuerySchema.parse(c.req.query());
	validateFilePaths([file]);
	const result = await gitService.getFileDiff(worktreePath, file, staged);
	return c.json(result);
});

// --- Stash ---

gitRoutes.get("/:chapterId/git/stash/list", async (c) => {
	const { worktreePath } = await resolveWorktree(c.req.param("chapterId"));
	const list = await gitService.stashList(worktreePath);
	return c.json(list);
});

gitRoutes.post("/:chapterId/git/stash", async (c) => {
	const { worktreePath } = await resolveWorktree(c.req.param("chapterId"));
	const body = gitStashSchema.parse(await c.req.json());

	switch (body.action) {
		case "push":
			await gitService.stash(worktreePath, body.message);
			break;
		case "pop": {
			const result = await gitService.stashPop(worktreePath);
			if (result.hasConflicts) {
				invalidateStatus(worktreePath);
				const summary = await statusSummary(worktreePath);
				return c.json({ hasConflicts: true, status: summary });
			}
			break;
		}
		case "drop":
			await gitService.stashDrop(worktreePath, body.index ?? 0);
			break;
	}

	invalidateStatus(worktreePath);
	const summary = await statusSummary(worktreePath);
	return c.json({ hasConflicts: false, status: summary });
});

// --- Log ---

gitRoutes.get("/:chapterId/git/log", async (c) => {
	const { worktreePath } = await resolveWorktree(c.req.param("chapterId"));
	const { limit, skip } = gitLogQuerySchema.parse(c.req.query());
	const log = await gitService.getLog(worktreePath, { limit, skip });
	return c.json(log);
});

// --- Reset ---

gitRoutes.post("/:chapterId/git/reset", async (c) => {
	const chapterId = c.req.param("chapterId");
	const { worktreePath } = await resolveWorktree(chapterId);
	const { target, mode } = gitResetSchema.parse(await c.req.json());

	if (mode === "hard") {
		await gitService.resetHard(worktreePath, target);
	} else {
		await gitService.resetSoft(worktreePath, target);
	}

	// Sync commits after reset (history may have changed)
	try {
		await commitSyncService.syncChapterCommits(chapterId);
	} catch {
		// Non-fatal
	}

	invalidateStatus(worktreePath);
	const summary = await statusSummary(worktreePath);
	return c.json(summary);
});

// --- AI commit message ---

gitRoutes.post("/:chapterId/git/ai-commit-message", async (c) => {
	const { worktreePath } = await resolveWorktree(c.req.param("chapterId"));
	const diff = await gitService.getFullDiff(worktreePath);
	if (!diff.trim()) {
		return c.json({ message: "" });
	}

	// Lazy import to avoid circular dependency
	const { summaryGenerateWithHistory } = await import("../lib/agent");

	const systemPrompt = `You are a git commit message generator. Given a git diff, generate a concise commit message following the Conventional Commits format.
Rules:
- Use format: <type>(<optional scope>): <description>
- Types: feat, fix, refactor, style, docs, test, chore, perf, ci, build
- Description should be lowercase, imperative mood, no period at end
- If the diff covers multiple changes, summarize the primary change
- Keep the message under 72 characters
- Reply with ONLY the commit message, nothing else`;

	const AI_TIMEOUT_MS = 30_000;
	const generatePromise = summaryGenerateWithHistory(
		systemPrompt,
		`<diff>\n${diff}\n</diff>`,
		"en",
		{ kind: "git_summary" },
	);

	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutHandle = setTimeout(
			() => reject(new Error("AI commit message generation timed out")),
			AI_TIMEOUT_MS,
		);
	});

	let message: string;
	try {
		message = await Promise.race([generatePromise, timeoutPromise]);
	} finally {
		clearTimeout(timeoutHandle);
	}

	message = message
		.trim()
		.replace(/^["'`\u201c\u201d]+|["'`\u201c\u201d]+$/g, "")
		.split("\n")[0]
		.trim();

	if (!message || message.length > 200) {
		message = "chore: update files";
	}

	return c.json({ message });
});
