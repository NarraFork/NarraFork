/**
 * Shared continuation vocabulary and executable recovery precedence.
 *
 * P3 has one outer loop in agent-runtime/orchestrator.ts. The legacy audience
 * metadata and marker utilities below remain for diagnostics, not as proof of
 * execution. selectPassRecoverySource is consumed by the real transition executor;
 * behavioral orchestrator tests, rather than markers in two files, enforce parity.
 */
import type { ExecuteLoopResult } from "./narrator-executor";

export type PassRecoverySource =
	| "abort-before-recovery"
	| "payment-required"
	| "model-unavailable"
	| "context-overflow"
	| "transient-error"
	| "silent-disconnect"
	| "completed";

/** No variant argument: identity cannot silently select a different recovery order. */
export function selectPassRecoverySource(
	result: ExecuteLoopResult,
	control: { aborted: boolean; planApproved: boolean },
): PassRecoverySource {
	if ((control.aborted || result.aborted) && !control.planApproved) return "abort-before-recovery";
	if (result.paymentRequired) return "payment-required";
	if (result.modelUnavailable) return "model-unavailable";
	if (result.contextLengthExceeded) return "context-overflow";
	if (result.retryableError) return "transient-error";
	if (result.silentDisconnect) return "silent-disconnect";
	return "completed";
}

/** Which loop is consuming the registry. */
export type ContinuationAudience = "primary" | "subagent";

export const CONTINUATION_AUDIENCES: readonly ContinuationAudience[] = ["primary", "subagent"];

/**
 * What a source does to the pass that follows it.
 *
 * Recorded because it is the property that makes ordering reviewable: a `terminal`
 * source placed after an `inject` source can never fire, and two `inject` sources in
 * the wrong order change which text the model sees first (the causality-inversion bug
 * that `parent-injection-queue` was built to fix).
 */
export type ContinuationOutcome =
	/** Performs bounded work without itself deciding whether another pass is needed. */
	| "effect"
	/** Ends the run. No further pass. */
	| "terminal"
	/** Re-sends the same turn (rebuilt history, no new user-visible content). */
	| "replay"
	/** Persists new model-facing content, then drives a pass for it. */
	| "inject"
	/** Waits for an external condition, then replays. */
	| "suspend";

/** What one audience does about one source. */
export type ContinuationDisposition =
	/** This audience implements the source; the loop body carries its marker. */
	| { kind: "handled" }
	/**
	 * This audience implements the source, but the work lands at ANOTHER source's
	 * boundary rather than in a branch of its own — so there is no marker to carry.
	 *
	 * Distinct from `handled` because the marker check is the registry's teeth: a
	 * `handled` claim with no marker is exactly the "declared but never wired" defect the
	 * consistency test hunts for. Claiming `handled` here would have meant loosening that
	 * check for everybody in order to describe one source honestly.
	 *
	 * `via` names the carrying source and must itself be `handled` by this audience,
	 * which is verified — otherwise this becomes a way to point at nothing. Real case:
	 * permission feedback for a subagent is queued by `bufferSubagentUserMessage`, so it
	 * is consumed at the `buffered-message` boundary the loop already has.
	 */
	| { kind: "handledVia"; via: string; reason: string }
	/**
	 * This audience deliberately does not implement the source.
	 *
	 * `reason` is required: an unexplained gap is indistinguishable from the bug this
	 * whole file exists to prevent, and the reason is what a later reader needs in order
	 * to decide whether it is still true.
	 */
	| { kind: "notApplicable"; reason: string }
	/**
	 * This audience SHOULD implement the source but does not yet.
	 *
	 * Distinct from `notApplicable` on purpose. Collapsing the two is how a real gap
	 * disappears: "the subagent doesn't do this" reads identically whether somebody
	 * decided it or nobody noticed. A `gap` is a claim that the asymmetry is a defect,
	 * and the consistency test treats it accordingly — it must NOT carry an in-loop
	 * marker, so converting one to `handled` is a deliberate, visible edit.
	 */
	| { kind: "gap"; reason: string };

export interface ContinuationSource {
	/** Stable id used by the in-loop markers. */
	id: string;
	/** One line on what condition this source reacts to. */
	summary: string;
	outcome: ContinuationOutcome;
	/**
	 * Why this source sits where it does, when its position is load-bearing.
	 *
	 * Absent when the position carries no meaning beyond "somewhere in this group".
	 */
	orderRationale?: string;
	/**
	 * Sources whose relative order carries no meaning, because their trigger conditions
	 * are mutually exclusive.
	 *
	 * `executeAgentLoop` breaks out of its event drain on the FIRST terminal signal it
	 * sees, so at most one of `contextLengthExceeded` / `modelUnavailable` can be set on a
	 * given result. The two loops happen to test them in opposite orders, and no behaviour
	 * depends on which — declaring that is more honest than picking one order and
	 * reshuffling a working loop body to match it.
	 *
	 * Only sources that are genuinely unreachable together may share a group. Everything
	 * else is strictly ordered, which is the point of the registry.
	 */
	mutexGroup?: string;
	dispositions: Record<ContinuationAudience, ContinuationDisposition>;
}

const handled: ContinuationDisposition = { kind: "handled" };

const na = (reason: string): ContinuationDisposition => ({ kind: "notApplicable", reason });

/**
 * Currently unused, and kept deliberately.
 *
 * Every known gap has been closed, so nothing constructs one today. Deleting it would
 * mean the next person to find a one-sided defect has to re-derive the distinction
 * between "nobody noticed" and "decided against" — which is the exact conflation this
 * file was written to prevent. The type variant stays for the same reason.
 */
// biome-ignore lint/correctness/noUnusedVariables: retained as the vocabulary for the next gap found; see above.
const gap = (reason: string): ContinuationDisposition => ({ kind: "gap", reason });

const handledVia = (via: string, reason: string): ContinuationDisposition => ({
	kind: "handledVia",
	via,
	reason,
});

/**
 * Every continuation source, in the order the loops consult them.
 *
 * ⚠️ The array order IS the semantics. Reordering entries here without reordering the
 * loop bodies makes the consistency test fail, which is the intended outcome: the order
 * was arrived at by fixing real bugs, and several adjacent pairs are load-bearing (see
 * `orderRationale`).
 */
export const CONTINUATION_SOURCES: readonly ContinuationSource[] = [
	{
		id: "abort-before-recovery",
		summary: "The user aborted; finalize the interrupted run before any recovery branch.",
		outcome: "terminal",
		orderRationale:
			"First, because every recovery branch below would otherwise spend a backoff sleep or " +
			"a rebuilt request on a run the user already stopped.",
		dispositions: {
			primary: handled,
			subagent: handled,
		},
	},
	{
		id: "payment-required",
		summary: "The provider refused the request because the balance is exhausted.",
		outcome: "terminal",
		orderRationale:
			"Ahead of the retry family: no amount of retrying or history rebuilding changes an " +
			"exhausted balance, and `paymentRequired` sets none of the other result flags, so a " +
			"later branch would read the pass as an ordinary empty completion.",
		dispositions: {
			primary: handled,
			subagent: handled,
		},
	},
	{
		id: "context-overflow",
		summary: "The request was rejected as too long; prune or compact, then retry.",
		outcome: "replay",
		mutexGroup: "request-refused",
		dispositions: {
			primary: handled,
			subagent: handled,
		},
	},
	{
		id: "model-unavailable",
		summary:
			"The provider is blocked but self-recovering: NUG credential pool disabled, or Kimi quota exhausted. Park on the availability poller or the published reset instant.",
		outcome: "suspend",
		mutexGroup: "request-refused",
		dispositions: {
			primary: handled,
			subagent: handled,
		},
	},
	{
		id: "transient-error",
		summary: "A transient API error survived the in-loop retries.",
		outcome: "replay",
		orderRationale:
			"Before `silent-disconnect`, and both before the success reset, because they share " +
			"one retry counter.",
		dispositions: {
			primary: handled,
			subagent: handled,
		},
	},
	{
		id: "silent-disconnect",
		summary: "The upstream socket closed quietly, yielding neither answer nor error.",
		outcome: "replay",
		orderRationale:
			"Must precede the transient-counter reset: resetting first would zero the counter " +
			"every pass and turn the bounded retry into an unbounded reconnect loop.",
		dispositions: {
			primary: handled,
			subagent: handled,
		},
	},
	{
		id: "max-turns-spec-continuation",
		summary: "The pass exhausted its turn budget while the Dynamic Spec still has open work.",
		outcome: "inject",
		orderRationale:
			"Before the generic `hasError` branch: max-turns marks the result as an error, so a " +
			"continuation attempt has to come first or the run ends instead.",
		dispositions: {
			primary: handled,
			// Closed. The earlier `gap` entry claimed the primary bound could not be lifted
			// because `computeContinuationStallState`'s counters "live on ActiveNarrator".
			// Half right: the STORAGE lived there, the RULE is a pure function of
			// (kind, result, previousState). It now sits in `turn-continuation-decisions.ts`
			// and the subagent supplies run-local storage — a tighter scope than the
			// primary's, since a subagent's run is exactly the window the bound should cover.
			//
			// The other half of that warning was correct and is preserved by
			// `planSubagentContinuation`: each continuation pass gets a FRESH turn budget, so
			// the bound cannot come from turn counts. It comes from the stall rule plus a
			// per-run pass cap, and exceeding either ends the run with a stated reason
			// instead of holding the parent's tool call open.
			subagent: handled,
		},
	},
	{
		id: "interruption-continuation",
		summary: "The provider truncated its output (completion limit) or failed after partial output.",
		outcome: "inject",
		orderRationale:
			"After the error branches (those own their own terminal handling) and before every " +
			"queue drain, because the model's own turn is unfinished and resuming it must not be " +
			"reordered behind newly arrived input.",
		dispositions: {
			primary: handled,
			subagent: handled,
		},
	},
	{
		id: "plan-approved",
		summary: "A plan was approved, so drive the execution turn it authorizes.",
		outcome: "inject",
		dispositions: {
			primary: handled,
			subagent: na(
				"Plan mode is a primary-narrator product feature: a plan is written for a human to " +
					"approve. A `plan` subagent produces a plan document as its result and returns it " +
					"to its parent; it never holds an approval gate of its own.",
			),
		},
	},
	{
		id: "permission-feedback",
		summary: "The approver typed text alongside a permission decision; deliver it as a turn.",
		outcome: "inject",
		orderRationale:
			"Deliberately ahead of the idle/unread transition so approving-with-text lands " +
			"immediately after the tool completes rather than after the whole turn.",
		dispositions: {
			primary: handled,
			// Closed. This WAS a real gap: a subagent's tool calls go through the same
			// `handlePermission`, so a user could approve one with attached text and that text
			// was silently dropped — both the payload and the soft-stop flag were keyed through
			// `activeNarrators`, which a subagent has no entry in.
			//
			subagent: handledVia(
				"buffered-message",
				"A subagent reaches the same two effects through its own plumbing rather than the " +
					"primary's: `deliverSubagentPermissionFeedback` routes the text through " +
					'`bufferSubagentUserMessage`, which both queues it as a `role: "user"` turn and ' +
					"arms the soft stop the loop already reads via " +
					"`shouldStopSubagentForBufferedMessage`. It is therefore consumed at the " +
					"buffered-message boundary, and a marker of its own would name a branch that " +
					"does not exist.",
			),
		},
	},
	{
		id: "review-git-guard",
		summary: "A review narrator modified files; reset the worktree and tell it to continue.",
		outcome: "inject",
		dispositions: {
			primary: handled,
			subagent: na(
				"The guard resets a review CHAPTER's git state and concludes the review through " +
					"review-service. A review subagent has no chapter of its own to reset and does not " +
					"own a review record; its read-only tool filter is what keeps it from writing.",
			),
		},
	},
	{
		id: "post-turn-compact",
		summary: "Context (or pruned ratio) crossed its threshold; start a background compact.",
		outcome: "effect",
		orderRationale:
			"Runs after the turn is accounted for and before the queue drains, so a compact " +
			"triggered here lands on the history the NEXT pass rebuilds rather than racing the " +
			"pass that is about to be started.",
		dispositions: { primary: handled, subagent: handled },
	},
	{
		id: "injection-drain",
		summary: "Background completions and inbound messages queued during the turn.",
		outcome: "inject",
		orderRationale:
			"Ahead of the buffered-message consumer: without it, a message that arrived at this " +
			"exact moment waited for the next wake.",
		dispositions: { primary: handled, subagent: handled },
	},
	{
		id: "buffered-message",
		summary: "A queued user message is consumed as the next turn.",
		outcome: "inject",
		dispositions: {
			primary: handled,
			subagent: handled,
		},
	},
	{
		id: "queued-command",
		summary: "A queued `/new` or `/goal` slash command taken from the buffer.",
		outcome: "inject",
		orderRationale: "Recognized while consuming the buffer, so it is part of that step.",
		dispositions: {
			primary: handled,
			subagent: na(
				"`/new` creates a sibling narrator and `/goal` appends a protected task to a " +
					"long-lived session's spec — both are primary-narrator session commands. A " +
					"subagent's queue carries plain text only.",
			),
		},
	},
	{
		id: "soft-stop-recovery",
		summary:
			"The pass stopped early for a cut-in message that was then cancelled; resume the turn.",
		outcome: "replay",
		orderRationale:
			"Immediately after the buffer consumer, because it is precisely the case where that " +
			"consumer found nothing: settling idle here would look like the narrator stopping on " +
			"its own right after a tool call.",
		dispositions: { primary: handled, subagent: handled },
	},
	{
		id: "spec-continuation",
		summary: "spec://tasks.json still has a doing/blocked task, so drive another turn.",
		outcome: "inject",
		orderRationale:
			"Last among the content sources: real input (queued messages, injections) always " +
			"outranks the loop's own self-continuation.",
		dispositions: {
			primary: handled,
			// Was the starkest asymmetry on the list: a subagent DOES receive the Dynamic
			// Spec digest (`getAfterToolsInjections` builds it on a cadence), so it was told
			// about its open tasks and then nothing closed the loop — the reminder went out
			// and the run ended with the task still `doing`.
			//
			// Now closed by `planSubagentContinuation` + `maybeContinueForSpec`. Of the three
			// dependencies the old `gap` cited, only one was real:
			//
			//   - stall counters on `ActiveNarrator` — storage, not rule. The rule is pure and
			//     is now shared; the subagent keeps the counters in its run.
			//   - `continuationStartLock` and the persisted `idle` status — these belong to
			//     the primary's WAKE path (`startSpecContinuationIfPossible` reviving a
			//     sleeping session from a route). A subagent decides inside its own run's
			//     end-of-pass, with no cross-process wake to serialize and no idle row to
			//     race, so neither is needed here.
			//
			// The genuine risk the gap named — an unbounded self-continuation holding the
			// parent's tool call open — is what the per-run pass cap addresses; the stall rule
			// alone would not, since it only counts CONSECUTIVE no-progress passes.
			subagent: handled,
		},
	},
	{
		id: "pre-idle-injection-drain",
		summary: "Second drain, immediately before flipping the persisted status to idle.",
		outcome: "inject",
		orderRationale:
			"Deliberately duplicated at the very end: it closes the window where the row already " +
			"reads `idle` (visible to clients and to route admission) while this loop is still " +
			"running and about to pick up more work.",
		dispositions: { primary: handled, subagent: handled },
	},
	{
		id: "compact-restart",
		summary: "A background compact landed after the pass returned; restart on fresh history.",
		outcome: "replay",
		orderRationale:
			"Last: it is the fallback for a compact that finished too late for the in-loop " +
			"`onBeforeTurn` rebuild, so every source that could end the run legitimately gets " +
			"to decide first.",
		dispositions: { primary: handled, subagent: handled },
	},
] as const;

/**
 * Asymmetries between the two loops that are NOT end-of-pass continuation sources.
 *
 * They belong beside the registry because they were found by the same audit and are
 * misread the same way (as oversights), but they are mid-turn or config-level concerns, so
 * they carry no in-loop marker and the sequence checker does not see them. Recorded as data
 * rather than prose so a reader auditing the two loops finds the verdicts in one place.
 */
export const NON_SOURCE_ASYMMETRIES: readonly {
	id: string;
	summary: string;
	verdict: "resolved" | "essential" | "gap";
	detail: string;
}[] = [
	{
		id: "defer-eager-tools-for-safe-stop",
		summary: "`deferEagerToolsForSafeStop` is set by the subagent loop only.",
		verdict: "essential",
		detail:
			"Not a gap. The flag disables streaming-time eager tool execution, which is a real " +
			"throughput cost, and the primary loop does not need it: both eager-start sites are " +
			"already gated on `observeSoftStopForTurn()`, so a cut-in stops the turn at the right " +
			"boundary either way. `loop-cutin-boundary.test.ts` pins exactly this — the same " +
			"scenario produces identical executed/skipped sets with and without the flag. Setting " +
			"it for the primary would cost parallel-tool latency and buy nothing. The subagent " +
			"keeps it because it is the stricter guarantee and a subagent's turns are short.",
	},
	{
		id: "knowledge-keyword-injection",
		summary:
			"Passive knowledge injection at the incoming-text point now runs for both loops; " +
			"a Task-dispatched subagent's initial prompt is deliberately still not scanned.",
		verdict: "resolved",
		detail:
			"The gap half is closed and the essential half is kept — the two must not be " +
			"conflated. Point B (scanning TOOL OUTPUT) always ran for subagents via `loop.ts`. " +
			"Point A (scanning INCOMING text) now runs for a subagent too, in " +
			"`subagent-knowledge-injection.ts`, at the three places new text actually reaches a " +
			"live subagent: the in-pass buffered drain, the sibling `Send` inbox, and the " +
			"pass-restart drain in `consumeNextBufferedSubagentMessage`. The subagent's config " +
			"also passes `knowledgeInjectedEntryIds` + `knowledgeInjectionCompactSeq`, so the two " +
			"points de-dup against each other and the ledger is keyed by the real compact cycle " +
			"rather than -1. STILL NOT SCANNED, on purpose: a `Task`-dispatched subagent's " +
			"initial prompt, because the parent wrote it and had already run its own point A over " +
			"the user's words — scanning it again would re-derive hits that turn surfaced. The ACL " +
			"question this was blocked on is decided: the injection resolves as the acting HUMAN " +
			"of the chain (`resolveSubagentActingUserId`, the same fallback fast mode and trait " +
			"layering use), never as the sending agent, and when no acting user can be resolved " +
			"nothing is injected rather than falling back to the anonymous public baseline. An " +
			"agent-to-agent message IS scanned: the sender was scanned on the text it RECEIVED, " +
			"while what it WRITES is new prose that can name a term nobody was injected for.",
	},
] as const;

/** Every source id, in registry order. */
export function listContinuationSourceIds(): string[] {
	return CONTINUATION_SOURCES.map((source) => source.id);
}

/**
 * The sources one audience implements, in registry order.
 *
 * This is the "subset subscription" the two loops share: neither audience gets its own
 * ordering, only its own subset of one ordering.
 */
export function listContinuationSources(audience: ContinuationAudience): ContinuationSource[] {
	return CONTINUATION_SOURCES.filter(
		(source) => source.dispositions[audience].kind === "handled",
	) as ContinuationSource[];
}

/** The ids one audience implements, in registry order. */
export function listHandledContinuationSourceIds(audience: ContinuationAudience): string[] {
	return listContinuationSources(audience).map((source) => source.id);
}

/** Look up one source by id. */
export function getContinuationSource(id: string): ContinuationSource | undefined {
	return CONTINUATION_SOURCES.find((source) => source.id === id);
}

/** One audience's disposition for one source, or undefined when the id is unknown. */
export function describeDisposition(
	id: string,
	audience: ContinuationAudience,
): ContinuationDisposition | undefined {
	return getContinuationSource(id)?.dispositions[audience];
}

/**
 * Whether `audience` carries an in-loop branch for `id`. Unknown ids are handled by
 * nobody.
 *
 * `handledVia` is deliberately false here: the question this answers is "does this
 * audience's loop body carry a marker for this source", and the marker check depends on
 * that being exact. Use `isImplementedBy` for "does the work happen at all".
 */
export function isHandledBy(id: string, audience: ContinuationAudience): boolean {
	return describeDisposition(id, audience)?.kind === "handled";
}

/**
 * Whether the work happens for `audience` at all, in its own branch or at another
 * source's boundary.
 *
 * The distinction matters to different readers: someone auditing the loop body wants
 * `isHandledBy`, while someone asking "does a subagent act on permission feedback"
 * wants this.
 */
export function isImplementedBy(id: string, audience: ContinuationAudience): boolean {
	const kind = describeDisposition(id, audience)?.kind;
	return kind === "handled" || kind === "handledVia";
}

/**
 * Every `handledVia` whose `via` does not name a source this audience actually handles
 * in its own branch.
 *
 * A dangling `via` would turn the honest "no marker, carried elsewhere" escape hatch
 * into a way to claim a source is implemented while pointing at nothing.
 */
export function findDanglingHandledVia(): Array<{
	id: string;
	audience: ContinuationAudience;
	via: string;
}> {
	const dangling: Array<{ id: string; audience: ContinuationAudience; via: string }> = [];
	for (const source of CONTINUATION_SOURCES) {
		for (const audience of CONTINUATION_AUDIENCES) {
			const disposition = source.dispositions[audience];
			if (disposition.kind !== "handledVia") continue;
			if (!isHandledBy(disposition.via, audience)) {
				dangling.push({ id: source.id, audience, via: disposition.via });
			}
		}
	}
	return dangling;
}

/**
 * Registry order as a lookup, for asserting relative order without hard-coding indices.
 *
 * Returns -1 for unknown ids so a caller comparing positions treats them as "before
 * everything", which surfaces as an obvious failure rather than a silent pass.
 */
export function continuationSourceIndex(id: string): number {
	return CONTINUATION_SOURCES.findIndex((source) => source.id === id);
}

/**
 * Whether two ids may legitimately appear in either order.
 *
 * True only when both belong to the same declared `mutexGroup` — i.e. their triggers
 * cannot both be set on one result, so no behaviour can depend on which is tested first.
 */
export function isOrderInterchangeable(a: string, b: string): boolean {
	if (a === b) return true;
	const groupA = getContinuationSource(a)?.mutexGroup;
	const groupB = getContinuationSource(b)?.mutexGroup;
	return groupA !== undefined && groupA === groupB;
}

/**
 * Check an observed marker sequence against the registry for one audience.
 *
 * This is the drift detector's core, kept here (rather than inline in the test) so the
 * rule lives beside the declaration it enforces.
 *
 * Reported problems:
 *  - `unknown`      — a marker naming no registered source (typo, or a source someone
 *                     added to a loop body without declaring)
 *  - `notDeclared`  — a marker for a source this audience declared `notApplicable`/`gap`
 *  - `missing`      — a source declared `handled` with no marker in the loop body
 *  - `outOfOrder`   — two markers whose order contradicts the registry, excluding pairs
 *                     declared interchangeable
 *
 * Repeated markers for one id are allowed: several sources legitimately appear at more
 * than one point in a loop body (`abort-before-recovery` guards several branches). Only
 * the FIRST occurrence of each id is used for the ordering check, since a later repeat is
 * a guard rather than a position claim.
 */
export function checkContinuationMarkerSequence(
	audience: ContinuationAudience,
	observed: readonly string[],
): {
	ok: boolean;
	unknown: string[];
	notDeclared: string[];
	missing: string[];
	outOfOrder: Array<{ earlier: string; later: string }>;
} {
	const unknown: string[] = [];
	const notDeclared: string[] = [];
	const firstSeen: string[] = [];

	for (const id of observed) {
		const source = getContinuationSource(id);
		if (!source) {
			if (!unknown.includes(id)) unknown.push(id);
			continue;
		}
		if (source.dispositions[audience].kind !== "handled") {
			if (!notDeclared.includes(id)) notDeclared.push(id);
			continue;
		}
		if (!firstSeen.includes(id)) firstSeen.push(id);
	}

	const missing = listHandledContinuationSourceIds(audience).filter(
		(id) => !firstSeen.includes(id),
	);

	const outOfOrder: Array<{ earlier: string; later: string }> = [];
	for (let i = 0; i < firstSeen.length; i++) {
		for (let j = i + 1; j < firstSeen.length; j++) {
			const earlier = firstSeen[i] as string;
			const later = firstSeen[j] as string;
			if (isOrderInterchangeable(earlier, later)) continue;
			if (continuationSourceIndex(earlier) > continuationSourceIndex(later)) {
				outOfOrder.push({ earlier, later });
			}
		}
	}

	return {
		ok:
			unknown.length === 0 &&
			notDeclared.length === 0 &&
			missing.length === 0 &&
			outOfOrder.length === 0,
		unknown,
		notDeclared,
		missing,
		outOfOrder,
	};
}

/** The marker comment a loop body carries for `id`. Single source of the marker syntax. */
export function continuationMarker(id: string): string {
	return `[continuation-source: ${id}]`;
}

/** Extract marker ids from a loop-body source text, in the order they appear. */
export function extractContinuationMarkers(sourceText: string): string[] {
	const found: string[] = [];
	const pattern = /\[continuation-source:\s*([a-z0-9-]+)\s*\]/g;
	for (const match of sourceText.matchAll(pattern)) {
		const id = match[1];
		if (id) found.push(id);
	}
	return found;
}
