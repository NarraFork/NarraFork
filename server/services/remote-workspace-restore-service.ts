import { createHash } from "node:crypto";
import { setImmediate as yieldTick } from "node:timers/promises";
import {
	FILE_CHANGE_LIMITS,
	type FileChangeRevertMutationJournal,
	type FileChangeState,
	fileChangeStatesEqual,
} from "@shared/file-change-protocol";
import {
	type RemoteHistoryBinding,
	type RemoteHistoryReceipt,
	remoteHistoryFileState,
} from "@shared/remote-history-protocol";
import { and, eq, sql } from "drizzle-orm";
import { fileChangeBlobs, narrators, workspaceWriteLeases } from "../db/schema";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import {
	createFileChangeIdentity,
	fileChangeExecutionBindingMatches,
} from "./file-change-identity";
import type { NarratorPrincipal } from "./narrator-acl";
import { RemoteFileChangeRuntime } from "./remote-file-change-runtime";
import {
	currentRemoteRecoveryAuthProvenance,
	type RemoteRecoveryAuthProvenance,
} from "./remote-history-recovery-auth";
import {
	assertRemoteHistoryBinding,
	isRemoteHistoryNoDispatchError,
	RemoteHistoryUncertainError,
} from "./remote-history-service";
import type {
	RemoteHistoryActor,
	RemoteWorkspaceHistoryRuntime,
} from "./remote-workspace-history-runtime";
import { attestRemoteRevertLeaseRecovery } from "./remote-workspace-lease-recovery-authority";
import {
	assertCompleteWorkspaceSnapshot,
	createProductionRemoteWorkspaceRestoreAuthority,
	type RemoteWorkspaceRestoreAuthority,
	type RemoteWorkspaceSnapshotOrigin,
} from "./remote-workspace-restore-authority";
import { RemoteRestoreParser } from "./remote-workspace-restore-parser";
import type {
	RemoteSnapshotDelta,
	RemoteTreeEntry,
	RemoteTreeIndex,
} from "./remote-workspace-restore-worker";
import {
	type RevertJournalClaim,
	type RevertJournalContext,
	type RevertJournalFile,
	RevertMutationJournal,
} from "./revert-mutation-journal";
import {
	type AppendRevertPlanFile,
	fingerprintRevertPlanFiles,
	type RevertPlanHeader,
	type RevertPlanManifestProof,
	type RevertPlanOwner,
	RevertPlanService,
	revertPlanHeaderDigest,
} from "./revert-plan-service";
import type { WorkspaceWriteLease } from "./workspace-write-coordinator";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface RemoteWorkspaceRestoreConfirmation {
	kind: "snapshot_restore";
	captureId: string;
	deviceId: string;
	root: string;
	rootIdentity: string;
	treeDigest: string;
}
export interface RemoteWorkspaceRestoreRequest {
	principal: NarratorPrincipal;
	narratorId: string;
	captureId: string;
	idempotencyKey: string;
	signal?: AbortSignal;
}
interface RestoreManifest {
	purpose: "remote_workspace_snapshot_restore_v1";
	owner: RevertPlanOwner;
	recoveryAuth?: RemoteRecoveryAuthProvenance;
	header: RevertPlanHeader;
	proof: RevertPlanManifestProof;
	origin: RemoteWorkspaceSnapshotOrigin;
	currentFingerprint: string;
	currentReceipt: RemoteHistoryReceipt;
	runtimeGeneration: number;
	confirmation: RemoteWorkspaceRestoreConfirmation;
	changes: RemoteSnapshotDelta[];
	files: AppendRevertPlanFile[];
}
export interface RemoteWorkspaceRestoreResult {
	planId: string;
	status: "committed" | "compensated" | "recovery_required";
	reason?: string;
	restoredFileCount: number;
	nativeOperationId?: string;
	coverage?: import("@shared/partial-revert").PartialRevertResult;
}
export interface RemoteWorkspaceRestoreOptions {
	registry: RemoteWorkspaceHistoryRuntime;
	authority?: RemoteWorkspaceRestoreAuthority;
	timeoutMs?: number;
}

/** Explicit whole-directory snapshot recovery, not narrator undo and not history deletion.
 * Only changed bounded individual files are imported into the server audit store;
 * complete native tree data remains in the executor's private object store. */
export class RemoteWorkspaceRestoreService {
	private readonly authority: RemoteWorkspaceRestoreAuthority;
	private readonly timeout: number;
	private active = 0;
	constructor(private readonly options: RemoteWorkspaceRestoreOptions) {
		this.authority =
			options.authority ?? createProductionRemoteWorkspaceRestoreAuthority(options.registry);
		this.timeout = Math.min(options.timeoutMs ?? 120_000, FILE_CHANGE_LIMITS.planLifetimeMs);
	}
	private actor(
		principal: NarratorPrincipal,
		narratorId: string,
		origin: RemoteWorkspaceSnapshotOrigin,
	): RemoteHistoryActor {
		return { userId: principal.userId, narratorId, projectId: origin.projectId, kind: "human" };
	}
	private async scope(origin: RemoteWorkspaceSnapshotOrigin) {
		const scope = this.options.registry.evidence.getScope(origin.binding.scopeId);
		if (
			!scope ||
			(scope.status !== "active" && scope.status !== "needs_verification") ||
			scope.deviceId !== origin.deviceId ||
			scope.sourceInstanceId !== origin.binding.sourceInstanceId ||
			scope.workspaceInstanceId !== origin.binding.workspaceInstanceId ||
			scope.canonicalRoot !== origin.binding.root ||
			scope.rootIdentityJson?.object !== origin.binding.rootIdentity
		)
			throw new Error("Original workspace snapshot scope/source/root changed");
		return scope;
	}
	private async readTree(
		parser: RemoteRestoreParser,
		actor: RemoteHistoryActor,
		origin: RemoteWorkspaceSnapshotOrigin,
		binding: RemoteHistoryBinding,
		receipt: RemoteHistoryReceipt,
		side: "snapshot" | "current" | "after",
		principal: NarratorPrincipal,
		narratorId: string,
		signal: AbortSignal,
	) {
		if (
			!receipt.tree ||
			receipt.kind !== "capture" ||
			receipt.captureKind !== "whole_directory" ||
			receipt.coverage !== "complete" ||
			receipt.consistency !== "stable_double_scan" ||
			receipt.policyDigest !== origin.receipt.policyDigest ||
			!["settled", "finalized"].includes(receipt.state)
		)
			throw new Error("Complete stable tree receipt/descriptor absent");
		assertRemoteHistoryBinding(binding, receipt.binding);
		const reader = await this.options.registry.resolveSnapshotIndexHistory(
			actor,
			binding,
			origin.deviceId,
			signal,
			side === "snapshot" ? "tree_index" : "snapshot_read_observation",
		);
		if (receipt.tree.sizeBytes > 1024 * 1024)
			throw new Error("Tree index exceeds its metadata frame budget");
		const index = await parser.request<RemoteTreeIndex>({
			kind: "index",
			bytes: await reader.readTreeIndex(receipt.tree, signal),
			binding,
			policyDigest: origin.receipt.policyDigest as string,
			side,
		});
		let count = 0;
		const backend = this.options.registry.options.backend(origin.deviceId);
		for (const page of index.pages) {
			signal.throwIfAborted();
			const entries = await parser.request<RemoteTreeEntry[]>({
				kind: "page",
				bytes: await reader.readTreeIndex(page, signal),
				binding,
				flavor: backend.pathFlavor === "windows" ? "windows" : "posix",
			});
			for (const entry of entries) {
				await this.authority.authorizeEntry(
					principal,
					narratorId,
					origin,
					entry.path,
					"read",
					signal,
				);
				await this.authority.authorizeEntry(
					principal,
					narratorId,
					origin,
					entry.path,
					"write",
					signal,
				);
			}
			count = await parser.request<number>({
				kind: "ingest",
				side,
				entries,
				expectedCount: index.entryCount,
			});
			await yieldTick();
		}
		if (count !== index.entryCount || count !== receipt.entryCount)
			throw new Error("Complete snapshot page inventory/count mismatch");
	}
	private async currentTree(
		actor: RemoteHistoryActor,
		origin: RemoteWorkspaceSnapshotOrigin,
		operationId: string,
		signal: AbortSignal,
		lease?: WorkspaceWriteLease,
	) {
		const registry = this.options.registry;
		const backend = registry.options.backend(origin.deviceId);
		const target = {
			deviceId: origin.deviceId,
			cwd: origin.binding.root,
			lexicalPath: origin.binding.root,
			canonicalPath: origin.binding.root,
			runtimeGeneration: backend.runtimeGeneration,
			rootIdentity: origin.binding.rootIdentity,
		};
		const policy = await this.authority.policy(actor, origin, signal);
		lease?.assertCurrent();
		// Even metadata open goes through the realtime registry gate. No direct
		// backend RPC may bypass connection generation/actor/root authorization.
		const history = (await registry.resolveWorkspace(actor, target, signal, lease, true)).history;
		assertRemoteHistoryBinding(
			{ ...origin.binding, fence: history.binding.fence },
			history.binding,
		);
		const receipt = await history.captureTree(
			{
				binding: history.binding,
				operationId,
				requestDigest: hash({ operationId, binding: history.binding, policy }),
				treePolicy: policy,
				capturePhase: "warm",
			},
			signal,
		);
		if (
			receipt.coverage !== "complete" ||
			receipt.consistency !== "stable_double_scan" ||
			receipt.captureKind !== "whole_directory" ||
			!receipt.tree
		)
			throw new Error("Current workspace cannot provide complete stable coverage");
		return { history, receipt };
	}
	private async stores(signal: AbortSignal) {
		const namespace = await this.options.registry.auditNamespace(signal);
		const namespaceKey = namespace.catalog.getBudget()?.namespaceKey;
		if (!namespaceKey) throw new Error("Verified bounded audit store unavailable");
		return {
			namespace,
			plans: new RevertPlanService(this.options.registry.options.db, { namespaceKey }),
			journal: new RevertMutationJournal(this.options.registry.options.db, { namespaceKey }),
		};
	}
	private confirmation(origin: RemoteWorkspaceSnapshotOrigin): RemoteWorkspaceRestoreConfirmation {
		return {
			kind: "snapshot_restore",
			captureId: origin.captureId,
			deviceId: origin.deviceId,
			root: origin.binding.root,
			rootIdentity: origin.binding.rootIdentity,
			treeDigest: origin.descriptor.digest,
		};
	}
	async prepare(input: RemoteWorkspaceRestoreRequest) {
		if (this.active >= FILE_CHANGE_LIMITS.captureConcurrency)
			throw new Error("Workspace restore preparation busy");
		this.active++;
		const started = performance.now();
		const signal = AbortSignal.any([
			...(input.signal ? [input.signal] : []),
			AbortSignal.timeout(this.timeout),
		]);
		let ownedParser: RemoteRestoreParser | undefined;
		try {
			const parser = new RemoteRestoreParser(signal);
			ownedParser = parser;
			const owner = await this.authority.owner(input.principal, input.narratorId, signal);
			const origin = await this.authority.snapshot(
				input.principal,
				input.narratorId,
				input.captureId,
				signal,
			);
			assertCompleteWorkspaceSnapshot(origin);
			const actor = this.actor(input.principal, input.narratorId, origin);
			const scope = await this.scope(origin);
			const backend = this.options.registry.options.backend(origin.deviceId);
			const generation = backend.runtimeGeneration;
			await this.authority.policy(actor, origin, signal);
			this.options.registry.coordinator.assertRevertActivityBarrier(scope);
			await this.readTree(
				parser,
				actor,
				origin,
				origin.binding,
				origin.receipt,
				"snapshot",
				input.principal,
				input.narratorId,
				signal,
			);
			const current = await this.currentTree(
				actor,
				origin,
				`restore_preview_${hash([input.idempotencyKey, origin.captureId]).slice(0, 40)}`,
				signal,
			);
			await this.readTree(
				parser,
				actor,
				origin,
				current.receipt.binding,
				current.receipt,
				"current",
				input.principal,
				input.narratorId,
				signal,
			);
			const delta = await parser.request<{
				changes: RemoteSnapshotDelta[];
				currentFingerprint: string;
			}>({ kind: "delta" });
			const { namespace, plans } = await this.stores(signal);
			const files: AppendRevertPlanFile[] = [];
			for (const [sequence, change] of delta.changes.entries()) {
				const canonicalPath = backend.paths.resolve(origin.binding.root, change.path);
				const identity = createFileChangeIdentity(scope, {
					deviceId: origin.deviceId,
					pathFlavor: backend.pathFlavor,
					canonicalPath,
					lexicalPath: canonicalPath,
					objectRole: "referent",
				});
				const endpoint = await this.options.registry.resolve(
					actor,
					{
						deviceId: origin.deviceId,
						cwd: origin.binding.root,
						lexicalPath: canonicalPath,
						canonicalPath,
						runtimeGeneration: generation,
						rootIdentity: origin.binding.rootIdentity,
					},
					"read",
					signal,
					identity,
					true,
				);
				for (const state of [change.expected, change.desired])
					if (state.kind === "regular")
						await this.options.registry.importState(
							namespace,
							remoteHistoryFileState(state),
							await endpoint.runtime.history.readObject(state.object, signal),
							signal,
						);
				files.push({
					sequence,
					identity,
					expected: remoteHistoryFileState(change.expected),
					desired: remoteHistoryFileState(change.desired),
				});
			}
			const version = this.options.registry.options.db
				.select({ version: narrators.messageVersion })
				.from(narrators)
				.where(eq(narrators.id, input.narratorId))
				.get()?.version;
			if (version === undefined) throw new Error("Restore owner narrator missing");
			const confirmation = this.confirmation(origin);
			const requestDigest = hash({
				purpose: "remote_workspace_snapshot_restore_v1",
				owner,
				idempotencyKey: input.idempotencyKey,
				origin,
				currentFingerprint: delta.currentFingerprint,
				confirmation,
				generation,
			});
			const publish = async (value: unknown) => {
				const bytes = await parser.request<Uint8Array>({ kind: "encode", value });
				return namespace.store.putBytes(bytes, { expectedSize: bytes.byteLength, signal });
			};
			const recoveryAuth = currentRemoteRecoveryAuthProvenance(input.principal.userId);
			const selector = await publish({
				recoveryAuth,
				purpose: "remote_workspace_snapshot_restore_v1",
				owner,
				origin,
				confirmation,
				currentFingerprint: delta.currentFingerprint,
				runtimeGeneration: generation,
				requestDigest,
			});
			const historyManifest = await publish({
				purpose: "workspace_snapshot_no_history_mutation_v1",
				owner,
				noHistoryMutation: true,
			});
			const header: RevertPlanHeader = {
				...owner,
				idempotencyKey: input.idempotencyKey,
				requestDigest,
				kind: "revert",
				revertScope: "workspace",
				selectorKind: "all",
				selector,
				historyManifest,
				expectedMessageVersion: version,
				expectedFileCount: files.length,
			};
			const fingerprint = fingerprintRevertPlanFiles(files);
			const proof: RevertPlanManifestProof = {
				source: "trusted_published_planner_v1",
				headerDigest: revertPlanHeaderDigest(header),
				orderedFilesDigest: fingerprint.orderedFilesDigest,
				fileEvidenceBytes: fingerprint.fileEvidenceBytes,
				computation: "complete",
				selectorCoverage: "complete",
				historyCoverage: "complete",
				omittedFiles: 0,
				unknownFiles: 0,
			};
			const manifest: RestoreManifest = {
				recoveryAuth,
				purpose: "remote_workspace_snapshot_restore_v1",
				owner,
				header,
				proof,
				origin,
				confirmation,
				runtimeGeneration: generation,
				currentFingerprint: delta.currentFingerprint,
				currentReceipt: current.receipt,
				changes: delta.changes,
				files,
			};
			const planRef = await publish(manifest);
			if (this.options.registry.options.backend(origin.deviceId).runtimeGeneration !== generation)
				throw new Error("Workspace restore generation changed during preview");
			const finalOrigin = await this.authority.snapshot(
				input.principal,
				input.narratorId,
				input.captureId,
				signal,
			);
			if (hash(finalOrigin) !== hash(origin))
				throw new Error("Snapshot source changed during preparation");
			await this.authority.policy(actor, origin, signal);
			const plan = await plans.prepare({ ...header, plan: planRef, manifestProof: proof }, files, {
				signal,
			});
			return {
				plan,
				coverage: {
					restoredFiles: [] as string[],
					conflicts: [],
					unknownCoverage: this.options.registry.coordinator.revertUnknownCoverage(scope),
				},
				origin: {
					captureId: origin.captureId,
					deviceId: origin.deviceId,
					root: origin.binding.root,
					rootIdentity: origin.binding.rootIdentity,
					treeDigest: origin.descriptor.digest,
					sourceInstanceId: origin.binding.sourceInstanceId,
					scopeId: origin.binding.scopeId,
					contextKey: origin.contextKey,
					workspaceRevision: origin.workspaceRevision,
					originProjectId: origin.projectId,
					originContextVersion: 1 as const,
				},
				confirmation,
				requiresExplicitSnapshotRestore: true as const,
				files: files.slice(0, FILE_CHANGE_LIMITS.historyPageItems).map((file) => ({
					deviceId: file.identity.deviceId,
					path: file.identity.displayPath,
					willBeDeleted: file.desired.kind === "absent",
				})),
				totalFileCount: files.length,
				hasMore: files.length > FILE_CHANGE_LIMITS.historyPageItems,
			};
		} finally {
			ownedParser?.close();
			this.active--;
			this.slow(started, "preview");
		}
	}
	private async load(
		principal: NarratorPrincipal,
		narratorId: string,
		planId: string,
		planHash: string,
		confirmation: RemoteWorkspaceRestoreConfirmation,
		signal: AbortSignal,
		parser: RemoteRestoreParser,
	) {
		const stores = await this.stores(signal);
		const owner = await this.authority.owner(principal, narratorId, signal);
		const ctx: RevertJournalContext = { owner, planId, planHash };
		const operation = stores.journal.getOperation(ctx);
		if (operation.scope !== "workspace" || operation.kind !== "revert" || !operation.planBlobDigest)
			throw new Error("This is not an explicit whole-directory snapshot restore plan");
		const row = this.options.registry.options.db
			.select({ size: fileChangeBlobs.sizeBytes, state: fileChangeBlobs.status })
			.from(fileChangeBlobs)
			.where(eq(fileChangeBlobs.digest, operation.planBlobDigest))
			.get();
		if (!row || row.state !== "ready" || row.size > FILE_CHANGE_LIMITS.blobBytes)
			throw new Error("Complete original workspace restore manifest unavailable");
		const bytes = await stores.namespace.store.readBytes(
			{ algorithm: "sha256", digest: operation.planBlobDigest, sizeBytes: row.size },
			{ signal, maxBytes: FILE_CHANGE_LIMITS.blobBytes },
		);
		const manifest = await parser.request<RestoreManifest>({ kind: "parseManifest", bytes });
		if (
			manifest.purpose !== "remote_workspace_snapshot_restore_v1" ||
			hash(manifest.owner) !== hash(owner) ||
			manifest.header.requestDigest !== operation.requestDigest ||
			manifest.header.revertScope !== "workspace" ||
			manifest.header.kind !== "revert" ||
			manifest.header.expectedFileCount !== manifest.files.length ||
			manifest.changes.length !== manifest.files.length ||
			manifest.files.length > FILE_CHANGE_LIMITS.revertFiles ||
			manifest.proof.headerDigest !== revertPlanHeaderDigest(manifest.header) ||
			hash(manifest.confirmation) !== hash(confirmation) ||
			confirmation.kind !== "snapshot_restore"
		)
			throw new Error("Explicit snapshot restore source/consent/manifest mismatch");
		const fingerprint = fingerprintRevertPlanFiles(manifest.files);
		if (
			fingerprint.orderedFilesDigest !== manifest.proof.orderedFilesDigest ||
			fingerprint.fileEvidenceBytes !== manifest.proof.fileEvidenceBytes ||
			!operation.coverageComplete ||
			manifest.proof.computation !== "complete" ||
			manifest.proof.omittedFiles ||
			manifest.proof.unknownFiles
		)
			throw new Error("Whole workspace restore declaration is incomplete");
		const origin = await this.authority.snapshot(
			principal,
			narratorId,
			manifest.origin.captureId,
			signal,
		);
		if (
			hash(origin) !== hash(manifest.origin) ||
			hash(this.confirmation(origin)) !== hash(confirmation)
		)
			throw new Error("Original snapshot/source record changed after preview");
		await this.scope(origin);
		await this.authority.policy(this.actor(principal, narratorId, origin), origin, signal);
		const files: RevertJournalFile[] = [];
		let cursor: string | undefined;
		do {
			const page = stores.journal.listFiles(ctx, { cursor, limit: 32 });
			files.push(...page.items);
			cursor = page.nextCursor ?? undefined;
			if (files.length > FILE_CHANGE_LIMITS.revertFiles || (page.hasMore && !cursor))
				throw new Error("Incomplete original restore file inventory");
			await yieldTick();
		} while (cursor);
		files.sort((a, b) => a.sequence - b.sequence);
		if (files.length !== manifest.files.length)
			throw new Error("Original workspace delta file count changed");
		for (let index = 0; index < files.length; index++) {
			const stored = files[index];
			const fixed = manifest.files[index];
			const delta = manifest.changes[index];
			if (
				stored.sequence !== fixed.sequence ||
				hash(stored.identityJson) !== hash(fixed.identity) ||
				!fileChangeStatesEqual(stored.expectedStateJson, fixed.expected) ||
				!fileChangeStatesEqual(stored.desiredStateJson, fixed.desired) ||
				!fileChangeStatesEqual(remoteHistoryFileState(delta.expected), fixed.expected) ||
				!fileChangeStatesEqual(remoteHistoryFileState(delta.desired), fixed.desired)
			)
				throw new Error("Stored workspace delta differs from its fixed source manifest");
			await this.authority.authorizeEntry(
				principal,
				narratorId,
				origin,
				delta.path,
				"read",
				signal,
			);
			await this.authority.authorizeEntry(
				principal,
				narratorId,
				origin,
				delta.path,
				"write",
				signal,
			);
		}
		return { ...stores, owner, ctx, operation, manifest, files, origin };
	}
	async apply(input: {
		principal: NarratorPrincipal;
		narratorId: string;
		planId: string;
		planHash: string;
		confirmation: RemoteWorkspaceRestoreConfirmation;
		signal?: AbortSignal;
		onMutationDispatch?: () => void;
	}): Promise<RemoteWorkspaceRestoreResult> {
		if (this.active >= FILE_CHANGE_LIMITS.captureConcurrency)
			throw new Error("Workspace restore execution busy");
		this.active++;
		const started = performance.now();
		const signal = AbortSignal.any([
			...(input.signal ? [input.signal] : []),
			AbortSignal.timeout(this.timeout),
		]);
		let ownedParser: RemoteRestoreParser | undefined;
		try {
			const parser = new RemoteRestoreParser(signal);
			ownedParser = parser;
			const fixed = await this.load(
				input.principal,
				input.narratorId,
				input.planId,
				input.planHash,
				input.confirmation,
				signal,
				parser,
			);
			if (fixed.operation.status !== "prepared")
				return await this.reconcile(input, fixed, signal, parser);
			if (fixed.plans.getSummary(fixed.owner, input.planId).expired)
				throw new Error("Workspace restore confirmation expired");
			const registry = this.options.registry;
			const scope = await this.scope(fixed.origin);
			const runtime = registry.runtimeBinding(fixed.origin.deviceId);
			if (!runtime || runtime.runtimeGeneration !== fixed.manifest.runtimeGeneration)
				throw new Error("Workspace restore execution generation changed since preview");
			const actor = this.actor(input.principal, input.narratorId, fixed.origin);
			const result = await registry.coordinator.withRollback<RemoteWorkspaceRestoreResult>(
				{
					scope,
					runtime,
					signal,
					ranges: [{ kind: "subtree", canonicalPath: scope.canonicalRoot }],
					executionClass: "unknown",
					activityPolicy: "strict",
				},
				async (lease) => {
					// Re-enumerate COMPLETE current coverage under the actual whole-root lease.
					await this.readTree(
						parser,
						actor,
						fixed.origin,
						fixed.origin.binding,
						fixed.origin.receipt,
						"snapshot",
						input.principal,
						input.narratorId,
						signal,
					);
					const current = await this.currentTree(
						actor,
						fixed.origin,
						`restore_apply_${hash([input.planId, lease.executionBinding]).slice(0, 40)}`,
						signal,
						lease,
					);
					await this.readTree(
						parser,
						actor,
						fixed.origin,
						current.receipt.binding,
						current.receipt,
						"current",
						input.principal,
						input.narratorId,
						signal,
					);
					const checked = await parser.request<{
						currentFingerprint: string;
						currentReceipt: RemoteHistoryReceipt;

						changes: RemoteSnapshotDelta[];
					}>({ kind: "delta" });
					if (
						checked.currentFingerprint !== fixed.manifest.currentFingerprint ||
						hash(checked.changes) !== hash(fixed.manifest.changes)
					)
						throw new Error("Current complete workspace changed after preview; no silent replan");
					await this.authority.owner(input.principal, input.narratorId, signal);
					lease.assertCurrent();
					const admission = await fixed.journal.startExecution(fixed.ctx, fixed.manifest.proof, {
						signal,
					});
					if (!admission.started)
						throw new Error("Workspace restore already attempted; use original receipt recovery");
					if (!fixed.files.length) {
						await fixed.journal.finishFiles(fixed.ctx, { signal });
						fixed.journal.commit(fixed.ctx, { db: registry.options.db, apply: () => undefined });
						return { planId: input.planId, status: "committed", restoredFileCount: 0 };
					}
					const targets = fixed.manifest.files.map((file) => ({
						deviceId: fixed.origin.deviceId,
						cwd: scope.canonicalRoot,
						lexicalPath: file.identity.lexicalPath,
						canonicalPath: file.identity.canonicalPath,
						runtimeGeneration: runtime.runtimeGeneration,
						rootIdentity: scope.rootIdentityJson?.object,
					}));
					const history = await registry.resolveBatchHistory(actor, targets, scope, lease, signal);
					const nativeId = `workspace_restore:${input.planId}`;
					const claims: RevertJournalClaim[] = [];
					const digest = hash({
						purpose: "remote_workspace_snapshot_restore_v1",
						planId: input.planId,
						planHash: input.planHash,
						confirmation: input.confirmation,
					});
					try {
						for (const file of fixed.files) {
							const claim = fixed.journal.claimApply(fixed.ctx, file, lease);
							if (!claim.mayExecute) throw new Error("Original restore claim cannot redispatch");
							claims.push(claim);
							lease.registerMutation(claim.mutationId);
						}
						try {
							input.onMutationDispatch?.();
						} catch {
							logger.warn("Workspace restore dispatch observer failed", { planId: input.planId });
						}
						const receipt = await history.dispatch(
							"restore",
							{
								binding: history.binding,
								operationId: nativeId,
								requestDigest: digest,
								changes: fixed.manifest.changes,
							},
							signal,
						);
						await this.recordBatch(fixed, claims, receipt, lease, "apply", signal, actor);
						if (
							receipt.state !== "settled" ||
							receipt.effects.some((effect) => effect.outcome !== "applied")
						)
							throw new Error("Native workspace restore has partial/unknown effects");
						await new RemoteFileChangeRuntime(
							history,
							registry.options.backend(fixed.origin.deviceId),
						).verifyApplied(receipt, signal);
						await parser.request({ kind: "postExpected", effects: receipt.effects });
						const after = await this.currentTree(
							actor,
							fixed.origin,
							`restore_post_${hash([input.planId, lease.executionBinding, "beforeOwner"]).slice(0, 40)}`,
							signal,
							lease,
						);
						await this.readTree(
							parser,
							actor,
							fixed.origin,
							after.receipt.binding,
							after.receipt,
							"after",
							input.principal,
							input.narratorId,
							signal,
						);
						await parser.request({ kind: "verifyPost" });
						await fixed.journal.finishFiles(fixed.ctx, { signal });
						await this.authority.owner(input.principal, input.narratorId, signal);
						await this.authority.policy(actor, fixed.origin, signal);
						await new RemoteFileChangeRuntime(
							history,
							registry.options.backend(fixed.origin.deviceId),
						).verifyApplied(receipt, signal);
						await parser.request({ kind: "postExpected", effects: receipt.effects });
						const finalTree = await this.currentTree(
							actor,
							fixed.origin,
							`restore_post_${hash([input.planId, lease.executionBinding, "finalCommit"]).slice(0, 40)}`,
							signal,
							lease,
						);
						await this.readTree(
							parser,
							actor,
							fixed.origin,
							finalTree.receipt.binding,
							finalTree.receipt,
							"after",
							input.principal,
							input.narratorId,
							signal,
						);
						await parser.request({ kind: "verifyPost" });
						lease.assertCurrent();
						fixed.journal.commit(fixed.ctx, { db: registry.options.db, apply: () => undefined });
						const finalized = await history.finalize(nativeId, digest, input.planId, signal);
						if (finalized.state !== "finalized")
							throw new Error("Workspace restore final acknowledgement unavailable");
						return {
							planId: input.planId,
							status: "committed",
							restoredFileCount: claims.length,
							nativeOperationId: nativeId,
						};
					} catch (_error) {
						if (isRemoteHistoryNoDispatchError(_error)) {
							try {
								const refused = _error.receipt;
								assertRemoteHistoryBinding(history.binding, refused.binding);
								if (
									refused.kind !== "restore" ||
									refused.operationId !== nativeId ||
									refused.requestDigest !== digest ||
									claims.length !== fixed.files.length
								)
									throw new Error(
										"Native refusal differs from the original complete workspace restore",
									);
								const cleanup = AbortSignal.timeout(30_000);
								await this.recordBatch(fixed, claims, refused, lease, "apply", cleanup, actor);
								// Logical rollback of an entirely unexecuted plan: no native compensation.
								// The executor's durable receipt remains rejected, never compensated/finalized.
								fixed.journal.beginCompensation(fixed.ctx);
								const outcome = await fixed.journal.finishCompensation(fixed.ctx, {
									signal: cleanup,
								});
								if (outcome.status !== "compensated")
									throw new Error("Native refusal settlement incomplete");
								return {
									planId: input.planId,
									status: "compensated",
									restoredFileCount: 0,
									nativeOperationId: nativeId,
									reason: "UNSUPPORTED_CROSS_FILESYSTEM_NOT_DISPATCHED",
								};
							} catch {
								lease.markUncertain();
								return {
									planId: input.planId,
									status: "recovery_required",
									restoredFileCount: 0,
									nativeOperationId: nativeId,
									reason: "NATIVE_REFUSAL_SETTLEMENT_REQUIRED",
								};
							}
						}
						if (_error instanceof RemoteHistoryUncertainError) {
							lease.markUncertain();
							return {
								planId: input.planId,
								status: "recovery_required",
								restoredFileCount: 0,
								nativeOperationId: nativeId,
								reason: "ORIGINAL_NATIVE_OUTCOME_UNKNOWN",
							};
						}
						const operation = fixed.journal.getOperation(fixed.ctx);
						if (operation.status === "committed") {
							lease.markUncertain();
							return {
								planId: input.planId,
								status: "committed",
								restoredFileCount: fixed.files.length,
								nativeOperationId: nativeId,
								reason: "REMOTE_FINALIZE_REQUIRED",
							};
						}
						// A lost/unknown reply is not execution evidence and cannot authorize compensation.
						const recorded = await history
							.status(nativeId, AbortSignal.timeout(15_000))
							.catch(() => null);
						if (
							!recorded ||
							recorded.state !== "settled" ||
							recorded.effects.some((effect) => effect.outcome !== "applied" || !effect.after)
						) {
							lease.markUncertain();
							return {
								planId: input.planId,
								status: "recovery_required",
								restoredFileCount: 0,
								nativeOperationId: nativeId,
								reason: "ORIGINAL_NATIVE_OUTCOME_UNKNOWN",
							};
						}
						const cleanup = AbortSignal.timeout(30_000);
						try {
							fixed.journal.beginCompensation(fixed.ctx);
							const reverse = fixed.files.map((file) =>
								fixed.journal.claimCompensate(fixed.ctx, file, lease),
							);
							for (const claim of reverse) {
								if (!claim.mayExecute) throw new Error("Compensation claim already attempted");
								lease.registerMutation(claim.mutationId);
							}
							const compensated = await history.dispatch(
								"compensate",
								{
									binding: history.binding,
									operationId: `${nativeId}:compensate`,
									requestDigest: hash({
										planId: input.planId,
										planHash: input.planHash,
										original: nativeId,
										phase: "compensate",
									}),
									originalOperationId: nativeId,
								},
								cleanup,
							);
							await this.recordBatch(
								fixed,
								reverse,
								compensated,
								lease,
								"compensate",
								cleanup,
								actor,
							);
							const outcome = await fixed.journal.finishCompensation(fixed.ctx, {
								signal: cleanup,
							});
							if (outcome.status !== "compensated")
								throw new Error("Conditional snapshot compensation incomplete");
							return {
								planId: input.planId,
								status: "compensated",
								restoredFileCount: 0,
								nativeOperationId: nativeId,
								reason:
									_error instanceof Error
										? _error.message.slice(0, 512)
										: "WORKSPACE_POSTCONDITION_FAILED",
							};
						} catch {
							lease.markUncertain();
							return {
								planId: input.planId,
								status: "recovery_required",
								restoredFileCount: 0,
								nativeOperationId: nativeId,
								reason: "CONDITIONAL_COMPENSATION_CONFLICT",
							};
						}
					}
				},
			);
			return {
				...result,
				coverage: {
					restoredFiles:
						result.status === "committed"
							? fixed.files.map((file) => file.identityJson.displayPath)
							: [],
					conflicts: [],
					unknownCoverage: registry.coordinator.revertUnknownCoverage(scope),
				},
			};
		} finally {
			ownedParser?.close();
			this.active--;
			this.slow(started, "apply");
		}
	}
	private async recordBatch(
		fixed: Awaited<ReturnType<RemoteWorkspaceRestoreService["load"]>>,
		claims: RevertJournalClaim[],
		receipt: RemoteHistoryReceipt,
		lease: WorkspaceWriteLease,
		phase: "apply" | "compensate",
		signal: AbortSignal,
		actor: RemoteHistoryActor,
	) {
		if (receipt.effects.length !== claims.length)
			throw new Error("Native workspace receipt changed the exact delta set");
		const registry = this.options.registry;
		for (const [index, claim] of claims.entries()) {
			const path = fixed.manifest.changes[index].path;
			const matches = receipt.effects.filter((effect) => effect.path === path);
			const effect = matches[0];
			if (
				matches.length !== 1 ||
				!effect ||
				!fileChangeStatesEqual(remoteHistoryFileState(effect.before), claim.expected) ||
				!fileChangeStatesEqual(remoteHistoryFileState(effect.intended), claim.desired)
			)
				throw new Error("Native workspace receipt does not map to its original fixed file claim");
			const applied =
				effect.outcome === "applied" &&
				effect.after &&
				fileChangeStatesEqual(remoteHistoryFileState(effect.after), claim.desired);
			const untouched = effect.outcome === "pending";
			const after: FileChangeState =
				applied && effect.after
					? remoteHistoryFileState(effect.after)
					: untouched
						? claim.expected
						: { kind: "unknown", reason: "result_unknown" };
			if (applied && effect.after?.kind === "regular") {
				const endpoint = await registry.resolve(
					actor,
					{
						deviceId: fixed.origin.deviceId,
						cwd: fixed.origin.binding.root,
						lexicalPath: fixed.manifest.files[index].identity.lexicalPath,
						canonicalPath: fixed.manifest.files[index].identity.canonicalPath,
						runtimeGeneration: lease.executionBinding.runtimeGeneration,
						rootIdentity: fixed.origin.binding.rootIdentity,
					},
					"read",
					signal,
					fixed.manifest.files[index].identity,
					true,
				);
				await registry.importState(
					fixed.namespace,
					after,
					await endpoint.runtime.history.readObject(effect.after.object, signal),
					signal,
				);
			}
			const converted = {
				receiptId: receipt.operationId,
				mutationId: claim.mutationId,
				requestDigest: claim.requestDigest,
				executionBinding: claim.executionBinding,
				confirmed: Boolean(applied || untouched),
				outcome: applied
					? ("applied" as const)
					: untouched
						? ("not_applied" as const)
						: ("unknown" as const),
				observedAfter: after,
			};
			if (phase === "apply")
				await fixed.journal.recordApplyReceipt(fixed.ctx, fixed.files[index].id, converted);
			else await fixed.journal.recordCompensateReceipt(fixed.ctx, fixed.files[index].id, converted);
			lease.settle(claim.mutationId, converted.confirmed ? converted.outcome : "unknown");
		}
	}
	async recover(input: {
		principal: NarratorPrincipal;
		narratorId: string;
		planId: string;
		planHash: string;
		confirmation: RemoteWorkspaceRestoreConfirmation;
		signal?: AbortSignal;
	}): Promise<RemoteWorkspaceRestoreResult> {
		if (this.active >= FILE_CHANGE_LIMITS.captureConcurrency)
			throw new Error("Workspace restore recovery busy");
		this.active++;
		const started = performance.now();
		const signal = AbortSignal.any([
			...(input.signal ? [input.signal] : []),
			AbortSignal.timeout(this.timeout),
		]);
		let ownedParser: RemoteRestoreParser | undefined;
		try {
			const parser = new RemoteRestoreParser(signal);
			ownedParser = parser;
			const fixed = await this.load(
				input.principal,
				input.narratorId,
				input.planId,
				input.planHash,
				input.confirmation,
				signal,
				parser,
			);
			if (["planned", "prepared", "cancelled", "expired"].includes(fixed.operation.status))
				throw new Error(
					"Recovery requires an original attempted workspace restore; it never starts a prepared plan",
				);
			return await this.reconcile(input, fixed, signal, parser);
		} finally {
			ownedParser?.close();
			this.active--;
			this.slow(started, "recover");
		}
	}

	private async reconcile(
		input: {
			principal: NarratorPrincipal;
			narratorId: string;
			planId: string;
			planHash: string;
			confirmation: RemoteWorkspaceRestoreConfirmation;
		},
		fixed: Awaited<ReturnType<RemoteWorkspaceRestoreService["load"]>>,
		signal: AbortSignal,
		parser: RemoteRestoreParser,
	): Promise<RemoteWorkspaceRestoreResult> {
		const first = fixed.files[0];
		if (fixed.operation.status === "compensated") {
			const held =
				first &&
				this.options.registry.options.db
					.select({ id: workspaceWriteLeases.leaseId })
					.from(workspaceWriteLeases)
					.where(
						and(
							eq(workspaceWriteLeases.scopeId, first.scopeId),
							eq(workspaceWriteLeases.deviceId, fixed.origin.deviceId),
							sql`${workspaceWriteLeases.status} in ('executing','quarantined')`,
						),
					)
					.limit(1)
					.get();
			// Finishing the logical journal is not evidence that its native lease closed.
			if (!held) return { planId: input.planId, status: "compensated", restoredFileCount: 0 };
		}
		if (!first)
			return {
				planId: input.planId,
				status: fixed.operation.status === "committed" ? "committed" : "recovery_required",
				restoredFileCount: 0,
			};
		const phase = (first.receiptJson as FileChangeRevertMutationJournal | null)?.apply;
		const nativeId = `workspace_restore:${input.planId}`;
		const fence =
			phase?.executionBinding.fencingToken ??
			this.options.registry.evidence.getScope(first.scopeId)?.fencingToken;
		if (!fence) throw new Error("Original workspace restore execution fence unavailable");
		const { history } = await this.options.registry.resolveRecoveryHistory(
			this.actor(input.principal, input.narratorId, fixed.origin),
			first.identityJson,
			fence,
			signal,
		);
		const receipt = await history.status(nativeId, signal);
		const expectedDigest = hash({
			purpose: "remote_workspace_snapshot_restore_v1",
			planId: input.planId,
			planHash: input.planHash,
			confirmation: input.confirmation,
		});
		if (
			receipt.requestDigest !== expectedDigest ||
			receipt.operationId !== nativeId ||
			receipt.effects.length !== fixed.files.length
		)
			throw new Error("Original native workspace receipt identity/digest mismatch");
		if (receipt.state === "rejected") {
			if (fixed.operation.status === "committed")
				throw new Error("Native refusal contradicts a committed workspace restore");
			const noDispatch = await history.proveNoDispatch(receipt);
			for (const [index, file] of fixed.files.entries()) {
				const journal = file.receiptJson as FileChangeRevertMutationJournal | null;
				const original = journal?.apply;
				const change = noDispatch.receipt.effects[index];
				if (
					!original ||
					journal?.compensate ||
					change?.path !== fixed.manifest.changes[index].path ||
					!fileChangeStatesEqual(remoteHistoryFileState(change.before), file.expectedStateJson) ||
					!fileChangeStatesEqual(remoteHistoryFileState(change.intended), file.desiredStateJson)
				)
					throw new Error("Original native refusal does not cover the fixed workspace claim");
				await fixed.journal.recordApplyReceipt(fixed.ctx, file.id, {
					receiptId: nativeId,
					mutationId: file.applyMutationId,
					requestDigest: file.applyRequestDigest,
					executionBinding: original.executionBinding,
					confirmed: true,
					outcome: "not_applied",
					observedAfter: file.expectedStateJson,
				});
			}
			if (fixed.journal.getOperation(fixed.ctx).status !== "compensated") {
				fixed.journal.beginCompensation(fixed.ctx);
				if (
					(await fixed.journal.finishCompensation(fixed.ctx, { signal })).status !== "compensated"
				)
					throw new Error("Original workspace refusal bookkeeping incomplete");
			}
			const scope = await this.scope(fixed.origin);
			const leases = this.options.registry.options.db
				.select({ id: workspaceWriteLeases.leaseId })
				.from(workspaceWriteLeases)
				.where(
					and(
						eq(workspaceWriteLeases.scopeId, scope.id),
						eq(workspaceWriteLeases.deviceId, scope.deviceId),
						sql`${workspaceWriteLeases.status} in ('executing','quarantined')`,
					),
				)
				.limit(2)
				.all();
			if (leases.length > 1)
				throw new Error("Workspace refusal cannot release ambiguous original leases");
			if (leases.length === 1) {
				const proof = await attestRemoteRevertLeaseRecovery({
					registry: this.options.registry,
					principal: input.principal,
					narratorId: input.narratorId,
					planId: input.planId,
					planHash: input.planHash,
					scope,
					leaseId: leases[0].id,
					signal,
					workspaceSnapshot: {
						captureId: fixed.origin.captureId,
						treeDigest: fixed.origin.descriptor.digest,
					},
					noDispatchProofs: [noDispatch],
				});
				const reservation = this.options.registry.coordinator.reserveRemoteRecovery(
					{ scope, leaseId: leases[0].id },
					proof,
				);
				try {
					reservation.complete(() => undefined);
				} finally {
					reservation.release();
				}
			}
			return {
				planId: input.planId,
				status: "compensated",
				restoredFileCount: 0,
				nativeOperationId: nativeId,
				reason: "ORIGINAL_NATIVE_REFUSAL_RECONCILED",
			};
		}
		if (
			["applying", "files_verified", "recovery_required"].includes(fixed.operation.status) &&
			receipt.state === "settled" &&
			receipt.effects.every((effect) => effect.outcome === "applied" && effect.after)
		) {
			for (const [index, file] of fixed.files.entries()) {
				const original = (file.receiptJson as FileChangeRevertMutationJournal | null)?.apply;
				if (!original) throw new Error("Original native workspace claim is absent");
				const matches = receipt.effects.filter(
					(effect) => effect.path === fixed.manifest.changes[index].path,
				);
				const effect = matches[0];
				if (
					matches.length !== 1 ||
					!effect.after ||
					!fileChangeStatesEqual(remoteHistoryFileState(effect.before), file.expectedStateJson) ||
					!fileChangeStatesEqual(remoteHistoryFileState(effect.after), file.desiredStateJson)
				)
					throw new Error("Native receipt cannot prove the original workspace claim");
				const after = remoteHistoryFileState(effect.after);
				if (original.receipt) {
					const old = original.receipt;
					if (
						old.receiptId !== nativeId ||
						old.mutationId !== file.applyMutationId ||
						old.requestDigest !== file.applyRequestDigest ||
						!old.confirmed ||
						old.outcome !== "applied" ||
						!fileChangeExecutionBindingMatches(old.executionBinding, original.executionBinding) ||
						old.executionBinding.fencingToken !== receipt.binding.fence ||
						!fileChangeStatesEqual(old.observedAfter, after)
					)
						throw new Error(
							"Existing immutable workspace receipt differs from the original native acknowledgement",
						);
					continue;
				}
				if (effect.after.kind === "regular") {
					const originalFile = await this.options.registry.resolveRecoveryHistory(
						this.actor(input.principal, input.narratorId, fixed.origin),
						file.identityJson,
						original.executionBinding.fencingToken,
						signal,
					);
					await this.options.registry.importState(
						fixed.namespace,
						after,
						await originalFile.history.readObject(effect.after.object, signal),
						signal,
					);
				}
				await fixed.journal.recordApplyReceipt(fixed.ctx, file.id, {
					receiptId: nativeId,
					mutationId: file.applyMutationId,
					requestDigest: file.applyRequestDigest,
					executionBinding: original.executionBinding,
					confirmed: true,
					outcome: "applied",
					observedAfter: after,
				});
			}
			const actor = this.actor(input.principal, input.narratorId, fixed.origin);
			for (const [index, file] of fixed.files.entries()) {
				const backend = this.options.registry.options.backend(fixed.origin.deviceId);
				const endpoint = await this.options.registry.resolve(
					actor,
					{
						deviceId: fixed.origin.deviceId,
						cwd: fixed.origin.binding.root,
						lexicalPath: file.identityJson.lexicalPath,
						canonicalPath: file.identityJson.canonicalPath,
						runtimeGeneration: backend.runtimeGeneration,
						rootIdentity: fixed.origin.binding.rootIdentity,
					},
					"read",
					signal,
					file.identityJson,
					true,
				);
				const current = await endpoint.runtime.observe(file.identityJson, signal);
				const nativeAfter = receipt.effects.find(
					(effect) => effect.path === fixed.manifest.changes[index].path,
				)?.after;
				if (
					!nativeAfter ||
					!fileChangeStatesEqual(
						remoteHistoryFileState(current.state),
						remoteHistoryFileState(nativeAfter),
					) ||
					(nativeAfter.kind === "regular" &&
						(current.state.kind !== "regular" ||
							current.state.incarnation !== nativeAfter.incarnation ||
							current.state.metadata?.digest !== nativeAfter.metadata?.digest))
				)
					throw new Error(
						"External modification prevents workspace restore receipt reconciliation",
					);
			}
			await this.authority.owner(input.principal, input.narratorId, signal);
			await this.authority.policy(actor, fixed.origin, signal);
			await fixed.journal.finishFiles(fixed.ctx, { signal });
			// Keep the original unknown lease/native pending barrier. Recovery does not
			// borrow a local PID/TTL or acquire a fresh fence to declare the whole tree complete.
			const held = this.options.registry.options.db
				.select({
					fence: workspaceWriteLeases.fencingToken,
					mutations: workspaceWriteLeases.mutationManifestJson,
				})
				.from(workspaceWriteLeases)
				.where(
					and(
						eq(workspaceWriteLeases.scopeId, first.scopeId),
						eq(workspaceWriteLeases.deviceId, fixed.origin.deviceId),
						sql`${workspaceWriteLeases.status} in ('executing','quarantined')`,
						sql`octet_length(${workspaceWriteLeases.mutationManifestJson}) <= ${FILE_CHANGE_LIMITS.summaryBytes}`,
					),
				)
				.limit(2)
				.all();
			const mutationIds = new Set(fixed.files.map((file) => file.applyMutationId));
			if (
				held.length !== 1 ||
				held[0].fence !== receipt.binding.fence ||
				held[0].mutations.mutations.length !== mutationIds.size ||
				held[0].mutations.mutations.some((item) => !mutationIds.has(item.mutationId))
			)
				throw new Error("Original whole-workspace recovery lease is absent or ambiguous");
			if (!fixed.manifest.currentReceipt)
				throw new Error("Original current tree proof unavailable");
			await this.readTree(
				parser,
				actor,
				fixed.origin,
				fixed.manifest.currentReceipt.binding,
				fixed.manifest.currentReceipt,
				"current",
				input.principal,
				input.narratorId,
				signal,
			);
			await parser.request({ kind: "postExpected", effects: receipt.effects });
			const policy = await this.authority.policy(actor, fixed.origin, signal);
			const captureId = `restore_recover_post_${generateId()}`;
			const captureHistory = await this.options.registry.resolveRecoveryTreeCaptureHistory(
				actor,
				receipt.binding,
				fixed.origin.deviceId,
				policy,
				signal,
			);
			const recoveredTree = await captureHistory.captureTree(
				{
					binding: history.binding,
					operationId: captureId,
					requestDigest: hash({ operationId: captureId, binding: history.binding, policy }),
					treePolicy: policy,
					capturePhase: "warm",
				},
				signal,
			);
			await this.readTree(
				parser,
				actor,
				fixed.origin,
				recoveredTree.binding,
				recoveredTree,
				"after",
				input.principal,
				input.narratorId,
				signal,
			);
			await parser.request({ kind: "verifyPost" });
			signal.throwIfAborted();
			fixed.journal.commit(fixed.ctx, {
				db: this.options.registry.options.db,
				apply: () => undefined,
			});
		}
		const durable = fixed.journal.getOperation(fixed.ctx);
		if (durable.status === "committed" && ["settled", "finalized"].includes(receipt.state)) {
			const acknowledged =
				receipt.state === "finalized"
					? receipt
					: await history.finalize(nativeId, receipt.requestDigest, input.planId, signal);
			if (acknowledged.state !== "finalized" || acknowledged.serverCommitId !== input.planId)
				throw new Error("Original workspace restore finalize cannot be proven");
			const scope = await this.scope(fixed.origin);
			const leases = this.options.registry.options.db
				.select({ id: workspaceWriteLeases.leaseId })
				.from(workspaceWriteLeases)
				.where(
					and(
						eq(workspaceWriteLeases.scopeId, scope.id),
						eq(workspaceWriteLeases.deviceId, scope.deviceId),
						sql`${workspaceWriteLeases.status} in ('executing','quarantined')`,
					),
				)
				.limit(2)
				.all();
			if (leases.length > 1)
				throw new Error("Workspace restore recovery cannot release ambiguous original leases");
			if (leases.length === 1) {
				const proof = await attestRemoteRevertLeaseRecovery({
					registry: this.options.registry,
					principal: input.principal,
					narratorId: input.narratorId,
					planId: input.planId,
					planHash: input.planHash,
					scope,
					leaseId: leases[0].id,
					signal,
					workspaceSnapshot: {
						captureId: fixed.origin.captureId,
						treeDigest: fixed.origin.descriptor.digest,
					},
				});
				const reservation = this.options.registry.coordinator.reserveRemoteRecovery(
					{ scope, leaseId: leases[0].id },
					proof,
				);
				try {
					reservation.complete(() => undefined);
				} finally {
					reservation.release();
				}
			}
			return {
				planId: input.planId,
				status: "committed",
				restoredFileCount: fixed.files.length,
				nativeOperationId: nativeId,
				reason: "ORIGINAL_RECEIPT_RECONCILED",
			};
		}
		return {
			planId: input.planId,
			status: "recovery_required",
			restoredFileCount: 0,
			nativeOperationId: nativeId,
			reason: "NATIVE_RECEIPT_REQUIRES_ORIGINAL_LEASE_RECONCILIATION",
		};
	}
	private slow(started: number, phase: string) {
		const durationMs = performance.now() - started;
		if (durationMs > 1000)
			logger.warn("Slow bounded remote workspace restore", { phase, durationMs });
	}
}
