/**
 * Git workspace resolution layer.
 *
 * Decouples the git subsystem from the chapter/narrative model. A *workspace*
 * is simply a filesystem path that may or may not be a git working tree. The
 * canonical key for a workspace is its normalized absolute path (forward
 * slashes, platform-aware case folding) — NOT a chapterId.
 *
 * Callers (routes, services) resolve their domain object (chapter, narrator,
 * raw path) into a `ResolvedWorkspace` here, then hand the plain path to
 * `gitService` / `gitStatusCache` / `fileAttributionService`. Chapter is just
 * one possible *source* of a path.
 */
import { eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, narrators, projects } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { normalizePathForComparison } from "../lib/platform-path";

/** A resolved git workspace, keyed by its normalized absolute path. */
export interface ResolvedWorkspace {
	/** Normalized absolute path — the canonical workspace key. */
	workspacePath: string;
	/** The raw (un-normalized) filesystem path to pass to git commands. */
	rawPath: string;
	/** Originating chapter, if the workspace was resolved from one. */
	chapterId?: string;
	/** Originating project, if known. */
	projectId?: string;
	/** Base branch for ahead/behind computation, if known. */
	baseBranch?: string;
}

/**
 * Normalize a filesystem path into the canonical workspace key.
 * Use this everywhere a path is used as a Map key or DB column for a workspace.
 */
export function normalizeWorkspacePath(path: string): string {
	return normalizePathForComparison(path);
}

/**
 * Resolve a chapter into its active git workspace.
 * Throws if the chapter is missing or has no active worktree.
 */
export async function resolveWorkspaceFromChapter(chapterId: string): Promise<ResolvedWorkspace> {
	const ch = await db.query.chapters.findFirst({
		where: eq(chapters.id, chapterId),
	});
	if (!ch) throw new NotFoundError("Chapter", chapterId);
	if (!ch.worktreePath) throw new ValidationError("Chapter has no active worktree");
	return {
		workspacePath: normalizeWorkspacePath(ch.worktreePath),
		rawPath: ch.worktreePath,
		chapterId: ch.id,
		projectId: ch.projectId,
		baseBranch: ch.baseBranch,
	};
}

/**
 * Resolve a narrator into its git workspace.
 *
 * Resolution order:
 * 1. If bound to a chapter with an active worktree → that worktree.
 * 2. Otherwise fall back to the narrator's own `cwd` (standalone narrators).
 *
 * Returns `null` when no usable path can be determined.
 */
export async function resolveWorkspaceFromNarrator(
	narratorId: string,
): Promise<ResolvedWorkspace | null> {
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
	});
	if (!narrator) throw new NotFoundError("Narrator", narratorId);

	if (narrator.chapterId) {
		const ch = await db.query.chapters.findFirst({
			where: eq(chapters.id, narrator.chapterId),
		});
		if (ch?.worktreePath) {
			return {
				workspacePath: normalizeWorkspacePath(ch.worktreePath),
				rawPath: ch.worktreePath,
				chapterId: ch.id,
				projectId: ch.projectId,
				baseBranch: ch.baseBranch,
			};
		}
		// Chapter dormant: fall back to project gitPath, then narrator cwd.
		if (ch) {
			const project = await db.query.projects.findFirst({
				where: eq(projects.id, ch.projectId),
			});
			const fallback = narrator.cwd || project?.gitPath;
			if (fallback) {
				return {
					workspacePath: normalizeWorkspacePath(fallback),
					rawPath: fallback,
					chapterId: ch.id,
					projectId: ch.projectId,
					baseBranch: ch.baseBranch,
				};
			}
		}
	}

	if (narrator.cwd) {
		return {
			workspacePath: normalizeWorkspacePath(narrator.cwd),
			rawPath: narrator.cwd,
		};
	}

	return null;
}

/**
 * Resolve a raw filesystem path into a workspace descriptor.
 * Does not verify the path is a git repo — callers should use
 * `gitService.isGitRepo()` when that matters.
 */
export function resolveWorkspaceFromPath(rawPath: string): ResolvedWorkspace {
	return {
		workspacePath: normalizeWorkspacePath(rawPath),
		rawPath,
	};
}
