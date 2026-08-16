import { Hono } from "hono";
import { ValidationError } from "../lib/errors";
import { requireChapterAccess } from "../lib/project-access";
import {
	gitCommitSchema,
	gitDiffQuerySchema,
	gitDiscardSchema,
	gitLogQuerySchema,
	gitModificationsQuerySchema,
	gitResetSchema,
	gitStageSchema,
	gitStashSchema,
	gitUnstageSchema,
} from "../lib/validators";
import { commitSyncService } from "../services/commit-sync-service";
import { getCommitBoundariesCached } from "../services/git-commit-boundary-cache";
import { gitService } from "../services/git-service";
import { getStatusSummaryCached, invalidateStatus } from "../services/git-status-cache";
import { resolveWorkspaceFromChapter } from "../services/git-workspace";
import { getWorkspaceModificationView } from "../services/workspace-modification-view";

export const gitRoutes = new Hono();

/**
 * Access gate for every git endpoint.
 *
 * All twelve are `/:chapterId/git/...`, and a chapter inherits its project's verdict
 * (the worktrees share one repository, so chapter-level isolation is not real). One
 * middleware therefore covers the whole surface, including endpoints added later.
 *
 * GET is read; the mutating ones stage, commit, discard, stash and reset — they
 * rewrite the shared repository, so they need project write.
 */
gitRoutes.use("/:chapterId/git/*", async (c, next) => {
	const chapterId = c.req.param("chapterId");
	if (!chapterId) return next();
	await requireChapterAccess(c, chapterId, c.req.method === "GET" ? "read" : "write");
	return next();
});

/**
 * Resolve chapter → worktreePath, throwing if not available.
 *
 * Returns `rawPath`, not `workspacePath`, and deliberately does not expose both.
 * Everything downstream — `gitService` write methods, `getStatusSummaryCached`,
 * `invalidateStatus` — takes a raw path and derives its own normalized key
 * internally, so a second field here would be unused at best and, at worst,
 * would tempt a future caller into passing a case-folded path to git as a cwd.
 * That breaks on case-sensitive filesystems, where `/srv/WT` and `/srv/wt` are
 * different directories.
 */
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

/**
 * Reject paths that could act outside the worktree.
 *
 * Traversal is judged per SEGMENT, not by substring. `f.includes("..")` also rejected
 * `some..file.ts` and `v1..v2/notes.md` — ordinary filenames that contain two dots without
 * naming a parent directory — so staging or discarding them was impossible. Only a segment
 * that IS `..` climbs, which is what this checks.
 *
 * A leading `/` or `\` is refused separately: those are absolute (or, doubled, a UNC path)
 * and would escape without any `..` at all. Both separators are treated as such regardless
 * of platform, because git accepts `/` everywhere and a Windows client may send `\`.
 *
 * NUL is refused because it terminates a C string: a path that git or the filesystem reads
 * as a prefix of what was validated is a different path than the one that was checked.
 *
 * Exported for tests: it guards every mutating git route, so the boundary deserves direct
 * cases rather than being exercised only through a route's happy path.
 */
export function validateFilePaths(files: string[]): void {
	for (const f of files) {
		const segments = f.split(/[\\/]/);
		if (
			segments.some((segment) => segment === "..") ||
			f.startsWith("/") ||
			f.startsWith("\\") ||
			f.includes("\0")
		) {
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

/**
 * Unified modification view for the whole worktree.
 *
 * Unlike the per-narrator file views, this covers every actor that wrote to the
 * directory — all narrators, their subagents, and external edits — because that is
 * what has to be understood before reverting anything. Returns metadata only, never
 * file contents.
 */
gitRoutes.get("/:chapterId/git/modifications", async (c) => {
	const { worktreePath } = await resolveWorktree(c.req.param("chapterId"));
	// Parsed rather than forwarded raw: `since`/`until` are compared as STRINGS against
	// `file_attributions.changed_at`, so an unparseable value is not rejected by SQLite —
	// it just compares as text and silently returns an empty window. Same for `narratorId`,
	// where a malformed id matches no row. Both used to look like "this file has no
	// attribution", which is the failure mode this endpoint exists to remove.
	const query = gitModificationsQuerySchema.parse(c.req.query());

	// `scope=uncommitted` answers the question the Git panel actually asks: who caused the
	// changes that are sitting in the working tree right now. Without it the view spans the
	// workspace's entire recorded history, which for a long-lived worktree credits a file's
	// current diff to every session that ever touched it (measured here: a median of 7
	// contributors per file, up to 157, where the real answer was 1).
	const scope = query.scope === "uncommitted" ? await resolveUncommittedScope(worktreePath) : null;

	const view = await getWorkspaceModificationView(worktreePath, {
		...(query.limit !== undefined ? { limit: query.limit } : {}),
		...(query.since ? { since: query.since } : {}),
		...(query.until ? { until: query.until } : {}),
		...(query.narratorId ? { narratorId: query.narratorId } : {}),
		// `projection` is opt-in so an existing client keeps receiving the timeline.
		...(query.projection ? { projection: query.projection } : {}),
		...(scope ?? {}),
	});
	return c.json(view);
});

/**
 * Scope options describing "the current uncommitted change".
 *
 * Three pieces: the paths git reports as changed, where each one's current change begins,
 * and how a renamed file's two names relate.
 *
 * The boundary must be per path — a single repository-wide HEAD timestamp is not it,
 * because a file's last commit is usually older than HEAD (in this repository, 90 of 127
 * changed files, by a median of 164 hours), and using HEAD dropped real contributors.
 *
 * Paths with no boundary are left unbounded, which is correct for a file that has never
 * been committed. Paths the walk did not reach fall back to its oldest commit: being newer
 * than the true boundary, that can only under-count, and over-crediting a file with
 * unrelated history is the failure that matters here.
 *
 * Renames are queried under BOTH names. Attribution rows carry the path that was written
 * at the time, so everything a session did before the rename lives under the old path —
 * which is not in the current diff. Asking for the new path only meant a renamed file's
 * whole history was missing from the window and the row fell through to the
 * `oldestInWindow` fallback: the "Unknown" badge, one shape removed. The alias map tells
 * the view to fold those rows into the current path's group.
 *
 * Exported for tests only. Its behaviour depends on real porcelain output (rename
 * detection, untracked reporting) and on the boundary walk, so the only honest test runs
 * it against a throwaway repository rather than a hand-built status object.
 */
export async function resolveUncommittedScope(worktreePath: string): Promise<{
	filePaths: string[];
	sinceByPath: Map<string, string>;
	pathAliases: Map<string, string>;
}> {
	const status = await getStatusSummaryCached(worktreePath);
	// Old paths participate in the query; only the current path is ever displayed.
	const pathAliases = new Map<string, string>();
	for (const file of status.files) {
		if (file.oldPath && file.oldPath !== file.path) pathAliases.set(file.oldPath, file.path);
	}
	const filePaths = [...status.files.map((file) => file.path), ...pathAliases.keys()];
	if (filePaths.length === 0) {
		return { filePaths, sinceByPath: new Map(), pathAliases };
	}

	const { byPath, oldestInWindow } = await getCommitBoundariesCached(
		worktreePath,
		status.headSha,
		filePaths,
	);

	// Boundaries are keyed by DISPLAY path, matching how the view looks them up: a rename's
	// pre-rename rows are folded onto the current path and must be judged against the
	// window git resolved for the file as a whole. Taking the older of the two names' own
	// boundaries keeps that window from cutting off history the rename carried over.
	const sinceByPath = new Map<string, string>();
	for (const [path, boundary] of byPath) {
		const displayPath = pathAliases.get(path) ?? path;
		const existing = sinceByPath.get(displayPath);
		if (existing === undefined || boundary < existing) sinceByPath.set(displayPath, boundary);
	}

	if (oldestInWindow) {
		const untracked = new Set(
			status.files.filter((file) => file.status.startsWith("?")).map((file) => file.path),
		);
		for (const file of status.files) {
			// An untracked file has no commit to bound it, so it must stay unbounded rather
			// than inherit the window fallback.
			if (!sinceByPath.has(file.path) && !untracked.has(file.path)) {
				sinceByPath.set(file.path, oldestInWindow);
			}
		}
	}

	return { filePaths, sinceByPath, pathAliases };
}

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
