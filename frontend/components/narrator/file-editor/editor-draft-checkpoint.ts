import { editorDocumentApi } from "../../../lib/api/editor-documents";
import type { EditorAttemptSpool } from "./editor-attempt-spool";
import {
	type EditorDraftMetadata,
	type EditorDraftOperation,
	type EditorDraftScope,
	type EditorDraftStore,
	EditorDraftWriteFailure,
	editorDraftStore,
	editorDraftWriterId,
} from "./editor-draft-store";
import { serializeEditorFormat } from "./editor-format";
import { type EditorRawSnapshot, encodeEditorRawSnapshot } from "./editor-save-client";
import { sessionDirty } from "./editor-session-state";
import { captureEditorSnapshot, encodeEditorSnapshot } from "./editor-worker-client";
import type { EditorWorkingCopy } from "./editor-working-copy";

interface DraftTask {
	run(signal: AbortSignal): Promise<void>;
	flush(): void;
	maintenance?: boolean;
}
/** One realm-wide deadline/queue and one running checkpoint, not a timer per tab. */
export class EditorDraftScheduler {
	private queue = new Map<DraftTask, { first: number; due: number }>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private running: { owner: DraftTask; controller: AbortController } | undefined;
	private foreground = new Set<DraftTask>();
	private leased = new Set<EditorDraftCheckpoint>();
	private leaseTask: DraftTask = {
		maintenance: true,
		flush: () => {
			if (this.leased.size) this.scheduleAt(this.leaseTask, 10_000);
		},
		run: async (signal) => {
			try {
				for (const owner of this.leased) {
					signal.throwIfAborted();
					await owner.renewLease(signal);
				}
			} catch {
				/* cancellation/failure is surfaced by the owner; never blocks save */
			} finally {
				this.leaseTask.flush();
			}
		},
	};
	track(owner: EditorDraftCheckpoint, active: boolean) {
		if (active && this.leased.size < 32) this.leased.add(owner);
		else if (!active) this.leased.delete(owner);
		if (this.leased.size) this.leaseTask.flush();
		else this.cancel(this.leaseTask);
	}
	constructor(
		private now = Date.now,
		private scheduleTimer = (callback: () => void, ms: number) => setTimeout(callback, ms),
		private cancelTimer = (timer: ReturnType<typeof setTimeout> | undefined) => clearTimeout(timer),
	) {}
	schedule(owner: DraftTask, immediate = false) {
		const now = this.now(),
			first = this.queue.get(owner)?.first ?? now;
		this.queue.set(owner, { first, due: immediate ? now : Math.min(now + 1000, first + 5000) });
		this.arm();
	}
	scheduleAt(owner: DraftTask, delay: number) {
		if (!this.queue.has(owner))
			this.queue.set(owner, { first: this.now(), due: this.now() + delay });
		this.arm();
	}
	cancel(owner: DraftTask) {
		this.queue.delete(owner);
		if (this.running?.owner === owner) this.running.controller.abort();
		this.arm();
	}
	priority(owner: DraftTask, busy: boolean) {
		if (busy) {
			this.foreground.add(owner);
			this.running?.controller.abort();
		} else this.foreground.delete(owner);
		this.arm();
	}
	private arm() {
		this.cancelTimer(this.timer);
		this.timer = undefined;
		if (this.running || this.foreground.size || !this.queue.size) return;
		const due = Math.min(...[...this.queue.values()].map((row) => row.due));
		this.timer = this.scheduleTimer(() => this.drain(), Math.max(0, due - this.now()));
		this.timer.unref?.();
	}
	private drain() {
		if (this.running || this.foreground.size) return;
		const next = [...this.queue].sort((a, b) => a[1].due - b[1].due)[0];
		if (!next) return;
		const [owner] = next;
		this.queue.delete(owner);
		const controller = new AbortController();
		this.running = { owner, controller };
		void owner.run(controller.signal).finally(() => {
			this.running = undefined;
			if (controller.signal.aborted) owner.flush();
			this.arm();
		});
	}
	diagnostics() {
		return {
			queued: [...this.queue.keys()].filter((owner) => !owner.maintenance).length,
			running: this.running ? 1 : 0,
			foreground: this.foreground.size,
		};
	}
}
export const editorDraftScheduler = new EditorDraftScheduler();
export class EditorDraftCheckpoint {
	private signature = "";
	private sequence = 0;
	private disposed = false;
	private checkpoint: EditorDraftMetadata | undefined;
	private releaseSnapshot: (() => void) | undefined;
	private operation: EditorDraftOperation | undefined;
	private discarding = false;
	private discardTask: Promise<boolean> | undefined;
	private baseHash: string | null;
	private capturedRevision: number | undefined;
	private modelLifetime: string | undefined;
	private hasServerAnchor = false;
	private lastAnchorId: string | undefined;
	private failedAnchorId: string | undefined;
	private anchorEpoch = 0;
	private dispatchPending() {
		const phase = this.copy.getSnapshot().phase;
		return phase === "committing" || phase === "unknown";
	}
	private releaseIds(ids: Iterable<string | undefined>) {
		for (const id of new Set(ids))
			if (id)
				void editorDocumentApi
					.releaseDraftAnchor(this.scope.narratorId, id, {
						deviceId: this.scope.deviceId,
						origin: this.scope.origin,
					})
					.catch(() => {});
	}
	private releaseStaleIds(ids: Iterable<string | undefined>) {
		const protectedIds = new Set([
			this.hasServerAnchor ? this.lastAnchorId : undefined,
			this.hasServerAnchor ? this.checkpoint?.anchor?.anchorId : undefined,
			this.dispatchPending() ? this.failedAnchorId : undefined,
		]);
		this.releaseIds([...ids].filter((id) => !protectedIds.has(id)));
	}
	private releaseAnchors(row?: EditorDraftMetadata, preserveDispatch = true) {
		const ids = new Set([row?.anchor?.anchorId, this.lastAnchorId, this.failedAnchorId]);
		const held =
			preserveDispatch && this.dispatchPending()
				? (this.lastAnchorId ?? this.failedAnchorId ?? row?.anchor?.anchorId)
				: undefined;
		this.lastAnchorId = undefined;
		this.failedAnchorId = held;
		this.hasServerAnchor = false;
		this.anchorEpoch++;
		this.releaseIds([...ids].filter((id) => id !== held));
	}
	/** Explicit original-owner discard; never deletes another realm's metadata. */
	discard(): Promise<boolean> {
		if (this.discardTask) return this.discardTask;
		const hadWork = !!this.checkpoint || !!this.releaseSnapshot;
		this.discarding = true;
		this.sequence++;
		this.scheduler.cancel(this);
		this.scheduler.track(this, false);
		this.discardTask = (async () => {
			try {
				if (hadWork)
					await this.store.removeSaved(
						this.writerId,
						this.scope.resourceKey,
						undefined,
						this.copy.lifetimeId,
					);
				this.releaseAnchors(this.checkpoint);
				this.checkpoint = undefined;
				return true;
			} catch {
				this.discarding = false;
				this.discardTask = undefined;
				this.copy.setBackupError(true);
				return false;
			}
		})();
		return this.discardTask;
	}
	constructor(
		readonly copy: EditorWorkingCopy,
		readonly scope: EditorDraftScope,
		private store: EditorDraftStore = editorDraftStore,
		private scheduler = editorDraftScheduler,
		readonly writerId = editorDraftWriterId,
	) {
		this.baseHash = copy.getSnapshot().baseHash;
		this.modelLifetime = copy.lifetimeId;
	}
	changed() {
		if (this.disposed || this.discarding) return;
		const state = this.copy.getSnapshot();
		if (state.phase === "idle" && !state.invalidated) this.operation = undefined;
		const busy = state.phase === "encoding";
		this.scheduler.priority(this, busy);
		if (this.modelLifetime !== this.copy.lifetimeId) {
			this.modelLifetime = this.copy.lifetimeId;
			this.sequence++;
			this.scheduler.cancel(this);
		}
		const signature = JSON.stringify([
			this.copy.lifetimeId,
			state.version?.revision,
			state.phase,
			state.baseHash,
			state.invalidated,
			sessionDirty(state),
			state.loaded,
		]);
		if (signature === this.signature) return;
		this.signature = signature;
		if (this.baseHash !== state.baseHash) {
			this.baseHash = state.baseHash;
			this.sequence++;
			this.scheduler.cancel(this);
		}
		// New input queues the latest intent, but does not invalidate a useful immutable
		// checkpoint already encoding. Otherwise sustained typing could starve backups forever.
		if (!sessionDirty(state)) this.scheduler.track(this, false);
		else if (this.checkpoint) this.scheduler.track(this, true);
		if (busy || !sessionDirty(state) || !state.loaded) {
			this.sequence++;
			this.scheduler.cancel(this);
			return;
		}
		this.scheduler.schedule(this);
	}
	flush() {
		if (!this.disposed && !this.discarding && sessionDirty(this.copy.getSnapshot()))
			this.scheduler.schedule(this, true);
	}
	/** Before any possible side effect, durably retire any previous ordinary backup. */
	async beforeDispatch(operation: EditorDraftOperation) {
		this.operation = operation;
		// Fence any snapshot captured before the operation association became known.
		this.sequence++;
		this.scheduler.cancel(this);
		try {
			const anchor = await this.store.markOperation(
				this.writerId,
				this.scope.resourceKey,
				operation,
				this.copy.lifetimeId,
			);
			if (anchor) {
				this.hasServerAnchor = true;
				this.lastAnchorId = anchor.anchorId;
			} else {
				// This transaction also fenced all staging: a missing pointer is positive
				// local evidence that this lifetime has no recoverable checkpoint.
				this.releaseAnchors(this.checkpoint, false);
				this.checkpoint = undefined;
				this.scheduler.track(this, false);
			}
		} catch {
			this.copy.setBackupError(true);
		} finally {
			if (!this.disposed && !this.discarding) this.scheduler.schedule(this);
		}
		return this.hasServerAnchor
			? { draftWriterId: this.writerId, draftModelLifetime: this.copy.lifetimeId }
			: undefined;
	}
	async renewLease(signal: AbortSignal) {
		if (!this.checkpoint || this.disposed) return;
		try {
			await this.store.protect(this.checkpoint, this.writerId, signal);
		} catch {
			if (!signal.aborted) this.copy.setBackupError(true);
		}
	}
	async saved(revision: number, lifetime = this.copy.lifetimeId) {
		if (lifetime !== this.copy.lifetimeId) {
			await this.store
				.removeSaved(this.writerId, this.scope.resourceKey, revision, lifetime)
				.catch(() => this.copy.setBackupError(true));
			return;
		}
		this.operation = undefined;
		if (this.capturedRevision === revision) {
			this.sequence++;
			this.scheduler.cancel(this);
		}
		const row = this.checkpoint,
			epoch = this.anchorEpoch,
			anchorAtStart = this.lastAnchorId;
		try {
			const remaining = await this.store.removeSaved(
				this.writerId,
				this.scope.resourceKey,
				revision,
				this.copy.lifetimeId,
			);
			if (!remaining) {
				if (epoch === this.anchorEpoch) this.releaseAnchors(row);
				else this.releaseStaleIds([row?.anchor?.anchorId, anchorAtStart]);
			}
			if (row?.revision === revision && this.checkpoint === row) {
				this.checkpoint = undefined;
				this.scheduler.track(this, false);
			}
		} catch {
			this.copy.setBackupError(true);
		}
	}
	async run(signal: AbortSignal) {
		if (this.disposed || this.discarding || !this.copy.model) return;
		const state = this.copy.getSnapshot();
		if (!state.loaded || !sessionDirty(state) || state.phase === "encoding") return;
		const sequence = this.sequence;
		let createdAnchorId: string | undefined;
		let rawSpool: EditorAttemptSpool | undefined;
		let previousCoverage = false,
			publicationEpoch = -1;
		try {
			signal.throwIfAborted();
			// Snapshot and all revision metadata captured synchronously, without a view.
			const snapshot =
				this.copy.protocol === "raw-v2"
					? this.copy.captureSnapshot()
					: captureEditorSnapshot(this.copy.model);
			const lifetime = this.copy.lifetimeId;
			const raw =
				this.copy.protocol === "raw-v2" ? (snapshot as EditorRawSnapshot).rawFormat : undefined;
			this.capturedRevision = snapshot.revision;
			const operation = this.copy.session.draftOperation ?? this.operation;
			const input = {
				scope: this.scope,
				writerId: this.writerId,
				modelLifetime: lifetime,
				revision: snapshot.revision,
				alternativeVersionId: snapshot.alternativeVersionId,
				length: snapshot.length,
				baseVersion: {
					hash: state.baseHash,
					hashKind: raw ? ("raw-sha256" as const) : ("v1-decoded-sha256" as const),
				},
				encoding: raw?.encoding ?? state.encoding,
				protocol: raw ? ("raw-v2" as const) : ("v1" as const),
				bodyCodec: raw ? "raw-v2" : "utf8-v1",
				...(raw ? { bom: raw.bom, preferredEol: this.copy.preferredEol } : {}),
				...(operation || state.phase === "unknown"
					? {
							operation: operation ?? {
								status: "query-first" as const,
								snapshotRevision: snapshot.revision,
							},
						}
					: {}),
			};
			this.releaseSnapshot = this.copy.pin("checkpoint", {
				models: 0,
				bytes: snapshot.length * 12,
			});
			if (raw) rawSpool = await encodeEditorRawSnapshot(snapshot as EditorRawSnapshot, signal);
			const blob = rawSpool ? rawSpool.body() : await encodeEditorSnapshot(snapshot, signal);
			const sidecar =
				raw && raw.root.kind !== "uniform" ? serializeEditorFormat(raw.root) : undefined;
			signal.throwIfAborted();
			if (sequence !== this.sequence || this.disposed) return;
			await this.store.ensureAvailable(signal);
			const anchor = await editorDocumentApi.createDraftAnchor(
				this.scope.narratorId,
				{
					writerId: this.writerId,
					resourceKey: this.scope.resourceKey,
					revision: snapshot.revision,
					modelLifetime: lifetime,
					deviceId: this.scope.deviceId,
					origin: this.scope.origin,
					...(input.operation
						? {
								operation: {
									operationId: input.operation.operationId,
									snapshotRevision: input.operation.snapshotRevision,
								},
							}
						: {}),
				},
				signal,
			);
			if (
				anchor.recoveryKey !== this.scope.recoveryKey ||
				anchor.resourceKey !== this.scope.resourceKey ||
				anchor.writerId !== this.writerId ||
				anchor.revision !== snapshot.revision ||
				anchor.modelLifetime !== lifetime ||
				this.copy.lifetimeId !== lifetime
			)
				throw new Error("EDITOR_DRAFT_ANCHOR_MISMATCH");
			if (signal.aborted || sequence !== this.sequence || this.disposed || this.discarding) {
				this.releaseIds([anchor.anchorId]);
				return;
			}
			createdAnchorId = anchor.anchorId;
			previousCoverage = this.hasServerAnchor;
			publicationEpoch = ++this.anchorEpoch;
			// Keep at most one failed/unpublished point until a newer server point exists.
			// Replace it only after a newer durable server coverage point exists.
			if (this.failedAnchorId && this.failedAnchorId !== anchor.anchorId) {
				void editorDocumentApi
					.releaseDraftAnchor(this.scope.narratorId, this.failedAnchorId, {
						deviceId: this.scope.deviceId,
						origin: this.scope.origin,
					})
					.catch(() => {});
				this.failedAnchorId = undefined;
			}
			this.hasServerAnchor = true;
			this.lastAnchorId = anchor.anchorId;
			signal.throwIfAborted();
			if (sequence !== this.sequence || this.disposed) return;
			const checkpoint = await this.store.write(
				{
					...input,
					...(rawSpool?.seal
						? {
								rawDigest: rawSpool.seal.rawDigest,
								textDigest: rawSpool.seal.textDigest,
								...(raw?.root.kind === "uniform"
									? {
											format: {
												revision: snapshot.revision,
												codec: "eol-uniform-v1",
												root: {
													tag: raw.root.tag,
													count: raw.root.count,
													digest: rawSpool.seal.formatDigest,
												},
											},
										}
									: {}),
							}
						: {}),
					anchor: { anchorId: anchor.anchorId, checkpointGeneration: anchor.checkpointGeneration },
				},
				blob,
				signal,
				sidecar,
			);
			// Publication may have completed just before save/discard's CAS. A delayed JS
			// completion must not resurrect an already released pointer, writer flag or lease.
			if (sequence !== this.sequence || this.disposed || this.discarding) return;
			this.checkpoint = checkpoint;
			this.hasServerAnchor = true;
			this.scheduler.track(this, true);
			try {
				await editorDocumentApi.publishDraftAnchor(
					this.scope.narratorId,
					anchor.anchorId,
					{ deviceId: this.scope.deviceId, origin: this.scope.origin },
					signal,
				);
				if (sequence === this.sequence && !this.disposed && !this.discarding)
					this.copy.setBackupError(false);
			} catch {
				if (sequence === this.sequence && !this.disposed && !this.discarding)
					this.copy.setBackupError(true);
			}
		} catch (error) {
			if (createdAnchorId && error instanceof EditorDraftWriteFailure) {
				if (
					publicationEpoch === this.anchorEpoch &&
					this.lastAnchorId === createdAnchorId &&
					!previousCoverage
				)
					this.hasServerAnchor = false;
				if (!this.disposed && !this.discarding) this.failedAnchorId = createdAnchorId;
				else if (!this.dispatchPending()) this.releaseIds([createdAnchorId]);
			}
			if (!signal.aborted && !this.disposed) this.copy.setBackupError(true);
		} finally {
			await rawSpool?.dispose();
			this.capturedRevision = undefined;
			this.releaseSnapshot?.();
			this.releaseSnapshot = undefined;
		}
	}
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.sequence++;
		this.scheduler.cancel(this);
		this.scheduler.priority(this, false);
		this.scheduler.track(this, false);
		this.releaseSnapshot?.();
		this.releaseSnapshot = undefined;
	}
}
/** A restored uncertain operation can only query its original receipt, never apply. */
export async function queryDraftOperation(row: EditorDraftMetadata, signal: AbortSignal) {
	if (!row.operation?.operationId) throw new Error("EDITOR_DRAFT_QUERY_REQUIRED");
	const receipt = await editorDocumentApi.operation(
		row.scope.narratorId,
		row.operation.operationId,
		signal,
	);
	if (
		receipt.operationId !== row.operation.operationId ||
		(receipt.status === "saved" &&
			(!receipt.result ||
				receipt.result.snapshotRevision !== row.operation.snapshotRevision ||
				(row.protocol === "raw-v2" && receipt.result.hashKind !== "raw-sha256")))
	)
		throw new Error("EDITOR_DRAFT_RECEIPT_MISMATCH");
	return receipt;
}
