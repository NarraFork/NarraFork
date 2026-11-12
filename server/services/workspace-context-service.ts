import { createHash, randomUUID } from "node:crypto";
import { access, constants, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
	type SwitchWorkingDirectoryRequest,
	serializeWorkspaceContext,
	type WorkspaceContext,
} from "@shared/workspace-context";
import {
	isAbsoluteForFlavor,
	normalizeWorkspacePathFlavor,
	parseWorkspaceDirectoryMap,
	readDeviceDirectory,
	type WorkspaceDirectoryEntry,
	type WorkspaceDirectoryMap,
	type WorkspacePathFlavor,
	withDeviceDirectory,
} from "@shared/workspace-directories";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { narrators, projects } from "../db/schema";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import { targetPathSemantics } from "../lib/agent/execution/path-semantics";
import { localBackend, resolveBackend } from "../lib/agent/execution/registry";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { isSecretPlatformPath, isSecretUserPath } from "../lib/fs-secret-paths";
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { isKnowledgeStewardNarrator } from "../lib/narrator-utils";
import { getHome } from "../lib/platform";
import { narraforkDir } from "../lib/settings";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { executionPolicyEngine } from "./execution-policy/engine";
import { gitWorkspaceIdentity, probeLocalGitWorkspace } from "./git-workspace";
import { isFormerChapterSessionWithoutDirectory, resolveNarratorSessionCwd } from "./narrator-cwd";
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
import { syncNarratorProjectLinksSafely } from "./project-index";
import { transitionWorkspaceContext, workspaceConflict } from "./workspace-context-transition";
import { withWorkspaceAdmission } from "./worktree-lifecycle-guard";

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
			workspaceDirectories: true,
			defaultDeviceId: true,
			contextProjectId: true,
			variant: true,
			traits: true,
			status: true,
		},
	});
	if (!row) throw new NotFoundError("Narrator", id);
	return row;
}

type WorkspaceRow = Awaited<ReturnType<typeof loadWorkspaceRow>>;

/**
 * Narrator-level gate for directory switching. Independent of which device is
 * current: a specialized session never chooses its own directory, and an offline
 * device must not change that answer (`get()` publishes this via capabilities).
 */
function supportsDirectorySwitch(row: Pick<WorkspaceRow, "variant" | "traits">): boolean {
	return (
		row.variant === "primary" &&
		!row.traits.includes("background") &&
		!isKnowledgeStewardNarrator(row.traits)
	);
}

function localPathFlavor(): WorkspacePathFlavor {
	return normalizeWorkspacePathFlavor(localBackend.pathFlavor);
}

/** Path grammar of a device known through the row, without requiring it to be online. */
function devicePathFlavor(row: WorkspaceRow, deviceId: string): WorkspacePathFlavor {
	if (deviceId === "local") return localPathFlavor();
	if (row.workspaceContext?.deviceId === deviceId)
		return normalizeWorkspacePathFlavor(row.workspaceContext.pathFlavor);
	try {
		return normalizeWorkspacePathFlavor(resolveBackend({ requested: deviceId }).pathFlavor);
	} catch {
		// Offline: fall back to the shape of the recorded path rather than assuming
		// POSIX, which would read a Windows path as relative.
		const inferred = parseWorkspaceDirectoryMap({
			[deviceId]: { cwd: (row.cwd ?? "").trim() },
		})[deviceId];
		return inferred?.pathFlavor ?? "posix";
	}
}

/**
 * The directory recorded for one device, including the lazy legacy fallback.
 *
 * Rows written before `workspaceDirectories` existed keep their effective
 * directory in `cwd`, owned by whichever device `defaultDeviceId` names. Older
 * remote rows never overwrote `cwd` (the column tracked the local directory), but
 * their committed `workspaceContext` carries the directory they actually ran in,
 * so that is preferred when it belongs to the same device.
 *
 * Anything else means "this device has no directory yet" — which the switch path
 * turns into an explicit prompt instead of silently reusing another device's path.
 */
function resolveDeviceDirectory(
	row: WorkspaceRow,
	deviceId: string,
): WorkspaceDirectoryEntry | null {
	const recorded = readDeviceDirectory(
		parseWorkspaceDirectoryMap(row.workspaceDirectories),
		deviceId,
	);
	if (recorded) return recorded;
	if ((row.defaultDeviceId ?? "local") !== deviceId) return null;
	// `cwd` only ever tracked the *local* directory before this map existed. A remote
	// device's legacy directory lives in its committed context, never in `cwd`.
	const cwd = (
		row.workspaceContext?.deviceId === deviceId
			? row.workspaceContext.cwd
			: deviceId === "local"
				? row.cwd
				: null
	)?.trim();
	if (!cwd) return null;
	return { cwd, pathFlavor: devicePathFlavor(row, deviceId) };
}

/** Every directory recorded for this narrator, including the legacy current one. */
function workspaceDirectoryMap(row: WorkspaceRow): WorkspaceDirectoryMap {
	const map = parseWorkspaceDirectoryMap(row.workspaceDirectories);
	const effectiveDevice = row.defaultDeviceId ?? "local";
	if (readDeviceDirectory(map, effectiveDevice)) return map;
	const fallback = resolveDeviceDirectory(row, effectiveDevice);
	return fallback ? withDeviceDirectory(map, effectiveDevice, fallback) : map;
}

/** Every device's recorded directory, for the device picker and the details panel. */
export async function getWorkspaceDirectories(id: string): Promise<WorkspaceDirectoryMap> {
	return workspaceDirectoryMap(await loadWorkspaceRow(id));
}

function directoryEntryOf(
	context: Pick<WorkspaceContext, "cwd" | "pathFlavor">,
): WorkspaceDirectoryEntry | null {
	const cwd = context.cwd?.trim();
	return cwd ? { cwd, pathFlavor: normalizeWorkspacePathFlavor(context.pathFlavor) } : null;
}

/**
 * The map after a switch: the target device's new directory, plus the one the
 * session is leaving.
 *
 * The backfill is what makes the first switch away from a device reversible: a
 * legacy row (or any session whose current directory was never written into the
 * map) would otherwise have no way back, because the map is the only source a
 * device switch restores from.
 */
function workspaceDirectoriesAfterSwitch(
	map: WorkspaceDirectoryMap | null | undefined,
	previous: Pick<WorkspaceContext, "deviceId" | "cwd" | "pathFlavor">,
	current: Pick<WorkspaceContext, "deviceId" | "cwd" | "pathFlavor">,
): WorkspaceDirectoryMap {
	let next = parseWorkspaceDirectoryMap(map);
	const target = directoryEntryOf(current);
	if (target) next = withDeviceDirectory(next, current.deviceId, target);
	const left = directoryEntryOf(previous);
	if (left && !readDeviceDirectory(next, previous.deviceId))
		next = withDeviceDirectory(next, previous.deviceId, left);
	return next;
}

function directorySwitchCapabilities(options: {
	supported: boolean;
	available?: boolean;
}): WorkspaceContext["capabilities"] {
	if (!options.supported)
		return {
			switchDirectory: false,
			reason: "Only ordinary primary narrators support directory switching",
		};
	if (options.available === false)
		return { switchDirectory: false, reason: "Remote device is unavailable; no local fallback" };
	return { switchDirectory: true };
}

/** A device must be resolvable to switch to it; staying on it is never required. */
function requireRemoteBackend(deviceId: string): ExecutionBackend {
	try {
		return resolveBackend({ requested: deviceId });
	} catch {
		throw workspaceConflict(
			`Execution device "${deviceId}" is unknown or offline; no local fallback`,
			"WORKSPACE_CONTEXT_UNSUPPORTED",
		);
	}
}

function directoryRequiredError(deviceId: string): AppError {
	return new AppError(
		`Device "${deviceId}" has no working directory yet. Choose one to switch to it.`,
		409,
		"WORKSPACE_DIRECTORY_REQUIRED",
		undefined,
		{ deviceId },
	);
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
					repositoryPath: probe.repositoryPath,
				}
			: undefined;
	if (
		!allowUnavailableCurrent &&
		probe.state !== "ready" &&
		probe.state !== "not_git" &&
		probe.state !== "git_unavailable"
	)
		throw new ValidationError(probe.reason ?? "Cannot safely resolve working directory");
	return localWorkspaceContext(canonical, revision, contextProjectId, git);
}

/** Construct from an already-authoritative probe; never re-probe to cache facts. */
export function localWorkspaceContext(
	canonical: string,
	revision: number,
	contextProjectId: string | undefined,
	git: WorkspaceContext["git"],
): WorkspaceContext {
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

/** Discovery must not overwrite a concurrently committed directory or device transition. */
export async function cacheLocalWorkspaceContext(
	id: string,
	row: Pick<
		typeof narrators.$inferSelect,
		"workspaceRevision" | "workspaceContext" | "cwd" | "defaultDeviceId"
	>,
	context: WorkspaceContext,
): Promise<boolean> {
	if (
		row.workspaceContext &&
		serializeWorkspaceContext(context) === serializeWorkspaceContext(row.workspaceContext)
	)
		return true;
	const saved = await db
		.update(narrators)
		.set({ workspaceContext: context })
		.where(
			and(
				eq(narrators.id, id),
				eq(narrators.workspaceRevision, row.workspaceRevision),
				row.workspaceContext
					? eq(narrators.workspaceContext, row.workspaceContext)
					: isNull(narrators.workspaceContext),
				row.cwd === null ? isNull(narrators.cwd) : eq(narrators.cwd, row.cwd),
				row.defaultDeviceId === null
					? isNull(narrators.defaultDeviceId)
					: eq(narrators.defaultDeviceId, row.defaultDeviceId),
			),
		)
		.returning({ id: narrators.id });
	return saved.length === 1;
}

function prepareRemoteWorkspaceContext(
	deviceId: string,
	cwd: string,
	flavor: string,
	revision: number,
	contextProjectId: string | undefined,
	options: { supported: boolean; available: boolean },
): WorkspaceContext {
	const pathFlavor = normalizeWorkspacePathFlavor(flavor);
	const paths = targetPathSemantics(pathFlavor);
	const normalizedCwd = cwd ? paths.normalize(cwd) : "";
	return {
		revision,
		deviceId,
		cwd: normalizedCwd,
		pathFlavor,
		contextProjectId,
		contextKey: createHash("sha256")
			.update(JSON.stringify([deviceId, paths.identityKey(normalizedCwd)]))
			.digest("hex"),
		capabilities: directorySwitchCapabilities(options),
	};
}

/** Build a remote target from a recorded directory, validating it in its own grammar. */
function remoteTargetFromDirectory(
	backend: ExecutionBackend,
	deviceId: string,
	entry: WorkspaceDirectoryEntry,
	previous: Pick<WorkspaceContext, "revision" | "contextProjectId">,
): WorkspaceContext {
	if (!isAbsoluteForFlavor(entry.cwd, entry.pathFlavor))
		throw new ValidationError("Remote working directory must be an absolute path");
	return prepareRemoteWorkspaceContext(
		deviceId,
		entry.cwd,
		backend.pathFlavor,
		previous.revision,
		previous.contextProjectId,
		{ supported: true, available: true },
	);
}

/**
 * The manual cwd change card. Restored after the workspace-context rewrite dropped it:
 * the details panel still promises "writes a reminder message into history", and the
 * vlist still renders `role=disp` info cards of this shape.
 *
 * Agent-origin switches skip this on purpose — that path injects
 * "Working directory changed..." as the next pass's user text instead.
 */
async function writeCwdChangeReminder(
	narratorId: string,
	previousCwd: string | null | undefined,
	cwd: string,
	userId?: string | null,
): Promise<void> {
	const { getUserLanguage } = await import("../lib/i18n");
	const locale = userId ? await getUserLanguage(userId) : "en";
	const from = previousCwd?.trim() || null;
	const reminder =
		locale === "zh-CN"
			? from
				? `工作目录已更新：${from} → ${cwd}`
				: `工作目录已设置为：${cwd}`
			: from
				? `Working directory updated: ${from} → ${cwd}`
				: `Working directory set to: ${cwd}`;
	const { narratorService } = await import("./narrator-service");
	await narratorService.persistDisplayMessage(narratorId, reminder);
}

interface WorkspaceTarget {
	deviceId: string;
	backend: ExecutionBackend;
	cwd: string;
	pathFlavor: WorkspacePathFlavor;
}

function localTarget(cwd: string): WorkspaceTarget {
	return { deviceId: "local", backend: localBackend, cwd, pathFlavor: localPathFlavor() };
}

/**
 * Deny checks for a directory a session is about to move to.
 *
 * The host-only hard denials (server data dir, home secrets, `.ssh`/… ) only make
 * sense against this machine's filesystem, so they apply to the local backend
 * alone. Every target — local or remote — then goes through the narrator's
 * compiled execution policy, scoped to that device, so a rule written for the
 * device is honoured before the switch instead of after the first tool call.
 */
async function assertTargetAllowed(narratorId: string, target: WorkspaceTarget) {
	const { backend, cwd } = target;
	if (backend.kind === "local") {
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
	}
	const policy = await executionPolicyEngine.compile(narratorId, {
		backend,
		paths: backend.paths,
		deviceClass: backend.kind === "local" ? "host" : null,
		target: {
			deviceId: target.deviceId,
			backendKind: backend.kind,
			cwd,
			lexicalPath: cwd,
			canonicalPath: cwd,
			pathFlavor: target.pathFlavor,
			runtimeGeneration: backend.runtimeGeneration,
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
	/** Metadata for directory recovery only; never use this to admit tool execution. */
	async getForDirectorySwitch(id: string): Promise<WorkspaceContext> {
		return this.get(id, { allowMissingDirectory: true });
	},
	async get(
		id: string,
		options: { allowMissingDirectory?: boolean } = {},
	): Promise<WorkspaceContext> {
		const row = await loadWorkspaceRow(id);
		const projectId = row.contextProjectId ?? undefined;
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
		const supported = supportsDirectorySwitch(row);
		if (deviceId !== "local") {
			let backend: ExecutionBackend | null = null;
			try {
				backend = resolveBackend({ requested: deviceId });
			} catch {
				/* Offline stays unsupported; never local fallback. */
			}
			const capabilities = directorySwitchCapabilities({ supported, available: Boolean(backend) });
			if (
				row.workspaceContext?.deviceId === deviceId &&
				row.workspaceContext.revision === row.workspaceRevision
			)
				return { ...row.workspaceContext, contextProjectId: projectId, capabilities };
			// The recorded directory wins over the device default: it is where this
			// session actually runs. Sessions that never recorded one (and legacy rows)
			// keep reporting the device default.
			const recorded = resolveDeviceDirectory(row, deviceId);
			return prepareRemoteWorkspaceContext(
				deviceId,
				recorded?.cwd ?? backend?.defaultCwd ?? "",
				recorded?.pathFlavor ?? normalizeWorkspacePathFlavor(backend?.pathFlavor ?? "posix"),
				row.workspaceRevision,
				projectId,
				{ supported, available: Boolean(backend) },
			);
		}
		const committed =
			row.workspaceContext?.revision === row.workspaceRevision &&
			(!row.cwd || localBackend.paths.equals(row.cwd, row.workspaceContext.cwd)) &&
			row.workspaceContext.deviceId === "local"
				? row.workspaceContext
				: null;
		const localDirectory = resolveDeviceDirectory(row, "local");
		const cwd =
			committed?.cwd ??
			localDirectory?.cwd ??
			activeNarrators.get(id)?.cwd ??
			(isFormerChapterSessionWithoutDirectory(row)
				? null
				: resolveNarratorSessionCwd(row.cwd, project?.gitPath, getHome()));
		if (!cwd) {
			if (!options.allowMissingDirectory)
				throw new AppError(
					"This legacy workspace has no directory. Choose a working directory to continue.",
					409,
					"WORKSPACE_DIRECTORY_REQUIRED",
				);
			// An unselected directory is metadata, not an executable workspace. Do not
			// resolve an empty path against process.cwd(), probe Git, or cache it.
			return {
				revision: row.workspaceRevision,
				deviceId: "local",
				cwd: "",
				pathFlavor: localBackend.paths.flavor === "windows" ? "windows" : "posix",
				contextProjectId: projectId,
				contextKey: createHash("sha256")
					.update(JSON.stringify(["local", "directory-required", id]))
					.digest("hex"),
				capabilities: {
					switchDirectory: supported,
					...(!supported
						? { reason: "Only ordinary primary narrators support directory switching" }
						: {}),
				},
			};
		}
		let context = committed
			? { ...committed, contextProjectId: projectId }
			: await prepareLocalWorkspaceContext(cwd, row.workspaceRevision, projectId, true);
		if (committed && !committed.git?.repositoryPath) {
			const discovered = await prepareLocalWorkspaceContext(
				cwd,
				row.workspaceRevision,
				projectId,
				true,
			);
			// A missing checkout must retain its last known identity, not erase it.
			if (discovered.git) context = discovered;
		}
		if (context.git && !(await cacheLocalWorkspaceContext(id, row, context)))
			return this.get(id, options);
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
					// A device switch restores that device's own directory. A device with no
					// recorded directory must be configured first — switching it anyway would
					// either run tools in the wrong place or force a fallback to local.
					const entry = resolveDeviceDirectory(row, targetDeviceId);
					if (!entry) throw directoryRequiredError(targetDeviceId);
					const supported = supportsDirectorySwitch(row);
					if (targetDeviceId !== "local") {
						const backend = requireRemoteBackend(targetDeviceId);
						return {
							...remoteTargetFromDirectory(backend, targetDeviceId, entry, previous),
							capabilities: directorySwitchCapabilities({ supported, available: true }),
						};
					}
					const target = await prepareLocalWorkspaceContext(
						entry.cwd,
						previous.revision,
						previous.contextProjectId,
						true,
					);
					return {
						...target,
						capabilities: directorySwitchCapabilities({ supported }),
					};
				},
				admit: (action) => withNarratorMutationAdmission(id, action, { failIfBusy: true }),
				commit: async (old, current) => {
					await options.validateDevice?.();
					const row = await loadWorkspaceRow(id);
					if (targetDeviceId !== "local") {
						// The device's recorded directory is the authority we prepared from; a
						// concurrent change must win instead of being silently overwritten.
						const entry = resolveDeviceDirectory(row, targetDeviceId);
						const paths = targetPathSemantics(normalizeWorkspacePathFlavor(current.pathFlavor));
						if (!entry || !paths.equals(entry.cwd, current.cwd))
							throw workspaceConflict("Device working directory changed");
					}
					return withWorkspaceAdmission(
						{
							deviceId: current.deviceId,
							path: current.cwd,
							repositoryKey: current.git?.repositoryKey,
						},
						async () => {
							const rows = await db
								.update(narrators)
								.set({
									cwd: current.cwd,
									defaultDeviceId: deviceId,
									workspaceRevision: current.revision,
									workspaceContext: current,
									workspaceDirectories: workspaceDirectoriesAfterSwitch(
										row.workspaceDirectories,
										old,
										current,
									),
									updatedAt: new Date().toISOString(),
								})
								.where(and(eq(narrators.id, id), eq(narrators.workspaceRevision, old.revision)))
								.returning({ id: narrators.id });
							return rows.length === 1;
						},
					);
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
				},
				pause: () => {
					const active = activeNarrators.get(id);
					if (active) {
						active._workspaceInstallFailed = true;
						active._workspacePassInvalidated = true;
						active.abortController.abort("Workspace installation failed");
					}
				},
				publish: ({ previous: old, current }) => {
					broadcastToNarrator(id, {
						type: "workspace_context_changed",
						narratorId: id,
						previous: old,
						current,
					});
					void syncNarratorProjectLinksSafely(id);
				},
			},
		);
	},
	async switch(
		id: string,
		request: SwitchWorkingDirectoryRequest,
		options: WorkspaceSwitchOptions,
	) {
		const result = await transitionWorkspaceContext(request, {
			read: () => this.getForDirectorySwitch(id),
			checkAdmission: () => assertSwitchAdmission(id, options),
			prepare: async (previous, input) => {
				const row = await loadWorkspaceRow(id);
				if (!supportsDirectorySwitch(row))
					throw workspaceConflict(
						"Specialized narrator directory switching is unsupported",
						"WORKSPACE_CONTEXT_UNSUPPORTED",
					);
				if (row.status === "working" || row.status === "waiting") {
					if (options.origin !== "agent")
						throw workspaceConflict("Narrator is busy", "WORKSPACE_CONTEXT_BUSY");
				}
				const targetDeviceId = input.target.deviceId?.trim() || "local";
				if (targetDeviceId === "local") {
					// OAuth narrators keep their no-local-execution ceiling; remote targets are
					// bounded by the device allowlist the caller validates instead.
					if (await resolveOAuthNarratorRuntimePolicy(id))
						throw workspaceConflict(
							"OAuth directory switching is unsupported",
							"WORKSPACE_CONTEXT_UNSUPPORTED",
						);
					const target = await prepareLocalWorkspaceContext(
						input.target.cwd,
						previous.revision,
						previous.contextProjectId,
					);
					await assertTargetAllowed(id, localTarget(target.cwd));
					return target;
				}
				// Remote target: the path is validated by the device itself, in that
				// device's grammar, so a Windows path is never read with POSIX rules.
				const backend = requireRemoteBackend(targetDeviceId);
				const pathFlavor = normalizeWorkspacePathFlavor(backend.pathFlavor);
				if (!isAbsoluteForFlavor(input.target.cwd, pathFlavor))
					throw new ValidationError("cwd must be an absolute path");
				const cwd = backend.paths.normalize(input.target.cwd);
				const statResult = await backend.statFile(cwd);
				if (!statResult?.isDirectory)
					throw new ValidationError("Working directory does not exist or is not accessible");
				await assertTargetAllowed(id, { deviceId: targetDeviceId, backend, cwd, pathFlavor });
				return prepareRemoteWorkspaceContext(
					targetDeviceId,
					cwd,
					pathFlavor,
					previous.revision,
					previous.contextProjectId,
					{ supported: true, available: true },
				);
			},
			admit: (action) => withNarratorMutationAdmission(id, action, { failIfBusy: true }),
			commit: async (previous, current) => {
				await options.validateDevice?.();
				const row = await loadWorkspaceRow(id);
				// Admission may have waited behind a Git mutation. Revalidate canonical
				// target and its deny rules before CAS, never install stale prepared identity.
				if (current.deviceId === "local") {
					const target = await prepareLocalWorkspaceContext(
						current.cwd,
						current.revision,
						current.contextProjectId,
					);
					if (target.contextKey !== current.contextKey)
						throw workspaceConflict("Target directory identity changed");
					await assertTargetAllowed(id, localTarget(current.cwd));
				} else {
					// Re-derive the remote identity: a directory whose grammar or device
					// changed underneath us must not be committed as this revision.
					const rebuilt = prepareRemoteWorkspaceContext(
						current.deviceId,
						current.cwd,
						current.pathFlavor,
						current.revision,
						current.contextProjectId,
						{ supported: true, available: true },
					);
					if (rebuilt.contextKey !== current.contextKey)
						throw workspaceConflict("Target directory identity changed");
				}
				return withWorkspaceAdmission(
					{
						deviceId: current.deviceId,
						path: current.cwd,
						repositoryKey: current.git?.repositoryKey,
					},
					async () => {
						const rows = await db
							.update(narrators)
							.set({
								cwd: current.cwd,
								defaultDeviceId: current.deviceId === "local" ? null : current.deviceId,
								workspaceRevision: current.revision,
								workspaceContext: current,
								workspaceDirectories: workspaceDirectoriesAfterSwitch(
									row.workspaceDirectories,
									previous,
									current,
								),
							})
							.where(and(eq(narrators.id, id), eq(narrators.workspaceRevision, previous.revision)))
							.returning({ id: narrators.id });
						return rows.length === 1;
					},
				);
			},
			install: async (current) => {
				const active = activeNarrators.get(id);
				executionPolicyEngine.invalidate(id);
				if (!active?.alive) return;
				// Invalidate before awaiting preparation of skills. Old config keeps its frozen cwd.
				active._workspacePassInvalidated = options.origin === "agent";
				active._defaultDeviceId = current.deviceId === "local" ? null : current.deviceId;
				active._lastTreeHash = undefined;
				active._bashBeforeStatus?.clear();
				if (active._gitTrackTimer) clearTimeout(active._gitTrackTimer);
				active._gitTrackTimer = undefined;
				if (current.deviceId === "local") {
					const { updateActiveNarratorCwdAndSkillContext } = await import("./narrator-session");
					await updateActiveNarratorCwdAndSkillContext(id, current.cwd);
				}
				// A remote directory is not a path on this server: keep the session's own
				// local directory as the fallback base so explicit local tool calls still
				// resolve, and let the frozen workspace context bind the remote one.
				active._workspaceContext = current;
				active._workspaceInstallFailed = false;
			},
			pause: () => {
				const active = activeNarrators.get(id);
				if (active) {
					active._workspaceInstallFailed = true;
					active._workspacePassInvalidated = true;
					active.abortController.abort("Workspace installation failed");
				}
			},
			publish: ({ previous, current }) => {
				broadcastToNarrator(id, {
					type: "workspace_context_changed",
					narratorId: id,
					previous,
					current,
				});
				// The directory may now belong to another project.
				void syncNarratorProjectLinksSafely(id);
			},
		});
		// Manual HTTP switch: the UI still promises a history reminder card. Agent-origin
		// switches skip this — the orchestrator injects the pass-continuation text instead.
		if (result.changed && options.origin === "http") {
			try {
				await writeCwdChangeReminder(id, result.previous.cwd, result.current.cwd, options.userId);
			} catch (error) {
				logger.warn("Failed to persist working-directory change reminder", {
					narratorId: id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return result;
	},
};
