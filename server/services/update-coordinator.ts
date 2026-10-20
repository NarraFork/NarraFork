import {
	closeSync,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { getNarraforkPath } from "../lib/narrafork-home";
import {
	bindRecoveryHandoffEpoch,
	getRecoveryHandoffSources,
	getRegisteredRecoveryManifestIdentity,
	getRegisteredRecoverySource,
	hasReservedRecoverySourceEpoch,
	invalidateRecoveryTarget,
	isRecoveryAdvanceActive,
	MAX_RECOVERY_MANIFEST_BYTES,
	MAX_RECOVERY_TARGETS,
	normalizeRecoverySources,
	type RecoveryHandoffTicket,
	type RecoverySource,
	releaseRecoveryHandoff,
	reserveRecoveryHandoff,
	resetRecoveryHandoffForTests,
	waitForRecoveryHandoffReady,
} from "./recovery-handoff";

export type { RecoverySource } from "./recovery-handoff";

export type UpdatePhase = "idle" | "draining_background_bash" | "quiescing_tools" | "restarting";
export type UpdateExecutionKind = "background_bash" | "ordinary" | "resumable";
type LegacyUpdateExecutionKind = "bash" | "subagent";

export interface UpdateWaitBlocker {
	kind: "background_bash" | "ordinary" | "response" | "tool_start_grant" | "pre_admission";
	narratorId?: string;
	toolUseId?: string;
	waitingMs: number;
}

export interface UpdateCoordinationStatus {
	phase: UpdatePhase;
	scheduled: boolean;
	targetVersion?: string;
	operation?: "update" | "system_shutdown";
	updateEpoch?: string;
	pendingBackgroundBashCount: number;
	pendingOrdinaryExecutionCount: number;
	resumableExecutionCount: number;
	pausedToolCount: number;
	pendingToolStartGrantCount: number;
	pendingPreAdmissionCount: number;
	activeResponseCount: number;
	/** Compatibility total for callers that have not migrated to per-kind counts. */
	pendingExecutionCount: number;
	/** Whether an administrator asked to abandon the scheduled update. */
	cancelRequested: boolean;
	/** Oldest blockers holding the current wait open, for operator diagnosis. */
	blockers: UpdateWaitBlocker[];
	error?: string;
	/** Distinguishes an operator cancellation from a genuine update failure. */
	errorKind?: "failed" | "cancelled";
}

export interface NarratorRecoveryTarget {
	narratorId: string;
	locale: string;
	userId?: string | null;
	replyInUserLanguage?: boolean;
}

export interface PlannedUpdateRecoverySnapshot {
	version: 2 | 3;
	sources?: RecoverySource[];
	updateEpoch: string;
	targetVersion?: string;
	capturedAt: string;
	/**
	 * Marker nonce handed to the replacement process this manifest was written for.
	 *
	 * The manifest is a one-shot handover note: only the process that update attempt spawned may
	 * act on it. Startup compares this against the nonce it received through the handoff
	 * environment, so an ordinary manual restart — or a later, different update — can never
	 * inherit a leftover manifest and resume the narrators it lists. Absent on manifests written
	 * before the replacement was spawned, and on those written by older binaries.
	 */
	handoffMarkerNonce?: string;
	/** Explicit one-shot authorization for a user-started process after system preparation. */
	resumeOnNextStartup?: boolean;
	/**
	 * Written by a FAILED update attempt purely to preserve diagnostics.
	 *
	 * No replacement process was ever spawned for such an attempt, so no future startup can
	 * legitimately claim it. It must never authorize resuming narrators — otherwise the failure
	 * record itself becomes a standing instruction to restart that work on a later boot.
	 */
	evidenceOnly?: boolean;
	narrators: NarratorRecoveryTarget[];
}

interface WritablePlannedUpdateRecoverySnapshot {
	version: 1 | 2 | 3;
	sources?: RecoverySource[];
	updateEpoch?: string;
	targetVersion?: string;
	capturedAt: string;
	handoffMarkerNonce?: string;
	/** Explicit one-shot authorization for a user-started process after system preparation. */
	resumeOnNextStartup?: boolean;
	evidenceOnly?: boolean;
	narrators: NarratorRecoveryTarget[];
}

export interface UpdateExecutionLease {
	readonly kind: UpdateExecutionKind;
	readonly token: string;
	setNarratorId(narratorId: string): void;
	release(): void;
}

export interface UpdateToolStartGrant {
	readonly kind: UpdateExecutionKind;
	readonly token: string;
	setNarratorId(narratorId: string): void;
	release(): void;
}

export interface UpdateCheckpointActivityLease {
	readonly token: string;
	release(): void;
}

export interface NarratorResponseActivityLease extends UpdateCheckpointActivityLease {
	/** Only the current request may be stopped; null protects text/tool output. */
	setReasoningAbort(abort: (() => void) | null): void;
}

interface CoordinatorState {
	phase: UpdatePhase;
	targetVersion?: string;
	operation?: "update" | "system_shutdown";
	updateEpoch?: string;
	error?: string;
	errorKind?: "failed" | "cancelled";
	/** Set by cancelScheduledUpdate; every unbounded wait observes it as a stop request. */
	cancelRequestedEpoch?: string;
}

/**
 * Raised by an unbounded coordination wait once an administrator cancels the scheduled
 * update. Callers must treat this as "abandon this attempt", not as an update failure
 * caused by narrator work.
 */
export class UpdateCancelledError extends Error {
	constructor(readonly updateEpoch: string) {
		super(`Scheduled update ${updateEpoch} was cancelled by an administrator`);
		this.name = "UpdateCancelledError";
	}
}

interface ExecutionRecord {
	kind: UpdateExecutionKind | LegacyUpdateExecutionKind;
	narratorId?: string;
	startedAt: number;
}

interface ToolStartGrantRecord {
	kind: UpdateExecutionKind;
	narratorId: string;
	toolUseId: string;
	startedAt: number;
}

export type UpdateToolStartAdmission =
	| { status: "granted"; grant: UpdateToolStartGrant }
	| {
			status: "paused";
			updateEpoch: string;
			activity: UpdateCheckpointActivityLease;
	  };

export type UpdateToolStartExecutionTransition = {
	status: "execution";
	lease: UpdateExecutionLease;
};

interface NarratorLoopRecord {
	narratorId: string;
	locale: string;
	userId?: string | null;
	replyInUserLanguage?: boolean;
	startedAt: number;
}

interface GateWaiter {
	resolve: () => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

interface CheckpointActivityRecord {
	narratorId: string;
	toolUseId?: string;
	updateEpoch?: string;
	startedAt: number;
	reasoningAbort?: (() => void) | null;
}

const UPDATE_DIR = getNarraforkPath("updates");
const RECOVERY_SNAPSHOT_PATH = join(UPDATE_DIR, "planned-update-recovery.json");
const scheduledHandoff = hotSafe("update-recovery-handoff-v1", () => ({
	current: undefined as
		| {
				ticket: RecoveryHandoffTicket;
				epoch: string;
				original: string | undefined;
				published: string | undefined;
				ready?: boolean;
				cancellation: AbortController;
		  }
		| undefined,
}));

const state = hotSafe<CoordinatorState>("narrafork.updateCoordinator.state", () => ({
	phase: "idle",
}));
const executions = hotSafe<Map<string, ExecutionRecord>>(
	"narrafork.updateCoordinator.executions",
	() => new Map(),
);
const narratorLoops = hotSafe<Map<string, NarratorLoopRecord>>(
	"narrafork.updateCoordinator.narratorLoops",
	() => new Map(),
);
const toolStartGrants = hotSafe<Map<string, ToolStartGrantRecord>>(
	"narrafork.updateCoordinator.toolStartGrants",
	() => new Map(),
);
const preAdmissionActivities = hotSafe<Map<string, CheckpointActivityRecord>>(
	"narrafork.updateCoordinator.preAdmissionActivities",
	() => new Map(),
);
const responseActivities = hotSafe<Map<string, CheckpointActivityRecord>>(
	"narrafork.updateCoordinator.responseActivities",
	() => new Map(),
);

// Migrate hot-reloaded state created by the former idle/draining/restarting coordinator.
if ((state.phase as string) === "draining") {
	state.phase = "draining_background_bash";
}
if (state.phase !== "idle" && !state.updateEpoch) {
	state.updateEpoch = generateUpdateEpoch();
}

interface CoordinationWaiter {
	resolve: () => void;
	cancel: (error: UpdateCancelledError) => void;
}

let backgroundBashDrainWaiters: CoordinationWaiter[] = [];
let ordinaryDrainWaiters: CoordinationWaiter[] = [];
let checkpointFenceWaiters: CoordinationWaiter[] = [];
const gateWaiters = new Map<string, GateWaiter>();

function generateToken(prefix: string): string {
	return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function generateUpdateEpoch(): string {
	return generateToken("update");
}

function normalizeExecutionKind(
	kind: UpdateExecutionKind | LegacyUpdateExecutionKind,
): UpdateExecutionKind {
	if (kind === "bash") return "background_bash";
	if (kind === "subagent") return "ordinary";
	return kind;
}

function countExecutions(kind: UpdateExecutionKind): number {
	let count = 0;
	for (const record of executions.values()) {
		if (normalizeExecutionKind(record.kind) === kind) count++;
	}
	return count;
}

/** How many blockers a status payload reports; enough to diagnose, bounded for the API. */
const STATUS_BLOCKER_LIMIT = 10;

function collectBlockers(now: number): UpdateWaitBlocker[] {
	const blockers: UpdateWaitBlocker[] = [];
	for (const record of executions.values()) {
		const kind = normalizeExecutionKind(record.kind);
		// Resumable work never blocks a restart, so it is not a blocker.
		if (kind === "resumable") continue;
		blockers.push({
			kind,
			...(record.narratorId ? { narratorId: record.narratorId } : {}),
			waitingMs: now - record.startedAt,
		});
	}
	for (const record of responseActivities.values()) {
		blockers.push({
			kind: "response",
			narratorId: record.narratorId,
			waitingMs: now - record.startedAt,
		});
	}
	for (const record of toolStartGrants.values()) {
		blockers.push({
			kind: "tool_start_grant",
			narratorId: record.narratorId,
			toolUseId: record.toolUseId,
			waitingMs: now - record.startedAt,
		});
	}
	for (const record of preAdmissionActivities.values()) {
		blockers.push({
			kind: "pre_admission",
			narratorId: record.narratorId,
			...(record.toolUseId ? { toolUseId: record.toolUseId } : {}),
			waitingMs: now - record.startedAt,
		});
	}
	return blockers.sort((a, b) => b.waitingMs - a.waitingMs).slice(0, STATUS_BLOCKER_LIMIT);
}

function resolveStatus(): UpdateCoordinationStatus {
	const pendingBackgroundBashCount = countExecutions("background_bash");
	const pendingOrdinaryExecutionCount = countExecutions("ordinary");
	const resumableExecutionCount = countExecutions("resumable");
	return {
		phase: state.phase,
		scheduled: state.phase !== "idle",
		operation: state.operation,
		...(state.targetVersion ? { targetVersion: state.targetVersion } : {}),
		...(state.updateEpoch ? { updateEpoch: state.updateEpoch } : {}),
		pendingBackgroundBashCount,
		pendingOrdinaryExecutionCount,
		resumableExecutionCount,
		pausedToolCount: gateWaiters.size,
		pendingPreAdmissionCount: preAdmissionActivities.size,
		activeResponseCount: responseActivities.size,
		pendingExecutionCount:
			pendingBackgroundBashCount + pendingOrdinaryExecutionCount + resumableExecutionCount,
		pendingToolStartGrantCount: toolStartGrants.size,
		cancelRequested: isUpdateCancelRequested(),
		blockers: state.phase === "idle" ? [] : collectBlockers(Date.now()),
		...(state.error ? { error: state.error, errorKind: state.errorKind ?? "failed" } : {}),
	};
}

function resolveDrainWaitersIfReady(): void {
	if (countExecutions("background_bash") === 0 && backgroundBashDrainWaiters.length > 0) {
		const waiters = backgroundBashDrainWaiters;
		backgroundBashDrainWaiters = [];
		for (const waiter of waiters) waiter.resolve();
	}
	if (countExecutions("ordinary") === 0 && ordinaryDrainWaiters.length > 0) {
		const waiters = ordinaryDrainWaiters;
		ordinaryDrainWaiters = [];
		for (const waiter of waiters) waiter.resolve();
	}
}

function checkpointFenceIsStable(): boolean {
	return (
		toolStartGrants.size === 0 && preAdmissionActivities.size === 0 && responseActivities.size === 0
	);
}

/** Test-only view of the fence predicate. */
export function checkpointFenceIsStableForTests(): boolean {
	return checkpointFenceIsStable();
}

/**
 * A lease that tracks nothing, for work that is already inside the checkpoint fence via
 * another holder — currently only reflection decision tools, which resolve a gate whose
 * parent tool still holds its start grant. Registering them again would make them block the
 * checkpoint they are exempt from.
 */
export function inertUpdateExecutionLease(
	kind: UpdateExecutionKind = "ordinary",
): UpdateExecutionLease {
	return {
		kind,
		token: generateToken("inert"),
		setNarratorId() {},
		release() {},
	};
}

function resolveCheckpointFenceWaitersIfReady(): void {
	if (!checkpointFenceIsStable() || checkpointFenceWaiters.length === 0) return;
	const waiters = checkpointFenceWaiters;
	checkpointFenceWaiters = [];
	for (const waiter of waiters) waiter.resolve();
}

function registerCheckpointActivity(
	map: Map<string, CheckpointActivityRecord>,
	prefix: string,
	record: Omit<CheckpointActivityRecord, "startedAt">,
): UpdateCheckpointActivityLease {
	const token = generateToken(prefix);
	map.set(token, { ...record, startedAt: Date.now() });
	let released = false;
	return {
		token,
		release() {
			if (released) return;
			released = true;
			map.delete(token);
			resolveCheckpointFenceWaitersIfReady();
		},
	};
}

function settleGateWaiter(token: string, action: "resolve" | "abort"): void {
	const waiter = gateWaiters.get(token);
	if (!waiter) return;
	gateWaiters.delete(token);
	if (waiter.signal && waiter.onAbort) {
		waiter.signal.removeEventListener("abort", waiter.onAbort);
	}
	if (action === "resolve") {
		waiter.resolve();
		return;
	}
	const error = new Error("Waiting for the update gate was aborted");
	error.name = "AbortError";
	waiter.reject(waiter.signal?.reason ?? error);
}

function openUpdateGate(): void {
	for (const token of [...gateWaiters.keys()]) settleGateWaiter(token, "resolve");
}

export function getUpdateCoordinationStatus(): UpdateCoordinationStatus {
	return resolveStatus();
}

export function isUpdateScheduled(): boolean {
	return state.phase !== "idle";
}

/** Whether the currently scheduled update has an outstanding cancellation request. */
export function isUpdateCancelRequested(): boolean {
	return state.phase !== "idle" && state.cancelRequestedEpoch === state.updateEpoch;
}

function cancellationError(): UpdateCancelledError | null {
	if (!isUpdateCancelRequested() || !state.updateEpoch) return null;
	return new UpdateCancelledError(state.updateEpoch);
}

/**
 * Throw if the scheduled update was cancelled. Restart orchestration calls this at every
 * step boundary so a cancellation lands before an irreversible action (writing the recovery
 * manifest, spawning the replacement process).
 */
export function assertUpdateNotCancelled(): void {
	const error = cancellationError();
	if (error) throw error;
}

function cancelCoordinationWaiters(error: UpdateCancelledError): void {
	const pending = [
		...backgroundBashDrainWaiters,
		...ordinaryDrainWaiters,
		...checkpointFenceWaiters,
	];
	backgroundBashDrainWaiters = [];
	ordinaryDrainWaiters = [];
	checkpointFenceWaiters = [];
	for (const waiter of pending) waiter.cancel(error);
}

/**
 * Ask the running restart orchestration to abandon the scheduled update.
 *
 * Every coordination wait is unbounded on purpose: narrator work legitimately takes
 * minutes (a five-minute first-token timeout with retries, a permission request nobody
 * answered yet), and a deadline would abort an otherwise healthy update. Cancellation is
 * the operator's escape hatch instead. It unblocks the waits with `UpdateCancelledError`;
 * the orchestration then runs its normal failure cleanup, which reopens the tool gate so
 * paused work resumes. Returns false when no update is scheduled.
 */
export function cancelScheduledUpdate(reason?: string): boolean {
	if (state.phase === "idle" || !state.updateEpoch) return false;
	if (state.cancelRequestedEpoch !== state.updateEpoch) {
		state.cancelRequestedEpoch = state.updateEpoch;
		logger.warn("Scheduled update cancellation requested", {
			updateEpoch: state.updateEpoch,
			phase: state.phase,
			reason,
			blockers: collectBlockers(Date.now()),
		});
	}
	scheduledHandoff.current?.cancellation.abort();
	const error = cancellationError();
	if (error) cancelCoordinationWaiters(error);
	return true;
}

/** Interval between progress logs while an unbounded coordination wait is open. */
const WAIT_PROGRESS_LOG_INTERVAL_MS = 30_000;

/**
 * Register an unbounded wait. It settles when `isReady()` becomes true (the caller's
 * resolve path) or rejects when the scheduled update is cancelled. While it is open, the
 * blockers holding it are logged periodically so an operator can see what to act on.
 */
function waitForCoordination(
	label: string,
	waiters: () => CoordinationWaiter[],
	isReady: () => boolean,
): Promise<void> {
	// Cancellation outranks readiness. An already-satisfied wait must still fail once the
	// operator cancelled, so orchestration cannot slip forward into an irreversible step
	// through a step that happened to have nothing left to wait for.
	const pendingCancellation = cancellationError();
	if (pendingCancellation) return Promise.reject(pendingCancellation);
	if (isReady()) return Promise.resolve();

	const startedAt = Date.now();
	return new Promise<void>((resolve, reject) => {
		let settled = false;
		const progressTimer = setInterval(() => {
			logger.warn("Still waiting before the planned update can restart", {
				label,
				updateEpoch: state.updateEpoch,
				phase: state.phase,
				waitingMs: Date.now() - startedAt,
				blockers: collectBlockers(Date.now()),
			});
		}, WAIT_PROGRESS_LOG_INTERVAL_MS);
		(progressTimer as { unref?: () => void }).unref?.();

		const remove = () => {
			const list = waiters();
			const index = list.indexOf(waiter);
			if (index >= 0) list.splice(index, 1);
		};
		const waiter: CoordinationWaiter = {
			resolve: () => {
				if (settled) return;
				settled = true;
				clearInterval(progressTimer);
				remove();
				resolve();
			},
			cancel: (error) => {
				if (settled) return;
				settled = true;
				clearInterval(progressTimer);
				remove();
				reject(error);
			},
		};
		waiters().push(waiter);
		// Close the race where readiness or cancellation landed between the checks above
		// and registration.
		if (isReady()) {
			waiter.resolve();
			return;
		}
		const late = cancellationError();
		if (late) waiter.cancel(late);
	});
}

/**
 * Track one provider response that may still produce tool rows. Scheduled updates park
 * new responses and stop reasoning-only requests; text/tool responses drain to persistence.
 *
 * A REFLECTION request is exempt, and must be: a reflection gate (danger / plan / task /
 * question) runs inside tool admission, so by the time it issues its request the parent
 * loop already holds both the tool's `startGrant` and its own response lease — the two
 * things `checkpointFenceIsStable()` waits for. Parking the reflection here deadlocked the
 * pair: the fence could not stabilize while the tool stayed paused, and the tool could not
 * finish deliberating until the gate reopened, which only happens on failure/cancellation.
 * Both waits are unbounded by design, so the tool row stayed `pending` forever showing a
 * "still reflecting" card and the update never proceeded.
 *
 * The exemption is safe because a reflection produces no new tool row: it decides the fate
 * of a row that already exists and is already fenced by the grant it runs under. For the
 * same reason it must NOT register its own activity — counting it would make it block the
 * very checkpoint it just bypassed, recreating the deadlock from the other side.
 */
export async function beginNarratorResponseActivity(
	narratorId: string,
	signal?: AbortSignal,
	options: { isReflection?: boolean } = {},
): Promise<NarratorResponseActivityLease> {
	if (options.isReflection) {
		return { token: generateToken("reflection_response"), release() {}, setReasoningAbort() {} };
	}
	while (state.phase !== "idle") {
		await waitUntilUpdateGateOpens(signal);
	}
	const activity = registerCheckpointActivity(responseActivities, "response", { narratorId });
	return {
		...activity,
		setReasoningAbort(abort) {
			const record = responseActivities.get(activity.token);
			if (!record) return;
			record.reasoningAbort = abort;
			if (state.phase !== "idle") abort?.();
		},
	};
}

/** Do not release the fence until the event consumer has removed this attempt's output. */
function interruptReasoningResponses(): void {
	for (const record of responseActivities.values()) record.reasoningAbort?.();
}

/** Track a rejected tool admission until its durable continuation row is stable. */
export function beginUpdatePreAdmissionActivity(
	updateEpoch: string,
	narratorId: string,
	toolUseId: string,
): UpdateCheckpointActivityLease | null {
	if (state.phase === "idle" || state.updateEpoch !== updateEpoch) return null;
	return registerCheckpointActivity(preAdmissionActivities, "pre_admission", {
		narratorId,
		toolUseId,
		updateEpoch,
	});
}

/**
 * Wait until no response, tool-start grant, or durable pre-admission can still add a tool
 * row. This wait is unbounded by design — see `cancelScheduledUpdate` for why — and only
 * rejects with `UpdateCancelledError`.
 */
export async function waitForUpdateCheckpointFence(): Promise<void> {
	await waitForCoordination(
		"checkpoint_fence",
		() => checkpointFenceWaiters,
		checkpointFenceIsStable,
	);
}

export function canStartFinalUpdateExecution(kind: UpdateExecutionKind): boolean {
	switch (state.phase) {
		case "idle":
			return true;
		case "draining_background_bash":
			return kind !== "background_bash";
		case "quiescing_tools":
		case "restarting":
			return false;
	}
}

function registerExecutionLease(
	kind: UpdateExecutionKind,
	narratorId?: string,
): UpdateExecutionLease {
	const token = generateToken(kind);
	executions.set(token, {
		kind,
		narratorId,
		startedAt: Date.now(),
	});
	let released = false;

	return {
		kind,
		token,
		setNarratorId(id: string) {
			const record = executions.get(token);
			if (record) record.narratorId = id;
		},
		release() {
			if (released) return;
			released = true;
			executions.delete(token);
			resolveDrainWaitersIfReady();
		},
	};
}

function registerRejectedToolStart(
	narratorId: string,
	toolUseId: string,
): Extract<UpdateToolStartAdmission, { status: "paused" }> {
	if (state.phase === "idle" || !state.updateEpoch) {
		throw new Error("Cannot register a rejected tool start without an active update epoch");
	}
	const updateEpoch = state.updateEpoch;
	return {
		status: "paused",
		updateEpoch,
		activity: registerCheckpointActivity(preAdmissionActivities, "pre_admission", {
			narratorId,
			toolUseId,
			updateEpoch,
		}),
	};
}

/**
 * Atomically decide phase-one admission and register either a start grant or the
 * durable-pause activity that fences checkpointing. A granted result is the irrevocable
 * tool-start linearization point. The synchronous function body is the critical section:
 * a phase switch cannot interleave with the decision/record.
 */
export function beginToolStartAdmission(
	kind: UpdateExecutionKind,
	narratorId: string,
	toolUseId: string,
): UpdateToolStartAdmission {
	if (!canStartFinalUpdateExecution(kind)) {
		return registerRejectedToolStart(narratorId, toolUseId);
	}

	const token = generateToken("tool_start");
	toolStartGrants.set(token, { kind, narratorId, toolUseId, startedAt: Date.now() });
	let released = false;
	const grant: UpdateToolStartGrant = {
		kind,
		token,
		setNarratorId(id: string) {
			const record = toolStartGrants.get(token);
			if (record) record.narratorId = id;
		},
		release() {
			if (released) return;
			released = true;
			toolStartGrants.delete(token);
			resolveCheckpointFenceWaitersIfReady();
		},
	};
	return { status: "granted", grant };
}

/**
 * Atomically convert an irrevocable start grant into its execution lease. The grant itself is
 * the start linearization point, so a later phase change cannot turn already-started work into
 * a durable pause. Phase two only prevents beginToolStartAdmission from issuing new grants.
 */
export function convertToolStartGrantToExecution(
	grant: UpdateToolStartGrant,
	narratorId: string,
	_toolUseId: string,
): UpdateToolStartExecutionTransition {
	const record = toolStartGrants.get(grant.token);
	if (!record) throw new Error("Tool start grant is no longer active");
	if (record.kind !== grant.kind) throw new Error("Tool start grant kind changed unexpectedly");

	const lease = registerExecutionLease(record.kind, narratorId);
	toolStartGrants.delete(grant.token);
	resolveCheckpointFenceWaitersIfReady();
	return { status: "execution", lease };
}

/**
 * Perform the final synchronous admission check and register the execution lease.
 * Callers must use the returned lease as the authority to start work.
 */
export function tryAcquireFinalUpdateExecution(
	kind: UpdateExecutionKind,
	narratorId?: string,
): UpdateExecutionLease | null {
	if (!canStartFinalUpdateExecution(kind)) return null;
	return registerExecutionLease(kind, narratorId);
}

/**
 * Compatibility wrapper for existing Bash/subagent call sites.
 * Legacy Bash is conservatively treated as background Bash until those callers migrate.
 */
export function tryAcquireUpdateExecution(
	kind: UpdateExecutionKind | LegacyUpdateExecutionKind,
	narratorId?: string,
): UpdateExecutionLease | null {
	return tryAcquireFinalUpdateExecution(normalizeExecutionKind(kind), narratorId);
}

/** Compatibility admission helper retained for callers using the former API. */
export function canStartUpdateExecution(narratorId?: string): boolean {
	void narratorId;
	return canStartFinalUpdateExecution("ordinary");
}

export function registerNarratorLoop(
	narratorId: string,
	locale: string,
	options: { userId?: string | null; replyInUserLanguage?: boolean } = {},
): () => void {
	invalidateRecoveryTarget(narratorId);
	const token = generateToken("loop");
	narratorLoops.set(token, {
		narratorId,
		locale,
		userId: options.userId,
		replyInUserLanguage: options.replyInUserLanguage,
		startedAt: Date.now(),
	});
	let released = false;
	return () => {
		if (released) return;
		released = true;
		narratorLoops.delete(token);
	};
}

export function scheduleUpdate(
	targetVersion?: string,
	operation: "update" | "system_shutdown" = "update",
	options: { supportedRecoveryManifestVersions?: readonly number[] } = {},
): UpdateCoordinationStatus {
	if (state.phase !== "idle") return resolveStatus();
	const ticket = reserveRecoveryHandoff();
	let recoverySourceEpochs: string[];
	try {
		const original = readRecoverySnapshotText();
		if (original !== undefined) {
			const root = parsePlannedUpdateRecoverySnapshot(JSON.parse(original));
			const claimed = root && getRegisteredRecoverySource(root.updateEpoch);
			if (
				!root ||
				!claimed ||
				claimed.kind !== "planned" ||
				claimed.capturedAt !== root.capturedAt ||
				JSON.stringify(claimed.narrators) !== JSON.stringify(root.narrators) ||
				getRegisteredRecoveryManifestIdentity(root.updateEpoch) !== JSON.stringify(root)
			) {
				throw new Error("Recovery manifest is corrupt, unknown, or not claimed by this process");
			}
			for (const source of root.sources ?? []) {
				const registered = getRegisteredRecoverySource(source.updateEpoch);
				if (!registered || JSON.stringify(registered) !== JSON.stringify(source))
					throw new Error("Recovery source lineage is not claimed by this process");
			}
		}
		const sources = getRecoveryHandoffSources(ticket);
		recoverySourceEpochs = sources.map((source) => source.updateEpoch);
		if (
			sources.length &&
			operation !== "system_shutdown" &&
			!options.supportedRecoveryManifestVersions?.includes(3)
		)
			throw new Error("Target binary does not support recovery manifest v3");
		const epoch = generateUpdateEpoch();
		bindRecoveryHandoffEpoch(ticket, epoch);
		scheduledHandoff.current = {
			ticket,
			epoch,
			original,
			published: undefined,
			cancellation: new AbortController(),
		};
	} catch (error) {
		releaseRecoveryHandoff(ticket);
		throw error;
	}
	state.operation = operation;
	state.phase = "draining_background_bash";
	state.targetVersion = targetVersion;
	state.updateEpoch = scheduledHandoff.current?.epoch;
	state.error = undefined;
	state.errorKind = undefined;
	// A cancellation belongs to the epoch that was cancelled; never inherit it.
	state.cancelRequestedEpoch = undefined;
	interruptReasoningResponses();
	logger.info("Update scheduled; draining background Bash executions", {
		targetVersion,
		updateEpoch: state.updateEpoch,
		// Logging must not re-read source files after committing the schedule.
		recoverySourceEpochs,
		pendingBackgroundBashCount: countExecutions("background_bash"),
		pendingOrdinaryExecutionCount: countExecutions("ordinary"),
		resumableExecutionCount: countExecutions("resumable"),
	});
	return resolveStatus();
}

/** Unbounded; only rejects with `UpdateCancelledError`. */
export async function waitForBackgroundBashDrain(): Promise<void> {
	await waitForCoordination(
		"background_bash_drain",
		() => backgroundBashDrainWaiters,
		() => countExecutions("background_bash") === 0,
	);
}

export function beginQuiescingTools(): UpdateCoordinationStatus {
	if (state.phase === "draining_background_bash") {
		state.phase = "quiescing_tools";
		interruptReasoningResponses();
		logger.info("Background Bash drained; closing the checkpoint fence", {
			updateEpoch: state.updateEpoch,
			pendingOrdinaryExecutionCount: countExecutions("ordinary"),
			resumableExecutionCount: countExecutions("resumable"),
			activeResponseCount: responseActivities.size,
			pendingToolStartGrantCount: toolStartGrants.size,
			pendingPreAdmissionCount: preAdmissionActivities.size,
		});
	}
	return resolveStatus();
}

/** Unbounded; only rejects with `UpdateCancelledError`. */
export async function waitForOrdinaryToolDrain(): Promise<void> {
	await waitForCoordination(
		"ordinary_tool_drain",
		() => ordinaryDrainWaiters,
		() => countExecutions("ordinary") === 0,
	);
}

/** Compatibility drain helper. Resumable work intentionally never blocks restart. */
export async function waitForUpdateExecutionDrain(): Promise<void> {
	await waitForBackgroundBashDrain();
	await waitForOrdinaryToolDrain();
}

/**
 * Suspend a rejected tool until a failed/cancelled update returns the coordinator to idle.
 * This is a gate wait, not a tool failure result.
 */
export async function waitUntilUpdateGateOpens(signal?: AbortSignal): Promise<void> {
	if (state.phase === "idle") return;
	if (signal?.aborted) {
		const error = new Error("Waiting for the update gate was aborted");
		error.name = "AbortError";
		throw signal.reason ?? error;
	}

	const token = generateToken("paused_tool");
	await new Promise<void>((resolve, reject) => {
		const waiter: GateWaiter = { resolve, reject, signal };
		if (signal) {
			waiter.onAbort = () => settleGateWaiter(token, "abort");
			signal.addEventListener("abort", waiter.onAbort, { once: true });
		}
		gateWaiters.set(token, waiter);
		// Close the race where failure opened the gate between the initial check and registration.
		if (state.phase === "idle") settleGateWaiter(token, "resolve");
	});
}

export function markUpdateRestarting(): UpdateCoordinationStatus {
	if (state.phase === "idle") return resolveStatus();
	state.phase = "restarting";
	return resolveStatus();
}

export function failScheduledUpdate(
	error: string,
	options: { cancelled?: boolean } = {},
): UpdateCoordinationStatus {
	const handoff = scheduledHandoff.current;
	if (handoff) {
		if (
			handoff.published !== undefined &&
			getRecoveryHandoffSources(handoff.ticket).length === 0 &&
			readRecoverySnapshotText() === handoff.published &&
			parsePlannedUpdateRecoverySnapshot(JSON.parse(handoff.published))?.evidenceOnly === true
		) {
			// Legacy no-source failure evidence is not an authorization and remains on disk.
			releaseRecoveryHandoff(handoff.ticket);
			scheduledHandoff.current = undefined;
		} else releasePreparedUpdateRecoveryHandoff(handoff.epoch);
	}
	state.phase = "idle";
	state.operation = undefined;
	state.targetVersion = undefined;
	state.updateEpoch = undefined;
	state.cancelRequestedEpoch = undefined;
	state.error = error;
	state.errorKind = options.cancelled ? "cancelled" : "failed";
	openUpdateGate();
	if (options.cancelled) {
		logger.info("Scheduled update cancelled; paused work resumed", { error });
	} else {
		logger.error("Scheduled update failed before replacement startup", { error });
	}
	return resolveStatus();
}

export function capturePlannedUpdateRecoverySnapshot(): PlannedUpdateRecoverySnapshot {
	const targets = new Map<string, NarratorRecoveryTarget>();
	for (const record of narratorLoops.values()) {
		targets.set(record.narratorId, {
			narratorId: record.narratorId,
			locale: record.locale,
			userId: record.userId,
			replyInUserLanguage: record.replyInUserLanguage,
		});
	}
	for (const record of executions.values()) {
		if (!record.narratorId || targets.has(record.narratorId)) continue;
		targets.set(record.narratorId, { narratorId: record.narratorId, locale: "en" });
	}

	const sources = getScheduledRecoverySources();
	return {
		version: sources.length ? 3 : 2,
		...(sources.length ? { sources } : {}),
		updateEpoch: state.updateEpoch ?? generateUpdateEpoch(),
		targetVersion: state.targetVersion,
		capturedAt: new Date().toISOString(),
		narrators: [...targets.values()],
	};
}

function parseNarrators(value: unknown): NarratorRecoveryTarget[] | null {
	if (!Array.isArray(value) || value.length > MAX_RECOVERY_TARGETS) return null;
	const ids = new Set<string>();
	if (
		value.some(
			(entry) =>
				!entry ||
				typeof entry !== "object" ||
				typeof entry.narratorId !== "string" ||
				!entry.narratorId ||
				typeof entry.locale !== "string" ||
				(entry.userId !== undefined && entry.userId !== null && typeof entry.userId !== "string") ||
				(entry.replyInUserLanguage !== undefined &&
					typeof entry.replyInUserLanguage !== "boolean") ||
				ids.has(entry.narratorId) ||
				!ids.add(entry.narratorId),
		)
	)
		return null;
	return value.flatMap((entry) => {
		if (
			!entry ||
			typeof entry !== "object" ||
			typeof (entry as NarratorRecoveryTarget).narratorId !== "string" ||
			typeof (entry as NarratorRecoveryTarget).locale !== "string"
		) {
			return [];
		}
		const target = entry as NarratorRecoveryTarget;
		return [
			{
				narratorId: target.narratorId,
				locale: target.locale,
				...(typeof target.userId === "string" || target.userId === null
					? { userId: target.userId }
					: {}),
				...(typeof target.replyInUserLanguage === "boolean"
					? { replyInUserLanguage: target.replyInUserLanguage }
					: {}),
			},
		];
	});
}

export function parsePlannedUpdateRecoverySnapshot(
	value: unknown,
): PlannedUpdateRecoverySnapshot | null {
	if (!value || typeof value !== "object") return null;
	try {
		if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_RECOVERY_MANIFEST_BYTES) return null;
	} catch {
		return null;
	}
	const parsed = value as Partial<WritablePlannedUpdateRecoverySnapshot>;
	if (
		typeof parsed.capturedAt !== "string" ||
		!parsed.capturedAt ||
		(parsed.targetVersion !== undefined && typeof parsed.targetVersion !== "string") ||
		(parsed.handoffMarkerNonce !== undefined &&
			(typeof parsed.handoffMarkerNonce !== "string" || !parsed.handoffMarkerNonce)) ||
		[parsed.resumeOnNextStartup, parsed.evidenceOnly].some(
			(flag) => flag !== undefined && typeof flag !== "boolean",
		)
	)
		return null;
	if (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3) return null;
	const narrators = parseNarrators(parsed.narrators);
	if (!narrators) return null;
	if (parsed.version !== 1 && (typeof parsed.updateEpoch !== "string" || !parsed.updateEpoch))
		return null;
	if (parsed.version !== 3 && parsed.sources !== undefined) return null;
	let sources: RecoverySource[] = [];
	try {
		sources = parsed.version === 3 ? normalizeRecoverySources(parsed.sources) : [];
	} catch {
		return null;
	}
	if (
		sources.some((source) => source.updateEpoch === parsed.updateEpoch) ||
		sources.reduce((total, source) => total + source.narrators.length, narrators.length) >
			MAX_RECOVERY_TARGETS
	)
		return null;
	const capturedAt = parsed.capturedAt;

	return {
		version: sources.length ? 3 : 2,
		...(sources.length ? { sources } : {}),
		updateEpoch:
			parsed.version !== 1
				? (parsed.updateEpoch as string)
				: `legacy_${capturedAt.replace(/[^a-zA-Z0-9]/g, "_")}`,
		targetVersion: typeof parsed.targetVersion === "string" ? parsed.targetVersion : undefined,
		capturedAt,
		...(typeof parsed.handoffMarkerNonce === "string" && parsed.handoffMarkerNonce
			? { handoffMarkerNonce: parsed.handoffMarkerNonce }
			: {}),
		...(parsed.evidenceOnly === true ? { evidenceOnly: true } : {}),
		...(parsed.resumeOnNextStartup === true ? { resumeOnNextStartup: true } : {}),
		narrators,
	};
}

function readRecoverySnapshotText(): string | undefined {
	if (!existsSync(RECOVERY_SNAPSHOT_PATH)) return undefined;
	const fd = openSync(RECOVERY_SNAPSHOT_PATH, "r");
	try {
		const size = fstatSync(fd).size;
		if (size > MAX_RECOVERY_MANIFEST_BYTES)
			throw new Error("Recovery manifest exceeds 4 MiB limit");
		const buffer = Buffer.alloc(size + 1);
		let length = 0;
		while (length < buffer.length) {
			const read = readSync(fd, buffer, length, buffer.length - length, null);
			if (!read) break;
			length += read;
		}
		if (length > size) throw new Error("Recovery manifest changed size during bounded read");
		return buffer.subarray(0, length).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

function readExistingRecoverySnapshotEpoch(): string | undefined {
	if (!existsSync(RECOVERY_SNAPSHOT_PATH)) return undefined;
	try {
		return parsePlannedUpdateRecoverySnapshot(JSON.parse(readRecoverySnapshotText() ?? "null"))
			?.updateEpoch;
	} catch {
		return undefined;
	}
}

/**
 * Optional caller assertion for recovery-manifest mutations.
 *
 * The single on-disk recovery manifest is owned by exactly one update epoch at a time. Every
 * write is therefore compare-and-set by default: an existing manifest may only be replaced by a
 * snapshot with the same epoch. `expectedEpoch` additionally asserts which epoch the caller owns.
 */
export interface RecoveryManifestEpochGuard {
	expectedEpoch: string;
	/**
	 * Marker nonce of the replacement process this manifest authorizes.
	 *
	 * Set by the restart orchestration once the handoff session exists, so the manifest becomes
	 * actionable by exactly one spawned process instead of by whichever server starts next.
	 */
	handoffMarkerNonce?: string;
}

export class RecoveryManifestEpochConflictError extends Error {
	constructor(
		readonly manifestEpoch: string | null,
		readonly incomingEpoch: string,
	) {
		super(
			`Recovery manifest belongs to epoch ${manifestEpoch ?? "unknown"}; refusing to replace it with epoch ${incomingEpoch}`,
		);
		this.name = "RecoveryManifestEpochConflictError";
	}
}

export function writePlannedUpdateRecoverySnapshot(
	snapshot: WritablePlannedUpdateRecoverySnapshot = capturePlannedUpdateRecoverySnapshot(),
	guard: Partial<RecoveryManifestEpochGuard> = {},
): PlannedUpdateRecoverySnapshot {
	if (![1, 2, 3].includes(snapshot.version))
		throw new Error("Unsupported recovery manifest version");
	const normalized = parsePlannedUpdateRecoverySnapshot({
		...snapshot,
		version: snapshot.sources?.length ? 3 : 2,
		...(snapshot.sources?.length ? {} : { sources: undefined }),
		updateEpoch: snapshot.updateEpoch ?? state.updateEpoch ?? generateUpdateEpoch(),
		handoffMarkerNonce: guard.handoffMarkerNonce ?? snapshot.handoffMarkerNonce,
	});
	if (!normalized) throw new Error("Invalid planned update recovery snapshot");

	if (guard.expectedEpoch !== undefined && normalized.updateEpoch !== guard.expectedEpoch) {
		throw new Error(
			`Recovery manifest epoch guard mismatch: snapshot epoch ${normalized.updateEpoch} does not match expected ${guard.expectedEpoch}`,
		);
	}

	const manifestExists = existsSync(RECOVERY_SNAPSHOT_PATH);
	const existingEpoch = readExistingRecoverySnapshotEpoch();
	if (manifestExists && existingEpoch !== normalized.updateEpoch) {
		logger.warn("Refused to replace recovery manifest owned by a different update epoch", {
			path: RECOVERY_SNAPSHOT_PATH,
			manifestEpoch: existingEpoch ?? null,
			incomingEpoch: normalized.updateEpoch,
		});
		throw new RecoveryManifestEpochConflictError(existingEpoch ?? null, normalized.updateEpoch);
	}

	if (manifestExists) {
		const existing = parsePlannedUpdateRecoverySnapshot(
			JSON.parse(readRecoverySnapshotText() ?? "null"),
		);
		if (
			existing?.sources?.length &&
			JSON.stringify(existing.sources) !== JSON.stringify(normalized.sources)
		)
			throw new Error("Ordinary recovery write cannot alter inherited sources");
	}
	if (hasReservedRecoverySourceEpoch(normalized.updateEpoch))
		throw new Error("Recovery source manifest is reserved");
	const text = JSON.stringify(normalized, null, 2);
	atomicWriteRecoveryText(text);
	if (scheduledHandoff.current?.epoch === normalized.updateEpoch)
		scheduledHandoff.current.published = text;
	logger.info("Planned update recovery snapshot written", {
		path: RECOVERY_SNAPSHOT_PATH,
		updateEpoch: normalized.updateEpoch,
		narratorCount: normalized.narrators.length,
	});
	return normalized;
}

function atomicWriteRecoveryText(text: string): void {
	if (Buffer.byteLength(text, "utf8") > MAX_RECOVERY_MANIFEST_BYTES)
		throw new Error("Recovery manifest exceeds 4 MiB limit");
	mkdirSync(UPDATE_DIR, { recursive: true });
	const tempPath = `${RECOVERY_SNAPSHOT_PATH}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		writeFileSync(tempPath, text, { flag: "wx" });
		renameSync(tempPath, RECOVERY_SNAPSHOT_PATH);
	} finally {
		try {
			unlinkSync(tempPath);
		} catch {
			/* renamed or no temp was written */
		}
	}
}

export async function waitForScheduledRecoveryHandoff(
	options: { signal?: AbortSignal } = {},
): Promise<void> {
	const handoff = scheduledHandoff.current;
	if (!handoff || handoff.epoch !== state.updateEpoch)
		throw new Error("No scheduled recovery handoff");
	assertUpdateNotCancelled();
	if (handoff.ready) return;
	const startedAt = Date.now();
	try {
		const signal = options.signal
			? AbortSignal.any([options.signal, handoff.cancellation.signal])
			: handoff.cancellation.signal;
		await waitForRecoveryHandoffReady(handoff.ticket, { signal });
		assertUpdateNotCancelled();
		const current = readRecoverySnapshotText();
		if (current !== handoff.original) {
			const original =
				handoff.original && parsePlannedUpdateRecoverySnapshot(JSON.parse(handoff.original));
			if (current === undefined && original && !getRegisteredRecoverySource(original.updateEpoch))
				handoff.original = undefined;
			else throw new Error("Recovery manifest changed while waiting for the short barrier");
		}
		handoff.ready = true;
		const elapsedMs = Date.now() - startedAt;
		if (elapsedMs >= 1000)
			logger.warn("Recovery handoff short barrier was slow", {
				updateEpoch: handoff.epoch,
				elapsedMs,
				sourceCount: getRecoveryHandoffSources(handoff.ticket).length,
			});
	} catch (error) {
		logger.warn("Recovery handoff short barrier failed", {
			updateEpoch: handoff.epoch,
			elapsedMs: Date.now() - startedAt,
			error: error instanceof Error ? error.message : String(error),
		});
		// This wait occurs before publication; cancellation/timeout unpins only this reservation.
		try {
			releaseRecoveryHandoff(handoff.ticket);
		} catch {
			/* timeout/abort already released it */
		}
		if (scheduledHandoff.current === handoff) scheduledHandoff.current = undefined;
		throw cancellationError() ?? error;
	}
}

export function getScheduledRecoverySources(): RecoverySource[] {
	return scheduledHandoff.current ? getRecoveryHandoffSources(scheduledHandoff.current.ticket) : [];
}
export function getScheduledRecoveryEpochs(): readonly string[] {
	return state.updateEpoch
		? [state.updateEpoch, ...getScheduledRecoverySources().map((source) => source.updateEpoch)]
		: [];
}

export function writePreparedUpdateRecoverySnapshot(
	snapshot: WritablePlannedUpdateRecoverySnapshot = capturePlannedUpdateRecoverySnapshot(),
	guard: Partial<RecoveryManifestEpochGuard> = {},
): PlannedUpdateRecoverySnapshot {
	const handoff = scheduledHandoff.current;
	if (!handoff || handoff.epoch !== state.updateEpoch || snapshot.updateEpoch !== handoff.epoch)
		throw new Error("Prepared recovery handoff epoch mismatch");
	if (!handoff.ready)
		throw new Error("Prepared recovery handoff has not reached its short barrier");
	const sources = getRecoveryHandoffSources(handoff.ticket);
	const incomingSources = normalizeRecoverySources(snapshot.sources ?? []);
	if (incomingSources.length !== sources.length)
		throw new Error("Prepared recovery sources do not match the reserved scope");
	for (const source of sources) {
		const incoming = incomingSources.find(
			(candidate) => candidate.updateEpoch === source.updateEpoch,
		);
		if (
			!incoming ||
			JSON.stringify({ ...incoming, unstartedTools: undefined }) !==
				JSON.stringify({ ...source, unstartedTools: undefined })
		)
			throw new Error("Prepared recovery source metadata changed outside the reservation");
		// Only fresh bounded tool receipts may augment a reserved source. They cannot authorize
		// execution: cold startup still checks the persisted attempt and execution-start receipt.
		source.unstartedTools = incoming.unstartedTools;
	}
	if (guard.expectedEpoch !== undefined && guard.expectedEpoch !== handoff.epoch)
		throw new Error("Prepared recovery manifest guard mismatch");
	if (readRecoverySnapshotText() !== (handoff.published ?? handoff.original))
		throw new Error("Recovery manifest changed during handoff");
	const normalized = parsePlannedUpdateRecoverySnapshot({
		...snapshot,
		version: sources.length ? 3 : 2,
		sources: sources.length ? sources : undefined,
		handoffMarkerNonce: guard.handoffMarkerNonce ?? snapshot.handoffMarkerNonce,
	});
	if (!normalized) throw new Error("Invalid prepared recovery manifest");
	const text = JSON.stringify(normalized, null, 2);
	atomicWriteRecoveryText(text);
	handoff.published = text;
	logger.info("Prepared recovery root published", {
		updateEpoch: handoff.epoch,
		sourceEpochs: sources.map((source) => source.updateEpoch),
		narratorCount: normalized.narrators.length,
		manifestBytes: Buffer.byteLength(text, "utf8"),
	});
	return normalized;
}

export function rollbackPreparedUpdateRecoverySnapshot(epoch: string): void {
	const handoff = scheduledHandoff.current;
	if (!handoff && state.updateEpoch === epoch) return; // An unpublished short wait was cancelled.
	if (!handoff || handoff.epoch !== epoch)
		throw new Error("Prepared recovery rollback epoch mismatch");
	getRecoveryHandoffSources(handoff.ticket);
	const current = readRecoverySnapshotText();
	if (handoff.published === undefined) {
		if (current !== handoff.original)
			throw new Error("Unpublished recovery manifest changed during handoff");
		return;
	}
	if (current !== handoff.published)
		throw new Error("Prepared recovery manifest changed before rollback");
	if (handoff.original === undefined) unlinkSync(RECOVERY_SNAPSHOT_PATH);
	else atomicWriteRecoveryText(handoff.original);
	handoff.published = undefined;
}

export function releasePreparedUpdateRecoveryHandoff(epoch: string): void {
	const handoff = scheduledHandoff.current;
	if (!handoff && state.updateEpoch === epoch) return;
	if (!handoff || handoff.epoch !== epoch)
		throw new Error("Prepared recovery release epoch mismatch");
	if (handoff.published !== undefined)
		throw new Error("Cannot release published recovery handoff before rollback");
	if (readRecoverySnapshotText() !== handoff.original)
		throw new Error("Cannot release recovery handoff after manifest identity changed");
	releaseRecoveryHandoff(handoff.ticket);
	scheduledHandoff.current = undefined;
}

export function consumePlannedUpdateRecoverySnapshot(): PlannedUpdateRecoverySnapshot | null {
	if (!existsSync(RECOVERY_SNAPSHOT_PATH)) return null;
	try {
		return parsePlannedUpdateRecoverySnapshot(JSON.parse(readRecoverySnapshotText() ?? "null"));
	} catch (error) {
		logger.warn("Failed to consume planned update recovery snapshot", {
			path: RECOVERY_SNAPSHOT_PATH,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

export type RecoveryManifestRejection =
	| "not_a_replacement_process"
	| "handoff_nonce_mismatch"
	| "evidence_only";

/**
 * Decide whether the manifest found on disk authorizes THIS process to resume its narrators.
 *
 * The manifest is a one-shot handover note from a single update attempt to the single replacement
 * process it spawned. Ownership is proven by identity, not by age: an ordinary manual restart
 * receives no handoff at all, and a different update attempt carries a different marker nonce.
 * Without this check a manifest left behind by a failed update (or by a recovery pass that could
 * not finish) is re-consumed by every subsequent startup, which resumes long-abandoned narrators
 * again and again.
 *
 * A manifest with no nonce is accepted for any handoff-spawned process: it was written either
 * before the replacement was spawned, or by a binary that predates nonce binding. Requiring a
 * nonce there would silently drop the one legitimate resume during the upgrade that introduces it.
 */
export function classifyRecoveryManifestOwnership(
	snapshot: Pick<
		PlannedUpdateRecoverySnapshot,
		"handoffMarkerNonce" | "evidenceOnly" | "resumeOnNextStartup"
	>,
	handoff: { markerNonce?: string } | null,
): { owned: true } | { owned: false; reason: RecoveryManifestRejection } {
	if (snapshot.evidenceOnly) return { owned: false, reason: "evidence_only" };
	if (snapshot.resumeOnNextStartup && !snapshot.handoffMarkerNonce && !handoff) {
		return { owned: true };
	}
	if (!handoff) return { owned: false, reason: "not_a_replacement_process" };
	if (!snapshot.handoffMarkerNonce) return { owned: true };
	if (snapshot.handoffMarkerNonce !== handoff.markerNonce) {
		return { owned: false, reason: "handoff_nonce_mismatch" };
	}
	return { owned: true };
}

export function removePlannedUpdateRecoverySnapshot(guard: RecoveryManifestEpochGuard): void {
	const handoff = scheduledHandoff.current;
	if (handoff?.epoch === guard.expectedEpoch && handoff.original !== undefined)
		throw new Error("Inherited recovery root requires explicit rollback");
	if (
		hasReservedRecoverySourceEpoch(guard.expectedEpoch) &&
		!isRecoveryAdvanceActive(guard.expectedEpoch)
	)
		return;
	const existingEpoch = readExistingRecoverySnapshotEpoch();
	// Absent manifest: nothing to remove, and a corrupt/unparseable manifest (undefined epoch while
	// the file exists) is not claimed by this epoch, so leave it for its owner/consumer.
	if (existingEpoch !== guard.expectedEpoch) {
		if (existsSync(RECOVERY_SNAPSHOT_PATH)) {
			logger.warn("Skipped recovery manifest removal owned by a different update epoch", {
				path: RECOVERY_SNAPSHOT_PATH,
				expectedEpoch: guard.expectedEpoch,
				manifestEpoch: existingEpoch ?? null,
			});
		}
		return;
	}
	try {
		unlinkSync(RECOVERY_SNAPSHOT_PATH);
		if (handoff?.epoch === guard.expectedEpoch) handoff.published = undefined;
	} catch {
		// already absent
	}
}

/** Test-only reset helper; production code never needs to reset a scheduled update. */
export function resetUpdateCoordinationForTests(): void {
	resetRecoveryHandoffForTests();
	scheduledHandoff.current = undefined;
	executions.clear();
	narratorLoops.clear();
	toolStartGrants.clear();
	preAdmissionActivities.clear();
	responseActivities.clear();
	const pending = [
		...backgroundBashDrainWaiters,
		...ordinaryDrainWaiters,
		...checkpointFenceWaiters,
	];
	backgroundBashDrainWaiters = [];
	ordinaryDrainWaiters = [];
	checkpointFenceWaiters = [];
	for (const waiter of pending) waiter.resolve();
	state.phase = "idle";
	state.operation = undefined;
	state.targetVersion = undefined;
	state.updateEpoch = undefined;
	state.error = undefined;
	state.errorKind = undefined;
	state.cancelRequestedEpoch = undefined;
	openUpdateGate();
	try {
		unlinkSync(RECOVERY_SNAPSHOT_PATH);
	} catch {
		// already absent
	}
}
