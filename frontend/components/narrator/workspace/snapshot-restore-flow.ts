import type {
	WorkspaceSnapshotRestorePreview,
	WorkspaceSnapshotRestoreRequest,
	WorkspaceSnapshotRestoreResult,
	WorkspaceSnapshotSummary,
} from "../../../lib/api/workspace-snapshot-restores";

export interface PendingSnapshotRestore {
	version: 1;
	snapshot: WorkspaceSnapshotSummary;
	origin: WorkspaceSnapshotRestorePreview["origin"];
	request: WorkspaceSnapshotRestoreRequest;
}
export interface SnapshotRestoreState {
	step:
		| "idle"
		| "previewing"
		| "ready"
		| "stale"
		| "applying"
		| "recovery"
		| "recovering"
		| "finished";
	snapshot?: WorkspaceSnapshotSummary;
	preview?: WorkspaceSnapshotRestorePreview;
	pending?: PendingSnapshotRestore;
	result?: WorkspaceSnapshotRestoreResult;
	error?: string;
	consent: boolean;
}
export interface SnapshotRestorePorts {
	scope: () => string | null;
	now: () => number;
	requestId: () => string;
	preview: (
		input: { captureId: string; idempotencyKey: string },
		signal: AbortSignal,
	) => Promise<WorkspaceSnapshotRestorePreview>;
	apply: (input: WorkspaceSnapshotRestoreRequest) => Promise<WorkspaceSnapshotRestoreResult>;
	recover: (input: WorkspaceSnapshotRestoreRequest) => Promise<WorkspaceSnapshotRestoreResult>;
	save: (pending: PendingSnapshotRestore) => void;
	complete: (request: WorkspaceSnapshotRestoreRequest) => void;
}
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
export function snapshotIsCandidate(snapshot: WorkspaceSnapshotSummary): boolean {
	return (
		snapshot.originContextVersion === 1 &&
		snapshot.state === "complete" &&
		snapshot.restorableCandidate === true &&
		[
			snapshot.id,
			snapshot.deviceId,
			snapshot.root,
			snapshot.rootIdentity,
			snapshot.treeDigest,
			snapshot.sourceInstanceId,
			snapshot.scopeId,
			snapshot.contextKey,
		].every(nonempty) &&
		typeof snapshot.workspaceRevision === "number" &&
		Number.isSafeInteger(snapshot.workspaceRevision) &&
		snapshot.workspaceRevision >= 0 &&
		(snapshot.originProjectId === null || typeof snapshot.originProjectId === "string")
	);
}
function identity(snapshot: WorkspaceSnapshotSummary) {
	return JSON.stringify([
		snapshot.id,
		snapshot.deviceId,
		snapshot.root,
		snapshot.rootIdentity,
		snapshot.treeDigest,
		snapshot.sourceInstanceId,
		snapshot.scopeId,
		snapshot.contextKey,
		snapshot.workspaceRevision,
		snapshot.originProjectId,
		snapshot.originContextVersion,
		snapshot.state,
		snapshot.restorableCandidate,
	]);
}
export function previewMatchesSnapshot(
	snapshot: WorkspaceSnapshotSummary,
	preview: WorkspaceSnapshotRestorePreview,
): boolean {
	const origin = preview.origin,
		confirmation = preview.confirmation;
	return (
		snapshotIsCandidate(snapshot) &&
		preview.requiresExplicitSnapshotRestore === true &&
		preview.plan.status === "prepared" &&
		preview.plan.coverageComplete === true &&
		nonempty(preview.plan.id) &&
		nonempty(preview.plan.planHash) &&
		Number.isFinite(Date.parse(preview.plan.expiresAt)) &&
		origin.originContextVersion === 1 &&
		origin.captureId === snapshot.id &&
		origin.deviceId === snapshot.deviceId &&
		origin.root === snapshot.root &&
		origin.rootIdentity === snapshot.rootIdentity &&
		origin.treeDigest === snapshot.treeDigest &&
		origin.sourceInstanceId === snapshot.sourceInstanceId &&
		origin.scopeId === snapshot.scopeId &&
		nonempty(origin.scopeId) &&
		origin.contextKey === snapshot.contextKey &&
		origin.workspaceRevision === snapshot.workspaceRevision &&
		origin.originProjectId === snapshot.originProjectId &&
		confirmation.kind === "snapshot_restore" &&
		confirmation.captureId === origin.captureId &&
		confirmation.deviceId === origin.deviceId &&
		confirmation.root === origin.root &&
		confirmation.rootIdentity === origin.rootIdentity &&
		confirmation.treeDigest === origin.treeDigest &&
		Array.isArray(preview.files) &&
		preview.files.length <= 100 &&
		Number.isSafeInteger(preview.totalFileCount) &&
		preview.totalFileCount >= preview.files.length &&
		typeof preview.hasMore === "boolean"
	);
}
function message(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
function refused(error: unknown) {
	if (
		typeof error !== "object" ||
		error === null ||
		!("status" in error) ||
		![400, 409, 412].includes(Number(error.status))
	)
		return false;
	const data =
		"data" in error && typeof error.data === "object" && error.data !== null
			? (error.data as Record<string, unknown>)
			: undefined;
	const code = data?.code ?? ("code" in error ? error.code : undefined);
	// Explicit pre-dispatch codes only. Auth revocation may occur after a write;
	// OUTCOME_UNKNOWN and untyped 409s must keep the original receipt.
	return [
		"VALIDATION_ERROR",
		"REVERT_JOURNAL_REQUEST_CONFLICT",
		"REVERT_JOURNAL_EXPIRED",
		"REVERT_PLAN_EXPIRED",
		"WORKSPACE_SNAPSHOT_RESTORE_UNAVAILABLE",
	].includes(String(code));
}

/** Only explicit user consent admits apply. Recovery always keeps the original source/hash. */
export class SnapshotRestoreFlow {
	state: SnapshotRestoreState = { step: "idle", consent: false };
	private listeners = new Set<(state: SnapshotRestoreState) => void>();
	private generation = 0;
	private read?: AbortController;
	private preparedScope: string | null = null;
	private previewKey?: { captureId: string; idempotencyKey: string };
	private writing = false;
	private consentKey: string | null = null;
	private bindingKey() {
		const request =
			this.state.pending?.request ??
			(this.state.preview
				? {
						planId: this.state.preview.plan.id,
						planHash: this.state.preview.plan.planHash,
						confirmation: this.state.preview.confirmation,
					}
				: null);
		return request
			? JSON.stringify([request.planId, request.planHash, request.confirmation, this.ports.scope()])
			: null;
	}
	constructor(
		private ports: SnapshotRestorePorts,
		pending?: PendingSnapshotRestore,
	) {
		if (pending)
			this.state = {
				step: "recovery",
				consent: false,
				snapshot: structuredClone(pending.snapshot),
				pending: structuredClone(pending),
			};
	}
	subscribe(listener: (state: SnapshotRestoreState) => void) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	private update(patch: Partial<SnapshotRestoreState>) {
		if (patch.consent === false) this.consentKey = null;
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) listener(this.state);
	}
	get busy() {
		return this.writing || this.state.step === "previewing";
	}
	observeScope() {
		if (
			this.state.step === "ready" &&
			this.state.preview &&
			Date.parse(this.state.preview.plan.expiresAt) <= this.ports.now()
		) {
			this.previewKey = undefined;
			this.update({ step: "stale", consent: false, error: "snapshotRestore.expired" });
		}
		if (this.state.preview && this.preparedScope !== this.ports.scope()) {
			this.generation++;
			this.read?.abort();
			this.update({ consent: false, ...(this.state.pending ? {} : { step: "stale" as const }) });
		}
		if (this.state.pending && this.preparedScope !== this.ports.scope() && this.state.consent)
			this.update({ consent: false });
	}
	select(snapshot: WorkspaceSnapshotSummary) {
		if (this.writing || this.state.pending) return;
		this.generation++;
		this.read?.abort();
		this.previewKey = undefined;
		this.update({
			step: "idle",
			snapshot: structuredClone(snapshot),
			preview: undefined,
			result: undefined,
			error: undefined,
			consent: false,
		});
	}
	observeSnapshot(snapshot: WorkspaceSnapshotSummary | undefined) {
		if (this.state.pending || !this.state.snapshot || !snapshot) return;
		if (identity(snapshot) !== identity(this.state.snapshot)) {
			this.generation++;
			this.read?.abort();
			this.previewKey = undefined;
			this.update({
				snapshot: structuredClone(snapshot),
				preview: undefined,
				step: "stale",
				consent: false,
				error: "snapshotRestore.sourceChanged",
			});
		}
	}
	async preview() {
		const snapshot = this.state.snapshot;
		if (
			!snapshot ||
			!snapshotIsCandidate(snapshot) ||
			this.busy ||
			this.state.pending ||
			!this.ports.scope()
		)
			return;
		const generation = ++this.generation;
		this.read?.abort();
		const controller = new AbortController();
		this.read = controller;
		const scope = this.ports.scope();
		if (
			this.state.step === "ready" ||
			this.state.step === "stale" ||
			this.state.step === "finished"
		)
			this.previewKey = undefined;
		this.previewKey ??= { captureId: snapshot.id, idempotencyKey: this.ports.requestId() };
		this.update({ step: "previewing", preview: undefined, error: undefined, consent: false });
		try {
			const preview = await this.ports.preview(this.previewKey, controller.signal);
			if (generation !== this.generation || controller.signal.aborted) return;
			if (scope !== this.ports.scope()) {
				this.update({ step: "stale", consent: false, error: "snapshotRestore.contextChanged" });
				return;
			}
			if (!previewMatchesSnapshot(snapshot, preview))
				throw new Error("snapshotRestore.sourceChanged");
			this.preparedScope = scope;
			this.update({ step: "ready", preview: structuredClone(preview), consent: false });
		} catch (error) {
			if (generation !== this.generation || controller.signal.aborted) return;
			this.update({ step: "idle", preview: undefined, consent: false, error: message(error) });
		}
	}
	canConsent() {
		if (this.writing) return false;
		if (this.state.step === "recovery" && this.state.pending) return !!this.ports.scope();
		return (
			this.state.step === "ready" &&
			!!this.state.snapshot &&
			!!this.state.preview &&
			this.preparedScope === this.ports.scope() &&
			previewMatchesSnapshot(this.state.snapshot, this.state.preview) &&
			Date.parse(this.state.preview.plan.expiresAt) > this.ports.now()
		);
	}
	setConsent(checked: boolean) {
		if (!checked) {
			this.update({ consent: false });
			return;
		}
		if (this.canConsent()) {
			this.preparedScope = this.ports.scope();
			this.consentKey = this.bindingKey();
			this.update({ consent: true });
		}
	}
	canApply() {
		return (
			this.state.consent &&
			this.consentKey === this.bindingKey() &&
			this.state.step === "ready" &&
			this.canConsent()
		);
	}
	canRecover() {
		return (
			this.state.step === "recovery" &&
			!!this.state.pending &&
			this.state.consent &&
			this.consentKey === this.bindingKey() &&
			this.canConsent() &&
			this.preparedScope === this.ports.scope()
		);
	}
	async apply() {
		if (!this.canApply() || this.writing || !this.state.preview || !this.state.snapshot) return;
		const preview = this.state.preview;
		if (!preview.plan.planHash) return;
		const pending: PendingSnapshotRestore = structuredClone({
			version: 1,
			snapshot: this.state.snapshot,
			origin: preview.origin,
			request: {
				planId: preview.plan.id,
				planHash: preview.plan.planHash,
				confirmation: preview.confirmation,
			},
		});
		try {
			this.ports.save(pending);
		} catch (error) {
			this.update({ error: message(error), consent: false });
			return;
		}
		this.writing = true;
		this.update({ step: "applying", pending, error: undefined, consent: false });
		try {
			this.accept(await this.ports.apply(structuredClone(pending.request)), pending);
		} catch (error) {
			if (refused(error)) {
				try {
					this.ports.complete(pending.request);
				} catch {
					this.update({ step: "recovery", error: message(error), consent: false });
					return;
				}
				this.previewKey = undefined;
				this.update({
					step: "stale",
					pending: undefined,
					preview: undefined,
					error: message(error),
					consent: false,
				});
			} else this.update({ step: "recovery", error: message(error), consent: false });
		} finally {
			this.writing = false;
			this.update({});
		}
	}
	async recover() {
		if (!this.canRecover() || this.writing || !this.state.pending) return;
		const pending = this.state.pending;
		this.writing = true;
		this.update({ step: "recovering", consent: false, error: undefined });
		try {
			this.accept(await this.ports.recover(structuredClone(pending.request)), pending);
		} catch (error) {
			this.update({ step: "recovery", error: message(error), consent: false });
		} finally {
			this.writing = false;
			this.update({});
		}
	}
	private accept(result: WorkspaceSnapshotRestoreResult, pending: PendingSnapshotRestore) {
		if (
			result.planId !== pending.request.planId ||
			!["committed", "compensated", "recovery_required"].includes(result.status)
		)
			throw new Error("snapshotRestore.resultUnknown");
		if (result.status === "recovery_required") {
			this.update({ step: "recovery", result, error: result.reason, consent: false });
			return;
		}
		this.ports.complete(pending.request);
		this.update({
			step: "finished",
			pending: undefined,
			preview: undefined,
			result,
			error: undefined,
			consent: false,
		});
	}
	cancel() {
		if (this.writing) return false;
		this.generation++;
		this.read?.abort();
		this.update({
			consent: false,
			...(this.state.pending
				? { step: "recovery" as const }
				: { step: "idle" as const, preview: undefined }),
		});
		return true;
	}
}
