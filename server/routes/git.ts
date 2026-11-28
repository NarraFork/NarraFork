import { type GitStatusPageQuery, isGitStatusFilterChar } from "@shared/git-status-page";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { basePath } from "hono/route";
import { AppError, catalogError, ValidationError, zodValidationError } from "../lib/errors";
import { resolveUserGitIdentityEnv } from "../lib/git-identity";
import { logger } from "../lib/logger";
import { narratorPrincipalOf, requireNarratorAccess } from "../lib/narrator-access";
import {
	gitCheckoutSchema,
	gitCommitDiffQuerySchema,
	gitCommitSchema,
	gitCommitShaSchema,
	gitDiffQuerySchema,
	gitDiscardSchema,
	gitFetchSchema,
	gitLogQuerySchema,
	gitModificationsQuerySchema,
	gitPushSchema,
	gitResetSchema,
	gitStageSchema,
	gitStashSchema,
	gitUnstageSchema,
} from "../lib/validators";
import {
	gitStagingActionSchema,
	gitStagingDiffQuerySchema,
	gitStagingFilesQuerySchema,
	gitStagingListIdSchema,
	gitStatusPageStatsQuerySchema,
} from "../lib/validators/git";
import { getAuthPrincipal, revalidateAuthPrincipal } from "../middleware/auth";
import {
	assertGitWorkspaceStatusPageScope,
	getGitWorkspaceLineStats,
	getGitWorkspaceStatus,
	getGitWorkspaceStatusPage,
	getGitWorkspaceStatusPageStats,
	gitAttributionScopes,
	gitManagementService,
	invalidateGitWorkspace,
	invalidateGitWorkspaceFacts,
	validateFilePaths,
	validateGitFileTargets,
} from "../services/git-management-service";
import { type GitStatusSummary, withGitRequestContext } from "../services/git-service";
import { getGitStagingListsService } from "../services/git-staging-lists-service";
import { GitStatusPageError } from "../services/git-status-page";
import { assertGitWorkspaceKey, type GitWorkspaceTarget } from "../services/git-workspace";
import { authorizeGitTarget, requireReadyGitTarget } from "../services/git-workspace-access";
import {
	collectGitAttributionScopes,
	redactGitModificationView,
} from "../services/git-workspace-attribution";
import {
	withWorkspaceRepositoryLock,
	workspaceContextService,
} from "../services/workspace-context-service";
import { getWorkspaceModificationView } from "../services/workspace-modification-view";
import { withWorkspaceAdmission } from "../services/worktree-lifecycle-guard";

export { validateFilePaths } from "../services/git-management-service";

type GitEnv = { Variables: { gitTarget: GitWorkspaceTarget } };

function stagingGrantId(c: Context): string | undefined {
	const principal = getAuthPrincipal(c);
	return principal?.type === "oauth"
		? JSON.stringify([
				c.req.param("id"),
				"oauth",
				principal.oauth.tokenId,
				principal.oauth.clientId,
				principal.oauth.grantId,
			])
		: c.req.param("id");
}

function statusPageQuery(c: Context): GitStatusPageQuery {
	const cursor = c.req.query("cursor");
	const limit = c.req.query("limit");
	const filter = c.req.query("filter");
	if (cursor !== undefined && (!cursor || cursor.length > 4096))
		throw new ValidationError("A bounded Git status cursor is required");
	if (limit !== undefined && (!/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 200))
		throw new ValidationError("Git status page limit must be between 1 and 200");
	const filters = filter ? filter.split(",") : [];
	if ((filter?.length ?? 0) > 32 || !filters.every(isGitStatusFilterChar))
		throw new ValidationError("Invalid Git status filter");
	return {
		...(cursor !== undefined ? { cursor } : {}),
		...(limit !== undefined ? { limit: Number(limit) } : {}),
		filter: filters,
	};
}

function modificationCursor(c: Context) {
	const cursorAt = c.req.query("cursorAt");
	const cursorRowId = c.req.query("cursorRowId");
	if (
		(cursorAt === undefined) !== (cursorRowId === undefined) ||
		(cursorAt?.length ?? 0) > 64 ||
		(cursorRowId?.length ?? 0) > 64
	)
		throw new ValidationError("A bounded cursorAt/cursorRowId pair is required");
	if (
		cursorRowId !== undefined &&
		(!/^[1-9]\d*$/.test(cursorRowId) || !Number.isSafeInteger(Number(cursorRowId)))
	)
		throw new ValidationError("Invalid historical row cursor");
	const cursorUntil = cursorAt
		? gitModificationsQuerySchema.parse({ until: cursorAt }).until
		: undefined;
	return cursorUntil && cursorRowId ? { changedAt: cursorUntil, rowId: cursorRowId } : undefined;
}

function cancelledCurrentDiff(filePaths: string[]) {
	const target = (kind: "index" | "worktree") => ({
		source: "current_diff" as const,
		target: kind,
		status: "unknown" as const,
		actor: null,
		effectId: null,
		reason: "cancelled" as const,
		baselineVersion: "",
		historyComplete: false,
		modeScope: kind === "index" ? ("git_executable_bit" as const) : ("filesystem" as const),
		continuity: "unverified" as const,
	});
	return {
		source: "current_diff" as const,
		baselineStatus: "unavailable" as const,
		version: null,
		headSha: null,
		clean: null,
		complete: false,
		scope: null,
		byFile: filePaths.slice(0, 200).map((filePath) => ({
			filePath,
			index: target("index"),
			worktree: target("worktree"),
		})),
	};
}

/**
 * Uncommitted paths to read history for. A client-named path only selects an entry of
 * this trusted status, whose rename source becomes the alias. A path absent from a
 * truncated status is unknown, not clean: it is read without an alias and reported
 * incomplete. Absent from a complete status, it has no uncommitted change to explain.
 */
function modificationFiles(status: GitStatusSummary, filePath: string | undefined) {
	const files =
		filePath === undefined ? status.files : status.files.filter((file) => file.path === filePath);
	const pathAliases = new Map<string, string>();
	for (const file of files) if (file.oldPath) pathAliases.set(file.oldPath, file.path);
	if (filePath !== undefined && files.length === 0 && status.truncated === true)
		return { filePaths: [filePath], pathAliases, truncated: true };
	return {
		filePaths: [...files.map((file) => file.path), ...pathAliases.keys()],
		pathAliases,
		truncated: filePath === undefined && status.truncated === true,
	};
}

async function cancelledModificationResponse(c: Context) {
	const id = c.req.param("id") ?? "";
	const query = gitModificationsQuerySchema.parse(c.req.query());
	modificationCursor(c);
	await requireNarratorAccess(c, id, "read");
	return c.json({
		source: "history",
		...(query.scope === "uncommitted" ? { currentDiff: cancelledCurrentDiff([]) } : {}),
		nextCursor: null,
		workspacePath: "",
		deviceId: "",
		...((query.projection ?? "all") === "all" ? { timeline: [] } : {}),
		byFile: [],
		hasMore: true,
		windowCount: 0,
		actors: [],
		completeness: {
			fileHistoryComplete: false,
			contributorsTruncated: true,
			countsLowerBound: true,
			warningScanComplete: false,
			asOfRevision: null,
		},
		evidence: "legacy",
		baselineStatus: "unverified",
	});
}

/**
 * Git routes for a narrator's workspace. No workspace path comes from the client; a client file path is validated as Git-root-relative before any use.
 */
function createGitRoutes() {
	const routes = new Hono<GitEnv>();
	const prefix = "/:id/git";
	routes.use(
		`${prefix}/*`,
		bodyLimit({
			maxSize: 1024 * 1024,
			onError: (c) =>
				c.json({ error: "Git request body exceeds 1 MiB", code: "PAYLOAD_TOO_LARGE" }, 413),
		}),
	);
	routes.use(`${prefix}/*`, async (c, next) => {
		try {
			// The deferred summary owns its authorization and cached discovery chain.
			if (
				c.req.method === "GET" &&
				/^\/[^/]+\/git\/summary$/.test(c.req.path.slice(basePath(c).length))
			)
				return await next();
			const need = c.req.method === "GET" ? "read" : "write";
			const workspaceRequest = c.req.method === "GET" && c.req.path.endsWith("/workspace");
			const origin = { narratorId: c.req.param("id") ?? "" };
			if (
				c.req.method === "GET" &&
				c.req.path.endsWith("/modifications") &&
				c.req.raw.signal.aborted
			)
				return cancelledModificationResponse(c);
			const discoveryMode = c.req.path.includes("/staging-lists")
				? ("metadata" as const)
				: undefined;
			const target = await authorizeGitTarget(c, origin, need, discoveryMode);
			let parallelStagingWrite = false;
			if (!workspaceRequest) {
				if (need === "write") {
					// Hono caches parsed JSON: each handler still uses its existing Zod schema.
					const body = await c.req.json().catch((error: unknown) => {
						if (error instanceof Error && error.name === "BodyLimitError")
							throw new AppError("Git request body exceeds 1 MiB", 413, "PAYLOAD_TOO_LARGE");
						return {};
					});
					assertGitWorkspaceKey(target.workspace, body.workspaceKey);
					if (target.backend?.kind === "local" && c.req.path.endsWith("/staging-lists/action")) {
						const action = gitStagingActionSchema.safeParse(body);
						parallelStagingWrite =
							action.success && action.data.action !== "commit" && action.data.action !== "recover";
					}
				} else if (c.req.query("workspaceKey") !== undefined)
					assertGitWorkspaceKey(target.workspace, c.req.query("workspaceKey"));
				requireReadyGitTarget(target, need);
			}
			if (
				c.req.method === "GET" &&
				c.req.query("fresh") === "1" &&
				(c.req.path.endsWith("/status") || c.req.path.endsWith("/line-stats"))
			)
				invalidateGitWorkspaceFacts(target);
			target.beforeWrite = async () => {
				if (c.req.path.endsWith("/staging-lists/action")) await revalidateAuthPrincipal(c);
				const fresh = await authorizeGitTarget(c, origin, "write", discoveryMode);
				assertGitWorkspaceKey(fresh.workspace, target.workspace.workspaceKey);
				requireReadyGitTarget(fresh, "write");
				target.authorizeFilePaths = fresh.authorizeFilePaths;
				if (
					(fresh.discoveryRuntimeGeneration ?? fresh.backend?.runtimeGeneration) !==
					(target.discoveryRuntimeGeneration ?? target.backend?.runtimeGeneration)
				)
					throw new AppError(
						"Git device connection changed; refresh before retrying",
						409,
						"GIT_WORKSPACE_CHANGED",
					);
			};
			const lockKey =
				need === "write" && !parallelStagingWrite ? target.workspace.repositoryKey : null;
			c.set("gitTarget", target);
			const started = performance.now();
			const run = () => withGitRequestContext(c.req.raw.signal, next, target.beforeWrite);
			const write = () => (lockKey ? withWorkspaceRepositoryLock(lockKey, run) : run());
			try {
				if (need === "write" && target.workspace.deviceId === "local") {
					const id = c.req.param("id") ?? "";
					const context = await workspaceContextService.get(id);
					if (parallelStagingWrite) {
						await workspaceContextService.withParallelRevision(
							id,
							context.revision,
							target.workspace.workspaceKey ?? undefined,
							() =>
								withWorkspaceAdmission(
									{
										deviceId: target.workspace.deviceId,
										path: target.workspace.rootPath ?? undefined,
										repositoryKey: target.workspace.repositoryKey ?? undefined,
									},
									write,
								),
							c.req.raw.signal,
						);
					} else {
						await workspaceContextService.withRevision(
							id,
							context.revision,
							target.workspace.workspaceKey ?? undefined,
							write,
						);
					}
				} else await write();
			} finally {
				if (need === "write" || performance.now() - started > 1000)
					logger.info("Git workspace request", {
						operation: c.req.path.split("/").pop(),
						workspaceKey: target.workspace.workspaceKey,
						deviceId: target.workspace.deviceId,
						elapsedMs: Math.round(performance.now() - started),
					});
			}
		} catch (error) {
			// Only cancellation of the original HTTP request qualifies; reader deadlines
			// and other database failures retain their existing error boundary.
			if (
				c.req.raw.signal.aborted &&
				error instanceof Error &&
				"code" in error &&
				error.code === "DB_READ_ABORTED"
			)
				throw catalogError("GIT_REQUEST_CANCELLED");
			if (error instanceof GitStatusPageError)
				throw new AppError(error.message, error.status, error.code);
			throw error;
		}
	});
	const access = (c: Context<GitEnv>) => {
		const target = c.get("gitTarget");
		const path = target.workspace.rootPath;
		if (!path) throw new ValidationError("Git workspace root is unavailable");
		return { target, path, git: gitManagementService(target, c.req.raw.signal) };
	};
	const summary = (c: Context<GitEnv>) =>
		getGitWorkspaceStatus(
			c.get("gitTarget"),
			c.req.raw.signal,
			c.req.query("fresh") === "1" ? 0 : undefined,
		);
	const changed = (c: Context<GitEnv>) => invalidateGitWorkspace(c.get("gitTarget"));

	routes.get(`${prefix}/workspace`, (c) => c.json(c.get("gitTarget").workspace));
	routes.get(`${prefix}/status`, async (c) => c.json(await summary(c)));
	routes.get(`${prefix}/status-files`, async (c) => {
		const target = c.get("gitTarget");
		assertGitWorkspaceKey(target.workspace, c.req.query("workspaceKey"));
		const query = statusPageQuery(c);
		try {
			return c.json(
				await getGitWorkspaceStatusPage(
					target,
					narratorPrincipalOf(c).userId,
					query,
					c.req.raw.signal,
				),
			);
		} catch (error) {
			if (error instanceof GitStatusPageError)
				throw new AppError(error.message, error.status, error.code);
			throw error;
		}
	});
	routes.get(`${prefix}/status-page-stats`, async (c) => {
		const target = c.get("gitTarget");
		assertGitWorkspaceKey(target.workspace, c.req.query("workspaceKey"));
		const parsed = gitStatusPageStatsQuerySchema.safeParse(c.req.query());
		if (!parsed.success) throw zodValidationError(parsed.error);
		validateFilePaths(parsed.data.rows.map((row) => row.path));
		try {
			return c.json(
				await getGitWorkspaceStatusPageStats(
					target,
					narratorPrincipalOf(c).userId,
					parsed.data,
					c.req.raw.signal,
				),
			);
		} catch (error) {
			if (error instanceof GitStatusPageError)
				throw new AppError(error.message, error.status, error.code);
			throw error;
		}
	});
	routes.get(`${prefix}/line-stats`, async (c) =>
		c.json(
			await getGitWorkspaceLineStats(
				c.get("gitTarget"),
				c.req.raw.signal,
				c.req.query("fresh") === "1" ? 0 : undefined,
			),
		),
	);
	routes.get(`${prefix}/modifications`, async (c) => {
		const { target, path, git } = access(c);
		const parsed = gitModificationsQuerySchema.safeParse(c.req.query());
		if (!parsed.success) throw zodValidationError(parsed.error);
		const query = parsed.data;
		if (query.narratorId && query.narratorId !== "external")
			await requireNarratorAccess(c, query.narratorId, "read");
		if (query.filePath !== undefined) validateFilePaths([query.filePath]);
		const cursor = modificationCursor(c);
		const status = query.scope === "uncommitted" ? await git.getStatusSummary(path) : null;
		const files = status ? modificationFiles(status, query.filePath) : null;
		const directScopes = gitAttributionScopes(target, files?.filePaths ?? []);
		const discoveredScopes = await collectGitAttributionScopes(target, c.req.raw.signal);
		// Discovered cwd keys hold stored rows; ancestor-directory guesses come after them.
		// The view drops spellings with no rows before applying its own scope cap.
		const scopeMap = new Map(
			[...discoveredScopes.scopes, ...directScopes.scopes].map((scope) => [
				scope.workspacePath,
				scope,
			]),
		);
		const scopesTruncated =
			directScopes.truncated || discoveredScopes.truncated || files?.truncated === true;
		const view = await getWorkspaceModificationView(path, {
			deviceId: target.workspace.deviceId,
			additionalScopes: [...scopeMap.values()],
			additionalScopesTruncated: scopesTruncated,
			currentDiff: query.scope === "uncommitted",
			signal: c.req.raw.signal,
			cursor,
			limit: query.limit,
			since: query.since,
			until: query.until,
			narratorId: query.narratorId,
			projection: query.projection,
			...(files ? { filePaths: files.filePaths, pathAliases: files.pathAliases } : {}),
		});
		if (scopesTruncated) {
			view.hasMore = true;
			view.completeness = {
				...view.completeness,
				fileHistoryComplete: false,
				contributorsTruncated: true,
				countsLowerBound: true,
				warningScanComplete: false,
			};
		}
		return c.json(await redactGitModificationView(view, narratorPrincipalOf(c), c.req.raw.signal));
	});
	routes.get(`${prefix}/staging-lists`, async (c) => {
		const target = c.get("gitTarget");
		assertGitWorkspaceKey(target.workspace, c.req.query("workspaceKey"));
		const staging = await getGitStagingListsService(
			target,
			narratorPrincipalOf(c).userId,
			c.req.raw.signal,
			stagingGrantId(c),
		);
		return c.json(await staging.summary());
	});
	routes.get(`${prefix}/staging-lists/:listId/files`, async (c) => {
		const parsed = gitStagingFilesQuerySchema.safeParse(c.req.query());
		if (!parsed.success) throw zodValidationError(parsed.error);
		const target = c.get("gitTarget");
		assertGitWorkspaceKey(target.workspace, parsed.data.workspaceKey);
		const staging = await getGitStagingListsService(
			target,
			narratorPrincipalOf(c).userId,
			c.req.raw.signal,
			stagingGrantId(c),
		);
		return c.json(
			await staging.files(gitStagingListIdSchema.parse(c.req.param("listId")), {
				cursor: parsed.data.cursor,
				limit: parsed.data.limit,
				filter: parsed.data.filter,
			}),
		);
	});
	routes.get(`${prefix}/staging-lists/:listId/diff`, async (c) => {
		const parsed = gitStagingDiffQuerySchema.safeParse(c.req.query());
		if (!parsed.success) throw zodValidationError(parsed.error);
		const target = c.get("gitTarget");
		assertGitWorkspaceKey(target.workspace, parsed.data.workspaceKey);
		const { path, oldPath } = parsed.data;
		await validateGitFileTargets(target, [path, ...(oldPath ? [oldPath] : [])]);
		const staging = await getGitStagingListsService(
			target,
			narratorPrincipalOf(c).userId,
			c.req.raw.signal,
			stagingGrantId(c),
		);
		return c.json(
			await staging.diff(gitStagingListIdSchema.parse(c.req.param("listId")), { path, oldPath }),
		);
	});
	routes.post(`${prefix}/staging-lists/action`, async (c) => {
		const parsed = gitStagingActionSchema.safeParse(await c.req.json());
		if (!parsed.success) throw zodValidationError(parsed.error);
		const { workspaceKey, ...action } = parsed.data;
		const target = c.get("gitTarget");
		assertGitWorkspaceKey(target.workspace, workspaceKey);
		const staging = await getGitStagingListsService(
			target,
			narratorPrincipalOf(c).userId,
			c.req.raw.signal,
			stagingGrantId(c),
		);
		const identity =
			action.action === "commit" ? await resolveUserGitIdentityEnv(c.get("user").sub) : null;
		const result = await staging.action(
			action.action === "commit" && identity?.GIT_AUTHOR_NAME && identity.GIT_AUTHOR_EMAIL
				? {
						...action,
						identity: { name: identity.GIT_AUTHOR_NAME, email: identity.GIT_AUTHOR_EMAIL },
					}
				: action,
		);
		if (action.action === "commit" && result.commitOid) changed(c);
		return c.json(result);
	});
	for (const operation of ["stage", "unstage", "discard"] as const) {
		routes.post(`${prefix}/${operation}`, async (c) => {
			const { target, path, git } = access(c);
			const schema =
				operation === "stage"
					? gitStageSchema
					: operation === "unstage"
						? gitUnstageSchema
						: gitDiscardSchema;
			const body = schema.parse(await c.req.json());
			if (body.files) await validateGitFileTargets(target, body.files);
			if (body.snapshotScope) {
				const expectedSection = operation === "unstage" ? "staged" : "unstaged";
				if (body.snapshotScope.section !== expectedSection)
					throw new ValidationError("Git snapshot section does not match this operation");
				await assertGitWorkspaceStatusPageScope(
					target,
					narratorPrincipalOf(c).userId,
					body.snapshotScope,
					body.files ?? [],
					c.req.raw.signal,
				).catch((error: unknown) => {
					// Hono may serialize handler failures before an outer middleware's
					// catch runs, so preserve the cursor error at the mutation boundary.
					if (error instanceof GitStatusPageError)
						throw new AppError(error.message, error.status, error.code);
					throw error;
				});
			}
			if (operation === "stage") {
				if (body.all) await git.stageAll(path);
				else {
					if (!body.files) throw new ValidationError("files or all is required");
					await git.stageFiles(path, body.files);
				}
			} else if (operation === "unstage") {
				if (body.all) await git.unstageAll(path);
				else {
					if (!body.files) throw new ValidationError("files or all is required");
					await git.unstageFiles(path, body.files);
				}
			} else {
				if (body.all) await git.discardAll(path);
				else {
					if (!body.files) throw new ValidationError("files or all is required");
					await git.discardFiles(path, body.files);
				}
			}
			changed(c);
			return c.json(await summary(c));
		});
	}
	routes.post(`${prefix}/commit`, async (c) => {
		const { path, git } = access(c);
		const { message } = gitCommitSchema.parse(await c.req.json());
		const sha = await git.commit(path, message, await resolveUserGitIdentityEnv(c.get("user").sub));
		changed(c);
		// A failed follow-up read must never invite replaying an already successful commit.
		let status: Awaited<ReturnType<typeof summary>> | undefined;
		try {
			status = await summary(c);
		} catch {
			/* commit remains successful */
		}
		return c.json({ commitSha: sha, status });
	});
	routes.get(`${prefix}/diff`, async (c) => {
		const { target, path, git } = access(c);
		const { file, staged } = gitDiffQuerySchema.parse(c.req.query());
		await validateGitFileTargets(target, [file]);
		return c.json(await git.getFileDiff(path, file, staged));
	});
	routes.get(`${prefix}/stash/list`, async (c) => {
		const { path, git } = access(c);
		return c.json(await git.stashList(path));
	});
	routes.post(`${prefix}/stash`, async (c) => {
		const { path, git } = access(c);
		const body = gitStashSchema.parse(await c.req.json());
		let hasConflicts = false;
		if (body.action === "push")
			await git.stash(path, body.message, await resolveUserGitIdentityEnv(c.get("user").sub));
		else if (body.action === "pop") hasConflicts = (await git.stashPop(path)).hasConflicts;
		else await git.stashDrop(path, body.index ?? 0);
		changed(c);
		return c.json({ hasConflicts, status: await summary(c) });
	});
	routes.get(`${prefix}/log`, async (c) => {
		const { path, git } = access(c);
		return c.json(await git.getLog(path, gitLogQuerySchema.parse(c.req.query())));
	});
	// Commit preview: read-only, so a read-only workspace may use it too.
	routes.get(`${prefix}/commits/:sha`, async (c) => {
		const { path, git } = access(c);
		const sha = gitCommitShaSchema.parse(c.req.param("sha"));
		return c.json(await git.getCommitDetail(path, sha));
	});
	routes.get(`${prefix}/commits/:sha/diff`, async (c) => {
		const { path, git } = access(c);
		const sha = gitCommitShaSchema.parse(c.req.param("sha"));
		const { file, oldPath } = gitCommitDiffQuerySchema.parse(c.req.query());
		// Lexical only: a historical path may no longer exist in the working tree.
		validateFilePaths(oldPath ? [file, oldPath] : [file]);
		return c.json(await git.getCommitPatch(path, sha, file, oldPath));
	});
	routes.post(`${prefix}/reset`, async (c) => {
		const { path, git } = access(c);
		const { target: ref, mode } = gitResetSchema.parse(await c.req.json());
		if (mode === "hard") await git.resetHard(path, ref);
		else await git.resetSoft(path, ref);
		changed(c);
		return c.json(await summary(c));
	});
	// === Branch management ===
	routes.get(`${prefix}/branches`, async (c) => {
		const { path, git } = access(c);
		return c.json(await git.getBranches(path));
	});
	routes.post(`${prefix}/checkout`, async (c) => {
		const { path, git } = access(c);
		// safeParse + zodValidationError: a bare `.parse()` rejection is not an
		// AppError, so it would surface as a 500 rather than a 400.
		const parsed = gitCheckoutSchema.safeParse(await c.req.json());
		if (!parsed.success) throw zodValidationError(parsed.error);
		await git.checkoutBranch(path, parsed.data);
		changed(c);
		return c.json({ status: await summary(c) });
	});
	routes.post(`${prefix}/push`, async (c) => {
		const { path, git } = access(c);
		const parsed = gitPushSchema.safeParse(await c.req.json());
		if (!parsed.success) throw zodValidationError(parsed.error);
		// Never `--force`: a non-fast-forward comes back as git's own refusal text.
		await git.push(path, parsed.data);
		changed(c);
		return c.json({ status: await summary(c) });
	});
	routes.post(`${prefix}/fetch`, async (c) => {
		const { path, git } = access(c);
		const parsed = gitFetchSchema.safeParse(await c.req.json());
		if (!parsed.success) throw zodValidationError(parsed.error);
		await git.fetch(path, parsed.data);
		changed(c);
		return c.json({ status: await summary(c) });
	});
	routes.post(`${prefix}/ai-commit-message`, async (c) => {
		const { path, git } = access(c);
		const diff = await git.getFullDiff(path);
		if (!diff.trim()) return c.json({ message: "" });
		return c.json({ message: await generateCommitMessage(diff, c.req.raw.signal) });
	});
	return routes;
}

export const narratorGitRoutes = createGitRoutes();

async function generateCommitMessage(diff: string, requestSignal: AbortSignal): Promise<string> {
	const { summaryGenerateWithHistory } = await import("../lib/agent");
	const systemPrompt = `You are a git commit message generator. Given a git diff, generate a concise Conventional Commits message (<type>(<optional scope>): <description>). Use lowercase imperative mood, no period, under 72 characters. Reply with ONLY the commit message.`;
	const controller = new AbortController();
	const relay = () => controller.abort(requestSignal.reason);
	requestSignal.addEventListener("abort", relay, { once: true });
	if (requestSignal.aborted) relay();
	const timer = setTimeout(
		() => controller.abort(new Error("AI commit message generation timed out")),
		30_000,
	);
	let message: string;
	try {
		message = await summaryGenerateWithHistory(
			systemPrompt,
			`<diff>\n${diff}\n</diff>`,
			"en",
			{ kind: "git_summary" },
			{ signal: controller.signal },
		);
	} finally {
		clearTimeout(timer);
		requestSignal.removeEventListener("abort", relay);
	}
	message = message
		.trim()
		.replace(/^["'`\u201c\u201d]+|["'`\u201c\u201d]+$/g, "")
		.split("\n")[0]
		.trim();
	return !message || message.length > 200 ? "chore: update files" : message;
}
