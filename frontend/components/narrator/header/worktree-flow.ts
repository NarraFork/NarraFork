import type {
	WorktreeCreateRequest,
	WorktreeCreateResult,
	WorktreePrepareRequest,
	WorktreePrepareResult,
	WorktreeReconcileRequest,
} from "@shared/narrator-worktrees";
import type { WorkspaceContext } from "@shared/workspace-context";

export interface WorktreeDraft {
	name: string;
	requirement: string;
	branchOverride: string;
	destinationPath: string;
	baseRef: string;
}
export type WorktreeStep = "idle" | "prepare" | "create" | "reconcile" | "switch" | "done";
export interface WorktreeFlowState {
	step: WorktreeStep;
	busy: boolean;
	error?: string;
	unknown?: boolean;
	confirmedFailure?: boolean;
	residuals?: WorktreeCreateResult["residuals"];
	createdPath?: string;
	/** Frozen original proposal: recovery must not change its revision, identity or request id. */
	createRequest?: WorktreeCreateRequest;
}
export interface WorktreeFlowPorts {
	prepare: (input: WorktreePrepareRequest) => Promise<WorktreePrepareResult>;
	create: (input: WorktreeCreateRequest) => Promise<WorktreeCreateResult>;
	reconcile: (input: WorktreeReconcileRequest) => Promise<WorktreeCreateResult>;
	switch: (path: string) => Promise<void>;
	requestId: () => string;
	persist?: (request: WorktreeCreateRequest, draft: WorktreeDraft) => Promise<void>;
	complete?: (requestId: string) => void;
}

export class WorktreeFlow {
	state: WorktreeFlowState = { step: "idle", busy: false };
	private switching = false;
	constructor(
		private ports: WorktreeFlowPorts,
		private changed: (state: WorktreeFlowState) => void,
	) {}
	private update(patch: Partial<WorktreeFlowState>) {
		this.state = { ...this.state, ...patch };
		this.changed(this.state);
	}
	restore(request: WorktreeCreateRequest) {
		this.update({
			createRequest: Object.freeze({ ...request, branch: Object.freeze({ ...request.branch }) }),
			unknown: true,
			step: "idle",
			busy: false,
		});
	}
	private accept(result: WorktreeCreateResult): boolean {
		if (result.outcome === "failed" && this.state.createRequest)
			this.ports.complete?.(this.state.createRequest.requestId);
		if (result.outcome === "created" && result.worktree) {
			this.update({
				unknown: false,
				confirmedFailure: false,
				createdPath: result.worktree.path,
				residuals: result.residuals,
				error: undefined,
			});
			return true;
		}
		this.update({
			unknown: result.outcome !== "failed",
			confirmedFailure: result.outcome === "failed",
			residuals: result.residuals,
			error: result.error?.message ?? result.outcome,
		});
		return false;
	}
	async submit(draft: WorktreeDraft, context: WorkspaceContext) {
		if (this.state.busy || this.state.unknown || this.state.createdPath) return;
		if (!draft.name.trim() && !draft.requirement.trim()) {
			this.update({ error: "empty" });
			return;
		}
		if (!context.capabilities.switchDirectory || !context.git) {
			this.update({ error: context.capabilities.reason ?? "unsupported" });
			return;
		}
		this.update({
			busy: true,
			error: undefined,
			unknown: false,
			confirmedFailure: false,
			residuals: undefined,
			createRequest: undefined,
			step: "prepare",
		});
		// Copy before prepare awaits: later UI/cache edits cannot alter the proposal.
		draft = { ...draft };
		const revision = context.revision;
		const workspaceKey = context.git.workspaceKey;
		let dispatched = false;
		try {
			const prepared = await this.ports.prepare({
				expectedRevision: revision,
				workspaceKey,
				...(draft.name.trim() ? { name: draft.name.trim() } : {}),
				...(draft.requirement.trim() ? { requirement: draft.requirement.trim() } : {}),
				...(draft.branchOverride.trim() ? { branchName: draft.branchOverride.trim() } : {}),
				...(draft.destinationPath.trim() ? { destinationPath: draft.destinationPath.trim() } : {}),
			});
			const request: WorktreeCreateRequest = Object.freeze({
				expectedRevision: revision,
				workspaceKey,
				requestId: this.ports.requestId(),
				destinationPath: prepared.destinationPath,
				branch: Object.freeze({ kind: "new" as const, name: prepared.branchName }),
				...(draft.baseRef.trim() ? { baseRef: draft.baseRef.trim() } : {}),
			});
			await this.ports.persist?.(request, draft);
			this.update({ step: "create", createRequest: request });
			dispatched = true;
			if (this.accept(await this.ports.create(request))) await this.switchNow();
		} catch (error) {
			// Transport/HTTP errors, including 403/404, are never a creation receipt.
			const unknown = dispatched && !this.state.createdPath;
			this.update({
				unknown,
				confirmedFailure: dispatched && !unknown,
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			this.update({ busy: false });
		}
	}
	/** Read-only endpoint; never call create again, even when the original revision is now stale. */
	async reconcile() {
		if (this.state.busy || !this.state.unknown || !this.state.createRequest) return;
		const original = this.state.createRequest;
		this.update({ busy: true, step: "reconcile", error: undefined });
		try {
			const result = await this.ports.reconcile(original);
			this.accept(result);
			this.update({ step: result.outcome === "created" && result.worktree ? "switch" : "idle" });
		} catch (error) {
			// Missing/inaccessible receipt is not proof that creation failed.
			this.update({
				unknown: true,
				confirmedFailure: false,
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			this.update({ busy: false });
		}
	}
	async switchCreated() {
		if (!this.state.busy) await this.switchNow();
	}
	private async switchNow() {
		if (!this.state.createdPath || this.switching) return;
		this.switching = true;
		this.update({ step: "switch", busy: true, error: undefined });
		try {
			await this.ports.switch(this.state.createdPath);
			if (this.state.createRequest) this.ports.complete?.(this.state.createRequest.requestId);
			this.update({ step: "done" });
		} catch (error) {
			this.update({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			this.switching = false;
			this.update({ busy: false });
		}
	}
}
