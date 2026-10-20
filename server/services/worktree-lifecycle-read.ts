import type { Database } from "bun:sqlite";
import { inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { chapters, narrators } from "../db/schema";

export interface WorktreeLifecycleReadParams {
	kind: "worktree-lifecycle-read-v1";
	chapterIds: string[];
	limit: number;
}

/** Chapter paths and their legacy owners are provenance from the same read snapshot. */
export function runWorktreeLifecycleRead(
	sqlite: Database,
	params: WorktreeLifecycleReadParams,
	signal: AbortSignal,
) {
	const db = drizzle(sqlite);
	return sqlite.transaction(() => {
		signal.throwIfAborted();
		const rows = db
			.select({
				id: chapters.id,
				path: chapters.worktreePath,
				shadowKey: chapters.snapshotShadowKey,
			})
			.from(chapters)
			.where(inArray(chapters.id, params.chapterIds))
			.limit(params.limit)
			.all();
		signal.throwIfAborted();
		const owners = db
			.select({
				id: narrators.id,
				cwd: narrators.cwd,
				contextCwd: sql<string | null>`json_extract(${narrators.workspaceContext}, '$.cwd')`,
				revision: narrators.workspaceRevision,
			})
			.from(narrators)
			.where(inArray(narrators.chapterId, params.chapterIds))
			.limit(params.limit)
			.all();
		return { rows, owners };
	})();
}
