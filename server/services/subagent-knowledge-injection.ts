/**
 * Passive knowledge injection for a SUBAGENT's incoming text (point A).
 *
 * ## Which halves of the asymmetry this closes
 *
 * Point B (scanning TOOL OUTPUT) lives in `loop.ts` and has always run for subagents.
 * Point A (scanning the text the agent was ASKED) was primary-only, and the registry
 * (`NON_SOURCE_ASYMMETRIES` / `knowledge-keyword-injection`) recorded that as half
 * essential, half gap. This module implements the gap half and deliberately not the
 * other:
 *
 *  - **Not scanned: a `Task`-dispatched subagent's initial prompt.** The parent wrote
 *    it, and the parent already ran its own point A over the user's words. Scanning it
 *    again would re-derive hits the parent's turn already surfaced.
 *  - **Scanned: text that arrives at a LIVE subagent** — typed by a user on the
 *    subagent's own page, or sent by the parent / a sibling through `Send`. Nobody has
 *    scanned that text, and it is where new terminology actually enters the session.
 *
 * ## Whose permissions resolve it (the ACL decision)
 *
 * Always the **acting human user of the agent chain**, resolved through
 * `resolveSubagentActingUserId` — never the sending agent, because an agent is not a
 * principal and holds no clearance of its own.
 *
 * An agent-to-agent message is scanned rather than skipped. The tempting argument for
 * skipping is that the sender was already scanned in its own turn, so a second scan is
 * redundant. That argument does not hold: the sender was scanned on the text it
 * RECEIVED, while what it WRITES is new prose that can name a term nobody has been
 * injected for yet (it may have learned the term from a tool output, or invented the
 * phrasing while summarizing). Skipping would make the injection depend on which
 * participant happened to type a keyword first.
 *
 * The safety property this rests on: resolving as the acting user cannot ESCALATE.
 * The parent narrator's own point A already ran under that exact identity, so a
 * subagent seeing the same entries is not a widening; and `resolveInjections` runs the
 * full dual-axis `canRead` filter, so the acting user's own clearance still bounds the
 * result. A relay through an agent grants nothing.
 *
 * When no acting user can be resolved at all (recovery paths, detached background
 * restarts, standalone runs that never had one), the answer is **no injection** —
 * `resolveCapsByUserId(null)` would fall back to the anonymous baseline, and quietly
 * publishing "public" knowledge into a session nobody is accountable for is a worse
 * default than the session simply not being helped. See `resolveInjectionUserId`.
 *
 * ## Cost
 *
 * Measured against a 300-entry / 600-keyword dictionary with the compiled-matcher cache
 * warm: ~0.26 ms for a miss and ~1.26 ms for a hit (which additionally reads bounded
 * snippets for the hits only). The candidate set is guarded by
 * `keywordInjectionCandidatesSignature`, a single indexed aggregate, so the 5000-row
 * read + trie rebuild does not recur per message. That is affordable per delivered
 * message and needs no separate throttle.
 */

import type { SideCarBody } from "@shared/sidecar-body";
import { resolveSubagentActingUserId } from "../lib/fast-mode";
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import type { Locale } from "../lib/prompt-i18n";
import { sideCarBodyWithText } from "../lib/sidecar-templates";
import { knowledgeInjection } from "./knowledge-injection";
import { knowledgeInjectionReads } from "./knowledge-service";
import { narratorService } from "./narrator-service";
import { activeNarrators } from "./narrator-session-state";

/**
 * Where a piece of incoming subagent text came from.
 *
 * Only used for logging and for the injected row's heading; the ACL identity is the
 * same acting user in every case, by the reasoning in the module doc.
 */
export type SubagentKnowledgeTextSource =
	/** Typed by a user on the subagent's own page, or queued for it by the parent's Send. */
	| "buffered_message"
	/** Delivered by a sibling through `Send` / `TeamStatus` broadcast. */
	| "team_message";

/**
 * De-dup set + ledger seq for one subagent's current compact cycle.
 *
 * The same contract the primary session keeps in `knowledgeInjectionCycleStates`: hits
 * are suppressed while they stay in `ids`, and crossing a compact boundary clears the
 * set so genuinely-relevant knowledge can be re-surfaced into the summarized context.
 */
export interface SubagentKnowledgeCycle {
	seq: number;
	ids: Set<string>;
}

/**
 * Cycle state keyed by subagent narrator id.
 *
 * Keyed rather than owned by the executor for the same reason the primary session keeps
 * a map: a subagent's turns are driven from several places (the executor's own pass
 * restart, the runner's post-interrupt drain, a `resumeSubagent` continuation that
 * re-enters `executeSubagent` entirely), and a set owned by one invocation would let the
 * next one re-inject everything the previous had already delivered. `hotSafe` keeps the
 * map identical across `--hot` reloads, so a reload mid-run does not reset de-dup.
 */
const cycles = hotSafe<Map<string, SubagentKnowledgeCycle>>(
	"narrafork.subagentKnowledgeInjectionCycles",
	() => new Map(),
);

/** The cycle for this subagent, created on first use. */
export function getSubagentKnowledgeCycle(narratorId: string): SubagentKnowledgeCycle {
	const existing = cycles.get(narratorId);
	if (existing) return existing;
	const fresh: SubagentKnowledgeCycle = { seq: Number.NaN, ids: new Set<string>() };
	cycles.set(narratorId, fresh);
	return fresh;
}

/**
 * Drop a finished subagent's cycle.
 *
 * Called when the run reaches a terminal state. Losing the set is harmless for
 * correctness (the ledger is the durable record and is reloaded on the next sync); this
 * only stops the map from growing for the lifetime of the process.
 */
export function clearSubagentKnowledgeCycle(narratorId: string): void {
	cycles.delete(narratorId);
}

/**
 * Re-align the cycle with the narrator's latest compact seq.
 *
 * Mirrors the primary loop: on a boundary change the in-memory set is rebuilt from the
 * ledger rather than merely cleared, so entries already injected into THIS cycle by a
 * previous pass (or by point B) are not injected a second time.
 *
 * Failure is swallowed to a warning: losing de-dup state degrades to a repeated hint,
 * whereas throwing here would fail the subagent's whole pass.
 */
export async function syncSubagentKnowledgeCycle(
	narratorId: string,
	cycle: SubagentKnowledgeCycle,
): Promise<number> {
	let seq = -1;
	try {
		seq = (await narratorService.getLatestCompactSeq(narratorId)) ?? -1;
	} catch (err) {
		logger.warn("Failed to read compact seq for subagent knowledge cycle", {
			narratorId,
			error: String(err),
		});
		return Number.isNaN(cycle.seq) ? -1 : cycle.seq;
	}
	if (seq === cycle.seq) return seq;
	try {
		// Preserve both cached fields until the whole read succeeds. A failure must
		// not mark this compact boundary synced and suppress the next retry.
		const persistedIds = await knowledgeInjectionReads.listInjectedEntryIds(narratorId, seq);
		cycle.ids.clear();
		for (const id of persistedIds) {
			cycle.ids.add(id);
		}
		cycle.seq = seq;
	} catch (err) {
		logger.warn("Failed to reload injected knowledge ids for subagent", {
			narratorId,
			error: String(err),
		});
	}
	return seq;
}

/**
 * The user whose clearance resolves a subagent's knowledge injection, or null when
 * there is none and nothing may be injected.
 *
 * Reuses `resolveSubagentActingUserId` rather than restating the fallback: a subagent
 * has no user of its own, and the existing decision (turn user, else the parent
 * session's current user) is the one every other identity-sensitive subagent concern —
 * fast mode, trait layering, device authorization — already follows. Diverging here
 * would mean a subagent resolved knowledge as one person and its device access as
 * another.
 *
 * Returning null is load-bearing: callers must skip injection entirely rather than
 * passing null down, because `resolveInjections(null, …)` is a legitimate ANONYMOUS
 * read (public entries) rather than a no-op.
 */
export function resolveInjectionUserId(
	turnUserId: string | null | undefined,
	parentNarratorId: string,
): string | null {
	// null is a frozen anonymous execution, not permission to impersonate a later parent.
	if (turnUserId !== undefined) return turnUserId;
	const parentUserId = activeNarrators.get(parentNarratorId)?._currentUserId;
	return resolveSubagentActingUserId(undefined, parentUserId);
}

/** The heading each source contributes to the injected hint. */
const HEADINGS: Record<SubagentKnowledgeTextSource, string> = {
	buffered_message: "Relevant knowledge-base entries were found for this request:",
	team_message: "Relevant knowledge-base entries were found for this incoming message:",
};

export interface SubagentKnowledgeScanInput {
	narratorId: string;
	parentNarratorId: string;
	/** The incoming text to scan. */
	text: string;
	source: SubagentKnowledgeTextSource;
	/** Acting user for the turn that carries this text, if it had one. */
	turnUserId: string | null | undefined;
	projectId?: string | null;
	cycle: SubagentKnowledgeCycle;
	locale: Locale;
}

export interface SubagentKnowledgeScanResult {
	/** Model-facing text to fold into the turn. */
	content: string;
	body: SideCarBody;
	/** Ledger payload; recorded by the caller only once the row is durable. */
	record: {
		narratorId: string;
		compactSeq: number;
		hits: Array<{ entryId: string; entryRevisionId?: string | null; summary?: string | null }>;
	};
}

/**
 * Scan one piece of incoming subagent text for relevant knowledge.
 *
 * Returns null when there is nothing to say — no acting user, injection disabled, no
 * keyword hit, or every hit already injected this cycle. The de-dup set is updated here
 * (so two messages drained at the same boundary cannot both carry the same entry) while
 * the DURABLE ledger write is left to the caller: the record must not be persisted
 * before the row exists, or a compact reload would treat an entry the model never saw as
 * already delivered and suppress it for good.
 *
 * Never throws. A failed scan must cost the subagent a hint, not its turn.
 */
export async function scanSubagentTextForKnowledge(
	input: SubagentKnowledgeScanInput,
): Promise<SubagentKnowledgeScanResult | null> {
	const { narratorId, parentNarratorId, text, source, cycle, locale } = input;
	if (!text.trim()) return null;

	// No accountable human → no injection (see `resolveInjectionUserId`).
	const userId = resolveInjectionUserId(input.turnUserId, parentNarratorId);
	if (!userId) {
		logger.debug("Skipping subagent knowledge injection: no acting user", {
			narratorId,
			source,
		});
		return null;
	}

	try {
		const compactSeq = await syncSubagentKnowledgeCycle(narratorId, cycle);
		const hits = await knowledgeInjection.resolveInjections(userId, text, {
			already: cycle.ids,
			projectId: input.projectId ?? undefined,
		});
		if (hits.length === 0) return null;
		for (const hit of hits) cycle.ids.add(hit.entryId);

		// Only the BODY is taken from the shared template: its rendered text carries point
		// B's "based on the latest tool output" heading, which would misdescribe an incoming
		// message. The model-facing text is built below with this point's own heading.
		const { body } = sideCarBodyWithText(
			"knowledge_base_hint",
			{
				kind: "knowledge",
				hits: hits.map((hit) => ({
					entryId: hit.entryId,
					title: hit.title,
					summary: hit.summary,
				})),
			},
			locale,
		);
		return {
			// The side-car text renders the tool-output heading; this point is about the
			// incoming request, so the heading is replaced with the source's own.
			content: knowledgeInjection.formatInjectionsBare(hits, HEADINGS[source]),
			body,
			record: { narratorId, compactSeq, hits },
		};
	} catch (err) {
		logger.warn("Knowledge injection (subagent incoming text) failed", {
			narratorId,
			source,
			error: String(err),
		});
		return null;
	}
}

export const subagentKnowledgeInjection = {
	getSubagentKnowledgeCycle,
	clearSubagentKnowledgeCycle,
	syncSubagentKnowledgeCycle,
	resolveInjectionUserId,
	scanSubagentTextForKnowledge,
};
