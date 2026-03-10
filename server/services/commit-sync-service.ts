import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { chapterCommits, chapters, narratorMessages, projects } from "../db/schema";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { safeSpawn } from "../lib/spawn";
import { gitService } from "./git-service";

type CommitSource = "manual" | "auto" | "merge" | "cherry_pick" | "initial";

interface RawCommit {
	sha: string;
	message: string;
	fullMessage: string;
	authorName: string;
	authorEmail: string;
	authoredAt: string;
	filesChanged: number;
	linesAdded: number;
	linesRemoved: number;
}

interface RecordCommitParams {
	chapterId: string;
	sha: string;
	message: string;
	fullMessage?: string;
	source: CommitSource;
	narratorId?: string;
	narratorMessageId?: string;
	authorName?: string;
	authorEmail?: string;
	authoredAt?: string;
}

/** Resolve the working directory for a chapter (worktree or project gitPath for root). */
async function resolveChapterCwd(chapter: {
	worktreePath: string | null;
	projectId: string;
	isRoot: number | null;
}): Promise<string | null> {
	if (chapter.worktreePath) return chapter.worktreePath;
	// Root chapter or dormant — try project gitPath
	const project = await db.query.projects.findFirst({
		where: eq(projects.id, chapter.projectId),
	});
	return project?.gitPath ?? null;
}

/**
 * Parse `git log` output with a custom format into structured commit objects.
 * Format: `%H|%s|%aI|%an|%ae` per line, followed by `---BODY---` and full message.
 */
async function getCommitLog(
	cwd: string,
	opts: { since?: string; limit?: number; branch?: string },
): Promise<RawCommit[]> {
	// Use a delimiter that won't appear in commit messages
	const delim = "---NARRAFORK_DELIM---";
	const format = `${delim}%n%H%n%s%n%aI%n%an%n%ae%n%B`;
	const args = ["log", `--format=${format}`, `--max-count=${opts.limit ?? 200}`];
	if (opts.since && opts.branch) {
		args.push(`${opts.since}..${opts.branch}`);
	} else if (opts.since) {
		args.push(`${opts.since}..HEAD`);
	} else if (opts.branch) {
		args.push(opts.branch);
	}
	args.push("--");

	const result = await safeSpawn({ cmd: ["git", ...args], cwd });

	if (!result.stdout.trim()) return [];

	const blocks = result.stdout.split(delim).filter((b) => b.trim());
	const commits: RawCommit[] = [];

	for (const block of blocks) {
		const lines = block.trim().split("\n");
		if (lines.length < 5) continue;
		const [sha, message, authoredAt, authorName, authorEmail, ...bodyLines] = lines;
		commits.push({
			sha,
			message,
			fullMessage: bodyLines.join("\n").trim(),
			authorName,
			authorEmail,
			authoredAt,
			filesChanged: 0,
			linesAdded: 0,
			linesRemoved: 0,
		});
	}

	return commits;
}

/** Get diff stats for a single commit. */
async function getCommitDiffStats(
	cwd: string,
	sha: string,
): Promise<{ filesChanged: number; linesAdded: number; linesRemoved: number }> {
	const result = await safeSpawn({
		cmd: ["git", "show", "--shortstat", "--format=", sha],
		cwd,
	});

	if (result.exitCode !== 0 || !result.stdout.trim()) {
		return { filesChanged: 0, linesAdded: 0, linesRemoved: 0 };
	}

	// Parse: " 3 files changed, 10 insertions(+), 2 deletions(-)"
	const filesMatch = result.stdout.match(/(\d+) files? changed/);
	const addMatch = result.stdout.match(/(\d+) insertions?\(\+\)/);
	const delMatch = result.stdout.match(/(\d+) deletions?\(-\)/);

	return {
		filesChanged: filesMatch ? Number.parseInt(filesMatch[1], 10) : 0,
		linesAdded: addMatch ? Number.parseInt(addMatch[1], 10) : 0,
		linesRemoved: delMatch ? Number.parseInt(delMatch[1], 10) : 0,
	};
}

export const commitSyncService = {
	/**
	 * Sync chapter's git commit history into the database (incremental).
	 * Returns the number of new commits synced.
	 */
	async syncChapterCommits(chapterId: string): Promise<number> {
		const chapter = await db.query.chapters.findFirst({
			where: eq(chapters.id, chapterId),
		});
		if (!chapter) return 0;

		const cwd = await resolveChapterCwd(chapter);
		if (!cwd) return 0;

		// Find the latest commit we already have for this chapter
		const latestExisting = await db.query.chapterCommits.findFirst({
			where: eq(chapterCommits.chapterId, chapterId),
			orderBy: [desc(chapterCommits.authoredAt)],
		});

		const rawCommits = await getCommitLog(cwd, {
			since: latestExisting?.sha,
			limit: 500,
			branch: chapter.branch,
		});

		if (rawCommits.length === 0) return 0;

		// Filter out any commits we already have (edge case: since commit itself)
		const existingShas = new Set<string>();
		if (latestExisting) {
			const existing = await db.query.chapterCommits.findMany({
				where: eq(chapterCommits.chapterId, chapterId),
				columns: { sha: true },
			});
			for (const e of existing) existingShas.add(e.sha);
		}

		const newCommits = rawCommits.filter((c) => !existingShas.has(c.sha));
		if (newCommits.length === 0) return 0;

		const now = new Date().toISOString();
		// Note: diff stats (filesChanged/linesAdded/linesRemoved) are left as 0 during
		// bulk sync to avoid spawning N git processes. They are only populated for
		// individually recorded commits (auto-commit, merge). A future optimization
		// could parse `git log --shortstat` output to fill these in bulk.
		const values = newCommits.map((c) => ({
			id: generateId(),
			chapterId,
			sha: c.sha,
			message: c.message,
			fullMessage: c.fullMessage || null,
			authorName: c.authorName || null,
			authorEmail: c.authorEmail || null,
			authoredAt: c.authoredAt,
			source: "manual" as CommitSource,
			createdAt: now,
		}));

		// Batch insert (SQLite has a variable limit, chunk if needed)
		const CHUNK_SIZE = 50;
		for (let i = 0; i < values.length; i += CHUNK_SIZE) {
			const chunk = values.slice(i, i + CHUNK_SIZE);
			await db.insert(chapterCommits).values(chunk).onConflictDoNothing();
		}

		// Update chapter head and count
		const headSha = await gitService.getHeadCommit(cwd);
		const totalCount = await db.$count(chapterCommits, eq(chapterCommits.chapterId, chapterId));
		await db
			.update(chapters)
			.set({
				headCommitSha: headSha,
				commitCount: totalCount,
				updatedAt: now,
			})
			.where(eq(chapters.id, chapterId));

		logger.debug("Synced chapter commits", { chapterId, newCount: newCommits.length, totalCount });
		return newCommits.length;
	},

	/**
	 * Record a single known commit (e.g. after auto-commit or merge).
	 * More efficient than full sync when we already have the commit info.
	 */
	async recordCommit(params: RecordCommitParams): Promise<void> {
		const now = new Date().toISOString();

		// Get diff stats if we have a working directory
		let diffStats = { filesChanged: 0, linesAdded: 0, linesRemoved: 0 };
		const chapter = await db.query.chapters.findFirst({
			where: eq(chapters.id, params.chapterId),
		});
		if (chapter) {
			const cwd = await resolveChapterCwd(chapter);
			if (cwd) {
				try {
					diffStats = await getCommitDiffStats(cwd, params.sha);
				} catch {
					// Non-fatal — stats are optional
				}
			}
		}

		await db
			.insert(chapterCommits)
			.values({
				id: generateId(),
				chapterId: params.chapterId,
				sha: params.sha,
				message: params.message,
				fullMessage: params.fullMessage ?? null,
				authorName: params.authorName ?? null,
				authorEmail: params.authorEmail ?? null,
				authoredAt: params.authoredAt ?? now,
				source: params.source,
				narratorId: params.narratorId ?? null,
				narratorMessageId: params.narratorMessageId ?? null,
				filesChanged: diffStats.filesChanged,
				linesAdded: diffStats.linesAdded,
				linesRemoved: diffStats.linesRemoved,
				createdAt: now,
			})
			.onConflictDoNothing();

		// Update chapter head cache
		if (chapter) {
			const totalCount = await db.$count(
				chapterCommits,
				eq(chapterCommits.chapterId, params.chapterId),
			);
			await db
				.update(chapters)
				.set({
					headCommitSha: params.sha,
					commitCount: totalCount,
					updatedAt: now,
				})
				.where(eq(chapters.id, params.chapterId));
		}

		// Mark narrator message with commit SHA (if provided)
		if (params.narratorMessageId) {
			await db
				.update(narratorMessages)
				.set({ commitSha: params.sha })
				.where(eq(narratorMessages.id, params.narratorMessageId));
		}
	},

	/**
	 * Copy parent chapter's commit records to a forked child chapter.
	 * Only copies commits up to (and including) the fork point.
	 */
	async copyCommitsForFork(
		parentChapterId: string,
		childChapterId: string,
		forkPointSha: string,
	): Promise<void> {
		// Get all parent commits up to the fork point
		const parentCommits = await db.query.chapterCommits.findMany({
			where: eq(chapterCommits.chapterId, parentChapterId),
			orderBy: [chapterCommits.authoredAt],
		});

		if (parentCommits.length === 0) return;

		// Find the fork point index and copy everything up to it
		const forkIdx = parentCommits.findIndex((c) => c.sha === forkPointSha);
		const toCopy = forkIdx >= 0 ? parentCommits.slice(0, forkIdx + 1) : parentCommits;

		const now = new Date().toISOString();
		const values = toCopy.map((c) => ({
			id: generateId(),
			chapterId: childChapterId,
			sha: c.sha,
			message: c.message,
			fullMessage: c.fullMessage,
			authorName: c.authorName,
			authorEmail: c.authorEmail,
			authoredAt: c.authoredAt,
			source: c.source as CommitSource,
			narratorId: c.narratorId,
			narratorMessageId: c.narratorMessageId,
			filesChanged: c.filesChanged,
			linesAdded: c.linesAdded,
			linesRemoved: c.linesRemoved,
			createdAt: now,
		}));

		const CHUNK_SIZE = 50;
		for (let i = 0; i < values.length; i += CHUNK_SIZE) {
			const chunk = values.slice(i, i + CHUNK_SIZE);
			await db.insert(chapterCommits).values(chunk).onConflictDoNothing();
		}

		// Set start commit and count for child
		await db
			.update(chapters)
			.set({
				startCommitSha: forkPointSha,
				headCommitSha: forkPointSha,
				commitCount: values.length,
				updatedAt: now,
			})
			.where(eq(chapters.id, childChapterId));
	},

	/**
	 * Update chapter's headCommitSha and commitCount cache.
	 */
	async updateChapterHead(chapterId: string, sha: string): Promise<void> {
		const now = new Date().toISOString();
		const totalCount = await db.$count(chapterCommits, eq(chapterCommits.chapterId, chapterId));
		await db
			.update(chapters)
			.set({
				headCommitSha: sha,
				commitCount: totalCount,
				updatedAt: now,
			})
			.where(eq(chapters.id, chapterId));
	},

	/**
	 * Get commits for a chapter from the database (with optional sync).
	 */
	async getChapterCommits(
		chapterId: string,
		opts: { limit?: number; offset?: number; sync?: boolean },
	) {
		if (opts.sync !== false) {
			try {
				await this.syncChapterCommits(chapterId);
			} catch (err) {
				logger.warn("Commit sync failed, returning cached data", {
					chapterId,
					error: String(err),
				});
			}
		}

		return db.query.chapterCommits.findMany({
			where: eq(chapterCommits.chapterId, chapterId),
			orderBy: [desc(chapterCommits.authoredAt)],
			limit: opts.limit ?? 50,
			offset: opts.offset ?? 0,
		});
	},

	/**
	 * Get a single commit by SHA for a chapter.
	 */
	async getCommitBySha(chapterId: string, sha: string) {
		return db.query.chapterCommits.findFirst({
			where: and(eq(chapterCommits.chapterId, chapterId), eq(chapterCommits.sha, sha)),
		});
	},
};
