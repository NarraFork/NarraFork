import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
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
	terminalViewState,
} from "../db/schema";
import { GitAuthError, NotFoundError, ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { getHome } from "../lib/platform";
import { projectPrincipalOf, requireProjectAccess } from "../lib/project-access";
import { projectDbManager } from "../lib/project-db";
import {
	createProjectSchema,
	projectMembersSchema,
	projectTransferOwnerSchema,
	projectVisibilitySchema,
	updateProjectSchema,
} from "../lib/validators";
import { chapterService } from "../services/chapter-service";
import { refreshCache as refreshContainerProxyCache } from "../services/container-proxy";
import { containerService } from "../services/container-service";
import { gitService } from "../services/git-service";
import { integrationResourceBindingService } from "../services/integration-resource-binding-service";
import { propagateOAuthProjectRemoval } from "../services/oauth-runtime-revocation";
import { projectReadableWhere } from "../services/project-acl";
import { ensureGitignoreEntry } from "../services/project-db-sync";
import {
	getProjectAccess,
	removeProjectMember,
	setProjectMembers,
	setProjectVisibility,
	transferProjectOwner,
} from "../services/project-membership";
import { terminalService } from "../services/terminal-service";
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
	// The visibility predicate is pushed into SQL rather than applied afterwards, so
	// this stays one indexed query no matter how many projects exist. Returns
	// undefined for admins, which `and(...)` treats as no extra restriction.
	const result = await db.query.projects.findMany({
		where: and(where, projectReadableWhere(projectPrincipalOf(c))),
		orderBy: (projects, { desc }) => [desc(projects.updatedAt)],
	});
	return c.json(result);
});

/**
 * Whether any project exists that the caller cannot see.
 *
 * An empty project list became ambiguous once it was ACL-filtered: "nothing exists
 * yet" and "projects exist but none are yours" look identical to the client, yet they
 * call for opposite advice — "create one" versus "ask to be added". A new member
 * otherwise gets told to create a project when they simply have not been invited.
 *
 * Deliberately a separate, bare-boolean endpoint rather than a field on the list
 * response or a header: the list returns an array, and the shared fetch helper
 * discards headers, so both alternatives would distort a widely used shape. Discloses
 * only existence — never a name, id or count — and is a bounded probe (`limit 1`, one
 * column), fetched by the client only when the visible list is empty.
 */
projectRoutes.get("/hidden-existence", async (c) => {
	const principal = projectPrincipalOf(c);
	// Admins see everything, so nothing can be hidden from them.
	if (principal.isAdmin) return c.json({ hasHidden: false });
	const visible = await db.query.projects.findFirst({
		where: projectReadableWhere(principal),
		columns: { id: true },
	});
	// Only meaningful when the caller sees nothing; a non-empty list needs no hint.
	if (visible) return c.json({ hasHidden: false });
	const any = await db.query.projects.findFirst({ columns: { id: true } });
	return c.json({ hasHidden: !!any });
});

projectRoutes.post("/", async (c) => {
	const parsed = createProjectSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const body = parsed.data;

	const now = new Date().toISOString();
	const projectId = generateId();
	// Owner of any narrator auto-created alongside the root chapter below.
	const createdByUserId = c.get("user").sub;

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
						// Ownership always comes from the session, never the body: a client must
						// not be able to create a project on someone else's behalf. The creator
						// becomes its first manager, so they can invite others without an admin.
						ownerUserId: createdByUserId,
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
						createdByUserId,
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
			// See the sibling insert above: the session user owns what they create.
			ownerUserId: createdByUserId,
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
			createdByUserId,
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

// ─── Access control (membership) ─────────────────────────────────────────────
//
// Registered before the `/:id` routes so these literal paths are not captured as
// project ids. Reading the panel needs project read; every mutation additionally
// requires owner/manage/admin, enforced in the service layer — a write member works
// in the project but does not decide who else may.

projectRoutes.get("/:id/access", async (c) => {
	const id = c.req.param("id");
	await requireProjectAccess(c, id, "read");
	return c.json(await getProjectAccess(id, projectPrincipalOf(c)));
});

projectRoutes.patch("/:id/visibility", async (c) => {
	const id = c.req.param("id");
	await requireProjectAccess(c, id, "read");
	const parsed = projectVisibilitySchema.safeParse(await c.req.json().catch(() => ({})));
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(await setProjectVisibility(id, parsed.data.visibility, projectPrincipalOf(c)));
});

projectRoutes.post("/:id/members", async (c) => {
	const id = c.req.param("id");
	await requireProjectAccess(c, id, "read");
	const parsed = projectMembersSchema.safeParse(await c.req.json().catch(() => ({})));
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const principal = projectPrincipalOf(c);
	const outcome = await setProjectMembers(id, parsed.data.userIds, parsed.data.role, principal);
	// The resulting state travels with the per-user outcome so the panel needs no second
	// round trip, and so a partially successful batch is visible rather than implied.
	return c.json({ ...outcome, access: await getProjectAccess(id, principal) });
});

projectRoutes.delete("/:id/members/:userId", async (c) => {
	const id = c.req.param("id");
	await requireProjectAccess(c, id, "read");
	await removeProjectMember(id, c.req.param("userId"), projectPrincipalOf(c));
	return c.json({ ok: true });
});

projectRoutes.post("/:id/transfer-owner", async (c) => {
	const id = c.req.param("id");
	await requireProjectAccess(c, id, "read");
	const parsed = projectTransferOwnerSchema.safeParse(await c.req.json().catch(() => ({})));
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(await transferProjectOwner(id, parsed.data.userId, projectPrincipalOf(c)));
});

projectRoutes.get("/:id", async (c) => {
	const id = c.req.param("id");
	// Denial and absence are both NotFoundError, so this cannot be used to discover
	// which project ids exist.
	const project = await requireProjectAccess(c, id, "read");
	return c.json(project);
});

projectRoutes.patch("/:id", async (c) => {
	const id = c.req.param("id");
	// Project settings (git path, proxy domain, chapter defaults) shape how everyone
	// in the project works, so editing them is a management action rather than a
	// write one.
	await requireProjectAccess(c, id, "manage");
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
	// Deletion cascades through every chapter, worktree, container, port allocation
	// and conversation, so it sits in the management tier rather than write.
	const project = await requireProjectAccess(c, id, "manage");

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
		// Host-side cleanup first, and this is no longer optional.
		//
		// These chapters are the ones whose `removeForProjectDeletion` threw, so their
		// containers and terminals are still running and their ports still allocated.
		// The rows below used to be deleted with `chapter_id` at `ON DELETE NO ACTION`,
		// where a surviving container row made `DELETE FROM chapters` fail loudly — ugly,
		// but it kept the host and the database describing the same world. Those FKs now
		// cascade, so deleting the rows silently succeeds and leaves a Podman container
		// running against a project that no longer exists, holding a port nothing will
		// ever release. Best-effort per chapter: one host that refuses to stop must not
		// strand the whole project as undeletable.
		for (const chapterId of remainingChapterIds) {
			try {
				await terminalService.cleanupForChapter(chapterId);
			} catch (err) {
				logger.warn("Failed to stop terminals during project delete fallback", {
					chapterId,
					error: String(err),
				});
			}
			try {
				await containerService.removeChapterContainers(chapterId, { deleteVolumes: true });
			} catch (err) {
				logger.warn("Failed to remove containers during project delete fallback", {
					chapterId,
					error: String(err),
				});
			}
		}

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
				// Break narrator self-references. `refsInheritedFrom` is one too: a lazy
				// fork points at the ancestor still holding its pre-compact refs, and the
				// FK would otherwise block deleting that ancestor.
				tx.update(narrators)
					.set({
						parentNarratorId: null,
						forkMessageId: null,
						pruneBoundaryMessageId: null,
						refsInheritedFrom: null,
						refsBackfillCursor: null,
					})
					.where(inArray(narrators.id, allNarratorIds))
					.run();

				// Delete tables referencing narrators / messages
				tx.delete(terminalViewState)
					.where(inArray(terminalViewState.narratorId, allNarratorIds))
					.run();
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
