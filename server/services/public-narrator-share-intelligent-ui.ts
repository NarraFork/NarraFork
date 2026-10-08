import { isIntelligentUiToolName, publicIntelligentUiSummary } from "@shared/intelligent-ui-public";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { narratorToolCalls } from "../db/schema";
import { AppError } from "../lib/errors";

export interface PublicToolIdentity {
	toolUseId: string;
	toolCallId?: string | null;
	messageId?: string;
	toolName?: string;
}

const MAX_IDENTITIES = 4096;
const IDENTITY_TTL_MS = 5 * 60_000;
const MAX_PROJECTION_NODES = 20_000;
const MAX_PROJECTION_DEPTH = 64;
const MAX_IDENTITY_READS = 256;
const MAX_IDENTITY_CANDIDATES = 32;
type Identity = "private" | "public" | "unknown";
const identities = new Map<string, { identity: Identity; expires: number }>();
const keyFor = (narratorId: string, identity: PublicToolIdentity) =>
	JSON.stringify([
		narratorId,
		identity.toolUseId,
		identity.toolCallId ?? "",
		identity.messageId ?? "",
	]);

function cache(key: string, identity: Identity): void {
	// A missing row may be inserted as soon as the streamed input finishes parsing.
	if (identity === "unknown") return;
	// Provider IDs can collide across messages. A named non-UI frame must not
	// downgrade a UI identity used by an older/id-only frame on the same lane.
	const previous = identities.get(key);
	if (previous?.identity === "private" && previous.expires > Date.now() && identity === "public")
		return;
	identities.delete(key);
	identities.set(key, { identity, expires: Date.now() + IDENTITY_TTL_MS });
	if (identities.size > MAX_IDENTITIES) {
		const oldest = identities.keys().next().value;
		if (oldest !== undefined) identities.delete(oldest);
	}
}

/** Only call with dispatcher-owned tool names, never a client/model privacy flag. */
export function rememberPublicToolIdentity(narratorId: string, identity: PublicToolIdentity): void {
	if (
		!identity.toolName ||
		!identity.toolUseId ||
		[
			narratorId,
			identity.toolUseId,
			identity.toolCallId,
			identity.messageId,
			identity.toolName,
		].some((value) => value != null && value.length > 256)
	)
		return;
	const value = isIntelligentUiToolName(identity.toolName) ? "private" : "public";
	cache(keyFor(narratorId, identity), value);
	cache(keyFor(narratorId, { toolUseId: identity.toolUseId }), value);
}

function toolIdentity(narratorId: string, identity: PublicToolIdentity): Identity {
	if (isIntelligentUiToolName(identity.toolName)) return "private";
	if (!identity.toolUseId || identity.toolUseId.length > 256) return "unknown";
	const key = keyFor(narratorId, identity);
	const cached = identities.get(key);
	if (cached && cached.expires > Date.now()) return cached.identity;
	identities.delete(key);
	try {
		// Indexed PK / narrator+toolUseId lookup; never select tool bodies or scan history.
		let rows = db
			.select({ toolName: narratorToolCalls.toolName })
			.from(narratorToolCalls)
			.where(
				and(
					eq(narratorToolCalls.toolUseId, identity.toolUseId),
					identity.toolCallId
						? eq(narratorToolCalls.id, identity.toolCallId)
						: identity.messageId
							? eq(narratorToolCalls.messageId, identity.messageId)
							: eq(narratorToolCalls.narratorId, narratorId),
				),
			)
			.limit(MAX_IDENTITY_CANDIDATES + 1)
			.all();
		if (rows.length === 0 && !identity.toolCallId && !identity.messageId) {
			// Parent broadcasts / fork snapshots may refer to a child/original author.
			// This is classification, not access: the caller already authorized the
			// payload. An indexed capped fallback restores ordinary child-tool output
			// after reconnect without trusting another connection's in-memory history.
			rows = db
				.select({ toolName: narratorToolCalls.toolName })
				.from(narratorToolCalls)
				.where(eq(narratorToolCalls.toolUseId, identity.toolUseId))
				.limit(MAX_IDENTITY_CANDIDATES + 1)
				.all();
		}
		const result: Identity = rows.some((row) => isIntelligentUiToolName(row.toolName))
			? "private"
			: rows.length > 0 && rows.length <= MAX_IDENTITY_CANDIDATES
				? "public"
				: "unknown";
		// Only immutable PK identities and private decisions may outlive this call.
		// A provider ID alone can be reused by a later invocation with another name.
		if (identity.toolCallId || result === "private") cache(key, result);
		return result;
	} catch {
		return "unknown";
	}
}

/** Classification only, NOT authorization. Call after the share/source narrator check. */
export function isPublicToolSourceAllowed(
	narratorId: string,
	identity: PublicToolIdentity,
): boolean {
	return toolIdentity(narratorId, identity) === "public";
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identityFor(value: Record<string, unknown>): PublicToolIdentity | undefined {
	const toolUseId =
		value.toolUseId ?? value.tool_use_id ?? (value.type === "tool_use" ? value.id : undefined);
	if (typeof toolUseId !== "string") return undefined;
	const toolCallId =
		value.toolCallId ?? value.tcId ?? (value.toolName && !value.type ? value.id : undefined);
	return {
		toolUseId,
		...(typeof toolCallId === "string" ? { toolCallId } : {}),
		...(typeof value.messageId === "string" ? { messageId: value.messageId } : {}),
		...(typeof value.toolName === "string"
			? { toolName: value.toolName }
			: value.type === "tool_use" && typeof value.name === "string"
				? { toolName: value.name }
				: {}),
	};
}

// Traverse transcript structure only. A Bash JSON result containing a key called
// "toolName" remains byte-for-byte intact; this is not a general JSON scrubber.
const CONTAINERS = [
	"messages",
	"message",
	"contentJson",
	"content",
	"children",
	"toolCalls",
	"toolChunks",
	"topLevel",
	"orphanChildren",
	"subagentActivities",
	"activity",
	"_subagentActivity",
	"latestToolCalls",
	"request",
	"block",
] as const;

/** Batch immutable PK identities: a normal 100-message page must not issue N+1 queries. */
function payloadToolRows(payload: unknown) {
	const ids = new Set<string>();
	let visited = 0;
	const collect = (value: unknown, depth: number) => {
		if (++visited > MAX_PROJECTION_NODES || depth > MAX_PROJECTION_DEPTH)
			throw new AppError(
				"Public transcript projection limit",
				503,
				"PUBLIC_SHARE_PROJECTION_LIMIT",
			);
		if (Array.isArray(value)) {
			if (value.length > MAX_PROJECTION_NODES - visited)
				throw new AppError(
					"Public transcript projection limit",
					503,
					"PUBLIC_SHARE_PROJECTION_LIMIT",
				);
			for (const entry of value) collect(entry, depth + 1);
			return;
		}
		if (!object(value)) return;
		const identity = identityFor(value);
		if (identity?.toolCallId && !isIntelligentUiToolName(identity.toolName))
			ids.add(identity.toolCallId);
		for (const key of CONTAINERS) {
			if (object(value[key]) || Array.isArray(value[key])) collect(value[key], depth + 1);
		}
	};
	collect(payload, 0);
	const result = new Map<string, { toolUseId: string; toolName: string }>();
	const keys = [...ids];
	if (keys.length > MAX_IDENTITIES)
		throw new AppError("Public transcript identity limit", 503, "PUBLIC_SHARE_PROJECTION_LIMIT");
	for (let start = 0; start < keys.length; start += 128) {
		const batch = keys.slice(start, start + 128);
		for (const row of db
			.select({
				id: narratorToolCalls.id,
				toolUseId: narratorToolCalls.toolUseId,
				toolName: narratorToolCalls.toolName,
			})
			.from(narratorToolCalls)
			.where(inArray(narratorToolCalls.id, batch))
			.limit(batch.length)
			.all())
			result.set(row.id, row);
	}
	return result;
}

/** Covers history trees, enriched blocks, persisted tool rows, snapshots and catch-up. */
export function projectPublicNarratorPayload<T>(narratorId: string, payload: T): T {
	const toolRows = payloadToolRows(payload);
	let visited = 0;
	let reads = 0;
	const decisions = new Map<string, Identity>();
	const classify = (identity: PublicToolIdentity, scope: string): Identity => {
		if (isIntelligentUiToolName(identity.toolName)) return "private";
		if (identity.toolCallId) {
			const row = toolRows.get(identity.toolCallId);
			if (row?.toolUseId === identity.toolUseId)
				return isIntelligentUiToolName(row.toolName) ? "private" : "public";
		}
		// Without a durable PK, a dispatcher-selected name is the strongest
		// available identity (e.g. a streamed call not yet inserted in SQLite).
		if (identity.toolName) return "public";
		const key = keyFor(scope, identity);
		const previous = decisions.get(key);
		if (previous) return previous;
		if (++reads > MAX_IDENTITY_READS)
			throw new AppError(
				"Public transcript projection limit",
				503,
				"PUBLIC_SHARE_PROJECTION_LIMIT",
			);
		const result = toolIdentity(scope, identity);
		decisions.set(key, result);
		return result;
	};
	const visit = (value: unknown, depth: number, scope: string): unknown => {
		if (++visited > MAX_PROJECTION_NODES || depth > MAX_PROJECTION_DEPTH)
			throw new AppError(
				"Public transcript projection limit",
				503,
				"PUBLIC_SHARE_PROJECTION_LIMIT",
			);
		if (Array.isArray(value)) {
			let changed = false;
			const projected = value.map((entry) => {
				const next = visit(entry, depth + 1, scope);
				changed ||= next !== entry;
				return next;
			});
			return changed ? projected : value;
		}
		if (!object(value)) return value;
		const localScope = typeof value.narratorId === "string" ? value.narratorId : scope;
		if (
			isIntelligentUiToolName(value.toolName) ||
			(value.type === "tool_use" && isIntelligentUiToolName(value.name))
		)
			return publicIntelligentUiSummary(value);
		const identity = identityFor(value);
		if (identity) {
			const state = classify(identity, localScope);
			if (state === "private" || (state === "unknown" && value.type === "tool_result"))
				return publicIntelligentUiSummary(value);
		}
		let result = value;
		for (const key of CONTAINERS) {
			if (!object(value[key]) && !Array.isArray(value[key])) continue;
			const next = visit(value[key], depth + 1, localScope);
			if (next !== value[key]) {
				if (result === value) result = { ...value };
				result[key] = next;
				// A denormalized full-text fallback can contain the original tool result
				// even after its structured block was replaced. Never return both copies.
				if ((key === "contentJson" || key === "content") && "contentText" in result)
					result.contentText = null;
			}
		}
		return result;
	};
	return visit(payload, 0, narratorId) as T;
}

/** Call BEFORE anonymous serialization/queueing, including replay and safeSend. */
export function projectPublicNarratorEvent<T extends { type: string }>(
	narratorId: string,
	event: T,
): T | null {
	try {
		const value = event as Record<string, unknown>;
		if (
			event.type === "leaked_tool_call_notice" &&
			Array.isArray(value.toolNames) &&
			value.toolNames.some(isIntelligentUiToolName)
		)
			return null;
		const identity =
			identityFor(value) ?? (object(value.request) ? identityFor(value.request) : undefined);
		if (identity) {
			const state = toolIdentity(narratorId, identity);
			// Named dispatcher frames can precede persistence. Their selected tool name
			// is trusted; reconnect/id-only frames must instead resolve durable identity.
			const privateOrUnknown = state === "private" || (state === "unknown" && !identity.toolName);
			if (privateOrUnknown) {
				if (event.type === "tool_started" || event.type === "tool_completed")
					return publicIntelligentUiSummary(value) as T;
				return null;
			}
		}
		return projectPublicNarratorPayload(narratorId, event);
	} catch {
		// An oversized/malformed snapshot is unavailable, never a reason to leak it.
		return null;
	}
}
