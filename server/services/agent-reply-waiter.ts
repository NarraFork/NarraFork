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

interface PendingAgentReplyWait {
	requestId: string;
	requesterId: string;
	responderId: string;
	scope: AgentReplyScope;
	resolve: (result: AgentReplyWaitResult) => void;
	timer?: ReturnType<typeof setTimeout>;
	signal?: AbortSignal;
	onAbort?: () => void;
}

export interface AgentReplyWaitHandle {
	requestId: string;
	scope: AgentReplyScope;
	promise: Promise<AgentReplyWaitResult>;
	cancel: () => void;
	fail: (error: string) => void;
}

const pendingReplyWaits = hotSafe(
	"narrafork:pendingAgentReplyWaits:v2",
	() => new Map<string, PendingAgentReplyWait>(),
);

function sameScope(a: AgentReplyScope, b: AgentReplyScope): boolean {
	return a.type === b.type && a.id === b.id;
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

function settlePendingReply(entry: PendingAgentReplyWait, result: AgentReplyWaitResult): boolean {
	if (pendingReplyWaits.get(entry.requestId) !== entry) return false;
	pendingReplyWaits.delete(entry.requestId);
	if (entry.timer) clearTimeout(entry.timer);
	if (entry.signal && entry.onAbort) {
		entry.signal.removeEventListener("abort", entry.onAbort);
	}
	entry.resolve(result);
	return true;
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

export function registerAgentReplyWait(opts: {
	requesterId: string;
	responderId: string;
	scope: AgentReplyScope;
	timeoutMs?: number;
	signal?: AbortSignal;
}): AgentReplyWaitHandle {
	const timeoutMs = Math.min(
		Math.max(Math.trunc(opts.timeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS), 1),
		MAX_REPLY_TIMEOUT_MS,
	);
	let resolvePromise!: (result: AgentReplyWaitResult) => void;
	const promise = new Promise<AgentReplyWaitResult>((resolve) => {
		resolvePromise = resolve;
	});
	let requestId = generateShortId();
	while (pendingReplyWaits.has(requestId)) requestId = generateShortId();
	const entry: PendingAgentReplyWait = {
		requestId,
		requesterId: opts.requesterId,
		responderId: opts.responderId,
		scope: opts.scope,
		resolve: resolvePromise,
		signal: opts.signal,
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
		entry.timer = setTimeout(() => {
			settlePendingReply(entry, { status: "timeout" });
		}, timeoutMs);
	}

	return {
		requestId,
		scope: entry.scope,
		promise,
		cancel: () => {
			settlePendingReply(entry, { status: "cancelled" });
		},
		fail: (error) => {
			settlePendingReply(entry, { status: "failed", error });
		},
	};
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
}
