import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import type { GitWorkspace, GitWorkspaceState } from "@shared/git-workspace";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { narrators, projects } from "../db/schema";
import { type ReadQueryOptions, readQueryFirst } from "../db/worker-read";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import { localBackend, resolveBackend } from "../lib/agent/execution/registry";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { getHome } from "../lib/platform";
import { normalizePathForComparison } from "../lib/platform-path";
import { safeSpawn } from "../lib/spawn";
import { gitDiscoveryCache } from "./git-discovery-cache";
import { isFormerChapterSessionWithoutDirectory, resolveNarratorSessionCwd } from "./narrator-cwd";
import { resolveNarratorProjectId } from "./narrator-project";
import { activeNarrators } from "./narrator-session-state";
import { createRemoteGitService, supportsRemoteGitWorkspace } from "./remote-git-service";

/** Legacy path consumers retain their local path key; management uses device/root keys. */
export interface ResolvedWorkspace {
	workspacePath: string;
	rawPath: string;
	projectId?: string;
}

export function normalizeWorkspacePath(path: string): string {
	return normalizePathForComparison(path);
}

export const GIT_PROBE_TIMEOUT_MS = 10_000;
export const GIT_PROBE_MAX_BYTES = 32 * 1024;

export interface GitProbe {
	state: GitWorkspaceState;
	rootPath?: string;
	repositoryPath?: string;
	reason?: string;
	branch?: string | null;
}

/** Real Git probing handles unborn repositories, linked worktrees, submodules and bare repos. */
export async function probeLocalGitWorkspace(cwd: string, signal?: AbortSignal): Promise<GitProbe> {
	try {
		if (!(await stat(cwd)).isDirectory()) return { state: "missing_directory" };
	} catch (error) {
		return {
			state:
				(error as NodeJS.ErrnoException).code === "EACCES" ? "access_denied" : "missing_directory",
		};
	}
	try {
		const result = await safeSpawn({
			cmd: [
				"git",
				"--no-optional-locks",
				"-C",
				cwd,
				"rev-parse",
				"--is-inside-work-tree",
				"--is-bare-repository",
				"--path-format=absolute",
				"--show-toplevel",
				"--git-common-dir",
			],
			// Classify Git failures independently of the host's locale.
			env: { ...process.env, LC_ALL: "C", LANG: "C" },
			timeout: GIT_PROBE_TIMEOUT_MS,
			maxOutputBytes: GIT_PROBE_MAX_BYTES,
			signal,
		});
		signal?.throwIfAborted();
		if (result.stdoutTruncated || result.stderrTruncated)
			return { state: "unsupported", reason: "Git workspace probe exceeded its output budget" };
		const [inside, bare, root, repository] = result.stdout.trim().split("\n");
		if (bare === "true")
			return { state: "unsupported", reason: "Bare repositories have no working tree" };
		if (result.exitCode !== 0 || inside !== "true" || !root || !repository) {
			if (/dubious ownership|permission denied|access denied/i.test(result.stderr))
				return { state: "access_denied", reason: "Git refused access to this working tree" };
			return /not a git repository/i.test(result.stderr)
				? { state: "not_git", reason: "Directory is not a Git working tree" }
				: { state: "unsupported", reason: "Git workspace probe did not complete" };
		}
		return {
			state: "ready",
			rootPath: await realpath(root),
			repositoryPath: await realpath(repository),
		};
	} catch (error) {
		signal?.throwIfAborted();
		return {
			state: /ENOENT|not found/i.test(String(error)) ? "git_unavailable" : "unsupported",
			reason: "Git workspace probe failed",
		};
	}
}

export function gitWorkspaceIdentity(
	backend: Pick<ExecutionBackend, "deviceId" | "paths">,
	root: string,
): string {
	return createHash("sha256")
		.update(JSON.stringify([backend.deviceId, backend.paths.identityKey(root)]))
		.digest("hex");
}

export interface GitWorkspaceTarget {
	workspace: GitWorkspace;
	backend?: ExecutionBackend;
	/** Frozen when discovery was resolved; a live backend object's generation may change. */
	discoveryRuntimeGeneration?: number;
	repositoryPath?: string;
	/** Associated project is for authorization even when cwd is elsewhere. */
	contextProjectId?: string;
	/** The local session cwd is NOT used as a remote cwd fallback. */
	configuredCwd?: string;
	/** Request-bound authorization refresh, never serialized to clients. */
	beforeWrite?: () => Promise<void>;
	/** Request-bound policy check for backend-resolved complete file selections. */
	authorizeFilePaths?: (files: readonly string[], need: "read" | "write") => Promise<void>;
	/** Request-local, read-only recovery. Never enables ordinary Git operations. */
	worktreeListOnly?: boolean;
}

interface MetadataDiscoveryBinding {
	profile: string;
	probe: GitProbe;
	evidence: string;
}
// Discovery facts only. Every caller still reloads its narrator, device, ACL and policy.
const metadataDiscoveryBindings = new Map<string, MetadataDiscoveryBinding>();
const METADATA_DISCOVERY_MAX = 128;
const METADATA_POINTER_MAX_BYTES = 4096;
function metadataWorkspaceChanged(): never {
	throw new AppError(
		"Git workspace identity changed; resolve the workspace before retrying",
		409,
		"GIT_WORKSPACE_CHANGED",
	);
}

/** No Git commands: physical directories and bounded gitfile/commondir pointers only. */
async function metadataDiscoveryEvidence(
	target: GitWorkspaceTarget,
	signal?: AbortSignal,
): Promise<string> {
	const { backend, workspace, repositoryPath } = target;
	if (!backend || backend.kind !== "local" || !workspace.rootPath || !repositoryPath)
		return metadataWorkspaceChanged();
	const paths = backend.paths;
	const generation = target.discoveryRuntimeGeneration ?? backend.runtimeGeneration;
	const evidence: string[] = [];
	const info = async (path: string) => {
		signal?.throwIfAborted();
		if (path.length > 4096 || !paths.isAbsolute(path)) return metadataWorkspaceChanged();
		try {
			const canonical = await realpath(path);
			const value = await stat(canonical, { bigint: true });
			if (value.ino === 0n) return metadataWorkspaceChanged();
			evidence.push(
				JSON.stringify([
					paths.identityKey(path),
					paths.identityKey(canonical),
					String(value.dev),
					String(value.ino),
				]),
			);
			return {
				isDirectory: value.isDirectory(),
				isFile: value.isFile(),
				size: Number(value.size),
				resolvedPath: canonical,
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				evidence.push(`${paths.identityKey(path)}:missing`);
				return null;
			}
			throw error;
		}
	};
	const directory = async (path: string) => {
		const value = await info(path);
		if (!value?.isDirectory || !value.resolvedPath) return metadataWorkspaceChanged();
		return value.resolvedPath;
	};
	const pointer = async (path: string, value: NonNullable<Awaited<ReturnType<typeof info>>>) => {
		if (
			!value.isFile ||
			value.size > METADATA_POINTER_MAX_BYTES ||
			value.size <= 0 ||
			!value.resolvedPath
		)
			return metadataWorkspaceChanged();
		let bytes: Uint8Array;
		const link = await lstat(path);
		if (!link.isFile() || link.isSymbolicLink()) return metadataWorkspaceChanged();
		const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const before = await file.stat({ bigint: true });
			if (!before.isFile() || before.size > BigInt(METADATA_POINTER_MAX_BYTES))
				return metadataWorkspaceChanged();
			const buffer = Buffer.alloc(METADATA_POINTER_MAX_BYTES + 1);
			let length = 0;
			while (length < buffer.length) {
				signal?.throwIfAborted();
				const part = await file.read(buffer, length, buffer.length - length, length);
				if (!part.bytesRead) break;
				length += part.bytesRead;
			}
			const after = await file.stat({ bigint: true });
			const named = await stat(path, { bigint: true });
			if (
				length > METADATA_POINTER_MAX_BYTES ||
				BigInt(length) !== before.size ||
				after.size !== before.size ||
				after.mtimeNs !== before.mtimeNs ||
				after.ctimeNs !== before.ctimeNs ||
				named.dev !== before.dev ||
				named.ino !== before.ino
			)
				return metadataWorkspaceChanged();
			bytes = buffer.subarray(0, length);
		} finally {
			await file.close();
		}
		evidence.push(createHash("sha256").update(bytes).digest("hex"));
		const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
			.decode(bytes)
			.replace(/\r?\n$/, "");
		if (!text || /[\0\r\n]/.test(text)) return metadataWorkspaceChanged();
		return text;
	};
	const cwd = await directory(workspace.cwd);
	const root = await directory(workspace.rootPath);
	if (!paths.equals(root, workspace.rootPath) || !paths.contains(root, cwd))
		return metadataWorkspaceChanged();
	// Adding a nearer nested repository changes discovery even when the old root survives.
	let ancestor = cwd;
	for (let depth = 0; !paths.equals(ancestor, root); depth++) {
		if (depth >= 64 || (await info(paths.resolve(ancestor, ".git"))))
			return metadataWorkspaceChanged();
		const parent = paths.dirname(ancestor);
		if (paths.equals(parent, ancestor)) return metadataWorkspaceChanged();
		ancestor = parent;
	}
	const marker = paths.resolve(root, ".git");
	const markerInfo = await info(marker);
	if (!markerInfo) return metadataWorkspaceChanged();
	let gitDir: string;
	if (markerInfo.isDirectory) gitDir = await directory(marker);
	else {
		const text = await pointer(marker, markerInfo);
		if (!text.startsWith("gitdir: ")) return metadataWorkspaceChanged();
		gitDir = await directory(paths.resolve(root, text.slice(8)));
	}
	const backlinkPath = paths.resolve(gitDir, "gitdir");
	const backlinkInfo = await info(backlinkPath);
	if (backlinkInfo) {
		const linkedMarker = await info(
			paths.resolve(gitDir, await pointer(backlinkPath, backlinkInfo)),
		);
		if (
			!linkedMarker?.resolvedPath ||
			!markerInfo.resolvedPath ||
			!paths.equals(linkedMarker.resolvedPath, markerInfo.resolvedPath)
		)
			return metadataWorkspaceChanged();
	}
	const commonMarker = paths.resolve(gitDir, "commondir");
	const commonInfo = await info(commonMarker);
	const common = commonInfo
		? await directory(paths.resolve(gitDir, await pointer(commonMarker, commonInfo)))
		: gitDir;
	const repository = await directory(repositoryPath);
	if (!paths.equals(repository, repositoryPath) || !paths.equals(common, repository))
		return metadataWorkspaceChanged();
	signal?.throwIfAborted();
	if (backend.runtimeGeneration !== generation) return metadataWorkspaceChanged();
	return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}

export async function resolveNarratorGitTarget(
	narratorId: string,
	signal?: AbortSignal,
	beforeResolve?: (target: GitWorkspaceTarget) => Promise<void>,
	beforeProbe?: (target: GitWorkspaceTarget) => Promise<void>,
	/** Display discovery only; authoritative reads/writes keep the uncached probe. */
	cachedDiscovery = false,
	recoverWorktreeList = false,
	/** File-only discovery reuse; the caller must still perform every authorization gate. */
	metadataDiscovery: boolean | GitWorkspaceTarget = false,
	readOptions?: ReadQueryOptions,
	/** Trusted row loaded by the same authorization, never a cached verdict. */
	loadedNarrator?: Pick<
		typeof narrators.$inferSelect,
		| "id"
		| "cwd"
		| "workspaceRevision"
		| "workspaceContext"
		| "contextProjectId"
		| "defaultDeviceId"
		| "traits"
	>,
): Promise<GitWorkspaceTarget> {
	signal ??= readOptions?.signal;
	signal?.throwIfAborted();
	const narrator =
		loadedNarrator?.id === narratorId
			? loadedNarrator
			: await readQueryFirst(
					db.query.narrators.findMany({
						limit: 1,
						where: eq(narrators.id, narratorId),
						columns: {
							id: true,
							cwd: true,
							workspaceRevision: true,
							workspaceContext: true,
							contextProjectId: true,
							defaultDeviceId: true,
							traits: true,
						},
					}),
					{ ...readOptions, executionPolicy: "worker-required", maxRows: 1, signal },
				);
	if (!narrator) throw new NotFoundError("Narrator", narratorId);
	const projectId = (await resolveNarratorProjectId(narrator, readOptions)) ?? undefined;
	signal?.throwIfAborted();
	const project = projectId
		? await readQueryFirst(
				db.query.projects.findMany({
					limit: 1,
					where: eq(projects.id, projectId),
					columns: { gitPath: true },
				}),
				{ ...readOptions, executionPolicy: "worker-required", maxRows: 1, signal },
			)
		: undefined;
	if (projectId && !project) throw new NotFoundError("Project", projectId);
	const active = activeNarrators.get(narratorId);
	const committedContext =
		narrator.workspaceContext?.revision === narrator.workspaceRevision &&
		(!narrator.cwd || localBackend.paths.equals(narrator.cwd, narrator.workspaceContext.cwd)) &&
		narrator.workspaceContext.deviceId === "local"
			? narrator.workspaceContext
			: null;
	const localCwd =
		committedContext?.cwd ??
		active?.cwd ??
		(isFormerChapterSessionWithoutDirectory(narrator)
			? ""
			: resolveNarratorSessionCwd(narrator.cwd, project?.gitPath, getHome()));
	const deviceId = active
		? (active._defaultDeviceId ?? "local")
		: (narrator.defaultDeviceId ?? "local");
	const workspace: GitWorkspace = {
		narratorId,
		projectId,
		deviceId,
		cwd: deviceId === "local" ? localCwd : "",
		rootPath: null,
		workspaceKey: null,
		repositoryKey: null,
		state: "device_offline",
		capabilities: { read: false, write: false },
	};
	// No backend resolution, device RPC or local Git probe is allowed before this access gate.
	await beforeResolve?.({ workspace, contextProjectId: projectId, configuredCwd: localCwd });
	let backend: ExecutionBackend;
	try {
		backend = resolveBackend({ requested: deviceId });
	} catch {
		return { workspace, contextProjectId: projectId, configuredCwd: localCwd };
	}
	// Match toolBaseCwd: remote tools use the executor's cwd, never the host-side
	// narrator.cwd. Local tools use the live session cwd, then the persisted override.
	workspace.cwd = backend.kind === "remote" ? (backend.defaultCwd ?? "") : localCwd;
	const target: GitWorkspaceTarget = {
		workspace,
		backend,
		discoveryRuntimeGeneration: backend.runtimeGeneration,
		contextProjectId: projectId,
		configuredCwd: localCwd,
	};
	if (!workspace.cwd || !backend.paths.isAbsolute(workspace.cwd)) {
		workspace.state = "missing_directory";
		workspace.reason = "Execution device has no absolute working directory";
		return target;
	}
	// The cwd itself must pass execution policy before Git reads any metadata from it.
	await beforeProbe?.(target);
	if (backend.kind !== "local") metadataDiscovery = false;
	if (backend.kind === "remote" && !supportsRemoteGitWorkspace(backend)) {
		workspace.state = "unsupported";
		workspace.reason = "Upgrade the remote executor to support Git workspace management";
		return target;
	}
	const metadataProfile = JSON.stringify([
		narrator.workspaceRevision,
		projectId,
		localCwd,
		workspace.cwd,
		deviceId,
		backend.kind,
		backend.runtimeGeneration,
		backend.pathFlavor,
	]);
	const binding = metadataDiscoveryBindings.get(narratorId);
	if (
		metadataDiscovery &&
		!binding &&
		(typeof metadataDiscovery === "object" || committedContext?.git?.repositoryPath)
	)
		return metadataWorkspaceChanged();
	let probe: GitProbe;
	try {
		if (metadataDiscovery && binding) {
			if (binding.profile !== metadataProfile) return metadataWorkspaceChanged();
			if (
				typeof metadataDiscovery === "object" &&
				((metadataDiscovery.discoveryRuntimeGeneration ??
					metadataDiscovery.backend?.runtimeGeneration) !== backend.runtimeGeneration ||
					metadataDiscovery.workspace.deviceId !== deviceId ||
					!backend.paths.equals(metadataDiscovery.workspace.cwd, workspace.cwd) ||
					!metadataDiscovery.workspace.rootPath ||
					!binding.probe.rootPath ||
					!backend.paths.equals(metadataDiscovery.workspace.rootPath, binding.probe.rootPath) ||
					!metadataDiscovery.repositoryPath ||
					!binding.probe.repositoryPath ||
					!backend.paths.equals(metadataDiscovery.repositoryPath, binding.probe.repositoryPath))
			)
				return metadataWorkspaceChanged();
			let evidence: string;
			try {
				evidence = await metadataDiscoveryEvidence(
					{
						...target,
						workspace: { ...workspace, rootPath: binding.probe.rootPath ?? null },
						repositoryPath: binding.probe.repositoryPath,
					},
					signal,
				);
			} catch {
				signal?.throwIfAborted();
				return metadataWorkspaceChanged();
			}
			if (evidence !== binding.evidence) return metadataWorkspaceChanged();
			probe = { ...binding.probe };
		} else {
			if (metadataDiscovery && metadataDiscoveryBindings.size >= METADATA_DISCOVERY_MAX)
				return metadataWorkspaceChanged();
			const discover = async (probeSignal?: AbortSignal): Promise<GitProbe> => {
				const result =
					backend.kind === "local"
						? await probeLocalGitWorkspace(workspace.cwd, probeSignal)
						: await createRemoteGitService(backend, probeSignal).probe(
								workspace.cwd,
								probeSignal,
								cachedDiscovery
									? { maxBytes: GIT_PROBE_MAX_BYTES, timeoutMs: GIT_PROBE_TIMEOUT_MS }
									: {},
							);
				const facts: GitProbe = { ...result, state: result.state ?? "unsupported" };
				if (facts.state === "ready" && (!facts.rootPath || !facts.repositoryPath))
					return { state: "unsupported", reason: "Incomplete Git workspace discovery" };
				if (cachedDiscovery && facts.state === "ready" && backend.kind === "local") {
					const head = await safeSpawn({
						cmd: [
							"git",
							"--no-optional-locks",
							"-C",
							workspace.cwd,
							"symbolic-ref",
							"--quiet",
							"--short",
							"HEAD",
						],
						timeout: GIT_PROBE_TIMEOUT_MS,
						maxOutputBytes: GIT_PROBE_MAX_BYTES,
						signal: probeSignal,
					});
					facts.branch = !head.stdoutTruncated && head.exitCode === 0 ? head.stdout.trim() : null;
				}
				probeSignal?.throwIfAborted();
				return facts;
			};
			probe = cachedDiscovery
				? await gitDiscoveryCache.get(
						backend.deviceId,
						backend.runtimeGeneration,
						backend.paths.identityKey(workspace.cwd),
						() => discover(AbortSignal.timeout(GIT_PROBE_TIMEOUT_MS)),
						signal,
					)
				: await discover(signal);
		}
	} catch (error) {
		signal?.throwIfAborted();
		if (metadataDiscovery && error instanceof AppError && error.code === "GIT_WORKSPACE_CHANGED")
			throw error;
		workspace.state = /offline|connection|unavailable|disconnect/i.test(String(error))
			? "device_offline"
			: /denied|forbidden|path.*rule|outside/i.test(String(error))
				? "access_denied"
				: "unsupported";
		workspace.reason = "Execution device could not resolve the Git working tree";
		return target;
	}
	workspace.state = probe.state ?? "unsupported";
	workspace.reason = probe.reason;
	if (cachedDiscovery) workspace.branch = probe.branch ?? null;
	if (probe.state === "missing_directory" && recoverWorktreeList && backend.kind === "local") {
		const cached = committedContext?.git;
		if (
			!cached ||
			!backend.paths.equals(committedContext.cwd, workspace.cwd) ||
			gitWorkspaceIdentity(backend, cached.rootPath) !== cached.workspaceKey
		)
			return target;
		// Only persisted evidence or an explicitly associated project root is a candidate.
		const candidate = cached.repositoryPath ?? project?.gitPath ?? cached.rootPath;
		if (!candidate || !backend.paths.isAbsolute(candidate)) return target;
		const recovery = { ...target, workspace: { ...workspace, cwd: candidate } };
		await beforeProbe?.(recovery);
		let common: string | undefined;
		if (cached.repositoryPath) {
			const canonical = await realpath(candidate).catch(() => null);
			if (!canonical || !backend.paths.equals(canonical, candidate)) return target;
			const result = await safeSpawn({
				cmd: [
					"git",
					"--no-optional-locks",
					`--git-dir=${canonical}`,
					"rev-parse",
					"--path-format=absolute",
					"--git-common-dir",
				],
				timeout: GIT_PROBE_TIMEOUT_MS,
				maxOutputBytes: GIT_PROBE_MAX_BYTES,
				signal,
				env: {
					...process.env,
					GIT_DIR: undefined,
					GIT_COMMON_DIR: undefined,
					GIT_WORK_TREE: undefined,
				},
			});
			if (result.exitCode || result.stdoutTruncated || result.stderrTruncated) return target;
			common = await realpath(result.stdout.trim()).catch(() => undefined);
		} else {
			const recovered = await probeLocalGitWorkspace(candidate, signal);
			if (recovered.state === "ready") common = recovered.repositoryPath;
		}
		if (!common || gitWorkspaceIdentity(backend, common) !== cached.repositoryKey) return target;
		target.repositoryPath = common;
		workspace.rootPath = cached.rootPath;
		workspace.workspaceKey = cached.workspaceKey;
		workspace.repositoryKey = cached.repositoryKey;
		target.worktreeListOnly = true;
		return target;
	}
	if (probe.state !== "ready" || !probe.rootPath || !probe.repositoryPath) return target;
	workspace.rootPath = probe.rootPath;
	target.repositoryPath = probe.repositoryPath;
	workspace.workspaceKey = gitWorkspaceIdentity(backend, probe.rootPath);
	workspace.repositoryKey = gitWorkspaceIdentity(backend, probe.repositoryPath);
	if (backend.kind === "local" && (!cachedDiscovery || !committedContext?.git?.repositoryPath)) {
		const { cacheLocalWorkspaceContext, localWorkspaceContext } = await import(
			"./workspace-context-service"
		);
		await cacheLocalWorkspaceContext(
			narratorId,
			narrator,
			localWorkspaceContext(workspace.cwd, narrator.workspaceRevision, projectId, {
				rootPath: probe.rootPath,
				repositoryPath: probe.repositoryPath,
				workspaceKey: workspace.workspaceKey,
				repositoryKey: workspace.repositoryKey,
			}),
		);
	}
	if (backend.kind === "local" && (!metadataDiscovery || !binding)) {
		try {
			const evidence = await metadataDiscoveryEvidence(target, signal);
			if (
				!metadataDiscoveryBindings.has(narratorId) &&
				metadataDiscoveryBindings.size >= METADATA_DISCOVERY_MAX
			) {
				// Keep existing bindings instead of silently rediscovering an evicted
				// target later. Ordinary Git remains usable at capacity.
				if (metadataDiscovery) return metadataWorkspaceChanged();
				return target;
			}
			metadataDiscoveryBindings.set(narratorId, {
				profile: metadataProfile,
				probe: { ...probe },
				evidence,
			});
		} catch {
			signal?.throwIfAborted();
			// Retain stale evidence as a refusal boundary; a later metadata call must
			// not turn a failed identity refresh into an implicit discovery fallback.
			if (metadataDiscovery) return metadataWorkspaceChanged();
		}
	}
	return target;
}

export async function resolveWorkspaceFromNarrator(
	narratorId: string,
): Promise<ResolvedWorkspace | null> {
	const { workspace } = await resolveNarratorGitTarget(narratorId);
	if (workspace.state !== "ready" || !workspace.rootPath || !workspace.workspaceKey) return null;
	return {
		rawPath: workspace.rootPath,
		workspacePath:
			workspace.deviceId === "local"
				? normalizeWorkspacePath(workspace.rootPath)
				: workspace.workspaceKey,
		projectId: workspace.projectId,
	};
}

export function assertGitWorkspaceKey(workspace: GitWorkspace, expected: unknown): void {
	if (typeof expected !== "string" || !expected || expected.length > 256)
		throw new ValidationError("workspaceKey is required");
	if (workspace.workspaceKey !== expected)
		throw new AppError(
			"Git workspace changed; refresh before retrying",
			409,
			"GIT_WORKSPACE_CHANGED",
		);
}

export function resolveWorkspaceFromPath(rawPath: string): ResolvedWorkspace {
	return { workspacePath: normalizeWorkspacePath(rawPath), rawPath };
}
