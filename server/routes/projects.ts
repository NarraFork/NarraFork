import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { db } from "../db";
import {
	chapters,
	containerInstances,
	explorationGroups,
	mergeSessions,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	portAllocations,
	projects,
	remoteDevices,
	terminals,
	terminalTabs,
	terminalViewState,
} from "../db/schema";
import { GitAuthError, NotFoundError, ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { getHome } from "../lib/platform";
import { projectDbManager } from "../lib/project-db";
import { createProjectSchema, updateProjectSchema } from "../lib/validators";
import { chapterService } from "../services/chapter-service";
import { refreshCache as refreshContainerProxyCache } from "../services/container-proxy";
import { gitService } from "../services/git-service";
import { integrationResourceBindingService } from "../services/integration-resource-binding-service";
import { propagateOAuthProjectRemoval } from "../services/oauth-runtime-revocation";
import { ensureGitignoreEntry } from "../services/project-db-sync";
import { removeTabFromAllUsers } from "../services/user-preferences-service";

export const projectRoutes = new Hono();

const validStatuses = ["active", "archived"] as const;

projectRoutes.get("/", async (c) => {
	const status = c.req.query("status");
	const where =
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		status && validStatuses.includes(status as any)
			? eq(projects.status, status as (typeof validStatuses)[number])
			: undefined;
	const result = await db.query.projects.findMany({
		where,
		orderBy: (projects, { desc }) => [desc(projects.updatedAt)],
	});
	return c.json(result);
});

projectRoutes.post("/", async (c) => {
	const parsed = createProjectSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const body = parsed.data;

	const now = new Date().toISOString();
	const projectId = generateId();

	let gitPath = body.gitPath.trim();
	// Expand ~ and resolve to absolute path so worktreePath / terminal cwd are correct
	if (gitPath.startsWith("~/") || gitPath === "~") {
		gitPath = gitPath.replace("~", getHome());
	}
	gitPath = resolve(gitPath);

	let remoteUrl: string | null = null;
	let defaultBranch = "main";
	const mode = body.repoMode;

	// For clone mode, use SSE to stream progress
	if (mode === "clone") {
		if (!body.cloneUrl) {
			throw new ValidationError('cloneUrl is required when repoMode is "clone"');
		}
		const cloneUrl = body.cloneUrl;
		const cloneBranch = body.cloneBranch;
		const credentials =
			body.cloneUsername && body.clonePassword
				? { username: body.cloneUsername, password: body.clonePassword }
				: undefined;

		return streamSSE(c, async (stream) => {
			let sseId = 0;
			try {
				await gitService.cloneRepoStreaming(
					cloneUrl,
					gitPath,
					cloneBranch,
					(line) => {
						stream
							.writeSSE({
								id: String(sseId++),
								event: "progress",
								data: JSON.stringify({ message: line }),
							})
							.catch(() => {});
					},
					credentials,
				);

				const detectedBranch = await gitService.getCurrentBranch(gitPath);
				remoteUrl = cloneUrl;
				defaultBranch = detectedBranch ?? "main";

				const [project] = await db
					.insert(projects)
					.values({
						id: projectId,
						name: body.name,
						description: body.description,
						flowMode: body.flowMode,
						gitPath,
						remoteUrl,
						defaultBranch,
						createdAt: now,
						updatedAt: now,
					})
					.returning();

				if (project.proxyDomain) {
					refreshContainerProxyCache().catch((err) => {
						logger.warn("Failed to refresh container proxy cache after project create", {
							projectId,
							error: String(err),
						});
					});
				}

				try {
					await chapterService.createRootChapter({
						projectId,
						title: body.name,
						gitPath,
						defaultBranch,
					});
				} catch (err) {
					console.warn("Failed to create root chapter:", err);
				}

				try {
					projectDbManager.openForGitPath(projectId, gitPath);
					ensureGitignoreEntry(gitPath);
					await gitService.commitGitignoreIfDirty(gitPath);
				} catch (err) {
					logger.warn("Failed to initialize project backup DB", {
						projectId,
						error: String(err),
					});
				}

				await stream.writeSSE({
					id: String(sseId++),
					event: "complete",
					data: JSON.stringify(project),
				});
			} catch (err) {
				if (err instanceof GitAuthError) {
					// Clean up partially-created clone directory
					try {
						if (existsSync(gitPath)) rmSync(gitPath, { recursive: true, force: true });
					} catch {}
					await stream
						.writeSSE({
							id: String(sseId++),
							event: "credential_required",
							data: JSON.stringify({ error: err.message }),
						})
						.catch(() => {});
				} else {
					const message = err instanceof Error ? err.message : String(err);
					await stream
						.writeSSE({
							id: String(sseId++),
							event: "error",
							data: JSON.stringify({ error: message }),
						})
						.catch(() => {});
				}
			}
		});
	}

	if (mode === "existing") {
		if (!(await gitService.isGitRepo(gitPath))) {
			throw new ValidationError(`Path is not a git repository: ${gitPath}`);
		}
		const detectedBranch = await gitService.getCurrentBranch(gitPath);
		defaultBranch = detectedBranch ?? "main";
	} else if (mode === "init") {
		await gitService.initRepo(gitPath);
		const detectedBranch = await gitService.getCurrentBranch(gitPath);
		defaultBranch = detectedBranch ?? "main";

		// Commit .gitignore as part of initial repo setup so fork branches inherit it
		ensureGitignoreEntry(gitPath);
		await gitService.stageAndCommit(gitPath, [".gitignore"], "Add .gitignore");
	}

	const [project] = await db
		.insert(projects)
		.values({
			id: projectId,
			name: body.name,
			description: body.description,
			flowMode: body.flowMode,
			gitPath,
			remoteUrl,
			defaultBranch,
			createdAt: now,
			updatedAt: now,
		})
		.returning();

	if (project.proxyDomain) {
		refreshContainerProxyCache().catch((err) => {
			logger.warn("Failed to refresh container proxy cache after project create", {
				projectId,
				error: String(err),
			});
		});
	}

	// Auto-create root chapter
	try {
		await chapterService.createRootChapter({
			projectId,
			title: body.name,
			gitPath,
			defaultBranch,
		});
	} catch (err) {
		// Non-fatal — project is still usable without root chapter
		console.warn("Failed to create root chapter:", err);
	}

	// Initialize project backup DB + .gitignore
	try {
		projectDbManager.openForGitPath(projectId, gitPath);
		ensureGitignoreEntry(gitPath);
		await gitService.commitGitignoreIfDirty(gitPath);
	} catch (err) {
		logger.warn("Failed to initialize project backup DB", {
			projectId,
			error: String(err),
		});
	}

	return c.json(project, 201);
});

projectRoutes.get("/:id", async (c) => {
	const id = c.req.param("id");
	const project = await db.query.projects.findFirst({
		where: eq(projects.id, id),
	});
	if (!project) throw new NotFoundError("Project", id);
	return c.json(project);
});

projectRoutes.patch("/:id", async (c) => {
	const id = c.req.param("id");
	const parsed = updateProjectSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const { chapterSettings: incomingSettings, ...rest } = parsed.data;

	const now = new Date().toISOString();

	const existingProject = await db.query.projects.findFirst({
		where: eq(projects.id, id),
		columns: { proxyDomain: true, chapterSettings: true },
	});
	if (!existingProject) throw new NotFoundError("Project", id);

	// Merge chapterSettings with existing values instead of overwriting
	let mergedSettings: Record<string, unknown> | undefined;
	if (incomingSettings) {
		let current: Record<string, unknown> = {};
		try {
			current =
				typeof existingProject.chapterSettings === "string"
					? JSON.parse(existingProject.chapterSettings)
					: (existingProject.chapterSettings ?? {});
		} catch {
			// corrupted JSON — start fresh
		}
		mergedSettings = { ...current, ...incomingSettings };
	}

	const [updated] = await db
		.update(projects)
		.set({
			...rest,
			...(mergedSettings !== undefined ? { chapterSettings: mergedSettings } : {}),
			updatedAt: now,
		})
		.where(eq(projects.id, id))
		.returning();
	if (!updated) throw new NotFoundError("Project", id);

	if (existingProject.proxyDomain !== (updated.proxyDomain ?? null)) {
		refreshContainerProxyCache().catch((err) => {
			logger.warn("Failed to refresh container proxy cache after project update", {
				projectId: id,
				error: String(err),
			});
		});
	}

	return c.json(updated);
});

projectRoutes.delete("/:id", async (c) => {
	const id = c.req.param("id");
	const project = await db.query.projects.findFirst({
		where: eq(projects.id, id),
	});
	if (!project) throw new NotFoundError("Project", id);

	await propagateOAuthProjectRemoval(id);

	const projectChapters = await db.query.chapters.findMany({
		where: eq(chapters.projectId, id),
	});

	// Remove non-root chapters first, then root chapters — full resource cleanup for all
	const nonRoot = projectChapters.filter((ch) => !ch.isRoot);
	const root = projectChapters.filter((ch) => ch.isRoot);

	for (const chapter of nonRoot) {
		try {
			await chapterService.removeForProjectDeletion(chapter.id, project.gitPath);
		} catch (err) {
			logger.warn("Failed to remove chapter during project delete", {
				chapterId: chapter.id,
				error: String(err),
			});
		}
	}
	for (const chapter of root) {
		try {
			await chapterService.removeForProjectDeletion(chapter.id, project.gitPath);
		} catch (err) {
			logger.warn("Failed to remove root chapter during project delete", {
				chapterId: chapter.id,
				error: String(err),
			});
		}
	}

	// Clean up exploration groups (should cascade, but be explicit)
	await db.delete(explorationGroups).where(eq(explorationGroups.projectId, id));

	// Prune any leftover worktrees in the git repo
	if (project.gitPath) {
		try {
			await gitService.pruneWorktrees(project.gitPath);
		} catch (err) {
			logger.warn("Failed to prune worktrees during project delete", {
				error: String(err),
			});
		}
	}

	// Fallback cleanup: ensure all FK-dependent rows are gone even if
	// removeForProjectDeletion partially failed for some chapters.
	const remainingChapterIds = (
		await db.query.chapters.findMany({
			where: eq(chapters.projectId, id),
			columns: { id: true },
		})
	).map((ch) => ch.id);

	if (remainingChapterIds.length > 0) {
		const remainingNarratorIds = (
			await db.query.narrators.findMany({
				where: inArray(narrators.chapterId, remainingChapterIds),
				columns: { id: true },
			})
		).map((n) => n.id);

		// Also collect standalone child narrators (subagents) whose parent belongs to this project
		let allNarratorIds = [...remainingNarratorIds];
		if (allNarratorIds.length > 0) {
			const childNarrators = (
				await db.query.narrators.findMany({
					where: inArray(narrators.parentNarratorId, allNarratorIds),
					columns: { id: true },
				})
			).map((n) => n.id);
			allNarratorIds = [...new Set([...allNarratorIds, ...childNarrators])];
		}
		for (const narratorId of allNarratorIds) {
			await integrationResourceBindingService.markDeleted("narrator", narratorId);
		}

		db.transaction((tx) => {
			if (allNarratorIds.length > 0) {
				// Break narrator self-references
				tx.update(narrators)
					.set({ parentNarratorId: null, forkMessageId: null, pruneBoundaryMessageId: null })
					.where(inArray(narrators.id, allNarratorIds))
					.run();

				// Delete tables referencing narrators / messages
				tx.delete(terminalViewState)
					.where(inArray(terminalViewState.narratorId, allNarratorIds))
					.run();
				tx.delete(terminalTabs).where(inArray(terminalTabs.narratorId, allNarratorIds)).run();
				tx.delete(terminals).where(inArray(terminals.narratorId, allNarratorIds)).run();
				tx.delete(narratorToolCalls)
					.where(inArray(narratorToolCalls.narratorId, allNarratorIds))
					.run();
				tx.delete(narratorMessageRefs)
					.where(inArray(narratorMessageRefs.narratorId, allNarratorIds))
					.run();
				tx.delete(narratorMessages)
					.where(inArray(narratorMessages.narratorId, allNarratorIds))
					.run();
				tx.delete(narrators).where(inArray(narrators.id, allNarratorIds)).run();
			}

			// Delete tables referencing chapters
			tx.delete(terminalViewState)
				.where(inArray(terminalViewState.chapterId, remainingChapterIds))
				.run();
			tx.delete(terminalTabs).where(inArray(terminalTabs.chapterId, remainingChapterIds)).run();
			tx.delete(terminals).where(inArray(terminals.chapterId, remainingChapterIds)).run();
			tx.delete(containerInstances)
				.where(inArray(containerInstances.chapterId, remainingChapterIds))
				.run();
			tx.delete(portAllocations)
				.where(inArray(portAllocations.chapterId, remainingChapterIds))
				.run();
			tx.delete(mergeSessions)
				.where(inArray(mergeSessions.targetChapterId, remainingChapterIds))
				.run();

			// Break chapter self-references before deleting
			tx.update(chapters)
				.set({ parentChapterId: null, mergedIntoChapterId: null })
				.where(inArray(chapters.id, remainingChapterIds))
				.run();
			tx.delete(chapters).where(inArray(chapters.id, remainingChapterIds)).run();
		});
	}

	const deviceRevokedAt = new Date().toISOString();
	await db
		.update(narrators)
		.set({ contextProjectId: null, updatedAt: deviceRevokedAt })
		.where(eq(narrators.contextProjectId, id));
	await db
		.update(remoteDevices)
		.set({
			projectId: null,
			status: "offline",
			revokedAt: deviceRevokedAt,
			updatedAt: deviceRevokedAt,
		})
		.where(eq(remoteDevices.projectId, id));
	await db.delete(projects).where(eq(projects.id, id));
	removeTabFromAllUsers("project", id).catch((err) => {
		logger.warn("Failed to remove project tab from users", {
			projectId: id,
			error: String(err),
		});
	});
	if (project.proxyDomain) {
		refreshContainerProxyCache().catch((err) => {
			logger.warn("Failed to refresh container proxy cache after project delete", {
				projectId: id,
				error: String(err),
			});
		});
	}
	logger.info("Project deleted", { projectId: id, name: project.name });
	return c.json({ ok: true });
});
