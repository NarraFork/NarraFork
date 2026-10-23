import { AsyncLocalStorage } from "node:async_hooks";
import {
	FILE_CHANGE_LIMITS,
	type FileChangeActor,
	type FileChangeIdentity,
	type FileChangeState,
	fileChangeStatesEqual,
} from "@shared/file-change-protocol";
import {
	type RemoteHistoryBackend,
	type RemoteHistoryBinding,
	type RemoteHistoryOperations,
	type RemoteHistoryReceipt,
	remoteHistoryFileState,
} from "@shared/remote-history-protocol";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { db as applicationDb } from "../db";
import {
	fileAttributions,
	fileChangeOperations,
	fileChangeScopes,
	narrators,
	narratorToolCalls,
	workspaceWriteLeases,
} from "../db/schema";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import { resolveBackend } from "../lib/agent/execution/registry";
import type { ToolResult } from "../lib/agent/types";
import { generateId } from "../lib/id";
import type { EditorActor, EditorBinding, RemoteEditorAdapter } from "./editor-document-service";
import {
	type BeginFileChangeOperation,
	type FileChangeEffectRecord,
	FileChangeEvidenceService,
	type FileChangeScopeRecord,
} from "./file-change-evidence";
import { createFileChangeIdentity } from "./file-change-identity";
import {
	type FileChangeCompletion,
	getDefaultLocalFileChangeRuntime,
	hashLocalFileChangeRequest,
	type LocalFileChangeRequest,
	type LocalFileChangeRuntime,
	localFileChangeRuntimeBinding,
} from "./file-change-runtime";
import { createRemoteEditorAdapter } from "./remote-editor-adapter";
import { RemoteFileChangeRuntime } from "./remote-file-change-runtime";
import {
	createPersistentRemoteHistoryJournal,
	type RemoteHistoryMetadataStore,
} from "./remote-history-journal";
import {
	currentRemoteRecoveryAuthProvenance,
	type RemoteRecoveryAuthProvenance,
} from "./remote-history-recovery-auth";
import {
	assertRemoteHistoryBinding,
	isRemoteHistoryNoDispatchError,
	RemoteHistoryService,
} from "./remote-history-service";
import {
	checkWindowsEditorSession,
	preflightWindowsEditorMetadata,
} from "./windows-editor-metadata-preflight";
import {
	type WorkspaceRuntimeBinding,
	WorkspaceWriteCoordinator,
	type WorkspaceWriteLease,
} from "./workspace-write-coordinator";

export const REMOTE_HISTORY_INLINE_WRITE_BYTES = 512 * 1024;
export function remoteHistoryWriteBudget(
	backend: Pick<RemoteHistoryBackend, "supportsRemoteObjectStage">,
): number {
	return backend.supportsRemoteObjectStage
		? FILE_CHANGE_LIMITS.blobBytes
		: REMOTE_HISTORY_INLINE_WRITE_BYTES;
}
type RuntimeDb = typeof applicationDb;
type Namespace = Awaited<ReturnType<LocalFileChangeRuntime["verifyNamespace"]>>;
export interface RemoteHistoryActor {
	userId: string;
	narratorId: string;
	projectId: string | null;
	kind: "human" | "primary" | "subagent";
	toolName?: "Write" | "Edit" | "StructSed";
}
export interface RemoteHistoryTarget {
	deviceId: string;
	cwd: string;
	lexicalPath: string;
	canonicalPath: string;
	runtimeGeneration: number;
	rootIdentity?: string;
}
export interface RemoteWorkspaceHistoryOptions {
	db: RuntimeDb;
	/** Server audit-copy store only; NEVER used to resolve a remote workspace path. */
	auditRuntime: LocalFileChangeRuntime;
	backend(deviceId: string): ExecutionBackend;
	authorize(
		actor: Readonly<RemoteHistoryActor>,
		target: Readonly<RemoteHistoryTarget>,
		need: "read" | "write",
		signal: AbortSignal,
	): Promise<void>;
	metadataStore?: RemoteHistoryMetadataStore;
	coordinatorState?: ConstructorParameters<typeof WorkspaceWriteCoordinator>[0]["state"];
}
export interface RemoteHistoryEndpoint {
	runtime: RemoteFileChangeRuntime;
	identity: FileChangeIdentity;
	scope: FileChangeScopeRecord;
	assertCurrent(signal: AbortSignal): Promise<void>;
}

/** Persistent source-qualified composition. No current-cwd lookup, default allow or IO fallback. */
export class RemoteWorkspaceHistoryRuntime {
	readonly evidence: FileChangeEvidenceService;
	readonly coordinator: WorkspaceWriteCoordinator;
	constructor(readonly options: RemoteWorkspaceHistoryOptions) {
		this.evidence = new FileChangeEvidenceService(options.db);
		this.coordinator = new WorkspaceWriteCoordinator({
			db: options.db,
			state: options.coordinatorState,
			readRuntime: (deviceId) => this.runtimeBinding(deviceId),
		});
	}
	runtimeBinding(deviceId: string): WorkspaceRuntimeBinding | null {
		if (deviceId === "local") return localFileChangeRuntimeBinding(deviceId);
		try {
			const backend = this.options.backend(deviceId);
			if (backend.kind !== "remote") return null;
			return {
				runtimeEpoch: `remote:${deviceId}:${backend.runtimeGeneration}`,
				runtimeGeneration: backend.runtimeGeneration,
			};
		} catch {
			return null;
		}
	}
	async auditNamespace(signal: AbortSignal) {
		await this.options.auditRuntime.initialize();
		return this.options.auditRuntime.verifyNamespace(signal);
	}

	private backend(target: RemoteHistoryTarget): ExecutionBackend & RemoteHistoryBackend {
		const backend = this.options.backend(target.deviceId);
		if (
			backend.kind !== "remote" ||
			!backend.supportsRemoteHistory ||
			(backend.pathFlavor !== "posix" && backend.pathFlavor !== "windows") ||
			!backend.remoteHistory ||
			backend.runtimeGeneration !== target.runtimeGeneration ||
			!backend.paths.isAbsolute(target.cwd) ||
			!backend.paths.isAbsolute(target.canonicalPath) ||
			!backend.paths.isAbsolute(target.lexicalPath)
		)
			throw new Error("Remote history endpoint unavailable or changed; no plain-write fallback");
		return backend as ExecutionBackend & RemoteHistoryBackend;
	}
	private assertRpcOrigin<K extends keyof RemoteHistoryOperations>(
		backend: ExecutionBackend,
		target: RemoteHistoryTarget,
		kind: K,
		request: RemoteHistoryOperations[K]["request"],
	) {
		if (kind === "open") {
			const root = (request as RemoteHistoryOperations["open"]["request"]).root;
			const selectedRoot = backend.paths.contains(target.cwd, target.canonicalPath)
				? target.cwd
				: backend.paths.dirname(target.canonicalPath);
			if (!backend.paths.equals(root, selectedRoot))
				throw new Error("Remote history open escaped the admitted file root");
			return;
		}
		if (!("binding" in request))
			throw new Error("Remote history request needs its original binding");
		const root = request.binding.root;
		if (!backend.paths.contains(root, target.canonicalPath))
			throw new Error("Remote history binding does not contain its admitted file");
		const rootOnly = backend.paths.equals(root, target.canonicalPath);
		if (rootOnly && ["mutate", "restore", "compensate", "objectStage"].includes(kind))
			throw new Error("Root metadata/capture admission is not file-mutation authority");
		if (kind === "objectRead" && rootOnly)
			throw new Error(
				"Workspace capture admission is not raw-file read authority; resolve a recorded file identity",
			);
		if (kind === "objectRead" || kind === "objectStage") {
			const object = (request as RemoteHistoryOperations["objectRead"]["request"]).object;
			if (
				object.kind !== "blob" ||
				(!rootOnly &&
					!backend.paths.equals(backend.paths.resolve(root, object.path), target.canonicalPath))
			)
				throw new Error(
					"Remote history object is not from the exact admitted file; whole trees remain resident",
				);
		}
		if (!rootOnly) {
			if (kind === "captureTree")
				throw new Error("A single-file grant cannot capture its parent tree");
			const paths = "paths" in request ? request.paths : undefined;
			const changes = "changes" in request ? request.changes : undefined;
			for (const path of [...(paths ?? []), ...(changes?.map((change) => change.path) ?? [])])
				if (!backend.paths.equals(backend.paths.resolve(root, path), target.canonicalPath))
					throw new Error("Remote history request contains an unadmitted sibling path");
		}
	}

	private authorizedBackend(
		actor: RemoteHistoryActor,
		target: RemoteHistoryTarget,
		need: "read" | "write",
		assertScope?: () => void,
	): ExecutionBackend & RemoteHistoryBackend {
		const backend = this.backend(target);
		const registry = this;
		return Object.assign(Object.create(backend) as ExecutionBackend & RemoteHistoryBackend, {
			async remoteHistory<K extends keyof RemoteHistoryOperations>(
				kind: K,
				request: RemoteHistoryOperations[K]["request"],
				signal?: AbortSignal,
			): Promise<RemoteHistoryOperations[K]["result"]> {
				const bounded = signal ?? AbortSignal.timeout(120_000);
				bounded.throwIfAborted();
				registry.assertRpcOrigin(backend, target, kind, request);
				const rpcNeed =
					kind === "mutate" ||
					kind === "restore" ||
					kind === "compensate" ||
					kind === "finalize" ||
					kind === "objectStage"
						? "write"
						: kind === "open"
							? need
							: "read";
				await registry.options.authorize(actor, target, rpcNeed, bounded);
				registry.backend(target);
				assertScope?.();
				// No user callback is allowed to change the canonical endpoint after authorization.
				const resolved = await backend.resolvePathIdentity(target.lexicalPath, {
					signal: bounded,
					timeoutMs: 5_000,
				});
				if (
					!backend.paths.equals(resolved.canonicalPath, target.canonicalPath) ||
					resolved.runtimeGeneration !== target.runtimeGeneration
				)
					throw new Error("Remote history canonical target changed");
				registry.backend(target);
				assertScope?.();
				registry.assertRpcOrigin(backend, target, kind, request);
				return backend.remoteHistory(kind, request, bounded);
			},
		});
	}
	private history(backend: ExecutionBackend & RemoteHistoryBackend, binding: RemoteHistoryBinding) {
		return new RemoteHistoryService(
			backend,
			binding,
			createPersistentRemoteHistoryJournal(backend.deviceId, binding, {
				store: this.options.metadataStore,
			}),
		);
	}
	private async openScope(
		actor: RemoteHistoryActor,
		target: RemoteHistoryTarget,
		need: "read" | "write",
		signal: AbortSignal,
		recorded?: FileChangeIdentity,
		metadataOnly = false,
		partialRevert = false,
	) {
		actor = Object.freeze({ ...actor });
		target = Object.freeze({ ...target });
		await this.options.authorize(actor, target, need, signal);
		let scope: FileChangeScopeRecord;
		let binding: RemoteHistoryBinding;
		const backend = this.authorizedBackend(actor, target, need);
		// Outside-cwd execution already has an actual frozen authorization. Give it its
		// own physical root/scope rather than attaching ../ evidence to the current workspace.
		const historyRoot = backend.paths.contains(target.cwd, target.canonicalPath)
			? target.cwd
			: backend.paths.dirname(target.canonicalPath);
		if (recorded) {
			const stored = this.evidence.getScope(recorded.scopeId);
			if (
				!stored ||
				stored.sourceInstanceId !== recorded.sourceInstanceId ||
				stored.workspaceInstanceId !== recorded.workspaceInstanceId ||
				stored.deviceId !== recorded.deviceId ||
				stored.canonicalRoot !== historyRoot ||
				(stored.status !== "active" && !(partialRevert && stored.status === "needs_verification"))
			)
				throw new Error("Recorded remote source/scope unavailable");
			scope = stored;
			binding = await backend.remoteHistory(
				"open",
				{ root: scope.canonicalRoot, scopeId: scope.id, fence: Math.max(1, scope.fencingToken) },
				signal,
			);
			this.assertScope(scope, binding);
		} else {
			// Reuse an existing admitted scope without creating an orphan remote scope on every read.
			const candidates = this.options.db
				.select()
				.from(fileChangeScopes)
				.where(
					and(
						eq(fileChangeScopes.deviceId, target.deviceId),
						eq(fileChangeScopes.canonicalRoot, historyRoot),
						partialRevert
							? sql`${fileChangeScopes.status} in ('active', 'needs_verification')`
							: eq(fileChangeScopes.status, "active"),
					),
				)
				.limit(2)
				.all();
			if (candidates.length > 1)
				throw new Error("Remote root has ambiguous source-qualified scopes");
			const candidate = candidates[0];
			if ((candidate?.activeLeaseId || candidate?.activeMutationCount) && !metadataOnly)
				throw new Error("Remote scope retains a durable barrier");
			// First open obtains real persistent source/root identities, rather than hashing cwd into an incarnation.
			const probe = await backend.remoteHistory(
				"open",
				{
					root: historyRoot,
					scopeId: candidate?.id ?? generateId(),
					fence: Math.max(1, candidate?.fencingToken ?? 1),
				},
				signal,
			);
			if (candidate) this.assertScope(candidate, probe);
			const stored = this.options.db
				.select()
				.from(fileChangeScopes)
				.where(
					and(
						eq(fileChangeScopes.sourceInstanceId, probe.sourceInstanceId),
						eq(fileChangeScopes.deviceId, target.deviceId),
						eq(fileChangeScopes.workspaceInstanceId, probe.workspaceInstanceId),
					),
				)
				.get();
			if (stored) {
				if (
					(stored.status !== "active" &&
						!(partialRevert && stored.status === "needs_verification")) ||
					(!metadataOnly && (stored.activeLeaseId || stored.activeMutationCount))
				)
					throw new Error("Remote scope requires reconciliation; no TTL/PID release");
				scope = stored;
				binding = await backend.remoteHistory(
					"open",
					{ root: historyRoot, scopeId: stored.id, fence: Math.max(1, stored.fencingToken) },
					signal,
				);
				this.assertScope(scope, binding);
			} else {
				binding = probe;
				scope = this.evidence.prepareScope({
					id: binding.scopeId,
					sourceInstanceId: binding.sourceInstanceId,
					deviceId: target.deviceId,
					workspaceInstanceId: binding.workspaceInstanceId,
					canonicalRoot: binding.root,
					pathFlavor: backend.pathFlavor === "windows" ? "windows" : "posix",
				});
				scope = this.evidence.recordScopeVerification({
					scopeId: scope.id,
					canonicalRoot: binding.root,
					rootIdentity: { object: binding.rootIdentity },
				});
				this.options.db
					.update(fileChangeScopes)
					.set({ fencingToken: binding.fence })
					.where(eq(fileChangeScopes.id, scope.id))
					.run();
				scope = this.evidence.getScope(scope.id) as FileChangeScopeRecord;
			}
		}
		if (target.rootIdentity && target.rootIdentity !== binding.rootIdentity)
			throw new Error("Remote workspace root replaced");
		return { scope, binding, backend };
	}

	/** Human create-only streaming attachments use the real write-only scope/fence;
	 * no secret file/tree read grant and no borrowed server blob-source identity. */
	async withAttachmentLease<T>(
		actor: RemoteHistoryActor,
		target: RemoteHistoryTarget,
		signal: AbortSignal,
		body: (endpoint: {
			backend: ExecutionBackend;
			binding: RemoteHistoryBinding;
			scope: FileChangeScopeRecord;
			identity: FileChangeIdentity;
			lease: WorkspaceWriteLease;
			assertCurrent(): Promise<void>;
		}) => Promise<T>,
	): Promise<T> {
		if (actor.kind !== "human") throw new Error("Attachment creation requires a real human actor");
		actor = Object.freeze({ ...actor });
		target = Object.freeze({ ...target });
		const endpoint = await this.resolve(actor, target, "write", signal);
		const runtime = this.runtimeBinding(target.deviceId);
		if (!runtime || runtime.runtimeGeneration !== target.runtimeGeneration)
			throw new Error("Attachment connection changed");
		return this.coordinator.withWrite(
			{
				scope: endpoint.scope,
				runtime,
				signal,
				executionClass: "unknown",
				ranges: [{ kind: "subtree", canonicalPath: endpoint.scope.canonicalRoot }],
			},
			async (lease) => {
				const backend = this.backend(target);
				const assertCurrent = async () => {
					await this.options.authorize(actor, target, "write", signal);
					this.backend(target);
					lease.assertCurrent();
					const path = await backend.resolvePathIdentity(target.lexicalPath, {
						signal,
						timeoutMs: 5_000,
					});
					if (
						!backend.paths.equals(path.canonicalPath, target.canonicalPath) ||
						path.runtimeGeneration !== target.runtimeGeneration
					)
						throw new Error("Attachment canonical identity changed");
					lease.assertCurrent();
				};
				await assertCurrent();
				const binding = await backend.remoteHistory(
					"open",
					{
						root: endpoint.scope.canonicalRoot,
						scopeId: endpoint.scope.id,
						fence: lease.executionBinding.fencingToken,
					},
					signal,
				);
				this.assertScope(endpoint.scope, binding);
				if (binding.fence !== lease.executionBinding.fencingToken)
					throw new Error("Attachment native fence mismatch");
				await assertCurrent();
				return body({
					backend,
					binding,
					scope: endpoint.scope,
					identity: endpoint.identity,
					lease,
					assertCurrent,
				});
			},
		);
	}

	/** Fixed, individually authorized manifest files sharing ONE native scope/fence. */
	async resolveBatchHistory(
		actor: RemoteHistoryActor,
		targets: readonly RemoteHistoryTarget[],
		scope: FileChangeScopeRecord,
		lease: WorkspaceWriteLease,
		signal: AbortSignal,
	) {
		if (!targets.length || targets.length > FILE_CHANGE_LIMITS.revertFiles)
			throw new Error("Remote batch target budget exceeded");
		actor = Object.freeze({ ...actor });
		const fixed = targets.map((target) => Object.freeze({ ...target }));
		const backend = this.backend(fixed[0]);
		const keys = new Set(fixed.map((target) => backend.paths.identityKey(target.canonicalPath)));
		if (
			keys.size !== fixed.length ||
			fixed.some(
				(target) =>
					target.deviceId !== scope.deviceId ||
					target.runtimeGeneration !== lease.executionBinding.runtimeGeneration ||
					!backend.paths.contains(scope.canonicalRoot, target.canonicalPath) ||
					backend.paths.equals(scope.canonicalRoot, target.canonicalPath),
			)
		)
			throw new Error("Remote batch targets do not match the admitted scope/fence");
		const authorize = async (need: "read" | "write", currentSignal: AbortSignal) => {
			for (const target of fixed) {
				await this.options.authorize(actor, target, need, currentSignal);
				this.backend(target);
				lease.assertCurrent();
				const path = await backend.resolvePathIdentity(target.lexicalPath, {
					signal: currentSignal,
					timeoutMs: 5_000,
				});
				if (
					!backend.paths.equals(path.canonicalPath, target.canonicalPath) ||
					path.runtimeGeneration !== target.runtimeGeneration
				)
					throw new Error("Remote batch canonical target changed");
			}
			lease.assertCurrent();
		};
		await authorize("write", signal);
		const binding = await backend.remoteHistory(
			"open",
			{ root: scope.canonicalRoot, scopeId: scope.id, fence: lease.executionBinding.fencingToken },
			signal,
		);
		this.assertScope(scope, binding);
		if (binding.fence !== lease.executionBinding.fencingToken)
			throw new Error("Remote batch opened another fence");
		const admitted = Object.assign(
			Object.create(backend) as ExecutionBackend & RemoteHistoryBackend,
			{
				async remoteHistory<K extends keyof RemoteHistoryOperations>(
					kind: K,
					request: RemoteHistoryOperations[K]["request"],
					requestedSignal?: AbortSignal,
				): Promise<RemoteHistoryOperations[K]["result"]> {
					const bounded = requestedSignal ?? AbortSignal.timeout(120_000);
					if (
						!(
							[
								"restore",
								"compensate",
								"status",
								"finalize",
								"objectRead",
								"objectStage",
								"inspect",
							] as string[]
						).includes(kind) ||
						!("binding" in request)
					)
						throw new Error("Remote batch cannot expand its primitive capabilities");
					assertRemoteHistoryBinding(binding, request.binding);
					const names = [
						...("paths" in request ? (request.paths ?? []) : []),
						...("changes" in request ? (request.changes?.map((change) => change.path) ?? []) : []),
						...("object" in request ? [request.object.path] : []),
					];
					if ("object" in request && request.object.kind !== "blob")
						throw new Error("Remote batch cannot read parent trees");
					for (const path of names)
						if (!keys.has(backend.paths.identityKey(backend.paths.resolve(binding.root, path))))
							throw new Error("Remote batch primitive contains an unadmitted file");
					await authorize(
						["restore", "compensate", "finalize", "objectStage"].includes(kind) ? "write" : "read",
						bounded,
					);
					return backend.remoteHistory(kind, request, bounded);
				},
			},
		);
		return this.history(admitted, binding);
	}

	/** Purpose-bound snapshot metadata reader. Root approval never becomes raw-file
	 * read or mutation authority; each tree entry is authorized separately by restore. */
	async resolveSnapshotIndexHistory(
		actor: RemoteHistoryActor,
		original: RemoteHistoryBinding,
		deviceId: string,
		signal: AbortSignal,
		purpose: "tree_index" | "snapshot_read_observation",
	) {
		if (purpose !== "tree_index" && purpose !== "snapshot_read_observation")
			throw new Error("Explicit tree-index read purpose required");
		actor = Object.freeze({ ...actor });
		original = Object.freeze({ ...original });
		const scope = this.evidence.getScope(original.scopeId);
		if (
			!scope ||
			scope.deviceId !== deviceId ||
			(scope.status !== "active" && scope.status !== "needs_verification")
		)
			throw new Error("Recorded snapshot source scope unavailable");
		this.assertScope(scope, original);
		const backend = this.options.backend(deviceId);
		const target: RemoteHistoryTarget = Object.freeze({
			deviceId,
			cwd: original.root,
			lexicalPath: original.root,
			canonicalPath: original.root,
			runtimeGeneration: backend.runtimeGeneration,
			rootIdentity: original.rootIdentity,
		});
		const authorize = async (currentSignal: AbortSignal) => {
			await this.options.authorize(actor, target, "read", currentSignal);
			this.backend(target);
			const current = this.evidence.getScope(scope.id);
			if (!current || (current.status !== "active" && current.status !== "needs_verification"))
				throw new Error("Snapshot scope unavailable");
			this.assertScope(current, original);
			const opened = await backend.remoteHistory?.(
				"open",
				{
					root: original.root,
					scopeId: original.scopeId,
					fence: Math.max(1, current.fencingToken),
				},
				currentSignal,
			);
			if (!opened) throw new Error("Snapshot native source unavailable");
			this.assertScope(current, opened);
			if (original.fence > opened.fence) throw new Error("Snapshot has an unproven future fence");
		};
		await authorize(signal);
		const admitted = Object.assign(
			Object.create(backend) as ExecutionBackend & RemoteHistoryBackend,
			{
				async remoteHistory<K extends keyof RemoteHistoryOperations>(
					kind: K,
					request: RemoteHistoryOperations[K]["request"],
					requestedSignal?: AbortSignal,
				): Promise<RemoteHistoryOperations[K]["result"]> {
					const bounded = requestedSignal ?? AbortSignal.timeout(10_000);
					if (
						kind !== "objectRead" ||
						!("object" in request) ||
						request.object.kind !== "tree" ||
						request.object.path !== "" ||
						!("binding" in request)
					)
						throw new Error("Snapshot index capability cannot read blobs or write files");
					assertRemoteHistoryBinding(original, request.binding);
					await authorize(bounded);
					if (!backend.remoteHistory) throw new Error("Snapshot history unavailable");
					return backend.remoteHistory(kind, request, bounded);
				},
			},
		);
		const history = this.history(admitted, original);
		return Object.freeze({
			readTreeIndex: (
				object: RemoteHistoryOperations["objectRead"]["request"]["object"],
				currentSignal: AbortSignal,
			) => {
				if (object.kind !== "tree" || object.path !== "" || object.sizeBytes > 4 * 1024 * 1024)
					throw new Error("Tree-index frame capability cannot read raw files or oversized frames");
				return history.readObject(object, currentSignal);
			},
		});
	}

	/** Original-fence recovery only: never upgrades an old receipt to a new connection/fence. */
	async resolveRecoveryHistory(
		actor: RemoteHistoryActor,
		identity: FileChangeIdentity,
		fencingToken: number,
		signal: AbortSignal,
	) {
		const scope = this.evidence.getScope(identity.scopeId);
		if (
			!scope ||
			scope.sourceInstanceId !== identity.sourceInstanceId ||
			scope.workspaceInstanceId !== identity.workspaceInstanceId ||
			scope.deviceId !== identity.deviceId ||
			!scope.rootIdentityJson?.object
		)
			throw new Error("Recovery provenance unavailable");
		const backend = this.options.backend(identity.deviceId);
		const target: RemoteHistoryTarget = Object.freeze({
			deviceId: identity.deviceId,
			cwd: scope.canonicalRoot,
			lexicalPath: identity.lexicalPath,
			canonicalPath: identity.canonicalPath,
			runtimeGeneration: backend.runtimeGeneration,
			rootIdentity: scope.rootIdentityJson.object,
		});
		const admitted = this.authorizedBackend(Object.freeze({ ...actor }), target, "read");
		const binding = await admitted.remoteHistory(
			"open",
			{ root: scope.canonicalRoot, scopeId: scope.id, fence: fencingToken },
			signal,
		);
		this.assertScope(scope, binding);
		if (binding.fence !== fencingToken) throw new Error("Original recovery fence changed");
		const historyBackend = Object.assign(
			Object.create(admitted) as ExecutionBackend & RemoteHistoryBackend,
			{
				async remoteHistory<K extends keyof RemoteHistoryOperations>(
					kind: K,
					request: RemoteHistoryOperations[K]["request"],
					currentSignal?: AbortSignal,
				): Promise<RemoteHistoryOperations[K]["result"]> {
					if (!["status", "objectRead", "finalize", "compensate"].includes(kind))
						throw new Error("Recovery cannot dispatch fresh remote writes");
					return admitted.remoteHistory(kind, request, currentSignal);
				},
			},
		);
		return { history: this.history(historyBackend, binding), scope };
	}

	/** Read-only post-state capture at an original quarantined fence. This narrow
	 * capability cannot read blobs, mutate files, finalize, or advance the fence. */
	async resolveRecoveryTreeCaptureHistory(
		actor: RemoteHistoryActor,
		original: RemoteHistoryBinding,
		deviceId: string,
		policy: NonNullable<RemoteHistoryOperations["captureTree"]["request"]["treePolicy"]>,
		signal: AbortSignal,
	) {
		const backend = this.options.backend(deviceId);
		const target: RemoteHistoryTarget = Object.freeze({
			deviceId,
			cwd: original.root,
			lexicalPath: original.root,
			canonicalPath: original.root,
			runtimeGeneration: backend.runtimeGeneration,
			rootIdentity: original.rootIdentity,
		});
		const policyJson = JSON.stringify(policy);
		const assertHeld = () => {
			const scope = this.evidence.getScope(original.scopeId);
			const held = this.options.db
				.select({ fence: workspaceWriteLeases.fencingToken })
				.from(workspaceWriteLeases)
				.where(
					and(
						eq(workspaceWriteLeases.scopeId, original.scopeId),
						eq(workspaceWriteLeases.deviceId, deviceId),
						sql`${workspaceWriteLeases.status} in ('executing','quarantined')`,
					),
				)
				.limit(2)
				.all();
			if (
				!scope ||
				!["active", "needs_verification"].includes(scope.status) ||
				scope.deviceId !== deviceId ||
				scope.fencingToken !== original.fence ||
				held.length !== 1 ||
				held[0].fence !== original.fence
			)
				throw new Error("Recovery capture requires the original retained workspace barrier");
			this.assertScope(scope, original);
		};
		const admitted = this.authorizedBackend(
			Object.freeze({ ...actor }),
			target,
			"read",
			assertHeld,
		);
		const binding = await admitted.remoteHistory(
			"open",
			{ root: original.root, scopeId: original.scopeId, fence: original.fence },
			signal,
		);
		assertRemoteHistoryBinding(original, binding);
		const captureOnly = Object.assign(
			Object.create(admitted) as ExecutionBackend & RemoteHistoryBackend,
			{
				async remoteHistory<K extends keyof RemoteHistoryOperations>(
					kind: K,
					request: RemoteHistoryOperations[K]["request"],
					currentSignal?: AbortSignal,
				): Promise<RemoteHistoryOperations[K]["result"]> {
					if (
						kind !== "captureTree" ||
						!("treePolicy" in request) ||
						JSON.stringify(request.treePolicy) !== policyJson ||
						!("binding" in request)
					)
						throw new Error(
							"Recovery tree capability is only the approved read-only capture policy",
						);
					assertRemoteHistoryBinding(original, request.binding);
					return admitted.remoteHistory(kind, request, currentSignal);
				},
			},
		);
		return this.history(captureOnly, binding);
	}

	/** Metadata-only root reauthorization, safe inside an existing admitted write.
	 * Never grants mutation, releases a barrier, or resurrects needs_verification. */
	async verifyWorkspaceRoot(
		actor: RemoteHistoryActor,
		target: RemoteHistoryTarget,
		signal: AbortSignal,
	) {
		const { binding, backend } = await this.openScope(
			Object.freeze({ ...actor }),
			Object.freeze({ ...target }),
			"read",
			signal,
			undefined,
			true,
		);
		return { rootIdentity: binding.rootIdentity, maxWriteBytes: remoteHistoryWriteBudget(backend) };
	}

	/** Real whole-workspace identity, for capture hooks; no invented sentinel file. */
	async resolveWorkspace(
		actor: RemoteHistoryActor,
		target: RemoteHistoryTarget,
		signal: AbortSignal,
		lease?: WorkspaceWriteLease,
		partialRevert = false,
	) {
		actor = Object.freeze({ ...actor });
		target = Object.freeze({ ...target });
		const { scope, binding } = await this.openScope(
			actor,
			target,
			"read",
			signal,
			undefined,
			Boolean(lease),
			partialRevert,
		);
		if (
			lease &&
			(lease.scope.id !== scope.id ||
				lease.executionBinding.deviceId !== scope.deviceId ||
				lease.executionBinding.fencingToken !== binding.fence)
		)
			throw new Error("Workspace capture cannot borrow another restore lease");
		lease?.assertCurrent();
		const guarded = this.authorizedBackend(actor, target, "read", () => {
			const current = this.evidence.getScope(scope.id);
			if (
				!current ||
				(current.status !== "active" &&
					!(partialRevert && current.status === "needs_verification")) ||
				current.fencingToken !== binding.fence ||
				(!lease && (current.activeLeaseId || current.activeMutationCount))
			)
				throw new Error("Remote capture scope/fence busy or changed");
			lease?.assertCurrent();
			this.assertScope(current, binding);
		});
		const runtimeBinding = this.runtimeBinding(scope.deviceId);
		if (!runtimeBinding) throw new Error("Remote capture connection unavailable");
		return {
			history: this.history(guarded, binding),
			scope,
			runtimeBinding,
			coordinator: this.coordinator,
		};
	}

	async resolve(
		actor: RemoteHistoryActor,
		target: RemoteHistoryTarget,
		need: "read" | "write",
		signal: AbortSignal,
		recorded?: FileChangeIdentity,
		partialRevert = false,
	): Promise<RemoteHistoryEndpoint> {
		actor = Object.freeze({ ...actor });
		target = Object.freeze({ ...target });
		const { scope, binding, backend } = await this.openScope(
			actor,
			target,
			need,
			signal,
			recorded,
			false,
			partialRevert,
		);
		const identity =
			recorded ??
			createFileChangeIdentity(scope, {
				deviceId: target.deviceId,
				pathFlavor: backend.paths.flavor,
				lexicalPath: target.lexicalPath,
				canonicalPath: target.canonicalPath,
				objectRole: "referent",
			});
		const assertCurrent = async (currentSignal: AbortSignal) => {
			await this.options.authorize(actor, target, need, currentSignal);
			this.backend(target);
			const current = this.evidence.getScope(scope.id);
			if (
				!current ||
				(current.status !== "active" &&
					!(partialRevert && current.status === "needs_verification")) ||
				current.revision !== scope.revision ||
				current.activeLeaseId ||
				current.activeMutationCount
			)
				throw new Error("Remote scope changed or has a durable barrier");
			this.assertScope(current, binding);
		};
		const guarded = this.authorizedBackend(actor, target, need, () => {
			const current = this.evidence.getScope(scope.id);
			if (
				!current ||
				(current.status !== "active" && !(partialRevert && current.status === "needs_verification"))
			)
				throw new Error("Remote scope unavailable");
			this.assertScope(current, binding);
		});
		const history = this.history(guarded, binding);
		const registry = this;
		class BoundRuntime extends RemoteFileChangeRuntime {
			override execute<Result>(
				input: Parameters<RemoteFileChangeRuntime["execute"]>[0] & {
					construct: (
						before: Parameters<Parameters<RemoteFileChangeRuntime["execute"]>[0]["construct"]>[0],
					) =>
						| Promise<{ nextBytes: Uint8Array; result: Result }>
						| { nextBytes: Uint8Array; result: Result };
				},
			): Promise<{ result: Result; receipt: RemoteHistoryReceipt }> {
				return registry.execute(
					actor,
					target,
					scope,
					identity,
					input as Parameters<RemoteFileChangeRuntime["execute"]>[0],
				) as Promise<{ result: Result; receipt: RemoteHistoryReceipt }>;
			}
		}
		const runtime = new BoundRuntime(history, backend);
		runtime.relativePath(identity);
		return { runtime, identity, scope, assertCurrent };
	}
	private assertScope(scope: FileChangeScopeRecord, binding: RemoteHistoryBinding) {
		if (
			scope.id !== binding.scopeId ||
			scope.sourceInstanceId !== binding.sourceInstanceId ||
			scope.workspaceInstanceId !== binding.workspaceInstanceId ||
			scope.canonicalRoot !== binding.root ||
			scope.rootIdentityJson?.object !== binding.rootIdentity
		)
			throw new Error("Remote source/workspace/root identity mismatch");
	}
	async importState(
		namespace: Namespace,
		state: FileChangeState,
		bytes: Uint8Array | null,
		signal: AbortSignal,
	) {
		if (state.kind === "absent") {
			if (bytes !== null) throw new Error("Absent state has bytes");
			return;
		}
		if (state.kind !== "regular" || !bytes || bytes.byteLength !== state.blob.sizeBytes)
			throw new Error("Remote audit-copy unavailable");
		const stored = await namespace.store.putBytes(bytes, {
			signal,
			expectedSize: bytes.byteLength,
		});
		if (stored.digest !== state.blob.digest || stored.sizeBytes !== state.blob.sizeBytes)
			throw new Error("Remote audit-copy digest mismatch");
	}
	private async execute(
		actor: RemoteHistoryActor,
		target: RemoteHistoryTarget,
		scope: FileChangeScopeRecord,
		identity: FileChangeIdentity,
		input: Parameters<RemoteFileChangeRuntime["execute"]>[0],
	) {
		const runtime = this.runtimeBinding(target.deviceId);
		if (!runtime || runtime.runtimeGeneration !== target.runtimeGeneration)
			throw new Error("Remote connection changed");
		return this.coordinator.withWrite(
			{
				scope,
				runtime,
				signal: input.signal,
				// The native v1 journal owns a scope-wide fence, not independent range fences.
				// Admission is conservative; the actual effect stays one exact file.
				ranges: [{ canonicalPath: scope.canonicalRoot, kind: "subtree" }],
				executionClass: "unknown",
			},
			async (lease) => {
				const guarded = this.authorizedBackend(actor, target, "write", () => lease.assertCurrent());
				const binding = await guarded.remoteHistory(
					"open",
					{
						root: scope.canonicalRoot,
						scopeId: scope.id,
						fence: lease.executionBinding.fencingToken,
					},
					input.signal,
				);
				this.assertScope(scope, binding);
				const history = this.history(guarded, binding);
				const remote = new RemoteFileChangeRuntime(history, guarded);
				const windowsEditor = guarded.pathFlavor === "windows" && actor.kind === "human";
				let namespace = windowsEditor ? undefined : await this.auditNamespace(input.signal);
				let operation: ReturnType<FileChangeEvidenceService["beginOperation"]> | undefined;
				let effect: FileChangeEffectRecord | undefined;
				let lineStats: { added: number; removed: number } | null | undefined;
				// Local flow facts only: admission/preparing is never native dispatch proof.
				let newWindowsPreparation = false;
				let metadataAttempted = false;
				let windowsLeaseCheck: (() => void) | undefined;
				try {
					if (windowsEditor) {
						lease.assertCurrent();
						const leaseId = lease.leaseId;
						const columns = {
							leaseId: workspaceWriteLeases.leaseId,
							scopeId: workspaceWriteLeases.scopeId,
							deviceId: workspaceWriteLeases.deviceId,
							ownerEpoch: workspaceWriteLeases.ownerEpoch,
							runtimeEpoch: workspaceWriteLeases.runtimeEpoch,
							runtimeGeneration: workspaceWriteLeases.runtimeGeneration,
							fencingToken: workspaceWriteLeases.fencingToken,
							scopeRevision: workspaceWriteLeases.scopeRevision,
							status: workspaceWriteLeases.status,
						};
						const held = this.options.db
							.select(columns)
							.from(workspaceWriteLeases)
							.where(eq(workspaceWriteLeases.leaseId, leaseId))
							.get();
						if (
							!held ||
							held.status !== "executing" ||
							held.scopeId !== lease.scope.id ||
							held.deviceId !== target.deviceId ||
							held.runtimeEpoch !== lease.executionBinding.runtimeEpoch ||
							held.runtimeGeneration !== lease.executionBinding.runtimeGeneration ||
							held.fencingToken !== lease.executionBinding.fencingToken ||
							held.scopeRevision !== lease.scopeRevision
						)
							throw new Error("Original Windows editor durable lease is unavailable");
						const pinned = Object.freeze({ ...held });
						windowsLeaseCheck = () => {
							this.backend(target);
							lease.assertCurrent();
							this.assertScope(scope, binding);
							const row = this.options.db
								.select(columns)
								.from(workspaceWriteLeases)
								.where(eq(workspaceWriteLeases.leaseId, leaseId))
								.get();
							const liveScope = this.evidence.getScope(pinned.scopeId);
							if (
								!row ||
								row.status !== "executing" ||
								row.leaseId !== pinned.leaseId ||
								row.scopeId !== pinned.scopeId ||
								row.deviceId !== pinned.deviceId ||
								row.ownerEpoch !== pinned.ownerEpoch ||
								row.runtimeEpoch !== pinned.runtimeEpoch ||
								row.runtimeGeneration !== pinned.runtimeGeneration ||
								row.fencingToken !== pinned.fencingToken ||
								row.scopeRevision !== pinned.scopeRevision ||
								!liveScope ||
								liveScope.status !== "active" ||
								liveScope.activeLeaseId !== leaseId ||
								liveScope.revision !== pinned.scopeRevision ||
								liveScope.sourceInstanceId !== scope.sourceInstanceId ||
								liveScope.workspaceInstanceId !== scope.workspaceInstanceId ||
								liveScope.canonicalRoot !== scope.canonicalRoot ||
								liveScope.rootIdentityJson?.object !== binding.rootIdentity ||
								liveScope.fencingToken !== pinned.fencingToken
							)
								throw new Error("Original Windows editor source/scope/lease/fence changed");
						};
						const check = {
							registry: this,
							userId: actor.userId,
							phase: "save" as const,
							signal: input.signal,
							assertCurrent: windowsLeaseCheck,
							authorize: async (bounded: AbortSignal) => {
								await input.authorize();
								bounded.throwIfAborted();
								await this.options.authorize(actor, target, "write", bounded);
							},
						};
						const origin = await checkWindowsEditorSession(check);
						lease.assertCurrent();
						const context = this.operationInput(
							actor,
							input.operationId,
							input.requestDigest,
							lease,
						);
						// Root transaction either inserts this intent or rejects every old source
						// tuple. Never infer creation from counters or claim an existing preparing row.
						operation = this.evidence.beginNewPreparingOperation(context);
						newWindowsPreparation = true;
						await preflightWindowsEditorMetadata({ ...check, origin, correlationId: operation.id });
						namespace = await this.auditNamespace(input.signal);
						metadataAttempted = true;
					}
					return await remote.execute({
						...input,
						identity,
						construct: async (before) => {
							const constructed = await input.construct(before);
							if (constructed.nextBytes.byteLength > remoteHistoryWriteBudget(guarded))
								throw new Error("Executor upgrade required for chunked history writes");
							lineStats = (constructed as { lineStats?: { added: number; removed: number } | null })
								.lineStats;
							const beforeState = remoteHistoryFileState(before.state);
							if (!namespace)
								throw new Error("Audit namespace unavailable after metadata preflight");
							await this.importState(namespace, beforeState, before.bytes, input.signal);
							const afterRef = await namespace.store.putBytes(constructed.nextBytes, {
								signal: input.signal,
								expectedSize: constructed.nextBytes.byteLength,
							});
							const after: FileChangeState = {
								kind: "regular",
								blob: afterRef,
								mode:
									before.state.kind === "regular"
										? before.state.mode
										: guarded.pathFlavor === "windows"
											? 0o666
											: 0o600,
							};
							await input.authorize();
							await this.options.authorize(actor, target, "write", input.signal);
							lease.assertCurrent();
							const context = this.operationInput(
								actor,
								input.operationId,
								input.requestDigest,
								lease,
							);
							operation = this.evidence.beginOperation(context);
							effect = this.evidence.prepareEffects(operation.id, [
								{
									identity,
									scopeRevision: lease.scopeRevision,
									requestDigest: input.requestDigest,
									before: beforeState,
									intendedAfter: after,
								},
							])[0];
							await this.evidence.finalizePreparation(operation.id, { signal: input.signal });
							if (
								!this.evidence.markApplying({
									operationId: operation.id,
									mutationId: effect.mutationId,
									requestDigest: input.requestDigest,
									executionBinding: lease.executionBinding,
								}).mayExecute
							)
								throw new Error("Remote operation already dispatched; query its original receipt");
							lease.registerMutation(effect.mutationId, {
								operationId: operation.id,
								effectId: effect.id,
							});
							if (actor.kind !== "human") this.linkTool(operation.sourceId, operation.id);
							return constructed;
						},
						commit: async (receipt) => {
							if (!operation || !effect) throw new Error("Remote evidence intent unavailable");
							assertRemoteHistoryBinding(binding, receipt.binding);
							const change = receipt.effects[0];
							if (
								receipt.operationId !== input.operationId ||
								receipt.requestDigest !== input.requestDigest ||
								receipt.effects.length !== 1 ||
								change?.path !== remote.relativePath(identity) ||
								!change.after ||
								change.outcome !== "applied" ||
								!fileChangeStatesEqual(
									remoteHistoryFileState(change.before),
									effect.beforeStateJson,
								) ||
								!fileChangeStatesEqual(
									remoteHistoryFileState(change.intended),
									effect.intendedAfterStateJson,
								) ||
								!fileChangeStatesEqual(
									remoteHistoryFileState(change.after),
									effect.intendedAfterStateJson,
								)
							)
								throw new Error("Remote receipt does not prove this exact mutation");
							const after = remoteHistoryFileState(change.after);
							const cleanup = AbortSignal.timeout(30_000);
							const bytes =
								change.after.kind === "regular"
									? await history.readObject(change.after.object, cleanup)
									: null;
							if (!namespace)
								throw new Error("Audit namespace unavailable for original operation commit");
							await this.importState(namespace, after, bytes, cleanup);
							const fixedOperation = operation;
							const fixedEffect = effect;
							const recorded = lease.settleWith(fixedEffect.mutationId, (tx) => {
								const value = this.evidence.settleEffect(
									{
										operationId: fixedOperation.id,
										mutationId: fixedEffect.mutationId,
										requestDigest: input.requestDigest,
										receipt: {
											receiptId: receipt.operationId,
											mutationId: fixedEffect.mutationId,
											requestDigest: receipt.requestDigest,
											executionBinding: lease.executionBinding,
											confirmed: true,
											outcome: "applied",
											observedAfter: after,
										},
										linesAdded: lineStats?.added,
										linesRemoved: lineStats?.removed,
									},
									tx,
								);
								this.evidence.finishOperation(fixedOperation.id, "succeeded", tx);
								return {
									value,
									outcome:
										value.settlement === "settled" ? ("applied" as const) : ("unknown" as const),
								};
							});
							this.project(actor, scope, operation.id, recorded);
							return input.commit(receipt);
						},
					});
				} catch (error) {
					if (windowsEditor && newWindowsPreparation && operation && !metadataAttempted) {
						try {
							if (!windowsLeaseCheck)
								throw new Error("Original Windows lease assertion is missing");
							windowsLeaseCheck();
							const current = this.evidence.getOperation(operation.id);
							if (
								!current ||
								current.settlement !== "preparing" ||
								current.preparedEffectCount !== 0 ||
								lease.pendingMutationCount !== 0 ||
								effect !== undefined
							)
								throw new Error("Original Windows preparation cannot be proven non-dispatched");
							this.evidence.finishPreparationWithoutDispatch(operation.id, {
								targetDispatched: false,
								reason: input.signal.aborted ? "cancelled_before_dispatch" : "validation_rejected",
							});
							windowsLeaseCheck();
						} catch (settlementError) {
							lease.markUncertain();
							throw settlementError;
						}
						throw error;
					}
					if (operation && effect && isRemoteHistoryNoDispatchError(error)) {
						try {
							const receipt = error.receipt;
							assertRemoteHistoryBinding(binding, receipt.binding);
							const change = receipt.effects[0];
							if (
								receipt.kind !== "mutate" ||
								receipt.operationId !== input.operationId ||
								receipt.requestDigest !== input.requestDigest ||
								receipt.effects.length !== 1 ||
								change?.path !== remote.relativePath(identity) ||
								!fileChangeStatesEqual(
									remoteHistoryFileState(change.before),
									effect.beforeStateJson,
								) ||
								!fileChangeStatesEqual(
									remoteHistoryFileState(change.intended),
									effect.intendedAfterStateJson,
								)
							)
								throw new Error("Native refusal does not match the original allocated file effect");
							const fixedOperation = operation;
							const fixedEffect = effect;
							const recorded = lease.settleWith(fixedEffect.mutationId, (tx) => {
								const value = this.evidence.settleEffect(
									{
										operationId: fixedOperation.id,
										mutationId: fixedEffect.mutationId,
										requestDigest: input.requestDigest,
										receipt: {
											receiptId: receipt.operationId,
											mutationId: fixedEffect.mutationId,
											requestDigest: receipt.requestDigest,
											executionBinding: lease.executionBinding,
											confirmed: true,
											outcome: "not_applied",
											observedAfter: { kind: "unknown", reason: "result_unknown" },
										},
									},
									tx,
								);
								this.evidence.finishOperation(fixedOperation.id, "failed", tx);
								return {
									value,
									outcome:
										value.settlement === "settled"
											? ("not_applied" as const)
											: ("unknown" as const),
								};
							});
							this.project(actor, scope, operation.id, recorded);
						} catch (settlementError) {
							lease.markUncertain();
							throw settlementError;
						}
					} else if (operation || effect) lease.markUncertain();
					throw error;
				}
			},
		);
	}
	private operationInput(
		actor: RemoteHistoryActor,
		sourceId: string,
		requestDigest: string,
		lease: WorkspaceWriteLease,
	): BeginFileChangeOperation {
		let toolCallId: string | undefined;
		let attempt = 1;
		if (actor.kind !== "human") {
			const split = sourceId.lastIndexOf(":");
			const invocationAttempt = Number(sourceId.slice(split + 1));
			if (split < 1 || !Number.isSafeInteger(invocationAttempt) || invocationAttempt < 1)
				throw new Error("Attempt-qualified remote operation identity required");
			sourceId = sourceId.slice(0, split);
			const row = this.toolRow(sourceId);
			toolCallId = row.id;
			attempt = row.executionAttempt;
			if (attempt !== invocationAttempt) throw new Error("Persisted remote tool attempt changed");
		}
		const recoveryAuth = currentRemoteRecoveryAuthProvenance(actor.userId);
		const snapshot: FileChangeActor & {
			recoveryAuth?: RemoteRecoveryAuthProvenance;
			recoveryOrigin?: { narratorId: string; projectId: string | null };
		} = {
			kind: actor.kind,
			subjectKey: actor.kind === "human" ? `human:${actor.userId}` : `narrator:${actor.narratorId}`,
			narratorId: actor.kind === "human" ? null : actor.narratorId,
			userId: actor.kind === "human" ? actor.userId : null,
			label: null,
			deleted: false,
			parentSubjectKey: null,
			...(recoveryAuth
				? {
						recoveryAuth,
						recoveryOrigin: {
							narratorId: actor.narratorId,
							projectId: actor.projectId,
							...(actor.toolName ? { toolName: actor.toolName } : {}),
						},
					}
				: {}),
		};
		return {
			sourceInstanceId: lease.scope.sourceInstanceId,
			sourceKind: actor.kind === "human" ? "editor" : "tool",
			sourceId,
			attempt,
			requestDigest,
			expectedEffectCount: 1,
			actor: snapshot,
			executionBinding: lease.executionBinding,
			narratorId: actor.narratorId,
			projectId: actor.projectId,
			ownerUserId: actor.userId,
			toolCallId,
		};
	}
	private toolRow(id: string) {
		const row = this.options.db
			.select({ id: narratorToolCalls.id, executionAttempt: narratorToolCalls.executionAttempt })
			.from(narratorToolCalls)
			.where(eq(narratorToolCalls.id, id))
			.get();
		if (!row) throw new Error("Real persisted tool attempt required");
		return row;
	}
	private linkTool(sourceId: string, operationId: string) {
		const row = this.options.db
			.update(narratorToolCalls)
			.set({ fileChangeOperationId: operationId })
			.where(
				and(eq(narratorToolCalls.id, sourceId), isNull(narratorToolCalls.fileChangeOperationId)),
			)
			.returning({ id: narratorToolCalls.id })
			.get();
		if (!row) throw new Error("Tool attempt already associated with an operation");
	}
	private project(
		actor: RemoteHistoryActor,
		scope: FileChangeScopeRecord,
		operationId: string,
		effect: FileChangeEffectRecord,
	) {
		this.options.db
			.insert(fileAttributions)
			.values({
				id: generateId(),
				deviceId: scope.deviceId,
				workspacePath: scope.canonicalRoot,
				filePath: effect.identityJson.displayPath,
				narratorId: actor.kind === "human" ? null : actor.narratorId,
				userId: actor.kind === "human" ? actor.userId : null,
				action: actor.kind === "human" ? "human" : actor.toolName === "Write" ? "write" : "edit",
				toolName: actor.toolName,
				operationId,
				effectId: effect.id,
				scopeId: scope.id,
				fileKey: effect.fileKey,
				actorSubjectKey:
					actor.kind === "human" ? `human:${actor.userId}` : `narrator:${actor.narratorId}`,
				attributionGrade: effect.attributionGrade,
				linesAdded: effect.linesAdded,
				linesRemoved: effect.linesRemoved,
				changedAt: new Date().toISOString(),
			})
			.onConflictDoNothing({ target: fileAttributions.effectId })
			.run();
	}
	completion<Result>(
		actor: RemoteHistoryActor,
		sourceId: string,
		result: Result,
	): { completion: FileChangeCompletion<Result>; serverCommitId: string } {
		const row = this.options.db
			.select({
				id: fileChangeOperations.id,
				owner: fileChangeOperations.ownerUserId,
				narrator: fileChangeOperations.narratorId,
				status: fileChangeOperations.settlement,
			})
			.from(fileChangeOperations)
			.where(
				and(
					eq(fileChangeOperations.sourceKind, actor.kind === "human" ? "editor" : "tool"),
					eq(fileChangeOperations.sourceId, sourceId),
				),
			)
			.limit(2)
			.all();
		if (
			row.length !== 1 ||
			row[0].owner !== actor.userId ||
			row[0].narrator !== actor.narratorId ||
			row[0].status !== "settled"
		)
			throw new Error("Owned durable remote completion unavailable");
		const effects = this.evidence.listEffects(row[0].id, { limit: 2 }).items;
		if (effects.length !== 1) throw new Error("Exact remote effect required");
		const effect = effects[0];
		return {
			serverCommitId: row[0].id,
			completion: {
				result,
				linesAdded: effect.linesAdded,
				linesRemoved: effect.linesRemoved,
				fileChangeEvidence: {
					version: 2,
					operationId: row[0].id,
					effectId: effect.id,
					grade: effect.attributionGrade,
					settlement: effect.settlement,
					outcome: effect.outcome,
				},
			},
		};
	}
}

const runtimeContext = new AsyncLocalStorage<RemoteWorkspaceHistoryRuntime>();
export function withRemoteWorkspaceHistoryRuntime<T>(
	runtime: RemoteWorkspaceHistoryRuntime,
	body: () => T,
): T {
	return runtimeContext.run(runtime, body);
}
let production: Promise<RemoteWorkspaceHistoryRuntime> | undefined;
export function getRemoteWorkspaceHistoryRuntime() {
	const injected = runtimeContext.getStore();
	if (injected) return Promise.resolve(injected);
	production ??= Promise.all([import("../db"), getDefaultLocalFileChangeRuntime()]).then(
		([{ db, postgresRuntime }, auditRuntime]) => {
			if (postgresRuntime)
				throw new Error("unsupported_database: async remote workspace control store required");
			return new RemoteWorkspaceHistoryRuntime({
				db,
				auditRuntime,
				backend: (deviceId) => resolveBackend({ requested: deviceId }),
				authorize: authorizeRemoteHistoryTarget,
			});
		},
	);
	return production;
}

/** Rechecks user/narrator/project, connection, OAuth narrator AND per-device ceilings on EVERY RPC. */
export async function authorizeRemoteHistoryTarget(
	actor: Readonly<RemoteHistoryActor>,
	target: Readonly<RemoteHistoryTarget>,
	need: "read" | "write",
	signal: AbortSignal,
	/** Server-only strict lookup window; never a request/DTO permission flag. */
	freshPolicy = false,
) {
	const [{ db }, schema, acl, projectAcl, devices, oauth, deviceOAuth, policy] = await Promise.all([
		import("../db"),
		import("../db/schema"),
		import("./narrator-acl"),
		import("./project-acl"),
		import("./device-service"),
		import("./oauth-narrator-runtime-policy"),
		import("./oauth-device-runtime-policy"),
		import("./execution-policy/engine"),
	]);
	signal.throwIfAborted();
	const backend = resolveBackend({ requested: target.deviceId });
	if (backend.kind !== "remote" || backend.runtimeGeneration !== target.runtimeGeneration)
		throw new Error("Remote connection changed");
	const user = await db.query.users.findFirst({
		where: eq(schema.users.id, actor.userId),
		columns: { role: true },
	});
	if (!user) throw new Error("Remote history actor no longer exists");
	const principal = { userId: actor.userId, isAdmin: user.role === "admin" };
	const narrator = await db.query.narrators.findFirst({
		where: eq(schema.narrators.id, actor.narratorId),
		columns: { ...acl.NARRATOR_ACL_COLUMNS, permissionMode: true },
	});
	if (!narrator) throw new Error("Remote history narrator unavailable");
	await acl.assertNarratorAccess(narrator, principal, need);
	if (actor.projectId) await projectAcl.loadProjectForAccess(actor.projectId, principal, need);
	await devices.requireAuthorizedDeviceForProject(target.deviceId, actor.projectId, actor.userId);
	const device = await devices.getDeviceRow(target.deviceId);
	if (!device) throw new Error("Remote history device revoked");
	const deviceAuthority = await deviceOAuth.resolveOAuthDeviceRuntimeAuthorization(device);
	if (!deviceAuthority.allowed) throw new Error("Remote history OAuth device authority revoked");
	const runtime = await oauth.resolveOAuthNarratorRuntimePolicy(actor.narratorId, actor.userId);
	const bindingService = await import("./integration-resource-binding-service");
	const provenance = await bindingService.integrationResourceBindingService.get(
		"device",
		target.deviceId,
	);
	const deviceClass =
		runtime &&
		provenance?.sourceType === "oauth_client" &&
		provenance.sourceId === runtime.clientId &&
		provenance.authorityId === runtime.grantId
			? ("selfRegistered" as const)
			: ("global" as const);
	const tool =
		need === "read" ? "Read" : actor.kind === "human" ? "Write" : (actor.toolName ?? "Write");
	if (
		runtime &&
		(!runtime.allowedTools.has(tool) ||
			!runtime.deviceIds.includes(target.deviceId) ||
			(need === "write"
				? runtime.policy.deviceAccess[deviceClass] !== "readWrite"
				: runtime.policy.deviceAccess[deviceClass] === "denied"))
	)
		throw new Error("Remote history exceeds narrator OAuth ceiling");
	if (deviceAuthority.policy) {
		const level = deviceAuthority.policy.deviceAccess.selfRegistered;
		if (need === "write" ? level !== "readWrite" : level === "denied")
			throw new Error("Remote history exceeds device OAuth ceiling");
	}
	const compiled = await (freshPolicy
		? new policy.ExecutionPolicyEngine()
		: policy.executionPolicyEngine
	).compile(
		actor.narratorId,
		{
			backend,
			paths: backend.paths,
			deviceClass,
			target: {
				deviceId: target.deviceId,
				backendKind: "remote",
				cwd: target.cwd,
				lexicalPath: target.lexicalPath,
				canonicalPath: target.canonicalPath,
				pathFlavor: backend.paths.flavor,
				runtimeGeneration: target.runtimeGeneration,
				selectionSource: "explicit",
			},
		},
		runtime?.useRobotDiagnosticPreset ? ["robotDiagnostic"] : [],
		signal,
	);
	if (compiled.evaluatePath({ path: target.canonicalPath, operation: need }).decision === "deny")
		throw new Error("Remote history execution path denied");
	if (resolveBackend({ requested: target.deviceId }).runtimeGeneration !== target.runtimeGeneration)
		throw new Error("Remote history connection changed during authorization");
}

function editorActor(actor: EditorActor, binding: EditorBinding): RemoteHistoryActor {
	return {
		userId: actor.userId,
		narratorId: actor.narratorId,
		projectId: binding.projectId,
		kind: "human",
	};
}
function editorTarget(binding: EditorBinding): RemoteHistoryTarget {
	if (!binding.deviceId || binding.deviceId === "local" || binding.runtimeGeneration === undefined)
		throw new Error("Frozen remote editor binding required");
	return {
		deviceId: binding.deviceId,
		cwd: binding.cwd,
		lexicalPath: binding.lexicalPath,
		canonicalPath: binding.canonicalPath,
		runtimeGeneration: binding.runtimeGeneration,
		rootIdentity: binding.rootIdentity,
	};
}
export async function resolveProductionRemoteEditorRoot(
	actor: EditorActor,
	binding: Readonly<EditorBinding>,
	signal: AbortSignal,
) {
	return (await getRemoteWorkspaceHistoryRuntime()).verifyWorkspaceRoot(
		editorActor(actor, binding),
		editorTarget(binding),
		signal,
	);
}
export function createProductionRemoteEditorAdapter(): RemoteEditorAdapter {
	return createRemoteEditorAdapter({
		async resolve(actor, binding, need, signal) {
			const registry = await getRemoteWorkspaceHistoryRuntime();
			const context = editorActor(actor, binding);
			const endpoint = await registry.resolve(context, editorTarget(binding), need, signal);
			return {
				...endpoint,
				maxWriteBytes: remoteHistoryWriteBudget(endpoint.runtime.history.backend),
				async commit(_receipt, request, result) {
					return registry.completion(context, request.requestId, result);
				},
			};
		},
		async queryOperation(actor, operationId, recovery) {
			const registry = await getRemoteWorkspaceHistoryRuntime();
			const rows = registry.options.db
				.select({
					id: fileChangeOperations.id,
					owner: fileChangeOperations.ownerUserId,
					narrator: fileChangeOperations.narratorId,
					project: fileChangeOperations.projectId,
					settlement: fileChangeOperations.settlement,
					execution: fileChangeOperations.executionOutcome,
				})
				.from(fileChangeOperations)
				.where(
					and(
						eq(fileChangeOperations.sourceKind, "editor"),
						eq(fileChangeOperations.sourceId, operationId),
					),
				)
				.limit(2)
				.all();
			if (
				rows.length !== 1 ||
				rows[0].owner !== actor.userId ||
				rows[0].narrator !== actor.narratorId
			)
				return null;
			const row = rows[0];
			const effect = registry.evidence.listEffects(row.id, { limit: 2 }).items;
			if (effect.length !== 1) return { status: "uncertain", operationId };
			const identity = effect[0].identityJson;
			const scope = registry.evidence.getScope(identity.scopeId);
			if (!scope) return { status: "uncertain", operationId };
			const backend = registry.options.backend(identity.deviceId);
			await registry.options.authorize(
				{
					userId: actor.userId,
					narratorId: actor.narratorId,
					projectId: row.project,
					kind: "human",
				},
				{
					deviceId: identity.deviceId,
					cwd: scope.canonicalRoot,
					canonicalPath: identity.canonicalPath,
					lexicalPath: identity.lexicalPath,
					runtimeGeneration: backend.runtimeGeneration,
					rootIdentity: scope.rootIdentityJson?.object,
				},
				"read",
				AbortSignal.timeout(10_000),
			);
			if (row.settlement !== "settled") return { status: "uncertain", operationId };
			if (row.execution !== "succeeded") return { status: "failed", operationId };
			const after = effect[0].observedAfterStateJson;
			if (
				!recovery ||
				recovery.userId !== actor.userId ||
				recovery.narratorId !== actor.narratorId ||
				recovery.operationId !== operationId ||
				after.kind !== "regular" ||
				after.blob.digest !== recovery.rawDigest ||
				after.blob.sizeBytes !== recovery.bytes
			)
				return { status: "uncertain", operationId };
			return {
				status: "saved",
				operationId,
				result: {
					status: "saved",
					operationId,
					hash: recovery.hash,
					bytes: recovery.bytes,
					snapshotRevision: recovery.snapshotRevision,
				},
			};
		},
	});
}

export async function executeRemoteToolFileChange(
	request: LocalFileChangeRequest,
): Promise<ToolResult | undefined> {
	if (request.backend.kind !== "remote" || !request.backend.supportsRemoteHistory) return undefined;
	request = {
		...request,
		ctx: {
			...request.ctx,
			toolCallBinding:
				request.ctx.toolCallBinding && Object.freeze({ ...request.ctx.toolCallBinding }),
			executionTarget:
				request.ctx.executionTarget && Object.freeze({ ...request.ctx.executionTarget }),
		},
	};
	// A modern executor can never fall back to unjournaled fs.write, even when a caller forgot its binding.
	const frozen = request.ctx.executionTarget && Object.freeze({ ...request.ctx.executionTarget });
	const call = request.ctx.toolCallBinding && Object.freeze({ ...request.ctx.toolCallBinding });
	if (
		!frozen ||
		!call ||
		!request.ctx.userId ||
		!frozen.lexicalPath ||
		!frozen.canonicalPath ||
		frozen.runtimeGeneration === undefined
	)
		throw new Error("Persisted frozen remote tool attempt required");
	const registry = await getRemoteWorkspaceHistoryRuntime();
	const assertAttempt = async () => {
		const row = registry.options.db
			.select({
				id: narratorToolCalls.id,
				narrator: narratorToolCalls.narratorId,
				toolUse: narratorToolCalls.toolUseId,
				tool: narratorToolCalls.toolName,
				version: narratorToolCalls.executionIdentityVersion,
				origin: narratorToolCalls.executionOriginToolCallId,
				checkpoint: narratorToolCalls.isFileHistoryCheckpoint,
				attempt: narratorToolCalls.executionAttempt,
				device: narratorToolCalls.executionDeviceId,
				cwd: narratorToolCalls.executionCwd,
				flavor: narratorToolCalls.executionPathFlavor,
				lexical: narratorToolCalls.resolvedFilePath,
				canonical: narratorToolCalls.canonicalFilePath,
				generation: narratorToolCalls.runtimeGeneration,
				status: narratorToolCalls.status,
				started: narratorToolCalls.executionStartedAt,
			})
			.from(narratorToolCalls)
			.where(eq(narratorToolCalls.id, call.toolCallId))
			.get();
		if (
			!row ||
			row.version !== 1 ||
			row.origin !== null ||
			row.checkpoint ||
			!Number.isSafeInteger(call.attempt) ||
			call.attempt < 1 ||
			row.attempt !== call.attempt ||
			row.narrator !== request.ctx.narratorId ||
			row.toolUse !== request.ctx.currentToolUseId ||
			row.tool !== request.toolName ||
			row.device !== frozen.deviceId ||
			row.cwd !== frozen.cwd ||
			row.flavor !== frozen.pathFlavor ||
			row.lexical !== frozen.lexicalPath ||
			row.canonical !== frozen.canonicalPath ||
			row.generation !== frozen.runtimeGeneration ||
			row.status !== "running" ||
			!row.started ||
			request.backend.runtimeGeneration !== frozen.runtimeGeneration ||
			request.backend.deviceId !== frozen.deviceId ||
			frozen.backendKind !== "remote" ||
			request.backend.pathFlavor !== frozen.pathFlavor ||
			!request.backend.paths.equals(
				request.backend.paths.resolve(frozen.cwd, request.filePath),
				frozen.lexicalPath as string,
			)
		)
			throw new Error("Remote tool row/attempt differs from its authorized frozen endpoint");
	};
	await assertAttempt();
	const narrator = registry.options.db
		.select({ type: narrators.type })
		.from(narrators)
		.where(eq(narrators.id, request.ctx.narratorId))
		.get();
	if (!narrator) throw new Error("Narrator deleted");
	const actor: RemoteHistoryActor = {
		userId: request.ctx.userId,
		narratorId: request.ctx.narratorId,
		projectId: request.ctx.projectId ?? null,
		kind: narrator.type === "subagent" ? "subagent" : "primary",
		toolName: request.toolName,
	};
	const endpoint = await registry.resolve(
		actor,
		{
			deviceId: frozen.deviceId,
			cwd: frozen.cwd,
			lexicalPath: frozen.lexicalPath,
			canonicalPath: frozen.canonicalPath,
			runtimeGeneration: frozen.runtimeGeneration,
		},
		"write",
		request.ctx.signal,
	);
	const digest = await hashLocalFileChangeRequest(
		[request.toolName, call.toolCallId, String(call.attempt), JSON.stringify(endpoint.identity)],
		request.input,
		request.ctx.signal,
	);
	let completion: FileChangeCompletion<ToolResult> | undefined;
	const result = await endpoint.runtime.execute({
		identity: endpoint.identity,
		operationId: `${call.toolCallId}:${call.attempt}`,
		requestDigest: digest,
		signal: request.ctx.signal,
		authorize: assertAttempt,
		construct: (before) =>
			request.construct({
				bytes: before.bytes,
				mode: before.state.kind === "regular" ? before.state.mode : null,
				identity: null,
			}),
		commit: async () => {
			const committed = registry.completion(actor, call.toolCallId, { output: "" });
			completion = committed.completion;
			return committed.serverCommitId;
		},
	});
	if (!completion) throw new Error("Remote tool completion unavailable");
	return {
		...result.result,
		metadata: {
			...result.result.metadata,
			...(completion.linesAdded === null ? {} : { linesAdded: completion.linesAdded }),
			...(completion.linesRemoved === null ? {} : { linesRemoved: completion.linesRemoved }),
			fileChangeEvidence: completion.fileChangeEvidence,
		},
	};
}
