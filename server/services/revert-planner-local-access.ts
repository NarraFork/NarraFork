import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { FILE_CHANGE_LIMITS, type FileChangeState } from "@shared/file-change-protocol";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { narrators, projects, users } from "../db/schema";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { localBackend } from "../lib/agent/execution/local-backend";
import { AppError, NotFoundError } from "../lib/errors";
import { checkWriteBoundary } from "../lib/fs-write-boundary";
import { settings } from "../lib/settings";
import { createFileChangeIdentity, fileChangeIdentityKey } from "./file-change-identity";
import { fileChangeLocalIo, localDirectoryIdentity } from "./file-change-local-io";
import {
	getDefaultLocalFileChangeRuntime,
	type LocalFileChangeRuntime,
	localFileChangeRuntimeBinding,
} from "./file-change-runtime";
import { assertNarratorAccess, type NarratorAclRow, type NarratorPrincipal } from "./narrator-acl";
import { resolveNarratorProjectId } from "./narrator-project";
import { assertProjectAccess } from "./project-acl";
import {
	type RevertPlanFileCursor,
	type RevertPlanOwner,
	RevertPlanService,
} from "./revert-plan-service";
import {
	type RevertPlannerAccess,
	RevertPlannerError,
	type RevertPlannerFileAccess,
	type RevertPlannerFileTarget,
	type RevertPlannerRequest,
	RevertPlannerService,
} from "./revert-planner-service";
import type { WorkspaceCaptureSummary } from "./workspace-write-coordinator";

/** Production ACL and read-only local backend adapter. No test/HTTP allow callbacks,
 * cwd confirmation, default-device guessing, legacy replay or remote fallback. */
export class RevertPlannerLocalAccess implements RevertPlannerAccess {
	async authenticate(principal: NarratorPrincipal, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		const user = db
			.select({ id: users.id, role: users.role })
			.from(users)
			.where(eq(users.id, principal.userId))
			.get();
		// requireSessionAuth verifies the JWT; this closes its cached-user/stale-role window.
		if (
			!user ||
			!["user", "admin"].includes(user.role) ||
			principal.isAdmin !== (user.role === "admin")
		)
			throw new AppError(
				"Authenticated user no longer exists or its role changed",
				401,
				"REVERT_PREVIEW_AUTHENTICATION_CHANGED",
			);
	}

	async authorizeNarrator(
		principal: NarratorPrincipal,
		row: NarratorAclRow,
		need: "write",
		signal: AbortSignal,
	) {
		await this.authenticate(principal, signal);
		await assertNarratorAccess(row, principal, need);
		signal.throwIfAborted();
	}

	async resolveContext(input: {
		principal: NarratorPrincipal;
		narratorId: string;
		signal: AbortSignal;
	}) {
		const context = await this.narrator(input.principal, input.narratorId, input.signal);
		// Also reverify for a zero-file plan. Its no_dispatch history is not a reason to
		// skip the source/namespace checks needed before publishing complete manifests.
		await verifiedNamespace(input.signal);
		return { projectId: context.projectId };
	}

	private async narrator(principal: NarratorPrincipal, narratorId: string, signal: AbortSignal) {
		await this.authenticate(principal, signal);
		const row = db
			.select({
				id: narrators.id,
				ownerUserId: narrators.ownerUserId,
				visibility: narrators.visibility,
				writeAudience: narrators.writeAudience,
				type: narrators.type,
				aclRootNarratorId: narrators.aclRootNarratorId,
				chapterId: narrators.chapterId,
				contextProjectId: narrators.contextProjectId,
				cwd: narrators.cwd,
			})
			.from(narrators)
			.where(eq(narrators.id, narratorId))
			.get();
		if (!row) throw new NotFoundError("Narrator", narratorId);
		await assertNarratorAccess(row, principal, "write");
		const projectId = await resolveNarratorProjectId(row);
		if (row.chapterId && !projectId) throw new NotFoundError("Narrator project", narratorId);
		if (projectId) {
			const project = db
				.select({
					id: projects.id,
					ownerUserId: projects.ownerUserId,
					visibility: projects.visibility,
				})
				.from(projects)
				.where(eq(projects.id, projectId))
				.get();
			if (!project) throw new NotFoundError("Project", projectId);
			await assertProjectAccess(project, principal, "write");
		}
		signal.throwIfAborted();
		return { row, projectId };
	}

	private async fileContext(input: RevertPlannerFileAccess) {
		const { principal, owner, identity, signal } = input;
		if (!owner.narratorId || owner.subjectKey !== `human:${principal.userId}`)
			throw new NotFoundError("Revert plan", "owner");
		const context = await this.narrator(principal, owner.narratorId, signal);
		if (context.projectId !== owner.projectId) throw stale("Narrator project changed");
		// The recorded actual target, not the narrator's current default device, owns
		// this evidence. Current cwd/write-boundary and live scope checks still apply.
		if (identity.deviceId !== LOCAL_DEVICE_ID || identity.pathFlavor !== localBackend.pathFlavor)
			throw new RevertPlannerError(
				"UNSUPPORTED_BACKEND",
				"Only the verified local backend supports this preview",
			);
		if (identity.objectRole !== "referent")
			throw new RevertPlannerError(
				"UNSUPPORTED_OBJECT",
				"Local preview currently supports regular referents or known absence only",
			);
		const cwd = context.row.cwd?.trim();
		if (!cwd || !isAbsolute(cwd))
			throw new RevertPlannerError(
				"WORKSPACE_UNAVAILABLE",
				"Narrator has no verified absolute workspace",
			);
		// A confirmable outside-root verdict remains a REFUSAL. This endpoint cannot
		// create a new writable directory or accept confirmOutsideRoots from a client.
		const decision = checkWriteBoundary(identity.lexicalPath, [
			cwd,
			...(settings.paths.extraWritableDirs ?? []),
		]);
		if (!decision.allowed || !decision.physicalPath)
			throw new AppError(
				"File is outside the current allowed write boundary",
				403,
				"REVERT_PREVIEW_FILE_ACCESS_DENIED",
			);
		if (!localBackend.paths.equals(decision.physicalPath, identity.canonicalPath))
			throw stale("Authorized file target changed");
		signal.throwIfAborted();
		return { cwd, projectId: context.projectId };
	}

	async authorizeFile(input: RevertPlannerFileAccess) {
		await this.fileContext(input);
	}

	async resolveFile(input: RevertPlannerFileAccess): Promise<RevertPlannerFileTarget> {
		const initialContext = await this.fileContext(input);
		const { runtime, namespace } = await verifiedNamespace(input.signal);
		const identity = Object.freeze({ ...input.identity });
		const scope = runtime.evidence.getScope(identity.scopeId);
		if (!scope) throw stale("Recorded scope is unavailable");
		const initialRuntime = localFileChangeRuntimeBinding(LOCAL_DEVICE_ID);
		if (!initialRuntime) throw stale("Local runtime is unavailable");
		const initialCapture = runtime.coordinator.capture(scope);
		assertIdle(initialCapture);
		const executionBinding = Object.freeze({
			deviceId: LOCAL_DEVICE_ID,
			...initialRuntime,
			fencingToken: initialCapture.fencingToken,
		});
		const assertCurrent = async ({ signal }: { signal: AbortSignal }) => {
			const context = await this.fileContext({ ...input, identity, signal });
			if (context.cwd !== initialContext.cwd || context.projectId !== initialContext.projectId)
				throw stale("Narrator workspace/context changed during preview");
			const liveNamespace = await verifiedNamespace(signal);
			if (liveNamespace.runtime !== runtime || liveNamespace.namespace !== namespace)
				throw stale("Local runtime implementation or namespace changed");
			const live = runtime.evidence.getScope(identity.scopeId);
			if (
				!live ||
				live.sourceInstanceId !== namespace.sourceInstanceId ||
				live.sourceInstanceId !== identity.sourceInstanceId ||
				live.deviceId !== LOCAL_DEVICE_ID ||
				live.pathFlavor !== localBackend.pathFlavor ||
				live.workspaceInstanceId !== identity.workspaceInstanceId ||
				live.canonicalRoot !== scope.canonicalRoot ||
				live.rootIdentityJson?.object !== scope.rootIdentityJson?.object
			)
				throw stale("Recorded scope identity no longer matches this installation");
			const rebuilt = createFileChangeIdentity(live, identity);
			if (
				fileChangeIdentityKey(rebuilt) !== fileChangeIdentityKey(identity) ||
				rebuilt.scopeId !== identity.scopeId
			)
				throw stale("File identity no longer matches the recorded scope");
			if (
				!live.rootIdentityJson?.object ||
				(await localDirectoryIdentity(live.canonicalRoot)) !== live.rootIdentityJson.object
			)
				throw stale("Workspace directory incarnation changed");
			const canonical = await localBackend.resolvePathIdentity(identity.lexicalPath);
			if (!localBackend.paths.equals(canonical.canonicalPath, identity.canonicalPath))
				throw stale("Canonical referent changed");
			const currentRuntime = localFileChangeRuntimeBinding(LOCAL_DEVICE_ID);
			if (
				!currentRuntime ||
				currentRuntime.runtimeEpoch !== initialRuntime.runtimeEpoch ||
				currentRuntime.runtimeGeneration !== initialRuntime.runtimeGeneration ||
				localBackend.runtimeGeneration !== initialRuntime.runtimeGeneration
			)
				throw stale("Local runtime generation changed");
			let capture: WorkspaceCaptureSummary;
			try {
				capture = runtime.coordinator.assertObservationCurrent({
					scope: live,
					runtime: currentRuntime,
					scopeRevision: initialCapture.scopeRevision,
					fencingToken: executionBinding.fencingToken,
					signal,
				});
			} catch {
				signal.throwIfAborted();
				throw new RevertPlannerError(
					"ACTIVE_WRITER",
					"An overlapping durable or live write scope requires verification",
				);
			}
			assertIdle(capture);
			if (
				capture.scopeRevision !== initialCapture.scopeRevision ||
				capture.fencingToken !== executionBinding.fencingToken ||
				capture.coordinationEpoch !== initialCapture.coordinationEpoch ||
				capture.coordinationRevision !== initialCapture.coordinationRevision
			)
				throw stale("Platform write activity or scope revision changed during observation");
			signal.throwIfAborted();
		};
		await assertCurrent({ signal: input.signal });
		return {
			identity,
			executionBinding,
			scopeRevision: initialCapture.scopeRevision,
			assertCurrent,
			async readCurrent({ signal, maxBytes }) {
				if (
					!Number.isSafeInteger(maxBytes) ||
					maxBytes < 0 ||
					maxBytes > FILE_CHANGE_LIMITS.blobBytes
				)
					throw new RevertPlannerError("BUDGET_EXCEEDED", "Invalid current-file read limit");
				await assertCurrent({ signal });
				try {
					const entry = await lstat(identity.canonicalPath);
					if (entry.size > maxBytes)
						throw new RevertPlannerError(
							"BUDGET_EXCEEDED",
							"Current file exceeds the remaining preview budget",
						);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				const observed = await fileChangeLocalIo.read(identity.canonicalPath, signal);
				let state: FileChangeState;
				if (observed.bytes === null) state = { kind: "absent" };
				else {
					if (observed.bytes.byteLength > maxBytes || observed.mode === null)
						throw new RevertPlannerError(
							"BUDGET_EXCEEDED",
							"Current object grew or its mode was not measured",
						);
					const hash = createHash("sha256");
					for (
						let offset = 0;
						offset < observed.bytes.byteLength;
						offset += FILE_CHANGE_LIMITS.streamChunkBytes
					) {
						signal.throwIfAborted();
						hash.update(
							observed.bytes.subarray(offset, offset + FILE_CHANGE_LIMITS.streamChunkBytes),
						);
						await yieldToEventLoop();
					}
					state = {
						kind: "regular",
						mode: observed.mode,
						blob: {
							algorithm: "sha256",
							digest: hash.digest("hex"),
							sizeBytes: observed.bytes.byteLength,
						},
					};
				}
				await assertCurrent({ signal });
				return { state, raw: observed.bytes };
			},
		};
	}

	async owner(
		principal: NarratorPrincipal,
		narratorId: string,
		signal: AbortSignal,
	): Promise<RevertPlanOwner> {
		const { projectId } = await this.narrator(principal, narratorId, signal);
		return { subjectKey: `human:${principal.userId}`, narratorId, projectId };
	}
}

function assertIdle(capture: WorkspaceCaptureSummary) {
	if (
		capture.status !== "active" ||
		capture.durableLeasePresent ||
		capture.activeMutationCount ||
		capture.active.writes ||
		capture.active.rollbacks ||
		capture.active.uncoordinatedActivities ||
		capture.active.retainedRecoveryHolds
	)
		throw new RevertPlannerError(
			"ACTIVE_WRITER",
			"Known platform activity or an unsettled scope prevents preview preparation",
		);
	// externalFilesystemQuiescence intentionally remains unknown. This is only a
	// preview; external races must be detected again by a future guarded executor.
}
function stale(message: string) {
	return new RevertPlannerError("STALE", message);
}
async function verifiedNamespace(signal: AbortSignal) {
	signal.throwIfAborted();
	const runtime = await getDefaultLocalFileChangeRuntime();
	try {
		return { runtime, namespace: await runtime.verifyNamespace(signal) };
	} catch (error) {
		signal.throwIfAborted();
		if (error instanceof AppError) throw error;
		throw new RevertPlannerError(
			"NAMESPACE_UNAVAILABLE",
			"Existing local evidence source or private storage needs verification",
		);
	}
}

// Module-generation singleton: keep the shared calculator/namespace but never retain
// an old implementation via hotSafe, and never borrow the test ALS runtime override.
const access = new RevertPlannerLocalAccess();
let cached:
	| { runtime: LocalFileChangeRuntime; planner: RevertPlannerService; plans: RevertPlanService }
	| undefined;
async function services(signal: AbortSignal) {
	const { runtime, namespace } = await verifiedNamespace(signal);
	if (!cached || cached.runtime !== runtime) {
		const namespaceKey = namespace.catalog.getBudget()?.namespaceKey;
		if (!namespaceKey) throw stale("Evidence namespace metadata is missing");
		cached = {
			runtime,
			planner: new RevertPlannerService(db, {
				access,
				blobStore: namespace.store,
				blobCatalog: namespace.catalog,
				generation: namespace.generation,
				planOptions: { namespaceKey },
			}),
			plans: new RevertPlanService(db, { namespaceKey }),
		};
	}
	return cached;
}

/** Authenticated entrypoints only. No route accepts a caller-provided owner, project,
 * manifest proof or raw digest, and even metadata GETs recheck write authorization. */
export async function prepareLocalRevertPlan(request: RevertPlannerRequest) {
	const signal = request.signal ?? AbortSignal.timeout(FILE_CHANGE_LIMITS.planLifetimeMs);
	try {
		await access.owner(request.principal, request.narratorId, signal);
		const { planner } = await services(signal);
		return await planner.prepare({ ...request, signal });
	} catch (error) {
		if (signal.aborted)
			throw new AppError(
				"Preview preparation was cancelled or timed out",
				409,
				"REVERT_PREVIEW_CANCELLED",
			);
		throw error;
	}
}
export async function getLocalRevertPlan(
	principal: NarratorPrincipal,
	narratorId: string,
	planId: string,
	signal: AbortSignal,
) {
	const owner = await access.owner(principal, narratorId, signal);
	const { plans } = await services(signal);
	const plan = plans.getSummary(owner, planId);
	signal.throwIfAborted();
	return { plan, executable: false as const };
}
export async function listLocalRevertPlanFiles(
	principal: NarratorPrincipal,
	narratorId: string,
	planId: string,
	options: { cursor?: RevertPlanFileCursor; limit?: number; signal: AbortSignal },
) {
	const owner = await access.owner(principal, narratorId, options.signal);
	const { plans } = await services(options.signal);
	const page = plans.listFiles(owner, planId, options);
	// Stored paths are sensitive too. A preview created before file permission revocation
	// must not leak target identities under the weaker GET/read-only narrator gate.
	for (const item of page.items) {
		await access.authorizeFile({
			principal,
			owner,
			identity: item.identityJson,
			signal: options.signal,
		});
	}
	const currentOwner = await access.owner(principal, narratorId, options.signal);
	if (currentOwner.projectId !== owner.projectId) throw stale("Plan project changed");
	options.signal.throwIfAborted();
	return { ...page, executable: false as const };
}
