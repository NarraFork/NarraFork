import { realpath } from "node:fs/promises";
import type { FileReferenceSourceOrigin } from "@shared/file-reference";
import type { WorkspaceContext } from "@shared/workspace-context";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { narrators, projects, remoteDevices, userPreferences, users } from "../db/schema";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import { resolveBackend } from "../lib/agent/execution/registry";
import type { AgentConfig, ToolContext, ToolExecutionTarget } from "../lib/agent/types";
import { AppError } from "../lib/errors";
import { isSecretPlatformPath, isSecretUserPath } from "../lib/fs-secret-paths";
import { getDisabledToolSet } from "../lib/narrator-custom-traits";
import { isPermissionMode } from "../lib/permission-modes";
import { createWorkspaceFileAccess, type WorkspaceFileAccess } from "../lib/plan-file-path";
import { getHome } from "../lib/platform";
import { narraforkDir } from "../lib/settings";
import type { WorkspaceArtifactOrigin, WorkspaceAttachmentAccess } from "../lib/uploads";
import { isRuntimeToolAllowed } from "./agent-runtime/policy";
import { isDeviceOnline } from "./device-connection-service";
import { isDeviceAuthorized } from "./device-service";
import { executionPolicyEngine } from "./execution-policy/engine";
import type { ExecutionDeviceClass, ExecutionTargetContext } from "./execution-policy/types";
import { integrationResourceBindingService } from "./integration-resource-binding-service";
import { assertNarratorAccess, NARRATOR_ACL_COLUMNS } from "./narrator-acl";
import { resolveOAuthNarratorRuntimePolicy } from "./oauth-narrator-runtime-policy";
import { loadProjectForAccess } from "./project-acl";
import { resolveEffectiveTraits, resolveNarratorProjectId } from "./trait-layer-service";
import { createNarratorWorkspaceFileAccess } from "./workspace-file-access";

/** Production runners share this actor-bound configuration, including manual Bash/recovery. */
export async function createDeviceWorkspaceConfig(
	narratorId: string,
	options: { userId?: string | null; signal: AbortSignal },
): Promise<
	Pick<
		AgentConfig,
		| "resolveDeviceWorkspace"
		| "assertDeviceWorkspaceCurrent"
		| "assertDeviceWorkspaceCurrentSync"
		| "createDeviceWorkspaceFileAccess"
		| "assertEndpointAuthorized"
	>
> {
	// Freeze before even module loading yields; never borrow the next turn's actor/signal.
	const userId = options.userId ?? null;
	const { signal } = options;
	const { narratorDeviceWorkspaceService } = await import("./narrator-device-workspace-service");
	const assertCurrent = async (workspace: WorkspaceContext) => {
		signal.throwIfAborted();
		await narratorDeviceWorkspaceService.assertCurrent(narratorId, workspace, { userId });
		signal.throwIfAborted();
	};
	return {
		async assertEndpointAuthorized(target) {
			signal.throwIfAborted();
			const ticket = await narratorDeviceWorkspaceService.assertEndpointDeviceCurrent(
				narratorId,
				target.deviceId,
				{
					userId,
					contextProjectId: target.workspaceContext?.contextProjectId,
				},
			);
			signal.throwIfAborted();
			return {
				assertStillCurrent() {
					signal.throwIfAborted();
					ticket.assertStillCurrent();
				},
			};
		},
		async resolveDeviceWorkspace(deviceId) {
			signal.throwIfAborted();
			const workspace = await narratorDeviceWorkspaceService.resolve(narratorId, deviceId, {
				userId,
			});
			signal.throwIfAborted();
			return workspace ? Object.freeze(structuredClone(workspace)) : null;
		},
		assertDeviceWorkspaceCurrent: assertCurrent,
		assertDeviceWorkspaceCurrentSync(workspace) {
			signal.throwIfAborted();
			narratorDeviceWorkspaceService.assertCurrentSync(narratorId, workspace, { userId });
		},
		createDeviceWorkspaceFileAccess(workspace, backend) {
			return createNarratorWorkspaceFileAccess(narratorId, workspace, {
				userId,
				signal,
				backend,
				authorizationGuard: () => assertCurrent(workspace),
			});
		},
	};
}

export type ApprovedWorkspaceReadGuard = (
	canonicalPath: string,
	backend: ExecutionBackend,
	signal?: AbortSignal,
) => Promise<boolean | undefined>;

function denied(message: string): AppError {
	return new AppError(message, 403, "WORKSPACE_ARTIFACT_ACCESS_DENIED");
}

function assertGeneration(backend: ExecutionBackend, generation: number): void {
	const live = resolveBackend({ requested: backend.deviceId });
	if (
		live.kind !== backend.kind ||
		live.runtimeGeneration !== generation ||
		backend.runtimeGeneration !== generation
	)
		throw denied("Workspace execution identity changed");
}

/** Roles and resource ACLs always come from current server state, never caller input. */
async function liveAuthority(
	narratorId: string,
	actor: string | null | undefined,
	projectId: string | null | undefined,
	backend: ExecutionBackend,
	operation: "read" | "write",
) {
	if (!actor) throw denied("Workspace artifacts require an authenticated actor");
	const user = await db.query.users.findFirst({
		where: eq(users.id, actor),
		columns: { role: true },
	});
	if (!user) throw denied("Workspace actor no longer exists");
	const principal = { userId: actor, isAdmin: user.role === "admin" };
	const row = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: {
			...NARRATOR_ACL_COLUMNS,
			workspaceRevision: true,
			workspaceContext: true,
			permissionMode: true,
			planMode: true,
			relaxedPlan: true,
			traits: true,
		},
	});
	if (!row) throw denied("Workspace narrator no longer exists");
	await assertNarratorAccess(row, principal, operation);
	if (projectId) await loadProjectForAccess(projectId, principal, operation);
	const runtime = await resolveOAuthNarratorRuntimePolicy(narratorId, actor);
	let deviceClass: ExecutionDeviceClass | null = backend.kind === "local" ? "host" : null;
	if (backend.kind === "remote") {
		const device = await db.query.remoteDevices.findFirst({
			where: eq(remoteDevices.id, backend.deviceId),
			columns: {
				id: true,
				scope: true,
				projectId: true,
				ownerScope: true,
				createdBy: true,
				revokedAt: true,
			},
		});
		if (
			!device ||
			device.revokedAt ||
			!isDeviceOnline(backend.deviceId) ||
			!isDeviceAuthorized(device, { projectId, userId: actor })
		)
			throw denied("Workspace device is offline or unauthorized");
		if (runtime) {
			const binding = await integrationResourceBindingService.get("device", backend.deviceId);
			deviceClass =
				binding?.sourceType === "oauth_client" &&
				binding.sourceId === runtime.clientId &&
				binding.authorityType === "oauth_grant" &&
				binding.authorityId === runtime.grantId &&
				binding.state === "active"
					? "selfRegistered"
					: "global";
		}
	}
	if (runtime) {
		if (
			!runtime.allowedTools.has(operation === "write" ? "Write" : "Read") ||
			(backend.kind === "local"
				? !runtime.allowLocalExecution
				: !runtime.deviceIds.includes(backend.deviceId)) ||
			!deviceClass
		)
			throw denied("Workspace artifact is outside the OAuth authority");
		const level = runtime.policy.deviceAccess[deviceClass];
		if (level !== "readWrite" && (operation === "write" || level !== "readOnly"))
			throw denied("Workspace artifact exceeds the OAuth device access ceiling");
	}
	return { row, runtime, deviceClass };
}

/** Also rejects an ancestor tree that would disclose protected platform descendants. */
async function assertSafeLocalPath(backend: ExecutionBackend, path: string): Promise<void> {
	if (backend.kind !== "local") return;
	const [home, platform] = await Promise.all([
		realpath(getHome()).catch(() => getHome()),
		realpath(narraforkDir).catch(() => narraforkDir),
	]);
	if (
		isSecretPlatformPath(path, platform) ||
		isSecretUserPath(path, home) ||
		backend.paths.contains(platform, path) ||
		backend.paths.contains(path, platform) ||
		[".ssh", ".aws", ".gnupg", ".kube"].some((part) => {
			const secret = backend.paths.resolve(home, part);
			return backend.paths.contains(secret, path) || backend.paths.contains(path, secret);
		})
	)
		throw denied("Workspace artifacts cannot access private platform files");
}

async function assertCanonical(
	backend: ExecutionBackend,
	path: string,
	generation: number,
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted();
	assertGeneration(backend, generation);
	if (!backend.paths.isAbsolute(path)) throw denied("Artifact path must be absolute");
	const identity = await backend.resolvePathIdentity(path, { signal, timeoutMs: 5_000 });
	if (
		identity.runtimeGeneration !== generation ||
		!backend.paths.equals(identity.canonicalPath, path)
	)
		throw denied("Artifact canonical path changed");
	assertGeneration(backend, generation);
}

/** Preserve original native root/parent pins instead of replacing them with a fresh observation. */
async function assertStoredWorkspaceRoot(
	backend: ExecutionBackend,
	workspace: WorkspaceContext,
	generation: number,
	signal?: AbortSignal,
): Promise<void> {
	if (
		backend.pathFlavor !== workspace.pathFlavor ||
		resolveBackend({ requested: workspace.deviceId }).pathFlavor !== workspace.pathFlavor
	)
		throw denied("Original workspace path grammar changed");
	if (
		backend.kind === "remote" &&
		workspace.pathFlavor === "windows" &&
		!workspace.nativeRootDescriptor
	)
		throw denied("Original native workspace root evidence is unavailable");
	await assertCanonical(backend, workspace.cwd, generation, signal);
	if (workspace.nativeRootDescriptor) {
		if (backend.kind !== "remote") throw denied("Original native root does not match its backend");
		const stat = await backend.statFile(workspace.cwd, {
			signal,
			timeoutMs: 5_000,
			expectedNativeDescriptor: workspace.nativeRootDescriptor,
		});
		if (!stat?.isDirectory) throw denied("Original native workspace root identity changed");
		assertGeneration(backend, generation);
	}
}

function targetContext(
	backend: ExecutionBackend,
	generation: number,
	cwd: string,
	path: string,
	deviceClass: ExecutionDeviceClass | null,
): ExecutionTargetContext {
	return {
		backend,
		paths: backend.paths,
		deviceClass,
		target: {
			deviceId: backend.deviceId,
			backendKind: backend.kind,
			cwd,
			lexicalPath: path,
			canonicalPath: path,
			pathFlavor: backend.pathFlavor,
			runtimeGeneration: generation,
			selectionSource: "session_default",
		},
	};
}

/** Captured bytes are reauthorized without resolving or reading any live filesystem source. */
export async function assertNarratorCapturedReferenceAuthority(
	source: FileReferenceSourceOrigin,
	userId: string,
	signal: AbortSignal,
): Promise<{ assertStillCurrent(): void }> {
	signal.throwIfAborted();
	const { narratorDeviceWorkspaceService } = await import("./narrator-device-workspace-service");
	const proof = await narratorDeviceWorkspaceService.assertOriginalEndpointDeviceCurrent(
		source.narratorId,
		source.deviceId,
		{ userId, originalProjectId: source.projectId },
	);
	const backend = resolveBackend({ requested: source.deviceId });
	const generation = backend.runtimeGeneration;
	if (
		!backend.paths.isAbsolute(source.canonicalPath) ||
		(source.cwd && !backend.paths.isAbsolute(source.cwd))
	)
		throw denied("Captured source path grammar is unavailable");
	const [
		{ executionPolicyRepository },
		{ compileExecutionPolicy },
		{ resolveLayeredTraits },
		{ robotDiagnosticRuleSet },
		{ mergeExecutionPolicyRuleSets },
		{ executionPolicyRevision },
	] = await Promise.all([
		import("./execution-policy/repository"),
		import("./execution-policy/compiler"),
		import("../lib/trait-resolution"),
		import("../lib/robot-diagnostic-policy"),
		import("./execution-policy/normalize"),
		import("./execution-policy/engine"),
	]);
	// The async loader may return a previously read snapshot. Capture every Read dependency
	// synchronously before it (and the live authority awaits), then compare again at body release.
	const readDependenciesNow = () => {
		const rules = executionPolicyRepository.loadNow(source.narratorId);
		const rows = (rules.inheritedNarratorIds ?? [source.narratorId]).map((id) => {
			const row = db
				.select({
					id: narrators.id,
					permissionMode: narrators.permissionMode,
					traits: narrators.traits,
				})
				.from(narrators)
				.where(
					and(eq(narrators.id, id), sql`length(cast(${narrators.traits} as text)) <= ${64 * 1024}`),
				)
				.get();
			if (!row) throw denied("Captured reference Read dependencies are unavailable or oversized");
			return row;
		});
		const decodeTraitRow = (row: { serializedTraits: string | null } | undefined) => {
			if (!row) return null;
			if (
				typeof row.serializedTraits !== "string" ||
				Buffer.byteLength(row.serializedTraits) > 64 * 1024
			)
				throw denied("Captured reference Read trait budget exceeded");
			let traits: unknown;
			try {
				traits = JSON.parse(row.serializedTraits);
			} catch {
				throw denied("Captured reference Read traits are unavailable");
			}
			if (!Array.isArray(traits)) throw denied("Captured reference Read traits are unavailable");
			return { traits };
		};
		const preference = decodeTraitRow(
			db
				.select({
					serializedTraits: sql<
						string | null
					>`case when length(cast(${userPreferences.traits} as text)) <= ${64 * 1024} then cast(${userPreferences.traits} as text) else null end`,
				})
				.from(userPreferences)
				.where(eq(userPreferences.userId, userId))
				.get(),
		);
		const project =
			source.projectId === null
				? null
				: decodeTraitRow(
						db
							.select({
								serializedTraits: sql<
									string | null
								>`case when length(cast(${projects.traits} as text)) <= ${64 * 1024} then cast(${projects.traits} as text) else null end`,
							})
							.from(projects)
							.where(eq(projects.id, source.projectId))
							.get(),
					);
		if (source.projectId !== null && !project)
			throw denied("Captured reference original project no longer exists");
		if (
			[...rows.map((row) => row.traits), preference?.traits, project?.traits].some(
				(traits) => Buffer.byteLength(JSON.stringify(traits ?? [])) > 64 * 1024,
			)
		)
			throw denied("Captured reference Read trait budget exceeded");
		const fingerprint = JSON.stringify({
			revision: executionPolicyRevision(rules),
			rows,
			userTraits: preference?.traits ?? [],
			projectTraits: project?.traits ?? [],
		});
		return { rules, rows, preference, project, fingerprint };
	};
	const baseline = readDependenciesNow();
	const { runtime, deviceClass } = await liveAuthority(
		source.narratorId,
		userId,
		source.projectId,
		backend,
		"read",
	);
	let rules = await executionPolicyRepository.load(source.narratorId);
	if (runtime?.useRobotDiagnosticPreset) {
		rules = { ...rules, ...mergeExecutionPolicyRuleSets(rules, robotDiagnosticRuleSet()) };
	}
	const context = targetContext(
		backend,
		generation,
		source.cwd ?? backend.paths.resolve(source.canonicalPath, ".."),
		source.canonicalPath,
		deviceClass,
	);
	// Captured bytes have a canonical server identity; neither this decision nor its
	// final synchronous refresh may canonicalize a live filesystem rule or dispatch RPC.
	const assertReadPolicyCurrent = () => {
		const current = readDependenciesNow();
		if (current.fingerprint !== baseline.fingerprint)
			throw denied("Captured reference Read policy changed during authorization");
		for (const row of current.rows) {
			const effective = resolveLayeredTraits({
				narrator: { traits: row.traits },
				user: current.preference ? { traits: current.preference.traits } : null,
				project: current.project ? { traits: current.project.traits } : null,
			});
			if (getDisabledToolSet(effective.traits).has("Read"))
				throw denied("Captured reference Read is disabled by effective traits");
		}
		const effectiveRules = runtime?.useRobotDiagnosticPreset
			? {
					...current.rules,
					...mergeExecutionPolicyRuleSets(current.rules, robotDiagnosticRuleSet()),
				}
			: current.rules;
		const decision = compileExecutionPolicy(effectiveRules, context).evaluatePath({
			path: source.canonicalPath,
			operation: "read",
		}).decision;
		const mode = runtime?.permissionMode ?? current.rows[0].permissionMode ?? "default";
		const implicitRoot =
			source.cwd !== undefined && backend.paths.contains(source.cwd, source.canonicalPath);
		if (
			decision === "deny" ||
			(decision !== "allow" &&
				(mode === "dontAsk" ||
					(!implicitRoot && mode !== "bypassPermissions") ||
					(runtime &&
						deviceClass &&
						runtime.policy.deviceAccess[deviceClass] === "readOnly" &&
						!implicitRoot)))
		)
			throw denied("Captured reference Read denied by current path policy");
	};
	// Reject a stale async loader result even before the first Read decision.
	if (
		executionPolicyRevision(rules) !==
		executionPolicyRevision(
			runtime?.useRobotDiagnosticPreset
				? {
						...baseline.rules,
						...mergeExecutionPolicyRuleSets(baseline.rules, robotDiagnosticRuleSet()),
					}
				: baseline.rules,
		)
	)
		throw denied("Captured reference Read policy changed while loading");
	assertReadPolicyCurrent();
	proof.assertStillCurrent();
	return {
		assertStillCurrent() {
			signal.throwIfAborted();
			proof.assertStillCurrent();
			assertGeneration(backend, generation);
			assertReadPolicyCurrent();
		},
	};
}

/** New resource admission must reject a pending selected installation before any filesystem metadata. */
export async function assertNarratorWorkspaceArtifactCreationAdmission(
	narratorId: string,
	options: { userId?: string | null; signal?: AbortSignal; need?: "read" | "write" },
): Promise<void> {
	const { userId, signal } = options;
	signal?.throwIfAborted();
	if (!userId) throw denied("Workspace artifacts require an authenticated actor");
	const user = await db.query.users.findFirst({
		where: eq(users.id, userId),
		columns: { role: true },
	});
	const row = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: NARRATOR_ACL_COLUMNS,
	});
	if (!user || !row) throw denied("Workspace actor or narrator no longer exists");
	await assertNarratorAccess(
		row,
		{ userId, isAdmin: user.role === "admin" },
		options.need ?? "write",
	);
	const { assertWorkspaceSelectionInstalled } = await import("./workspace-context-service");
	signal?.throwIfAborted();
	assertWorkspaceSelectionInstalled(narratorId);
}

/** Reauthorize a server-owned original resource endpoint; never consult the current binding map. */
export async function assertNarratorOriginalWorkspaceAuthority(
	narratorId: string,
	originalWorkspace: WorkspaceContext,
	options: {
		userId: string;
		signal?: AbortSignal;
		need?: "read" | "write";
		originalProjectId?: string | null;
		/** Exact server-owned canonical target, never a caller-provided read/write root. */
		canonicalPath?: string;
	},
): Promise<{ assertStillCurrent(): void }> {
	const workspace = Object.freeze(structuredClone(originalWorkspace));
	const { userId, signal, canonicalPath } = options;
	const originalProjectId = Object.hasOwn(options, "originalProjectId")
		? options.originalProjectId
		: workspace.contextProjectId;
	const need = options.need ?? "read";
	signal?.throwIfAborted();
	const backend = resolveBackend({ requested: workspace.deviceId });
	const generation = backend.runtimeGeneration;
	if (
		originalProjectId === undefined ||
		(workspace.contextProjectId !== undefined &&
			workspace.contextProjectId !== originalProjectId) ||
		!workspace.contextKey ||
		!backend.paths.isAbsolute(workspace.cwd) ||
		backend.pathFlavor !== workspace.pathFlavor
	)
		throw denied("Original workspace source is unavailable");
	const { narratorDeviceWorkspaceService } = await import("./narrator-device-workspace-service");
	const proof = await narratorDeviceWorkspaceService.assertOriginalEndpointDeviceCurrent(
		narratorId,
		workspace.deviceId,
		{ userId, originalProjectId },
	);
	const { runtime, deviceClass } = await liveAuthority(
		narratorId,
		userId,
		originalProjectId,
		backend,
		need,
	);
	proof.assertStillCurrent();
	await assertStoredWorkspaceRoot(backend, workspace, generation, signal);
	proof.assertStillCurrent();
	if (canonicalPath !== undefined) {
		if (canonicalPath.length > 4096) throw denied("Original resource target is too large");
		await assertCanonical(backend, canonicalPath, generation, signal);
		proof.assertStillCurrent();
		await assertSafeLocalPath(backend, canonicalPath);
		const policy = await executionPolicyEngine.compile(
			narratorId,
			targetContext(backend, generation, workspace.cwd, canonicalPath, deviceClass),
			runtime?.useRobotDiagnosticPreset ? ["robotDiagnostic"] : [],
			signal,
		);
		if (policy.evaluatePath({ path: canonicalPath, operation: need }).decision === "deny")
			throw denied("Original resource path denied by execution policy");
	}
	proof.assertStillCurrent();
	return {
		assertStillCurrent() {
			signal?.throwIfAborted();
			proof.assertStillCurrent();
			assertGeneration(backend, generation);
			if (resolveBackend({ requested: workspace.deviceId }).pathFlavor !== workspace.pathFlavor)
				throw denied("Original workspace path grammar changed");
		},
	};
}

/** Human attachment materialization is not an AI Write or an owner-user impersonation. */
export function createNarratorWorkspaceAttachmentAccess(
	narratorId: string,
	workspaceContext: WorkspaceContext,
	options: {
		userId?: string | null;
		signal?: AbortSignal;
		sourceAccess?: WorkspaceFileAccess;
		/** Only a server-owned existing document may supply its frozen exact target. */
		originalFilePath?: string;
		originalProjectId?: string | null;
		authorizationGuard?: () => Promise<void>;
	} = {},
): WorkspaceAttachmentAccess {
	const workspace = Object.freeze(structuredClone(workspaceContext));
	const {
		userId,
		signal: callerSignal,
		sourceAccess,
		authorizationGuard,
		originalFilePath,
	} = options;
	let artifactOrigin: WorkspaceArtifactOrigin | undefined =
		Object.hasOwn(options, "originalProjectId") && options.originalProjectId !== undefined
			? Object.freeze({ version: 1, projectId: options.originalProjectId })
			: workspace.contextProjectId !== undefined
				? Object.freeze({ version: 1, projectId: workspace.contextProjectId })
				: undefined;
	const assertCreationBinding = async () => {
		if (originalFilePath !== undefined) return;
		const { narratorDeviceWorkspaceService } = await import("./narrator-device-workspace-service");
		const proof = await narratorDeviceWorkspaceService.assertEndpointDeviceCurrent(
			narratorId,
			workspace.deviceId,
			{ userId, contextProjectId: workspace.contextProjectId },
		);
		const { assertWorkspaceSelectionInstalled } = await import("./workspace-context-service");
		proof.assertStillCurrent();
		assertWorkspaceSelectionInstalled(narratorId);
		await narratorDeviceWorkspaceService.assertCurrent(narratorId, workspace, { userId });
	};
	const backend = resolveBackend({ requested: workspace.deviceId });
	const generation = backend.runtimeGeneration;
	if (backend.paths.flavor !== workspace.pathFlavor || !backend.paths.isAbsolute(workspace.cwd))
		throw denied("Workspace attachment backend mismatch");
	const access: WorkspaceAttachmentAccess = {
		get artifactOrigin() {
			return artifactOrigin;
		},
		backend,
		workspaceContext: workspace,
		signal: callerSignal,
		sourceAccess,
		async authorizeWrite(canonicalPath, selectedBackend, writeSignal) {
			const signal =
				writeSignal && callerSignal
					? AbortSignal.any([writeSignal, callerSignal])
					: (writeSignal ?? callerSignal);
			signal?.throwIfAborted();
			if (!userId) throw denied("Workspace artifacts require an authenticated actor");
			if (originalFilePath !== undefined && !artifactOrigin)
				throw denied("Original project source is unavailable");
			if (selectedBackend !== backend) throw denied("Workspace attachment backend changed");
			if (originalFilePath !== undefined && !backend.paths.equals(originalFilePath, canonicalPath))
				throw denied("Original document Write is limited to its exact target");
			await authorizationGuard?.();
			await assertCreationBinding();
			if (!artifactOrigin) {
				const { row } = await liveAuthority(narratorId, userId, undefined, backend, "write");
				artifactOrigin = Object.freeze({
					version: 1,
					projectId: await resolveNarratorProjectId(row),
				});
				await assertCreationBinding();
			}
			const { runtime, deviceClass } = await liveAuthority(
				narratorId,
				userId,
				artifactOrigin.projectId,
				backend,
				"write",
			);
			await assertStoredWorkspaceRoot(backend, workspace, generation, signal);
			await assertCanonical(backend, canonicalPath, generation, signal);
			if (!backend.paths.contains(workspace.cwd, canonicalPath))
				throw denied("Workspace attachment escaped its canonical workspace");
			await assertSafeLocalPath(backend, canonicalPath);
			const policy = await executionPolicyEngine.compile(
				narratorId,
				targetContext(backend, generation, workspace.cwd, canonicalPath, deviceClass),
				runtime?.useRobotDiagnosticPreset ? ["robotDiagnostic"] : [],
				signal,
			);
			if (policy.evaluatePath({ path: canonicalPath, operation: "write" }).decision === "deny")
				throw denied("Workspace attachment write denied by execution policy");
			// Explicit human upload needs no AI permission-mode promotion or Read-rule inference.
			await authorizationGuard?.();
			await assertCreationBinding();
			const { narratorDeviceWorkspaceService } = await import(
				"./narrator-device-workspace-service"
			);
			const proof = await narratorDeviceWorkspaceService.assertOriginalEndpointDeviceCurrent(
				narratorId,
				workspace.deviceId,
				{ userId, originalProjectId: artifactOrigin.projectId },
			);
			// Capture the ticket before the final Write ACL awaits, not after a possible downgrade.
			await liveAuthority(narratorId, userId, artifactOrigin.projectId, backend, "write");
			await assertStoredWorkspaceRoot(backend, workspace, generation, signal);
			await assertCanonical(backend, canonicalPath, generation, signal);
			proof.assertStillCurrent();
			if (originalFilePath === undefined) {
				const { assertWorkspaceSelectionInstalled } = await import("./workspace-context-service");
				proof.assertStillCurrent();
				assertWorkspaceSelectionInstalled(narratorId);
				narratorDeviceWorkspaceService.assertCurrentSync(narratorId, workspace, { userId });
			}
			return true;
		},
		async withAttachmentTarget(signal, body, admitted) {
			if (!userId) throw denied("Attachment native publisher requires its actual human actor");
			const { withWorkspaceAttachmentTarget } = await import("./workspace-attachment-runtime");
			return withWorkspaceAttachmentTarget({ narratorId, userId, access, admitted, signal, body });
		},
	};
	return access;
}

/**
 * Original human attachment provenance supplies an exact source, not an approved tool root.
 * A later source narrator workspace switch must not reinterpret this persisted source binding.
 */
export function createNarratorWorkspaceAttachmentSourceAccess(
	sourceNarratorId: string,
	originalWorkspace: WorkspaceContext,
	originalFilePath: string,
	options: {
		userId?: string | null;
		signal?: AbortSignal;
		originalProjectId?: string | null;
		authorizationGuard?: () => Promise<void>;
	} = {},
): WorkspaceFileAccess {
	const workspace = Object.freeze(structuredClone(originalWorkspace));
	const { userId, signal: callerSignal, authorizationGuard } = options;
	const originalProjectId = Object.hasOwn(options, "originalProjectId")
		? options.originalProjectId
		: workspace.contextProjectId;
	const backend = resolveBackend({ requested: workspace.deviceId });
	const generation = backend.runtimeGeneration;
	if (
		backend.paths.flavor !== workspace.pathFlavor ||
		!backend.paths.isAbsolute(workspace.cwd) ||
		!backend.paths.isAbsolute(originalFilePath) ||
		!backend.paths.contains(workspace.cwd, originalFilePath)
	)
		throw denied("Attachment source does not match its original workspace binding");
	return createWorkspaceFileAccess({
		backend,
		workspaceContext: workspace,
		signal: callerSignal,
		async authorizeRead(canonicalPath, selectedBackend, readSignal) {
			const signal =
				callerSignal && readSignal
					? AbortSignal.any([callerSignal, readSignal])
					: (callerSignal ?? readSignal);
			signal?.throwIfAborted();
			if (!userId) throw denied("Workspace artifacts require an authenticated actor");
			if (originalProjectId === undefined) throw denied("Original project source is unavailable");
			if (selectedBackend !== backend || !backend.paths.equals(originalFilePath, canonicalPath))
				throw denied("Attachment source Read is limited to its exact original file");
			await authorizationGuard?.();
			const { runtime, deviceClass } = await liveAuthority(
				sourceNarratorId,
				userId,
				originalProjectId,
				backend,
				"read",
			);
			await assertStoredWorkspaceRoot(backend, workspace, generation, signal);
			await assertCanonical(backend, originalFilePath, generation, signal);
			await assertSafeLocalPath(backend, originalFilePath);
			const policy = await executionPolicyEngine.compile(
				sourceNarratorId,
				targetContext(backend, generation, workspace.cwd, originalFilePath, deviceClass),
				runtime?.useRobotDiagnosticPreset ? ["robotDiagnostic"] : [],
				signal,
			);
			if (policy.evaluatePath({ path: originalFilePath, operation: "read" }).decision === "deny")
				throw denied("Attachment source Read denied by execution policy");
			await authorizationGuard?.();
			await liveAuthority(sourceNarratorId, userId, originalProjectId, backend, "read");
			const { narratorDeviceWorkspaceService } = await import(
				"./narrator-device-workspace-service"
			);
			const proof = await narratorDeviceWorkspaceService.assertOriginalEndpointDeviceCurrent(
				sourceNarratorId,
				workspace.deviceId,
				{ userId, originalProjectId },
			);
			await assertStoredWorkspaceRoot(backend, workspace, generation, signal);
			await assertCanonical(backend, originalFilePath, generation, signal);
			proof.assertStillCurrent();
			return true;
		},
	});
}

/**
 * Explicit AI artifact copies require their own approved Write endpoint. This is deliberately
 * separate from human attachments: neither a Read approval nor an upload permission grants it.
 * The optional original source access is supplied by the trusted resource publisher, not inferred.
 */
export function createApprovedWorkspaceArtifactAccess(
	ctx: ToolContext,
	sourceAccess?: WorkspaceFileAccess,
): WorkspaceAttachmentAccess {
	if (!ctx.workspaceContext) throw denied("AI artifacts require a frozen workspace context");
	const workspace = Object.freeze(structuredClone(ctx.workspaceContext));
	const { narratorId, userId, signal, runtimePolicy, planFileBinding, planFileId, planFilePath } =
		ctx;
	const recheck = ctx.recheckAuthorization;
	const backend = resolveBackend({ requested: workspace.deviceId });
	const generation = backend.runtimeGeneration;
	const writes =
		ctx.executionPlan?.endpoints
			.filter((endpoint) => endpoint.operation === "write")
			.map((endpoint) => ({ ...endpoint.target })) ?? [];
	if (backend.paths.flavor !== workspace.pathFlavor || !backend.paths.isAbsolute(workspace.cwd))
		throw denied("AI artifact backend does not match its frozen workspace");

	async function assertAiAuthority() {
		signal.throwIfAborted();
		if (!recheck) throw denied("AI artifacts require a live authorization fence");
		await recheck();
		if (
			planFileBinding ||
			planFileId ||
			planFilePath ||
			(runtimePolicy &&
				(runtimePolicy.tools.readOnly || !isRuntimeToolAllowed(runtimePolicy, "Write")))
		)
			throw denied("AI artifact Write is outside the runtime or plan authority");
		const authority = await liveAuthority(
			narratorId,
			userId,
			workspace.contextProjectId,
			backend,
			"write",
		);
		const effectiveTraits = await resolveEffectiveTraits({
			narratorTraits: authority.row.traits,
			projectId: (await resolveNarratorProjectId(authority.row)) ?? workspace.contextProjectId,
			actingUserId: userId,
		});
		if (getDisabledToolSet(effectiveTraits.traits).has("Write"))
			throw denied("AI artifact Write is disabled by effective user/project/narrator traits");
		const mode = authority.runtime?.permissionMode ?? authority.row.permissionMode;
		if (
			!isPermissionMode(mode) ||
			mode === "readOnly" ||
			(authority.row.planMode && !authority.row.relaxedPlan)
		)
			throw denied("AI artifacts are forbidden by live read-only or strict plan mode");
		if (workspace.binding) {
			if (
				workspace.binding.narratorId !== narratorId ||
				workspace.binding.deviceId !== workspace.deviceId
			)
				throw denied("AI artifact has a foreign workspace binding");
			const { narratorDeviceWorkspaceService } = await import(
				"./narrator-device-workspace-service"
			);
			await narratorDeviceWorkspaceService.assertCurrent(narratorId, workspace, { userId });
		} else if (
			authority.row.workspaceRevision !== workspace.revision ||
			(authority.row.workspaceContext &&
				authority.row.workspaceContext.contextKey !== workspace.contextKey)
		)
			throw denied("AI artifact workspace context changed");
		return authority;
	}

	return {
		backend,
		workspaceContext: workspace,
		signal,
		sourceAccess,
		async authorizeWrite(canonicalPath, selectedBackend, writeSignal) {
			const operationSignal = writeSignal ? AbortSignal.any([signal, writeSignal]) : signal;
			operationSignal.throwIfAborted();
			if (selectedBackend !== backend) throw denied("AI artifact backend changed");
			const { runtime, deviceClass } = await assertAiAuthority();
			const endpoint = writes.find(
				(target) =>
					target.deviceId === backend.deviceId &&
					target.backendKind === backend.kind &&
					target.runtimeGeneration === generation &&
					target.pathFlavor === backend.pathFlavor &&
					(!workspace.binding ||
						(JSON.stringify(target.workspaceBinding) === JSON.stringify(workspace.binding) &&
							JSON.stringify(target.workspaceContext?.binding) ===
								JSON.stringify(workspace.binding))) &&
					target.canonicalPath &&
					backend.paths.contains(target.canonicalPath, canonicalPath),
			);
			if (!endpoint?.canonicalPath)
				throw denied("AI artifact is outside its approved canonical Write endpoints");
			await assertCanonical(backend, workspace.cwd, generation, operationSignal);
			await assertCanonical(backend, endpoint.canonicalPath, generation, operationSignal);
			await assertCanonical(backend, canonicalPath, generation, operationSignal);
			if (!backend.paths.contains(workspace.cwd, canonicalPath))
				throw denied("AI artifact escaped its canonical workspace");
			await assertSafeLocalPath(backend, canonicalPath);
			const policy = await executionPolicyEngine.compile(
				narratorId,
				targetContext(backend, generation, workspace.cwd, canonicalPath, deviceClass),
				runtime?.useRobotDiagnosticPreset ? ["robotDiagnostic"] : [],
				operationSignal,
			);
			const decision = policy.evaluatePath({ path: canonicalPath, operation: "write" }).decision;
			if (decision === "deny") throw denied("AI artifact Write denied by execution policy");
			const final = await assertAiAuthority();
			if (
				(final.runtime?.permissionMode ?? final.row.permissionMode) === "dontAsk" &&
				decision !== "allow"
			)
				throw denied("AI artifact Write has no automatic allow under dontAsk mode");
			await assertCanonical(backend, workspace.cwd, generation, operationSignal);
			await assertCanonical(backend, endpoint.canonicalPath, generation, operationSignal);
			await assertCanonical(backend, canonicalPath, generation, operationSignal);
			return true;
		},
	};
}

/** Read scope comes exclusively from the immutable permission-approved endpoint plan. */
export function createApprovedWorkspaceReadGuard(ctx: ToolContext): ApprovedWorkspaceReadGuard {
	const { narratorId, userId, signal: callerSignal, runtimePolicy } = ctx;
	const fallbackProjectId = ctx.projectId;
	const recheck = ctx.recheckAuthorization;
	const targets: ToolExecutionTarget[] = ctx.executionPlan
		? ctx.executionPlan.endpoints
				.filter((endpoint) => endpoint.operation === "read")
				.map((endpoint) => ({ ...endpoint.target }))
		: ctx.executionTarget
			? [{ ...ctx.executionTarget }]
			: [];
	const sources = targets.map((target) => {
		const backend =
			ctx.resolveBackend?.(target.deviceId) ?? resolveBackend({ requested: target.deviceId });
		return { target, backend, generation: backend.runtimeGeneration };
	});
	return async (canonicalPath, backend, readSignal) => {
		const signal = readSignal ? AbortSignal.any([callerSignal, readSignal]) : callerSignal;
		signal.throwIfAborted();
		if (!recheck) throw denied("Approved workspace reads require a live authorization fence");
		await recheck();
		if (runtimePolicy && !isRuntimeToolAllowed(runtimePolicy, "Read"))
			throw denied("Workspace read is outside the runtime tool authority");
		const source = sources.find(
			({ target, backend: admitted, generation }) =>
				admitted === backend &&
				target.deviceId === backend.deviceId &&
				target.backendKind === backend.kind &&
				target.runtimeGeneration === generation &&
				target.pathFlavor === backend.pathFlavor &&
				target.canonicalPath &&
				backend.paths.contains(target.canonicalPath, canonicalPath),
		);
		if (!source?.target.canonicalPath)
			throw denied("Workspace read is outside its approved canonical endpoints");
		const root = source.target.canonicalPath;
		const { generation, target } = source;
		const projectId = target.workspaceContext?.contextProjectId ?? fallbackProjectId;
		const { runtime, deviceClass } = await liveAuthority(
			narratorId,
			userId,
			projectId,
			backend,
			"read",
		);
		await assertCanonical(backend, root, generation, signal);
		await assertCanonical(backend, canonicalPath, generation, signal);
		await assertSafeLocalPath(backend, canonicalPath);
		const policy = await executionPolicyEngine.compile(
			narratorId,
			targetContext(backend, generation, target.cwd, canonicalPath, deviceClass),
			runtime?.useRobotDiagnosticPreset ? ["robotDiagnostic"] : [],
			signal,
		);
		if (
			policy.evaluatePath({ path: canonicalPath, operation: "read" }).decision === "deny" ||
			policy.directoryBlacklist.some(
				(rule) => rule.denyLevel === "denyAll" && backend.paths.contains(canonicalPath, rule.path),
			)
		)
			throw denied("Workspace read tree includes an execution-policy denied path");
		await recheck();
		await liveAuthority(narratorId, userId, projectId, backend, "read");
		await assertCanonical(backend, root, generation, signal);
		await assertCanonical(backend, canonicalPath, generation, signal);
		return true;
	};
}
