import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
	FILE_CHANGE_LIMITS,
	type FileChangeRevertAction,
	type FileChangeState,
} from "@shared/file-change-protocol";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	projects,
	users,
} from "../db/schema";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { localBackend } from "../lib/agent/execution/local-backend";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { checkWriteBoundary } from "../lib/fs-write-boundary";
import { logger } from "../lib/logger";
import { settings } from "../lib/settings";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { createFileChangeIdentity, fileChangeIdentityKey } from "./file-change-identity";
import { fileChangeLocalIo, localDirectoryIdentity } from "./file-change-local-io";
import { fileChangePlatformCapability } from "./file-change-platform-capability";
import {
	getDefaultLocalFileChangeRuntime,
	type LocalFileChangeRuntime,
	localFileChangeRuntimeBinding,
} from "./file-change-runtime";
import { assertNarratorAccess, type NarratorAclRow, type NarratorPrincipal } from "./narrator-acl";
import { resolveNarratorProjectId } from "./narrator-project";
import type { ScopedRevertUnavailableReason } from "./narrator-scoped-revert";
import {
	invalidateWorkspaceTreeCache,
	resetActiveUpstreamSession,
	resolveNarratorAdmissionRoot,
} from "./narrator-session-state";
import { assertProjectAccess } from "./project-acl";
import { boundedDetail, collectRevertBlockers } from "./revert-blockers";
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
import { RevertTransactionService } from "./revert-transaction-service";
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
		// A subagent row carries no chapter/project of its own; its project is the
		// delegation root's. Without this, reverting inside a subagent would skip the
		// project write gate its parent is held to.
		const projectRow =
			row.type === "subagent"
				? await (async () => {
						const rootId = await resolveNarratorAdmissionRoot(narratorId);
						const root = db
							.select({
								chapterId: narrators.chapterId,
								contextProjectId: narrators.contextProjectId,
							})
							.from(narrators)
							.where(eq(narrators.id, rootId))
							.get();
						if (!root) throw new NotFoundError("Narrator", rootId);
						return root;
					})()
				: row;
		const projectId = await resolveNarratorProjectId(projectRow);
		if (projectRow.chapterId && !projectId) throw new NotFoundError("Narrator project", narratorId);
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
/** Volume-level admission (e.g. FAT/exFAT on Windows) before any history is read. */
async function assertLocalRevertPlatform() {
	const capability = await fileChangePlatformCapability();
	if (!capability.supported)
		throw new RevertPlannerError(
			"PLATFORM_UNSUPPORTED",
			`Local filesystem cannot provide verified rollback identities (${capability.reason})`,
		);
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
	| {
			runtime: LocalFileChangeRuntime;
			namespace: Awaited<ReturnType<LocalFileChangeRuntime["verifyNamespace"]>>;
			planner: RevertPlannerService;
			plans: RevertPlanService;
			transactions: RevertTransactionService;
	  }
	| undefined;
async function services(signal: AbortSignal) {
	const { runtime, namespace } = await verifiedNamespace(signal);
	if (!cached || cached.runtime !== runtime || cached.namespace !== namespace) {
		const namespaceKey = namespace.catalog.getBudget()?.namespaceKey;
		if (!namespaceKey) throw stale("Evidence namespace metadata is missing");
		cached = {
			runtime,
			namespace,
			planner: new RevertPlannerService(db, {
				access,
				blobStore: namespace.store,
				blobCatalog: namespace.catalog,
				generation: namespace.generation,
				planOptions: { namespaceKey },
			}),
			plans: new RevertPlanService(db, { namespaceKey }),
			transactions: new RevertTransactionService(db, {
				access,
				runtime,
				namespace,
				planOptions: { namespaceKey },
			}),
		};
	}
	return cached;
}

async function prepareLocalRevertPlanCore(request: RevertPlannerRequest & { signal: AbortSignal }) {
	const runtime = await getDefaultLocalFileChangeRuntime();
	return runtime.withNamespaceAccess(async () => {
		const { planner } = await services(request.signal);
		return planner.prepare({ ...request, signal: request.signal });
	});
}

export async function prepareLocalRevertPlan(request: RevertPlannerRequest) {
	const signal = request.signal ?? AbortSignal.timeout(FILE_CHANGE_LIMITS.planLifetimeMs);
	try {
		await access.owner(request.principal, request.narratorId, signal);
		return await prepareLocalRevertPlanCore({ ...request, signal });
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

export interface LocalRevertActionPreviewRequest {
	action: FileChangeRevertAction;
	messageId: string;
	blockIndex?: number;
	idempotencyKey: string;
}

/** Resolve UI indices only at preview time; the resulting manifest freezes actual identities. */
export async function prepareLocalRevertAction(
	principal: NarratorPrincipal,
	narratorId: string,
	input: LocalRevertActionPreviewRequest,
	signal: AbortSignal,
) {
	await access.owner(principal, narratorId, signal);
	try {
		const { assertBashActivityProtectionReady } = await import("../lib/agent/tools/bash");
		assertBashActivityProtectionReady();
		const narrator = db
			.select({ messageVersion: narrators.messageVersion })
			.from(narrators)
			.where(eq(narrators.id, narratorId))
			.get();
		if (!narrator) throw new NotFoundError("Narrator", narratorId);
		// Subagents are revert roots too: users work in them directly. Their selection
		// covers only their own history (plus anything they delegated), and admission
		// reserves only the subagent, never its parent's live turn.
		if (localBackend.pathFlavor !== "posix" && localBackend.pathFlavor !== "windows")
			throw new RevertPlannerError(
				"UNSUPPORTED_TARGET",
				"This action requires a local filesystem narrator",
			);
		await assertLocalRevertPlatform();
		let selector: RevertPlannerRequest["selector"];
		let kind: RevertPlannerRequest["kind"];
		if (input.action === "revert_files") {
			kind = "revert";
			if (input.messageId === "__all__") selector = { kind: "all" };
			else {
				const ref = db
					.select({ seq: narratorMessageRefs.seq })
					.from(narratorMessageRefs)
					.where(
						and(
							eq(narratorMessageRefs.narratorId, narratorId),
							eq(narratorMessageRefs.messageId, input.messageId),
						),
					)
					.get();
				if (!ref) throw new NotFoundError("Message", input.messageId);
				selector = { kind: "from_seq", minSeq: ref.seq };
			}
		} else {
			const index = input.blockIndex;
			if (index === undefined || !Number.isSafeInteger(index) || index < 0)
				throw new ValidationError("A valid block index is required");
			// Bound JSON1 parsing on the HTTP thread; never select the complete message body.
			const body = sql`CASE WHEN octet_length(${narratorMessages.contentJson}) <= ${FILE_CHANGE_LIMITS.summaryBytes}
				THEN CASE WHEN json_valid(${narratorMessages.contentJson}) THEN ${narratorMessages.contentJson} ELSE NULL END
				ELSE NULL END`;
			const message = db
				.select({
					role: narratorMessages.role,
					blockCount: sql<number | null>`json_array_length(${body})`,
					blockType: sql<string | null>`json_extract(${body}, ${`$[${index}].type`})`,
					toolUseId: sql<string | null>`json_extract(${body}, ${`$[${index}].id`})`,
				})
				.from(narratorMessageRefs)
				.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
				.where(
					and(
						eq(narratorMessageRefs.narratorId, narratorId),
						eq(narratorMessageRefs.messageId, input.messageId),
					),
				)
				.get();
			if (!message) throw new NotFoundError("Message", input.messageId);
			if (message.blockCount === null)
				throw new RevertPlannerError(
					"BUDGET_EXCEEDED",
					"Message boundary metadata exceeds its verification budget",
				);
			if (index >= message.blockCount)
				throw new ValidationError("Block index is outside the message");
			if (input.action === "rollback_to_block") {
				kind = "rollback_to_block";
				selector = {
					kind: "after_block",
					messageId: input.messageId,
					keepThroughBlockIndex: message.role === "user" ? message.blockCount - 1 : index,
				};
			} else {
				if (message.blockType !== "tool_use" || typeof message.toolUseId !== "string")
					throw new ValidationError("The selected block is not a tool call");
				const tools = db
					.select({ id: narratorToolCalls.id })
					.from(narratorToolCalls)
					.where(
						and(
							eq(narratorToolCalls.messageId, input.messageId),
							eq(narratorToolCalls.toolUseId, message.toolUseId),
						),
					)
					.limit(2)
					.all();
				if (tools.length !== 1)
					throw new RevertPlannerError(
						"EVIDENCE_INCOMPLETE",
						"The selected tool has no unique execution identity",
					);
				kind = "history_delete";
				selector = { kind: "tool_calls", toolCallIds: [tools[0].id] };
			}
		}
		const result = await prepareLocalRevertPlanCore({
			principal,
			narratorId,
			expectedMessageVersion: narrator.messageVersion,
			idempotencyKey: input.idempotencyKey,
			kind,
			revertScope: "narrator",
			selector,
			uiAction: input.action,
			signal,
		});
		return { ...result, action: input.action };
	} catch (error) {
		if (!(error instanceof AppError) || error.statusCode !== 409) throw error;
		const code = error.code;
		if (/IDEMPOTENCY|ACTION_MISMATCH|REQUEST_CONFLICT/.test(code)) throw error;
		// The coarse reason below is all the client sees. Keep the precise code for
		// remote diagnosis; never log error.message, which can embed absolute paths.
		logger.warn("Revert preview refused", { narratorId, action: input.action, code });
		let unavailable: ScopedRevertUnavailableReason = "incomplete_coverage";
		if (code === "REVERT_RUNTIME_RELOAD_REQUIRED") unavailable = "runtime_reload_required";
		else if (code === "REVERT_PLANNER_PLATFORM_UNSUPPORTED") unavailable = "platform_unsupported";
		else if (/UNSUPPORTED|WORKSPACE_UNAVAILABLE|TARGET_UNVERIFIED/.test(code))
			unavailable = "unsupported_target";
		else if (/BUDGET|TOO_LARGE/.test(code)) unavailable = "window_too_large";
		else if (/ACTIVE_WRITER|BUSY/.test(code)) unavailable = "pending_operations";
		else if (/NAMESPACE|BLOB|CATALOG|MANIFEST/.test(code)) unavailable = "snapshot_missing";
		// Name the actual holders instead of only the coarse reason. Diagnostics are
		// advisory: they never widen the refused plan or soften the safety gate.
		let blockers =
			unavailable === "pending_operations" || unavailable === "incomplete_coverage"
				? collectRevertBlockers(narratorId, code)
				: undefined;
		if (unavailable === "pending_operations" && (!blockers || blockers.length === 0)) {
			// In-memory coordinator activity (write lease / registerActivity) has no
			// durable tool row. Prefer a stable short label over error.message: that
			// prose can embed absolute paths. Only error.code is a safe extra signal.
			const busy = /BUSY/.test(code);
			blockers = [
				{
					kind: busy ? "narrator_busy" : "uncoordinated_activity",
					detail: boundedDetail(
						busy ? "Narrator runtime is busy" : "Workspace write activity is still open",
					),
				},
			];
		}
		return {
			action: input.action,
			plan: null,
			executable: false as const,
			unavailable,
			historySummary: null,
			...(blockers && blockers.length > 0 ? { blockers } : {}),
		};
	}
}

/** Own the real transaction lifetime, not merely the HTTP response deadline. */
export async function applyLocalRevertPlan(
	principal: NarratorPrincipal,
	narratorId: string,
	planId: string,
	input: { planHash: string; action: FileChangeRevertAction },
	signal: AbortSignal,
) {
	const owner = await access.owner(principal, narratorId, signal);
	const { assertBashActivityProtectionReady } = await import("../lib/agent/tools/bash");
	assertBashActivityProtectionReady();
	await assertLocalRevertPlatform();
	const { plans, transactions } = await services(signal);
	const plan = plans.getSummary(owner, planId);
	if (plan.planHash !== input.planHash)
		throw new RevertPlannerError("ACTION_MISMATCH", "Confirmed plan changed");
	if (plan.status === "prepared" && plan.expired)
		throw new RevertPlannerError("EXPIRED", "Confirmed plan expired; load a fresh preview");
	const expectedKind = {
		revert_files: "revert",
		rollback_to_block: "rollback_to_block",
		delete_tool_block: "history_delete",
	}[input.action];
	if (plan.kind !== expectedKind)
		throw new RevertPlannerError(
			"ACTION_MISMATCH",
			"Confirmed action does not match the prepared plan",
		);
	const { acquireNarratorRevertAdmission } = await import("./narrator-session");
	const release =
		plan.status === "prepared"
			? await acquireNarratorRevertAdmission(narratorId, { signal, interrupt: true })
			: () => {};
	let execution: ReturnType<RevertTransactionService["execute"]>;
	try {
		await transactions.validateHttpAction({ principal, narratorId, planId, ...input, signal });
		const admissionPlan = plans.getSummary(owner, planId);
		if (admissionPlan.status === "prepared" && admissionPlan.expired)
			throw new RevertPlannerError("EXPIRED", "Confirmed plan expired; load a fresh preview");
		execution = transactions.execute({ principal, narratorId, planId, ...input, signal });
	} catch (error) {
		release();
		throw error;
	}
	let refreshFailed = false;
	const refresh = (work: () => void) => {
		try {
			work();
		} catch (error) {
			refreshFailed = true;
			logger.error("Committed revert notification failed", { error: String(error) });
		}
	};
	const settled = execution.whenSettled
		.then(async (outcome) => {
			if (outcome.status !== "committed") return;
			if (outcome.historyResult?.affectedQuestionIds?.length) {
				try {
					const { notifyQuestionHistoryChanged } = await import("./narrator-question-service");
					await notifyQuestionHistoryChanged(narratorId, outcome.historyResult.affectedQuestionIds);
				} catch (error) {
					refreshFailed = true;
					logger.error("Committed question history refresh failed", { error: String(error) });
				}
			}
			for (const path of outcome.worktreePaths ?? [])
				refresh(() => invalidateWorkspaceTreeCache(path));
			const affected = new Set(outcome.historyResult?.affectedNarratorIds ?? []);
			for (const id of affected) refresh(() => resetActiveUpstreamSession(id));
			// The fixed root also refreshes for file-only operations and terminal retries.
			affected.add(narratorId);
			for (const id of affected)
				refresh(() => broadcastToNarrator(id, { type: "full_reload", narratorId: id }));
		})
		.finally(release);
	void settled.catch((error) =>
		logger.error("Revert settlement or post-commit refresh failed", { error: String(error) }),
	);
	const outcome = await execution.result;
	if (!outcome.settling) await settled;
	const { historyResult: _historyResult, worktreePaths: _worktreePaths, ...response } = outcome;
	return refreshFailed && response.status === "committed"
		? { ...response, reason: response.reason ?? "POST_COMMIT_REFRESH_FAILED" }
		: response;
}
