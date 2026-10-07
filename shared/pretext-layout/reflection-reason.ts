/**
 * reflection-reason.ts — Classify server-written reflection reasons for display.
 *
 * Reflection gates write English system defaults into
 * `permissionSuggestions[].reason` and `permissionDecisionReason` when no custom
 * AI/user text exists. The notice already paints a localized status TITLE for
 * that state, so those defaults must not leak into the summary line as
 * untranslated English.
 *
 * Classification is display-time and string-stable: the server keeps writing
 * canonical English (historical rows and multi-user views stay matchable), and
 * the shell decides whether to omit, re-label, or pass the text through.
 *
 * Pure, DOM-free, i18n-free — the shell supplies localized labels.
 */

import { lookupDangerCopy } from "../danger-copy";

export type ReflectionReasonClassification =
	/** Pure status restatement. The localized title already carries it. */
	| { kind: "omit" }
	/**
	 * System chrome that needs its own localized copy (not the status title).
	 * `params` interpolates into the label template (`{name}` style).
	 */
	| { kind: "label"; key: string; params?: Record<string, string>; nextSteps?: string }
	/**
	 * Reader-visible content (AI reflection text, danger summary, user feedback).
	 * `text` may be empty when only the advisory `nextSteps` line survived the split.
	 */
	| { kind: "content"; text: string; nextSteps?: string };

/**
 * Server defaults that only restate the gate's status. The notice title is
 * already the localized form of the same fact, so repeating them as a summary
 * is both redundant and (before this module) stuck in English.
 */
const STATUS_RESTATEMENTS = new Set([
	// plan (exit-plan-reflection.statusReason)
	"Plan reflection is checking this plan",
	"Plan reflection stopped; awaiting user decision",
	"Plan reflection confirmed the plan",
	"Plan reflection requested revision",
	"Plan reflection failed before reaching a decision",
	"Plan reflection aborted",
	// task (task-reflection.statusReason)
	"Task reflection is checking the protected task change",
	"Task reflection stopped; awaiting user decision",
	"Task reflection confirmed the protected task change",
	"Task reflection requested more work",
	"Task reflection failed before reaching a decision",
	"Task reflection aborted",
	// danger (narrator-permission hard-coded defaults)
	"Danger reflection aborted",
	"Danger reflection stopped; awaiting user decision",
	"Danger reflection stopped by user; awaiting user decision",
	"Danger reflection confirmed this operation",
	"Danger reflection rejected this operation",
	"Danger reflection could not complete its check",
	"Danger reflection is checking this operation",
]);

/**
 * System strings that are NOT status restatements — they carry a distinct fact
 * (who aborted, how the pause ended) and need their own localized copy.
 */
const LABEL_REASONS = new Map([
	["Narrator aborted", "reflectionReasonNarratorAborted"],
	["Danger reflection pause cancelled by user", "reflectionReasonDangerCancelledByUser"],
	["Danger reflection pause cancelled by reflection loop", "reflectionReasonDangerCancelledByLoop"],
	[
		"Danger reflection was interrupted before manual takeover; no live reflection loop remains",
		"reflectionReasonDangerInterrupted",
	],
	[
		"The danger reflection pause was already resolved by another decision path.",
		"reflectionReasonDangerAlreadyResolved",
	],
	["User approved the protected task change via takeover.", "reflectionReasonTaskApprovedByUser"],
	["User rejected the protected task change.", "reflectionReasonTaskRejectedByUser"],
	[
		"The user declined this protected task change. Do not retry it without new instructions.",
		"reflectionReasonTaskDeclinedNextSteps",
	],
]);

/** `Danger reflection: ${summary}` — strip the English chrome prefix. */
const DANGER_SUMMARY_PREFIX = /^Danger reflection:\s*/;

/** `Permission rule request: ${reason}` — strip the English chrome prefix. */
const PERMISSION_RULE_PREFIX = /^Permission rule request:\s*/;

/** `statusReason` concatenation of custom reason + advisory next steps. */
const NEXT_STEPS_SEPARATOR = "\n\nNext steps:";

function asContent(text: string, nextSteps?: string): ReflectionReasonClassification {
	return nextSteps ? { kind: "content", text, nextSteps } : { kind: "content", text };
}

/**
 * Classify one summary candidate for the reflection notice.
 *
 * Accepts the full fallback chain input (`reason` / `danger.summary` /
 * `permissionDecisionReason` / abort `errorMessage`) and returns how the shell
 * should present it.
 */
export function classifyReflectionReasonSummary(
	raw: string | null | undefined,
): ReflectionReasonClassification | null {
	const trimmed = typeof raw === "string" ? raw.trim() : "";
	if (!trimmed) return null;

	// Split a statusReason concatenation first so a chrome head + advisory tail
	// does not force the whole string into the content branch.
	let text = trimmed;
	let nextSteps: string | undefined;
	const sepIndex = text.indexOf(NEXT_STEPS_SEPARATOR);
	if (sepIndex >= 0) {
		const head = text.slice(0, sepIndex).trim();
		const tail = text.slice(sepIndex + NEXT_STEPS_SEPARATOR.length).trim();
		if (tail) {
			text = head;
			nextSteps = tail;
		}
	}

	if (STATUS_RESTATEMENTS.has(text)) {
		return nextSteps ? asContent("", nextSteps) : { kind: "omit" };
	}

	const labelKey = LABEL_REASONS.get(text);
	if (labelKey) {
		// A labelled system fact may still carry an advisory tail.
		return nextSteps
			? { kind: "label", key: labelKey, nextSteps }
			: { kind: "label", key: labelKey };
	}

	// Danger assessment copy (summary lines) is system chrome — re-label it.
	const dangerCopy = lookupDangerCopy(text);
	if (dangerCopy) {
		return nextSteps
			? {
					kind: "label",
					key: dangerCopy.key,
					...(dangerCopy.params ? { params: dangerCopy.params } : {}),
					nextSteps,
				}
			: {
					kind: "label",
					key: dangerCopy.key,
					...(dangerCopy.params ? { params: dangerCopy.params } : {}),
				};
	}

	const dangerMatch = text.match(DANGER_SUMMARY_PREFIX);
	if (dangerMatch) {
		const summary = text.slice(dangerMatch[0].length).trim();
		// The bare prefix with nothing after it is chrome, not content.
		if (!summary) return nextSteps ? asContent("", nextSteps) : { kind: "omit" };
		const nested = lookupDangerCopy(summary);
		if (nested) {
			return {
				kind: "label",
				key: nested.key,
				...(nested.params ? { params: nested.params } : {}),
				...(nextSteps ? { nextSteps } : {}),
			};
		}
		return asContent(summary, nextSteps);
	}

	const ruleMatch = text.match(PERMISSION_RULE_PREFIX);
	if (ruleMatch) {
		const reason = text.slice(ruleMatch[0].length).trim();
		if (!reason) return nextSteps ? asContent("", nextSteps) : { kind: "omit" };
		return asContent(reason, nextSteps);
	}

	// Only the advisory line survived — keep it as nextSteps, drop the empty reason.
	if (!text) {
		return nextSteps ? asContent("", nextSteps) : { kind: "omit" };
	}

	return asContent(text, nextSteps);
}
