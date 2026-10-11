import { generateShortId } from "@server/lib/id";
import type { IntelligentUiKitRequest } from "@shared/intelligent-ui-kit";

/**
 * The confirmation gate in front of a component kit build.
 *
 * A build runs the project's own bundler and rewrites the bundle every preview uses, so
 * the agent never starts one on its own: the host records a request, the user confirms
 * it in the UI, and only then does `kit_build` proceed.
 *
 * Deliberately process memory, not a workspace file or a tool result: the agent can write
 * both, and an approval the agent can author is not an approval. A restart drops pending
 * requests, which costs the user one more click and nothing else.
 */
interface Entry extends IntelligentUiKitRequest {
	workspaceKey: string;
	expires: number;
	/** The user declined; do not ask again for this workspace until it expires. */
	dismissed?: boolean;
}

const TTL_MS = 24 * 60 * 60_000;
const MAX_ENTRIES = 2_000;
const entries = new Map<string, Entry>();

const keyFor = (narratorId: string, workspaceKey: string) =>
	JSON.stringify([narratorId, workspaceKey]);

function live(narratorId: string, workspaceKey: string): Entry | undefined {
	const key = keyFor(narratorId, workspaceKey);
	const entry = entries.get(key);
	if (entry && entry.expires <= Date.now()) {
		entries.delete(key);
		return undefined;
	}
	return entry;
}

function expose(entry: Entry): IntelligentUiKitRequest {
	return {
		id: entry.id,
		kind: entry.kind,
		state: entry.state,
		reason: entry.reason,
		createdAt: entry.createdAt,
	};
}

/** The request the user can still act on, or that the agent may now fulfil. */
export function getKitRequest(
	narratorId: string,
	workspaceKey: string,
): IntelligentUiKitRequest | null {
	const entry = live(narratorId, workspaceKey);
	return entry && !entry.dismissed ? expose(entry) : null;
}

/**
 * Passive suggestion (a render noticed the kit is missing or out of date): ask the user
 * ONCE. Returns the request only on the call that created it, so one prompt appears in
 * the conversation instead of one under every piece of UI drawn while it is unanswered.
 * A workspace the user declined is not asked again.
 */
export function suggestKitBuild(
	narratorId: string,
	workspaceKey: string,
	kind: IntelligentUiKitRequest["kind"],
	reason: string,
): IntelligentUiKitRequest | null {
	return live(narratorId, workspaceKey)
		? null
		: requestKitBuild(narratorId, workspaceKey, kind, reason);
}

/**
 * Explicit request (the agent called `kit_build`, typically because the user asked for
 * it in chat). Returns the open request, creating one if needed; `explicit` re-opens a
 * request the user had declined.
 */
export function requestKitBuild(
	narratorId: string,
	workspaceKey: string,
	kind: IntelligentUiKitRequest["kind"],
	reason: string,
	explicit = false,
): IntelligentUiKitRequest | null {
	const existing = live(narratorId, workspaceKey);
	if (existing && !existing.dismissed) return expose(existing);
	if (existing?.dismissed && !explicit) return null;
	const entry: Entry = {
		id: generateShortId(12),
		kind,
		state: "pending",
		reason: reason.slice(0, 400),
		createdAt: new Date().toISOString(),
		workspaceKey,
		expires: Date.now() + TTL_MS,
	};
	const key = keyFor(narratorId, workspaceKey);
	entries.delete(key);
	entries.set(key, entry);
	if (entries.size > MAX_ENTRIES) {
		const oldest = entries.keys().next().value;
		if (oldest !== undefined) entries.delete(oldest);
	}
	return expose(entry);
}

function byId(narratorId: string, requestId: string): Entry | undefined {
	for (const [key, entry] of entries) {
		// The id alone is not authority: it must belong to this narrator's request.
		if (entry.id !== requestId || JSON.parse(key)[0] !== narratorId) continue;
		return entry.expires > Date.now() && !entry.dismissed ? entry : undefined;
	}
	return undefined;
}

/** User confirmation. Idempotent; null when the request is gone or was never this narrator's. */
export function approveKitRequest(
	narratorId: string,
	requestId: string,
): { request: IntelligentUiKitRequest; newlyApproved: boolean } | null {
	const entry = byId(narratorId, requestId);
	if (!entry) return null;
	const newlyApproved = entry.state === "pending";
	entry.state = "approved";
	entry.expires = Date.now() + TTL_MS;
	return { request: expose(entry), newlyApproved };
}

export function dismissKitRequest(narratorId: string, requestId: string): boolean {
	const entry = byId(narratorId, requestId);
	if (!entry || entry.state !== "pending") return false;
	entry.dismissed = true;
	return true;
}

export function hasKitApproval(narratorId: string, workspaceKey: string): boolean {
	const entry = live(narratorId, workspaceKey);
	return entry?.state === "approved" && !entry.dismissed;
}

/** A successful build spends the approval; the next build needs a new confirmation. */
export function consumeKitApproval(narratorId: string, workspaceKey: string): void {
	const entry = live(narratorId, workspaceKey);
	if (entry?.state === "approved") entries.delete(keyFor(narratorId, workspaceKey));
}

/** Test seam: process memory must not leak between cases. */
export function resetKitRequestsForTest(): void {
	entries.clear();
}
