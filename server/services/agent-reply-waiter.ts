import { hotSafe } from "@server/lib/hot-safe";
import { generateShortId } from "@server/lib/id";

const DEFAULT_REPLY_TIMEOUT_MS = 60_000;
const MAX_REPLY_TIMEOUT_MS = 86_400_000;
const MAX_REPLY_CHARS = 16_000;

export type AgentReplyScopeType = "parent-child" | "team" | "chat-group";
export interface AgentReplyScope {
	type: AgentReplyScopeType;
	id: string;
}

export type AgentReplyWaitResult =
	| { status: "replied"; message: string; receivedAt: string }
	| { status: "timeout" | "aborted" | "cancelled" }
	| { status: "failed"; error: string };

export type SendAwaitTargetStatus =
	| "queued"
	| "started"
	| "completed"
	| "failed"
	| "timeout"
	| "aborted"
	| "cancelled"
	| "taken_over";

export interface SendAwaitTargetSnapshot {
	id: string;
	title?: string | null;
	status: SendAwaitTargetStatus;
	interrupted?: boolean;
	awaited?: boolean;
	error?: string;
}

export interface AgentReplyWaitSnapshot {
	toolUseId: string;
	requestId: string;
	requesterId: string;
	responderId: string;
	scope: AgentReplyScope;
	deadlineAt: string;
	label?: string;
	title?: string | null;
	deliveryNote: string;
	interrupted?: boolean;
	result?: AgentReplyWaitResult;
}

export interface AgentReplyWaitRunSnapshot {
	toolUseId: string;
	requesterId: string;
	doInterrupt: boolean;
	waiters: AgentReplyWaitSnapshot[];
	prefixSections: string[];
	prefixTargets: SendAwaitTargetSnapshot[];
}

interface PendingAgentReplyWait {
	requestId: string;
	requesterId: string;
	responderId: string;
	scope: AgentReplyScope;
	resolve: (result: AgentReplyWaitResult) => void;
	timer?: ReturnType<typeof setTimeout>;
	signal?: AbortSignal;
	onAbort?: () => void;
	snapshot?: AgentReplyWaitSnapshot;
}

interface ActiveAgentReplyWaitRun {
	token: string;
	snapshot: AgentReplyWaitRunSnapshot;
	stable: boolean;
	stablePromise: Promise<void>;
	resolveStable: () => void;
}

export interface AgentReplyWaitRunHandle {
	readonly toolUseId: string;
	readonly token: string;
	markStable: (input?: {
		prefixSections?: string[];
		prefixTargets?: SendAwaitTargetSnapshot[];
	}) => void;
	complete: () => void;
}

export interface AgentReplyWaitHandle {
	requestId: string;
	scope: AgentReplyScope;
	deadlineAt: string;
	promise: Promise<AgentReplyWaitResult>;
	cancel: () => void;
	fail: (error: string) => void;
	updateSnapshot: (
		input: Partial<
			Pick<AgentReplyWaitSnapshot, "label" | "title" | "deliveryNote" | "interrupted">
		>,
	) => void;
}

const pendingReplyWaits = hotSafe(
	"narrafork:pendingAgentReplyWaits:v3",
	() => new Map<string, PendingAgentReplyWait>(),
);
const activeReplyWaitRuns = hotSafe(
	"narrafork:activeAgentReplyWaitRuns:v1",
	() => new Map<string, ActiveAgentReplyWaitRun>(),
);

function sameScope(a: AgentReplyScope, b: AgentReplyScope): boolean {
	return a.type === b.type && a.id === b.id;
}

function cloneResult(result: AgentReplyWaitResult | undefined): AgentReplyWaitResult | undefined {
	return result ? { ...result } : undefined;
}

function cloneWaiterSnapshot(snapshot: AgentReplyWaitSnapshot): AgentReplyWaitSnapshot {
	return {
		...snapshot,
		scope: { ...snapshot.scope },
		result: cloneResult(snapshot.result),
	};
}

function cloneRunSnapshot(snapshot: AgentReplyWaitRunSnapshot): AgentReplyWaitRunSnapshot {
	return {
		...snapshot,
		waiters: snapshot.waiters.map(cloneWaiterSnapshot),
		prefixSections: [...snapshot.prefixSections],
		prefixTargets: snapshot.prefixTargets.map((target) => ({ ...target })),
	};
}

function matchingPendingReplies(
	requesterId: string,
	responderId: string,
	scope?: AgentReplyScope,
): PendingAgentReplyWait[] {
	return [...pendingReplyWaits.values()].filter(
		(entry) =>
			entry.requesterId === requesterId &&
			entry.responderId === responderId &&
			(!scope || sameScope(entry.scope, scope)),
	);
}

function detachPendingReply(entry: PendingAgentReplyWait): void {
	if (entry.timer) clearTimeout(entry.timer);
	if (entry.signal && entry.onAbort) {
		entry.signal.removeEventListener("abort", entry.onAbort);
	}
}

function settlePendingReply(entry: PendingAgentReplyWait, result: AgentReplyWaitResult): boolean {
	// Identity comparison is the cleanup CAS: a stale timer/abort/cancel from an older
	// waiter with the same explicit request id can never delete a replacement waiter.
	if (pendingReplyWaits.get(entry.requestId) !== entry) return false;
	pendingReplyWaits.delete(entry.requestId);
	detachPendingReply(entry);
	if (entry.snapshot) entry.snapshot.result = result;
	entry.resolve(result);
	return true;
}

function retireReplacedPendingReply(entry: PendingAgentReplyWait): void {
	if (pendingReplyWaits.get(entry.requestId) === entry) {
		pendingReplyWaits.delete(entry.requestId);
	}
	detachPendingReply(entry);
	const result = { status: "cancelled" } as const;
	if (entry.snapshot) entry.snapshot.result = result;
	entry.resolve(result);
}

function activeRunForHandle(handle: AgentReplyWaitRunHandle): ActiveAgentReplyWaitRun | null {
	const active = activeReplyWaitRuns.get(handle.toolUseId);
	return active?.token === handle.token ? active : null;
}

export function beginAgentReplyWaitRun(input: {
	toolUseId: string;
	requesterId: string;
	doInterrupt?: boolean;
}): AgentReplyWaitRunHandle {
	let resolveStable = () => {};
	const stablePromise = new Promise<void>((resolve) => {
		resolveStable = resolve;
	});
	const token = `${input.toolUseId}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
	const run: ActiveAgentReplyWaitRun = {
		token,
		snapshot: {
			toolUseId: input.toolUseId,
			requesterId: input.requesterId,
			doInterrupt: input.doInterrupt ?? false,
			waiters: [],
			prefixSections: [],
			prefixTargets: [],
		},
		stable: false,
		stablePromise,
		resolveStable,
	};
	activeReplyWaitRuns.set(input.toolUseId, run);

	const handle: AgentReplyWaitRunHandle = {
		toolUseId: input.toolUseId,
		token,
		markStable: (stableInput = {}) => {
			const active = activeRunForHandle(handle);
			if (!active) return;
			active.snapshot.prefixSections = [...(stableInput.prefixSections ?? [])];
			active.snapshot.prefixTargets = (stableInput.prefixTargets ?? []).map((target) => ({
				...target,
			}));
			if (!active.stable) {
				active.stable = true;
				active.resolveStable();
			}
		},
		complete: () => {
			const active = activeRunForHandle(handle);
			if (!active) return;
			if (!active.stable) active.resolveStable();
			activeReplyWaitRuns.delete(input.toolUseId);
		},
	};
	return handle;
}

function attachWaiterSnapshot(
	run: AgentReplyWaitRunHandle | undefined,
	snapshot: AgentReplyWaitSnapshot,
): AgentReplyWaitSnapshot | undefined {
	if (!run) return undefined;
	const active = activeRunForHandle(run);
	if (!active) throw new Error("Send reply wait run is no longer active");
	if (active.stable) throw new Error("Cannot add a Send reply waiter after the run became stable");
	const attached = cloneWaiterSnapshot(snapshot);
	active.snapshot.waiters.push(attached);
	return attached;
}

export function attachSettledAgentReplyWait(
	run: AgentReplyWaitRunHandle,
	snapshot: AgentReplyWaitSnapshot,
): void {
	if (!snapshot.result) throw new Error("Settled Send reply snapshot is missing its result");
	attachWaiterSnapshot(run, snapshot);
}

export function getRunningAgentReplyWaitRunSnapshot(
	toolUseId: string,
): AgentReplyWaitRunSnapshot | null {
	const run = activeReplyWaitRuns.get(toolUseId);
	return run?.stable ? cloneRunSnapshot(run.snapshot) : null;
}

export function listRunningAgentReplyWaitRuns(): AgentReplyWaitRunSnapshot[] {
	return [...activeReplyWaitRuns.values()]
		.filter((run) => run.stable)
		.map((run) => cloneRunSnapshot(run.snapshot));
}

/** Wait only for an already-started Send await setup to stabilize or complete. */
export async function waitForAgentReplyWaitRunStability(
	toolUseId: string,
): Promise<AgentReplyWaitRunSnapshot | null> {
	const run = activeReplyWaitRuns.get(toolUseId);
	if (!run) return null;
	await run.stablePromise;
	const current = activeReplyWaitRuns.get(toolUseId);
	if (!current || current.token !== run.token || !current.stable) return null;
	return cloneRunSnapshot(current.snapshot);
}

export function hasPendingAgentReply(
	requesterId: string,
	responderId: string,
	scope?: AgentReplyScope,
): boolean {
	return matchingPendingReplies(requesterId, responderId, scope).length > 0;
}

export function getPendingAgentReplyCount(
	requesterId: string,
	responderId: string,
	scope: AgentReplyScope,
): number {
	return matchingPendingReplies(requesterId, responderId, scope).length;
}

function resolveDeadline(input: { timeoutMs?: number; deadlineAt?: string }): string {
	if (input.deadlineAt) {
		const deadline = new Date(input.deadlineAt);
		if (Number.isNaN(deadline.getTime())) throw new Error("deadlineAt must be a valid timestamp");
		return deadline.toISOString();
	}
	const timeoutMs = Math.min(
		Math.max(Math.trunc(input.timeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS), 1),
		MAX_REPLY_TIMEOUT_MS,
	);
	return new Date(Date.now() + timeoutMs).toISOString();
}

export function registerAgentReplyWait(opts: {
	requesterId: string;
	responderId: string;
	scope: AgentReplyScope;
	timeoutMs?: number;
	deadlineAt?: string;
	requestId?: string;
	signal?: AbortSignal;
	run?: AgentReplyWaitRunHandle;
	toolUseId?: string;
	label?: string;
	title?: string | null;
	deliveryNote?: string;
	interrupted?: boolean;
}): AgentReplyWaitHandle {
	const deadlineAt = resolveDeadline(opts);
	let resolvePromise!: (result: AgentReplyWaitResult) => void;
	const promise = new Promise<AgentReplyWaitResult>((resolve) => {
		resolvePromise = resolve;
	});
	let requestId = opts.requestId ?? generateShortId();
	if (!opts.requestId) {
		while (pendingReplyWaits.has(requestId)) requestId = generateShortId();
	}
	const existing = pendingReplyWaits.get(requestId);
	if (existing) retireReplacedPendingReply(existing);

	const toolUseId = opts.toolUseId ?? opts.run?.toolUseId;
	const attachedSnapshot = toolUseId
		? attachWaiterSnapshot(opts.run, {
				toolUseId,
				requestId,
				requesterId: opts.requesterId,
				responderId: opts.responderId,
				scope: opts.scope,
				deadlineAt,
				label: opts.label,
				title: opts.title,
				deliveryNote: opts.deliveryNote ?? "",
				interrupted: opts.interrupted,
			})
		: undefined;
	const entry: PendingAgentReplyWait = {
		requestId,
		requesterId: opts.requesterId,
		responderId: opts.responderId,
		scope: opts.scope,
		resolve: resolvePromise,
		signal: opts.signal,
		snapshot: attachedSnapshot,
	};
	pendingReplyWaits.set(requestId, entry);

	entry.onAbort = () => {
		settlePendingReply(entry, { status: "aborted" });
	};
	if (opts.signal?.aborted) {
		entry.onAbort();
	} else if (opts.signal) {
		opts.signal.addEventListener("abort", entry.onAbort, { once: true });
	}
	if (pendingReplyWaits.get(requestId) === entry) {
		const remainingMs = Math.max(Date.parse(deadlineAt) - Date.now(), 0);
		entry.timer = setTimeout(() => {
			settlePendingReply(entry, { status: "timeout" });
		}, remainingMs);
	}

	return {
		requestId,
		scope: entry.scope,
		deadlineAt,
		promise,
		cancel: () => {
			settlePendingReply(entry, { status: "cancelled" });
		},
		fail: (error) => {
			settlePendingReply(entry, { status: "failed", error });
		},
		updateSnapshot: (input) => {
			if (!entry.snapshot) return;
			Object.assign(entry.snapshot, input);
		},
	};
}

export function registerAgentReplyWaitFromSnapshot(
	run: AgentReplyWaitRunHandle,
	snapshot: AgentReplyWaitSnapshot,
	signal?: AbortSignal,
): AgentReplyWaitHandle | null {
	if (snapshot.result) {
		attachSettledAgentReplyWait(run, snapshot);
		return null;
	}
	return registerAgentReplyWait({
		requesterId: snapshot.requesterId,
		responderId: snapshot.responderId,
		scope: snapshot.scope,
		deadlineAt: snapshot.deadlineAt,
		requestId: snapshot.requestId,
		signal,
		run,
		toolUseId: snapshot.toolUseId,
		label: snapshot.label,
		title: snapshot.title,
		deliveryNote: snapshot.deliveryNote,
		interrupted: snapshot.interrupted,
	});
}

export interface ResolvePendingAgentReplyResult {
	matched: boolean;
	requestId?: string;
	ambiguous?: boolean;
	error?: string;
}

export function resolvePendingAgentReply(opts: {
	fromNarratorId: string;
	toNarratorId: string;
	scope: AgentReplyScope;
	message: string;
	replyTo?: string;
}): ResolvePendingAgentReplyResult {
	let entry: PendingAgentReplyWait | undefined;
	if (opts.replyTo) {
		entry = pendingReplyWaits.get(opts.replyTo);
		if (!entry) {
			return { matched: false, error: `Unknown or expired Send reply request "${opts.replyTo}".` };
		}
		if (entry.requesterId !== opts.toNarratorId) {
			return { matched: false, error: "Send reply target does not match the original requester." };
		}
		if (entry.responderId !== opts.fromNarratorId) {
			return { matched: false, error: "This narrator is not the requested Send responder." };
		}
		if (!sameScope(entry.scope, opts.scope)) {
			return { matched: false, error: "Send reply scope does not match the original request." };
		}
	} else {
		const candidates = matchingPendingReplies(opts.toNarratorId, opts.fromNarratorId, opts.scope);
		if (candidates.length === 0) return { matched: false };
		if (candidates.length > 1) {
			return {
				matched: false,
				ambiguous: true,
				error:
					"Multiple Send reply requests are pending for this narrator pair and scope; " +
					"reply with the explicit replyTo request id.",
			};
		}
		entry = candidates[0];
	}

	const message =
		opts.message.length > MAX_REPLY_CHARS
			? `${opts.message.slice(0, MAX_REPLY_CHARS)}…[truncated]`
			: opts.message;
	const matched = settlePendingReply(entry, {
		status: "replied",
		message,
		receivedAt: new Date().toISOString(),
	});
	return matched ? { matched: true, requestId: entry.requestId } : { matched: false };
}

export function clearPendingAgentReplyWaits(): void {
	for (const entry of [...pendingReplyWaits.values()]) {
		settlePendingReply(entry, { status: "cancelled" });
	}
	for (const run of [...activeReplyWaitRuns.values()]) {
		if (!run.stable) run.resolveStable();
	}
	activeReplyWaitRuns.clear();
}
