/**
 * await-agent-resolution.ts — Resolve a RUNNING `Await({type:"agent"})` call's
 * target selector into the real subagent narrator id.
 *
 * WHY THIS EXISTS
 * The Await tool only learns its target's narrator id when it RETURNS: `subagentId`
 * / `resolvedId` live in `metadata`, and the `<subagent_id>` tag lives in the
 * output text (`tools/await.ts` execute → return). While the wait is in flight the
 * tool call row has an empty `outputJson`, so every frontend derivation of "which
 * session does this Await row point at" comes up empty:
 *
 *   vlist    → deriveAwaitAgentNarratorId  (vlist-tool-meta.ts)
 *   chunked  → getAwaitAgentNarratorId     (ToolCallCard.tsx)
 *   trace    → traceRowAwaitAgentNarratorId (trace-row-identity.ts)
 *
 * All three then hide (or disable) the "open session" item — precisely while the
 * user most wants it, because the subagent is still working and its progress is
 * only visible inside its own session.
 *
 * The missing fact is cheap: the selector the model typed (`input.id`) is an
 * alias / title / id-prefix that the team's subagent roster can resolve. This
 * module does exactly that, in BULK for a page of messages, so no per-row query
 * is ever needed (the trace path documents that constraint explicitly).
 *
 * ── Deliberate scope limits ──
 * - READ ONLY. It never writes `outputJson`: a non-null output makes the history
 *   builders treat the call as finished (`status === "success" | "fail"` gating
 *   in anthropic/openai providers reads status, but several UI paths gate on
 *   `outputJson` truthiness — e.g. `isRunning = status === "running" && !outputJson`).
 *   The resolved id is delivered as a separate transport field instead.
 * - NEVER THROWS. A selector that matches nothing, or matches ambiguously,
 *   resolves to nothing and the menu item simply stays hidden — the previous
 *   behaviour. Failing a message load over a cosmetic navigation affordance
 *   would be a strictly worse trade.
 * - Bounded queries only: one roster query per parent narrator plus one
 *   background-task query, both indexed, with narrow column projections. No
 *   large fields (`output`, `input_json`, message bodies) are selected.
 */

import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { backgroundTasks, narrators } from "../db/schema";
import { isSubagentVariant } from "../lib/narrator-utils";
import { resolveTaskAlias, subagentMatchesSelector } from "./subagent-alias";

/**
 * Field carrying the resolved child narrator id of a RUNNING `Await({type:"agent"})`.
 *
 * ⚠️ Deliberately NOT written into `metadata.subagentId`, even though that is where
 * a FINISHED Await keeps the same fact. Two reasons, both load-bearing:
 *
 *  1. Height. `classifyAwait` (shared/pretext-layout/tool-detail.ts) renders a
 *     `subagent: …` row whenever `metadata.subagentId` exists, so writing it there
 *     would grow every running Await card. This channel exists only to enable a
 *     menu item, and a navigation affordance must not move layout.
 *  2. Provenance. `metadata` is the tool's own returned payload; this value is
 *     DERIVED by the server from the selector. Keeping it in a distinct field means
 *     no reader can mistake a still-running wait for a completed one.
 *
 * Frontend readers treat it as the last fallback after the persisted metadata (see
 * `deriveAwaitAgentNarratorId` / `getAwaitAgentNarratorId`), so a finished call
 * always prefers its authoritative id.
 */
// Also used by single-target Send: this is a navigation-only transport channel,
// independent of either tool's returned metadata or completion state.
export const AWAIT_AGENT_RESOLVED_FIELD = "_awaitAgentNarratorId";

/** Conservative input gating: never guess among multiple selectors or parent reports. */
export function singleSendSelector(input: Record<string, unknown>): string | undefined {
	if (
		[input.ids, input.names].some(
			(value) =>
				value !== undefined &&
				(!Array.isArray(value) || value.some((item) => typeof item !== "string")),
		)
	)
		return undefined;
	const selectors = [
		input.id,
		input.name,
		...(Array.isArray(input.ids) ? input.ids : []),
		...(Array.isArray(input.names) ? input.names : []),
	]
		.map(nonEmpty)
		.filter(Boolean);
	if (selectors.length !== 1) return undefined;
	const selector = selectors[0];
	if (!selector || ["parent", "main", "@parent", "@main"].includes(selector.toLowerCase())) {
		return undefined;
	}
	return selector;
}

/**
 * Field marking a tool call whose target subagent is currently TAKEN OVER by the
 * user (`subagent-takeover.ts`).
 *
 * Why the parent's card needs it at all: a takeover leaves the parent narrator
 * blocked — a foreground Agent/Task call stays suspended in
 * `waitForManualOverride`, and an `Await({type:"agent"})` that was already in
 * flight when the takeover began never returns. Neither state is visible on the
 * card, so a user who forgets to press "Stop takeover" silently stalls the whole
 * session with no indication of why.
 *
 * ⚠️ Deliberately NOT written into `metadata`, for the same two reasons as
 * {@link AWAIT_AGENT_RESOLVED_FIELD}:
 *
 *  1. Height. `classifyAwait` turns metadata entries into extra rows; this flag
 *     is painted as a badge inside the card's ALREADY-FIXED header row, so it
 *     must not reach the detail classifier.
 *  2. Provenance. `metadata` is the tool's own returned payload, while this is
 *     server-derived runtime state that vanishes on restart (takeover authority
 *     is in-memory). A reader must not mistake it for something the tool
 *     reported.
 */
export const TAKEN_OVER_FIELD = "_takenOver";

/**
 * Mark the `tool_use` blocks of calls whose target subagent is taken over.
 *
 * Same shape and identity contract as {@link attachAwaitAgentNarratorIds}: an
 * unaffected page comes back as the SAME references, so the common case (no live
 * takeover) pays a single set-size check.
 */
export function attachTakenOverFlags(
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	tree: any[],
	takenOverToolUseIds: ReadonlySet<string>,
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
): any[] {
	if (takenOverToolUseIds.size === 0 || !Array.isArray(tree) || tree.length === 0) return tree;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	let next: any[] | null = null;
	for (let i = 0; i < tree.length; i++) {
		const msg = tree[i];
		const patched = patchTakenOverMessage(msg, takenOverToolUseIds);
		if (patched === msg) {
			next?.push(msg);
			continue;
		}
		if (!next) next = tree.slice(0, i);
		next.push(patched);
	}
	return next ?? tree;
}

/** Patch one message, returning the SAME reference when nothing changed. */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function patchTakenOverMessage(msg: any, takenOverToolUseIds: ReadonlySet<string>): any {
	const children = msg?.children?.length
		? attachTakenOverFlags(msg.children, takenOverToolUseIds)
		: msg?.children;
	const childrenChanged = children !== msg?.children;
	if (!Array.isArray(msg?.contentJson)) {
		return childrenChanged ? { ...msg, children } : msg;
	}
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	let contentJson: any[] | null = null;
	for (let i = 0; i < msg.contentJson.length; i++) {
		const block = msg.contentJson[i];
		const hit = block?.type === "tool_use" && takenOverToolUseIds.has(block.id);
		if (!hit) {
			contentJson?.push(block);
			continue;
		}
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const acc: any[] = contentJson ?? msg.contentJson.slice(0, i);
		contentJson = acc;
		acc.push({ ...block, [TAKEN_OVER_FIELD]: true });
	}
	if (!contentJson) return childrenChanged ? { ...msg, children } : msg;
	return { ...msg, contentJson, children };
}

/**
 * Attach {@link AWAIT_AGENT_RESOLVED_FIELD} to the `tool_use` blocks of pending
 * Await-agent calls, so the frontend can offer "open session" WHILE the wait is
 * still in flight.
 *
 * Lives here rather than in `narrator-messages` on purpose: it is pure, and
 * `narrator-messages` is part of an import cycle with `narrator-service`, so
 * importing it from a test would evaluate that cycle and fail at module init.
 *
 * Runs on an already-enriched tree and only rewrites the blocks it has an id for,
 * returning the SAME references otherwise — an unaffected page pays no copy.
 */
export function attachAwaitAgentNarratorIds(
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	tree: any[],
	resolved: ReadonlyMap<string, string>,
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
): any[] {
	if (resolved.size === 0 || !Array.isArray(tree) || tree.length === 0) return tree;
	// Build lazily: `Array.prototype.map` would allocate a new array (and a new
	// message object per entry) even when nothing matched, defeating the identity
	// contract this function promises for unaffected pages.
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	let next: any[] | null = null;
	for (let i = 0; i < tree.length; i++) {
		const msg = tree[i];
		const patched = patchMessage(msg, resolved);
		if (patched === msg) {
			next?.push(msg);
			continue;
		}
		if (!next) next = tree.slice(0, i);
		next.push(patched);
	}
	return next ?? tree;
}

/** Patch one message, returning the SAME reference when nothing changed. */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function patchMessage(msg: any, resolved: ReadonlyMap<string, string>): any {
	const children = msg?.children?.length
		? attachAwaitAgentNarratorIds(msg.children, resolved)
		: msg?.children;
	const childrenChanged = children !== msg?.children;
	if (!Array.isArray(msg?.contentJson)) {
		return childrenChanged ? { ...msg, children } : msg;
	}
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	let contentJson: any[] | null = null;
	for (let i = 0; i < msg.contentJson.length; i++) {
		const block = msg.contentJson[i];
		const subagentId = block?.type === "tool_use" ? resolved.get(block.id) : undefined;
		if (!subagentId) {
			contentJson?.push(block);
			continue;
		}
		// `??=` does not narrow here (the source expression is `any`), so assign to a
		// definitely-non-null local and keep the accumulator in sync.
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const acc: any[] = contentJson ?? msg.contentJson.slice(0, i);
		contentJson = acc;
		acc.push({ ...block, [AWAIT_AGENT_RESOLVED_FIELD]: subagentId });
	}
	if (!contentJson) return childrenChanged ? { ...msg, children } : msg;
	return { ...msg, contentJson, children };
}

/** The Await tool-call shape this module reads. Mirrors the frontend derivations. */
export interface AwaitAgentToolCallLike {
	toolUseId: string;
	toolName: string;
	inputJson?: unknown;
	outputJson?: unknown;
}

/** One pending Await-agent call: the row plus the selector it is waiting on. */
export interface PendingAwaitAgent {
	toolUseId: string;
	/** The selector the model typed (`input.id`): alias | title | id | id-prefix. */
	selector: string;
	/** Send enforces child/sibling authorization, unlike legacy Await resolution. */
	send?: boolean;
	callerId?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function nonEmpty(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Whether this Await call ALREADY knows its subagent id from persisted data.
 *
 * A finished Await carries it in `outputJson._metadata`; re-resolving such a row
 * would be pure waste, and the persisted value is authoritative anyway (the wait
 * may have targeted a subagent that has since been superseded by a same-alias
 * sibling).
 */
function hasPersistedSubagentId(tc: AwaitAgentToolCallLike): boolean {
	const metadata = asRecord(asRecord(tc.outputJson)._metadata);
	return !!(nonEmpty(metadata.subagentId) ?? nonEmpty(metadata.resolvedId));
}

/**
 * The pending Await-agent calls in a batch of tool calls.
 *
 * Pure and export-visible so tests can lock the gating without a database: only
 * `Await`, only `type: "agent"`, only with a selector, only when the persisted
 * metadata does not already answer the question.
 */
export function collectPendingAwaitAgents(
	toolCalls: readonly AwaitAgentToolCallLike[],
): PendingAwaitAgent[] {
	const pending: PendingAwaitAgent[] = [];
	const seen = new Set<string>();
	for (const tc of toolCalls) {
		if ((tc.toolName !== "Await" && tc.toolName !== "Send") || !tc.toolUseId) continue;
		if (seen.has(tc.toolUseId)) continue;
		const input = asRecord(tc.inputJson);
		// A truncated input keeps its short fields, so `type`/`id` survive; anything
		// else is not an agent await and has no session to open.
		if (tc.toolName === "Send") {
			// Never retarget a completed Send from today's roster. Returned targets win.
			if (tc.outputJson != null) continue;
			const selector = singleSendSelector(input);
			if (!selector) continue;
			seen.add(tc.toolUseId);
			pending.push({ toolUseId: tc.toolUseId, selector, send: true });
			continue;
		}
		if (nonEmpty(input.type) !== "agent") continue;
		const selector = nonEmpty(input.id);
		if (!selector) continue;
		if (hasPersistedSubagentId(tc)) continue;
		seen.add(tc.toolUseId);
		pending.push({ toolUseId: tc.toolUseId, selector });
	}
	return pending;
}

/** Roster entry a selector is matched against. */
interface RosterEntry {
	id: string;
	title: string | null;
	traits: unknown;
}

/**
 * Resolve selectors against one parent narrator's subagent roster.
 *
 * Mirrors `resolveOneTarget` (agent-communication.ts) minus its throwing
 * behaviour and its permission assertions:
 *   1. the in-memory alias registry (same-session, no I/O)
 *   2. an exact roster id
 *   3. `subagentMatchesSelector` — id prefix / exact title / title slug / alias trait
 *   4. a background-task alias or id (a detached agent's readable handle)
 *
 * An AMBIGUOUS selector resolves to nothing on purpose: guessing one of several
 * candidates would silently navigate the user into the wrong session, which is
 * worse than the item staying hidden.
 */
function resolveAgainstRoster(
	selector: string,
	roster: readonly RosterEntry[],
	taskAliasToSubagentId: ReadonlyMap<string, string>,
): string | undefined {
	const byId = roster.find((entry) => entry.id === selector);
	if (byId) return byId.id;

	const matches = roster.filter((entry) => subagentMatchesSelector(entry, selector));
	if (matches.length === 1) return matches[0].id;
	// More than one candidate: ambiguous, resolve to nothing (see the note above).
	if (matches.length > 1) return undefined;

	return taskAliasToSubagentId.get(selector);
}

/**
 * Resolve every pending Await-agent selector for ONE parent narrator's team.
 *
 * Returns `toolUseId → subagent narrator id` for the selectors that resolved
 * unambiguously. Unresolvable entries are simply absent.
 *
 * `teamParentId` must be the TEAM scope (a subagent's parent, or the narrator
 * itself for a primary), because both the alias registry and the roster are
 * keyed by parent — the same rule `getCommunicationScope` applies.
 */
export async function resolveAwaitAgentNarratorIds(
	teamParentId: string,
	pending: readonly PendingAwaitAgent[],
): Promise<Map<string, string>> {
	const resolved = new Map<string, string>();
	if (!teamParentId || pending.length === 0) return resolved;

	try {
		const [roster, tasks] = await Promise.all([
			db.query.narrators.findMany({
				where: eq(narrators.parentNarratorId, teamParentId),
				columns: { id: true, title: true, traits: true, variant: true },
			}),
			db.query.backgroundTasks.findMany({
				where: inArray(backgroundTasks.parentNarratorId, [
					teamParentId,
					...new Set(
						pending.flatMap((entry) => (entry.send && entry.callerId ? [entry.callerId] : [])),
					),
				]),
				columns: {
					id: true,
					alias: true,
					subagentNarratorId: true,
					type: true,
					parentNarratorId: true,
					createdAt: true,
				},
			}),
		]);
		if (roster.length === 0 && tasks.length === 0) return resolved;

		const taskAliasToSubagentId = new Map<string, string>();
		const sendTaskAliases = new Map<string, Map<string, { id: string; createdAt: string }>>();
		for (const task of tasks) {
			// Preserve Await's agent-task fallback; Send's aliases additionally honor
			// the latest non-agent task reusing an alias, just like getByAlias.
			const subagentId =
				task.subagentNarratorId ?? (task.type === "agent" ? task.id : (task.alias ?? ""));
			if (task.type === "agent" && task.parentNarratorId === teamParentId) {
				taskAliasToSubagentId.set(task.id, subagentId);
				if (task.alias) taskAliasToSubagentId.set(task.alias, subagentId);
			}
			if (task.parentNarratorId && task.alias) {
				let aliases = sendTaskAliases.get(task.parentNarratorId);
				if (!aliases) {
					aliases = new Map();
					sendTaskAliases.set(task.parentNarratorId, aliases);
				}
				const previous = aliases.get(task.alias);
				if (!previous || task.createdAt > previous.createdAt) {
					aliases.set(task.alias, { id: subagentId, createdAt: task.createdAt });
				} else if (task.createdAt === previous.createdAt && subagentId !== previous.id) {
					// A timestamp tie has no authoritative latest target: do not guess.
					aliases.set(task.alias, { id: "", createdAt: task.createdAt });
				}
			}
		}

		const rosterById = new Map(roster.map((target) => [target.id, target]));
		for (const entry of pending) {
			if (entry.send) {
				// Match Send's caller-first alias lookup, and never allow a task pointer
				// to bypass the actual child/sibling roster authorization.
				let candidate = entry.selector;
				for (const owner of new Set([entry.callerId ?? teamParentId, teamParentId])) {
					candidate = resolveTaskAlias(owner, entry.selector);
					if (candidate !== entry.selector) break;
					candidate = sendTaskAliases.get(owner)?.get(entry.selector)?.id ?? entry.selector;
					if (candidate !== entry.selector) break;
				}
				const eligible = (target: (typeof roster)[number]) =>
					isSubagentVariant(target.variant ?? "") && target.id !== entry.callerId;
				const direct = rosterById.get(candidate);
				if (direct) {
					if (eligible(direct)) resolved.set(entry.toolUseId, direct.id);
					continue;
				}
				if (candidate !== entry.selector) continue;
				const matches = roster.filter(
					(target) => eligible(target) && subagentMatchesSelector(target, entry.selector),
				);
				if (matches.length === 1) resolved.set(entry.toolUseId, matches[0].id);
				continue;
			}
			// The registry maps an alias to a real id within this parent's session.
			const aliasCandidate = resolveTaskAlias(teamParentId, entry.selector);
			const hit =
				resolveAgainstRoster(aliasCandidate, roster, taskAliasToSubagentId) ??
				(aliasCandidate === entry.selector
					? undefined
					: resolveAgainstRoster(entry.selector, roster, taskAliasToSubagentId));
			if (hit) resolved.set(entry.toolUseId, hit);
		}
	} catch {
		// A navigation affordance must never fail a message load.
		return resolved;
	}
	return resolved;
}

/**
 * Resolve the pending Await-agent calls found in a batch of tool calls.
 *
 * The single entry point message-loading code needs: it derives the team scope
 * from the narrator ids that own the calls, so a page mixing a primary narrator's
 * messages with a subagent's still resolves each against the right roster.
 */
export async function resolveAwaitAgentIdsForToolCalls(
	toolCalls: readonly (AwaitAgentToolCallLike & { narratorId?: string })[],
): Promise<Map<string, string>> {
	const pending = collectPendingAwaitAgents(toolCalls);
	if (pending.length === 0) return new Map();

	const ownerByToolUseId = new Map<string, string>();
	for (const tc of toolCalls) {
		if (tc.toolUseId && tc.narratorId && !ownerByToolUseId.has(tc.toolUseId)) {
			ownerByToolUseId.set(tc.toolUseId, tc.narratorId);
		}
	}
	const ownerIds = [...new Set([...ownerByToolUseId.values()])];
	if (ownerIds.length === 0) return new Map();

	// A subagent's Await resolves against its PARENT's roster (its own siblings),
	// exactly as getCommunicationScope defines the team scope.
	//
	// ⚠️ "Is the caller a subagent" is decided by `variant`, NOT by the presence of
	// `parentNarratorId` — that is what `getCommunicationScope` (the authority the
	// Await tool itself runs through) does, and the two disagree for a real and
	// common shape: a FORKED primary narrator also carries a `parentNarratorId`
	// (the narrator it was forked from), while its own subagents are parented to
	// IT. Treating that parent link as "I am a subagent" pointed the lookup at the
	// fork source's roster, where the target does not exist.
	//
	// Measured on a real database: of 2082 Await-agent calls whose subagent id is
	// known from persisted metadata, this mistake alone lost 131 — a running Await
	// on a forked narrator's own child could never offer "open session". It fails
	// silently (a missing menu item), which is why it survived so long.
	const scopeByNarratorId = new Map<string, string>();
	try {
		const owners = await db.query.narrators.findMany({
			where: inArray(narrators.id, ownerIds),
			columns: { id: true, parentNarratorId: true, variant: true },
		});
		for (const owner of owners) {
			const isSubagent = isSubagentVariant(owner.variant ?? "");
			scopeByNarratorId.set(owner.id, isSubagent ? (owner.parentNarratorId ?? owner.id) : owner.id);
		}
	} catch {
		return new Map();
	}

	const byScope = new Map<string, PendingAwaitAgent[]>();
	for (const entry of pending) {
		const owner = ownerByToolUseId.get(entry.toolUseId);
		const scope = owner ? scopeByNarratorId.get(owner) : undefined;
		if (!scope) continue;
		const scopedEntry = entry.send ? { ...entry, callerId: owner } : entry;
		const bucket = byScope.get(scope);
		if (bucket) bucket.push(scopedEntry);
		else byScope.set(scope, [scopedEntry]);
	}

	const resolved = new Map<string, string>();
	for (const [scope, entries] of byScope) {
		const scopeResolved = await resolveAwaitAgentNarratorIds(scope, entries);
		for (const [toolUseId, subagentId] of scopeResolved) resolved.set(toolUseId, subagentId);
	}
	return resolved;
}
