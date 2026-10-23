import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isFullyQualifiedWindowsPath } from "@shared/target-native-path";
import type {
	ListNarratorDeviceWorkspacesResult,
	NarratorDeviceWorkspaceBinding,
	NarratorDeviceWorkspaceMutationResult,
	SelectNarratorDeviceWorkspaceRequest,
	SetNarratorDeviceWorkspaceRequest,
	WorkspaceContext,
} from "@shared/workspace-context";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { db } from "../db";
import {
	narratorDeviceWorkspaces as bindings,
	chapters,
	narrators,
	projects,
	narratorDeviceWorkspaceRequests as receipts,
	users,
	workspaceSwitchRequests,
} from "../db/schema";
import {
	ExecutionTargetError,
	localBackend,
	resolveBackend,
} from "../lib/agent/execution/registry";
import { AppError, NotFoundError } from "../lib/errors";
import { generateId } from "../lib/id";
import { isInsidePath } from "../lib/platform-path";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { isDeviceOnline } from "./device-connection-service";
import { isDeviceAuthorized } from "./device-service";
import { assertNarratorAccess, NARRATOR_ACL_COLUMNS } from "./narrator-acl";
import {
	endpointDeviceAuthorityFingerprint,
	endpointDeviceAuthorityRow,
} from "./narrator-device-workspace-authority";
import {
	deviceWorkspaceBindingContext,
	insertInitialDeviceWorkspaceBinding,
	readDeviceWorkspaceBinding,
} from "./narrator-device-workspace-store";
import {
	activeNarrators,
	compactLocks,
	isNarratorRevertAdmissionBlocked,
	pendingDangerReflections,
	pendingPermissions,
	withNarratorMutationAdmission,
} from "./narrator-session-state";
import { resolveOAuthDeviceRuntimeAuthorization } from "./oauth-device-runtime-policy";
import { resolveOAuthNarratorRuntimePolicy } from "./oauth-narrator-runtime-policy";
import { loadProjectForAccess } from "./project-acl";
import {
	assertSwitchAdmission,
	assertTargetAllowed,
	assertWorkspaceContextFresh,
	authorizeWorkspaceDevice,
	installWorkspaceContext,
	pauseWorkspace,
	prepareWorkspaceContext,
	runtimeDeviceClass,
	type WorkspaceSwitchOptions,
	workspaceContextService,
	workspaceSelectionInstallationStatus,
} from "./workspace-context-service";
import { workspaceConflict } from "./workspace-context-transition";
import { withWorkspaceAdmission } from "./worktree-lifecycle-guard";

type ActorOptions = { userId?: string | null };
type MutationOptions = WorkspaceSwitchOptions;

export interface WorkspaceEndpointDeviceAuthority {
	/** Must run in the final no-await body-start fence; never an authorization token from a caller. */
	assertStillCurrent(): void;
}

export interface OriginalEndpointDeviceOptions {
	/** Fixed actual actor, never a role or owner borrowed from a mutable config. */
	userId: string;
	/** Server-owned origin only. null is explicitly standalone; absent/undefined is unknown. */
	originalProjectId: string | null;
}

async function originalNarratorReadAuthority(id: string, actor: string) {
	const row = await db.query.narrators.findFirst({
		where: eq(narrators.id, id),
		columns: NARRATOR_ACL_COLUMNS,
	});
	if (!row) throw new NotFoundError("Narrator", id);
	const user = await db.query.users.findFirst({
		where: eq(users.id, actor),
		columns: { role: true },
	});
	if (!user) throw new AppError("Workspace actor no longer exists", 403, "WORKSPACE_ACCESS_DENIED");
	const principal = Object.freeze({ userId: actor, isAdmin: user.role === "admin" });
	// Only canonical narrator ACL here: selecting workspace B must not make B's
	// extra workspace-project gate the grant for a server-owned original resource A.
	await assertNarratorAccess(row, principal, "read");
	return principal;
}

async function authority(id: string, options: ActorOptions, need: "read" | "write") {
	const row = await db.query.narrators.findFirst({
		where: eq(narrators.id, id),
		columns: {
			...NARRATOR_ACL_COLUMNS,
			status: true,
			workspaceRevision: true,
			workspaceContext: true,
			defaultDeviceId: true,
			cwd: true,
			contextProjectId: true,
		},
	});
	if (!row) throw new NotFoundError("Narrator", id);
	// Internal callers may omit actor, but a supplied actor is never replaced by the owner.
	const actor = options.userId === undefined ? row.ownerUserId : options.userId;
	if (!actor)
		throw new AppError("Workspace requires an authenticated actor", 403, "WORKSPACE_ACCESS_DENIED");
	const user = await db.query.users.findFirst({
		where: eq(users.id, actor),
		columns: { role: true },
	});
	if (!user) throw new AppError("Workspace actor no longer exists", 403, "WORKSPACE_ACCESS_DENIED");
	const principal = { userId: actor, isAdmin: user.role === "admin" };
	await assertNarratorAccess(row, principal, need);
	const projectId = row.workspaceContext?.contextProjectId ?? row.contextProjectId;
	if (projectId) await loadProjectForAccess(projectId, principal, need);
	return { row, actor };
}

/** Summary authorization never pulls the selected endpoint's original native JSON into JS. */
async function summaryAuthority(id: string, options: ActorOptions) {
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
			projectId: sql<
				string | null
			>`coalesce(json_extract(${narrators.workspaceContext}, '$.contextProjectId'), ${narrators.contextProjectId})`,
			deviceId: sql<string>`coalesce(json_extract(${narrators.workspaceContext}, '$.deviceId'), ${narrators.defaultDeviceId}, 'local')`,
		})
		.from(narrators)
		.where(eq(narrators.id, id))
		.get();
	if (!row) throw new NotFoundError("Narrator", id);
	const actor = options.userId === undefined ? row.ownerUserId : options.userId;
	if (!actor)
		throw new AppError("Workspace requires an authenticated actor", 403, "WORKSPACE_ACCESS_DENIED");
	const user = await db.query.users.findFirst({
		where: eq(users.id, actor),
		columns: { role: true },
	});
	if (!user) throw new AppError("Workspace actor no longer exists", 403, "WORKSPACE_ACCESS_DENIED");
	const principal = { userId: actor, isAdmin: user.role === "admin" };
	await assertNarratorAccess(row, principal, "read");
	if (row.projectId) await loadProjectForAccess(row.projectId, principal, "read");
	return { row, actor };
}

function bindingResult(
	context: WorkspaceContext,
	createdAt: string,
	updatedAt: string,
): NarratorDeviceWorkspaceBinding {
	const ref = context.binding;
	if (!ref) throw workspaceConflict("Workspace binding is missing");
	return {
		id: ref.bindingId,
		narratorId: ref.narratorId,
		deviceId: ref.deviceId,
		bindingRevision: ref.bindingRevision,
		context,
		createdAt,
		updatedAt,
	};
}

async function fresh(
	id: string,
	context: WorkspaceContext,
	options: ActorOptions,
	need: "read" | "write" = "read",
) {
	const { actor } = await authority(id, options, need);
	await authorizeWorkspaceDevice(context.deviceId, context.contextProjectId, {
		narratorId: id,
		userId: actor,
	});
	const generation = resolveBackend({ requested: context.deviceId }).runtimeGeneration;
	await assertWorkspaceContextFresh(id, context, { userId: actor });
	await authority(id, { userId: actor }, need);
	if (resolveBackend({ requested: context.deviceId }).runtimeGeneration !== generation)
		throw workspaceConflict("Device connection changed during authority validation");
}

function digest(
	kind: "set" | "select",
	request: SetNarratorDeviceWorkspaceRequest | SelectNarratorDeviceWorkspaceRequest,
	actor: string,
) {
	return createHash("sha256")
		.update(
			JSON.stringify([
				"narrator-device-workspace-request/v1",
				kind,
				actor,
				request.deviceId,
				request.expectedBindingRevision,
				request.expectedSelectionRevision ?? null,
				"cwd" in request ? request.cwd : null,
				"expectedWorktreeKey" in request ? (request.expectedWorktreeKey ?? null) : null,
			]),
		)
		.digest("hex");
}

async function replay(
	id: string,
	kind: "set" | "select",
	request: SetNarratorDeviceWorkspaceRequest | SelectNarratorDeviceWorkspaceRequest,
	options: MutationOptions,
): Promise<NarratorDeviceWorkspaceMutationResult | null> {
	const actor = (await authority(id, options, "write")).actor;
	if (await workspaceContextService.getRequest(id, request.requestId))
		throw workspaceConflict(
			"Request id belongs to a legacy workspace switch",
			"WORKSPACE_REQUEST_CONFLICT",
		);
	const receipt = await narratorDeviceWorkspaceService.getRequest(id, request.requestId, {
		userId: actor,
	});
	if (!receipt) return null;
	if (
		receipt.kind !== kind ||
		receipt.actorUserId !== actor ||
		receipt.requestDigest !== digest(kind, request, actor)
	)
		throw workspaceConflict(
			"Request id was used by a different workspace operation or actor",
			"WORKSPACE_REQUEST_CONFLICT",
		);
	await fresh(id, receipt.result.binding.context, { userId: actor }, "write");
	return receipt.installState === "pending"
		? narratorDeviceWorkspaceService.recoverRequest(id, request.requestId, {
				...options,
				userId: actor,
			})
		: receipt.result;
}

function requireBinding(
	binding: NarratorDeviceWorkspaceBinding | null,
): NarratorDeviceWorkspaceBinding {
	if (!binding)
		throw workspaceConflict(
			"Device workspace needs initialization",
			"WORKSPACE_DIRECTORY_NOT_CONFIGURED",
		);
	return binding;
}

async function mutate(
	id: string,
	kind: "set" | "select",
	request: SetNarratorDeviceWorkspaceRequest | SelectNarratorDeviceWorkspaceRequest,
	options: MutationOptions,
): Promise<NarratorDeviceWorkspaceMutationResult> {
	const { actor, row } = await authority(id, options, "write");
	options = { ...options, userId: actor };
	const priorReceipt = await replay(id, kind, request, options);
	if (priorReceipt) return priorReceipt;
	assertSwitchAdmission(id, options);
	if (options.origin === "http" && ["working", "waiting"].includes(row.status))
		throw workspaceConflict("Narrator is busy", "WORKSPACE_CONTEXT_BUSY");
	const previous = await workspaceContextService.get(id, { userId: actor, persistLegacy: false });
	if (!previous.capabilities.switchDirectory)
		throw workspaceConflict(
			"Specialized narrator workspace mutation is unsupported",
			"WORKSPACE_CONTEXT_UNSUPPORTED",
		);
	if (kind === "set" && (await resolveOAuthNarratorRuntimePolicy(id, actor)))
		throw workspaceConflict(
			"OAuth directory configuration is not enabled",
			"WORKSPACE_CONTEXT_UNSUPPORTED",
		);
	const prior = readDeviceWorkspaceBinding(db, id, request.deviceId);
	if (
		(prior?.bindingRevision ?? 0) !== request.expectedBindingRevision ||
		(kind === "select" && !prior)
	)
		throw workspaceConflict("Device workspace binding revision changed");
	const selects = kind === "select" || request.deviceId === previous.deviceId;
	if (selects && request.expectedSelectionRevision !== previous.revision)
		throw workspaceConflict("Default workspace selection revision changed");
	await authorizeWorkspaceDevice(request.deviceId, previous.contextProjectId, {
		...options,
		narratorId: id,
	});
	const backend = resolveBackend({ requested: request.deviceId });
	const generation = backend.runtimeGeneration;
	const target =
		kind === "select"
			? requireBinding(prior).context
			: await prepareWorkspaceContext(
					{ deviceId: request.deviceId, cwd: (request as SetNarratorDeviceWorkspaceRequest).cwd },
					previous.revision,
					previous.contextProjectId,
					{ ...options, narratorId: id },
				);
	await fresh(id, target, options, "write");
	if (
		"expectedWorktreeKey" in request &&
		request.expectedWorktreeKey !== undefined &&
		target.git?.workspaceKey !== request.expectedWorktreeKey
	)
		throw workspaceConflict("Target worktree identity changed");
	// Keep the legacy chapter/worktree ceiling; adding device bindings is not a bypass.
	if (row.chapterId && kind === "set") {
		const chapter = await db.query.chapters.findFirst({
			where: eq(chapters.id, row.chapterId),
			columns: { worktreePath: true },
		});
		const root = chapter?.worktreePath
			? await realpath(chapter.worktreePath).catch(() => null)
			: null;
		if (
			target.deviceId !== "local" ||
			!root ||
			!isInsidePath(root, target.cwd) ||
			previous.git?.workspaceKey !== target.git?.workspaceKey
		)
			throw workspaceConflict(
				"Chapter cross-worktree switching is unsupported",
				"WORKSPACE_CONTEXT_UNSUPPORTED",
			);
	}
	try {
		return await withNarratorMutationAdmission(
			id,
			async () => {
				assertSwitchAdmission(id, options);
				const live = await authority(id, options, "write");
				if (options.origin === "http" && ["working", "waiting"].includes(live.row.status))
					throw workspaceConflict("Narrator is busy", "WORKSPACE_CONTEXT_BUSY");
				const latest = await workspaceContextService.get(id, {
					userId: actor,
					persistLegacy: false,
				});
				if (latest.revision !== previous.revision || latest.contextKey !== previous.contextKey)
					throw workspaceConflict("Default workspace changed while preparing");
				await fresh(id, target, options, "write");
				if (resolveBackend({ requested: request.deviceId }).runtimeGeneration !== generation)
					throw workspaceConflict("Execution device connection changed");
				const timestamp = new Date().toISOString();
				const endpointChanged =
					!prior ||
					prior.context.contextKey !== target.contextKey ||
					JSON.stringify(prior.context.nativeRootDescriptor) !==
						JSON.stringify(target.nativeRootDescriptor);
				const context =
					kind === "select" || !endpointChanged
						? requireBinding(prior).context
						: deviceWorkspaceBindingContext(
								id,
								prior?.id ?? generateId(),
								(prior?.bindingRevision ?? 0) + 1,
								target,
							);
				const binding = bindingResult(
					context,
					prior?.createdAt ?? timestamp,
					endpointChanged && kind === "set" ? timestamp : (prior?.updatedAt ?? timestamp),
				);
				const selectionChanged =
					selects &&
					(previous.contextKey !== context.contextKey ||
						previous.binding?.bindingKey !== context.binding?.bindingKey);
				const current = Object.freeze({
					...context,
					revision: previous.revision + (selectionChanged ? 1 : 0),
				});
				const result: NarratorDeviceWorkspaceMutationResult = {
					kind,
					changed: (kind === "set" && endpointChanged) || selectionChanged,
					binding,
					...(selects ? { selection: { changed: selectionChanged, previous, current } } : {}),
				};
				await withWorkspaceAdmission(
					{
						deviceId: context.deviceId,
						path: context.cwd,
						repositoryKey: context.git?.repositoryKey,
					},
					async () =>
						db.transaction((tx) => {
							if (
								tx
									.select({ id: workspaceSwitchRequests.id })
									.from(workspaceSwitchRequests)
									.where(
										and(
											eq(workspaceSwitchRequests.narratorId, id),
											eq(workspaceSwitchRequests.requestId, request.requestId),
										),
									)
									.get()
							)
								throw workspaceConflict(
									"Request id belongs to legacy switch",
									"WORKSPACE_REQUEST_CONFLICT",
								);
							const stored = readDeviceWorkspaceBinding(tx, id, request.deviceId);
							if ((stored?.bindingRevision ?? 0) !== request.expectedBindingRevision)
								throw workspaceConflict("Device workspace binding revision changed");
							if (kind === "set" && endpointChanged) {
								const values = {
									bindingRevision: binding.bindingRevision,
									cwd: context.cwd,
									pathFlavor: context.pathFlavor,
									workspaceContext: context,
									updatedAt: timestamp,
								};
								if (stored) {
									const won = tx
										.update(bindings)
										.set(values)
										.where(
											and(
												eq(bindings.id, stored.id),
												eq(bindings.bindingRevision, request.expectedBindingRevision),
											),
										)
										.returning({ id: bindings.id })
										.all();
									if (won.length !== 1) throw workspaceConflict("Binding CAS failed");
								} else
									tx.insert(bindings)
										.values({
											...values,
											id: binding.id,
											narratorId: id,
											deviceId: request.deviceId,
											createdAt: timestamp,
										})
										.run();
							}
							if (selects) {
								if (
									previous.cwd &&
									previous.deviceId !== context.deviceId &&
									!readDeviceWorkspaceBinding(tx, id, previous.deviceId)
								)
									insertInitialDeviceWorkspaceBinding(tx, {
										narratorId: id,
										context: previous,
										createdAt: timestamp,
									});
								const won = tx
									.update(narrators)
									.set({
										workspaceContext: current,
										workspaceRevision: current.revision,
										cwd: current.cwd,
										defaultDeviceId: current.deviceId === "local" ? null : current.deviceId,
										...(selectionChanged ? { apiConversationId: null, updatedAt: timestamp } : {}),
									})
									.where(
										and(
											eq(narrators.id, id),
											eq(narrators.workspaceRevision, request.expectedSelectionRevision ?? -1),
										),
									)
									.returning({ id: narrators.id })
									.all();
								if (won.length !== 1) throw workspaceConflict("Selection CAS failed");
							}
							tx.insert(receipts)
								.values({
									id: generateId(),
									narratorId: id,
									requestId: request.requestId,
									actorUserId: actor,
									kind,
									deviceId: request.deviceId,
									requestDigest: digest(kind, request, actor),
									expectedBindingRevision: request.expectedBindingRevision,
									expectedSelectionRevision: request.expectedSelectionRevision ?? null,
									result,
									installState: selectionChanged ? "pending" : "installed",
									createdAt: timestamp,
									updatedAt: timestamp,
								})
								.run();
						}),
				);
				// This is a durable summary invalidation, not an installed-context event.
				broadcastToNarrator(id, { type: "device_workspace_bindings_changed", narratorId: id });
				if (selectionChanged) {
					try {
						await installWorkspaceContext(id, current);
						await db
							.update(receipts)
							.set({ installState: "installed", updatedAt: new Date().toISOString() })
							.where(and(eq(receipts.narratorId, id), eq(receipts.requestId, request.requestId)));
					} catch {
						pauseWorkspace(id);
						throw workspaceConflict(
							"Workspace committed; runtime needs recovery",
							"WORKSPACE_CONTEXT_INSTALL_FAILED",
						);
					}
					broadcastToNarrator(id, {
						type: "workspace_context_changed",
						narratorId: id,
						previous,
						current,
					});
				}
				return result;
			},
			{ failIfBusy: true },
		);
	} catch (error) {
		if (error instanceof AppError && error.code === "WORKSPACE_CONTEXT_INSTALL_FAILED") throw error;
		const existing = await replay(id, kind, request, options);
		if (existing) return existing;
		throw error;
	}
}

export const narratorDeviceWorkspaceService = {
	/** Current selection readiness only; fresh actor/role ACL, no endpoint or filesystem probing. */
	async getSelectionInstallationStatus(id: string, options: { userId: string }) {
		const actor = options?.userId;
		if (typeof actor !== "string" || !actor)
			throw new AppError(
				"Selection status requires its actual actor",
				403,
				"WORKSPACE_ACCESS_DENIED",
			);
		await summaryAuthority(id, { userId: actor });
		return workspaceSelectionInstallationStatus(id);
	},
	/** Original server-owned resource authority. No current binding comparison, cwd/root grant, FS or RPC. */
	async assertOriginalEndpointDeviceCurrent(
		id: string,
		deviceId: string,
		options: OriginalEndpointDeviceOptions,
	): Promise<WorkspaceEndpointDeviceAuthority> {
		const actor = options?.userId;
		if (typeof actor !== "string" || !actor || actor.length > 128)
			throw new AppError(
				"Original endpoint requires its actual actor",
				403,
				"WORKSPACE_ACCESS_DENIED",
			);
		const originalProjectId = options?.originalProjectId;
		if (
			originalProjectId !== null &&
			(typeof originalProjectId !== "string" ||
				!originalProjectId ||
				originalProjectId.length > 128)
		)
			throw workspaceConflict(
				"Original endpoint project identity is unknown",
				"WORKSPACE_ORIGINAL_CONTEXT_REQUIRED",
			);
		// Capture both fixed primitives and all ACL/OAuth dependencies before any await.
		const original = Object.freeze({ originalProjectId });
		const fingerprint = endpointDeviceAuthorityFingerprint(id, deviceId, actor, original);
		const principal = await originalNarratorReadAuthority(id, actor);
		if (originalProjectId !== null)
			await loadProjectForAccess(originalProjectId, principal, "read");
		const denied = () =>
			new AppError(
				"Original endpoint device is no longer authorized",
				403,
				"WORKSPACE_ACCESS_DENIED",
			);
		const requireDevice = () => {
			const device = endpointDeviceAuthorityRow(deviceId);
			if (
				!device ||
				device.revokedAt ||
				!isDeviceAuthorized(device, { projectId: originalProjectId, userId: actor })
			)
				throw denied();
			return device;
		};
		const device = deviceId === "local" ? null : requireDevice();
		const { runtime } = await runtimeDeviceClass(id, deviceId, actor);
		if (
			runtime &&
			(deviceId === "local" ? !runtime.allowLocalExecution : !runtime.deviceIds.includes(deviceId))
		)
			throw denied();
		if (
			device &&
			!(await resolveOAuthDeviceRuntimeAuthorization(device).catch(() => ({ allowed: false })))
				.allowed
		)
			throw denied();
		const latestPrincipal = await originalNarratorReadAuthority(id, actor);
		if (originalProjectId !== null)
			await loadProjectForAccess(originalProjectId, latestPrincipal, "read");
		const assertStillCurrent = () => {
			if (endpointDeviceAuthorityFingerprint(id, deviceId, actor, original) !== fingerprint)
				throw denied();
			if (deviceId !== "local") {
				requireDevice();
				if (!isDeviceOnline(deviceId))
					throw workspaceConflict(
						"Original endpoint device is offline",
						"WORKSPACE_DEVICE_OFFLINE",
					);
			}
		};
		assertStillCurrent();
		return Object.freeze({ assertStillCurrent });
	},
	/** Live authority for an explicit absolute endpoint without a stored directory binding. Zero FS/RPC. */
	async assertEndpointDeviceCurrent(
		id: string,
		deviceId: string,
		options: ActorOptions & { contextProjectId?: string | null } = {},
	): Promise<WorkspaceEndpointDeviceAuthority> {
		// Freeze trusted actor/hint and the dependency baseline before the first await.
		// Capturing only after project authorization could bless a revocation that happened
		// while that earlier authorization was returning its accepted result.
		const actor =
			options.userId === undefined
				? db
						.select({ owner: narrators.ownerUserId })
						.from(narrators)
						.where(eq(narrators.id, id))
						.get()?.owner
				: options.userId;
		if (!actor)
			throw new AppError(
				"Workspace requires an authenticated actor",
				403,
				"WORKSPACE_ACCESS_DENIED",
			);
		const projectHint = options.contextProjectId;
		const fingerprint = endpointDeviceAuthorityFingerprint(id, deviceId, actor);
		const { row } = await summaryAuthority(id, { userId: actor });
		const chapter = row.chapterId
			? await db.query.chapters.findFirst({
					where: eq(chapters.id, row.chapterId),
					columns: { projectId: true },
				})
			: null;
		const projectId = chapter?.projectId ?? row.contextProjectId ?? row.projectId ?? undefined;
		if (projectHint !== undefined && projectHint !== (projectId ?? null))
			throw new AppError(
				"Endpoint project hint does not match live narrator authority",
				403,
				"WORKSPACE_ACCESS_DENIED",
			);
		if (projectId) {
			const user = await db.query.users.findFirst({
				where: eq(users.id, actor),
				columns: { role: true },
			});
			await loadProjectForAccess(
				projectId,
				{ userId: actor, isAdmin: user?.role === "admin" },
				"read",
			);
		}
		const denied = () =>
			new AppError("Endpoint device is no longer authorized", 403, "WORKSPACE_ACCESS_DENIED");
		const requireDevice = () => {
			const device = endpointDeviceAuthorityRow(deviceId);
			if (!device || device.revokedAt || !isDeviceAuthorized(device, { projectId, userId: actor }))
				throw denied();
			return device;
		};
		const device = deviceId === "local" ? null : requireDevice();
		const { runtime } = await runtimeDeviceClass(id, deviceId, actor);
		if (
			runtime &&
			(deviceId === "local" ? !runtime.allowLocalExecution : !runtime.deviceIds.includes(deviceId))
		)
			throw denied();
		if (device) {
			const authorization = await resolveOAuthDeviceRuntimeAuthorization(device).catch(() => null);
			const level = authorization?.policy?.deviceAccess.selfRegistered;
			if (
				!authorization?.allowed ||
				(authorization.oauthOwned && level !== "readOnly" && level !== "readWrite")
			)
				throw denied();
		}
		await summaryAuthority(id, { userId: actor });
		const assertStillCurrent = () => {
			if (endpointDeviceAuthorityFingerprint(id, deviceId, actor) !== fingerprint) throw denied();
			if (deviceId !== "local") {
				requireDevice();
				if (!isDeviceOnline(deviceId))
					throw workspaceConflict("Endpoint device is offline", "WORKSPACE_DEVICE_OFFLINE");
			}
		};
		assertStillCurrent();
		return Object.freeze({ assertStillCurrent });
	},
	async list(
		id: string,
		query: { cursor?: string; limit?: number } = {},
		options: ActorOptions = {},
	): Promise<ListNarratorDeviceWorkspacesResult> {
		await summaryAuthority(id, options);
		const limit = Math.max(1, Math.min(32, Math.floor(query.limit ?? 32)));
		const { row, actor } = await summaryAuthority(id, options);
		const items: ListNarratorDeviceWorkspacesResult["items"] = [];
		let scanCursor = query.cursor;
		// Keyset-scan bounded summaries until there is one extra AUTHORIZED item.
		// A private/offline row is never exposed as a client-visible cursor.
		while (items.length <= limit) {
			const rows = await db
				.select({
					id: bindings.id,
					deviceId: bindings.deviceId,
					cwd: bindings.cwd,
					pathFlavor: bindings.pathFlavor,
					bindingRevision: bindings.bindingRevision,
					updatedAt: bindings.updatedAt,
				})
				.from(bindings)
				.where(
					and(
						eq(bindings.narratorId, id),
						scanCursor ? gt(bindings.deviceId, scanCursor) : undefined,
					),
				)
				.orderBy(asc(bindings.deviceId))
				.limit(limit + 1);
			for (const entry of rows) {
				try {
					// Recheck ACL, OAuth and path policy, without reading original native JSON in list queries.
					await authorizeWorkspaceDevice(entry.deviceId, row.projectId ?? undefined, {
						narratorId: id,
						userId: actor,
					});
					await assertTargetAllowed(
						id,
						entry.cwd,
						resolveBackend({ requested: entry.deviceId }),
						actor,
					);
					await summaryAuthority(id, { userId: actor });
					items.push({
						...entry,
						selected: row.deviceId === entry.deviceId,
						availability: "ready",
					});
				} catch (error) {
					if (!(error instanceof AppError) && !(error instanceof ExecutionTargetError)) throw error;
					// Offline/unauthorized/deleted endpoints never disclose cwd and never fall back to host.
				}
				if (items.length > limit) break;
			}
			if (items.length > limit || rows.length <= limit) break;
			scanCursor = rows[rows.length - 1].deviceId;
		}
		await summaryAuthority(id, { userId: actor });
		const hasMore = items.length > limit;
		return { items: items.slice(0, limit), nextCursor: hasMore ? items[limit - 1].deviceId : null };
	},
	async get(
		id: string,
		deviceId: string,
		options: ActorOptions & { ensureLegacy?: boolean } = {},
	): Promise<NarratorDeviceWorkspaceBinding | null> {
		const { actor, row } = await authority(id, options, "read");
		let binding = readDeviceWorkspaceBinding(db, id, deviceId);
		if (!binding && options.ensureLegacy !== false) {
			const committed =
				row.workspaceContext?.revision === row.workspaceRevision ? row.workspaceContext : null;
			const selectedDevice = committed?.deviceId ?? row.defaultDeviceId ?? "local";
			// A missing B must not prepare A, consult A's filesystem, or mint any host fallback.
			if (selectedDevice !== deviceId) return null;
			if (!committed) {
				if (deviceId !== "local") return null;
				const chapter = row.chapterId
					? await db.query.chapters.findFirst({
							where: eq(chapters.id, row.chapterId),
							columns: { worktreePath: true, projectId: true },
						})
					: null;
				const projectId = chapter?.projectId ?? row.contextProjectId;
				const project = projectId
					? await db.query.projects.findFirst({
							where: eq(projects.id, projectId),
							columns: { gitPath: true },
						})
					: null;
				// Match legacy precedence, but never reinterpret a relative preferred source
				// through process cwd or silently replace it with another source.
				const source = row.cwd || chapter?.worktreePath || project?.gitPath;
				if (
					!source ||
					!localBackend.paths.isAbsolute(source) ||
					(localBackend.paths.flavor === "windows" && !isFullyQualifiedWindowsPath(source))
				)
					return null;
			} else if (!committed.cwd) return null;
			const current = await workspaceContextService.get(id, {
				userId: actor,
				persistLegacy: false,
			});
			if (
				current.deviceId === deviceId &&
				current.cwd &&
				current.availability !== "needs_initialization"
			) {
				await fresh(id, current, { userId: actor });
				await workspaceContextService.get(id, { userId: actor });
				binding = readDeviceWorkspaceBinding(db, id, deviceId);
			}
		}
		if (!binding) return null;
		await fresh(id, binding.context, { userId: actor });
		return binding;
	},
	async resolve(
		id: string,
		deviceId: string,
		options: ActorOptions = {},
	): Promise<WorkspaceContext | null> {
		return (await this.get(id, deviceId, options))?.context ?? null;
	},
	/** Identity-only final guard. Async assertCurrent remains mandatory for live authorization. */
	assertCurrentSync(id: string, context: WorkspaceContext, options: ActorOptions = {}): void {
		if (
			options.userId &&
			!db.select({ id: users.id }).from(users).where(eq(users.id, options.userId)).get()
		)
			throw new AppError("Workspace actor no longer exists", 403, "WORKSPACE_ACCESS_DENIED");
		const ref = context.binding;
		if (!ref || ref.narratorId !== id || ref.deviceId !== context.deviceId)
			throw workspaceConflict("Workspace binding does not belong to this narrator/device");
		const binding = readDeviceWorkspaceBinding(db, id, context.deviceId);
		if (
			!binding ||
			binding.id !== ref.bindingId ||
			binding.bindingRevision !== ref.bindingRevision ||
			JSON.stringify(binding.context.binding) !== JSON.stringify(ref) ||
			binding.context.contextKey !== context.contextKey ||
			binding.context.cwd !== context.cwd ||
			binding.context.pathFlavor !== context.pathFlavor ||
			binding.context.contextProjectId !== context.contextProjectId ||
			JSON.stringify(binding.context.git) !== JSON.stringify(context.git) ||
			JSON.stringify(binding.context.nativeRootDescriptor) !==
				JSON.stringify(context.nativeRootDescriptor)
		)
			throw workspaceConflict("Workspace binding identity changed");
	},
	async assertCurrent(
		id: string,
		context: WorkspaceContext,
		options: ActorOptions = {},
	): Promise<void> {
		this.assertCurrentSync(id, context, options);
		const binding = requireBinding(readDeviceWorkspaceBinding(db, id, context.deviceId));
		await fresh(id, binding.context, options);
		this.assertCurrentSync(id, context, options);
	},
	async set(id: string, request: SetNarratorDeviceWorkspaceRequest, options: MutationOptions) {
		return mutate(id, "set", request, options);
	},
	async select(
		id: string,
		request: SelectNarratorDeviceWorkspaceRequest,
		options: MutationOptions,
	) {
		return mutate(id, "select", request, options);
	},
	async getRequest(id: string, requestId: string, options: ActorOptions = {}) {
		const { actor } = await authority(id, options, "read");
		const receipt = await db.query.narratorDeviceWorkspaceRequests.findFirst({
			where: and(eq(receipts.narratorId, id), eq(receipts.requestId, requestId)),
		});
		if (receipt) {
			if (receipt.actorUserId !== actor)
				throw workspaceConflict(
					"Workspace request belongs to its original actor",
					"WORKSPACE_REQUEST_CONFLICT",
				);
			await fresh(id, receipt.result.binding.context, { userId: actor });
		}
		return receipt;
	},
	async recoverRequest(
		id: string,
		requestId: string,
		options: MutationOptions,
	): Promise<NarratorDeviceWorkspaceMutationResult> {
		const { actor } = await authority(id, options, "write");
		const receipt = await this.getRequest(id, requestId, { userId: actor });
		if (!receipt) throw new NotFoundError("Device workspace request", requestId);
		if (receipt.actorUserId !== actor)
			throw workspaceConflict(
				"Workspace recovery belongs to its original actor",
				"WORKSPACE_REQUEST_CONFLICT",
			);
		await fresh(id, receipt.result.binding.context, { userId: actor }, "write");
		if (receipt.installState !== "pending") return receipt.result;
		const current = receipt.result.selection?.current;
		if (!current) throw workspaceConflict("Pending request has no selection");
		const check = () => {
			if (
				activeNarrators.get(id)?._loopRunning ||
				isNarratorRevertAdmissionBlocked(id) ||
				compactLocks.has(id) ||
				[...pendingPermissions.values(), ...pendingDangerReflections.values()].some(
					(pending) => pending.narratorId === id,
				)
			)
				throw workspaceConflict("Workspace recovery is busy", "WORKSPACE_CONTEXT_BUSY");
		};
		check();
		return withNarratorMutationAdmission(
			id,
			async () => {
				check();
				await fresh(id, current, { userId: actor }, "write");
				const { row } = await authority(id, { userId: actor }, "write");
				if (
					row.workspaceRevision !== current.revision ||
					row.workspaceContext?.binding?.bindingKey !== current.binding?.bindingKey
				) {
					await db
						.update(receipts)
						.set({ installState: "superseded", updatedAt: new Date().toISOString() })
						.where(eq(receipts.id, receipt.id));
					return receipt.result;
				}
				try {
					await installWorkspaceContext(id, current);
					await db
						.update(receipts)
						.set({ installState: "installed", updatedAt: new Date().toISOString() })
						.where(eq(receipts.id, receipt.id));
				} catch (error) {
					pauseWorkspace(id);
					throw error;
				}
				return receipt.result;
			},
			{ failIfBusy: true },
		);
	},
};
