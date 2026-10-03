import { createHash, randomUUID } from "node:crypto";
import { access, constants, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { SwitchWorkingDirectoryRequest, WorkspaceContext } from "@shared/workspace-context";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, narrators, projects } from "../db/schema";
import { localBackend, resolveBackend } from "../lib/agent/execution/registry";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { isSecretPlatformPath, isSecretUserPath } from "../lib/fs-secret-paths";
import { hotSafe } from "../lib/hot-safe";
import { isKnowledgeStewardNarrator } from "../lib/narrator-utils";
import { getHome } from "../lib/platform";
import { isInsidePath } from "../lib/platform-path";
import { narraforkDir } from "../lib/settings";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { executionPolicyEngine } from "./execution-policy/engine";
import { gitWorkspaceIdentity, probeLocalGitWorkspace } from "./git-workspace";
import { resolveNarratorSessionCwd } from "./narrator-cwd";
import {
	type ActiveNarrator,
	activeNarrators,
	compactLocks,
	isNarratorMutationAdmissionBusy,
	isNarratorRevertAdmissionBlocked,
	isNarratorRuntimeBusy,
	pendingDangerReflections,
	pendingPermissions,
	withNarratorMutationAdmission,
} from "./narrator-session-state";
import { resolveOAuthNarratorRuntimePolicy } from "./oauth-narrator-runtime-policy";
import { transitionWorkspaceContext, workspaceConflict } from "./workspace-context-transition";

const writingRepositories = hotSafe("narrafork.workspaceRepositoryWrites", () => new Set<string>());

/** Repository common-dir identity, shared across linked worktrees. */
export async function withWorkspaceRepositoryLock<T>(
	repositoryKey: string,
	action: () => Promise<T>,
): Promise<T> {
	// No waiting queue for shared refs/stash mutations across linked worktrees.
	if (writingRepositories.has(repositoryKey))
		throw workspaceConflict(
			"Another Git write is in progress in this repository",
			"GIT_WORKSPACE_BUSY",
		);
	writingRepositories.add(repositoryKey);
	try {
		return await action();
	} finally {
		writingRepositories.delete(repositoryKey);
	}
}

/** M0 has no cross-directory restore engine: do not reinterpret old trees under the new cwd. */
export async function assertWorkspaceHistoryRevertSupported(narratorId: string): Promise<void> {
	const row = await loadWorkspaceRow(narratorId);
	if (row.workspaceRevision > 0)
		throw workspaceConflict(
			"File rollback across a changed workspace context is unsupported (M0)",
			"WORKSPACE_REVERT_UNSUPPORTED",
		);
}

export interface WorkspaceSwitchOptions {
	origin: "http" | "agent";
	active?: ActiveNarrator;
	userId?: string | null;
	/** Revalidate the device allowlist/OAuth authority immediately before CAS. */
	validateDevice?: () => Promise<void>;
}

async function loadWorkspaceRow(id: string) {
	const row = await db.query.narrators.findFirst({
		where: eq(narrators.id, id),
		columns: {
			id: true,
			cwd: true,
			workspaceRevision: true,
			workspaceContext: true,
			defaultDeviceId: true,
			chapterId: true,
			contextProjectId: true,
			variant: true,
			traits: true,
			status: true,
		},
	});
	if (!row) throw new NotFoundError("Narrator", id);
	return row;
}

export async function prepareLocalWorkspaceContext(
	cwd: string,
	revision: number,
	contextProjectId?: string,
	allowUnavailableCurrent = false,
): Promise<WorkspaceContext> {
	if (!isAbsolute(cwd)) throw new ValidationError("cwd must be an absolute path");
	let canonical: string;
	try {
		await access(cwd, constants.R_OK | constants.X_OK);
		canonical = await realpath(cwd);
		if (!(await stat(canonical)).isDirectory()) throw new Error("Not a directory");
	} catch {
		if (!allowUnavailableCurrent)
			throw new ValidationError("Working directory does not exist or is not accessible");
		// The existing cwd can disappear externally. Read/activation must still work
		// so the normal Bash recovery path or an explicit switch can repair it.
		canonical = localBackend.paths.normalize(cwd);
	}
	const probe = await probeLocalGitWorkspace(canonical);
	const git =
		probe.state === "ready" && probe.rootPath && probe.repositoryPath
			? {
					workspaceKey: gitWorkspaceIdentity(localBackend, probe.rootPath),
					repositoryKey: gitWorkspaceIdentity(localBackend, probe.repositoryPath),
					rootPath: probe.rootPath,
				}
			: undefined;
	if (
		!allowUnavailableCurrent &&
		probe.state !== "ready" &&
		probe.state !== "not_git" &&
		probe.state !== "git_unavailable"
	)
		throw new ValidationError(probe.reason ?? "Cannot safely resolve working directory");
	return {
		revision,
		deviceId: "local",
		cwd: canonical,
		pathFlavor: localBackend.paths.flavor === "windows" ? "windows" : "posix",
		contextProjectId,
		git,
		contextKey: createHash("sha256")
			.update(
				JSON.stringify([
					"local",
					localBackend.paths.identityKey(canonical),
					git?.workspaceKey ?? null,
					git?.repositoryKey ?? null,
				]),
			)
			.digest("hex"),
		capabilities: { switchDirectory: true },
	};
}

function prepareRemoteWorkspaceContext(
	deviceId: string,
	cwd: string,
	flavor: string,
	revision: number,
	contextProjectId?: string,
): WorkspaceContext {
	return {
		revision,
		deviceId,
		cwd,
		pathFlavor: flavor === "windows" ? "windows" : "posix",
		contextProjectId,
		contextKey: createHash("sha256")
			.update(JSON.stringify([deviceId, cwd]))
			.digest("hex"),
		capabilities: {
			switchDirectory: false,
			reason: cwd
				? "Remote arbitrary cwd switching is unsupported"
				: "Remote device is unavailable; no local fallback",
		},
	};
}

async function assertTargetAllowed(narratorId: string, cwd: string) {
	const [home, nf] = await Promise.all([
		realpath(getHome()).catch(() => getHome()),
		realpath(narraforkDir).catch(() => narraforkDir),
	]);
	if (
		isSecretPlatformPath(cwd, nf) ||
		isSecretUserPath(cwd, home) ||
		localBackend.paths.contains(cwd, nf) ||
		[".ssh", ".aws", ".gnupg", ".kube"].some((part) =>
			localBackend.paths.contains(cwd, localBackend.paths.resolve(home, part)),
		)
	)
		throw new AppError("Workspace access denied", 403, "WORKSPACE_ACCESS_DENIED");
	const policy = await executionPolicyEngine.compile(narratorId, {
		backend: localBackend,
		paths: localBackend.paths,
		deviceClass: "host",
		target: {
			deviceId: "local",
			backendKind: "local",
			cwd,
			lexicalPath: cwd,
			canonicalPath: cwd,
			pathFlavor: localBackend.paths.flavor,
			runtimeGeneration: localBackend.runtimeGeneration,
			selectionSource: "session_default",
		},
	});
	if (policy.evaluatePath({ path: cwd, operation: "read" }).decision === "deny")
		throw new AppError(
			"Workspace access denied by execution policy",
			403,
			"WORKSPACE_ACCESS_DENIED",
		);
}

function assertSwitchAdmission(id: string, options: WorkspaceSwitchOptions) {
	const active = activeNarrators.get(id);
	if (active?._workspaceInstallFailed)
		throw workspaceConflict("Workspace runtime requires recovery");
	if (isNarratorRevertAdmissionBlocked(id) || compactLocks.has(id))
		throw workspaceConflict("Narrator history is reserved");
	if (isNarratorMutationAdmissionBusy(id))
		throw workspaceConflict("Another workspace mutation is in progress", "WORKSPACE_CONTEXT_BUSY");
	if (options.origin === "http") {
		if (isNarratorRuntimeBusy(id))
			throw workspaceConflict("Narrator is busy", "WORKSPACE_CONTEXT_BUSY");
	} else {
		if (
			!active ||
			active !== options.active ||
			!active._loopRunning ||
			active._workspacePassInvalidated
		)
			throw workspaceConflict("Switching agent pass is no longer current");
		if (
			[...pendingPermissions.values(), ...pendingDangerReflections.values()].some(
				(pending) => pending.narratorId === id,
			)
		)
			throw workspaceConflict("Narrator is waiting for a permission decision");
	}
}

export const workspaceContextService = {
	async withRevision<T>(
		id: string,
		expectedRevision: number,
		expectedWorktreeKey: string | undefined,
		action: (context: WorkspaceContext) => Promise<T>,
	): Promise<T> {
		return withNarratorMutationAdmission(id, async () => {
			if (isNarratorRevertAdmissionBlocked(id))
				throw workspaceConflict("Narrator history is reserved");
			const context = await this.get(id);
			if (
				context.revision !== expectedRevision ||
				(expectedWorktreeKey !== undefined && context.git?.workspaceKey !== expectedWorktreeKey)
			)
				throw workspaceConflict("Workspace identity changed");
			return action(context);
		});
	},
	async get(id: string): Promise<WorkspaceContext> {
		const row = await loadWorkspaceRow(id);
		const chapter = row.chapterId
			? await db.query.chapters.findFirst({
					where: eq(chapters.id, row.chapterId),
					columns: { worktreePath: true, projectId: true },
				})
			: undefined;
		const projectId = chapter?.projectId ?? row.contextProjectId ?? undefined;
		const project = projectId
			? await db.query.projects.findFirst({
					where: eq(projects.id, projectId),
					columns: { gitPath: true },
				})
			: undefined;
		// Persistence is authoritative, including while runtime installation is awaiting.
		const deviceId = row.workspaceContext
			? (row.defaultDeviceId ?? "local")
			: (activeNarrators.get(id)?._defaultDeviceId ?? row.defaultDeviceId ?? "local");
		const supported =
			deviceId === "local" &&
			row.variant === "primary" &&
			!row.traits.includes("background") &&
			!isKnowledgeStewardNarrator(row.traits);
		if (deviceId !== "local") {
			if (
				row.workspaceContext?.deviceId === deviceId &&
				row.workspaceContext.revision === row.workspaceRevision
			)
				return { ...row.workspaceContext, contextProjectId: projectId };
			let cwd = "";
			let pathFlavor: WorkspaceContext["pathFlavor"] = "posix";
			try {
				const backend = resolveBackend({ requested: deviceId });
				cwd = backend.defaultCwd ?? "";
				pathFlavor = backend.paths.flavor === "windows" ? "windows" : "posix";
			} catch {
				/* Offline stays unsupported; never local fallback. */
			}
			return prepareRemoteWorkspaceContext(
				deviceId,
				cwd,
				pathFlavor,
				row.workspaceRevision,
				projectId,
			);
		}
		const committed =
			row.workspaceContext?.revision === row.workspaceRevision &&
			row.workspaceContext.deviceId === "local"
				? row.workspaceContext
				: null;
		const cwd =
			committed?.cwd ??
			activeNarrators.get(id)?.cwd ??
			resolveNarratorSessionCwd(row.cwd, chapter?.worktreePath, project?.gitPath, getHome());
		const context =
			row.workspaceContext?.cwd === cwd &&
			row.workspaceContext.deviceId === deviceId &&
			row.workspaceContext.revision === row.workspaceRevision
				? { ...row.workspaceContext, contextProjectId: projectId }
				: await prepareLocalWorkspaceContext(cwd, row.workspaceRevision, projectId, true);
		return {
			...context,
			capabilities: {
				switchDirectory: supported,
				...(!supported
					? { reason: "Only ordinary primary narrators support directory switching" }
					: {}),
			},
		};
	},
	/** Device selection uses the same CAS and publication protocol as cwd selection. */
	async switchDevice(id: string, deviceId: string | null, options: WorkspaceSwitchOptions) {
		const previous = await this.get(id);
		const targetDeviceId = deviceId ?? "local";
		const checkAdmission = () => {
			if (options.origin === "agent") return assertSwitchAdmission(id, options);
			// The existing HTTP device picker can change a busy session's *next* pass.
			// It never changes targets already admitted by that session.
			if (isNarratorRevertAdmissionBlocked(id) || compactLocks.has(id))
				throw workspaceConflict("Narrator history is reserved");
			if (isNarratorMutationAdmissionBusy(id))
				throw workspaceConflict(
					"Another workspace mutation is in progress",
					"WORKSPACE_CONTEXT_BUSY",
				);
		};
		return transitionWorkspaceContext(
			{
				expectedRevision: previous.revision,
				requestId: randomUUID(),
				target: { deviceId: targetDeviceId, cwd: "" },
			},
			{
				read: () => this.get(id),
				checkAdmission,
				prepare: async () => {
					const row = await loadWorkspaceRow(id);
					if (targetDeviceId !== "local") {
						const backend = resolveBackend({ requested: targetDeviceId });
						if (!backend.defaultCwd || !backend.paths.isAbsolute(backend.defaultCwd))
							throw new ValidationError("Remote device has no absolute default working directory");
						return prepareRemoteWorkspaceContext(
							targetDeviceId,
							backend.defaultCwd,
							backend.paths.flavor,
							previous.revision,
							previous.contextProjectId,
						);
					}
					// cwd remains the narrator's selected local directory across remote visits.
					const chapter = row.chapterId
						? await db.query.chapters.findFirst({
								where: eq(chapters.id, row.chapterId),
								columns: { worktreePath: true },
							})
						: undefined;
					const project = previous.contextProjectId
						? await db.query.projects.findFirst({
								where: eq(projects.id, previous.contextProjectId),
								columns: { gitPath: true },
							})
						: undefined;
					const target = await prepareLocalWorkspaceContext(
						resolveNarratorSessionCwd(row.cwd, chapter?.worktreePath, project?.gitPath, getHome()),
						previous.revision,
						previous.contextProjectId,
						true,
					);
					const supported =
						row.variant === "primary" &&
						!row.traits.includes("background") &&
						!isKnowledgeStewardNarrator(row.traits);
					return {
						...target,
						capabilities: {
							switchDirectory: supported,
							...(!supported
								? { reason: "Only ordinary primary narrators support directory switching" }
								: {}),
						},
					};
				},
				admit: (action) => withNarratorMutationAdmission(id, action, { failIfBusy: true }),
				commit: async (old, current) => {
					await options.validateDevice?.();
					if (targetDeviceId !== "local") {
						const backend = resolveBackend({ requested: targetDeviceId });
						if (backend.defaultCwd !== current.cwd)
							throw workspaceConflict("Remote default working directory changed");
					}
					const rows = await db
						.update(narrators)
						.set({
							defaultDeviceId: deviceId,
							workspaceRevision: current.revision,
							workspaceContext: current,
							apiConversationId: null,
							updatedAt: new Date().toISOString(),
						})
						.where(and(eq(narrators.id, id), eq(narrators.workspaceRevision, old.revision)))
						.returning({ id: narrators.id });
					return rows.length === 1;
				},
				install: async (current) => {
					executionPolicyEngine.invalidate(id);
					const active = activeNarrators.get(id);
					if (!active?.alive) return;
					active._workspacePassInvalidated = !!active._loopRunning;
					active._defaultDeviceId = deviceId;
					active._workspaceContext = current;
					active._lastTreeHash = undefined;
					active._bashBeforeStatus?.clear();
					if (active._gitTrackTimer) clearTimeout(active._gitTrackTimer);
					active._gitTrackTimer = undefined;
					active.conversationId = randomUUID();
					active._resetUpstreamSessionOnNextRequest = true;
				},
				pause: () => {
					const active = activeNarrators.get(id);
					if (active) {
						active._workspaceInstallFailed = true;
						active._workspacePassInvalidated = true;
						active.abortController.abort("Workspace installation failed");
					}
				},
				publish: ({ previous: old, current }) =>
					broadcastToNarrator(id, {
						type: "workspace_context_changed",
						narratorId: id,
						previous: old,
						current,
					}),
			},
		);
	},
	async switch(
		id: string,
		request: SwitchWorkingDirectoryRequest,
		options: WorkspaceSwitchOptions,
	) {
		return transitionWorkspaceContext(request, {
			read: () => this.get(id),
			checkAdmission: () => assertSwitchAdmission(id, options),
			prepare: async (previous, input) => {
				if (!previous.capabilities.switchDirectory || input.target.deviceId !== "local")
					throw workspaceConflict(
						"Remote or specialized narrator directory switching is unsupported",
						"WORKSPACE_CONTEXT_UNSUPPORTED",
					);
				if (await resolveOAuthNarratorRuntimePolicy(id))
					throw workspaceConflict(
						"OAuth directory switching is unsupported",
						"WORKSPACE_CONTEXT_UNSUPPORTED",
					);
				const row = await loadWorkspaceRow(id);
				if (row.status === "working" || row.status === "waiting") {
					if (options.origin !== "agent")
						throw workspaceConflict("Narrator is busy", "WORKSPACE_CONTEXT_BUSY");
				}
				const target = await prepareLocalWorkspaceContext(
					input.target.cwd,
					previous.revision,
					previous.contextProjectId,
				);
				await assertTargetAllowed(id, target.cwd);
				if (row.chapterId) {
					const chapter = await db.query.chapters.findFirst({
						where: eq(chapters.id, row.chapterId),
						columns: { worktreePath: true },
					});
					const root = chapter?.worktreePath
						? await realpath(chapter.worktreePath).catch(() => null)
						: null;
					if (
						!root ||
						!isInsidePath(root, target.cwd) ||
						previous.git?.workspaceKey !== target.git?.workspaceKey
					)
						throw workspaceConflict(
							"Chapter cross-worktree switching is unsupported",
							"WORKSPACE_CONTEXT_UNSUPPORTED",
						);
				}
				if (input.expectedWorktreeKey && input.expectedWorktreeKey !== target.git?.workspaceKey)
					throw workspaceConflict("Target worktree identity changed");
				return target;
			},
			admit: (action) => withNarratorMutationAdmission(id, action, { failIfBusy: true }),
			commit: async (previous, current) => {
				// Admission may have waited behind a Git mutation. Revalidate canonical
				// target and its deny rules before CAS, never install stale prepared identity.
				const target = await prepareLocalWorkspaceContext(
					current.cwd,
					current.revision,
					current.contextProjectId,
				);
				if (target.contextKey !== current.contextKey)
					throw workspaceConflict("Target directory identity changed");
				await assertTargetAllowed(id, current.cwd);
				const rows = await db
					.update(narrators)
					.set({
						cwd: current.cwd,
						workspaceRevision: current.revision,
						workspaceContext: current,
						apiConversationId: null,
					})
					.where(and(eq(narrators.id, id), eq(narrators.workspaceRevision, previous.revision)))
					.returning({ id: narrators.id });
				return rows.length === 1;
			},
			install: async (current) => {
				const active = activeNarrators.get(id);
				executionPolicyEngine.invalidate(id);
				if (!active?.alive) return;
				// Invalidate before awaiting preparation of skills. Old config keeps its frozen cwd.
				active._workspacePassInvalidated = options.origin === "agent";
				active._lastTreeHash = undefined;
				active._bashBeforeStatus?.clear();
				if (active._gitTrackTimer) clearTimeout(active._gitTrackTimer);
				active._gitTrackTimer = undefined;
				const { updateActiveNarratorCwdAndSkillContext } = await import("./narrator-session");
				await updateActiveNarratorCwdAndSkillContext(id, current.cwd);
				active._workspaceContext = current;
				active._workspaceInstallFailed = false;
				active.conversationId = randomUUID();
				active._resetUpstreamSessionOnNextRequest = true;
			},
			pause: () => {
				const active = activeNarrators.get(id);
				if (active) {
					active._workspaceInstallFailed = true;
					active._workspacePassInvalidated = true;
					active.abortController.abort("Workspace installation failed");
				}
			},
			publish: ({ previous, current }) =>
				broadcastToNarrator(id, {
					type: "workspace_context_changed",
					narratorId: id,
					previous,
					current,
				}),
		});
	},
};
