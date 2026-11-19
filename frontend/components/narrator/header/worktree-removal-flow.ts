import { ApiError } from "@frontend/lib/api";
import type {
	WorktreeDependent,
	WorktreeRemovalBlocker,
	WorktreeRemovalConfirmation,
	WorktreeRemovalPlan,
	WorktreeRemovalRequest,
	WorktreeRemovalResult,
} from "@shared/narrator-worktrees";

export type WorktreeRemovalStep = "idle" | "plan" | "remove" | "done";
export interface WorktreeRemovalFlowState {
	step: WorktreeRemovalStep;
	busy: boolean;
	plan?: WorktreeRemovalPlan;
	/** Confirmations the user actually ticked; never inferred from the plan alone. */
	confirmed: WorktreeRemovalConfirmation[];
	error?: string;
	/**
	 * Stable server code behind `error`, when the failure carried one.
	 *
	 * The dialog translates this instead of printing the server's English sentence; a
	 * refusal such as WORKTREE_REMOVAL_DEPENDENT_NOT_ARCHIVED is actionable and the
	 * catalogue already has a sentence for it.
	 */
	errorCode?: string;
	result?: WorktreeRemovalResult;
}
export interface WorktreeRemovalFlowPorts {
	plan: (input: { workspaceKey: string; path: string }) => Promise<WorktreeRemovalPlan>;
	remove: (input: WorktreeRemovalRequest) => Promise<WorktreeRemovalResult>;
	/** Archive one blocking conversation, then re-read the plan. */
	archive: (narratorId: string) => Promise<void>;
	/** A 409 carries the fresh plan, so a refused removal becomes an actionable view. */
	planFromError?: (error: unknown) => WorktreeRemovalPlan | undefined;
}

/**
 * Plan → confirm → remove.
 *
 * The server owns every judgement (what is blocked, what must be confirmed); this class
 * only refuses to submit while that judgement is unmet or stale. Keeping it free of React
 * and HTTP is what lets the gating rules be tested directly.
 */
export class WorktreeRemovalFlow {
	state: WorktreeRemovalFlowState = { step: "idle", busy: false, confirmed: [] };
	constructor(
		private ports: WorktreeRemovalFlowPorts,
		private changed: (state: WorktreeRemovalFlowState) => void,
		private scope: () => { workspaceKey: string; path: string } | null,
	) {}
	private update(patch: Partial<WorktreeRemovalFlowState>) {
		this.state = { ...this.state, ...patch };
		this.changed(this.state);
	}
	/** Confirmations the plan demands but the user has not given yet. */
	get outstanding(): WorktreeRemovalConfirmation[] {
		const required = requiredConfirmations(this.state.plan);
		return required.filter((item) => !this.state.confirmed.includes(item));
	}
	get canSubmit(): boolean {
		return (
			!this.state.busy &&
			this.state.step !== "done" &&
			this.state.plan?.status === "ready" &&
			this.outstanding.length === 0
		);
	}
	get blockingDependents(): WorktreeDependent[] {
		return (
			this.state.plan?.blockers
				.flatMap((blocker) => blocker.dependents ?? [])
				.filter((dependent) => dependent.kind === "primary") ?? []
		);
	}
	async load(): Promise<void> {
		const scope = this.scope();
		if (!scope || this.state.busy) return;
		this.update({ busy: true, step: "plan", error: undefined, errorCode: undefined });
		try {
			const plan = await this.ports.plan(scope);
			this.update({
				plan,
				// A confirmation only survives if the fresh plan still asks for it.
				confirmed: this.state.confirmed.filter((item) =>
					requiredConfirmations(plan).includes(item),
				),
			});
		} catch (error) {
			this.update({ error: messageOf(error), errorCode: codeOf(error) });
		} finally {
			this.update({ busy: false, step: this.state.step === "done" ? "done" : "idle" });
		}
	}
	toggle(kind: WorktreeRemovalConfirmation, value: boolean): void {
		if (!requiredConfirmations(this.state.plan).includes(kind)) return;
		const confirmed = value
			? [...new Set([...this.state.confirmed, kind])]
			: this.state.confirmed.filter((item) => item !== kind);
		this.update({ confirmed });
	}
	/** Archive a blocker, then refresh: the user asked for the obstruction to go away. */
	async archiveDependent(narratorId: string): Promise<void> {
		if (this.state.busy) return;
		this.update({ busy: true, error: undefined, errorCode: undefined });
		let archived = false;
		try {
			await this.ports.archive(narratorId);
			archived = true;
		} catch (error) {
			// A failed archive must not be reported as a fresh plan: it would erase the reason.
			this.update({ error: messageOf(error), errorCode: codeOf(error) });
		} finally {
			this.update({ busy: false });
		}
		if (archived) await this.load();
	}
	async submit(): Promise<WorktreeRemovalResult | undefined> {
		const plan = this.state.plan;
		if (!plan || !this.canSubmit) return undefined;
		this.update({ busy: true, step: "remove", error: undefined, errorCode: undefined });
		try {
			const result = await this.ports.remove({
				// The revision the plan was taken under; the server refuses a stale one.
				expectedRevision: plan.expectedRevision,
				workspaceKey: this.scope()?.workspaceKey ?? "",
				path: plan.worktree.path,
				...(this.state.confirmed.includes("force")
					? {
							force: true,
							// Exactly what the person saw; the server refuses if reality moved on.
							confirmedLoss: {
								head: plan.worktree.head,
								dirtyFileCount: plan.worktree.dirtyFileCount,
								unreachableCommits: plan.worktree.unreachableCommits ?? 0,
							},
						}
					: {}),
				acknowledgeUnregistered: this.state.confirmed.includes("acknowledgeUnregistered")
					? true
					: undefined,
			});
			this.update({ result, step: "done" });
			return result;
		} catch (error) {
			// The server refuses when reality moved on; adopt the plan it sent instead of
			// guessing what changed.
			const fresh = this.ports.planFromError?.(error);
			this.update({
				error: messageOf(error),
				errorCode: codeOf(error),
				...(fresh ? { plan: fresh, confirmed: [] } : {}),
			});
			if (!fresh) await this.load();
			return undefined;
		} finally {
			this.update({ busy: false });
		}
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The server's stable code, when the response carried one. */
function codeOf(error: unknown): string | undefined {
	if (!(error instanceof ApiError)) return undefined;
	const code = error.data?.code;
	return typeof code === "string" && code ? code : undefined;
}

/**
 * Confirmations to ask the person for. `rows` mode deletes nothing on disk, so it never
 * asks to force a loss, even if an older server listed one.
 */
export function requiredConfirmations(
	plan: WorktreeRemovalPlan | undefined,
): WorktreeRemovalConfirmation[] {
	const confirmations = plan?.confirmations ?? [];
	return plan?.worktree.mode === "rows"
		? confirmations.filter((item) => item !== "force")
		: confirmations;
}

/** Blockers rendered as one list; keeps the caller from re-deriving codes. */
export function removalBlockers(plan: WorktreeRemovalPlan | undefined): WorktreeRemovalBlocker[] {
	return plan?.blockers ?? [];
}
