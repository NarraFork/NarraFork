/**
 * subagent-label.ts — the ONE rule turning a subagent narrator id into the
 * human/model-facing label that Await, Send, Agent and TeamStatus print.
 *
 * WHY THIS EXISTS
 * Aliases already existed (`subagent-alias.ts` slugifies a subagent's
 * description into `run-tests` and persists it on `narrators.traits` /
 * `background_tasks.alias`), but only ONE call site used them: the Agent tool
 * rewrote its own `<subagent_id>` tag. Every other outlet — Await wording, Send
 * delivery notes, background-completion notifications, the detach handoff, the
 * TeamStatus listing — printed the raw 21-char nanoid. The model therefore only
 * ever learned the nanoid and kept addressing agents by it, and a reader saw
 * `Await agent: UscgG1vLFnxzyKyaUOIfR`.
 *
 * The alias registry is keyed by PARENT narrator id (see `subagent-alias.ts`),
 * so every lookup here takes the parent/team scope, never the caller. A subagent
 * asking for a sibling's label passes the shared parent and hits the same entry
 * the parent registered.
 *
 * Resolution order (both functions):
 *   1. in-memory registry for the scope        — same-session, no I/O
 *   2. `subagent-alias:` trait on the narrator — survives restarts
 *   3. slugified narrator title                — always readable
 *   4. `background_tasks.alias` (async only)   — background rows launched with one
 *   5. first 8 chars of the id                 — last resort, still shorter
 */

import { eq } from "drizzle-orm";
import {
	getPersistedSubagentAliases,
	getTaskAlias,
	shortAgentId,
	slugifyTaskAlias,
} from "./subagent-alias";

// Re-exported so callers can reach the shortened-id fallback through this module,
// which is the one they already import for labels.
export { shortAgentId };

/** Bounded memo so a polling Await does not re-query on every wait. */
const LABEL_MEMO_TTL_MS = 30_000;
const LABEL_MEMO_MAX_ENTRIES = 500;

interface MemoEntry {
	label: string;
	expiresAt: number;
}

let _labelMemo: Map<string, MemoEntry> | undefined;
function getLabelMemo(): Map<string, MemoEntry> {
	if (!_labelMemo) _labelMemo = new Map();
	return _labelMemo;
}

function memoKey(scopeNarratorId: string, subagentId: string): string {
	return `${scopeNarratorId}\u0000${subagentId}`;
}

function readMemo(key: string): string | undefined {
	const memo = getLabelMemo();
	const entry = memo.get(key);
	if (!entry) return undefined;
	if (entry.expiresAt <= Date.now()) {
		memo.delete(key);
		return undefined;
	}
	// Re-insert to move the entry to the back: eviction below takes the front, so
	// without this a hot key inserted long ago would be evicted while colder but
	// newer keys survive — the opposite of what the cap is for.
	memo.delete(key);
	memo.set(key, entry);
	return entry.label;
}

function writeMemo(key: string, label: string): void {
	const memo = getLabelMemo();
	// Evict the least-recently-USED entry once the cap is reached. Map preserves
	// insertion order and every read re-inserts, so the first key is the coldest.
	// An overwrite must also re-insert, hence the unconditional delete below.
	memo.delete(key);
	if (memo.size >= LABEL_MEMO_MAX_ENTRIES) {
		const coldest = memo.keys().next();
		if (!coldest.done) memo.delete(coldest.value);
	}
	memo.set(key, { label, expiresAt: Date.now() + LABEL_MEMO_TTL_MS });
}

/** Drop memoized labels (test hook; also used when an alias is re-registered). */
export function clearAgentLabelMemo(): void {
	getLabelMemo().clear();
}

/** The narrator fields a label can be derived from without any I/O. */
export interface AgentLabelSource {
	id: string;
	title?: string | null;
	traits?: unknown;
}

/**
 * Label for a narrator row already in hand — the common case, and the reason
 * this is synchronous: `withSenderPrefix` and the Send delivery notes run inside
 * synchronous formatting code that must not become async just to read an alias.
 */
export function agentLabelFromNarrator(
	narrator: AgentLabelSource,
	scopeNarratorId?: string,
): string {
	if (scopeNarratorId) {
		const registered = getTaskAlias(scopeNarratorId, narrator.id);
		if (registered) return registered;
	}
	const persisted = getPersistedSubagentAliases(narrator.traits)[0];
	if (persisted) return persisted;
	const titleAlias = narrator.title ? slugifyTaskAlias(narrator.title) : "";
	if (titleAlias) return titleAlias;
	return shortAgentId(narrator.id);
}

async function loadLabelSources(subagentId: string): Promise<{
	narrator: AgentLabelSource | null;
	taskAlias: string | null;
}> {
	const [{ db }, schema] = await Promise.all([import("../db"), import("../db/schema")]);
	const narrator = await db.query.narrators
		.findFirst({
			where: eq(schema.narrators.id, subagentId),
			columns: { id: true, title: true, traits: true },
		})
		.catch(() => undefined);
	if (narrator) {
		const fromNarrator = agentLabelFromNarrator(narrator);
		// A trait/title alias is already authoritative; skip the second query.
		if (fromNarrator !== shortAgentId(subagentId)) {
			return { narrator, taskAlias: null };
		}
	}
	// An agent background task row shares the subagent's id (see createAgentTask).
	const task = await db.query.backgroundTasks
		.findFirst({
			where: eq(schema.backgroundTasks.id, subagentId),
			columns: { alias: true },
		})
		.catch(() => undefined);
	return { narrator: narrator ?? null, taskAlias: task?.alias ?? null };
}

/**
 * The `<subagent_id>` addressing prefix a subagent result carries.
 *
 * The tag is part of the model-visible output string, so it holds the readable
 * label. The frontend does NOT depend on it for navigation: Agent/Task cards read
 * `_subagentActivity.subagentNarratorId` (a join on `parentToolUseId`) and Await
 * cards read `metadata.subagentId`; the tag is only their last-resort fallback,
 * and it stays a valid selector either way.
 */
export function agentResultTag(label: string): string {
	return `<subagent_id>${label}</subagent_id>\n\n`;
}

/**
 * Label for a subagent when only its id is known (Await results, background
 * completion notifications, TeamStatus file_changes). Queries at most two
 * single-row primary-key lookups and memoizes STABLE outcomes briefly.
 *
 * Only alias-derived labels are cached. A title-slug label must not be, because a
 * title is mutable (`PATCH /narrators/:id/title`, and chapter title sync): a
 * renamed subagent would keep being printed under its old slug, and that slug no
 * longer matches anything — so the model would be handed a selector that resolves
 * to "No accessible subagent found". Aliases live in traits / `background_tasks`
 * and are never rewritten in place, so caching them is safe.
 */
export async function resolveAgentLabel(
	scopeNarratorId: string,
	subagentId: string,
): Promise<string> {
	if (!subagentId) return "";
	const registered = getTaskAlias(scopeNarratorId, subagentId);
	if (registered) return registered;

	const key = memoKey(scopeNarratorId, subagentId);
	const memoized = readMemo(key);
	if (memoized) return memoized;

	const short = shortAgentId(subagentId);
	let label = short;
	// Tracks whether the label came from a stable source (alias) or a mutable one
	// (title). Only the former may be memoized.
	let stable = true;
	try {
		const { narrator, taskAlias } = await loadLabelSources(subagentId);
		if (narrator) {
			const persisted = getPersistedSubagentAliases(narrator.traits)[0];
			if (persisted) {
				label = persisted;
			} else if (narrator.title) {
				const titleAlias = slugifyTaskAlias(narrator.title);
				if (titleAlias) {
					label = titleAlias;
					stable = false;
				}
			}
		}
		if (label === short && taskAlias) label = taskAlias;
	} catch {
		// A label is cosmetic; never fail a tool result over it.
	}
	if (stable) writeMemo(key, label);
	return label;
}
